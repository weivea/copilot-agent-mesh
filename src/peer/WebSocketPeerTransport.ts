import { randomUUID } from 'node:crypto';

import WebSocket, { type RawData } from 'ws';

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
	safeEqual,
	type EnrollmentTranscript,
	type ReconnectTranscript,
} from '../gateway/PairingCrypto';
import type { SecretStore } from '../gateway/SecretStore';
import type { PeerProfile, PeerProfileStore } from './PeerProfile';

export interface PeerSession {
	readonly profile: PeerProfile;
	readonly lastHeartbeatAt?: number;
	readonly latencyMs?: number;
	request(method: string, params: Record<string, unknown>): Promise<unknown>;
	onClose(listener: () => void): () => void;
	close(): Promise<void>;
}

export interface PeerTransport {
	connect(
		profile: PeerProfile,
		coordinatorDeviceId: string,
		secrets: SecretStore,
		profiles: PeerProfileStore,
		signal: AbortSignal,
	): Promise<PeerSession>;
}

export interface WebSocketPeerTransportOptions {
	readonly requestTimeoutMs?: number;
	readonly heartbeatIntervalMs?: number;
	readonly webSocketFactory?: (url: string) => WebSocket;
	readonly now?: () => number;
}

export class PeerTransportError extends Error {
	public constructor(
		public readonly reason: 'AUTH_FAILED' | 'PROTOCOL_INCOMPATIBLE' | 'CONNECTION_FAILED',
		message: string,
	) {
		super(message);
		this.name = 'PeerTransportError';
	}
}

export class WebSocketPeerTransport implements PeerTransport {
	private readonly requestTimeoutMs: number;
	private readonly heartbeatIntervalMs: number;
	private readonly factory: (url: string) => WebSocket;
	private readonly now: () => number;

	public constructor(options: WebSocketPeerTransportOptions = {}) {
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
		this.factory = options.webSocketFactory ?? ((url) => new WebSocket(url, {
			perMessageDeflate: false,
			maxPayload: 1_048_576,
		}));
		this.now = options.now ?? Date.now;
	}

	public async connect(
		profile: PeerProfile,
		coordinatorDeviceId: string,
		secrets: SecretStore,
		profiles: PeerProfileStore,
		signal: AbortSignal,
	): Promise<PeerSession> {
		if (profile.peerId !== undefined && profile.credentialKeyRef !== undefined) {
			const client = await this.open(profile.rpcEndpoint, signal);
			try {
				await this.reconnect(client, profile, coordinatorDeviceId, secrets);
				let connectedProfile = profile;
				if (profile.pairingSecretKeyRef !== undefined) {
					connectedProfile = {
						id: profile.id,
						rpcEndpoint: profile.rpcEndpoint,
						workerDeviceId: profile.workerDeviceId,
						peerId: profile.peerId,
						credentialKeyRef: profile.credentialKeyRef,
					};
					await profiles.store(connectedProfile);
					await secrets.delete(profile.pairingSecretKeyRef);
				}
				return client.toSession(connectedProfile, this.heartbeatIntervalMs, this.now);
			} catch (error: unknown) {
				await client.close();
				const normalized = normalizeTransportError(error);
				if (normalized.reason === 'AUTH_FAILED'
					&& profile.invitationId !== undefined
					&& profile.pairingSecretKeyRef !== undefined) {
					throw new PeerTransportError(
						'CONNECTION_FAILED',
						'Enrollment commit confirmation is pending.',
					);
				}
				throw normalized;
			}
		}
		return this.enroll(profile, coordinatorDeviceId, secrets, profiles, signal);
	}

