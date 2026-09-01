import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROTOCOL_LIMITS } from '../../shared/protocol';
import {
	NodeRegistry,
	PeerPolicyService,
	PeerPolicyStore,
	resolveWindowDisplayName,
	validateWindowName,
	type RegistryScheduler,
} from '../broker';
import { MeshDomainError } from '../domain/errors';
import type { StateStore } from '../domain/ports';
import type { LocalIpcSession } from '../ipc';
import { AtomicFileStore } from '../storage/AtomicFileStore';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';
import {
	MemoryAtomicFileSystem,
	TestOwnership,
	uuid,
} from './artifactStoreTestSupport';

const DEVICE = uuid(1);
const NODE_A = uuid(2);
const NODE_B = uuid(3);
const NODE_C = uuid(4);
const INSTANCE_A = uuid(5);
const INSTANCE_B = uuid(6);
const INSTANCE_B2 = uuid(7);
const INSTANCE_C = uuid(8);
const WORKSPACE_A = uuid(9);
const WORKSPACE_B = uuid(10);
const WORKSPACE_C = uuid(11);
const TASK = uuid(12);
const NOW = new Date('2026-08-30T11:00:00.000Z');
const IDENTITY_A = createOpaqueWorkspaceIdentity('workspace-a');
const IDENTITY_B = createOpaqueWorkspaceIdentity('workspace-b');
const IDENTITY_C = createOpaqueWorkspaceIdentity('workspace-c');

test('falls through unsafe Workspace display names to the short node identity', () => {
	assert.equal(resolveWindowDisplayName(undefined, ' Backend ', NODE_A), NODE_A.slice(0, 8));
	assert.equal(
		resolveWindowDisplayName(undefined, 'ｆｉｌｅ：／／／private', NODE_A),
		NODE_A.slice(0, 8),
	);
});

test('applies all four directional allowlist and accepting gate combinations', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());

	for (const combination of [
		{ allow: false, accept: false, visible: false, error: 'PEER_NOT_ALLOWED' },
		{ allow: false, accept: true, visible: false, error: 'PEER_NOT_ALLOWED' },
		{ allow: true, accept: false, visible: false, error: 'PEER_NOT_ACCEPTING' },
		{ allow: true, accept: true, visible: true, error: undefined },
	] as const) {
		await setGate(fixture, combination.allow, combination.accept);
		const listed = fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A));
		assert.equal(listed.nodes.some(({ nodeId }) => nodeId === NODE_B), combination.visible);
		if (combination.error === undefined) {
			await fixture.registry.validateTaskRoute(route());
		} else {
			await assert.rejects(
				fixture.registry.validateTaskRoute(route()),
				hasReason(combination.error),
			);
		}
	}

	assert.equal(
		fixture.service.listAuthorized(identityParams(NODE_B, INSTANCE_B))
			.nodes.some(({ nodeId }) => nodeId === NODE_A),
		false,
	);
});

test('defaults ambiguous multi-workspace sources to all-workspaces authorization', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());
	await fixture.registry.claimWorkspace(claim(
		NODE_A,
		INSTANCE_A,
		WORKSPACE_C,
		IDENTITY_C,
		'Repository C',
	));
	await setGate(fixture, true, true);

	assert.equal(fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A)).nodes.length, 0);
	await assert.rejects(fixture.registry.validateTaskRoute(route()), hasReason('PEER_NOT_ALLOWED'));

	await fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_C,
		allowlist: [IDENTITY_B],
	});
	assert.equal(
		fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A)).nodes[0]?.nodeId,
		NODE_B,
	);
	await fixture.registry.validateTaskRoute(route());
});

test('reads each owned multi-root policy explicitly and rejects foreign identities', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());
	await fixture.registry.claimWorkspace(claim(
		NODE_A,
		INSTANCE_A,
		WORKSPACE_C,
		IDENTITY_C,
		'Repository C',
	));
	await fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_C,
		allowlist: [IDENTITY_B],
	});

	assert.deepEqual(fixture.service.getPolicy({
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_C,
	}).allowlist, [IDENTITY_B]);
	assert.throws(
		() => fixture.service.getPolicy({
			...identityParams(NODE_A, INSTANCE_A),
			workspaceIdentity: IDENTITY_B,
		}),
		hasReason('POLICY_FORBIDDEN'),
	);
	assert.throws(
		() => fixture.service.getPolicy(identityParams(NODE_A, INSTANCE_A)),
		hasReason('POLICY_FORBIDDEN'),
	);
});

