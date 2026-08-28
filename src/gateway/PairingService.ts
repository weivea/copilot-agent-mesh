import { randomUUID } from 'node:crypto';

import { MESH_PROTOCOL_VERSION } from '../../shared/protocol';
import {
	decodeFixedBase64Url,
	derivePeerRoot,
	encodeBase64Url,
	enrollmentProof,
	enrollmentTranscriptHash,
	hmac,
	NONCE_BYTES,
	PairingProtocolError,
	randomBase64Url,
	reconnectProof,
	safeEqual,
	SECRET_BYTES,
	type EnrollmentTranscript,
	type ReconnectTranscript,
} from './PairingCrypto';
import type { SecretStore } from './SecretStore';

export interface InvitationRecord {
	readonly invitationId: string;
	readonly expiresAt: number;
	readonly secretKeyRef: string;
}

export interface PendingPeerRecord {
	readonly enrollmentId: string;
	readonly peerId: string;
	readonly coordinatorDeviceId: string;
	readonly invitationId: string;
	readonly transcriptHash: string;
	readonly rootKeyRef: string;
	readonly expiresAt: number;
}

export interface PeerRecord {
	readonly peerId: string;
	readonly coordinatorDeviceId: string;
	readonly rootKeyRef: string;
	readonly enrollmentId: string;
	readonly transcriptHash: string;
	readonly createdAt: number;
	readonly invitationSecretKeyRef?: string;
	readonly cleanupPending?: boolean;
}

export interface PairingRecordStore {
	listInvitations(): Promise<readonly InvitationRecord[]>;
	getInvitation(invitationId: string): Promise<InvitationRecord | undefined>;
	storeInvitation(record: InvitationRecord): Promise<void>;
	deleteInvitation(invitationId: string): Promise<void>;
	listPending(): Promise<readonly PendingPeerRecord[]>;
	getPending(enrollmentId: string): Promise<PendingPeerRecord | undefined>;
	storePending(record: PendingPeerRecord): Promise<void>;
	deletePending(enrollmentId: string): Promise<void>;
	listPeers(): Promise<readonly PeerRecord[]>;
	getPeer(peerId: string): Promise<PeerRecord | undefined>;
	commitPeer(record: PeerRecord, pending: PendingPeerRecord): Promise<boolean>;
	completePeerCleanup(peerId: string, enrollmentId: string): Promise<boolean>;
}

export class InMemoryPairingRecordStore implements PairingRecordStore {
	private readonly invitations = new Map<string, InvitationRecord>();
	private readonly pending = new Map<string, PendingPeerRecord>();
	private readonly peers = new Map<string, PeerRecord>();

	public async listInvitations(): Promise<readonly InvitationRecord[]> {
		return [...this.invitations.values()];
	}
	public async getInvitation(id: string): Promise<InvitationRecord | undefined> {
		return this.invitations.get(id);
	}
	public async storeInvitation(record: InvitationRecord): Promise<void> {
		this.invitations.set(record.invitationId, record);
	}
	public async deleteInvitation(id: string): Promise<void> {
		this.invitations.delete(id);
	}
	public async listPending(): Promise<readonly PendingPeerRecord[]> {
		return [...this.pending.values()];
	}
	public async getPending(id: string): Promise<PendingPeerRecord | undefined> {
		return this.pending.get(id);
	}
	public async storePending(record: PendingPeerRecord): Promise<void> {
		this.pending.set(record.enrollmentId, record);
	}
	public async deletePending(id: string): Promise<void> {
		this.pending.delete(id);
	}
	public async getPeer(id: string): Promise<PeerRecord | undefined> {
		return this.peers.get(id);
	}
	public async listPeers(): Promise<readonly PeerRecord[]> {
		return [...this.peers.values()];
	}
	public async commitPeer(record: PeerRecord, pending: PendingPeerRecord): Promise<boolean> {
		const invitation = this.invitations.get(pending.invitationId);
		if (invitation === undefined
			|| record.cleanupPending !== true
			|| record.invitationSecretKeyRef !== invitation.secretKeyRef) {
			return false;
		}
		this.peers.set(record.peerId, record);
		this.invitations.delete(pending.invitationId);
		this.pending.delete(pending.enrollmentId);
		return true;
	}
	public async completePeerCleanup(peerId: string, enrollmentId: string): Promise<boolean> {
		const peer = this.peers.get(peerId);
		if (peer === undefined || peer.enrollmentId !== enrollmentId) {
			return false;
		}
		const {
			invitationSecretKeyRef: _invitationSecretKeyRef,
			cleanupPending: _cleanupPending,
			...completed
		} = peer;
		this.peers.set(peerId, completed);
		return true;
	}
}

