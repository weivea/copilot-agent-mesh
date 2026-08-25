import * as assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { suite, test } from 'node:test';

import WebSocket, { type RawData } from 'ws';

import { GatewayRouter, type TaskStartParams } from '../gateway/GatewayRouter';
import { GatewayServer } from '../gateway/GatewayServer';
import {
	decodeFixedBase64Url,
	derivePeerRoot,
	encodeBase64Url,
	enrollmentProof,
	enrollmentTranscriptHash,
	hmac,
	NONCE_BYTES,
	randomBase64Url,
	reconnectProof,
	type EnrollmentTranscript,
	type ReconnectTranscript,
} from '../gateway/PairingCrypto';
import {
	InMemoryPairingRecordStore,
	PairingService,
	type CreatedInvitation,
} from '../gateway/PairingService';
import { InMemorySecretStore } from '../gateway/SecretStore';
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import { WebSocketPeerTransport } from '../peer/WebSocketPeerTransport';

suite('Gateway pairing component', { concurrency: 1 }, () => {
	test('serves an exact private health check and rejects other HTTP routes', async () => {
		const fixture = await createFixture();
		try {
			const health = await get(fixture.port, '/healthz');
			assert.equal(health.status, 204);
			assert.equal(health.body.byteLength, 0);
			const rejected = await get(fixture.port, '/anything');
			assert.equal(rejected.status, 404);
			assert.equal(rejected.body.byteLength, 0);
			assert.deepStrictEqual(fixture.address, { host: '127.0.0.1', port: fixture.port });
		} finally {
			await fixture.dispose();
		}
	});

	test('releases unauthenticated capacity after malformed upgrades', async () => {
		const fixture = await createFixture();
		try {
			for (let index = 0; index < 6; index += 1) {
				await malformedUpgrade(fixture.port);
			}
			const client = await RawClient.open(fixture.endpoint);
			await client.close();
		} finally {
			await fixture.dispose();
		}
	});

	test('pairs successfully, routes with peer ownership, and removes invitation secret', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const manager = fixture.manager();
		try {
			const connection = await manager.add(invitation.url);
			assert.equal(connection.snapshot().state, 'online');
			const result = await connection.request('device.getInfo', {});
			assert.deepStrictEqual(result, { deviceId: 'worker-device' });
			assert.equal(fixture.devicePeers.length, 1);
			assert.deepStrictEqual(
				await connection.request('task.get', { taskId: 'task-1', afterEventSeq: 2 }),
				{ peerId: fixture.devicePeers[0], taskId: 'task-1' },
			);
			await assert.rejects(connection.request('task.cancel', {
				taskId: 'task-1',
				peerId: 'attacker-controlled',
			}));
			const profile = await connection.profile();
			assert.ok(profile?.peerId);
			assert.ok(profile?.credentialKeyRef);
			assert.equal(profile?.pairingSecretKeyRef, undefined);
			assert.equal(profile?.invitationId, undefined);
			assert.equal(await fixture.records.getInvitation(invitation.invitationId), undefined);
			assert.doesNotMatch(JSON.stringify(profile), /secret=/u);
		} finally {
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('rejects a valid-length wrong pairing secret without exposing it', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const url = new URL(invitation.url);
		const wrongSecret = randomBase64Url(32);
		url.hash = new URLSearchParams({ secret: wrongSecret }).toString();
		const manager = fixture.manager();
		try {
			await assert.rejects(
				manager.add(url.toString()),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.doesNotMatch(error.message, new RegExp(wrongSecret, 'u'));
					return true;
				},
			);
		} finally {
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('rejects nonce replay across sockets', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const nonce = randomBase64Url(NONCE_BYTES);
		const first = await RawClient.open(fixture.endpoint);
		const second = await RawClient.open(fixture.endpoint);
		try {
			const params = {
				protocolMin: 1,
				protocolMax: 1,
				coordinatorDeviceId: 'coordinator-device',
				clientNonce: nonce,
				invitationId: invitation.invitationId,
			};
			await first.request('mesh.hello', params);
			await assert.rejects(
				second.request('mesh.hello', params),
				(error: unknown) => rpcReason(error) === 'AUTH_FAILED',
			);
		} finally {
			await first.close();
			await second.close();
			await fixture.dispose();
		}
	});

	test('allows only one concurrent enrollment to consume an invitation', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const secret = secretFrom(invitation);
		const first = await RawClient.open(fixture.endpoint);
		const second = await RawClient.open(fixture.endpoint);
		try {
			const firstEnrollment = await beginEnrollment(first, invitation.invitationId, secret, 'first');
			const secondEnrollment = await beginEnrollment(second, invitation.invitationId, secret, 'second');
			await commitEnrollment(first, firstEnrollment);
			await assert.rejects(
				commitEnrollment(second, secondEnrollment),
				(error: unknown) => rpcReason(error) === 'AUTH_FAILED',
			);
		} finally {
			await first.close();
			await second.close();
			await fixture.dispose();
		}
	});

	test('recovers with the derived key when final commit acknowledgement is lost', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const secret = secretFrom(invitation);
		const client = await RawClient.open(fixture.endpoint);
		try {
			const enrollment = await beginEnrollment(
				client,
				invitation.invitationId,
				secret,
				'coordinator-device',
			);
			client.sendWithoutWaiting('mesh.enrollmentCommit', {
				sessionId: enrollment.transcript.sessionId,
				enrollmentId: enrollment.enrollmentId,
				proof: encodeBase64Url(hmac(
					enrollment.rootKey,
					'mesh/enrollment-commit/v1',
					enrollment.enrollmentId,
					enrollment.transcriptHash,
				)),
			});

			await waitFor(async () => (
				await fixture.records.getPeer(enrollment.peerId)
			) !== undefined, 1_000);
			client.terminate();

			const reconnected = await RawClient.open(fixture.endpoint);
			try {
				await reconnect(
					reconnected,
					enrollment.peerId,
					enrollment.rootKey,
					'coordinator-device',
				);
				const info = await reconnected.request('device.getInfo', {});
				assert.deepStrictEqual(info, { deviceId: 'worker-device' });
			} finally {
				await reconnected.close();
			}
		} finally {
			client.terminate();
			await fixture.dispose();
		}
	});

	test('retries enrollment after a restart persisted an uncommitted candidate credential', async () => {
		const fixture = await createFixture();
		let session: Awaited<ReturnType<WebSocketPeerTransport['connect']>> | undefined;
		try {
			const invitation = await fixture.invitation();
			const secret = secretFrom(invitation);
			const interrupted = await RawClient.open(fixture.endpoint);
			const enrollment = await beginEnrollment(
				interrupted,
				invitation.invitationId,
				secret,
				'interrupted-coordinator',
			);
			await interrupted.close();

			const profiles = new InMemoryPeerProfileStore();
			const pairingSecretKeyRef = 'mesh.remoteInvitation.interrupted';
			const credentialKeyRef = 'mesh.remotePeer.interrupted';
			await fixture.secrets.store(pairingSecretKeyRef, encodeBase64Url(secret));
			await fixture.secrets.store(credentialKeyRef, encodeBase64Url(enrollment.rootKey));
			await profiles.store({
				id: 'interrupted',
				rpcEndpoint: fixture.endpoint,
				workerDeviceId: 'worker-device',
				invitationId: invitation.invitationId,
				pairingSecretKeyRef,
				peerId: enrollment.peerId,
				credentialKeyRef,
			});
			const transport = new WebSocketPeerTransport({ requestTimeoutMs: 500 });
			session = await transport.connect(
				(await profiles.get('interrupted'))!,
				'interrupted-coordinator',
				fixture.secrets,
				profiles,
				new AbortController().signal,
			);
			assert.deepStrictEqual(await session.request('device.getInfo', {}), {
				deviceId: 'worker-device',
			});
			const completed = await profiles.get('interrupted');
			assert.ok(completed?.peerId);
			assert.equal(completed?.invitationId, undefined);
			assert.equal(completed?.pairingSecretKeyRef, undefined);
		} finally {
			await session?.close();
			await fixture.dispose();
		}
	});

	test('rejects incompatible protocol, binary frames, batches, and oversized frames', async () => {
		const fixture = await createFixture();
		try {
			const protocol = await RawClient.open(fixture.endpoint);
			const protocolClose = protocol.closed();
			await assert.rejects(
				protocol.request('mesh.hello', {
					protocolMin: 2,
					protocolMax: 2,
					coordinatorDeviceId: 'coordinator-device',
					clientNonce: randomBase64Url(NONCE_BYTES),
					invitationId: 'unused',
				}),
				(error: unknown) => rpcReason(error) === 'PROTOCOL_INCOMPATIBLE',
			);
			assert.equal(await protocolClose, 1002);

			const binary = await RawClient.open(fixture.endpoint);
			const binaryClose = binary.closed();
			binary.sendBinary(Buffer.from('{}'));
			assert.equal(await binaryClose, 1003);

			const batch = await RawClient.open(fixture.endpoint);
			try {
				const response = await batch.sendRawAndReceive('[]');
				assert.equal((response.error as { code: number }).code, -32600);
			} finally {
				await batch.close();
			}

			const oversized = await RawClient.open(fixture.endpoint);
			const oversizedClose = oversized.closed();
			oversized.sendRaw(JSON.stringify({
				jsonrpc: '2.0',
				id: 'large',
				method: 'mesh.hello',
				params: { padding: 'x'.repeat(65 * 1024) },
			}));
			assert.equal(await oversizedClose, 1009);
		} finally {
			await fixture.dispose();
		}
	});

	test('keeps pong-capable peers alive and terminates a peer that does not pong', async () => {
		const fixture = await createFixture({
			heartbeatIntervalMs: 15,
			heartbeatTimeoutMs: 45,
		});
		const firstInvitation = await fixture.invitation();
		const healthy = await RawClient.open(fixture.endpoint);
		try {
			await pairAndCommit(healthy, firstInvitation, 'healthy-coordinator');
			await delay(90);
			assert.equal(healthy.readyState, WebSocket.OPEN);

			const secondInvitation = await fixture.invitation();
			const silent = await RawClient.open(fixture.endpoint, false);
			try {
				await pairAndCommit(silent, secondInvitation, 'silent-coordinator');
				const close = silent.closed();
				assert.notEqual(await close, 1000);
			} finally {
				silent.terminate();
			}
		} finally {
			await healthy.close();
			await fixture.dispose();
		}
	});

	test('automatically reconnects after gateway restart and disposes all resources', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const manager = fixture.manager({
			reconnectBaseMs: 10,
			reconnectMaxMs: 20,
			stableOnlineMs: 40,
		});
		let restarted: GatewayServer | undefined;
		try {
			const connection = await manager.add(invitation.url);
			assert.equal(connection.snapshot().state, 'online');
			await fixture.gateway.dispose();
			await waitFor(
				() => connection.snapshot().state === 'offline',
				1_000,
			);
			restarted = fixture.newGateway();
			await restarted.start(fixture.port);
			await waitFor(
				() => connection.snapshot().state === 'online',
				2_000,
			);
			assert.deepStrictEqual(
				await connection.request('workspace.list', {}),
				[{ workspaceId: 'workspace-1' }],
			);
			await manager.dispose();
			assert.equal(connection.snapshot().state, 'offline');
			await restarted.dispose();
			restarted = undefined;
			await assert.rejects(connectSocket(fixture.endpoint));
		} finally {
			await manager.dispose();
			await restarted?.dispose();
			await fixture.dispose();
		}
	});
});

