import * as assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
	GATEWAY_NOTIFICATIONS,
	LOCAL_BROKER_METHODS,
	MESH_ERROR_CODES,
	MESH_PROTOCOL_VERSION,
	nodeRegistrationResultSchema,
	routedTaskStartParamsSchema,
	type NodeDirectoryResult,
	type NodeHeartbeatParams,
	type NodeRegisterParams,
	type NodeTaskStartParams,
	type RoutedTaskStartParams,
	type TaskSnapshot,
	type WindowNodeDescriptor,
} from '../../shared/protocol';
import type { DelegationIntentInput } from '../../shared/toolProtocol';
import {
	AgentRuntimeApprovalCapabilityIssuer,
	createAgentRuntimeEventQueue,
	type AgentRuntime,
	type AgentRuntimeProbe,
	type AgentTaskHandle,
	type AgentTaskRequest,
} from '../agentHost/AgentRuntime';
import {
	BrokerTaskService,
	DeviceBroker,
	NodeRegistry,
	TaskRouteCatalog,
	type PeerPolicyService,
} from '../broker';
import {
	ProductionRemoteTaskAdapter,
	REMOTE_TASK_ROUTE_STATE_KEY,
} from '../composition/ProductionRemoteTaskAdapter';
import { MeshDomainError } from '../domain/errors';
import type { StateStore } from '../domain/ports';
import type { TaskRecord } from '../domain/task';
import { GatewayRouter } from '../gateway/GatewayRouter';
import {
	LocalIpcClient,
	LocalIpcRemoteError,
	type LocalIpcIdentity,
	type LocalIpcSession,
} from '../ipc';
import {
	LocalIpcRemoteTaskAdapter,
	WindowNodeClient,
	WindowNodeTaskExecutor,
	type WindowNodeClientOptions,
	type WindowNodeTaskConfirmationRequest,
} from '../node';
import type { PeerConnectionManager } from '../peer/PeerConnectionManager';
import type { PeerProfile, PeerProfileStore } from '../peer/PeerProfile';
import { PeerRpcError } from '../peer/WebSocketPeerTransport';
import { AtomicFileStore, NodeAtomicFileSystem } from '../storage/AtomicFileStore';
import { FileTaskStore } from '../tasks/FileTaskStore';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { LocalBrokerTaskFacade } from '../tools/LocalBrokerTaskFacade';
import { TaskToolFacadeError } from '../tools/taskToolFacade';

const LOCAL_DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const LOCAL_NODE_ID = '00000000-0000-4000-8000-000000000002';
const LOCAL_INSTANCE_ID = '00000000-0000-4000-8000-000000000003';
const RAW_INSTANCE_ID = '00000000-0000-4000-8000-000000000004';
const RAW_NODE_ID = '00000000-0000-4000-8000-000000000005';
const PEER_ID = '00000000-0000-4000-8000-000000000010';
const REMOTE_DEVICE_ID = '00000000-0000-4000-8000-000000000011';
const REMOTE_NODE_ID = '00000000-0000-4000-8000-000000000012';
const REMOTE_INSTANCE_ID = '00000000-0000-4000-8000-000000000013';
const REMOTE_WORKSPACE_ID = '00000000-0000-4000-8000-000000000014';
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000015';
const DELEGATION_ID = '00000000-0000-4000-8000-000000000016';
const INPUT_ID = '00000000-0000-4000-8000-000000000017';
const ANSWER_ID = '00000000-0000-4000-8000-000000000018';
const CREATED_AT = '2026-08-25T12:00:00.000Z';
const DEADLINE = '2026-08-25T13:00:00.000Z';

class MemoryState implements StateStore {
	private readonly values = new Map<string, unknown>();

	public get<T>(key: string): T | undefined {
		const value = this.values.get(key);
		return value === undefined ? undefined : structuredClone(value) as T;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, structuredClone(value));
	}
}

class FakeRemoteConnection {
	public readonly profileId = PEER_ID;
	public readonly methods: string[] = [];
	public startCalls = 0;
	public lastStart: Record<string, unknown> | undefined;
	public answers: Record<string, unknown>[] = [];
	private snapshotValue: TaskSnapshot | undefined;

	public constructor(private readonly state: StateStore) {}

	public snapshot(): { readonly state: 'online' } {
		return { state: 'online' };
	}

	public async request(method: string, params: Record<string, unknown>): Promise<unknown> {
		this.methods.push(method);
		switch (method) {
			case 'device.getInfo':
				return {
					deviceId: REMOTE_DEVICE_ID,
					name: 'Remote Device',
					platform: 'darwin',
					architecture: 'arm64',
					vscodeVersion: '1.103.0',
					extensionVersion: '0.2.0',
					protocolVersion: MESH_PROTOCOL_VERSION,
				};
			case 'node.list':
				return remoteDirectory();
			case 'task.start': {
				this.startCalls += 1;
				this.lastStart = structuredClone(params);
				assert.equal(Object.hasOwn(params, 'sourceNodeId'), false);
				const serializedRoutes = JSON.stringify(
					this.state.get<unknown>(REMOTE_TASK_ROUTE_STATE_KEY),
				);
				assert.match(serializedRoutes, new RegExp(String(params.taskId), 'u'));
				assert.doesNotMatch(serializedRoutes, /prompt|secret|Implement remotely/u);
				const input = params as unknown as RoutedTaskStartParams;
				this.snapshotValue = taskSnapshot(input);
				return this.snapshotValue;
			}
			case 'task.get': {
				const snapshot = this.requireTask(String(params.taskId));
				return params.afterEventSeq === undefined
					? snapshot
					: { ...snapshot, afterEventSeq: params.afterEventSeq };
			}
			case 'task.answer': {
				const current = this.requireTask(String(params.taskId));
				this.answers.push(structuredClone(params));
				const { pendingInput: _pendingInput, ...withoutPendingInput } = current;
				this.snapshotValue = {
					...withoutPendingInput,
					state: 'running',
					updatedAt: '2026-08-25T12:01:00.000Z',
				};
				return this.snapshotValue;
			}
			case 'task.cancel': {
				const current = this.requireTask(String(params.taskId));
				const { pendingInput: _pendingInput, ...withoutPendingInput } = current;
				this.snapshotValue = {
					...withoutPendingInput,
					state: 'cancelled',
					updatedAt: '2026-08-25T12:02:00.000Z',
					cancellationDeadline: '2026-08-25T12:02:30.000Z',
					summary: 'Cancelled.',
				};
				return this.snapshotValue;
			}
			default:
				throw new Error(`Unexpected remote method: ${method}`);
		}
	}

	private requireTask(taskId: string): TaskSnapshot {
		if (this.snapshotValue?.taskId !== taskId) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'Remote task not found.');
		}
		return this.snapshotValue;
	}
}

class TimeoutRemoteConnection extends FakeRemoteConnection {
	public override async request(
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		if (method === 'task.start') {
			this.startCalls += 1;
			throw new Error('Simulated timeout after the task.start send.');
		}
		return super.request(method, params);
	}
}