interface EnrollmentSession {
	readonly mode: 'enrollment';
	readonly connectionId: string;
	readonly expiresAt: number;
	readonly transcript: EnrollmentTranscript;
	readonly secret: Buffer;
	readonly expirationTimer: NodeJS.Timeout;
	failures: number;
	enrollmentId?: string;
	peerId?: string;
}

interface ReconnectSession {
	readonly mode: 'reconnect';
	readonly connectionId: string;
	readonly expiresAt: number;
	readonly transcript: ReconnectTranscript;
	readonly rootKey: Buffer;
	readonly expirationTimer: NodeJS.Timeout;
	failures: number;
}

type AuthenticationSession = EnrollmentSession | ReconnectSession;
type AuthenticationSessionWithoutTimer =
	| Omit<EnrollmentSession, 'expirationTimer'>
	| Omit<ReconnectSession, 'expirationTimer'>;

export interface PairingServiceOptions {
	readonly invitationTtlMs?: number;
	readonly pendingTtlMs?: number;
	readonly handshakeTtlMs?: number;
	readonly maxInvitations?: number;
	readonly now?: () => number;
	readonly id?: () => string;
}

export interface CreatedInvitation {
	readonly invitationId: string;
	readonly expiresAt: number;
	readonly url: string;
}

export type HelloParams = {
	readonly protocolMin: number;
	readonly protocolMax: number;
	readonly coordinatorDeviceId: string;
	readonly clientNonce: string;
	readonly invitationId?: string;
	readonly peerId?: string;
};

export class PairingService {
	private readonly invitationTtlMs: number;
	private readonly pendingTtlMs: number;
	private readonly handshakeTtlMs: number;
	private readonly maxInvitations: number;
	private readonly now: () => number;
	private readonly id: () => string;
	private readonly sessions = new Map<string, AuthenticationSession>();
	private readonly usedNonces = new Map<string, number>();
	private readonly activeConnections = new Set<string>();
	private readonly closedConnections = new Set<string>();
	private readonly connectionGenerations = new Map<string, number>();
	private readonly inFlightHellos = new Map<string, number>();
	private recordMutation = Promise.resolve();

	public constructor(
		public readonly workerDeviceId: string,
		private readonly secretStore: SecretStore,
		private readonly records: PairingRecordStore,
		options: PairingServiceOptions = {},
	) {
		this.invitationTtlMs = options.invitationTtlMs ?? 10 * 60_000;
		this.pendingTtlMs = options.pendingTtlMs ?? 10 * 60_000;
		this.handshakeTtlMs = options.handshakeTtlMs ?? 30_000;
		this.maxInvitations = options.maxInvitations ?? 5;
		this.now = options.now ?? Date.now;
		this.id = options.id ?? randomUUID;
	}

	public async createInvitation(origin: string): Promise<CreatedInvitation> {
		return this.mutateRecords(() => this.createInvitationLocked(origin));
	}

