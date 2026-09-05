import { z } from 'zod';
import { uuidSchema } from './models';

export const CONNECTIVITY_ACTIONS = [
	'configureConnectivity', 'refreshDiscovery', 'pairDiscoveredPeer',
	'configureRemotePolicy', 'revokeIncomingPeer', 'retryConnectivityCleanup',
] as const;
export type ConnectivityAction = typeof CONNECTIVITY_ACTIONS[number];

export const connectivitySnapshotParamsSchema = z.strictObject({
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
});
export const connectivityActionParamsSchema = connectivitySnapshotParamsSchema.extend({
	action: z.enum(CONNECTIVITY_ACTIONS),
	actionHandle: uuidSchema.optional(),
}).refine((value) => (
	value.action === 'pairDiscoveredPeer' || value.action === 'revokeIncomingPeer'
) === (value.actionHandle !== undefined), 'This connectivity action requires an exact handle.');

export const connectivitySnapshotSchema = z.strictObject({
	discoveryEnabled: z.boolean(),
	delegationEnabled: z.boolean(),
	strictPolicyActivated: z.boolean(),
	publishEnabled: z.boolean(),
	hostingBackend: z.enum(['cli', 'sdk']),
	migrationPending: z.boolean(),
	accountProvider: z.enum(['none', 'github', 'microsoft']),
	claimedWorkspaceCount: z.number().int().min(0).max(32),
	receivingWorkspaceCount: z.number().int().min(0).max(32),
	state: z.enum(['disabled', 'authRequired', 'discovering', 'ready', 'error']),
	error: z.enum([
		'DISABLED', 'AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED', 'OFFLINE',
		'DISCOVERY_UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT', 'CANCELLED', 'INVALID_ENDPOINT',
		'BINDING_CHANGED', 'POLICY_DENIED', 'PRIVATE_ACCESS_REQUIRED', 'CLEANUP_FAILED', 'MIGRATION_REQUIRED', 'PROTOCOL_INCOMPATIBLE',
	]).optional(),
	truncated: z.boolean(),
	candidates: z.array(z.strictObject({
		actionHandle: uuidSchema,
		label: z.string().regex(/^Candidate [0-9a-f]{8}$/u),
		hostHint: z.enum(['online', 'offline', 'unknown']),
		stale: z.boolean(),
		admission: z.enum(['legacy-mesh-auth', 'private-port-token']),
	})).max(10),
	incomingPeers: z.array(z.strictObject({
		actionHandle: uuidSchema,
		label: z.string().regex(/^Peer [0-9a-f]{8}$/u),
		state: z.enum(['active', 'pending', 'revoked']),
		cleanupPending: z.boolean(),
	})).max(256),
});
export type ConnectivitySnapshot = z.infer<typeof connectivitySnapshotSchema>;
export type ConnectivityActionParams = z.infer<typeof connectivityActionParamsSchema>;

export const DISABLED_CONNECTIVITY_SNAPSHOT: ConnectivitySnapshot = {
	discoveryEnabled: false, delegationEnabled: false, strictPolicyActivated: false,
	publishEnabled: false, hostingBackend: 'cli', migrationPending: false, accountProvider: 'none',
	claimedWorkspaceCount: 0, receivingWorkspaceCount: 0,
	state: 'disabled', truncated: false, candidates: [], incomingPeers: [],
};