class FakePeerManager {
	public readonly routedPeerIds: string[] = [];
	public tunnelProviderTouches = 0;

	public constructor(private readonly connection: FakeRemoteConnection) {}

	public listConnections(): readonly FakeRemoteConnection[] {
		return [this.connection];
	}

	public isEnabled(peerId: string): boolean {
		return peerId === PEER_ID;
	}

	public get(peerId: string): FakeRemoteConnection | undefined {
		this.routedPeerIds.push(peerId);
		return peerId === PEER_ID ? this.connection : undefined;
	}
}

class FakeRegistry {
	private readonly nodes = new Map<string, WindowNodeDescriptor>();

	public register(input: NodeRegisterParams, _session: LocalIpcSession): WindowNodeDescriptor {
		const descriptor: WindowNodeDescriptor = {
			...input,
			lastHeartbeatAt: input.startedAt,
			workspaces: [],
		};
		this.nodes.set(input.nodeId, descriptor);
		return descriptor;
	}

	public heartbeat(input: NodeHeartbeatParams): WindowNodeDescriptor {
		const existing = this.nodes.get(input.nodeId);
		if (existing === undefined) {
			throw new MeshDomainError('AGENT_UNAVAILABLE', 'Window Node is unavailable.');
		}
		const descriptor = {
			...existing,
			status: input.status,
			lastHeartbeatAt: input.at,
		};
		this.nodes.set(input.nodeId, descriptor);
		return descriptor;
	}

	public list(): NodeDirectoryResult {
		return {
			deviceId: LOCAL_DEVICE_ID,
			truncated: false,
			totalNodes: this.nodes.size,
			nodes: [...this.nodes.values()],
		};
	}

	public unregister(input: { readonly nodeId: string }): void {
		this.nodes.delete(input.nodeId);
	}

	public assertDelegationPrincipal(): void {}

	public windowDelegationPrincipal(): {
		readonly kind: 'window';
		readonly capability: string;
	} {
		return { kind: 'window', capability: 'w'.repeat(43) };
	}

	public dispose(): void {}
}

class FakeLocalTaskService {
	public getLocal(): Promise<never> {
		return Promise.reject(new MeshDomainError('TASK_NOT_FOUND', 'Local task not found.'));
	}

	public cancelLocal(): Promise<never> {
		return Promise.reject(new MeshDomainError('TASK_NOT_FOUND', 'Local task not found.'));
	}

	public answerLocal(): Promise<never> {
		return Promise.reject(new MeshDomainError('TASK_NOT_FOUND', 'Local task not found.'));
	}

	public async dispose(): Promise<void> {}
}

test('non-owner Window Node multiplexes remote v2 tasks over authenticated local IPC across takeover', async () => {
	const state = new MemoryState();
	const connection = new FakeRemoteConnection(state);
	const peers = new FakePeerManager(connection);
	const profiles = profileStore([remoteProfile()]);
	const identity: LocalIpcIdentity = {
		userIdentity: randomBytes(16),
		deviceId: LOCAL_DEVICE_ID,
		tempDirectory: `.ipc-remote-${randomBytes(6).toString('hex')}`,
	};
	const key = Buffer.alloc(32, 0x6b);
	await mkdir(identity.tempDirectory!, { recursive: true, mode: 0o700 });
	let broker = await createBroker(
		identity,
		key,
		new ProductionRemoteTaskAdapter(
			peers as unknown as PeerConnectionManager,
			profiles,
			state,
			() => new Date(CREATED_AT),
		),
		state,
	);
	const rawClient = new LocalIpcClient({
		identity,
		brokerKey: key,
		clientId: RAW_INSTANCE_ID,
		requestTimeoutMs: 2_000,
	});
	const node = createWindowNode(identity, key);
	const remoteTasks = new LocalIpcRemoteTaskAdapter(node);
	const facade = new LocalBrokerTaskFacade(node, {
		deviceName: 'Local Device',
		remoteAdapter: remoteTasks,
		now: () => new Date(CREATED_AT),
	});

	try {
		const rawSession = await rawClient.connect();
		await assert.rejects(
			rawSession.request('broker.remote.list', {}),
			(error: unknown) => (
				error instanceof LocalIpcRemoteError
				&& error.code === MESH_ERROR_CODES.AUTH_REQUIRED
			),
		);
		await rawSession.request('node.register', {
			nodeId: RAW_NODE_ID,
			nodeInstanceId: RAW_INSTANCE_ID,
			label: 'Raw Window',
			capabilities: ['tasks'],
			status: 'online',
			startedAt: CREATED_AT,
		});
		await assert.rejects(
			rawSession.request('broker.remote.list', { extra: true }),
			(error: unknown) => (
				error instanceof LocalIpcRemoteError
				&& error.code === -32602
			),
		);
		rawClient.dispose();

		await node.start();
		const directory = await facade.listWorkers(new AbortController().signal);
		const remote = directory.devices.find(({ deviceId }) => deviceId === REMOTE_DEVICE_ID);
		assert.equal(remote?.peerId, PEER_ID);
		assert.equal(remote?.nodes[0].nodeId, REMOTE_NODE_ID);
		assert.equal(remote?.nodes[0].workspaces[0].workspaceId, REMOTE_WORKSPACE_ID);

		const persisted = await facade.persistDelegationIntent({
			delegationRequestId: DELEGATION_ID,
			deviceId: REMOTE_DEVICE_ID,
			nodeId: REMOTE_NODE_ID,
			nodeInstanceId: REMOTE_INSTANCE_ID,
			workspaceId: REMOTE_WORKSPACE_ID,
			peerId: PEER_ID,
			title: 'Remote task',
			prompt: 'Implement remotely.',
			acceptanceCriteria: ['Tests pass.'],
			timeoutMinutes: 60,
		});
		assert.equal(connection.startCalls, 1);
		assert.equal(connection.lastStart?.sourceNodeId, undefined);
		assert.equal(connection.lastStart?.timeoutMinutes, 60);
		const notified = new Promise<TaskSnapshot>((resolve) => {
			const registration = node.onTaskSnapshot((snapshot) => {
				registration.dispose();
				resolve(snapshot);
			});
		});
		await broker.reconcileRemoteTaskNotification(
			PEER_ID,
			GATEWAY_NOTIFICATIONS.taskStateChanged,
			{ taskId: persisted.taskId },
		);
		assert.equal((await notified).state, 'needsInput');
		const restoredNotification = new Promise<TaskSnapshot>((resolve) => {
			const registration = node.onTaskSnapshot((snapshot) => {
				registration.dispose();
				resolve(snapshot);
			});
		});
		await broker.reconcileRemoteTasks();
		assert.equal((await restoredNotification).taskId, persisted.taskId);

		const read = await facade.getTask({
			taskId: persisted.taskId,
			afterEventSequence: 0,
			maxEvents: 10,
		}, new AbortController().signal);
		assert.deepStrictEqual(read.events.map(({ type }) => type), [
			'agentStarted',
			'inputRequired',
		]);

		await assert.rejects(
			node.startRemoteTask({
				...(connection.lastStart as unknown as RoutedTaskStartParams),
				target: {
					deviceId: REMOTE_DEVICE_ID,
					nodeId: REMOTE_NODE_ID,
					nodeInstanceId: REMOTE_INSTANCE_ID,
					workspaceId: OTHER_WORKSPACE_ID,
				},
			}, PEER_ID),
			(error: unknown) => (
				error instanceof LocalIpcRemoteError
				&& error.code === MESH_ERROR_CODES.IDEMPOTENCY_CONFLICT
			),
		);
		assert.equal(connection.startCalls, 1);

		await broker.dispose();
		await waitFor(() => node.snapshot().state !== 'online' || !node.snapshot().registered);
		const restoredRemoteTasks = new ProductionRemoteTaskAdapter(
			peers as unknown as PeerConnectionManager,
			profiles,
			state,
			() => new Date(CREATED_AT),
		);
		broker = await createBroker(identity, key, restoredRemoteTasks, state);
		await waitFor(() => node.snapshot().state === 'online' && node.snapshot().registered);

		const restored = await facade.getTask({
			taskId: persisted.taskId,
			maxEvents: 10,
		}, new AbortController().signal);
		assert.equal(restored.snapshot.taskId, persisted.taskId);
		assert.equal(restoredRemoteTasks.listKnownTasks().length, 1);

		const answered = await facade.answerOwnedTask({
			taskId: persisted.taskId,
			inputId: INPUT_ID,
			answerId: ANSWER_ID,
			answer: 'Proceed.',
		}, new AbortController().signal);
		assert.equal(answered.status, 'running');
		assert.equal(connection.answers.length, 1);
		const cancelled = await facade.cancelOwnedTask(
			{ taskId: persisted.taskId },
			new AbortController().signal,
		);
		assert.equal(cancelled.status, 'cancelled');
		const retainedRoute = remoteRoutes(state).find(({ taskId }) => taskId === persisted.taskId);
		assert.equal(retainedRoute?.state, 'cancelled');
		assert.equal(retainedRoute?.terminalAt, '2026-08-25T12:02:00.000Z');

		assert.deepStrictEqual([...new Set(peers.routedPeerIds)], [PEER_ID]);
		assert.equal(peers.tunnelProviderTouches, 0);
		assert.ok(connection.methods.includes('task.start'));
		assert.ok(connection.methods.includes('task.get'));
		assert.ok(connection.methods.includes('task.answer'));
		assert.ok(connection.methods.includes('task.cancel'));
	} finally {
		rawClient.dispose();
		await Promise.allSettled([node.dispose(), broker.dispose()]);
		await rm(identity.tempDirectory!, { recursive: true, force: true });
	}
});

