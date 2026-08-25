import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { test } from 'node:test';

import {
	AsyncEventQueue,
	AgentRuntimeError,
	type AgentRuntime,
	type AgentRuntimeEvent,
	type AgentRuntimeProbe,
	type AgentTaskAnswer,
	type AgentTaskHandle,
	type AgentTaskRequest,
} from '../agentHost/AgentRuntime';
import { createAcceptedTask } from '../domain/task';
import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { WorkerTaskService } from '../application/RemoteTaskRunner';
import { GatewayRouter } from '../gateway/GatewayRouter';
import { GatewayServer } from '../gateway/GatewayServer';
import {
	InMemoryPairingRecordStore,
	PairingService,
} from '../gateway/PairingService';
import { InMemorySecretStore } from '../gateway/SecretStore';
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import { WebSocketPeerTransport } from '../peer/WebSocketPeerTransport';
import {
	AtomicFileStore,
	type AtomicFileSystem,
} from '../storage/AtomicFileStore';
import { FileTaskStore } from '../tasks/FileTaskStore';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { WorkspaceRegistry } from '../workspaces/WorkspaceRegistry';
import WebSocket from 'ws';
import { GATEWAY_NOTIFICATIONS } from '../../shared/protocol';

const workerDeviceId = '00000000-0000-4000-8000-000000000001';
const coordinatorDeviceId = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000003';
const secondWorkspaceId = '00000000-0000-4000-8000-000000000008';
const secondCoordinatorDeviceId = '00000000-0000-4000-8000-000000000009';
const delegationRequestId = '00000000-0000-4000-8000-000000000004';
const taskId = '00000000-0000-4000-8000-000000000005';
const inputId = '00000000-0000-4000-8000-000000000006';
const answerId = '00000000-0000-4000-8000-000000000007';

