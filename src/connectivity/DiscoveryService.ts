import { randomUUID } from 'node:crypto';

import { assertDocumentFence, type DocumentFence } from '../storage/FencedDocumentStore';
import { ConnectivityError, type ConnectivityCode } from './ConnectivitySchemas';
import type { DevTunnelDiscoveryProvider, DiscoveredEndpoint } from './DevTunnelDiscoveryProvider';

export interface DiscoverySnapshot {
	readonly state: 'disabled' | 'authRequired' | 'discovering' | 'ready' | 'error';
	readonly error?: ConnectivityCode;
	readonly truncated: boolean;
	readonly candidates: readonly {
		readonly candidateHandle: string;
		readonly label: string;
		readonly hostHint: 'online' | 'offline' | 'unknown';
		readonly stale: boolean;
		readonly admission: 'legacy-mesh-auth' | 'private-port-token';
	}[];
}

export class DiscoveryService {
	private state: DiscoverySnapshot['state'] = 'disabled';
	private code: ConnectivityCode | undefined;
	private candidates = new Map<string, { endpoint: DiscoveredEndpoint; observedAt: number }>();
	private controller = new AbortController();
	private timer: NodeJS.Timeout | undefined;
	private refreshing: Promise<void> | undefined;
	private nextRequestAt = 0;
	private truncated = false;
	private disposed = false;

	public constructor(
		private readonly provider: DevTunnelDiscoveryProvider,
		private readonly fence: DocumentFence,
		private readonly enabled: () => boolean,
		private readonly accountAvailable: () => boolean,
		private readonly changed: () => void,
		private readonly now: () => number = Date.now,
	) {}

	public snapshot(): DiscoverySnapshot {
		return {
			state: this.enabled() ? this.state : 'disabled',
			...(this.code === undefined ? {} : { error: this.code }),
			truncated: this.truncated,
			candidates: [...this.candidates].map(([candidateHandle, { endpoint, observedAt }]) => ({
				candidateHandle,
				label: `Candidate ${endpoint.locator.advertisementId.slice(0, 8)}`,
				hostHint: endpoint.hostHint,
				stale: this.now() - observedAt > 120_000,
				admission: endpoint.admission,
			})),
		};
	}

	public select(handle: string): DiscoveredEndpoint {
		const candidate = this.candidates.get(handle);
		if (!this.enabled() || candidate === undefined || this.now() - candidate.observedAt > 120_000) {
			throw new ConnectivityError('BINDING_CHANGED');
		}
		this.candidates.delete(handle);
		return structuredClone(candidate.endpoint);
	}

	public invalidate(): void {
		this.controller.abort();
		this.controller = new AbortController();
		this.candidates.clear();
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.nextRequestAt = 0;
		this.code = undefined;
		this.state = !this.enabled() ? 'disabled' : 'authRequired';
		this.changed();
	}

	public refresh(): Promise<void> {
		if (this.refreshing !== undefined) {
			return this.refreshing;
		}
		const operation = this.refreshCore().finally(() => {
			if (this.refreshing === operation) {
				this.refreshing = undefined;
			}
		});
		this.refreshing = operation;
		return operation;
	}

	public async dispose(): Promise<void> {
		this.disposed = true;
		this.invalidate();
		await this.refreshing;
	}

	private async refreshCore(): Promise<void> {
		if (this.disposed) {
			throw new ConnectivityError('CANCELLED');
		}
		if (!this.enabled()) {
			throw new ConnectivityError('DISABLED');
		}
		if (!this.accountAvailable()) {
			this.state = 'authRequired';
			this.code = 'AUTH_REQUIRED';
			this.changed();
			return;
		}
		await assertDocumentFence(this.fence);
		if (this.now() < this.nextRequestAt) {
			return;
		}
		const controller = this.controller;
		this.state = 'discovering';
		this.nextRequestAt = this.now() + 10_000;
		this.changed();
		try {
			const result = await this.provider.list(controller.signal);
			await assertDocumentFence(this.fence);
			if (controller.signal.aborted || this.controller !== controller) {
				throw new ConnectivityError('CANCELLED');
			}
			this.candidates = new Map(result.endpoints.map((endpoint) => [
				randomUUID(), { endpoint, observedAt: this.now() },
			]));
			this.truncated = result.truncated;
			this.state = 'ready';
			this.code = undefined;
		} catch (error: unknown) {
			if (controller.signal.aborted) {
				return;
			}
			const normalized = error instanceof ConnectivityError ? error : new ConnectivityError('DISCOVERY_UNAVAILABLE');
			this.code = normalized.code;
			this.state = ['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED'].includes(normalized.code)
				? 'authRequired' : 'error';
			this.nextRequestAt = this.now() + (normalized.retryAfterMs ?? 60_000);
			if (this.state === 'authRequired') {
				this.candidates.clear();
			}
		} finally {
			if (!controller.signal.aborted && !this.disposed) {
				if (this.timer !== undefined) {
					clearTimeout(this.timer);
				}
				this.timer = setTimeout(() => {
					this.timer = undefined;
					void this.refresh().catch(() => {
						this.state = 'error';
						this.code = 'DISCOVERY_UNAVAILABLE';
						this.changed();
					});
				}, Math.max(60_000 + Math.floor(Math.random() * 5000), this.nextRequestAt - this.now()));
				this.timer.unref();
				this.changed();
			}
		}
	}
}
