export type DevTunnelErrorCode =
	| 'CLI_COMMAND_FAILED'
	| 'CLI_UNSUPPORTED'
	| 'HOST_CIRCUIT_OPEN'
	| 'HOST_START_FAILED'
	| 'HTTPS_HEALTH_FAILED'
	| 'LOGIN_REQUIRED'
	| 'PORT_CONFLICT'
	| 'PORT_MIGRATION_REQUIRED'
	| 'TUNNEL_ACCESS_EXPIRED'
	| 'TUNNEL_METADATA_INVALID'
	| 'TUNNEL_NOT_FOUND'
	| 'WSS_PROBE_FAILED';

export class DevTunnelProviderError extends Error {
	constructor(
		readonly code: DevTunnelErrorCode,
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = 'DevTunnelProviderError';
	}
}

export interface TunnelCapability {
	readonly build?: string;
	readonly loggedIn: boolean;
	readonly supported: boolean;
	readonly reason?: DevTunnelErrorCode;
}

export interface TunnelRequest {
	readonly accessDuration: `${number}h` | `${number}d`;
	readonly healthPath: `/${string}`;
	readonly localPort: number;
	readonly ownershipLabel: string;
	readonly tunnelAlias: string;
	readonly tunnelExpiration: `${number}h` | `${number}d`;
	readonly wssExpectedResponse: string;
	readonly wssPath: `/${string}`;
	readonly wssProbeRequest: string;
}

export interface TunnelMetadata {
	readonly accessDuration: `${number}h` | `${number}d`;
	readonly accessExpiresAt: string;
	readonly accessIndex: number;
	readonly build: string;
	readonly decoderRevision: string;
	readonly forwardingOrigin?: string;
	readonly localPort: number;
	readonly ownershipLabel: string;
	readonly provisioned: boolean;
	readonly tunnelAlias: string;
	readonly tunnelExpiresAt: string;
	readonly tunnelId: string;
}

export interface HostedTunnel extends TunnelMetadata {
	readonly forwardingOrigin: string;
	readonly status: 'ready';
}

export type DevTunnelRuntimeStatus =
	| { readonly state: 'idle' | 'stopped' }
	| { readonly state: 'starting' }
	| { readonly state: 'ready'; readonly tunnel: HostedTunnel }
	| { readonly state: 'backoff'; readonly attempt: number; readonly retryAt: string }
	| { readonly state: 'cleanup-failed'; readonly message: string }
	| { readonly state: 'circuit-open'; readonly code: DevTunnelErrorCode; readonly message?: string };

export interface DevTunnelStateStore {
	load(): Promise<TunnelMetadata | undefined>;
	save(metadata: TunnelMetadata): Promise<void>;
}

export interface DevTunnelProvider {
	probe(): Promise<TunnelCapability>;
	ensureHosted(request: TunnelRequest): Promise<HostedTunnel>;
	renewAccess(): Promise<TunnelMetadata>;
	stop(): Promise<void>;
	dispose(): Promise<void>;
	getStatus(): DevTunnelRuntimeStatus;
	onDidChange?(listener: () => void): { dispose(): void };
}
