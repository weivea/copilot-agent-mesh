export type PeerConnectionState =
	| 'connecting'
	| 'online'
	| 'busy'
	| 'offline'
	| 'authFailed'
	| 'incompatible'
	| 'rePairRequired';

export interface PeerProfile {
	readonly id: string;
	readonly generation?: string;
	readonly rpcEndpoint: string;
	readonly workerDeviceId: string;
	readonly cleanupPending?: true;
	readonly invitationId?: string;
	readonly pairingSecretKeyRef?: string;
	readonly peerId?: string;
	readonly credentialKeyRef?: string;
	readonly pendingEnrollmentId?: string;
	readonly pendingTranscriptHash?: string;
	readonly pendingCommitProofKeyRef?: string;
	readonly pendingExpiresAt?: number;
}

export interface PeerProfileDeleteCondition {
	readonly generation?: string;
	readonly cleanupPending?: true;
	readonly pairingSecretKeyRef?: string;
	readonly credentialKeyRef?: string;
	readonly pendingCommitProofKeyRef?: string;
}

export interface PeerProfileStore {
	get(id: string): Promise<PeerProfile | undefined>;
	list(): Promise<readonly PeerProfile[]>;
	store(profile: PeerProfile): Promise<void>;
	storeIfAbsent?(profile: PeerProfile): Promise<boolean>;
	replace?(profile: PeerProfile, expected: PeerProfileDeleteCondition): Promise<boolean>;
	delete(id: string, expected?: PeerProfileDeleteCondition): Promise<boolean | void>;
}

export class InMemoryPeerProfileStore implements PeerProfileStore {
	private readonly profiles = new Map<string, PeerProfile>();

	public async get(id: string): Promise<PeerProfile | undefined> {
		return this.profiles.get(id);
	}
	public async list(): Promise<readonly PeerProfile[]> {
		return [...this.profiles.values()];
	}
	public async store(profile: PeerProfile): Promise<void> {
		this.profiles.set(profile.id, structuredClone(profile));
	}
	public async storeIfAbsent(profile: PeerProfile): Promise<boolean> {
		if (this.profiles.has(profile.id)) {
			return false;
		}
		this.profiles.set(profile.id, structuredClone(profile));
		return true;
	}
	public async replace(
		profile: PeerProfile,
		expected: PeerProfileDeleteCondition,
	): Promise<boolean> {
		const current = this.profiles.get(profile.id);
		if (current === undefined || !matchesDeleteCondition(current, expected)) {
			return false;
		}
		this.profiles.set(profile.id, structuredClone(profile));
		return true;
	}
	public async delete(id: string, expected?: PeerProfileDeleteCondition): Promise<boolean> {
		const current = this.profiles.get(id);
		if (current === undefined || !matchesDeleteCondition(current, expected)) {
			return false;
		}
		return this.profiles.delete(id);
	}
}

export function matchesDeleteCondition(
	profile: PeerProfile,
	expected: PeerProfileDeleteCondition | undefined,
): boolean {
	return expected === undefined || (
		profile.generation === expected.generation
		&& profile.cleanupPending === expected.cleanupPending
		&& profile.pairingSecretKeyRef === expected.pairingSecretKeyRef
		&& profile.credentialKeyRef === expected.credentialKeyRef
		&& profile.pendingCommitProofKeyRef === expected.pendingCommitProofKeyRef
	);
}

export function isPeerCleanupPending(profile: PeerProfile): boolean {
	const marker = (profile as { readonly cleanupPending?: unknown }).cleanupPending;
	if (marker === undefined) {
		return false;
	}
	if (marker !== true) {
		throw new TypeError('Invalid persisted peer cleanup metadata.');
	}
	const allowed = new Set([
		'id',
		'generation',
		'rpcEndpoint',
		'workerDeviceId',
		'cleanupPending',
		'pairingSecretKeyRef',
		'credentialKeyRef',
		'pendingCommitProofKeyRef',
	]);
	if (
		Object.keys(profile).some((key) => !allowed.has(key))
		|| !nonEmptyString(profile.id)
		|| !nonEmptyString(profile.rpcEndpoint)
		|| !nonEmptyString(profile.workerDeviceId)
		|| !optionalString(profile.generation)
		|| !optionalString(profile.pairingSecretKeyRef)
		|| !optionalString(profile.credentialKeyRef)
		|| !optionalString(profile.pendingCommitProofKeyRef)
	) {
		throw new TypeError('Invalid persisted peer cleanup metadata.');
	}
	return true;
}

export function isUsablePeerProfile(profile: PeerProfile): boolean {
	return !isPeerCleanupPending(profile);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function optionalString(value: unknown): boolean {
	return value === undefined || nonEmptyString(value);
}