	private async enroll(
		profile: PeerProfile,
		coordinatorDeviceId: string,
		secrets: SecretStore,
		profiles: PeerProfileStore,
		signal: AbortSignal,
	): Promise<PeerSession> {
		if (profile.invitationId === undefined || profile.pairingSecretKeyRef === undefined) {
			throw new PeerTransportError('AUTH_FAILED', 'Pairing credentials are unavailable.');
		}
		const encodedSecret = await secrets.get(profile.pairingSecretKeyRef);
		if (encodedSecret === undefined) {
			throw new PeerTransportError('AUTH_FAILED', 'Pairing credentials are unavailable.');
		}
		const secret = decodeFixedBase64Url(encodedSecret, 32, 'pairing credential');
		let client = await this.open(profile.rpcEndpoint, signal);
		let candidate: PeerProfile | undefined;
		try {
			const clientNonce = randomBase64Url(NONCE_BYTES);
			const hello = objectResult(await client.request('mesh.hello', {
				protocolMin: 1,
				protocolMax: 1,
				coordinatorDeviceId,
				clientNonce,
				invitationId: profile.invitationId,
			}));
			assertHello(hello, 'enrollment', profile.workerDeviceId);
			const transcript: EnrollmentTranscript = {
				version: 1,
				invitationId: profile.invitationId,
				workerDeviceId: profile.workerDeviceId,
				coordinatorDeviceId,
				sessionId: stringField(hello, 'sessionId'),
				clientNonce,
				serverNonce: stringField(hello, 'serverNonce'),
			};
			const serverProof = decodeFixedBase64Url(hello.serverProof, 32, 'server proof');
			if (!safeEqual(serverProof, enrollmentProof(secret, 'mesh/server-proof/v1', transcript))) {
				throw new PeerTransportError('AUTH_FAILED', 'Pairing authentication failed.');
			}
			const authentication = objectResult(await client.request('mesh.authenticate', {
				sessionId: transcript.sessionId,
				proof: encodeBase64Url(enrollmentProof(secret, 'mesh/client-proof/v1', transcript)),
			}));
			assertExactFields(authentication, ['enrollmentId', 'peerId', 'pendingProof']);
			const enrollmentId = stringField(authentication, 'enrollmentId');
			const peerId = identifierField(authentication, 'peerId');
			const rootKey = derivePeerRoot(secret, transcript);
			const hash = enrollmentTranscriptHash(transcript);
			const pendingProof = decodeFixedBase64Url(authentication.pendingProof, 32, 'pending proof');
			if (!safeEqual(
				pendingProof,
				hmac(rootKey, 'mesh/enrollment-pending/v1', enrollmentId, hash),
			)) {
				throw new PeerTransportError('AUTH_FAILED', 'Pairing authentication failed.');
			}
			const credentialKeyRef = `mesh.remotePeer.${profile.id}`;
			await secrets.store(credentialKeyRef, encodeBase64Url(rootKey));
			candidate = {
				...profile,
				peerId,
				credentialKeyRef,
			};
			await profiles.store(candidate);
			try {
				const committed = objectResult(await client.request('mesh.enrollmentCommit', {
					sessionId: transcript.sessionId,
					enrollmentId,
					proof: encodeBase64Url(hmac(
						rootKey,
						'mesh/enrollment-commit/v1',
						enrollmentId,
						hash,
					)),
				}));
				assertExactFields(committed, ['committed', 'peerId']);
				if (committed.committed !== true || committed.peerId !== peerId) {
					throw new PeerTransportError('AUTH_FAILED', 'Enrollment commit was not confirmed.');
				}
			} catch {
				await client.close();
				client = await this.open(profile.rpcEndpoint, signal);
				try {
					await this.reconnect(client, candidate, coordinatorDeviceId, secrets);
				} catch {
					throw new PeerTransportError(
						'CONNECTION_FAILED',
						'Enrollment commit confirmation is pending.',
					);
				}
			}
			const completed: PeerProfile = {
				id: candidate.id,
				rpcEndpoint: candidate.rpcEndpoint,
				workerDeviceId: candidate.workerDeviceId,
				peerId: candidate.peerId,
				credentialKeyRef: candidate.credentialKeyRef,
			};
			await profiles.store(completed);
			await secrets.delete(profile.pairingSecretKeyRef);
			return client.toSession(completed, this.heartbeatIntervalMs, this.now);
		} catch (error: unknown) {
			await client.close();
			throw normalizeTransportError(error);
		}
	}

	private async reconnect(
		client: RpcWebSocketClient,
		profile: PeerProfile,
		coordinatorDeviceId: string,
		secrets: SecretStore,
	): Promise<void> {
		if (profile.peerId === undefined || profile.credentialKeyRef === undefined) {
			throw new PeerTransportError('AUTH_FAILED', 'Peer credentials are unavailable.');
		}
		const encodedRoot = await secrets.get(profile.credentialKeyRef);
		if (encodedRoot === undefined) {
			throw new PeerTransportError('AUTH_FAILED', 'Peer credentials are unavailable.');
		}
		const rootKey = decodeFixedBase64Url(encodedRoot, 32, 'peer credential');
		const clientNonce = randomBase64Url(NONCE_BYTES);
		const hello = objectResult(await client.request('mesh.hello', {
			protocolMin: 1,
			protocolMax: 1,
			coordinatorDeviceId,
			clientNonce,
			peerId: profile.peerId,
		}));
		assertHello(hello, 'reconnect', profile.workerDeviceId);
		const transcript: ReconnectTranscript = {
			version: 1,
			peerId: profile.peerId,
			workerDeviceId: profile.workerDeviceId,
			coordinatorDeviceId,
			sessionId: stringField(hello, 'sessionId'),
			clientNonce,
			serverNonce: stringField(hello, 'serverNonce'),
		};
		const serverProof = decodeFixedBase64Url(hello.serverProof, 32, 'server proof');
		if (!safeEqual(
			serverProof,
			reconnectProof(rootKey, 'mesh/reconnect-server-proof/v1', transcript),
		)) {
			throw new PeerTransportError('AUTH_FAILED', 'Peer authentication failed.');
		}
		const authenticated = objectResult(await client.request('mesh.authenticate', {
			sessionId: transcript.sessionId,
			proof: encodeBase64Url(reconnectProof(
				rootKey,
				'mesh/reconnect-client-proof/v1',
				transcript,
			)),
		}));
		assertExactFields(authenticated, ['authenticated', 'peerId']);
		if (authenticated.authenticated !== true || authenticated.peerId !== profile.peerId) {
			throw new PeerTransportError('AUTH_FAILED', 'Peer authentication was not confirmed.');
		}
	}

