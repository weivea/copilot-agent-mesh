import { spawn } from 'node:child_process';

const defaultMaxOutputBytes = 1024 * 1024;
const defaultTerminationGraceMs = 250;
const terminationConfirmationMs = 1_000;
const terminationPollMs = 10;

export class OwnedCommandError extends Error {
	constructor(
		message: string,
		readonly processGroupId?: number,
		readonly cleanupRequired = false,
	) {
		super(message);
		this.name = 'OwnedCommandError';
	}
}

export interface RunOwnedCommandOptions {
	timeoutMs: number;
	maxOutputBytes?: number;
	terminationGraceMs?: number;
	platform?: NodeJS.Platform;
	signal?: AbortSignal;
}

export function assertOwnedProcessControlSupported(
	platform: NodeJS.Platform = process.platform,
): void {
	if (platform !== 'darwin' && platform !== 'linux') {
		throw new Error(
			platform === 'win32'
				? 'Agent Host spike is unavailable on Windows until a Job Object based process controller is implemented.'
				: `Agent Host spike has no owned process-group controller for platform ${platform}.`,
		);
	}
}

export function runOwnedCommand(
	executable: string,
	args: readonly string[],
	options: RunOwnedCommandOptions,
): Promise<string> {
	assertOwnedProcessControlSupported(options.platform);
	const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
	const terminationGraceMs = options.terminationGraceMs ?? defaultTerminationGraceMs;

	return new Promise((resolve, reject) => {
		const child = spawn(executable, [...args], {
			detached: true,
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		const processGroupId = child.pid;
		const stdoutChunks: Buffer[] = [];
		let closeObserved = false;
		let finalError: Error | undefined;
		let finalizing = false;
		let outputBytes = 0;
		let resolveClose: (() => void) | undefined;
		let settled = false;
		let processTerminated = processGroupId === undefined;
		const closePromise = new Promise<void>((resolveClosePromise) => {
			resolveClose = resolveClosePromise;
		});

		const timer = setTimeout(() => {
			finalize(new OwnedCommandError(
				`${commandLabel(executable, args)} timed out after ${options.timeoutMs}ms.`,
				processGroupId,
			));
		}, options.timeoutMs);

		const cleanup = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', handleAbort);
			child.stdout?.removeAllListeners('data');
			child.stderr?.removeAllListeners('data');
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();
		};

		const waitForOutputClose = async () => {
			if (closeObserved) {
				return;
			}
			let drainTimer: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					closePromise,
					new Promise<void>((_resolve, rejectDrain) => {
						drainTimer = setTimeout(
							() => rejectDrain(new OwnedCommandError(
								`${commandLabel(executable, args)} output pipes did not close after process-group cleanup.`,
								processGroupId,
							)),
							terminationConfirmationMs,
						);
					}),
				]);
			} finally {
				if (drainTimer !== undefined) {
					clearTimeout(drainTimer);
				}
			}
		};

		const finalize = (error?: Error) => {
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
			clearTimeout(timer);
			void (async () => {
				if (processGroupId !== undefined) {
					await terminateOwnedProcessGroup(processGroupId, terminationGraceMs);
					processTerminated = true;
				}
				await waitForOutputClose();
				const output = Buffer.concat(stdoutChunks).toString('utf8');
				settled = true;
				cleanup();
				if (finalError !== undefined) {
					reject(finalError);
				} else {
					resolve(output);
				}
			})().catch(() => {
				settled = true;
				cleanup();
				reject(new OwnedCommandError(
					`${commandLabel(executable, args)} failed to clean up its owned process group or output pipes.`,
					processGroupId,
					!processTerminated,
				));
			});
		};
		const handleAbort = () => finalize(new OwnedCommandError(
			`${commandLabel(executable, args)} was cancelled.`,
			processGroupId,
		));
		if (options.signal?.aborted) {
			handleAbort();
		} else {
			options.signal?.addEventListener('abort', handleAbort, { once: true });
		}

		const recordOutput = (chunk: Buffer, keep: boolean) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maxOutputBytes) {
				finalize(
					new OwnedCommandError(
						`${commandLabel(executable, args)} exceeded the ${maxOutputBytes} byte output limit.`,
						processGroupId,
					),
				);
				return;
			}
			if (keep) {
				stdoutChunks.push(chunk);
			}
		};

		child.stdout?.on('data', (chunk: Buffer) => recordOutput(chunk, true));
		child.stderr?.on('data', (chunk: Buffer) => recordOutput(chunk, false));
		child.once('error', (error) => {
			finalize(
				new OwnedCommandError(
					`${commandLabel(executable, args)} failed to spawn: ${error.message}`,
					processGroupId,
				),
			);
		});
		child.once('exit', (code, signal) => {
			if (code !== 0) {
				finalize(
				new OwnedCommandError(
					`${commandLabel(executable, args)} exited with ${code ?? signal ?? 'unknown'}.`,
					processGroupId,
				),
			);
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

export async function terminateOwnedProcessGroup(
	processGroupId: number,
	graceMs: number,
): Promise<void> {
	const groupExisted = signalProcessGroup(processGroupId, 'SIGTERM');
	if (!groupExisted) {
		return;
	}
	const exitedDuringGrace = await waitForProcessGroupExit(
		processGroupId,
		Date.now() + graceMs,
	);
	if (exitedDuringGrace) {
		return;
	}
	if (!signalProcessGroup(processGroupId, 'SIGKILL')) {
		return;
	}
	const exitedAfterForce = await waitForProcessGroupExit(
		processGroupId,
		Date.now() + terminationConfirmationMs,
	);
	if (!exitedAfterForce) {
		throw new OwnedCommandError(
			'The owned process group remained alive after forced termination.',
			processGroupId,
		);
	}
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-processGroupId, signal);
		return true;
	} catch (error) {
		if (isErrno(error, 'ESRCH')) {
			return false;
		}
		throw error;
	}
}

async function waitForProcessGroupExit(
	processGroupId: number,
	deadline: number,
): Promise<boolean> {
	while (true) {
		if (!isProcessGroupAlive(processGroupId)) {
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			return false;
		}
		await delay(Math.min(terminationPollMs, remainingMs));
	}
}

function isProcessGroupAlive(processGroupId: number): boolean {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		if (isErrno(error, 'ESRCH')) {
			return false;
		}
		if (isErrno(error, 'EPERM')) {
			return true;
		}
		throw error;
	}
}

function commandLabel(executable: string, args: readonly string[]): string {
	return `${executable} ${args.slice(0, 2).join(' ')}`.trim();
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