	private async createInvitationLocked(origin: string): Promise<CreatedInvitation> {
		const url = new URL(origin);
		if (url.protocol !== 'https:' && url.protocol !== 'wss:') {
			throw new PairingProtocolError('INVALID_ORIGIN', 'Pairing origin must be secure.');
		}
		const now = this.now();
		await this.pruneExpiredRecords(now);
		const invitations = await this.records.listInvitations();
		const live = invitations.filter((record) => record.expiresAt > now);
		if (live.length >= this.maxInvitations) {
			throw new PairingProtocolError('INVITATION_LIMIT', 'Too many live pairing invitations.');
		}
		const invitationId = this.id();
		const secret = randomBase64Url(SECRET_BYTES);
		const secretKeyRef = `mesh.invitation.${invitationId}`;
		const expiresAt = now + this.invitationTtlMs;
		await this.secretStore.store(secretKeyRef, secret);
		try {
			await this.records.storeInvitation({ invitationId, expiresAt, secretKeyRef });
		} catch (error: unknown) {
			await this.secretStore.delete(secretKeyRef);
			throw error;
		}
		url.pathname = '/agent-mesh/connect';
		url.search = new URLSearchParams({
			v: String(MESH_PROTOCOL_VERSION),
			device: this.workerDeviceId,
			invite: invitationId,
		}).toString();
		url.hash = new URLSearchParams({ secret }).toString();
		return { invitationId, expiresAt, url: url.toString() };
	}

	public async revokeInvitation(invitationId: string): Promise<void> {
		await this.mutateRecords(async () => {
			const record = await this.records.getInvitation(invitationId);
			if (record !== undefined) {
				await this.secretStore.delete(record.secretKeyRef);
				await this.records.deleteInvitation(invitationId);
			}
		});
	}

	public registerConnection(connectionId: string): void {
		this.closedConnections.delete(connectionId);
		this.activeConnections.add(connectionId);
		this.connectionGenerations.set(
			connectionId,
			(this.connectionGenerations.get(connectionId) ?? 0) + 1,
		);
	}

	public async hello(connectionId: string, params: HelloParams): Promise<Record<string, unknown>> {
		this.assertHello(params);
		const generation = this.beginHello(connectionId);
		try {
			return await this.helloCore(connectionId, params, generation);
		} finally {
			this.endHello(connectionId);
		}
	}

