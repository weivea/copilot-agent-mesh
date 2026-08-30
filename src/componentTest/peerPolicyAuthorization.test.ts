import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	BrokerTaskService,
	DeviceBroker,
	NodeRegistry,
	PeerPolicyService,
	PeerPolicyStore,
	TaskRouteCatalog,
	type RegistryScheduler,
} from '../broker';
import type { NodeTaskStartParams } from '../../shared/protocol';
import type { StateStore } from '../domain/ports';
import { LocalIpcRemoteError, type LocalIpcIdentity } from '../ipc';
import { WindowNodeClient, type WindowNodeExecutor } from '../node';
import { AtomicFileStore } from '../storage/AtomicFileStore';
import type { BrokerOwnership } from '../storage/WorkerOwnerLock';
import { FileTaskStore } from '../tasks/FileTaskStore';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { LocalBrokerTaskFacade } from '../tools/LocalBrokerTaskFacade';
import { DelegatedToolInvocationRegistry } from '../tools/DelegatedToolInvocationRegistry';
import { TaskToolsCore } from '../tools/taskToolsCore';
import { MESH_TOOL_NAMES } from '../tools/toolManifest';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';
import {
	MemoryAtomicFileSystem,
	TestOwnership,
	uuid,
} from '../unitTest/artifactStoreTestSupport';

const DEVICE = uuid(201);
const NODE_A = uuid(202);
const NODE_B = uuid(203);
const NODE_C = uuid(230);
const INSTANCE_A = uuid(204);
const INSTANCE_B = uuid(205);
const INSTANCE_C = uuid(231);
const WORKSPACE_A = uuid(206);
const WORKSPACE_B = uuid(207);
const WORKSPACE_C = uuid(208);
const WORKSPACE_D = uuid(232);
const IDENTITY_A = createOpaqueWorkspaceIdentity('component-workspace-a');
const IDENTITY_B = createOpaqueWorkspaceIdentity('component-workspace-b');
const IDENTITY_C = createOpaqueWorkspaceIdentity('component-workspace-c');
const IDENTITY_D = createOpaqueWorkspaceIdentity('component-workspace-d');

test('authenticated broker RPC keeps Tool and configuration directories separate', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());

	assert.equal((await fixture.nodeA.listNodes()).nodes.length, 0);
	const candidates = await fixture.nodeA.listPeerPolicyCandidates(IDENTITY_A);
	assert.equal(candidates.candidates.length, 2);
	assert.equal(
		candidates.candidates.find(({ self }) => !self)?.windowLabel,
		'Repository B',
	);
	assert.doesNotMatch(JSON.stringify(candidates), /sha256:|file:|component-workspace/u);
	const staleHandle = candidates.candidates.find(({ self }) => !self)?.actionHandle;
	assert.ok(staleHandle);
	await assert.rejects(
		fixture.nodeB.setPeerPolicyCandidate(IDENTITY_B, staleHandle, true),
		(error: unknown) =>
			error instanceof LocalIpcRemoteError
			&& errorReason(error) === 'POLICY_FORBIDDEN',
	);
	const refreshed = await fixture.nodeA.listPeerPolicyCandidates(IDENTITY_A);
	await assert.rejects(
		fixture.nodeA.setPeerPolicyCandidate(IDENTITY_A, staleHandle, true),
		(error: unknown) =>
			error instanceof LocalIpcRemoteError
			&& errorReason(error) === 'POLICY_FORBIDDEN',
	);
	const targetHandle = refreshed.candidates.find(({ self }) => !self)?.actionHandle;
	assert.ok(targetHandle);
	await fixture.nodeA.setPeerPolicyCandidate(IDENTITY_A, targetHandle, true);
	await assert.rejects(
		fixture.nodeA.setPeerPolicyCandidate(IDENTITY_A, targetHandle, false),
		(error: unknown) =>
			error instanceof LocalIpcRemoteError
			&& errorReason(error) === 'POLICY_FORBIDDEN',
	);
	await assert.rejects(
		fixture.nodeA.startTask(task(uuid(208))),
		(error: unknown) =>
			error instanceof LocalIpcRemoteError
			&& errorReason(error) === 'PEER_NOT_ACCEPTING',
	);

	await fixture.nodeB.setPeerPolicy({
		workspaceIdentity: IDENTITY_B,
		acceptsIncoming: true,
	});
	const visible = await fixture.nodeA.listNodes();
	assert.equal(visible.nodes.length, 1);
	assert.equal(visible.nodes[0]?.nodeId, NODE_B);
	assert.equal(visible.nodes[0]?.nodeInstanceId, INSTANCE_B);
	assert.equal(visible.nodes[0]?.workspaces[0]?.workspaceIdentity, IDENTITY_B);

	await fixture.nodeA.setPeerPolicy({
		workspaceIdentity: IDENTITY_A,
		allowlist: [],
	});
	assert.equal((await fixture.nodeA.listNodes()).nodes.length, 0);
	await assert.rejects(
		fixture.nodeA.startTask(task(uuid(209))),
		(error: unknown) =>
			error instanceof LocalIpcRemoteError
			&& errorReason(error) === 'PEER_NOT_ALLOWED',
	);
});

