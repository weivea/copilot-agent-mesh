import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
	access,
	chmod,
	lstat,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	downloadAndUnzipVSCode,
	resolveCliPathFromVSCodeExecutablePath,
} from '@vscode/test-electron';

const terminalStates = new Set(['completed', 'failed', 'cancelled', 'timedOut']);
const multiProjectMode = process.argv.includes('--multi-project');
const environmentPrefix = multiProjectMode
	? 'MESH_MULTI_PROJECT_E2E'
	: 'MESH_MULTI_WINDOW_E2E';
if (multiProjectMode && process.env.MESH_MULTI_PROJECT_E2E !== '1') {
	throw new Error('MESH_MULTI_PROJECT_E2E=1 is required for the real multi-project E2E.');
}
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const require = createRequire(import.meta.url);
const {
	multiWindowWorkspaceKey,
	parseProcessTable,
	selectOwnedProcesses,
} = require(join(repositoryRoot, 'out/src/e2e/MultiWindowE2eSupport.js'));

class E2eRequestError extends Error {
	constructor(action, code, message) {
		super(message);
		this.name = 'E2eRequestError';
		this.action = action;
		this.code = code;
	}
}

if (process.platform === 'win32') {
	throw new Error(
		'The real multi-window E2E currently requires POSIX ps-based exact PID ownership inspection.',
	);
}
if (
	process.platform === 'linux'
	&& !process.env.DISPLAY
	&& !process.env.WAYLAND_DISPLAY
) {
	throw new Error(
		'VS Code display unavailable: set DISPLAY or WAYLAND_DISPLAY for the real multi-window E2E.',
	);
}

const runId = randomUUID();
const configuredRuntimeBase = process.env[`${environmentPrefix}_RUNTIME_DIR`];
const runtimeBase = configuredRuntimeBase === undefined
	? join(repositoryRoot, '.mw')
	: resolve(configuredRuntimeBase);
const runRoot = join(runtimeBase, `mw-${runId.slice(0, 8)}`);
const evidenceRoot = join(
	repositoryRoot,
	'.vscode-test',
	multiProjectMode ? 'multi-project-evidence' : 'multi-window-evidence',
);
const evidencePath = join(evidenceRoot, `${runId}.json`);
// Opt-in only. When unset the run keeps its throwaway per-run profile, which has no
// authentication sessions and therefore cannot exercise authenticated Agent turns.
const configuredProfileBase = process.env[`${environmentPrefix}_PROFILE_DIR`];
const persistentProfile = configuredProfileBase !== undefined;
const profileBase = persistentProfile ? resolve(configuredProfileBase) : undefined;
const userDataDirectory = persistentProfile
	? join(profileBase, 'user-data')
	: join(runRoot, 'user-data');
const meshGlobalStorageDirectory = join(
	userDataDirectory,
	'User',
	'globalStorage',
	'weivea.copilot-agent-mesh',
);
const profileLockDirectory = persistentProfile
	? join(profileBase, '.copilot-agent-mesh-e2e-lock')
	: undefined;
const profileLockOwnerPath = persistentProfile
	? join(profileLockDirectory, 'owner')
	: undefined;
const extensionsDirectory = join(runRoot, 'extensions');
const controlRoot = join(runRoot, 'control');
const logsDirectory = join(runRoot, 'logs');
const workspacesDirectory = join(runRoot, 'workspaces');
const repoAPath = join(workspacesDirectory, 'repo-a');
const repoBPath = join(workspacesDirectory, 'repo-b');
const reopenedRepoAPath = join(workspacesDirectory, 'reopen-a', 'repo-a');
const reopenedRepoBPath = join(workspacesDirectory, 'reopen-b', 'repo-b');
const duplicateRepoAPath = join(workspacesDirectory, 'repo-a-duplicate');
const sentinelPath = join(runRoot, 'devtunnel-sentinel');
const sentinelInvocationPath = join(runRoot, 'devtunnel-invoked.json');
const realTaskEnabled = multiProjectMode || process.env.MESH_MULTI_WINDOW_E2E_TASKS === '1';
const nonce = randomUUID();
const ownedMarkers = [
	runRoot,
	extensionsDirectory,
	controlRoot,
	sentinelPath,
];
const rootPids = new Set();
const historicalOwnedPids = new Set();
const historicalOwnedCommands = new Map();
const launchRecords = [];
const windowOpenRecords = [];
const activeControllers = new Map();
let maximumOwnedProcessCount = 0;
let localIpcEndpoint;
let vscodeExecutablePath;
let codeCliPath;
let sentinelDigest;
let primaryFailure;
let cleanupFailure;
let persistentProfileLockOwned = false;
let evidence = {
	schemaVersion: 1,
	runId,
	mode: multiProjectMode
		? 'same-device-multi-project'
		: realTaskEnabled ? 'transport-and-ahp' : 'transport-lifecycle',
	sharedProfile: {
		oneUserDataDirectory: false,
		oneExtensionsDirectory: false,
		persistentProfile,
	},
	initial: { state: 'not-run' },
	task: {
		state: realTaskEnabled ? 'not-run' : 'skipped',
		reason: realTaskEnabled
			? undefined
			: 'Set MESH_MULTI_WINDOW_E2E_TASKS=1 to opt into production AHP/quota use.',
	},
	collaboration: {
		state: multiProjectMode ? 'not-run' : 'not-applicable',
	},
	reopen: { state: 'not-run' },
	takeover: { state: 'not-run' },
	duplicate: { state: 'not-run' },
	tunnelIsolation: { state: 'not-run' },
	cleanup: { state: 'not-run' },
};

