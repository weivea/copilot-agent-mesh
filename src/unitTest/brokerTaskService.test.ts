import assert from 'node:assert/strict';
import { sep } from 'node:path';
import { test } from 'node:test';

import {
	LOCAL_BROKER_TASK_START_TIMEOUT_MS,
	MESH_ERROR_CODES,
	PROTOCOL_LIMITS,
	nodeTaskStartParamsSchema,
	timestampSchema,
	type NodeTaskEventParams,
	type RoutedTaskStartParams,
	type TaskSnapshot,
} from '../../shared/protocol';
import {
	BrokerTaskService,
	DASHBOARD_TASK_INDEX_ENTRY_BYTES,
	DASHBOARD_TASK_INDEX_LIMIT,
	NodeRegistry,
	projectDashboardTaskIndexRecord,
	type BrokerTaskServiceOptions,
	type NodeTaskBinding,
	type RegistryScheduler,
} from '../broker';
import { MeshDomainError } from '../domain/errors';
import {
	createAcceptedRoutedTask,
	createAcceptedTask,
	type TaskRecord,
} from '../domain/task';
import type { StateStore } from '../domain/ports';
import { taskReducer } from '../domain/taskReducer';
import { GatewayRouter } from '../gateway/GatewayRouter';
import {
	LocalIpcRemoteError,
	type JsonValue,
	type LocalIpcSession,
} from '../ipc/LocalIpcTransport';
import {
	AtomicFileStore,
	type AtomicFileSystem,
	StorageCorruptionError,
} from '../storage/AtomicFileStore';
import { FileTaskStore } from '../tasks/FileTaskStore';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const NODE_ID = '00000000-0000-4000-8000-000000000002';
const INSTANCE_ID = '00000000-0000-4000-8000-000000000003';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000004';
const SOURCE_ID = '00000000-0000-4000-8000-000000000005';
const OWNER_ID = '00000000-0000-4000-8000-000000000006';
const TASK_ID = '00000000-0000-4000-8000-000000000007';
const OTHER_TASK_ID = '00000000-0000-4000-8000-000000000008';
const DELEGATION_ID = '00000000-0000-4000-8000-000000000009';
const OTHER_DELEGATION_ID = '00000000-0000-4000-8000-00000000000a';
const INPUT_ID = '00000000-0000-4000-8000-00000000000b';
const ANSWER_ID = '00000000-0000-4000-8000-00000000000c';
const AT = '2026-08-25T12:00:00.000Z';

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

class FakeSession {
	public closed = false;
	public requests: { method: string; params: JsonValue; timeoutMs?: number }[] = [];
	public handler: (method: string, params: JsonValue) => Promise<JsonValue> = async (
		method,
	) => method === 'node.task.start'
		? {
			taskId: TASK_ID,
			nodeId: NODE_ID,
			nodeInstanceId: INSTANCE_ID,
		}
		: null;
	private readonly listeners = new Set<(error?: Error) => void>();

	public async request(method: string, params: JsonValue, timeoutMs?: number): Promise<JsonValue> {
		this.requests.push({ method, params, timeoutMs });
		return this.handler(method, params);
	}

	public onClose(listener: (error?: Error) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const listener of [...this.listeners]) {
			listener();
		}
	}

	public asRoute(): LocalIpcSession {
		return this as unknown as LocalIpcSession;
	}
}

interface Fixture {
	readonly registry: NodeRegistry;
	readonly service: BrokerTaskService;
	readonly store: FileTaskStore;
	readonly files: AtomicFileStore;
	readonly session: FakeSession;
	lost(): Promise<void>;
	dispose(): Promise<void>;
}

