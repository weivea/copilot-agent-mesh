export const MESH_PROTOCOL_VERSION = 1 as const;

export const GATEWAY_METHODS = {
	hello: 'mesh.hello',
	authenticate: 'mesh.authenticate',
	enrollmentCommit: 'mesh.enrollmentCommit',
	ping: 'mesh.ping',
	deviceGetInfo: 'device.getInfo',
	workspaceList: 'workspace.list',
	taskStart: 'task.start',
	taskGet: 'task.get',
	taskCancel: 'task.cancel',
	taskAnswer: 'task.answer',
} as const;

export type GatewayMethod = typeof GATEWAY_METHODS[keyof typeof GATEWAY_METHODS];

export const GATEWAY_NOTIFICATIONS = {
	taskStateChanged: 'task.stateChanged',
	taskProgress: 'task.progress',
	taskOutput: 'task.output',
	taskInputRequired: 'task.inputRequired',
	taskCompleted: 'task.completed',
	connectionDraining: 'connection.draining',
} as const;

export const ACTIVE_TASK_STATUSES = [
	'accepted',
	'startingAgent',
	'running',
	'needsInput',
	'recovering',
	'cancelling',
] as const;

export const TERMINAL_TASK_STATUSES = [
	'completed',
	'failed',
	'cancelled',
	'timedOut',
] as const;

export const TASK_STATUSES = [
	...ACTIVE_TASK_STATUSES,
	...TERMINAL_TASK_STATUSES,
] as const;

export type ActiveTaskStatus = typeof ACTIVE_TASK_STATUSES[number];
export type TerminalTaskStatus = typeof TERMINAL_TASK_STATUSES[number];
export type TaskStatus = typeof TASK_STATUSES[number];
