import type { EndpointLocator, PeerAdmission, TunnelResource } from '../connectivity/ConnectivitySchemas';

export interface RemoteExposure {
	readonly provider: 'cli' | 'sdk';
	readonly admission: PeerAdmission;
	readonly localPort: number;
	readonly forwardingOrigin: string;
	readonly resource: TunnelResource;
	readonly locator?: EndpointLocator;
	readonly ownershipLabel: string;
}

export type RemoteExposureStatus =
	| { readonly state: 'idle' | 'stopped' | 'starting' }
	| { readonly state: 'ready'; readonly tunnel: RemoteExposure }
	| { readonly state: 'backoff'; readonly attempt: number; readonly retryAt: string }
	| { readonly state: 'cleanup-failed'; readonly message: string }
	| { readonly state: 'circuit-open'; readonly code: string; readonly message?: string };

export interface RemoteExposureProvider {
	readonly providerId: 'cli' | 'sdk' | 'selected';
	probe(): Promise<{ readonly supported: boolean; readonly reason?: string }>;
	start(request: { readonly localPort: number; readonly deviceId: string }): Promise<RemoteExposure>;
	cancel?(): void;
	stop(): Promise<void>;
	dispose(): Promise<void>;
	getStatus(): RemoteExposureStatus;
	onDidChange(listener: () => void): { dispose(): void };
}