try {
	assertUsableRuntimePath();
	await acquirePersistentProfileLock();
	assertPersistentProfileIdle();
	if (persistentProfile) {
		ownedMarkers.push(meshGlobalStorageDirectory);
	}
	await prepareRun();
	vscodeExecutablePath = process.env.MESH_VSCODE_EXECUTABLE
		? resolve(process.env.MESH_VSCODE_EXECUTABLE)
		: await downloadAndUnzipVSCode('stable');
	await access(vscodeExecutablePath);
	codeCliPath = process.env.MESH_CODE_CLI
		? resolve(process.env.MESH_CODE_CLI)
		: resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
	await access(codeCliPath);
	await writeSettings();

	assert.equal(currentOwnedProcesses().length, 0, 'The fresh run markers unexpectedly matched a process.');
	const repoA = await launchAndDiscover(repoAPath);
	activeControllers.set(repoA.windowId, repoA);
	const firstState = await waitForControllerState(
		repoA,
		(state) => state.broker?.state === 'running' && state.broker?.owner === true,
		30_000,
		'repo-a did not become the initial Device Broker owner',
	);
	const initialGeneration = requiredString(firstState.broker.generation, 'initial Broker generation');

	const repoB = await launchAndDiscover(repoBPath);
	activeControllers.set(repoB.windowId, repoB);
	const bothActivatedAt = Math.max(
		Date.parse(repoA.activatedAt),
		Date.parse(repoB.activatedAt),
	);
	const initialDirectory = await waitForDirectory(
		repoA,
		(directory) => {
			const local = localDevice(directory);
			const live = local?.nodes?.filter((node) => node.status !== 'offline') ?? [];
			return live.length === 2
				&& live.some((node) => node.nodeId === repoA.nodeId)
				&& live.some((node) => node.nodeId === repoB.nodeId);
		},
		5_000,
		'two local Window Nodes were not visible within five seconds of activation',
	);
	const activationObservationMs = Date.now() - bothActivatedAt;
	assert.ok(
		activationObservationMs <= 5_000,
		`Window Node observation took ${activationObservationMs}ms.`,
	);
	const initialStates = await Promise.all([
		request(repoA, 'controller.state'),
		request(repoB, 'controller.state'),
	]);
	const owners = initialStates.filter(
		(state) => state.broker?.state === 'running' && state.broker?.owner === true,
	);
	assert.equal(owners.length, 1, 'Exactly one running Device Broker owner was not observed.');
	assert.equal(owners[0].windowId, repoA.windowId, 'The first window did not retain ownership.');

	const initialDevice = localDevice(initialDirectory);
	assert.ok(initialDevice, 'The local Device directory was unavailable.');
	assert.equal(initialDirectory.devices.length, 1, 'The fresh profile exposed more than one Device.');
	const repoANode = requireDirectoryNode(initialDevice, repoA.nodeId);
	const repoBNode = requireDirectoryNode(initialDevice, repoB.nodeId);
	const repoAWorkspace = requireClaimedWorkspace(repoANode, 'repo-a');
	const repoBWorkspace = requireClaimedWorkspace(repoBNode, 'repo-b');
	assert.notEqual(
		repoAWorkspace.workspaceId,
		repoBWorkspace.workspaceId,
		'Separate repositories received the same workspace ID.',
	);
	evidence.initial = {
		state: 'passed',
		activationObservationMs,
		deviceCount: 1,
		liveNodeCount: 2,
		runningBrokerOwners: 1,
		generation: initialGeneration,
	};

	const launchArguments = launchRecords.map(({ args }) => args);
	assertSharedProfileArguments(launchArguments);
	assert.equal(windowOpenRecords.length, 1, 'The second window was not opened by the shared VS Code instance.');
	evidence.sharedProfile = {
		oneUserDataDirectory: true,
		oneExtensionsDirectory: true,
		persistentProfile,
		windowOpenCount: windowOpenRecords.length + 1,
	};

	const listenerState = await request(repoA, 'listener.state');
	assert.equal(listenerState.listener?.state, 'stopped', 'The local listener auto-started.');
	assert.equal(listenerState.tunnel?.state, 'stopped', 'The Dev Tunnel runtime was accessed.');
	localIpcEndpoint = await request(repoA, 'ipc.endpoint');
	assert.equal(localIpcEndpoint.platform, process.platform);
	if (localIpcEndpoint.platform !== 'win32') {
		const socket = await lstat(localIpcEndpoint.address);
		assert.equal(socket.isSocket(), true, 'The owned local IPC endpoint is not a socket.');
	}
	await assertTunnelUntouched();
	evidence.tunnelIsolation = {
		state: 'passed',
		listenerAutoStart: false,
		listenerState: 'stopped',
		tunnelState: 'stopped',
		sentinelInvoked: false,
		ownedDevTunnelProcesses: 0,
	};

	if (multiProjectMode) {
		evidence.collaboration = await runProductionCollaboration(
			repoA,
			repoB,
			initialDevice,
			repoAWorkspace,
			repoBWorkspace,
		);
		evidence.task = {
			state: evidence.collaboration.state,
			backendTaskId: evidence.collaboration.backend.taskId,
			frontendTaskId: evidence.collaboration.frontend.taskId,
		};
		await assertTunnelUntouched();
	} else if (realTaskEnabled) {
		evidence.task = await runProductionTask(repoA, repoB, initialDevice, repoBWorkspace);
		await assertTunnelUntouched();
	}

	const repoBCloseStarted = Date.now();
	await request(repoB, 'host.close');
	activeControllers.delete(repoB.windowId);
	const offlineDirectory = await waitForDirectory(
		repoA,
		(directory) => {
			const local = localDevice(directory);
			const closed = local?.nodes?.find((node) => node.nodeId === repoB.nodeId);
			const source = local?.nodes?.find((node) => node.nodeId === repoA.nodeId);
			return closed?.status === 'offline' && source?.status === 'online';
		},
		5_000,
		'repo-b did not become offline while repo-a stayed online',
	);
	const repoBOfflineMs = Date.now() - repoBCloseStarted;
	assert.ok(repoBOfflineMs <= 5_000);
	assert.equal(localDevice(offlineDirectory)?.deviceId, initialDevice.deviceId);

	const reopenedRepoB = await launchAndDiscover(reopenedRepoBPath, new Set([repoB.windowId]));
	activeControllers.set(reopenedRepoB.windowId, reopenedRepoB);
	const reopenedDirectory = await waitForDirectory(
		repoA,
		(directory) => {
			const node = localDevice(directory)?.nodes?.find(
				(candidate) => candidate.nodeId === reopenedRepoB.nodeId,
			);
			return node?.status === 'online'
				&& node.workspaces.some(
					(workspace) =>
						workspace.workspaceId === repoBWorkspace.workspaceId
						&& workspace.claimStatus === 'claimed',
				);
		},
		5_000,
		'reopened repo-b did not reclaim its workspace ID',
	);
	const reopenedNode = requireDirectoryNode(localDevice(reopenedDirectory), reopenedRepoB.nodeId);
	const reopenedWorkspace = requireClaimedWorkspace(reopenedNode, 'repo-b');
	assert.equal(reopenedWorkspace.workspaceId, repoBWorkspace.workspaceId);
	evidence.reopen = {
		state: 'passed',
		offlineObservationMs: repoBOfflineMs,
		sameWorkspaceId: true,
		newNodeInstance: reopenedRepoB.nodeInstanceId !== repoB.nodeInstanceId,
	};

	const ownerBeforeClose = await request(repoA, 'controller.state');
	assert.equal(ownerBeforeClose.broker.owner, true);
	const ownerGeneration = requiredString(
		ownerBeforeClose.broker.generation,
		'pre-takeover Broker generation',
	);
	const takeoverStarted = Date.now();
	await request(repoA, 'host.close');
	activeControllers.delete(repoA.windowId);
	const takeoverState = await waitForControllerState(
		reopenedRepoB,
		(state) =>
			state.broker?.state === 'running'
			&& state.broker?.owner === true
			&& typeof state.broker?.generation === 'string'
			&& state.broker.generation !== ownerGeneration
			&& state.node?.state === 'online'
			&& state.node?.registered === true,
		10_000,
		'the surviving window did not take over and reconnect',
	);
	const takeoverMs = Date.now() - takeoverStarted;
	const takeoverGeneration = requiredString(
		takeoverState.broker.generation,
		'takeover Broker generation',
	);
	const takeoverDirectory = await waitForDirectory(
		reopenedRepoB,
		(directory) => {
			const node = localDevice(directory)?.nodes?.find(
				(candidate) => candidate.nodeId === reopenedRepoB.nodeId,
			);
			return node?.status === 'online'
				&& node.nodeInstanceId === reopenedRepoB.nodeInstanceId;
		},
		5_000,
		'the surviving Window Node did not re-register after takeover',
	);
	assert.equal(localDevice(takeoverDirectory)?.deviceId, initialDevice.deviceId);
	const afterTakeoverListener = await request(reopenedRepoB, 'listener.state');
	assert.equal(afterTakeoverListener.listener?.state, 'stopped');
	assert.equal(afterTakeoverListener.tunnel?.state, 'stopped');
	evidence.takeover = {
		state: 'passed',
		takeoverMs,
		generationChanged: takeoverGeneration !== ownerGeneration,
		nodeReconnected: true,
		deviceIdStable: true,
	};

	const reopenedRepoA = await launchAndDiscover(reopenedRepoAPath, new Set([repoA.windowId]));
	activeControllers.set(reopenedRepoA.windowId, reopenedRepoA);
	const reclaimedRepoADirectory = await waitForDirectory(
		reopenedRepoB,
		(directory) => {
			const node = localDevice(directory)?.nodes?.find(
				(candidate) => candidate.nodeId === reopenedRepoA.nodeId,
			);
			return node?.status === 'online'
				&& node.workspaces.some(
					(workspace) =>
						workspace.workspaceId === repoAWorkspace.workspaceId
						&& workspace.claimStatus === 'claimed',
				);
		},
		5_000,
		'reopened repo-a did not reclaim its catalogued workspace',
	);
	assert.ok(localDevice(reclaimedRepoADirectory));

	const duplicateRepoA = await launchAndDiscover(duplicateRepoAPath);
	activeControllers.set(duplicateRepoA.windowId, duplicateRepoA);
	const duplicateDirectory = await waitForDirectory(
		reopenedRepoB,
		(directory) => {
			const local = localDevice(directory);
			const original = local?.nodes?.find((node) => node.nodeId === reopenedRepoA.nodeId);
			const duplicate = local?.nodes?.find((node) => node.nodeId === duplicateRepoA.nodeId);
			const statuses = [original, duplicate]
				.flatMap((node) => node?.workspaces ?? [])
				.filter((workspace) => workspace.workspaceId === repoAWorkspace.workspaceId)
				.map((workspace) => workspace.claimStatus)
				.sort();
			return statuses.length === 2
				&& statuses[0] === 'claimed'
				&& statuses[1] === 'conflict';
		},
		5_000,
		'the duplicate repo-a claim did not become conflict',
	);
	const duplicateNode = requireDirectoryNode(localDevice(duplicateDirectory), duplicateRepoA.nodeId);
	const duplicateWorkspace = duplicateNode.workspaces.find(
		(workspace) => workspace.workspaceId === repoAWorkspace.workspaceId,
	);
	assert.equal(duplicateWorkspace?.claimStatus, 'conflict');
	const originalNode = requireDirectoryNode(localDevice(duplicateDirectory), reopenedRepoA.nodeId);
	assert.equal(
		originalNode.workspaces.find(
			(workspace) => workspace.workspaceId === repoAWorkspace.workspaceId,
		)?.claimStatus,
		'claimed',
	);
	const conflictError = await requestError(reopenedRepoB, 'task.start', {
		delegationRequestId: randomUUID(),
		deviceId: initialDevice.deviceId,
		nodeId: duplicateRepoA.nodeId,
		nodeInstanceId: duplicateRepoA.nodeInstanceId,
		workspaceId: repoAWorkspace.workspaceId,
		title: 'Duplicate claim rejection probe',
		prompt: 'This must be rejected before any Agent runtime is accessed.',
		acceptanceCriteria: [],
	});
	assert.equal(
		conflictError.code,
		'WORKSPACE_NOT_FOUND',
		'The conflicting Window Node unexpectedly accepted task execution.',
	);
	assert.equal(
		currentOwnedProcesses().some(isAgentHostProcess),
		false,
		'The rejected duplicate claim accessed Agent Host.',
	);
	evidence.duplicate = {
		state: 'passed',
		claimedCount: 1,
		conflictCount: 1,
		conflictTaskError: conflictError.code,
		agentHostAccessed: false,
	};
	await assertTunnelUntouched();
} catch (error) {
	primaryFailure = error;
} finally {
	try {
		await closeControllers();
		await waitForNoOwnedProcesses(10_000).catch(async () => {
			await terminateOwnedProcesses();
			await waitForNoOwnedProcesses(5_000);
		});
		await closeLogStreams();
		if (primaryFailure !== undefined) {
			await saveSanitizedLogs();
		}

		const socketRemoved = localIpcEndpoint === undefined
			|| localIpcEndpoint.platform === 'win32'
			|| await isAbsent(localIpcEndpoint.address);
		const agentHosts = currentOwnedProcesses().filter(isAgentHostProcess);
		const testProcesses = currentOwnedProcesses();
		const sentinelInvoked = !await isAbsent(sentinelInvocationPath);
		const sentinelUnchanged = sentinelDigest === undefined
			|| createHash('sha256').update(await readFile(sentinelPath)).digest('hex') === sentinelDigest;
		const cleanupPassed = socketRemoved
			&& agentHosts.length === 0
			&& testProcesses.length === 0
			&& !sentinelInvoked
			&& sentinelUnchanged;
		evidence.cleanup = {
			state: cleanupPassed ? 'passed' : 'failed',
			localIpcSocketRemoved: socketRemoved,
			agentHostProcesses: agentHosts.length,
			testVscodeProcesses: testProcesses.length,
			devTunnelProcesses: testProcesses.filter(isDevTunnelProcess).length,
			ownedTimers: testProcesses.length === 0 ? 0 : undefined,
			sentinelInvoked,
			sentinelUnchanged,
			trackedPidCount: historicalOwnedPids.size,
			maximumOwnedProcessCount,
			profileLockReleased: !persistentProfile,
			runtimeRemoved: false,
		};
		if (!cleanupPassed) {
			throw new Error('Owned multi-window E2E cleanup was not fully confirmed.');
		}
		evidence.cleanup.profileLockReleased = await releasePersistentProfileLock();
		await rm(runRoot, { recursive: true, force: true });
		if (!await isAbsent(runRoot)) {
			throw new Error('The owned multi-window E2E runtime directory remains.');
		}
		evidence.cleanup.runtimeRemoved = true;
	} catch (error) {
		cleanupFailure = error;
		await closeLogStreams().catch(() => undefined);
	}
}

