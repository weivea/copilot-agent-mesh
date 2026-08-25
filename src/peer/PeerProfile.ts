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
	readonly pairingSecretKeyRef?: string;
	readonly credentialKeyRef?: string;
	readonly pendingCommitProofKeyRef?: string;
}

export interface PeerProfileStore {
	get(id: string): Promise<PeerProfile | undefined>;
	list(): Promise<readonly PeerProfile[]>;
	store(profile: PeerProfile): Promise<void>;
	storeIfAbsent?(profile: PeerProfile): Promise<boolean>;
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
		&& profile.pairingSecretKeyRef === expected.pairingSecretKeyRef
		&& profile.credentialKeyRef === expected.credentialKeyRef
		&& profile.pendingCommitProofKeyRef === expected.pendingCommitProofKeyRef
	);
}
