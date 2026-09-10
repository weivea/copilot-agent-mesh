import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemorySecretStore } from '../gateway/SecretStore';
import { PeerConnection } from '../peer/PeerConnection';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import type {
	PeerSession,
	PeerTransport,
} from '../peer/WebSocketPeerTransport';

test('PeerConnection makes concurrent connection attempts single-flight', async () => {
	const profiles = new InMemoryPeerProfileStore();
	await profiles.store({
		id: 'peer-profile',
		rpcEndpoint: 'wss://worker.example/agent-mesh/rpc',
		workerDeviceId: 'worker',
		peerId: 'peer',
		credentialKeyRef: 'credential',
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let connectCalls = 0;
	let closeCalls = 0;
	const session: PeerSession = {
		profile: (await profiles.get('peer-profile'))!,
		request: async () => undefined,
		onClose: () => () => undefined,
		close: async () => {
			closeCalls += 1;
		},
	};
	const transport: PeerTransport = {
		connect: async () => {
			connectCalls += 1;
			await gate;
			return session;
		},
	};
	const connection = new PeerConnection(
		'peer-profile',
		'coordinator',
		profiles,
		new InMemorySecretStore(),
		transport,
		() => undefined,
	);

	const first = connection.connect();
	const second = connection.connect();
	assert.strictEqual(first, second);
	assert.equal(connection.authenticatedBinding(), undefined);
	release();
	await Promise.all([first, second]);
	assert.equal(connectCalls, 1);
	assert.equal(typeof connection.authenticatedBinding()?.connectionGeneration, 'string');

	await connection.disconnect();
	assert.equal(closeCalls, 1);
	assert.equal(connection.authenticatedBinding(), undefined);
});

test('PeerConnection serializes reconnect behind an in-progress disconnect', async () => {
	const profiles = new InMemoryPeerProfileStore();
	await profiles.store({
		id: 'peer-profile',
		rpcEndpoint: 'wss://worker.example/agent-mesh/rpc',
		workerDeviceId: 'worker',
		peerId: 'peer',
		credentialKeyRef: 'credential',
	});
	let releaseClose!: () => void;
	const closeGate = new Promise<void>((resolve) => {
		releaseClose = resolve;
	});
	let connectCalls = 0;
	const transport: PeerTransport = {
		connect: async () => {
			connectCalls += 1;
			return {
				profile: (await profiles.get('peer-profile'))!,
				request: async () => undefined,
				onClose: () => () => undefined,
				close: async () => {
					if (connectCalls === 1) {
						await closeGate;
					}
				},
			};
		},
	};
	const connection = new PeerConnection(
		'peer-profile',
		'coordinator',
		profiles,
		new InMemorySecretStore(),
		transport,
		() => undefined,
	);
	await connection.connect();
	const firstAuthentication = connection.authenticatedBinding()!;

	const disconnect = connection.disconnect();
	const reconnect = connection.connect();
	assert.equal(connectCalls, 1);
	assert.equal(connection.authenticatedBinding(), undefined);
	await profiles.store({ ...(await profiles.get('peer-profile'))!, generation: 'replacement-profile-generation' });
	releaseClose();
	await Promise.all([disconnect, reconnect]);

	assert.equal(connectCalls, 2);
	assert.equal(connection.snapshot().state, 'online');
	assert.notEqual(connection.authenticatedBinding()?.connectionGeneration, firstAuthentication.connectionGeneration);
	assert.equal(connection.authenticatedBinding()?.profileGeneration, 'replacement-profile-generation');
	await connection.disconnect();
});
