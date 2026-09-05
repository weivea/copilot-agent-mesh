import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { NodeRegistry } from '../broker/NodeRegistry';
import { PeerPolicyService } from '../broker/PeerPolicyService';
import { PeerPolicyStore } from '../broker/PeerPolicyStore';
import { RemotePeerPolicyService } from '../broker/RemotePeerPolicyService';
import { RemotePeerPolicyStore } from '../broker/RemotePeerPolicyStore';
import { REMOTE_POLICY_CAPABILITY } from '../connectivity/ConnectivitySchemas';
import { EndpointBindingStore } from '../connectivity/EndpointBindingStore';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';
import { uuid } from './artifactStoreTestSupport';
import { connectivityFixture, ConnectivityMemoryState, localSession, TEST_ACCOUNT, TEST_LOCATOR } from './connectivityTestSupport';

const A = { nodeId: uuid(721), nodeInstanceId: uuid(722) };
const B = { nodeId: uuid(723), nodeInstanceId: uuid(724) };
const WA = uuid(725);
const WB = uuid(726);
const IA = createOpaqueWorkspaceIdentity('remote-policy-source');
const IB = createOpaqueWorkspaceIdentity('remote-policy-target');
const PEER = uuid(727);
const PROFILE = uuid(728);
const DEVICE = uuid(729);

test('remote source allowlist, target receive and incoming peer grant are independent at the Lease boundary', async (t) => {
	const f = await policyFixture();
	t.after(() => f.dispose());
	for (const allow of [false, true]) {
		for (const receive of [false, true]) {
			for (const grant of [false, true]) {
				await f.service.setAllowed(A, IA, f.allowed, allow);
				await f.service.setReceive(B, IB, receive);
				await f.service.setIncomingGrant(B, IB, PEER, grant);
				const target = f.remoteTarget(receive);
				if (allow && receive) { await f.service.assertOutgoing(A, target, WB); }
				else { await assert.rejects(f.service.assertOutgoing(A, target, WB), { reason: 'PEER_NOT_ALLOWED' }); }
				const incoming = await f.service.listIncoming(PEER);
				assert.equal(incoming.nodes.length, receive && grant ? 1 : 0);
				assert.equal(incoming.totalNodes, incoming.nodes.length);
				if (grant && receive) {
					const route = await f.registry.acquireTaskRoute(f.route);
					assert.equal(route.workspaceLeaseKey, IB);
					assert.equal(f.leases.isLeased(IB), true);
					f.registry.releaseTaskRoute(PEER, f.route.taskId);
				} else {
					await assert.rejects(f.registry.acquireTaskRoute(f.route), {
						reason: grant ? 'PEER_NOT_ACCEPTING' : 'PEER_NOT_ALLOWED',
					});
					assert.equal(f.leases.isLeased(IB), false);
				}
			}
		}
	}
	assert.equal(f.localEnabled, false);
});

test('remote policy requires every claimed source Workspace and rejects foreign edits, stale profiles and post-list revocation', async (t) => {
	const f = await policyFixture();
	t.after(() => f.dispose());
	await f.service.setAllowed(A, IA, f.allowed, true);
	await f.service.setReceive(B, IB, true);
	await f.service.setIncomingGrant(B, IB, PEER, true);
	const other = createOpaqueWorkspaceIdentity('second-source-root');
	await f.registry.claimWorkspace({ ...A, workspaceId: uuid(731), workspaceIdentity: other, name: 'Second source', capabilityTags: [] });
	await assert.rejects(f.service.assertOutgoing(A, f.remoteTarget(true), WB), { reason: 'PEER_NOT_ALLOWED' });
	await f.service.setAllowed(A, other, f.allowed, true);
	await f.service.assertOutgoing(A, f.remoteTarget(true), WB);
	await assert.rejects(f.service.setReceive(A, IB, true), { reason: 'POLICY_FORBIDDEN' });
	assert.equal((await f.service.listIncoming(PEER)).nodes.length, 1);
	await f.service.setIncomingGrant(B, IB, PEER, false);
	await assert.rejects(f.registry.acquireTaskRoute(f.route), { reason: 'PEER_NOT_ALLOWED' });
	await assert.rejects(f.registry.acquireTaskRoute({ ...f.route, nodeInstanceId: uuid(900) }));
	await f.profiles.store({ ...(await f.profiles.get(PROFILE))!, generation: uuid(899) });
	await assert.rejects(f.service.assertOutgoing(A, f.remoteTarget(true), WB), { reason: 'PEER_NOT_ALLOWED' });
	assert.equal(f.leases.isLeased(IB), false);
});

