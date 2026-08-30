import { z } from 'zod';

import { PROTOCOL_LIMITS, utf8ByteLength, utf8String } from './limits';
import {
	deviceInfoSchema,
	recoveryDescriptorSchema,
	taskFailureSchema,
	taskSnapshotAfterEventSeqSchema,
	taskSnapshotSchema,
	timestampSchema,
	uuidSchema,
} from './models';

export const NODE_STATUSES = [
	'online',
	'busy',
	'offline',
	'conflict',
	'draining',
] as const;

export const WORKSPACE_CLAIM_STATUSES = [
	'claimed',
	'readOnly',
	'conflict',
] as const;

export const nodeStatusSchema = z.enum(NODE_STATUSES);
export const workspaceClaimStatusSchema = z.enum(WORKSPACE_CLAIM_STATUSES);

export const nodeWorkspaceSummarySchema = z.strictObject({
	workspaceId: uuidSchema,
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace name', 1),
	capabilityTags: z.array(utf8String(64, 'capability tag', 1)).max(32),
	enabled: z.boolean(),
	busy: z.boolean(),
	claimStatus: workspaceClaimStatusSchema,
	activeTaskId: uuidSchema.optional(),
});

export const windowNodeDescriptorSchema = z.strictObject({
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
	label: utf8String(PROTOCOL_LIMITS.nameBytes, 'window node label', 1),
	status: nodeStatusSchema,
	capabilities: z.array(
		utf8String(PROTOCOL_LIMITS.identifierBytes, 'node capability', 1),
	).max(32),
	startedAt: timestampSchema,
	lastHeartbeatAt: timestampSchema,
	workspaces: z.array(nodeWorkspaceSummarySchema).max(PROTOCOL_LIMITS.workspaceListCount),
});

export const nodeDirectoryResultSchema = z.strictObject({
	deviceId: uuidSchema,
	nodes: z.array(windowNodeDescriptorSchema).max(PROTOCOL_LIMITS.nodeListCount),
	truncated: z.boolean(),
	totalNodes: z.number().int().nonnegative().max(PROTOCOL_LIMITS.nodeListCount),
}).superRefine((result, context) => {
	validateTruncation(
		result.nodes.length,
		result.totalNodes,
		result.truncated,
		context,
		['totalNodes'],
	);
	if (serializedLocalResultBytes(result) > PROTOCOL_LIMITS.frameBytes) {
		context.addIssue({
			code: 'custom',
			message: 'Serialized node directory exceeds the protocol frame limit',
		});
	}
});

export const meshDeviceDirectoryEntrySchema = z.strictObject({
	peerId: uuidSchema.optional(),
	device: deviceInfoSchema,
	nodes: z.array(windowNodeDescriptorSchema).max(PROTOCOL_LIMITS.nodeListCount),
	nodesTruncated: z.boolean(),
	totalNodes: z.number().int().nonnegative().max(PROTOCOL_LIMITS.nodeListCount),
}).superRefine((entry, context) => {
	validateTruncation(
		entry.nodes.length,
		entry.totalNodes,
		entry.nodesTruncated,
		context,
		['totalNodes'],
	);
});

export const meshDirectoryResultSchema = z.strictObject({
	devices: z.array(meshDeviceDirectoryEntrySchema).max(PROTOCOL_LIMITS.deviceListCount),
	truncated: z.boolean(),
	totalDevices: z.number().int().nonnegative(),
}).superRefine((result, context) => {
	validateTruncation(
		result.devices.length,
		result.totalDevices,
		result.truncated,
		context,
		['totalDevices'],
	);
	if (serializedLocalResultBytes(result) > PROTOCOL_LIMITS.frameBytes) {
		context.addIssue({
			code: 'custom',
			message: 'Serialized mesh directory exceeds the protocol frame limit',
		});
	}
});

export const brokerRemoteWorkspaceSummarySchema = z.strictObject({
	workspaceId: uuidSchema,
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace name', 1),
	tags: z.array(utf8String(64, 'workspace tag', 1)).max(32),
	busy: z.boolean(),
	claimStatus: workspaceClaimStatusSchema,
});

