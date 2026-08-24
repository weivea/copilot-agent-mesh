import { spawn } from 'node:child_process';
import { basename } from 'node:path';

export type ChildProcessErrorCode =
	| 'EXECUTABLE_NOT_ALLOWED'
	| 'PROCESS_ABORTED'
	| 'PROCESS_EXIT_NONZERO'
	| 'PROCESS_OUTPUT_LIMIT'
	| 'PROCESS_START_FAILED'
	| 'PROCESS_TREE_UNSUPPORTED'
	| 'PROCESS_TIMEOUT';

export class ChildProcessExecutionError extends Error {
	constructor(
		readonly code: ChildProcessErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'ChildProcessExecutionError';
	}
}

export interface ChildProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ChildProcessRunOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
}

export interface ChildProcessRunnerOptions {
	readonly allowedExecutableBasenames?: readonly string[];
	readonly defaultTimeoutMs?: number;
	readonly defaultMaxOutputBytes?: number;
	readonly platform?: NodeJS.Platform;
	readonly terminateProcessTree?: (pid: number, signal: NodeJS.Signals) => void;
	readonly terminationGraceMs?: number;
}

const defaultAllowedExecutables = ['devtunnel', 'devtunnel.exe'];

export class ChildProcessRunner {
	private readonly allowedExecutableBasenames: ReadonlySet<string>;
	private readonly defaultTimeoutMs: number;
	private readonly defaultMaxOutputBytes: number;
	private readonly platform: NodeJS.Platform;
	private readonly terminateProcessTree: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
	private readonly terminationGraceMs: number;

	constructor(options: ChildProcessRunnerOptions = {}) {
		this.allowedExecutableBasenames = new Set(
			(options.allowedExecutableBasenames ?? defaultAllowedExecutables)
				.map((name) => name.toLowerCase()),
		);
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
		this.defaultMaxOutputBytes = options.defaultMaxOutputBytes ?? 256 * 1024;
		this.platform = options.platform ?? process.platform;
		this.terminateProcessTree = options.terminateProcessTree
			?? (this.platform === 'win32' ? undefined : terminatePosixProcessGroup);
		this.terminationGraceMs = options.terminationGraceMs ?? 1_000;
	}

