import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
	parseEndpointDocument,
	sanitizeError,
	waitForOwnedStandaloneEndpoint,
	type AgentHostEndpointDocument,
} from '../spikes/agentHostEndpoint';
import {
	assertOwnedProcessControlSupported,
	OwnedCommandError,
	runOwnedCommand,
	terminateOwnedProcessGroup,
	type RunOwnedCommandOptions,
} from '../spikes/ownedProcess';
import { AgentRuntimeError } from './AgentRuntime';
import type { AgentHostSource } from './AgentRuntime';
import type WebSocket from 'ws';

const commandTimeoutMs = 10_000;
const startupTimeoutMs = 30_000;
const shutdownGraceMs = 5_000;

export interface AgentHostProbe {
	readonly available: boolean;
	readonly executable?: string;
	readonly version?: string;
	readonly commit?: string;
	readonly architecture?: string;
}

export interface LaunchedAgentHost {
	readonly endpoint: URL;
	readonly version: string;
	readonly registryProtocolVersion: string;
	readonly source?: AgentHostSource;
	readonly preserveTerminalSession?: boolean;
	openWebSocket?(signal?: AbortSignal): Promise<WebSocket>;
	onExit(listener: (error: AgentRuntimeError) => void): { dispose(): void };
	dispose(): Promise<void>;
}

export interface AgentHostLauncherOptions {
	readonly storageRoot: string;
	readonly configuredCodeCli?: string;
	readonly startupTimeoutMs?: number;
}

export interface AgentHostLauncherDependencies {
	readonly assertProcessControlSupported: () => void;
	readonly runCommand: (
		executable: string,
		args: readonly string[],
		options: RunOwnedCommandOptions,
	) => Promise<string>;
	readonly terminate: (processGroupId: number, graceMs: number) => Promise<void>;
	readonly remove: (path: string) => Promise<void>;
}

export interface AgentHostLauncherLike {
	probe(): Promise<AgentHostProbe>;
	launch(signal?: AbortSignal): Promise<LaunchedAgentHost>;
	dispose(): Promise<void>;
}

interface OwnedResource {
	dispose(): Promise<void>;
}

interface InFlightLaunch {
	readonly controller: AbortController;
	readonly promise: Promise<LaunchedAgentHost>;
}

export class AgentHostLauncher implements AgentHostLauncherLike {
	private readonly owned = new Set<OwnedResource>();
	private readonly auxiliaryProcessGroups = new Map<number, OwnedResource>();
	private readonly inFlight = new Set<InFlightLaunch>();
	private disposed = false;
	private readonly dependencies: AgentHostLauncherDependencies;

	constructor(
		private readonly options: AgentHostLauncherOptions,
		dependencies: Partial<AgentHostLauncherDependencies> = {},
	) {
		this.dependencies = {
			assertProcessControlSupported: assertOwnedProcessControlSupported,
			runCommand: runOwnedCommand,
			terminate: terminateOwnedProcessGroup,
			remove: (path) => rm(path, { recursive: true, force: true }),
			...dependencies,
		};
	}

	async probe(): Promise<AgentHostProbe> {
		try {
			this.dependencies.assertProcessControlSupported();
			const result = await discoverCodeCli(
				this.options.configuredCodeCli,
				undefined,
				(executable, args, options) => this.runCommand(executable, args, options),
			);
			return { available: true, ...result };
		} catch {
			return { available: false };
		}
	}

