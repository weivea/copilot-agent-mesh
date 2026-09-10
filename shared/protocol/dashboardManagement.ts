import { z } from 'zod';

import { PROTOCOL_LIMITS, utf8ByteLength, utf8String } from './limits';
import { uuidSchema } from './models';

export const DASHBOARD_MANAGEMENT_ACTIONS = [
	'switchAccount', 'probeDevice', 'revokeDevice', 'deleteSavedDevice',
	'setWorkspaceReceiving', 'setIncomingDeviceGrant', 'setDeviceAutoAccept',
	'setTargetAllowed', 'setWindowTargetAllowed', 'setWorkspaceEnabled',
	'removeManagedWorkspace',
] as const;
export type DashboardManagementAction = typeof DASHBOARD_MANAGEMENT_ACTIONS[number];
export const MANAGEMENT_BOOLEAN_ACTIONS: ReadonlySet<DashboardManagementAction> = new Set([
	'setWorkspaceReceiving', 'setIncomingDeviceGrant', 'setDeviceAutoAccept',
	'setTargetAllowed', 'setWindowTargetAllowed', 'setWorkspaceEnabled',
]);

const label = utf8String(PROTOCOL_LIMITS.nameBytes, 'management label', 1);
const key = z.string().regex(/^manage-(?:workspace|target|device|peer)-[1-9][0-9]*$/).max(64);
export const DASHBOARD_MANAGEMENT_BYTES = 192 * 1024;
export function createDashboardManagementSchema(actionHandleSchema: z.ZodType<string>) {
	return z.strictObject({
		available: z.boolean(),
		truncated: z.boolean(),
		accountActionHandle: actionHandleSchema.optional(),
		devices: z.array(z.strictObject({
			key, name: label,
			state: z.enum(['connecting', 'online', 'busy', 'offline', 'authFailed', 'incompatible', 'unknown', 'pending', 'revoked']),
			cleanupPending: z.boolean(),
			activeTaskCount: z.number().int().nonnegative().optional(),
			deleteBlockedReason: utf8String(1024, 'deletion block reason', 1).optional(),
			lastSeen: utf8String(128, 'last seen', 1).optional(),
			deleteActionHandle: actionHandleSchema.optional(),
			revokeActionHandle: actionHandleSchema.optional(),
			probeActionHandle: actionHandleSchema.optional(),
		}).refine((device) => device.deleteActionHandle === undefined
			|| (device.activeTaskCount === 0 && device.deleteBlockedReason === undefined),
		'Saved-device deletion requires confirmed zero unfinished tasks and no deletion blocker.')).max(32),
		workspaces: z.array(z.strictObject({
			key, name: label, enabled: z.boolean(), acceptsIncoming: z.boolean(),
			receiveActionHandle: actionHandleSchema.optional(),
			enableActionHandle: actionHandleSchema.optional(),
			removeActionHandle: actionHandleSchema.optional(),
			incomingPeers: z.array(z.strictObject({
				key, name: label, allowed: z.boolean(),
				allowActionHandle: actionHandleSchema.optional(),
				autoAccept: z.boolean(),
				autoAcceptActionHandle: actionHandleSchema.optional(),
			})).max(32),
		})).max(PROTOCOL_LIMITS.workspaceListCount),
		targets: z.array(z.strictObject({
			key, deviceName: label, windowName: label, workspaceName: label,
			locality: z.enum(['local', 'remote']), online: z.boolean(),
			sources: z.array(z.strictObject({
				sourceKey: key, allowed: z.boolean(), actionHandle: actionHandleSchema.optional(),
			})).max(PROTOCOL_LIMITS.workspaceListCount),
			allSourcesActionHandle: actionHandleSchema.optional(),
			allSourcesAllowed: z.enum(['all', 'some', 'none']),
		})).max(PROTOCOL_LIMITS.nodeListCount),
	}).refine((snapshot) => utf8ByteLength(JSON.stringify(snapshot)) <= DASHBOARD_MANAGEMENT_BYTES,
		'Management data exceeds the bounded display budget.');
}

export const dashboardManagementSnapshotSchema = createDashboardManagementSchema(uuidSchema);
export type DashboardManagement = z.infer<typeof dashboardManagementSnapshotSchema>;
export type DashboardManagementActionParams = z.infer<typeof dashboardManagementActionParamsSchema>;
export const dashboardManagementParamsSchema = z.strictObject({
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
});
export const dashboardManagementActionParamsSchema = dashboardManagementParamsSchema.extend({
	action: z.enum(DASHBOARD_MANAGEMENT_ACTIONS),
	actionHandle: uuidSchema,
	enabled: z.boolean().optional(),
}).superRefine((value, context) => {
	if (MANAGEMENT_BOOLEAN_ACTIONS.has(value.action) !== (value.enabled !== undefined)) {
		context.addIssue({ code: 'custom', message: 'Boolean value is required only for set actions.', path: ['enabled'] });
	}
});