test('continuation crosses local IPC and the production peer gateway into a separately approved target turn', async (t) => {
	const fixture = await createContinuationFixture(t);
	const first = await fixture.facade.persistDelegationIntent(continuationIntent(DELEGATION_ID));
	await waitForTargetTask(fixture, first.taskId, 'running');
	const predecessor = await completeRemoteTask(fixture, first.taskId);
	assert.ok(predecessor.recoveryDescriptor);
	assert.notEqual(fixture.source.broker.taskRoutes.get(first.taskId)?.state, 'completed');

	const intent = continuationIntent(routeUuid(80_001), first.taskId);
	const continued = await fixture.facade.persistDelegationIntent(intent);
	const record = await waitForTargetTask(fixture, continued.taskId, 'running');
	assert.notEqual(continued.taskId, first.taskId);
	assert.notEqual(continued.delegationRequestId, first.delegationRequestId);
	assert.equal(record.schemaVersion, 2);
	assert.equal(record.schemaVersion === 2 && record.continueFromTaskId, first.taskId);
	assert.deepStrictEqual(record.recoveryDescriptor, predecessor.recoveryDescriptor);
	assert.equal(new TaskRouteCatalog(fixture.source.state).get(continued.taskId)?.continueFromTaskId, first.taskId);

	const gatewayStart = fixture.connection.starts[1]!;
	assert.equal(gatewayStart.continueFromTaskId, first.taskId);
	assert.equal(gatewayStart.sourceWorkspaceIdentity, fixture.sourceNode.delegationSourceScopeIdentity());
	for (const field of ['sourceNodeId', 'continuation', 'sessionUri', 'chatUri', 'recoveryDescriptor']) {
		assert.equal(Object.hasOwn(gatewayStart, field), false, field);
	}
	const continuation = {
		sessionUri: predecessor.recoveryDescriptor.sessionId,
		chatUri: predecessor.recoveryDescriptor.conversationId,
	};
	assert.deepStrictEqual(fixture.nodeStarts[1]!.continuation, continuation);
	assert.equal(fixture.nodeStarts[1]!.continueFromTaskId, first.taskId);
	assert.equal(fixture.nodeStarts[1]!.requireEditor, true);
	assert.deepStrictEqual(fixture.runtime.requests[1]!.continuation, continuation);
	assert.equal(fixture.runtime.requests[1]!.requireEditor, true);
	assert.notStrictEqual(
		fixture.runtime.requests[1]!.approvalCapability,
		fixture.runtime.requests[0]!.approvalCapability,
	);
	assert.notEqual(
		fixture.nodeStarts[1]!.delegatedExecutionContext.capability,
		fixture.nodeStarts[0]!.delegatedExecutionContext.capability,
	);
	assert.equal(fixture.confirmations.length, 2);
	assert.equal(fixture.confirmations[1]!.continueFromTaskId, first.taskId);
	assert.equal(record.pendingInput, undefined);
	assert.equal((await fixture.target.store.getOwned(LOCAL_DEVICE_ID, first.taskId))?.eventSeq, predecessor.eventSeq);

	const retried = await fixture.facade.persistDelegationIntent(intent);
	assert.equal(retried.taskId, continued.taskId);
	assert.equal(retried.recovered, true);
	const { continueFromTaskId: _continueFromTaskId, ...withoutContinuation } = intent;
	for (const changed of [
		withoutContinuation,
		{ ...intent, continueFromTaskId: routeUuid(80_002) },
	]) {
		await assert.rejects(
			fixture.facade.persistDelegationIntent(changed),
			(error: unknown) => error instanceof TaskToolFacadeError && error.code === 'IDEMPOTENCY_CONFLICT',
		);
	}
	assert.equal(fixture.connection.startCalls, 2);
	assert.equal(fixture.runtime.requests.length, 2);
	assert.equal(fixture.confirmations.length, 2);

	await completeRemoteTask(fixture, continued.taskId);
	const fresh = await fixture.facade.persistDelegationIntent(continuationIntent(routeUuid(80_003)));
	const freshRecord = await waitForTargetTask(fixture, fresh.taskId, 'running');
	for (const start of [fixture.connection.starts[0]!, fixture.connection.starts[2]!, fixture.nodeStarts[2]!]) {
		assert.equal(Object.hasOwn(start, 'continueFromTaskId'), false);
		assert.equal(Object.hasOwn(start, 'continuation'), false);
	}
	assert.equal(Object.hasOwn(fixture.runtime.requests[2]!, 'continuation'), false);
	assert.notEqual(freshRecord.recoveryDescriptor?.sessionId, predecessor.recoveryDescriptor.sessionId);
	assert.equal(fixture.confirmations.length, 3);
	assert.equal(Object.hasOwn(fixture.confirmations[2]!, 'continueFromTaskId'), false);
	await completeRemoteTask(fixture, fresh.taskId);
});