async function createFixture(
	notificationSink?: {
		publish(
			record: { peerId: string; taskId: string; eventSeq: number },
			event: { type: string },
		): Promise<void>;
	},
	serviceOptions: Omit<BrokerTaskServiceOptions, 'notificationSink'> = {},
	clock = { now: () => new Date(AT) },
): Promise<Fixture> {
	const memory = new MemoryFileSystem();
	let temporaryId = 0;
	const files = new AtomicFileStore(memoryRoot(), memory, {
		next: () => `write-${temporaryId += 1}`,
	});
	const store = new FileTaskStore(files, clock);
	const session = new FakeSession();
	let service: BrokerTaskService | undefined;
	let loss = Promise.resolve();
	const registry = await NodeRegistry.create({
		deviceId: DEVICE_ID,
		state: new MemoryState(),
		ids: { next: () => WORKSPACE_ID },
		clock,
		workspaceLeases: new WorkspaceLeaseManager(),
		scheduler: new NoopScheduler(),
		onNodeTasksLost: (bindings: readonly NodeTaskBinding[]) => {
			loss = service?.handleNodeTasksLost(bindings) ?? Promise.resolve();
		},
	});
	registry.register({
		nodeId: NODE_ID,
		nodeInstanceId: INSTANCE_ID,
		label: 'Window Node',
		capabilities: ['tasks'],
		status: 'online',
		startedAt: AT,
	}, session.asRoute());
	await registry.claimWorkspace({
		nodeId: NODE_ID,
		nodeInstanceId: INSTANCE_ID,
		workspaceId: WORKSPACE_ID,
		workspaceIdentity: createOpaqueWorkspaceIdentity('opaque-workspace-identity'),
		name: 'Workspace',
		capabilityTags: ['typescript'],
	});
	service = new BrokerTaskService(
		DEVICE_ID,
		registry,
		store,
		clock,
		{
			...serviceOptions,
			...(notificationSink === undefined ? {} : { notificationSink }),
		},
	);
	return {
		registry,
		service,
		store,
		files,
		session,
		lost: () => loss,
		dispose: async () => {
			await service?.dispose();
			registry.dispose();
		},
	};
}

function startParams(
	changes: Partial<RoutedTaskStartParams> = {},
): RoutedTaskStartParams {
	return {
		delegationRequestId: DELEGATION_ID,
		taskId: TASK_ID,
		target: {
			deviceId: DEVICE_ID,
			nodeId: NODE_ID,
			nodeInstanceId: INSTANCE_ID,
			workspaceId: WORKSPACE_ID,
		},
		title: 'Implement routed task',
		prompt: 'Sensitive prompt that must not be persisted.',
		acceptanceCriteria: ['Tests pass.'],
		workerDeadline: '2026-08-25T13:00:00.000Z',
		...changes,
	};
}

function nodeEvent(
	event: NodeTaskEventParams['event'],
	taskId = TASK_ID,
): NodeTaskEventParams {
	return {
		nodeId: NODE_ID,
		nodeInstanceId: INSTANCE_ID,
		taskId,
		at: AT,
		event,
	};
}

test('dashboard index excludes a maximum journal and stays small at full capacity', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	const params = startParams();
	let record: TaskRecord = createAcceptedRoutedTask({
		...params,
		peerId: DEVICE_ID,
		workspaceLeaseKey: createOpaqueWorkspaceIdentity('dashboard-heavy-journal'),
	}, AT);
	record = taskReducer(record, { type: 'agentStartRequested', at: AT });
	record = taskReducer(record, { type: 'agentStarted', at: AT });
	for (let index = 0; index < 39; index += 1) {
		record = taskReducer(record, {
			type: 'output',
			at: AT,
			summary: `${index}`.padEnd(16_000, 'x'),
		});
	}
	if (record.schemaVersion !== 2) {
		throw new Error('Expected a routed v2 task record.');
	}
	record = {
		...record,
		title: '\u0001'.repeat(PROTOCOL_LIMITS.taskTitleBytes),
		sourceWorkspaceIdentity: 'token=raw-sensitive-value',
	};
	assert.ok(Buffer.byteLength(JSON.stringify(record.events), 'utf8') > 600 * 1_024);

	const projected = projectDashboardTaskIndexRecord(record);
	assert.equal('events' in projected, false);
	assert.equal('failure' in projected, false);
	assert.equal('pendingInput' in projected, false);
	assert.equal('recoveryDescriptor' in projected, false);
	assert.equal('answeredInputs' in projected, false);
	assert.equal('sourceWorkspaceIdentity' in projected, false);
	assert.equal(projected.title, '[redacted sensitive details]');
	assert.ok(Object.isFrozen(projected));
	assert.ok(Buffer.byteLength(JSON.stringify(projected), 'utf8') <= DASHBOARD_TASK_INDEX_ENTRY_BYTES);
	assert.ok(
		Buffer.byteLength(
			JSON.stringify(Array.from({ length: DASHBOARD_TASK_INDEX_LIMIT }, () => projected)),
			'utf8',
		) < 700 * 1_024,
	);
	const longFraction = `2026-08-25T12:00:00.${'1'.repeat(900)}Z`;
	assert.equal(timestampSchema.safeParse(longFraction).success, true);
	const fractionalProjection = projectDashboardTaskIndexRecord({
		...record,
		createdAt: longFraction,
		updatedAt: longFraction,
	});
	assert.equal(fractionalProjection.createdAt, '2026-08-25T12:00:00.111Z');
	assert.ok(
		Buffer.byteLength(JSON.stringify(fractionalProjection), 'utf8')
		<= DASHBOARD_TASK_INDEX_ENTRY_BYTES,
	);

	await fixture.store.create(record);
	await fixture.service.initialize();
	const listed = await fixture.service.listDashboardRecords();
	assert.equal(listed.length, 1);
	const listedRecord = listed[0];
	assert.ok(listedRecord);
	assert.equal('events' in listedRecord, false);
	assert.equal(listedRecord.state, 'failed');
	assert.ok(Buffer.byteLength(JSON.stringify(listed), 'utf8') <= DASHBOARD_TASK_INDEX_ENTRY_BYTES + 2);
	assert.deepEqual(fixture.service.dashboardMetrics(), {
		startupScans: 1,
		storeListScans: 1,
		reads: 1,
		indexSize: 1,
	});
});

