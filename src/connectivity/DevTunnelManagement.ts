import {
	ManagementApiVersions,
	TunnelManagementHttpClient,
	type TunnelManagementClient,
} from '@microsoft/dev-tunnels-management';
import axios, { type AxiosAdapter } from 'axios';
import type { CancellationToken } from 'vscode-jsonrpc';

import { assertDocumentFence, type DocumentFence } from '../storage/FencedDocumentStore';
import type { AccountSessionProvider } from './AccountSessionProvider';
import { ConnectivityError } from './ConnectivitySchemas';
import { ConnectivityOperation } from './ConnectivityOperations';
import { validateManagementUri } from './DevTunnelUris';
import { MeshDomainError } from '../domain/errors';

export const DEV_TUNNELS_SDK_VERSION = '1.3.56';

/** Applied even to management requests made internally by the SDK host. */
export function createGuardedTunnelHttpAdapter(send: AxiosAdapter): AxiosAdapter {
	return async (config) => {
		let uri = validateManagementUri(config.url ?? '');
		for (let redirects = 0; ; redirects += 1) {
			try {
				return await send({
					...config, url: uri.toString(),
					maxRedirects: 0,
					timeout: Math.min(config.timeout ?? 10_000, 10_000),
					maxContentLength: 1024 * 1024,
					maxBodyLength: 64 * 1024,
				});
			} catch (error: unknown) {
				if (!axios.isAxiosError(error) || ![307, 308].includes(error.response?.status ?? 0)) { throw error; }
				if (redirects >= 2) { throw new ConnectivityError('INVALID_ENDPOINT'); }
				const location: unknown = error.response?.headers.location;
				if (typeof location !== 'string') { throw new ConnectivityError('INVALID_ENDPOINT'); }
				const next = validateManagementUri(location);
				if (next.pathname !== uri.pathname || next.search !== uri.search) {
					throw new ConnectivityError('INVALID_ENDPOINT');
				}
				uri = next;
			}
		}
	};
}
export const guardedTunnelHttpAdapter = createGuardedTunnelHttpAdapter(axios.getAdapter('http'));

export function createTunnelManagementClient(
	authorization?: () => Promise<string | null>,
	adapter: AxiosAdapter = guardedTunnelHttpAdapter,
): TunnelManagementHttpClient {
	const client = new TunnelManagementHttpClient(
		{ name: 'copilot-agent-mesh', version: '0.4.0' },
		ManagementApiVersions.Version20230927preview,
		authorization,
		undefined,
		undefined,
		adapter,
	);
	client.trace = () => undefined;
	client.enableEventsReporting = false;
	return client;
}

export class DevTunnelManagement {
	private lifetime = new AbortController();
	private inFlight = 0;
	private rateLimitedUntil = 0;
	private readonly pending = new Set<Promise<unknown>>();
	private disposed = false;
	private readonly subscription: { dispose(): void };

	public constructor(
		private readonly account: AccountSessionProvider,
		private readonly fence: DocumentFence,
		private readonly enabled: () => boolean,
		private readonly options: {
			readonly timeoutMs?: number;
			readonly adapter?: AxiosAdapter;
		} = {},
	) {
		this.subscription = account.onDidChange(() => this.invalidate());
	}

	public run<T>(
		operation: (client: TunnelManagementClient, cancellation: CancellationToken) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const result = this.runCore(operation, signal);
		this.pending.add(result);
		void result.finally(() => this.pending.delete(result)).catch(() => undefined);
		return result;
	}

	public invalidate(): void {
		this.lifetime.abort();
		this.lifetime = new AbortController();
		this.rateLimitedUntil = 0;
	}

	public async dispose(): Promise<void> {
		this.disposed = true;
		this.subscription.dispose();
		this.lifetime.abort();
		await Promise.allSettled([...this.pending]);
	}

	private async runCore<T>(
		action: (client: TunnelManagementClient, cancellation: CancellationToken) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		if (this.disposed || signal?.aborted) {
			throw new ConnectivityError('CANCELLED');
		}
		if (!this.enabled()) {
			throw new ConnectivityError('DISABLED');
		}
		if (Date.now() < this.rateLimitedUntil) {
			throw new ConnectivityError('RATE_LIMITED', this.rateLimitedUntil - Date.now());
		}
		if (this.inFlight >= 2) {
			throw new ConnectivityError('RATE_LIMITED', 1000);
		}
		this.inFlight += 1;
		const operation = new ConnectivityOperation(this.options.timeoutMs ?? 10_000, this.lifetime.signal, signal);
		const client = createTunnelManagementClient(
			() => this.account.authorization(operation.controller.signal),
			this.options.adapter,
		);
		try {
			operation.assertActive();
			await assertDocumentFence(this.fence);
			const result = await action(client, operation.cancellation.token);
			operation.assertActive();
			await assertDocumentFence(this.fence);
			return result;
		} catch (error: unknown) {
			operation.assertActive();
			const normalized = normalizeConnectivityError(error);
			if (normalized.code === 'RATE_LIMITED') {
				this.rateLimitedUntil = Date.now() + (normalized.retryAfterMs ?? 60_000);
			}
			throw normalized;
		} finally {
			operation.dispose();
			this.inFlight -= 1;
			await client.dispose();
		}
	}
}

export function normalizeConnectivityError(error: unknown): ConnectivityError {
	if (error instanceof ConnectivityError) {
		return error;
	}
	if (error instanceof MeshDomainError) {
		return new ConnectivityError(error.reason === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED'
			: error.reason === 'WORKER_DRAINING' ? 'MIGRATION_REQUIRED' : 'POLICY_DENIED');
	}
	if (axios.isAxiosError(error)) {
		const status = error.response?.status;
		if (status === 401 || status === 403) {
			return new ConnectivityError('AUTH_REQUIRED');
		}
		if (status === 404) {
			return new ConnectivityError('OFFLINE');
		}
		if (status === 429) {
			const value: unknown = error.response?.headers['retry-after'];
			const seconds = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value)
				: typeof value === 'string' && Number.isFinite(Date.parse(value))
					? (Date.parse(value) - Date.now()) / 1000 : 60;
			return new ConnectivityError('RATE_LIMITED', Math.max(1000, Math.min(seconds * 1000, 300_000)));
		}
	}
	// Raw SDK/Axios errors can retain authorization headers and full resource identifiers.
	return new ConnectivityError('DISCOVERY_UNAVAILABLE');
}
