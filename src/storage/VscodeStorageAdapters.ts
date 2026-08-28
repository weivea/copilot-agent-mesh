import type * as vscode from 'vscode';

import type { StateStore } from '../domain/ports';
import type {
	InvitationRecord,
	PairingRecordStore,
	PeerRecord,
	PendingPeerRecord,
} from '../gateway/PairingService';
import type { SecretStore } from '../gateway/SecretStore';
import {
	matchesDeleteCondition,
	type PeerProfile,
	type PeerProfileDeleteCondition,
	type PeerProfileStore,
} from '../peer/PeerProfile';
import type {
	DevTunnelStateStore,
	TunnelMetadata,
} from '../tunnel/DevTunnelProvider';

const pairingStateKey = 'copilotAgentMesh.pairingRecords';
const peerProfilesKey = 'copilotAgentMesh.peerProfiles';
const tunnelStateKey = 'copilotAgentMesh.tunnelMetadata';

export class VscodeGlobalStateStore implements StateStore {
	public constructor(private readonly state: vscode.Memento) {}

	public get<T>(key: string): T | undefined {
		return this.state.get<T>(key);
	}

	public update(key: string, value: unknown): Promise<void> {
		return Promise.resolve(this.state.update(key, value));
	}
}

export class VscodeSecretStore implements SecretStore {
	public constructor(private readonly secrets: vscode.SecretStorage) {}

	public get(key: string): Promise<string | undefined> {
		return Promise.resolve(this.secrets.get(key));
	}

	public store(key: string, value: string): Promise<void> {
		return Promise.resolve(this.secrets.store(key, value));
	}

	public delete(key: string): Promise<void> {
		return Promise.resolve(this.secrets.delete(key));
	}
}

interface PairingState {
	readonly schemaVersion: 1;
	readonly invitations: readonly InvitationRecord[];
	readonly pending: readonly PendingPeerRecord[];
	readonly peers: readonly PeerRecord[];
}

const emptyPairingState: PairingState = {
	schemaVersion: 1,
	invitations: [],
	pending: [],
	peers: [],
};

export class VscodePairingRecordStore implements PairingRecordStore {
	private mutation = Promise.resolve();

	public constructor(private readonly state: StateStore) {}

	public async listInvitations(): Promise<readonly InvitationRecord[]> {
		return this.read().invitations;
	}

	public async getInvitation(invitationId: string): Promise<InvitationRecord | undefined> {
		return this.read().invitations.find((record) => record.invitationId === invitationId);
	}

	public storeInvitation(record: InvitationRecord): Promise<void> {
		return this.mutate((current) => ({
			...current,
			invitations: replaceBy(current.invitations, record, 'invitationId'),
		}));
	}

	public deleteInvitation(invitationId: string): Promise<void> {
		return this.mutate((current) => ({
			...current,
			invitations: current.invitations.filter((record) => record.invitationId !== invitationId),
		}));
	}

	public async listPending(): Promise<readonly PendingPeerRecord[]> {
		return this.read().pending;
	}

	public async getPending(enrollmentId: string): Promise<PendingPeerRecord | undefined> {
		return this.read().pending.find((record) => record.enrollmentId === enrollmentId);
	}

	public storePending(record: PendingPeerRecord): Promise<void> {
		return this.mutate((current) => ({
			...current,
			pending: replaceBy(current.pending, record, 'enrollmentId'),
		}));
	}

	public deletePending(enrollmentId: string): Promise<void> {
		return this.mutate((current) => ({
			...current,
			pending: current.pending.filter((record) => record.enrollmentId !== enrollmentId),
		}));
	}

	public async listPeers(): Promise<readonly PeerRecord[]> {
		return this.read().peers;
	}

	public async getPeer(peerId: string): Promise<PeerRecord | undefined> {
		return this.read().peers.find((record) => record.peerId === peerId);
	}

	public commitPeer(record: PeerRecord, pending: PendingPeerRecord): Promise<boolean> {
		return this.mutateResult((current) => {
			const invitation = current.invitations.find(
				(candidate) => candidate.invitationId === pending.invitationId,
			);
			if (
				invitation === undefined
				|| record.cleanupPending !== true
				|| record.invitationSecretKeyRef !== invitation.secretKeyRef
			) {
				return { state: current, result: false };
			}
			return {
				state: {
					...current,
					invitations: current.invitations.filter(
						(candidate) => candidate.invitationId !== pending.invitationId,
					),
					pending: current.pending.filter(
						(candidate) => candidate.enrollmentId !== pending.enrollmentId,
					),
					peers: replaceBy(current.peers, record, 'peerId'),
				},
				result: true,
			};
		});
	}

