import { spawn } from 'node:child_process';
import { basename } from 'node:path';

export type ChildProcessErrorCode =
	| 'EXECUTABLE_NOT_ALLOWED'
	| 'PROCESS_ABORTED'
	| 'PROCESS_EXIT_NONZERO'
	| 'PROCESS_OUTPUT_DRAIN_FAILED'
	| 'PROCESS_OUTPUT_LIMIT'
	| 'PROCESS_START_FAILED'
	| 'PROCESS_TREE_TERMINATION_FAILED'
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
	readonly acceptedExitCodes?: readonly number[];
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
}

export interface OwnedChildProcessExit {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
}

export interface OwnedChildProcess {
	readonly pid: number;
	readonly exit: Promise<OwnedChildProcessExit>;
	stop(): Promise<void>;
}

export interface ChildProcessRunnerOptions {
	readonly allowedExecutableBasenames?: readonly string[];
	readonly defaultTimeoutMs?: number;
	readonly defaultMaxOutputBytes?: number;
	readonly isProcessTreeAlive?: (pid: number) => boolean;
	readonly platform?: NodeJS.Platform;
	readonly terminateProcessTree?: (pid: number, signal: NodeJS.Signals) => void;
	readonly terminationConfirmationMs?: number;
	readonly terminationGraceMs?: number;
	readonly terminationPollMs?: number;
}

const defaultAllowedExecutables = ['devtunnel', 'devtunnel.exe'];

