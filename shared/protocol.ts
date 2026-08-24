export const MESH_PROTOCOL_VERSION = 1 as const;

export const GATEWAY_METHODS = {
	hello: 'mesh.hello',
	ping: 'mesh.ping',
	deviceGetInfo: 'device.getInfo',
	workspaceList: 'workspace.list',
	taskStart: 'task.start',
	taskGet: 'task.get',
	taskCancel: 'task.cancel',
	taskAnswer: 'task.answer',
} as const;

export type GatewayMethod = typeof GATEWAY_METHODS[keyof typeof GATEWAY_METHODS];

export const TASK_STATUSES = [
	'created',
	'accepted',
	'startingAgent',
	'running',
	'needsInput',
	'completed',
	'failed',
	'cancelled',
	'timedOut',
] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

export interface DeviceInfo {
	readonly deviceId: string;
	readonly name: string;
	readonly platform: NodeJS.Platform;
	readonly architecture: string;
	readonly protocolVersion: typeof MESH_PROTOCOL_VERSION;
}

export interface WorkspaceSummary {
	readonly workspaceId: string;
	readonly name: string;
	readonly repository?: string;
	readonly branch?: string;
	readonly headSha?: string;
	readonly busy: boolean;
}
