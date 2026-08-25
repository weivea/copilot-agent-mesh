import * as assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type * as vscode from 'vscode';

import type {
	AgentRuntime,
	AgentRuntimeProbe,
	AgentTaskHandle,
	AgentTaskRequest,
} from '../agentHost/AgentRuntime';
import { ListenerService, type ListenerGateway, type ListenerPairing } from '../application/ListenerService';
import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { WorkerTaskService } from '../application/RemoteTaskRunner';
import { getWorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import { VscodeSessionConfigurationResolver } from '../composition/VscodeAgentRuntime';
import {
	AtomicFileStore,
	NodeAtomicFileSystem,
} from '../storage/AtomicFileStore';
import { WorkerOwnerLock } from '../storage/WorkerOwnerLock';
import { FileTaskStore } from '../tasks/FileTaskStore';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import type {
	DevTunnelProvider,
	DevTunnelRuntimeStatus,
	HostedTunnel,
	TunnelCapability,
	TunnelMetadata,
	TunnelRequest,
} from '../tunnel/DevTunnelProvider';
import { WorkspaceRegistry } from '../workspaces/WorkspaceRegistry';

const temporaryDirectories: string[] = [];
const deviceId = '00000000-0000-4000-8000-000000000001';
const peerId = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000003';
const taskId = '00000000-0000-4000-8000-000000000004';
const delegationRequestId = '00000000-0000-4000-8000-000000000005';

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) =>
		rm(path, { recursive: true, force: true }),
	));
});

test('only one Extension Host owns Worker services and non-owner disposal cannot remove its lock', async () => {
	const root = await makeDirectory();
	const alive = (pid: number): boolean => pid === 101 || pid === 202;
	const first = await WorkerOwnerLock.acquire(root, {
		pid: 101,
		instanceId: 'first-window',
		token: 'first-token',
		pidAlive: alive,
		heartbeatMs: 60_000,
	});
	const second = await WorkerOwnerLock.acquire(root, {
		pid: 202,
		instanceId: 'second-window',
		token: 'second-token',
		pidAlive: alive,
		heartbeatMs: 60_000,
	});
	assert.equal(first.isOwner(), true);
	assert.equal(second.isOwner(), false);
	assert.equal(second.snapshot().holderInstanceId, 'first-window');
	await assert.rejects(second.assertOwner(), /Another VS Code window/u);
	await second.dispose();
	await first.assertOwner();
	await first.dispose();
});

test('stale owner lock can be atomically taken over without old-token deletion', async () => {
	const root = await makeDirectory();
	let now = Date.parse('2026-08-25T00:00:00.000Z');
	const first = await WorkerOwnerLock.acquire(root, {
		pid: 101,
		instanceId: 'stale-window',
		token: 'stale-token',
		now: () => now,
		ttlMs: 100,
		heartbeatMs: 60_000,
		pidAlive: () => false,
	});
	let lossEvents = 0;
	first.onDidLoseOwnership(() => {
		lossEvents += 1;
	});
	now += 101;
	const second = await WorkerOwnerLock.acquire(root, {
		pid: 202,
		instanceId: 'takeover-window',
		token: 'takeover-token',
		now: () => now,
		ttlMs: 100,
		heartbeatMs: 60_000,
		pidAlive: () => false,
	});
	assert.equal(second.isOwner(), true);
	await assert.rejects(first.assertOwner(), /Another VS Code window/u);
	assert.equal(lossEvents, 1);
	await first.dispose();
	await second.assertOwner();
	await second.dispose();
});

test('expired heartbeat cannot fence out a still-live owner process', async () => {
	const root = await makeDirectory();
	let now = Date.parse('2026-08-25T00:00:00.000Z');
	const first = await WorkerOwnerLock.acquire(root, {
		pid: 101,
		instanceId: 'live-window',
		token: 'live-token',
		now: () => now,
		ttlMs: 100,
		heartbeatMs: 60_000,
		pidAlive: (pid) => pid === 101,
	});
	now += 10_000;
	const second = await WorkerOwnerLock.acquire(root, {
		pid: 202,
		instanceId: 'contender-window',
		token: 'contender-token',
		now: () => now,
		ttlMs: 100,
		heartbeatMs: 60_000,
		pidAlive: (pid) => pid === 101,
	});
	assert.equal(first.isOwner(), true);
	assert.equal(second.isOwner(), false);
	await first.assertOwner();
	await second.dispose();
	await first.dispose();
});

