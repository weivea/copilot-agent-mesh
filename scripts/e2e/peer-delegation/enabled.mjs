import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, createWriteStream } from 'node:fs';
import {
	access,
	chmod,
	lstat,
	mkdir,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	downloadAndUnzipVSCode,
	resolveCliPathFromVSCodeExecutablePath,
} from '@vscode/test-electron';
import {
	assertCleanCommittedReleaseSnapshot,
	resolvePeerDelegationEvidenceDestination,
} from './evidence-path.mjs';

const environmentPrefix = 'MESH_PEER_DELEGATION_E2E';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const require = createRequire(import.meta.url);
const {
	multiWindowWorkspaceKey,
	parseProcessTable,
	readMultiWindowStartupDiagnostic,
} = require(join(repositoryRoot, 'out/src/e2e/MultiWindowE2eSupport.js'));
const {
	createPeerDelegationDiagnosticEvidence,
	createPeerDelegationTestDiagnosticEvidence,
	normalizePeerDelegationEvidenceTerminalState,
	parsePeerDelegationEvidence,
} = require(join(repositoryRoot, 'out/src/e2e/PeerDelegationEvidence.js'));
const {
	runPeerDelegationCleanupPhases,
} = require(join(repositoryRoot, 'out/src/e2e/PeerDelegationCleanup.js'));
const {
	PeerDelegationProcessTracker,
} = require(join(repositoryRoot, 'out/src/e2e/PeerDelegationProcessTracker.js'));

class E2eRequestError extends Error {
	constructor(action, code, message) {
		super(message);
		this.name = 'E2eRequestError';
		this.action = action;
		this.code = code;
	}
}

function revalidateEvidenceDestination(additionalFileNames = []) {
	return resolvePeerDelegationEvidenceDestination({
		repositoryRoot,
		configuredRoot: evidenceRoot,
		additionalFileNames,
	});
}

const testMode = process.env[`${environmentPrefix}_TEST_MODE`] === '1';
if (
	!testMode
	&& (process.platform !== 'darwin' || process.arch !== 'arm64')
) {
	throw new Error('The real peer-delegation E2E requires supported macOS arm64 Worker hardware.');
}

const runId = randomUUID();
const runLabel = runId.slice(0, 8);
const startedAtMs = Date.now();
const configuredRuntimeBase = process.env[`${environmentPrefix}_RUNTIME_DIR`];
const runtimeBase = configuredRuntimeBase === undefined
	? join(homedir(), '.mesh-peer-e2e')
	: resolve(configuredRuntimeBase);
const runRoot = join(runtimeBase, `peer-${runLabel}`);
const configuredProfileBase = process.env[`${environmentPrefix}_PROFILE_DIR`];
const persistentProfile = configuredProfileBase !== undefined;
const profileBase = persistentProfile
	? resolve(configuredProfileBase)
	: join(runRoot, 'profile');
const userDataDirectory = join(profileBase, 'user-data');
const profileLockDirectory = join(profileBase, '.copilot-agent-mesh-peer-e2e-lock');
const profileLockOwnerPath = join(profileLockDirectory, 'owner');
const extensionsDirectory = join(runRoot, 'extensions');
const controlRoot = join(runRoot, 'control');
const logsDirectory = join(runRoot, 'logs');
const workspacesDirectory = join(runRoot, 'projects');
const sourceWorkspacePath = join(workspacesDirectory, `source-${runLabel}`);
const targetWorkspacePath = join(workspacesDirectory, `target-${runLabel}`);
const sentinelPath = join(runRoot, 'devtunnel-sentinel');
const sentinelInvocationPath = join(runRoot, 'devtunnel-invoked.json');
const configuredEvidenceRoot = process.env[`${environmentPrefix}_EVIDENCE_DIR`];
const releaseEvidenceRoot = join(repositoryRoot, 'artifacts', 'peer-delegation-e2e');
const evidenceDestination = await resolvePeerDelegationEvidenceDestination({
	repositoryRoot,
	configuredRoot: configuredEvidenceRoot,
});
const evidenceRoot = evidenceDestination.root;
const evidencePath = evidenceDestination.evidencePath;
const summaryPath = evidenceDestination.summaryPath;
const attestationPath = join(evidenceRoot, `attestation-${runId}.json`);
const manualUi = process.env[`${environmentPrefix}_MANUAL_UI`] !== '0';
const testTerminationLogPath = testMode
	&& process.env[`${environmentPrefix}_TEST_TERMINATION_LOG`] !== undefined
	? resolve(process.env[`${environmentPrefix}_TEST_TERMINATION_LOG`])
	: undefined;
const budgetMs = parseBudgetMs(process.env[`${environmentPrefix}_BUDGET_MS`] ?? '10000');
const nonce = randomUUID();
const sourceWindowLabel = `P8 Source ${runLabel}`;
const targetWindowLabel = `P8 Target ${runLabel}`;
const ownedMarkers = [
	runRoot,
	extensionsDirectory,
	controlRoot,
	sentinelPath,
];
const processTracker = new PeerDelegationProcessTracker({
	rootPids: new Set(),
	markers: ownedMarkers,
	selfPid: process.pid,
});
const launchRecords = [];
const windowOpenRecords = [];
const activeControllers = new Map();
const ownedPeaks = {
	vscode: 0,
	agentHost: 0,
	tunnel: 0,
};
let maximumOwnedProcessCount = 0;
let localIpcEndpoint;
let vscodeExecutablePath;
let codeCliPath;
let sentinelDigest;
let profileLockOwned = false;
let primaryFailure;
let cleanupFailure;
let latestResourceMetrics;
let cleanupLeaseReleased = false;
let evidence = initialEvidence();
let canonicalUserDataDirectory = userDataDirectory;
let signalCleanupStarted = false;
let cleanupOperation;
let ownershipSampler;
let ownershipSamplerStarted = false;
let ownershipSamplerFailure;
let testDirtyTree = false;
let testEvidencePersistenceAllowed = true;

if (
	testMode
	&& (
		configuredEvidenceRoot === undefined
		|| filesystemPathsOverlap(evidenceRoot, releaseEvidenceRoot)
	)
) {
	throw new Error('Internal peer-delegation test mode requires an isolated evidence directory.');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		if (signalCleanupStarted) {
			return;
		}
		signalCleanupStarted = true;
		primaryFailure ??= new Error(`The peer-delegation E2E was interrupted by ${signal}.`);
		void cleanupAfterSignal(signal);
	});
}

