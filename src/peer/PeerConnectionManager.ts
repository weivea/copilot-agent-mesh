import { randomUUID } from 'node:crypto';

import type { SecretStore } from '../gateway/SecretStore';
import { parseConnectionUrl } from './ConnectionUrl';
import { PeerConnection } from './PeerConnection';
import {
	isPeerCleanupPending,
	type PeerProfile,
	type PeerProfileDeleteCondition,
	type PeerProfileStore,
} from './PeerProfile';
import type { PeerTransport } from './WebSocketPeerTransport';
import type { WorkerOwnership } from '../storage/WorkerOwnerLock';

export interface PeerConnectionManagerOptions {
	readonly reconnectBaseMs?: number;
	readonly reconnectMaxMs?: number;
	readonly stableOnlineMs?: number;
	readonly random?: () => number;
	readonly id?: () => string;
	readonly ownership?: WorkerOwnership;
}

interface ManagedPeer {
	readonly connection: PeerConnection;
	enabled: boolean;
	provisional: boolean;
	readonly pairingSecretKeyRef?: string;
	readonly profileGeneration?: string;
	attempt: number;
	reconnectTimer?: NodeJS.Timeout;
	stableTimer?: NodeJS.Timeout;
}

export class PeerConnectionManager {
	private readonly peers = new Map<string, ManagedPeer>();
	private readonly inflight = new Set<Promise<unknown>>();
	private readonly reconnectBaseMs: number;
	private readonly reconnectMaxMs: number;
	private readonly stableOnlineMs: number;
	private readonly random: () => number;
	private readonly id: () => string;
	private readonly ownership: WorkerOwnership | undefined;
	private readonly backgroundFailures: unknown[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly notificationListeners = new Set<(
		profileId: string,
		method: string,
		params: Record<string, unknown>,
	) => void>();
	private disposed = false;
	private disposeComplete = false;
	private disposing: Promise<void> | undefined;

	public constructor(
		private readonly coordinatorDeviceId: string,
		private readonly profiles: PeerProfileStore,
		private readonly secrets: SecretStore,
		private readonly transport: PeerTransport,
		options: PeerConnectionManagerOptions = {},
	) {
		this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
		this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
		this.stableOnlineMs = options.stableOnlineMs ?? 30_000;
		this.random = options.random ?? Math.random;
		this.id = options.id ?? randomUUID;
		this.ownership = options.ownership;
	}

	public async add(connectionUrl: string): Promise<PeerConnection> {
		if (this.ownership !== undefined) {
			await this.ownership.assertOwner();
		}
		this.assertActive();
		return this.track(this.addCore(connectionUrl));
	}

	private async addCore(connectionUrl: string): Promise<PeerConnection> {
		const parsed = parseConnectionUrl(connectionUrl);
		const id = this.id();
		const pairingSecretKeyRef = `mesh.remoteInvitation.${id}`;
		const profile: PeerProfile = {
			id,
			generation: id,
			rpcEndpoint: parsed.rpcEndpoint,
			workerDeviceId: parsed.workerDeviceId,
			invitationId: parsed.invitationId,
			pairingSecretKeyRef,
		};
		try {
			await this.secrets.store(pairingSecretKeyRef, parsed.secret);
			this.assertActive();
			await this.profiles.store(profile);
			this.assertActive();
			const managed = this.createManaged(id, true, pairingSecretKeyRef, profile.generation);
			this.peers.set(id, managed);
			await managed.connection.connect();
			this.assertActive();
			managed.provisional = false;
			this.markStableLater(managed);
			return managed.connection;
		} catch (error: unknown) {
			if (this.disposed || !this.peers.has(id)) {
				await this.rollbackAddedPeer(id, pairingSecretKeyRef, id, profile);
			} else {
				const managed = this.peers.get(id);
				const state = managed?.connection.snapshot().state;
				if (state === 'authFailed' || state === 'incompatible') {
					await this.rollbackAddedPeer(id, pairingSecretKeyRef, id, profile);
				} else if (state === 'offline' && managed !== undefined) {
					this.scheduleReconnect(managed);
				}
			}
			throw error;
		}
	}

	public async restore(): Promise<void> {
		if (this.ownership !== undefined) {
			await this.ownership.assertOwner();
		}
		this.assertActive();
		return this.track(this.restoreCore());
	}

	private async restoreCore(): Promise<void> {
		const profiles = await this.profiles.list();
		this.assertActive();
		const cleanupFailures: unknown[] = [];
		for (const profile of profiles) {
			if (!isPeerCleanupPending(profile)) {
				continue;
			}
			try {
				await this.cleanupPendingProfile(profile);
			} catch (error: unknown) {
				cleanupFailures.push(error);
			}
			this.assertActive();
		}
		if (cleanupFailures.length > 0) {
			throw new AggregateError(cleanupFailures, 'Pending peer credential cleanup failed.');
		}
		for (const profile of profiles) {
			this.assertActive();
			if (isPeerCleanupPending(profile) || this.peers.has(profile.id)) {
				continue;
			}
			const managed = this.createManaged(
				profile.id,
				isProvisionalProfile(profile),
				profile.pairingSecretKeyRef,
				profile.generation,
			);
			this.assertActive();
			this.peers.set(profile.id, managed);
			this.launchTryConnect(managed);
		}
	}

	public get(profileId: string): PeerConnection | undefined {
		return this.peers.get(profileId)?.connection;
	}

	public listConnections(): readonly PeerConnection[] {
		return [...this.peers.values()].map(({ connection }) => connection);
	}

	public isEnabled(profileId: string): boolean {
		return this.peers.get(profileId)?.enabled === true;
	}

	public onDidChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public onNotification(
		listener: (
			profileId: string,
			method: string,
			params: Record<string, unknown>,
		) => void,
	): () => void {
		this.notificationListeners.add(listener);
		return () => this.notificationListeners.delete(listener);
	}

	public async connect(profileId: string): Promise<void> {
		if (this.ownership !== undefined) {
			await this.ownership.assertOwner();
		}
		this.assertActive();
		return this.track(this.connectCore(profileId));
	}

	private async connectCore(profileId: string): Promise<void> {
		const managed = await this.ensureManaged(profileId);
		this.assertActive();
		managed.enabled = true;
		this.clearReconnect(managed);
		await managed.connection.connect();
		managed.provisional = false;
		if (this.disposed) {
			await managed.connection.disconnect();
			this.assertActive();
		}
		this.markStableLater(managed);
	}

	public async disconnect(profileId: string): Promise<void> {
		if (this.ownership !== undefined) {
			await this.ownership.assertOwner();
		}
		const managed = this.peers.get(profileId);
		if (managed === undefined) {
			return;
		}
		managed.enabled = false;
		this.clearTimers(managed);
		await managed.connection.disconnect();
	}

	public async remove(profileId: string): Promise<void> {
		if (this.ownership !== undefined) {
			await this.ownership.assertOwner();
		}
		const managed = this.peers.get(profileId);
		if (managed !== undefined) {
			managed.enabled = false;
			this.clearTimers(managed);
			await managed.connection.disconnect();
			this.peers.delete(profileId);
		}
		const profile = await this.profiles.get(profileId);
		if (profile !== undefined) {
			const pending = isPeerCleanupPending(profile)
				? profile
				: await this.markCleanupPending(profile);
			if (pending !== undefined) {
				await this.cleanupPendingProfile(pending);
			}
		}
	}

	public dispose(): Promise<void> {
		if (this.disposing !== undefined) {
			return this.disposing;
		}
		if (this.disposeComplete) {
			return Promise.resolve();
		}
		let disposing!: Promise<void>;
		disposing = this.disposeCore().then(() => {
			this.disposeComplete = true;
		}).finally(() => {
			if (!this.disposeComplete && this.disposing === disposing) {
				this.disposing = undefined;
			}
		});
		this.disposing = disposing;
		return disposing;
	}

	private async disposeCore(): Promise<void> {
		this.disposed = true;
		await this.disconnectAll(false);
		while (this.inflight.size > 0) {
			await Promise.allSettled([...this.inflight]);
		}
		const failures = [
			...await this.disconnectAll(true),
			...this.backgroundFailures.splice(0),
		];
		try {
			await this.cleanupPendingProfiles();
		} catch (error: unknown) {
			failures.push(error);
		}
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				'One or more peer reconnect operations failed.',
			);
		}
		this.listeners.clear();
		this.notificationListeners.clear();
	}

	private createManaged(
		profileId: string,
		provisional = false,
		pairingSecretKeyRef?: string,
		profileGeneration?: string,
	): ManagedPeer {
		let managed: ManagedPeer;
		const connection = new PeerConnection(
			profileId,
			this.coordinatorDeviceId,
			this.profiles,
			this.secrets,
			this.transport,
			() => this.scheduleReconnect(managed),
		);
		managed = {
			connection,
			enabled: true,
			provisional,
			pairingSecretKeyRef,
			profileGeneration,
			attempt: 0,
		};
		connection.onStateChanged((snapshot) => {
			if (snapshot.state === 'online') {
				this.markStableLater(managed);
			}
			this.fireChanged();
		});
		connection.onNotification((method, params) => {
			for (const listener of this.notificationListeners) {
				listener(profileId, method, params);
			}
		});
		return managed;
	}

	private fireChanged(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	private async ensureManaged(profileId: string): Promise<ManagedPeer> {
		const existing = this.peers.get(profileId);
		if (existing !== undefined) {
			return existing;
		}
		const profile = await this.profiles.get(profileId);
		if (profile === undefined) {
			throw new Error('Peer profile does not exist.');
		}
		if (isPeerCleanupPending(profile)) {
			throw new Error('Peer profile cleanup is pending.');
		}
		this.assertActive();
		const concurrentlyCreated = this.peers.get(profileId);
		if (concurrentlyCreated !== undefined) {
			return concurrentlyCreated;
		}
		const managed = this.createManaged(
			profileId,
			isProvisionalProfile(profile),
			profile.pairingSecretKeyRef,
			profile.generation,
		);
		this.peers.set(profileId, managed);
		return managed;
	}

	private scheduleReconnect(managed: ManagedPeer): void {
		if (
			!managed.enabled
			|| this.disposed
			|| managed.reconnectTimer !== undefined
			|| this.ownership?.isOwner() === false
		) {
			return;
		}
		if (managed.stableTimer !== undefined) {
			clearTimeout(managed.stableTimer);
			managed.stableTimer = undefined;
		}
		const ceiling = Math.min(
			this.reconnectMaxMs,
			this.reconnectBaseMs * (2 ** Math.min(managed.attempt, 30)),
		);
		const delay = Math.floor(this.random() * ceiling);
		managed.attempt += 1;
		managed.reconnectTimer = setTimeout(() => {
			managed.reconnectTimer = undefined;
			this.launchTryConnect(managed);
		}, delay);
	}

	private launchTryConnect(managed: ManagedPeer): void {
		const operation = this.tryConnect(managed).catch((error: unknown) => {
			this.backgroundFailures.push(error);
		});
		void this.track(operation);
	}

	private async tryConnect(managed: ManagedPeer): Promise<void> {
		if (!managed.enabled || this.disposed) {
			return;
		}
		if (this.ownership !== undefined) {
			await this.ownership.assertOwner();
		}
		try {
			await managed.connection.connect();
			managed.provisional = false;
			this.markStableLater(managed);
		} catch {
			const state = managed.connection.snapshot().state;
			if (state === 'offline') {
				this.scheduleReconnect(managed);
			} else if (managed.provisional
				&& (state === 'authFailed' || state === 'incompatible')) {
				await this.rollbackAddedPeer(
					managed.connection.profileId,
					managed.pairingSecretKeyRef,
					managed.profileGeneration,
				);
			}
		}
	}

	private markStableLater(managed: ManagedPeer): void {
		if (managed.stableTimer !== undefined) {
			clearTimeout(managed.stableTimer);
		}
		managed.stableTimer = setTimeout(() => {
			managed.stableTimer = undefined;
			if (managed.connection.snapshot().state === 'online') {
				managed.attempt = 0;
			}
		}, this.stableOnlineMs);
	}

	private clearReconnect(managed: ManagedPeer): void {
		if (managed.reconnectTimer !== undefined) {
			clearTimeout(managed.reconnectTimer);
			managed.reconnectTimer = undefined;
		}
	}

	private clearTimers(managed: ManagedPeer): void {
		this.clearReconnect(managed);
		if (managed.stableTimer !== undefined) {
			clearTimeout(managed.stableTimer);
			managed.stableTimer = undefined;
		}
	}

	private track<T>(operation: Promise<T>): Promise<T> {
		let tracked!: Promise<T>;
		tracked = operation.finally(() => {
			this.inflight.delete(tracked);
		});
		this.inflight.add(tracked);
		return tracked;
	}

	private async disconnectAll(removeSuccessful: boolean): Promise<unknown[]> {
		const entries = [...this.peers.entries()];
		const disconnects: Promise<void>[] = [];
		for (const [, managed] of entries) {
			managed.enabled = false;
			this.clearTimers(managed);
			disconnects.push(managed.connection.disconnect());
		}
		const results = await Promise.allSettled(disconnects);
		const failures: unknown[] = [];
		for (const [index, result] of results.entries()) {
			const entry = entries[index];
			if (result.status === 'rejected') {
				failures.push(result.reason);
			} else if (
				removeSuccessful
				&& entry !== undefined
				&& this.peers.get(entry[0]) === entry[1]
			) {
				this.peers.delete(entry[0]);
			}
		}
		return failures;
	}

	private async rollbackAddedPeer(
		id: string,
		pairingSecretKeyRef?: string,
		profileGeneration?: string,
		fallbackProfile?: PeerProfile,
	): Promise<void> {
		const managed = this.peers.get(id);
		if (managed !== undefined && managed.profileGeneration === profileGeneration) {
			managed.enabled = false;
			this.clearTimers(managed);
			await managed.connection.disconnect();
			this.peers.delete(id);
		}
		let profile: PeerProfile | undefined;
		try {
			profile = await this.profiles.get(id);
		} catch {
			if (pairingSecretKeyRef !== undefined) {
				await this.secrets.delete(pairingSecretKeyRef);
			}
			throw new Error('Failed to completely roll back the peer profile.');
		}
		if (
			profile !== undefined
			&& (
				profile.generation !== profileGeneration
				|| profile.pairingSecretKeyRef !== pairingSecretKeyRef
			)
		) {
			return;
		}
		if (profile === undefined) {
			const candidate = fallbackProfile;
			if (candidate === undefined || this.profiles.storeIfAbsent === undefined) {
				if (pairingSecretKeyRef !== undefined) {
					await this.secrets.delete(pairingSecretKeyRef);
				}
				return;
			}
			const tombstone = cleanupTombstone(candidate);
			if (!await this.profiles.storeIfAbsent(tombstone)) {
				return;
			}
			await this.cleanupPendingProfile(tombstone);
			return;
		}
		const pending = isPeerCleanupPending(profile)
			? profile
			: await this.markCleanupPending(profile);
		if (pending !== undefined) {
			try {
				await this.cleanupPendingProfile(pending);
			} catch {
				throw new Error('Failed to completely roll back the peer profile.');
			}
		}
	}

	private async cleanupPendingProfiles(): Promise<void> {
		const failures: unknown[] = [];
		for (const profile of await this.profiles.list()) {
			if (!isPeerCleanupPending(profile)) {
				continue;
			}
			try {
				await this.cleanupPendingProfile(profile);
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, 'Pending peer credential cleanup failed.');
		}
	}

	private async markCleanupPending(profile: PeerProfile): Promise<PeerProfile | undefined> {
		const tombstone = cleanupTombstone(profile);
		return await this.replaceProfile(tombstone, deleteCondition(profile))
			? tombstone
			: undefined;
	}

	private async cleanupPendingProfile(initial: PeerProfile): Promise<void> {
		if (!isPeerCleanupPending(initial)) {
			throw new TypeError('Peer profile is not pending cleanup.');
		}
		let current = initial;
		const failures: unknown[] = [];
		for (const field of [
			'pairingSecretKeyRef',
			'credentialKeyRef',
			'pendingCommitProofKeyRef',
		] as const) {
			const reference = current[field];
			if (reference === undefined) {
				continue;
			}
			try {
				await this.secrets.delete(reference);
			} catch (error: unknown) {
				failures.push(error);
				continue;
			}
			const updated = withoutSecretReference(current, field);
			try {
				if (!await this.replaceProfile(updated, deleteCondition(current))) {
					failures.push(new Error('Peer cleanup metadata changed unexpectedly.'));
					break;
				}
				current = updated;
			} catch (error: unknown) {
				failures.push(error);
				break;
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, 'Failed to remove peer credentials.');
		}
		const deleted = await this.profiles.delete(current.id, deleteCondition(current));
		if (deleted === false) {
			throw new Error('Peer cleanup metadata changed unexpectedly.');
		}
	}

	private async replaceProfile(
		profile: PeerProfile,
		expected: PeerProfileDeleteCondition,
	): Promise<boolean> {
		if (this.profiles.replace !== undefined) {
			return this.profiles.replace(profile, expected);
		}
		const current = await this.profiles.get(profile.id);
		if (current === undefined || !matchesProfileCondition(current, expected)) {
			return false;
		}
		await this.profiles.store(profile);
		return true;
	}

	private assertActive(): void {
		if (this.disposed) {
			throw new Error('Peer connection manager is disposed.');
		}
	}

}

