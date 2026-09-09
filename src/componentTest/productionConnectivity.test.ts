import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';

import { LOCAL_BROKER_METHODS, LOCAL_BROKER_NOTIFICATIONS, connectivitySnapshotSchema, remotePolicyDashboardSchema, dashboardNodeDirectoryResultSchema } from '../../shared/protocol';
import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { getWorkerPlatformSupport, type WorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import { ProductionBrokerRuntime } from '../composition/ProductionBrokerRuntime';
import { LOCAL_BROKER_KEY_SECRET } from '../composition/SharedBrokerIdentity';
import { InMemorySecretStore } from '../gateway/SecretStore';
import { LocalIpcClient, LocalIpcRemoteError } from '../ipc';
import { StructuredLogger } from '../logging/StructuredLogger';
import { VscodeSecretStore } from '../storage/VscodeStorageAdapters';
import { TestOwnership, uuid } from '../unitTest/artifactStoreTestSupport';
import { ConnectivityMemoryState, TestAuthentication, TEST_ACCOUNT, TEST_LOCATOR, connectivityFixture } from '../unitTest/connectivityTestSupport';
import { AccountDeviceIdentityStore } from '../connectivity/AccountDeviceIdentity';
import { ConnectivityError } from '../connectivity/ConnectivitySchemas';
import type { RemoteExposure, RemoteExposureStatus } from '../tunnel/RemoteExposureProvider';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';
import { GatewayServer } from '../gateway/GatewayServer';
import { GatewayRouter } from '../gateway/GatewayRouter';
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import { WebSocketPeerTransport } from '../peer/WebSocketPeerTransport';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import WebSocket from 'ws';
import { AxiosError, type AxiosAdapter } from 'axios';
import type { Tunnel } from '@microsoft/dev-tunnels-contracts';
import { DevTunnelManagement } from '../connectivity/DevTunnelManagement';
import type { TunnelMetadata } from '../tunnel/DevTunnelProvider';
import { sdkResponse } from '../unitTest/connectivityTestSupport';

test('real production owner composition defaults off and serves authenticated local IPC without auth/discovery/hosting', async (t) => {
	const f = await productionFixture();
	t.after(() => f.dispose());
	await f.runtime.start();
	const local = await f.connect();
	t.after(() => local.client.dispose());
	const snapshot = connectivitySnapshotSchema.parse(await local.session.request(LOCAL_BROKER_METHODS.connectivitySnapshot, local.identity));
	assert.equal(snapshot.state, 'disabled');
	assert.equal(snapshot.discoveryEnabled, false);
	assert.equal(snapshot.delegationEnabled, false);
	assert.equal(f.authentication.requests.length, 0);
	assert.deepEqual(f.runtime.tunnel.lifecycleMetrics(), { loadAttempts: 0, probeAttempts: 0, ensureHostedAttempts: 0 });
	assert.equal(f.runtime.listener.snapshot().state, 'stopped');
	const directory = await local.session.request(LOCAL_BROKER_METHODS.dashboardList, local.identity);
	assert.ok(directory);
});

test('production Dashboard automatically removes closed windows and reuses only the reopened Workspace permissions', async (t) => {
	const f = await productionFixture();
	t.after(() => f.dispose());
	await f.runtime.start();
	const source = await f.connect();
	const target = await f.connect();
	t.after(() => { source.client.dispose(); target.client.dispose(); });
	const sourceIdentity = createOpaqueWorkspaceIdentity('automatic-cleanup-source');
	const targetIdentity = createOpaqueWorkspaceIdentity('automatic-cleanup-target');
	for (const [local, workspaceIdentity, workspaceId, name] of [
		[source, sourceIdentity, uuid(870), 'Source Workspace'],
		[target, targetIdentity, uuid(871), 'Target Workspace'],
	] as const) {
		await local.session.request(LOCAL_BROKER_METHODS.claimWorkspace, {
			...local.identity, workspaceIdentity, workspaceId, name, capabilityTags: [],
		});
	}
	const policy = { ...source.identity, workspaceIdentity: sourceIdentity };
	await source.session.request(LOCAL_BROKER_METHODS.policySet, { ...policy, allowlist: [targetIdentity] });
	const before = await source.session.request(LOCAL_BROKER_METHODS.policyGet, policy);
	await target.session.request(LOCAL_BROKER_METHODS.unregister, target.identity);
	let directory = dashboardNodeDirectoryResultSchema.parse(
		await source.session.request(LOCAL_BROKER_METHODS.dashboardList, source.identity),
	);
	assert.equal(directory.nodes.some((node) => node.nodeId === target.identity.nodeId), false);
	assert.equal(directory.totalNodes, 1);
	assert.deepEqual(await source.session.request(LOCAL_BROKER_METHODS.policyGet, policy), before);
	const reopened = await f.connect();
	t.after(() => reopened.client.dispose());
	await reopened.session.request(LOCAL_BROKER_METHODS.claimWorkspace, {
		...reopened.identity, workspaceIdentity: targetIdentity, workspaceId: uuid(871),
		name: 'Target Workspace', capabilityTags: [],
	});
	directory = dashboardNodeDirectoryResultSchema.parse(
		await source.session.request(LOCAL_BROKER_METHODS.dashboardList, source.identity),
	);
	assert.equal(directory.totalNodes, 2);
	assert.equal(directory.nodes.some((node) => node.nodeId === target.identity.nodeId), false);
	assert.equal(directory.nodes.find((node) => node.nodeId === reopened.identity.nodeId)?.workspaces[0].workspaceId, uuid(871));
	assert.deepEqual(await source.session.request(LOCAL_BROKER_METHODS.policyGet, policy), before);
	assert.equal(f.authentication.requests.length, 0);
	assert.equal(f.runtime.tunnel.lifecycleMetrics().loadAttempts, 0);
	assert.equal(f.runtime.listener.snapshot().state, 'stopped');
});

test('unsupported platforms reject connections before account selection or SDK hosting', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host, workerPlatform: getWorkerPlatformSupport('linux', 'x64') });
	t.after(() => f.dispose());
	await f.runtime.start();
	const local = await f.connect();
	t.after(() => local.client.dispose());
	await assert.rejects(
		local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'enableConnectivity' }),
		LocalIpcRemoteError,
	);
	const snapshot = connectivitySnapshotSchema.parse(
		await local.session.request(LOCAL_BROKER_METHODS.connectivitySnapshot, local.identity),
	);
	assert.equal(snapshot.error, 'PLATFORM_UNSUPPORTED');
	assert.equal(snapshot.connectionState, 'error');
	assert.equal(snapshot.enabled, false);
	assert.equal(f.authentication.requests.length, 0);
	assert.equal(f.picker.count, 0);
	assert.deepEqual(host.created, []);
	assert.equal(f.runtime.listener.snapshot().state, 'stopped');
});