test('dashboard index evicts the oldest terminal projection at its hard limit', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	for (let index = 0; index <= DASHBOARD_TASK_INDEX_LIMIT; index += 1) {
		const taskId = indexedUuid(index + 1_000);
		let record: TaskRecord = createAcceptedRoutedTask({
			...startParams({
				taskId,
				delegationRequestId: indexedUuid(index + 3_000),
			}),
			peerId: DEVICE_ID,
			workspaceLeaseKey: createOpaqueWorkspaceIdentity(`dashboard-eviction-${index}`),
		}, AT);
		record = taskReducer(record, {
			type: 'failed',
			at: index === 0
				? '2026-08-25T00:00:00+14:00'
				: index === 1
					? '2026-08-24T23:00:00-12:00'
					: new Date(Date.parse(AT) + index).toISOString(),
			code: 'TASK_EXECUTION_FAILED',
			message: 'Terminal history entry.',
			retryable: false,
		});
		await fixture.store.create(record);
	}
	await fixture.service.initialize();
	const listed = await fixture.service.listDashboardRecords();
	assert.equal(listed.length, DASHBOARD_TASK_INDEX_LIMIT);
	assert.equal(listed.some(({ taskId }) => taskId === indexedUuid(1_000)), false);
	assert.equal(listed.some(({ taskId }) => taskId === indexedUuid(1_001)), true);
	assert.equal(
		listed.some(({ taskId }) => taskId === indexedUuid(1_000 + DASHBOARD_TASK_INDEX_LIMIT)),
		true,
	);
});

test('runs a local v2 task vertically and persists before notification', async (t) => {
	let fixture: Fixture;
	const notifications: number[] = [];
	fixture = await createFixture({
		publish: async (record) => {
			const persisted = await fixture.store.getOwned(record.peerId, record.taskId);
			assert.equal(persisted?.eventSeq, record.eventSeq);
			notifications.push(record.eventSeq);
		},
	});
	t.after(() => fixture.dispose());
	fixture.session.handler = async (method) => {
		if (method === 'node.task.start') {
			await fixture.service.acceptNodeEvent(
				fixture.session.asRoute(),
				nodeEvent({ type: 'progress', summary: 'Started work.' }),
			);
			return {
				taskId: TASK_ID,
				nodeId: NODE_ID,
				nodeInstanceId: INSTANCE_ID,
			};
		}
		return null;
	};

	const started = await fixture.service.startLocal({
		nodeId: SOURCE_ID,
		nodeInstanceId: INSTANCE_ID,
	}, startParams());
	assert.equal(started.state, 'startingAgent');
	assert.deepEqual(started.events.map(({ type }) => type), [
		'agentStartRequested',
	]);
	await waitFor(async () =>
		(await fixture.store.getOwned(DEVICE_ID, TASK_ID))?.state === 'running',
	);
	const running = await fixture.service.getLocal(TASK_ID);
	assert.deepEqual(running.events.map(({ type }) => type), [
		'agentStartRequested',
		'agentStarted',
		'progress',
	]);
	const persisted = await fixture.store.getOwned(DEVICE_ID, TASK_ID);
	assert.equal(persisted?.schemaVersion, 2);
	assert.equal(persisted?.schemaVersion === 2 && persisted.sourceNodeId, SOURCE_ID);
	assert.deepEqual(persisted?.schemaVersion === 2 && persisted.target, {
		deviceId: DEVICE_ID,
		nodeId: NODE_ID,
		nodeInstanceId: INSTANCE_ID,
		workspaceId: WORKSPACE_ID,
	});
	assert.equal(JSON.stringify(persisted).includes('Sensitive prompt'), false);

	await fixture.service.acceptNodeEvent(
		fixture.session.asRoute(),
		nodeEvent({ type: 'completed', summary: 'Done.' }),
	);
	const completed = await fixture.service.get(DEVICE_ID, TASK_ID, 0);
	assert.equal(completed.state, 'completed');
	assert.equal(completed.events.at(-1)?.type, 'completed');
	assert.deepEqual(notifications, [1, 2, 3, 4]);
});