await mkdir(evidenceRoot, { recursive: true });
await writeFile(evidencePath, `${JSON.stringify({
	...evidence,
	outcome: primaryFailure === undefined && cleanupFailure === undefined ? 'passed' : 'failed',
	...(primaryFailure === undefined ? {} : { failure: safeFailure(primaryFailure) }),
	...(cleanupFailure === undefined ? {} : { cleanupFailure: safeFailure(cleanupFailure) }),
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

if (primaryFailure !== undefined || cleanupFailure !== undefined) {
	throw new AggregateError(
		[primaryFailure, cleanupFailure].filter((error) => error !== undefined),
		`Real multi-window E2E failed; sanitized evidence: ${relative(repositoryRoot, evidencePath)}`,
	);
}
console.log(JSON.stringify({
	outcome: 'passed',
	mode: evidence.mode,
	task: evidence.task.state,
	evidence: relative(repositoryRoot, evidencePath),
	cleanup: evidence.cleanup.state,
}));

async function prepareRun() {
	// A reused profile must not carry mesh Device/Node state between runs, or the
	// directory assertions would observe stale nodes. Authentication lives in VS Code's
	// own secret storage, which is deliberately left untouched.
	if (persistentProfile) {
		await rm(meshGlobalStorageDirectory, { recursive: true, force: true });
	}
	await Promise.all([
		mkdir(join(userDataDirectory, 'User'), { recursive: true }),
		mkdir(extensionsDirectory, { recursive: true }),
		mkdir(controlRoot, { recursive: true }),
		mkdir(logsDirectory, { recursive: true }),
		mkdir(repoAPath, { recursive: true }),
		mkdir(repoBPath, { recursive: true }),
		mkdir(dirname(reopenedRepoAPath), { recursive: true }),
		mkdir(dirname(reopenedRepoBPath), { recursive: true }),
		mkdir(evidenceRoot, { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			join(repoAPath, 'README.txt'),
			'Temporary non-sensitive same-profile multi-window E2E repository A.\n',
			'utf8',
		),
		writeFile(
			join(repoBPath, 'README.txt'),
			'Temporary non-sensitive same-profile multi-window E2E repository B.\n',
			'utf8',
		),
	]);
	if (multiProjectMode) {
		await Promise.all([
			writeFile(join(repoAPath, 'package.json'), `${JSON.stringify({
				name: 'mesh-e2e-frontend',
				private: true,
				type: 'module',
				scripts: { test: 'node test.mjs' },
			})}\n`, 'utf8'),
			writeFile(
				join(repoAPath, 'client.mjs'),
				"export function createItemsRequest() { throw new Error('not implemented'); }\n"
					+ "export function renderItem() { throw new Error('not implemented'); }\n",
				'utf8',
			),
			writeFile(
				join(repoAPath, 'test.mjs'),
				"import assert from 'node:assert/strict';\n"
					+ "import { createItemsRequest, renderItem } from './client.mjs';\n"
					+ "assert.deepEqual(createItemsRequest(), { method: 'GET', path: '/api/items' });\n"
					+ "assert.equal(renderItem({ id: '1', name: 'Sample' }), '1: Sample');\n",
				'utf8',
			),
			writeFile(join(repoBPath, 'package.json'), `${JSON.stringify({
				name: 'mesh-e2e-backend',
				private: true,
				type: 'module',
				scripts: { test: 'node test.mjs' },
			})}\n`, 'utf8'),
			writeFile(
				join(repoBPath, 'server.mjs'),
				"export function getItems() { throw new Error('not implemented'); }\n",
				'utf8',
			),
			writeFile(
				join(repoBPath, 'test.mjs'),
				"import assert from 'node:assert/strict';\n"
					+ "import { readFile } from 'node:fs/promises';\n"
					+ "import { getItems } from './server.mjs';\n"
					+ "const contract = JSON.parse(await readFile(new URL('./contract.json', import.meta.url), 'utf8'));\n"
					+ "assert.equal(contract.endpoint, '/api/items');\n"
					+ "assert.deepEqual(contract.item.required, ['id', 'name']);\n"
					+ "assert.deepEqual(getItems(), [{ id: '1', name: 'Sample' }]);\n",
				'utf8',
			),
		]);
	}
	await Promise.all([
		symlink(repoAPath, reopenedRepoAPath, 'dir'),
		symlink(repoBPath, reopenedRepoBPath, 'dir'),
	]);
	await symlink(repoAPath, duplicateRepoAPath, 'dir');
	const sentinel = [
		'#!/usr/bin/env node',
		`require('node:fs').writeFileSync(${JSON.stringify(sentinelInvocationPath)}, JSON.stringify({ invoked: true, pid: process.pid }));`,
		'process.exitCode = 97;',
		'',
	].join('\n');
	await writeFile(sentinelPath, sentinel, { encoding: 'utf8', mode: 0o700 });
	await chmod(sentinelPath, 0o700);
	sentinelDigest = createHash('sha256').update(sentinel).digest('hex');
}

async function acquirePersistentProfileLock() {
	if (!persistentProfile) {
		return;
	}
	await mkdir(profileBase, { recursive: true });
	try {
		await mkdir(profileLockDirectory);
		persistentProfileLockOwned = true;
		await writeFile(profileLockOwnerPath, `${runId}\n`, { encoding: 'utf8', mode: 0o600 });
	} catch (error) {
		if (persistentProfileLockOwned) {
			await rm(profileLockDirectory, { recursive: true, force: true });
			persistentProfileLockOwned = false;
		}
		if (error?.code === 'EEXIST') {
			throw new Error(
				'The persistent multi-window E2E profile is already locked by another run.',
			);
		}
		throw error;
	}
}

function assertPersistentProfileIdle() {
	if (!persistentProfile) {
		return;
	}
	const users = readProcessTable().filter(({ pid, command }) =>
		pid !== process.pid
		&& command.includes('--user-data-dir')
		&& command.includes(userDataDirectory),
	);
	if (users.length > 0) {
		throw new Error(
			'The persistent multi-window E2E profile is already in use. '
			+ 'Close its VS Code and Agent Host processes before retrying.',
		);
	}
}

async function releasePersistentProfileLock() {
	if (!persistentProfile) {
		return true;
	}
	if (!persistentProfileLockOwned) {
		return false;
	}
	const owner = await readFile(profileLockOwnerPath, 'utf8');
	if (owner.trim() !== runId) {
		throw new Error('The persistent multi-window E2E profile lock ownership changed.');
	}
	await rm(profileLockDirectory, { recursive: true, force: false });
	persistentProfileLockOwned = false;
	return true;
}

async function writeSettings() {
	const authenticationResource = process.env[`${environmentPrefix}_AUTH_RESOURCE`];
	const authenticationProvider = process.env[`${environmentPrefix}_AUTH_PROVIDER`];
	const authenticationScopes = parseStringArray(
		process.env[`${environmentPrefix}_AUTH_SCOPES_JSON`],
		[],
	);
	const mappings = authenticationResource && authenticationProvider
		? {
			[authenticationResource]: {
				providerId: authenticationProvider,
				scopes: authenticationScopes,
			},
		}
		: {};
	await writeFile(
		join(userDataDirectory, 'User', 'settings.json'),
		`${JSON.stringify({
			'copilotAgentMesh.deviceName': 'Same-profile E2E Device',
			'copilotAgentMesh.codePath': codeCliPath,
			'copilotAgentMesh.experimental.agentHost': realTaskEnabled,
			'copilotAgentMesh.experimental.sameDeviceCollaboration': multiProjectMode,
			'copilotAgentMesh.experimental.authenticationProviders': mappings,
			'copilotAgentMesh.devTunnelPath': sentinelPath,
			'copilotAgentMesh.listener.autoStart': false,
			'copilotAgentMesh.e2e.nonce': nonce,
			'copilotAgentMesh.e2e.role': 'coordinator',
			'security.workspace.trust.enabled': false,
			'window.restoreWindows': 'none',
			'extensions.autoCheckUpdates': false,
			'extensions.autoUpdate': false,
			'update.mode': 'none',
		})}\n`,
		{ encoding: 'utf8', mode: 0o600 },
	);
}

async function launchAndDiscover(workspacePath, excludedWindowIds = new Set()) {
	const launchedAt = Date.now();
	const opener = [...activeControllers.values()][0];
	if (opener === undefined) {
		launchWindow(workspacePath);
	} else {
		await request(opener, 'window.open', { workspacePath }, 10_000);
		windowOpenRecords.push({
			workspacePath,
			userDataDirectory,
			extensionsDirectory,
		});
	}
	const controller = await waitForController(
		workspacePath,
		launchedAt,
		excludedWindowIds,
		60_000,
	);
	await request(controller, 'controller.state');
	refreshOwnedProcesses();
	return controller;
}

function launchWindow(workspacePath) {
	const args = [
		workspacePath,
		`--user-data-dir=${userDataDirectory}`,
		`--extensions-dir=${extensionsDirectory}`,
		'--disable-extensions',
		'--disable-gpu',
		'--disable-gpu-sandbox',
		'--disable-updates',
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
		'--no-cached-data',
		'--no-sandbox',
		'--new-window',
		`--extensionDevelopmentPath=${repositoryRoot}`,
	];
	assertSharedProfileArguments([args]);
	const logPath = join(
		logsDirectory,
		`${basename(workspacePath)}-${launchRecords.length + 1}.log`,
	);
	const output = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
	const environment = { ...process.env };
	delete environment.MESH_TWO_DEVICE_E2E;
	delete environment.MESH_TWO_DEVICE_E2E_NONCE;
	delete environment.MESH_TWO_DEVICE_E2E_ROLE;
	delete environment.MESH_MULTI_WINDOW_E2E;
	delete environment.MESH_MULTI_PROJECT_E2E;
	environment[environmentPrefix] = '1';
	environment[`${environmentPrefix}_CONTROL_DIR`] = controlRoot;
	environment[`${environmentPrefix}_NONCE`] = nonce;
	const child = spawn(vscodeExecutablePath, args, {
		env: environment,
		shell: false,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (child.pid === undefined) {
		throw new Error(`VS Code did not expose a child PID for ${basename(workspacePath)}.`);
	}
	rootPids.add(child.pid);
	child.stdout.pipe(output, { end: false });
	child.stderr.pipe(output, { end: false });
	const record = {
		workspacePath,
		args,
		child,
		output,
		logPath,
		exit: undefined,
	};
	child.once('error', (error) => {
		record.exit = { error: error.message };
	});
	child.once('exit', (code, signal) => {
		record.exit = { code, signal };
		rootPids.delete(child.pid);
	});
	launchRecords.push(record);
	refreshOwnedProcesses();
}

async function waitForController(workspacePath, launchedAt, excludedWindowIds, timeoutMs) {
	const workspaceBasename = basename(workspacePath);
	const workspaceKey = multiWindowWorkspaceKey(workspaceBasename);
	const workspaceControlRoot = join(controlRoot, 'windows', workspaceKey);
	const deadline = Date.now() + timeoutMs;
	let lastFailure;
	while (Date.now() < deadline) {
		for (const windowId of await readdir(workspaceControlRoot).catch(() => [])) {
			if (excludedWindowIds.has(windowId)) {
				continue;
			}
			const controlDirectory = join(workspaceControlRoot, windowId);
			try {
				const ready = JSON.parse(await readFile(join(controlDirectory, 'ready.json'), 'utf8'));
				if (
					ready.schemaVersion !== 1
					|| ready.ready !== true
					|| ready.workspaceBasename !== workspaceBasename
					|| ready.workspaceKey !== workspaceKey
					|| ready.windowId !== windowId
					|| Date.parse(ready.activatedAt) < launchedAt - 1_000
					|| typeof ready.nodeId !== 'string'
					|| typeof ready.nodeInstanceId !== 'string'
					|| ready.nodeInstanceId !== windowId
					|| typeof ready.extensionHostPid !== 'number'
				) {
					continue;
				}
				const controller = { ...ready, controlDirectory };
				await request(controller, 'controller.state', {}, 2_000);
				return controller;
			} catch (error) {
				lastFailure = error;
			}
		}
		const relevantLaunch = [...launchRecords]
			.reverse()
			.find((record) => record.workspacePath === workspacePath);
		if (relevantLaunch?.exit?.error) {
			throw new Error(
				`VS Code failed to launch ${workspaceBasename}: ${relevantLaunch.exit.error}`,
			);
		}
		await delay(50);
	}
	throw new Error(
		`Timed out waiting for the ${workspaceBasename} Extension Host controller.`
		+ (lastFailure instanceof Error ? ` Last error: ${lastFailure.message}` : ''),
	);
}

async function request(controller, action, params = {}, timeoutMs = 30_000) {
	const id = randomUUID();
	const requestPath = join(controller.controlDirectory, 'requests', `${id}.json`);
	const temporary = `${requestPath}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify({
		schemaVersion: 1,
		id,
		action,
		nonce,
		role: 'coordinator',
		workspaceKey: controller.workspaceKey,
		windowId: controller.windowId,
		params,
	})}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, requestPath);
	const responsePath = join(controller.controlDirectory, 'responses', `${id}.json`);
	await waitForFile(responsePath, timeoutMs);
	const response = JSON.parse(await readFile(responsePath, 'utf8'));
	await rm(responsePath, { force: true });
	if (
		response.schemaVersion !== 1
		|| response.id !== id
		|| response.windowId !== controller.windowId
		|| typeof response.ok !== 'boolean'
	) {
		throw new Error(`The ${action} controller response envelope was invalid.`);
	}
	if (!response.ok) {
		throw new E2eRequestError(
			action,
			response.error?.code,
			response.error?.message ?? `E2E action ${action} failed.`,
		);
	}
	return response.result;
}