test('default-off Tool listing stays empty while the safe Dashboard directory remains complete', async (t) => {
	const fixture = await createFixture({ enabled: false });
	t.after(() => fixture.dispose());

	assert.deepEqual((await fixture.nodeA.listNodes()).nodes, []);
	const dashboard = await fixture.nodeA.listDashboardNodes();
	assert.equal(dashboard.nodes.length, 2);
	assert.equal(dashboard.totalNodes, 2);
	assert.equal(dashboard.truncated, false);
	assert.equal(
		dashboard.nodes.find(({ nodeId }) => nodeId === NODE_A)?.workspaces[0]?.workspaceId,
		WORKSPACE_A,
	);
	assert.doesNotMatch(JSON.stringify(dashboard), /sha256:|component-workspace/u);
});

test('retains an offline allowlist entry with a removable one-time handle', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	await fixture.nodeB.setPeerPolicy({
		workspaceIdentity: IDENTITY_B,
		windowName: 'Backend',
	});
	const candidate = (await fixture.nodeA.listPeerPolicyCandidates(IDENTITY_A))
		.candidates.find(({ self }) => !self);
	assert.ok(candidate?.actionHandle);
	await fixture.nodeA.setPeerPolicyCandidate(IDENTITY_A, candidate.actionHandle, true);
	await fixture.nodeB.dispose();

	const offline = (await fixture.nodeA.listPeerPolicyCandidates(IDENTITY_A))
		.candidates.find(({ online, allowlisted }) => !online && allowlisted);
	assert.equal(offline?.windowLabel, 'Backend');
	assert.equal(offline?.gateState, 'offline');
	assert.ok(offline?.actionHandle);
	await fixture.nodeA.setPeerPolicyCandidate(IDENTITY_A, offline.actionHandle, false);
	assert.deepEqual((await fixture.nodeA.getPeerPolicy(IDENTITY_A)).allowlist, []);
});

test('rename updates every window immediately and rejects normalized conflicts over authenticated RPC', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	let notified!: () => void;
	const notification = new Promise<void>((resolve) => {
		notified = resolve;
	});
	const subscription = fixture.nodeB.onDidChange(notified);
	t.after(() => subscription.dispose());

	await fixture.nodeA.setPeerPolicy({
		workspaceIdentity: IDENTITY_A,
		windowName: 'Ｆrontend',
	});
	await notification;
	const dashboard = await fixture.nodeB.listDashboardNodes();
	assert.equal(
		dashboard.nodes.find(({ nodeId }) => nodeId === NODE_A)?.label,
		'Ｆrontend',
	);
	await assert.rejects(
		fixture.nodeB.setPeerPolicy({
			workspaceIdentity: IDENTITY_B,
			windowName: 'frontend',
		}),
		(error: unknown) =>
			error instanceof LocalIpcRemoteError
			&& errorReason(error) === 'WINDOW_NAME_CONFLICT',
	);
	assert.equal((await fixture.nodeB.getPeerPolicy()).windowName, 'Repository B');
});