test('dashboard cancellation revalidates the authoritative record and live route', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	fixture.session.handler = async (method) => method === 'node.task.start'
		? {
			taskId: TASK_ID,
			nodeId: NODE_ID,
			nodeInstanceId: INSTANCE_ID,
		}
		: null;
	await fixture.service.startLocal({
		nodeId: SOURCE_ID,
		nodeInstanceId: INSTANCE_ID,
	}, startParams());
	await waitFor(async () =>
		(await fixture.store.getOwned(DEVICE_ID, TASK_ID))?.state === 'running',
	);
	await fixture.service.assertDashboardTaskCancellable(
		SOURCE_ID,
		INSTANCE_ID,
		DEVICE_ID,
		TASK_ID,
		'outgoing',
	);
	fixture.registry.releaseTaskRoute(DEVICE_ID, TASK_ID);
	await assert.rejects(
		fixture.service.assertDashboardTaskCancellable(
			SOURCE_ID,
			INSTANCE_ID,
			DEVICE_ID,
			TASK_ID,
			'outgoing',
		),
		(error: unknown) => isReason(error, 'TASK_NOT_FOUND'),
	);
});

test('returns a durable start acknowledgement while the target start is pending', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	const startResult = deferred<JsonValue>();
	fixture.session.handler = async (method) =>
		method === 'node.task.start' ? startResult.promise : null;

	const acknowledgement = await within(
		fixture.service.startRemote(OWNER_ID, startParams()),
		500,
	);
	assert.equal(acknowledgement.state, 'startingAgent');
	assert.deepEqual(acknowledgement.events.map(({ type }) => type), [
		'agentStartRequested',
	]);
	assert.equal(
		fixture.session.requests.filter(({ method }) => method === 'node.task.start').length,
		1,
	);
	assert.equal(
		fixture.session.requests.find(({ method }) => method === 'node.task.start')?.timeoutMs,
		LOCAL_BROKER_TASK_START_TIMEOUT_MS,
	);
	const persisted = await fixture.store.getOwned(OWNER_ID, TASK_ID);
	assert.equal(persisted?.state, 'startingAgent');
	assert.equal(persisted?.events.at(-1)?.type, 'agentStartRequested');
	const dispatched = nodeTaskStartParamsSchema.parse(
		fixture.session.requests.find(({ method }) => method === 'node.task.start')?.params,
	);
	assert.equal(dispatched.delegationGrant.taskId, TASK_ID);
	assert.equal(dispatched.delegationGrant.targetNodeId, NODE_ID);
	assert.equal(dispatched.delegationGrant.targetNodeInstanceId, INSTANCE_ID);
	assert.equal(
		dispatched.delegationGrant.workspaceIdentity,
		createOpaqueWorkspaceIdentity('opaque-workspace-identity'),
	);
	assert.equal(dispatched.delegationGrant.requestHash, persisted?.requestHash);
	assert.deepEqual(dispatched.delegationGrant.autoApprove, [
		'localTerminal',
		'localFileWrite',
	]);
	assert.equal(JSON.stringify(persisted).includes('delegationGrant'), false);

	startResult.resolve(nodeStartedResult({
		recoveryDescriptor: {
			adapter: 'ahp',
			sessionId: 'accepted-session',
			conversationId: 'accepted-conversation',
		},
	}));
	await waitFor(async () =>
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.state === 'running',
	);
	assert.deepEqual(
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.recoveryDescriptor,
		{
			adapter: 'ahp',
			sessionId: 'accepted-session',
			conversationId: 'accepted-conversation',
		},
	);
});