try {
	await preflight();
	await acquireProfileLock();
	await assertProfileMutationSafe();
	assertProfileIdle();
	await prepareRun();
	vscodeExecutablePath = process.env.MESH_VSCODE_EXECUTABLE
		? resolve(process.env.MESH_VSCODE_EXECUTABLE)
		: await downloadAndUnzipVSCode('stable');
	await access(vscodeExecutablePath);
	codeCliPath = process.env.MESH_CODE_CLI
		? resolve(process.env.MESH_CODE_CLI)
		: resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
	await access(codeCliPath);
	evidence.versions.vscode = readCodeVersion(codeCliPath);
	await writeSettings();

	assert.equal(currentOwnedProcesses().length, 0, 'Fresh peer E2E markers matched an existing process.');
	const source = await launchAndDiscover(sourceWorkspacePath);
	activeControllers.set(source.windowId, source);
	await waitForControllerState(
		source,
		(state) => state.broker?.state === 'running' && state.broker?.owner === true,
		30_000,
		'the source window did not become Broker owner',
	);
	const target = await launchAndDiscover(targetWorkspacePath);
	activeControllers.set(target.windowId, target);
	const topology = await waitForDashboard(
		source,
		(snapshot) => {
			const live = snapshot.localNodes?.filter(({ status }) => status !== 'offline') ?? [];
			return live.length === 2
				&& live.some(({ nodeId }) => nodeId === source.nodeId)
				&& live.some(({ nodeId }) => nodeId === target.nodeId);
		},
		10_000,
		'two ordinary Window Nodes were not visible',
	);
	const controllerStates = await Promise.all([
		request(source, 'controller.state'),
		request(target, 'controller.state'),
	]);
	const brokerCount = controllerStates.filter(
		(state) => state.broker?.owner === true && state.broker?.state === 'running',
	).length;
	assert.equal(brokerCount, 1, 'Exactly one running Broker owner was not observed.');
	assert.equal(windowOpenRecords.length, 1, 'The target was not opened as a second ordinary window.');
	const sourceClaim = await request(source, 'peer.claim.fingerprint');
	const targetClaim = await request(target, 'peer.claim.fingerprint');
	const claimHashes = [sourceClaim.claimHash, targetClaim.claimHash];
	assert.equal(new Set(claimHashes).size, 2, 'The two projects did not produce distinct Workspace claims.');
	evidence.topology = {
		ordinaryWindows: {
			status: 'pass',
			count: 2,
			ordinary: true,
			sharedUserData: true,
		},
		broker: { status: 'pass', count: brokerCount },
		workspaceClaims: {
			status: 'pass',
			count: 2,
			hashes: claimHashes,
			distinct: true,
		},
	};
	setAc5(1, 'pass', ['#/topology/ordinaryWindows']);
	setAc5(2, 'pass', ['#/topology/broker']);
	setAc5(3, 'pass', ['#/topology/workspaceClaims']);

	await request(source, 'peer.window.rename', { name: sourceWindowLabel });
	await request(target, 'peer.window.rename', { name: targetWindowLabel });
	const namedDashboard = await waitForDashboard(
		source,
		(snapshot) => snapshot.localNodes?.some(({ label }) => label === targetWindowLabel),
		5_000,
		'the target window rename did not propagate',
	);
	const sourceNode = requireDashboardNode(namedDashboard, source.nodeId);
	const targetNode = requireDashboardNode(namedDashboard, target.nodeId);
	const targetWorkspace = requireClaimedWorkspace(targetNode);
	const targetInputBase = {
		deviceId: namedDashboard.device.deviceId,
		nodeId: targetNode.nodeId,
		nodeInstanceId: targetNode.nodeInstanceId,
		workspaceId: targetWorkspace.workspaceId,
	};

	localIpcEndpoint = await request(source, 'ipc.endpoint');
	assert.equal(localIpcEndpoint.platform, process.platform);
	if (localIpcEndpoint.platform !== 'win32') {
		const socket = await lstat(localIpcEndpoint.address);
		assert.equal(socket.isSocket(), true, 'The local Broker endpoint is not a Unix socket.');
	}
	const baselineResources = await request(source, 'peer.resources');
	latestResourceMetrics = baselineResources;
	assertAttemptMetricsZero(baselineResources);
	assert.equal(await isAbsent(sentinelInvocationPath), true);

	const catalogBefore = await request(target, 'peer.session.catalog', {}, 60_000);
	const catalogBeforeCount = catalogBefore.available ? catalogBefore.sessionCount : 0;

	await request(target, 'peer.policy.accept', { enabled: false });
	await request(source, 'peer.policy.allow', {
		windowLabel: targetWindowLabel,
		allowed: false,
	});
	const beforeList = await invokeMeshTool(source, 'mesh_list_workers', {});
	const beforeTargetVisible = toolDirectoryContains(beforeList, targetNode);
	const notAllowed = await request(source, 'peer.direct.start.error', {
		input: {
			...targetInputBase,
			delegationRequestId: randomUUID(),
			title: 'P8 denied allowlist probe',
			prompt: 'Return a short safe acknowledgement without tools or file changes.',
			acceptanceCriteria: [],
			timeoutMinutes: 1,
		},
	});
	await request(source, 'peer.policy.allow', {
		windowLabel: targetWindowLabel,
		allowed: true,
	});
	const allowOnlyList = await invokeMeshTool(source, 'mesh_list_workers', {});
	const allowOnlyTargetVisible = toolDirectoryContains(allowOnlyList, targetNode);
	const notAccepting = await request(source, 'peer.direct.start.error', {
		input: {
			...targetInputBase,
			delegationRequestId: randomUUID(),
			title: 'P8 denied receive-gate probe',
			prompt: 'Return a short safe acknowledgement without tools or file changes.',
			acceptanceCriteria: [],
			timeoutMinutes: 1,
		},
	});
	await request(target, 'peer.policy.accept', { enabled: true });
	const afterList = await invokeMeshTool(source, 'mesh_list_workers', {});
	const afterTargetVisible = toolDirectoryContains(afterList, targetNode);
	const reverseList = await invokeMeshTool(target, 'mesh_list_workers', {});
	const reverseTargetVisible = toolDirectoryContains(reverseList, sourceNode);
	const sourceDashboard = await request(source, 'peer.dashboard.snapshot');
	const targetDashboard = await request(target, 'peer.dashboard.snapshot');
	const sourceCandidateCount = sourceDashboard.policyCandidates?.length ?? 0;
	const targetCandidateCount = targetDashboard.policyCandidates?.length ?? 0;
	const dashboardAlwaysListedBoth = sourceCandidateCount === 2 && targetCandidateCount === 2;
	assert.equal(beforeTargetVisible, false);
	assert.equal(notAllowed.code, 'PEER_NOT_ALLOWED');
	assert.equal(allowOnlyTargetVisible, false);
	assert.equal(notAccepting.code, 'PEER_NOT_ACCEPTING');
	assert.equal(afterTargetVisible, true);
	assert.equal(reverseTargetVisible, false);
	assert.equal(dashboardAlwaysListedBoth, true);
	evidence.doubleGate = {
		status: 'pass',
		beforeTargetVisible,
		notAllowedCode: notAllowed.code,
		allowOnlyTargetVisible,
		notAcceptingCode: notAccepting.code,
		afterTargetVisible,
		reverseTargetVisible,
		dashboardSourceCandidateCount: sourceCandidateCount,
		dashboardTargetCandidateCount: targetCandidateCount,
		dashboardAlwaysListedBoth,
	};
	setAc5(4, 'pass', ['#/doubleGate']);

	const completionAvailable = await recordCompletionScenario({
		source,
		target,
		targetInputBase,
		catalogBeforeCount,
	});
	if (completionAvailable) {
		await runNeedsInputScenario(source, targetInputBase);
		await runCancellationScenario(source, targetInputBase);
		await runTimeoutScenario(source, targetInputBase);
	}

	latestResourceMetrics = await request(source, 'peer.resources');
	const listenerDelta = delta(
		baselineResources.listener.startAttempts,
		latestResourceMetrics.listener.startAttempts,
	);
	const tunnelLoadDelta = delta(
		baselineResources.tunnel.loadAttempts,
		latestResourceMetrics.tunnel.loadAttempts,
	);
	const tunnelProbeDelta = delta(
		baselineResources.tunnel.probeAttempts,
		latestResourceMetrics.tunnel.probeAttempts,
	);
	const tunnelEnsureDelta = delta(
		baselineResources.tunnel.ensureHostedAttempts,
		latestResourceMetrics.tunnel.ensureHostedAttempts,
	);
	const transportPass = [
		listenerDelta,
		tunnelLoadDelta,
		tunnelProbeDelta,
		tunnelEnsureDelta,
	].every(({ delta: difference }) => difference === 0)
		&& await isAbsent(sentinelInvocationPath)
		&& currentOwnedProcesses().filter(isDevTunnelProcess).length === 0;
	evidence.transport = {
		status: transportPass ? 'pass' : 'fail',
		listenerStartAttempts: listenerDelta,
		tunnelLoadAttempts: tunnelLoadDelta,
		tunnelProbeAttempts: tunnelProbeDelta,
		tunnelEnsureHostedAttempts: tunnelEnsureDelta,
		localRouteOnly: transportPass,
	};
	setAc5(10, transportPass ? 'pass' : 'fail', transportPass ? ['#/transport'] : []);
	cleanupLeaseReleased = completionAvailable
		? [
			evidence.completion.leaseReleased,
			evidence.needsInput.leaseReleased,
			evidence.cancellation.leaseReleased,
			evidence.timeout.leaseReleased,
		].every(Boolean)
		: evidence.completion.leaseReleased;
	assert.equal(latestResourceMetrics.toolTimers.activeTimers, 0);
	assert.equal(latestResourceMetrics.toolTimers.armedBudgetTimers, 0);
	await assertProjectUnchanged(sourceWorkspacePath);
	await assertProjectUnchanged(targetWorkspacePath);
} catch (error) {
	primaryFailure = error;
} finally {
	const cleanupFailures = await performCleanup();
	if (cleanupFailures.length > 0) {
		cleanupFailure = new AggregateError(
			cleanupFailures.map(({ error }) => error),
			'One or more peer-delegation E2E cleanup phases failed.',
		);
		evidence.cleanupFailures = cleanupFailures.map(({ phase, error }) => ({
			phase,
			...safeFailure(error),
		}));
	}
}

if (primaryFailure !== undefined || cleanupFailure !== undefined) {
	evidence.failure = safeFailure(primaryFailure ?? cleanupFailure);
}
evidence.finishedAt = new Date().toISOString();
evidence.durationMs = Date.now() - startedAtMs;
evidence.outcome = deriveOutcome(evidence);
injectInvalidEvidenceForTest(evidence);
const persisted = await persistEvidenceArtifact(evidence);
const validated = persisted.artifact;

if (persisted.validationError !== undefined) {
	throw new AggregateError(
		[
			primaryFailure,
			cleanupFailure,
			persisted.validationError,
		].filter((error) => error !== undefined),
		`Real peer-delegation E2E evidence validation failed safely; diagnostic: ${
			relative(repositoryRoot, evidencePath)
		}`,
	);
}

if (primaryFailure !== undefined || cleanupFailure !== undefined) {
	throw new AggregateError(
		[primaryFailure, cleanupFailure].filter((error) => error !== undefined),
		`Real peer-delegation E2E failed; sanitized evidence: ${relative(repositoryRoot, evidencePath)}`,
	);
}
if (validated.kind === 'diagnostic' || validated.outcome !== 'pass') {
	throw new Error(
		`Real peer-delegation E2E remains unverified; sanitized evidence: ${relative(repositoryRoot, evidencePath)}`,
	);
}
console.log(JSON.stringify({
	outcome: validated.outcome,
	evidence: relative(repositoryRoot, evidencePath),
	summary: relative(repositoryRoot, summaryPath),
	ac5PassCount: 'ac5' in validated
		? validated.ac5.filter(({ status }) => status === 'pass').length
		: 0,
	cleanup: 'cleanup' in validated ? validated.cleanup.status : 'failed',
}));

