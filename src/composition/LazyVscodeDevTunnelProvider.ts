import type { E2eCapability } from './E2eCapability';
import type {
	DevTunnelProvider,
	DevTunnelRuntimeStatus,
	DevTunnelStateStore,
	HostedTunnel,
	TunnelCapability,
	TunnelMetadata,
	TunnelRequest,
} from '../tunnel/DevTunnelProvider';

export interface LazyVscodeDevTunnelProviderOptions {
	readonly executable?: string;
	readonly reportStatusListenerError?: (error: unknown) => void;
	readonly stateStore: DevTunnelStateStore;
	readonly loadProvider?: () => Promise<LazyDevTunnelDelegate>;
}

export interface LazyDevTunnelDelegate extends DevTunnelProvider {
	deleteOwnedForE2e(
		capability: E2eCapability,
	): Promise<'deleted' | 'already-absent'>;
	ownedMetadataForE2e(capability: E2eCapability): Promise<{
		readonly build: string;
		readonly decoderRevision: string;
		readonly executablePath: string;
		readonly localPort: number;
		readonly ownershipLabel: string;
		readonly tunnelId: string;
	}>;
}

export interface LazyDevTunnelMetrics {
	readonly loadAttempts: number;
	readonly probeAttempts: number;
	readonly ensureHostedAttempts: number;
}

/**
 * Keeps the Dev Tunnel implementation out of the local Broker/task startup
 * path. Loading and CLI probing begin only from an explicit Listener/E2E action
 * or Listener auto-restore.
 */
export class LazyVscodeDevTunnelProvider implements DevTunnelProvider {
	private readonly listeners = new Set<() => void>();
	private delegate: LazyDevTunnelDelegate | undefined;
	private loading: Promise<LazyDevTunnelDelegate> | undefined;
	private delegateSubscription: { dispose(): void } | undefined;
	private disposal: Promise<void> | undefined;
	private disposeRequested = false;
	private disposed = false;
	private loadAttempts = 0;
	private probeAttempts = 0;
	private ensureHostedAttempts = 0;

	public constructor(private readonly options: LazyVscodeDevTunnelProviderOptions) {}

	public async probe(): Promise<TunnelCapability> {
		this.probeAttempts += 1;
		return (await this.load()).probe();
	}

	public async ensureHosted(request: TunnelRequest): Promise<HostedTunnel> {
		this.ensureHostedAttempts += 1;
		return (await this.load()).ensureHosted(request);
	}

	public async renewAccess(): Promise<TunnelMetadata> {
		return (await this.load()).renewAccess();
	}

	public async stop(): Promise<void> {
		await this.delegate?.stop();
	}

	public dispose(): Promise<void> {
		if (this.disposed) {
			return this.disposal ?? Promise.resolve();
		}
		if (this.disposal !== undefined) {
			return this.disposal;
		}
		this.disposeRequested = true;
		let disposal!: Promise<void>;
		disposal = this.disposeCore().finally(() => {
			if (!this.disposed && this.disposal === disposal) {
				this.disposal = undefined;
			}
		});
		this.disposal = disposal;
		return disposal;
	}

	public getStatus(): DevTunnelRuntimeStatus {
		return this.delegate?.getStatus() ?? { state: 'stopped' };
	}

	public lifecycleMetrics(): LazyDevTunnelMetrics {
		return {
			loadAttempts: this.loadAttempts,
			probeAttempts: this.probeAttempts,
			ensureHostedAttempts: this.ensureHostedAttempts,
		};
	}

	public onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	public async deleteOwnedForE2e(
		capability: E2eCapability,
	): Promise<'deleted' | 'already-absent'> {
		return (await this.load()).deleteOwnedForE2e(capability);
	}

	public async ownedMetadataForE2e(capability: E2eCapability): Promise<{
		readonly build: string;
		readonly decoderRevision: string;
		readonly executablePath: string;
		readonly localPort: number;
		readonly ownershipLabel: string;
		readonly tunnelId: string;
	}> {
		return (await this.load()).ownedMetadataForE2e(capability);
	}

	private load(): Promise<LazyDevTunnelDelegate> {
		if (this.disposeRequested || this.disposed) {
			return Promise.reject(new Error('The lazy Dev Tunnel provider is disposed.'));
		}
		if (this.loading !== undefined) {
			return this.loading;
		}
		let loading!: Promise<LazyDevTunnelDelegate>;
		loading = this.loadOnce().catch((error: unknown) => {
			if (this.loading === loading) {
				this.loading = undefined;
			}
			throw error;
		});
		this.loading = loading;
		return loading;
	}

	private async loadOnce(): Promise<LazyDevTunnelDelegate> {
		this.loadAttempts += 1;
		const delegate = this.options.loadProvider === undefined
			? new (await import('../tunnel/DevTunnelCliProvider.js')).DevTunnelCliProvider(
				this.options,
			)
			: await this.options.loadProvider();
		this.delegate = delegate;
		this.delegateSubscription = delegate.onDidChange?.(() => {
			for (const listener of this.listeners) {
				try {
					listener();
				} catch (error: unknown) {
					this.options.reportStatusListenerError?.(error);
				}
			}
		});
		if (this.disposeRequested || this.disposed) {
			throw new Error('The lazy Dev Tunnel provider was disposed while loading.');
		}
		return delegate;
	}

	private async disposeCore(): Promise<void> {
		await this.loading?.catch(() => undefined);
		const failures: unknown[] = [];
		const delegate = this.delegate;
		if (delegate !== undefined) {
			try {
				await delegate.dispose();
				if (this.delegate === delegate) {
					this.delegate = undefined;
				}
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		const subscription = this.delegateSubscription;
		if (subscription !== undefined) {
			try {
				subscription.dispose();
				if (this.delegateSubscription === subscription) {
					this.delegateSubscription = undefined;
				}
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				'The lazy Dev Tunnel provider did not release every loaded resource.',
			);
		}
		this.loading = undefined;
		this.disposed = true;
		this.listeners.clear();
	}
}