test('remote Gateway task.start acknowledges before a peer request timeout budget', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	const startResult = deferred<JsonValue>();
	fixture.session.handler = async (method) =>
		method === 'node.task.start' ? startResult.promise : null;
	const gateway = new GatewayRouter(
		{ getInfo: async () => ({ deviceId: DEVICE_ID }) },
		{
			listNodes: () => fixture.registry.list(),
			startRemote: (peerId, params) => fixture.service.startRemote(peerId, params),
			getRemote: (peerId, taskId, afterEventSeq) =>
				fixture.service.get(peerId, taskId, afterEventSeq),
			cancelRemote: (peerId, taskId) => fixture.service.cancel(peerId, taskId),
			answerRemote: (peerId, taskId, inputId, answerId, answer) =>
				fixture.service.answer(peerId, taskId, inputId, answerId, answer),
		},
	);

	const acknowledgement = await within(
		gateway.dispatch(OWNER_ID, 'task.start', startParams()) as Promise<TaskSnapshot>,
		500,
	);
	assert.equal(acknowledgement.state, 'startingAgent');
	assert.equal(fixture.session.requests.length, 1);

	startResult.resolve(nodeStartedResult());
	await waitFor(async () =>
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.state === 'running',
	);
});

test('exact concurrent retries share one pending node start dispatch', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	const startResult = deferred<JsonValue>();
	fixture.session.handler = async (method) =>
		method === 'node.task.start' ? startResult.promise : null;

	const acknowledgements = await within(Promise.all([
		fixture.service.startRemote(OWNER_ID, startParams()),
		fixture.service.startRemote(OWNER_ID, startParams()),
	]), 500);
	assert.deepEqual(
		acknowledgements.map(({ state }) => state),
		['startingAgent', 'startingAgent'],
	);
	assert.equal(
		fixture.session.requests.filter(({ method }) => method === 'node.task.start').length,
		1,
	);
	assert.equal((await fixture.store.list()).length, 1);

	startResult.resolve(nodeStartedResult());
	await waitFor(async () =>
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.state === 'running',
	);
});

test('concurrent conflicting starts persist and dispatch only one request', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());

	const results = await Promise.allSettled([
		fixture.service.startRemote(OWNER_ID, startParams()),
		fixture.service.startRemote(OWNER_ID, startParams({ prompt: 'Conflicting prompt.' })),
	]);

	assert.equal(results[0].status, 'fulfilled');
	assert.equal(results[1].status, 'rejected');
	if (results[1].status === 'rejected') {
		assert.equal(isReason(results[1].reason, 'IDEMPOTENCY_CONFLICT'), true);
	}
	assert.equal((await fixture.store.list()).length, 1);
	assert.equal(
		fixture.session.requests.filter(({ method }) => method === 'node.task.start').length,
		1,
	);
});

test('persists a safe stable Agent authentication failure after acceptance', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	fixture.session.handler = async (method) => {
		if (method === 'node.task.start') {
			throw new LocalIpcRemoteError(
				MESH_ERROR_CODES.AGENT_AUTH_REQUIRED,
				'Sensitive target authentication detail.',
				{ reason: 'AGENT_AUTH_REQUIRED', retryable: true },
			);
		}
		return null;
	};

	const acknowledgement = await fixture.service.startRemote(OWNER_ID, startParams());
	assert.equal(acknowledgement.state, 'startingAgent');
	await waitFor(async () =>
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.state === 'failed',
	);
	const failed = await fixture.store.getOwned(OWNER_ID, TASK_ID);
	assert.equal(failed?.failure?.code, 'AGENT_AUTH_REQUIRED');
	assert.equal(failed?.failure?.retryable, true);
	assert.equal(
		failed?.failure?.message,
		'The Window Node Agent runtime requires authentication.',
	);
	assert.doesNotMatch(JSON.stringify(failed), /Sensitive target authentication detail/u);
});

