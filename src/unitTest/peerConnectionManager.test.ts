import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeBase64Url } from '../gateway/PairingCrypto';
import {
	InMemorySecretStore,
	type SecretStore,
} from '../gateway/SecretStore';
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import {
	InMemoryPeerProfileStore,
	type PeerProfile,
	type PeerProfileStore,
} from '../peer/PeerProfile';
import {
	PeerTransportError,
	type PeerTransport,
} from '../peer/WebSocketPeerTransport';

const connectionUrl = 'https://worker.example/agent-mesh/connect'
	+ '?v=1&device=worker&invite=invitation'
	+ `#secret=${encodeBase64Url(Buffer.alloc(32, 1))}`;

test('PeerConnectionManager dispose rolls back an add blocked in secret storage', async () => {
	const storedSecrets = new InMemorySecretStore();
	let releaseStore!: () => void;
	let markStoreStarted!: () => void;
	const storeStarted = new Promise<void>((resolve) => {
		markStoreStarted = resolve;
	});
	const storeGate = new Promise<void>((resolve) => {
		releaseStore = resolve;
	});
	const secrets: SecretStore = {
		get: (key) => storedSecrets.get(key),
		delete: (key) => storedSecrets.delete(key),
		store: async (key, value) => {
			await storedSecrets.store(key, value);
			markStoreStarted();
			await storeGate;
		},
	};
	const profiles = new InMemoryPeerProfileStore();
	let connectCalls = 0;
	const transport: PeerTransport = {
		connect: async () => {
			connectCalls += 1;
			throw new Error('Transport must not start after disposal.');
		},
	};
	const manager = new PeerConnectionManager(
		'coordinator',
		profiles,
		secrets,
		transport,
		{ id: () => 'added-profile' },
	);

	const add = manager.add(connectionUrl);
	await storeStarted;
	const dispose = manager.dispose();
	releaseStore();
	await assert.rejects(add, /disposed/u);
	await dispose;

	assert.equal(connectCalls, 0);
	assert.deepStrictEqual(await profiles.list(), []);
	assert.equal(await storedSecrets.get('mesh.remoteInvitation.added-profile'), undefined);
	assert.equal(manager.get('added-profile'), undefined);
});

test('PeerConnectionManager dispose aborts and waits for an in-flight connect', async () => {
	const secrets = new InMemorySecretStore();
	await secrets.store('credential', encodeBase64Url(Buffer.alloc(32, 2)));
	const profiles = new InMemoryPeerProfileStore();
	await profiles.store({
		id: 'saved-profile',
		rpcEndpoint: 'wss://worker.example/agent-mesh/rpc',
		workerDeviceId: 'worker',
		peerId: 'peer',
		credentialKeyRef: 'credential',
	});
	let markConnectStarted!: () => void;
	const connectStarted = new Promise<void>((resolve) => {
		markConnectStarted = resolve;
	});
	let aborted = 0;
	const transport: PeerTransport = {
		connect: async (_profile, _device, _secrets, _profiles, signal) => {
			markConnectStarted();
			return new Promise((_, reject) => {
				signal.addEventListener('abort', () => {
					aborted += 1;
					reject(new PeerTransportError('CONNECTION_FAILED', 'Connection aborted.'));
				}, { once: true });
			});
		},
	};
	const manager = new PeerConnectionManager(
		'coordinator',
		profiles,
		secrets,
		transport,
	);

	const connect = manager.connect('saved-profile');
	await connectStarted;
	const dispose = manager.dispose();
	await assert.rejects(connect, /disposed/u);
	await dispose;

	assert.equal(aborted, 1);
	assert.equal(manager.get('saved-profile'), undefined);
	assert.ok(await profiles.get('saved-profile'));
	assert.ok(await secrets.get('credential'));
});

test('PeerConnectionManager cleans the invitation secret when profile persistence fails', async () => {
	const secrets = new InMemorySecretStore();
	const profiles: PeerProfileStore = {
		get: async () => {
			throw new Error('Profile read failed.');
		},
		list: async () => [],
		store: async () => {
			throw new Error('Profile persistence failed.');
		},
		delete: async () => undefined,
	};
	const transport: PeerTransport = {
		connect: async () => {
			throw new Error('Transport must not start.');
		},
	};
	const manager = new PeerConnectionManager(
		'coordinator',
		profiles,
		secrets,
		transport,
		{ id: () => 'failed-profile' },
	);

	await assert.rejects(manager.add(connectionUrl), /roll back/u);

	assert.equal(await secrets.get('mesh.remoteInvitation.failed-profile'), undefined);
	await manager.dispose();
});

test('PeerConnectionManager creates one managed connection for concurrent connects', async () => {
	const profile: PeerProfile = {
		id: 'saved-profile',
		rpcEndpoint: 'wss://worker.example/agent-mesh/rpc',
		workerDeviceId: 'worker',
		peerId: 'peer',
		credentialKeyRef: 'credential',
	};
	let releaseGet!: () => void;
	const getGate = new Promise<void>((resolve) => {
		releaseGet = resolve;
	});
	let getCalls = 0;
	const profiles: PeerProfileStore = {
		get: async () => {
			getCalls += 1;
			await getGate;
			return profile;
		},
		list: async () => [profile],
		store: async () => undefined,
		delete: async () => undefined,
	};
	let connectCalls = 0;
	let closeCalls = 0;
	const transport: PeerTransport = {
		connect: async () => {
			connectCalls += 1;
			return {
				profile,
				request: async () => undefined,
				onClose: () => () => undefined,
				close: async () => {
					closeCalls += 1;
				},
			};
		},
	};
	const manager = new PeerConnectionManager(
		'coordinator',
		profiles,
		new InMemorySecretStore(),
		transport,
	);

	const first = manager.connect(profile.id);
	const second = manager.connect(profile.id);
	assert.equal(getCalls, 2);
	releaseGet();
	await Promise.all([first, second]);

	assert.equal(connectCalls, 1);
	await manager.dispose();
	assert.equal(closeCalls, 1);
});