	run(
		executable: string,
		args: readonly string[],
		options: ChildProcessRunOptions = {},
	): Promise<ChildProcessResult> {
		const executableName = basename(executable).toLowerCase();
		if (!this.allowedExecutableBasenames.has(executableName)) {
			return Promise.reject(new ChildProcessExecutionError(
				'EXECUTABLE_NOT_ALLOWED',
				'The requested executable is not allowed.',
			));
		}
		if (options.signal?.aborted === true) {
			return Promise.reject(new ChildProcessExecutionError(
				'PROCESS_ABORTED',
				'The process request was cancelled before it started.',
			));
		}
		if (this.terminateProcessTree === undefined) {
			return Promise.reject(new ChildProcessExecutionError(
				'PROCESS_TREE_UNSUPPORTED',
				'Owned process-tree termination is unavailable on this platform.',
			));
		}

		const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
		const maxOutputBytes = options.maxOutputBytes ?? this.defaultMaxOutputBytes;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
			return Promise.reject(new RangeError('timeoutMs must be a positive safe integer.'));
		}
		if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
			return Promise.reject(new RangeError('maxOutputBytes must be a positive safe integer.'));
		}

		const child = spawn(executable, [...args], {
			detached: this.platform !== 'win32',
			shell: false,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		return new Promise((resolve, reject) => {
			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			let capturedBytes = 0;
			let settled = false;
			let terminationError: ChildProcessExecutionError | undefined;
			let forceKillTimer: NodeJS.Timeout | undefined;
			let settlementTimer: NodeJS.Timeout | undefined;
			let timeoutTimer: NodeJS.Timeout | undefined;

			const cleanup = (): void => {
				if (timeoutTimer !== undefined) {
					clearTimeout(timeoutTimer);
				}
				if (forceKillTimer !== undefined) {
					clearTimeout(forceKillTimer);
				}
				if (settlementTimer !== undefined) {
					clearTimeout(settlementTimer);
				}
				options.signal?.removeEventListener('abort', abortListener);
				if (terminationError !== undefined) {
					child.stdout.removeAllListeners('data');
					child.stderr.removeAllListeners('data');
					child.stdout.destroy();
					child.stderr.destroy();
					child.unref();
				}
			};

			const settleReject = (error: ChildProcessExecutionError): void => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			};

			const killOwnedProcessTree = (signal: NodeJS.Signals): void => {
				if (child.pid === undefined) {
					return;
				}
				try {
					this.terminateProcessTree?.(child.pid, signal);
				} catch {
					// The final settlement deadline still bounds the caller even if the
					// process already exited or the platform refuses the group signal.
				}
			};

			const terminate = (error: ChildProcessExecutionError): void => {
				if (terminationError !== undefined || settled) {
					return;
				}
				terminationError = error;
				killOwnedProcessTree('SIGTERM');
				forceKillTimer = setTimeout(() => {
					killOwnedProcessTree('SIGKILL');
					settleReject(error);
				}, this.terminationGraceMs);
				settlementTimer = setTimeout(
					() => settleReject(error),
					this.terminationGraceMs * 2,
				);
			};

			const capture = (target: Buffer[], chunk: Buffer | string): void => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				const remaining = Math.max(0, maxOutputBytes - capturedBytes);
				if (remaining > 0) {
					target.push(buffer.subarray(0, remaining));
				}
				capturedBytes += buffer.byteLength;
				if (capturedBytes > maxOutputBytes) {
					terminate(new ChildProcessExecutionError(
						'PROCESS_OUTPUT_LIMIT',
						'The process exceeded the bounded output limit.',
					));
				}
			};

			const abortListener = (): void => terminate(new ChildProcessExecutionError(
				'PROCESS_ABORTED',
				'The process request was cancelled.',
			));
			timeoutTimer = setTimeout(() => terminate(new ChildProcessExecutionError(
				'PROCESS_TIMEOUT',
				'The process exceeded its execution timeout.',
			)), timeoutMs);

			options.signal?.addEventListener('abort', abortListener, { once: true });
			if (options.signal?.aborted === true) {
				abortListener();
			}
			child.stdout.on('data', (chunk: Buffer | string) => capture(stdoutChunks, chunk));
			child.stderr.on('data', (chunk: Buffer | string) => capture(stderrChunks, chunk));
			child.once('error', () => settleReject(new ChildProcessExecutionError(
				'PROCESS_START_FAILED',
				'The process could not be started.',
			)));
			child.once('close', (exitCode) => {
				if (settled) {
					return;
				}
				if (terminationError !== undefined) {
					return;
				}
				if (exitCode !== 0) {
					settleReject(new ChildProcessExecutionError(
						'PROCESS_EXIT_NONZERO',
						`The process exited with code ${exitCode ?? 'unknown'}.`,
					));
					return;
				}

				settled = true;
				cleanup();
				resolve({
					exitCode,
					stdout: Buffer.concat(stdoutChunks).toString('utf8'),
					stderr: Buffer.concat(stderrChunks).toString('utf8'),
				});
			});
		});
	}
}

export function redactProcessText(value: string): string {
	return value
		.replace(/(https?:\/\/[^\s#]+)#[^\s]*/giu, '$1#<redacted>')
		.replace(/([?&](?:tkn|token|access_token|connectionToken)=)[^&\s]+/giu, '$1<redacted>')
		.replace(/(authorization\s*[:=]\s*)[^\r\n]*/giu, '$1<redacted>')
		.replace(/(--(?:access-token|token))(?:\s+|=)[^\s]+/giu, '$1=<redacted>')
		.replace(/("(?:accessToken|connectionToken|secret|token)"\s*:\s*")[^"]*"/giu, '$1<redacted>"');
}

function terminatePosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
	process.kill(-pid, signal);
}
