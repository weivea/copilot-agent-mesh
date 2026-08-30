import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	PROTOCOL_LIMITS,
	brokerRemoteListResultSchema,
	nodeDirectoryResultSchema,
	serializedLocalResultBytes,
} from '../../shared/protocol';
import type { MeshDeviceToolSummary } from '../../shared/toolProtocol';
import { budgetRemoteDirectory } from '../composition/ProductionRemoteTaskAdapter';
import type { StateStore } from '../domain/ports';
import type { LocalIpcSession } from '../ipc/LocalIpcTransport';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';
import {
	NodeRegistry,
	WORKSPACE_CATALOG_STATE_KEY,
	type NodeRegistryOptions,
	type NodeTaskBinding,
	type RegistryScheduler,
} from '../broker';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const NODE_A = '00000000-0000-4000-8000-000000000002';
const NODE_B = '00000000-0000-4000-8000-000000000003';
const INSTANCE_A = '00000000-0000-4000-8000-000000000004';
const INSTANCE_B = '00000000-0000-4000-8000-000000000005';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000006';
const OWNER_A = '00000000-0000-4000-8000-000000000007';
const OWNER_B = '00000000-0000-4000-8000-000000000008';
const TASK_A = '00000000-0000-4000-8000-000000000009';
const TASK_B = '00000000-0000-4000-8000-00000000000a';
const STARTED_AT = '2026-08-25T10:00:00.000Z';

class MemoryState implements StateStore {
	public readonly values = new Map<string, unknown>();
	public writes = 0;
	public failWrites = false;

	public constructor(initial?: Readonly<Record<string, unknown>>) {
		for (const [key, value] of Object.entries(initial ?? {})) {
			this.values.set(key, structuredClone(value));
		}
	}

	public get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.writes += 1;
		if (this.failWrites) {
			throw new Error('write failed');
		}
		this.values.set(key, structuredClone(value));
	}
}

class FakeSession {
	public closed = false;
	public closeCalls = 0;
	private readonly listeners = new Set<(error?: Error) => void>();

	public onClose(listener: (error?: Error) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.closeCalls += 1;
		for (const listener of [...this.listeners]) {
			listener();
		}
	}

	public disconnect(): void {
		this.close();
	}

	public asRoute(): LocalIpcSession {
		return this as unknown as LocalIpcSession;
	}
}

class ManualTime implements RegistryScheduler {
	public now = new Date(STARTED_AT);
	public callback: (() => void) | undefined;
	public disposed = false;

	public repeat(callback: () => void): { dispose(): void } {
		this.callback = callback;
		return {
			dispose: () => {
				this.disposed = true;
			},
		};
	}

	public advance(milliseconds: number): void {
		this.now = new Date(this.now.getTime() + milliseconds);
	}
}

interface Fixture {
	readonly registry: NodeRegistry;
	readonly state: MemoryState;
	readonly time: ManualTime;
	readonly leases: WorkspaceLeaseManager;
}

async function createFixture(
	overrides: Partial<NodeRegistryOptions> = {},
	state = new MemoryState(),
): Promise<Fixture> {
	const time = new ManualTime();
	const leases = new WorkspaceLeaseManager();
	const registry = await NodeRegistry.create({
		deviceId: DEVICE_ID,
		state,
		ids: { next: () => WORKSPACE_ID },
		clock: { now: () => time.now },
		workspaceLeases: leases,
		heartbeatTtlMs: 1_000,
		sweepIntervalMs: 100,
		scheduler: time,
		...overrides,
	});
	return { registry, state, time, leases };
}

function registration(
	nodeId = NODE_A,
	nodeInstanceId = INSTANCE_A,
): {
	nodeId: string;
	nodeInstanceId: string;
	label: string;
	capabilities: string[];
	status: 'online';
	startedAt: string;
} {
	return {
		nodeId,
		nodeInstanceId,
		label: nodeId === NODE_A ? 'Window A' : 'Window B',
		capabilities: ['tasks'],
		status: 'online',
		startedAt: STARTED_AT,
	};
}

function claim(nodeId = NODE_A, nodeInstanceId = INSTANCE_A) {
	return {
		nodeId,
		nodeInstanceId,
		workspaceIdentity: createOpaqueWorkspaceIdentity('fs-opaque:volume=7;inode=42'),
		name: 'Repository',
		capabilityTags: ['typescript'],
	};
}

