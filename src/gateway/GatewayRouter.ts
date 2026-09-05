import { Buffer } from 'node:buffer';

import {
	nodeDirectoryResultSchema,
	routedTaskStartParamsSchema,
	taskAnswerParamsSchema,
	taskCancelParamsSchema,
	taskGetParamsSchema,
	type RoutedTaskStartParams,
} from '../../shared/protocol';

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

export interface BrokerRoutingService {
	listNodes(): unknown;
	listNodesForPeer?(authenticatedPeerId: string): Promise<unknown>;
	startRemote(authenticatedPeerId: string, params: RoutedTaskStartParams): Promise<unknown>;
	getRemote(authenticatedPeerId: string, taskId: string, afterEventSeq?: number): Promise<unknown>;
	cancelRemote(authenticatedPeerId: string, taskId: string): Promise<unknown>;
	answerRemote(
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
	private readonly brokerRouting: BrokerRoutingService | undefined;
	private readonly workspaceService: WorkspaceService | undefined;
	private readonly taskService: TaskService | undefined;

	public constructor(
		deviceService: DeviceService,
		brokerRouting: BrokerRoutingService,
	);
	public constructor(
		deviceService: DeviceService,
		workspaceService: WorkspaceService,
		taskService: TaskService,
	);
	public constructor(
		private readonly deviceService: DeviceService,
		routingOrWorkspace: BrokerRoutingService | WorkspaceService,
		taskService?: TaskService,
	) {
		if (taskService === undefined) {
			this.brokerRouting = routingOrWorkspace as BrokerRoutingService;
			this.workspaceService = undefined;
			this.taskService = undefined;
		} else {
			this.brokerRouting = undefined;
			this.workspaceService = routingOrWorkspace as WorkspaceService;
			this.taskService = taskService;
		}
	}

	public hasMethod(method: string): boolean {
		return this.brokerRouting === undefined
			? [
				'device.getInfo',
				'workspace.list',
				'task.start',
				'task.get',
				'task.cancel',
				'task.answer',
			].includes(method)
			: [
				'device.getInfo',
				'node.list',
				'task.start',
				'task.get',
				'task.cancel',
				'task.answer',
			].includes(method);
	}

	public async dispatch(peerId: string, method: string, params: unknown): Promise<unknown> {
		if (this.brokerRouting !== undefined) {
			return this.dispatchV2(peerId, method, params);
		}
		switch (method) {
			case 'device.getInfo':
				assertObject(params, []);
				return this.deviceService.getInfo(peerId);
			case 'workspace.list':
				assertObject(params, []);
				return this.workspaceService!.list(peerId);
			case 'task.start':
				return this.taskService!.start(peerId, validateTaskStart(params));
			case 'task.get': {
				const value = assertObject(params, ['taskId'], ['afterEventSeq']);
				const taskId = identifier(value.taskId);
				const after = value.afterEventSeq === undefined
					? undefined
					: nonNegativeInteger(value.afterEventSeq);
				return this.taskService!.get(peerId, taskId, after);
			}
			case 'task.cancel': {
				const value = assertObject(params, ['taskId']);
				return this.taskService!.cancel(peerId, identifier(value.taskId));
			}
			case 'task.answer': {
				const value = assertObject(params, ['taskId', 'inputId', 'answerId', 'answer']);
				return this.taskService!.answer(
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

	private dispatchV2(peerId: string, method: string, params: unknown): Promise<unknown> {
		const broker = this.brokerRouting!;
		switch (method) {
			case 'device.getInfo':
				assertObject(params, []);
				return this.deviceService.getInfo(peerId);
			case 'node.list':
				assertObject(params, []);
				return broker.listNodesForPeer === undefined
					? Promise.resolve(nodeDirectoryResultSchema.parse(broker.listNodes()))
					: broker.listNodesForPeer(peerId).then((value) => nodeDirectoryResultSchema.parse(value));
			case 'task.start': {
				const input = parseV2(routedTaskStartParamsSchema, params);
				if (input.sourceNodeId !== undefined) {
					throw new GatewayValidationError('Remote task routes cannot claim a local source node.');
				}
				return broker.startRemote(peerId, input);
			}
			case 'task.get': {
				const input = parseV2(taskGetParamsSchema, params);
				return broker.getRemote(peerId, input.taskId, input.afterEventSeq);
			}
			case 'task.cancel': {
				const input = parseV2(taskCancelParamsSchema, params);
				return broker.cancelRemote(peerId, input.taskId);
			}
			case 'task.answer': {
				const input = parseV2(taskAnswerParamsSchema, params);
				return broker.answerRemote(
					peerId,
					input.taskId,
					input.inputId,
					input.answerId,
					input.answer,
				);
			}
			default:
				throw new GatewayValidationError('Method is not allowlisted.');
		}
	}
}

function parseV2<T>(
	schema: { parse(value: unknown): T },
	value: unknown,
): T {
	try {
		return schema.parse(value);
	} catch {
		throw new GatewayValidationError();
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
