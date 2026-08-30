import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { test } from 'node:test';

import type { RoutedTaskStartParams } from '../../shared/protocol';
import { createAcceptedRoutedTask } from '../domain/task';
import type { StateStore } from '../domain/ports';
import { GatewayRouter } from '../gateway/GatewayRouter';
import type { SecretStore } from '../gateway/SecretStore';
import {
	LazyVscodeDevTunnelProvider,
	type LazyDevTunnelDelegate,
} from '../composition/LazyVscodeDevTunnelProvider';
import { ProductionBrokerRuntime } from '../composition/ProductionBrokerRuntime';
import {
	ensureOwnedBrokerKey,
	LOCAL_BROKER_KEY_SECRET,
	waitForBrokerKey,
	waitForDeviceProfile,
} from '../composition/SharedBrokerIdentity';
import {
	AtomicFileStore,
	type AtomicFileSystem,
} from '../storage/AtomicFileStore';
import { DeviceProfileStore } from '../storage/DeviceProfileStore';
import type {
	BrokerOwnership,
	BrokerOwnershipSnapshot,
} from '../storage/BrokerOwnerLock';
import { FileTaskStore } from '../tasks/FileTaskStore';
import type {
	DevTunnelRuntimeStatus,
	TunnelMetadata,
} from '../tunnel/DevTunnelProvider';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const NODE_ID = '00000000-0000-4000-8000-000000000002';
const INSTANCE_ID = '00000000-0000-4000-8000-000000000003';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000004';
const TASK_ID = '00000000-0000-4000-8000-000000000005';
const DELEGATION_ID = '00000000-0000-4000-8000-000000000006';
const PEER_ID = '00000000-0000-4000-8000-000000000007';

