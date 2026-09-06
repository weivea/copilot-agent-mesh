import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Tunnel } from '@microsoft/dev-tunnels-contracts';
import { AxiosError, type AxiosAdapter } from 'axios';
import WebSocket from 'ws';
import { deviceInfoSchema } from '../../shared/protocol';

import { AccountDeviceIdentityStore } from '../connectivity/AccountDeviceIdentity';
import { AccountPeerEnrollment } from '../connectivity/AccountPeerEnrollment';
import { BoundPeerTransport } from '../connectivity/BoundPeerTransport';
import { ACCOUNT_IDENTITY_PREFIX, ADVERTISEMENT_PREFIX, DISCOVERY_LABELS, PRIVATE_LABEL, type ConnectivityCode } from '../connectivity/ConnectivitySchemas';
import { DevTunnelDiscoveryProvider } from '../connectivity/DevTunnelDiscoveryProvider';
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
import { uuid } from '../unitTest/artifactStoreTestSupport';
import { connectivityFixture, sdkResponse, syntheticCapability } from '../unitTest/connectivityTestSupport';

test('same-account public-key discovery automatically establishes both real Mesh connections without invitations', async (t) => {
	const directory = new AccountDirectory();
	const a = await accountDevice(directory, 910);
	const b = await accountDevice(directory, 911);
	t.after(async () => { await a.dispose(); await b.dispose(); });
	await Promise.all([a.sync(), b.sync()]);
	assert.equal(a.peers.listConnections()[0]?.snapshot().state, 'online');
	assert.equal(b.peers.listConnections()[0]?.snapshot().state, 'online');
	assert.equal((await a.records.listInvitations()).length, 0);
	assert.equal((await b.records.listInvitations()).length, 0);
	assert.equal((await a.records.listPending()).length, 0);
	const peer = a.peers.listConnections()[0];
	assert.equal(deviceInfoSchema.parse(await peer.request('device.getInfo', {})).deviceId, b.deviceId);
	assert.equal(a.endpoints.get(peer.profileId)?.admission, 'private-port-token');
	const credential = (await peer.profile())!.credentialKeyRef!;
	const root = await a.secrets.get(credential);
	assert.ok(root);
	assert.ok(![...a.fs.files.values()].join('').includes(root));
	assert.ok(directory.requests.some((url) => url.searchParams.get('tokenScopes') === 'connect'));
	assert.ok(directory.requests.filter((url) => url.pathname === '/tunnels').every((url) => !url.searchParams.has('tokenScopes')));
});

test('a replacement Tunnel rebinds the authenticated peer without replacing profile, generation, or saved credentials', async (t) => {
	const directory = new AccountDirectory();
	const a = await accountDevice(directory, 912);
	const b = await accountDevice(directory, 913);
	t.after(async () => { await a.dispose(); await b.dispose(); });
	await Promise.all([a.sync(), b.sync()]);
	const connection = a.peers.listConnections()[0];
	const profile = await connection.profile();
	const previousBinding = a.endpoints.get(connection.profileId);
	await a.peers.disconnect(connection.profileId);
	b.publish('replacement-tunnel');
	await a.sync();
	assert.equal(connection.snapshot().state, 'online');
	assert.deepEqual(await connection.profile(), profile);
	assert.notDeepEqual(a.endpoints.get(connection.profileId)?.locator, previousBinding?.locator);
	assert.equal((await b.records.listPeers()).length, 1);
	assert.equal(a.endpoints.get(connection.profileId)?.profileGeneration, profile?.generation);
});

test('changed public keys and duplicate identities never silently replace a trusted device', async (t) => {
	const directory = new AccountDirectory();
	const a = await accountDevice(directory, 914);
	const b = await accountDevice(directory, 915);
	const c = await accountDevice(directory, 916);
	t.after(async () => { await a.dispose(); await b.dispose(); await c.dispose(); });
	await Promise.all([a.sync(), b.sync(), c.sync()]);
	const profile = (await a.profiles.list()).find((value) => value.workerDeviceId === b.deviceId)!;
	const original = b.tunnel.description;
	b.tunnel.description = `${ACCOUNT_IDENTITY_PREFIX}${JSON.stringify({ deviceId: b.deviceId, publicKey: c.publicIdentity.publicKey })}`;
	await a.sync();
	assert.ok(a.errors.includes('BINDING_CHANGED'));
	assert.notEqual(a.peers.get(profile.id)?.snapshot().state, 'online');
	assert.deepEqual(await a.profiles.get(profile.id), profile);
	b.tunnel.description = original;
	await a.sync();
	assert.equal(a.peers.get(profile.id)?.snapshot().state, 'online');
});

