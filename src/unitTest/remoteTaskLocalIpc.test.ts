import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { test } from 'node:test';

import {
	GATEWAY_NOTIFICATIONS,
	MESH_ERROR_CODES,
	MESH_PROTOCOL_VERSION,
	type NodeDirectoryResult,
	type NodeHeartbeatParams,
	type NodeRegisterParams,
	type RoutedTaskStartParams,
	type TaskSnapshot,
	type WindowNodeDescriptor,
} from '../../shared/protocol';
import {
	DeviceBroker,
	TaskRouteCatalog,
	type BrokerTaskService,
	type NodeRegistry,
	type PeerPolicyService,
} from '../broker';
import {
	ProductionRemoteTaskAdapter,
	REMOTE_TASK_ROUTE_STATE_KEY,
} from '../composition/ProductionRemoteTaskAdapter';
import { MeshDomainError } from '../domain/errors';
import type { StateStore } from '../domain/ports';
import {
	LocalIpcClient,
	LocalIpcRemoteError,
	type LocalIpcIdentity,
	type LocalIpcSession,
} from '../ipc';
import {
	LocalIpcRemoteTaskAdapter,
	WindowNodeClient,
} from '../node';
import type { PeerConnectionManager } from '../peer/PeerConnectionManager';
import type { PeerProfile, PeerProfileStore } from '../peer/PeerProfile';
import { LocalBrokerTaskFacade } from '../tools/LocalBrokerTaskFacade';

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

async function createBroker(
	identity: LocalIpcIdentity,
	key: Buffer,
	remoteTasks: ProductionRemoteTaskAdapter,
	state: StateStore,
): Promise<DeviceBroker> {
	const registry = new FakeRegistry() as unknown as NodeRegistry;
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
		taskService: new FakeLocalTaskService() as unknown as BrokerTaskService,
		remoteTaskService: remoteTasks,
		taskRoutes: new TaskRouteCatalog(state, () => new Date(CREATED_AT)),
		requestTimeoutMs: 2_000,
	});
	await broker.start();
	return broker;
}

function createWindowNode(identity: LocalIpcIdentity, key: Buffer): WindowNodeClient {
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