test('real loopback composes pairing, workspace, accepted task, input, get, and cancellation', async () => {
	const state = new MemoryState();
	const leases = new WorkspaceLeaseManager();
	const registry = new WorkspaceRegistry(
		state,
		{ next: () => workspaceId },
		{ now: () => new Date('2026-08-25T00:00:00.000Z') },
		{
			resolve: async () => ({
				canonicalUri: 'file:///workspace',
				identity: 'file:1:1',
			}),
		},
		leases,
	);
	await registry.register({ localUri: 'file:///workspace', name: 'Loopback Workspace' });
	const files = new AtomicFileStore('memory-root', new MemoryAtomicFileSystem(), {
		next: randomUUID,
	});
	const tasks = new FileTaskStore(files);
	const runtime = new StubAgentRuntime(inputId);
	let liveGateway: GatewayServer | undefined;
	const guard = new LocalDesktopWorkspaceGuard(() => ({
		remoteName: undefined,
		isTrusted: true,
		workspaceFolders: [{ uriScheme: 'file' }],
	}));
	const persistedNotifications: number[] = [];
	const runner = new WorkerTaskService(
		workerDeviceId,
		runtime,
		registry,
		tasks,
		leases,
		guard,
		{ confirm: async () => true },
		{
			id: () => inputId,
			notificationSink: {
				publish: async (record, event) => {
					const persisted = await tasks.getOwned(record.peerId, record.taskId);
					assert.equal(persisted?.eventSeq, record.eventSeq);
					persistedNotifications.push(record.eventSeq);
					await liveGateway?.notifyPeer(
						record.peerId,
						GATEWAY_NOTIFICATIONS.taskStateChanged,
						{
							taskId: record.taskId,
							eventSeq: record.eventSeq,
							at: event.at,
							state: record.state,
						},
					);
				},
			},
		},
	);
	await runner.initialize();

	const secrets = new InMemorySecretStore();
	const pairing = new PairingService(
		workerDeviceId,
		secrets,
		new InMemoryPairingRecordStore(),
	);
	const router = new GatewayRouter(
		{ getInfo: async () => ({ deviceId: workerDeviceId }) },
		{ list: async () => ({ workspaces: await registry.listForWire() }) },
		runner,
	);
	const gateway = new GatewayServer(pairing, router, {
		heartbeatIntervalMs: 50,
		heartbeatTimeoutMs: 500,
	});
	liveGateway = gateway;
	const address = await gateway.start();
	const profiles = new InMemoryPeerProfileStore();
	const manager = new PeerConnectionManager(
		coordinatorDeviceId,
		profiles,
		secrets,
		new WebSocketPeerTransport({
			heartbeatIntervalMs: 50,
			webSocketFactory: () => new WebSocket(
				`ws://127.0.0.1:${address.port}/agent-mesh/rpc`,
			),
		}),
	);

	try {
		const invitation = await pairing.createInvitation('https://worker.example.test');
		const connection = await manager.add(invitation.url);
		const notifications: string[] = [];
		connection.onNotification((method, params) => {
			if (method === GATEWAY_NOTIFICATIONS.taskStateChanged) {
				notifications.push(String(params.state));
			}
		});
		assert.equal(connection.snapshot().state, 'online');
		assert.deepStrictEqual(await connection.request('workspace.list', {}), {
			workspaces: [{
				workspaceId,
				name: 'Loopback Workspace',
				capabilityTags: [],
				enabled: true,
				busy: false,
			}],
		});

		const accepted = await connection.request('task.start', {
			delegationRequestId,
			taskId,
			workspaceId,
			title: 'Loopback vertical task',
			prompt: 'Request input, then wait for cancellation.',
			acceptanceCriteria: [],
			workerDeadline: '2099-08-25T01:00:00.000Z',
		}) as { state: string; taskId: string };
		assert.equal(accepted.state, 'accepted');
		assert.equal(accepted.taskId, taskId);

		const needsInput = await waitForTaskState(connection, 'needsInput');
		assert.equal(runtime.starts, 1);
		assert.equal(needsInput.pendingInput?.inputId, inputId);
		const retried = await connection.request('task.start', {
			delegationRequestId,
			taskId,
			workspaceId,
			title: 'Loopback vertical task',
			prompt: 'Request input, then wait for cancellation.',
			acceptanceCriteria: [],
			workerDeadline: '2099-08-25T01:00:00.000Z',
		}) as { taskId: string; state: string };
		assert.equal(retried.taskId, taskId);
		assert.equal(retried.state, 'needsInput');
		assert.equal(runtime.starts, 1);
		const answered = await connection.request('task.answer', {
			taskId,
			inputId,
			answerId,
			answer: 'Proceed.',
		}) as { state: string };
		assert.equal(answered.state, 'running');
		assert.equal(runtime.answers.length, 1);

		const eventWindow = await connection.request('task.get', {
			taskId,
			afterEventSeq: 0,
		}) as { events: readonly { eventSeq: number }[]; eventsTruncated: boolean };
		assert.equal(eventWindow.eventsTruncated, false);
		assert.deepStrictEqual(
			eventWindow.events.map(({ eventSeq }) => eventSeq),
			eventWindow.events.map((_, index) => index + 1),
		);

		const cancelling = await connection.request('task.cancel', { taskId }) as { state: string };
		assert.equal(cancelling.state, 'cancelling');
		await waitForTaskState(connection, 'cancelled');
		assert.ok(persistedNotifications.length >= 5);
		assert.ok(notifications.includes('needsInput'));
		assert.ok(notifications.includes('cancelled'));
	} finally {
		await manager.dispose();
		await gateway.dispose();
		await runner.dispose();
		await runtime.dispose();
	}
});

test('startup recovery fails active tasks honestly and releases their workspace lease', async () => {
	const files = new AtomicFileStore('memory-root', new MemoryAtomicFileSystem(), {
		next: randomUUID,
	});
	const tasks = new FileTaskStore(files);
	const accepted = createAcceptedTask({
		peerId: coordinatorDeviceId,
		delegationRequestId,
		taskId,
		workspaceId,
		workspaceLeaseKey: 'file:1:1',
		title: 'Recover active task',
		prompt: 'Do not restart this task.',
		acceptanceCriteria: [],
		workerDeadline: '2099-08-25T01:00:00.000Z',
	}, '2026-08-25T00:00:00.000Z');
	await tasks.create(accepted);
	const leases = new WorkspaceLeaseManager();
	const runtime = new StubAgentRuntime(inputId);
	const runner = new WorkerTaskService(
		workerDeviceId,
		runtime,
		new WorkspaceRegistry(
			new MemoryState(),
			{ next: () => workspaceId },
			{ now: () => new Date() },
			{ resolve: async () => ({ canonicalUri: 'file:///workspace', identity: 'file:1:1' }) },
			leases,
		),
		tasks,
		leases,
		allowedGuard(),
		{ confirm: async () => true },
	);
	await runner.initialize();
	const recovered = await runner.get(coordinatorDeviceId, taskId);
	assert.equal(recovered.state, 'failed');
	assert.equal(recovered.failure?.code, 'TASK_RECOVERY_UNAVAILABLE');
	assert.equal(leases.isLeased('file:1:1'), false);
	assert.equal(runtime.starts, 0);
	await runner.dispose();
});