test('continuation ownership rejects another source window even on the same peer and workspace', async (t) => {
	const fixture = await createContinuationFixture(t);
	const first = await fixture.facade.persistDelegationIntent(continuationIntent(DELEGATION_ID));
	await waitForTargetTask(fixture, first.taskId, 'running');
	await completeRemoteTask(fixture, first.taskId);
	const sourceWorkspaceIdentity = fixture.sourceNode.delegationSourceScopeIdentity();
	const changedScope = {
		...continuationIntent(routeUuid(81_001), first.taskId),
		sourceWorkspaceIdentity: `sha256:${'X'.repeat(43)}`,
	};
	const changedTarget = {
		...continuationIntent(routeUuid(81_002), first.taskId),
		workspaceId: OTHER_WORKSPACE_ID,
	};
	for (const [intent, code] of [
		[changedScope, 'TASK_NOT_FOUND'],
		[changedTarget, 'TASK_RECOVERY_UNAVAILABLE'],
	] as const) {
		await assert.rejects(
			fixture.facade.persistDelegationIntent(intent),
			(error: unknown) => error instanceof TaskToolFacadeError && error.code === code,
		);
		assert.equal(fixture.source.broker.taskRoutes.get(fixture.facade.identifyDelegation(intent).taskId), undefined);
	}

	await fixture.sourceNode.dispose();
	const replacement = await fixture.createSourceWindow(RAW_NODE_ID, RAW_INSTANCE_ID);
	assert.equal(replacement.node.delegationSourceScopeIdentity(), sourceWorkspaceIdentity);
	const intent = continuationIntent(routeUuid(81_003), first.taskId);
	await assert.rejects(
		replacement.facade.persistDelegationIntent(intent),
		(error: unknown) => error instanceof TaskToolFacadeError && error.code === 'TASK_NOT_FOUND',
	);
	assert.equal(fixture.source.broker.taskRoutes.get(replacement.facade.identifyDelegation(intent).taskId), undefined);
	assert.equal(fixture.connection.startCalls, 1);
	assert.equal(remoteRoutes(fixture.source.state).length, 1);
	assert.equal(fixture.runtime.requests.length, 1);
	assert.equal((await fixture.target.store.list()).length, 1);
});

test('continuation retries bind the production remote adapter hash across restoration', async (t) => {
	const fixture = await createContinuationFixture(t);
	const first = await fixture.facade.persistDelegationIntent(continuationIntent(DELEGATION_ID));
	await waitForTargetTask(fixture, first.taskId, 'running');
	await completeRemoteTask(fixture, first.taskId);
	const continued = await fixture.facade.persistDelegationIntent(continuationIntent(routeUuid(82_001), first.taskId));
	await waitForTargetTask(fixture, continued.taskId, 'running');
	await completeRemoteTask(fixture, continued.taskId);
	const restored = new ProductionRemoteTaskAdapter(
		fixture.peers as unknown as PeerConnectionManager,
		profileStore([remoteProfile()]),
		fixture.source.state,
		() => new Date(CREATED_AT),
	);
	const original = fixture.connection.starts[1]!;
	assert.equal((await restored.startTask(original, { peerId: PEER_ID })).taskId, continued.taskId);
	assert.equal(fixture.connection.startCalls, 3);
	const { continueFromTaskId: _continueFromTaskId, ...withoutContinuation } = original;
	for (const changed of [
		withoutContinuation,
		{ ...original, continueFromTaskId: routeUuid(82_002) },
		{ ...fixture.connection.starts[0]!, continueFromTaskId: continued.taskId },
	]) {
		await assert.rejects(
			restored.startTask(changed, { peerId: PEER_ID }),
			(error: unknown) => error instanceof MeshDomainError && error.reason === 'IDEMPOTENCY_CONFLICT',
		);
	}
	assert.equal(fixture.connection.startCalls, 3);
	assert.equal((await restored.startTask(fixture.connection.starts[0]!, { peerId: PEER_ID })).taskId, first.taskId);
	assert.equal(Object.hasOwn(fixture.connection.starts[3]!, 'continueFromTaskId'), false);
	assert.equal(fixture.runtime.requests.length, 2);
	assert.equal(fixture.confirmations.length, 2);
	assert.equal(remoteRoutes(fixture.source.state).length, 2);
});

test('continuation requires authoritative target completion despite a completed source cache', async (t) => {
	const fixture = await createContinuationFixture(t);
	const first = await fixture.facade.persistDelegationIntent(continuationIntent(DELEGATION_ID));
	await waitForTargetTask(fixture, first.taskId, 'running');
	const running = await fixture.target.service.get(LOCAL_DEVICE_ID, first.taskId);
	await fixture.source.broker.taskRoutes.markSnapshot({ ...running, state: 'completed' });

	const intent = continuationIntent(routeUuid(83_001), first.taskId);
	await assert.rejects(
		fixture.facade.persistDelegationIntent(intent),
		(error: unknown) => error instanceof TaskToolFacadeError && error.code === 'TASK_RECOVERY_UNAVAILABLE',
	);
	const taskId = fixture.facade.identifyDelegation(intent).taskId;
	assert.equal(fixture.source.broker.taskRoutes.get(first.taskId)?.state, 'completed');
	assert.equal((await fixture.target.store.getOwned(LOCAL_DEVICE_ID, first.taskId))?.state, 'running');
	assert.equal(await fixture.target.store.getOwned(LOCAL_DEVICE_ID, taskId), undefined);
	assert.equal(fixture.target.broker.taskRoutes.get(taskId), undefined);
	assert.equal(fixture.connection.startCalls, 2);
	assert.equal(fixture.connection.starts[1]!.continueFromTaskId, first.taskId);
	assert.equal(fixture.runtime.requests.length, 1);
	assert.equal(fixture.confirmations.length, 1);
	await completeRemoteTask(fixture, first.taskId);
});