test('Windows starts and stops private SDK connections without a platform opt-in', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host, workerPlatform: getWorkerPlatformSupport('win32', 'x64') });
	t.after(() => f.dispose());
	await f.runtime.start();
	const local = await f.connect();
	t.after(() => local.client.dispose());
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'enableConnectivity' });
	assert.equal(f.runtime.listener.snapshot().state, 'running');
	assert.equal(host.created.length, 1);
	assert.equal(f.settings.get('experimental.peerDelegation'), undefined);
	assert.equal(f.runtime.tunnel.lifecycleMetrics().loadAttempts, 0);
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'disableConnectivity' });
	assert.equal(f.runtime.listener.snapshot().state, 'stopped');
	assert.deepEqual(host.deleted, host.created);
	assert.equal(f.runtime.connectivity.settings.snapshot().enabled, false);
});

test('corrupt new remote state blocks only remote initialization, not the production local Broker or claims', async (t) => {
	const f = await productionFixture({ corrupt: true });
	t.after(() => f.dispose());
	await f.runtime.start();
	const local = await f.connect();
	t.after(() => local.client.dispose());
	const snapshot = connectivitySnapshotSchema.parse(await local.session.request(LOCAL_BROKER_METHODS.connectivitySnapshot, local.identity));
	assert.equal(snapshot.state, 'error');
	assert.equal(f.runtime.connectivity.isReady(), false);
	await local.session.request(LOCAL_BROKER_METHODS.claimWorkspace, {
		...local.identity, workspaceId: uuid(801), workspaceIdentity: createOpaqueWorkspaceIdentity('isolated-local'),
		name: 'Local test workspace', capabilityTags: [],
	});
	assert.equal(f.runtime.registry.peerNodes()[0].workspaces.length, 1);
	assert.equal(f.authentication.requests.length, 0);
	assert.equal(f.runtime.tunnel.lifecycleMetrics().loadAttempts, 0);
});

test('strict activation persists across a real Broker restart and remote receive works while local delegation stays off', async (t) => {
	const f = await productionFixture({ strict: true });
	f.settings.set('experimental.peerDelegation', false);
	t.after(() => f.dispose());
	await f.runtime.start();
	await f.enablePolicy();
	let local = await f.connect();
	const identity = createOpaqueWorkspaceIdentity('receive-without-local-feature');
	await local.session.request(LOCAL_BROKER_METHODS.claimWorkspace, {
		...local.identity, workspaceId: uuid(802), workspaceIdentity: identity, name: 'Remote target', capabilityTags: [],
	});
	await f.runtime.connectivity.remotePolicies.setReceive(local.identity, identity, true);
	let snapshot = connectivitySnapshotSchema.parse(await local.session.request(LOCAL_BROKER_METHODS.connectivitySnapshot, local.identity));
	assert.equal(snapshot.receivingWorkspaceCount, 1);
	assert.equal(snapshot.strictPolicyActivated, true);
	assert.equal(f.settings.get('experimental.peerDelegation'), false);
	local.client.dispose();
	await f.runtime.dispose();
	await f.runtime.connectivity.settings.update((value) => ({ ...value, enabled: false }));
	await f.restart();
	local = await f.connect();
	t.after(() => local.client.dispose());
	snapshot = connectivitySnapshotSchema.parse(await local.session.request(LOCAL_BROKER_METHODS.connectivitySnapshot, local.identity));
	assert.equal(snapshot.strictPolicyActivated, true);
	assert.equal(snapshot.delegationEnabled, false);
	assert.throws(() => f.runtime.connectivity.remotePolicies.requireEnabled(), { reason: 'PEER_NOT_ALLOWED' });
	let remoteRequests = 0;
	f.runtime.remoteTasks.listDevices = async () => {
		remoteRequests += 1;
		throw new Error('Disabled remote listing must not touch a peer.');
	};
	assert.deepEqual(await local.session.request(LOCAL_BROKER_METHODS.remoteList, {}), {
		devices: [], totalDevices: 0, truncated: false,
	});
	await local.session.request(LOCAL_BROKER_METHODS.dashboardList, local.identity);
	assert.equal(remoteRequests, 0);
	assert.equal(f.authentication.requests.length, 0);
});

