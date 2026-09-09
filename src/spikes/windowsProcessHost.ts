import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';

const maxFrameBytes = 1024 * 1024;
const controlTimeoutMs = 8_000;

export interface OwnedProcessCleanup {
	dispose(): Promise<void>;
}

export interface WindowsProcessOptions {
	readonly environment?: NodeJS.ProcessEnv;
	readonly cwd?: string;
	readonly maxOutputBytes?: number;
	readonly helperPath?: string;
}

export class WindowsProcessHostError extends Error {
	constructor(readonly code: string, readonly cleanupRequired: boolean) {
		super(`Windows process host: ${code}.`);
		this.name = 'WindowsProcessHostError';
	}
}

export function windowsProcessHostPath(
	architecture: string = process.arch,
	moduleDirectory = __dirname,
): string {
	if (architecture !== 'x64' && architecture !== 'arm64') {
		throw new Error('Windows owned process control requires x64 or ARM64.');
	}
	const name = `mesh-process-host-${architecture}.exe`;
	const candidates = [join(moduleDirectory, 'windows', name)];
	// Development scripts can import src/spikes directly through tsx; compiled
	// tests use out/src/spikes. Neither layout depends on the caller's cwd.
	if (basename(moduleDirectory) === 'spikes' && basename(dirname(moduleDirectory)) === 'src') {
		const sourceRoot = resolve(moduleDirectory, '..', '..');
		const repository = basename(sourceRoot) === 'out' ? dirname(sourceRoot) : sourceRoot;
		candidates.push(join(repository, 'dist', 'windows', name));
	}
	const path = candidates.find((candidate) => existsSync(candidate));
	if (path === undefined) {
		throw new Error('The bundled Windows Job Object helper is missing. Reinstall the complete extension; development builds must run build-windows-process-host.mjs.');
	}
	return path;
}

interface PendingRequest {
	type: 'pids' | 'terminate';
	resolve(value: Record<string, unknown>): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

/**
 * The helper owns the process HANDLE and kill-on-close Job Object. Numeric PIDs
 * are metadata only; they are never used to terminate Windows processes.
 */
export class WindowsOwnedProcess extends EventEmitter implements OwnedProcessCleanup {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly started: Promise<void>;
	readonly completion: Promise<number>;
	pid: number | undefined;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	private readonly helper: ChildProcessWithoutNullStreams;
	private readonly helperClosedPromise: Promise<void>;
	private resolveHelperClosed!: () => void;
	private readonly pending = new Map<number, PendingRequest>();
	private resolveStarted!: () => void;
	private rejectStarted!: (error: Error) => void;
	private resolveCompletion!: (code: number) => void;
	private rejectCompletion!: (error: Error) => void;
	private buffer = Buffer.alloc(0);
	private sequence = 0;
	private confirmed = false;
	private closed = false;
	private failure: Error | undefined;
	private disposal: Promise<void> | undefined;
	private outputBytes = 0;
	private exitEmitted = false;
	private pidSnapshot: readonly number[] | undefined;
	private readonly maxOutputBytes: number;