test('two windows and one Broker deliver authoritative delegation outcomes without polling', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	await fixture.nodeA.setPeerPolicy({
		workspaceIdentity: IDENTITY_A,
		allowlist: [IDENTITY_B],
	});
	await fixture.nodeB.setPeerPolicy({
		workspaceIdentity: IDENTITY_B,
		acceptsIncoming: true,
	});
	const facade = new LocalBrokerTaskFacade(fixture.nodeA, {
		deviceName: 'Component Device',
		now: () => new Date('2026-08-30T12:00:00.000Z'),
		sourceWorkspaceIdentity: () => IDENTITY_A,
	});
	const core = new TaskToolsCore(facade);

	const completedInput = delegationInput(210);
	const completedIdentity = facade.identifyDelegation(completedInput);
	await fixture.nodeA.startTask({
		delegationRequestId: completedInput.delegationRequestId,
		taskId: completedIdentity.taskId,
		sourceNodeId: NODE_A,
		sourceWorkspaceIdentity: IDENTITY_A,
		target: {
			deviceId: completedInput.deviceId,
			nodeId: completedInput.nodeId,
			nodeInstanceId: completedInput.nodeInstanceId,
			workspaceId: completedInput.workspaceId,
		},
		title: completedInput.title,
		prompt: completedInput.prompt,
		acceptanceCriteria: completedInput.acceptanceCriteria,
		workerDeadline: '2026-08-30T13:00:00.000Z',
	});
	const completed = core.delegateTask(completedInput);
	const completedTaskId = await startedTaskId(fixture.executorB, completed);
	await fixture.nodeB.publishTaskEvent(taskEvent(completedTaskId, {
		type: 'completed',
		summary: 'Component task completed.',
	}));
	assert.deepEqual(await completed, {
		s: 0,
		t: completedTaskId,
		d: completedInput.delegationRequestId,
		r: { summary: 'Component task completed.' },
	});
	assert.equal(fixture.executorB.startCount, 1);
	assert.deepEqual(await core.delegateTask({
		...completedInput,
		timeoutMinutes: 59,
	}), {
		s: 2,
		t: completedTaskId,
		d: completedInput.delegationRequestId,
		e: 'IDEMPOTENCY_CONFLICT',
	});
	assert.equal(fixture.executorB.startCount, 1);

	const needsInputRequest = delegationInput(211);
	const needsInput = core.delegateTask(needsInputRequest);
	const needsInputTaskId = await startedTaskId(fixture.executorB, needsInput);
	const inputId = uuid(212);
	await fixture.nodeB.publishTaskEvent(taskEvent(needsInputTaskId, {
		type: 'inputRequired',
		inputId,
		prompt: 'Which component option?',
	}));
	assert.deepEqual(await needsInput, {
		s: 1,
		t: needsInputTaskId,
		d: needsInputRequest.delegationRequestId,
		i: inputId,
		q: 'Which component option?',
	});
	await fixture.nodeB.publishTaskEvent(taskEvent(needsInputTaskId, {
		type: 'completed',
		summary: 'Input flow closed.',
	}));

	const failedInput = delegationInput(213);
	const failed = core.delegateTask(failedInput);
	const failedTaskId = await startedTaskId(fixture.executorB, failed);
	await fixture.nodeB.publishTaskEvent(taskEvent(failedTaskId, {
		type: 'failed',
		failure: {
			code: 'TASK_EXECUTION_FAILED',
			message: 'The component worker failed.',
			retryable: false,
		},
	}));
	assert.deepEqual(await failed, {
		s: 2,
		t: failedTaskId,
		d: failedInput.delegationRequestId,
		e: 'TASK_EXECUTION_FAILED',
	});

	const cancelledInput = delegationInput(214);
	const cancelled = core.delegateTask(cancelledInput);
	const cancelledTaskId = await startedTaskId(fixture.executorB, cancelled);
	const outgoing = await fixture.nodeA.listDashboardTasks();
	const incoming = await fixture.nodeB.listDashboardTasks();
	const outgoingTask = outgoing.tasks.find(({ shortId }) => shortId === cancelledTaskId.slice(0, 8));
	const incomingTask = incoming.tasks.find(({ shortId }) => shortId === cancelledTaskId.slice(0, 8));
	assert.equal(outgoingTask?.direction, 'outgoing');
	assert.equal(incomingTask?.direction, 'incoming');
	assert.equal((await fixture.nodeA.listDashboardTasks()).tasks.some(
		({ direction }) => direction === 'incoming',
	), false);
	const wrongDirectionHandle = incomingTask?.actionHandle;
	assert.ok(wrongDirectionHandle);
	await assert.rejects(
		fixture.nodeB.reserveDashboardTask(wrongDirectionHandle, 'outgoing'),
		(error: unknown) =>
			error instanceof LocalIpcRemoteError
			&& errorReason(error) === 'TASK_NOT_FOUND',
	);
	const cancelHandle = (await fixture.nodeB.listDashboardTasks()).tasks.find(
		({ shortId }) => shortId === cancelledTaskId.slice(0, 8),
	)?.actionHandle;
	assert.ok(cancelHandle);
	const reservation = await fixture.nodeB.reserveDashboardTask(cancelHandle, 'incoming');
	await fixture.nodeB.listDashboardTasks();
	const cancelling = await fixture.nodeB.cancelDashboardTask(
		reservation.reservationHandle,
		'incoming',
	);
	assert.equal(cancelling.state, 'cancelling');
	await assert.rejects(
		fixture.nodeB.cancelDashboardTask(reservation.reservationHandle, 'incoming'),
		(error: unknown) =>
			error instanceof LocalIpcRemoteError
			&& errorReason(error) === 'TASK_NOT_FOUND',
	);
	await fixture.nodeB.publishTaskEvent(taskEvent(cancelledTaskId, {
		type: 'cancelled',
		summary: 'The peer cancelled the component task.',
	}));
	assert.deepEqual(await cancelled, {
		s: 3,
		t: cancelledTaskId,
		d: cancelledInput.delegationRequestId,
		e: 'CANCELLED',
		x: 'peer',
	});
});