	private async open(endpoint: string, signal: AbortSignal): Promise<RpcWebSocketClient> {
		let socket: WebSocket;
		try {
			socket = this.factory(endpoint);
		} catch {
			throw new PeerTransportError('CONNECTION_FAILED', 'Unable to open peer connection.');
		}
		return RpcWebSocketClient.open(socket, this.requestTimeoutMs, signal);
	}
}

class RpcWebSocketClient {
	private readonly pending = new Map<string, {
		resolve(value: unknown): void;
		reject(error: Error): void;
		timer: NodeJS.Timeout;
	}>();
	private readonly closeListeners = new Set<() => void>();
	private closed = false;

	private constructor(
		private readonly socket: WebSocket,
		private readonly requestTimeoutMs: number,
	) {
		socket.on('message', (data, isBinary) => this.receive(data, isBinary));
		socket.once('close', () => this.handleClose());
		socket.once('error', () => this.handleClose());
	}

	public static open(
		socket: WebSocket,
		requestTimeoutMs: number,
		signal: AbortSignal,
	): Promise<RpcWebSocketClient> {
		return new Promise((resolve, reject) => {
			const fail = (): void => {
				cleanup();
				socket.terminate();
				reject(new PeerTransportError('CONNECTION_FAILED', 'Unable to open peer connection.'));
			};
			const abort = (): void => fail();
			const opened = (): void => {
				cleanup();
				resolve(new RpcWebSocketClient(socket, requestTimeoutMs));
			};
			const cleanup = (): void => {
				socket.off('open', opened);
				socket.off('error', fail);
				signal.removeEventListener('abort', abort);
			};
			if (signal.aborted) {
				fail();
				return;
			}
			socket.once('open', opened);
			socket.once('error', fail);
			signal.addEventListener('abort', abort, { once: true });
		});
	}