async function requestError(controller, action, params = {}, timeoutMs = 30_000) {
	try {
		await request(controller, action, params, timeoutMs);
	} catch (error) {
		if (error instanceof E2eRequestError) {
			return error;
		}
		throw error;
	}
	throw new Error(`E2E action ${action} unexpectedly succeeded.`);
}

async function waitForControllerState(controller, predicate, timeoutMs, message) {
	const deadline = Date.now() + timeoutMs;
	let latest;
	do {
		try {
			latest = await request(controller, 'controller.state', {}, 2_000);
			if (predicate(latest)) {
				return latest;
			}
		} catch {
			// Broker takeover briefly interrupts the local controller route.
		}
		await delay(50);
	} while (Date.now() < deadline);
	throw new Error(`${message}; last state: ${JSON.stringify(latest?.broker ?? latest)}.`);
}

async function waitForDirectory(controller, predicate, timeoutMs, message) {
	const deadline = Date.now() + timeoutMs;
	let latest;
	do {
		try {
			latest = await request(controller, 'directory.list', {}, 2_000);
			if (predicate(latest)) {
				return latest;
			}
		} catch {
			// A generation handoff closes and recreates the local IPC route.
		}
		await delay(50);
	} while (Date.now() < deadline);
	throw new Error(`${message}; last directory: ${JSON.stringify(latest)}.`);
}