test('continuation descriptors cannot be injected over authenticated local IPC', async (t) => {
	const fixture = await createContinuationFixture(t);
	const client = new LocalIpcClient({
		identity: fixture.source.identity,
		brokerKey: fixture.key,
		clientId: RAW_INSTANCE_ID,
		requestTimeoutMs: 2_000,
	});
	t.after(() => client.dispose());
	const session = await client.connect();
	const registration = nodeRegistrationResultSchema.parse(await session.request(LOCAL_BROKER_METHODS.register, {
		nodeId: RAW_NODE_ID,
		nodeInstanceId: RAW_INSTANCE_ID,
		label: 'Raw source',
		capabilities: ['tasks'],
		status: 'online',
		startedAt: CREATED_AT,
	}));
	const input = {
		...remoteStartParams(routeUuid(84_001), routeUuid(84_002)),
		continueFromTaskId: routeUuid(84_003),
		sourceNodeId: RAW_NODE_ID,
		delegationPrincipal: registration.delegationPrincipal,
	};
	for (const injected of [
		{ continuation: { sessionUri: 'retained-session', chatUri: 'retained-chat' } },
		{ sessionUri: 'retained-session' },
		{ chatUri: 'retained-chat' },
		{ sessionId: 'retained-session' },
		{ conversationId: 'retained-chat' },
		{ recoveryDescriptor: { adapter: 'ahp', sessionId: 'retained-session', conversationId: 'retained-chat' } },
	]) {
		for (const method of [LOCAL_BROKER_METHODS.taskStart, LOCAL_BROKER_METHODS.remoteTaskStart]) {
			await assert.rejects(
				session.request(method, JSON.parse(JSON.stringify({
					...input,
					...(method === LOCAL_BROKER_METHODS.remoteTaskStart ? { peerId: PEER_ID } : {}),
					...injected,
				}))),
				(error: unknown) => error instanceof LocalIpcRemoteError && error.code === -32602,
			);
		}
	}
	assert.equal(fixture.source.broker.taskRoutes.get(input.taskId), undefined);
	assert.equal(remoteRoutes(fixture.source.state).length, 0);
	assert.equal(fixture.connection.startCalls, 0);
	assert.equal(fixture.runtime.requests.length, 0);
});

test('remote route catalog rejects unknown and corrupt persisted versions', async () => {
	const profiles = profileStore([]);
	const emptyManager = {
		listConnections: () => [],
		isEnabled: () => false,
		get: () => undefined,
	} as unknown as PeerConnectionManager;
	const unknown = new MemoryState();
	await unknown.update(REMOTE_TASK_ROUTE_STATE_KEY, {
		schemaVersion: 3,
		routes: [],
	});

	assert.throws(
		() => new ProductionRemoteTaskAdapter(emptyManager, profiles, unknown),
		/Invalid persisted remote task route catalog/u,
	);

	const corrupt = new MemoryState();
	await corrupt.update(REMOTE_TASK_ROUTE_STATE_KEY, {
		schemaVersion: 2,
		routes: [{
			taskId: 'not-a-uuid',
			delegationRequestId: DELEGATION_ID,
			peerId: PEER_ID,
			target: {
				deviceId: REMOTE_DEVICE_ID,
				nodeId: REMOTE_NODE_ID,
				nodeInstanceId: REMOTE_INSTANCE_ID,
				workspaceId: REMOTE_WORKSPACE_ID,
			},
			createdAt: CREATED_AT,
			prompt: 'must never be persisted',
		}],
	});
	assert.throws(
		() => new ProductionRemoteTaskAdapter(emptyManager, profiles, corrupt),
		/Invalid persisted remote task route catalog/u,
	);
});

test('remote route capacity prunes oldest terminal tombstones and rejects active saturation', async () => {
	const terminalState = new MemoryState();
	await terminalState.update(REMOTE_TASK_ROUTE_STATE_KEY, remoteRouteState('completed'));
	const terminalConnection = new FakeRemoteConnection(terminalState);
	const terminalAdapter = new ProductionRemoteTaskAdapter(
		new FakePeerManager(terminalConnection) as unknown as PeerConnectionManager,
		profileStore([remoteProfile()]),
		terminalState,
		() => new Date(CREATED_AT),
	);
	const newTaskId = routeUuid(10_000);
	await terminalAdapter.startTask(
		remoteStartParams(newTaskId, routeUuid(11_000)),
		{ peerId: PEER_ID },
	);
	const retained = remoteRoutes(terminalState);
	assert.equal(retained.length, 1_000);
	assert.equal(retained.some(({ taskId }) => taskId === routeUuid(1_000)), false);
	assert.equal(retained.some(({ taskId }) => taskId === newTaskId), true);
	assert.equal(terminalConnection.startCalls, 1);

	const activeState = new MemoryState();
	await activeState.update(REMOTE_TASK_ROUTE_STATE_KEY, remoteRouteState('running'));
	const activeConnection = new FakeRemoteConnection(activeState);
	const activeAdapter = new ProductionRemoteTaskAdapter(
		new FakePeerManager(activeConnection) as unknown as PeerConnectionManager,
		profileStore([remoteProfile()]),
		activeState,
		() => new Date(CREATED_AT),
	);
	await assert.rejects(
		activeAdapter.startTask(
			remoteStartParams(routeUuid(12_000), routeUuid(13_000)),
			{ peerId: PEER_ID },
		),
		(error: unknown) =>
			error instanceof MeshDomainError && error.reason === 'RATE_LIMITED',
	);
	assert.equal(activeConnection.startCalls, 0);
	assert.equal(remoteRoutes(activeState).length, 1_000);
});

test('more than one thousand offline and mismatched remote starts do not consume route capacity', async () => {
	const offlineState = new MemoryState();
	const offlineManager = {
		listConnections: () => [],
		isEnabled: () => false,
		get: () => undefined,
	} as unknown as PeerConnectionManager;
	const offlineAdapter = new ProductionRemoteTaskAdapter(
		offlineManager,
		profileStore([remoteProfile()]),
		offlineState,
		() => new Date(CREATED_AT),
	);
	for (let index = 0; index < 1_001; index += 1) {
		await assert.rejects(
			offlineAdapter.startTask(
				remoteStartParams(routeUuid(20_000 + index), routeUuid(30_000 + index)),
				{ peerId: PEER_ID },
			),
			(error: unknown) =>
				error instanceof MeshDomainError && error.reason === 'TUNNEL_UNAVAILABLE',
		);
	}
	assert.equal(remoteRoutes(offlineState).length, 0);

	const state = new MemoryState();
	const connection = new FakeRemoteConnection(state);
	const identity: LocalIpcIdentity = {
		userIdentity: randomBytes(16),
		deviceId: LOCAL_DEVICE_ID,
		tempDirectory: `.ipc-invalid-remote-${randomBytes(6).toString('hex')}`,
	};
	const key = Buffer.alloc(32, 0x6c);
	await mkdir(identity.tempDirectory!, { recursive: true, mode: 0o700 });
	const broker = await createBroker(
		identity,
		key,
		new ProductionRemoteTaskAdapter(
			new FakePeerManager(connection) as unknown as PeerConnectionManager,
			profileStore([remoteProfile()]),
			state,
			() => new Date(CREATED_AT),
		),
		state,
	);
	const node = createWindowNode(identity, key);
	try {
		await node.start();
		for (let index = 0; index < 1_001; index += 1) {
			const invalid = remoteStartParams(
				routeUuid(40_000 + index),
				routeUuid(50_000 + index),
			);
			await assert.rejects(node.startRemoteTask({
				...invalid,
				target: { ...invalid.target, deviceId: LOCAL_DEVICE_ID },
			}, PEER_ID));
		}
		assert.equal(remoteRoutes(state).length, 0);
		assert.equal(broker.taskRoutes.get(routeUuid(40_000)), undefined);

		const valid = remoteStartParams(routeUuid(60_000), routeUuid(60_001));
		const snapshot = await node.startRemoteTask(valid, PEER_ID);
		assert.equal(snapshot.taskId, valid.taskId);
		assert.equal(connection.startCalls, 1);
		assert.equal(remoteRoutes(state).length, 1);
	} finally {
		await Promise.allSettled([node.dispose(), broker.dispose()]);
		await rm(identity.tempDirectory!, { recursive: true, force: true });
	}
});

