import * as assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as net from 'node:net';
import { once } from 'node:events';
import { suite, test } from 'node:test';

import {
	LengthPrefixedJsonDecoder,
	LOCAL_IPC_MAX_FRAME_BYTES,
	LocalIpcClient,
	LocalIpcServer,
	type JsonValue,
	type LocalIpcIdentity,
	type LocalIpcSession,
} from '../ipc';

const key = Buffer.alloc(32, 0x5a);

suite('authenticated local IPC transport', () => {
	test('supports bidirectional requests and notifications over a real local endpoint', async () => {
		const identity = testIdentity();
		let serverNotification: JsonValue | undefined;
		let clientNotification: JsonValue | undefined;
		let resolveServerSession!: (session: LocalIpcSession) => void;
		const serverSessionPromise = new Promise<LocalIpcSession>((resolve) => {
			resolveServerSession = resolve;
		});
		const server = new LocalIpcServer({
			identity,
			brokerKey: key,
			handler: (method, params) => {
				if (method === 'server.echo') {
					return { params };
				}
				if (method === 'server.notice') {
					serverNotification = params;
					return null;
				}
				throw new Error('Unexpected method.');
			},
			onSession: resolveServerSession,
		});
		const client = new LocalIpcClient({
			identity,
			brokerKey: key.toString('base64url'),
			clientId: 'window-one',
			handler: (method, params) => {
				if (method === 'window.echo') {
					return { params };
				}
				if (method === 'window.notice') {
					clientNotification = params;
					return null;
				}
				throw new Error('Unexpected method.');
			},
		});
		try {
			await server.listen();
			const clientSession = await client.connect();
			const serverSession = await serverSessionPromise;
			assert.deepEqual(
				await clientSession.request('server.echo', { side: 'client' }),
				{ params: { side: 'client' } },
			);
			assert.deepEqual(
				await serverSession.request('window.echo', { side: 'server' }),
				{ params: { side: 'server' } },
			);
			await clientSession.notify('server.notice', { sequence: 1 });
			await serverSession.notify('window.notice', { sequence: 2 });
			await waitFor(() => serverNotification !== undefined && clientNotification !== undefined);
			assert.deepEqual(serverNotification, { sequence: 1 });
			assert.deepEqual(clientNotification, { sequence: 2 });
		} finally {
			client.dispose();
			await server.dispose();
		}
	});

	test('decodes fragmented and coalesced frames and rejects trailing data', () => {
		const first = encode({
			kind: 'hello',
			version: 2,
			clientId: 'first',
			clientNonce: randomBytes(32).toString('base64url'),
		});
		const second = encode({
			kind: 'hello',
			version: 2,
			clientId: 'second',
			clientNonce: randomBytes(32).toString('base64url'),
		});
		const decoder = new LengthPrefixedJsonDecoder();
		assert.deepEqual(decoder.push(first.subarray(0, 2)), []);
		assert.deepEqual(decoder.push(first.subarray(2, 9)), []);
		const decoded = decoder.push(Buffer.concat([first.subarray(9), second]));
		assert.equal(decoded.length, 2);
		assert.equal(decoded[0].kind, 'hello');
		assert.equal(decoded[1].kind, 'hello');
		decoder.finish();

		const trailing = new LengthPrefixedJsonDecoder();
		trailing.push(Buffer.from([0, 0]));
		assert.throws(() => trailing.finish(), /Truncated/u);
	});

	test('rejects a client that cannot verify or produce the correct HMAC', async () => {
		const identity = testIdentity();
		const server = new LocalIpcServer({
			identity,
			brokerKey: key,
			handshakeTimeoutMs: 500,
		});
		const attacker = new LocalIpcClient({
			identity,
			brokerKey: Buffer.alloc(32, 0x7f),
			clientId: 'malicious-window',
			handshakeTimeoutMs: 500,
		});
		try {
			await server.listen();
			await assert.rejects(attacker.connect(), /authentication|closed/iu);
			const malicious = await connectRaw(server.endpoint.address);
			const clientNonce = randomBytes(32).toString('base64url');
			malicious.write(encode({
				kind: 'hello',
				version: 2,
				clientId: 'forged-window',
				clientNonce,
			}));
			const challenge = await readOneFrame(malicious);
			assert.equal(challenge.kind, 'challenge');
			malicious.write(encode({
				kind: 'authenticate',
				version: 2,
				clientId: 'forged-window',
				clientNonce,
				serverNonce: challenge.serverNonce,
				clientProof: randomBytes(32).toString('base64url'),
			}));
			await once(malicious, 'close');
			assert.equal(server.sessions.length, 0);
		} finally {
			attacker.dispose();
			await server.dispose();
		}
	});

	test('rejects replay of an already claimed client nonce', async () => {
		const identity = testIdentity();
		const server = new LocalIpcServer({ identity, brokerKey: key });
		const nonce = randomBytes(32).toString('base64url');
		const hello = encode({
			kind: 'hello',
			version: 2,
			clientId: 'replayed-window',
			clientNonce: nonce,
		});
		try {
			await server.listen();
			const first = await connectRaw(server.endpoint.address);
			first.write(hello);
			const challenge = await readOneFrame(first);
			assert.equal(challenge.kind, 'challenge');
			first.destroy();
			await once(first, 'close');

			const replay = await connectRaw(server.endpoint.address);
			replay.write(hello);
			await once(replay, 'close');
			assert.equal(server.sessions.length, 0);
		} finally {
			await server.dispose();
		}
	});

	test('replaces a duplicate registered client session', async () => {
		const identity = testIdentity();
		const server = new LocalIpcServer({ identity, brokerKey: key });
		const firstClient = new LocalIpcClient({
			identity,
			brokerKey: key,
			clientId: 'same-window',
		});
		const secondClient = new LocalIpcClient({
			identity,
			brokerKey: key,
			clientId: 'same-window',
		});
		try {
			await server.listen();
			const first = await firstClient.connect();
			const closed = new Promise<void>((resolve) => first.onClose(() => resolve()));
			const second = await secondClient.connect();
			await closed;
			assert.equal(first.closed, true);
			assert.equal(second.closed, false);
			assert.equal(server.sessions.length, 1);
			assert.equal(server.sessions[0].clientId, 'same-window');
		} finally {
			firstClient.dispose();
			secondClient.dispose();
			await server.dispose();
		}
	});

	test('enforces the authentication deadline', async () => {
		const identity = testIdentity();
		const server = new LocalIpcServer({
			identity,
			brokerKey: key,
			handshakeTimeoutMs: 30,
		});
		try {
			await server.listen();
			const idle = await connectRaw(server.endpoint.address);
			await once(idle, 'close');
			assert.equal(server.sessions.length, 0);
		} finally {
			await server.dispose();
		}
	});

	test('rejects oversized and invalid frame lengths', async () => {
		const identity = testIdentity();
		const server = new LocalIpcServer({ identity, brokerKey: key });
		try {
			await server.listen();
			const oversized = await connectRaw(server.endpoint.address);
			const header = Buffer.alloc(4);
			header.writeUInt32BE(LOCAL_IPC_MAX_FRAME_BYTES + 1);
			oversized.write(header);
			await once(oversized, 'close');

			const zero = await connectRaw(server.endpoint.address);
			zero.write(Buffer.alloc(4));
			await once(zero, 'close');
			assert.equal(server.sessions.length, 0);
		} finally {
			await server.dispose();
		}
	});

	test('request timeout closes both authenticated sides and tolerates a late response', async () => {
		const identity = testIdentity();
		let resolveHandler!: (value: JsonValue) => void;
		const handlerResult = new Promise<JsonValue>((resolve) => {
			resolveHandler = resolve;
		});
		const server = new LocalIpcServer({
			identity,
			brokerKey: key,
			handler: (method) => method === 'slow' ? handlerResult : null,
		});
		const client = new LocalIpcClient({
			identity,
			brokerKey: key,
			clientId: 'timed-out-window',
			requestTimeoutMs: 25,
		});
		try {
			await server.listen();
			const clientSession = await client.connect();
			await waitFor(() => server.sessions.length === 1);
			const serverSession = server.sessions[0];
			const clientClosed = new Promise<void>((resolve) =>
				clientSession.onClose(() => resolve()),
			);
			const serverClosed = new Promise<void>((resolve) =>
				serverSession.onClose(() => resolve()),
			);
			await assert.rejects(
				clientSession.request('slow', null),
				/Local IPC request timed out/u,
			);
			await Promise.all([clientClosed, serverClosed]);
			assert.equal(clientSession.closed, true);
			assert.equal(serverSession.closed, true);
			await waitFor(() => server.sessions.length === 0);
			resolveHandler(null);
			await new Promise((resolve) => setTimeout(resolve, 10));
		} finally {
			client.dispose();
			await server.dispose();
		}
	});

	test('cleans up disconnected sessions and pending requests', async () => {
		const identity = testIdentity();
		const server = new LocalIpcServer({
			identity,
			brokerKey: key,
			handler: async (method) => {
				if (method === 'never') {
					await new Promise<void>(() => undefined);
				}
				return null;
			},
		});
		const client = new LocalIpcClient({
			identity,
			brokerKey: key,
			clientId: 'disconnecting-window',
		});
		try {
			await server.listen();
			const session = await client.connect();
			const pending = session.request('never', null);
			await waitFor(() => server.sessions.length === 1);
			server.sessions[0].close();
			await assert.rejects(pending, /closed/iu);
			await waitFor(() => server.sessions.length === 0);
		} finally {
			client.dispose();
			await server.dispose();
		}
	});

	test('server shutdown closes sessions and disposal is idempotent', async () => {
		const identity = testIdentity();
		const server = new LocalIpcServer({ identity, brokerKey: key });
		const client = new LocalIpcClient({
			identity,
			brokerKey: key,
			clientId: 'shutdown-window',
		});
		await server.listen();
		const session = await client.connect();
		const closed = new Promise<void>((resolve) => session.onClose(() => resolve()));
		const firstDisposal = server.dispose();
		const secondDisposal = server.dispose();
		assert.equal(firstDisposal, secondDisposal);
		await firstDisposal;
		await closed;
		assert.equal(session.closed, true);
		client.dispose();
		client.dispose();
		await server.dispose();
	});

	test('uses restrictive Unix directory and socket permissions', {
		skip: process.platform === 'win32',
	}, async () => {
		const server = new LocalIpcServer({
			identity: testIdentity(),
			brokerKey: key,
		});
		try {
			await server.listen();
			assert.ok(server.endpoint.parentDirectory);
			const directoryStat = await stat(server.endpoint.parentDirectory);
			const socketStat = await stat(server.endpoint.address);
			assert.equal(directoryStat.mode & 0o777, 0o700);
			assert.equal(socketStat.mode & 0o777, 0o600);
			assert.ok(server.endpoint.address.length < 80);
		} finally {
			await server.dispose();
		}
	});
});

