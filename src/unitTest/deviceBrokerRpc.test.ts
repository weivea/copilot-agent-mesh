import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import type {
	RoutedTaskStartParams,
	TaskSnapshot,
} from '../../shared/protocol';
import { LOCAL_BROKER_METHODS } from '../../shared/protocol';
import {
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
	type NodeTaskBinding,
	type RegistryScheduler,
} from '../broker';
import type { StateStore } from '../domain/ports';
import {
	LocalIpcClient,
	LocalIpcRemoteError,
	type JsonValue,
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

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const NODE_A = '00000000-0000-4000-8000-000000000002';
const NODE_B = '00000000-0000-4000-8000-000000000003';
const INSTANCE_A = '00000000-0000-4000-8000-000000000004';
const INSTANCE_B = '00000000-0000-4000-8000-000000000005';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000006';
const TASK_A = '00000000-0000-4000-8000-000000000007';
const TASK_B = '00000000-0000-4000-8000-000000000008';
const DELEGATION_A = '00000000-0000-4000-8000-000000000009';
const DELEGATION_B = '00000000-0000-4000-8000-00000000000a';
const INPUT_ID = '00000000-0000-4000-8000-00000000000b';
const ANSWER_ID = '00000000-0000-4000-8000-00000000000c';

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
		const prefix = `${path}/`;
		return [...this.files.keys()]
			.filter((candidate) =>
				candidate.startsWith(prefix)
				&& !candidate.slice(prefix.length).includes('/'),
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

interface BrokerFixture {
	readonly broker: DeviceBroker;
	readonly state: MemoryState;
	readonly files: MemoryFileSystem;
	readonly identity: {
		readonly userIdentity: string;
		readonly deviceId: string;
		readonly tempDirectory: string;
	};
}

async function createBroker(
	state = new MemoryState(),
	files = new MemoryFileSystem(),
	identity = {
		userIdentity: randomBytes(16).toString('hex'),
		deviceId: DEVICE_ID,
		tempDirectory: `.ipc-test-${randomBytes(6).toString('hex')}`,
	},
): Promise<BrokerFixture> {
	await mkdir(identity.tempDirectory, { recursive: true, mode: 0o700 });
	const clock = { now: () => new Date() };
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
		taskService: service,
		requestTimeoutMs: 2_000,
	});
	await broker.start();
	return { broker, state, files, identity };
}

interface ClientFixture {
	readonly client: WindowNodeClient;
	readonly runtime: TestRuntime;
	readonly confirmations: WindowNodeTaskConfirmationRequest[];
	readonly executorCreations: () => number;
	readonly previousGenerationWasDrained: () => boolean;
}

