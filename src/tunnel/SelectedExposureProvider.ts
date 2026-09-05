import { ConnectivityError } from '../connectivity/ConnectivitySchemas';
import type { RemoteExposureProvider, RemoteExposure } from './RemoteExposureProvider';

/** Selection is persisted by the migration workflow, never inferred from a failed private start. */
export class SelectedExposureProvider implements RemoteExposureProvider {
	public readonly providerId = 'selected';
	private active: RemoteExposureProvider | undefined;
	private readonly listeners = new Set<() => void>();
	private readonly subscriptions: { dispose(): void }[];

	public constructor(
		private readonly cli: RemoteExposureProvider,
		private readonly sdk: RemoteExposureProvider,
		private readonly selected: () => 'cli' | 'sdk',
		private readonly permitted: () => boolean,
	) {
		this.subscriptions = [cli, sdk].map((provider) => provider.onDidChange(() => {
			if (provider === (this.active ?? this.current())) {
				for (const listener of this.listeners) { listener(); }
			}
		}));
	}

	public probe() {
		if (!this.permitted()) {
			throw new ConnectivityError('MIGRATION_REQUIRED');
		}
		return this.current().probe();
	}

	public async start(request: { readonly localPort: number; readonly deviceId: string }): Promise<RemoteExposure> {
		if (!this.permitted()) {
			throw new ConnectivityError('MIGRATION_REQUIRED');
		}
		const provider = this.current();
		if (this.active !== undefined && this.active !== provider) {
			throw new ConnectivityError('MIGRATION_REQUIRED');
		}
		this.active = provider;
		return provider.start(request);
	}

	public cancel(): void { this.active?.cancel?.(); }
	public async stop(): Promise<void> {
		const provider = this.active ?? this.current();
		await provider.stop();
		this.active = undefined;
	}
	public async dispose(): Promise<void> {
		await this.stop();
		const results = await Promise.allSettled([this.cli.dispose(), this.sdk.dispose()]);
		if (results.some((result) => result.status === 'rejected')) {
			throw new ConnectivityError('CLEANUP_FAILED');
		}
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.listeners.clear();
	}
	public getStatus() { return (this.active ?? this.current()).getStatus(); }
	public onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}
	private current(): RemoteExposureProvider { return this.selected() === 'cli' ? this.cli : this.sdk; }
}