test('disabled Agent Host fails with stable AGENT_UNAVAILABLE before accepting a task', async () => {
	const state = new MemoryState();
	const leases = new WorkspaceLeaseManager();
	const registry = new WorkspaceRegistry(
		state,
		{ next: () => workspaceId },
		{ now: () => new Date() },
		{ resolve: async () => ({ canonicalUri: 'file:///workspace', identity: 'file:1:1' }) },
		leases,
	);
	await registry.register({ localUri: 'file:///workspace', name: 'Workspace' });
	const runtime = new StubAgentRuntime(inputId, false);
	const runner = new WorkerTaskService(
		workerDeviceId,
		runtime,
		registry,
		new FileTaskStore(new AtomicFileStore(
			'memory-root',
			new MemoryAtomicFileSystem(),
			{ next: randomUUID },
		)),
		leases,
		allowedGuard(),
		{ confirm: async () => true },
	);
	await assert.rejects(
		runner.start(coordinatorDeviceId, {
			delegationRequestId,
			taskId,
			workspaceId,
			title: 'Disabled runtime',
			prompt: 'Must not start.',
			acceptanceCriteria: [],
			workerDeadline: '2099-08-25T01:00:00.000Z',
		}),
		(error: unknown) => error instanceof AgentRuntimeError && error.code === 'AGENT_UNAVAILABLE',
	);
	assert.equal(runtime.starts, 0);
	await runner.dispose();
});

test('concurrent idempotent starts retain the active workspace lease', async () => {
	const state = new MemoryState();
	const leases = new WorkspaceLeaseManager();
	const registry = new WorkspaceRegistry(
		state,
		{ next: () => workspaceId },
		{ now: () => new Date('2026-08-25T00:00:00.000Z') },
		{ resolve: async () => ({ canonicalUri: 'file:///workspace', identity: 'file:1:1' }) },
		leases,
	);
	await registry.register({ localUri: 'file:///workspace', name: 'Workspace' });
	const runtime = new StubAgentRuntime(inputId);
	const runner = new WorkerTaskService(
		workerDeviceId,
		runtime,
		registry,
		new FileTaskStore(new AtomicFileStore(
			'memory-root',
			new MemoryAtomicFileSystem(),
			{ next: randomUUID },
		)),
		leases,
		allowedGuard(),
		{ confirm: async () => true },
	);
	const request = {
		delegationRequestId,
		taskId,
		workspaceId,
		title: 'Concurrent retry',
		prompt: 'Start exactly once.',
		acceptanceCriteria: [],
		workerDeadline: '2099-08-25T01:00:00.000Z',
	};
	const [first, second] = await Promise.all([
		runner.start(coordinatorDeviceId, request),
		runner.start(coordinatorDeviceId, request),
	]);
	assert.equal(first.taskId, taskId);
	assert.equal(second.taskId, taskId);
	assert.deepStrictEqual(leases.owner('file:1:1'), {
		peerId: coordinatorDeviceId,
		taskId,
	});
	await waitForRunnerState(runner, coordinatorDeviceId, taskId, 'needsInput');
	assert.equal(runtime.starts, 1);
	await runner.dispose();
});

test('runtime handles are isolated by authenticated owner even when task IDs collide', async () => {
	const state = new MemoryState();
	const leases = new WorkspaceLeaseManager();
	const workspaceIds = [workspaceId, secondWorkspaceId];
	const registry = new WorkspaceRegistry(
		state,
		{ next: () => workspaceIds.shift()! },
		{ now: () => new Date('2026-08-25T00:00:00.000Z') },
		{
			resolve: async (uri) => ({
				canonicalUri: uri,
				identity: uri.endsWith('/one') ? 'file:1:1' : 'file:2:2',
			}),
		},
		leases,
	);
	await registry.register({ localUri: 'file:///one', name: 'One' });
	await registry.register({ localUri: 'file:///two', name: 'Two' });
	const runtime = new StubAgentRuntime(inputId);
	const runner = new WorkerTaskService(
		workerDeviceId,
		runtime,
		registry,
		new FileTaskStore(new AtomicFileStore(
			'memory-root',
			new MemoryAtomicFileSystem(),
			{ next: randomUUID },
		)),
		leases,
		allowedGuard(),
		{ confirm: async () => true },
		{ cancellationDeadlineMs: 100 },
	);
	await runner.start(coordinatorDeviceId, {
		delegationRequestId,
		taskId,
		workspaceId,
		title: 'First owner',
		prompt: 'Wait.',
		acceptanceCriteria: [],
		workerDeadline: '2099-08-25T01:00:00.000Z',
	});
	await runner.start(secondCoordinatorDeviceId, {
		delegationRequestId: answerId,
		taskId,
		workspaceId: secondWorkspaceId,
		title: 'Second owner',
		prompt: 'Wait.',
		acceptanceCriteria: [],
		workerDeadline: '2099-08-25T01:00:00.000Z',
	});
	await waitForRunnerState(runner, coordinatorDeviceId, taskId, 'needsInput');
	await waitForRunnerState(runner, secondCoordinatorDeviceId, taskId, 'needsInput');
	await runner.cancel(coordinatorDeviceId, taskId);
	await waitForRunnerState(runner, coordinatorDeviceId, taskId, 'cancelled');
	assert.equal((await runner.get(secondCoordinatorDeviceId, taskId)).state, 'needsInput');
	assert.equal(runtime.handles[0]?.cancelled, true);
	assert.equal(runtime.handles[1]?.cancelled, false);
	await runner.dispose();
});