test('production IPC scopes auto-accept to the claiming window and paired peer, rejects replay and revokes saved approval', async (t) => {
	const f = await productionFixture({ strict: true });
	t.after(() => f.dispose());
	await f.runtime.start();
	await f.enablePolicy();
	const local = await f.connect();
	const other = await f.connect();
	t.after(() => { local.client.dispose(); other.client.dispose(); });
	const workspaceId = uuid(805);
	const workspaceIdentity = createOpaqueWorkspaceIdentity('paired-auto-accept-target');
	await local.session.request(LOCAL_BROKER_METHODS.claimWorkspace, {
		...local.identity, workspaceId, workspaceIdentity, name: 'Target Workspace', capabilityTags: [],
	});
	const paired = await pairWithRuntime(f.runtime);
	t.after(() => paired.dispose());
	const peerId = paired.peerId;
	await f.runtime.connectivity.remotePolicies.setIncomingGrant(local.identity, workspaceIdentity, peerId, true);
	const snapshot = () => local.session.request(LOCAL_BROKER_METHODS.remotePolicyDashboard, local.identity)
		.then((value) => remotePolicyDashboardSchema.parse(value));
	const first = (await snapshot()).workspaces[0].incomingPeers[0];
	assert.equal(first.autoAccept, false);
	await assert.rejects(other.session.request(LOCAL_BROKER_METHODS.remotePolicyAction, {
		...other.identity, action: 'setRemoteAutoAccept', actionHandle: first.actionHandle, enabled: true,
	}));
	await assert.rejects(local.session.request(LOCAL_BROKER_METHODS.remotePolicyAction, {
		...local.identity, action: 'setRemoteAutoAccept', actionHandle: first.actionHandle, enabled: true, peerId: uuid(800),
	}));
	assert.deepEqual(f.runtime.connectivity.remotePolicies.policy(workspaceIdentity).autoAcceptPeerIds, []);
	const current = (await snapshot()).workspaces[0].incomingPeers[0];
	const action = { ...local.identity, action: 'setRemoteAutoAccept', actionHandle: current.actionHandle, enabled: true };
	await local.session.request(LOCAL_BROKER_METHODS.remotePolicyAction, action);
	assert.equal(f.confirmations.length, 1);
	assert.match(f.confirmations[0], /skips only the target task-start prompt/u);
	assert.equal((await snapshot()).workspaces[0].incomingPeers[0].autoAccept, true);
	await assert.rejects(local.session.request(LOCAL_BROKER_METHODS.remotePolicyAction, action));
	await f.runtime.connectivity.pairing.revokePeer(peerId);
	assert.deepEqual(f.runtime.connectivity.remotePolicies.policy(workspaceIdentity).autoAcceptPeerIds, []);
	assert.equal((await snapshot()).workspaces[0].incomingPeers.length, 0);
	assert.equal(f.authentication.requests.length, 0);
	assert.equal(f.runtime.tunnel.lifecycleMetrics().loadAttempts, 0);
});

test('a grant revoked while native auto-accept consent is open cannot turn into a saved permission', async (t) => {
	const f = await productionFixture({ strict: true });
	t.after(() => f.dispose());
	await f.runtime.start();
	await f.enablePolicy();
	const local = await f.connect();
	t.after(() => local.client.dispose());
	const workspaceId = uuid(807);
	const workspaceIdentity = createOpaqueWorkspaceIdentity('approval-race-target');
	await local.session.request(LOCAL_BROKER_METHODS.claimWorkspace, {
		...local.identity, workspaceId, workspaceIdentity, name: 'Target Workspace', capabilityTags: [],
	});
	const paired = await pairWithRuntime(f.runtime);
	t.after(() => paired.dispose());
	await f.runtime.connectivity.remotePolicies.setIncomingGrant(local.identity, workspaceIdentity, paired.peerId, true);
	const snapshot = remotePolicyDashboardSchema.parse(await local.session.request(LOCAL_BROKER_METHODS.remotePolicyDashboard, local.identity));
	let show!: () => void;
	const shown = new Promise<void>((resolve) => { show = resolve; });
	let release!: () => void;
	const released = new Promise<void>((resolve) => { release = resolve; });
	f.confirmation.wait = async () => { show(); await released; };
	const attempt = local.session.request(LOCAL_BROKER_METHODS.remotePolicyAction, {
		...local.identity, action: 'setRemoteAutoAccept', actionHandle: snapshot.workspaces[0].incomingPeers[0].actionHandle, enabled: true,
	});
	const rejected = assert.rejects(attempt);
	await shown;
	await f.runtime.connectivity.remotePolicies.setIncomingGrant(local.identity, workspaceIdentity, paired.peerId, false);
	release();
	await rejected;
	assert.deepEqual(f.runtime.connectivity.remotePolicies.policy(workspaceIdentity).autoAcceptPeerIds, []);
});