test('revoked account devices remain blocked across rediscovery and enrollment-store restart', async (t) => {
	const directory = new AccountDirectory();
	const a = await accountDevice(directory, 917);
	const b = await accountDevice(directory, 918);
	t.after(async () => { await a.dispose(); await b.dispose(); });
	await Promise.all([a.sync(), b.sync()]);
	const incoming = (await a.records.listPeers())[0];
	for (const id of await a.enrollment.block(incoming.peerId)) { await a.pairing.revokePeer(id); }
	await a.enrollment.disconnectDevice(incoming.peerId);
	assert.equal(await a.secrets.get(incoming.rootKeyRef), undefined);
	const restored = a.createEnrollment();
	await restored.initialize();
	await restored.synchronize((await a.discovery.list(new AbortController().signal)).endpoints);
	await b.sync();
	assert.equal(await a.secrets.get(incoming.rootKeyRef), undefined);
	assert.equal(a.enrollment.permitsIncoming(incoming.peerId), false);
	assert.notEqual(a.peers.listConnections()[0]?.snapshot().state, 'online');
	await restored.suspend();
});

test('revocation wins against enrollment paused between endpoint preparation and connection', async (t) => {
	const directory = new AccountDirectory();
	const a = await accountDevice(directory, 921);
	const b = await accountDevice(directory, 922);
	t.after(async () => { await a.dispose(); await b.dispose(); });
	await Promise.all([a.sync(), b.sync()]);
	const profile = (await a.profiles.list())[0];
	await a.peers.disconnect(profile.id);
	let prepared!: () => void;
	let release!: () => void;
	const reached = new Promise<void>((resolve) => { prepared = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const prepare = a.transport.prepare.bind(a.transport);
	a.transport.prepare = async (...args) => { await prepare(...args); prepared(); await gate; };
	const syncing = a.sync();
	await reached;
	const incoming = (await a.records.listPeers())[0];
	for (const id of await a.enrollment.block(incoming.peerId)) { await a.pairing.revokePeer(id); }
	await a.enrollment.disconnectDevice(incoming.peerId);
	release();
	await syncing;
	assert.notEqual(a.peers.get(profile.id)?.snapshot().state, 'online');
	assert.equal(a.peers.isEnabled(profile.id), false);
	assert.equal(await a.secrets.get(incoming.rootKeyRef), undefined);
	await a.sync();
	assert.equal(a.peers.isEnabled(profile.id), false);
});

test('queued directory results cannot be enrolled into a different account after account selection changes', async (t) => {
	const directory = new AccountDirectory();
	const a = await accountDevice(directory, 923);
	const b = await accountDevice(directory, 924);
	t.after(async () => { await a.dispose(); await b.dispose(); });
	await Promise.all([a.sync(), b.sync()]);
	const profile = (await a.profiles.list())[0];
	await a.peers.disconnect(profile.id);
	let prepared!: () => void;
	let release!: () => void;
	const reached = new Promise<void>((resolve) => { prepared = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const prepare = a.transport.prepare.bind(a.transport);
	a.transport.prepare = async (...args) => { await prepare(...args); prepared(); await gate; };
	const first = a.sync();
	await reached;
	const previous = (await a.discovery.list(new AbortController().signal)).endpoints;
	const queued = assert.rejects(a.enrollment.synchronize(previous), { code: 'ACCOUNT_CHANGED' });
	const next = { ...a.account.current()!, accountRef: uuid(2023), accountId: 'different-account' };
	a.account.setBinding(next);
	await a.identity.load(next);
	release();
	await Promise.all([first, queued]);
	const stored = [...a.fs.files].find(([path]) => path.endsWith('/account-peers.json'))?.[1];
	assert.ok(stored);
	assert.ok(!stored.includes(next.accountRef));
	assert.notEqual(a.peers.get(profile.id)?.snapshot().state, 'online');
});

test('self, legacy, offline, and foreign-account hints cannot create an automatic peer', async (t) => {
	const directory = new AccountDirectory();
	const a = await accountDevice(directory, 919);
	const b = await accountDevice(directory, 920);
	t.after(async () => { await a.dispose(); await b.dispose(); });
	b.tunnel.status = { hostConnectionCount: 0 };
	await a.sync();
	assert.equal((await a.profiles.list()).length, 0);
	b.tunnel.status = { hostConnectionCount: 1 };
	b.tunnel.description = undefined;
	await a.sync();
	assert.equal((await a.profiles.list()).length, 0);
	b.publish('foreign-account');
	directory.hidden.add(b.tunnel.tunnelId!);
	await a.sync();
	assert.equal((await a.profiles.list()).length, 0);
	assert.equal((await a.records.listPeers()).length, 0);
});

class AccountDirectory {
	public readonly tunnels = new Map<string, Tunnel>();
	public readonly sockets = new Map<string, number>();
	public readonly hidden = new Set<string>();
	public readonly requests: URL[] = [];
	public readonly adapter: AxiosAdapter = async (config) => {
		const url = new URL(config.url!);
		this.requests.push(url);
		if (url.pathname === '/tunnels') {
			return sdkResponse(config, { value: [{ value: [...this.tunnels.values()].filter((tunnel) => !this.hidden.has(tunnel.tunnelId!)) }] });
		}
		const tunnel = this.tunnels.get(url.pathname.split('/')[2]);
		if (tunnel === undefined || this.hidden.has(tunnel.tunnelId!)) {
			throw new AxiosError('Not found', 'ERR_BAD_RESPONSE', config, undefined, sdkResponse(config, {}, 404));
		}
		if (url.pathname.includes('/ports/')) {
			return sdkResponse(config, { ...tunnel.ports![0], accessTokens: { connect: syntheticCapability() } });
		}
		return sdkResponse(config, tunnel);
	};
}

async function accountDevice(directory: AccountDirectory, index: number) {
	const base = connectivityFixture();
	const deviceId = uuid(index);
	base.account.setBinding({ ...base.account.current()!, accountRef: uuid(index + 100) });
	const secrets = new InMemorySecretStore();
	const identity = new AccountDeviceIdentityStore(base.files, base.fence, secrets, deviceId);
	await identity.initialize();
	const publicIdentity = await identity.load(base.account.current()!);
	const records = new InMemoryPairingRecordStore();
	const profiles = new InMemoryPeerProfileStore();
	const endpoints = new EndpointBindingStore(base.files, base.fence);
	await endpoints.initialize();
	const management = new DevTunnelManagement(base.account, base.fence, () => true, { adapter: directory.adapter });
	const discovery = new DevTunnelDiscoveryProvider(management);
	let enrollment!: AccountPeerEnrollment;
	const transport = new BoundPeerTransport(endpoints, new DevTunnelEndpointResolver(management), base.account, base.fence, () => true, {
		webSocketFactory: (origin) => {
			const port = directory.sockets.get(new URL(origin).origin.replace('wss:', 'https:'));
			assert.ok(port);
			return new WebSocket(`ws://127.0.0.1:${port}/agent-mesh/rpc`);
		},
		requestTimeoutMs: 1000, heartbeatIntervalMs: 1000,
	}, (profile) => enrollment.permitsOutgoing(profile.id));
	const peers = new PeerConnectionManager(deviceId, profiles, secrets, transport);
	let gateway!: GatewayServer;
	const revocations = new PeerRevocationService(base.files, base.fence, records, secrets,
		(peerId) => gateway.closePeer(peerId), async () => undefined, () => undefined);
	await revocations.initialize();
	const pairing = new PairingService(deviceId, secrets, records, {
		accessControl: {
			assertAllowed: (peerId) => {
				revocations.assertAllowed(peerId);
				assert.ok(enrollment.permitsIncoming(peerId), 'Account device must be registered before Mesh authentication');
			},
			revoke: (peerId) => revocations.revoke(peerId), retryCleanup: () => revocations.retryCleanup(),
		},
	});
	const errors: ConnectivityCode[] = [];
	const createEnrollment = () => new AccountPeerEnrollment(
		base.files, base.fence, deviceId, base.account, identity, pairing, records, profiles, secrets, endpoints, transport, peers, {
			enabled: () => true, isRevoked: (id) => revocations.snapshot().some((entry) => entry.peerId === id),
			report: (code) => errors.push(code),
		},
	);
	enrollment = createEnrollment();
	await enrollment.initialize();
	gateway = new GatewayServer(pairing, new GatewayRouter({
		getInfo: async () => ({
			deviceId, name: 'Account device', platform: 'darwin', architecture: 'arm64',
			vscodeVersion: '1.136.1', extensionVersion: '0.4.0', protocolVersion: 2,
		}),
	}, { list: async () => [] }, {
		start: async () => { throw new Error('Automatic trust must not run a task.'); },
		get: async () => null, cancel: async () => null, answer: async () => null,
	}));
	const address = await gateway.start();
	let tunnel: Tunnel;
	const publish = (suffix: string) => {
		if (tunnel !== undefined) { directory.tunnels.delete(tunnel.tunnelId!); }
		const tunnelId = `mesh-${index}-${suffix}`;
		const origin = `https://${tunnelId}-43121.use2.devtunnels.ms`;
		tunnel = {
			clusterId: 'use2', tunnelId, description: `${ACCOUNT_IDENTITY_PREFIX}${JSON.stringify(publicIdentity)}`,
			labels: [...DISCOVERY_LABELS, PRIVATE_LABEL, `${ADVERTISEMENT_PREFIX}${uuid(index + suffix.length + 200)}`],
			status: { hostConnectionCount: 1 },
			ports: [{ portNumber: 43121, protocol: 'http', portForwardingUris: [origin] }],
		};
		directory.tunnels.set(tunnelId, tunnel);
		directory.sockets.set(origin, address.port);
	};
	publish('initial');
	return {
		...base, deviceId, publicIdentity, records, profiles, secrets, identity, enrollment, peers, endpoints, pairing, errors,
		discovery, transport, createEnrollment, publish, get tunnel() { return tunnel; },
		sync: async () => enrollment.synchronize((await discovery.list(new AbortController().signal)).endpoints),
		dispose: async () => {
			await enrollment.suspend();
			await peers.dispose();
			await gateway.dispose();
			await pairing.dispose();
			await management.dispose();
			base.account.dispose();
		},
	};
}
