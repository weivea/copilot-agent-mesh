import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';

import { BoundPeerTransport } from '../connectivity/BoundPeerTransport';
import { DevTunnelEndpointResolver } from '../connectivity/DevTunnelEndpointResolver';
import { DevTunnelManagement } from '../connectivity/DevTunnelManagement';
import { EndpointBindingStore } from '../connectivity/EndpointBindingStore';
import { GatewayRouter } from '../gateway/GatewayRouter';
import { GatewayServer } from '../gateway/GatewayServer';
import { InMemoryPairingRecordStore, PairingService } from '../gateway/PairingService';
import { PeerRevocationService } from '../gateway/PeerRevocationService';
import { InMemorySecretStore } from '../gateway/SecretStore';
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import { WebSocketPeerTransport } from '../peer/WebSocketPeerTransport';
import { uuid } from '../unitTest/artifactStoreTestSupport';
import { advertisedTunnel, connectivityFixture, sdkResponse, TEST_LOCATOR } from '../unitTest/connectivityTestSupport';

const DEVICE = uuid(740);
const COORDINATOR = uuid(741);

test('real Mesh pairing commits a locator only after device proof, then rebinds the same peer without re-enrollment', async (t) => {
	const f = await boundFixture();
	t.after(() => f.dispose());
	const invitation = await f.pairing.createInvitation(f.origin());
	const connection = await f.manager.add(invitation.url, (profile) => f.transport.prepare(profile, {
		locator: TEST_LOCATOR, admission: 'legacy-mesh-auth', origin: f.origin(), hostHint: 'unknown',
	}));
	const initial = f.endpoints.get(connection.profileId);
	assert.equal(initial?.expectedWorkerDeviceId, DEVICE);
	assert.equal(f.endpoints.attempt(connection.profileId), undefined);
	const peerId = (await connection.profile())?.peerId;
	await f.manager.disconnect(connection.profileId);
	f.tunnel.ports[0].portForwardingUris = ['https://mesh-rebound-43121.use2.devtunnels.ms'];
	await f.manager.connect(connection.profileId);
	assert.equal((await connection.profile())?.peerId, peerId);
	assert.equal((await f.records.listPeers()).length, 1);
	assert.equal(f.endpoints.get(connection.profileId)?.verifiedOrigin, f.origin());
	assert.equal(connection.snapshot().state, 'online');
	await f.manager.disconnect(connection.profileId);
	f.deviceInfoId = uuid(799);
	await assert.rejects(f.manager.connect(connection.profileId), { reason: 'AUTH_FAILED' });
	assert.equal(f.endpoints.get(connection.profileId)?.verifiedOrigin, f.origin());
});

test('failed pairing and profile-generation races cannot leave an authorized endpoint binding', async (t) => {
	const f = await boundFixture();
	t.after(() => f.dispose());
	const invitation = await f.pairing.createInvitation(f.origin());
	const wrong = new URL(invitation.url);
	wrong.hash = new URLSearchParams({ secret: Buffer.alloc(32, 77).toString('base64url') }).toString();
	await assert.rejects(f.manager.add(wrong.toString(), (profile) => f.transport.prepare(profile, {
		locator: TEST_LOCATOR, admission: 'legacy-mesh-auth', origin: f.origin(), hostHint: 'unknown',
	})));
	assert.equal(f.endpoints.list().length, 0);
	const next = await f.pairing.createInvitation(f.origin());
	let profileId: string | undefined;
	let changed = false;
	const syncFile = f.fs.syncFile.bind(f.fs);
	f.fs.syncFile = async (path) => {
		await syncFile(path);
		if (!changed && profileId !== undefined && path.includes('endpoints.json')
			&& (await f.profiles.get(profileId))?.peerId !== undefined) {
			changed = true;
			await f.profiles.store({ ...(await f.profiles.get(profileId))!, generation: uuid(780) });
		}
	};
	await assert.rejects(f.manager.add(next.url, async (profile) => {
		profileId = profile.id;
		await f.transport.prepare(profile, { locator: TEST_LOCATOR, admission: 'legacy-mesh-auth', origin: f.origin(), hostHint: 'unknown' });
	}));
	assert.equal(changed, true);
	assert.equal(f.endpoints.list().length, 0);
	assert.notEqual(f.manager.get(profileId!)?.snapshot().state, 'online');
});