function testIdentity(): LocalIpcIdentity {
	return {
		userIdentity: `test-user-${randomUUID()}`,
		deviceId: randomUUID(),
	};
}

function encode(value: unknown): Buffer {
	const payload = Buffer.from(JSON.stringify(value), 'utf8');
	const result = Buffer.alloc(4 + payload.byteLength);
	result.writeUInt32BE(payload.byteLength, 0);
	payload.copy(result, 4);
	return result;
}

async function connectRaw(address: string): Promise<net.Socket> {
	const socket = net.createConnection(address);
	await once(socket, 'connect');
	return socket;
}

async function readOneFrame(socket: net.Socket): Promise<Record<string, unknown>> {
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		let buffered = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			buffered = Buffer.concat([buffered, chunk]);
			if (buffered.byteLength >= 4) {
				const length = buffered.readUInt32BE(0);
				if (buffered.byteLength >= 4 + length) {
					cleanup();
					resolve(JSON.parse(
						buffered.subarray(4, 4 + length).toString('utf8'),
					) as Record<string, unknown>);
				}
			}
		};
		const onClose = (): void => {
			cleanup();
			reject(new Error('Socket closed before a frame was received.'));
		};
		const cleanup = (): void => {
			socket.off('data', onData);
			socket.off('close', onClose);
		};
		socket.on('data', onData);
		socket.once('close', onClose);
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for local IPC state.');
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