async function runProductionCollaboration(
	source,
	backendController,
	device,
	frontendWorkspace,
	backendWorkspace,
) {
	for (const controller of [source, backendController]) {
		const probe = await request(controller, 'runtime.probe', {}, 30_000);
		if (probe.available !== true || probe.featureEnabled !== true) {
			throw new Error(
				`Production Agent Host runtime unavailable: ${probe.reason ?? 'probe failed'}.`,
			);
		}
	}
	const providerId = process.env[`${environmentPrefix}_AUTH_PROVIDER`] ?? 'github';
	const scopes = parseStringArray(
		process.env[`${environmentPrefix}_AUTH_SCOPES_JSON`],
		[],
	);
	for (const controller of [source, backendController]) {
		const authentication = await request(controller, 'auth.check', { providerId, scopes });
		if (authentication.available !== true) {
			throw new Error(
				`Authenticated multi-project E2E requires a ${providerId} session in the shared profile.`,
			);
		}
	}
	const frontendNode = requireDirectoryNode(device, source.nodeId);
	const backendNode = requireDirectoryNode(device, backendController.nodeId);
	const collaborationRequestId = randomUUID();
	const started = await request(source, 'collaboration.start', {
		collaborationRequestId,
		title: 'Implement and consume the items API',
		goal: [
			'Backend: implement getItems() in server.mjs, create contract.json with endpoint "/api/items"',
			'and make npm test pass. Write contract.json and use the exact same object as the structured',
			'contract artifact content: {"endpoint":"/api/items","method":"GET","item":{"type":"object",',
			'"required":["id","name"],"properties":{"id":{"type":"string"},"name":{"type":"string"}}}}.',
			'Frontend: implement createItemsRequest() and renderItem() in client.mjs from that contract',
			'and make npm test pass. Do not modify the other workspace.',
		].join(' '),
		frontend: {
			deviceId: device.deviceId,
			nodeId: frontendNode.nodeId,
			nodeInstanceId: frontendNode.nodeInstanceId,
			workspaceId: frontendWorkspace.workspaceId,
		},
		backend: {
			deviceId: device.deviceId,
			nodeId: backendNode.nodeId,
			nodeInstanceId: backendNode.nodeInstanceId,
			workspaceId: backendWorkspace.workspaceId,
		},
		timeoutMinutes: 30,
	}, 180_000);
	assert.equal(typeof started.run?.runId, 'string', 'Collaboration start did not return a run ID.');
	assert.equal(started.run.collaborationRequestId, collaborationRequestId);
	const runId = started.run.runId;
	const observed = new Map();
	let latestRun = started.run;
	const deadline = Date.now() + 30 * 60_000;
	while (Date.now() < deadline) {
		const current = await request(source, 'collaboration.get', { runId }, 60_000);
		latestRun = current.run;
		for (const task of latestRun.tasks) {
			try {
				const previous = observed.get(task.taskId);
				const read = await request(source, 'task.get', {
					taskId: task.taskId,
					afterEventSequence: previous?.eventCursor ?? 0,
					maxEvents: 100,
				}, 30_000);
				observed.set(task.taskId, {
					status: read.snapshot.status,
					eventCursor: read.eventCursor,
					eventTypes: [...new Set([
						...(previous?.eventTypes ?? []),
						...read.events.map((event) => event.type),
					])],
				});
				if (read.snapshot.status === 'needsInput' && read.snapshot.pendingInput) {
					await request(source, 'task.answer', {
						taskId: task.taskId,
						inputId: read.snapshot.pendingInput.inputId,
						answerId: randomUUID(),
						answer: 'approve',
					}, 30_000);
				}
			} catch (error) {
				if (!(error instanceof E2eRequestError && error.code === 'TASK_NOT_FOUND')) {
					throw error;
				}
			}
		}
		if (latestRun.status === 'completed') {
			break;
		}
		if (latestRun.status === 'failed' || latestRun.status === 'cancelled') {
			throw new Error(
				`Collaboration ${runId} became ${latestRun.status}: ${JSON.stringify(
					latestRun.tasks.map(({ taskId, status, failure, block }) => ({
						taskId,
						status,
						failure: failure?.code,
						block: block?.code,
					})),
				)}.`,
			);
		}
		await delay(250);
	}
	assert.equal(latestRun.status, 'completed', 'Collaboration did not complete before the deadline.');
	for (const task of latestRun.tasks) {
		for (let page = 0; page < 20; page += 1) {
			const previous = observed.get(task.taskId);
			const read = await request(source, 'task.get', {
				taskId: task.taskId,
				afterEventSequence: previous?.eventCursor ?? 0,
				maxEvents: 100,
			}, 30_000);
			observed.set(task.taskId, {
				status: read.snapshot.status,
				eventCursor: read.eventCursor,
				eventTypes: [...new Set([
					...(previous?.eventTypes ?? []),
					...read.events.map((event) => event.type),
				])],
			});
			if (read.events.length < 100) {
				break;
			}
		}
	}
	const backend = requireCollaborationTask(latestRun, 'backend', 'implementation');
	const frontend = requireCollaborationTask(latestRun, 'frontend', 'implementation');
	const backendEvents = requireCompletedTaskEvents(observed, backend.taskId, 'backend');
	const frontendEvents = requireCompletedTaskEvents(observed, frontend.taskId, 'frontend');
	const artifact = latestRun.artifacts[0];
	assert.ok(artifact, 'Collaboration did not publish a contract artifact.');
	assert.equal(artifact.producerTaskId, backend.taskId);
	assert.ok(backend.artifactIds.includes(artifact.artifactId));
	assert.ok(frontend.artifactIds.includes(artifact.artifactId));
	assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
	assert.ok(artifact.contentLength > 0);

	const contractFile = JSON.parse(await readFile(join(repoBPath, 'contract.json'), 'utf8'));
	const contractHash = createHash('sha256')
		.update(canonicalJson(contractFile), 'utf8')
		.digest('hex');
	assert.equal(contractHash, artifact.sha256, 'Backend contract file and immutable artifact differ.');
	const backendValidation = runWorkspaceValidation(repoBPath);
	const frontendValidation = runWorkspaceValidation(repoAPath);
	assert.equal(backendValidation, 0, 'Independent backend validation failed.');
	assert.equal(frontendValidation, 0, 'Independent frontend validation failed.');
	assert.equal(latestRun.validations.length, 2);
	assert.ok(latestRun.validations.every(({ status }) => status === 'passed'));
	await waitForNoAgentHostProcesses(30_000);
	return {
		state: 'completed',
		runId,
		collaborationRequestId,
		windowNodes: {
			frontend: source.nodeId,
			backend: backendController.nodeId,
		},
		workspaceClaims: {
			frontend: frontendWorkspace.workspaceId,
			backend: backendWorkspace.workspaceId,
		},
		backend: {
			taskId: backend.taskId,
			agentStarted: backendEvents.includes('agentStarted'),
			output: backendEvents.includes('output'),
			turnComplete: backendEvents.includes('completed'),
			completed: observed.get(backend.taskId).status === 'completed',
			eventTypes: backendEvents,
		},
		artifact: {
			artifactId: artifact.artifactId,
			mediaType: artifact.mediaType,
			contentLength: artifact.contentLength,
			sha256: artifact.sha256,
			contentRecorded: false,
		},
		frontend: {
			taskId: frontend.taskId,
			consumedArtifactId: artifact.artifactId,
			agentStarted: frontendEvents.includes('agentStarted'),
			output: frontendEvents.includes('output'),
			turnComplete: frontendEvents.includes('completed'),
			completed: observed.get(frontend.taskId).status === 'completed',
			eventTypes: frontendEvents,
		},
		validation: {
			backend: 'passed',
			frontend: 'passed',
			independentBackendExitCode: backendValidation,
			independentFrontendExitCode: frontendValidation,
		},
		runCompleted: true,
	};
}