test('registers and lists deterministic Window Node descriptors', async (t) => {
	const { registry } = await createFixture();
	t.after(() => registry.dispose());
	const sessionB = new FakeSession();
	const sessionA = new FakeSession();
	registry.register(registration(NODE_B, INSTANCE_B), sessionB.asRoute());
	registry.register(registration(), sessionA.asRoute());
	registry.register(registration(), sessionA.asRoute());

	const directory = registry.list();
	assert.equal(directory.deviceId, DEVICE_ID);
	assert.deepEqual(directory.nodes.map((node) => node.nodeId), [NODE_A, NODE_B]);
	assert.equal(directory.nodes[0].status, 'online');
});

test('binds mandatory delegation principals to exact window and child sessions', async (t) => {
	const { registry } = await createFixture();
	t.after(() => registry.dispose());
	const session = new FakeSession();
	registry.register(registration(), session.asRoute());
	const claimed = await registry.claimWorkspace(claim());
	const windowPrincipal = registry.windowDelegationPrincipal(session.asRoute(), {
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
	});
	assert.doesNotThrow(() => registry.assertDelegationPrincipal(
		session.asRoute(),
		{ nodeId: NODE_A, nodeInstanceId: INSTANCE_A },
		windowPrincipal,
	));
	assert.throws(() => registry.assertDelegationPrincipal(
		session.asRoute(),
		{ nodeId: NODE_A, nodeInstanceId: INSTANCE_A },
		{ ...windowPrincipal, capability: 'x'.repeat(43) },
	), /invalid or expired/u);

	const route = await registry.acquireTaskRoute({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		workspaceId: claimed.workspaceId,
		ownerId: OWNER_A,
		taskId: TASK_A,
	});
	assert.throws(() => registry.assertDelegationPrincipal(
		session.asRoute(),
		{ nodeId: NODE_A, nodeInstanceId: INSTANCE_A },
		route.delegatedExecutionContext,
	), /cannot delegate/u);
	assert.equal(registry.releaseTaskRoute(OWNER_A, TASK_A), true);
	assert.throws(() => registry.assertDelegationPrincipal(
		session.asRoute(),
		{ nodeId: NODE_A, nodeInstanceId: INSTANCE_A },
		route.delegatedExecutionContext,
	), /invalid or expired/u);
	assert.doesNotMatch(
		JSON.stringify(registry.list()),
		/"(?:capability|delegationPrincipal)":/u,
	);
});

test('fences duplicate registrations and rejects instance reuse across node IDs', async (t) => {
	const { registry } = await createFixture();
	t.after(() => registry.dispose());
	const stale = new FakeSession();
	const current = new FakeSession();
	registry.register(registration(), stale.asRoute());
	registry.register(registration(NODE_A, INSTANCE_B), current.asRoute());

	assert.equal(stale.closeCalls, 1);
	assert.equal(registry.list().nodes[0].nodeInstanceId, INSTANCE_B);
	assert.throws(
		() => registry.register(registration(NODE_B, INSTANCE_B), new FakeSession().asRoute()),
		/another node/,
	);
	assert.throws(
		() => registry.register(
			{ ...registration(NODE_A, INSTANCE_B), label: 'changed' },
			current.asRoute(),
		),
		/changed live instance metadata/,
	);
});

test('heartbeat TTL marks nodes offline and releases workspace claims', async (t) => {
	const { registry, time } = await createFixture();
	t.after(() => registry.dispose());
	registry.register(registration(), new FakeSession().asRoute());
	await registry.claimWorkspace(claim());
	registry.heartbeat({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		status: 'busy',
		at: time.now.toISOString(),
	});
	time.advance(1_001);
	assert.deepEqual(registry.sweepExpired(), [NODE_A]);
	assert.equal(registry.list().nodes[0].status, 'offline');
	assert.deepEqual(registry.list().nodes[0].workspaces, []);

	const second = new FakeSession();
	registry.register(registration(NODE_B, INSTANCE_B), second.asRoute());
	assert.equal((await registry.claimWorkspace(claim(NODE_B, INSTANCE_B))).status, 'claimed');
});

