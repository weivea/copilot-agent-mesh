import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocketServer } from 'ws';

import {
	encodeBase64Url,
	randomBase64Url,
	reconnectProof,
	type ReconnectTranscript,
} from '../gateway/PairingCrypto';
import { InMemorySecretStore } from '../gateway/SecretStore';
import {
	InMemoryPeerProfileStore,
	type PeerProfileStore,
} from '../peer/PeerProfile';
import {
	PeerTransportError,
	WebSocketPeerTransport,
} from '../peer/WebSocketPeerTransport';

test('WebSocketPeerTransport rejects a malformed JSON-RPC error response', async () => {
	const server = new WebSocketServer({
		host: '127.0.0.1',
		port: 0,
		perMessageDeflate: false,
	});

	await once(server, 'listening');
	const address = server.address();
	assert.ok(typeof address === 'object' && address !== null);
	server.on('connection', (socket) => {
		socket.once('message', (data) => {
			const request = JSON.parse(data.toString()) as { id: string };
			socket.send(JSON.stringify({
				jsonrpc: '2.0',
				id: request.id,
				error: null,
			}));
		});
	});
	const secrets = new InMemorySecretStore();
	await secrets.store('pairing-key', 'A'.repeat(43));
	const profiles = new InMemoryPeerProfileStore();
	const profile = {
		id: 'profile',
		rpcEndpoint: `ws://127.0.0.1:${address.port}`,
		workerDeviceId: 'worker',
		invitationId: 'invitation',
		pairingSecretKeyRef: 'pairing-key',
	};
	await profiles.store(profile);
	const transport = new WebSocketPeerTransport({ requestTimeoutMs: 200 });

	try {
		await assert.rejects(
			transport.connect(
				profile,
				'coordinator',
				secrets,
				profiles,
				new AbortController().signal,
			),
			(error: unknown) => error instanceof PeerTransportError,
		);
	} finally {
		for (const client of server.clients) {
			client.terminate();
		}
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error === undefined ? resolve() : reject(error));
		});
	}
});

test('WebSocketPeerTransport closes on a malformed heartbeat result', async () => {
	const rootKey = Buffer.alloc(32, 7);
	const serverNonce = randomBase64Url(32);
	const sessionId = 'session';
	const server = new WebSocketServer({
		host: '127.0.0.1',
		port: 0,
		perMessageDeflate: false,
	});
	await once(server, 'listening');
	const address = server.address();
	assert.ok(typeof address === 'object' && address !== null);
	server.on('connection', (socket) => {
		socket.on('message', (data) => {
			const request = JSON.parse(data.toString()) as {
				id: string;
				method: string;
				params: Record<string, unknown>;
			};
			if (request.method === 'mesh.hello') {
				const transcript: ReconnectTranscript = {
					version: 2,
					peerId: 'peer',
					workerDeviceId: 'worker',
					coordinatorDeviceId: 'coordinator',
					sessionId,
					clientNonce: String(request.params.clientNonce),
					serverNonce,
				};
				socket.send(JSON.stringify({
					jsonrpc: '2.0',
					id: request.id,
					result: {
						mode: 'reconnect',
						version: 2,
						workerDeviceId: 'worker',
						sessionId,
						serverNonce,
						serverProof: encodeBase64Url(reconnectProof(
							rootKey,
							'mesh/reconnect-server-proof/v1',
							transcript,
						)),
					},
				}));
				return;
			}
			if (request.method === 'mesh.authenticate') {
				socket.send(JSON.stringify({
					jsonrpc: '2.0',
					id: request.id,
					result: { authenticated: true, peerId: 'peer' },
				}));
				return;
			}
			socket.send(JSON.stringify({
				jsonrpc: '2.0',
				id: request.id,
				result: null,
			}));
		});
	});
	const secrets = new InMemorySecretStore();
	await secrets.store('credential', encodeBase64Url(rootKey));
	const profiles = new InMemoryPeerProfileStore();
	const profile = {
		id: 'profile',
		rpcEndpoint: `ws://127.0.0.1:${address.port}`,
		workerDeviceId: 'worker',
		peerId: 'peer',
		credentialKeyRef: 'credential',
	};
	await profiles.store(profile);
	const transport = new WebSocketPeerTransport({
		requestTimeoutMs: 200,
		heartbeatIntervalMs: 5,
	});
	const session = await transport.connect(
		profile,
		'coordinator',
		secrets,
		profiles,
		new AbortController().signal,
	);

	try {
		await Promise.race([
			new Promise<void>((resolve) => session.onClose(resolve)),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('Heartbeat did not close the peer.')), 500);
			}),
		]);
	} finally {
		await session.close();
		for (const client of server.clients) {
			client.terminate();
		}
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error === undefined ? resolve() : reject(error));
		});
	}
});