test('production composition uses per-window runtime and local Broker tools', () => {
	const application = source('src/composition/createApplication.ts');
	const owner = source('src/composition/ProductionBrokerRuntime.ts');
	const remote = source('src/composition/ProductionRemoteTaskAdapter.ts');
	const runtime = source('src/composition/VscodeAgentRuntime.ts');
	assert.match(application, /new BrokerLifecycle/u);
	assert.match(application, /new WindowNodeClient/u);
	assert.match(application, /new WindowNodeTaskExecutor/u);
	assert.match(application, /createVscodeAgentRuntime/u);
	assert.match(application, /new LocalBrokerTaskFacade/u);
	assert.match(application, /new LocalBrokerCollaborationFacade/u);
	assert.match(application, /new LocalIpcRemoteTaskAdapter\(node\)/u);
	assert.match(application, /remoteAdapter: remoteTasks/u);
	assert.match(application, /registerMeshTaskTools\(localTasks, localCollaborations\)/u);
	assert.match(owner, /new ProductionRemoteTaskAdapter\(\s*peers,\s*peerProfiles,\s*fencedState/u);
	assert.match(owner, /remoteTaskService: remoteTasks/u);
	assert.doesNotMatch(application, /WorkerTaskService|registerMeshTaskTools\(coordinator\)/u);
	assert.doesNotMatch(owner, /new DevTunnelCliProvider|import\('\.\.\/tunnel\/DevTunnelCliProvider/u);
	assert.doesNotMatch(remote, /DevTunnel|tunnel\./u);
	assert.doesNotMatch(runtime, /WorkerOwnership|ownership\.assertOwner|ownership\.isOwner/u);
});

test('only the owner creates one stable 32-byte local Broker key while contenders wait', async () => {
	const secrets = new MemorySecrets();
	const owner = new TestOwnership(true, 'generation-1');
	const key = await ensureOwnedBrokerKey(secrets, owner, 'generation-1');
	assert.equal(Buffer.from(key, 'base64url').byteLength, 32);
	assert.equal(secrets.storeCalls, 1);
	assert.equal(await ensureOwnedBrokerKey(secrets, owner, 'generation-1'), key);
	assert.equal(secrets.storeCalls, 1);

	const empty = new MemorySecrets();
	const contender = new TestOwnership(false);
	await assert.rejects(
		ensureOwnedBrokerKey(empty, contender, 'generation-2'),
		/no longer owns/u,
	);
	assert.equal(empty.storeCalls, 0);
	const wait = waitForBrokerKey(empty, { intervalMs: 1, timeoutMs: 100 });
	setTimeout(() => {
		void empty.store(
			LOCAL_BROKER_KEY_SECRET,
			Buffer.alloc(32, 0x4a).toString('base64url'),
		);
	}, 5);
	assert.equal(Buffer.from(await wait, 'base64url').byteLength, 32);
});

test('a contender waits for the owner-created stable device profile', async () => {
	const state = new MemoryState();
	const environment = {
		defaultName: 'Device',
		platform: 'darwin' as const,
		architecture: 'arm64',
		vscodeVersion: '1.103.0',
		extensionVersion: '0.2.0',
	};
	const wait = waitForDeviceProfile(state, environment, {
		intervalMs: 1,
		timeoutMs: 100,
	});
	setTimeout(() => {
		void new DeviceProfileStore(
			state,
			{ next: () => DEVICE_ID },
			{ now: () => new Date('2026-08-25T00:00:00.000Z') },
		).getOrCreate(environment);
	}, 5);
	const profile = await wait;
	assert.equal(profile.deviceId, DEVICE_ID);
	assert.equal(new DeviceProfileStore(
		state,
		{ next: () => {
			throw new Error('must not create');
		} },
		{ now: () => new Date() },
	).getReadOnly(environment).deviceId, DEVICE_ID);
});

test('task files reject writes after the captured Broker generation is lost', async () => {
	const ownership = new TestOwnership(true, 'generation-1');
	const files = new MemoryFileSystem();
	const store = new FileTaskStore(
		new AtomicFileStore('memory', files, { next: () => 'write-id' }),
		{ now: () => new Date('2026-08-25T00:00:00.000Z') },
		{ ownership, generation: 'generation-1' },
	);
	await store.create(createAcceptedRoutedTask({
		peerId: PEER_ID,
		delegationRequestId: DELEGATION_ID,
		taskId: TASK_ID,
		target: {
			deviceId: DEVICE_ID,
			nodeId: NODE_ID,
			nodeInstanceId: INSTANCE_ID,
			workspaceId: WORKSPACE_ID,
		},
		workspaceLeaseKey: 'opaque-workspace-identity',
		title: 'Generation fence',
		prompt: 'Do not persist after takeover.',
		acceptanceCriteria: [],
		workerDeadline: '2030-01-01T00:00:00.000Z',
	}, '2026-08-25T00:00:00.000Z'));
	ownership.owner = false;
	ownership.generation = 'generation-2';
	await assert.rejects(
		store.transitionOwned(PEER_ID, TASK_ID, {
			type: 'agentStartRequested',
			at: '2026-08-25T00:00:01.000Z',
		}),
		/generation changed before/u,
	);
	assert.equal((await store.getOwned(PEER_ID, TASK_ID))?.state, 'accepted');
});

test('v2 Gateway routes node directory and explicit tasks through DeviceBroker', async () => {
	let started: RoutedTaskStartParams | undefined;
	const broker = {
		listNodes: () => ({
			deviceId: DEVICE_ID,
			nodes: [],
			truncated: false,
			totalNodes: 0,
		}),
		startRemote: async (_peerId: string, input: RoutedTaskStartParams) => {
			started = input;
			return { accepted: true };
		},
		getRemote: async () => ({ state: 'running' }),
		cancelRemote: async () => ({ state: 'cancelled' }),
		answerRemote: async () => ({ state: 'running' }),
	};
	const router = new GatewayRouter(
		{ getInfo: async () => ({ deviceId: DEVICE_ID }) },
		broker,
	);
	assert.equal(router.hasMethod('node.list'), true);
	assert.equal(router.hasMethod('workspace.list'), false);
	assert.deepEqual(await router.dispatch(PEER_ID, 'node.list', {}), {
		deviceId: DEVICE_ID,
		nodes: [],
		truncated: false,
		totalNodes: 0,
	});
	const input = routedTask();
	await router.dispatch(PEER_ID, 'task.start', input);
	assert.deepEqual(started, input);
	await assert.rejects(
		router.dispatch(PEER_ID, 'task.start', { ...input, sourceNodeId: NODE_ID }),
		/cannot claim a local source/u,
	);
});

test('local Broker startup and cleanup do not load the Dev Tunnel provider', async () => {
	let loads = 0;
	const delegate = new RecordingTunnel();
	const tunnel = new LazyVscodeDevTunnelProvider({
		stateStore: {
			load: async () => undefined,
			save: async () => undefined,
		},
		loadProvider: async () => {
			loads += 1;
			return delegate;
		},
	});
	assert.deepEqual(tunnel.getStatus(), { state: 'stopped' });
	await tunnel.stop();
	assert.equal(loads, 0);
	await tunnel.probe();
	assert.equal(loads, 1);
	await tunnel.dispose();
});

test('lazy Dev Tunnel disposal waits for an in-flight load and rejects later loads', async () => {
	const load = deferred<RecordingTunnel>();
	const delegate = new RecordingTunnel();
	const tunnel = new LazyVscodeDevTunnelProvider({
		stateStore: {
			load: async () => undefined,
			save: async () => undefined,
		},
		loadProvider: () => load.promise,
	});
	const probe = tunnel.probe();
	const disposal = tunnel.dispose();
	let disposalSettled = false;
	void disposal.finally(() => {
		disposalSettled = true;
	});

	await assert.rejects(tunnel.probe(), /disposed/u);
	await Promise.resolve();
	assert.equal(disposalSettled, false);

	load.resolve(delegate);
	await assert.rejects(probe, /disposed while loading/u);
	await disposal;
	assert.equal(delegate.probeCalls, 0);
	assert.equal(delegate.disposeCalls, 1);
	assert.equal(delegate.subscriptionDisposeCalls, 1);
});

test('lazy Dev Tunnel delegate cleanup failure is retryable and success is idempotent', async () => {
	const delegate = new RecordingTunnel();
	delegate.disposeFailures = 1;
	const tunnel = createLazyTunnel(delegate);
	await tunnel.probe();

	await assert.rejects(tunnel.dispose(), (error: unknown) =>
		error instanceof AggregateError
		&& error.errors.some((failure) =>
			failure instanceof Error && failure.message === 'delegate cleanup failed',
		),
	);
	assert.equal(delegate.disposeCalls, 1);
	await assert.rejects(tunnel.probe(), /disposed/u);

	await tunnel.dispose();
	assert.equal(delegate.disposeCalls, 2);
	await tunnel.dispose();
	assert.equal(delegate.disposeCalls, 2);
});

test('lazy Dev Tunnel retries only failed subscription cleanup', async () => {
	const delegate = new RecordingTunnel();
	delegate.subscriptionDisposeFailures = 1;
	const tunnel = createLazyTunnel(delegate);
	await tunnel.probe();

	await assert.rejects(tunnel.dispose(), AggregateError);
	assert.equal(delegate.disposeCalls, 1);
	assert.equal(delegate.subscriptionDisposeCalls, 1);

	await tunnel.dispose();
	assert.equal(delegate.disposeCalls, 1);
	assert.equal(delegate.subscriptionDisposeCalls, 2);
	await tunnel.dispose();
	assert.equal(delegate.subscriptionDisposeCalls, 2);
});

test('lazy Dev Tunnel clears a rejected load so a later load can retry', async () => {
	const delegate = new RecordingTunnel();
	let loads = 0;
	const tunnel = new LazyVscodeDevTunnelProvider({
		stateStore: {
			load: async () => undefined,
			save: async () => undefined,
		},
		loadProvider: async () => {
			loads += 1;
			if (loads === 1) {
				throw new Error('load failed');
			}
			return delegate;
		},
	});

	await assert.rejects(tunnel.probe(), /load failed/u);
	await tunnel.probe();
	assert.equal(loads, 2);
	await tunnel.dispose();
});

test('production runtime retries failed resources without disposing successful resources twice', async () => {
	const listener = new RuntimeResource(1);
	const peers = new RuntimePeerResource();
	const broker = new RuntimeResource(1);
	const subscriptions = [
		new RuntimeSubscription(),
		new RuntimeSubscription(),
		new RuntimeSubscription(),
	];
	let subscriptionIndex = 0;
	let disposedNotifications = 0;
	let changeNotifications = 0;
	const runtime = Reflect.construct(ProductionBrokerRuntime, [
		{
			onDisposed: () => {
				disposedNotifications += 1;
			},
			onDidChange: () => {
				changeNotifications += 1;
			},
		},
		{
			device: {},
			profile: {},
			leases: {},
			registry: {},
			tasks: {},
			brokerTasks: {},
			broker,
			peerProfiles: {},
			peers: Object.assign(peers, {
				onDidChange: () => () => subscriptions[subscriptionIndex++]!.dispose(),
				onNotification: () => () => subscriptions[subscriptionIndex++]!.dispose(),
			}),
			coordinator: {},
			remoteTasks: {},
			listener: Object.assign(listener, {
				onDidChange: () => subscriptions[subscriptionIndex++]!,
			}),
			tunnel: {},
		},
	]) as ProductionBrokerRuntime;

	await assert.rejects(runtime.dispose(), (error: unknown) =>
		error instanceof AggregateError && error.errors.length === 2,
	);
	assert.equal(listener.disposeCalls, 1);
	assert.equal(peers.disposeCalls, 1);
	assert.equal(broker.disposeCalls, 1);
	assert.deepEqual(subscriptions.map(({ disposeCalls }) => disposeCalls), [1, 1, 1]);
	assert.equal(disposedNotifications, 0);
	assert.equal(changeNotifications, 0);

	await runtime.dispose();
	assert.equal(listener.disposeCalls, 2);
	assert.equal(peers.disposeCalls, 1);
	assert.equal(broker.disposeCalls, 2);
	assert.deepEqual(subscriptions.map(({ disposeCalls }) => disposeCalls), [1, 1, 1]);
	assert.equal(disposedNotifications, 1);
	assert.equal(changeNotifications, 1);

	await runtime.dispose();
	assert.equal(listener.disposeCalls, 2);
	assert.equal(peers.disposeCalls, 1);
	assert.equal(broker.disposeCalls, 2);
	assert.equal(disposedNotifications, 1);
	assert.equal(changeNotifications, 1);
});

function routedTask(): RoutedTaskStartParams {
	return {
		delegationRequestId: DELEGATION_ID,
		taskId: TASK_ID,
		target: {
			deviceId: DEVICE_ID,
			nodeId: NODE_ID,
			nodeInstanceId: INSTANCE_ID,
			workspaceId: WORKSPACE_ID,
		},
		title: 'Explicit route',
		prompt: 'Use the selected Window Node only.',
		acceptanceCriteria: [],
		workerDeadline: '2030-01-01T00:00:00.000Z',
	};
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

class MemorySecrets implements SecretStore {
	private readonly values = new Map<string, string>();
	public storeCalls = 0;

	public get(key: string): Promise<string | undefined> {
		return Promise.resolve(this.values.get(key));
	}

	public async store(key: string, value: string): Promise<void> {
		this.storeCalls += 1;
		this.values.set(key, value);
	}

	public async delete(key: string): Promise<void> {
		this.values.delete(key);
	}
}

class TestOwnership implements BrokerOwnership {
	public constructor(
		public owner: boolean,
		public generation: string | undefined = undefined,
	) {}

	public isOwner(): boolean {
		return this.owner;
	}

	public currentGeneration(): string | undefined {
		return this.owner ? this.generation : undefined;
	}

	public snapshot(): BrokerOwnershipSnapshot {
		return {
			owner: this.owner,
			instanceId: 'window',
			generation: this.currentGeneration(),
		};
	}

	public async assertOwner(): Promise<void> {
		if (!this.owner) {
			throw new Error('not owner');
		}
	}

	public async contend(): Promise<boolean> {
		return this.owner;
	}

	public onDidLoseOwnership(): { dispose(): void } {
		return { dispose: () => undefined };
	}

	public async dispose(): Promise<void> {
		this.owner = false;
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
		const prefix = `${path}${sep}`;
		return [...this.files.keys()]
			.filter((candidate) =>
				candidate.startsWith(prefix)
				&& !candidate.slice(prefix.length).includes(sep),
			)
			.map((candidate) => candidate.slice(prefix.length));
	}
}

class RecordingTunnel implements LazyDevTunnelDelegate {
	public status: DevTunnelRuntimeStatus = { state: 'stopped' };
	public probeCalls = 0;
	public disposeCalls = 0;
	public disposeFailures = 0;
	public subscriptionDisposeCalls = 0;
	public subscriptionDisposeFailures = 0;

	public async probe() {
		this.probeCalls += 1;
		return { loggedIn: true, supported: true };
	}

	public async ensureHosted(): Promise<never> {
		throw new Error('not used');
	}

	public async renewAccess(): Promise<TunnelMetadata> {
		throw new Error('not used');
	}

	public async stop(): Promise<void> {}
	public async dispose(): Promise<void> {
		this.disposeCalls += 1;
		if (this.disposeFailures > 0) {
			this.disposeFailures -= 1;
			throw new Error('delegate cleanup failed');
		}
	}
	public getStatus(): DevTunnelRuntimeStatus {
		return this.status;
	}
	public onDidChange(): { dispose(): void } {
		return {
			dispose: () => {
				this.subscriptionDisposeCalls += 1;
				if (this.subscriptionDisposeFailures > 0) {
					this.subscriptionDisposeFailures -= 1;
					throw new Error('subscription cleanup failed');
				}
			},
		};
	}
	public async deleteOwnedForE2e(): Promise<'already-absent'> {
		return 'already-absent';
	}
	public async ownedMetadataForE2e(): Promise<never> {
		throw new Error('not used');
	}
}

class RuntimeResource {
	public disposeCalls = 0;

	public constructor(private failures: number) {}

	public async dispose(): Promise<void> {
		this.disposeCalls += 1;
		if (this.failures > 0) {
			this.failures -= 1;
			throw new Error('runtime resource cleanup failed');
		}
	}
}

class RuntimePeerResource extends RuntimeResource {
	public constructor() {
		super(0);
	}
}

class RuntimeSubscription {
	public disposeCalls = 0;

	public dispose(): void {
		this.disposeCalls += 1;
	}
}

function createLazyTunnel(delegate: RecordingTunnel): LazyVscodeDevTunnelProvider {
	return new LazyVscodeDevTunnelProvider({
		stateStore: {
			load: async () => undefined,
			save: async () => undefined,
		},
		loadProvider: async () => delegate,
	});
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function notFound(): NodeJS.ErrnoException {
	const error = new Error('not found') as NodeJS.ErrnoException;
	error.code = 'ENOENT';
	return error;
}

function source(path: string): string {
	return readFileSync(resolve(__dirname, `../../../${path}`), 'utf8');
}