test('a post-send remote timeout retains ambiguity and changed retries conflict', async () => {
	const state = new MemoryState();
	const connection = new TimeoutRemoteConnection(state);
	const identity: LocalIpcIdentity = {
		userIdentity: randomBytes(16),
		deviceId: LOCAL_DEVICE_ID,
		tempDirectory: `.ipc-timeout-remote-${randomBytes(6).toString('hex')}`,
	};
	const key = Buffer.alloc(32, 0x6d);
	await mkdir(identity.tempDirectory!, { recursive: true, mode: 0o700 });
	const broker = await createBroker(
		identity,
		key,
		new ProductionRemoteTaskAdapter(
			new FakePeerManager(connection) as unknown as PeerConnectionManager,
			profileStore([remoteProfile()]),
			state,
			() => new Date(CREATED_AT),
		),
		state,
	);
	const node = createWindowNode(identity, key);
	const input = remoteStartParams(routeUuid(70_000), routeUuid(70_001));
	try {
		await node.start();
		await assert.rejects(node.startRemoteTask(input, PEER_ID));
		assert.equal(connection.startCalls, 1);
		assert.equal(remoteRoutes(state)[0]?.state, 'ambiguous');
		assert.equal(broker.taskRoutes.get(input.taskId)?.state, 'ambiguous');

		await assert.rejects(
			node.startRemoteTask({ ...input, prompt: 'Changed retry payload.' }, PEER_ID),
			(error: unknown) =>
				error instanceof LocalIpcRemoteError
				&& error.code === MESH_ERROR_CODES.IDEMPOTENCY_CONFLICT,
		);
		assert.equal(connection.startCalls, 1);
		assert.equal(remoteRoutes(state).length, 1);
		assert.equal(broker.taskRoutes.get(input.taskId)?.state, 'ambiguous');
	} finally {
		await Promise.allSettled([node.dispose(), broker.dispose()]);
		await rm(identity.tempDirectory!, { recursive: true, force: true });
	}
});

test('valid persisted v1 peer identity remains visible without treating its directory as v2', async () => {
	const legacyProfile: PeerProfile = {
		id: PEER_ID,
		rpcEndpoint: 'wss://legacy.example/rpc',
		workerDeviceId: REMOTE_DEVICE_ID,
	};
	const legacyConnection = {
		profileId: PEER_ID,
		snapshot: () => ({ state: 'online' }),
		request: async (method: string): Promise<unknown> => method === 'device.getInfo'
			? {
				deviceId: REMOTE_DEVICE_ID,
				name: 'Legacy Device',
				platform: 'darwin',
				architecture: 'arm64',
				vscodeVersion: '1.90.0',
				extensionVersion: '0.1.0',
				protocolVersion: 1,
			}
			: { workspaces: [{ workspaceId: REMOTE_WORKSPACE_ID }] },
	};
	const manager = {
		listConnections: () => [legacyConnection],
		isEnabled: () => true,
		get: () => legacyConnection,
	} as unknown as PeerConnectionManager;
	const adapter = new ProductionRemoteTaskAdapter(
		manager,
		profileStore([legacyProfile]),
		new MemoryState(),
	);

	const directory = await adapter.listDevices(new AbortController().signal);

	assert.deepStrictEqual(directory, {
		devices: [{
			deviceId: REMOTE_DEVICE_ID,
			deviceName: REMOTE_DEVICE_ID,
			locality: 'remote',
			status: 'incompatible',
			peerId: PEER_ID,
			nodesTruncated: false,
			totalNodes: 0,
			nodes: [],
		}],
		truncated: false,
		totalDevices: 1,
	});
});

class GatewayRemoteConnection extends FakeRemoteConnection {
	public readonly starts: RoutedTaskStartParams[] = [];

	public constructor(state: StateStore, private readonly router: GatewayRouter) {
		super(state);
	}

	public override async request(method: string, params: Record<string, unknown>): Promise<unknown> {
		this.methods.push(method);
		const wire = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
		if (method === 'task.start') {
			this.startCalls += 1;
			this.lastStart = wire;
			this.starts.push(routedTaskStartParamsSchema.parse(wire));
		}
		try {
			return JSON.parse(JSON.stringify(await this.router.dispatch(LOCAL_DEVICE_ID, method, wire)));
		} catch (error: unknown) {
			if (error instanceof MeshDomainError) {
				throw new PeerRpcError(error.reason, error.retryable, error.message);
			}
			throw error;
		}
	}
}

class ContinuationHandle implements AgentTaskHandle {
	public readonly events = createAgentRuntimeEventQueue();
	public readonly recovery;

	public constructor(public readonly taskId: string, request: AgentTaskRequest) {
		this.recovery = {
			clientId: `client-${taskId}`,
			sessionUri: request.continuation?.sessionUri ?? `copilotcli:/${taskId}`,
			chatUri: request.continuation?.chatUri ?? `ahp-chat:/${taskId}`,
			lastSeenServerSeq: 1,
		};
	}

	public async cancel(): Promise<void> {}
	public async answer(): Promise<void> {}
	public async dispose(): Promise<void> {
		this.events.close();
	}
}

class ContinuationRuntime implements AgentRuntime {
	public readonly requests: AgentTaskRequest[] = [];
	public readonly handles: ContinuationHandle[] = [];

	public async probe(): Promise<AgentRuntimeProbe> {
		return { available: true, featureEnabled: true };
	}

	public async start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		this.requests.push(request);
		const handle = new ContinuationHandle(request.taskId, request);
		this.handles.push(handle);
		return handle;
	}

	public async dispose(): Promise<void> {}
}

interface RoutingBrokerFixture {
	readonly broker: DeviceBroker;
	readonly service: BrokerTaskService;
	readonly store: FileTaskStore;
	readonly identity: LocalIpcIdentity;
	readonly state: MemoryState;
}