export const brokerRemoteNodeSummarySchema = z.strictObject({
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
	label: utf8String(PROTOCOL_LIMITS.nameBytes, 'window node label', 1),
	status: nodeStatusSchema,
	capabilities: z.array(
		utf8String(PROTOCOL_LIMITS.identifierBytes, 'node capability', 1),
	).max(32),
	workspaces: z.array(brokerRemoteWorkspaceSummarySchema)
		.max(PROTOCOL_LIMITS.workspaceListCount),
});

export const brokerRemoteDeviceSummarySchema = z.strictObject({
	deviceId: uuidSchema,
	deviceName: utf8String(PROTOCOL_LIMITS.nameBytes, 'device name', 1),
	locality: z.literal('remote'),
	status: z.enum(['online', 'incompatible']),
	peerId: uuidSchema,
	nodes: z.array(brokerRemoteNodeSummarySchema).max(PROTOCOL_LIMITS.nodeListCount),
	nodesTruncated: z.boolean(),
	totalNodes: z.number().int().nonnegative().max(PROTOCOL_LIMITS.nodeListCount),
}).superRefine((device, context) => {
	validateTruncation(
		device.nodes.length,
		device.totalNodes,
		device.nodesTruncated,
		context,
		['totalNodes'],
	);
});

export const brokerRemoteListResultSchema = z.strictObject({
	devices: z.array(brokerRemoteDeviceSummarySchema).max(PROTOCOL_LIMITS.deviceListCount),
	truncated: z.boolean(),
	totalDevices: z.number().int().nonnegative(),
}).superRefine((result, context) => {
	validateTruncation(
		result.devices.length,
		result.totalDevices,
		result.truncated,
		context,
		['totalDevices'],
	);
	if (serializedLocalResultBytes(result) > PROTOCOL_LIMITS.frameBytes) {
		context.addIssue({
			code: 'custom',
			message: 'Serialized remote directory exceeds the local IPC frame limit',
		});
	}
});

export const taskTargetSchema = z.strictObject({
	deviceId: uuidSchema,
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
	workspaceId: uuidSchema,
});

export const routedTaskStartParamsSchema = z.strictObject({
	delegationRequestId: uuidSchema,
	taskId: uuidSchema,
	target: taskTargetSchema,
	sourceNodeId: uuidSchema.optional(),
	title: utf8String(PROTOCOL_LIMITS.taskTitleBytes, 'task title', 1),
	prompt: utf8String(PROTOCOL_LIMITS.taskPromptBytes, 'task prompt', 1),
	acceptanceCriteria: z.array(
		utf8String(PROTOCOL_LIMITS.acceptanceCriterionBytes, 'acceptance criterion', 1),
	).max(PROTOCOL_LIMITS.acceptanceCriteriaCount),
	workerDeadline: timestampSchema,
});

export const nodeRegisterParamsSchema = z.strictObject({
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
	label: utf8String(PROTOCOL_LIMITS.nameBytes, 'window node label', 1),
	capabilities: z.array(
		utf8String(PROTOCOL_LIMITS.identifierBytes, 'node capability', 1),
	).max(32),
	status: nodeStatusSchema.exclude(['offline']),
	startedAt: timestampSchema,
});

export const nodeHeartbeatParamsSchema = z.strictObject({
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
	status: nodeStatusSchema.exclude(['offline']),
	at: timestampSchema,
});

export const nodeIdentityParamsSchema = z.strictObject({
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
});

export const nodeWorkspaceClaimParamsSchema = nodeIdentityParamsSchema.extend({
	workspaceId: uuidSchema.optional(),
	workspaceIdentity: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/u),
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace name', 1),
	capabilityTags: z.array(utf8String(64, 'capability tag', 1)).max(32),
});

export const nodeWorkspaceReleaseParamsSchema = nodeIdentityParamsSchema.extend({
	workspaceId: uuidSchema,
});

export const nodeTaskStartParamsSchema = routedTaskStartParamsSchema.extend({
	authenticatedOwnerId: uuidSchema,
	sourceLabel: utf8String(PROTOCOL_LIMITS.nameBytes, 'task source label', 1),
});

export const nodeTaskCancelParamsSchema = nodeIdentityParamsSchema.extend({
	taskId: uuidSchema,
});

export const nodeTaskAnswerParamsSchema = nodeTaskCancelParamsSchema.extend({
	inputId: uuidSchema,
	answerId: uuidSchema,
	answer: utf8String(PROTOCOL_LIMITS.taskAnswerBytes, 'task answer', 1),
});