async function persistEvidenceArtifact(rawEvidence) {
	if (testMode && !testEvidencePersistenceAllowed) {
		throw new Error('Internal test evidence isolation failed; no artifact was written.');
	}
	if (testMode) {
		await assertSafeTestEvidenceDestination();
	} else {
		await revalidateEvidenceDestination();
	}
	await mkdir(evidenceRoot, { recursive: true });
	if (testMode) {
		let validationError;
		try {
			parsePeerDelegationEvidence(rawEvidence);
		} catch (error) {
			validationError = error;
		}
		const diagnostic = createPeerDelegationTestDiagnosticEvidence({
			runId,
			gitCommit: /^[a-f0-9]{40}$/u.test(rawEvidence.gitCommit)
				? rawEvidence.gitCommit
				: '0000000000000000000000000000000000000000',
			startedAt: new Date(startedAtMs).toISOString(),
			finishedAt: new Date().toISOString(),
			durationMs: Math.max(0, Date.now() - startedAtMs),
			platform: {
				os: process.platform,
				architecture: process.arch,
			},
			simulation: {
				...optionalTestSimulationString('TEST_PLATFORM', 'os'),
				...optionalTestSimulationString('TEST_ARCHITECTURE', 'architecture'),
				dirtyTree: testDirtyTree,
			},
			failureCode: diagnosticFailureCode(rawEvidence),
			validationFailed: validationError !== undefined,
		});
		await writeJsonAtomic(evidencePath, diagnostic);
		await writeTextAtomic(summaryPath, renderDiagnosticSummary(diagnostic));
		return {
			artifact: diagnostic,
			validationError: validationError
				?? Object.assign(
					new Error('Internal test-mode diagnostics are not release evidence.'),
					{ code: 'TEST_MODE_NOT_RELEASE_EVIDENCE' },
				),
		};
	}
	let releaseEligibilityError;
	try {
		assertReleaseEvidenceTree(rawEvidence.gitCommit);
	} catch (error) {
		releaseEligibilityError = error;
	}
	const diagnostic = createPeerDelegationDiagnosticEvidence({
		runId,
		gitCommit: /^[a-f0-9]{40}$/u.test(rawEvidence.gitCommit)
			? rawEvidence.gitCommit
			: '0000000000000000000000000000000000000000',
		startedAt: new Date(startedAtMs).toISOString(),
		finishedAt: new Date().toISOString(),
		durationMs: Math.max(0, Date.now() - startedAtMs),
		failureCode: releaseEligibilityError === undefined
			? diagnosticFailureCode(rawEvidence)
			: safeFailure(releaseEligibilityError).code,
	});
	await writeJsonAtomic(evidencePath, diagnostic);
	await writeTextAtomic(summaryPath, renderDiagnosticSummary(diagnostic));
	if (releaseEligibilityError !== undefined) {
		return { artifact: diagnostic, validationError: releaseEligibilityError };
	}
	try {
		const parsed = parsePeerDelegationEvidence(rawEvidence);
		let evidenceTemporary;
		let summaryTemporary;
		try {
			evidenceTemporary = await writeJsonTemporary(evidencePath, parsed);
			summaryTemporary = await writeTextTemporary(
				summaryPath,
				renderSummary(parsed),
			);
			assertReleaseEvidenceTree(parsed.gitCommit);
			await installEvidenceTemporary(summaryTemporary, summaryPath);
			summaryTemporary = undefined;
			assertReleaseEvidenceTree(parsed.gitCommit);
			await installEvidenceTemporary(evidenceTemporary, evidencePath);
			evidenceTemporary = undefined;
			assertReleaseEvidenceTree(parsed.gitCommit);
		} catch (error) {
			await Promise.all([
				removeOptionalTemporary(evidenceTemporary),
				removeOptionalTemporary(summaryTemporary),
			]);
			await writeJsonAtomic(evidencePath, diagnostic);
			await writeTextAtomic(summaryPath, renderDiagnosticSummary(diagnostic));
			return { artifact: diagnostic, validationError: error };
		}
		return { artifact: parsed, validationError: undefined };
	} catch (validationError) {
		return { artifact: diagnostic, validationError };
	}

	function optionalTestSimulationString(environmentSuffix, field) {
		const value = process.env[`${environmentPrefix}_${environmentSuffix}`];
		return typeof value === 'string' && value.length > 0 && value.length <= 32
			? { [field]: value }
			: {};
	}
}