	public completePeerCleanup(peerId: string, enrollmentId: string): Promise<boolean> {
		return this.mutateResult((current) => {
			const peer = current.peers.find((record) => record.peerId === peerId);
			if (peer === undefined || peer.enrollmentId !== enrollmentId) {
				return { state: current, result: false };
			}
			const {
				invitationSecretKeyRef: _invitationSecretKeyRef,
				cleanupPending: _cleanupPending,
				...completed
			} = peer;
			return {
				state: {
					...current,
					peers: replaceBy(current.peers, completed, 'peerId'),
				},
				result: true,
			};
		});
	}

	private read(): PairingState {
		const value = this.state.get<PairingState>(pairingStateKey);
		if (value === undefined) {
			return emptyPairingState;
		}
		if (
			value.schemaVersion !== 1
			|| !Array.isArray(value.invitations)
			|| !Array.isArray(value.pending)
			|| !Array.isArray(value.peers)
		) {
			throw new TypeError('Invalid persisted pairing metadata.');
		}
		return structuredClone(value);
	}

	private mutate(transform: (state: PairingState) => PairingState): Promise<void> {
		return this.mutateResult((state) => ({ state: transform(state), result: undefined }));
	}

	private mutateResult<T>(
		transform: (state: PairingState) => { readonly state: PairingState; readonly result: T },
	): Promise<T> {
		const operation = this.mutation.then(async () => {
			const transformed = transform(this.read());
			await this.state.update(pairingStateKey, transformed.state);
			return transformed.result;
		});
		this.mutation = operation.then(() => undefined, () => undefined);
		return operation;
	}
}

interface PeerProfileState {
	readonly schemaVersion: 1;
	readonly profiles: readonly PeerProfile[];
}

export class VscodePeerProfileStore implements PeerProfileStore {
	private mutation = Promise.resolve();

	public constructor(private readonly state: StateStore) {}

	public async get(id: string): Promise<PeerProfile | undefined> {
		return this.read().find((profile) => profile.id === id);
	}

	public async list(): Promise<readonly PeerProfile[]> {
		return this.read();
	}

	public store(profile: PeerProfile): Promise<void> {
		return this.mutate(async () => {
			const profiles = replaceBy(this.read(), profile, 'id');
			await this.state.update(peerProfilesKey, { schemaVersion: 1, profiles });
		});
	}

	public storeIfAbsent(profile: PeerProfile): Promise<boolean> {
		return this.mutate(async () => {
			const profiles = this.read();
			if (profiles.some((candidate) => candidate.id === profile.id)) {
				return false;
			}
			await this.state.update(peerProfilesKey, {
				schemaVersion: 1,
				profiles: [...profiles, structuredClone(profile)],
			});
			return true;
		});
	}

	public replace(
		profile: PeerProfile,
		expected: PeerProfileDeleteCondition,
	): Promise<boolean> {
		return this.mutate(async () => {
			const profiles = this.read();
			const current = profiles.find((candidate) => candidate.id === profile.id);
			if (current === undefined || !matchesDeleteCondition(current, expected)) {
				return false;
			}
			await this.state.update(peerProfilesKey, {
				schemaVersion: 1,
				profiles: replaceBy(profiles, profile, 'id'),
			});
			return true;
		});
	}

	public delete(id: string, expected?: PeerProfileDeleteCondition): Promise<boolean> {
		return this.mutate(async () => {
			const current = this.read();
			const profile = current.find((candidate) => candidate.id === id);
			if (profile === undefined || !matchesDeleteCondition(profile, expected)) {
				return false;
			}
			const profiles = current.filter((candidate) => candidate.id !== id);
			await this.state.update(peerProfilesKey, { schemaVersion: 1, profiles });
			return true;
		});
	}

	private read(): readonly PeerProfile[] {
		const value = this.state.get<PeerProfileState>(peerProfilesKey);
		if (value === undefined) {
			return [];
		}
		if (value.schemaVersion !== 1 || !Array.isArray(value.profiles)) {
			throw new TypeError('Invalid persisted peer profile metadata.');
		}
		return structuredClone(value.profiles);
	}

	private mutate<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutation.then(operation, operation);
		this.mutation = result.then(() => undefined, () => undefined);
		return result;
	}
}

export class VscodeDevTunnelStateStore implements DevTunnelStateStore {
	public constructor(private readonly state: StateStore) {}

	public async load(): Promise<TunnelMetadata | undefined> {
		return this.state.get<TunnelMetadata>(tunnelStateKey);
	}

	public save(metadata: TunnelMetadata): Promise<void> {
		return this.state.update(tunnelStateKey, metadata);
	}
}

function replaceBy<T, K extends keyof T>(
	values: readonly T[],
	value: T,
	key: K,
): readonly T[] {
	return [...values.filter((candidate) => candidate[key] !== value[key]), structuredClone(value)];
}