test('remote automatic task acceptance defaults off, binds one peer and Workspace, and remains subordinate to receive/grants', async (t) => {
	const f = await policyFixture();
	t.after(() => f.dispose());
	const target = { deviceId: DEVICE, ...B, workspaceId: WB };
	await assert.rejects(f.service.setAutoAccept(B, IB, PEER, true), { reason: 'PEER_NOT_ALLOWED' });
	await f.service.setIncomingGrant(B, IB, PEER, true);
	await f.service.setReceive(B, IB, true);
	assert.equal(await f.service.approveTaskStart(PEER, target, IB, uuid(902)), undefined);
	await assert.rejects(f.service.setAutoAccept(A, IB, PEER, true), { reason: 'POLICY_FORBIDDEN' });
	await f.service.setAutoAccept(B, IB, PEER, true, f.service.revision());
	assert.deepEqual(await f.service.approveTaskStart(PEER, target, IB, uuid(902)), {
		kind: 'remoteAutoAccept', peerId: PEER, workspaceIdentity: IB, taskId: uuid(902),
		policyRevision: f.service.revision(),
	});
	await f.service.setIncomingGrant(A, IA, PEER, true);
	await f.service.setReceive(A, IA, true);
	assert.equal(await f.service.approveTaskStart(PEER, { deviceId: DEVICE, ...A, workspaceId: WA }, IA, uuid(903)), undefined);
	await assert.rejects(f.service.approveTaskStart(uuid(901), target, IB, uuid(904)));
	await f.service.setReceive(B, IB, false);
	await assert.rejects(f.service.approveTaskStart(PEER, target, IB, uuid(905)), { reason: 'PEER_NOT_ACCEPTING' });
	await f.service.setReceive(B, IB, true);
	await f.service.setIncomingGrant(B, IB, PEER, false);
	assert.deepEqual(f.service.policy(IB).autoAcceptPeerIds, []);
	await f.service.setIncomingGrant(B, IB, PEER, true);
	assert.equal(await f.service.approveTaskStart(PEER, target, IB, uuid(906)), undefined);
});

test('automatic acceptance persists but cannot survive an obsolete policy revision or lost Workspace claim', async (t) => {
	const f = await policyFixture();
	t.after(() => f.dispose());
	await f.service.setIncomingGrant(B, IB, PEER, true);
	const staleRevision = f.service.revision();
	await f.service.setAutoAccept(B, IB, PEER, true, staleRevision);
	await assert.rejects(f.service.setAutoAccept(B, IB, PEER, false, staleRevision), { reason: 'POLICY_FORBIDDEN' });
	const reopened = new RemotePeerPolicyStore(f.files, f.fence);
	await reopened.initialize();
	assert.deepEqual(reopened.get(IB).autoAcceptPeerIds, [PEER]);
	await f.service.setAutoAccept(B, IB, PEER, false);
	f.fs.syncFile = async () => { f.registry.releaseWorkspace({ ...B, workspaceId: WB }); };
	await assert.rejects(f.service.setAutoAccept(B, IB, PEER, true), { reason: 'POLICY_FORBIDDEN' });
	const afterRace = new RemotePeerPolicyStore(f.files, f.fence);
	await afterRace.initialize();
	assert.deepEqual(afterRace.get(IB).autoAcceptPeerIds, []);
});

test('revoking a peer removes saved automatic acceptance and all of its Workspace grants', async (t) => {
	const f = await policyFixture();
	t.after(() => f.dispose());
	await f.service.setIncomingGrant(B, IB, PEER, true);
	await f.service.setAutoAccept(B, IB, PEER, true);
	await f.remoteStore.removePeer(PEER);
	assert.deepEqual(f.remoteStore.get(IB).autoAcceptPeerIds, []);
	assert.deepEqual(f.remoteStore.get(IB).incomingPeerIds, []);
});

test('tree allowlist edits cover every actual source root and reject a changed source set', async (t) => {
	const f = await policyFixture();
	t.after(() => f.dispose());
	const additionalIdentity = createOpaqueWorkspaceIdentity('additional-source-root');
	await f.registry.claimWorkspace({
		...A, workspaceId: uuid(980), workspaceIdentity: additionalIdentity, name: 'Second source root', capabilityTags: [],
	});
	const scope = f.service.sourceScope(A);
	await f.service.setAllowedForWindow(A, scope, f.allowed, true, f.service.revision());
	assert.deepEqual(f.service.policy(IA).allowlist, [f.allowed]);
	assert.deepEqual(f.service.policy(additionalIdentity).allowlist, [f.allowed]);
	await f.service.assertOutgoing(A, f.remoteTarget(true), WB);
	f.registry.releaseWorkspace({ ...A, workspaceId: uuid(980) });
	await assert.rejects(
		f.service.setAllowedForWindow(A, scope, f.allowed, false, f.service.revision()),
		{ reason: 'POLICY_FORBIDDEN' },
	);
	assert.deepEqual(f.service.policy(IA).allowlist, [f.allowed]);
});