test('shutdown does not wait forever for an unresolved local approval', async () => {
	const state = new MemoryState();
	const leases = new WorkspaceLeaseManager();
	const registry = new WorkspaceRegistry(
		state,
		{ next: () => workspaceId },
		{ now: () => new Date('2026-08-25T00:00:00.000Z') },
		{ resolve: async () => ({ canonicalUri: 'file:///workspace', identity: 'file:1:1' }) },
		leases,
	);
	await registry.register({ localUri: 'file:///workspace', name: 'Workspace' });
	const runner = new WorkerTaskService(
		workerDeviceId,
		new StubAgentRuntime(inputId),
		registry,
		new FileTaskStore(new AtomicFileStore(
			'memory-root',
			new MemoryAtomicFileSystem(),
			{ next: randomUUID },
		)),
		leases,
		allowedGuard(),
		{ confirm: () => new Promise<boolean>(() => undefined) },
	);
	await runner.start(coordinatorDeviceId, {
		delegationRequestId,
		taskId,
		workspaceId,
		title: 'Pending approval',
		prompt: 'Wait for approval.',
		acceptanceCriteria: [],
		workerDeadline: '2099-08-25T01:00:00.000Z',
	});
	await Promise.race([
		runner.dispose(),
		new Promise<never>((_, reject) => setTimeout(
			() => reject(new Error('Runner disposal timed out.')),
			250,
		)),
	]);
});

test('shutdown drains a task start blocked in atomic persistence', async () => {
	const state = new MemoryState();
	const leases = new WorkspaceLeaseManager();
	const registry = new WorkspaceRegistry(
		state,
		{ next: () => workspaceId },
		{ now: () => new Date('2026-08-25T00:00:00.000Z') },
		{ resolve: async () => ({ canonicalUri: 'file:///workspace', identity: 'file:1:1' }) },
		leases,
	);
	await registry.register({ localUri: 'file:///workspace', name: 'Workspace' });
	const fileSystem = new BlockingAtomicFileSystem();
	const runner = new WorkerTaskService(
		workerDeviceId,
		new StubAgentRuntime(inputId),
		registry,
		new FileTaskStore(new AtomicFileStore(
			'memory-root',
			fileSystem,
			{ next: randomUUID },
		)),
		leases,
		allowedGuard(),
		{ confirm: async () => true },
	);
	const start = runner.start(coordinatorDeviceId, {
		delegationRequestId,
		taskId,
		workspaceId,
		title: 'Blocked persistence',
		prompt: 'Persist before shutdown.',
		acceptanceCriteria: [],
		workerDeadline: '2099-08-25T01:00:00.000Z',
	});
	await fileSystem.writeStarted;
	const disposal = runner.dispose();
	fileSystem.releaseWrite();
	await assert.rejects(start, /shutting down/);
	await disposal;
	assert.equal(leases.isLeased('file:1:1'), false);
});

async function waitForTaskState(
	connection: { request(method: string, params: Record<string, unknown>): Promise<unknown> },
	state: string,
): Promise<{
	readonly state: string;
	readonly pendingInput?: { readonly inputId: string };
}> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const snapshot = await connection.request('task.get', { taskId }) as {
			readonly state: string;
			readonly pendingInput?: { readonly inputId: string };
		};
		if (snapshot.state === state) {
			return snapshot;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Task did not reach ${state}.`);
}

async function waitForRunnerState(
	runner: WorkerTaskService,
	peerId: string,
	ownedTaskId: string,
	state: string,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if ((await runner.get(peerId, ownedTaskId)).state === state) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Task did not reach ${state}.`);
}