test('serializes same-identity partial patches without restoring revoked gates', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());
	await setGate(fixture, true, true);

	await Promise.all([
		fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
			...identityParams(NODE_A, INSTANCE_A),
			workspaceIdentity: IDENTITY_A,
			allowlist: [],
		}),
		fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
			...identityParams(NODE_A, INSTANCE_A),
			workspaceIdentity: IDENTITY_A,
			windowName: 'renamed-source',
		}),
		fixture.service.setPolicy(identityParams(NODE_B, INSTANCE_B), {
			...identityParams(NODE_B, INSTANCE_B),
			workspaceIdentity: IDENTITY_B,
			acceptsIncoming: false,
		}),
		fixture.service.setPolicy(identityParams(NODE_B, INSTANCE_B), {
			...identityParams(NODE_B, INSTANCE_B),
			workspaceIdentity: IDENTITY_B,
			windowName: 'renamed-target',
		}),
	]);

	const source = fixture.service.getPolicy(identityParams(NODE_A, INSTANCE_A));
	const target = fixture.service.getPolicy(identityParams(NODE_B, INSTANCE_B));
	assert.equal(source.windowName, 'renamed-source');
	assert.deepEqual(source.allowlist, []);
	assert.equal(target.windowName, 'renamed-target');
	assert.equal(target.acceptsIncoming, false);
	assert.equal(fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A)).nodes.length, 0);
});

test('only lets a registered caller mutate its own claimed workspace policy', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());

	await assert.rejects(
		fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
			...identityParams(NODE_A, INSTANCE_A),
			workspaceIdentity: IDENTITY_B,
			acceptsIncoming: true,
		}),
		hasReason('POLICY_FORBIDDEN'),
	);
	await assert.rejects(
		fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
			...identityParams(NODE_A, INSTANCE_A),
			workspaceIdentity: IDENTITY_A,
			allowlist: [IDENTITY_A],
		}),
		hasReason('POLICY_FORBIDDEN'),
	);
});

test('retains offline allowlist identities and rebinds them to a new exact node instance', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());
	await setGate(fixture, true, true);
	await fixture.service.setPolicy(identityParams(NODE_B, INSTANCE_B), {
		...identityParams(NODE_B, INSTANCE_B),
		workspaceIdentity: IDENTITY_B,
		windowName: 'Persistent Backend',
	});

	fixture.registry.unregister(identityParams(NODE_B, INSTANCE_B));
	assert.deepEqual(fixture.service.getPolicy(identityParams(NODE_A, INSTANCE_A)).allowlist, [
		IDENTITY_B,
	]);
	assert.equal(fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A)).nodes.length, 0);
	await assert.rejects(fixture.registry.validateTaskRoute(route()), hasReason('PEER_OFFLINE'));

	fixture.registry.register(registration(NODE_C, INSTANCE_C, 'Window C'), new FakeSession().route());
	await fixture.registry.claimWorkspace(claim(
		NODE_C,
		INSTANCE_C,
		WORKSPACE_B,
		IDENTITY_B,
		'Repository B',
	));
	assert.equal(
		fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A)).nodes[0]?.nodeId,
		NODE_C,
	);
	assert.equal(
		fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A)).nodes[0]?.nodeInstanceId,
		INSTANCE_C,
	);
	assert.equal(
		fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A)).nodes[0]?.label,
		'Persistent Backend',
	);
	const reboundCandidates = fixture.service.listCandidates({
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
	}).filter(({ targetWorkspaceIdentity }) => targetWorkspaceIdentity === IDENTITY_B);
	assert.equal(reboundCandidates.length, 1);
	assert.equal(reboundCandidates[0]?.candidate.online, true);
});