test('stable claimed-set source scope survives focus changes, no editor, and Broker takeover', async (t) => {
	const fixture = await createFixture({
		sourceWorkspaceIdentities: ['component-workspace-a', 'component-workspace-c'],
	});
	t.after(() => fixture.dispose());
	for (const workspaceIdentity of [IDENTITY_A, IDENTITY_C]) {
		await fixture.nodeA.setPeerPolicy({
			workspaceIdentity,
			allowlist: [IDENTITY_B],
		});
	}
	await fixture.nodeB.setPeerPolicy({
		workspaceIdentity: IDENTITY_B,
		acceptsIncoming: true,
	});

	const scope = fixture.nodeA.delegationSourceScopeIdentity();
	assert.equal(
		fixture.nodeA.selectPeerPolicyWorkspace('file:///component-workspace-a').kind,
		'selected',
	);
	assert.equal(fixture.nodeA.delegationSourceScopeIdentity(), scope);
	assert.equal(
		fixture.nodeA.selectPeerPolicyWorkspace('file:///component-workspace-c').kind,
		'selected',
	);
	assert.equal(fixture.nodeA.delegationSourceScopeIdentity(), scope);
	assert.equal(fixture.nodeA.selectPeerPolicyWorkspace().kind, 'unavailable');
	assert.equal(fixture.nodeA.delegationSourceScopeIdentity(), scope);

	const facade = new LocalBrokerTaskFacade(fixture.nodeA, {
		deviceName: 'Component Device',
		now: () => new Date('2026-08-30T12:00:00.000Z'),
		sourceWorkspaceIdentity: () => fixture.nodeA.delegationSourceScopeIdentity(),
	});
	const core = new TaskToolsCore(facade);
	const input = delegationInput(220);
	const invocation = core.delegateTask(input);
	const taskId = await startedTaskId(fixture.executorB, invocation);
	await fixture.nodeB.publishTaskEvent(taskEvent(taskId, {
		type: 'completed',
		summary: 'Stable scope completed.',
	}));
	assert.equal((await invocation).t, taskId);
	fixture.nodeA.selectPeerPolicyWorkspace('file:///component-workspace-a');
	assert.equal((await core.delegateTask(input)).t, taskId);
	fixture.nodeA.selectPeerPolicyWorkspace('file:///component-workspace-c');
	assert.equal((await core.delegateTask(input)).t, taskId);
	fixture.nodeA.selectPeerPolicyWorkspace();
	assert.equal((await core.delegateTask(input)).t, taskId);
	assert.equal(fixture.executorB.startCount, 1);

	await fixture.restartBroker();
	const takeoverCore = new TaskToolsCore(new LocalBrokerTaskFacade(fixture.nodeA, {
		deviceName: 'Component Device',
		now: () => new Date('2026-08-30T12:00:00.000Z'),
		sourceWorkspaceIdentity: () => fixture.nodeA.delegationSourceScopeIdentity(),
	}));
	assert.equal((await takeoverCore.delegateTask(input)).t, taskId);
	assert.deepEqual(await takeoverCore.delegateTask({
		...input,
		prompt: 'Changed semantics after takeover.',
	}), {
		s: 2,
		t: taskId,
		d: input.delegationRequestId,
		e: 'IDEMPOTENCY_CONFLICT',
	});
	assert.equal(fixture.executorB.startCount, 1);
});