	launch(signal?: AbortSignal): Promise<LaunchedAgentHost> {
		if (this.disposed) {
			return Promise.reject(new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Agent Host launcher has been disposed.'));
		}
		if (signal?.aborted === true) {
			return Promise.reject(new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Agent Host launch was cancelled.'));
		}
		const controller = new AbortController();
		let operation: InFlightLaunch;
		const abort = () => controller.abort();
		signal?.addEventListener('abort', abort, { once: true });
		const promise = this.launchOwned(controller.signal).finally(() => {
			signal?.removeEventListener('abort', abort);
			this.inFlight.delete(operation);
		});
		operation = { controller, promise };
		this.inFlight.add(operation);
		return promise;
	}

	private async launchOwned(signal: AbortSignal): Promise<LaunchedAgentHost> {
		throwIfLaunchAborted(signal);
		try {
			this.dependencies.assertProcessControlSupported();
		} catch {
			throw new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'Reliable owned Agent Host process control is unavailable on this platform.',
			);
		}

		const code = await discoverCodeCli(
			this.options.configuredCodeCli,
			signal,
			(executable, args, options) => this.runCommand(executable, args, options),
		).catch(() => {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'A compatible VS Code command-line interface was not found.');
		});
		throwIfLaunchAborted(signal);
		await mkdir(this.options.storageRoot, { recursive: true });
		const ownedRoot = await mkdtemp(join(this.options.storageRoot, 'instance-'));
		const userDataDir = join(ownedRoot, 'user-data');
		const serverDataDir = join(ownedRoot, 'server-data');
		const tokenFile = join(ownedRoot, 'connection-token');
		const token = randomBytes(32).toString('hex');
		let processGroupId: number | undefined;
		let host: ChildProcess | undefined;
		let launched: OwnedAgentHost | undefined;
		let spawnError: Error | undefined;

		try {
			await Promise.all([
				mkdir(userDataDir),
				mkdir(serverDataDir),
				writeFile(tokenFile, token, { encoding: 'utf8', mode: 0o600 }),
			]);
			throwIfLaunchAborted(signal);
			const baseline = await discoverEndpoints(
				code.executable,
				userDataDir,
				commandTimeoutMs,
				signal,
				(executable, args, options) => this.runCommand(executable, args, options),
			);
			const baselineInstanceIds = new Set(baseline.endpoints.map(({ instanceId }) => instanceId));

			host = spawn(code.executable, [
				'agent',
				'host',
				'--new-instance',
				'--foreground',
				'--host',
				'127.0.0.1',
				'--port',
				'0',
				'--user-data-dir',
				userDataDir,
				'--server-data-dir',
				serverDataDir,
				'--connection-token-file',
				tokenFile,
				'--log',
				'error',
			], {
				detached: true,
				shell: false,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			host.once('error', (error) => {
				spawnError = error;
			});
			host.stdout?.resume();
			host.stderr?.resume();
			processGroupId = host.pid;
			if (processGroupId === undefined) {
				throw new Error('The Agent Host did not expose an owned process identifier.');
			}

			let ownedPids = new Set([processGroupId]);
			const endpoint = await waitForOwnedStandaloneEndpoint({
				baselineInstanceIds,
				discover: async (remainingMs) => {
					if (spawnError !== undefined) {
						throw spawnError;
					}
					if (host?.exitCode !== null) {
						throw new Error('The Agent Host exited before publishing its endpoint.');
					}
					throwIfLaunchAborted(signal);
					ownedPids = await readOwnedProcessGroup(
						processGroupId!,
						signal,
						(executable, args, options) => this.runCommand(executable, args, options),
					);
					return discoverEndpoints(
						code.executable,
						userDataDir,
						remainingMs,
						signal,
						(executable, args, options) => this.runCommand(executable, args, options),
					);
				},
				ownedPids: () => ownedPids,
				expectedToken: token,
				timeoutMs: this.options.startupTimeoutMs ?? startupTimeoutMs,
				pollIntervalMs: 500,
				signal,
			});

			launched = new OwnedAgentHost(
				host,
				processGroupId,
				ownedRoot,
				endpoint.url,
				code.version,
				endpoint.registryProtocolVersion,
				token,
				{
					terminate: this.dependencies.terminate,
					remove: this.dependencies.remove,
				},
				() => this.owned.delete(launched!),
			);
			this.owned.add(launched);
			if (this.disposed || signal.aborted) {
				await launched.dispose();
				throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Agent Host launch was cancelled during shutdown.');
			}
			return launched;
		} catch (error) {
			if (launched !== undefined) {
				throw normalizeLaunchError(error, token);
			}
			let cleanupError: AgentRuntimeError | undefined;
			if (processGroupId !== undefined) {
				const cleanup = new RetainedLaunchCleanup(
					processGroupId,
					ownedRoot,
					token,
					{
						terminate: this.dependencies.terminate,
						remove: this.dependencies.remove,
					},
					() => this.owned.delete(cleanup),
				);
				this.owned.add(cleanup);
				try {
					await cleanup.dispose();
				} catch (cleanupFailure) {
					cleanupError = normalizeLaunchError(cleanupFailure, token);
				}
			} else {
				try {
					await rm(ownedRoot, { recursive: true, force: true });
				} catch (cleanupFailure) {
					cleanupError = normalizeLaunchError(cleanupFailure, token);
				}
			}
			const primary = normalizeLaunchError(error, token);
			throw cleanupError === undefined ? primary : combineLaunchErrors(primary, cleanupError);
		}
	}

	private async runCommand(
		executable: string,
		args: readonly string[],
		options: RunOwnedCommandOptions,
	): Promise<string> {
		try {
			return await this.dependencies.runCommand(executable, args, options);
		} catch (error) {
			if (
				error instanceof OwnedCommandError
				&& error.cleanupRequired
				&& error.processGroupId !== undefined
			) {
				this.retainAuxiliaryProcessGroup(error.processGroupId);
			}
			throw error;
		}
	}

	private retainAuxiliaryProcessGroup(processGroupId: number): void {
		if (this.auxiliaryProcessGroups.has(processGroupId)) {
			return;
		}
		let cleanup: OwnedResource;
		cleanup = new RetainedProcessGroupCleanup(
			processGroupId,
			this.dependencies.terminate,
			() => {
				this.auxiliaryProcessGroups.delete(processGroupId);
				this.owned.delete(cleanup);
			},
		);
		this.auxiliaryProcessGroups.set(processGroupId, cleanup);
		this.owned.add(cleanup);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const launch of this.inFlight) {
			launch.controller.abort();
		}
		await Promise.allSettled([...this.inFlight].map(({ promise }) => promise));
		const results = await Promise.allSettled([...this.owned].map((resource) => resource.dispose()));
		if (results.some(({ status }) => status === 'rejected')) {
			throw new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'One or more owned Agent Host resources could not be shut down and remain tracked for retry.',
			);
		}
	}
}

