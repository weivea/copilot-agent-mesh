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
	type RegistryScheduler,
} from '../broker';
import type { StateStore } from '../domain/ports';
import { LocalIpcRemoteError, type LocalIpcIdentity } from '../ipc';
import { WindowNodeClient, type WindowNodeExecutor } from '../node';
import { AtomicFileStore } from '../storage/AtomicFileStore';
import type { BrokerOwnership } from '../storage/WorkerOwnerLock';
import { FileTaskStore } from '../tasks/FileTaskStore';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';
import {
	MemoryAtomicFileSystem,
	TestOwnership,
	uuid,
} from '../unitTest/artifactStoreTestSupport';

const DEVICE = uuid(201);
const NODE_A = uuid(202);
const NODE_B = uuid(203);
const INSTANCE_A = uuid(204);
const INSTANCE_B = uuid(205);
const WORKSPACE_A = uuid(206);
const WORKSPACE_B = uuid(207);
const IDENTITY_A = createOpaqueWorkspaceIdentity('component-workspace-a');
const IDENTITY_B = createOpaqueWorkspaceIdentity('component-workspace-b');

test('authenticated broker RPC keeps Tool and configuration directories separate', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.dispose());

	assert.equal((await fixture.nodeA.listNodes()).nodes.length, 0);
	const candidates = await fixture.nodeA.listPeerPolicyCandidates();
	assert.equal(candidates.candidates.length, 1);
	assert.equal(candidates.candidates[0]?.nodeId, NODE_B.slice(0, 8));
	assert.doesNotMatch(JSON.stringify(candidates), /sha256:|file:|component-workspace/u);

	await fixture.nodeA.setPeerPolicy({
		workspaceIdentity: IDENTITY_A,
		allowlist: [IDENTITY_B],
	});
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

interface Fixture {
	readonly nodeA: WindowNodeClient;
	readonly nodeB: WindowNodeClient;
	dispose(): Promise<void>;
}

async function createFixture(options: { readonly enabled?: boolean } = {}): Promise<Fixture> {
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
	const tasks = new FileTaskStore(files, clock);
	const peerStore = new PeerPolicyStore(files, {
		ownership,
		generation: ownership.generation,
		clock,
	});
	await peerStore.initialize();
	const workspaceIds = [WORKSPACE_A, WORKSPACE_B];
	const registry = await NodeRegistry.create({
		deviceId: DEVICE,
		state: new MemoryState(),
		ids: { next: () => workspaceIds.shift()! },
		clock,
		workspaceLeases: new WorkspaceLeaseManager(),
		scheduler: new NoopScheduler(),
	});
	const policies = new PeerPolicyService(peerStore, registry, {
		enabled: () => options.enabled ?? true,
	});
	registry.setPeerRouteAuthorizer(policies);
	const taskService = new BrokerTaskService(DEVICE, registry, tasks, clock);
	await taskService.initialize();
	const broker = new DeviceBroker({
		identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		ownership,
		registry,
		peerPolicies: policies,
		taskService,
		requestTimeoutMs: 2_000,
	});
	await broker.start();
	const nodeA = nodeClient(identity, NODE_A, INSTANCE_A, 'component-workspace-a');
	const nodeB = nodeClient(identity, NODE_B, INSTANCE_B, 'component-workspace-b');
	await nodeA.start();
	await nodeB.start();
	return {
		nodeA,
		nodeB,
		dispose: async () => {
			await nodeA.dispose().catch(() => undefined);
			await nodeB.dispose().catch(() => undefined);
			await broker.dispose().catch(() => undefined);
			await rm(tempDirectory, { recursive: true, force: true });
		},
	};
}

function nodeClient(
	identity: LocalIpcIdentity,
	nodeId: string,
	nodeInstanceId: string,
	fileIdentity: string,
): WindowNodeClient {
	return new WindowNodeClient({
		identity,
		brokerKey: Buffer.alloc(32, 0x5a),
		nodeId,
		nodeInstanceId,
		label: nodeId === NODE_A ? 'frontend' : 'backend',
		capabilities: ['tasks'],
		executor: noopExecutor(),
		workspaceSource: () => [{
			localUri: `file:///${fileIdentity}`,
			name: nodeId === NODE_A ? 'Repository A' : 'Repository B',
			capabilityTags: ['typescript'],
		}],
		fileIdentityResolver: {
			resolve: async (uri) => ({
				identity: fileIdentity,
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