export const brokerRemoteTaskStartParamsSchema = routedTaskStartParamsSchema.extend({
	peerId: uuidSchema,
});

export const brokerRemoteTaskGetParamsSchema = z.strictObject({
	taskId: uuidSchema,
	afterEventSeq: z.number().int().nonnegative().optional(),
});

export const brokerRemoteTaskCancelParamsSchema = z.strictObject({
	taskId: uuidSchema,
});

export const brokerRemoteTaskAnswerParamsSchema = brokerRemoteTaskCancelParamsSchema.extend({
	inputId: uuidSchema,
	answerId: uuidSchema,
	answer: utf8String(PROTOCOL_LIMITS.taskAnswerBytes, 'task answer', 1),
});

export const brokerRemoteTaskOptionalResultSchema = z.union([
	taskSnapshotSchema,
	z.null(),
]);

export const brokerRemoteTaskGetResultSchema = z.union([
	taskSnapshotSchema,
	taskSnapshotAfterEventSeqSchema,
	z.null(),
]);

export const nodeTaskStartedResultSchema = z.strictObject({
	taskId: uuidSchema,
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
	recoveryDescriptor: recoveryDescriptorSchema.optional(),
});

const nodeTaskEventPayloadSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('progress'),
		summary: utf8String(PROTOCOL_LIMITS.outputEventBytes, 'progress summary', 1),
	}),
	z.strictObject({
		type: z.literal('output'),
		summary: utf8String(PROTOCOL_LIMITS.outputEventBytes, 'task output', 1),
	}),
	z.strictObject({
		type: z.literal('outputTruncated'),
		summary: utf8String(PROTOCOL_LIMITS.outputEventBytes, 'output truncation summary', 1),
	}),
	z.strictObject({
		type: z.literal('tool'),
		summary: utf8String(PROTOCOL_LIMITS.outputEventBytes, 'tool summary', 1),
	}),
	z.strictObject({
		type: z.literal('terminal'),
		summary: utf8String(PROTOCOL_LIMITS.outputEventBytes, 'terminal summary', 1),
	}),
	z.strictObject({
		type: z.literal('inputRequired'),
		inputId: uuidSchema,
		prompt: utf8String(PROTOCOL_LIMITS.taskAnswerBytes, 'input prompt', 1),
	}),
	z.strictObject({
		type: z.literal('completed'),
		summary: utf8String(PROTOCOL_LIMITS.terminalSummaryBytes, 'completion summary', 1),
	}),
	z.strictObject({
		type: z.literal('cancelled'),
		summary: utf8String(PROTOCOL_LIMITS.terminalSummaryBytes, 'cancellation summary', 1),
	}),
	z.strictObject({
		type: z.literal('failed'),
		failure: taskFailureSchema,
	}),
]);

export const nodeTaskEventParamsSchema = nodeIdentityParamsSchema.extend({
	taskId: uuidSchema,
	at: timestampSchema,
	event: nodeTaskEventPayloadSchema,
});

export const LOCAL_BROKER_METHODS = {
	register: 'node.register',
	heartbeat: 'node.heartbeat',
	unregister: 'node.unregister',
	list: 'node.list',
	claimWorkspace: 'node.claimWorkspace',
	releaseWorkspace: 'node.releaseWorkspace',
	taskStart: 'node.task.start',
	taskCancel: 'node.task.cancel',
	taskDispose: 'node.task.dispose',
	taskAnswer: 'node.task.answer',
	taskEvent: 'node.task.event',
	remoteList: 'broker.remote.list',
	remoteTaskStart: 'broker.remote.task.start',
	remoteTaskGet: 'broker.remote.task.get',
	remoteTaskCancel: 'broker.remote.task.cancel',
	remoteTaskAnswer: 'broker.remote.task.answer',
} as const;

/**
 * Upper bound for the Broker → Window Node `node.task.start` request.
 *
 * Starting a real Agent turn spawns and authenticates an Agent Host before the Node can
 * answer, which routinely exceeds the transport's ordinary request timeout. The bound stays
 * finite so a wedged Node still fails the request instead of pinning the session forever.
 */
export const LOCAL_BROKER_TASK_START_TIMEOUT_MS = 180_000;