test('preserves stable target availability and execution failure reasons', async () => {
	for (const [reason, message] of [
		['AGENT_UNAVAILABLE', 'The Window Node Agent runtime is unavailable.'],
		['TASK_EXECUTION_FAILED', 'The Window Node could not start the task.'],
	] as const) {
		const fixture = await createFixture();
		try {
			fixture.session.handler = async (method) => {
				if (method === 'node.task.start') {
					throw new LocalIpcRemoteError(
						MESH_ERROR_CODES[reason],
						'Sensitive target startup detail.',
						{ reason, retryable: false },
					);
				}
				return null;
			};

			assert.equal(
				(await fixture.service.startRemote(OWNER_ID, startParams())).state,
				'startingAgent',
			);
			await waitFor(async () =>
				(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.state === 'failed',
			);
			const failed = await fixture.store.getOwned(OWNER_ID, TASK_ID);
			assert.equal(failed?.failure?.code, reason);
			assert.equal(failed?.failure?.message, message);
			assert.doesNotMatch(JSON.stringify(failed), /Sensitive target startup detail/u);
		} finally {
			await fixture.dispose();
		}
	}
});

test('persists an ambiguous closed transport without retrying execution', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	fixture.session.handler = async (method) => {
		if (method === 'node.task.start') {
			throw new Error('Transport closed after the request was written.');
		}
		return null;
	};

	const acknowledgement = await fixture.service.startRemote(OWNER_ID, startParams());
	assert.equal(acknowledgement.state, 'startingAgent');
	await waitFor(async () =>
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.state === 'failed',
	);
	const failed = await fixture.store.getOwned(OWNER_ID, TASK_ID);
	assert.equal(failed?.failure?.code, 'TASK_RECOVERY_UNAVAILABLE');
	assert.equal(failed?.failure?.retryable, true);
	assert.equal(
		fixture.session.requests.filter(({ method }) => method === 'node.task.start').length,
		1,
	);

	const retry = await fixture.service.startRemote(OWNER_ID, startParams());
	assert.equal(retry.state, 'failed');
	assert.equal(
		fixture.session.requests.filter(({ method }) => method === 'node.task.start').length,
		1,
	);
});

test('rejects a mismatched background start result as unrecoverable ambiguity', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	fixture.session.handler = async (method) => method === 'node.task.start'
		? {
			taskId: OTHER_TASK_ID,
			nodeId: NODE_ID,
			nodeInstanceId: INSTANCE_ID,
		}
		: null;

	assert.equal(
		(await fixture.service.startRemote(OWNER_ID, startParams())).state,
		'startingAgent',
	);
	await waitFor(async () =>
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.state === 'failed',
	);
	const failed = await fixture.store.getOwned(OWNER_ID, TASK_ID);
	assert.equal(failed?.failure?.code, 'TASK_RECOVERY_UNAVAILABLE');
	assert.equal(failed?.failure?.retryable, true);
});

test('keeps an earlier node event authoritative when the start response arrives later', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	const releaseResponse = deferred<void>();
	fixture.session.handler = async (method) => {
		if (method !== 'node.task.start') {
			return null;
		}
		await fixture.service.acceptNodeEvent(
			fixture.session.asRoute(),
			nodeEvent({ type: 'progress', summary: 'Started from the node event.' }),
		);
		await releaseResponse.promise;
		return nodeStartedResult({
			recoveryDescriptor: {
				adapter: 'ahp',
				sessionId: 'mesh-session',
				conversationId: 'mesh-conversation',
			},
		});
	};

	const acknowledgement = await fixture.service.startRemote(OWNER_ID, startParams());
	assert.equal(acknowledgement.state, 'startingAgent');
	await waitFor(async () =>
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.state === 'running',
	);
	releaseResponse.resolve();
	await fixture.service.dispose();

	const persisted = await fixture.store.getOwned(OWNER_ID, TASK_ID);
	assert.deepEqual(persisted?.events.map(({ type }) => type), [
		'agentStartRequested',
		'agentStarted',
		'progress',
	]);
	assert.equal(persisted?.recoveryDescriptor, undefined);
});

test('dispose drains a pending start dispatch without releasing its route early', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	const startResult = deferred<JsonValue>();
	fixture.session.handler = async (method) =>
		method === 'node.task.start' ? startResult.promise : null;
	await fixture.service.startRemote(OWNER_ID, startParams());

	let disposed = false;
	const disposal = fixture.service.dispose().then(() => {
		disposed = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(disposed, false);
	assert.equal(fixture.registry.list().nodes[0].workspaces[0].busy, true);

	startResult.resolve(nodeStartedResult());
	await disposal;
	assert.equal(disposed, true);
	assert.equal(
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.state,
		'running',
	);
	assert.equal(fixture.registry.list().nodes[0].workspaces[0].busy, true);
});

test('enforces owner, explicit target, workspace, and exact idempotency boundaries', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	await fixture.service.startRemote(OWNER_ID, startParams());
	await assert.rejects(
		fixture.service.get(DEVICE_ID, TASK_ID),
		(error: unknown) => isReason(error, 'TASK_NOT_FOUND'),
	);
	await assert.rejects(
		fixture.service.startRemote(OWNER_ID, startParams({
			target: { ...startParams().target, deviceId: SOURCE_ID },
		})),
		(error: unknown) => isReason(error, 'AGENT_UNAVAILABLE'),
	);

	const retry = await fixture.service.startRemote(OWNER_ID, startParams());
	assert.equal(retry.taskId, TASK_ID);
	assert.equal(
		fixture.session.requests.filter(({ method }) => method === 'node.task.start').length,
		1,
	);
	await assert.rejects(
		fixture.service.startRemote(OWNER_ID, startParams({ prompt: 'Different.' })),
		(error: unknown) => isReason(error, 'IDEMPOTENCY_CONFLICT'),
	);
	await assert.rejects(
		fixture.service.startRemote(OWNER_ID, startParams({
			taskId: OTHER_TASK_ID,
			delegationRequestId: OTHER_DELEGATION_ID,
		})),
		(error: unknown) => isReason(error, 'WORKSPACE_BUSY'),
	);
});

