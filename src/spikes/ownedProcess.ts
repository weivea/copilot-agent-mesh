import { spawn } from 'node:child_process';

const defaultMaxOutputBytes = 1024 * 1024;
const defaultTerminationGraceMs = 250;
const postKillWaitMs = 50;

export class OwnedCommandError extends Error {
	constructor(
		message: string,
		readonly processGroupId?: number,
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
		let outputBytes = 0;
		let settling = false;

		const timer = setTimeout(() => {
			void terminateAndReject(
				new OwnedCommandError(
					`${commandLabel(executable, args)} timed out after ${options.timeoutMs}ms.`,
					processGroupId,
				),
			);
		}, options.timeoutMs);

		const terminateAndReject = async (error: Error) => {
			if (settling) {
				return;
			}
			settling = true;
			clearTimeout(timer);
			if (processGroupId !== undefined) {
				try {
					await terminateOwnedProcessGroup(processGroupId, terminationGraceMs);
				} catch {
					child.stdout?.destroy();
					child.stderr?.destroy();
					reject(new OwnedCommandError(
						`${commandLabel(executable, args)} failed to terminate its owned process group.`,
						processGroupId,
					));
					return;
				}
			}
			child.stdout?.destroy();
			child.stderr?.destroy();
			reject(error);
		};

		const recordOutput = (chunk: Buffer, keep: boolean) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maxOutputBytes) {
				void terminateAndReject(
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
			void terminateAndReject(
				new OwnedCommandError(
					`${commandLabel(executable, args)} failed to spawn: ${error.message}`,
					processGroupId,
				),
			);
		});
		child.once('close', (code, signal) => {
			if (settling) {
				return;
			}
			settling = true;
			clearTimeout(timer);
			if (code !== 0) {
				reject(new OwnedCommandError(
					`${commandLabel(executable, args)} exited with ${code ?? signal ?? 'unknown'}.`,
					processGroupId,
				));
				return;
			}
			resolve(Buffer.concat(stdoutChunks).toString('utf8'));
		});
	});
}

export async function terminateOwnedProcessGroup(
	processGroupId: number,
	graceMs: number,
): Promise<void> {
	signalProcessGroup(processGroupId, 'SIGTERM');
	await delay(graceMs);
	signalProcessGroup(processGroupId, 'SIGKILL');
	await delay(postKillWaitMs);
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-processGroupId, signal);
	} catch (error) {
		if (!isErrno(error, 'ESRCH')) {
			throw error;
		}
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
