import { z } from 'zod';

import { PROTOCOL_LIMITS, utf8String } from './limits';
import { uuidSchema } from './models';

export const REMOTE_POLICY_ACTIONS = [
	'setRemoteAutoAccept', 'setRemoteReceive', 'setRemoteAllowed',
] as const;
export type RemotePolicyAction = typeof REMOTE_POLICY_ACTIONS[number];

export const remotePolicyDashboardParamsSchema = z.strictObject({
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
});

export const remotePolicyActionParamsSchema = remotePolicyDashboardParamsSchema.extend({
	action: z.enum(REMOTE_POLICY_ACTIONS),
	actionHandle: uuidSchema,
	enabled: z.boolean(),
});

const label = utf8String(PROTOCOL_LIMITS.nameBytes, 'remote policy display label', 1);
export const remotePolicyDashboardSchema = z.strictObject({
	peerStates: z.array(z.strictObject({
		profileId: uuidSchema,
		deviceId: uuidSchema,
		state: z.enum(['connecting', 'online', 'busy', 'offline', 'authFailed', 'incompatible']),
	})).max(32).default([]),
	workspaces: z.array(z.strictObject({
		workspaceId: uuidSchema,
		name: label,
		acceptsIncoming: z.boolean(),
		receiveActionHandle: uuidSchema,
		incomingPeers: z.array(z.strictObject({
			peerId: uuidSchema,
			label,
			autoAccept: z.boolean(),
			actionHandle: uuidSchema,
		})).max(32),
	})).max(PROTOCOL_LIMITS.workspaceListCount),
	remoteTargets: z.array(z.strictObject({
		profileId: uuidSchema,
		deviceId: uuidSchema,
		nodeId: uuidSchema,
		nodeInstanceId: uuidSchema,
		workspaceId: uuidSchema,
		allowlisted: z.boolean(),
		acceptsIncoming: z.boolean(),
		canDelegate: z.boolean(),
		actionHandle: uuidSchema.optional(),
	})).max(PROTOCOL_LIMITS.nodeListCount),
	truncated: z.boolean(),
});

export type RemotePolicyDashboard = z.infer<typeof remotePolicyDashboardSchema>;
export type RemotePolicyActionParams = z.infer<typeof remotePolicyActionParamsSchema>;