test('rejects a fresh start whose worker deadline has already expired', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	await assert.rejects(
		fixture.service.startRemote(OWNER_ID, startParams({ workerDeadline: AT })),
		(error: unknown) =>
			isReason(error, 'TASK_EXECUTION_FAILED')
			&& error instanceof Error
			&& error.message.includes('deadline'),
	);
	assert.equal(
		fixture.session.requests.some(({ method }) => method === 'node.task.start'),
		false,
	);
	assert.equal(await fixture.store.getOwned(OWNER_ID, TASK_ID), undefined);
	assert.equal(fixture.registry.list().nodes[0].workspaces[0].busy, false);
});

test('persists worker timeout before releasing and disposing the exact node task', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	await fixture.service.startRemote(OWNER_ID, startParams({
		workerDeadline: new Date(Date.parse(AT) + 25).toISOString(),
	}));
	await waitFor(async () =>
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.state === 'timedOut',
	);
	const persisted = await fixture.store.getOwned(OWNER_ID, TASK_ID);
	assert.equal(persisted?.state, 'timedOut');
	assert.equal(persisted?.failure?.code, 'TASK_TIMED_OUT');
	assert.equal(persisted?.events.at(-1)?.type, 'timedOut');
	assert.equal(
		fixture.session.requests.some(({ method }) => method === 'node.task.dispose'),
		true,
	);
	assert.equal(fixture.registry.list().nodes[0].workspaces[0].busy, false);
});

test('restores an absolute worker timer for a recoverable active record', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	const route = await fixture.registry.acquireTaskRoute({
		ownerId: OWNER_ID,
		taskId: TASK_ID,
		nodeId: NODE_ID,
		nodeInstanceId: INSTANCE_ID,
		workspaceId: WORKSPACE_ID,
	});
	await fixture.store.create(createAcceptedRoutedTask({
		...startParams({
			workerDeadline: new Date(Date.parse(AT) + 25).toISOString(),
		}),
		peerId: OWNER_ID,
		workspaceLeaseKey: route.workspaceLeaseKey,
	}, AT));
	await fixture.store.transitionOwned(OWNER_ID, TASK_ID, {
		type: 'agentStartRequested',
		at: AT,
	});
	await fixture.store.transitionOwned(OWNER_ID, TASK_ID, {
		type: 'agentStarted',
		at: AT,
	});
	await fixture.service.initialize();
	await waitFor(async () =>
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.state === 'timedOut',
	);
	assert.equal(
		fixture.session.requests.some(({ method }) => method === 'node.task.dispose'),
		true,
	);
});

test('enforces the stored absolute cancellation deadline while node RPC is hung', async (t) => {
	const fixture = await createFixture(undefined, { cancellationDeadlineMs: 25 });
	t.after(() => fixture.dispose());
	let resolveCancellation!: (value: JsonValue) => void;
	const cancellationRpc = new Promise<JsonValue>((resolve) => {
		resolveCancellation = resolve;
	});
	fixture.session.handler = async (method) => {
		if (method === 'node.task.start') {
			return {
				taskId: TASK_ID,
				nodeId: NODE_ID,
				nodeInstanceId: INSTANCE_ID,
			};
		}
		if (method === 'node.task.cancel') {
			return cancellationRpc;
		}
		return null;
	};
	await fixture.service.startRemote(OWNER_ID, startParams());
	const cancellation = fixture.service.cancel(OWNER_ID, TASK_ID);
	await waitFor(async () =>
		(await fixture.store.getOwned(OWNER_ID, TASK_ID))?.failure?.code
			=== 'TASK_CANCELLATION_UNCONFIRMED',
	);
	assert.equal(
		fixture.session.requests.some(({ method }) => method === 'node.task.dispose'),
		true,
	);
	resolveCancellation(null);
	const snapshot = await cancellation;
	assert.equal(snapshot.state, 'failed');
	assert.equal(snapshot.failure?.code, 'TASK_CANCELLATION_UNCONFIRMED');
});

