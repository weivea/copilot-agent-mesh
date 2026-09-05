import { z } from 'zod';

import { PROTOCOL_LIMITS, utf8ByteLength, utf8String } from '../../shared/protocol';

export const DASHBOARD_TREE_BYTES = 512 * 1024;

const key = z.string().regex(/^tree-[1-9][0-9]{0,8}$/u);
const label = utf8String(PROTOCOL_LIMITS.nameBytes, 'tree display label', 1);
const handle = z.string().regex(/^[A-Za-z0-9_-]{32}$/u);

export const dashboardTreeWorkspaceSchema = z.strictObject({
	key,
	name: label,
	claimStatus: z.enum(['claimed', 'readOnly', 'conflict']),
	enabled: z.boolean(),
	busy: z.boolean(),
	acceptsIncoming: z.boolean(),
	allowlisted: z.boolean(),
	gateState: z.enum(['allowed', 'notAllowed', 'notAccepting', 'offline', 'multiWorkspace', 'notClaimed', 'unavailable', 'self']),
	canDelegate: z.boolean(),
	delegateActionHandle: handle.optional(),
	allowActionHandle: handle.optional(),
	receiveActionHandle: handle.optional(),
	receiveAction: z.enum(['setAcceptIncoming', 'setRemoteReceive']).optional(),
	incomingPeers: z.array(z.strictObject({
		key,
		label,
		autoAccept: z.boolean(),
		actionHandle: handle,
	})).max(32),
});

export const dashboardDeviceTreeSchema = z.array(z.strictObject({
	key,
	name: label,
	locality: z.enum(['local', 'remote']),
	state: z.enum(['connecting', 'online', 'busy', 'offline', 'authFailed', 'incompatible', 'unknown']),
	nodes: z.array(z.strictObject({
		key,
		label,
		thisWindow: z.boolean(),
		status: z.enum(['online', 'busy', 'offline', 'conflict', 'draining']),
		workspaces: z.array(dashboardTreeWorkspaceSchema).max(PROTOCOL_LIMITS.workspaceListCount),
	})).max(PROTOCOL_LIMITS.nodeListCount),
})).max(33).superRefine((devices, context) => {
	const keys = new Set<string>();
	const remember = (value: string) => {
		if (keys.has(value)) { context.addIssue({ code: 'custom', message: 'Tree presentation keys must be unique.' }); }
		keys.add(value);
	};
	for (const device of devices) {
		remember(device.key);
		for (const node of device.nodes) {
			remember(node.key);
			if (node.thisWindow && device.locality !== 'local') {
				context.addIssue({ code: 'custom', message: 'A remote node cannot be the current window.' });
			}
			for (const workspace of node.workspaces) {
				remember(workspace.key);
				for (const peer of workspace.incomingPeers) { remember(peer.key); }
				if (workspace.canDelegate !== (workspace.delegateActionHandle !== undefined)
					|| (workspace.canDelegate && (node.thisWindow || !workspace.enabled || workspace.busy
						|| workspace.claimStatus !== 'claimed' || workspace.gateState !== 'allowed'))) {
					context.addIssue({ code: 'custom', message: 'Tree delegation must have an authorized exact-target action.' });
				}
				if ((workspace.receiveAction === undefined) !== (workspace.receiveActionHandle === undefined)
					|| ((workspace.receiveActionHandle !== undefined || workspace.incomingPeers.length > 0)
						&& (!node.thisWindow || device.locality !== 'local'))
					|| (node.thisWindow && workspace.allowActionHandle !== undefined)) {
					context.addIssue({ code: 'custom', message: 'Tree policy actions must belong to the appropriate Workspace.' });
				}
			}
		}
	}
	if (utf8ByteLength(JSON.stringify(devices)) > DASHBOARD_TREE_BYTES) {
		context.addIssue({ code: 'custom', message: 'Tree data exceeds the bounded display budget.' });
	}
});

export type DashboardDeviceTree = z.infer<typeof dashboardDeviceTreeSchema>;
export type DashboardTreeWorkspace = z.infer<typeof dashboardTreeWorkspaceSchema>;
