import { TunnelConstraints } from '@microsoft/dev-tunnels-contracts';
import { z } from 'zod';

import { timestampSchema, uuidSchema } from '../../shared/protocol';

export const DISCOVERY_LABELS = ['copilot-agent-mesh', 'mesh-discovery-v1', 'mesh-protocol-v2'];
export const PRIVATE_LABEL = 'mesh-private-v1';
export const ADVERTISEMENT_PREFIX = 'mesh-ad-';
export const REMOTE_POLICY_CAPABILITY = 'mesh.remote-policy.v1';

export const accountBindingSchema = z.strictObject({
	accountRef: uuidSchema,
	providerId: z.enum(['github', 'microsoft']),
	accountId: z.string().min(1).max(256),
	scopes: z.array(z.string().min(1).max(256)).min(1).max(8),
});
export type AccountBinding = z.infer<typeof accountBindingSchema>;

export const tunnelResourceSchema = z.strictObject({
	clusterId: z.string().regex(TunnelConstraints.clusterIdRegex),
	tunnelId: z.string().regex(new RegExp(`^${TunnelConstraints.newTunnelIdPattern}$`, 'u')),
});

export const endpointLocatorSchema = tunnelResourceSchema.extend({
	provider: z.literal('dev-tunnels'),
	portNumber: z.number().int().min(1).max(65535),
	advertisementId: uuidSchema,
});
export type EndpointLocator = z.infer<typeof endpointLocatorSchema>;
export type TunnelResource = z.infer<typeof tunnelResourceSchema>;
export const admissionSchema = z.enum(['legacy-mesh-auth', 'private-port-token']);
export type PeerAdmission = z.infer<typeof admissionSchema>;

export const endpointBindingSchema = z.strictObject({
	profileId: uuidSchema,
	profileGeneration: uuidSchema,
	expectedWorkerDeviceId: uuidSchema,
	accountRef: uuidSchema,
	locator: endpointLocatorSchema,
	admission: admissionSchema,
	verifiedOrigin: z.string().url().max(512),
	verifiedAt: timestampSchema,
});
export type PeerEndpointBinding = z.infer<typeof endpointBindingSchema>;

export const connectivitySettingsSchema = z.strictObject({
	schemaVersion: z.literal(1),
	revision: z.number().int().nonnegative(),
	account: accountBindingSchema.optional(),
	publishEnabled: z.boolean(),
	advertisementId: uuidSchema.optional(),
	strictPolicyActivated: z.boolean(),
	hostingBackend: z.enum(['cli', 'sdk']),
	// A failed migration stays stopped across restart until explicitly resolved.
	migrationPending: z.boolean(),
});
export type ConnectivitySettings = z.infer<typeof connectivitySettingsSchema>;

export const EMPTY_CONNECTIVITY_SETTINGS: ConnectivitySettings = {
	schemaVersion: 1,
	revision: 0,
	publishEnabled: false,
	strictPolicyActivated: false,
	hostingBackend: 'cli',
	migrationPending: false,
};

export type ConnectivityCode =
	| 'DISABLED' | 'AUTH_REQUIRED' | 'ACCOUNT_CHANGED' | 'SCOPES_CHANGED'
	| 'OFFLINE' | 'DISCOVERY_UNAVAILABLE' | 'RATE_LIMITED' | 'TIMEOUT'
	| 'CANCELLED' | 'INVALID_ENDPOINT' | 'BINDING_CHANGED' | 'POLICY_DENIED'
	| 'PRIVATE_ACCESS_REQUIRED' | 'CLEANUP_FAILED' | 'MIGRATION_REQUIRED' | 'PROTOCOL_INCOMPATIBLE';

const messages: Record<ConnectivityCode, string> = {
	DISABLED: 'Cross-device connectivity is disabled.',
	AUTH_REQUIRED: 'Authorize the selected account for Microsoft Dev Tunnels.',
	ACCOUNT_CHANGED: 'The selected discovery account is no longer available.',
	SCOPES_CHANGED: 'The selected account does not provide the exact Dev Tunnels scopes.',
	OFFLINE: 'The bound Mesh endpoint is unavailable.',
	DISCOVERY_UNAVAILABLE: 'Microsoft Dev Tunnels discovery is unavailable.',
	RATE_LIMITED: 'Microsoft Dev Tunnels requests are temporarily rate limited.',
	TIMEOUT: 'The connectivity operation exceeded its deadline.',
	CANCELLED: 'The connectivity operation was cancelled.',
	INVALID_ENDPOINT: 'The service returned an invalid Mesh endpoint.',
	BINDING_CHANGED: 'The peer, account, or endpoint binding changed. Explicit binding is required.',
	POLICY_DENIED: 'Cross-device policy does not permit this operation.',
	PRIVATE_ACCESS_REQUIRED: 'A fresh capability for this private tunnel port is required.',
	CLEANUP_FAILED: 'An owned remote resource still requires cleanup.',
	MIGRATION_REQUIRED: 'Stop the current host and explicitly select the hosting backend.',
	PROTOCOL_INCOMPATIBLE: 'The peer does not support the required Mesh protocol.',
};

export class ConnectivityError extends Error {
	public constructor(public readonly code: ConnectivityCode, public readonly retryAfterMs?: number) {
		super(messages[code]);
		this.name = 'ConnectivityError';
	}
}