class StubAgentRuntime implements AgentRuntime {
	public starts = 0;
	public readonly answers: AgentTaskAnswer[] = [];
	public readonly handles: StubTaskHandle[] = [];

	public constructor(
		private readonly requestId: string,
		private readonly available = true,
	) {}

	public async probe(): Promise<AgentRuntimeProbe> {
		return this.available
			? { available: true, featureEnabled: true, version: 'stub' }
			: { available: false, featureEnabled: false, reason: 'AGENT_UNAVAILABLE' };
	}

	public async start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		this.starts += 1;
		const handle = new StubTaskHandle(request.taskId, this.requestId, this.answers);
		this.handles.push(handle);
		setImmediate(() => handle.requestInput());
		return handle;
	}

	public async dispose(): Promise<void> {
		for (const handle of this.handles) {
			await handle.dispose();
		}
		this.handles.splice(0);
	}
}

function allowedGuard(): LocalDesktopWorkspaceGuard {
	return new LocalDesktopWorkspaceGuard(() => ({
		remoteName: undefined,
		isTrusted: true,
		workspaceFolders: [{ uriScheme: 'file' }],
	}));
}

class StubTaskHandle implements AgentTaskHandle {
	public readonly events = new AsyncEventQueue<AgentRuntimeEvent>();
	public cancelled = false;
	public readonly recovery = {
		clientId: 'stub-client',
		sessionUri: 'stub-session',
		chatUri: 'stub-chat',
		lastSeenServerSeq: 0,
	};

	public constructor(
		public readonly taskId: string,
		private readonly requestId: string,
		private readonly answers: AgentTaskAnswer[],
	) {}

	public requestInput(): void {
		this.events.push({
			type: 'inputRequired',
			request: {
				requestId: this.requestId,
				kind: 'chatInput',
				prompt: 'Continue?',
				fields: [{ id: 'answer', prompt: 'Continue?', required: true, type: 'string' }],
			},
		});
	}

	public async cancel(): Promise<void> {
		this.cancelled = true;
		this.events.push({ type: 'cancelled' });
		this.events.close();
	}

	public async answer(answer: AgentTaskAnswer): Promise<void> {
		this.answers.push(answer);
	}

	public async dispose(): Promise<void> {
		this.events.close();
	}
}

class MemoryState {
	private readonly values = new Map<string, unknown>();

	public get<T>(key: string): T | undefined {
		return structuredClone(this.values.get(key)) as T | undefined;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, structuredClone(value));
	}
}

class MemoryAtomicFileSystem implements AtomicFileSystem {
	private readonly files = new Map<string, string>();
	private readonly directories = new Set(['memory-root']);

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
			throw Object.assign(new Error('missing'), { code: 'ENOENT' });
		}
		return value;
	}

	public async writeFile(path: string, contents: string): Promise<void> {
		this.files.set(path, contents);
	}

	public async syncFile(_path: string): Promise<void> {}
	public async syncDirectory(_path: string): Promise<void> {}

	public async rename(from: string, to: string): Promise<void> {
		const value = await this.readFile(from);
		this.files.set(to, value);
		this.files.delete(from);
	}

	public async removeDirectory(path: string): Promise<void> {
		this.directories.delete(path);
	}

	public async unlink(path: string): Promise<void> {
		if (!this.files.delete(path)) {
			throw Object.assign(new Error('missing'), { code: 'ENOENT' });
		}
	}

	public async readdir(path: string): Promise<readonly string[]> {
		if (!this.directories.has(path)) {
			throw Object.assign(new Error('missing'), { code: 'ENOENT' });
		}
		return [...this.files.keys()]
			.filter((file) => dirname(file) === path)
			.map((file) => file.slice(path.length + 1));
	}
}

class BlockingAtomicFileSystem extends MemoryAtomicFileSystem {
	private resolveStarted!: () => void;
	private resolveReleased!: () => void;
	private shouldBlock = true;
	public readonly writeStarted = new Promise<void>((resolve) => {
		this.resolveStarted = resolve;
	});
	private readonly writeReleased = new Promise<void>((resolve) => {
		this.resolveReleased = resolve;
	});

	public override async writeFile(path: string, contents: string): Promise<void> {
		if (this.shouldBlock) {
			this.shouldBlock = false;
			this.resolveStarted();
			await this.writeReleased;
		}
		await super.writeFile(path, contents);
	}

	public releaseWrite(): void {
		this.resolveReleased();
	}
}