test('fresh in-progress lock files are not mistaken for stale owners', async () => {
	const root = await makeDirectory();
	const lockPath = join(root, 'worker-owner.lock');
	await writeFile(lockPath, '', { mode: 0o600 });
	const metadata = await stat(lockPath);
	let now = metadata.mtimeMs;
	const blocked = await WorkerOwnerLock.acquire(root, {
		pid: 202,
		instanceId: 'blocked-window',
		token: 'blocked-token',
		now: () => now,
		ttlMs: 100,
		heartbeatMs: 60_000,
		pidAlive: () => true,
	});
	assert.equal(blocked.isOwner(), false);
	await blocked.dispose();
	now += 101;
	const takeover = await WorkerOwnerLock.acquire(root, {
		pid: 202,
		instanceId: 'takeover-window',
		token: 'takeover-token',
		now: () => now,
		ttlMs: 100,
		heartbeatMs: 60_000,
		pidAlive: () => true,
	});
	assert.equal(takeover.isOwner(), true);
	await takeover.dispose();
});

test('non-owner window does not read active tasks or touch listener resources', async () => {
	const root = await makeDirectory();
	const owner = await WorkerOwnerLock.acquire(root, {
		pid: 101,
		instanceId: 'owner',
		token: 'owner-token',
		pidAlive: () => true,
		heartbeatMs: 60_000,
	});
	const nonOwner = await WorkerOwnerLock.acquire(root, {
		pid: 202,
		instanceId: 'coordinator-only',
		token: 'non-owner-token',
		pidAlive: () => true,
		heartbeatMs: 60_000,
	});
	const taskStore = new CountingTaskStore(root);
	const leases = new WorkspaceLeaseManager();
	const worker = new WorkerTaskService(
		deviceId,
		new UnusedRuntime(),
		new WorkspaceRegistry(
			new MemoryState(),
			{ next: () => workspaceId },
			{ now: () => new Date() },
			{ resolve: async () => ({ canonicalUri: 'file:///workspace', identity: 'file:1:1' }) },
			leases,
		),
		taskStore,
		leases,
		allowedGuard(),
		{ confirm: async () => true },
		{ ownership: nonOwner },
	);
	await assert.rejects(worker.initialize(), /Another VS Code window/u);
	await assert.rejects(worker.start(peerId, {
		delegationRequestId,
		taskId,
		workspaceId,
		title: 'Must not register',
		prompt: 'Do not touch active tasks.',
		acceptanceCriteria: [],
		workerDeadline: '2099-01-01T00:00:00.000Z',
	}), /Another VS Code window/u);
	assert.equal(taskStore.recoveryReads, 0);
	assert.equal(taskStore.listReads, 0);

	const tunnel = new CountingTunnel();
	let gatewayCreates = 0;
	const listener = new ListenerService(
		deviceId,
		new CountingPairing(),
		tunnel,
		() => {
			gatewayCreates += 1;
			return new UnusedGateway();
		},
		new MemoryState(),
		allowedGuard(),
		{
			workerPlatform: getWorkerPlatformSupport('darwin', 'arm64'),
			ownership: nonOwner,
		},
	);
	await assert.rejects(listener.start(), /Another VS Code window/u);
	assert.equal(tunnel.probeCalls, 0);
	assert.equal(gatewayCreates, 0);
	await listener.dispose();
	assert.equal(tunnel.disposeCalls, 0);
	await worker.dispose();
	await nonOwner.dispose();
	await owner.dispose();
});

test('dynamic configuration search drops stale completions and exposes more than 100 results', async () => {
	const picker = new TestQuickPick();
	const resolver = new VscodeSessionConfigurationResolver(vscodeWithPicker(picker), 1);
	const requests: Array<{
		readonly query: string;
		readonly signal: AbortSignal | undefined;
		readonly result: Deferred<readonly { readonly value: string; readonly label: string }[]>;
	}> = [];
	const resolution = resolver.resolve({
		schema: {
			type: 'object',
			required: ['model'],
			properties: {
				model: { type: 'string', title: 'Model', enumDynamic: true },
			},
		},
		values: {},
		interactive: true,
		completions: async (_property, _values, query, signal) => {
			const result = deferred<readonly { readonly value: string; readonly label: string }[]>();
			requests.push({ query, signal, result });
			return result.promise;
		},
	});
	await waitFor(() => requests.length === 1);
	picker.emitValue('old');
	await new Promise((resolve) => setTimeout(resolve, 3));
	picker.emitValue('new');
	await new Promise((resolve) => setTimeout(resolve, 3));
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.signal?.aborted, true);
	requests[0]?.result.resolve([{ value: 'stale-value', label: 'Stale result' }]);
	await waitFor(() => requests.length === 2);
	const latest = Array.from({ length: 150 }, (_, index) => ({
		value: `new-${index}`,
		label: `New model ${index}`,
	}));
	assert.equal(requests[1]?.query, 'new');
	requests[1]?.result.resolve(latest);
	await waitFor(() => picker.items.length === 150);
	assert.equal(picker.items.length, 150);
	assert.equal(picker.items[0]?.completionValue, 'new-0');
	picker.selectedItems = [picker.items[149]!];
	picker.emitAccept();
	assert.deepStrictEqual(await resolution, { model: 'new-149' });
	assert.equal(picker.disposed, true);
});