test('delegated child context blocks recursion without blocking the window primary role', async (t) => {
	const fixture = await createFixture({ includeNodeC: true });
	t.after(() => fixture.dispose());
	const nodeC = fixture.nodeC!;
	const executorC = fixture.executorC!;
	await fixture.nodeA.setPeerPolicy({
		workspaceIdentity: IDENTITY_A,
		allowlist: [IDENTITY_B],
	});
	await fixture.nodeB.setPeerPolicy({
		workspaceIdentity: IDENTITY_B,
		acceptsIncoming: true,
		allowlist: [IDENTITY_D],
	});
	await nodeC.setPeerPolicy({
		workspaceIdentity: IDENTITY_D,
		acceptsIncoming: true,
	});

	const incomingTaskId = uuid(233);
	const incomingStarted = fixture.executorB.nextStartedTaskId();
	await fixture.nodeA.startTask(task(incomingTaskId));
	await incomingStarted;
	const childContext = fixture.executorB.lastStart?.delegatedExecutionContext;
	assert.ok(childContext);

	const facadeB = new LocalBrokerTaskFacade(fixture.nodeB, {
		deviceName: 'Component Device',
		now: () => new Date('2026-08-30T12:00:00.000Z'),
		sourceWorkspaceIdentity: () => IDENTITY_B,
	});
	const delegatedToolInvocations = new DelegatedToolInvocationRegistry();
	t.after(() => delegatedToolInvocations.dispose());
	const primaryCore = new TaskToolsCore(facadeB, { delegatedToolInvocations });
	const primaryInput = delegationFromBToC(234);
	const primaryTaskId = facadeB.identifyDelegation(primaryInput).taskId;
	const primaryStarted = executorC.nextStartedTaskId();
	const primary = primaryCore.delegateTask(primaryInput);
	await primaryStarted;
	assert.equal(executorC.lastStart?.taskId, primaryTaskId);

	const childCore = new TaskToolsCore(facadeB, { delegatedToolInvocations });
	const childInput = delegationFromBToC(236);
	delegatedToolInvocations.observe({
		scopeId: 'ahp-session:/component-child',
		invocationId: 'turn-1\u0000tool-1',
		toolName: MESH_TOOL_NAMES.delegateTask,
		toolInput: JSON.stringify(childInput),
		context: childContext,
	});
	const childResult = await childCore.delegateTask(childInput);
	assert.equal(childResult.e, 'DELEGATION_RECURSION');
	const duplicateChildResult = await childCore.delegateTask(childInput);
	assert.equal(duplicateChildResult.e, 'DELEGATION_RECURSION');
	assert.equal(delegatedToolInvocations.size, 1);
	delegatedToolInvocations.forget('ahp-session:/component-child', 'turn-1\u0000tool-1');
	assert.equal(delegatedToolInvocations.size, 0);

	await nodeC.publishTaskEvent(taskEventFor(
		NODE_C,
		INSTANCE_C,
		primaryTaskId,
		{ type: 'completed', summary: 'Primary delegation completed.' },
	));
	assert.equal((await primary).s, 0);
	await fixture.nodeB.publishTaskEvent(taskEvent(incomingTaskId, {
		type: 'completed',
		summary: 'Incoming child task completed.',
	}));

	const staleInput = delegationFromBToC(238);
	delegatedToolInvocations.observe({
		scopeId: 'ahp-session:/component-child',
		invocationId: 'turn-1\u0000tool-2',
		toolName: MESH_TOOL_NAMES.delegateTask,
		toolInput: JSON.stringify(staleInput),
		context: childContext,
	});
	const staleResult = await childCore.delegateTask(staleInput);
	assert.equal(staleResult.e, 'AUTH_FAILED');
	assert.equal(executorC.startCount, 1);
});