export class ChildProcessRunner {
	private readonly allowedExecutableBasenames: ReadonlySet<string>;
	private readonly defaultTimeoutMs: number;
	private readonly defaultMaxOutputBytes: number;
	private readonly isProcessTreeAlive: ((pid: number) => boolean) | undefined;
	private readonly platform: NodeJS.Platform;
	private readonly terminateProcessTree: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
	private readonly terminationConfirmationMs: number;
	private readonly terminationGraceMs: number;
	private readonly terminationPollMs: number;

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
		this.isProcessTreeAlive = options.isProcessTreeAlive
			?? (this.platform === 'win32' ? undefined : isPosixProcessGroupAlive);
		this.terminationConfirmationMs = options.terminationConfirmationMs ?? 1_000;
		this.terminationGraceMs = options.terminationGraceMs ?? 1_000;
		this.terminationPollMs = options.terminationPollMs ?? 10;
		for (const [name, value] of [
			['terminationConfirmationMs', this.terminationConfirmationMs],
			['terminationGraceMs', this.terminationGraceMs],
			['terminationPollMs', this.terminationPollMs],
		] as const) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new RangeError(`${name} must be a positive safe integer.`);
			}
		}
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
		const terminateProcessTree = this.terminateProcessTree;
		const isProcessTreeAlive = this.isProcessTreeAlive;
		if (terminateProcessTree === undefined || isProcessTreeAlive === undefined) {
			return Promise.reject(new ChildProcessExecutionError(
				'PROCESS_TREE_UNSUPPORTED',
				'Owned process-tree termination is unavailable on this platform.',
			));
		}

		const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
		const maxOutputBytes = options.maxOutputBytes ?? this.defaultMaxOutputBytes;
		const acceptedExitCodes = new Set(options.acceptedExitCodes ?? []);
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
			return Promise.reject(new RangeError('timeoutMs must be a positive safe integer.'));
		}
		if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
			return Promise.reject(new RangeError('maxOutputBytes must be a positive safe integer.'));
		}
		if (
			[...acceptedExitCodes].some((code) => !Number.isSafeInteger(code) || code <= 0)
		) {
			return Promise.reject(new RangeError('acceptedExitCodes must contain positive safe integers.'));
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
			let closeObserved = false;
			let finalError: ChildProcessExecutionError | undefined;
			let finalizing = false;
			let observedExitCode = 0;
			let resolveClose: (() => void) | undefined;
			let settled = false;
			let timeoutTimer: NodeJS.Timeout | undefined;
			const closePromise = new Promise<void>((resolveClosePromise) => {
				resolveClose = resolveClosePromise;
			});

			const cleanup = (): void => {
				if (timeoutTimer !== undefined) {
					clearTimeout(timeoutTimer);
				}
				options.signal?.removeEventListener('abort', abortListener);
				child.stdout.removeAllListeners('data');
				child.stderr.removeAllListeners('data');
				child.stdout.destroy();
				child.stderr.destroy();
				child.unref();
			};

			const settleReject = (error: ChildProcessExecutionError): void => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			};

			const settleResolve = (): void => {
				if (settled) {
					return;
				}
				const result = {
					exitCode: observedExitCode,
					stdout: Buffer.concat(stdoutChunks).toString('utf8'),
					stderr: Buffer.concat(stderrChunks).toString('utf8'),
				};
				settled = true;
				cleanup();
				resolve(result);
			};

			const killOwnedProcessTree = (signal: NodeJS.Signals): boolean => {
				if (child.pid === undefined) {
					return false;
				}
				try {
					terminateProcessTree(child.pid, signal);
					return true;
				} catch (error: unknown) {
					if (isProcessMissingError(error)) {
						return false;
					}
					throw new ChildProcessExecutionError(
						'PROCESS_TREE_TERMINATION_FAILED',
						'The owned process tree could not be terminated.',
					);
				}
			};

			const processTreeIsAlive = (): boolean => {
				if (child.pid === undefined) {
					return false;
				}
				try {
					return isProcessTreeAlive(child.pid);
				} catch (error: unknown) {
					if (isProcessMissingError(error)) {
						return false;
					}
					if (isProcessPermissionError(error)) {
						return true;
					}
					throw toProcessTreeTerminationError(error);
				}
			};

			const waitForProcessTreeExitUntil = async (deadline: number): Promise<boolean> => {
				while (true) {
					if (!processTreeIsAlive()) {
						return true;
					}
					const remainingMs = deadline - Date.now();
					if (remainingMs <= 0) {
						return false;
					}
					await delay(Math.min(this.terminationPollMs, remainingMs));
				}
			};

			const cleanupOwnedProcessTree = async (): Promise<void> => {
				if (!killOwnedProcessTree('SIGTERM')) {
					return;
				}
				const exitedDuringGrace = await waitForProcessTreeExitUntil(
					Date.now() + this.terminationGraceMs,
				);
				if (exitedDuringGrace) {
					return;
				}
				if (!killOwnedProcessTree('SIGKILL')) {
					return;
				}
				const exitedAfterForce = await waitForProcessTreeExitUntil(
					Date.now() + this.terminationConfirmationMs,
				);
				if (!exitedAfterForce) {
					throw new ChildProcessExecutionError(
						'PROCESS_TREE_TERMINATION_FAILED',
						'The owned process tree remained alive after forced termination.',
					);
				}
			};

			const waitForOutputClose = async (): Promise<void> => {
				if (closeObserved) {
					return;
				}
				let drainTimer: NodeJS.Timeout | undefined;
				try {
					await Promise.race([
						closePromise,
						new Promise<void>((_resolve, rejectDrain) => {
							drainTimer = setTimeout(() => rejectDrain(
								new ChildProcessExecutionError(
									'PROCESS_OUTPUT_DRAIN_FAILED',
									'The process output pipes did not close after tree cleanup.',
								),
							), this.terminationConfirmationMs);
						}),
					]);
				} finally {
					if (drainTimer !== undefined) {
						clearTimeout(drainTimer);
					}
				}
			};

			const finalize = (error?: ChildProcessExecutionError): void => {
				if (settled) {
					return;
				}
				if (error !== undefined && finalError === undefined) {
					finalError = error;
				}
				if (finalizing) {
					return;
				}
				finalizing = true;
				clearTimeout(timeoutTimer);
				options.signal?.removeEventListener('abort', abortListener);
				void (async () => {
					await cleanupOwnedProcessTree();
					await waitForOutputClose();
					if (finalError !== undefined) {
						settleReject(finalError);
					} else {
						settleResolve();
					}
				})().catch((failure: unknown) => {
					settleReject(failure instanceof ChildProcessExecutionError
						? failure
						: toProcessTreeTerminationError(failure));
				});
			};

			const capture = (target: Buffer[], chunk: Buffer | string): void => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				const remaining = Math.max(0, maxOutputBytes - capturedBytes);
				if (remaining > 0) {
					target.push(buffer.subarray(0, remaining));
				}
				capturedBytes += buffer.byteLength;
				if (capturedBytes > maxOutputBytes) {
					finalize(new ChildProcessExecutionError(
						'PROCESS_OUTPUT_LIMIT',
						'The process exceeded the bounded output limit.',
					));
				}
			};

			const abortListener = (): void => finalize(new ChildProcessExecutionError(
				'PROCESS_ABORTED',
				'The process request was cancelled.',
			));
			timeoutTimer = setTimeout(() => finalize(new ChildProcessExecutionError(
				'PROCESS_TIMEOUT',
				'The process exceeded its execution timeout.',
			)), timeoutMs);

			options.signal?.addEventListener('abort', abortListener, { once: true });
			if (options.signal?.aborted === true) {
				abortListener();
			}
			child.stdout.on('data', (chunk: Buffer | string) => capture(stdoutChunks, chunk));
			child.stderr.on('data', (chunk: Buffer | string) => capture(stderrChunks, chunk));
			child.once('error', () => finalize(new ChildProcessExecutionError(
				'PROCESS_START_FAILED',
				'The process could not be started.',
			)));
			child.once('exit', (exitCode) => {
				if (exitCode !== 0) {
					if (exitCode !== null && acceptedExitCodes.has(exitCode)) {
						observedExitCode = exitCode;
						finalize();
						return;
					}
					finalize(new ChildProcessExecutionError(
						'PROCESS_EXIT_NONZERO',
						`The process exited with code ${exitCode ?? 'unknown'}.`,
					));
					return;
				}
				finalize();
			});
			child.once('close', () => {
				closeObserved = true;
				resolveClose?.();
			});
		});
	}

	startOwned(
		executable: string,
		args: readonly string[],
	): Promise<OwnedChildProcess> {
		const executableName = basename(executable).toLowerCase();
		if (!this.allowedExecutableBasenames.has(executableName)) {
			return Promise.reject(new ChildProcessExecutionError(
				'EXECUTABLE_NOT_ALLOWED',
				'The requested executable is not allowed.',
			));
		}
		const terminateProcessTree = this.terminateProcessTree;
		const isProcessTreeAlive = this.isProcessTreeAlive;
		if (terminateProcessTree === undefined || isProcessTreeAlive === undefined) {
			return Promise.reject(new ChildProcessExecutionError(
				'PROCESS_TREE_UNSUPPORTED',
				'Owned process-tree termination is unavailable on this platform.',
			));
		}

		const child = spawn(executable, [...args], {
			detached: this.platform !== 'win32',
			shell: false,
			windowsHide: true,
			stdio: ['ignore', 'ignore', 'ignore'],
		});

		return new Promise((resolve, reject) => {
			let settled = false;
			let stopping: Promise<void> | undefined;
			let resolveExit: ((result: OwnedChildProcessExit) => void) | undefined;
			const exit = new Promise<OwnedChildProcessExit>((resolveExitPromise) => {
				resolveExit = resolveExitPromise;
			});
			const stop = (): Promise<void> => {
				if (stopping === undefined) {
					const attempt = this.stopOwnedProcess(
						child.pid,
						terminateProcessTree,
						isProcessTreeAlive,
					);
					stopping = attempt;
					void attempt.catch(() => {
						if (stopping === attempt) {
							stopping = undefined;
						}
					});
				}
				return stopping;
			};

			child.once('spawn', () => {
				if (settled || child.pid === undefined) {
					return;
				}
				settled = true;
				resolve({
					pid: child.pid,
					exit,
					stop,
				});
			});
			child.once('error', () => {
				if (!settled) {
					settled = true;
					reject(new ChildProcessExecutionError(
						'PROCESS_START_FAILED',
						'The process could not be started.',
					));
				}
				resolveExit?.({ exitCode: null, signal: null });
			});
			child.once('exit', (exitCode, signal) => {
				resolveExit?.({ exitCode, signal });
				child.unref();
			});
		});
	}

	private async stopOwnedProcess(
		pid: number | undefined,
		terminateProcessTree: (pid: number, signal: NodeJS.Signals) => void,
		isProcessTreeAlive: (pid: number) => boolean,
	): Promise<void> {
		if (pid === undefined) {
			return;
		}
		const signal = (processSignal: NodeJS.Signals): boolean => {
			try {
				terminateProcessTree(pid, processSignal);
				return true;
			} catch (error: unknown) {
				if (isProcessMissingError(error)) {
					return false;
				}
				throw toProcessTreeTerminationError(error);
			}
		};
		const isAlive = (): boolean => {
			try {
				return isProcessTreeAlive(pid);
			} catch (error: unknown) {
				if (isProcessMissingError(error)) {
					return false;
				}
				if (isProcessPermissionError(error)) {
					return true;
				}
				throw toProcessTreeTerminationError(error);
			}
		};
		const waitUntil = async (deadline: number): Promise<boolean> => {
			while (isAlive()) {
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) {
					return false;
				}
				await delay(Math.min(this.terminationPollMs, remainingMs));
			}
			return true;
		};

		if (!signal('SIGTERM')) {
			return;
		}
		if (await waitUntil(Date.now() + this.terminationGraceMs)) {
			return;
		}
		if (!signal('SIGKILL')) {
			return;
		}
		if (!await waitUntil(Date.now() + this.terminationConfirmationMs)) {
			throw new ChildProcessExecutionError(
				'PROCESS_TREE_TERMINATION_FAILED',
				'The owned process tree remained alive after forced termination.',
			);
		}
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

function isPosixProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error: unknown) {
		if (isProcessMissingError(error)) {
			return false;
		}
		throw error;
	}
}

function isProcessMissingError(error: unknown): boolean {
	return error instanceof Error
		&& 'code' in error
		&& error.code === 'ESRCH';
}

function isProcessPermissionError(error: unknown): boolean {
	return error instanceof Error
		&& 'code' in error
		&& error.code === 'EPERM';
}

function toProcessTreeTerminationError(error: unknown): ChildProcessExecutionError {
	return error instanceof ChildProcessExecutionError
		? error
		: new ChildProcessExecutionError(
			'PROCESS_TREE_TERMINATION_FAILED',
			'The owned process tree could not be terminated.',
		);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