function isProvisionalProfile(profile: PeerProfile): boolean {
	return profile.invitationId !== undefined || profile.pendingEnrollmentId !== undefined;
}

function deleteCondition(profile: PeerProfile) {
	return {
		generation: profile.generation,
		cleanupPending: profile.cleanupPending,
		pairingSecretKeyRef: profile.pairingSecretKeyRef,
		credentialKeyRef: profile.credentialKeyRef,
		pendingCommitProofKeyRef: profile.pendingCommitProofKeyRef,
	};
}

function cleanupTombstone(profile: PeerProfile): PeerProfile {
	return {
		id: profile.id,
		...(profile.generation === undefined ? {} : { generation: profile.generation }),
		rpcEndpoint: profile.rpcEndpoint,
		workerDeviceId: profile.workerDeviceId,
		cleanupPending: true,
		...(profile.pairingSecretKeyRef === undefined
			? {}
			: { pairingSecretKeyRef: profile.pairingSecretKeyRef }),
		...(profile.credentialKeyRef === undefined
			? {}
			: { credentialKeyRef: profile.credentialKeyRef }),
		...(profile.pendingCommitProofKeyRef === undefined
			? {}
			: { pendingCommitProofKeyRef: profile.pendingCommitProofKeyRef }),
	};
}

function withoutSecretReference(
	profile: PeerProfile,
	field: 'pairingSecretKeyRef' | 'credentialKeyRef' | 'pendingCommitProofKeyRef',
): PeerProfile {
	const updated = { ...profile };
	delete updated[field];
	return updated;
}

function matchesProfileCondition(
	profile: PeerProfile,
	expected: PeerProfileDeleteCondition,
): boolean {
	return profile.generation === expected.generation
		&& profile.cleanupPending === expected.cleanupPending
		&& profile.pairingSecretKeyRef === expected.pairingSecretKeyRef
		&& profile.credentialKeyRef === expected.credentialKeyRef
		&& profile.pendingCommitProofKeyRef === expected.pendingCommitProofKeyRef;
}
