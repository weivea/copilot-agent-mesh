import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
	parseEndpointDocument,
	redactSecrets,
	requireGlobalWebSocket,
	waitForOwnedStandaloneEndpoint,
	type AgentHostEndpointDocument,
} from './agentHostEndpoint';

const optInEnvironmentVariable = 'MESH_AGENT_HOST_E2E';
const expectedAhpPackageVersion = '0.8.0';
const expectedAhpDependency = 'file:vendor/microsoft-agent-host-protocol-0.8.0.tgz';
const startupTimeoutMs = 30_000;
const commandTimeoutMs = 10_000;
const webSocketTimeoutMs = 10_000;
const shutdownTimeoutMs = 5_000;

interface SafeSpikeResult {
	codeVersion: string;
	codeCommit: string;
	codeArchitecture: string;
	ahpPackageVersion: string;
	ahpSupportedProtocolVersions: readonly string[];
	negotiatedProtocolVersion: string;
	registryProtocolVersion: string;
	endpoint: string;
	providers: Array<{
		provider: string;
		displayName: string;
		protectedResourceCount: number;
	}>;
	globalWebSocket: true;
}

async function main(): Promise<void> {
	if (process.env[optInEnvironmentVariable] !== '1') {
		console.log(`Agent Host spike skipped. Set ${optInEnvironmentVariable}=1 to run the disposable real-host probe.`);
		return;
	}

	console.warn('Opt-in Agent Host probe enabled. Later session/turn probes may consume GitHub Copilot quota.');
	const result = await runAgentHostSpike(process.env.MESH_CODE_CLI ?? 'code');
	console.log(JSON.stringify(result, null, 2));
}