	public request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new PeerTransportError('CONNECTION_FAILED', 'Peer connection is closed.'));
		}
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new PeerTransportError('CONNECTION_FAILED', 'Peer request timed out.'));
			}, this.requestTimeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
				if (error !== undefined && error !== null) {
					const pending = this.pending.get(id);
					if (pending !== undefined) {
						clearTimeout(pending.timer);
						this.pending.delete(id);
						pending.reject(new PeerTransportError(
							'CONNECTION_FAILED',
							`Peer request "${method}" could not be sent.`,
						));
					}
				}
			});
		});
	}

	public toSession(
		profile: PeerProfile,
		heartbeatIntervalMs: number,
		now: () => number,
	): PeerSession {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
			throw new PeerTransportError('CONNECTION_FAILED', 'Peer connection closed before activation.');
		}
		const client = this;
		let lastHeartbeatAt: number | undefined;
		let latencyMs: number | undefined;
		const heartbeat = setInterval(() => {
			const sentAt = now();
			void client.request('mesh.ping', { sentAt }).then((value) => {
				const result = objectResult(value);
				assertExactFields(result, ['sentAt', 'receivedAt']);
				if (result.sentAt !== sentAt
					|| typeof result.receivedAt !== 'number'
					|| !Number.isFinite(result.receivedAt)) {
					throw new PeerTransportError(
						'CONNECTION_FAILED',
						'Peer returned an invalid heartbeat response.',
					);
				}
				lastHeartbeatAt = now();
				latencyMs = lastHeartbeatAt - sentAt;
			}).catch(() => {
				void client.close();
			});
		}, heartbeatIntervalMs);
		const stopHeartbeat = (): void => clearInterval(heartbeat);
		this.closeListeners.add(stopHeartbeat);
		return {
			profile,
			get lastHeartbeatAt(): number | undefined {
				return lastHeartbeatAt;
			},
			get latencyMs(): number | undefined {
				return latencyMs;
			},
			request: (method, params) => client.request(method, params),
			onClose: (listener) => client.onClose(listener),
			close: async () => {
				stopHeartbeat();
				await client.close();
			},
		};
	}

	private onClose(listener: () => void): () => void {
		if (this.closed) {
			listener();
			return () => undefined;
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	public close(): Promise<void> {
		if (this.closed || this.socket.readyState === WebSocket.CLOSED) {
			this.handleClose();
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			this.socket.once('close', () => {
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				resolve();
			});
			this.socket.close(1000, 'Peer disconnected.');
			timer = setTimeout(() => this.socket.terminate(), 1_000);
			timer.unref();
		});
	}

	private receive(data: RawData, isBinary: boolean): void {
		if (isBinary) {
			this.socket.close(1003, 'Binary response is invalid.');
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(rawDataToBuffer(data).toString('utf8')) as unknown;
		} catch {
			this.socket.close(1002, 'Invalid JSON-RPC response.');
			return;
		}
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			this.socket.close(1002, 'Invalid JSON-RPC response.');
			return;
		}
		const response = value as Record<string, unknown>;
		const hasResult = Object.hasOwn(response, 'result');
		const hasError = Object.hasOwn(response, 'error');
		if (response.jsonrpc !== '2.0'
			|| typeof response.id !== 'string'
			|| response.id.length === 0
			|| hasResult === hasError
			|| Object.keys(response).length !== 3) {
			this.socket.close(1002, 'Invalid JSON-RPC response.');
			return;
		}
		if (hasError && !isRpcError(response.error)) {
			this.socket.close(1002, 'Invalid JSON-RPC response.');
			return;
		}
		const pending = this.pending.get(response.id);
		if (pending === undefined) {
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(response.id);
		if (hasError) {
			const error = response.error as Record<string, unknown>;
			const reason = typeof error.data === 'object' && error.data !== null
				? (error.data as Record<string, unknown>).reason
				: undefined;
			pending.reject(new PeerTransportError(
				reason === 'PROTOCOL_INCOMPATIBLE' ? 'PROTOCOL_INCOMPATIBLE'
					: reason === 'AUTH_FAILED' ? 'AUTH_FAILED'
						: 'CONNECTION_FAILED',
				typeof error.message === 'string' ? error.message : 'Peer request failed.',
			));
			return;
		}
		pending.resolve(response.result);
	}

	private handleClose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new PeerTransportError('CONNECTION_FAILED', 'Peer connection closed.'));
		}
		this.pending.clear();
		for (const listener of this.closeListeners) {
			listener();
		}
		this.closeListeners.clear();
	}
}

function assertHello(
	value: Record<string, unknown>,
	mode: 'enrollment' | 'reconnect',
	workerDeviceId: string,
): void {
	assertExactFields(value, [
		'mode', 'version', 'workerDeviceId', 'sessionId', 'serverNonce', 'serverProof',
	]);
	if (value.mode !== mode
		|| value.version !== 1
		|| value.workerDeviceId !== workerDeviceId) {
		throw new PeerTransportError('PROTOCOL_INCOMPATIBLE', 'Peer protocol response is incompatible.');
	}
	stringField(value, 'sessionId');
	stringField(value, 'serverNonce');
	stringField(value, 'serverProof');
}

function assertExactFields(value: Record<string, unknown>, fields: readonly string[]): void {
	if (Object.keys(value).length !== fields.length
		|| fields.some((field) => !Object.hasOwn(value, field))) {
		throw new PeerTransportError('CONNECTION_FAILED', 'Peer returned an invalid response.');
	}
}

function isRpcError(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const error = value as Record<string, unknown>;
	const keys = Object.keys(error);
	return keys.every((key) => ['code', 'message', 'data'].includes(key))
		&& keys.length >= 2
		&& Object.hasOwn(error, 'code')
		&& Object.hasOwn(error, 'message')
		&& Number.isInteger(error.code)
		&& typeof error.message === 'string'
		&& (!Object.hasOwn(error, 'data')
			|| (typeof error.data === 'object' && error.data !== null && !Array.isArray(error.data)));
}

function objectResult(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new PeerTransportError('CONNECTION_FAILED', 'Peer returned an invalid response.');
	}
	return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
	const result = value[field];
	if (typeof result !== 'string' || result.length === 0 || result.length > 256) {
		throw new PeerTransportError('CONNECTION_FAILED', 'Peer returned an invalid response.');
	}
	return result;
}

function identifierField(value: Record<string, unknown>, field: string): string {
	const result = stringField(value, field);
	if (!/^[A-Za-z0-9._~-]+$/u.test(result) || result.length > 128) {
		throw new PeerTransportError('CONNECTION_FAILED', 'Peer returned an invalid response.');
	}
	return result;
}

function normalizeTransportError(error: unknown): PeerTransportError {
	return error instanceof PeerTransportError
		? error
		: new PeerTransportError('CONNECTION_FAILED', 'Peer connection failed.');
}

function rawDataToBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data);
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data);
	}
	throw new Error('Unsupported WebSocket frame representation.');
}