interface FixtureOptions {
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatTimeoutMs?: number;
}

async function createFixture(options: FixtureOptions = {}) {
	const secrets = new InMemorySecretStore();
	const records = new InMemoryPairingRecordStore();
	const pairing = new PairingService('worker-device', secrets, records);
	const devicePeers: string[] = [];
	const taskPeers: string[] = [];
	const router = new GatewayRouter(
		{
			getInfo: async (peerId) => {
				devicePeers.push(peerId);
				return { deviceId: 'worker-device' };
			},
		},
		{ list: async () => [{ workspaceId: 'workspace-1' }] },
		{
			start: async (peerId: string, params: TaskStartParams) => {
				taskPeers.push(peerId);
				return params;
			},
			get: async (peerId, taskId) => ({ peerId, taskId }),
			cancel: async (peerId, taskId) => ({ peerId, taskId }),
			answer: async (peerId, taskId) => ({ peerId, taskId }),
		},
	);
	const gatewayOptions = {
		handshakeTimeoutMs: 500,
		heartbeatIntervalMs: options.heartbeatIntervalMs ?? 100,
		heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 300,
	};
	const newGateway = (): GatewayServer => new GatewayServer(pairing, router, gatewayOptions);
	const gateway = newGateway();
	const address = await gateway.start();
	const endpoint = `ws://127.0.0.1:${address.port}/agent-mesh/rpc`;
	const managers = new Set<PeerConnectionManager>();
	const manager = (managerOptions: {
		reconnectBaseMs?: number;
		reconnectMaxMs?: number;
		stableOnlineMs?: number;
	} = {}): PeerConnectionManager => {
		const profiles = new InMemoryPeerProfileStore();
		const transport = new WebSocketPeerTransport({
			requestTimeoutMs: 500,
			heartbeatIntervalMs: 25,
			webSocketFactory: (url) => new WebSocket(url.replace(/^wss:/u, 'ws:'), {
				perMessageDeflate: false,
			}),
		});
		const result = new PeerConnectionManager(
			'coordinator-device',
			profiles,
			secrets,
			transport,
			{ random: () => 0.5, ...managerOptions },
		);
		managers.add(result);
		return result;
	};
	return {
		address,
		port: address.port,
		endpoint,
		gateway,
		newGateway,
		records,
		secrets,
		devicePeers,
		taskPeers,
		manager,
		invitation: () => pairing.createInvitation(`https://127.0.0.1:${address.port}`),
		dispose: async () => {
			await Promise.all([...managers].map((value) => value.dispose()));
			await gateway.dispose();
		},
	};
}