test('orders every online candidate ahead of saved offline entries at the transport limit', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());
	for (let index = 0; index < PROTOCOL_LIMITS.nodeListCount - 2; index += 1) {
		fixture.registry.register(
			registration(uuid(1_000 + index), uuid(2_000 + index), `Window ${index}`),
			new FakeSession().route(),
		);
	}
	const offlineIdentities = Array.from(
		{ length: PROTOCOL_LIMITS.workspaceListCount },
		(_, index) => createOpaqueWorkspaceIdentity(`offline-workspace-${index}`),
	);
	await fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
		allowlist: offlineIdentities,
	});

	const candidates = fixture.service.listCandidates({
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
	});
	assert.equal(
		candidates.length,
		PROTOCOL_LIMITS.nodeListCount + PROTOCOL_LIMITS.workspaceListCount,
	);
	assert.equal(
		candidates.slice(0, PROTOCOL_LIMITS.nodeListCount).every(({ candidate }) => candidate.online),
		true,
	);
	assert.equal(
		candidates.slice(PROTOCOL_LIMITS.nodeListCount).every(({ candidate }) => !candidate.online),
		true,
	);
});

test('does not synthesize saved authorization for a Workspace on an online multi-root node', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());
	await setGate(fixture, true, true);
	await fixture.registry.claimWorkspace(claim(
		NODE_B,
		INSTANCE_B,
		WORKSPACE_C,
		IDENTITY_C,
		'Repository C',
	));

	const candidates = fixture.service.listCandidates({
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
	});
	const target = candidates.find(({ candidate }) => !candidate.self);
	assert.equal(target?.candidate.online, true);
	assert.equal(target?.candidate.claimState, 'multiWorkspace');
	assert.equal(
		candidates.some(({ candidate }) => !candidate.online && candidate.allowlisted),
		false,
	);
});

test('distinguishes offline, non-claimed, and multi-workspace targets', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());
	await setGate(fixture, true, true);

	fixture.registry.unregister(identityParams(NODE_B, INSTANCE_B));
	await assert.rejects(fixture.registry.validateTaskRoute(route()), hasReason('PEER_OFFLINE'));

	fixture.registry.register(registration(NODE_B, INSTANCE_B2, 'Window B'), new FakeSession().route());
	fixture.registry.register(registration(NODE_C, INSTANCE_C, 'Window C'), new FakeSession().route());
	await fixture.registry.claimWorkspace(claim(
		NODE_C,
		INSTANCE_C,
		WORKSPACE_B,
		IDENTITY_B,
		'Repository B',
	));
	await fixture.registry.claimWorkspace(claim(
		NODE_B,
		INSTANCE_B2,
		WORKSPACE_B,
		IDENTITY_B,
		'Repository B',
	));
	const configuredName = fixture.store.get(IDENTITY_B)!.windowName;
	const conflictedDirectory = fixture.service.listDashboard(identityParams(NODE_A, INSTANCE_A));
	assert.equal(
		conflictedDirectory.nodes.find(({ nodeId }) => nodeId === NODE_C)?.label,
		configuredName,
	);
	assert.notEqual(
		conflictedDirectory.nodes.find(({ nodeId }) => nodeId === NODE_B)?.label,
		configuredName,
	);
	await assert.rejects(
		fixture.registry.validateTaskRoute(route(INSTANCE_B2)),
		hasReason('PEER_OFFLINE'),
	);

	fixture.registry.unregister(identityParams(NODE_C, INSTANCE_C));
	await fixture.registry.claimWorkspace(claim(
		NODE_B,
		INSTANCE_B2,
		WORKSPACE_B,
		IDENTITY_B,
		'Repository B',
	));
	await fixture.registry.claimWorkspace(claim(
		NODE_B,
		INSTANCE_B2,
		WORKSPACE_C,
		IDENTITY_C,
		'Repository C',
	));
	await assert.rejects(
		fixture.registry.validateTaskRoute(route(INSTANCE_B2)),
		hasReason('PEER_MULTI_WORKSPACE'),
	);
});

test('revocation is immediate and route acquisition rechecks after prevalidation', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());
	await setGate(fixture, true, true);
	await fixture.registry.validateTaskRoute(route());

	await fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
		allowlist: [],
	});

	assert.equal(fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A)).nodes.length, 0);
	await assert.rejects(fixture.registry.acquireTaskRoute(route()), hasReason('PEER_NOT_ALLOWED'));
	assert.equal(fixture.leases.isLeased(IDENTITY_B), false);
});