export async function runAgentHostSpike(codeCli: string): Promise<SafeSpikeResult> {
	const ownedRoot = await mkdtemp(join(tmpdir(), 'copilot-agent-mesh-ahp-'));
	const userDataDir = join(ownedRoot, 'user-data');
	const serverDataDir = join(ownedRoot, 'server-data');
	const workspaceDir = join(ownedRoot, 'workspace');
	const tokenFile = join(ownedRoot, 'connection-token');
	const token = randomBytes(32).toString('hex');
	let host: ChildProcess | undefined;
	let client: { shutdown(): Promise<void> } | undefined;
	let ownedPids = new Set<number>();
	let operationError: Error | undefined;
	let hostSpawnError: Error | undefined;

	try {
		await Promise.all([
			mkdir(userDataDir),
			mkdir(serverDataDir),
			mkdir(workspaceDir),
			writeFile(tokenFile, token, { encoding: 'utf8', mode: 0o600 }),
		]);

		const baseline = await discoverEndpoints(codeCli, userDataDir, commandTimeoutMs);
		const baselineInstanceIds = new Set(baseline.endpoints.map(({ instanceId }) => instanceId));
		const version = await readCodeVersion(codeCli);

		const spawnedHost = spawn(codeCli, [
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
			shell: false,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		host = spawnedHost;
		spawnedHost.once('error', (error) => {
			hostSpawnError = error;
		});

		// Drain but never log readiness output: current builds include the token in that text.
		spawnedHost.stdout?.resume();
		spawnedHost.stderr?.resume();
		const ownedPid = spawnedHost.pid;
		if (ownedPid === undefined) {
			throw new Error('The Agent Host process did not expose an owned PID.');
		}
		ownedPids.add(ownedPid);

		const selected = await waitForOwnedStandaloneEndpoint({
			baselineInstanceIds,
			discover: async (remainingMs) => {
				if (hostSpawnError !== undefined) {
					throw new Error(`The Agent Host process failed to spawn: ${hostSpawnError.message}`);
				}
				if (host?.exitCode !== null) {
					throw new Error(`The owned Agent Host exited before endpoint discovery (code ${host?.exitCode ?? 'unknown'}).`);
				}
				ownedPids = await readOwnedProcessTree(ownedPid);
				return discoverEndpoints(codeCli, userDataDir, remainingMs);
			},
			ownedPids: () => ownedPids,
			expectedToken: token,
			timeoutMs: startupTimeoutMs,
			pollIntervalMs: 500,
		});

		requireGlobalWebSocket();
		const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
			dependencies?: Record<string, string>;
		};
		const dependency = manifest.dependencies?.['@microsoft/agent-host-protocol'];
		if (dependency !== expectedAhpDependency) {
			throw new Error(`AHP must use the audited dependency ${expectedAhpDependency}; found ${dependency ?? 'missing'}.`);
		}
		const packageVersion = await readInstalledAhpPackageVersion();
		if (packageVersion !== expectedAhpPackageVersion) {
			throw new Error(`The installed AHP package must be ${expectedAhpPackageVersion}; found ${packageVersion}.`);
		}

		const protocol = await import('@microsoft/agent-host-protocol');
		const clientModule = await import('@microsoft/agent-host-protocol/client');
		const webSocketModule = await import('@microsoft/agent-host-protocol/ws');
		const socket = await connectGlobalWebSocket(selected.url, webSocketTimeoutMs);
		const transport = webSocketModule.WebSocketTransport.fromSocket(socket);
		const ahpClient = new clientModule.AhpClient(transport, { requestTimeoutMs: 20_000 });
		client = ahpClient;
		ahpClient.connect();
		const initializeResult = await ahpClient.initialize({
			clientId: `copilot-agent-mesh-spike-${randomUUID()}`,
			protocolVersions: [...protocol.SUPPORTED_PROTOCOL_VERSIONS],
			initialSubscriptions: ['ahp-root://'],
			locale: 'en-US',
		});
		if (!protocol.SUPPORTED_PROTOCOL_VERSIONS.includes(initializeResult.protocolVersion)) {
			throw new Error(`Host selected unoffered AHP protocol ${initializeResult.protocolVersion}.`);
		}

		const rootSnapshot = initializeResult.snapshots.find(({ resource }) => resource === 'ahp-root://');
		if (rootSnapshot === undefined) {
			throw new Error('AHP initialize did not return the requested ahp-root:// snapshot.');
		}
		ownedPids.add(selected.pid);

		return {
			...version,
			ahpPackageVersion: packageVersion,
			ahpSupportedProtocolVersions: protocol.SUPPORTED_PROTOCOL_VERSIONS,
			negotiatedProtocolVersion: initializeResult.protocolVersion,
			registryProtocolVersion: selected.registryProtocolVersion,
			endpoint: `${selected.url.protocol}//${selected.url.hostname}:${selected.url.port}`,
			providers: readSafeProviderEvidence(rootSnapshot.state),
			globalWebSocket: true,
		};
	} catch (error) {
		operationError = new Error(redactSecrets(toErrorMessage(error), [token]), { cause: error });
		throw operationError;
	} finally {
		const cleanupErrors: unknown[] = [];
		if (client !== undefined) {
			try {
				await withTimeout(
					client.shutdown(),
					shutdownTimeoutMs,
					`Timed out after ${shutdownTimeoutMs}ms shutting down the AHP client.`,
				);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		if (host !== undefined) {
			try {
				await terminateOwnedHost(host, ownedPids);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		try {
			await rm(ownedRoot, { recursive: true, force: true });
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
				'Agent Host spike cleanup failed.',
			);
		}
	}
}

async function discoverEndpoints(
	codeCli: string,
	userDataDir: string,
	timeoutMs: number,
): Promise<AgentHostEndpointDocument> {
	const stdout = await execute(
		codeCli,
		['agent', 'endpoints', '--user-data-dir', userDataDir],
		timeoutMs,
	);
	const document = parseEndpointDocument(stdout);
	if (resolve(document.userDataPath) !== resolve(userDataDir)) {
		throw new Error('The Agent Host endpoint registry did not belong to the requested user-data directory.');
	}
	return document;
}

async function readCodeVersion(codeCli: string): Promise<Pick<SafeSpikeResult, 'codeVersion' | 'codeCommit' | 'codeArchitecture'>> {
	const lines = (await execute(codeCli, ['--version'], commandTimeoutMs))
		.trim()
		.split(/\r?\n/u);
	if (lines.length < 3 || lines.some((line) => line.length === 0)) {
		throw new Error('The code CLI returned an unexpected version document.');
	}
	return {
		codeVersion: lines[0] ?? '',
		codeCommit: lines[1] ?? '',
		codeArchitecture: lines[2] ?? '',
	};
}

function execute(executable: string, args: readonly string[], timeoutMs = commandTimeoutMs): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(executable, [...args], {
			encoding: 'utf8',
			killSignal: 'SIGKILL',
			maxBuffer: 1024 * 1024,
			timeout: timeoutMs,
			windowsHide: true,
		}, (error, stdout) => {
			if (error) {
				reject(new Error(`${executable} ${args.slice(0, 2).join(' ')} failed with exit code ${error.code ?? 'unknown'}.`));
				return;
			}
			resolve(stdout);
		});
	});
}

async function readOwnedProcessTree(rootPid: number): Promise<Set<number>> {
	const relationships = process.platform === 'win32'
		? await readWindowsProcessRelationships()
		: await readPosixProcessRelationships();
	const owned = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, parentPid] of relationships) {
			if (owned.has(parentPid) && !owned.has(pid)) {
				owned.add(pid);
				changed = true;
			}
		}
	}
	return owned;
}

async function readPosixProcessRelationships(): Promise<Array<[number, number]>> {
	const stdout = await execute('ps', ['-axo', 'pid=,ppid='], commandTimeoutMs);
	return stdout
		.split(/\r?\n/u)
		.map((line) => line.trim().split(/\s+/u).map(Number))
		.filter((pair): pair is [number, number] =>
			pair.length === 2 && pair.every((value) => Number.isInteger(value) && value > 0),
		);
}