test('routes input, answer, cancellation, loss, and rejects stale events', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	await fixture.service.startRemote(OWNER_ID, startParams());
	await fixture.service.acceptNodeEvent(
		fixture.session.asRoute(),
		nodeEvent({ type: 'inputRequired', inputId: INPUT_ID, prompt: 'Proceed?' }),
	);
	const answered = await fixture.service.answer(
		OWNER_ID,
		TASK_ID,
		INPUT_ID,
		ANSWER_ID,
		'yes',
	);
	assert.equal(answered.state, 'running');
	assert.equal(answered.events.at(-1)?.type, 'inputAnswered');

	fixture.session.handler = async (method) => {
		if (method === 'node.task.cancel') {
			await fixture.service.acceptNodeEvent(
				fixture.session.asRoute(),
				nodeEvent({ type: 'cancelled', summary: 'Cancelled.' }),
			);
		}
		return null;
	};
	const cancelled = await fixture.service.cancel(OWNER_ID, TASK_ID);
	assert.equal(cancelled.state, 'cancelled');

	const lossFixture = await createFixture();
	t.after(() => lossFixture.dispose());
	await lossFixture.service.startRemote(OWNER_ID, startParams());
	lossFixture.session.close();
	await lossFixture.lost();
	const failed = await lossFixture.service.get(OWNER_ID, TASK_ID);
	assert.equal(failed.state, 'failed');
	assert.equal(failed.failure?.code, 'TASK_RECOVERY_UNAVAILABLE');
	assert.equal(
		lossFixture.session.requests.filter(({ method }) => method === 'node.task.start').length,
		1,
	);
	assert.throws(
		() => lossFixture.service.acceptNodeEvent(
			lossFixture.session.asRoute(),
			nodeEvent({ type: 'completed', summary: 'Stale.' }),
		),
		(error: unknown) => isReason(error, 'AGENT_UNAVAILABLE'),
	);
});

test('migrates v1 records without fake recovery and rejects unknown versions', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());
	await fixture.store.create(createAcceptedTask({
		delegationRequestId: DELEGATION_ID,
		taskId: TASK_ID,
		workspaceId: WORKSPACE_ID,
		title: 'Legacy task',
		prompt: 'Legacy prompt',
		acceptanceCriteria: [],
		workerDeadline: '2026-08-25T13:00:00.000Z',
		peerId: OWNER_ID,
		workspaceLeaseKey: 'opaque-workspace-identity',
	}, AT));
	const migrated = await fixture.service.get(OWNER_ID, TASK_ID);
	assert.equal(migrated.schemaVersion, 2);
	assert.equal(migrated.state, 'failed');
	assert.equal(migrated.failure?.code, 'TASK_RECOVERY_UNAVAILABLE');
	const record = await fixture.store.getOwned(OWNER_ID, TASK_ID);
	assert.equal(record?.schemaVersion, 2);
	assert.deepEqual(record?.schemaVersion === 2 && record.target, {
		deviceId: DEVICE_ID,
		workspaceId: WORKSPACE_ID,
	});

	await fixture.files.writeJson(
		`tasks/${OWNER_ID}--${OTHER_TASK_ID}.json`,
		{ schemaVersion: 99 },
	);
	await assert.rejects(
		fixture.service.get(OWNER_ID, OTHER_TASK_ID),
		StorageCorruptionError,
	);
});

function nodeStartedResult(
	changes: {
		readonly recoveryDescriptor?: {
			readonly adapter: string;
			readonly sessionId: string;
			readonly conversationId?: string;
		};
	} = {},
): JsonValue {
	return {
		taskId: TASK_ID,
		nodeId: NODE_ID,
		nodeInstanceId: INSTANCE_ID,
		...changes,
	};
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
	readonly reject: (error: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`Operation exceeded the ${timeoutMs} ms acknowledgement budget.`));
		}, timeoutMs);
		void operation.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function memoryRoot(): string {
	return 'memory';
}

function indexedUuid(index: number): string {
	return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function notFound(): Error {
	return Object.assign(new Error('not found'), { code: 'ENOENT' });
}

function isReason(error: unknown, reason: string): boolean {
	return error instanceof MeshDomainError && error.reason === reason;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) {
			assert.fail('Condition was not met before the deadline.');
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