interface ContinuationFixture {
	readonly source: RoutingBrokerFixture;
	readonly target: RoutingBrokerFixture;
	readonly sourceNode: WindowNodeClient;
	readonly facade: LocalBrokerTaskFacade;
	readonly key: Buffer;
	readonly connection: GatewayRemoteConnection;
	readonly peers: FakePeerManager;
	readonly runtime: ContinuationRuntime;
	readonly nodeStarts: NodeTaskStartParams[];
	readonly confirmations: WindowNodeTaskConfirmationRequest[];
	createSourceWindow(nodeId: string, nodeInstanceId: string): Promise<{
		readonly node: WindowNodeClient;
		readonly facade: LocalBrokerTaskFacade;
	}>;
}

async function createContinuationFixture(t: TestContext): Promise<ContinuationFixture> {
	const root = `.ipc-continuation-${randomBytes(6).toString('hex')}`;
	const nodes: WindowNodeClient[] = [];
	const brokers: DeviceBroker[] = [];
	await mkdir(root, { mode: 0o700 });
	t.after(async () => {
		const results = [
			...await Promise.allSettled(nodes.map((node) => node.dispose())),
			...await Promise.allSettled(brokers.map((broker) => broker.dispose())),
		];
		await rm(root, { recursive: true, force: true });
		assert.deepStrictEqual(results.filter((result) => result.status === 'rejected'), []);
	});
	const key = Buffer.alloc(32, 0x6e);
	const clock = { now: () => new Date(CREATED_AT) };
	const workspaceSource = {
		list: () => [{
			localUri: pathToFileURL(process.cwd()).href,
			name: 'Repository',
			capabilityTags: ['typescript'],
		}],
	};
	const createRoutingBroker = async (
		deviceId: string,
		workspaceId: string,
		directory: string,
		state: MemoryState,
		remoteTasks?: ProductionRemoteTaskAdapter,
	): Promise<RoutingBrokerFixture> => {
		const identity: LocalIpcIdentity = {
			userIdentity: randomBytes(16),
			deviceId,
			tempDirectory: join(root, directory),
		};
		await mkdir(identity.tempDirectory!, { mode: 0o700 });
		const store = new FileTaskStore(
			new AtomicFileStore(identity.tempDirectory!, new NodeAtomicFileSystem(), { next: randomUUID }),
			clock,
		);
		const registry = await NodeRegistry.create({
			deviceId,
			state,
			ids: { next: () => workspaceId },
			clock,
			workspaceLeases: new WorkspaceLeaseManager(),
			scheduler: { repeat: () => ({ dispose: () => undefined }) },
		});
		const service = new BrokerTaskService(deviceId, registry, store, clock);
		await service.initialize();
		const broker = await createBroker(identity, key, remoteTasks, state, { registry, taskService: service });
		brokers.push(broker);
		return { broker, service, store, identity, state };
	};

	const target = await createRoutingBroker(REMOTE_DEVICE_ID, REMOTE_WORKSPACE_ID, 'target', new MemoryState());
	const runtime = new ContinuationRuntime();
	const nodeStarts: NodeTaskStartParams[] = [];
	const confirmations: WindowNodeTaskConfirmationRequest[] = [];
	const targetNode = createWindowNode(target.identity, key, {
		nodeId: REMOTE_NODE_ID,
		nodeInstanceId: REMOTE_INSTANCE_ID,
		label: 'Target Window',
		workspaceSource,
		clock,
		executor: ({ workspaceResolver, eventSink }) => {
			const executor = new WindowNodeTaskExecutor({
				nodeId: REMOTE_NODE_ID,
				nodeInstanceId: REMOTE_INSTANCE_ID,
				nodeLabel: 'Target Window',
				runtime,
				workspaceResolver,
				eventSink,
				confirmationHost: {
					confirm: async (request) => {
						confirmations.push(request);
						return 'once';
					},
				},
				approvalCapabilities: new AgentRuntimeApprovalCapabilityIssuer(),
				ids: { next: randomUUID },
				clock,
			});
			return {
				start: (input) => {
					nodeStarts.push(structuredClone(input));
					return executor.start(input);
				},
				answer: (input) => executor.answer(input),
				cancel: (input) => executor.cancel(input),
				disposeTask: (input) => executor.disposeTask(input),
				dispose: () => executor.dispose(),
			};
		},
	});
	nodes.push(targetNode);
	await targetNode.start();

	const state = new MemoryState();
	// Only the peer transport and Agent host are simulated; both brokers, IPC hops,
	// the gateway, the durable task store, and the target executor are production code.
	const connection = new GatewayRemoteConnection(state, new GatewayRouter({
		getInfo: async () => ({
			deviceId: REMOTE_DEVICE_ID,
			name: 'Target Device',
			platform: 'darwin',
			architecture: 'arm64',
			vscodeVersion: '1.103.0',
			extensionVersion: '0.2.0',
			protocolVersion: MESH_PROTOCOL_VERSION,
		}),
	}, target.broker));
	const peers = new FakePeerManager(connection);
	const remoteTasks = new ProductionRemoteTaskAdapter(
		peers as unknown as PeerConnectionManager,
		profileStore([remoteProfile()]),
		state,
		clock.now,
	);
	const source = await createRoutingBroker(LOCAL_DEVICE_ID, routeUuid(85_000), 'source', state, remoteTasks);
	const createSourceWindow = async (nodeId: string, nodeInstanceId: string) => {
		const node = createWindowNode(source.identity, key, { nodeId, nodeInstanceId, workspaceSource, clock });
		nodes.push(node);
		await node.start();
		const facade = new LocalBrokerTaskFacade(node, {
			deviceName: 'Source Device',
			remoteAdapter: new LocalIpcRemoteTaskAdapter(node),
			sourceWorkspaceIdentity: () => node.delegationSourceScopeIdentity(),
			now: clock.now,
		});
		return { node, facade };
	};
	const sourceWindow = await createSourceWindow(LOCAL_NODE_ID, LOCAL_INSTANCE_ID);
	return {
		source,
		target,
		sourceNode: sourceWindow.node,
		facade: sourceWindow.facade,
		key,
		connection,
		peers,
		runtime,
		nodeStarts,
		confirmations,
		createSourceWindow,
	};
}

function continuationIntent(delegationRequestId: string, continueFromTaskId?: string): DelegationIntentInput {
	return {
		delegationRequestId,
		...(continueFromTaskId === undefined ? {} : { continueFromTaskId }),
		deviceId: REMOTE_DEVICE_ID,
		nodeId: REMOTE_NODE_ID,
		nodeInstanceId: REMOTE_INSTANCE_ID,
		workspaceId: REMOTE_WORKSPACE_ID,
		peerId: PEER_ID,
		title: 'Continue remote work',
		prompt: 'Implement the next change.',
		acceptanceCriteria: ['Tests pass.'],
		timeoutMinutes: 60,
	};
}