function malformedUpgrade(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connectTcp(port, '127.0.0.1');
		socket.once('error', reject);
		socket.once('close', () => resolve());
		socket.once('data', () => socket.destroy());
		socket.once('connect', () => {
			socket.write(
				'GET /agent-mesh/rpc HTTP/1.1\r\n'
				+ 'Host: 127.0.0.1\r\n'
				+ 'Connection: Upgrade\r\n'
				+ 'Upgrade: websocket\r\n'
				+ 'Sec-WebSocket-Version: 13\r\n'
				+ 'Sec-WebSocket-Key: invalid\r\n\r\n',
			);
		});
	});
}

interface Enrollment {
	readonly transcript: EnrollmentTranscript;
	readonly transcriptHash: Buffer;
	readonly rootKey: Buffer;
	readonly enrollmentId: string;
	readonly peerId: string;
}

async function beginEnrollment(
	client: RawClient,
	invitationId: string,
	secret: Buffer,
	coordinatorDeviceId: string,
): Promise<Enrollment> {
	const clientNonce = randomBase64Url(NONCE_BYTES);
	const hello = await client.request('mesh.hello', {
		protocolMin: 1,
		protocolMax: 1,
		coordinatorDeviceId,
		clientNonce,
		invitationId,
	}) as Record<string, string | number>;
	const transcript: EnrollmentTranscript = {
		version: 1,
		invitationId,
		workerDeviceId: String(hello.workerDeviceId),
		coordinatorDeviceId,
		sessionId: String(hello.sessionId),
		clientNonce,
		serverNonce: String(hello.serverNonce),
	};
	assert.deepStrictEqual(
		decodeFixedBase64Url(hello.serverProof, 32, 'server proof'),
		enrollmentProof(secret, 'mesh/server-proof/v1', transcript),
	);
	const authenticated = await client.request('mesh.authenticate', {
		sessionId: transcript.sessionId,
		proof: encodeBase64Url(enrollmentProof(secret, 'mesh/client-proof/v1', transcript)),
	}) as Record<string, string>;
	return {
		transcript,
		transcriptHash: enrollmentTranscriptHash(transcript),
		rootKey: derivePeerRoot(secret, transcript),
		enrollmentId: authenticated.enrollmentId,
		peerId: authenticated.peerId,
	};
}