	private async helloCore(
		connectionId: string,
		params: HelloParams,
		generation: number,
	): Promise<Record<string, unknown>> {
		await this.prune();
		this.assertConnectionOpen(connectionId, generation);
		if (
			params.protocolMin > MESH_PROTOCOL_VERSION
			|| params.protocolMax < MESH_PROTOCOL_VERSION
		) {
			throw new PairingProtocolError('PROTOCOL_INCOMPATIBLE', 'No compatible Mesh protocol version.');
		}
		this.consumeNonce(params.clientNonce);
		if ((params.invitationId === undefined) === (params.peerId === undefined)) {
			throw new PairingProtocolError('INVALID_PARAMS', 'Exactly one authentication mode is required.');
		}
		const sessionId = this.id();
		const serverNonce = randomBase64Url(NONCE_BYTES);
		const expiresAt = this.now() + this.handshakeTtlMs;
		if (params.invitationId !== undefined) {
			const invitation = await this.records.getInvitation(params.invitationId);
			this.assertConnectionOpen(connectionId, generation);
			if (invitation === undefined || invitation.expiresAt <= this.now()) {
				throw new PairingProtocolError('AUTH_FAILED', 'Pairing authentication failed.');
			}
			const encodedSecret = await this.secretStore.get(invitation.secretKeyRef);
			this.assertConnectionOpen(connectionId, generation);
			if (encodedSecret === undefined) {
				throw new PairingProtocolError('AUTH_FAILED', 'Pairing authentication failed.');
			}
			const secret = decodeFixedBase64Url(encodedSecret, SECRET_BYTES, 'pairing secret');
			const transcript: EnrollmentTranscript = {
				version: MESH_PROTOCOL_VERSION,
				invitationId: invitation.invitationId,
				workerDeviceId: this.workerDeviceId,
				coordinatorDeviceId: params.coordinatorDeviceId,
				sessionId,
				clientNonce: params.clientNonce,
				serverNonce,
			};
			this.assertConnectionOpen(connectionId, generation);
			this.storeSession(sessionId, {
				mode: 'enrollment',
				connectionId,
				expiresAt,
				transcript,
				secret,
				failures: 0,
			});
			return {
				mode: 'enrollment',
				version: MESH_PROTOCOL_VERSION,
				workerDeviceId: this.workerDeviceId,
				sessionId,
				serverNonce,
				serverProof: encodeBase64Url(enrollmentProof(secret, 'mesh/server-proof/v1', transcript)),
			};
		}
		const peer = await this.records.getPeer(params.peerId!);
		this.assertConnectionOpen(connectionId, generation);
		if (peer === undefined || peer.coordinatorDeviceId !== params.coordinatorDeviceId) {
			throw new PairingProtocolError('AUTH_FAILED', 'Peer authentication failed.');
		}
		const encodedRoot = await this.secretStore.get(peer.rootKeyRef);
		this.assertConnectionOpen(connectionId, generation);
		if (encodedRoot === undefined) {
			throw new PairingProtocolError('AUTH_FAILED', 'Peer authentication failed.');
		}
		const rootKey = decodeFixedBase64Url(encodedRoot, SECRET_BYTES, 'peer credential');
		const transcript: ReconnectTranscript = {
			version: MESH_PROTOCOL_VERSION,
			peerId: peer.peerId,
			workerDeviceId: this.workerDeviceId,
			coordinatorDeviceId: params.coordinatorDeviceId,
			sessionId,
			clientNonce: params.clientNonce,
			serverNonce,
		};
		this.assertConnectionOpen(connectionId, generation);
		this.storeSession(sessionId, {
			mode: 'reconnect',
			connectionId,
			expiresAt,
			transcript,
			rootKey,
			failures: 0,
		});
		return {
			mode: 'reconnect',
			version: MESH_PROTOCOL_VERSION,
			workerDeviceId: this.workerDeviceId,
			sessionId,
			serverNonce,
			serverProof: encodeBase64Url(reconnectProof(
				rootKey,
				'mesh/reconnect-server-proof/v1',
				transcript,
			)),
		};
	}

	public async authenticate(
		connectionId: string,
		sessionId: string,
		encodedProof: string,
	): Promise<{ readonly result: Record<string, unknown>; readonly peerId?: string }> {
		const session = this.getSession(connectionId, sessionId);
		let proof: Buffer;
		try {
			proof = decodeFixedBase64Url(encodedProof, 32, 'proof');
		} catch {
			this.authenticationFailed(sessionId, session);
		}
		if (session.mode === 'reconnect') {
			const expected = reconnectProof(
				session.rootKey,
				'mesh/reconnect-client-proof/v1',
				session.transcript,
			);
			if (!safeEqual(proof, expected)) {
				this.authenticationFailed(sessionId, session);
			}
			this.deleteSession(sessionId);
			return {
				result: { authenticated: true, peerId: session.transcript.peerId },
				peerId: session.transcript.peerId,
			};
		}
		const expected = enrollmentProof(session.secret, 'mesh/client-proof/v1', session.transcript);
		if (!safeEqual(proof, expected)) {
			this.authenticationFailed(sessionId, session);
		}
		const peerId = session.peerId ?? this.id();
		const enrollmentId = session.enrollmentId ?? this.id();
		const hash = enrollmentTranscriptHash(session.transcript);
		const rootKey = derivePeerRoot(session.secret, session.transcript);
		const rootKeyRef = `mesh.peer.${peerId}`;
		const pendingExpiresAt = this.now() + this.pendingTtlMs;
		await this.secretStore.store(rootKeyRef, encodeBase64Url(rootKey));
		try {
			await this.records.storePending({
				enrollmentId,
				peerId,
				coordinatorDeviceId: session.transcript.coordinatorDeviceId,
				invitationId: session.transcript.invitationId,
				transcriptHash: encodeBase64Url(hash),
				rootKeyRef,
				expiresAt: pendingExpiresAt,
			});
		} catch (error: unknown) {
			await this.secretStore.delete(rootKeyRef);
			throw error;
		}
		session.enrollmentId = enrollmentId;
		session.peerId = peerId;
		return {
			result: {
				enrollmentId,
				peerId,
				expiresAt: pendingExpiresAt,
				pendingProof: encodeBase64Url(hmac(
					rootKey,
					'mesh/enrollment-pending/v1',
					enrollmentId,
					hash,
				)),
			},
		};
	}