async function readWindowsProcessRelationships(): Promise<Array<[number, number]>> {
	const stdout = await execute('powershell.exe', [
		'-NoProfile',
		'-NonInteractive',
		'-Command',
		'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
	], commandTimeoutMs);
	const parsed = JSON.parse(stdout) as unknown;
	const entries = Array.isArray(parsed) ? parsed : [parsed];
	return entries.flatMap((entry): Array<[number, number]> => {
		if (!isRecord(entry)
			|| !isPositiveInteger(entry.ProcessId)
			|| !isPositiveInteger(entry.ParentProcessId)) {
			return [];
		}
		return [[entry.ProcessId, entry.ParentProcessId]];
	});
}

async function terminateOwnedHost(host: ChildProcess, knownOwnedPids: ReadonlySet<number>): Promise<void> {
	if (host.pid === undefined) {
		return;
	}
	const ownedPids = await readOwnedProcessTree(host.pid).catch(() => new Set(knownOwnedPids));
	for (const pid of knownOwnedPids) {
		ownedPids.add(pid);
	}
	signalOwnedPids(ownedPids, host.pid, 'SIGTERM');
	try {
		await waitForOwnedPidsToExit(ownedPids, 5_000);
	} catch {
		signalOwnedPids(ownedPids, host.pid, 'SIGKILL');
		await waitForOwnedPidsToExit(ownedPids, 5_000);
	}
}

function signalOwnedPids(pids: ReadonlySet<number>, launcherPid: number | undefined, signal: NodeJS.Signals): void {
	const orderedPids = [...pids].filter((pid) => pid !== launcherPid);
	if (launcherPid !== undefined) {
		orderedPids.push(launcherPid);
	}
	for (const pid of orderedPids) {
		try {
			process.kill(pid, signal);
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ESRCH') {
				throw error;
			}
		}
	}
}

async function waitForOwnedPidsToExit(pids: ReadonlySet<number>, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while ([...pids].some(isProcessAlive)) {
		if (Date.now() >= deadline) {
			throw new Error(`Owned Agent Host processes did not exit within ${timeoutMs}ms.`);
		}
		await delay(50);
	}
}

async function readInstalledAhpPackageVersion(): Promise<string> {
	const packageJsonPath = join(
		process.cwd(),
		'node_modules',
		'@microsoft',
		'agent-host-protocol',
		'package.json',
	);
	const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
		name?: string;
		version?: string;
	};
	if (manifest.name !== '@microsoft/agent-host-protocol' || typeof manifest.version !== 'string') {
		throw new Error('The installed AHP package metadata is invalid.');
	}
	return manifest.version;
}

function connectGlobalWebSocket(url: URL, timeoutMs: number): Promise<WebSocket> {
	return new Promise((resolveSocket, reject) => {
		const socket = new globalThis.WebSocket(url);
		const timer = setTimeout(() => {
			cleanup();
			socket.close();
			reject(new Error(`Timed out after ${timeoutMs}ms connecting to the owned Agent Host WebSocket.`));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			socket.removeEventListener('open', handleOpen);
			socket.removeEventListener('error', handleError);
			socket.removeEventListener('close', handleClose);
		};
		const handleOpen = () => {
			cleanup();
			resolveSocket(socket);
		};
		const handleError = () => {
			cleanup();
			reject(new Error('The owned Agent Host WebSocket failed to open.'));
		};
		const handleClose = (event: unknown) => {
			cleanup();
			const code = isRecord(event) && typeof event.code === 'number' ? event.code : 'unknown';
			reject(new Error(`The owned Agent Host WebSocket closed before opening (code ${code}).`));
		};
		socket.addEventListener('open', handleOpen);
		socket.addEventListener('error', handleError);
		socket.addEventListener('close', handleClose);
	});
}

function readSafeProviderEvidence(state: unknown): SafeSpikeResult['providers'] {
	if (!isRecord(state) || !Array.isArray(state.agents)) {
		throw new Error('The ahp-root:// snapshot did not contain an agents array.');
	}
	return state.agents.map((agent) => {
		if (!isRecord(agent)
			|| typeof agent.provider !== 'string'
			|| agent.provider.length === 0
			|| typeof agent.displayName !== 'string') {
			throw new Error('The ahp-root:// snapshot contained an invalid agent entry.');
		}
		return {
			provider: agent.provider,
			displayName: agent.displayName,
			protectedResourceCount: Array.isArray(agent.protectedResources) ? agent.protectedResources.length : 0,
		};
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isRecord(error) && error.code === 'ESRCH') {
			return false;
		}
		throw error;
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

void main().catch((error: unknown) => {
	console.error(`Agent Host spike failed: ${redactSecrets(toErrorMessage(error))}`);
	process.exitCode = 1;
});