interface Fixture {
	readonly nodeA: WindowNodeClient;
	readonly nodeB: WindowNodeClient;
	readonly nodeC?: WindowNodeClient;
	readonly executorB: RecordingExecutor;
	readonly executorC?: RecordingExecutor;
	restartBroker(): Promise<void>;
	dispose(): Promise<void>;
}

async function createFixture(options: {
	readonly enabled?: boolean;
	readonly sourceWorkspaceIdentities?: readonly string[];
	readonly includeNodeC?: boolean;
} = {}): Promise<Fixture> {
	const tempDirectory = await mkdtemp(
		process.platform === 'win32' ? join(tmpdir(), 'mesh-pp-') : '/tmp/mesh-pp-',
	);
	const identity: LocalIpcIdentity = {
		userIdentity: 'component-user',
		deviceId: DEVICE,
		tempDirectory,
	};
	const ownership = new TestBrokerOwnership();
	const clock = { now: () => new Date('2026-08-30T12:00:00.000Z') };
	const files = new AtomicFileStore('memory', new MemoryAtomicFileSystem(), {
		next: () => `temp-${Math.random().toString(16).slice(2)}`,
	});
	const peerStore = new PeerPolicyStore(files, {
		ownership,
		generation: ownership.generation,
		clock,
	});
	await peerStore.initialize();
	const registryState = new MemoryState();
	const routeState = new MemoryState();
	const workspaceIds = [
		WORKSPACE_A,
		...(options.sourceWorkspaceIdentities?.length === 2 ? [WORKSPACE_C] : []),
		WORKSPACE_B,
		...(options.includeNodeC ? [WORKSPACE_D] : []),
	];
	let registry: NodeRegistry;
	let policies: PeerPolicyService;
	let taskService: BrokerTaskService;
	let broker: DeviceBroker | undefined;
	const startBroker = async (): Promise<void> => {
		registry = await NodeRegistry.create({
			deviceId: DEVICE,
			state: registryState,
			ids: { next: () => workspaceIds.shift()! },
			clock,
			workspaceLeases: new WorkspaceLeaseManager(),
			scheduler: new NoopScheduler(),
		});
		policies = new PeerPolicyService(peerStore, registry, {
			enabled: () => options.enabled ?? true,
		});
		registry.setPeerRouteAuthorizer(policies);
		taskService = new BrokerTaskService(
			DEVICE,
			registry,
			new FileTaskStore(files, clock),
			clock,
			{
				onTaskSnapshot: (snapshot, sourceNodeId) => {
					broker?.publishTaskSnapshot(snapshot, sourceNodeId);
				},
			},
		);
		await taskService.initialize();
		broker = new DeviceBroker({
			identity,
			brokerKey: Buffer.alloc(32, 0x5a),
			ownership,
			registry,
			peerPolicies: policies,
			taskService,
			taskRoutes: new TaskRouteCatalog(routeState, clock.now),
			requestTimeoutMs: 2_000,
		});
		await broker.start();
	};
	await startBroker();
	const executorB = new RecordingExecutor();
	const executorC = options.includeNodeC ? new RecordingExecutor() : undefined;
	let nodeA: WindowNodeClient;
	let nodeB: WindowNodeClient;
	let nodeC: WindowNodeClient | undefined;
	const startNodes = async (): Promise<void> => {
		nodeA = nodeClient(
			identity,
			NODE_A,
			INSTANCE_A,
			options.sourceWorkspaceIdentities ?? ['component-workspace-a'],
		);
		nodeB = nodeClient(
			identity,
			NODE_B,
			INSTANCE_B,
			['component-workspace-b'],
			executorB,
		);
		nodeC = options.includeNodeC
			? nodeClient(
				identity,
				NODE_C,
				INSTANCE_C,
				['component-workspace-d'],
				executorC!,
			)
			: undefined;
		await nodeA.start();
		await nodeB.start();
		await nodeC?.start();
	};
	await startNodes();
	return {
		get nodeA() {
			return nodeA;
		},
		get nodeB() {
			return nodeB;
		},
		get nodeC() {
			return nodeC;
		},
		executorB,
		executorC,
		restartBroker: async () => {
			await nodeA.dispose();
			await nodeB.dispose();
			await nodeC?.dispose();
			await broker?.dispose();
			broker = undefined;
			await startBroker();
			await startNodes();
		},
		dispose: async () => {
			await nodeA.dispose().catch(() => undefined);
			await nodeB.dispose().catch(() => undefined);
			await nodeC?.dispose().catch(() => undefined);
			await broker?.dispose().catch(() => undefined);
			await rm(tempDirectory, { recursive: true, force: true });
		},
	};
}