test('unregister and disconnect retain offline descriptors and release claims', async (t) => {
	const { registry } = await createFixture();
	t.after(() => registry.dispose());
	const first = new FakeSession();
	registry.register(registration(), first.asRoute());
	await registry.claimWorkspace(claim());
	registry.unregister({ nodeId: NODE_A, nodeInstanceId: INSTANCE_A });
	assert.equal(first.closeCalls, 1);
	assert.equal(registry.list().nodes[0].status, 'offline');

	const second = new FakeSession();
	registry.register(registration(NODE_A, INSTANCE_B), second.asRoute());
	await registry.claimWorkspace({ ...claim(), nodeInstanceId: INSTANCE_B });
	second.disconnect();
	assert.equal(registry.list().nodes[0].status, 'offline');
	assert.deepEqual(registry.list().nodes[0].workspaces, []);
});

test('same repository conflicts, then reclaims its persisted workspace ID', async (t) => {
	const { registry } = await createFixture();
	t.after(() => registry.dispose());
	registry.register(registration(), new FakeSession().asRoute());
	registry.register(registration(NODE_B, INSTANCE_B), new FakeSession().asRoute());
	const first = await registry.claimWorkspace(claim());
	const conflict = await registry.claimWorkspace(claim(NODE_B, INSTANCE_B));
	assert.deepEqual(conflict, {
		workspaceId: first.workspaceId,
		status: 'conflict',
		canExecute: false,
	});
	registry.unregister({ nodeId: NODE_A, nodeInstanceId: INSTANCE_A });
	const reclaimed = await registry.claimWorkspace(claim(NODE_B, INSTANCE_B));
	assert.equal(reclaimed.status, 'claimed');
	assert.equal(reclaimed.workspaceId, first.workspaceId);
});

test('stale instances cannot heartbeat, release, or route tasks', async (t) => {
	const { registry } = await createFixture();
	t.after(() => registry.dispose());
	registry.register(registration(), new FakeSession().asRoute());
	await registry.claimWorkspace(claim());
	registry.register(registration(NODE_A, INSTANCE_B), new FakeSession().asRoute());

	assert.throws(() => registry.heartbeat({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		status: 'online',
		at: STARTED_AT,
	}), /stale/);
	assert.throws(() => registry.releaseWorkspace({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		workspaceId: WORKSPACE_ID,
	}), /stale/);
	await assert.rejects(() => registry.acquireTaskRoute({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		workspaceId: WORKSPACE_ID,
		ownerId: OWNER_A,
		taskId: TASK_A,
	}), /stale/);
});

test('task route acquisition is exact and workspace-lease atomic', async (t) => {
	const { registry, leases } = await createFixture();
	t.after(() => registry.dispose());
	const session = new FakeSession();
	registry.register(registration(), session.asRoute());
	await registry.claimWorkspace(claim());
	const route = await registry.acquireTaskRoute({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		workspaceId: WORKSPACE_ID,
		ownerId: OWNER_A,
		taskId: TASK_A,
	});
	assert.equal(route.session, session.asRoute());
	assert.equal(route.workspaceLeaseKey, claim().workspaceIdentity);
	await assert.rejects(() => registry.acquireTaskRoute({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		workspaceId: WORKSPACE_ID,
		ownerId: OWNER_B,
		taskId: TASK_B,
	}), /active task/);
	assert.equal(registry.releaseTaskRoute(OWNER_B, TASK_A), false);
	assert.equal(leases.isLeased(route.workspaceLeaseKey), true);
	assert.equal(registry.releaseTaskRoute(OWNER_A, TASK_A), true);
	assert.equal(leases.isLeased(route.workspaceLeaseKey), false);
});

test('node loss reports task bindings without silently releasing leases', async (t) => {
	const lost: NodeTaskBinding[][] = [];
	const { registry, leases } = await createFixture({
		onNodeTasksLost: (bindings) => lost.push(bindings.map((binding) => ({ ...binding }))),
	});
	t.after(() => registry.dispose());
	const session = new FakeSession();
	registry.register(registration(), session.asRoute());
	await registry.claimWorkspace(claim());
	const route = await registry.acquireTaskRoute({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		workspaceId: WORKSPACE_ID,
		ownerId: OWNER_A,
		taskId: TASK_A,
	});
	session.disconnect();

	assert.equal(lost.length, 1);
	assert.equal(lost[0][0].taskId, TASK_A);
	assert.equal(leases.isLeased(route.workspaceLeaseKey), true);
	assert.equal(registry.releaseTaskRoute(OWNER_A, TASK_A), true);
});

