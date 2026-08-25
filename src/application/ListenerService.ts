import type { StateStore } from '../domain/ports';
import type {
	DevTunnelProvider,
	DevTunnelRuntimeStatus,
	HostedTunnel,
} from '../tunnel/DevTunnelProvider';
import type { LocalDesktopWorkspaceGuard } from './LocalDesktopWorkspaceGuard';
import type { WorkerPlatformSupport } from './WorkerPlatformSupport';
import type { WorkerOwnership } from '../storage/WorkerOwnerLock';

const listenerStateKey = 'copilotAgentMesh.listener';
const probeRequest = 'mesh-readiness-probe';
const probeResponse = JSON.stringify({
	jsonrpc: '2.0',
	id: null,
	error: { code: -32700, message: 'Parse error.' },
});

interface PersistedListenerState {
	readonly schemaVersion: 1;
	readonly enabled: boolean;
	readonly preferredPort?: number;
}

export type ListenerLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface ListenerSnapshot {
	readonly state: ListenerLifecycleState;
	readonly port?: number;
	readonly forwardingOrigin?: string;
	readonly tunnel: DevTunnelRuntimeStatus;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface ListenerServiceOptions {
	readonly accessDuration?: `${number}h` | `${number}d`;
	readonly tunnelExpiration?: `${number}h` | `${number}d`;
	readonly configuredPort?: () => number | undefined;
	readonly workerPlatform?: WorkerPlatformSupport;
	readonly ownership?: WorkerOwnership;
}

export interface ListenerGateway {
	start(preferredPort?: number): Promise<{ readonly port: number }>;
	dispose(): Promise<void>;
	notifyPeer(
		peerId: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<void>;
}

export interface ListenerPairing {
	createInvitation(origin: string): Promise<{ readonly url: string }>;
	dispose(): Promise<void>;
}

export class ListenerService {
	private readonly listeners = new Set<() => void>();
	private gateway: ListenerGateway | undefined;
	private hosted: HostedTunnel | undefined;
	private state: ListenerLifecycleState = 'stopped';
	private operation: Promise<void> = Promise.resolve();
	private lastError: ListenerSnapshot['error'];
	private disposed = false;
	private ownsResources = false;

	public constructor(
		private readonly deviceId: string,
		private readonly pairing: ListenerPairing,
		private readonly tunnel: DevTunnelProvider,
		private readonly createGateway: () => ListenerGateway,
		private readonly metadata: StateStore,
		private readonly guard: LocalDesktopWorkspaceGuard,
		private readonly options: ListenerServiceOptions = {},
	) {}

	public async restore(): Promise<void> {
		await this.options.ownership?.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		const persisted = this.read();
		if (persisted.enabled) {
			await this.start();
		}
	}

	public start(): Promise<void> {
		this.guard.assertAllowed({ requireWorkspace: false });
		return this.serialize(async () => {
			await this.options.ownership?.assertOwner();
			await this.startCore();
		});
	}

	public stop(): Promise<void> {
		this.guard.assertAllowed({ requireWorkspace: false });
		return this.serialize(async () => {
			if (!this.ownsResources) {
				await this.options.ownership?.assertOwner();
			}
			await this.stopCore(true);
		});
	}

	public restart(): Promise<void> {
		this.guard.assertAllowed({ requireWorkspace: false });
		return this.serialize(async () => {
			await this.options.ownership?.assertOwner();
			await this.stopCore(false);
			await this.startCore();
		});
	}

	public async createConnectionUrl(): Promise<string> {
		await this.options.ownership?.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		if (this.state !== 'running' || this.hosted === undefined) {
			throw new Error('Start the listener before creating a connection URL.');
		}
		return (await this.pairing.createInvitation(this.hosted.forwardingOrigin)).url;
	}

	public snapshot(): ListenerSnapshot {
		return {
			state: this.state,
			port: this.hosted?.localPort,
			forwardingOrigin: this.hosted?.forwardingOrigin,
			tunnel: this.tunnel.getStatus(),
			error: this.lastError,
		};
	}

	public publish(
		peerId: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<void> {
		if (!this.ownsResources) {
			return Promise.resolve();
		}
		return this.gateway?.notifyPeer(peerId, method, params) ?? Promise.resolve();
	}

	public onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (!this.ownsResources && this.options.ownership?.isOwner() === false) {
			this.disposed = true;
			this.listeners.clear();
			return;
		}
		await this.serialize(() => this.disposeCore());
	}

	private async startCore(): Promise<void> {
		if (this.disposed) {
			throw new Error('Listener service is disposed.');
		}
		if (this.state === 'running') {
			return;
		}
		if (this.gateway !== undefined || this.hosted !== undefined) {
			await this.stopCore(false);
		}
		this.ownsResources = true;
		this.state = 'starting';
		this.lastError = undefined;
		this.changed();
		if (this.options.workerPlatform?.supported === false) {
			this.state = 'error';
			this.lastError = {
				code: this.options.workerPlatform.listenerCode,
				message: this.options.workerPlatform.listenerMessage,
			};
			this.changed();
			throw new Error(this.lastError.message);
		}
		const capability = await this.tunnel.probe();
		if (!capability.supported) {
			this.state = 'error';
			this.lastError = {
				code: capability.reason ?? 'TUNNEL_UNAVAILABLE',
				message: 'The exact supported Dev Tunnel CLI build is unavailable.',
			};
			this.changed();
			throw new Error(this.lastError.message);
		}
		const persisted = this.read();
		const configured = this.options.configuredPort?.();
		const preferredPort = configured ?? persisted.preferredPort;
		const gateway = this.createGateway();
		this.gateway = gateway;
		try {
			const address = await gateway.start(preferredPort);
			await this.metadata.update(listenerStateKey, {
				schemaVersion: 1,
				enabled: true,
				preferredPort: address.port,
			});
			const compactDeviceId = this.deviceId.replaceAll('-', '');
			const suffix = compactDeviceId.slice(0, 18);
			this.hosted = await this.tunnel.ensureHosted({
				accessDuration: this.options.accessDuration ?? '1d',
				healthPath: '/healthz',
				localPort: address.port,
				ownershipLabel: `copilot-agent-mesh-${compactDeviceId.slice(0, 31)}`,
				tunnelAlias: `cam${suffix}`,
				tunnelExpiration: this.options.tunnelExpiration ?? '30d',
				wssExpectedResponse: probeResponse,
				wssPath: '/agent-mesh/rpc',
				wssProbeRequest: probeRequest,
			});
			this.state = 'running';
			this.changed();
		} catch (error) {
			const cleanup = await Promise.allSettled([gateway.dispose(), this.tunnel.stop()]);
			if (cleanup[0]?.status === 'fulfilled' && this.gateway === gateway) {
				this.gateway = undefined;
			}
			if (cleanup[1]?.status === 'fulfilled') {
				this.hosted = undefined;
			}
			this.state = 'error';
			this.lastError = {
				code: 'LISTENER_START_FAILED',
				message: error instanceof Error ? error.message : 'Listener startup failed.',
			};
			this.changed();
			const cleanupFailures = cleanup.flatMap((result) =>
				result.status === 'rejected' ? [result.reason] : [],
			);
			if (cleanupFailures.length > 0) {
				throw new AggregateError(
					[error, ...cleanupFailures],
					'Listener startup failed and one or more owned resources require cleanup retry.',
				);
			}
			throw error;
		}
	}

	private async stopCore(persistStopped: boolean): Promise<void> {
		if (this.state === 'stopped' && this.gateway === undefined) {
			if (persistStopped) {
				await this.metadata.update(listenerStateKey, {
					...this.read(),
					schemaVersion: 1,
					enabled: false,
				});
			}
			return;
		}
		this.state = 'stopping';
		this.changed();
		const gateway = this.gateway;
		const results = await Promise.allSettled([
			gateway?.dispose() ?? Promise.resolve(),
			this.tunnel.stop(),
		]);
		const failures = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		);
		if (failures.length > 0) {
			this.state = 'error';
			this.lastError = {
				code: 'LISTENER_STOP_FAILED',
				message: 'One or more owned listener resources could not be stopped.',
			};
			this.changed();
			throw new AggregateError(failures, this.lastError.message);
		}
		this.gateway = undefined;
		this.hosted = undefined;
		this.state = 'stopped';
		this.lastError = undefined;
		if (persistStopped) {
			await this.metadata.update(listenerStateKey, {
				...this.read(),
				schemaVersion: 1,
				enabled: false,
			});
		}
		this.changed();
	}

	private async disposeCore(): Promise<void> {
		let stopFailure: unknown;
		try {
			await this.stopCore(false);
		} catch (error) {
			stopFailure = error;
		}

		const gateway = this.gateway;
		const cleanup = await Promise.allSettled([
			gateway?.dispose() ?? Promise.resolve(),
			this.tunnel.dispose(),
			this.pairing.dispose(),
		]);
		const cleanupFailures = cleanup.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		);
		if (cleanup[0]?.status === 'fulfilled' && this.gateway === gateway) {
			this.gateway = undefined;
		}
		if (cleanup[1]?.status === 'fulfilled') {
			this.hosted = undefined;
		}
		if (cleanupFailures.length > 0) {
			this.state = 'error';
			this.lastError = {
				code: 'LISTENER_STOP_FAILED',
				message: 'One or more owned listener resources could not be disposed; retry disposal.',
			};
			this.changed();
			throw new AggregateError(
				stopFailure === undefined ? cleanupFailures : [stopFailure, ...cleanupFailures],
				this.lastError.message,
			);
		}

		this.gateway = undefined;
		this.hosted = undefined;
		this.state = 'stopped';
		this.lastError = undefined;
		this.disposed = true;
		this.ownsResources = false;
		this.listeners.clear();
	}

	private read(): PersistedListenerState {
		const value = this.metadata.get<PersistedListenerState>(listenerStateKey);
		if (value === undefined) {
			return { schemaVersion: 1, enabled: false };
		}
		if (
			value.schemaVersion !== 1
			|| typeof value.enabled !== 'boolean'
			|| (value.preferredPort !== undefined
				&& (!Number.isInteger(value.preferredPort)
					|| value.preferredPort < 1
					|| value.preferredPort > 65_535))
		) {
			throw new TypeError('Invalid persisted listener metadata.');
		}
		return value;
	}

	private serialize(operation: () => Promise<void>): Promise<void> {
		const result = this.operation.then(operation, operation);
		this.operation = result.then(() => undefined, () => undefined);
		return result;
	}

	private changed(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}