export interface AgentHostCleanupDependencies {
	terminate(processGroupId: number, graceMs: number): Promise<void>;
	remove(path: string): Promise<void>;
}

export class OwnedAgentHost implements LaunchedAgentHost {
	private readonly exitListeners = new Set<(error: AgentRuntimeError) => void>();
	private disposing = false;
	private disposed = false;
	private disposal: Promise<void> | undefined;
	private processTerminated = false;
	private tempDirRemoved = false;

	constructor(
		private readonly child: ChildProcess,
		private readonly processGroupId: number,
		private readonly ownedRoot: string,
		readonly endpoint: URL,
		readonly version: string,
		readonly registryProtocolVersion: string,
		private readonly token: string,
		private readonly cleanup: AgentHostCleanupDependencies,
		private readonly didDispose: () => void,
	) {
		child.once('exit', (code, signal) => {
			if (this.disposing) {
				return;
			}
			const detail = code ?? signal ?? 'unknown';
			const error = new AgentRuntimeError(
				'TASK_RECOVERY_UNAVAILABLE',
				`The owned Agent Host exited unexpectedly (${detail}).`,
			);
			for (const listener of this.exitListeners) {
				listener(error);
			}
		});
	}

	onExit(listener: (error: AgentRuntimeError) => void): { dispose(): void } {
		this.exitListeners.add(listener);
		return { dispose: () => this.exitListeners.delete(listener) };
	}

	dispose(): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		this.disposal ??= this.disposeOwned().finally(() => {
			if (!this.disposed) {
				this.disposal = undefined;
			}
		});
		return this.disposal;
	}

	private async disposeOwned(): Promise<void> {
		this.disposing = true;
		if (!this.processTerminated) {
			try {
				await this.cleanup.terminate(this.processGroupId, shutdownGraceMs);
				this.processTerminated = true;
			} catch (error) {
				this.disposing = false;
				throw new AgentRuntimeError(
					'AGENT_UNAVAILABLE',
					'The owned Agent Host process group could not be terminated and remains tracked for retry.',
					false,
					sanitizeError(error, [this.token]),
					true,
				);
			}
		}
		if (!this.tempDirRemoved) {
			try {
				await this.cleanup.remove(this.ownedRoot);
				this.tempDirRemoved = true;
			} catch (error) {
				this.disposing = false;
				throw new AgentRuntimeError(
					'AGENT_UNAVAILABLE',
					'The owned Agent Host data could not be removed and remains tracked for retry.',
					false,
					sanitizeError(error, [this.token]),
					true,
				);
			}
		}
		this.disposed = true;
		this.exitListeners.clear();
		this.didDispose();
	}
}

class RetainedLaunchCleanup implements OwnedResource {
	private disposed = false;
	private disposal: Promise<void> | undefined;
	private processTerminated = false;
	private tempDirRemoved = false;

	constructor(
		private readonly processGroupId: number,
		private readonly ownedRoot: string,
		private readonly token: string,
		private readonly cleanup: AgentHostCleanupDependencies,
		private readonly didDispose: () => void,
	) {}

	dispose(): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		this.disposal ??= this.disposeOwned().finally(() => {
			if (!this.disposed) {
				this.disposal = undefined;
			}
		});
		return this.disposal;
	}

	private async disposeOwned(): Promise<void> {
		if (!this.processTerminated) {
			try {
				await this.cleanup.terminate(this.processGroupId, shutdownGraceMs);
				this.processTerminated = true;
			} catch (error) {
				throw normalizeLaunchError(error, this.token);
			}
		}
		if (!this.tempDirRemoved) {
			try {
				await this.cleanup.remove(this.ownedRoot);
				this.tempDirRemoved = true;
			} catch (error) {
				throw normalizeLaunchError(error, this.token);
			}
		}
		this.disposed = true;
		this.didDispose();
	}
}

