import { randomUUID } from 'node:crypto';

import { assertDocumentFence, type DocumentFence } from '../storage/FencedDocumentStore';
import { ConnectivityError, isTransientDiscoveryError, type ConnectivityCode, type ConnectivityDiagnosticsReporter } from './ConnectivitySchemas';
import type { DevTunnelDiscoveryProvider, DiscoveredEndpoint, DiscoveryAdvertisement } from './DevTunnelDiscoveryProvider';
import { normalizeConnectivityError } from './DevTunnelManagement';

export interface DiscoverySnapshot {
	readonly state: 'disabled' | 'authRequired' | 'discovering' | 'ready' | 'partial' | 'error';
	readonly error?: ConnectivityCode;
	readonly failedCandidateCount: number;
	readonly deferredCandidateCount: number;
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
	private candidates = new Map<string, { endpoint: DiscoveredEndpoint; observedAt: number; fresh: boolean }>();
	private observedAdvertisements: readonly DiscoveryAdvertisement[] = [];
	private failedCandidateCount = 0;
	private deferredCandidateCount = 0;
	private controller = new AbortController();
	private timer: NodeJS.Timeout | undefined;
	private refreshing: { readonly controller: AbortController; readonly operation: Promise<void> } | undefined;
	private nextRequestAt = 0;
	private lastStartedAt = Number.NEGATIVE_INFINITY;
	private rateLimitedUntil = 0;
	private failures = 0;
	private demandUntil = 0;
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
		private readonly options: { readonly active?: () => boolean; readonly random?: () => number } = {},
	) {}

	public endpoints(): readonly DiscoveredEndpoint[] {
		return [...this.candidates.values()]
			.filter((entry) => entry.fresh && this.now() - entry.observedAt <= 120_000)
			.map((entry) => structuredClone(entry.endpoint));
	}

	public advertisements(): readonly DiscoveryAdvertisement[] { return structuredClone(this.observedAdvertisements); }

	public onDidRefresh(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	public snapshot(excludeDeviceId?: string): DiscoverySnapshot {
		return {
			state: this.enabled() ? this.state : 'disabled',
			...(this.code === undefined ? {} : { error: this.code }),
			failedCandidateCount: this.failedCandidateCount, deferredCandidateCount: this.deferredCandidateCount,
			truncated: this.truncated,
			candidates: [...this.candidates].filter(([, { endpoint }]) =>
				excludeDeviceId === undefined || endpoint.accountIdentity?.deviceId !== excludeDeviceId)
				.map(([candidateHandle, { endpoint, observedAt, fresh }]) => ({
				candidateHandle,
				label: `Candidate ${endpoint.locator.advertisementId.slice(0, 8)}`,
				hostHint: endpoint.hostHint,
				stale: !fresh || this.now() - observedAt > 120_000,
				admission: endpoint.admission,
			})),
		};
	}

	public select(handle: string): DiscoveredEndpoint {
		const candidate = this.candidates.get(handle);
		if (!this.enabled() || candidate === undefined || !candidate.fresh || this.now() - candidate.observedAt > 120_000) {
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
		this.provider.invalidate();
		this.candidates.clear();
		this.observedAdvertisements = [];
		this.failedCandidateCount = 0;
		this.deferredCandidateCount = 0;
		this.failures = 0;
		this.demandUntil = 0;
		this.lastStartedAt = Number.NEGATIVE_INFINITY;
		this.rateLimitedUntil = 0;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.nextRequestAt = 0;
		this.code = undefined;
		this.state = !this.enabled() ? 'disabled' : 'authRequired';
		this.changed();
	}

	public refresh(options: { readonly interactive?: boolean; readonly demand?: boolean } = {}): Promise<void> {
		if (this.disposed) { return Promise.reject(new ConnectivityError('CANCELLED')); }
		if (options.interactive || options.demand) { this.demandUntil = this.now() + 60_000; }
		const controller = this.controller;
		const previous = this.refreshing;
		if (previous?.controller === controller) {
			this.diagnostics?.('Reusing an in-flight discovery request.', { state: this.state });
			return previous.operation;
		}
		const start = () => this.refreshCore(controller, options.interactive === true, options.demand === true);
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

	private async refreshCore(controller: AbortController, interactive: boolean, demand: boolean): Promise<void> {
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
			this.candidates.clear();
			this.observedAdvertisements = [];
			this.diagnostics?.('Discovery requires authentication.', { code: this.code });
			this.changed();
			return;
		}
		try {
			await assertDocumentFence(this.fence);
		} catch (error: unknown) {
			if (this.isCurrent(controller)) {
				this.candidates.clear();
				this.observedAdvertisements = [];
				this.failedCandidateCount = 0;
				this.deferredCandidateCount = 0;
				this.state = 'error';
				this.code = normalizeConnectivityError(error).code;
				this.diagnostics?.('Discovery ownership preflight failed.', { code: this.code });
				this.changed();
			}
			throw error;
		}
		if (!this.isCurrent(controller)) {
			this.diagnostics?.('Discovery request cancelled before starting.', {});
			return;
		}
		const nextRequestAt = demand ? Math.max(this.nextRequestAt, this.lastStartedAt + 15_000) : this.nextRequestAt;
		if (this.now() < nextRequestAt
			&& !(interactive && this.now() >= this.lastStartedAt + 10_000 && this.now() >= this.rateLimitedUntil)) {
			if (interactive && this.now() >= this.rateLimitedUntil) {
				this.nextRequestAt = this.lastStartedAt + 10_000;
				this.scheduleRefresh(controller, Math.max(1, this.nextRequestAt - this.now()), true);
			} else if (demand) {
				this.scheduleRefresh(controller, Math.max(1, nextRequestAt - this.now()), true);
			}
			return;
		}
		this.state = 'discovering';
		this.lastStartedAt = this.now();
		this.nextRequestAt = this.now() + 10_000;
		this.diagnostics?.('Requesting the account tunnel directory.', {});
		this.changed();
		try {
			const result = await this.provider.list(controller.signal);
			await assertDocumentFence(this.fence);
			if (!this.isCurrent(controller)) {
				throw new ConnectivityError('CANCELLED');
			}
			const partial = result.failedCandidateCount > 0 || result.deferredCandidateCount > 0 || result.error !== undefined;
			const candidates: typeof this.candidates = new Map(result.endpoints.map((endpoint) => [
				randomUUID(), { endpoint, observedAt: this.now(), fresh: true },
			]));
			if (partial || result.truncated) {
				const current = new Set(result.endpoints.map((endpoint) => JSON.stringify(endpoint.locator)));
				for (const [handle, entry] of this.candidates) {
					if (candidates.size >= 10) { break; }
					if (!current.has(JSON.stringify(entry.endpoint.locator)) && this.now() - entry.observedAt <= 120_000) {
						candidates.set(handle, { ...entry, fresh: false });
					}
				}
			}
			this.candidates = candidates;
			this.observedAdvertisements = result.advertisements;
			this.failedCandidateCount = result.failedCandidateCount;
			this.deferredCandidateCount = result.deferredCandidateCount;
			this.truncated = result.truncated;
			this.state = partial ? 'partial' : 'ready';
			this.code = result.error;
			this.failures = 0;
			if (result.retryAfterMs !== undefined) {
				this.rateLimitedUntil = this.now() + result.retryAfterMs;
				this.nextRequestAt = this.rateLimitedUntil;
			}
			for (const listener of this.listeners) { listener(); }
		} catch (error: unknown) {
			if (!this.isCurrent(controller)) {
				this.diagnostics?.('Discovery request cancelled.', { invalidated: this.controller !== controller });
				return;
			}
			const normalized = normalizeConnectivityError(error);
			this.code = normalized.code;
			this.failedCandidateCount = 0;
			this.deferredCandidateCount = 0;
			this.state = ['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED'].includes(normalized.code)
				? 'authRequired' : 'error';
			this.failures = Math.min(this.failures + 1, 4);
			this.nextRequestAt = this.now() + Math.max(normalized.retryAfterMs ?? 0, Math.min(300_000, 60_000 * 2 ** (this.failures - 1)));
			if (normalized.code === 'RATE_LIMITED') { this.rateLimitedUntil = this.nextRequestAt; }
			this.observedAdvertisements = [];
			for (const entry of this.candidates.values()) { entry.fresh = false; }
			this.diagnostics?.('Discovery request failed.', { code: this.code, state: this.state });
			if (!isTransientDiscoveryError(normalized.code)) {
				this.candidates.clear();
			}
		} finally {
			if (this.isCurrent(controller)) {
				const active = this.now() < this.demandUntil || (this.options.active?.() ?? true);
				const delayMs = Math.max((active ? 15_000 : 60_000) + Math.floor((this.options.random?.() ?? Math.random()) * 3000),
					this.nextRequestAt - this.now());
				this.scheduleRefresh(controller, delayMs, active);
				this.changed();
			}
		}
	}

	private scheduleRefresh(controller: AbortController, delayMs: number, active: boolean): void {
		if (this.timer !== undefined) { clearTimeout(this.timer); }
		const scheduledFor = this.now() + delayMs;
		this.timer = setTimeout(() => {
			if (!this.isCurrent(controller)) { return; }
			this.timer = undefined;
			const timerDelayMs = Math.max(0, this.now() - scheduledFor);
			if (timerDelayMs >= 1000) {
				this.diagnostics?.('Discovery refresh timer delayed.', { timerDelayMs, delayMs });
			}
			void this.refresh().catch((error: unknown) => {
				if (!this.isCurrent(controller)) { return; }
				this.state = 'error';
				this.code = normalizeConnectivityError(error).code;
				this.observedAdvertisements = [];
				for (const entry of this.candidates.values()) { entry.fresh = false; }
				if (!isTransientDiscoveryError(this.code)) { this.candidates.clear(); }
				this.diagnostics?.('Discovery refresh could not start.', { code: this.code });
				this.changed();
			});
		}, delayMs);
		this.diagnostics?.('Discovery refresh scheduled.', {
			state: this.state, candidateCount: this.candidates.size, delayMs, active,
			failedCandidateCount: this.failedCandidateCount, deferredCandidateCount: this.deferredCandidateCount,
		});
		this.timer.unref();
	}
}