	public async commit(
		connectionId: string,
		sessionId: string | undefined,
		enrollmentId: string,
		peerId: string,
		encodedProof: string,
	): Promise<string> {
		return this.mutateRecords(() => this.commitLocked(
			connectionId,
			sessionId,
			enrollmentId,
			peerId,
			encodedProof,
		));
	}

	private async commitLocked(
		connectionId: string,
		sessionId: string | undefined,
		enrollmentId: string,
		peerId: string,
		encodedProof: string,
	): Promise<string> {
		const session = sessionId === undefined || !this.sessions.has(sessionId)
			? undefined
			: this.getSession(connectionId, sessionId);
		if (session !== undefined && (
			session.mode !== 'enrollment'
			|| session.enrollmentId !== enrollmentId
			|| session.peerId !== peerId
		)) {
			throw new PairingProtocolError('AUTH_FAILED', 'Enrollment commit failed.');
		}
		const pending = await this.records.getPending(enrollmentId);
		if (pending === undefined) {
			const active = await this.records.getPeer(peerId);
			if (active === undefined || active.enrollmentId !== enrollmentId) {
				throw new PairingProtocolError(
					'ENROLLMENT_EXPIRED',
					'Enrollment confirmation expired; pairing is required again.',
				);
			}
			await this.verifyCommitProof(active, enrollmentId, encodedProof, sessionId, session);
			await this.cleanupCommittedPeer(active);
			if (sessionId !== undefined) {
				this.deleteSession(sessionId);
			}
			return active.peerId;
		}
		if (pending.peerId !== peerId) {
			throw new PairingProtocolError('AUTH_FAILED', 'Enrollment commit failed.');
		}
		if (pending.expiresAt <= this.now()) {
			throw new PairingProtocolError(
				'ENROLLMENT_EXPIRED',
				'Enrollment confirmation expired; pairing is required again.',
			);
		}
		await this.verifyCommitProof(pending, enrollmentId, encodedProof, sessionId, session);
		const invitation = await this.records.getInvitation(pending.invitationId);
		const peer: PeerRecord = {
			peerId: pending.peerId,
			coordinatorDeviceId: pending.coordinatorDeviceId,
			rootKeyRef: pending.rootKeyRef,
			enrollmentId: pending.enrollmentId,
			transcriptHash: pending.transcriptHash,
			createdAt: this.now(),
			invitationSecretKeyRef: invitation?.secretKeyRef,
			cleanupPending: invitation !== undefined,
		};
		if (!await this.records.commitPeer(peer, pending)) {
			const active = await this.records.getPeer(peerId);
			if (active === undefined
				|| active.enrollmentId !== enrollmentId
				|| active.rootKeyRef !== pending.rootKeyRef) {
				throw new PairingProtocolError('AUTH_FAILED', 'Enrollment invitation was already consumed.');
			}
			await this.cleanupCommittedPeer(active);
		} else {
			await this.cleanupCommittedPeer(peer);
		}
		if (sessionId !== undefined) {
			this.deleteSession(sessionId);
		}
		return pending.peerId;
	}

	public disposeConnection(connectionId: string): void {
		this.activeConnections.delete(connectionId);
		this.closedConnections.add(connectionId);
		this.connectionGenerations.set(
			connectionId,
			(this.connectionGenerations.get(connectionId) ?? 0) + 1,
		);
		for (const [id, session] of this.sessions) {
			if (session.connectionId === connectionId) {
				this.deleteSession(id);
			}
		}
		this.cleanupConnectionState(connectionId);
	}