async function pairAndCommit(
	client: RawClient,
	invitation: CreatedInvitation,
	coordinatorDeviceId: string,
): Promise<Enrollment> {
	const enrollment = await beginEnrollment(
		client,
		invitation.invitationId,
		secretFrom(invitation),
		coordinatorDeviceId,
	);
	await commitEnrollment(client, enrollment);
	return enrollment;
}

async function commitEnrollment(client: RawClient, enrollment: Enrollment): Promise<void> {
	await client.request('mesh.enrollmentCommit', {
		sessionId: enrollment.transcript.sessionId,
		enrollmentId: enrollment.enrollmentId,
		proof: encodeBase64Url(hmac(
			enrollment.rootKey,
			'mesh/enrollment-commit/v1',
			enrollment.enrollmentId,
			enrollment.transcriptHash,
		)),
	});
}

async function reconnect(
	client: RawClient,
	peerId: string,
	rootKey: Buffer,
	coordinatorDeviceId: string,
): Promise<void> {
	const clientNonce = randomBase64Url(NONCE_BYTES);
	const hello = await client.request('mesh.hello', {
		protocolMin: 1,
		protocolMax: 1,
		coordinatorDeviceId,
		clientNonce,
		peerId,
	}) as Record<string, string | number>;
	const transcript: ReconnectTranscript = {
		version: 1,
		peerId,
		workerDeviceId: String(hello.workerDeviceId),
		coordinatorDeviceId,
		sessionId: String(hello.sessionId),
		clientNonce,
		serverNonce: String(hello.serverNonce),
	};
	assert.deepStrictEqual(
		decodeFixedBase64Url(hello.serverProof, 32, 'server proof'),
		reconnectProof(rootKey, 'mesh/reconnect-server-proof/v1', transcript),
	);
	await client.request('mesh.authenticate', {
		sessionId: transcript.sessionId,
		proof: encodeBase64Url(reconnectProof(
			rootKey,
			'mesh/reconnect-client-proof/v1',
			transcript,
		)),
	});
}