test('owner loss and a closed authenticated socket fence endpoint writes and prevent online activation', async (t) => {
	const f = await boundFixture();
	t.after(async () => { f.ownership.owner = true; await f.dispose(); });
	const invitation = await f.pairing.createInvitation(f.origin());
	f.closeOnInfo = true;
	await assert.rejects(f.manager.add(invitation.url, (profile) => f.transport.prepare(profile, {
		locator: TEST_LOCATOR, admission: 'legacy-mesh-auth', origin: f.origin(), hostHint: 'unknown',
	})));
	assert.equal(f.endpoints.list().length, 0);
	f.closeOnInfo = false;
	const next = await f.pairing.createInvitation(f.origin());
	const syncFile = f.fs.syncFile.bind(f.fs);
	f.fs.syncFile = async (path) => {
		await syncFile(path);
		if (path.includes('endpoints.json')) { f.ownership.owner = false; }
	};
	await assert.rejects(f.manager.add(next.url, (profile) => f.transport.prepare(profile, {
		locator: TEST_LOCATOR, admission: 'legacy-mesh-auth', origin: f.origin(), hostHint: 'unknown',
	})));
	assert.equal(f.endpoints.list().length, 0);
});

test('target revocation closes authenticated sockets and pending reconnect hellos, persists denial before key cleanup, and survives restart', async (t) => {
	const base = connectivityFixture();
	const records = new ReadGatePairingStore();
	const secrets = new CleanupFailingSecrets();
	let gateway!: GatewayServer;
	let cancellations = 0;
	const revocations = new PeerRevocationService(base.files, base.fence, records, secrets,
		(id) => gateway.closePeer(id), async () => { cancellations += 1; }, () => undefined);
	await revocations.initialize();
	const pairing = new PairingService(DEVICE, secrets, records, { accessControl: revocations });
	gateway = new GatewayServer(pairing, router(() => DEVICE), { heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300 });
	const address = await gateway.start();
	const profiles = new InMemoryPeerProfileStore();
	const transport = new WebSocketPeerTransport({
		webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${address.port}/agent-mesh/rpc`),
		requestTimeoutMs: 500, heartbeatIntervalMs: 100,
	});
	const manager = new PeerConnectionManager(COORDINATOR, profiles, secrets, transport);
	t.after(async () => { records.release(); await manager.dispose(); await gateway.dispose(); await pairing.dispose(); base.account.dispose(); });
	const connection = await manager.add((await pairing.createInvitation('https://mesh-test-43121.use2.devtunnels.ms')).url);
	const profile = (await connection.profile())!;
	assert.ok(profile.peerId);
	records.blockNext = true;
	const controller = new AbortController();
	const reconnect = transport.connect(profile, COORDINATOR, secrets, profiles, controller.signal);
	// Observe rejection immediately, since revocation terminates the real socket before unblocking storage.
	const rejectedReconnect = assert.rejects(reconnect);
	await records.started;
	secrets.failPeerDelete = true;
	await assert.rejects(pairing.revokePeer(profile.peerId), { code: 'CLEANUP_FAILED' });
	assert.equal(cancellations, 1);
	assert.equal(revocations.snapshot()[0].cleanupPending, true);
	assert.throws(() => revocations.assertAllowed(profile.peerId!), { reason: 'AUTH_FAILED' });
	records.release();
	await rejectedReconnect;
	await waitUntil(() => connection.snapshot().state !== 'online');
	const restored = new PeerRevocationService(base.files, base.fence, records, secrets,
		(id) => gateway.closePeer(id), async () => undefined, () => undefined);
	await restored.initialize();
	assert.throws(() => restored.assertAllowed(profile.peerId!), { reason: 'AUTH_FAILED' });
	assert.ok(await secrets.get(profile.credentialKeyRef!));
	await assert.rejects(transport.connect(profile, COORDINATOR, secrets, profiles, new AbortController().signal));
	secrets.failPeerDelete = false;
	await restored.retryCleanup();
	assert.equal(restored.snapshot()[0].cleanupPending, false);
	assert.equal(await secrets.get(`mesh.peer.${profile.peerId}`), undefined);
	assert.throws(() => restored.assertAllowed(profile.peerId!), { reason: 'AUTH_FAILED' });
});

test('a revoked in-progress enrollment cannot finish commit or regain permissions with its pending key', async (t) => {
	const base = connectivityFixture();
	const records = new InMemoryPairingRecordStore();
	const secrets = new InMemorySecretStore();
	let gateway!: GatewayServer;
	const revocations = new PeerRevocationService(base.files, base.fence, records, secrets,
		(id) => gateway.closePeer(id), async () => undefined, () => undefined);
	await revocations.initialize();
	const pairing = new PairingService(DEVICE, secrets, records, { accessControl: revocations });
	gateway = new GatewayServer(pairing, router(() => DEVICE));
	const address = await gateway.start();
	let commitSeen!: () => void;
	const commitReached = new Promise<void>((resolve) => { commitSeen = resolve; });
	const profiles = new InMemoryPeerProfileStore();
	const transport = new WebSocketPeerTransport({
		requestTimeoutMs: 100,
		webSocketFactory: () => {
			const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agent-mesh/rpc`);
			const send = socket.send.bind(socket);
			socket.send = ((data, ...args) => {
				if (typeof data === 'string' && JSON.parse(data).method === 'mesh.enrollmentCommit') { commitSeen(); return; }
				Reflect.apply(send, socket, [data, ...args]);
			}) as WebSocket['send'];
			return socket;
		},
	});
	const manager = new PeerConnectionManager(COORDINATOR, profiles, secrets, transport, { reconnectBaseMs: 1000 });
	t.after(async () => { await manager.dispose(); await gateway.dispose(); await pairing.dispose(); base.account.dispose(); });
	const add = assert.rejects(manager.add((await pairing.createInvitation('https://mesh-test-43121.use2.devtunnels.ms')).url));
	await commitReached;
	const pending = (await records.listPending())[0];
	assert.ok(pending);
	await pairing.revokePeer(pending.peerId);
	await add;
	assert.equal((await records.listPeers()).length, 0);
	assert.equal(await secrets.get(pending.rootKeyRef), undefined);
	assert.throws(() => revocations.assertAllowed(pending.peerId), { reason: 'AUTH_FAILED' });
});

