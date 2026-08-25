import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	downloadAndUnzipVSCode,
	resolveCliPathFromVSCodeExecutablePath,
	runTests,
} from '@vscode/test-electron';

const expectedDevTunnelSha256 = '004f3cc8ebcce61223bacac80d31937eb2e92eaee9a05600a1cb62fb5f775afe';
const devTunnelUrl = 'https://tunnelsassetsprod.blob.core.windows.net/cli/1.0.2030+fc9273aa0f/osx-arm64-devtunnel';
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'timedOut']);
const forceFallbackCleanup = process.env.MESH_TWO_DEVICE_E2E_FORCE_FALLBACK_CLEANUP === '1';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const require = createRequire(import.meta.url);
const {
	decodeDevTunnelShowJson,
	isExactDevTunnelNotFound,
	SUPPORTED_DEVTUNNEL_BUILD,
} = require(join(repoRoot, 'out/src/tunnel/DevTunnelJsonDecoder.js'));

if (process.env.MESH_TWO_DEVICE_E2E !== '1') {
	throw new Error('MESH_TWO_DEVICE_E2E=1 is required because this test creates a public Dev Tunnel and may invoke Agent Host.');
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
	throw new Error('The real two-instance E2E requires macOS arm64.');
}

const evidenceRoot = process.env.MESH_TWO_DEVICE_E2E_EVIDENCE_DIR
	? resolve(process.env.MESH_TWO_DEVICE_E2E_EVIDENCE_DIR)
	: await mkdtemp(join(tmpdir(), 'copilot-agent-mesh-two-instance-e2e-'));
const runtimeRoot = await mkdtemp(join(tmpdir(), 'cam2-'));
const worker = hostPaths('worker');
const coordinator = hostPaths('coordinator');
const workspace = join(runtimeRoot, 'temporary-workspace');
const extensionTestsPath = join(repoRoot, 'out/src/e2e/twoInstanceHost.js');
const rawLogs = [];
let invitation;
let devTunnelPath;
let downloadedDevTunnel = false;
let workerRun;
let coordinatorRun;
let tunnelCleanup = 'not-attempted';
let tunnelCleanupMethod = 'in-host';
let authOutcome = { state: 'not-run' };
let cancelOutcome = { state: 'not-run' };
let directory;
let runtimeProbe;
let vscodeExecutablePath;
let codeCli;
let profilesRemoved = false;
let ownedProcessesStopped = false;
let hostFailures = [];
let baselineConfiguredDevTunnelPids = new Set();
let ownedTunnel;
let cleanupFailure;
let listenerStartAttempted = false;