class RawClient {
	private nextId = 0;
	private readonly responses: Array<(value: Record<string, unknown>) => void> = [];
	private readonly closeWaiters: Array<(code: number) => void> = [];
	private lastCloseCode: number | undefined;

	private constructor(private readonly socket: WebSocket) {
		socket.on('message', (data, isBinary) => {
			if (isBinary) {
				return;
			}
			const response = JSON.parse(rawBuffer(data).toString('utf8')) as Record<string, unknown>;
			this.responses.shift()?.(response);
		});
		socket.on('close', (code) => {
			this.lastCloseCode = code;
			for (const waiter of this.closeWaiters.splice(0)) {
				waiter(code);
			}
		});
	}

	public static async open(endpoint: string, autoPong = true): Promise<RawClient> {
		const socket = new WebSocket(endpoint, { autoPong, perMessageDeflate: false });
		await new Promise<void>((resolve, reject) => {
			socket.once('open', () => resolve());
			socket.once('error', reject);
		});
		return new RawClient(socket);
	}

	public get readyState(): number {
		return this.socket.readyState;
	}

	public request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = String(++this.nextId);
		return new Promise((resolve, reject) => {
			this.responses.push((response) => {
				if (response.error !== undefined) {
					const error = response.error as { message: string; data?: { reason?: string } };
					reject(Object.assign(new Error(error.message), { reason: error.data?.reason }));
				} else {
					resolve(response.result);
				}
			});
			this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		});
	}

	public sendWithoutWaiting(method: string, params: Record<string, unknown>): void {
		this.socket.send(JSON.stringify({
			jsonrpc: '2.0',
			id: String(++this.nextId),
			method,
			params,
		}));
	}

	public sendRaw(value: string): void {
		this.socket.send(value);
	}

	public sendBinary(value: Buffer): void {
		this.socket.send(value, { binary: true });
	}

	public sendRawAndReceive(value: string): Promise<Record<string, unknown>> {
		return new Promise((resolve) => {
			this.responses.push(resolve);
			this.socket.send(value);
		});
	}

	public closed(): Promise<number> {
		if (this.lastCloseCode !== undefined) {
			return Promise.resolve(this.lastCloseCode);
		}
		return new Promise((resolve) => this.closeWaiters.push(resolve));
	}

	public terminate(): void {
		this.socket.terminate();
	}

	public async close(): Promise<void> {
		if (this.socket.readyState === WebSocket.CLOSED) {
			return;
		}
		const closed = this.closed();
		this.socket.close();
		await closed;
	}
}

function secretFrom(invitation: CreatedInvitation): Buffer {
	return decodeFixedBase64Url(
		new URL(invitation.url).hash.slice('#secret='.length),
		32,
		'secret',
	);
}

function rpcReason(error: unknown): string | undefined {
	return error instanceof Error && 'reason' in error
		? String(error.reason)
		: undefined;
}

function rawBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data);
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data);
	}
	throw new Error('Unsupported WebSocket data.');
}

function get(port: number, path: string): Promise<{ status: number; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest({
			host: '127.0.0.1',
			port,
			path,
			method: 'GET',
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({
				status: response.statusCode ?? 0,
				body: Buffer.concat(chunks),
			}));
		});
		request.once('error', reject);
		request.end();
	});
}

function connectSocket(endpoint: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(endpoint);
		socket.once('open', () => {
			socket.close();
			resolve();
		});
		socket.once('error', reject);
	});
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!await predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for component state.');
		}
		await delay(5);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