async function waitForTargetTask(
	fixture: ContinuationFixture,
	taskId: string,
	state: TaskSnapshot['state'],
): Promise<TaskRecord> {
	const deadline = Date.now() + 2_000;
	let record: TaskRecord | undefined;
	do {
		record = await fixture.target.store.getOwned(LOCAL_DEVICE_ID, taskId);
		if (record?.state === state) {
			return record;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	} while (Date.now() < deadline);
	assert.fail(`Task ${taskId} did not reach ${state}; last state: ${record?.state}; failure: ${record?.failure?.code}`);
}

async function completeRemoteTask(fixture: ContinuationFixture, taskId: string): Promise<TaskRecord> {
	const handle = fixture.runtime.handles.find((candidate) => candidate.taskId === taskId);
	assert.ok(handle);
	await handle.events.push({ type: 'completed' });
	return waitForTargetTask(fixture, taskId, 'completed');
}

async function createBroker(
	identity: LocalIpcIdentity,
	key: Buffer,
	remoteTasks: ProductionRemoteTaskAdapter | undefined,
	state: StateStore,
	services?: { readonly registry: NodeRegistry; readonly taskService: BrokerTaskService },
): Promise<DeviceBroker> {
	const registry = services?.registry ?? new FakeRegistry() as unknown as NodeRegistry;
	const broker = new DeviceBroker({
		identity,
		brokerKey: key,
		ownership: {
			isOwner: () => true,
			currentGeneration: () => 'generation',
			snapshot: () => ({ owner: true, instanceId: 'owner' }),
			assertOwner: () => Promise.resolve(),
			contend: () => Promise.resolve(true),
			onDidLoseOwnership: () => ({ dispose: () => undefined }),
			dispose: () => Promise.resolve(),
		},
		registry,
		peerPolicies: {
			listAuthorized: () => registry.list(),
			onDidChange: () => ({ dispose: () => undefined }),
		} as unknown as PeerPolicyService,
		taskService: services?.taskService ?? new FakeLocalTaskService() as unknown as BrokerTaskService,
		remoteTaskService: remoteTasks,
		taskRoutes: new TaskRouteCatalog(state, () => new Date(CREATED_AT)),
		requestTimeoutMs: 2_000,
	});
	await broker.start();
	return broker;
}

function createWindowNode(
	identity: LocalIpcIdentity,
	key: Buffer,
	options: Partial<WindowNodeClientOptions> = {},
): WindowNodeClient {
	return new WindowNodeClient({
		nodeId: LOCAL_NODE_ID,
		nodeInstanceId: LOCAL_INSTANCE_ID,
		label: 'Non-owner Window',
		capabilities: ['tasks'],
		identity,
		brokerKey: key,
		executor: () => ({
			start: () => Promise.reject(new Error('Local execution is not expected.')),
			cancel: () => Promise.reject(new Error('Local execution is not expected.')),
			answer: () => Promise.reject(new Error('Local execution is not expected.')),
			dispose: () => Promise.resolve(),
		}),
		workspaceSource: { list: () => [] },
		heartbeatIntervalMs: 10_000,
		backoff: {
			initialDelayMs: 5,
			maxDelayMs: 20,
			jitterRatio: 0,
		},
		requestTimeoutMs: 2_000,
		...options,
	});
}

function profileStore(profiles: readonly PeerProfile[]): PeerProfileStore {
	return {
		get: async (id) => profiles.find((profile) => profile.id === id),
		list: async () => profiles,
		store: async () => undefined,
		delete: async () => false,
	};
}

function remoteProfile(): PeerProfile {
	return {
		id: PEER_ID,
		rpcEndpoint: 'wss://remote.example/rpc',
		workerDeviceId: REMOTE_DEVICE_ID,
	};
}

function remoteDirectory(): NodeDirectoryResult {
	return {
		deviceId: REMOTE_DEVICE_ID,
		truncated: false,
		totalNodes: 1,
		nodes: [{
			nodeId: REMOTE_NODE_ID,
			nodeInstanceId: REMOTE_INSTANCE_ID,
			label: 'Remote Window',
			status: 'online',
			capabilities: ['tasks'],
			startedAt: CREATED_AT,
			lastHeartbeatAt: CREATED_AT,
			workspaces: [{
				workspaceId: REMOTE_WORKSPACE_ID,
				workspaceIdentity: `sha256:${'R'.repeat(43)}`,
				name: 'Remote Workspace',
				capabilityTags: ['typescript'],
				enabled: true,
				busy: false,
				acceptsIncoming: false,
				claimStatus: 'claimed',
			}],
		}],
	};
}

function taskSnapshot(input: RoutedTaskStartParams): TaskSnapshot {
	return {
		schemaVersion: 2,
		taskId: input.taskId,
		delegationRequestId: input.delegationRequestId,
		requestHash: 'a'.repeat(64),
		peerId: LOCAL_DEVICE_ID,
		workspaceId: input.target.workspaceId,
		title: input.title,
		state: 'needsInput',
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		eventSeq: 2,
		workerDeadline: input.workerDeadline,
		pendingInput: {
			inputId: INPUT_ID,
			prompt: 'Continue?',
		},
		events: [{
			eventSeq: 1,
			at: CREATED_AT,
			type: 'agentStarted',
			summary: 'Started.',
		}, {
			eventSeq: 2,
			at: CREATED_AT,
			type: 'inputRequired',
			summary: 'Continue?',
		}],
		eventsTruncated: false,
		deviceId: REMOTE_DEVICE_ID,
	};
}

function remoteStartParams(taskId: string, delegationRequestId: string): RoutedTaskStartParams {
	return {
		delegationRequestId,
		taskId,
		target: {
			deviceId: REMOTE_DEVICE_ID,
			nodeId: REMOTE_NODE_ID,
			nodeInstanceId: REMOTE_INSTANCE_ID,
			workspaceId: REMOTE_WORKSPACE_ID,
		},
		title: 'Bounded route',
		prompt: 'Run the bounded task.',
		acceptanceCriteria: [],
		workerDeadline: DEADLINE,
	};
}

function remoteRouteState(state: 'completed' | 'running'): unknown {
	return {
		schemaVersion: 2,
		routes: Array.from({ length: 1_000 }, (_, index) => ({
			taskId: routeUuid(index + 1_000),
			delegationRequestId: routeUuid(index + 3_000),
			peerId: PEER_ID,
			target: {
				deviceId: REMOTE_DEVICE_ID,
				nodeId: REMOTE_NODE_ID,
				nodeInstanceId: REMOTE_INSTANCE_ID,
				workspaceId: REMOTE_WORKSPACE_ID,
			},
			createdAt: new Date(Date.parse(CREATED_AT) + index).toISOString(),
			state,
			...(state === 'completed'
				? { terminalAt: new Date(Date.parse(CREATED_AT) + index).toISOString() }
				: {}),
		})),
	};
}

function remoteRoutes(state: MemoryState): Array<{
	readonly taskId: string;
	readonly state?: string;
	readonly terminalAt?: string;
}> {
	return (state.get(REMOTE_TASK_ROUTE_STATE_KEY) as {
		readonly routes: Array<{
			readonly taskId: string;
			readonly state?: string;
			readonly terminalAt?: string;
		}>;
	} | undefined)?.routes ?? [];
}

function routeUuid(index: number): string {
	return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for Window Node reconnection.');
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
