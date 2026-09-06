import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import type {
	NodeRegisterParams,
	RoutedTaskStartParams,
	TaskSnapshot,
	TaskSnapshotAfterEventSeq,
} from '../../shared/protocol';
import {
	JSON_RPC_ERROR_CODES,
	LOCAL_BROKER_METHODS,
	MESH_ERROR_CODES,
} from '../../shared/protocol';
import {
	AgentRuntimeApprovalCapabilityIssuer,
	createAgentRuntimeEventQueue,
	type AgentRuntime,
	type AgentRuntimeEvent,
	type AgentRuntimeProbe,
	type AgentTaskAnswer,
	type AgentTaskHandle,
	type AgentTaskRequest,
} from '../agentHost/AgentRuntime';
import {
	BrokerTaskService,
	DeviceBroker,
	NodeRegistry,
	TaskRouteCatalog,
	type PeerPolicyService,
	type NodeTaskBinding,
	type RegistryScheduler,
} from '../broker';
import type { StateStore } from '../domain/ports';
import {
	LocalIpcClient,
	LocalIpcRemoteError,
	type LocalIpcIdentity,
} from '../ipc';
import {
	AtomicFileStore,
	type AtomicFileSystem,
} from '../storage/AtomicFileStore';
import { FileTaskStore } from '../tasks/FileTaskStore';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import {
	WindowNodeClient,
	WindowNodeTaskExecutor,
	type WindowNodeTaskConfirmationRequest,
} from '../node';
import type { RemoteTaskRouteAdapter } from '../tools/LocalBrokerTaskFacade';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const NODE_A = '00000000-0000-4000-8000-000000000002';
const NODE_B = '00000000-0000-4000-8000-000000000003';
const INSTANCE_A = '00000000-0000-4000-8000-000000000004';
const INSTANCE_B = '00000000-0000-4000-8000-000000000005';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000006';
const REMOTE_DEVICE_ID = '00000000-0000-4000-8000-000000000101';
const REMOTE_NODE_ID = '00000000-0000-4000-8000-000000000102';
const REMOTE_INSTANCE_ID = '00000000-0000-4000-8000-000000000103';
const REMOTE_WORKSPACE_ID = '00000000-0000-4000-8000-000000000104';
const REMOTE_PEER_ID = '00000000-0000-4000-8000-000000000105';
const OWNED_LOCAL_ACTIVE_TASK = '00000000-0000-4000-8000-000000000010';
const OWNED_LOCAL_TERMINAL_TASK = '00000000-0000-4000-8000-000000000020';
const OWNED_REMOTE_AMBIGUOUS_TASK = '00000000-0000-4000-8000-000000000030';
const OWNED_REMOTE_TASK = '00000000-0000-4000-8000-000000000040';
const FOREIGN_REMOTE_TASK = '00000000-0000-4000-8000-000000000050';
const INCOMING_TASK = '00000000-0000-4000-8000-000000000060';
const DELEGATION_1 = '00000000-0000-4000-8000-000000000201';
const DELEGATION_2 = '00000000-0000-4000-8000-000000000202';
const DELEGATION_3 = '00000000-0000-4000-8000-000000000203';
const DELEGATION_4 = '00000000-0000-4000-8000-000000000204';
const DELEGATION_5 = '00000000-0000-4000-8000-000000000205';
const DELEGATION_6 = '00000000-0000-4000-8000-000000000206';
const DEADLINE = '2030-01-01T00:00:00.000Z';

class MemoryState implements StateStore {
	private readonly values = new Map<string, unknown>();

	public get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, structuredClone(value));
	}
}

class MemoryFileSystem implements AtomicFileSystem {
	private readonly files = new Map<string, string>();
	private readonly directories = new Set(['memory']);

	public async mkdir(path: string): Promise<boolean> {
		if (this.directories.has(path)) {
			return false;
		}
		this.directories.add(path);
		return true;
	}

	public async readFile(path: string): Promise<string> {
		const value = this.files.get(path);
		if (value === undefined) {
			throw notFound();
		}
		return value;
	}

	public async writeFile(path: string, contents: string): Promise<void> {
		this.files.set(path, contents);
	}

	public async syncFile(): Promise<void> {}
	public async syncDirectory(): Promise<void> {}

