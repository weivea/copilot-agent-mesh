import type { SecretStore } from '../gateway/SecretStore';
import type {
	PeerConnectionState,
	PeerProfile,
	PeerProfileStore,
} from './PeerProfile';
import {
	PeerTransportError,
	type PeerSession,
	type PeerTransport,
} from './WebSocketPeerTransport';

export interface PeerConnectionSnapshot {
	readonly profileId: string;
	readonly state: PeerConnectionState;
	readonly lastHeartbeatAt?: number;
	readonly latencyMs?: number;
}

export class PeerConnection {
	private readonly listeners = new Set<(snapshot: PeerConnectionSnapshot) => void>();
	private session: PeerSession | undefined;
	private controller: AbortController | undefined;
	private connecting: Promise<void> | undefined;
	private disconnecting: Promise<void> | undefined;
	private state: PeerConnectionState = 'offline';
	private intentionalClose = false;

	public constructor(
		public readonly profileId: string,
		private readonly coordinatorDeviceId: string,
		private readonly profiles: PeerProfileStore,
		private readonly secrets: SecretStore,
		private readonly transport: PeerTransport,
		private readonly unexpectedlyClosed: () => void,
	) {}

	public snapshot(): PeerConnectionSnapshot {
		return {
			profileId: this.profileId,
			state: this.state,
			lastHeartbeatAt: this.session?.lastHeartbeatAt,
			latencyMs: this.session?.latencyMs,
		};
	}

	public onStateChanged(listener: (snapshot: PeerConnectionSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public connect(): Promise<void> {
		if (this.disconnecting !== undefined) {
			return this.disconnecting.then(() => this.connect());
		}
		if (this.session !== undefined) {
			return Promise.resolve();
		}
		if (this.connecting !== undefined) {
			return this.connecting;
		}
		let tracked!: Promise<void>;
		tracked = this.establish().finally(() => {
			if (this.connecting === tracked) {
				this.connecting = undefined;
			}
		});
		this.connecting = tracked;
		return tracked;
	}

	private async establish(): Promise<void> {
		this.intentionalClose = false;
		this.setState('connecting');
		const controller = new AbortController();
		this.controller = controller;
		try {
			const profile = await this.profiles.get(this.profileId);
			if (profile === undefined) {
				throw new Error('Peer profile does not exist.');
			}
			const session = await this.transport.connect(
				profile,
				this.coordinatorDeviceId,
				this.secrets,
				this.profiles,
				controller.signal,
			);
			if (controller.signal.aborted) {
				await session.close();
				return;
			}
			this.session = session;
			session.onClose(() => {
				if (this.session !== session) {
					return;
				}
				this.session = undefined;
				this.setState('offline');
				if (!this.intentionalClose) {
					this.unexpectedlyClosed();
				}
			});
			if (this.session !== session) {
				throw new PeerTransportError(
					'CONNECTION_FAILED',
					'Peer connection closed before activation.',
				);
			}
			this.setState('online');
		} catch (error: unknown) {
			if (controller.signal.aborted) {
				this.setState('offline');
				return;
			}
			this.setState(error instanceof PeerTransportError
				? error.reason === 'AUTH_FAILED'
					? 'authFailed'
					: error.reason === 'PROTOCOL_INCOMPATIBLE'
						? 'incompatible'
						: 'offline'
				: 'offline');
			throw error;
		} finally {
			if (this.controller === controller) {
				this.controller = undefined;
			}
		}
	}

	public async request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (this.session === undefined) {
			throw new Error('Peer is not online.');
		}
		return this.session.request(method, params);
	}

	public disconnect(): Promise<void> {
		if (this.disconnecting !== undefined) {
			return this.disconnecting;
		}
		let tracked!: Promise<void>;
		tracked = this.disconnectLifecycle().finally(() => {
			if (this.disconnecting === tracked) {
				this.disconnecting = undefined;
			}
		});
		this.disconnecting = tracked;
		return tracked;
	}

	private async disconnectLifecycle(): Promise<void> {
		this.intentionalClose = true;
		this.controller?.abort();
		this.controller = undefined;
		await this.connecting?.catch(() => undefined);
		const session = this.session;
		this.session = undefined;
		if (session !== undefined) {
			await session.close();
		}
		this.setState('offline');
	}

	public async profile(): Promise<PeerProfile | undefined> {
		return this.profiles.get(this.profileId);
	}

	private setState(state: PeerConnectionState): void {
		if (this.state === state) {
			return;
		}
		this.state = state;
		const snapshot = this.snapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}