	constructor(executable: string, args: readonly string[], options: WindowsProcessOptions = {}) {
		super();
		if (!isAbsolute(executable) || /\0/u.test(executable)) {
			throw new Error('The Windows process executable must be an absolute path without NUL characters.');
		}
		this.maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
		const environment: Record<string, string> = {};
		for (const [key, value] of Object.entries(options.environment ?? process.env)) {
			if (value !== undefined) {
				environment[key.toUpperCase()] = value;
			}
		}
		const startFrame = JSON.stringify({
			type: 'start', id: 0, executable, args, environment,
			cwd: options.cwd, maxOutputBytes: this.maxOutputBytes,
		}) + '\n';
		if (Buffer.byteLength(startFrame) >= maxFrameBytes) {
			throw new Error('The Windows process start request exceeds the control frame limit.');
		}
		this.helperClosedPromise = new Promise((resolve) => {
			this.resolveHelperClosed = resolve;
		});
		this.started = new Promise((resolve, reject) => {
			this.resolveStarted = resolve;
			this.rejectStarted = reject;
		});
		this.completion = new Promise((resolve, reject) => {
			this.resolveCompletion = resolve;
			this.rejectCompletion = reject;
		});
		// Consumers can await start before subscribing to completion, including
		// immediate launch failures. Keep both original promises observable.
		void this.started.catch(() => {});
		void this.completion.catch(() => {});
		this.helper = spawn(options.helperPath ?? windowsProcessHostPath(), [], {
			shell: false,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const startTimer = setTimeout(() => this.fail('startup_timeout'), controlTimeoutMs);
		void this.started.finally(() => clearTimeout(startTimer)).catch(() => {});
		this.helper.stdout.on('data', (chunk: Buffer) => this.readFrames(chunk));
		this.helper.stderr.on('data', () => this.fail('unexpected_helper_output'));
		this.helper.stdin.on('error', () => this.fail('control_write_failed'));
		this.helper.on('error', () => this.fail('helper_spawn_failed', this.helper.pid === undefined));
		this.helper.once('close', () => {
			this.closed = true;
			this.resolveHelperClosed();
			if (!this.confirmed) {
				this.fail(this.buffer.length > 0 ? 'truncated_control_frame' : 'helper_closed_without_cleanup_confirmation');
			}
			for (const request of this.pending.values()) {
				clearTimeout(request.timer);
				request.reject(this.error('helper_closed'));
			}
			this.pending.clear();
			this.stdout.end();
			this.stderr.end();
			this.emit('close', this.exitCode, this.signalCode);
		});
		this.helper.stdin.write(startFrame);
	}

	/** Native job cleanup confirmation; dispose also awaits the helper's own close. */
	get cleanupConfirmed(): boolean {
		return this.confirmed;
	}

	/** Last successful job-query metadata, not a fresh ownership proof or a PID-kill capability. */
	get ownedPidSnapshot(): ReadonlySet<number> | undefined {
		if (this.confirmed) {
			return new Set();
		}
		return this.pidSnapshot === undefined ? undefined : new Set(this.pidSnapshot);
	}

	toJSON(): { kind: string; pid: number | undefined; cleanupConfirmed: boolean } {
		return { kind: 'windowsOwnedProcess', pid: this.pid, cleanupConfirmed: this.confirmed };
	}

	[inspect.custom](): ReturnType<WindowsOwnedProcess['toJSON']> {
		return this.toJSON();
	}

	async ownedPids(): Promise<Set<number>> {
		await this.started;
		if (this.confirmed) {
			return new Set();
		}
		try {
			const response = await this.request('pids');
			if (this.confirmed) {
				return new Set();
			}
			if (!Array.isArray(response.pids) || response.pids.length > 65_536
				|| response.pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
				this.fail('invalid_pid_response');
				throw this.error('invalid_pid_response');
			}
			const pids = new Set(response.pids as number[]);
			this.pidSnapshot = [...pids];
			return pids;
		} catch (error) {
			this.pidSnapshot = undefined;
			throw error;
		}
	}

	dispose(): Promise<void> {
		if (this.confirmed && this.closed) {
			return Promise.resolve();
		}
		this.disposal ??= (async () => {
			if (!this.confirmed) {
				if (this.closed) {
					throw this.error('cleanup_unconfirmed_after_helper_exit');
				}
				try {
					await this.request('terminate');
				} catch (error) {
					if (!this.confirmed) {
						throw error;
					}
				}
				if (!this.confirmed) {
					throw this.error('cleanup_unconfirmed');
				}
			}
			if (!this.closed && !this.helper.stdin.destroyed && !this.helper.stdin.writableEnded) {
				this.helper.stdin.end();
			}
			await this.waitForHelperClose();
		})().finally(() => {
			if (!this.confirmed || !this.closed) {
				this.disposal = undefined;
			}
		});
		return this.disposal;
	}

	private async waitForHelperClose(): Promise<void> {
		if (this.closed) {
			return;
		}
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				this.helperClosedPromise,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(this.error('helper_close_timeout')), controlTimeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private request(type: 'pids' | 'terminate'): Promise<Record<string, unknown>> {
		if (this.closed || this.pending.size >= 32 || this.helper.stdin.destroyed) {
			return Promise.reject(this.error('control_unavailable'));
		}
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(this.error('control_timeout'));
			}, controlTimeoutMs);
			this.pending.set(id, { type, resolve, reject, timer });
			this.helper.stdin.write(JSON.stringify({ type, id }) + '\n');
		});
	}

