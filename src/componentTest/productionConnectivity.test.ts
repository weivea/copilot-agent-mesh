import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';

import { LOCAL_BROKER_METHODS, LOCAL_BROKER_NOTIFICATIONS, connectivitySnapshotSchema, remotePolicyDashboardSchema, dashboardNodeDirectoryResultSchema } from '../../shared/protocol';
import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { getWorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import { ProductionBrokerRuntime } from '../composition/ProductionBrokerRuntime';
import { LOCAL_BROKER_KEY_SECRET } from '../composition/SharedBrokerIdentity';
import { InMemorySecretStore } from '../gateway/SecretStore';
import { LocalIpcClient } from '../ipc';
import { StructuredLogger } from '../logging/StructuredLogger';
import { VscodeSecretStore } from '../storage/VscodeStorageAdapters';
import { TestOwnership, uuid } from '../unitTest/artifactStoreTestSupport';
import { ConnectivityMemoryState, TestAuthentication } from '../unitTest/connectivityTestSupport';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';
import { GatewayServer } from '../gateway/GatewayServer';
import { GatewayRouter } from '../gateway/GatewayRouter';
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import { WebSocketPeerTransport } from '../peer/WebSocketPeerTransport';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import WebSocket from 'ws';

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
	f.settings.set('experimental.peerDelegation', true);
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
	t.after(() => f.dispose());
	await f.runtime.start();
	let local = await f.connect();
	const identity = createOpaqueWorkspaceIdentity('receive-without-local-feature');
	await local.session.request(LOCAL_BROKER_METHODS.claimWorkspace, {
		...local.identity, workspaceId: uuid(802), workspaceIdentity: identity, name: 'Remote target', capabilityTags: [],
	});
	await f.runtime.connectivity.remotePolicies.setReceive(local.identity, identity, true);
	let snapshot = connectivitySnapshotSchema.parse(await local.session.request(LOCAL_BROKER_METHODS.connectivitySnapshot, local.identity));
	assert.equal(snapshot.receivingWorkspaceCount, 1);
	assert.equal(snapshot.strictPolicyActivated, true);
	assert.equal(f.settings.get('experimental.peerDelegation'), undefined);
	local.client.dispose();
	await f.runtime.dispose();
	f.settings.set('experimental.crossDeviceDelegation', false);
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

async function pairWithRuntime(runtime: ProductionBrokerRuntime) {
	const gateway = new GatewayServer(runtime.connectivity.pairing, new GatewayRouter(runtime.device, runtime.broker));
	const address = await gateway.start();
	const manager = new PeerConnectionManager(randomUUID(), new InMemoryPeerProfileStore(), new InMemorySecretStore(), new WebSocketPeerTransport({
		webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${address.port}/agent-mesh/rpc`),
	}));
	const connection = await manager.add((await runtime.connectivity.pairing.createInvitation('https://test-43121.use2.devtunnels.ms')).url);
	const profile = await connection.profile();
	assert.ok(profile?.peerId);
	return { peerId: profile.peerId, dispose: async () => { await manager.dispose(); await gateway.dispose(); } };
}

async function productionFixture(options: { corrupt?: boolean; strict?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'mesh-connectivity-composition-'));
	const state = new ConnectivityMemoryState();
	const ownership = new TestOwnership();
	const authentication = new TestAuthentication();
	const secrets = new InMemorySecretStore();
	const confirmations: string[] = [];
	const confirmation: { wait?: () => Promise<void> } = {};
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
		guard, workerPlatform: getWorkerPlatformSupport(process.platform, process.arch),
		logger: new StructuredLogger({
			name: 'Connectivity test', appendLine: () => undefined, append: () => undefined,
			replace: () => undefined, clear: () => undefined, show: () => undefined, hide: () => undefined, dispose: () => undefined,
		}),
		onDidChange: () => undefined,
	});
	let runtime = await create();
	return {
		authentication, settings, confirmations, confirmation,
		get runtime() { return runtime; },
		restart: async () => { ownership.generation = randomUUID(); runtime = await create(); await runtime.start(); },
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
