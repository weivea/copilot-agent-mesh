import { randomUUID } from 'node:crypto';

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
	readonly createdAt: number;
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
	getPeer(peerId: string): Promise<PeerRecord | undefined>;
	commitPeer(record: PeerRecord, pending: PendingPeerRecord): Promise<boolean>;
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
	public async commitPeer(record: PeerRecord, pending: PendingPeerRecord): Promise<boolean> {
		if (!this.invitations.has(pending.invitationId)) {
			return false;
		}
		this.peers.set(record.peerId, record);
		this.invitations.delete(pending.invitationId);
		this.pending.delete(pending.enrollmentId);
		return true;
	}
}

interface EnrollmentSession {
	readonly mode: 'enrollment';
	readonly connectionId: string;
	readonly expiresAt: number;
	readonly transcript: EnrollmentTranscript;
	readonly secret: Buffer;
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
	failures: number;
}

type AuthenticationSession = EnrollmentSession | ReconnectSession;

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
	private invitationCreation = Promise.resolve();

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
		const previous = this.invitationCreation;
		let release!: () => void;
		this.invitationCreation = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await this.createInvitationLocked(origin);
		} finally {
			release();
		}
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
			v: '1',
			device: this.workerDeviceId,
			invite: invitationId,
		}).toString();
		url.hash = new URLSearchParams({ secret }).toString();
		return { invitationId, expiresAt, url: url.toString() };
	}

	public async revokeInvitation(invitationId: string): Promise<void> {
		const record = await this.records.getInvitation(invitationId);
		if (record !== undefined) {
			await this.secretStore.delete(record.secretKeyRef);
			await this.records.deleteInvitation(invitationId);
		}
	}

	public async hello(connectionId: string, params: HelloParams): Promise<Record<string, unknown>> {
		this.assertHello(params);
		await this.prune();
		if (params.protocolMin > 1 || params.protocolMax < 1) {
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
			if (invitation === undefined || invitation.expiresAt <= this.now()) {
				throw new PairingProtocolError('AUTH_FAILED', 'Pairing authentication failed.');
			}
			const encodedSecret = await this.secretStore.get(invitation.secretKeyRef);
			if (encodedSecret === undefined) {
				throw new PairingProtocolError('AUTH_FAILED', 'Pairing authentication failed.');
			}
			const secret = decodeFixedBase64Url(encodedSecret, SECRET_BYTES, 'pairing secret');
			const transcript: EnrollmentTranscript = {
				version: 1,
				invitationId: invitation.invitationId,
				workerDeviceId: this.workerDeviceId,
				coordinatorDeviceId: params.coordinatorDeviceId,
				sessionId,
				clientNonce: params.clientNonce,
				serverNonce,
			};
			this.sessions.set(sessionId, {
				mode: 'enrollment', connectionId, expiresAt, transcript, secret, failures: 0,
			});
			return {
				mode: 'enrollment',
				version: 1,
				workerDeviceId: this.workerDeviceId,
				sessionId,
				serverNonce,
				serverProof: encodeBase64Url(enrollmentProof(secret, 'mesh/server-proof/v1', transcript)),
			};
		}
		const peer = await this.records.getPeer(params.peerId!);
		if (peer === undefined || peer.coordinatorDeviceId !== params.coordinatorDeviceId) {
			throw new PairingProtocolError('AUTH_FAILED', 'Peer authentication failed.');
		}
		const encodedRoot = await this.secretStore.get(peer.rootKeyRef);
		if (encodedRoot === undefined) {
			throw new PairingProtocolError('AUTH_FAILED', 'Peer authentication failed.');
		}
		const rootKey = decodeFixedBase64Url(encodedRoot, SECRET_BYTES, 'peer credential');
		const transcript: ReconnectTranscript = {
			version: 1,
			peerId: peer.peerId,
			workerDeviceId: this.workerDeviceId,
			coordinatorDeviceId: params.coordinatorDeviceId,
			sessionId,
			clientNonce: params.clientNonce,
			serverNonce,
		};
		this.sessions.set(sessionId, {
			mode: 'reconnect', connectionId, expiresAt, transcript, rootKey, failures: 0,
		});
		return {
			mode: 'reconnect',
			version: 1,
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
			this.sessions.delete(sessionId);
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
		await this.secretStore.store(rootKeyRef, encodeBase64Url(rootKey));
		try {
			await this.records.storePending({
				enrollmentId,
				peerId,
				coordinatorDeviceId: session.transcript.coordinatorDeviceId,
				invitationId: session.transcript.invitationId,
				transcriptHash: encodeBase64Url(hash),
				rootKeyRef,
				expiresAt: this.now() + this.pendingTtlMs,
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
		sessionId: string,
		enrollmentId: string,
		encodedProof: string,
	): Promise<string> {
		const session = this.getSession(connectionId, sessionId);
		if (session.mode !== 'enrollment' || session.enrollmentId !== enrollmentId) {
			throw new PairingProtocolError('AUTH_FAILED', 'Enrollment commit failed.');
		}
		const pending = await this.records.getPending(enrollmentId);
		if (pending === undefined || pending.expiresAt <= this.now()) {
			throw new PairingProtocolError('AUTH_FAILED', 'Enrollment commit failed.');
		}
		const encodedRoot = await this.secretStore.get(pending.rootKeyRef);
		if (encodedRoot === undefined) {
			throw new PairingProtocolError('AUTH_FAILED', 'Enrollment commit failed.');
		}
		const rootKey = decodeFixedBase64Url(encodedRoot, SECRET_BYTES, 'peer credential');
		const hash = decodeFixedBase64Url(pending.transcriptHash, 32, 'transcript hash');
		const expected = hmac(rootKey, 'mesh/enrollment-commit/v1', enrollmentId, hash);
		let proof: Buffer;
		try {
			proof = decodeFixedBase64Url(encodedProof, 32, 'commit proof');
		} catch {
			this.authenticationFailed(sessionId, session);
		}
		if (!safeEqual(proof, expected)) {
			this.authenticationFailed(sessionId, session);
		}
		const peer: PeerRecord = {
			peerId: pending.peerId,
			coordinatorDeviceId: pending.coordinatorDeviceId,
			rootKeyRef: pending.rootKeyRef,
			createdAt: this.now(),
		};
		const invitation = await this.records.getInvitation(pending.invitationId);
		if (!await this.records.commitPeer(peer, pending)) {
			await this.secretStore.delete(pending.rootKeyRef);
			await this.records.deletePending(pending.enrollmentId);
			throw new PairingProtocolError('AUTH_FAILED', 'Enrollment invitation was already consumed.');
		}
		if (invitation !== undefined) {
			await this.secretStore.delete(invitation.secretKeyRef);
		}
		this.sessions.delete(sessionId);
		return pending.peerId;
	}

	public disposeConnection(connectionId: string): void {
		for (const [id, session] of this.sessions) {
			if (session.connectionId === connectionId) {
				this.sessions.delete(id);
			}
		}
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
			throw new PairingProtocolError('AUTH_FAILED', 'Authentication session is invalid.');
		}
		return session;
	}

	private authenticationFailed(sessionId: string, session: AuthenticationSession): never {
		session.failures += 1;
		if (session.failures >= 5) {
			this.sessions.delete(sessionId);
		}
		throw new PairingProtocolError('AUTH_FAILED', 'Authentication proof is invalid.');
	}

	private async prune(): Promise<void> {
		const now = this.now();
		await this.pruneExpiredRecords(now);
		for (const [nonce, expiresAt] of this.usedNonces) {
			if (expiresAt <= now) {
				this.usedNonces.delete(nonce);
			}
		}
		for (const [id, session] of this.sessions) {
			if (session.expiresAt <= now) {
				this.sessions.delete(id);
			}
		}
	}

	private async pruneExpiredRecords(now: number): Promise<void> {
		for (const invitation of await this.records.listInvitations()) {
			if (invitation.expiresAt <= now) {
				await this.secretStore.delete(invitation.secretKeyRef);
				await this.records.deleteInvitation(invitation.invitationId);
			}
		}
		for (const pending of await this.records.listPending()) {
			if (pending.expiresAt <= now) {
				await this.secretStore.delete(pending.rootKeyRef);
				await this.records.deletePending(pending.enrollmentId);
			}
		}
	}
}

function isIdentifier(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length >= 1
		&& value.length <= 128
		&& /^[A-Za-z0-9._~-]+$/u.test(value);
}
