import type { StateStore } from '../domain/ports';
import type { GatewayServer } from '../gateway/GatewayServer';
import type { PairingService } from '../gateway/PairingService';
import type {
	DevTunnelProvider,
	DevTunnelRuntimeStatus,
	HostedTunnel,
} from '../tunnel/DevTunnelProvider';
import type { LocalDesktopWorkspaceGuard } from './LocalDesktopWorkspaceGuard';

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
}

export class ListenerService {
	private readonly listeners = new Set<() => void>();
	private gateway: GatewayServer | undefined;
	private hosted: HostedTunnel | undefined;
	private state: ListenerLifecycleState = 'stopped';
	private operation: Promise<void> = Promise.resolve();
	private lastError: ListenerSnapshot['error'];
	private disposed = false;

	public constructor(
		private readonly deviceId: string,
		private readonly pairing: PairingService,
		private readonly tunnel: DevTunnelProvider,
		private readonly createGateway: () => GatewayServer,
		private readonly metadata: StateStore,
		private readonly guard: LocalDesktopWorkspaceGuard,
		private readonly options: ListenerServiceOptions = {},
	) {}

	public async restore(): Promise<void> {
		this.guard.assertAllowed({ requireWorkspace: false });
		const persisted = this.read();
		if (persisted.enabled) {
			await this.start();
		}
	}

	public start(): Promise<void> {
		this.guard.assertAllowed({ requireWorkspace: false });
		return this.serialize(() => this.startCore());
	}

	public stop(): Promise<void> {
		this.guard.assertAllowed({ requireWorkspace: false });
		return this.serialize(() => this.stopCore(true));
	}

	public restart(): Promise<void> {
		this.guard.assertAllowed({ requireWorkspace: false });
		return this.serialize(async () => {
			await this.stopCore(false);
			await this.startCore();
		});
	}

	public async createConnectionUrl(): Promise<string> {
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
		await this.serialize(() => this.stopCore(false));
		this.disposed = true;
		await this.tunnel.dispose();
		this.listeners.clear();
	}

	private async startCore(): Promise<void> {
		if (this.disposed) {
			throw new Error('Listener service is disposed.');
		}
		if (this.state === 'running') {
			return;
		}
		this.state = 'starting';
		this.lastError = undefined;
		this.changed();
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
			const suffix = this.deviceId.replaceAll('-', '').slice(0, 18);
			this.hosted = await this.tunnel.ensureHosted({
				accessDuration: this.options.accessDuration ?? '1d',
				healthPath: '/healthz',
				localPort: address.port,
				ownershipLabel: `copilot-agent-mesh-${this.deviceId}`,
				tunnelAlias: `cam${suffix}`,
				tunnelExpiration: this.options.tunnelExpiration ?? '30d',
				wssExpectedResponse: probeResponse,
				wssPath: '/agent-mesh/rpc',
				wssProbeRequest: probeRequest,
			});
			this.state = 'running';
			this.changed();
		} catch (error) {
			await Promise.allSettled([gateway.dispose(), this.tunnel.stop()]);
			if (this.gateway === gateway) {
				this.gateway = undefined;
			}
			this.hosted = undefined;
			this.state = 'error';
			this.lastError = {
				code: 'LISTENER_START_FAILED',
				message: error instanceof Error ? error.message : 'Listener startup failed.',
			};
			this.changed();
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