function createClient(
	fixture: BrokerFixture,
	nodeId: string,
	nodeInstanceId: string,
	label: string,
): ClientFixture {
	const runtime = new TestRuntime();
	const confirmations: WindowNodeTaskConfirmationRequest[] = [];
	let executorCreations = 0;
	let previousGenerationWasDrained = true;
	const client = new WindowNodeClient({
		nodeId,
		nodeInstanceId,
		label,
		capabilities: ['tasks'],
		identity: fixture.identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		executor: ({ workspaceResolver, eventSink }) => {
			if (executorCreations > 0) {
				previousGenerationWasDrained &&= runtime.handles.every((handle) =>
					handle.cancelCalls > 0 && handle.disposeCalls > 0,
				);
			}
			executorCreations += 1;
			return new WindowNodeTaskExecutor({
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
				ids: { next: () => INPUT_ID },
				clock: { now: () => new Date() },
			});
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
	return {
		client,
		runtime,
		confirmations,
		executorCreations: () => executorCreations,
		previousGenerationWasDrained: () => previousGenerationWasDrained,
	};
}

function task(
	taskId: string,
	delegationRequestId: string,
	target: { nodeId: string; nodeInstanceId: string; workspaceId: string },
	workerDeadline = '2030-01-01T00:00:00.000Z',
): RoutedTaskStartParams {
	return {
		taskId,
		delegationRequestId,
		target: { deviceId: DEVICE_ID, ...target },
		title: 'Run local task',
		prompt: 'Implement the requested change.',
		acceptanceCriteria: ['Tests pass.'],
		workerDeadline,
	};
}

function indexedUuid(index: number): string {
	return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

test('DeviceBroker retries only resources whose disposal failed', async () => {
	let taskServiceDisposeCalls = 0;
	let registryDisposeCalls = 0;
	let taskServiceFailures = 1;
	const broker = new DeviceBroker({
		identity: {
			userIdentity: randomBytes(16).toString('hex'),
			deviceId: DEVICE_ID,
			tempDirectory: `.ipc-test-${randomBytes(6).toString('hex')}`,
		},
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
		registry: {
			dispose: () => {
				registryDisposeCalls += 1;
			},
		} as unknown as NodeRegistry,
		taskService: {
			dispose: async () => {
				taskServiceDisposeCalls += 1;
				if (taskServiceFailures > 0) {
					taskServiceFailures -= 1;
					throw new Error('task service cleanup failed');
				}
			},
		} as unknown as BrokerTaskService,
	});

	await assert.rejects(broker.dispose(), (error: unknown) =>
		error instanceof AggregateError
		&& error.errors.length === 1
		&& error.errors[0] instanceof Error
		&& error.errors[0].message === 'task service cleanup failed',
	);
	assert.equal(taskServiceDisposeCalls, 1);
	assert.equal(registryDisposeCalls, 1);

	await broker.dispose();
	assert.equal(taskServiceDisposeCalls, 2);
	assert.equal(registryDisposeCalls, 1);
	await broker.dispose();
	assert.equal(taskServiceDisposeCalls, 2);
	assert.equal(registryDisposeCalls, 1);
});

test('DeviceBroker closes sessions and drains active handlers before shared state disposal', async () => {
	const identity = {
		userIdentity: randomBytes(16).toString('hex'),
		deviceId: DEVICE_ID,
		tempDirectory: `.ipc-test-${randomBytes(6).toString('hex')}`,
	};
	await mkdir(identity.tempDirectory, { recursive: true, mode: 0o700 });
	let releaseHandler!: () => void;
	let markHandlerStarted!: () => void;
	const handlerStarted = new Promise<void>((resolve) => {
		markHandlerStarted = resolve;
	});
	const handlerGate = new Promise<void>((resolve) => {
		releaseHandler = resolve;
	});
	const disposalOrder: string[] = [];
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
		registry: {
			register: () => ({}),
			dispose: () => {
				disposalOrder.push('registry');
			},
		} as unknown as NodeRegistry,
		taskService: {
			dispose: async () => {
				disposalOrder.push('task-service');
			},
		} as unknown as BrokerTaskService,
		remoteTaskService: {
			listDevices: async () => {
				markHandlerStarted();
				await handlerGate;
				throw new Error('Expected request failure after the session closes.');
			},
		} as never,
	});
	const client = new LocalIpcClient({
		identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		clientId: INSTANCE_A,
	});
	try {
		await broker.start();
		const session = await client.connect();
		await session.request(LOCAL_BROKER_METHODS.register, {
			nodeId: NODE_A,
			nodeInstanceId: INSTANCE_A,
			label: 'Window A',
			capabilities: ['tasks'],
			status: 'online',
			startedAt: new Date().toISOString(),
		});
		const request = session.request<JsonValue>(LOCAL_BROKER_METHODS.remoteList, {});
		void request.catch(() => undefined);
		await handlerStarted;
		const disposal = broker.dispose();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(session.closed, true);
		assert.deepEqual(disposalOrder, []);
		assert.throws(
			() => broker.listNodes(),
			(error: unknown) => error instanceof Error && error.message.includes('shutting down'),
		);
		releaseHandler();
		await disposal;
		await assert.rejects(request);
		assert.deepEqual(disposalOrder, ['task-service', 'registry']);
	} finally {
		releaseHandler();
		client.dispose();
		await broker.dispose();
		await rm(identity.tempDirectory, { recursive: true, force: true });
	}
});

test('fatal background task-start closes the IPC generation after durable acceptance', async () => {
	const fixture = await createBroker();
	let executorCreations = 0;
	const client = new WindowNodeClient({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		label: 'Window A',
		capabilities: ['tasks'],
		identity: fixture.identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		executor: () => {
			executorCreations += 1;
			let generationClosed = false;
			return {
				get generationClosed() {
					return generationClosed;
				},
				start: async () => {
					generationClosed = true;
					throw new Error('Fatal executor generation failure.');
				},
				cancel: async () => undefined,
				answer: async () => undefined,
				dispose: async () => {
					generationClosed = true;
				},
			};
		},
		workspaceSource: {
			list: () => [{
				localUri: pathToFileURL(process.cwd()).href,
				name: 'Repository',
			}],
		},
		heartbeatIntervalMs: 100,
		backoff: {
			initialDelayMs: 10,
			maxDelayMs: 20,
			jitterRatio: 0,
		},
		requestTimeoutMs: 2_000,
	});
	try {
		await client.start();
		const node = (await client.listNodes()).nodes[0];
		const acknowledgement = await client.startTask(task(TASK_A, DELEGATION_A, {
			nodeId: NODE_A,
			nodeInstanceId: INSTANCE_A,
			workspaceId: node.workspaces[0].workspaceId,
		}));
		assert.equal(acknowledgement.state, 'startingAgent');
		await waitFor(async () => executorCreations === 2 && client.snapshot().registered);
		assert.equal(executorCreations, 2);
		const failed = await waitForTask(
			client,
			TASK_A,
			(snapshot) => snapshot.state === 'failed',
		);
		assert.ok([
			'TASK_EXECUTION_FAILED',
			'TASK_RECOVERY_UNAVAILABLE',
		].includes(failed.failure?.code ?? ''));
	} finally {
		await client.dispose();
		await fixture.broker.dispose();
		await rm(fixture.identity.tempDirectory, { recursive: true, force: true });
	}
});

test('WindowNodeClient retries a failed executor drain without double disposal', async () => {
	let disposeCalls = 0;
	const client = new WindowNodeClient({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		label: 'Window A',
		capabilities: ['tasks'],
		identity: {
			userIdentity: randomBytes(16).toString('hex'),
			deviceId: DEVICE_ID,
			tempDirectory: `.ipc-test-${randomBytes(6).toString('hex')}`,
		},
		brokerKey: Buffer.alloc(32, 0x5a),
		executor: {
			start: async () => {
				throw new Error('not used');
			},
			cancel: async () => undefined,
			answer: async () => undefined,
			dispose: async () => {
				disposeCalls += 1;
				if (disposeCalls === 1) {
					throw new Error('executor cleanup failed');
				}
			},
		},
		workspaceSource: { list: () => [] },
	});

	await assert.rejects(
		client.dispose(),
		(error: unknown) => error instanceof AggregateError
			&& error.errors.some((nested) =>
				nested instanceof Error && nested.message === 'executor cleanup failed',
			),
	);
	await client.dispose();
	await client.dispose();
	assert.equal(disposeCalls, 2);
});

test('routes authenticated local RPC across two nodes and fences workspace execution', async () => {
	const fixture = await createBroker();
	const windowA = createClient(fixture, NODE_A, INSTANCE_A, 'Window A');
	const windowB = createClient(fixture, NODE_B, INSTANCE_B, 'Window B');
	const { client: clientA } = windowA;
	const { client: clientB } = windowB;
	try {
		await clientA.start();
		await clientB.start();
		const directory = await clientB.listNodes();
		assert.equal(directory.nodes.length, 2);
		const nodeA = directory.nodes.find((node) => node.nodeId === NODE_A)!;
		const nodeB = directory.nodes.find((node) => node.nodeId === NODE_B)!;
		assert.equal(nodeA.workspaces[0].claimStatus, 'claimed');
		assert.equal(nodeB.workspaces[0].claimStatus, 'conflict');
		assert.equal(await clientB.resolve(nodeB.workspaces[0].workspaceId), undefined);

		await clientB.startTask(task(TASK_A, DELEGATION_A, {
			nodeId: NODE_A,
			nodeInstanceId: INSTANCE_A,
			workspaceId: nodeA.workspaces[0].workspaceId,
		}));
		assert.equal(windowA.runtime.requests.length, 1);
		assert.equal(windowA.confirmations[0].sourceWindowLabel, 'Window B');

		await emit(windowA.runtime.handles[0], {
			type: 'progress',
			message: 'Persisted progress.',
		});
		const persisted = await waitForTask(clientB, TASK_A, (snapshot) =>
			snapshot.events.some((event) => event.type === 'progress'),
		);
		assert.ok(persisted.events.some((event) => event.type === 'progress'));
		await assert.rejects(
			clientA.cancelTask(TASK_A),
			(error: unknown) => error instanceof LocalIpcRemoteError && error.code === 1007,
		);
		await clientB.cancelTask(TASK_A);
		assert.equal(windowA.runtime.handles[0].cancelCalls, 1);
		await windowA.runtime.handles[0].events.pushAndClose({ type: 'cancelled' });
		await waitForTask(clientB, TASK_A, (snapshot) => snapshot.state === 'cancelled');

		await clientB.startTask(task(TASK_B, DELEGATION_B, {
			nodeId: NODE_A,
			nodeInstanceId: INSTANCE_A,
			workspaceId: nodeA.workspaces[0].workspaceId,
		}));
		await emit(windowA.runtime.handles[1], {
			type: 'inputRequired',
			request: {
				requestId: 'runtime-input',
				kind: 'chatInput',
				prompt: 'Continue?',
				fields: [{
					id: 'response',
					prompt: 'Response',
					required: true,
					type: 'string',
				}],
			},
		});
		await waitForTask(clientB, TASK_B, (snapshot) => snapshot.state === 'needsInput');
		await assert.rejects(
			clientA.answerTask(TASK_B, INPUT_ID, ANSWER_ID, 'yes'),
			(error: unknown) => error instanceof LocalIpcRemoteError && error.code === 1007,
		);
		await clientB.answerTask(TASK_B, INPUT_ID, ANSWER_ID, 'yes');
		assert.equal(windowA.runtime.handles[1].answers.length, 1);
		await clientA.dispose();
		await waitFor(async () => {
			const offline = (await clientB.listNodes()).nodes.find((node) => node.nodeId === NODE_A);
			return offline?.status === 'offline' && offline.workspaces.length === 0;
		});
	} finally {
		await Promise.allSettled([clientA.dispose(), clientB.dispose()]);
		const endpoint = fixture.broker.endpoint.address;
		await fixture.broker.dispose();
		if (process.platform !== 'win32') {
			await assert.rejects(lstat(endpoint), { code: 'ENOENT' });
		}
		await rm(fixture.identity.tempDirectory, { recursive: true, force: true });
	}
});

test('more than one thousand definitely invalid local starts do not consume route capacity', async () => {
	const fixture = await createBroker();
	const window = createClient(fixture, NODE_A, INSTANCE_A, 'Window A');
	try {
		await window.client.start();
		const node = (await window.client.listNodes()).nodes[0];
		for (let index = 0; index < 1_001; index += 1) {
			const invalid = task(
				indexedUuid(10_000 + index),
				indexedUuid(20_000 + index),
				{
					nodeId: NODE_A,
					nodeInstanceId: index % 2 === 0 ? indexedUuid(40_000 + index) : INSTANCE_A,
					workspaceId: index % 2 === 0
						? node.workspaces[0].workspaceId
						: indexedUuid(50_000 + index),
				},
				index % 3 === 0 ? '2000-01-01T00:00:00.000Z' : undefined,
			);
			await assert.rejects(fixture.broker.startRemote(NODE_B, invalid));
		}

		const valid = task(indexedUuid(70_000), indexedUuid(70_001), {
			nodeId: NODE_A,
			nodeInstanceId: INSTANCE_A,
			workspaceId: node.workspaces[0].workspaceId,
		});
		const snapshot = await fixture.broker.startRemote(NODE_B, valid);
		assert.equal(snapshot.taskId, valid.taskId);
		await waitFor(async () => window.runtime.requests.length === 1);
		assert.equal(window.runtime.requests.length, 1);
		assert.equal(fixture.broker.taskRoutes.get(indexedUuid(10_000)), undefined);
	} finally {
		await Promise.allSettled([window.client.dispose(), fixture.broker.dispose()]);
		await rm(fixture.identity.tempDirectory, { recursive: true, force: true });
	}
});

test('requires registration and fences duplicate authenticated node instances', async () => {
	const fixture = await createBroker();
	const first = new LocalIpcClient({
		identity: fixture.identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		clientId: INSTANCE_A,
	});
	const second = new LocalIpcClient({
		identity: fixture.identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		clientId: INSTANCE_A,
	});
	try {
		const firstSession = await first.connect();
		await assert.rejects(
			firstSession.request('node.list', {}),
			(error: unknown) => error instanceof LocalIpcRemoteError && error.code === 1000,
		);
		await firstSession.request('node.register', {
			nodeId: NODE_A,
			nodeInstanceId: INSTANCE_A,
			label: 'Window A',
			capabilities: ['tasks'],
			status: 'online',
			startedAt: '2026-08-25T12:00:00.000Z',
		});
		const firstClosed = new Promise<void>((resolve) => firstSession.onClose(() => resolve()));
		const secondSession = await second.connect();
		await firstClosed;
		await assert.rejects(
			secondSession.request('node.register', {
				nodeId: NODE_B,
				nodeInstanceId: INSTANCE_A,
				label: 'Window B',
				capabilities: ['tasks'],
				status: 'online',
				startedAt: '2026-08-25T12:00:00.000Z',
			}),
			(error: unknown) => error instanceof LocalIpcRemoteError && error.code === 1011,
		);
		await secondSession.request('node.register', {
			nodeId: NODE_A,
			nodeInstanceId: INSTANCE_A,
			label: 'Window A',
			capabilities: ['tasks'],
			status: 'online',
			startedAt: '2026-08-25T12:00:00.000Z',
		});
	} finally {
		first.dispose();
		second.dispose();
		await fixture.broker.dispose();
		await rm(fixture.identity.tempDirectory, { recursive: true, force: true });
	}
});

test('broker and node deadlines stop one exact runtime handle without duplicate cleanup', async () => {
	const fixture = await createBroker();
	const window = createClient(fixture, NODE_A, INSTANCE_A, 'Window A');
	try {
		await window.client.start();
		const node = (await window.client.listNodes()).nodes[0];
		await window.client.startTask(task(
			TASK_A,
			DELEGATION_A,
			{
				nodeId: NODE_A,
				nodeInstanceId: INSTANCE_A,
				workspaceId: node.workspaces[0].workspaceId,
			},
			new Date(Date.now() + 200).toISOString(),
		));
		const snapshot = await waitForTask(
			window.client,
			TASK_A,
			(candidate) => candidate.state === 'timedOut',
		);
		assert.equal(snapshot.failure?.code, 'TASK_TIMED_OUT');
		const handle = window.runtime.handles[0];
		await waitFor(async () => handle.cancelCalls === 1 && handle.disposeCalls === 1);
		assert.equal(handle.cancelCalls, 1);
		assert.equal(handle.disposeCalls, 1);
	} finally {
		await window.client.dispose();
		await fixture.broker.dispose();
		await rm(fixture.identity.tempDirectory, { recursive: true, force: true });
	}
});

test('reconnects and reclaims after a broker restart', async () => {
	const first = await createBroker();
	const window = createClient(first, NODE_A, INSTANCE_A, 'Window A');
	const { client } = window;
	let second: BrokerFixture | undefined;
	try {
		await client.start();
		const originalNode = (await client.listNodes()).nodes[0];
		assert.equal(originalNode.workspaces[0].claimStatus, 'claimed');
		await client.startTask(task(TASK_A, DELEGATION_A, {
			nodeId: NODE_A,
			nodeInstanceId: INSTANCE_A,
			workspaceId: originalNode.workspaces[0].workspaceId,
		}));
		await waitFor(async () => window.runtime.handles.length === 1);
		const oldHandle = window.runtime.handles[0];
		await first.broker.dispose();
		await waitFor(async () =>
			oldHandle.cancelCalls === 1 && oldHandle.disposeCalls === 1,
		);
		second = await createBroker(first.state, first.files, first.identity);
		await waitFor(async () => {
			try {
				const node = (await client.listNodes()).nodes.find((candidate) =>
					candidate.nodeId === NODE_A,
				);
				return node?.workspaces[0]?.claimStatus === 'claimed';
			} catch {
				return false;
			}
		});
		assert.equal(window.executorCreations(), 2);
		assert.equal(window.previousGenerationWasDrained(), true);
	} finally {
		await client.dispose();
		await second?.broker.dispose();
		await rm(first.identity.tempDirectory, { recursive: true, force: true });
	}
});

test('executor cleanup failure blocks reconnect and workspace reclaim', async () => {
	const first = await createBroker();
	const errors: string[] = [];
	let executorCreations = 0;
	const client = new WindowNodeClient({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		label: 'Window A',
		capabilities: ['tasks'],
		identity: first.identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		executor: () => {
			executorCreations += 1;
			return {
				start: () => Promise.reject(new Error('not used')),
				cancel: () => Promise.reject(new Error('not used')),
				answer: () => Promise.reject(new Error('not used')),
				dispose: () => Promise.reject(new Error('executor cleanup failed')),
			};
		},
		workspaceSource: { list: () => [] },
		heartbeatIntervalMs: 100,
		backoff: {
			initialDelayMs: 10,
			maxDelayMs: 20,
			jitterRatio: 0,
		},
		requestTimeoutMs: 2_000,
		onError: (error) => errors.push(error.message),
	});
	let second: BrokerFixture | undefined;
	try {
		await client.start();
		await first.broker.dispose();
		await waitFor(async () =>
			errors.some((message) => message.includes('reclaim is blocked')),
		);
		second = await createBroker(first.state, first.files, first.identity);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(executorCreations, 1);
		assert.equal(client.snapshot().registered, false);
		assert.equal(client.snapshot().state, 'reconnecting');
		await assert.rejects(client.dispose(), /cleanup failed/u);
	} finally {
		await client.dispose().catch(() => undefined);
		await second?.broker.dispose();
		await rm(first.identity.tempDirectory, { recursive: true, force: true });
	}
});

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

async function emit(handle: TestHandle, event: AgentRuntimeEvent): Promise<void> {
	assert.equal(await handle.events.push(event), true);
}

function notFound(): NodeJS.ErrnoException {
	const error = new Error('not found') as NodeJS.ErrnoException;
	error.code = 'ENOENT';
	return error;
}
