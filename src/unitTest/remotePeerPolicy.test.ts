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

test('disabling a previously activated strict feature never restores legacy authorization or trusts a node capability', async (t) => {
	const f = await policyFixture();
	t.after(() => f.dispose());
	await f.service.setIncomingGrant(B, IB, PEER, true);
	await f.service.setReceive(B, IB, true);
	f.enabled = false;
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
		registry, service, profiles, leases, localEnabled: false,
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