test('uses stable identities and exact instances rather than spoofed or renamed labels', async (t) => {
	const fixture = await createFixture({ targetLabel: 'frontend' });
	t.after(() => fixture.registry.dispose());
	await fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
		windowName: 'frontend',
		allowlist: [IDENTITY_B],
	});
	await fixture.service.setPolicy(identityParams(NODE_B, INSTANCE_B), {
		...identityParams(NODE_B, INSTANCE_B),
		workspaceIdentity: IDENTITY_B,
		windowName: 'backend-renamed',
		acceptsIncoming: true,
	});

	const listed = fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A));
	assert.equal(listed.nodes[0]?.label, 'backend-renamed');
	assert.equal(listed.nodes[0]?.nodeId, NODE_B);
	assert.equal(listed.nodes[0]?.workspaces[0]?.workspaceIdentity, IDENTITY_B);
	assert.deepEqual(
		fixture.service.getPolicy(identityParams(NODE_A, INSTANCE_A)).allowlist,
		[IDENTITY_B],
	);
	await assert.rejects(
		fixture.registry.validateTaskRoute(route(INSTANCE_B2)),
		hasReason('PEER_OFFLINE'),
	);
	const acquired = await fixture.registry.acquireTaskRoute(route());
	await fixture.service.setPolicy(identityParams(NODE_B, INSTANCE_B), {
		...identityParams(NODE_B, INSTANCE_B),
		workspaceIdentity: IDENTITY_B,
		windowName: 'backend-display-only',
	});
	assert.equal(acquired.workspaceLeaseKey, IDENTITY_B);
	assert.equal(fixture.leases.isLeased(IDENTITY_B), true);
	assert.equal(fixture.registry.releaseTaskRoute(DEVICE, TASK), true);
});

test('rejects normalized rename collisions without changing policy gates', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());
	await setGate(fixture, true, true);
	await fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
		windowName: 'Ｆrontend',
	});
	const before = fixture.service.getPolicy(identityParams(NODE_B, INSTANCE_B));

	await assert.rejects(
		fixture.service.setPolicy(identityParams(NODE_B, INSTANCE_B), {
			...identityParams(NODE_B, INSTANCE_B),
			workspaceIdentity: IDENTITY_B,
			windowName: 'frontend',
		}),
		hasReason('WINDOW_NAME_CONFLICT'),
	);

	assert.deepEqual(fixture.service.getPolicy(identityParams(NODE_B, INSTANCE_B)), before);
	await fixture.registry.validateTaskRoute(route());
});

test('rejects an explicit rename that collides with another claimed Workspace fallback', async (t) => {
	const fixture = await createFixture({
		sourceWorkspaceName: 'Source Repository',
		targetWorkspaceName: 'repo',
	});
	t.after(() => fixture.registry.dispose());

	await assert.rejects(
		fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
			...identityParams(NODE_A, INSTANCE_A),
			workspaceIdentity: IDENTITY_A,
			windowName: 'REPO',
		}),
		hasReason('WINDOW_NAME_CONFLICT'),
	);
	assert.equal(fixture.store.get(IDENTITY_A), undefined);
});

test('allocates unique effective labels for identical claimed Workspace fallbacks', async (t) => {
	const fixture = await createFixture({
		sourceWorkspaceName: 'repo',
		targetWorkspaceName: 'repo',
	});
	t.after(() => fixture.registry.dispose());

	const before = fixture.service.listDashboard(identityParams(NODE_A, INSTANCE_A));
	const beforeLabels = before.nodes.map(({ label }) => label);
	assert.equal(new Set(beforeLabels.map((label) => label.toLocaleLowerCase('en-US'))).size, 2);
	assert.ok(beforeLabels.includes('repo'));
	assert.deepEqual(
		new Set([
			fixture.service.getPolicy({
				...identityParams(NODE_A, INSTANCE_A),
				workspaceIdentity: IDENTITY_A,
			}).windowName,
			fixture.service.getPolicy({
				...identityParams(NODE_B, INSTANCE_B),
				workspaceIdentity: IDENTITY_B,
			}).windowName,
		]),
		new Set(beforeLabels),
	);

	await setGate(fixture, true, true);
	const dashboard = fixture.service.listDashboard(identityParams(NODE_A, INSTANCE_A));
	const targetLabel = dashboard.nodes.find(({ nodeId }) => nodeId === NODE_B)?.label;
	assert.ok(targetLabel);
	const candidates = fixture.service.listCandidates({
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
	});
	assert.equal(
		candidates.find(({ targetNodeId }) => targetNodeId === NODE_B)?.candidate.windowLabel,
		targetLabel,
	);
	assert.equal(
		fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A)).nodes[0]?.label,
		targetLabel,
	);
	assert.equal(fixture.registry.lookupNodeLabel(NODE_B), targetLabel);
	await fixture.registry.validateTaskRoute(route());
});

