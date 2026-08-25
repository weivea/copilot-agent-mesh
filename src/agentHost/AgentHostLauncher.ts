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
	runOwnedCommand,
	terminateOwnedProcessGroup,
} from '../spikes/ownedProcess';
import { AgentRuntimeError } from './AgentRuntime';

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
	onExit(listener: (error: AgentRuntimeError) => void): { dispose(): void };
	dispose(): Promise<void>;
}

export interface AgentHostLauncherOptions {
	readonly storageRoot: string;
	readonly configuredCodeCli?: string;
	readonly startupTimeoutMs?: number;
}

export interface AgentHostLauncherLike {
	probe(): Promise<AgentHostProbe>;
	launch(): Promise<LaunchedAgentHost>;
	dispose(): Promise<void>;
}

export class AgentHostLauncher implements AgentHostLauncherLike {
	private readonly launched = new Set<LaunchedAgentHost>();
	private disposed = false;

	constructor(private readonly options: AgentHostLauncherOptions) {}

	async probe(): Promise<AgentHostProbe> {
		try {
			assertOwnedProcessControlSupported();
			const result = await discoverCodeCli(this.options.configuredCodeCli);
			return { available: true, ...result };
		} catch {
			return { available: false };
		}
	}

	async launch(): Promise<LaunchedAgentHost> {
		if (this.disposed) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Agent Host launcher has been disposed.');
		}
		try {
			assertOwnedProcessControlSupported();
		} catch {
			throw new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'Reliable owned Agent Host process control is unavailable on this platform.',
			);
		}

		const code = await discoverCodeCli(this.options.configuredCodeCli).catch(() => {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'A compatible VS Code command-line interface was not found.');
		});
		await mkdir(this.options.storageRoot, { recursive: true });
		const ownedRoot = await mkdtemp(join(this.options.storageRoot, 'instance-'));
		const userDataDir = join(ownedRoot, 'user-data');
		const serverDataDir = join(ownedRoot, 'server-data');
		const tokenFile = join(ownedRoot, 'connection-token');
		const token = randomBytes(32).toString('hex');
		let processGroupId: number | undefined;
		let host: ChildProcess | undefined;

		try {
			await Promise.all([
				mkdir(userDataDir),
				mkdir(serverDataDir),
				writeFile(tokenFile, token, { encoding: 'utf8', mode: 0o600 }),
			]);
			const baseline = await discoverEndpoints(code.executable, userDataDir, commandTimeoutMs);
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
			host.stdout?.resume();
			host.stderr?.resume();
			processGroupId = host.pid;
			if (processGroupId === undefined) {
				throw new Error('The Agent Host did not expose an owned process identifier.');
			}

			let spawnError: Error | undefined;
			host.once('error', (error) => {
				spawnError = error;
			});
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
					ownedPids = await readOwnedProcessGroup(processGroupId!);
					return discoverEndpoints(code.executable, userDataDir, remainingMs);
				},
				ownedPids: () => ownedPids,
				expectedToken: token,
				timeoutMs: this.options.startupTimeoutMs ?? startupTimeoutMs,
				pollIntervalMs: 500,
			});

			const launched = new OwnedAgentHost(
				host,
				processGroupId,
				ownedRoot,
				endpoint.url,
				code.version,
				endpoint.registryProtocolVersion,
				token,
				() => this.launched.delete(launched),
			);
			this.launched.add(launched);
			return launched;
		} catch (error) {
			if (processGroupId !== undefined) {
				await terminateOwnedProcessGroup(processGroupId, shutdownGraceMs).catch(() => undefined);
			}
			await rm(ownedRoot, { recursive: true, force: true }).catch(() => undefined);
			if (error instanceof AgentRuntimeError) {
				throw error;
			}
			throw new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				sanitizeError(error, [token]).message,
			);
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await Promise.all([...this.launched].map((host) => host.dispose()));
	}
}

class OwnedAgentHost implements LaunchedAgentHost {
	private readonly exitListeners = new Set<(error: AgentRuntimeError) => void>();
	private disposing = false;
	private disposed = false;

	constructor(
		private readonly child: ChildProcess,
		private readonly processGroupId: number,
		private readonly ownedRoot: string,
		readonly endpoint: URL,
		readonly version: string,
		readonly registryProtocolVersion: string,
		private readonly token: string,
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

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposing = true;
		const errors: Error[] = [];
		try {
			await terminateOwnedProcessGroup(this.processGroupId, shutdownGraceMs);
		} catch (error) {
			errors.push(sanitizeError(error, [this.token]));
		}
		try {
			await rm(this.ownedRoot, { recursive: true, force: true });
		} catch (error) {
			errors.push(sanitizeError(error, [this.token]));
		}
		this.disposed = true;
		this.exitListeners.clear();
		this.didDispose();
		if (errors.length > 0) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The owned Agent Host could not be completely shut down.');
		}
	}
}

async function discoverCodeCli(configuredCodeCli?: string): Promise<{
	readonly executable: string;
	readonly version: string;
	readonly commit: string;
	readonly architecture: string;
}> {
	const candidates = configuredCodeCli === undefined
		? defaultCodeCliCandidates()
		: [configuredCodeCli];
	for (const executable of candidates) {
		try {
			const lines = (await runOwnedCommand(executable, ['--version'], {
				timeoutMs: commandTimeoutMs,
				maxOutputBytes: 16 * 1024,
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
): Promise<AgentHostEndpointDocument> {
	const stdout = await runOwnedCommand(
		codeCli,
		['agent', 'endpoints', '--user-data-dir', userDataDir],
		{ timeoutMs, maxOutputBytes: 1024 * 1024 },
	);
	const document = parseEndpointDocument(stdout);
	if (resolve(document.userDataPath) !== resolve(userDataDir)) {
		throw new Error('The Agent Host endpoint registry did not belong to the owned user-data directory.');
	}
	return document;
}

async function readOwnedProcessGroup(processGroupId: number): Promise<Set<number>> {
	const stdout = await runOwnedCommand('ps', ['-axo', 'pid=,pgid='], {
		timeoutMs: commandTimeoutMs,
		maxOutputBytes: 1024 * 1024,
	});
	return new Set(stdout
		.split(/\r?\n/u)
		.map((line) => line.trim().split(/\s+/u).map(Number))
		.filter((pair) => pair.length === 2 && pair[1] === processGroupId)
		.map((pair) => pair[0])
		.filter((pid): pid is number => pid !== undefined && Number.isInteger(pid) && pid > 0));
}