	public async dispose(): Promise<void> {
		await this.recordMutation;
		for (const sessionId of [...this.sessions.keys()]) {
			this.deleteSession(sessionId);
		}
		this.usedNonces.clear();
		this.activeConnections.clear();
		this.closedConnections.clear();
		this.connectionGenerations.clear();
		this.inFlightHellos.clear();
	}

	private assertHello(params: HelloParams): void {
		const keys = Object.keys(params);
		if (keys.some((key) => ![
			'protocolMin', 'protocolMax', 'coordinatorDeviceId', 'clientNonce', 'invitationId', 'peerId',
		].includes(key))
			|| !Number.isInteger(params.protocolMin)
			|| !Number.isInteger(params.protocolMax)
			|| !isIdentifier(params.coordinatorDeviceId)
			|| (params.invitationId !== undefined && !isIdentifier(params.invitationId))
			|| (params.peerId !== undefined && !isIdentifier(params.peerId))) {
			throw new PairingProtocolError('INVALID_PARAMS', 'Invalid hello parameters.');
		}
		decodeFixedBase64Url(params.clientNonce, NONCE_BYTES, 'client nonce');
	}

	private consumeNonce(nonce: string): void {
		if (this.usedNonces.has(nonce)) {
			throw new PairingProtocolError('AUTH_FAILED', 'Authentication nonce was already used.');
		}
		this.usedNonces.set(nonce, this.now() + this.handshakeTtlMs);
	}

	private getSession(connectionId: string, sessionId: string): AuthenticationSession {
		const session = this.sessions.get(sessionId);
		if (session === undefined
			|| session.connectionId !== connectionId
			|| session.expiresAt <= this.now()) {
			if (session !== undefined && session.expiresAt <= this.now()) {
				this.deleteSession(sessionId);
			}
			throw new PairingProtocolError('AUTH_FAILED', 'Authentication session is invalid.');
		}
		return session;
	}

	private authenticationFailed(sessionId: string, session: AuthenticationSession): never {
		session.failures += 1;
		if (session.failures >= 5) {
			this.deleteSession(sessionId);
		}
		throw new PairingProtocolError('AUTH_FAILED', 'Authentication proof is invalid.');
	}

	private async verifyCommitProof(
		record: Pick<PendingPeerRecord, 'rootKeyRef' | 'transcriptHash'>,
		enrollmentId: string,
		encodedProof: string,
		sessionId?: string,
		session?: AuthenticationSession,
	): Promise<void> {
		const encodedRoot = await this.secretStore.get(record.rootKeyRef);
		if (encodedRoot === undefined) {
			throw new PairingProtocolError('AUTH_FAILED', 'Enrollment commit failed.');
		}
		const rootKey = decodeFixedBase64Url(encodedRoot, SECRET_BYTES, 'peer credential');
		const hash = decodeFixedBase64Url(record.transcriptHash, 32, 'transcript hash');
		const expected = hmac(rootKey, 'mesh/enrollment-commit/v1', enrollmentId, hash);
		let proof: Buffer;
		try {
			proof = decodeFixedBase64Url(encodedProof, 32, 'commit proof');
		} catch {
			if (sessionId !== undefined && session !== undefined) {
				this.authenticationFailed(sessionId, session);
			}
			throw new PairingProtocolError('AUTH_FAILED', 'Enrollment commit failed.');
		}
		if (!safeEqual(proof, expected)) {
			if (sessionId !== undefined && session !== undefined) {
				this.authenticationFailed(sessionId, session);
			}
			throw new PairingProtocolError('AUTH_FAILED', 'Enrollment commit failed.');
		}
	}