function nodeClient(
	identity: LocalIpcIdentity,
	nodeId: string,
	nodeInstanceId: string,
	fileIdentities: readonly string[],
	executor: WindowNodeExecutor = noopExecutor(),
): WindowNodeClient {
	return new WindowNodeClient({
		identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		nodeId,
		nodeInstanceId,
		label: nodeId === NODE_A ? 'frontend' : nodeId === NODE_B ? 'backend' : 'worker',
		capabilities: ['tasks'],
		executor,
		workspaceSource: () => fileIdentities.map((fileIdentity, index) => ({
			localUri: `file:///${fileIdentity}`,
			name: nodeId === NODE_A
				? `Repository ${index + 1}`
				: nodeId === NODE_B ? 'Repository B' : 'Repository C',
			capabilityTags: ['typescript'],
		})),
		fileIdentityResolver: {
			resolve: async (uri) => ({
				identity: new URL(uri).pathname.slice(1),
				canonicalUri: uri,
			}),
		},
		heartbeatIntervalMs: 60_000,
		requestTimeoutMs: 2_000,
	});
}

function errorReason(error: LocalIpcRemoteError): unknown {
	return (
		typeof error.data === 'object'
		&& error.data !== null
		&& !Array.isArray(error.data)
		&& 'reason' in error.data
	) ? error.data.reason : undefined;
}

function noopExecutor(): WindowNodeExecutor {
	return {
		start: async (input) => ({
			taskId: input.taskId,
			nodeId: input.target.nodeId,
			nodeInstanceId: input.target.nodeInstanceId,
		}),
		cancel: async () => undefined,
		answer: async () => undefined,
		dispose: async () => undefined,
	};
}

function task(taskId: string) {
	return {
		delegationRequestId: uuid(Number.parseInt(taskId.slice(-4), 16) + 1),
		taskId,
		target: {
			deviceId: DEVICE,
			nodeId: NODE_B,
			nodeInstanceId: INSTANCE_B,
			workspaceId: WORKSPACE_B,
		},
		sourceNodeId: NODE_A,
		title: 'Component peer policy task',
		prompt: 'Perform the bounded component task.',
		acceptanceCriteria: [],
		workerDeadline: '2026-08-30T13:00:00.000Z',
	};
}

function taskFromBToC(taskId: string, delegationRequestId: string) {
	return {
		delegationRequestId,
		taskId,
		target: {
			deviceId: DEVICE,
			nodeId: NODE_C,
			nodeInstanceId: INSTANCE_C,
			workspaceId: WORKSPACE_D,
		},
		sourceNodeId: NODE_B,
		sourceWorkspaceIdentity: IDENTITY_B,
		title: 'Simultaneous primary delegation',
		prompt: 'Run while this window also executes an incoming child task.',
		acceptanceCriteria: [],
		workerDeadline: '2026-08-30T13:00:00.000Z',
	};
}

