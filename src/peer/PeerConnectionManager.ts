import { randomUUID } from 'node:crypto';

import type { SecretStore } from '../gateway/SecretStore';
import { parseConnectionUrl } from './ConnectionUrl';
import { PeerConnection } from './PeerConnection';
import type { PeerProfile, PeerProfileStore } from './PeerProfile';
import type { PeerTransport } from './WebSocketPeerTransport';

export interface PeerConnectionManagerOptions {
	readonly reconnectBaseMs?: number;
	readonly reconnectMaxMs?: number;
	readonly stableOnlineMs?: number;
	readonly random?: () => number;
	readonly id?: () => string;
}

interface ManagedPeer {
	readonly connection: PeerConnection;
	enabled: boolean;
	provisional: boolean;
	readonly pairingSecretKeyRef?: string;
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
	private readonly backgroundFailures: unknown[] = [];
	private disposed = false;
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
	}

	public add(connectionUrl: string): Promise<PeerConnection> {
		this.assertActive();
		return this.track(this.addCore(connectionUrl));
	}

	private async addCore(connectionUrl: string): Promise<PeerConnection> {
		const parsed = parseConnectionUrl(connectionUrl);
		const id = this.id();
		const pairingSecretKeyRef = `mesh.remoteInvitation.${id}`;
		try {
			await this.secrets.store(pairingSecretKeyRef, parsed.secret);
			this.assertActive();
			const profile: PeerProfile = {
				id,
				rpcEndpoint: parsed.rpcEndpoint,
				workerDeviceId: parsed.workerDeviceId,
				invitationId: parsed.invitationId,
				pairingSecretKeyRef,
			};
			await this.profiles.store(profile);
			this.assertActive();
			const managed = this.createManaged(id, true, pairingSecretKeyRef);
			this.peers.set(id, managed);
			await managed.connection.connect();
			this.assertActive();
			managed.provisional = false;
			this.markStableLater(managed);
			return managed.connection;
		} catch (error: unknown) {
			if (this.disposed || !this.peers.has(id)) {
				await this.rollbackAddedPeer(id, pairingSecretKeyRef);
			} else {
				const managed = this.peers.get(id);
				const state = managed?.connection.snapshot().state;
				if (state === 'authFailed' || state === 'incompatible') {
					await this.rollbackAddedPeer(id, pairingSecretKeyRef);
				} else if (state === 'offline' && managed !== undefined) {
					this.scheduleReconnect(managed);
				}
			}
			throw error;
		}
	}

	public restore(): Promise<void> {
		this.assertActive();
		return this.track(this.restoreCore());
	}

	private async restoreCore(): Promise<void> {
		const profiles = await this.profiles.list();
		this.assertActive();
		for (const profile of profiles) {
			this.assertActive();
			if (this.peers.has(profile.id)) {
				continue;
			}
			const managed = this.createManaged(profile.id, isProvisionalProfile(profile));
			this.assertActive();
			this.peers.set(profile.id, managed);
			this.launchTryConnect(managed);
		}
	}

	public get(profileId: string): PeerConnection | undefined {
		return this.peers.get(profileId)?.connection;
	}

	public connect(profileId: string): Promise<void> {
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
		const managed = this.peers.get(profileId);
		if (managed === undefined) {
			return;
		}
		managed.enabled = false;
		this.clearTimers(managed);
		await managed.connection.disconnect();
	}

	public async remove(profileId: string): Promise<void> {
		const managed = this.peers.get(profileId);
		if (managed !== undefined) {
			managed.enabled = false;
			this.clearTimers(managed);
			await managed.connection.disconnect();
			this.peers.delete(profileId);
		}
		const profile = await this.profiles.get(profileId);
		if (profile !== undefined) {
			if (profile.pairingSecretKeyRef !== undefined) {
				await this.secrets.delete(profile.pairingSecretKeyRef);
			}
			if (profile.credentialKeyRef !== undefined) {
				await this.secrets.delete(profile.credentialKeyRef);
			}
			if (profile.pendingCommitProofKeyRef !== undefined) {
				await this.secrets.delete(profile.pendingCommitProofKeyRef);
			}
			await this.profiles.delete(profileId);
		}
	}

	public dispose(): Promise<void> {
		if (this.disposing !== undefined) {
			return this.disposing;
		}
		this.disposing = this.disposeCore();
		return this.disposing;
	}

	private async disposeCore(): Promise<void> {
		this.disposed = true;
		await this.disconnectAll();
		while (this.inflight.size > 0) {
			await Promise.allSettled([...this.inflight]);
		}
		await this.disconnectAll();
		this.peers.clear();
		if (this.backgroundFailures.length > 0) {
			throw new AggregateError(
				this.backgroundFailures,
				'One or more peer reconnect operations failed.',
			);
		}
	}

	private createManaged(
		profileId: string,
		provisional = false,
		pairingSecretKeyRef?: string,
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
			attempt: 0,
		};
		connection.onStateChanged((snapshot) => {
			if (snapshot.state === 'online') {
				this.markStableLater(managed);
			}
		});
		return managed;
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
		this.assertActive();
		const concurrentlyCreated = this.peers.get(profileId);
		if (concurrentlyCreated !== undefined) {
			return concurrentlyCreated;
		}
		const managed = this.createManaged(profileId, isProvisionalProfile(profile));
		this.peers.set(profileId, managed);
		return managed;
	}

	private scheduleReconnect(managed: ManagedPeer): void {
		if (!managed.enabled || this.disposed || managed.reconnectTimer !== undefined) {
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

	private async disconnectAll(): Promise<void> {
		const disconnects: Promise<void>[] = [];
		for (const managed of this.peers.values()) {
			managed.enabled = false;
			this.clearTimers(managed);
			disconnects.push(managed.connection.disconnect());
		}
		await Promise.all(disconnects);
	}

	private async rollbackAddedPeer(id: string, pairingSecretKeyRef?: string): Promise<void> {
		let cleanupFailed = false;
		const cleanup = async (operation: () => Promise<unknown>): Promise<void> => {
			try {
				await operation();
			} catch {
				cleanupFailed = true;
			}
		};
		const managed = this.peers.get(id);
		if (managed !== undefined) {
			managed.enabled = false;
			this.clearTimers(managed);
			await cleanup(() => managed.connection.disconnect());
			this.peers.delete(id);
		}
		let profile: PeerProfile | undefined;
		try {
			profile = await this.profiles.get(id);
		} catch {
			cleanupFailed = true;
		}
		if (pairingSecretKeyRef !== undefined) {
			await cleanup(() => this.secrets.delete(pairingSecretKeyRef));
		}
		if (profile !== undefined) {
			const secretRefs = new Set([
				profile?.pairingSecretKeyRef,
				profile?.credentialKeyRef,
				profile?.pendingCommitProofKeyRef,
			]);
			for (const secretRef of secretRefs) {
				if (secretRef !== undefined && secretRef !== pairingSecretKeyRef) {
					await cleanup(() => this.secrets.delete(secretRef));
				}
			}
		}
		if (!cleanupFailed) {
			await cleanup(() => this.profiles.delete(id));
		}
		if (cleanupFailed) {
			throw new Error('Failed to completely roll back the peer profile.');
		}
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