test('keeps the configuration directory safe and separate from Tool visibility', async (t) => {
	const fixture = await createFixture({
		targetLabel: '/Users/private/secret-project',
		targetWorkspaceName: 'C:\\private\\secret-project',
		targetCapabilityTags: ['typescript', 'token=secret'],
	});
	t.after(() => fixture.registry.dispose());

	assert.equal(fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A)).nodes.length, 0);
	const configuration = fixture.service.listCandidates({
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
	});
	const target = configuration.find(({ targetNodeId }) => targetNodeId === NODE_B)?.candidate;
	assert.equal(configuration.length, 2);
	assert.equal(target?.windowLabel, NODE_B.slice(0, 8));
	assert.equal(target?.workspaceName, 'Workspace');
	const serialized = JSON.stringify(configuration.map(({ candidate }) => candidate));
	assert.doesNotMatch(serialized, /sha256:/u);
	assert.doesNotMatch(serialized, /Users|private|secret-project/u);
	const dashboard = fixture.service.listDashboard(identityParams(NODE_A, INSTANCE_A));
	assert.deepEqual(dashboard.nodes[1]?.workspaces[0]?.capabilityTags, [
		'typescript',
		'Capability',
	]);

	await setGate(fixture, true, true);
	validateWindowName(fixture.store.get(IDENTITY_B)!.windowName);
	assert.notEqual(fixture.store.get(IDENTITY_B)?.windowName, 'C:\\private\\secret-project');
	const authorized = fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A));
	assert.equal(authorized.nodes[0]?.label, NODE_B.slice(0, 8));
	assert.equal(authorized.nodes[0]?.workspaces[0]?.name, 'Workspace');
});

test('rejects credential-shaped names and forgets explicitly released workspaces', async (t) => {
	const fixture = await createFixture();
	t.after(() => fixture.registry.dispose());
	await assert.rejects(
		fixture.service.setPolicy(identityParams(NODE_B, INSTANCE_B), {
		...identityParams(NODE_B, INSTANCE_B),
		workspaceIdentity: IDENTITY_B,
		windowName: 'ghp_123456789012345678901234567890123456',
		}),
		hasReason('WINDOW_NAME_INVALID'),
	);

	let candidate = fixture.service.listCandidates({
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
	}).find(({ targetNodeId }) => targetNodeId === NODE_B)?.candidate;
	assert.equal(candidate?.windowLabel, 'Repository B');
	assert.equal(candidate?.workspaceName, 'Repository B');

	fixture.registry.releaseWorkspace({
		...identityParams(NODE_B, INSTANCE_B),
		workspaceId: WORKSPACE_B,
	});
	fixture.registry.unregister(identityParams(NODE_B, INSTANCE_B));
	candidate = fixture.service.listCandidates({
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
	}).find(({ candidate: entry }) => !entry.self)?.candidate;
	assert.equal(candidate, undefined);
});

test('keeps peer visibility and receiving disabled behind the Preview flag', async (t) => {
	const fixture = await createFixture({ enabled: false });
	t.after(() => fixture.registry.dispose());

	assert.equal(fixture.service.listAuthorized(identityParams(NODE_A, INSTANCE_A)).nodes.length, 0);
	await assert.rejects(
		fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
			...identityParams(NODE_A, INSTANCE_A),
			workspaceIdentity: IDENTITY_A,
			acceptsIncoming: true,
		}),
		hasReason('POLICY_FORBIDDEN'),
	);
	await assert.rejects(fixture.registry.validateTaskRoute(route()), hasReason('PEER_NOT_ACCEPTING'));
});

interface Fixture {
	readonly registry: NodeRegistry;
	readonly service: PeerPolicyService;
	readonly store: PeerPolicyStore;
	readonly leases: WorkspaceLeaseManager;
}