function delegationInput(index: number) {
	return {
		delegationRequestId: uuid(index),
		deviceId: DEVICE,
		nodeId: NODE_B,
		nodeInstanceId: INSTANCE_B,
		workspaceId: WORKSPACE_B,
		title: `Component delegation ${index}`,
		prompt: 'Perform the bounded component delegation.',
		acceptanceCriteria: [],
		timeoutMinutes: 60,
	};
}

function delegationFromBToC(index: number) {
	return {
		delegationRequestId: uuid(index),
		deviceId: DEVICE,
		nodeId: NODE_C,
		nodeInstanceId: INSTANCE_C,
		workspaceId: WORKSPACE_D,
		title: 'Component nested task',
		prompt: 'Attempt delegation from Window B.',
		acceptanceCriteria: ['Reach Window C'],
		timeoutMinutes: 60,
	};
}

function taskEvent(
	taskId: string,
	event: Parameters<WindowNodeClient['publishTaskEvent']>[0]['event'],
): Parameters<WindowNodeClient['publishTaskEvent']>[0] {
	return {
		nodeId: NODE_B,
		nodeInstanceId: INSTANCE_B,
		taskId,
		at: '2026-08-30T12:00:01.000Z',
		event,
	};
}

function taskEventFor(
	nodeId: string,
	nodeInstanceId: string,
	taskId: string,
	event: Parameters<WindowNodeClient['publishTaskEvent']>[0]['event'],
): Parameters<WindowNodeClient['publishTaskEvent']>[0] {
	return {
		nodeId,
		nodeInstanceId,
		taskId,
		at: '2026-08-30T12:00:01.000Z',
		event,
	};
}

async function startedTaskId(
	executor: RecordingExecutor,
	invocation: Promise<unknown>,
): Promise<string> {
	return Promise.race([
		executor.nextStartedTaskId(),
		invocation.then((result) => {
			throw new Error(`Delegation returned before its worker started: ${JSON.stringify(result)}`);
		}),
	]);
}

class MemoryState implements StateStore {
	private readonly values = new Map<string, unknown>();

	public get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, structuredClone(value));
	}
}

class NoopScheduler implements RegistryScheduler {
	public repeat(): { dispose(): void } {
		return { dispose: () => undefined };
	}
}

class TestBrokerOwnership extends TestOwnership implements BrokerOwnership {
	public contend(): Promise<boolean> {
		return Promise.resolve(true);
	}

	public onDidLoseOwnership(): { dispose(): void } {
		return { dispose: () => undefined };
	}

	public dispose(): Promise<void> {
		return Promise.resolve();
	}
}

class RecordingExecutor implements WindowNodeExecutor {
	private readonly startedTaskIds: string[] = [];
	private readonly waiters: Array<(taskId: string) => void> = [];
	public startCount = 0;
	public lastStart: NodeTaskStartParams | undefined;

	public start(
		input: Parameters<WindowNodeExecutor['start']>[0],
	): Promise<Awaited<ReturnType<WindowNodeExecutor['start']>>> {
		this.startCount += 1;
		this.lastStart = structuredClone(input);
		const waiter = this.waiters.shift();
		if (waiter === undefined) {
			this.startedTaskIds.push(input.taskId);
		} else {
			waiter(input.taskId);
		}
		return Promise.resolve({
			taskId: input.taskId,
			nodeId: input.target.nodeId,
			nodeInstanceId: input.target.nodeInstanceId,
		});
	}

	public cancel(): Promise<void> {
		return Promise.resolve();
	}

	public answer(): Promise<void> {
		return Promise.resolve();
	}

	public dispose(): Promise<void> {
		return Promise.resolve();
	}

	public nextStartedTaskId(): Promise<string> {
		const taskId = this.startedTaskIds.shift();
		if (taskId !== undefined) {
			return Promise.resolve(taskId);
		}
		return new Promise<string>((resolve) => this.waiters.push(resolve));
	}
}