async function runProductionTask(source, target, device, workspace) {
	const probe = await request(target, 'runtime.probe', {}, 30_000);
	if (probe.available !== true || probe.featureEnabled !== true) {
		throw new Error(
			`Production Agent Host runtime unavailable: ${probe.reason ?? 'probe failed'}.`,
		);
	}

	const providerId = process.env.MESH_MULTI_WINDOW_E2E_AUTH_PROVIDER ?? 'github';
	const scopes = parseStringArray(
		process.env.MESH_MULTI_WINDOW_E2E_AUTH_SCOPES_JSON,
		[],
	);
	const authentication = await request(target, 'auth.check', { providerId, scopes });
	const mappingConfigured = Boolean(
		process.env.MESH_MULTI_WINDOW_E2E_AUTH_RESOURCE
		&& process.env.MESH_MULTI_WINDOW_E2E_AUTH_PROVIDER,
	);
	const targetNode = requireDirectoryNode(device, target.nodeId);
	const delegationRequestId = randomUUID();
	let started;
	try {
		started = await request(source, 'task.start', {
			delegationRequestId,
			deviceId: device.deviceId,
			nodeId: targetNode.nodeId,
			nodeInstanceId: targetNode.nodeInstanceId,
			workspaceId: workspace.workspaceId,
			title: 'Same-profile real Window Node cancellation probe',
			prompt: [
				'Use the terminal to run: node -e "setTimeout(() => {}, 120000)".',
				'Before running it, report that the cancellation probe started.',
				'Do not modify files. Wait for cancellation.',
			].join(' '),
			acceptanceCriteria: [
				'The source observes authoritative WindowNodeTaskExecutor events and cancellation.',
			],
		}, 180_000);
	} catch (error) {
		if (
			error instanceof E2eRequestError
			&& error.code === 'AGENT_AUTH_REQUIRED'
			&& (!mappingConfigured || authentication.available !== true)
		) {
			await waitForNoAgentHostProcesses(15_000);
			return {
				state: 'blocked',
				code: 'AGENT_AUTH_REQUIRED',
				authSessionAvailable: authentication.available === true,
				authenticationMappingConfigured: mappingConfigured,
				startAuthoritative: false,
				getAuthoritative: false,
				cancelAuthoritative: false,
				eventsClaimed: false,
			};
		}
		throw error;
	}
	assert.equal(typeof started.taskId, 'string', 'Task start did not return a task ID.');
	const ready = await waitForTaskEventOrTerminal(
		source,
		started.taskId,
		'agentStarted',
		60_000,
	);
	if (ready.kind === 'terminal') {
		const eventTypes = ready.value.events.map((event) => event.type);
		if (
			ready.value.snapshot.status === 'failed'
			&& ready.value.snapshot.failure?.code === 'AGENT_AUTH_REQUIRED'
			&& (!mappingConfigured || authentication.available !== true)
		) {
			for (const unclaimed of ['agentStarted', 'cancelRequested', 'cancelConfirmed']) {
				assert.equal(
					eventTypes.includes(unclaimed),
					false,
					`Authentication-blocked task unexpectedly claimed ${unclaimed}.`,
				);
			}
			await waitForNoAgentHostProcesses(15_000);
			return {
				state: 'blocked',
				code: 'AGENT_AUTH_REQUIRED',
				authSessionAvailable: authentication.available === true,
				authenticationMappingConfigured: mappingConfigured,
				acceptanceAuthoritative: true,
				startAuthoritative: false,
				getAuthoritative: true,
				cancelAuthoritative: false,
				eventsClaimed: false,
				eventTypes,
			};
		}
		throw new Error(
			`The cancellation probe became terminal before agentStarted: ${JSON.stringify(
				ready.value.snapshot.failure ?? ready.value.snapshot.status,
			)}.`,
		);
	}
	let latest = ready.value;
	assert.equal(latest.snapshot.taskId, started.taskId);
	assert.ok(
		latest.events.some((event) => event.type === 'agentStarted'),
		'Task polling did not observe authoritative agentStarted.',
	);
	const observedSignals = new Set(latest.events.map((event) => event.type));
	let inputAnswered = false;
	const observationDeadline = Date.now() + 120_000;
	while (
		Date.now() < observationDeadline
		&& !terminalStates.has(latest.snapshot.status)
		&& !observedSignals.has('output')
	) {
		if (latest.snapshot.status === 'needsInput' && latest.snapshot.pendingInput) {
			await request(source, 'task.answer', {
				taskId: started.taskId,
				inputId: latest.snapshot.pendingInput.inputId,
				answerId: randomUUID(),
				answer: 'approve',
			});
			inputAnswered = true;
		}
		await delay(100);
		latest = await request(source, 'task.get', { taskId: started.taskId });
		for (const event of latest.events) {
			observedSignals.add(event.type);
		}
	}
	if (terminalStates.has(latest.snapshot.status)) {
		throw new Error(
			`The cancellation probe became ${latest.snapshot.status} before cancel was exercised.`,
		);
	}
	assert.ok(
		observedSignals.has('output'),
		'The cancellation probe did not emit real Agent output before the observation deadline.',
	);
	const cancelReceipt = await request(
		source,
		'task.cancel',
		{ taskId: started.taskId },
		30_000,
	);
	assert.ok(
		cancelReceipt.status === 'cancelling' || cancelReceipt.status === 'cancelled',
		`Cancellation returned ${cancelReceipt.status}.`,
	);
	const terminal = await waitForTask(source, started.taskId, 60_000);
	assert.equal(terminal.snapshot.status, 'cancelled');
	const eventTypes = terminal.events.map((event) => event.type);
	for (const required of ['agentStarted', 'cancelRequested', 'cancelConfirmed']) {
		assert.ok(eventTypes.includes(required), `Authoritative task events omitted ${required}.`);
	}
	if (inputAnswered) {
		assert.ok(eventTypes.includes('inputAnswered'), 'The answered input event was not returned.');
	}
	await waitForNoAgentHostProcesses(15_000);
	return {
		state: 'cancelled',
		authSessionAvailable: authentication.available === true,
		startAuthoritative: true,
		getAuthoritative: true,
		cancelAuthoritative: true,
		agentTaskHandleCancelInvoked: true,
		terminalAuthoritative: true,
		outputObserved: eventTypes.includes('output'),
		progressObserved: eventTypes.includes('progress'),
		inputRequested: eventTypes.includes('inputRequired'),
		inputAnswered,
		eventTypes,
	};
}