test('one authenticated IPC action selects the native account and enables SDK hosting from any window', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host });
	t.after(() => f.dispose());
	await f.runtime.start();
	const a = await f.connect();
	const b = await f.connect();
	t.after(() => { a.client.dispose(); b.client.dispose(); });
	const enable = (local: typeof a) => local.session.request(LOCAL_BROKER_METHODS.connectivityAction, {
		...local.identity, action: 'enableConnectivity',
	});
	await Promise.all([enable(a), enable(b)]);
	assert.equal(f.picker.count, 1);
	assert.equal(host.created.length, 1);
	assert.equal(host.discoveryRefreshes, 1);
	const snapshot = connectivitySnapshotSchema.parse(await b.session.request(LOCAL_BROKER_METHODS.connectivitySnapshot, b.identity));
	assert.equal(snapshot.connectionState, 'online');
	assert.equal(snapshot.enabled, true);
	assert.equal(snapshot.hostingBackend, 'sdk');
	assert.equal(snapshot.accountLabel, 'Test account');
	assert.equal(snapshot.receivingWorkspaceCount, 0);
	assert.equal(snapshot.strictPolicyActivated, true);
	assert.equal(f.settings.has('experimental.crossDeviceDiscovery'), false);
	assert.equal(f.settings.has('experimental.devTunnelSdkHosting'), false);
	assert.equal(f.runtime.tunnel.lifecycleMetrics().loadAttempts, 0);
});

test('no existing account enters native sign-in directly and accepts its own authentication change event', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host });
	t.after(() => f.dispose());
	f.authentication.accounts = [];
	const getSession = f.authentication.getSession.bind(f.authentication);
	f.authentication.getSession = async (provider, scopes, options) => {
		if (options.forceNewSession) {
			f.authentication.accounts = undefined;
			f.authentication.changed();
		}
		return getSession(provider, scopes, options);
	};
	await f.runtime.start();
	const local = await f.connect();
	t.after(() => local.client.dispose());
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'enableConnectivity' });
	assert.equal(f.picker.count, 0);
	assert.equal(host.created.length, 1);
	assert.ok(f.authentication.requests[0].forceNewSession);
	assert.equal(f.runtime.listener.snapshot().state, 'running');
});

test('disable from another window cancels pending account selection without creating a Tunnel', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host });
	t.after(() => f.dispose());
	await f.runtime.start();
	const a = await f.connect();
	const b = await f.connect();
	t.after(() => { a.client.dispose(); b.client.dispose(); });
	let show!: () => void;
	let release!: () => void;
	const shown = new Promise<void>((resolve) => { show = resolve; });
	const released = new Promise<void>((resolve) => { release = resolve; });
	f.picker.wait = async () => { show(); await released; };
	const enabling = assert.rejects(a.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...a.identity, action: 'enableConnectivity' }));
	await shown;
	const stopping = b.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...b.identity, action: 'disableConnectivity' });
	// A following snapshot on the same IPC connection observes the cancellation intent.
	await b.session.request(LOCAL_BROKER_METHODS.connectivitySnapshot, b.identity);
	release();
	await Promise.all([enabling, stopping]);
	assert.equal(host.created.length, 0);
	assert.equal(f.authentication.requests.length, 0);
	assert.equal(f.runtime.connectivity.settings.snapshot().enabled, false);
	assert.equal(f.runtime.listener.snapshot().state, 'stopped');
});

test('a later disable supersedes an enable queued behind a management prompt', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host });
	t.after(() => f.dispose());
	await f.runtime.start();
	const a = await f.connect();
	const b = await f.connect();
	t.after(() => { a.client.dispose(); b.client.dispose(); });
	let show!: () => void;
	let release!: () => void;
	const shown = new Promise<void>((resolve) => { show = resolve; });
	const released = new Promise<void>((resolve) => { release = resolve; });
	f.picker.wait = async () => { show(); await released; };
	const managing = a.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...a.identity, action: 'configureConnectivity' });
	await shown;
	const enabling = assert.rejects(b.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...b.identity, action: 'enableConnectivity' }));
	const disabling = b.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...b.identity, action: 'disableConnectivity' });
	await b.session.request(LOCAL_BROKER_METHODS.connectivitySnapshot, b.identity);
	f.picker.cancel = true;
	release();
	await Promise.all([managing, enabling, disabling]);
	assert.equal(host.created.length, 0);
	assert.equal(f.picker.count, 1);
	assert.equal(f.authentication.requests.length, 0);
	assert.equal(f.runtime.connectivity.settings.snapshot().enabled, false);
});