async function writeJsonAtomic(path, value) {
	const temporary = await writeJsonTemporary(path, value);
	try {
		await installEvidenceTemporary(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function writeTextAtomic(path, value) {
	const temporary = await writeTextTemporary(path, value);
	try {
		await installEvidenceTemporary(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function writeTextTemporary(path, value) {
	await assertEvidenceWritePath(path);
	const temporary = `${path}.${process.pid}.${runLabel}.${randomUUID()}.tmp`;
	await revalidateEvidenceDestination([basename(path), basename(temporary)]);
	await writeFile(temporary, value, {
		encoding: 'utf8',
		mode: 0o600,
		flag: 'wx',
	});
	return temporary;
}

async function writeJsonTemporary(path, value) {
	await assertEvidenceWritePath(path);
	const temporary = `${path}.${process.pid}.${runLabel}.${randomUUID()}.tmp`;
	await revalidateEvidenceDestination([basename(path), basename(temporary)]);
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: 'utf8',
		mode: 0o600,
		flag: 'wx',
	});
	return temporary;
}

async function installEvidenceTemporary(temporary, destination) {
	await assertEvidenceWritePath(destination);
	if (dirname(temporary) !== evidenceRoot) {
		throw new Error('The peer-delegation evidence temporary escaped its directory.');
	}
	await revalidateEvidenceDestination([
		basename(destination),
		basename(temporary),
	]);
	await rename(temporary, destination);
}

async function assertEvidenceWritePath(path) {
	if (dirname(path) !== evidenceRoot) {
		throw new Error('The peer-delegation evidence write escaped its directory.');
	}
	await revalidateEvidenceDestination([basename(path)]);
}

function removeOptionalTemporary(path) {
	return path === undefined ? Promise.resolve() : rm(path, { force: true });
}

function assertReleaseEvidenceTree(expectedCommit) {
	const statusBefore = runGit(['status', '--porcelain=v1', '--untracked-files=all']);
	const headBefore = runGit(['rev-parse', 'HEAD']);
	const statusAfter = runGit(['status', '--porcelain=v1', '--untracked-files=all']);
	const headAfter = runGit(['rev-parse', 'HEAD']);
	assertCleanCommittedReleaseSnapshot({
		expectedCommit,
		headBefore,
		headAfter,
		statusBefore,
		statusAfter,
	});
}

function diagnosticFailureCode(rawEvidence) {
	for (const code of [
		rawEvidence.failure?.code,
		rawEvidence.blocker?.code,
	]) {
		if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code)) {
			return code;
		}
	}
	return 'EVIDENCE_INVALID';
}

function renderDiagnosticSummary(diagnostic) {
	const detail = diagnostic.kind === 'test-diagnostic'
		? 'Internal fixture diagnostic; release validators reject this artifact.'
		: 'Strict evidence validation failed; unsafe details were discarded.';
	return [
		'# Peer Delegation E2E diagnostic',
		'',
		'- Outcome: **fail**',
		`- Run: \`${diagnostic.runId}\``,
		`- Commit: \`${diagnostic.gitCommit}\``,
		`- Code: \`${diagnostic.failure.code}\``,
		`- ${detail}`,
		'',
	].join('\n');
}

function injectInvalidEvidenceForTest(rawEvidence) {
	if (!testMode) {
		return;
	}
	const injection = process.env[`${environmentPrefix}_TEST_INVALID_EVIDENCE`];
	if (injection === 'schema') {
		rawEvidence.needsInput.terminalState = 'running';
		return;
	}
	if (injection === 'safety') {
		rawEvidence.failure ??= {
			code: 'EVIDENCE_INVALID',
			message: 'Injected evidence safety failure.',
		};
		rawEvidence.failure.message = '/Users/injected/private-evidence';
	}
}

async function preflight() {
	await assertUsablePaths();
	const head = runGit(['rev-parse', 'HEAD']);
	const status = runGit(['status', '--porcelain=v1', '--untracked-files=all']);
	testDirtyTree = status.length !== 0
		|| process.env[`${environmentPrefix}_TEST_DIRTY_TREE`] === '1';
	if (!testMode && status.length !== 0) {
		throw Object.assign(
			new Error('The peer-delegation E2E requires a clean committed tree.'),
			{ code: 'WORKTREE_DIRTY' },
		);
	}
	const submodule = runGit(['-C', 'third_party/agent-host-protocol', 'rev-parse', 'HEAD']);
	assert.equal(submodule, 'f19dd8b3942d029744a3bdd31d830f9428e8ea47');
	const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
	assert.equal(manifest.version, '0.4.0');
	evidence.gitCommit = head;
}

async function acquireProfileLock() {
	await mkdir(profileBase, { recursive: true });
	try {
		await mkdir(profileLockDirectory);
		profileLockOwned = true;
		await writeFile(profileLockOwnerPath, `${runId}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		});
	} catch (error) {
		if (profileLockOwned) {
			await rm(profileLockDirectory, { recursive: true, force: true });
			profileLockOwned = false;
		}
		if (error?.code === 'EEXIST') {
			throw Object.assign(
				new Error('The dedicated peer-delegation E2E profile is already locked.'),
				{ code: 'PROFILE_LOCKED' },
			);
		}
		throw error;
	}
}

function assertProfileIdle() {
	const users = readProcessTable().filter(({ pid, command }) =>
		pid !== process.pid
		&& command.includes('--user-data-dir')
		&& (
			command.includes(userDataDirectory)
			|| command.includes(canonicalUserDataDirectory)
		),
	);
	if (users.length > 0) {
		throw Object.assign(
			new Error('The dedicated peer-delegation E2E profile is already in use.'),
			{ code: 'PROFILE_IN_USE' },
		);
	}
}

async function releaseProfileLock() {
	if (!profileLockOwned) {
		return false;
	}
	const owner = await readFile(profileLockOwnerPath, 'utf8');
	if (owner.trim() !== runId) {
		throw new Error('The peer-delegation E2E profile lock ownership changed.');
	}
	await rm(profileLockDirectory, { recursive: true, force: false });
	profileLockOwned = false;
	return true;
}

async function prepareRun() {
	await revalidateEvidenceDestination([basename(attestationPath)]);
	await mkdir(evidenceRoot, { recursive: true });
	await revalidateEvidenceDestination([basename(attestationPath)]);
	await Promise.all([
		mkdir(join(userDataDirectory, 'User'), { recursive: true }),
		mkdir(extensionsDirectory, { recursive: true }),
		mkdir(controlRoot, { recursive: true }),
		mkdir(logsDirectory, { recursive: true }),
		mkdir(sourceWorkspacePath, { recursive: true }),
		mkdir(targetWorkspacePath, { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			join(sourceWorkspacePath, 'README.txt'),
			'Temporary non-sensitive peer-delegation source project.\n',
			'utf8',
		),
		writeFile(
			join(targetWorkspacePath, 'README.txt'),
			'Temporary non-sensitive peer-delegation target project.\n',
			'utf8',
		),
	]);
	const sentinel = [
		'#!/usr/bin/env node',
		`require('node:fs').writeFileSync(${JSON.stringify(sentinelInvocationPath)}, JSON.stringify({ invoked: true, pid: process.pid }));`,
		'process.exitCode = 97;',
		'',
	].join('\n');
	await writeFile(sentinelPath, sentinel, { encoding: 'utf8', mode: 0o700 });
	await chmod(sentinelPath, 0o700);
	sentinelDigest = createHash('sha256').update(sentinel).digest('hex');
	await revalidateEvidenceDestination([basename(attestationPath)]);
	await rm(attestationPath, { force: true });
}

async function writeSettings() {
	const resource = process.env[`${environmentPrefix}_AUTH_RESOURCE`];
	const provider = process.env[`${environmentPrefix}_AUTH_PROVIDER`];
	const scopes = parseStringArray(process.env[`${environmentPrefix}_AUTH_SCOPES_JSON`]);
	const mappings = resource && provider
		? { [resource]: { providerId: provider, scopes } }
		: {};
	await writeFile(
		join(userDataDirectory, 'User', 'settings.json'),
		`${JSON.stringify({
			'copilotAgentMesh.deviceName': 'P8 Peer Delegation E2E',
			'copilotAgentMesh.codePath': codeCliPath,
			'copilotAgentMesh.experimental.agentHost': true,
			'copilotAgentMesh.experimental.peerDelegation': true,
			'copilotAgentMesh.experimental.authenticationProviders': mappings,
			'copilotAgentMesh.agentHost.userDataDir': userDataDirectory,
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

async function launchAndDiscover(workspacePath) {
	const launchedAt = Date.now();
	const opener = [...activeControllers.values()][0];
	if (opener === undefined) {
		launchWindow(workspacePath);
	} else {
		await request(opener, 'window.open', { workspacePath }, 10_000);
		windowOpenRecords.push({ workspacePath });
	}
	const controller = await waitForController(workspacePath, launchedAt, 60_000);
	await request(controller, 'controller.state');
	refreshOwnedProcesses();
	return controller;
}

function launchWindow(workspacePath) {
	const args = [
		workspacePath,
		`--user-data-dir=${userDataDirectory}`,
		`--extensions-dir=${extensionsDirectory}`,
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
	const logPath = join(logsDirectory, `${basename(workspacePath)}.log`);
	const output = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
	const environment = { ...process.env };
	for (const name of [
		'MESH_TWO_DEVICE_E2E',
		'MESH_MULTI_WINDOW_E2E',
		'MESH_TWO_DEVICE_E2E_NONCE',
		'MESH_MULTI_WINDOW_E2E_NONCE',
	]) {
		delete environment[name];
	}
	environment[environmentPrefix] = '1';
	environment[`${environmentPrefix}_CONTROL_DIR`] = controlRoot;
	environment[`${environmentPrefix}_NONCE`] = nonce;
	environment[`${environmentPrefix}_BUDGET_MS`] = String(budgetMs);
	const child = spawn(vscodeExecutablePath, args, {
		env: environment,
		shell: false,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (child.pid === undefined) {
		throw new Error('VS Code did not expose a child PID for the peer E2E.');
	}
	startOwnershipSampler();
	child.stdout.pipe(output, { end: false });
	child.stderr.pipe(output, { end: false });
	const record = { child, output, logPath, exit: undefined };
	child.once('error', (error) => {
		record.exit = { error: error.message };
	});
	child.once('exit', (code, signal) => {
		record.exit = { code, signal };
	});
	launchRecords.push(record);
	refreshOwnedProcesses();
}

async function waitForController(workspacePath, launchedAt, timeoutMs) {
	const workspaceBasename = basename(workspacePath);
	const workspaceKey = multiWindowWorkspaceKey(workspaceBasename);
	const workspaceControlRoot = join(controlRoot, 'windows', workspaceKey);
	const deadline = Date.now() + timeoutMs;
	let lastFailure;
	let lastDiagnostic;
	while (Date.now() < deadline) {
		for (const windowId of await readdir(workspaceControlRoot).catch(() => [])) {
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
					|| ready.nodeInstanceId !== windowId
				) {
					continue;
				}
				const controller = { ...ready, controlDirectory };
				await request(controller, 'controller.state', {}, 2_000);
				return controller;
			} catch (error) {
				if (error?.code !== 'ENOENT') {
					lastFailure = error;
				}
			}
			try {
				lastDiagnostic = await readMultiWindowStartupDiagnostic(
					join(controlDirectory, 'startup-failure.json'),
					{ workspaceKey, windowId, launchedAt },
				);
			} catch (error) {
				if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
					lastFailure = new Error('A peer E2E startup diagnostic was invalid.');
				}
			}
		}
		const launch = launchRecords.at(-1);
		if (launch?.exit?.error) {
			throw new Error(`VS Code failed to launch the peer E2E: ${launch.exit.error}`);
		}
		await delay(50);
	}
	throw new Error(
		`Timed out waiting for ${workspaceBasename}.`
		+ (lastDiagnostic === undefined
			? ''
			: ` Startup diagnostic: ${lastDiagnostic.code}: ${lastDiagnostic.message}`)
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
		throw new Error(`The ${action} E2E response envelope was invalid.`);
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

async function invokeMeshTool(controller, toolName, input, timeoutMs = 15 * 60_000) {
	return request(controller, 'peer.tool.invoke', { toolName, input }, timeoutMs);
}

async function invokeCoreTool(controller, toolName, input, timeoutMs = 15 * 60_000) {
	return request(controller, 'peer.core.invoke', { toolName, input }, timeoutMs);
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
			// Broker ownership startup may briefly interrupt the route.
		}
		await delay(50);
	} while (Date.now() < deadline);
	throw new Error(`${message}; last state was ${JSON.stringify(latest?.broker ?? latest)}.`);
}

async function waitForDashboard(controller, predicate, timeoutMs, message) {
	const deadline = Date.now() + timeoutMs;
	let latest;
	do {
		try {
			latest = await request(controller, 'peer.dashboard.snapshot', {}, 3_000);
			if (predicate(latest)) {
				return latest;
			}
		} catch {
			// The local IPC route can briefly reconnect during startup.
		}
		await delay(50);
	} while (Date.now() < deadline);
	throw new Error(`${message}; last dashboard was unavailable or did not match.`);
}

async function recordCompletionScenario({
	source,
	target,
	targetInputBase,
	catalogBeforeCount,
}) {
	const completionStarted = Date.now();
	const completionRun = manualUi
		? await waitForManualCompletion(source, targetInputBase)
		: await runProgrammaticCoreCompletion(source, targetInputBase);
	const completionResult = completionRun.result;
	const completionTaskId = requiredUuid(completionResult.t, 'completion taskId');
	const parentResultFields = completionRun.parentResultObservation?.resultFields
		?? Object.keys(completionResult).sort();
	const serializedParentResult = JSON.stringify(completionResult);
	const parentResultBytes = completionRun.parentResultObservation?.resultBytes
		?? Buffer.byteLength(serializedParentResult, 'utf8');
	const parentResultHash = completionRun.parentResultObservation?.resultHash?.slice(0, 16)
		?? shortHash('parent-result', serializedParentResult);
	const parentResultValid = parentResultFields.join(',') === 'd,r,s,t'
		&& parentResultBytes > 0
		&& parentResultHash.length === 16;
	const completionTask = await request(source, 'peer.task.evidence', {
		taskId: completionTaskId,
	});
	const completionObservations = await request(target, 'peer.observations');
	const turnCompleteObserved = completionObservations.ahp.some(
		(observation) =>
			observation.taskId === completionTaskId
			&& observation.eventType === 'chat/turnComplete',
	);
	const authoritativeOrder = ordered(
		completionTask.eventTypes,
		['agentStarted', 'output', 'completed'],
	);
	const incoming = await request(target, 'peer.dashboard.snapshot');
	const incomingRecord = incoming.incomingTasks?.some(
		(task) => task.shortId === completionTaskId.slice(0, 8),
	) === true;
	const runtimeStatus = await request(target, 'peer.runtime.status', {}, 60_000);
	const sourceKind = runtimeStatus.status?.source === 'editor'
		? 'editor'
		: runtimeStatus.status?.source === 'standalone'
			? 'standalone'
			: 'unavailable';
	const degraded = runtimeStatus.status?.degraded === true;
	const sourceFailure = runtimeStatus.status?.failure;
	const catalogAfter = await request(target, 'peer.session.catalog', {}, 60_000);
	const sessionHashMatched = catalogAfter.available === true
		&& typeof completionTask.recoverySessionHash === 'string'
		&& catalogAfter.sessionHashes.includes(completionTask.recoverySessionHash);
	const editorSessionObserved = sourceKind === 'editor'
		&& !degraded
		&& sourceFailure === undefined
		&& sessionHashMatched;
	const completed = completionResult.s === 0;
	const completionPass = completed
		&& authoritativeOrder
		&& turnCompleteObserved
		&& parentResultValid
		&& completionTask.outputCount > 0
		&& completionTask.outputBytes > 0
		&& typeof completionTask.outputHash === 'string'
		&& incomingRecord
		&& completionTask.leaseReleased
		&& editorSessionObserved;
	evidence.confirmation = completionRun.confirmation;
	evidence.completion = {
		status: completionPass ? 'pass' : 'unverified',
		taskId: completionTaskId,
		parentResultTaskId: completionTaskId,
		parentSameInvocation: true,
		parentResultFields,
		parentResultBytes,
		parentResultHash,
		invocationSource: completionRun.invocationSource,
		...(Number.isSafeInteger(completionResult.s)
			? { compactStatus: completionResult.s }
			: {}),
		eventTypes: completionTask.eventTypes,
		eventSequences: completionTask.eventSequences,
		authoritativeOrder,
		ahpTurnCompleteObserved: turnCompleteObserved,
		output: {
			count: completionTask.outputCount,
			bytes: completionTask.outputBytes,
			...(completionTask.outputHash === undefined ? {} : { hash: completionTask.outputHash }),
		},
		incomingRecord,
		source: sourceKind,
		degraded,
		leaseReleased: completionTask.leaseReleased,
		durationMs: Date.now() - completionStarted,
	};
	evidence.experiments[1] = {
		id: 'O2',
		status: 'unverified',
		conclusion: 'shorter-duration-only',
		observedDurationMs: evidence.completion.durationMs,
	};
	setAc5(
		5,
		evidence.confirmation.status,
		evidence.confirmation.status === 'pass' ? ['#/confirmation'] : [],
	);
	setAc5(6, completionPass ? 'pass' : 'unverified', completionPass
		? ['#/completion/eventTypes', '#/completion/ahpTurnCompleteObserved']
		: []);
	const parentChatResultVerified = parentResultValid
		&& completionRun.invocationSource === 'copilot-ui';
	setAc5(7, parentChatResultVerified ? 'pass' : 'unverified', parentChatResultVerified
		? ['#/completion/parentSameInvocation', '#/completion/parentResultTaskId']
		: []);
	setAc5(
		8,
		incomingRecord ? 'pass' : 'unverified',
		incomingRecord ? ['#/completion/incomingRecord'] : [],
	);
	setAc5(9, editorSessionObserved ? 'pass' : 'unverified', editorSessionObserved
		? ['#/completion/source', '#/sessionVisibility/sessionHashMatched']
		: []);

	const uiObserved = completionRun.uiAttestation?.targetSessionVisible === true;
	evidence.sessionVisibility = {
		status: sourceKind === 'editor' && sessionHashMatched && uiObserved
			? 'pass'
			: 'unverified',
		source: sourceKind,
		catalogBefore: catalogBeforeCount,
		catalogAfter: catalogAfter.available ? catalogAfter.sessionCount : 0,
		sessionHashMatched,
		uiObserved,
	};
	evidence.experiments[0] = {
		id: 'O1',
		status: evidence.sessionVisibility.status,
		conclusion: evidence.sessionVisibility.status === 'pass'
			? 'editor-session-visible'
			: 'unverified',
	};
	if (evidence.sessionVisibility.status === 'pass') {
		removeLimitation('TARGET_CHAT_SESSIONS_UI_UNVERIFIED');
	}
	if (!completed) {
		const code = typeof completionResult.e === 'string'
			&& /^[A-Z][A-Z0-9_]{0,127}$/u.test(completionResult.e)
			? completionResult.e
			: 'REAL_AGENT_COMPLETION_REQUIRED';
		evidence.blocker = {
			code,
			message: code === 'AGENT_AUTH_REQUIRED'
				? sourceKind === 'editor'
					? 'Authenticate the Agent Host in the selected editor profile before retrying.'
					: 'The selected real E2E profile has no usable standalone Agent Host authentication session.'
				: 'The real Agent task did not reach authoritative completion.',
		};
		return false;
	}
	if (!manualUi) {
		evidence.blocker = {
			code: 'COPILOT_UI_REQUIRED',
			message: 'A visible Copilot Agent-mode Tool invocation and one user confirmation are required.',
		};
	}
	return true;
}

async function runProgrammaticCoreCompletion(source, targetInputBase) {
	const delegationRequestId = randomUUID();
	const result = await invokeCoreTool(source, 'mesh_delegate_task', {
		...targetInputBase,
		delegationRequestId,
		title: `P8 E2E completion ${runLabel}`,
		prompt: 'Return one short non-empty acknowledgement. Do not use tools and do not modify files.',
		acceptanceCriteria: ['Return a non-empty response without modifying either temporary project.'],
		timeoutMinutes: 60,
	});
	return {
		result,
		parentResultObservation: undefined,
		invocationSource: 'programmatic-core',
		confirmation: {
			status: 'unverified',
			preparedCount: 0,
			acceptedCount: 0,
			source: 'programmatic',
			operatorAttested: false,
		},
		uiAttestation: {
			confirmationAcceptedOnce: false,
			targetSessionVisible: false,
		},
	};
}

async function waitForManualCompletion(source, targetInputBase) {
	const delegationRequestId = randomUUID();
	const title = `P8 E2E completion ${runLabel}`;
	const prompt = [
		`In Agent mode, use #meshListWorkers and then #meshDelegateTask to delegate to "${targetWindowLabel}".`,
		`Use delegationRequestId ${delegationRequestId}.`,
		`Use the title "${title}".`,
		'The child prompt must request one short non-empty acknowledgement, no tools, and no file changes.',
		'Use timeoutMinutes 60. Accept the single Continue confirmation exactly once.',
	].join(' ');
	console.log(JSON.stringify({
		manualActionRequired: true,
		runId,
		sourceWindowLabel,
		targetWindowLabel,
		prompt,
		attestationCommand: `node scripts/e2e/peer-delegation/attest.mjs ${runId} confirmation-once session-visible`,
	}));
	const deadline = Date.now() + 15 * 60_000;
	while (Date.now() < deadline) {
		const observations = await request(source, 'peer.observations');
		const matching = observations.tools.filter(
			(observation) => observation.delegationRequestId === delegationRequestId,
		);
		const preparedCount = matching.filter(({ phase }) => phase === 'prepared').length;
		const acceptedCount = matching.filter(({ phase }) => phase === 'invokeStarted').length;
		const completed = matching.find(({ phase }) => phase === 'invokeCompleted');
		if (completed !== undefined) {
			if (
				preparedCount !== 1
				|| acceptedCount !== 1
				|| completed.compactStatus !== 0
				|| typeof completed.taskId !== 'string'
			) {
				throw new Error('The manual Copilot Tool route did not produce one confirmed completion.');
			}
			const uiAttestation = await readUiAttestation();
			return {
				result: {
					s: completed.compactStatus,
					t: completed.taskId,
					d: delegationRequestId,
				},
				parentResultObservation: {
					resultFields: completed.resultFields,
					resultBytes: completed.resultBytes,
					resultHash: completed.resultHash,
				},
				invocationSource: 'copilot-ui',
				confirmation: {
					status: uiAttestation.confirmationAcceptedOnce ? 'pass' : 'unverified',
					preparedCount,
					acceptedCount,
					source: 'copilot-ui',
					operatorAttested: uiAttestation.confirmationAcceptedOnce,
				},
				uiAttestation,
			};
		}
		await delay(250);
	}
	throw new Error('Timed out waiting for the manual Copilot sidebar delegation.');
}

async function runNeedsInputScenario(source, targetInputBase) {
	const result = await invokeCoreTool(source, 'mesh_delegate_task', {
		...targetInputBase,
		delegationRequestId: randomUUID(),
		title: `P8 E2E needs input ${runLabel}`,
		prompt: [
			'Use the terminal tool to run the safe command: printf P8_INPUT_OK.',
			'Do not modify files. Do not complete until the terminal tool succeeds.',
		].join(' '),
		acceptanceCriteria: ['The safe terminal command is attempted and its confirmation is handled.'],
		timeoutMinutes: 60,
	});
	if (
		result.s !== 1
		|| typeof result.t !== 'string'
		|| typeof result.i !== 'string'
		|| typeof result.q !== 'string'
		|| result.q.length === 0
	) {
		const task = typeof result.t === 'string'
			? await request(source, 'peer.task.evidence', { taskId: result.t }).catch(() => undefined)
			: undefined;
		evidence.needsInput = {
			status: 'unverified',
			...(typeof result.t === 'string' ? { taskId: result.t } : {}),
			...(Number.isSafeInteger(result.s) ? { compactStatus: result.s } : {}),
			questionPresent: false,
			eventTypes: task?.eventTypes ?? [],
			answerTaskIdMatched: false,
			answerInputIdMatched: false,
			resumed: false,
			terminalState: normalizePeerDelegationEvidenceTerminalState(task?.state),
			leaseReleased: task?.leaseReleased === true,
		};
		return;
	}
	const answer = await invokeCoreTool(source, 'mesh_answer_task', {
		taskId: result.t,
		inputId: result.i,
		answerId: randomUUID(),
		answer: 'approve',
	});
	const terminal = await waitForTaskTerminal(source, result.t, 5 * 60_000);
	const resumed = terminal.eventTypes.includes('inputAnswered');
	const passed = answer.status === 'ok'
		&& answer.taskId === result.t
		&& resumed
		&& terminal.state === 'completed';
	evidence.needsInput = {
		status: passed ? 'pass' : 'fail',
		taskId: result.t,
		compactStatus: result.s,
		inputId: result.i,
		questionPresent: true,
		eventTypes: terminal.eventTypes,
		answerTaskIdMatched: answer.taskId === result.t,
		answerInputIdMatched: true,
		resumed,
		terminalState: normalizePeerDelegationEvidenceTerminalState(terminal.state),
		leaseReleased: terminal.leaseReleased,
	};
	if (passed) {
		removeLimitation('REAL_NEEDS_INPUT_UNVERIFIED');
	}
}

async function runCancellationScenario(source, targetInputBase) {
	const input = {
		...targetInputBase,
		delegationRequestId: randomUUID(),
		title: `P8 E2E cancellation ${runLabel}`,
		prompt: [
			'Produce a long response with at least 500 short numbered observations.',
			'Do not use tools and do not modify files. Continue until cancelled.',
		].join(' '),
		acceptanceCriteria: ['Emit non-empty output and remain active long enough to be cancelled.'],
		timeoutMinutes: 60,
	};
	const invocation = await request(
		source,
		'peer.core.cancel.after.events',
		{ input },
		10 * 60_000,
	);
	const taskId = requiredUuid(invocation.taskId, 'cancellation taskId');
	const task = await request(source, 'peer.task.evidence', { taskId });
	const passed = invocation.cancellationTokenTriggered === true
		&& invocation.compactStatus === 3
		&& invocation.cancellationReason === 'token'
		&& task.state === 'cancelled'
		&& task.leaseReleased
		&& task.eventTypes.includes('cancelRequested')
		&& task.eventTypes.includes('cancelConfirmed');
	evidence.cancellation = {
		status: passed ? 'pass' : 'fail',
		taskId,
		compactStatus: Number.isSafeInteger(invocation.compactStatus)
			? invocation.compactStatus
			: undefined,
		reason: invocation.cancellationReason === 'token' ? 'token' : 'not-observed',
		eventTypes: task.eventTypes,
		terminalState: normalizePeerDelegationEvidenceTerminalState(task.state),
		leaseReleased: task.leaseReleased,
	};
}

async function runTimeoutScenario(source, targetInputBase) {
	await request(source, 'peer.budget.arm');
	const result = await invokeCoreTool(source, 'mesh_delegate_task', {
		...targetInputBase,
		delegationRequestId: randomUUID(),
		title: `P8 E2E short budget ${runLabel}`,
		prompt: [
			'Produce a long response with at least 1000 short numbered observations.',
			'Do not use tools and do not modify files. Continue until the task budget cancels the turn.',
		].join(' '),
		acceptanceCriteria: ['The short E2E-only budget causes authoritative cancellation.'],
		timeoutMinutes: 1,
	});
	const taskId = requiredUuid(result.t, 'timeout taskId');
	const task = await request(source, 'peer.task.evidence', { taskId });
	const passed = result.s === 3
		&& result.x === 'budget'
		&& (task.state === 'cancelled' || task.state === 'failed')
		&& task.leaseReleased;
	evidence.timeout = {
		status: passed ? 'pass' : 'fail',
		taskId,
		compactStatus: Number.isSafeInteger(result.s) ? result.s : undefined,
		reason: result.x === 'budget' ? 'budget' : 'not-observed',
		budgetMs,
		productionDefaultMinutes: 60,
		productionMaximumMinutes: 60,
		eventTypes: task.eventTypes,
		terminalState: normalizePeerDelegationEvidenceTerminalState(task.state),
		leaseReleased: task.leaseReleased,
	};
}

async function waitForTaskTerminal(source, taskId, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let latest;
	do {
		latest = await request(source, 'peer.task.evidence', { taskId });
		if (['completed', 'failed', 'cancelled', 'timedOut'].includes(latest.state)) {
			return latest;
		}
		await delay(100);
	} while (Date.now() < deadline);
	throw new Error(`Task ${taskId} did not become terminal.`);
}

async function readUiAttestation() {
	const deadline = Date.now() + 5 * 60_000;
	while (Date.now() < deadline) {
		try {
			await revalidateEvidenceDestination([basename(attestationPath)]);
			const value = JSON.parse(await readFile(attestationPath, 'utf8'));
			if (
				value.schemaVersion === 1
				&& value.runId === runId
				&& typeof value.confirmationAcceptedOnce === 'boolean'
				&& typeof value.targetSessionVisible === 'boolean'
			) {
				return {
					confirmationAcceptedOnce: value.confirmationAcceptedOnce,
					targetSessionVisible: value.targetSessionVisible,
				};
			}
		} catch (error) {
			if (error?.code !== 'ENOENT') {
				throw error;
			}
		}
		await delay(250);
	}
	return {
		confirmationAcceptedOnce: false,
		targetSessionVisible: false,
	};
}

function requireDashboardNode(snapshot, nodeId) {
	const matches = snapshot.localNodes?.filter((node) => node.nodeId === nodeId) ?? [];
	assert.equal(matches.length, 1, 'The expected Dashboard Window Node was absent or duplicated.');
	return matches[0];
}

function requireClaimedWorkspace(node) {
	const matches = node.workspaces.filter(({ claimStatus }) => claimStatus === 'claimed');
	assert.equal(matches.length, 1, 'The target did not have exactly one claimed Workspace.');
	return matches[0];
}

function toolDirectoryContains(result, expectedNode) {
	return result.status === 'ok'
		&& result.devices?.some((device) =>
			device.nodes?.some((node) =>
				node.nodeId === expectedNode.nodeId
				&& node.nodeInstanceId === expectedNode.nodeInstanceId
			)
		) === true;
}

function ordered(values, required) {
	let index = -1;
	for (const value of required) {
		index = values.indexOf(value, index + 1);
		if (index < 0) {
			return false;
		}
	}
	return true;
}

function delta(baseline, final) {
	return { baseline, final, delta: final - baseline };
}

function assertAttemptMetricsZero(metrics) {
	assert.equal(metrics.listener.startAttempts, 0);
	assert.equal(metrics.tunnel.loadAttempts, 0);
	assert.equal(metrics.tunnel.probeAttempts, 0);
	assert.equal(metrics.tunnel.ensureHostedAttempts, 0);
}

async function assertProjectUnchanged(workspacePath) {
	const names = (await readdir(workspacePath)).sort();
	assert.deepEqual(names, ['README.txt']);
	const expected = workspacePath === sourceWorkspacePath
		? 'Temporary non-sensitive peer-delegation source project.\n'
		: 'Temporary non-sensitive peer-delegation target project.\n';
	assert.equal(await readFile(join(workspacePath, 'README.txt'), 'utf8'), expected);
}

function readProcessTable() {
	const result = spawnSync(
		'ps',
		['-axo', 'pid=,ppid=,pgid=,command='],
		{ encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
	);
	if (result.status !== 0) {
		throw new Error('Unable to inspect exact peer-delegation E2E process ownership.');
	}
	return parseProcessTable(result.stdout);
}

function currentOwnedProcesses() {
	const owned = processTracker.select(readProcessTable());
	maximumOwnedProcessCount = Math.max(maximumOwnedProcessCount, owned.length);
	ownedPeaks.vscode = Math.max(
		ownedPeaks.vscode,
		owned.filter(isVscodeProcess).length,
	);
	ownedPeaks.agentHost = Math.max(
		ownedPeaks.agentHost,
		owned.filter(isAgentHostProcess).length,
	);
	ownedPeaks.tunnel = Math.max(
		ownedPeaks.tunnel,
		owned.filter(isDevTunnelProcess).length,
	);
	return owned;
}

function refreshOwnedProcesses() {
	currentOwnedProcesses();
}

function startOwnershipSampler() {
	if (ownershipSampler !== undefined) {
		return;
	}
	ownershipSamplerStarted = true;
	ownershipSampler = setInterval(() => {
		try {
			currentOwnedProcesses();
		} catch (error) {
			ownershipSamplerFailure ??= error;
		}
	}, 100);
	ownershipSampler.unref?.();
}

function stopOwnershipSampler() {
	if (ownershipSampler !== undefined) {
		clearInterval(ownershipSampler);
		ownershipSampler = undefined;
	}
	if (ownershipSamplerFailure !== undefined) {
		throw ownershipSamplerFailure;
	}
}

function isVscodeProcess(processInfo) {
	return /(?:Visual Studio Code|Code Helper|Electron)(?:\s|$)/u.test(processInfo.command)
		|| processInfo.command.includes('--extensionDevelopmentPath');
}

function isAgentHostProcess(processInfo) {
	return /\sagent\s+host(?:\s|$)/u.test(processInfo.command);
}

function isDevTunnelProcess(processInfo) {
	return processInfo.command.includes(sentinelPath);
}

async function waitForNoOwnedProcesses(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	do {
		if (currentOwnedProcesses().length === 0) {
			return;
		}
		await delay(100);
	} while (Date.now() < deadline);
	throw new Error('Harness-owned VS Code or Agent Host processes did not exit.');
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
	if (testTerminationLogPath !== undefined) {
		appendFileSync(testTerminationLogPath, `${pid}:${signal}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		});
	}
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

function performCleanup() {
	cleanupOperation ??= performCleanupOnce();
	return cleanupOperation;
}

async function performCleanupOnce() {
	let finalOwned;
	let localIpcRemoved = localIpcEndpoint === undefined
		|| localIpcEndpoint.platform === 'win32';
	let editorEndpointReleased = codeCliPath === undefined;
	let sentinelInvoked = false;
	let sentinelUnchanged = sentinelDigest === undefined;
	let profileLockReleased = false;
	let runtimeRemoved = false;
	const cleanupFailures = await runPeerDelegationCleanupPhases([
		{
			name: 'snapshot-owned-processes',
			run: async () => {
				currentOwnedProcesses();
			},
		},
		{ name: 'stop-ownership-sampler', run: async () => stopOwnershipSampler() },
		{ name: 'close-controllers', run: closeControllers },
		{
			name: 'owned-processes',
			run: async () => {
				await waitForNoOwnedProcesses(15_000).catch(async () => {
					await terminateOwnedProcesses();
					await waitForNoOwnedProcesses(5_000);
				});
			},
		},
		{ name: 'close-logs', run: closeLogStreams },
		{
			name: 'save-logs',
			run: async () => {
				if (primaryFailure !== undefined) {
					await saveSanitizedLogs();
				}
			},
		},
		{
			name: 'observe-processes',
			run: async () => {
				finalOwned = currentOwnedProcesses();
			},
		},
		{
			name: 'observe-local-ipc',
			run: async () => {
				localIpcRemoved = localIpcEndpoint === undefined
					|| localIpcEndpoint.platform === 'win32'
					|| await isAbsent(localIpcEndpoint.address);
			},
		},
		{
			name: 'observe-editor-endpoint',
			run: async () => {
				editorEndpointReleased = codeCliPath === undefined
					|| await safeEditorEndpointCount(codeCliPath, userDataDirectory) === 0;
			},
		},
		{
			name: 'observe-sentinel',
			run: async () => {
				sentinelInvoked = !await isAbsent(sentinelInvocationPath);
				sentinelUnchanged = sentinelDigest === undefined
					|| createHash('sha256').update(await readFile(sentinelPath)).digest('hex') === sentinelDigest;
			},
		},
		{
			name: 'release-profile-lock',
			run: async () => {
				profileLockReleased = profileLockOwned
					? await releaseProfileLock()
					: await isAbsent(profileLockDirectory);
			},
		},
		{
			name: 'remove-run-root',
			run: () => rm(runRoot, { recursive: true, force: true }),
		},
		{
			name: 'verify-run-root',
			run: async () => {
				runtimeRemoved = await isAbsent(runRoot);
				if (!runtimeRemoved) {
					throw new Error('The exact peer-delegation E2E run root remains.');
				}
			},
		},
	]);
	const ownedProcessesReleased = finalOwned !== undefined && finalOwned.length === 0;
	const ownedSocketsReleased = localIpcRemoved && editorEndpointReleased;
	const ownedTimersReleased =
		(latestResourceMetrics?.toolTimers.activeTimers ?? 0) === 0
		&& ownershipSampler === undefined;
	const complete = cleanupFailures.length === 0
		&& profileLockReleased
		&& cleanupLeaseReleased
		&& localIpcRemoved
		&& editorEndpointReleased
		&& runtimeRemoved
		&& ownedProcessesReleased
		&& ownedSocketsReleased
		&& ownedTimersReleased
		&& sentinelUnchanged
		&& !sentinelInvoked;
	evidence.resources.vscode.ownedPeak = ownedPeaks.vscode;
	evidence.resources.agentHost.ownedPeak = ownedPeaks.agentHost;
	evidence.resources.tunnel.ownedPeak = ownedPeaks.tunnel;
	evidence.resources.socket.ownedPeak = localIpcEndpoint === undefined
		? 0
		: 1 + (evidence.completion.source === 'editor' ? 1 : 0);
	evidence.resources.timer.ownedPeak =
		(latestResourceMetrics?.toolTimers.timersCreated ?? 0)
		+ Number(ownershipSamplerStarted);
	evidence.resources.vscode.finalOwned = finalOwned?.filter(isVscodeProcess).length ?? 1;
	evidence.resources.agentHost.finalOwned = finalOwned?.filter(isAgentHostProcess).length ?? 1;
	evidence.resources.tunnel.finalOwned = finalOwned?.filter(isDevTunnelProcess).length ?? 1;
	evidence.resources.socket.finalOwned = Number(!localIpcRemoved) + Number(!editorEndpointReleased);
	evidence.resources.timer.finalOwned =
		(latestResourceMetrics?.toolTimers.activeTimers ?? 0)
		+ Number(ownershipSampler !== undefined);
	evidence.cleanup = {
		status: complete ? 'pass' : 'fail',
		profileLockReleased,
		workspaceLeaseReleased: cleanupLeaseReleased,
		localIpcRemoved,
		editorEndpointReleased,
		runtimeRemoved,
		ownedProcessesReleased,
		ownedSocketsReleased,
		ownedTimersReleased,
		complete,
	};
	setAc5(11, complete ? 'pass' : 'fail', complete ? ['#/cleanup'] : []);
	setAc5(12, complete ? 'pass' : 'fail', complete ? ['#/resources'] : []);
	return cleanupFailures;
}

async function cleanupAfterSignal(signal) {
	const exitCode = signal === 'SIGINT' ? 130 : 143;
	let cleanupFailures = [];
	try {
		cleanupFailures = await performCleanup();
	} catch {
		cleanupFailures = [{ phase: 'signal-primary-cleanup', error: new Error('Primary signal cleanup failed.') }];
	}
	try {
		if (cleanupFailures.length > 0) {
			await runPeerDelegationCleanupPhases([
			{ name: 'signal-owned-processes', run: terminateOwnedProcesses },
			{
				name: 'signal-verify-processes',
				run: () => waitForNoOwnedProcesses(5_000),
			},
			{
				name: 'signal-profile-lock',
				run: async () => {
					if (profileLockOwned) {
						await releaseProfileLock();
					}
				},
			},
			{
				name: 'signal-run-root',
				run: () => rm(runRoot, { recursive: true, force: true }),
			},
			{
				name: 'signal-verify-run-root',
				run: async () => {
					if (!await isAbsent(runRoot)) {
						throw new Error('The exact signal-cleanup run root remains.');
					}
				},
			},
			]);
		}
	} finally {
		process.exit(exitCode);
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
		const name = `${runId}-${basename(record.logPath)}`;
		await revalidateEvidenceDestination([name]);
		await writeTextAtomic(
			join(evidenceRoot, name),
			sanitize(raw),
		);
	}
}

async function safeEditorEndpointCount(executable, profile) {
	const result = spawnSync(
		executable,
		['agent', 'endpoints', '--user-data-dir', profile],
		{ encoding: 'utf8', maxBuffer: 1024 * 1024, shell: false },
	);
	if (result.status !== 0) {
		return -1;
	}
	try {
		const value = JSON.parse(result.stdout);
		return Array.isArray(value.endpoints)
			? value.endpoints.filter((endpoint) => endpoint?.type === 'editor').length
			: -1;
	} catch {
		return -1;
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

async function assertUsablePaths() {
	if (configuredRuntimeBase !== undefined && !isAbsolute(configuredRuntimeBase)) {
		throw new Error(`${environmentPrefix}_RUNTIME_DIR must be absolute.`);
	}
	if (runtimeBase === dirname(runtimeBase)) {
		throw new Error('The peer-delegation E2E runtime must not be a filesystem root.');
	}
	for (const root of ['/tmp', '/var/tmp', '/private/tmp']) {
		if (runtimeBase === root || runtimeBase.startsWith(`${root}${sep}`)) {
			throw new Error('The peer-delegation E2E runtime must not use a system temporary root.');
		}
	}
	if (persistentProfile) {
		if (!isAbsolute(configuredProfileBase) || profileBase === dirname(profileBase)) {
			throw new Error(`${environmentPrefix}_PROFILE_DIR must be an absolute non-root path.`);
		}
		if (
			profileBase === runtimeBase
			|| isWithin(runtimeBase, profileBase)
			|| isWithin(profileBase, runtimeBase)
		) {
			throw new Error('The persistent peer E2E profile must be outside the disposable runtime.');
		}
		for (const realProfile of realVscodeUserDataDirectories()) {
			if (
				profileBase === realProfile
				|| isWithin(realProfile, profileBase)
				|| isWithin(profileBase, realProfile)
			) {
				throw new Error('The dedicated peer E2E profile must not overlap a real VS Code profile.');
			}
		}
	}
	const canonicalRuntimeBase = await assertNoSymlinkAlias(runtimeBase, 'runtime base');
	const canonicalRunRoot = await assertNoSymlinkAlias(runRoot, 'run root');
	const canonicalProfileBase = await assertNoSymlinkAlias(profileBase, 'profile base');
	canonicalUserDataDirectory = await assertNoSymlinkAlias(
		userDataDirectory,
		'profile user-data directory',
	);
	if (
		canonicalRunRoot !== join(canonicalRuntimeBase, basename(runRoot))
		|| canonicalUserDataDirectory !== join(canonicalProfileBase, 'user-data')
	) {
		throw new Error('The peer-delegation E2E paths do not resolve beneath their owned roots.');
	}
	for (const realProfile of realVscodeUserDataDirectories()) {
		const canonicalRealProfile = await canonicalizePotentialPath(realProfile);
		if (
			canonicalProfileBase === canonicalRealProfile
			|| isWithin(canonicalRealProfile, canonicalProfileBase)
			|| isWithin(canonicalProfileBase, canonicalRealProfile)
			|| canonicalUserDataDirectory === canonicalRealProfile
			|| isWithin(canonicalRealProfile, canonicalUserDataDirectory)
			|| isWithin(canonicalUserDataDirectory, canonicalRealProfile)
		) {
			throw new Error('The canonical peer E2E profile must not overlap a real VS Code profile.');
		}
	}
	await assertSafeTestEvidenceDestination();
	const mainIpcPath = join(userDataDirectory, '1.13-main.sock');
	if (!testMode && Buffer.byteLength(mainIpcPath, 'utf8') > 103) {
		throw new Error('The selected peer E2E profile path exceeds the macOS socket limit.');
	}
}

async function assertSafeTestEvidenceDestination() {
	if (!testMode) {
		return;
	}
	try {
		await revalidateEvidenceDestination();
		await assertTestEvidenceIsolation();
		await assertNoSymlinkAlias(evidenceRoot, 'evidence directory');
	} catch (error) {
		testEvidencePersistenceAllowed = false;
		throw error;
	}
}

async function assertTestEvidenceIsolation() {
	if (!testMode) {
		return;
	}
	if (
		filesystemPathsOverlap(evidenceRoot, releaseEvidenceRoot)
		|| await pathsAliasSameEntry(evidenceRoot, releaseEvidenceRoot)
		|| await anyPathsAlias([
			evidencePath,
			summaryPath,
		], [
			join(releaseEvidenceRoot, 'evidence.json'),
			join(releaseEvidenceRoot, 'summary.md'),
		])
	) {
		testEvidencePersistenceAllowed = false;
		throw new Error('Internal test diagnostics must not alias the stable release evidence directory.');
	}
}

async function anyPathsAlias(leftPaths, rightPaths) {
	for (const left of leftPaths) {
		for (const right of rightPaths) {
			if (
				filesystemPathKey(left) === filesystemPathKey(right)
				|| await pathsAliasSameEntry(left, right)
			) {
				return true;
			}
		}
	}
	return false;
}

async function pathsAliasSameEntry(left, right) {
	if (filesystemPathKey(left) === filesystemPathKey(right)) {
		return true;
	}
	try {
		const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
		return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
	} catch (error) {
		if (error?.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

function filesystemPathKey(value) {
	const absolute = resolve(value);
	return process.platform === 'darwin' || process.platform === 'win32'
		? absolute.toLocaleLowerCase('en-US')
		: absolute;
}

function filesystemPathsOverlap(left, right) {
	const leftKey = filesystemPathKey(left);
	const rightKey = filesystemPathKey(right);
	return leftKey === rightKey
		|| leftKey.startsWith(`${rightKey}${sep}`)
		|| rightKey.startsWith(`${leftKey}${sep}`);
}

async function assertProfileMutationSafe() {
	const paths = [
		profileBase,
		userDataDirectory,
		join(userDataDirectory, 'User'),
		join(userDataDirectory, 'User', 'settings.json'),
		join(userDataDirectory, 'User', 'globalStorage'),
	];
	for (const path of paths) {
		await assertNoSymlinkAlias(path, 'profile mutation path');
	}
	canonicalUserDataDirectory = await canonicalizePotentialPath(userDataDirectory);
}

async function assertNoSymlinkAlias(path, label) {
	const resolved = resolve(path);
	const canonical = await canonicalizePotentialPath(resolved);
	if (canonical !== resolved) {
		throw new Error(`The peer-delegation E2E ${label} must not contain a symbolic-link alias.`);
	}
	return canonical;
}

async function canonicalizePotentialPath(path) {
	let probe = resolve(path);
	const suffix = [];
	while (true) {
		try {
			await lstat(probe);
			const canonical = await realpath(probe);
			return resolve(canonical, ...suffix);
		} catch (error) {
			if (error?.code !== 'ENOENT') {
				throw error;
			}
			const parent = dirname(probe);
			if (parent === probe) {
				throw new Error('The peer-delegation E2E path has no accessible ancestor.');
			}
			suffix.unshift(basename(probe));
			probe = parent;
		}
	}
}

function realVscodeUserDataDirectories() {
	const home = homedir();
	return [
		join(home, 'Library', 'Application Support', 'Code'),
		join(home, 'Library', 'Application Support', 'Code - Insiders'),
		join(home, '.config', 'Code'),
		join(home, '.config', 'Code - Insiders'),
		join(home, '.vscode'),
		join(home, '.vscode-insiders'),
	];
}

function isWithin(parent, candidate) {
	return candidate.startsWith(`${parent}${sep}`);
}

function parseStringArray(value) {
	if (value === undefined) {
		return [];
	}
	const parsed = JSON.parse(value);
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
		throw new Error('Peer E2E authentication scopes must be a JSON string array.');
	}
	return parsed;
}

function parseBudgetMs(value) {
	if (!/^[0-9]{3,5}$/u.test(value)) {
		throw new Error(`${environmentPrefix}_BUDGET_MS must be an integer from 500 to 30000.`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 500 || parsed > 30_000) {
		throw new Error(`${environmentPrefix}_BUDGET_MS must be an integer from 500 to 30000.`);
	}
	return parsed;
}

function requiredUuid(value, label) {
	if (
		typeof value !== 'string'
		|| !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
	) {
		throw new Error(`${label} was unavailable.`);
	}
	return value;
}

function runGit(args) {
	const result = spawnSync('git', args, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		shell: false,
	});
	if (result.status !== 0) {
		throw new Error('A peer-delegation E2E git preflight failed.');
	}
	return result.stdout.trim();
}

function readCodeVersion(executable) {
	const result = spawnSync(executable, ['--version'], {
		encoding: 'utf8',
		shell: false,
	});
	if (result.status !== 0) {
		throw new Error('The peer-delegation E2E could not read the VS Code version.');
	}
	const version = result.stdout.split(/\r?\n/u)[0]?.trim();
	if (version === undefined || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) {
		throw new Error('The peer-delegation E2E received an invalid VS Code version.');
	}
	return version;
}

function setAc5(item, itemStatus, evidenceRefs) {
	evidence.ac5[item - 1] = { item, status: itemStatus, evidenceRefs };
}

function shortHash(domain, value) {
	return createHash('sha256')
		.update(`copilot-agent-mesh/${domain}/v1\0`, 'utf8')
		.update(value, 'utf8')
		.digest('hex')
		.slice(0, 16);
}

function removeLimitation(value) {
	evidence.limitations = evidence.limitations.filter((limitation) => limitation !== value);
}

function safeFailure(error) {
	const candidateCode = error instanceof E2eRequestError
		? error.code
		: error !== null
			&& typeof error === 'object'
			&& 'code' in error
			? error.code
			: undefined;
	const code = typeof candidateCode === 'string'
		? stableCode(candidateCode)
		: 'PEER_E2E_FAILED';
	return {
		code,
		message: sanitize(error instanceof Error ? error.message : String(error)).slice(0, 512),
	};
}

function stableCode(value) {
	return /^[A-Z][A-Z0-9_]{0,127}$/u.test(value) ? value : 'PEER_E2E_FAILED';
}

function sanitize(value) {
	return value
		.split(profileBase).join('<profile>')
		.split(runRoot).join('<runtime>')
		.split(repositoryRoot).join('<repository>')
		.split(homedir()).join('<home>');
}

function deriveOutcome(value) {
	if (value.failure !== undefined) {
		return 'fail';
	}
	const required = [
		...value.ac5.map(({ status }) => status),
		value.topology.ordinaryWindows.status,
		value.topology.broker.status,
		value.topology.workspaceClaims.status,
		value.doubleGate.status,
		value.confirmation.status,
		value.completion.status,
		value.needsInput.status,
		value.cancellation.status,
		value.timeout.status,
		value.transport.status,
		value.cleanup.status,
	];
	if (Object.values(value.resources).some(({ finalOwned }) => finalOwned !== 0)) {
		return 'fail';
	}
	if (required.includes('fail')) {
		return 'fail';
	}
	return required.every((item) => item === 'pass') ? 'pass' : 'unverified';
}

function initialEvidence() {
	return {
		schemaVersion: 1,
		release: '0.4.0-preview',
		runId,
		outcome: 'unverified',
		gitCommit: '0000000000000000000000000000000000000000',
		versions: {
			extension: '0.4.0',
			vscode: '1.135.0',
			ahpCommit: 'f19dd8b3942d029744a3bdd31d830f9428e8ea47',
			ahpClient: '0.9.0',
			protocolOffer: ['1.0.0'],
		},
		startedAt: new Date(startedAtMs).toISOString(),
		finishedAt: new Date(startedAtMs).toISOString(),
		durationMs: 0,
		platform: { os: process.platform, architecture: process.arch },
		topology: {
			ordinaryWindows: {
				status: 'unverified',
				count: 0,
				ordinary: false,
				sharedUserData: false,
			},
			broker: { status: 'unverified', count: 0 },
			workspaceClaims: {
				status: 'unverified',
				count: 0,
				hashes: [],
				distinct: false,
			},
		},
		doubleGate: {
			status: 'unverified',
			beforeTargetVisible: false,
			allowOnlyTargetVisible: false,
			afterTargetVisible: false,
			reverseTargetVisible: false,
			dashboardSourceCandidateCount: 0,
			dashboardTargetCandidateCount: 0,
			dashboardAlwaysListedBoth: false,
		},
		confirmation: {
			status: 'unverified',
			preparedCount: 0,
			acceptedCount: 0,
			source: 'unobserved',
			operatorAttested: false,
		},
		completion: {
			status: 'unverified',
			parentSameInvocation: false,
			parentResultFields: [],
			parentResultBytes: 0,
			invocationSource: 'none',
			eventTypes: [],
			eventSequences: [],
			authoritativeOrder: false,
			ahpTurnCompleteObserved: false,
			output: { count: 0, bytes: 0 },
			incomingRecord: false,
			source: 'unavailable',
			degraded: false,
			leaseReleased: false,
			durationMs: 0,
		},
		needsInput: {
			status: 'unverified',
			questionPresent: false,
			eventTypes: [],
			answerTaskIdMatched: false,
			answerInputIdMatched: false,
			resumed: false,
			terminalState: 'not-observed',
			leaseReleased: false,
		},
		cancellation: {
			status: 'unverified',
			reason: 'not-observed',
			eventTypes: [],
			terminalState: 'not-observed',
			leaseReleased: false,
		},
		timeout: {
			status: 'unverified',
			reason: 'not-observed',
			budgetMs,
			productionDefaultMinutes: 60,
			productionMaximumMinutes: 60,
			eventTypes: [],
			terminalState: 'not-observed',
			leaseReleased: false,
		},
		sessionVisibility: {
			status: 'unverified',
			source: 'unavailable',
			catalogBefore: 0,
			catalogAfter: 0,
			sessionHashMatched: false,
			uiObserved: false,
		},
		transport: {
			status: 'unverified',
			listenerStartAttempts: { baseline: 0, final: 0, delta: 0 },
			tunnelLoadAttempts: { baseline: 0, final: 0, delta: 0 },
			tunnelProbeAttempts: { baseline: 0, final: 0, delta: 0 },
			tunnelEnsureHostedAttempts: { baseline: 0, final: 0, delta: 0 },
			localRouteOnly: false,
		},
		resources: {
			vscode: { baselineOwned: 0, ownedPeak: 0, finalOwned: 0 },
			agentHost: { baselineOwned: 0, ownedPeak: 0, finalOwned: 0 },
			tunnel: { baselineOwned: 0, ownedPeak: 0, finalOwned: 0 },
			socket: { baselineOwned: 0, ownedPeak: 0, finalOwned: 0 },
			timer: { baselineOwned: 0, ownedPeak: 0, finalOwned: 0 },
		},
		cleanup: {
			status: 'unverified',
			profileLockReleased: false,
			workspaceLeaseReleased: false,
			localIpcRemoved: false,
			editorEndpointReleased: false,
			runtimeRemoved: false,
			ownedProcessesReleased: false,
			ownedSocketsReleased: false,
			ownedTimersReleased: false,
			complete: false,
		},
		experiments: [
			{ id: 'O1', status: 'unverified', conclusion: 'unverified' },
			{
				id: 'O2',
				status: 'unverified',
				conclusion: 'unverified',
				observedDurationMs: 0,
			},
			{
				id: 'O3',
				status: 'unverified',
				conclusion: 'tool-choice-not-guaranteed',
			},
			{
				id: 'O4',
				status: 'unsupported',
				conclusion: 'concurrent-user-edits-undetectable',
			},
			{
				id: 'O5',
				status: 'unsupported',
				conclusion: 'non-macos-endpoint-unverified',
			},
		],
		ac5: Array.from({ length: 12 }, (_, index) => ({
			item: index + 1,
			status: 'unverified',
			evidenceRefs: [],
		})),
		limitations: [
			'COPILOT_TOOL_CHOICE_NOT_GUARANTEED',
			'CONCURRENT_USER_COPILOT_EDITS_UNDETECTABLE',
			'CROSS_DEVICE_DELEGATION_UNVERIFIED',
			'NON_MACOS_WORKER_UNSUPPORTED',
			'SIXTY_MINUTE_UI_CALL_UNVERIFIED',
			'TARGET_CHAT_SESSIONS_UI_UNVERIFIED',
			'REAL_NEEDS_INPUT_UNVERIFIED',
		],
	};
}

function renderSummary(value) {
	const rows = value.ac5
		.map(({ item, status }) => `| ${item} | ${status} |`)
		.join('\n');
	return [
		'# Peer Delegation real E2E',
		'',
		`- Outcome: **${value.outcome}**`,
		`- Run: \`${value.runId}\``,
		`- Commit: \`${value.gitCommit}\``,
		`- VS Code: \`${value.versions.vscode}\``,
		`- Agent Host source: \`${value.completion.source}\``,
		`- Cleanup: \`${value.cleanup.status}\``,
		'',
		'| AC-5 item | Status |',
		'| ---: | --- |',
		rows,
		'',
		`O1: ${value.experiments[0].status} (${value.experiments[0].conclusion})`,
		`O2: ${value.experiments[1].status} (${value.experiments[1].conclusion})`,
		'',
	].join('\n');
}

function delay(delayMs) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}
