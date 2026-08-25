import { Buffer } from 'node:buffer';

export interface DeviceService {
	getInfo(authenticatedPeerId: string): Promise<unknown>;
}

export interface WorkspaceService {
	list(authenticatedPeerId: string): Promise<unknown>;
}

export interface TaskStartParams {
	readonly delegationRequestId: string;
	readonly taskId: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly prompt: string;
	readonly acceptanceCriteria: readonly string[];
	readonly workerDeadline: string;
}

export interface TaskService {
	start(authenticatedPeerId: string, params: TaskStartParams): Promise<unknown>;
	get(authenticatedPeerId: string, taskId: string, afterEventSeq?: number): Promise<unknown>;
	cancel(authenticatedPeerId: string, taskId: string): Promise<unknown>;
	answer(
		authenticatedPeerId: string,
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
	): Promise<unknown>;
}

export class GatewayValidationError extends Error {
	public constructor(message = 'Invalid method parameters.') {
		super(message);
		this.name = 'GatewayValidationError';
	}
}

export class GatewayRouter {
	public constructor(
		private readonly deviceService: DeviceService,
		private readonly workspaceService: WorkspaceService,
		private readonly taskService: TaskService,
	) {}

	public hasMethod(method: string): boolean {
		return [
			'device.getInfo',
			'workspace.list',
			'task.start',
			'task.get',
			'task.cancel',
			'task.answer',
		].includes(method);
	}

	public async dispatch(peerId: string, method: string, params: unknown): Promise<unknown> {
		switch (method) {
			case 'device.getInfo':
				assertObject(params, []);
				return this.deviceService.getInfo(peerId);
			case 'workspace.list':
				assertObject(params, []);
				return this.workspaceService.list(peerId);
			case 'task.start':
				return this.taskService.start(peerId, validateTaskStart(params));
			case 'task.get': {
				const value = assertObject(params, ['taskId'], ['afterEventSeq']);
				const taskId = identifier(value.taskId);
				const after = value.afterEventSeq === undefined
					? undefined
					: nonNegativeInteger(value.afterEventSeq);
				return this.taskService.get(peerId, taskId, after);
			}
			case 'task.cancel': {
				const value = assertObject(params, ['taskId']);
				return this.taskService.cancel(peerId, identifier(value.taskId));
			}
			case 'task.answer': {
				const value = assertObject(params, ['taskId', 'inputId', 'answerId', 'answer']);
				return this.taskService.answer(
					peerId,
					identifier(value.taskId),
					identifier(value.inputId),
					identifier(value.answerId),
					boundedString(value.answer, 32 * 1024, false),
				);
			}
			default:
				throw new GatewayValidationError('Method is not allowlisted.');
		}
	}
}

function validateTaskStart(params: unknown): TaskStartParams {
	const value = assertObject(
		params,
		[
			'delegationRequestId',
			'taskId',
			'workspaceId',
			'title',
			'prompt',
			'acceptanceCriteria',
			'workerDeadline',
		],
		[],
	);
	const criteria = value.acceptanceCriteria;
	if (
		!Array.isArray(criteria)
		|| criteria.length > 32
		|| criteria.some((item) => typeof item !== 'string' || Buffer.byteLength(item) > 4 * 1024)
	) {
		throw new GatewayValidationError();
	}
	if (
		typeof value.workerDeadline !== 'string'
		|| !Number.isFinite(Date.parse(value.workerDeadline))
	) {
		throw new GatewayValidationError();
	}
	return {
		delegationRequestId: identifier(value.delegationRequestId),
		taskId: identifier(value.taskId),
		workspaceId: identifier(value.workspaceId),
		title: boundedString(value.title, 256, false),
		prompt: boundedString(value.prompt, 128 * 1024, false),
		acceptanceCriteria: criteria as readonly string[],
		workerDeadline: value.workerDeadline,
	};
}

function assertObject(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new GatewayValidationError();
	}
	const record = value as Record<string, unknown>;
	const allowed = new Set([...required, ...optional]);
	if (Object.keys(record).some((key) => !allowed.has(key))
		|| required.some((key) => !Object.hasOwn(record, key))) {
		throw new GatewayValidationError();
	}
	return record;
}

function identifier(value: unknown): string {
	if (typeof value !== 'string'
		|| value.length < 1
		|| value.length > 128
		|| !/^[A-Za-z0-9._~-]+$/u.test(value)) {
		throw new GatewayValidationError();
	}
	return value;
}

function boundedString(value: unknown, maxBytes: number, allowEmpty: boolean): string {
	if (typeof value !== 'string'
		|| (!allowEmpty && value.length === 0)
		|| Buffer.byteLength(value) > maxBytes) {
		throw new GatewayValidationError();
	}
	return value;
}

function nonNegativeInteger(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new GatewayValidationError();
	}
	return value as number;
}