test('closing dynamic configuration search aborts the active completion request', async () => {
	const picker = new TestQuickPick();
	const resolver = new VscodeSessionConfigurationResolver(vscodeWithPicker(picker), 1);
	let activeSignal: AbortSignal | undefined;
	const resolution = resolver.resolve({
		schema: {
			type: 'object',
			required: ['model'],
			properties: {
				model: { type: 'string', title: 'Model', enumDynamic: true },
			},
		},
		values: {},
		interactive: true,
		completions: async (_property, _values, _query, signal) => {
			activeSignal = signal;
			return new Promise(() => undefined);
		},
	});
	await waitFor(() => activeSignal !== undefined);
	picker.emitHide();
	await assert.rejects(resolution, /cancelled/u);
	assert.equal(activeSignal?.aborted, true);
	assert.equal(picker.disposed, true);
});

class MemoryState {
	private readonly values = new Map<string, unknown>();

	public get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

class CountingTaskStore extends FileTaskStore {
	public recoveryReads = 0;
	public listReads = 0;

	public constructor(root: string) {
		super(new AtomicFileStore(root, new NodeAtomicFileSystem(), { next: () => 'temp-id' }));
	}

	public override async listForRecovery() {
		this.recoveryReads += 1;
		return super.listForRecovery();
	}

	public override async list() {
		this.listReads += 1;
		return super.list();
	}
}

class UnusedRuntime implements AgentRuntime {
	public async probe(): Promise<AgentRuntimeProbe> {
		throw new Error('Runtime must not be probed by a non-owner.');
	}

	public async start(_request: AgentTaskRequest): Promise<AgentTaskHandle> {
		throw new Error('Runtime must not start for a non-owner.');
	}

	public async dispose(): Promise<void> {}
}

class CountingTunnel implements DevTunnelProvider {
	public probeCalls = 0;
	public disposeCalls = 0;

	public async probe(): Promise<TunnelCapability> {
		this.probeCalls += 1;
		throw new Error('Tunnel must not be probed by a non-owner.');
	}

	public async ensureHosted(_request: TunnelRequest): Promise<HostedTunnel> {
		throw new Error('not used');
	}

	public async renewAccess(): Promise<TunnelMetadata> {
		throw new Error('not used');
	}

	public async stop(): Promise<void> {}

	public async dispose(): Promise<void> {
		this.disposeCalls += 1;
	}

	public getStatus(): DevTunnelRuntimeStatus {
		return { state: 'stopped' };
	}
}

class CountingPairing implements ListenerPairing {
	public async createInvitation(): Promise<{ readonly url: string }> {
		throw new Error('Pairing must not be touched by a non-owner.');
	}

	public async dispose(): Promise<void> {
		throw new Error('Pairing must not be disposed by a non-owner.');
	}
}

class UnusedGateway implements ListenerGateway {
	public async start(): Promise<{ readonly port: number }> {
		throw new Error('Gateway must not be created by a non-owner.');
	}

	public async dispose(): Promise<void> {}
	public async notifyPeer(): Promise<void> {}
}

interface TestCompletionItem extends vscode.QuickPickItem {
	readonly completionValue: string;
}

class TestQuickPick {
	public title: string | undefined;
	public placeholder: string | undefined;
	public ignoreFocusOut = false;
	public matchOnDescription = false;
	public matchOnDetail = false;
	public keepScrollPosition = false;
	public busy = false;
	public items: readonly TestCompletionItem[] = [];
	public selectedItems: readonly TestCompletionItem[] = [];
	public activeItems: readonly TestCompletionItem[] = [];
	public disposed = false;
	private readonly valueListeners = new Set<(value: string) => void>();
	private readonly acceptListeners = new Set<() => void>();
	private readonly hideListeners = new Set<() => void>();

	public readonly onDidChangeValue = this.event(this.valueListeners);
	public readonly onDidAccept = this.event(this.acceptListeners);
	public readonly onDidHide = this.event(this.hideListeners);

	public show(): void {}

	public dispose(): void {
		this.disposed = true;
	}

	public emitValue(value: string): void {
		for (const listener of this.valueListeners) {
			listener(value);
		}
	}

	public emitAccept(): void {
		for (const listener of this.acceptListeners) {
			listener();
		}
	}

	public emitHide(): void {
		for (const listener of this.hideListeners) {
			listener();
		}
	}

	private event<T>(listeners: Set<(value: T) => void>) {
		return (listener: (value: T) => void): vscode.Disposable => {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		};
	}
}

function vscodeWithPicker(picker: TestQuickPick): typeof vscode {
	return {
		window: {
			createQuickPick: () => picker,
		},
	} as unknown as typeof vscode;
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function allowedGuard(): LocalDesktopWorkspaceGuard {
	return new LocalDesktopWorkspaceGuard(() => ({
		remoteName: undefined,
		isTrusted: true,
		workspaceFolders: [{ uriScheme: 'file' }],
	}));
}

async function makeDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'copilot-agent-mesh-owner-'));
	temporaryDirectories.push(path);
	return path;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error('Condition was not reached.');
}
