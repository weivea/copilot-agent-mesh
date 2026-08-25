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
	attempt: number;
	reconnectTimer?: NodeJS.Timeout;
	stableTimer?: NodeJS.Timeout;
}

export class PeerConnectionManager {
	private readonly peers = new Map<string, ManagedPeer>();
	private readonly reconnectBaseMs: number;
	private readonly reconnectMaxMs: number;
	private readonly stableOnlineMs: number;
	private readonly random: () => number;
	private readonly id: () => string;
	private disposed = false;

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

	public async add(connectionUrl: string): Promise<PeerConnection> {
		this.assertActive();
		const parsed = parseConnectionUrl(connectionUrl);
		const id = this.id();
		const pairingSecretKeyRef = `mesh.remoteInvitation.${id}`;
		await this.secrets.store(pairingSecretKeyRef, parsed.secret);
		const profile: PeerProfile = {
			id,
			rpcEndpoint: parsed.rpcEndpoint,
			workerDeviceId: parsed.workerDeviceId,
			invitationId: parsed.invitationId,
			pairingSecretKeyRef,
		};
		try {
			await this.profiles.store(profile);
		} catch (error: unknown) {
			await this.secrets.delete(pairingSecretKeyRef);
			throw error;
		}
		const managed = this.createManaged(id);
		this.peers.set(id, managed);
		try {
			await managed.connection.connect();
			this.markStableLater(managed);
			return managed.connection;
		} catch (error: unknown) {
			if (managed.connection.snapshot().state === 'offline') {
				this.scheduleReconnect(managed);
			}
			throw error;
		}
	}

	public async restore(): Promise<void> {
		this.assertActive();
		for (const profile of await this.profiles.list()) {
			if (this.peers.has(profile.id)) {
				continue;
			}
			const managed = this.createManaged(profile.id);
			this.peers.set(profile.id, managed);
			void this.tryConnect(managed);
		}
	}

	public get(profileId: string): PeerConnection | undefined {
		return this.peers.get(profileId)?.connection;
	}

	public async connect(profileId: string): Promise<void> {
		this.assertActive();
		const managed = await this.ensureManaged(profileId);
		managed.enabled = true;
		this.clearReconnect(managed);
		await managed.connection.connect();
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
			await this.profiles.delete(profileId);
		}
	}

	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		const disconnects: Promise<void>[] = [];
		for (const managed of this.peers.values()) {
			managed.enabled = false;
			this.clearTimers(managed);
			disconnects.push(managed.connection.disconnect());
		}
		await Promise.all(disconnects);
		this.peers.clear();
	}

	private createManaged(profileId: string): ManagedPeer {
		let managed: ManagedPeer;
		const connection = new PeerConnection(
			profileId,
			this.coordinatorDeviceId,
			this.profiles,
			this.secrets,
			this.transport,
			() => this.scheduleReconnect(managed),
		);
		managed = { connection, enabled: true, attempt: 0 };
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
		if (await this.profiles.get(profileId) === undefined) {
			throw new Error('Peer profile does not exist.');
		}
		const managed = this.createManaged(profileId);
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
			void this.tryConnect(managed);
		}, delay);
	}

	private async tryConnect(managed: ManagedPeer): Promise<void> {
		if (!managed.enabled || this.disposed) {
			return;
		}
		try {
			await managed.connection.connect();
			this.markStableLater(managed);
		} catch {
			const state = managed.connection.snapshot().state;
			if (state === 'offline') {
				this.scheduleReconnect(managed);
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

	private assertActive(): void {
		if (this.disposed) {
			throw new Error('Peer connection manager is disposed.');
		}
	}
}