test('switching accounts and returning restores the original account reference and pinned device key', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host });
	t.after(() => f.dispose());
	const first = f.authentication.session!;
	const second = { ...first, id: 'second-session', account: { id: 'second-account', label: 'Second account' } };
	f.authentication.accounts = [first.account, second.account];
	const getSession = f.authentication.getSession.bind(f.authentication);
	f.authentication.getSession = async (provider, scopes, options) => {
		f.authentication.session = options.account?.id === second.account.id ? second : first;
		return getSession(provider, scopes, options);
	};
	await f.runtime.start();
	const local = await f.connect();
	t.after(() => local.client.dispose());
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'enableConnectivity' });
	const originalAccount = f.runtime.connectivity.account.current()!;
	const originalKey = f.runtime.connectivity.identity.current(originalAccount.accountRef);
	f.picker.indexes.push(0, 1);
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'configureConnectivity' });
	assert.equal(f.runtime.connectivity.account.current()?.accountId, second.account.id);
	assert.notEqual(f.runtime.connectivity.account.current()?.accountRef, originalAccount.accountRef);
	f.picker.indexes.push(0, 0);
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'configureConnectivity' });
	assert.equal(f.runtime.connectivity.account.current()?.accountRef, originalAccount.accountRef);
	assert.deepEqual(f.runtime.connectivity.identity.current(originalAccount.accountRef), originalKey);
	assert.equal(f.runtime.connectivity.settings.snapshot().accounts.length, 2);
});

test('native authentication invalidation during silent startup preserves the saved opt-in', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host });
	t.after(() => f.dispose());
	await f.runtime.start();
	const local = await f.connect();
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'enableConnectivity' });
	local.client.dispose();
	await f.runtime.dispose();
	const requestCount = f.authentication.requests.length;
	host.onNextStart = () => { f.authentication.changed(); throw new ConnectivityError('CANCELLED'); };
	await f.restart();
	assert.equal(f.runtime.connectivity.settings.snapshot().enabled, true);
	assert.equal(f.picker.count, 1);
	assert.ok(f.authentication.requests.slice(requestCount).every((request) => request.silent));
	await f.runtime.connectivity.restore();
	assert.equal(f.runtime.listener.snapshot().state, 'running');
	assert.equal(f.runtime.connectivity.settings.snapshot().enabled, true);
	assert.equal(f.picker.count, 1);
});

test('disable deletes the exact SDK resource; re-enable keeps identity and Workspace settings but creates a new Tunnel', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host });
	t.after(() => f.dispose());
	await f.runtime.start();
	const local = await f.connect();
	t.after(() => local.client.dispose());
	const act = (action: 'enableConnectivity' | 'disableConnectivity') =>
		local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action });
	await act('enableConnectivity');
	const account = f.runtime.connectivity.account.current()!;
	const identity = f.runtime.connectivity.identity.current(account.accountRef);
	const workspaceIdentity = createOpaqueWorkspaceIdentity('persistent-permissions');
	await local.session.request(LOCAL_BROKER_METHODS.claimWorkspace, {
		...local.identity, workspaceIdentity, workspaceId: uuid(940), name: 'Workspace', capabilityTags: [],
	});
	await f.runtime.connectivity.remotePolicies.setReceive(local.identity, workspaceIdentity, true);
	await act('disableConnectivity');
	assert.equal(host.resource, undefined);
	assert.deepEqual(host.deleted, host.created);
	assert.equal(f.runtime.connectivity.settings.snapshot().cleanupPending, false);
	assert.equal(f.runtime.connectivity.account.current()?.accountRef, account.accountRef);
	assert.equal(f.runtime.peerPolicies.acceptsIncoming(workspaceIdentity), true);
	await act('enableConnectivity');
	assert.equal(f.picker.count, 1);
	assert.equal(host.created.length, 2);
	assert.notEqual(host.created[0], host.created[1]);
	assert.deepEqual(f.runtime.connectivity.identity.current(account.accountRef), identity);
	assert.equal(f.runtime.peerPolicies.acceptsIncoming(workspaceIdentity), true);
});

test('failed deletion remains disabled and cleanup-pending across restart, then retries without starting a host', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host });
	t.after(() => f.dispose());
	await f.runtime.start();
	let local = await f.connect();
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'enableConnectivity' });
	host.failDelete = true;
	await assert.rejects(local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'disableConnectivity' }));
	assert.equal(f.runtime.connectivity.settings.snapshot().enabled, false);
	assert.equal(f.runtime.connectivity.settings.snapshot().cleanupPending, true);
	assert.equal(f.runtime.listener.snapshot().state, 'stopped');
	local.client.dispose();
	await f.runtime.dispose();
	await f.restart();
	local = await f.connect();
	t.after(() => local.client.dispose());
	const pending = connectivitySnapshotSchema.parse(await local.session.request(LOCAL_BROKER_METHODS.connectivitySnapshot, local.identity));
	assert.equal(pending.connectionState, 'cleanupPending');
	assert.equal(host.created.length, 1);
	host.failDelete = false;
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'retryConnectivityCleanup' });
	assert.equal(f.runtime.connectivity.settings.snapshot().cleanupPending, false);
	assert.equal(host.resource, undefined);
	assert.equal(host.created.length, 1);
});