class RetainedProcessGroupCleanup implements OwnedResource {
	private disposal: Promise<void> | undefined;
	private disposed = false;

	constructor(
		private readonly processGroupId: number,
		private readonly terminate: (processGroupId: number, graceMs: number) => Promise<void>,
		private readonly didDispose: () => void,
	) {}

	dispose(): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		this.disposal ??= this.terminate(this.processGroupId, shutdownGraceMs)
			.then(() => {
				this.disposed = true;
				this.didDispose();
			})
			.finally(() => {
				if (!this.disposed) {
					this.disposal = undefined;
				}
			});
		return this.disposal;
	}
}

type OwnedCommandRunner = AgentHostLauncherDependencies['runCommand'];

export async function discoverCodeCli(
	configuredCodeCli?: string,
	signal?: AbortSignal,
	runCommand: OwnedCommandRunner = runOwnedCommand,
): Promise<{
	readonly executable: string;
	readonly version: string;
	readonly commit: string;
	readonly architecture: string;
}> {
	const candidates = configuredCodeCli === undefined
		? defaultCodeCliCandidates()
		: [configuredCodeCli];
	for (const executable of candidates) {
		throwIfLaunchAborted(signal);
		try {
			const lines = (await runCommand(executable, ['--version'], {
				timeoutMs: commandTimeoutMs,
				maxOutputBytes: 16 * 1024,
				signal,
			})).trim().split(/\r?\n/u);
			if (lines.length >= 3 && lines[0] && lines[1] && lines[2]) {
				return {
					executable,
					version: lines[0],
					commit: lines[1],
					architecture: lines[2],
				};
			}
		} catch {
			continue;
		}
	}
	throw new Error('No compatible VS Code CLI candidate responded.');
}

function defaultCodeCliCandidates(): readonly string[] {
	switch (process.platform) {
		case 'darwin':
			return ['/usr/local/bin/code', '/opt/homebrew/bin/code', 'code'];
		case 'linux':
			return ['/usr/bin/code', '/usr/local/bin/code', 'code'];
		default:
			return ['code'];
	}
}

async function discoverEndpoints(
	codeCli: string,
	userDataDir: string,
	timeoutMs: number,
	signal?: AbortSignal,
	runCommand: OwnedCommandRunner = runOwnedCommand,
): Promise<AgentHostEndpointDocument> {
	const stdout = await runCommand(
		codeCli,
		['agent', 'endpoints', '--user-data-dir', userDataDir],
		{ timeoutMs, maxOutputBytes: 1024 * 1024, signal },
	);
	const document = parseEndpointDocument(stdout);
	if (resolve(document.userDataPath) !== resolve(userDataDir)) {
		throw new Error('The Agent Host endpoint registry did not belong to the owned user-data directory.');
	}
	return document;
}

async function readOwnedProcessGroup(
	processGroupId: number,
	signal?: AbortSignal,
	runCommand: OwnedCommandRunner = runOwnedCommand,
): Promise<Set<number>> {
	const stdout = await runCommand('ps', ['-axo', 'pid=,pgid='], {
		timeoutMs: commandTimeoutMs,
		maxOutputBytes: 1024 * 1024,
		signal,
	});
	return new Set(stdout
		.split(/\r?\n/u)
		.map((line) => line.trim().split(/\s+/u).map(Number))
		.filter((pair) => pair.length === 2 && pair[1] === processGroupId)
		.map((pair) => pair[0])
		.filter((pid): pid is number => pid !== undefined && Number.isInteger(pid) && pid > 0));
}

function throwIfLaunchAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Agent Host launch was cancelled during shutdown.');
	}
}

function normalizeLaunchError(error: unknown, token: string): AgentRuntimeError {
	if (error instanceof AgentRuntimeError) {
		return error;
	}
	return new AgentRuntimeError(
		'AGENT_UNAVAILABLE',
		sanitizeError(error, [token]).message,
	);
}

function combineLaunchErrors(primary: AgentRuntimeError, cleanup: AgentRuntimeError): AgentRuntimeError {
	return new AgentRuntimeError(
		primary.code,
		`${primary.message} Owned Agent Host cleanup also failed and remains tracked for retry.`,
		primary.retryable,
		new AggregateError([
			new AgentRuntimeError(primary.code, primary.message, primary.retryable),
			new AgentRuntimeError(cleanup.code, cleanup.message, cleanup.retryable, cleanup.cause),
		], 'Agent Host launch and cleanup both failed.'),
		true,
	);
}