	private readFrames(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const newline = this.buffer.indexOf(10);
			if (newline < 0) {
				if (this.buffer.length >= maxFrameBytes) {
					this.fail('control_frame_limit');
					this.helper.stdin.destroy();
					this.helper.stdout.destroy();
				}
				return;
			}
			if (newline >= maxFrameBytes) {
				this.fail('control_frame_limit');
				this.helper.stdin.destroy();
				return;
			}
			const frame = this.buffer.subarray(0, newline);
			this.buffer = this.buffer.subarray(newline + 1);
			let value: unknown;
			try {
				value = JSON.parse(frame.toString('utf8'));
			} catch {
				this.fail('invalid_control_frame');
				this.helper.stdin.destroy();
				return;
			}
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				this.fail('invalid_control_frame');
				this.helper.stdin.destroy();
				return;
			}
			this.receive(value as Record<string, unknown>);
		}
	}

	private receive(frame: Record<string, unknown>): void {
		switch (frame.type) {
			case 'started':
				if (frame.id !== 0 || this.pid !== undefined || typeof frame.pid !== 'number' || !Number.isSafeInteger(frame.pid) || frame.pid <= 0) {
					this.fail('invalid_start_response');
					return;
				}
				this.pid = frame.pid;
				this.resolveStarted();
				break;
			case 'output': {
				if (this.confirmed || this.failure !== undefined) {
					return;
				}
				if (typeof frame.data !== 'string' || frame.data.length > 16_384
					|| !/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data)
					|| (frame.stream !== 'stdout' && frame.stream !== 'stderr')) {
					this.fail('invalid_output_frame');
					return;
				}
				const data = Buffer.from(frame.data, 'base64');
				this.outputBytes += data.byteLength;
				if (this.outputBytes > this.maxOutputBytes) {
					this.fail('output_limit');
					return;
				}
				if (!this[frame.stream].destroyed) {
					this[frame.stream].write(data);
				}
				break;
			}
			case 'exit':
				if (frame.cleanupConfirmed !== true || typeof frame.code !== 'number' || !Number.isSafeInteger(frame.code)
					|| frame.code < 0 || frame.code > 0xffff_ffff) {
					this.fail('invalid_exit_response');
					return;
				}
				this.confirmed = true;
				this.exitCode = frame.code;
				this.stdout.end();
				this.stderr.end();
				this.resolveCompletion(frame.code);
				this.emitExit(frame.code);
				break;
			case 'stopped':
				if (frame.cleanupConfirmed !== true || typeof frame.id !== 'number' || this.pending.get(frame.id)?.type !== 'terminate') {
					this.fail('cleanup_unconfirmed');
					return;
				}
				this.confirmed = true;
				this.exitCode ??= 1;
				this.resolveCompletion(this.exitCode);
				this.emitExit(this.exitCode);
				break;
			case 'pids':
				break;
			case 'error':
				// Codes are allowlisted: never surface helper-provided freeform text.
				if (typeof frame.code !== 'string' || ![
					'launch_failed', 'job_query_failed', 'cleanup_unconfirmed', 'output_limit', 'output_read_failed',
					'control_write_failed', 'control_backpressure', 'invalid_control_frame', 'control_timeout',
					'control_disconnected', 'already_started', 'not_started', 'unknown_control_request',
					'exit_query_failed', 'output_drain_timeout',
				].includes(frame.code)) {
					this.fail('invalid_error_response');
					return;
				}
				this.fail(frame.code === 'output_limit' ? 'output_limit' : 'helper_operation_failed', frame.cleanupConfirmed === true);
				break;
			default:
				this.fail('unknown_control_frame');
				this.helper.stdin.destroy();
		}
		if (typeof frame.id === 'number') {
			const request = this.pending.get(frame.id);
			if (request !== undefined) {
				this.pending.delete(frame.id);
				clearTimeout(request.timer);
				if (frame.type === 'error') {
					request.reject(this.error('helper_operation_failed'));
				} else {
					request.resolve(frame);
				}
			}
		}
	}

	private error(code: string): WindowsProcessHostError {
		return new WindowsProcessHostError(code, !this.confirmed || !this.closed);
	}

	private fail(code: string, confirmed = false): void {
		this.confirmed ||= confirmed;
		this.pidSnapshot = undefined;
		this.failure ??= this.error(code);
		this.rejectStarted(this.failure);
		this.rejectCompletion(this.failure);
		this.exitCode ??= 1;
		this.emitExit(this.exitCode);
		// Use a non-special event: launch failures must not become unhandled
		// EventEmitter 'error' events before the consumer attaches listeners.
		this.emit('failure', this.failure);
		if (!this.confirmed && !this.closed) {
			// Cleanup errors leave this controller intact for a caller's retry.
			void this.dispose().catch(() => {});
		}
	}

	private emitExit(code: number): void {
		if (!this.exitEmitted) {
			this.exitEmitted = true;
			this.emit('exit', code, null);
		}
	}
}