	private async prune(): Promise<void> {
		const now = this.now();
		await this.mutateRecords(() => this.pruneExpiredRecords(now));
		for (const [nonce, expiresAt] of this.usedNonces) {
			if (expiresAt <= now) {
				this.usedNonces.delete(nonce);
			}
		}
		for (const [id, session] of this.sessions) {
			if (session.expiresAt <= now) {
				this.deleteSession(id);
			}
		}
	}

	private async cleanupCommittedPeer(peer: PeerRecord): Promise<void> {
		if (peer.cleanupPending !== true) {
			return;
		}
		if (peer.invitationSecretKeyRef !== undefined) {
			await this.secretStore.delete(peer.invitationSecretKeyRef);
		}
		if (!await this.records.completePeerCleanup(peer.peerId, peer.enrollmentId)) {
			throw new Error('Failed to persist peer credential cleanup.');
		}
	}

	private storeSession(
		sessionId: string,
		session: AuthenticationSessionWithoutTimer,
	): void {
		this.deleteSession(sessionId);
		const expirationTimer = setTimeout(() => {
			const current = this.sessions.get(sessionId);
			if (current?.expirationTimer === expirationTimer) {
				this.sessions.delete(sessionId);
			}
		}, Math.max(0, session.expiresAt - this.now()));
		expirationTimer.unref();
		this.sessions.set(sessionId, { ...session, expirationTimer } as AuthenticationSession);
	}

	private deleteSession(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session !== undefined) {
			clearTimeout(session.expirationTimer);
			this.sessions.delete(sessionId);
		}
	}

	private assertConnectionOpen(connectionId: string, generation: number): void {
		if (!this.activeConnections.has(connectionId)
			|| this.closedConnections.has(connectionId)
			|| (this.connectionGenerations.get(connectionId) ?? 0) !== generation) {
			throw new PairingProtocolError('AUTH_FAILED', 'Authentication connection is closed.');
		}
	}

	private beginHello(connectionId: string): number {
		const generation = this.connectionGenerations.get(connectionId);
		if (generation === undefined) {
			throw new PairingProtocolError('AUTH_FAILED', 'Authentication connection is closed.');
		}
		this.assertConnectionOpen(connectionId, generation);
		this.inFlightHellos.set(
			connectionId,
			(this.inFlightHellos.get(connectionId) ?? 0) + 1,
		);
		return generation;
	}

	private endHello(connectionId: string): void {
		const remaining = (this.inFlightHellos.get(connectionId) ?? 1) - 1;
		if (remaining > 0) {
			this.inFlightHellos.set(connectionId, remaining);
			return;
		}
		this.inFlightHellos.delete(connectionId);
		this.cleanupConnectionState(connectionId);
	}

	private cleanupConnectionState(connectionId: string): void {
		if (this.activeConnections.has(connectionId)
			|| (this.inFlightHellos.get(connectionId) ?? 0) > 0) {
			return;
		}
		this.closedConnections.delete(connectionId);
		this.connectionGenerations.delete(connectionId);
	}

	private async pruneExpiredRecords(now: number): Promise<void> {
		for (const peer of await this.records.listPeers()) {
			if (peer.cleanupPending === true) {
				await this.cleanupCommittedPeer(peer);
			}
		}
		for (const invitation of await this.records.listInvitations()) {
			if (invitation.expiresAt <= now) {
				await this.secretStore.delete(invitation.secretKeyRef);
				await this.records.deleteInvitation(invitation.invitationId);
			}
		}
		for (const pending of await this.records.listPending()) {
			if (pending.expiresAt <= now) {
				const active = await this.records.getPeer(pending.peerId);
				if (active === undefined || active.rootKeyRef !== pending.rootKeyRef) {
					await this.secretStore.delete(pending.rootKeyRef);
				}
				await this.records.deletePending(pending.enrollmentId);
			}
		}
	}

	private async mutateRecords<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.recordMutation;
		let release!: () => void;
		this.recordMutation = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

function isIdentifier(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length >= 1
		&& value.length <= 128
		&& /^[A-Za-z0-9._~-]+$/u.test(value);
}