try {
	await Promise.all([
		mkdir(workspace, { recursive: true }),
		prepareHost(worker),
		prepareHost(coordinator),
	]);
	await writeFile(join(workspace, 'README.txt'), 'Temporary non-sensitive two-instance E2E workspace.\n', 'utf8');

	({ path: devTunnelPath, downloaded: downloadedDevTunnel } = await prepareDevTunnel());
	if (!downloadedDevTunnel) {
		baselineConfiguredDevTunnelPids = new Set(
			listProcessesByExecutable(devTunnelPath).map(({ pid }) => pid),
		);
	}
	vscodeExecutablePath = process.env.MESH_VSCODE_EXECUTABLE
		? resolve(process.env.MESH_VSCODE_EXECUTABLE)
		: await downloadAndUnzipVSCode('stable');
	codeCli = process.env.MESH_CODE_CLI
		? resolve(process.env.MESH_CODE_CLI)
		: resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);

	await Promise.all([
		writeSettings(worker, 'Mesh Worker', true),
		writeSettings(coordinator, 'Mesh Coordinator', false),
	]);

	workerRun = launchHost(worker, 'worker');
	coordinatorRun = launchHost(coordinator, 'coordinator');
	await Promise.all([waitForFile(join(worker.control, 'ready.json'), 60_000), waitForFile(join(coordinator.control, 'ready.json'), 60_000)]);

	const registered = await request(worker, 'workspace.register');
	const workerWorkspace = registered.workspaces?.[0];
	if (!workerWorkspace?.workspaceId || workerWorkspace.name !== 'temporary-workspace') {
		throw new Error('Worker did not register the temporary workspace.');
	}
	listenerStartAttempted = true;
	await request(worker, 'listener.start', {}, 120_000);
	ownedTunnel = await request(worker, 'tunnel.metadata');
	await writeFile(join(worker.control, 'owned-tunnel.json'), `${JSON.stringify({
		...ownedTunnel,
		controlPath: worker.control,
		globalStoragePath: join(
			worker.userData,
			'User/globalStorage/weivea.copilot-agent-mesh',
		),
	})}\n`, { mode: 0o600 });
	const invitationResponse = await request(worker, 'listener.invite');
	invitation = invitationResponse.connectionUrl;
	if (typeof invitation !== 'string' || !invitation.startsWith('https://')) {
		throw new Error('Worker did not create a secure connection invitation.');
	}
	await request(coordinator, 'peer.add', { connectionUrl: invitation });
	directory = await waitForDirectory(workerWorkspace.workspaceId);
	const target = directory.workers[0];

	runtimeProbe = await request(worker, 'runtime.probe');
	if (!runtimeProbe.available || !runtimeProbe.featureEnabled) {
		throw new Error('The production Agent Host runtime did not pass its real probe.');
	}

	const authProvider = process.env.MESH_TWO_DEVICE_E2E_AUTH_PROVIDER ?? 'github';
	const authScopes = parseStringArray(process.env.MESH_TWO_DEVICE_E2E_AUTH_SCOPES_JSON, []);
	const authAvailability = await request(worker, 'auth.check', {
		providerId: authProvider,
		scopes: authScopes,
	});
	const cancelTask = await request(coordinator, 'task.start', {
		peerId: target.peerId,
		workspaceId: workerWorkspace.workspaceId,
		title: 'Two-instance cancellation probe',
		prompt: 'Wait for cancellation. Do not modify files or run commands.',
		acceptanceCriteria: ['Cancellation is confirmed through the real remote task chain.'],
	});
	const cancelReady = await waitForTaskEventOrTerminal(cancelTask.taskId, 'agentStarted', 60_000);
	if (cancelReady.kind === 'event') {
		await request(coordinator, 'task.cancel', { taskId: cancelTask.taskId });
		const cancelled = await waitForTask(cancelTask.taskId, 60_000);
		if (cancelled.snapshot.status !== 'cancelled') {
			throw new Error(`Real cancellation finished as ${cancelled.snapshot.status}.`);
		}
		const cancellationEvents = cancelled.events.map((event) => event.type);
		for (const required of ['agentStarted', 'cancelRequested', 'cancelConfirmed']) {
			if (!cancellationEvents.includes(required)) {
				throw new Error(`Real cancellation did not emit ${required}.`);
			}
		}
		const runtimeCancellation = await request(worker, 'task.runtimeCancelObserved', {
			taskId: cancelTask.taskId,
		});
		if (runtimeCancellation.observed !== true) {
			throw new Error('Worker did not observe AgentTaskHandle.cancel().');
		}
		cancelOutcome = {
			state: 'cancelled',
			eventTypes: cancellationEvents,
			runtimeHandleCancelObserved: true,
		};
		const authTask = await request(coordinator, 'task.start', {
			peerId: target.peerId,
			workspaceId: workerWorkspace.workspaceId,
			title: 'Two-instance real AHP probe',
			prompt: 'Reply with exactly MESH_TWO_INSTANCE_E2E_OK. Do not modify files or run commands.',
			acceptanceCriteria: ['Authoritative AHP turnComplete is observed when authentication is available.'],
		});
		const authResult = await waitForTask(authTask.taskId, 180_000);
		if (
			authResult.snapshot.status !== 'completed'
			|| !authResult.events.some((event) => event.type === 'completed')
		) {
			throw new Error('Authenticated AHP did not produce authoritative turnComplete.');
		}
		authOutcome = {
			state: 'turnComplete',
			authSessionAvailable: authAvailability.available === true,
			eventTypes: authResult.events.map((event) => event.type),
		};
	} else if (
		cancelReady.value.snapshot.status === 'failed'
		&& cancelReady.value.snapshot.failure?.code === 'AGENT_AUTH_REQUIRED'
	) {
		if (
			process.env.MESH_TWO_DEVICE_E2E_AUTH_RESOURCE
			&& process.env.MESH_TWO_DEVICE_E2E_AUTH_PROVIDER
			&& authAvailability.available === true
		) {
			throw new Error('Explicit available VS Code authentication did not produce an authoritative AHP turn.');
		}
		authOutcome = {
			state: 'blocked',
			code: 'AGENT_AUTH_REQUIRED',
			authSessionAvailable: authAvailability.available === true,
		};
		cancelOutcome = {
			state: 'blocked',
			code: 'AGENT_AUTH_REQUIRED',
			reason: 'AgentTaskHandle was not acquired; cancellation was not claimed.',
		};
	} else {
		throw new Error(
			`Cancellation probe ended before agentStarted: ${JSON.stringify(
				cancelReady.value.snapshot.failure ?? cancelReady.value.snapshot.status,
			)}`,
		);
	}

	await request(worker, 'listener.stop');
	if (forceFallbackCleanup) {
		tunnelCleanup = 'fallback-required';
	} else {
		const cleanup = await request(worker, 'tunnel.cleanup', {}, 60_000);
		tunnelCleanup = cleanup.cleanup;
		if (!['deleted', 'already-absent'].includes(tunnelCleanup)) {
			throw new Error('Owned Tunnel cleanup was not confirmed.');
		}
	}
} finally {
	invitation = undefined;
	if (
		!forceFallbackCleanup
		&& !['deleted', 'already-absent'].includes(tunnelCleanup)
	) {
		await request(worker, 'listener.stop', {}, 15_000).catch(() => undefined);
		const cleanup = await request(worker, 'tunnel.cleanup', {}, 45_000).catch((error) => {
			cleanupFailure = error;
			return undefined;
		});
		if (cleanup?.cleanup) {
			tunnelCleanup = cleanup.cleanup;
		}
	}
	await Promise.allSettled([
		shutdownHost(worker),
		shutdownHost(coordinator),
	]);
	const ownedMarkers = [
		runtimeRoot,
		worker.userData,
		coordinator.userData,
		worker.extensions,
		coordinator.extensions,
		join(worker.userData, 'User/globalStorage/weivea.copilot-agent-mesh/agent-host'),
	].filter((marker) => typeof marker === 'string');
	const hostSettlement = Promise.allSettled([workerRun, coordinatorRun].filter(Boolean));
	let hostResults = await Promise.race([
		hostSettlement,
		delay(15_000).then(() => undefined),
	]);
	if (hostResults === undefined) {
		await terminateOwnedProcesses(ownedMarkers);
		hostResults = await Promise.race([
			hostSettlement,
			delay(10_000).then(() => undefined),
		]);
	}
	if (hostResults === undefined) {
		hostFailures.push(new Error('VS Code Development Hosts did not exit after owned-process termination.'));
	} else {
		hostFailures.push(...hostResults.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		));
	}
	await terminateOwnedProcesses(ownedMarkers);
	const configuredLeaks = downloadedDevTunnel
		? []
		: listProcessesByExecutable(devTunnelPath).filter(
			({ pid }) => !baselineConfiguredDevTunnelPids.has(pid),
		);
	ownedProcessesStopped = listOwnedProcesses(ownedMarkers).length === 0
		&& configuredLeaks.length === 0;

	if (
		!['deleted', 'already-absent'].includes(tunnelCleanup)
		&& ownedTunnel !== undefined
	) {
		try {
			tunnelCleanup = await fallbackDeleteOwnedTunnel(ownedTunnel);
			tunnelCleanupMethod = 'exact-cli-fallback';
			cleanupFailure = undefined;
		} catch (error) {
			cleanupFailure = error;
		}
	}
	const cleanupConfirmed = ['deleted', 'already-absent'].includes(tunnelCleanup);
	if (cleanupConfirmed || !listenerStartAttempted) {
		for (const path of [
			worker.userData,
			worker.extensions,
			worker.control,
			coordinator.userData,
			coordinator.extensions,
			coordinator.control,
			workspace,
		]) {
			await rm(path, { recursive: true, force: true });
		}
		profilesRemoved = await allAbsent([
			worker.userData,
			worker.extensions,
			worker.control,
			coordinator.userData,
			coordinator.extensions,
			coordinator.control,
			workspace,
		]);
		if (downloadedDevTunnel && devTunnelPath) {
			await rm(devTunnelPath, { force: true });
		}
	}
	await sanitizeLogs();
	if (cleanupConfirmed || !listenerStartAttempted) {
		await rm(runtimeRoot, { recursive: true, force: true });
	} else {
		await writeFile(join(evidenceRoot, 'cleanup-failure.json'), `${JSON.stringify({
			cleanup: 'unconfirmed',
			metadataRetained: true,
			errorCode: 'CLEANUP_UNCONFIRMED',
		})}\n`, { mode: 0o600 });
	}
}