test('enabled restoration is silent, but a disabled connection stays off and never prompts on restart', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host });
	t.after(() => f.dispose());
	await f.runtime.start();
	let local = await f.connect();
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'enableConnectivity' });
	local.client.dispose();
	await f.runtime.dispose();
	const requests = f.authentication.requests.length;
	await f.restart();
	assert.equal(host.created.length, 2);
	assert.ok(f.authentication.requests.slice(requests).every((request) => request.silent));
	assert.equal(f.picker.count, 1);
	local = await f.connect();
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'disableConnectivity' });
	local.client.dispose();
	await f.runtime.dispose();
	const stoppedRequests = f.authentication.requests.length;
	await f.restart();
	assert.equal(host.created.length, 2);
	assert.equal(f.authentication.requests.length, stoppedRequests);
	assert.equal(f.runtime.listener.snapshot().state, 'stopped');
});

test('legacy migration deletes only the exact owned resource through SDK management, never CLI login or hosting', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host });
	const legacy = legacyTunnel(f.runtime.profile.deviceId);
	f.runtime.tunnel.ownedResourceForMigration = async () => legacy.metadata;
	const management = new DevTunnelManagement(f.runtime.connectivity.account, {
		ownership: f.ownership, generation: f.ownership.generation,
	}, () => true, { adapter: legacy.adapter });
	f.runtime.connectivity.management.run = management.run.bind(management);
	t.after(async () => { await f.dispose(); await management.dispose(); });
	await f.runtime.start();
	const local = await f.connect();
	t.after(() => local.client.dispose());
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'enableConnectivity' });
	assert.deepEqual(legacy.deleted, [legacy.metadata.tunnelId.split('.')[0]]);
	assert.equal(host.created.length, 1);
	assert.equal(f.runtime.connectivity.settings.snapshot().legacyResourceRetired, true);
	assert.equal(f.runtime.tunnel.lifecycleMetrics().loadAttempts, 0);
});

test('a legacy resource without caller-owned proof blocks migration and never deletes or starts a replacement', async (t) => {
	const host = new ConnectionHost();
	const f = await productionFixture({ host });
	const legacy = legacyTunnel(f.runtime.profile.deviceId);
	legacy.owned = false;
	f.runtime.tunnel.ownedResourceForMigration = async () => legacy.metadata;
	const management = new DevTunnelManagement(f.runtime.connectivity.account, {
		ownership: f.ownership, generation: f.ownership.generation,
	}, () => true, { adapter: legacy.adapter });
	f.runtime.connectivity.management.run = management.run.bind(management);
	t.after(async () => { await f.dispose(); await management.dispose(); });
	await f.runtime.start();
	const local = await f.connect();
	t.after(() => local.client.dispose());
	await assert.rejects(local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'enableConnectivity' }));
	assert.deepEqual(legacy.deleted, []);
	assert.equal(host.created.length, 0);
	assert.equal(f.runtime.connectivity.settings.snapshot().cleanupPending, true);
	assert.equal(f.runtime.tunnel.lifecycleMetrics().loadAttempts, 0);
});

test('failed SDK startup cleans partial resources without CLI fallback or automatic Workspace authorization', async (t) => {
	const host = new ConnectionHost();
	host.failStart = true;
	const f = await productionFixture({ host });
	t.after(() => f.dispose());
	await f.runtime.start();
	const local = await f.connect();
	t.after(() => local.client.dispose());
	await assert.rejects(local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'enableConnectivity' }));
	assert.equal(host.resource, undefined);
	assert.equal(f.runtime.listener.snapshot().state, 'stopped');
	assert.equal(f.runtime.tunnel.lifecycleMetrics().loadAttempts, 0);
	assert.equal(f.runtime.connectivity.settings.snapshot().cleanupPending, false);
	host.failStart = false;
	await local.session.request(LOCAL_BROKER_METHODS.connectivityAction, { ...local.identity, action: 'enableConnectivity' });
	assert.equal(f.picker.count, 1);
	assert.equal(f.runtime.listener.snapshot().state, 'running');
});

