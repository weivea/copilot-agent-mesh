import { tunnelResourceSchema } from '../connectivity/ConnectivitySchemas';
import type { DevTunnelProvider, HostedTunnel } from './DevTunnelProvider';
import type { RemoteExposure, RemoteExposureProvider, RemoteExposureStatus } from './RemoteExposureProvider';

export const MESH_READINESS_REQUEST = 'mesh-readiness-probe';
export const MESH_READINESS_RESPONSE = JSON.stringify({
	jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' },
});

export class CliDevTunnelExposureAdapter implements RemoteExposureProvider {
	public readonly providerId = 'cli';

	public constructor(
		private readonly cli: DevTunnelProvider,
		private readonly options: {
			readonly accessDuration?: `${number}h` | `${number}d`;
			readonly tunnelExpiration?: `${number}h` | `${number}d`;
		} = {},
	) {}

	public probe() {
		return this.cli.probe();
	}

	public async start(request: { readonly localPort: number; readonly deviceId: string }): Promise<RemoteExposure> {
		const compact = request.deviceId.replaceAll('-', '');
		return describeCliExposure(await this.cli.ensureHosted({
			accessDuration: this.options.accessDuration ?? '1d',
			healthPath: '/healthz', localPort: request.localPort,
			ownershipLabel: `copilot-agent-mesh-${compact.slice(0, 31)}`,
			tunnelAlias: `cam${compact.slice(0, 18)}`,
			tunnelExpiration: this.options.tunnelExpiration ?? '30d',
			wssExpectedResponse: MESH_READINESS_RESPONSE,
			wssPath: '/agent-mesh/rpc', wssProbeRequest: MESH_READINESS_REQUEST,
		}));
	}

	public stop(): Promise<void> { return this.cli.stop(); }
	public dispose(): Promise<void> { return this.cli.dispose(); }
	public onDidChange(listener: () => void): { dispose(): void } {
		return this.cli.onDidChange?.(listener) ?? { dispose: () => undefined };
	}
	public getStatus(): RemoteExposureStatus {
		const status = this.cli.getStatus();
		return status.state === 'ready' ? { state: 'ready', tunnel: describeCliExposure(status.tunnel) } : status;
	}
}

function describeCliExposure(tunnel: HostedTunnel): RemoteExposure {
	const [tunnelId, clusterId] = tunnel.tunnelId.split('.');
	return {
		provider: 'cli', admission: 'legacy-mesh-auth', localPort: tunnel.localPort,
		forwardingOrigin: tunnel.forwardingOrigin,
		resource: tunnelResourceSchema.parse({ clusterId, tunnelId }),
		ownershipLabel: tunnel.ownershipLabel,
	};
}