	public async rename(from: string, to: string): Promise<void> {
		const value = this.files.get(from);
		if (value === undefined) {
			throw notFound();
		}
		this.files.delete(from);
		this.files.set(to, value);
	}

	public async removeDirectory(path: string): Promise<void> {
		this.directories.delete(path);
	}

	public async unlink(path: string): Promise<void> {
		if (!this.files.delete(path)) {
			throw notFound();
		}
	}

	public async readdir(path: string): Promise<readonly string[]> {
		if (!this.directories.has(path)) {
			throw notFound();
		}
		const prefix = `${path}${sep}`;
		return [...this.files.keys()]
			.filter((candidate) =>
				candidate.startsWith(prefix)
				&& !candidate.slice(prefix.length).includes(sep),
			)
			.map((candidate) => candidate.slice(prefix.length));
	}
}

class NoopScheduler implements RegistryScheduler {
	public repeat(): { dispose(): void } {
		return { dispose: () => undefined };
	}
}

class TestHandle implements AgentTaskHandle {
	public readonly events = createAgentRuntimeEventQueue();
	public readonly recovery = {
		clientId: 'client',
		sessionUri: 'session',
		chatUri: 'conversation',
		lastSeenServerSeq: 1,
	};
	public readonly answers: AgentTaskAnswer[] = [];
	public cancelCalls = 0;
	public disposeCalls = 0;

	public constructor(public readonly taskId: string) {}

	public cancel(): Promise<void> {
		this.cancelCalls += 1;
		return Promise.resolve();
	}

	public answer(answer: AgentTaskAnswer): Promise<void> {
		this.answers.push(answer);
		return Promise.resolve();
	}

	public dispose(): Promise<void> {
		this.disposeCalls += 1;
		this.events.close();
		return Promise.resolve();
	}
}

class TestRuntime implements AgentRuntime {
	public readonly requests: AgentTaskRequest[] = [];
	public readonly handles: TestHandle[] = [];

	public probe(): Promise<AgentRuntimeProbe> {
		return Promise.resolve({ available: true, featureEnabled: true });
	}

	public start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		this.requests.push(request);
		const handle = new TestHandle(request.taskId);
		this.handles.push(handle);
		return Promise.resolve(handle);
	}

	public dispose(): Promise<void> {
		return Promise.resolve();
	}
}

class FakeRemoteTaskService implements RemoteTaskRouteAdapter {
	public readonly counts = {
		listDevices: 0,
		startTask: 0,
		getTask: 0,
		cancelTask: 0,
		answerTask: 0,
		listKnownTasks: 0,
	};
	private readonly snapshots = new Map<string, TaskSnapshot | TaskSnapshotAfterEventSeq>();

	public setKnownTask(snapshot: TaskSnapshot | TaskSnapshotAfterEventSeq): void {
		this.snapshots.set(snapshot.taskId, structuredClone(snapshot));
	}

	public async listDevices(): Promise<{
		readonly devices: readonly [];
		readonly truncated: false;
		readonly totalDevices: 0;
	}> {
		this.counts.listDevices += 1;
		return { devices: [], truncated: false, totalDevices: 0 };
	}

	public async startTask(input: RoutedTaskStartParams): Promise<TaskSnapshot> {
		this.counts.startTask += 1;
		const snapshot = activeRemoteSnapshot(input, input.title);
		this.snapshots.set(snapshot.taskId, snapshot);
		return structuredClone(snapshot);
	}

