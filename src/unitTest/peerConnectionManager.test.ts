import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocketServer } from 'ws';

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
	WebSocketPeerTransport,
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

for (const reason of ['AUTH_FAILED', 'PROTOCOL_INCOMPATIBLE'] as const) {
	test(`PeerConnectionManager rolls back a new add after terminal ${reason}`, async () => {
		const secrets = new InMemorySecretStore();
		const profiles = new InMemoryPeerProfileStore();
		const transport: PeerTransport = {
			connect: async () => {
				throw new PeerTransportError(reason, 'Terminal peer failure.');
			},
		};
		const manager = new PeerConnectionManager(
			'coordinator',
			profiles,
			secrets,
			transport,
			{ id: () => 'terminal-profile' },
		);

		await assert.rejects(manager.add(connectionUrl));

		assert.deepStrictEqual(await profiles.list(), []);
		assert.equal(await secrets.get('mesh.remoteInvitation.terminal-profile'), undefined);
		assert.equal(await secrets.get('mesh.remotePeer.terminal-profile'), undefined);
		assert.equal(await secrets.get('mesh.remoteCommit.terminal-profile'), undefined);
		assert.equal(manager.get('terminal-profile'), undefined);
		await manager.dispose();
	});
}

test('PeerConnectionManager dispose aborts a real handshake before the request deadline', async () => {
	const server = new WebSocketServer({
		host: '127.0.0.1',
		port: 0,
		perMessageDeflate: false,
	});
	await once(server, 'listening');
	const address = server.address();
	assert.ok(typeof address === 'object' && address !== null);
	const connected = once(server, 'connection');
	const secrets = new InMemorySecretStore();
	await secrets.store('credential', encodeBase64Url(Buffer.alloc(32, 4)));
	const profiles = new InMemoryPeerProfileStore();
	await profiles.store({
		id: 'real-profile',
		rpcEndpoint: `ws://127.0.0.1:${address.port}`,
		workerDeviceId: 'worker',
		peerId: 'peer',
		credentialKeyRef: 'credential',
	});
	const manager = new PeerConnectionManager(
		'coordinator',
		profiles,
		secrets,
		new WebSocketPeerTransport({ requestTimeoutMs: 5_000 }),
	);

	try {
		const connect = manager.connect('real-profile');
		await connected;
		const startedAt = Date.now();
		const dispose = manager.dispose();
		await assert.rejects(connect, /disposed/u);
		await dispose;
		assert.ok(Date.now() - startedAt < 500, 'dispose should not wait for the RPC deadline');
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(server.clients.size, 0);
	} finally {
		await manager.dispose();
		for (const client of server.clients) {
			client.terminate();
		}
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error === undefined ? resolve() : reject(error));
		});
	}
});

test('PeerConnectionManager rolls back a provisional peer after a retry becomes terminal', async () => {
	const secrets = new InMemorySecretStore();
	const profiles = new InMemoryPeerProfileStore();
	let attempts = 0;
	let markTerminalAttempt!: () => void;
	const terminalAttempt = new Promise<void>((resolve) => {
		markTerminalAttempt = resolve;
	});
	const transport: PeerTransport = {
		connect: async (profile, _device, secretStore, profileStore) => {
			attempts += 1;
			if (attempts === 1) {
				const candidate: PeerProfile = {
					...profile,
					peerId: 'pending-peer',
					credentialKeyRef: 'mesh.remotePeer.retry-profile',
					pendingEnrollmentId: 'pending-enrollment',
					pendingTranscriptHash: encodeBase64Url(Buffer.alloc(32, 3)),
					pendingCommitProofKeyRef: 'mesh.remoteCommit.retry-profile',
					pendingExpiresAt: Date.now() + 60_000,
				};
				await secretStore.store(
					'mesh.remotePeer.retry-profile',
					encodeBase64Url(Buffer.alloc(32, 4)),
				);
				await secretStore.store(
					'mesh.remoteCommit.retry-profile',
					encodeBase64Url(Buffer.alloc(32, 5)),
				);
				await profileStore.store(candidate);
				throw new PeerTransportError('CONNECTION_FAILED', 'Commit acknowledgement is unknown.');
			}
			markTerminalAttempt();
			throw new PeerTransportError('AUTH_FAILED', 'Commit was rejected.');
		},
	};
	const manager = new PeerConnectionManager(
		'coordinator',
		profiles,
		secrets,
		transport,
		{
			id: () => 'retry-profile',
			random: () => 0,
			reconnectBaseMs: 1,
			reconnectMaxMs: 1,
		},
	);

	await assert.rejects(manager.add(connectionUrl));
	await terminalAttempt;
	await waitFor(() => manager.get('retry-profile') === undefined);

	assert.deepStrictEqual(await profiles.list(), []);
	assert.equal(await secrets.get('mesh.remoteInvitation.retry-profile'), undefined);
	assert.equal(await secrets.get('mesh.remotePeer.retry-profile'), undefined);
	assert.equal(await secrets.get('mesh.remoteCommit.retry-profile'), undefined);
	await manager.dispose();
});