function requireCollaborationTask(run, role, kind) {
	const task = run.tasks.find((candidate) =>
		candidate.role === role && candidate.kind === kind,
	);
	assert.ok(task, `Missing ${role} ${kind} collaboration task.`);
	assert.equal(task.status, 'completed');
	return task;
}

function requireCompletedTaskEvents(observed, taskId, label) {
	const task = observed.get(taskId);
	assert.ok(task, `Missing ${label} task evidence.`);
	assert.equal(task.status, 'completed');
	for (const required of ['agentStarted', 'output', 'completed']) {
		assert.ok(task.eventTypes.includes(required), `${label} task omitted ${required}.`);
	}
	return task.eventTypes;
}

function runWorkspaceValidation(workspacePath) {
	const result = spawnSync(process.execPath, ['test.mjs'], {
		cwd: workspacePath,
		env: { ...process.env },
		encoding: 'utf8',
		timeout: 30_000,
	});
	if (result.error !== undefined) {
		throw result.error;
	}
	return result.status;
}

function canonicalJson(value) {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

async function waitForTask(controller, taskId, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let latest;
	do {
		latest = await request(controller, 'task.get', { taskId });
		if (terminalStates.has(latest.snapshot.status)) {
			return latest;
		}
		if (latest.snapshot.status === 'needsInput' && latest.snapshot.pendingInput) {
			await request(controller, 'task.answer', {
				taskId,
				inputId: latest.snapshot.pendingInput.inputId,
				answerId: randomUUID(),
				answer: 'approve',
			});
		}
		await delay(100);
	} while (Date.now() < deadline);
	throw new Error(
		`Task ${taskId} did not become terminal; last status ${latest?.snapshot?.status ?? 'unknown'}.`,
	);
}

async function waitForTaskEventOrTerminal(controller, taskId, expectedEvent, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let latest;
	do {
		latest = await request(controller, 'task.get', { taskId });
		if (latest.events.some((event) => event.type === expectedEvent)) {
			return { kind: 'event', value: latest };
		}
		if (terminalStates.has(latest.snapshot.status)) {
			return { kind: 'terminal', value: latest };
		}
		await delay(100);
	} while (Date.now() < deadline);
	throw new Error(
		`Task ${taskId} did not emit ${expectedEvent} or become terminal; `
		+ `last status ${latest?.snapshot?.status ?? 'unknown'}.`,
	);
}

function localDevice(directory) {
	return directory?.devices?.find((device) => device.locality === 'local');
}

function requireDirectoryNode(device, nodeId) {
	const node = device?.nodes?.find((candidate) => candidate.nodeId === nodeId);
	assert.ok(node, `Window Node ${nodeId} was absent from the local directory.`);
	return node;
}

function requireClaimedWorkspace(node, expectedName) {
	const workspace = node.workspaces.find(
		(candidate) => candidate.name === expectedName && candidate.claimStatus === 'claimed',
	);
	assert.ok(workspace, `${expectedName} was not authoritatively claimed.`);
	return workspace;
}

function assertSharedProfileArguments(argumentSets) {
	const userDataValues = new Set();
	const extensionsValues = new Set();
	for (const args of argumentSets) {
		const userData = args.find((arg) => arg.startsWith('--user-data-dir='));
		const extensions = args.find((arg) => arg.startsWith('--extensions-dir='));
		assert.equal(userData, `--user-data-dir=${userDataDirectory}`);
		assert.equal(extensions, `--extensions-dir=${extensionsDirectory}`);
		assert.equal(
			args.filter((arg) => arg.startsWith('--user-data-dir=')).length,
			1,
			'A window received more than one user-data directory.',
		);
		assert.equal(
			args.filter((arg) => arg.startsWith('--extensions-dir=')).length,
			1,
			'A window received more than one extensions directory.',
		);
		userDataValues.add(userData);
		extensionsValues.add(extensions);
	}
	assert.equal(userDataValues.size, 1, 'VS Code windows did not share one user-data directory.');
	assert.equal(extensionsValues.size, 1, 'VS Code windows did not share one extensions directory.');
}

async function assertTunnelUntouched() {
	assert.equal(
		await isAbsent(sentinelInvocationPath),
		true,
		'The Dev Tunnel sentinel executable was invoked.',
	);
	assert.equal(
		createHash('sha256').update(await readFile(sentinelPath)).digest('hex'),
		sentinelDigest,
		'The Dev Tunnel sentinel executable changed.',
	);
	assert.equal(
		currentOwnedProcesses().filter(isDevTunnelProcess).length,
		0,
		'An owned Dev Tunnel process was observed.',
	);
}

function isDevTunnelProcess(processInfo) {
	return processInfo.command.includes(sentinelPath);
}

function isAgentHostProcess(processInfo) {
	return /\sagent\s+host(?:\s|$)/u.test(processInfo.command);
}

function readProcessTable() {
	const result = spawnSync(
		'ps',
		['-axo', 'pid=,ppid=,pgid=,command='],
		{ encoding: 'utf8', maxBuffer: 4 * 1_024 * 1_024 },
	);
	if (result.status !== 0) {
		throw new Error('Unable to inspect exact owned multi-window E2E PIDs.');
	}
	return parseProcessTable(result.stdout);
}

function currentOwnedProcesses() {
	const processTable = readProcessTable();
	const selected = selectOwnedProcesses(processTable, {
		rootPids,
		markers: ownedMarkers,
		selfPid: process.pid,
	});
	const byPid = new Map(selected.map((processInfo) => [processInfo.pid, processInfo]));
	for (const processInfo of processTable) {
		if (
			processInfo.pid !== process.pid
			&& historicalOwnedCommands.get(processInfo.pid) === processInfo.command
		) {
			byPid.set(processInfo.pid, processInfo);
		}
	}
	const owned = [...byPid.values()];
	maximumOwnedProcessCount = Math.max(maximumOwnedProcessCount, owned.length);
	for (const processInfo of owned) {
		historicalOwnedPids.add(processInfo.pid);
		historicalOwnedCommands.set(processInfo.pid, processInfo.command);
	}
	return owned;
}

function refreshOwnedProcesses() {
	currentOwnedProcesses();
}

async function waitForNoOwnedProcesses(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	do {
		if (currentOwnedProcesses().length === 0) {
			return;
		}
		await delay(100);
	} while (Date.now() < deadline);
	throw new Error('Owned VS Code or Agent Host PIDs did not exit before the deadline.');
}

async function waitForNoAgentHostProcesses(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	do {
		if (currentOwnedProcesses().filter(isAgentHostProcess).length === 0) {
			return;
		}
		await delay(100);
	} while (Date.now() < deadline);
	throw new Error('The owned Agent Host process did not exit after terminal task state.');
}

async function terminateOwnedProcesses() {
	let remaining = currentOwnedProcesses();
	for (const processInfo of remaining) {
		killExactProcess(processInfo.pid, 'SIGTERM');
	}
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		await delay(100);
		remaining = currentOwnedProcesses();
		if (remaining.length === 0) {
			return;
		}
	}
	for (const processInfo of remaining) {
		killExactProcess(processInfo.pid, 'SIGKILL');
	}
}