	public async getTask(
		taskId: string,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq | undefined> {
		this.counts.getTask += 1;
		const snapshot = this.snapshots.get(taskId);
		return snapshot === undefined ? undefined : structuredClone(snapshot);
	}

	public async cancelTask(taskId: string): Promise<TaskSnapshot | undefined> {
		this.counts.cancelTask += 1;
		const snapshot = this.snapshots.get(taskId);
		return snapshot === undefined ? undefined : structuredClone(snapshot as TaskSnapshot);
	}

	public async answerTask(taskId: string): Promise<TaskSnapshot | undefined> {
		this.counts.answerTask += 1;
		const snapshot = this.snapshots.get(taskId);
		return snapshot === undefined ? undefined : structuredClone(snapshot as TaskSnapshot);
	}

	public listKnownTasks(): readonly (TaskSnapshot | TaskSnapshotAfterEventSeq)[] {
		this.counts.listKnownTasks += 1;
		return [...this.snapshots.values()].map((snapshot) => structuredClone(snapshot));
	}
}

interface BrokerFixture {
	readonly broker: DeviceBroker;
	readonly identity: LocalIpcIdentity;
	readonly remoteTasks: FakeRemoteTaskService;
}

interface ClientFixture {
	readonly client: WindowNodeClient;
	readonly runtime: TestRuntime;
	readonly confirmations: WindowNodeTaskConfirmationRequest[];
}

async function createBroker(options: {
	readonly routeTimes?: readonly string[];
	readonly state?: MemoryState;
	readonly files?: MemoryFileSystem;
	readonly remoteTasks?: FakeRemoteTaskService;
} = {}): Promise<BrokerFixture> {
	const state = options.state ?? new MemoryState();
	const files = options.files ?? new MemoryFileSystem();
	const remoteTasks = options.remoteTasks ?? new FakeRemoteTaskService();
	const identity = {
		userIdentity: randomBytes(16).toString('hex'),
		deviceId: DEVICE_ID,
		tempDirectory: `.ipc-test-${randomBytes(6).toString('hex')}`,
	};
	await mkdir(identity.tempDirectory, { recursive: true, mode: 0o700 });
	const clock = { now: () => new Date() };
	let routeIndex = 0;
	const routeNow = (): Date => new Date(
		options.routeTimes?.[routeIndex++] ?? '2026-09-01T00:00:00.000Z',
	);
	const atomic = new AtomicFileStore('memory', files, { next: () => randomBytes(8).toString('hex') });
	const store = new FileTaskStore(atomic, clock);
	let service: BrokerTaskService | undefined;
	const registry = await NodeRegistry.create({
		deviceId: DEVICE_ID,
		state,
		ids: { next: () => WORKSPACE_ID },
		clock,
		workspaceLeases: new WorkspaceLeaseManager(),
		scheduler: new NoopScheduler(),
		onNodeTasksLost: (bindings: readonly NodeTaskBinding[]) => {
			void service?.handleNodeTasksLost(bindings);
		},
	});
	service = new BrokerTaskService(DEVICE_ID, registry, store, clock);
	await service.initialize();
	const broker = new DeviceBroker({
		identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		ownership: {
			isOwner: () => true,
			currentGeneration: () => 'test-generation',
			snapshot: () => ({ owner: true, instanceId: 'test-broker' }),
			assertOwner: () => Promise.resolve(),
			contend: () => Promise.resolve(true),
			onDidLoseOwnership: () => ({ dispose: () => undefined }),
			dispose: () => Promise.resolve(),
		},
		registry,
		peerPolicies: passthroughPeerPolicies(registry),
		taskService: service,
		remoteTaskService: remoteTasks,
		taskRoutes: new TaskRouteCatalog(state, routeNow),
		requestTimeoutMs: 2_000,
	});
	await broker.start();
	return { broker, identity, remoteTasks };
}

function createClient(
	fixture: BrokerFixture,
	nodeId: string,
	nodeInstanceId: string,
	label: string,
): ClientFixture {
	const runtime = new TestRuntime();
	const confirmations: WindowNodeTaskConfirmationRequest[] = [];
	const approvalCapabilities = new AgentRuntimeApprovalCapabilityIssuer();
	let executor: WindowNodeTaskExecutor | undefined;
	const client = new WindowNodeClient({
		nodeId,
		nodeInstanceId,
		label,
		capabilities: ['tasks'],
		identity: fixture.identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		executor: ({ workspaceResolver, eventSink }) => {
			executor = new WindowNodeTaskExecutor({
				nodeId,
				nodeInstanceId,
				nodeLabel: label,
				runtime,
				workspaceResolver,
				eventSink,
				confirmationHost: {
					confirm: async (request) => {
						confirmations.push(request);
						return 'once';
					},
				},
				approvalCapabilities,
				ids: { next: () => '00000000-0000-4000-8000-0000000000aa' },
				clock: { now: () => new Date() },
			});
			return executor;
		},
		workspaceSource: {
			list: () => [{
				localUri: pathToFileURL(process.cwd()).href,
				name: 'Repository',
				capabilityTags: ['typescript'],
			}],
		},
		heartbeatIntervalMs: 100,
		backoff: {
			initialDelayMs: 10,
			maxDelayMs: 50,
			jitterRatio: 0,
		},
		requestTimeoutMs: 2_000,
	});
	return { client, runtime, confirmations };
}

function localTask(
	taskId: string,
	delegationRequestId: string,
	target: { nodeId: string; nodeInstanceId: string; workspaceId: string },
	title: string,
): RoutedTaskStartParams {
	return {
		taskId,
		delegationRequestId,
		target: { deviceId: DEVICE_ID, ...target },
		title,
		prompt: 'Implement the requested change.',
		acceptanceCriteria: ['Tests pass.'],
		workerDeadline: DEADLINE,
	};
}

function remoteTask(
	taskId: string,
	delegationRequestId: string,
	title: string,
): RoutedTaskStartParams {
	return {
		taskId,
		delegationRequestId,
		target: {
			deviceId: REMOTE_DEVICE_ID,
			nodeId: REMOTE_NODE_ID,
			nodeInstanceId: REMOTE_INSTANCE_ID,
			workspaceId: REMOTE_WORKSPACE_ID,
		},
		title,
		prompt: 'Run the delegated remote task.',
		acceptanceCriteria: ['Report completion.'],
		workerDeadline: DEADLINE,
	};
}

function activeRemoteSnapshot(
	input: RoutedTaskStartParams,
	title: string,
): TaskSnapshot {
	return {
		schemaVersion: 2,
		taskId: input.taskId,
		delegationRequestId: input.delegationRequestId,
		requestHash: 'a'.repeat(64),
		peerId: DEVICE_ID,
		workspaceId: input.target.workspaceId,
		title,
		state: 'startingAgent',
		createdAt: '2026-09-01T00:10:00.000Z',
		updatedAt: '2026-09-01T00:10:00.000Z',
		eventSeq: 1,
		workerDeadline: input.workerDeadline,
		events: [{
			eventSeq: 1,
			at: '2026-09-01T00:10:00.000Z',
			type: 'agentStarted',
			summary: 'Started.',
		}],
		eventsTruncated: false,
		deviceId: REMOTE_DEVICE_ID,
	};
}

function completedRemoteSnapshot(
	input: RoutedTaskStartParams,
	title: string,
): TaskSnapshot {
	return {
		schemaVersion: 2,
		taskId: input.taskId,
		delegationRequestId: input.delegationRequestId,
		requestHash: 'b'.repeat(64),
		peerId: DEVICE_ID,
		workspaceId: input.target.workspaceId,
		title,
		state: 'completed',
		createdAt: '2026-09-01T00:11:00.000Z',
		updatedAt: '2026-09-01T00:12:00.000Z',
		eventSeq: 2,
		workerDeadline: input.workerDeadline,
		summary: 'Completed from cache.',
		events: [{
			eventSeq: 1,
			at: '2026-09-01T00:11:00.000Z',
			type: 'agentStarted',
			summary: 'Started.',
		}, {
			eventSeq: 2,
			at: '2026-09-01T00:12:00.000Z',
			type: 'completed',
			summary: 'Completed from cache.',
		}],
		eventsTruncated: false,
		deviceId: REMOTE_DEVICE_ID,
	};
}

test('DeviceBroker lists only owned tasks with stable pagination and cached local metadata', async () => {
	const fixture = await createBroker({
		routeTimes: [
			'2026-09-01T00:00:01.000Z',
			'2026-09-01T00:00:01.500Z',
			'2026-09-01T00:00:02.000Z',
			'2026-09-01T00:00:03.000Z',
			'2026-09-01T00:00:03.000Z',
			'2026-09-01T00:00:04.000Z',
		],
	});
	const windowA = createClient(fixture, NODE_A, INSTANCE_A, 'Window A');
	const windowB = createClient(fixture, NODE_B, INSTANCE_B, 'Window B');
	try {
		await windowA.client.start();
		await windowB.client.start();
		const directory = await windowB.client.listNodes();
		const nodeA = directory.nodes.find((node) => node.nodeId === NODE_A);
		assert.ok(nodeA);
		const target = {
			nodeId: nodeA.nodeId,
			nodeInstanceId: nodeA.nodeInstanceId,
			workspaceId: nodeA.workspaces[0]!.workspaceId,
		};

		await windowB.client.startTask(localTask(
			OWNED_LOCAL_TERMINAL_TASK,
			DELEGATION_2,
			target,
			'Owned local terminal task',
		));
		await windowB.client.cancelTask(OWNED_LOCAL_TERMINAL_TASK);
		await windowA.runtime.handles[0]!.events.pushAndClose({ type: 'cancelled' });
		await waitForTask(
			windowB.client,
			OWNED_LOCAL_TERMINAL_TASK,
			(snapshot) => snapshot.state === 'cancelled',
		);
		await fixture.broker.startRemote(REMOTE_PEER_ID, localTask(
			INCOMING_TASK,
			DELEGATION_6,
			target,
			'Incoming peer task',
		));
		await waitFor(async () => windowA.runtime.handles.length === 2);
		await windowA.runtime.handles[1]!.events.pushAndClose({ type: 'completed' });
		await waitFor(async () => windowA.runtime.handles[1]!.disposeCalls === 1);
		await windowB.client.startTask(localTask(
			OWNED_LOCAL_ACTIVE_TASK,
			DELEGATION_1,
			target,
			'Owned local active task',
		));

		const ownedRemote = remoteTask(
			OWNED_REMOTE_TASK,
			DELEGATION_4,
			'Owned remote cached task',
		);
		await windowB.client.startRemoteTask(ownedRemote, REMOTE_PEER_ID);

		const ambiguousRemote = remoteTask(
			OWNED_REMOTE_AMBIGUOUS_TASK,
			DELEGATION_3,
			'Hidden ambiguous task title',
		);
		await fixture.broker.taskRoutes.reserveRemote(
			ambiguousRemote,
			REMOTE_PEER_ID,
			NODE_B,
		);
		fixture.remoteTasks.setKnownTask(completedRemoteSnapshot(
			ambiguousRemote,
			'Cached ambiguous task title',
		));

		await windowA.client.startRemoteTask(remoteTask(
			FOREIGN_REMOTE_TASK,
			DELEGATION_5,
			'Foreign remote task',
		), REMOTE_PEER_ID);

		const beforeLocal = await windowB.client.getTask(OWNED_LOCAL_ACTIVE_TASK);
		const firstPage = await windowB.client.listOwnedTasks({ limit: 2 });
		assert.deepEqual(firstPage, {
			tasks: [{
				taskId: OWNED_REMOTE_AMBIGUOUS_TASK,
				delegationRequestId: DELEGATION_3,
				title: 'Cached ambiguous task title',
				lastKnownState: 'ambiguous',
				createdAt: '2026-09-01T00:00:03.000Z',
				target: ownedRemote.target,
				locality: 'remote',
			}, {
				taskId: OWNED_REMOTE_TASK,
				delegationRequestId: DELEGATION_4,
				title: 'Owned remote cached task',
				lastKnownState: 'startingAgent',
				createdAt: '2026-09-01T00:00:03.000Z',
				target: ownedRemote.target,
				locality: 'remote',
			}],
			truncated: true,
			totalTasks: 3,
			nextBeforeTaskId: OWNED_REMOTE_TASK,
		});

		const secondPage = await windowB.client.listOwnedTasks({
			limit: 2,
			beforeTaskId: OWNED_REMOTE_TASK,
		});
		assert.deepEqual(secondPage, {
			tasks: [{
				taskId: OWNED_LOCAL_ACTIVE_TASK,
				delegationRequestId: DELEGATION_1,
				title: 'Owned local active task',
				lastKnownState: 'running',
				createdAt: '2026-09-01T00:00:02.000Z',
				target: { deviceId: DEVICE_ID, ...target },
				locality: 'local',
			}],
			truncated: false,
			totalTasks: 3,
		});

		const cursorPastTerminal = await windowB.client.listOwnedTasks({
			beforeTaskId: OWNED_LOCAL_TERMINAL_TASK,
		});
		assert.deepEqual(cursorPastTerminal.tasks, []);
		assert.equal(cursorPastTerminal.totalTasks, 3);
		assert.equal(cursorPastTerminal.truncated, false);

		const includeTerminal = await windowB.client.listOwnedTasks({
			includeTerminal: true,
			limit: 10,
		});
		assert.deepEqual(includeTerminal.tasks.map(({ taskId }) => taskId), [
			OWNED_REMOTE_AMBIGUOUS_TASK,
			OWNED_REMOTE_TASK,
			OWNED_LOCAL_ACTIVE_TASK,
			OWNED_LOCAL_TERMINAL_TASK,
		]);
		assert.equal(includeTerminal.totalTasks, 4);
		assert.equal(includeTerminal.truncated, false);

		await assert.rejects(
			windowB.client.listOwnedTasks({ beforeTaskId: FOREIGN_REMOTE_TASK }),
			(error: unknown) =>
				error instanceof LocalIpcRemoteError
				&& error.code === MESH_ERROR_CODES.TASK_NOT_FOUND,
		);

		assert.ok(!includeTerminal.tasks.some(({ taskId }) => taskId === FOREIGN_REMOTE_TASK));
		assert.ok(!includeTerminal.tasks.some(({ taskId }) => taskId === INCOMING_TASK));
		assert.deepEqual(await windowB.client.getTask(OWNED_LOCAL_ACTIVE_TASK), beforeLocal);
		assert.equal(fixture.remoteTasks.counts.listDevices, 0);
		assert.equal(fixture.remoteTasks.counts.getTask, 0);
		assert.equal(fixture.remoteTasks.counts.cancelTask, 0);
		assert.equal(fixture.remoteTasks.counts.answerTask, 0);
		assert.equal(fixture.remoteTasks.counts.startTask, 2);
		assert.ok(fixture.remoteTasks.counts.listKnownTasks >= 1);
	} finally {
		await Promise.allSettled([
			windowA.client.dispose(),
			windowB.client.dispose(),
			fixture.broker.dispose(),
		]);
		await rm(fixture.identity.tempDirectory!, { recursive: true, force: true });
	}
});

test('DeviceBroker rejects spoofed owned-task identity and extra fields', async () => {
	const fixture = await createBroker();
	const ipc = new LocalIpcClient({
		identity: fixture.identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		clientId: INSTANCE_A,
	});
	try {
		const session = await ipc.connect();
		await session.request(LOCAL_BROKER_METHODS.register, {
			nodeId: NODE_A,
			nodeInstanceId: INSTANCE_A,
			label: 'Window A',
			capabilities: ['tasks'],
			status: 'online',
			startedAt: '2026-09-01T00:00:00.000Z',
		});

		await assert.rejects(
			session.request(LOCAL_BROKER_METHODS.ownedTaskList, {
				nodeId: NODE_A,
				nodeInstanceId: INSTANCE_B,
			}),
			(error: unknown) =>
				error instanceof LocalIpcRemoteError
				&& error.code === MESH_ERROR_CODES.AUTH_FAILED,
		);
		await assert.rejects(
			session.request(LOCAL_BROKER_METHODS.ownedTaskList, {
				nodeId: NODE_A,
				nodeInstanceId: INSTANCE_A,
				limit: 1,
				extra: true,
			}),
			(error: unknown) =>
				error instanceof LocalIpcRemoteError
				&& error.code === JSON_RPC_ERROR_CODES.INVALID_PARAMS,
		);
	} finally {
		ipc.dispose();
		await fixture.broker.dispose();
		await rm(fixture.identity.tempDirectory!, { recursive: true, force: true });
	}
});

function passthroughPeerPolicies(registry?: NodeRegistry): PeerPolicyService {
	return {
		listAuthorized: () => registry?.list() ?? {
			deviceId: DEVICE_ID,
			nodes: [],
			truncated: false,
			totalNodes: 0,
		},
		onDidChange: () => ({ dispose: () => undefined }),
	} as unknown as PeerPolicyService;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail('Condition was not met before the deadline.');
}

async function waitForTask(
	client: WindowNodeClient,
	taskId: string,
	predicate: (snapshot: TaskSnapshot) => boolean,
): Promise<TaskSnapshot> {
	const deadline = Date.now() + 3_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const snapshot = await client.getTask(taskId);
			if (predicate(snapshot)) {
				return snapshot;
			}
		} catch (error: unknown) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (lastError !== undefined) {
		throw lastError;
	}
	assert.fail('Task did not reach the expected state before the deadline.');
}

function notFound(): NodeJS.ErrnoException {
	const error = new Error('not found') as NodeJS.ErrnoException;
	error.code = 'ENOENT';
	return error;
}