async function pairWithRuntime(runtime: ProductionBrokerRuntime) {
	const base = connectivityFixture();
	const sourceId = randomUUID();
	const secrets = new InMemorySecretStore();
	const identity = new AccountDeviceIdentityStore(base.files, base.fence, secrets, sourceId);
	await identity.initialize();
	const publicIdentity = await identity.load(TEST_ACCOUNT);
	const connect = runtime.peers.connect;
	try {
		runtime.peers.connect = async () => undefined;
		await runtime.connectivity.enrollment.synchronize([{
			locator: TEST_LOCATOR, origin: 'https://mesh-test-43121.use2.devtunnels.ms',
			admission: 'private-port-token', hostHint: 'online', accountIdentity: publicIdentity,
		}]);
	} finally { runtime.peers.connect = connect; }
	const credential = identity.derive(TEST_ACCOUNT, runtime.connectivity.identity.current(TEST_ACCOUNT.accountRef)!, false);
	const profiles = new InMemoryPeerProfileStore();
	const keyRef = `mesh.remotePeer.${credential.peerId}`;
	await secrets.store(keyRef, credential.root);
	await profiles.store({
		id: credential.peerId, generation: credential.peerId, peerId: credential.peerId,
		workerDeviceId: runtime.profile.deviceId, credentialKeyRef: keyRef,
		rpcEndpoint: 'wss://mesh-test-43121.use2.devtunnels.ms/agent-mesh/rpc',
	});
	const gateway = new GatewayServer(runtime.connectivity.pairing, new GatewayRouter(runtime.device, runtime.broker));
	const address = await gateway.start();
	const manager = new PeerConnectionManager(sourceId, profiles, secrets, new WebSocketPeerTransport({
		webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${address.port}/agent-mesh/rpc`),
	}));
	await manager.connect(credential.peerId);
	const profile = await manager.get(credential.peerId)?.profile();
	assert.ok(profile?.peerId);
	return { peerId: profile.peerId, dispose: async () => { await manager.dispose(); await gateway.dispose(); base.account.dispose(); } };
}

class ConnectionHost {
	public readonly created: string[] = [];
	public readonly deleted: string[] = [];
	public resource: ReturnType<ProductionBrokerRuntime['connectivity']['sdkExposure']['ownedResource']>;
	public failDelete = false;
	public failStart = false;
	public discoveryRefreshes = 0;
	public onNextStart: (() => void) | undefined;
	private status: RemoteExposureStatus = { state: 'stopped' };

	public install(runtime: ProductionBrokerRuntime): void {
		const sdk = runtime.connectivity.sdkExposure;
		sdk.getStatus = () => this.status;
		sdk.ownedResource = () => this.resource;
		sdk.probe = async () => {
			await runtime.connectivity.account.authorization(new AbortController().signal);
			return { supported: true };
		};
		sdk.start = async ({ localPort }) => {
			const tunnelId = `mesh-${randomUUID()}`;
			const account = runtime.connectivity.account.current()!;
			const advertisementId = runtime.connectivity.settings.snapshot().advertisementId!;
			this.resource = {
				resource: { clusterId: 'use2', tunnelId }, accountRef: account.accountRef,
				advertisementId, ownershipId: randomUUID(), localPort, phase: 'hosting',
			};
			this.created.push(tunnelId);
			const onStart = this.onNextStart;
			this.onNextStart = undefined;
			onStart?.();
			if (this.failStart) { throw new ConnectivityError('OFFLINE'); }
			const tunnel: RemoteExposure = {
				provider: 'sdk', admission: 'private-port-token', localPort,
				resource: this.resource.resource, ownershipLabel: 'synthetic-owned',
				forwardingOrigin: `https://${tunnelId}-${localPort}.use2.devtunnels.ms`,
			};
			this.status = { state: 'ready', tunnel };
			return tunnel;
		};
		sdk.stop = async () => { this.status = { state: 'stopped' }; };
		sdk.renew = async () => undefined;
		sdk.deleteOwnedResource = async () => {
			if (this.resource === undefined) { return; }
			if (this.failDelete) { throw new ConnectivityError('CLEANUP_FAILED'); }
			this.deleted.push(this.resource.resource.tunnelId);
			this.resource = undefined;
		};
		runtime.connectivity.discovery.refresh = async () => { this.discoveryRefreshes += 1; };
	}
}