test('PeerConnectionManager retains profile references when secret rollback fails', async () => {
	const storedSecrets = new InMemorySecretStore();
	const secrets: SecretStore = {
		get: (key) => storedSecrets.get(key),
		store: (key, value) => storedSecrets.store(key, value),
		delete: async (key) => {
			if (key === 'mesh.remotePeer.rollback-profile') {
				throw new Error('Credential deletion failed.');
			}
			await storedSecrets.delete(key);
		},
	};
	const profiles = new InMemoryPeerProfileStore();
	const transport: PeerTransport = {
		connect: async (profile, _device, secretStore, profileStore) => {
			const candidate: PeerProfile = {
				...profile,
				peerId: 'rollback-peer',
				credentialKeyRef: 'mesh.remotePeer.rollback-profile',
				pendingEnrollmentId: 'rollback-enrollment',
				pendingTranscriptHash: encodeBase64Url(Buffer.alloc(32, 6)),
				pendingCommitProofKeyRef: 'mesh.remoteCommit.rollback-profile',
				pendingExpiresAt: Date.now() + 60_000,
			};
			await secretStore.store(
				'mesh.remotePeer.rollback-profile',
				encodeBase64Url(Buffer.alloc(32, 7)),
			);
			await secretStore.store(
				'mesh.remoteCommit.rollback-profile',
				encodeBase64Url(Buffer.alloc(32, 8)),
			);
			await profileStore.store(candidate);
			throw new PeerTransportError('AUTH_FAILED', 'Terminal peer failure.');
		},
	};
	const manager = new PeerConnectionManager(
		'coordinator',
		profiles,
		secrets,
		transport,
		{ id: () => 'rollback-profile' },
	);

	await assert.rejects(manager.add(connectionUrl), /roll back/u);

	const retained = await profiles.get('rollback-profile');
	assert.equal(retained?.credentialKeyRef, 'mesh.remotePeer.rollback-profile');
	assert.ok(await storedSecrets.get('mesh.remotePeer.rollback-profile'));
	assert.equal(manager.get('rollback-profile'), undefined);
	await manager.dispose();
});

test('PeerConnectionManager reports and awaits a background rollback failure on dispose', async () => {
	const storedSecrets = new InMemorySecretStore();
	await storedSecrets.store('background-invitation', encodeBase64Url(Buffer.alloc(32, 9)));
	await storedSecrets.store('background-credential', encodeBase64Url(Buffer.alloc(32, 10)));
	await storedSecrets.store('background-proof', encodeBase64Url(Buffer.alloc(32, 11)));
	const secrets: SecretStore = {
		get: (key) => storedSecrets.get(key),
		store: (key, value) => storedSecrets.store(key, value),
		delete: async (key) => {
			if (key === 'background-credential') {
				throw new Error('Background credential deletion failed.');
			}
			await storedSecrets.delete(key);
		},
	};
	const profiles = new InMemoryPeerProfileStore();
	await profiles.store({
		id: 'background-profile',
		rpcEndpoint: 'wss://worker.example/agent-mesh/rpc',
		workerDeviceId: 'worker',
		invitationId: 'background-enrollment',
		pairingSecretKeyRef: 'background-invitation',
		peerId: 'background-peer',
		credentialKeyRef: 'background-credential',
		pendingEnrollmentId: 'background-enrollment',
		pendingTranscriptHash: encodeBase64Url(Buffer.alloc(32, 12)),
		pendingCommitProofKeyRef: 'background-proof',
		pendingExpiresAt: Date.now() + 60_000,
	});
	let markAttempted!: () => void;
	const attempted = new Promise<void>((resolve) => {
		markAttempted = resolve;
	});
	const transport: PeerTransport = {
		connect: async () => {
			markAttempted();
			throw new PeerTransportError('AUTH_FAILED', 'Terminal retry failure.');
		},
	};
	const manager = new PeerConnectionManager(
		'coordinator',
		profiles,
		secrets,
		transport,
	);

	await manager.restore();
	await attempted;
	await waitFor(() => manager.get('background-profile') === undefined);
	await assert.rejects(
		manager.dispose(),
		(error: unknown) => (
			error instanceof AggregateError
			&& error.message === 'One or more peer reconnect operations failed.'
		),
	);
	assert.ok(await profiles.get('background-profile'));
	assert.ok(await storedSecrets.get('background-credential'));
});

test('PeerConnectionManager dispose waits for restore list and prevents late peer publication', async () => {
	const profile: PeerProfile = {
		id: 'late-restore-profile',
		rpcEndpoint: 'wss://worker.example/agent-mesh/rpc',
		workerDeviceId: 'worker',
		peerId: 'peer',
		credentialKeyRef: 'credential',
	};
	let releaseList!: () => void;
	let markListStarted!: () => void;
	const listStarted = new Promise<void>((resolve) => {
		markListStarted = resolve;
	});
	const listGate = new Promise<void>((resolve) => {
		releaseList = resolve;
	});
	const profiles: PeerProfileStore = {
		get: async () => profile,
		list: async () => {
			markListStarted();
			await listGate;
			return [profile];
		},
		store: async () => undefined,
		delete: async () => undefined,
	};
	let connectCalls = 0;
	const transport: PeerTransport = {
		connect: async () => {
			connectCalls += 1;
			throw new Error('Restore must not connect after disposal.');
		},
	};
	const manager = new PeerConnectionManager(
		'coordinator',
		profiles,
		new InMemorySecretStore(),
		transport,
	);

	const restore = manager.restore();
	await listStarted;
	const dispose = manager.dispose();
	let disposed = false;
	void dispose.then(() => {
		disposed = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(disposed, false);
	releaseList();

	await assert.rejects(restore, /disposed/u);
	await dispose;
	assert.equal(connectCalls, 0);
	assert.equal(manager.get(profile.id), undefined);
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for condition.');
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