function killExactProcess(pid, signal) {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if (error.code !== 'ESRCH') {
			throw error;
		}
	}
}

async function closeControllers() {
	const controllers = [...activeControllers.values()];
	const states = await Promise.all(controllers.map(async (controller) => ({
		controller,
		state: await request(controller, 'controller.state', {}, 2_000).catch(() => undefined),
	})));
	states.sort((left, right) =>
		Number(left.state?.broker?.owner === true) - Number(right.state?.broker?.owner === true),
	);
	for (const { controller } of states) {
		await request(controller, 'host.close', {}, 5_000).catch(() => undefined);
		activeControllers.delete(controller.windowId);
	}
}

async function closeLogStreams() {
	await Promise.all(launchRecords.map(({ child, output }) => new Promise((resolveOutput) => {
		child.stdout?.unpipe(output);
		child.stderr?.unpipe(output);
		if (output.closed) {
			resolveOutput();
		} else {
			output.end(resolveOutput);
		}
	})));
}

async function saveSanitizedLogs() {
	for (const record of launchRecords) {
		const raw = await readFile(record.logPath, 'utf8').catch(() => '');
		const sanitized = sanitize(raw);
		const name = `${runId}-${basename(record.logPath)}`;
		await writeFile(join(evidenceRoot, name), sanitized, {
			encoding: 'utf8',
			mode: 0o600,
		});
	}
}

async function waitForFile(path, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	do {
		try {
			await access(path);
			return;
		} catch {
			await delay(25);
		}
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for controller response ${basename(path)}.`);
}

async function isAbsent(path) {
	try {
		await stat(path);
		return false;
	} catch (error) {
		if (error.code === 'ENOENT') {
			return true;
		}
		throw error;
	}
}

function parseStringArray(value, fallback) {
	if (!value) {
		return fallback;
	}
	const parsed = JSON.parse(value);
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
		throw new Error('The multi-window authentication scopes must be a JSON string array.');
	}
	return parsed;
}

function requiredString(value, label) {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${label} is unavailable.`);
	}
	return value;
}

function assertUsableRuntimePath() {
	if (configuredRuntimeBase !== undefined && !isAbsolute(configuredRuntimeBase)) {
		throw new Error('MESH_MULTI_WINDOW_E2E_RUNTIME_DIR must be an absolute path.');
	}
	const forbiddenRoots = ['/tmp', '/var/tmp', '/private/tmp'];
	if (forbiddenRoots.some((root) =>
		runtimeBase === root || runtimeBase.startsWith(`${root}${sep}`),
	)) {
		throw new Error('MESH_MULTI_WINDOW_E2E_RUNTIME_DIR must not use /tmp or /var/tmp.');
	}
	assertUsableProfilePath();
	if (process.platform !== 'darwin') {
		return;
	}
	const mainIpcPath = join(userDataDirectory, '1.13-main.sock');
	const bytes = Buffer.byteLength(mainIpcPath, 'utf8');
	if (bytes > 103) {
		throw new Error(
			`VS Code shared user-data IPC path is ${bytes} bytes (maximum 103). `
			+ 'Use a shorter checkout or set MESH_MULTI_WINDOW_E2E_RUNTIME_DIR '
			+ 'to a short absolute non-/tmp directory.',
		);
	}
}

function assertUsableProfilePath() {
	if (!persistentProfile) {
		return;
	}
	if (!isAbsolute(configuredProfileBase)) {
		throw new Error('MESH_MULTI_WINDOW_E2E_PROFILE_DIR must be an absolute path.');
	}
	if (profileBase === dirname(profileBase)) {
		throw new Error('MESH_MULTI_WINDOW_E2E_PROFILE_DIR must not be a filesystem root.');
	}
	const forbiddenRoots = ['/tmp', '/var/tmp', '/private/tmp'];
	if (forbiddenRoots.some((root) =>
		profileBase === root || profileBase.startsWith(`${root}${sep}`),
	)) {
		throw new Error('MESH_MULTI_WINDOW_E2E_PROFILE_DIR must not use /tmp or /var/tmp.');
	}
	if (
		profileBase === runtimeBase
		|| isWithin(runtimeBase, profileBase)
		|| isWithin(profileBase, runtimeBase)
	) {
		throw new Error(
			'MESH_MULTI_WINDOW_E2E_PROFILE_DIR must be outside the run directory; '
			+ 'the run directory is deleted during cleanup.',
		);
	}
	// A persistent profile is written to and reused. It must never be aimed at a real
	// VS Code installation profile, whose sessions and state belong to the developer.
	for (const realProfile of realVscodeUserDataDirectories()) {
		if (
			profileBase === realProfile
			|| isWithin(realProfile, profileBase)
			|| isWithin(profileBase, realProfile)
		) {
			throw new Error(
				'MESH_MULTI_WINDOW_E2E_PROFILE_DIR must not overlap a real VS Code user data directory. '
				+ 'Use a dedicated directory such as ~/.mw-profile.',
			);
		}
	}
}

function realVscodeUserDataDirectories() {
	const home = homedir();
	const candidates = [
		join(home, 'Library', 'Application Support', 'Code'),
		join(home, 'Library', 'Application Support', 'Code - Insiders'),
		join(home, '.config', 'Code'),
		join(home, '.config', 'Code - Insiders'),
		join(home, '.vscode'),
		join(home, '.vscode-insiders'),
	];
	if (typeof process.env.APPDATA === 'string' && process.env.APPDATA.length > 0) {
		candidates.push(
			join(process.env.APPDATA, 'Code'),
			join(process.env.APPDATA, 'Code - Insiders'),
		);
	}
	return candidates;
}

function isWithin(parent, candidate) {
	return candidate.startsWith(`${parent}${sep}`);
}

function safeFailure(error) {
	return {
		name: error instanceof Error ? error.name : 'Error',
		message: sanitize(
			error instanceof Error ? error.message : String(error),
		),
		...(
			error instanceof E2eRequestError && typeof error.code === 'string'
				? { code: error.code }
				: {}
		),
	};
}

function sanitize(value) {
	const withoutProfile = persistentProfile
		? value.split(profileBase).join('<profile>')
		: value;
	return withoutProfile
		.split(runRoot).join('<runtime>')
		.split(repositoryRoot).join('<repository>')
		.split(homedir()).join('<home>');
}

function delay(delayMs) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}