test('atomically migrates schema v1 without persisting local paths', async (t) => {
	const v1 = {
		schemaVersion: 1,
		workspaces: [{
			workspaceId: WORKSPACE_ID,
			registeredUri: 'file:///Users/example/repository',
			localUri: 'file:///private/var/repository',
			fileIdentity: 'fs-opaque:volume=7;inode=42',
			name: 'Repository',
			capabilityTags: ['typescript'],
			enabled: false,
			stale: true,
			createdAt: STARTED_AT,
			updatedAt: STARTED_AT,
		}],
	};
	const state = new MemoryState({ [WORKSPACE_CATALOG_STATE_KEY]: v1 });
	const { registry } = await createFixture({}, state);
	t.after(() => registry.dispose());
	const catalog = registry.catalogSnapshot();
	assert.equal(catalog.schemaVersion, 2);
	assert.equal(catalog.workspaces[0].workspaceId, WORKSPACE_ID);
	assert.equal(
		catalog.workspaces[0].workspaceIdentity,
		createOpaqueWorkspaceIdentity(v1.workspaces[0].fileIdentity),
	);
	assert.equal(catalog.workspaces[0].enabled, false);
	assert.doesNotMatch(JSON.stringify(state.values.get(WORKSPACE_CATALOG_STATE_KEY)), /file:\/\//);
});

test('migration rejects corrupt and unknown versions without a fallback write', async () => {
	for (const value of [
		{ schemaVersion: 1, workspaces: [{ broken: true }] },
		{ schemaVersion: 99, workspaces: [] },
	]) {
		const state = new MemoryState({ [WORKSPACE_CATALOG_STATE_KEY]: value });
		await assert.rejects(() => createFixture({}, state));
		assert.equal(state.writes, 0);
	}

	const v1 = {
		schemaVersion: 1,
		workspaces: [{
			workspaceId: WORKSPACE_ID,
			registeredUri: 'file:///repository',
			localUri: 'file:///repository',
			fileIdentity: 'opaque',
			name: 'Repository',
			capabilityTags: [],
			enabled: true,
			stale: false,
			createdAt: STARTED_AT,
			updatedAt: STARTED_AT,
		}],
	};
	const failing = new MemoryState({ [WORKSPACE_CATALOG_STATE_KEY]: v1 });
	failing.failWrites = true;
	await assert.rejects(() => createFixture({}, failing), /write failed/);
	assert.deepEqual(failing.values.get(WORKSPACE_CATALOG_STATE_KEY), v1);
});

test('serialized directory exposes only the one-way workspace identity, never its source or path', async (t) => {
	const { registry } = await createFixture();
	t.after(() => registry.dispose());
	registry.register(registration(), new FakeSession().asRoute());
	await registry.claimWorkspace({
		...claim(),
		workspaceIdentity: createOpaqueWorkspaceIdentity('opaque-sensitive-token'),
	});
	const serialized = JSON.stringify(registry.list());
	assert.doesNotMatch(
		serialized,
		/opaque-sensitive-token|fileIdentity|localUri/,
	);
	assert.match(serialized, /"workspaceIdentity":"sha256:[A-Za-z0-9_-]{43}"/u);
	assert.match(serialized, /Repository/);
});

test('maximal UTF-8 directories are deterministically truncated below every frame limit', async (t) => {
	let workspaceSequence = 20_000;
	const { registry } = await createFixture({
		ids: { next: () => uuidFromIndex(workspaceSequence++) },
	});
	t.after(() => registry.dispose());
	const maximumName = `${'界'.repeat(85)}a`;
	const maximumCapability = `cc${'界'.repeat(42)}`;
	const maximumTag = `${'界'.repeat(21)}x`;
	const capabilities = Array.from({ length: 32 }, () => maximumCapability);
	const tags = Array.from({ length: 32 }, () => maximumTag);

	for (let index = 0; index < PROTOCOL_LIMITS.nodeListCount; index += 1) {
		registry.register({
			nodeId: uuidFromIndex(index + 30_000),
			nodeInstanceId: uuidFromIndex(index + 31_000),
			label: maximumName,
			capabilities,
			status: 'online',
			startedAt: STARTED_AT,
		}, new FakeSession().asRoute());
	}
	for (let workspace = 0; workspace < PROTOCOL_LIMITS.workspaceListCount; workspace += 1) {
		const workspaceIdentity = createOpaqueWorkspaceIdentity(`maximal-${workspace}`);
		for (let node = 0; node < PROTOCOL_LIMITS.nodeListCount; node += 1) {
			await registry.claimWorkspace({
				nodeId: uuidFromIndex(node + 30_000),
				nodeInstanceId: uuidFromIndex(node + 31_000),
				workspaceIdentity,
				name: maximumName,
				capabilityTags: tags,
			});
		}
	}

	const directory = registry.list();
	assert.equal(directory.totalNodes, PROTOCOL_LIMITS.nodeListCount);
	assert.equal(directory.truncated, true);
	assert.ok(directory.nodes.length > 0);
	assert.ok(directory.nodes.length < directory.totalNodes);
	assert.ok(serializedLocalResultBytes(directory) <= PROTOCOL_LIMITS.frameBytes);
	assert.equal(nodeDirectoryResultSchema.safeParse(directory).success, true);

	const descriptor = directory.nodes[0];
	const devices: MeshDeviceToolSummary[] = Array.from(
		{ length: PROTOCOL_LIMITS.deviceListCount },
		(_, index) => ({
			deviceId: uuidFromIndex(index + 40_000),
			deviceName: maximumName,
			locality: 'remote',
			status: 'online',
			peerId: uuidFromIndex(index + 41_000),
			nodesTruncated: false,
			totalNodes: 1,
			nodes: [{
				nodeId: descriptor.nodeId,
				nodeInstanceId: descriptor.nodeInstanceId,
				label: descriptor.label,
				status: descriptor.status,
				capabilities: [...descriptor.capabilities],
				workspaces: descriptor.workspaces.map((workspace) => ({
					workspaceId: workspace.workspaceId,
					name: workspace.name,
					tags: [...workspace.capabilityTags],
					busy: workspace.busy,
					claimStatus: workspace.claimStatus,
				})),
			}],
		}),
	);
	const oversized = {
		devices,
		truncated: false,
		totalDevices: devices.length,
	};
	assert.equal(brokerRemoteListResultSchema.safeParse(oversized).success, false);
	const budgeted = budgetRemoteDirectory(devices);
	assert.equal(budgeted.truncated, true);
	assert.ok(budgeted.devices.length < devices.length);
	assert.ok(serializedLocalResultBytes(budgeted) <= PROTOCOL_LIMITS.frameBytes);
	assert.equal(brokerRemoteListResultSchema.safeParse(budgeted).success, true);
});

test('dispose removes timer and close listeners idempotently', async () => {
	const { registry, time } = await createFixture();
	const session = new FakeSession();
	registry.register(registration(), session.asRoute());
	registry.dispose();
	registry.dispose();
	assert.equal(time.disposed, true);
	assert.equal(session.closeCalls, 1);
	session.disconnect();
});

test('offline churn admits live nodes and preserves tombstones needed for task cleanup', async (t) => {
	const { registry } = await createFixture();
	t.after(() => registry.dispose());
	const activeSession = new FakeSession();
	registry.register(registration(), activeSession.asRoute());
	await registry.claimWorkspace(claim());
	await registry.acquireTaskRoute({
		nodeId: NODE_A,
		nodeInstanceId: INSTANCE_A,
		workspaceId: WORKSPACE_ID,
		ownerId: OWNER_A,
		taskId: TASK_A,
	});
	activeSession.disconnect();

	for (let index = 0; index < 256; index += 1) {
		const nodeId = uuidFromIndex(index + 100);
		const nodeInstanceId = uuidFromIndex(index + 1_000);
		const session = new FakeSession();
		registry.register(registration(nodeId, nodeInstanceId), session.asRoute());
		registry.unregister({ nodeId, nodeInstanceId });
	}

	const retained = registry.list();
	assert.equal(retained.totalNodes, 128);
	assert.equal(retained.nodes.some(({ nodeId }) => nodeId === NODE_A), true);
	assert.equal(
		retained.nodes.filter(({ status }) => status !== 'offline').length,
		0,
	);

	assert.equal(registry.releaseTaskRoute(OWNER_A, TASK_A), true);
	const replacementNodeId = uuidFromIndex(10_000);
	const replacementInstanceId = uuidFromIndex(11_000);
	registry.register(
		registration(replacementNodeId, replacementInstanceId),
		new FakeSession().asRoute(),
	);
	assert.equal(registry.list().nodes.some(({ nodeId }) => nodeId === NODE_A), false);
	assert.equal(registry.list().totalNodes, 128);
});

function uuidFromIndex(index: number): string {
	return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}
