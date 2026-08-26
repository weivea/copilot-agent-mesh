import { randomUUID } from 'node:crypto';

import WebSocket, { type RawData } from 'ws';

import { MESH_PROTOCOL_VERSION, rpcNotificationSchema } from '../../shared/protocol';
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
import {
	isUsablePeerProfile,
	type PeerProfile,
	type PeerProfileStore,
} from './PeerProfile';

export interface PeerSession {
	readonly profile: PeerProfile;
	readonly lastHeartbeatAt?: number;
	readonly latencyMs?: number;
	request(method: string, params: Record<string, unknown>): Promise<unknown>;
	onNotification?(listener: (method: string, params: Record<string, unknown>) => void): () => void;
	onClose(listener: () => void): () => void;
	close(): Promise<void>;
}

function finiteNumberField(value: Record<string, unknown>, field: string): number {
	const result = value[field];
	if (typeof result !== 'number' || !Number.isFinite(result)) {
		throw new PeerTransportError('CONNECTION_FAILED', 'Peer returned an invalid response.');
	}
	return result;
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

function isPendingEnrollment(profile: PeerProfile): profile is PeerProfile & Required<Pick<
	PeerProfile,
	| 'peerId'
	| 'credentialKeyRef'
	| 'pendingEnrollmentId'
	| 'pendingTranscriptHash'
	| 'pendingCommitProofKeyRef'
	| 'pendingExpiresAt'
>> {
	return profile.peerId !== undefined
		&& profile.credentialKeyRef !== undefined
		&& profile.pendingEnrollmentId !== undefined
		&& profile.pendingTranscriptHash !== undefined
		&& profile.pendingCommitProofKeyRef !== undefined
		&& profile.pendingExpiresAt !== undefined;
}

async function completeEnrollment(
	profile: PeerProfile,
	secrets: SecretStore,
	profiles: PeerProfileStore,
): Promise<PeerProfile> {
	if (profile.peerId === undefined || profile.credentialKeyRef === undefined) {
		throw new PeerTransportError('AUTH_FAILED', 'Peer credentials are unavailable.');
	}
	if (profile.pendingCommitProofKeyRef !== undefined) {
		await secrets.delete(profile.pendingCommitProofKeyRef);
	}
	if (profile.pairingSecretKeyRef !== undefined) {
		await secrets.delete(profile.pairingSecretKeyRef);
	}
	const completed: PeerProfile = {
		id: profile.id,
		generation: profile.generation,
		rpcEndpoint: profile.rpcEndpoint,
		workerDeviceId: profile.workerDeviceId,
		peerId: profile.peerId,
		credentialKeyRef: profile.credentialKeyRef,
	};
	await profiles.store(completed);
	return completed;
}

export interface WebSocketPeerTransportOptions {
	readonly requestTimeoutMs?: number;
	readonly heartbeatIntervalMs?: number;
	readonly webSocketFactory?: (url: string) => WebSocket;
	readonly now?: () => number;
}

export class PeerTransportError extends Error {
	public constructor(
		public readonly reason:
			| 'AUTH_FAILED'
			| 'PROTOCOL_INCOMPATIBLE'
			| 'CONNECTION_FAILED'
			| 'REPAIR_REQUIRED',
		message: string,
	) {
		super(message);
		this.name = 'PeerTransportError';
	}
}

export class PeerRpcError extends Error {
	public constructor(
		public readonly reason: string,
		public readonly retryable: boolean,
		message: string,
	) {
		super(message);
		this.name = 'PeerRpcError';
	}
}

async function retryPendingCommit(
	client: RpcWebSocketClient,
	profile: PeerProfile & Required<Pick<
		PeerProfile,
		| 'peerId'
		| 'pendingEnrollmentId'
		| 'pendingCommitProofKeyRef'
		| 'pendingExpiresAt'
	>>,
	secrets: SecretStore,
): Promise<void> {
	const proof = await secrets.get(profile.pendingCommitProofKeyRef);
	if (proof === undefined) {
		throw new PeerTransportError(
			'REPAIR_REQUIRED',
			'Enrollment recovery credential is unavailable; pairing is required again.',
		);
	}
	const committed = objectResult(await client.request('mesh.enrollmentCommit', {
		enrollmentId: profile.pendingEnrollmentId,
		peerId: profile.peerId,
		proof,
	}));
	assertExactFields(committed, ['committed', 'peerId']);
	if (committed.committed !== true || committed.peerId !== profile.peerId) {
		throw new PeerTransportError('AUTH_FAILED', 'Enrollment commit was not confirmed.');
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
		if (!isUsablePeerProfile(profile)) {
			throw new PeerTransportError('AUTH_FAILED', 'Peer credentials are unavailable.');
		}
		if (profile.peerId !== undefined && profile.credentialKeyRef !== undefined) {
			const client = await this.open(profile.rpcEndpoint, signal);
			try {
				try {
					await this.reconnect(client, profile, coordinatorDeviceId, secrets);
				} catch (error: unknown) {
					const normalized = normalizeTransportError(error);
					if (normalized.reason !== 'AUTH_FAILED' || !isPendingEnrollment(profile)) {
						throw normalized;
					}
					await retryPendingCommit(client, profile, secrets);
				}
				const connectedProfile = hasProvisionalEnrollmentMetadata(profile)
					? await completeEnrollment(profile, secrets, profiles)
					: profile;
				return client.toSession(connectedProfile, this.heartbeatIntervalMs, this.now);
			} catch (error: unknown) {
				await client.close();
				throw normalizeTransportError(error);
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
				protocolMin: MESH_PROTOCOL_VERSION,
				protocolMax: MESH_PROTOCOL_VERSION,
				coordinatorDeviceId,
				clientNonce,
				invitationId: profile.invitationId,
			}));
			assertHello(hello, 'enrollment', profile.workerDeviceId);
			const transcript: EnrollmentTranscript = {
				version: MESH_PROTOCOL_VERSION,
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
			assertExactFields(authentication, ['enrollmentId', 'peerId', 'expiresAt', 'pendingProof']);
			const enrollmentId = stringField(authentication, 'enrollmentId');
			const peerId = identifierField(authentication, 'peerId');
			const expiresAt = finiteNumberField(authentication, 'expiresAt');
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
			const commitProofKeyRef = `mesh.remoteCommit.${profile.id}`;
			const commitProof = encodeBase64Url(hmac(
				rootKey,
				'mesh/enrollment-commit/v1',
				enrollmentId,
				hash,
			));
			await secrets.store(credentialKeyRef, encodeBase64Url(rootKey));
			try {
				await secrets.store(commitProofKeyRef, commitProof);
				candidate = {
					...profile,
					peerId,
					credentialKeyRef,
					pendingEnrollmentId: enrollmentId,
					pendingTranscriptHash: encodeBase64Url(hash),
					pendingCommitProofKeyRef: commitProofKeyRef,
					pendingExpiresAt: expiresAt,
				};
				try {
					await profiles.store(candidate);
				} catch (error: unknown) {
					const persisted = await reconcileProfileStore(
						profiles,
						profile,
						candidate,
					);
					if (persisted === 'previous') {
						await deleteCandidateSecrets(
							secrets,
							credentialKeyRef,
							commitProofKeyRef,
						);
						throw error;
					}
					if (persisted === 'unknown') {
						throw new PeerTransportError(
							'CONNECTION_FAILED',
							'Enrollment profile persistence could not be confirmed.',
						);
					}
				}
			} catch (error: unknown) {
				if (candidate === undefined) {
					await deleteCandidateSecrets(secrets, credentialKeyRef, commitProofKeyRef);
				}
				throw error;
			}
			try {
				const committed = objectResult(await client.request('mesh.enrollmentCommit', {
					sessionId: transcript.sessionId,
					enrollmentId,
					peerId,
					proof: commitProof,
				}));
				assertExactFields(committed, ['committed', 'peerId']);
				if (committed.committed !== true || committed.peerId !== peerId) {
					throw new PeerTransportError('AUTH_FAILED', 'Enrollment commit was not confirmed.');
				}
			} catch (error: unknown) {
				const normalized = normalizeTransportError(error);
				if (normalized.reason !== 'CONNECTION_FAILED') {
					throw normalized;
				}
				throw new PeerTransportError(
					'CONNECTION_FAILED',
					'Enrollment commit confirmation is pending.',
				);
			}
			const completed = await completeEnrollment(candidate, secrets, profiles);
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
			protocolMin: MESH_PROTOCOL_VERSION,
			protocolMax: MESH_PROTOCOL_VERSION,
			coordinatorDeviceId,
			clientNonce,
			peerId: profile.peerId,
		}));
		assertHello(hello, 'reconnect', profile.workerDeviceId);
		const transcript: ReconnectTranscript = {
			version: MESH_PROTOCOL_VERSION,
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

function hasProvisionalEnrollmentMetadata(profile: PeerProfile): boolean {
	return profile.invitationId !== undefined
		|| profile.pairingSecretKeyRef !== undefined
		|| profile.pendingEnrollmentId !== undefined
		|| profile.pendingTranscriptHash !== undefined
		|| profile.pendingCommitProofKeyRef !== undefined
		|| profile.pendingExpiresAt !== undefined;
}

async function reconcileProfileStore(
	profiles: PeerProfileStore,
	previous: PeerProfile,
	candidate: PeerProfile,
): Promise<'candidate' | 'previous' | 'unknown'> {
	let persisted: PeerProfile | undefined;
	try {
		persisted = await profiles.get(candidate.id);
	} catch {
		return 'unknown';
	}
	if (profilesEqual(persisted, candidate)) {
		return 'candidate';
	}
	return profilesEqual(persisted, previous) ? 'previous' : 'unknown';
}

function profilesEqual(left: PeerProfile | undefined, right: PeerProfile): boolean {
	return left !== undefined
		&& left.id === right.id
		&& left.generation === right.generation
		&& left.rpcEndpoint === right.rpcEndpoint
		&& left.workerDeviceId === right.workerDeviceId
		&& left.invitationId === right.invitationId
		&& left.pairingSecretKeyRef === right.pairingSecretKeyRef
		&& left.peerId === right.peerId
		&& left.credentialKeyRef === right.credentialKeyRef
		&& left.pendingEnrollmentId === right.pendingEnrollmentId
		&& left.pendingTranscriptHash === right.pendingTranscriptHash
		&& left.pendingCommitProofKeyRef === right.pendingCommitProofKeyRef
		&& left.pendingExpiresAt === right.pendingExpiresAt;
}

async function deleteCandidateSecrets(
	secrets: SecretStore,
	credentialKeyRef: string,
	commitProofKeyRef: string,
): Promise<void> {
	const results = await Promise.allSettled([
		secrets.delete(commitProofKeyRef),
		secrets.delete(credentialKeyRef),
	]);
	const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
	if (failures.length > 0) {
		throw new AggregateError(failures, 'Failed to remove unpersisted enrollment credentials.');
	}
}

class RpcWebSocketClient {
	private readonly pending = new Map<string, {
		resolve(value: unknown): void;
		reject(error: Error): void;
		timer: NodeJS.Timeout;
	}>();
	private readonly closeListeners = new Set<() => void>();
	private readonly notificationListeners = new Set<(
		method: string,
		params: Record<string, unknown>,
	) => void>();
	private closed = false;

	private constructor(
		private readonly socket: WebSocket,
		private readonly requestTimeoutMs: number,
		private readonly signal: AbortSignal,
	) {
		if (signal.aborted) {
			socket.terminate();
			this.closed = true;
			return;
		}
		socket.on('message', (data, isBinary) => this.receive(data, isBinary));
		socket.once('close', () => this.handleClose());
		socket.once('error', () => this.handleClose());
		signal.addEventListener('abort', this.abort, { once: true });
	}

	public static open(
		socket: WebSocket,
		requestTimeoutMs: number,
		signal: AbortSignal,
	): Promise<RpcWebSocketClient> {
		return new Promise((resolve, reject) => {
			const fail = (): void => {
				cleanup();
				socket.once('error', () => undefined);
				socket.terminate();
				reject(new PeerTransportError('CONNECTION_FAILED', 'Unable to open peer connection.'));
			};
			const abort = (): void => fail();
			const opened = (): void => {
				const client = new RpcWebSocketClient(socket, requestTimeoutMs, signal);
				cleanup();
				resolve(client);
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
			onNotification: (listener) => {
				client.notificationListeners.add(listener);
				return () => client.notificationListeners.delete(listener);
			},
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
		const notification = rpcNotificationSchema.safeParse(value);
		if (notification.success) {
			for (const listener of this.notificationListeners) {
				listener(notification.data.method, notification.data.params);
			}
			return;
		}
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
			const data = typeof error.data === 'object' && error.data !== null
				? error.data as Record<string, unknown>
				: undefined;
			const reason = data?.reason;
			if (
				typeof reason === 'string'
				&& !['PROTOCOL_INCOMPATIBLE', 'AUTH_FAILED', 'ENROLLMENT_EXPIRED'].includes(reason)
			) {
				pending.reject(new PeerRpcError(
					reason,
					data?.retryable === true,
					typeof error.message === 'string' ? error.message : 'Peer request failed.',
				));
				return;
			}
			pending.reject(new PeerTransportError(
				reason === 'PROTOCOL_INCOMPATIBLE' ? 'PROTOCOL_INCOMPATIBLE'
					: reason === 'AUTH_FAILED' ? 'AUTH_FAILED'
						: reason === 'ENROLLMENT_EXPIRED' ? 'REPAIR_REQUIRED'
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
		this.signal.removeEventListener('abort', this.abort);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new PeerTransportError('CONNECTION_FAILED', 'Peer connection closed.'));
		}
		this.pending.clear();
		for (const listener of this.closeListeners) {
			listener();
		}
		this.closeListeners.clear();
		this.notificationListeners.clear();
	}

	private readonly abort = (): void => {
		if (!this.closed) {
			this.socket.terminate();
			this.handleClose();
		}
	};
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
		|| value.version !== MESH_PROTOCOL_VERSION
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
