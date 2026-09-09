import { randomUUID } from 'node:crypto';

import { assertDocumentFence, type DocumentFence } from '../storage/FencedDocumentStore';
import { ConnectivityError, type ConnectivityCode, type ConnectivityDiagnosticsReporter } from './ConnectivitySchemas';
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
	private refreshing: { readonly controller: AbortController; readonly operation: Promise<void> } | undefined;
	private nextRequestAt = 0;
	private truncated = false;
	private disposed = false;
	private readonly listeners = new Set<() => void>();

	public constructor(
		private readonly provider: DevTunnelDiscoveryProvider,
		private readonly fence: DocumentFence,
		private readonly enabled: () => boolean,
		private readonly accountAvailable: () => boolean,
		private readonly changed: () => void,
		private readonly now: () => number = Date.now,
		private readonly diagnostics?: ConnectivityDiagnosticsReporter,
	) {}

	public endpoints(): readonly DiscoveredEndpoint[] {
		return [...this.candidates.values()]
			.filter((entry) => this.now() - entry.observedAt <= 120_000)
			.map((entry) => structuredClone(entry.endpoint));
	}

	public onDidRefresh(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	public snapshot(excludeDeviceId?: string): DiscoverySnapshot {
		return {
			state: this.enabled() ? this.state : 'disabled',
			...(this.code === undefined ? {} : { error: this.code }),
			truncated: this.truncated,
			candidates: [...this.candidates].filter(([, { endpoint }]) =>
				excludeDeviceId === undefined || endpoint.accountIdentity?.deviceId !== excludeDeviceId)
				.map(([candidateHandle, { endpoint, observedAt }]) => ({
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
		this.diagnostics?.('Discovery cache invalidated.', {
			enabled: this.enabled(), accountAvailable: this.accountAvailable(), refreshInFlight: this.refreshing !== undefined,
		});
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
		if (this.disposed) { return Promise.reject(new ConnectivityError('CANCELLED')); }
		const controller = this.controller;
		const previous = this.refreshing;
		if (previous?.controller === controller) {
			this.diagnostics?.('Reusing an in-flight discovery request.', { state: this.state });
			return previous.operation;
		}
		const start = () => this.refreshCore(controller);
		// Wait for cancelled work to release its budget, but never reuse it for a new generation.
		const operation = (previous?.operation ?? Promise.resolve()).then(start, start).finally(() => {
			if (this.refreshing?.operation === operation) {
				this.refreshing = undefined;
			}
		});
		this.refreshing = { controller, operation };
		return operation;
	}

	public async dispose(): Promise<void> {
		this.disposed = true;
		this.invalidate();
		await this.refreshing?.operation;
		this.listeners.clear();
	}

	private isCurrent(controller: AbortController): boolean {
		return !this.disposed && this.controller === controller && !controller.signal.aborted;
	}

	private async refreshCore(controller: AbortController): Promise<void> {
		if (!this.isCurrent(controller)) {
			this.diagnostics?.('Discovery request cancelled before starting.', {});
			return;
		}
		if (!this.enabled()) {
			throw new ConnectivityError('DISABLED');
		}
		if (!this.accountAvailable()) {
			this.state = 'authRequired';
			this.code = 'AUTH_REQUIRED';
			this.diagnostics?.('Discovery requires authentication.', { code: this.code });
			this.changed();
			return;
		}
		await assertDocumentFence(this.fence);
		if (!this.isCurrent(controller)) {
			this.diagnostics?.('Discovery request cancelled before starting.', {});
			return;
		}
		if (this.now() < this.nextRequestAt) {
			return;
		}
		this.state = 'discovering';
		this.nextRequestAt = this.now() + 10_000;
		this.diagnostics?.('Requesting the account tunnel directory.', {});
		this.changed();
		try {
			const result = await this.provider.list(controller.signal);
			await assertDocumentFence(this.fence);
			if (!this.isCurrent(controller)) {
				throw new ConnectivityError('CANCELLED');
			}
			this.candidates = new Map(result.endpoints.map((endpoint) => [
				randomUUID(), { endpoint, observedAt: this.now() },
			]));
			this.truncated = result.truncated;
			this.state = 'ready';
			this.code = undefined;
			for (const listener of this.listeners) { listener(); }
		} catch (error: unknown) {
			if (!this.isCurrent(controller)) {
				this.diagnostics?.('Discovery request cancelled.', { invalidated: this.controller !== controller });
				return;
			}
			const normalized = error instanceof ConnectivityError ? error : new ConnectivityError('DISCOVERY_UNAVAILABLE');
			this.code = normalized.code;
			this.state = ['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED'].includes(normalized.code)
				? 'authRequired' : 'error';
			this.nextRequestAt = this.now() + (normalized.retryAfterMs ?? 60_000);
			this.diagnostics?.('Discovery request failed.', { code: this.code, state: this.state });
			if (this.state === 'authRequired') {
				this.candidates.clear();
			}
		} finally {
			if (this.isCurrent(controller)) {
				if (this.timer !== undefined) {
					clearTimeout(this.timer);
				}
				const delayMs = Math.max(15_000 + Math.floor(Math.random() * 3000), this.nextRequestAt - this.now());
				this.timer = setTimeout(() => {
					if (!this.isCurrent(controller)) { return; }
					this.timer = undefined;
					void this.refresh().catch(() => {
						if (!this.isCurrent(controller)) { return; }
						this.state = 'error';
						this.code = 'DISCOVERY_UNAVAILABLE';
						this.changed();
					});
				}, delayMs);
				this.diagnostics?.('Discovery refresh scheduled.', { state: this.state, candidateCount: this.candidates.size, delayMs });
				this.timer.unref();
				this.changed();
			}
		}
	}
}