test('disabling a previously activated strict feature never restores legacy authorization or trusts a node capability', async (t) => {
	const f = await policyFixture();
	t.after(() => f.dispose());
	await f.service.setIncomingGrant(B, IB, PEER, true);
	await f.service.setReceive(B, IB, true);
	await f.service.setAutoAccept(B, IB, PEER, true);
	f.enabled = false;
	await assert.rejects(f.service.approveTaskStart(PEER, { deviceId: DEVICE, ...B, workspaceId: WB }, IB, uuid(906)), { reason: 'PEER_NOT_ALLOWED' });
	await assert.rejects(f.service.listIncoming(PEER), { reason: 'PEER_NOT_ALLOWED' });
	await assert.rejects(f.registry.acquireTaskRoute(f.route), { reason: 'PEER_NOT_ALLOWED' });
	f.strict = false;
	const legacy = await f.service.listIncoming(PEER);
	assert.ok(legacy.nodes.every((node) => !node.capabilities.includes(REMOTE_POLICY_CAPABILITY)));
});

async function policyFixture() {
	const base = connectivityFixture();
	const sessions = await Promise.all([localSession(A.nodeInstanceId), localSession(B.nodeInstanceId)]);
	const leases = new WorkspaceLeaseManager();
	const registry = await NodeRegistry.create({
		deviceId: DEVICE, state: new ConnectivityMemoryState(), ids: { next: randomUUID },
		clock: { now: () => new Date() }, workspaceLeases: leases,
		scheduler: { repeat: () => ({ dispose: () => undefined }) },
	});
	for (const [index, node] of [A, B].entries()) {
		registry.register({ ...node, label: `Window ${index}`, capabilities: ['tasks', REMOTE_POLICY_CAPABILITY], status: 'online', startedAt: new Date().toISOString() }, sessions[index].session);
		await registry.claimWorkspace({ ...node, workspaceId: index === 0 ? WA : WB, workspaceIdentity: index === 0 ? IA : IB, name: `Workspace ${index}`, capabilityTags: [] });
	}
	const localStore = new PeerPolicyStore(base.files, { ...base.fence, clock: { now: () => new Date() } });
	const remoteStore = new RemotePeerPolicyStore(base.files, base.fence);
	const endpoints = new EndpointBindingStore(base.files, base.fence);
	await Promise.all([localStore.initialize(), remoteStore.initialize(), endpoints.initialize()]);
	const local = new PeerPolicyService(localStore, registry, { enabled: () => false });
	const profiles = new InMemoryPeerProfileStore();
	await profiles.store({ id: PROFILE, generation: PROFILE, rpcEndpoint: 'wss://mesh-test-43121.use2.devtunnels.ms/agent-mesh/rpc', workerDeviceId: DEVICE, peerId: PEER, credentialKeyRef: 'test-root' });
	await endpoints.commit({
		profileId: PROFILE, profileGeneration: PROFILE, expectedWorkerDeviceId: DEVICE,
		accountRef: TEST_ACCOUNT.accountRef, locator: TEST_LOCATOR, admission: 'legacy-mesh-auth',
		verifiedOrigin: 'https://mesh-test-43121.use2.devtunnels.ms', verifiedAt: new Date().toISOString(),
	}, undefined, async () => undefined);
	const state = { enabled: true, strict: true };
	const service = new RemotePeerPolicyService(remoteStore, registry, local, endpoints, profiles, {
		enabled: () => state.enabled, strict: () => state.strict, ready: () => true,
		assertPeerAllowed: (id) => assert.equal(id, PEER), assertPeerActive: async (id) => assert.equal(id, PEER),
	});
	registry.setPeerRouteAuthorizer(service);
	return {
		registry, service, profiles, leases, remoteStore,
		files: base.files, fs: base.fs, fence: base.fence, localEnabled: false,
		get enabled() { return state.enabled; }, set enabled(value: boolean) { state.enabled = value; },
		get strict() { return state.strict; }, set strict(value: boolean) { state.strict = value; },
		allowed: { profileId: PROFILE, profileGeneration: PROFILE, workspaceIdentity: IB },
		route: { ...B, workspaceId: WB, ownerId: PEER, remotePeerId: PEER, taskId: uuid(733) },
		remoteTarget: (receive: boolean) => ({
			profileId: PROFILE, profileGeneration: PROFILE, deviceId: DEVICE,
			node: { ...registry.list().nodes.find((node) => node.nodeId === B.nodeId)!, workspaces: registry.list().nodes.find((node) => node.nodeId === B.nodeId)!.workspaces.map((workspace) => ({ ...workspace, acceptsIncoming: receive })) },
		}),
		dispose: async () => {
			registry.dispose(); base.account.dispose();
			for (const session of sessions) { await session.dispose(); }
		},
	};
}