async function productionFixture(options: { corrupt?: boolean; strict?: boolean; host?: ConnectionHost; workerPlatform?: WorkerPlatformSupport } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'mesh-connectivity-composition-'));
	const state = new ConnectivityMemoryState();
	const ownership = new TestOwnership();
	const authentication = new TestAuthentication();
	const secrets = new InMemorySecretStore();
	const confirmations: string[] = [];
	const confirmation: { wait?: () => Promise<void> } = {};
	const picker: { cancel?: boolean; wait?: () => Promise<void>; count: number; indexes: number[] } = { count: 0, indexes: [] };
	const settings = new Map<string, unknown>([['deviceName', 'Connectivity test']]);
	if (options.strict) { settings.set('experimental.crossDeviceDelegation', true); }
	const configuration = {
		get: <T>(key: string, fallback?: T): T | undefined => (settings.get(key) as T | undefined) ?? fallback,
		update: async (key: string, value: unknown) => { settings.set(key, value); },
	};
	const api = {
		version: '1.136.1',
		Uri: { joinPath: (uri: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(uri.fsPath, ...parts) }) },
		workspace: {
			getConfiguration: () => configuration,
			onDidChangeConfiguration: () => ({ dispose: () => undefined }),
			fs: { createDirectory: async (uri: { fsPath: string }) => { await mkdir(uri.fsPath, { recursive: true }); } },
		},
		authentication,
		window: {
			showQuickPick: async <T>(items: readonly T[]) => {
				picker.count += 1;
				await picker.wait?.();
				return picker.cancel ? undefined : items[picker.indexes.shift() ?? 0];
			},
			showWarningMessage: async (message: string) => {
				confirmations.push(message);
				await confirmation.wait?.();
				return 'Continue';
			},
		},
	};
	if (options.corrupt) {
		await mkdir(join(root, 'mesh-state/connectivity'), { recursive: true });
		await writeFile(join(root, 'mesh-state/connectivity/settings.json'), '{"schemaVersion":999}');
	}
	const guard = new LocalDesktopWorkspaceGuard(() => ({
		remoteName: undefined, isTrusted: true,
		workspaceFolders: [{ uriScheme: 'file' }],
	}));
	const create = async (): Promise<ProductionBrokerRuntime> => ProductionBrokerRuntime.create({
		vscodeApi: api as unknown as typeof vscode,
		context: { extension: { packageJSON: { version: '0.4.0' } } } as vscode.ExtensionContext,
		storageRootUri: { fsPath: root } as vscode.Uri,
		rawState: state,
		secrets: new VscodeSecretStore({
			get: (key) => secrets.get(key), store: (key, value) => secrets.store(key, value), delete: (key) => secrets.delete(key),
			keys: async () => [],
			onDidChange: () => ({ dispose: () => undefined }),
		}),
		ownership: Object.assign(ownership, {
			contend: async () => true, onDidLoseOwnership: () => ({ dispose: () => undefined }), dispose: async () => undefined,
		}),
		generation: ownership.generation,
		identityFor: (deviceId) => ({ userIdentity: root, deviceId }),
		guard, workerPlatform: options.workerPlatform ?? getWorkerPlatformSupport('darwin', 'arm64'),
		logger: new StructuredLogger({
			name: 'Connectivity test', appendLine: () => undefined, append: () => undefined,
			replace: () => undefined, clear: () => undefined, show: () => undefined, hide: () => undefined, dispose: () => undefined,
		}),
		onDidChange: () => undefined,
	});
	let runtime = await create();
	options.host?.install(runtime);
	return {
		authentication, settings, confirmations, confirmation, picker, ownership,
		get runtime() { return runtime; },
		enablePolicy: async () => {
			runtime.connectivity.account.setBinding(TEST_ACCOUNT);
			await runtime.connectivity.identity.load(TEST_ACCOUNT);
			await runtime.connectivity.settings.update((value) => ({ ...value, enabled: true, account: TEST_ACCOUNT }));
		},
		restart: async () => {
			ownership.generation = randomUUID();
			runtime = await create();
			options.host?.install(runtime);
			await runtime.start();
		},
		connect: async () => {
			const identity = { nodeId: randomUUID(), nodeInstanceId: randomUUID() };
			const brokerKey = await secrets.get(LOCAL_BROKER_KEY_SECRET);
			assert.ok(brokerKey);
			const client = new LocalIpcClient({
				identity: { userIdentity: root, deviceId: runtime.profile.deviceId }, brokerKey, clientId: identity.nodeInstanceId,
				handler: (method) => {
					if ([LOCAL_BROKER_NOTIFICATIONS.policyChanged, LOCAL_BROKER_NOTIFICATIONS.dashboardChanged]
						.some((notification) => method === notification)) { return null; }
					throw new Error('Unexpected test Node method.');
				},
			});
			const session = await client.connect();
			await session.request(LOCAL_BROKER_METHODS.register, {
				...identity, label: 'Ordinary test node', capabilities: ['tasks'], status: 'online', startedAt: new Date().toISOString(),
			});
			return { client, session, identity };
		},
		dispose: async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); },
	};
}

function legacyTunnel(deviceId: string) {
	const compact = deviceId.replaceAll('-', '');
	const tunnelAlias = `cam${compact.slice(0, 18)}`;
	const ownershipLabel = `copilot-agent-mesh-${compact.slice(0, 31)}`;
	const metadata: TunnelMetadata = {
		tunnelAlias, tunnelId: `${tunnelAlias}.use2`, ownershipLabel,
		localPort: 43121, provisioned: true, accessDuration: '1d', accessIndex: 0,
		accessExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
		tunnelExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
		build: 'legacy-test', decoderRevision: 'legacy-test',
	};
	const fixture = { metadata, owned: true, deleted: [] as string[] };
	let tunnel: Tunnel | undefined = {
		tunnelId: tunnelAlias, clusterId: 'use2', labels: [ownershipLabel],
		status: { hostConnectionCount: 0 }, ports: [{ portNumber: 43121, protocol: 'http' }],
	};
	const adapter: AxiosAdapter = async (config) => {
		const url = new URL(config.url!);
		if (url.pathname === '/tunnels') {
			return sdkResponse(config, { value: [{ value: fixture.owned && tunnel !== undefined ? [tunnel] : [] }] });
		}
		assert.equal(url.pathname, `/tunnels/${tunnelAlias}`);
		if (config.method === 'delete') {
			fixture.deleted.push(tunnelAlias);
			tunnel = undefined;
			return sdkResponse(config, {});
		}
		if (tunnel === undefined) {
			throw new AxiosError('Not found', 'ERR_BAD_RESPONSE', config, undefined, sdkResponse(config, {}, 404));
		}
		return sdkResponse(config, tunnel);
	};
	return Object.assign(fixture, { adapter });
}
