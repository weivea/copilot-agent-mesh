export type PeerConnectionState =
	| 'connecting'
	| 'online'
	| 'busy'
	| 'offline'
	| 'authFailed'
	| 'incompatible';

export interface PeerProfile {
	readonly id: string;
	readonly rpcEndpoint: string;
	readonly workerDeviceId: string;
	readonly invitationId?: string;
	readonly pairingSecretKeyRef?: string;
	readonly peerId?: string;
	readonly credentialKeyRef?: string;
}

export interface PeerProfileStore {
	get(id: string): Promise<PeerProfile | undefined>;
	list(): Promise<readonly PeerProfile[]>;
	store(profile: PeerProfile): Promise<void>;
	delete(id: string): Promise<void>;
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
	public async delete(id: string): Promise<void> {
		this.profiles.delete(id);
	}
}