async function createFixture(options: {
	readonly enabled?: boolean;
	readonly sourceWorkspaceName?: string;
	readonly targetLabel?: string;
	readonly targetWorkspaceName?: string;
	readonly targetCapabilityTags?: string[];
} = {}): Promise<Fixture> {
	const leases = new WorkspaceLeaseManager();
	const registry = await NodeRegistry.create({
		deviceId: DEVICE,
		state: new MemoryState(),
		ids: { next: () => uuid(99) },
		clock: { now: () => NOW },
		workspaceLeases: leases,
		scheduler: new NoopScheduler(),
	});
	registry.register(registration(NODE_A, INSTANCE_A, 'frontend'), new FakeSession().route());
	registry.register(
		registration(NODE_B, INSTANCE_B, options.targetLabel ?? 'backend'),
		new FakeSession().route(),
	);
	await registry.claimWorkspace(claim(
		NODE_A,
		INSTANCE_A,
		WORKSPACE_A,
		IDENTITY_A,
		options.sourceWorkspaceName ?? 'Repository A',
	));
	await registry.claimWorkspace(claim(
		NODE_B,
		INSTANCE_B,
		WORKSPACE_B,
		IDENTITY_B,
		options.targetWorkspaceName ?? 'Repository B',
		options.targetCapabilityTags,
	));
	const ownership = new TestOwnership();
	const store = new PeerPolicyStore(
		new AtomicFileStore('memory', new MemoryAtomicFileSystem(), {
			next: () => 'policy-temp',
		}),
		{
			ownership,
			generation: ownership.generation,
			clock: { now: () => NOW },
		},
	);
	await store.initialize();
	const service = new PeerPolicyService(store, registry, {
		enabled: () => options.enabled ?? true,
	});
	registry.setPeerRouteAuthorizer(service);
	return { registry, service, store, leases };
}

async function setGate(fixture: Fixture, allow: boolean, accept: boolean): Promise<void> {
	await fixture.service.setPolicy(identityParams(NODE_A, INSTANCE_A), {
		...identityParams(NODE_A, INSTANCE_A),
		workspaceIdentity: IDENTITY_A,
		allowlist: allow ? [IDENTITY_B] : [],
	});
	await fixture.service.setPolicy(identityParams(NODE_B, INSTANCE_B), {
		...identityParams(NODE_B, INSTANCE_B),
		workspaceIdentity: IDENTITY_B,
		acceptsIncoming: accept,
	});
}

function registration(nodeId: string, nodeInstanceId: string, label: string) {
	return {
		nodeId,
		nodeInstanceId,
		label,
		capabilities: ['tasks'],
		status: 'online' as const,
		startedAt: NOW.toISOString(),
	};
}

function claim(
	nodeId: string,
	nodeInstanceId: string,
	workspaceId: string,
	workspaceIdentity: string,
	name: string,
	capabilityTags: string[] = ['typescript'],
) {
	return {
		nodeId,
		nodeInstanceId,
		workspaceId,
		workspaceIdentity,
		name,
		capabilityTags,
	};
}

function identityParams(nodeId: string, nodeInstanceId: string) {
	return { nodeId, nodeInstanceId };
}

function route(targetInstanceId = INSTANCE_B) {
	return {
		nodeId: NODE_B,
		nodeInstanceId: targetInstanceId,
		workspaceId: WORKSPACE_B,
		ownerId: DEVICE,
		taskId: TASK,
		sourceNodeId: NODE_A,
		sourceNodeInstanceId: INSTANCE_A,
	};
}

function hasReason(reason: string) {
	return (error: unknown) =>
		error instanceof MeshDomainError
		&& error.reason === reason;
}

class MemoryState implements StateStore {
	private readonly values = new Map<string, unknown>();

	public get<T>(key: string): T | undefined {
		return structuredClone(this.values.get(key)) as T | undefined;
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

class FakeSession {
	public closed = false;
	private readonly listeners = new Set<() => void>();

	public onClose(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public close(): void {
		this.closed = true;
		for (const listener of [...this.listeners]) {
			listener();
		}
	}

	public route(): LocalIpcSession {
		return this as unknown as LocalIpcSession;
	}
}