async function boundFixture() {
	const base = connectivityFixture();
	const records = new InMemoryPairingRecordStore();
	const secrets = new InMemorySecretStore();
	const profiles = new InMemoryPeerProfileStore();
	const pairing = new PairingService(DEVICE, secrets, records);
	const info = { id: DEVICE, close: false };
	let gateway!: GatewayServer;
	gateway = new GatewayServer(pairing, router((peerId) => {
		if (info.close) { gateway.closePeer(peerId); }
		return info.id;
	}));
	const address = await gateway.start();
	const tunnel = advertisedTunnel();
	const management = new DevTunnelManagement(base.account, base.fence, () => true, {
		adapter: async (config) => sdkResponse(config, tunnel),
	});
	const endpoints = new EndpointBindingStore(base.files, base.fence);
	await endpoints.initialize();
	const transport = new BoundPeerTransport(endpoints, new DevTunnelEndpointResolver(management), base.account,
		base.fence, () => true, {
			webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${address.port}/agent-mesh/rpc`),
			requestTimeoutMs: 100, heartbeatIntervalMs: 1000,
		});
	const manager = new PeerConnectionManager(COORDINATOR, profiles, secrets, transport, {
		reconnectBaseMs: 1000,
		onProfileRemoved: (profile) => endpoints.remove(profile.id, profile.generation!),
	});
	return {
		...base, records, secrets, profiles, endpoints, pairing, manager, tunnel, transport,
		get deviceInfoId() { return info.id; }, set deviceInfoId(value: string) { info.id = value; },
		get closeOnInfo() { return info.close; }, set closeOnInfo(value: boolean) { info.close = value; },
		origin: () => tunnel.ports[0].portForwardingUris[0],
		dispose: async () => { await manager.dispose(); await gateway.dispose(); await pairing.dispose(); await management.dispose(); base.account.dispose(); },
	};
}

function router(deviceId: (peerId: string) => string): GatewayRouter {
	return new GatewayRouter({
		getInfo: async (peerId) => ({
			deviceId: deviceId(peerId), name: 'Test Mesh device', platform: 'darwin', architecture: 'arm64',
			vscodeVersion: '1.136.1', extensionVersion: '0.4.0', protocolVersion: 2,
		}),
	}, { list: async () => [] }, {
		start: async () => { throw new Error('No task or model execution in this fixture.'); },
		get: async () => null, cancel: async () => null, answer: async () => null,
	});
}

class ReadGatePairingStore extends InMemoryPairingRecordStore {
	public blockNext = false;
	private start!: () => void;
	private unblock!: () => void;
	public readonly started = new Promise<void>((resolve) => { this.start = resolve; });
	private readonly gate = new Promise<void>((resolve) => { this.unblock = resolve; });
	public override async getPeer(id: string) {
		if (this.blockNext) { this.blockNext = false; this.start(); await this.gate; }
		return super.getPeer(id);
	}
	public release(): void { this.unblock(); }
}
class CleanupFailingSecrets extends InMemorySecretStore {
	public failPeerDelete = false;
	public override async delete(key: string): Promise<void> {
		if (this.failPeerDelete && key.startsWith('mesh.peer.')) { throw new Error('synthetic cleanup failure'); }
		await super.delete(key);
	}
}
async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() >= deadline) { throw new Error('Condition did not become true.'); }
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