export const localBrokerMethodParamsSchemas = {
	[LOCAL_BROKER_METHODS.register]: nodeRegisterParamsSchema,
	[LOCAL_BROKER_METHODS.heartbeat]: nodeHeartbeatParamsSchema,
	[LOCAL_BROKER_METHODS.unregister]: nodeIdentityParamsSchema,
	[LOCAL_BROKER_METHODS.list]: z.strictObject({}),
	[LOCAL_BROKER_METHODS.claimWorkspace]: nodeWorkspaceClaimParamsSchema,
	[LOCAL_BROKER_METHODS.releaseWorkspace]: nodeWorkspaceReleaseParamsSchema,
	[LOCAL_BROKER_METHODS.taskStart]: nodeTaskStartParamsSchema,
	[LOCAL_BROKER_METHODS.taskCancel]: nodeTaskCancelParamsSchema,
	[LOCAL_BROKER_METHODS.taskDispose]: nodeTaskCancelParamsSchema,
	[LOCAL_BROKER_METHODS.taskAnswer]: nodeTaskAnswerParamsSchema,
	[LOCAL_BROKER_METHODS.taskEvent]: nodeTaskEventParamsSchema,
	[LOCAL_BROKER_METHODS.remoteList]: z.strictObject({}),
	[LOCAL_BROKER_METHODS.remoteTaskStart]: brokerRemoteTaskStartParamsSchema,
	[LOCAL_BROKER_METHODS.remoteTaskGet]: brokerRemoteTaskGetParamsSchema,
	[LOCAL_BROKER_METHODS.remoteTaskCancel]: brokerRemoteTaskCancelParamsSchema,
	[LOCAL_BROKER_METHODS.remoteTaskAnswer]: brokerRemoteTaskAnswerParamsSchema,
} as const;

export type NodeStatus = z.infer<typeof nodeStatusSchema>;
export type WorkspaceClaimStatus = z.infer<typeof workspaceClaimStatusSchema>;
export type NodeWorkspaceSummary = z.infer<typeof nodeWorkspaceSummarySchema>;
export type WindowNodeDescriptor = z.infer<typeof windowNodeDescriptorSchema>;
export type NodeDirectoryResult = z.infer<typeof nodeDirectoryResultSchema>;
export type MeshDirectoryResult = z.infer<typeof meshDirectoryResultSchema>;
export type BrokerRemoteListResult = z.infer<typeof brokerRemoteListResultSchema>;
export type TaskTarget = z.infer<typeof taskTargetSchema>;
export type RoutedTaskStartParams = z.infer<typeof routedTaskStartParamsSchema>;
export type NodeRegisterParams = z.infer<typeof nodeRegisterParamsSchema>;
export type NodeHeartbeatParams = z.infer<typeof nodeHeartbeatParamsSchema>;
export type NodeIdentityParams = z.infer<typeof nodeIdentityParamsSchema>;
export type NodeWorkspaceClaimParams = z.infer<typeof nodeWorkspaceClaimParamsSchema>;
export type NodeWorkspaceReleaseParams = z.infer<typeof nodeWorkspaceReleaseParamsSchema>;
export type NodeTaskStartParams = z.infer<typeof nodeTaskStartParamsSchema>;
export type NodeTaskCancelParams = z.infer<typeof nodeTaskCancelParamsSchema>;
export type NodeTaskAnswerParams = z.infer<typeof nodeTaskAnswerParamsSchema>;
export type NodeTaskStartedResult = z.infer<typeof nodeTaskStartedResultSchema>;
export type NodeTaskEventParams = z.infer<typeof nodeTaskEventParamsSchema>;

export function serializedLocalResultBytes(result: unknown): number {
	return utf8ByteLength(JSON.stringify({
		kind: 'result',
		jsonrpc: '2.0',
		id: '\u0000'.repeat(PROTOCOL_LIMITS.identifierBytes),
		result,
	}));
}

function validateTruncation(
	returned: number,
	total: number,
	truncated: boolean,
	context: z.core.$RefinementCtx<unknown>,
	path: readonly PropertyKey[],
): void {
	if (
		total < returned
		|| (truncated && total === returned)
		|| (!truncated && total !== returned)
	) {
		context.addIssue({
			code: 'custom',
			path: [...path],
			message: 'Directory truncation metadata is inconsistent',
		});
	}
}