if (!['deleted', 'already-absent'].includes(tunnelCleanup) && listenerStartAttempted) {
	throw new Error(
		`Owned Tunnel cleanup was not confirmed; exact metadata and profiles were retained under ${runtimeRoot}.`,
		{ cause: cleanupFailure },
	);
}
if (!ownedProcessesStopped || !profilesRemoved) {
	throw new Error('Owned process or isolated profile cleanup was not confirmed.');
}
if (hostFailures.length > 0) {
	throw new AggregateError(hostFailures, 'One or more VS Code Development Hosts exited unsuccessfully.');
}

const evidence = {
	schemaVersion: 1,
	baseline: '06775c7e2e8a18f7771507e4a739fad0b865d9a0',
	devTunnel: {
		build: '1.0.2030+fc9273aa0f',
		sha256: expectedDevTunnelSha256,
		cleanup: tunnelCleanup,
		cleanupMethod: tunnelCleanupMethod,
	},
	instances: {
		worker: 'isolated',
		coordinator: 'isolated',
		onlineWorkspaceObserved: directory?.workers?.[0]?.workspaces?.length === 1,
	},
	productionChain: ['TaskCoordinator', 'Gateway', 'WorkerTaskService', 'AHP'],
	runtimeProbe: {
		available: runtimeProbe?.available === true,
		featureEnabled: runtimeProbe?.featureEnabled === true,
	},
	cancel: cancelOutcome,
	agent: authOutcome,
	vscodeAuthenticationChecked: true,
	cleanup: {
		ownedProcessesStopped,
		profilesRemoved,
		tunnel: tunnelCleanup,
	},
};
await writeFile(join(evidenceRoot, 'two-instance-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ evidenceDir: evidenceRoot, outcome: evidence.agent, cleanup: evidence.cleanup }));

function hostPaths(role) {
	const root = join(runtimeRoot, role);
	return {
		role,
		root,
		userData: join(root, 'user-data'),
		extensions: join(root, 'extensions'),
		control: join(root, 'control'),
		log: join(root, `${role}.log`),
	};
}

async function prepareHost(host) {
	await Promise.all([
		mkdir(join(host.userData, 'User'), { recursive: true }),
		mkdir(host.extensions, { recursive: true }),
		mkdir(join(host.control, 'requests'), { recursive: true }),
		mkdir(join(host.control, 'responses'), { recursive: true }),
	]);
}

async function writeSettings(host, name, workerEnabled) {
	const authenticationResource = process.env.MESH_TWO_DEVICE_E2E_AUTH_RESOURCE;
	const authenticationProvider = process.env.MESH_TWO_DEVICE_E2E_AUTH_PROVIDER;
	const authenticationScopes = parseStringArray(process.env.MESH_TWO_DEVICE_E2E_AUTH_SCOPES_JSON, []);
	const mappings = authenticationResource && authenticationProvider
		? {
			[authenticationResource]: {
				providerId: authenticationProvider,
				scopes: authenticationScopes,
			},
		}
		: {};
	await writeFile(join(host.userData, 'User/settings.json'), `${JSON.stringify({
		'copilotAgentMesh.deviceName': name,
		'copilotAgentMesh.devTunnelPath': devTunnelPath,
		'copilotAgentMesh.codePath': codeCli,
		'copilotAgentMesh.experimental.agentHost': workerEnabled,
		'copilotAgentMesh.experimental.authenticationProviders': mappings,
		'security.workspace.trust.enabled': false,
	})}\n`, { mode: 0o600 });
}

function launchHost(host, role) {
	const output = createWriteStream(host.log, { flags: 'wx', mode: 0o600 });
	rawLogs.push({ host, output });
	const running = runTests({
		vscodeExecutablePath,
		extensionDevelopmentPath: repoRoot,
		extensionTestsPath,
		launchArgs: [
			workspace,
			`--user-data-dir=${host.userData}`,
			`--extensions-dir=${host.extensions}`,
			'--disable-extensions',
			'--disable-gpu',
			'--skip-welcome',
			'--skip-release-notes',
			'--new-window',
		],
		extensionTestsEnv: {
			MESH_TWO_DEVICE_E2E: '1',
			MESH_TWO_DEVICE_E2E_CONTROL_DIR: host.control,
			MESH_TWO_DEVICE_E2E_ROLE: role,
		},
		stdout: output,
		stderr: output,
	});
	// Attach immediately so an early Extension Host failure is retained for the
	// coordinated shutdown path instead of becoming an unhandled rejection.
	void running.catch(() => undefined);
	return running;
}

async function request(host, action, params = {}, timeoutMs = 30_000) {
	const id = randomUUID();
	const requestPath = join(host.control, 'requests', `${id}.json`);
	const temporary = `${requestPath}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ id, action, params })}\n`, { mode: 0o600 });
	await rename(temporary, requestPath);
	const responsePath = join(host.control, 'responses', `${id}.json`);
	await waitForFile(responsePath, timeoutMs);
	const response = JSON.parse(await readFile(responsePath, 'utf8'));
	await rm(responsePath, { force: true });
	if (!response.ok) {
		const error = new Error(response.error?.message ?? `E2E action ${action} failed.`);
		error.code = response.error?.code;
		throw error;
	}
	return response.result;
}

async function waitForDirectory(workspaceId) {
	const deadline = Date.now() + 60_000;
	do {
		const value = await request(coordinator, 'directory.list');
		if (
			value.workers?.length === 1
			&& value.workers[0].workspaces?.some((candidate) => candidate.workspaceId === workspaceId)
		) {
			return value;
		}
		await delay(250);
	} while (Date.now() < deadline);
	throw new Error('Coordinator did not observe the Worker online with its registered workspace.');
}

async function waitForTask(taskId, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let latest;
	do {
		latest = await request(coordinator, 'task.get', { taskId });
		if (terminalStates.has(latest.snapshot.status)) {
			return latest;
		}
		await delay(250);
	} while (Date.now() < deadline);
	throw new Error(`Task ${taskId} did not become terminal (last state ${latest?.snapshot?.status ?? 'unknown'}).`);
}

async function waitForTaskEventOrTerminal(taskId, expectedEvent, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	do {
		const latest = await request(coordinator, 'task.get', { taskId });
		if (latest.events.some((event) => event.type === expectedEvent)) {
			return { kind: 'event', value: latest };
		}
		if (terminalStates.has(latest.snapshot.status)) {
			return { kind: 'terminal', value: latest };
		}
		await delay(50);
	} while (Date.now() < deadline);
	throw new Error(`Task did not emit ${expectedEvent} before cancellation.`);
}

async function shutdownHost(host) {
	try {
		await request(host, 'host.shutdown', {}, 10_000);
	} catch {
		// A host that never reached ready will be surfaced by its runTests rejection.
	}
}

async function prepareDevTunnel() {
	const configured = process.env.MESH_DEVTUNNEL_PATH;
	const path = configured ? resolve(configured) : join(runtimeRoot, 'osx-arm64-devtunnel');
	if (!configured) {
		const response = await fetch(devTunnelUrl);
		if (!response.ok) {
			throw new Error(`Official Dev Tunnel download failed with HTTP ${response.status}.`);
		}
		await writeFile(path, Buffer.from(await response.arrayBuffer()), { mode: 0o700 });
		await chmod(path, 0o700);
	}
	await verifyExactDevTunnel(path);
	return { path, downloaded: !configured };
}

async function fallbackDeleteOwnedTunnel(metadata) {
	if (
		metadata?.build !== SUPPORTED_DEVTUNNEL_BUILD
		|| typeof metadata.executablePath !== 'string'
		|| typeof metadata.localPort !== 'number'
		|| typeof metadata.ownershipLabel !== 'string'
		|| typeof metadata.tunnelId !== 'string'
	) {
		throw new Error('Retained owned Tunnel metadata is incomplete.');
	}
	await verifyExactDevTunnel(metadata.executablePath);
	let shown = runDevTunnel(metadata.executablePath, ['show', metadata.tunnelId, '--json'], [0, 2]);
	if (isExactDevTunnelNotFound(metadata.build, shown, metadata.tunnelId)) {
		return 'already-absent';
	}
	if (shown.exitCode !== 0) {
		throw new Error('Exact-ID Tunnel inspection did not return a strict owned resource.');
	}
	decodeDevTunnelShowJson(metadata.build, shown.stdout, {
		expectedOwnershipLabel: metadata.ownershipLabel,
		expectedPort: metadata.localPort,
		expectedTunnelId: metadata.tunnelId,
		requireForwardingUri: false,
	});
	runDevTunnel(metadata.executablePath, ['delete', metadata.tunnelId], [0]);
	const deadline = Date.now() + 30_000;
	do {
		shown = runDevTunnel(metadata.executablePath, ['show', metadata.tunnelId, '--json'], [0, 2]);
		if (isExactDevTunnelNotFound(metadata.build, shown, metadata.tunnelId)) {
			return 'deleted';
		}
		await delay(250);
	} while (Date.now() < deadline);
	throw new Error('Fallback cleanup did not receive the strict versioned exact-ID not-found response.');
}

async function verifyExactDevTunnel(path) {
	const digest = createHash('sha256').update(await readFile(path)).digest('hex');
	if (digest !== expectedDevTunnelSha256) {
		throw new Error('The Dev Tunnel executable SHA-256 does not match the exact supported build.');
	}
}

function runDevTunnel(executable, args, acceptedExitCodes) {
	const result = spawnSync(executable, args, {
		encoding: 'utf8',
		maxBuffer: 256 * 1024,
		timeout: 30_000,
	});
	if (result.error) {
		throw result.error;
	}
	const exitCode = result.status ?? -1;
	if (!acceptedExitCodes.includes(exitCode)) {
		throw new Error(`Exact Dev Tunnel ${args[0]} command exited ${exitCode}.`);
	}
	return {
		exitCode,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

async function waitForFile(path, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	do {
		try {
			await access(path);
			return;
		} catch {
			await delay(50);
		}
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${path.replace(evidenceRoot, '<evidence>')}.`);
}

async function allAbsent(paths) {
	for (const path of paths) {
		try {
			await stat(path);
			return false;
		} catch (error) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}
	}
	return true;
}

async function sanitizeLogs() {
	const replacements = [
		[evidenceRoot, '<evidence>'],
		[runtimeRoot, '<runtime>'],
		[repoRoot, '<repo>'],
		[homedir(), '<home>'],
		[devTunnelPath, '<devtunnel>'],
	].filter((pair) => typeof pair[0] === 'string');
	for (const { host, output } of rawLogs) {
		await new Promise((resolve) => output.end(resolve));
		let value = await readFile(host.log, 'utf8').catch(() => '');
		for (const [from, to] of replacements) {
			value = value.split(from).join(to);
		}
		value = value.replace(/(#[^\s]*secret=)[^\s]+/gu, '$1<redacted>');
		await writeFile(join(evidenceRoot, `${host.role}.sanitized.log`), value, { mode: 0o600 });
	}
}

function listOwnedProcesses(markers) {
	const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error('Unable to inspect owned E2E processes.');
	}
	return result.stdout
		.split(/\r?\n/u)
		.map((line) => {
			const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
			return match === null ? undefined : { pid: Number(match[1]), command: match[2] };
		})
		.filter((entry) =>
			entry !== undefined
			&& entry.pid !== process.pid
			&& markers.some((marker) => entry.command.includes(marker)),
		);
}

function listProcessesByExecutable(executable) {
	return listOwnedProcesses([executable]);
}

async function terminateOwnedProcesses(markers) {
	let remaining = listOwnedProcesses(markers);
	for (const processInfo of remaining) {
		try {
			process.kill(processInfo.pid, 'SIGTERM');
		} catch (error) {
			if (error.code !== 'ESRCH') {
				throw error;
			}
		}
	}
	const deadline = Date.now() + 5_000;
	do {
		remaining = listOwnedProcesses(markers);
		if (remaining.length === 0) {
			return;
		}
		await delay(100);
	} while (Date.now() < deadline);
	for (const processInfo of remaining) {
		try {
			process.kill(processInfo.pid, 'SIGKILL');
		} catch (error) {
			if (error.code !== 'ESRCH') {
				throw error;
			}
		}
	}
	await delay(100);
}

function parseStringArray(value, fallback) {
	if (!value) {
		return fallback;
	}
	const parsed = JSON.parse(value);
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
		throw new Error('MESH_TWO_DEVICE_E2E_AUTH_SCOPES_JSON must be a JSON string array.');
	}
	return parsed;
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