test('WebSocketPeerTransport rejects a socket closed while persisting an authenticated profile', async () => {
	const rootKey = Buffer.alloc(32, 9);
	const serverNonce = randomBase64Url(32);
	let pingRequests = 0;
	const server = new WebSocketServer({
		host: '127.0.0.1',
		port: 0,
		perMessageDeflate: false,
	});
	await once(server, 'listening');
	const address = server.address();
	assert.ok(typeof address === 'object' && address !== null);
	server.on('connection', (socket) => {
		socket.on('message', (data) => {
			const request = JSON.parse(data.toString()) as {
				id: string;
				method: string;
				params: Record<string, unknown>;
			};
			if (request.method === 'mesh.hello') {
				const transcript: ReconnectTranscript = {
					version: 2,
					peerId: 'peer',
					workerDeviceId: 'worker',
					coordinatorDeviceId: 'coordinator',
					sessionId: 'session',
					clientNonce: String(request.params.clientNonce),
					serverNonce,
				};
				socket.send(JSON.stringify({
					jsonrpc: '2.0',
					id: request.id,
					result: {
						mode: 'reconnect',
						version: 2,
						workerDeviceId: 'worker',
						sessionId: 'session',
						serverNonce,
						serverProof: encodeBase64Url(reconnectProof(
							rootKey,
							'mesh/reconnect-server-proof/v1',
							transcript,
						)),
					},
				}));
				return;
			}
			if (request.method === 'mesh.authenticate') {
				socket.send(JSON.stringify({
					jsonrpc: '2.0',
					id: request.id,
					result: { authenticated: true, peerId: 'peer' },
				}), () => socket.close());
				return;
			}
			if (request.method === 'mesh.ping') {
				pingRequests += 1;
			}
		});
	});
	const secrets = new InMemorySecretStore();
	await secrets.store('credential', encodeBase64Url(rootKey));
	await secrets.store('pairing', encodeBase64Url(Buffer.alloc(32, 3)));
	const storedProfiles = new InMemoryPeerProfileStore();
	const profile = {
		id: 'profile',
		rpcEndpoint: `ws://127.0.0.1:${address.port}`,
		workerDeviceId: 'worker',
		invitationId: 'invitation',
		pairingSecretKeyRef: 'pairing',
		peerId: 'peer',
		credentialKeyRef: 'credential',
	};
	await storedProfiles.store(profile);
	const profiles: PeerProfileStore = {
		get: (id) => storedProfiles.get(id),
		list: () => storedProfiles.list(),
		delete: (id) => storedProfiles.delete(id),
		store: async (value) => {
			if (value.invitationId === undefined) {
				await new Promise((resolve) => setTimeout(resolve, 30));
			}
			await storedProfiles.store(value);
		},
	};
	const transport = new WebSocketPeerTransport({
		requestTimeoutMs: 200,
		heartbeatIntervalMs: 5,
	});

	try {
		await assert.rejects(
			transport.connect(
				profile,
				'coordinator',
				secrets,
				profiles,
				new AbortController().signal,
			),
			(error: unknown) => error instanceof PeerTransportError
				&& error.reason === 'CONNECTION_FAILED',
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(pingRequests, 0);
	} finally {
		for (const client of server.clients) {
			client.terminate();
		}
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error === undefined ? resolve() : reject(error));
		});
	}
});
