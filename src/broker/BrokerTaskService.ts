import { z } from 'zod';

import {
	ACTIVE_TASK_STATUSES,
	LOCAL_BROKER_METHODS,
	LOCAL_BROKER_TASK_START_TIMEOUT_MS,
	MESH_ERROR_CODES,
	nodeTaskAnswerParamsSchema,
	nodeTaskCancelParamsSchema,
	nodeTaskEventParamsSchema,
	nodeTaskStartedResultSchema,
	routedTaskStartParamsSchema,
	taskAnswerParamsSchema,
	taskSnapshotAfterEventSeqSchema,
	taskSnapshotSchema,
	uuidSchema,
	type MeshErrorReason,
	type NodeTaskEventParams,
	type RoutedTaskStartParams,
	type TaskSnapshot,
	type TaskSnapshotAfterEventSeq,
} from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import {
	createAcceptedRoutedTask,
	canonicalRoutedTaskRequestHash,
	matchIdempotentRoutedStart,
	type OwnedRoutedTaskStart,
	type TaskRecord,
} from '../domain/task';
import { createDelegationGrant } from '../node/DelegationGrant';
import type { Clock } from '../domain/ports';
import { taskReducer, type TaskDomainEvent } from '../domain/taskReducer';
import {
	LocalIpcRemoteError,
	type JsonValue,
	type LocalIpcSession,
} from '../ipc/LocalIpcTransport';
import type { FileTaskStore } from '../tasks/FileTaskStore';
import {
	type NodeRegistry,
	type NodeTaskBinding,
	type ResolvedTaskRoute,
} from './NodeRegistry';

const activeStates = new Set<string>(ACTIVE_TASK_STATUSES);
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'timedOut']);
const defaultCancellationDeadlineMs = 15_000;
const maximumTimerDelayMs = 2_147_483_647;
const dashboardTaskIndexLimit = 1_000;
const nodeActionResultSchema = z.null();

const ownedTaskReadSchema = z.strictObject({
	ownerId: uuidSchema,
	taskId: uuidSchema,
	afterEventSeq: z.number().int().nonnegative().optional(),
});

export interface BrokerTaskNotificationSink {
	publish(record: TaskRecord, event: TaskDomainEvent): Promise<void> | void;
}

export interface BrokerTaskServiceOptions {
	readonly notificationSink?: BrokerTaskNotificationSink;
	readonly onTaskSnapshot?: (
		snapshot: TaskSnapshot,
		sourceNodeId?: string,
	) => Promise<void> | void;
	readonly onDidChange?: () => void;
	readonly onBackgroundError?: (error: Error) => void;
	readonly cancellationDeadlineMs?: number;
}

export interface BrokerTaskStartOutcome {
	nodeRequestAttempted: boolean;
}

export type BrokerTaskStartReconciliation =
	| {
		readonly kind: 'notDispatched';
		readonly taskPersisted: false;
		readonly dispatchAttempted: false;
	}
	| {
		readonly kind: 'retained';
		readonly snapshot?: TaskSnapshot;
	};

interface PreparedStart {
	readonly route: ResolvedTaskRoute;
	readonly acknowledgement: TaskSnapshot;
}

export class BrokerTaskService {
	private readonly deviceId: string;
	private readonly options: BrokerTaskServiceOptions;
	private readonly taskQueues = new Map<string, Promise<void>>();
	private readonly operations = new Set<Promise<unknown>>();
	private readonly startDispatches = new Map<string, Promise<void>>();
	private readonly cancellationTimers = new Map<string, NodeJS.Timeout>();
	private readonly workerDeadlineTimers = new Map<string, NodeJS.Timeout>();
	private readonly backgroundFailures: Error[] = [];
	private readonly dashboardTaskIndex = new Map<string, TaskRecord>();
	private dashboardStartupScans = 0;
	private dashboardReads = 0;
	private storeListScans = 0;
	private changeImmediate: NodeJS.Immediate | undefined;
	private startQueue: Promise<void> = Promise.resolve();
	private disposed = false;
	private disposeComplete = false;
	private disposal: Promise<void> | undefined;

	public constructor(
		deviceId: string,
		private readonly registry: NodeRegistry,
		private readonly store: FileTaskStore,
		private readonly clock: Clock,
		optionsOrSink: BrokerTaskServiceOptions | BrokerTaskNotificationSink = {},
		onDidChange?: () => void,
	) {
		this.deviceId = uuidSchema.parse(deviceId);
		this.store.enableV2RoutingMigration(this.deviceId);
		this.options = 'publish' in optionsOrSink
			? { notificationSink: optionsOrSink, onDidChange }
			: optionsOrSink;
		const cancellationDeadlineMs = this.options.cancellationDeadlineMs
			?? defaultCancellationDeadlineMs;
		if (!Number.isSafeInteger(cancellationDeadlineMs) || cancellationDeadlineMs <= 0) {
			throw new TypeError('The task cancellation deadline must be a positive integer.');
		}
	}

	public initialize(): Promise<void> {
		this.assertActive();
		return this.trackOperation(this.initializeCore());
	}

	public startRemote(
		authenticatedPeerId: string,
		input: RoutedTaskStartParams,
		outcome?: BrokerTaskStartOutcome,
	): Promise<TaskSnapshot> {
		this.assertActive();
		const ownerId = uuidSchema.parse(authenticatedPeerId);
		const params = routedTaskStartParamsSchema.parse(input);
		return this.trackOperation(this.start(ownerId, params, undefined, outcome));
	}

	public startLocal(
		sourceNode: { readonly nodeId: string; readonly nodeInstanceId: string },
		input: RoutedTaskStartParams,
		outcome?: BrokerTaskStartOutcome,
	): Promise<TaskSnapshot> {
		this.assertActive();
		const { source, params } = this.localStartParams(sourceNode.nodeId, input);
		const sourceLabel = this.registry.lookupNodeLabel(source) ?? source;
		return this.trackOperation(this.start(
			this.deviceId,
			params,
			sourceLabel,
			outcome,
			sourceNode,
		));
	}

	public prevalidateRemote(
		authenticatedPeerId: string,
		input: RoutedTaskStartParams,
	): Promise<void> {
		this.assertActive();
		const ownerId = uuidSchema.parse(authenticatedPeerId);
		const params = routedTaskStartParamsSchema.parse(input);
		return this.trackOperation(this.serializeStart(() =>
			this.enqueueTask(params.taskId, () => this.prevalidateStart(ownerId, params)),
		));
	}

	public prevalidateLocal(
		sourceNode: { readonly nodeId: string; readonly nodeInstanceId: string },
		input: RoutedTaskStartParams,
	): Promise<void> {
		this.assertActive();
		const { params } = this.localStartParams(sourceNode.nodeId, input);
		return this.trackOperation(this.serializeStart(() =>
			this.enqueueTask(
				params.taskId,
				() => this.prevalidateStart(this.deviceId, params, sourceNode),
			),
		));
	}

	public async reconcileStartFailure(
		ownerId: string,
		taskId: string,
		outcome: BrokerTaskStartOutcome,
	): Promise<BrokerTaskStartReconciliation> {
		const owner = uuidSchema.parse(ownerId);
		const task = uuidSchema.parse(taskId);
		const record = await this.store.getOwned(owner, task);
		if (record === undefined && !outcome.nodeRequestAttempted) {
			return {
				kind: 'notDispatched',
				taskPersisted: false,
				dispatchAttempted: false,
			};
		}
		return {
			kind: 'retained',
			...(record === undefined ? {} : { snapshot: this.snapshot(record) }),
		};
	}

	public get(
		ownerId: string,
		taskId: string,
		afterEventSeq?: number,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq> {
		this.assertActive();
		const input = ownedTaskReadSchema.parse({
			ownerId,
			taskId,
			...(afterEventSeq === undefined ? {} : { afterEventSeq }),
		});
		return this.trackOperation(this.enqueueTask(input.taskId, async () => {
			let record = await this.requireOwned(input.ownerId, input.taskId);
			record = await this.failUnavailableActiveRoute(record);
			return this.snapshot(record, input.afterEventSeq);
		}));
	}

	public getLocal(
		taskId: string,
		afterEventSeq?: number,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq> {
		return this.get(this.deviceId, taskId, afterEventSeq);
	}

	public async listDashboardRecords(): Promise<readonly TaskRecord[]> {
		this.assertActive();
		this.dashboardReads += 1;
		return [...this.dashboardTaskIndex.values()].map((record) => structuredClone(record));
	}

	public dashboardMetrics(): {
		readonly startupScans: number;
		readonly storeListScans: number;
		readonly reads: number;
		readonly indexSize: number;
	} {
		return {
			startupScans: this.dashboardStartupScans,
			storeListScans: this.storeListScans,
			reads: this.dashboardReads,
			indexSize: this.dashboardTaskIndex.size,
		};
	}

	public cancel(ownerId: string, taskId: string): Promise<TaskSnapshot> {
		this.assertActive();
		const input = ownedTaskReadSchema.parse({ ownerId, taskId });
		return this.trackOperation(this.cancelCore(input.ownerId, input.taskId));
	}

	public async cancelLocal(sourceNodeId: string, taskId: string): Promise<TaskSnapshot> {
		this.assertActive();
		await this.assertLocalTaskSource(sourceNodeId, taskId);
		return this.cancel(this.deviceId, taskId);
	}

	public async cancelForTarget(
		nodeId: string,
		nodeInstanceId: string,
		ownerId: string,
		taskId: string,
	): Promise<TaskSnapshot> {
		this.assertActive();
		const owner = uuidSchema.parse(ownerId);
		const task = uuidSchema.parse(taskId);
		const record = this.dashboardTaskIndex.get(taskKey(owner, task));
		if (
			record === undefined
			|| record.schemaVersion !== 2
			|| record.target.nodeId !== uuidSchema.parse(nodeId)
			|| record.target.nodeInstanceId !== uuidSchema.parse(nodeInstanceId)
		) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'The task is not owned by this target Window Node.');
		}
		return this.cancel(record.peerId, record.taskId);
	}

	public assertDashboardTaskCancellable(
		nodeId: string,
		nodeInstanceId: string,
		ownerId: string,
		taskId: string,
		direction: 'outgoing' | 'incoming',
	): void {
		const node = uuidSchema.parse(nodeId);
		const instance = uuidSchema.parse(nodeInstanceId);
		const owner = uuidSchema.parse(ownerId);
		const task = uuidSchema.parse(taskId);
		const record = this.dashboardTaskIndex.get(taskKey(owner, task));
		if (record === undefined || record.schemaVersion !== 2 || !activeStates.has(record.state)) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'The dashboard task action is stale.');
		}
		const valid = direction === 'outgoing'
			? record.peerId === this.deviceId && record.sourceNodeId === node
			: record.target.nodeId === node && record.target.nodeInstanceId === instance;
		if (!valid) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'The dashboard task ownership changed.');
		}
	}

	public answer(
		ownerId: string,
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
	): Promise<TaskSnapshot> {
		this.assertActive();
		const owner = uuidSchema.parse(ownerId);
		const input = taskAnswerParamsSchema.parse({
			taskId,
			inputId,
			answerId,
			answer,
		});
		return this.trackOperation(this.answerCore(owner, input));
	}

	public answerLocal(
		sourceNodeId: string,
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
	): Promise<TaskSnapshot> {
		this.assertActive();
		return this.assertLocalTaskSource(sourceNodeId, taskId).then(() =>
			this.answer(this.deviceId, taskId, inputId, answerId, answer),
		);
	}

	public acceptNodeEvent(
		session: LocalIpcSession,
		input: NodeTaskEventParams,
	): Promise<TaskSnapshot> {
		this.assertActive();
		const event = nodeTaskEventParamsSchema.parse(input);
		const binding = this.registry.authenticateTaskEvent(session, {
			nodeId: event.nodeId,
			nodeInstanceId: event.nodeInstanceId,
			taskId: event.taskId,
		});
		return this.trackOperation(this.enqueueTask(event.taskId, () =>
			this.applyNodeEvent(binding, event),
		));
	}

	public handleNodeTasksLost(
		bindings: readonly NodeTaskBinding[],
	): Promise<void> {
		const operation = Promise.all(bindings.map((binding) =>
			this.enqueueTask(binding.taskId, () => this.failLostBinding(binding)),
		)).then(() => undefined);
		return this.trackOperation(operation);
	}

	public handleNodeTaskLost(binding: NodeTaskBinding): Promise<void> {
		return this.handleNodeTasksLost([binding]);
	}

	public dispose(): Promise<void> {
		if (this.disposal !== undefined) {
			return this.disposal;
		}
		if (this.disposeComplete) {
			return Promise.resolve();
		}
		this.disposed = true;
		if (this.changeImmediate !== undefined) {
			clearImmediate(this.changeImmediate);
			this.changeImmediate = undefined;
		}
		for (const timer of this.cancellationTimers.values()) {
			clearTimeout(timer);
		}
		this.cancellationTimers.clear();
		for (const timer of this.workerDeadlineTimers.values()) {
			clearTimeout(timer);
		}
		this.workerDeadlineTimers.clear();
		let disposal!: Promise<void>;
		disposal = this.disposeCore().then(() => {
			this.disposeComplete = true;
		}).finally(() => {
			if (!this.disposeComplete && this.disposal === disposal) {
				this.disposal = undefined;
			}
		});
		this.disposal = disposal;
		return disposal;
	}

	private async initializeCore(): Promise<void> {
		const records = await this.scanTaskStore();
		this.dashboardStartupScans += 1;
		for (const record of [...records].sort((left, right) =>
			left.updatedAt.localeCompare(right.updatedAt)
		)) {
			this.rememberDashboardRecord(record);
		}
		const active = records.filter((record) => activeStates.has(record.state));
		for (const record of active) {
			await this.enqueueTask(record.taskId, async () => {
				let migrated = await this.requireOwned(record.peerId, record.taskId);
				migrated = await this.enforceWorkerDeadline(migrated);
				if (!activeStates.has(migrated.state)) {
					return;
				}
				if (
					this.registry.lookupTaskRoute(migrated.peerId, migrated.taskId) === undefined
				) {
					await this.persistEvent(migrated.peerId, migrated.taskId, {
						type: 'failed',
						at: this.now(),
						code: 'TASK_RECOVERY_UNAVAILABLE',
						message: 'The Window Node AgentRuntime session cannot be recovered.',
						retryable: true,
					});
					return;
				}
				this.scheduleWorkerDeadline(
					migrated.peerId,
					migrated.taskId,
					migrated.workerDeadline,
				);
				if (migrated.state === 'cancelling') {
					this.scheduleCancellationDeadline(
						migrated.peerId,
						migrated.taskId,
						migrated.cancellationDeadline ?? this.now(),
					);
				}
			});
		}
	}

	private async start(
		ownerId: string,
		params: RoutedTaskStartParams,
		sourceLabel?: string,
		outcome?: BrokerTaskStartOutcome,
		sourceNode?: { readonly nodeId: string; readonly nodeInstanceId: string },
	): Promise<TaskSnapshot> {
		this.assertTargetDevice(params);
		const prepared = await this.serializeStart(() =>
			this.enqueueTask(params.taskId, () => this.prepareStart(ownerId, params, sourceNode)),
		);
		if (!('route' in prepared)) {
			return prepared;
		}
		this.launchStartDispatch(
			ownerId,
			params,
			sourceLabel,
			prepared.route,
			outcome,
		);
		return prepared.acknowledgement;
	}

	private async prepareStart(
		ownerId: string,
		params: RoutedTaskStartParams,
		sourceNode?: { readonly nodeId: string; readonly nodeInstanceId: string },
	): Promise<PreparedStart | TaskSnapshot> {
		this.assertActive();
		const records = await this.scanTaskStore();
		const existing = this.findExistingStart(records, ownerId, params);
		if (existing !== undefined) {
			let migrated = await this.requireOwned(ownerId, existing.taskId);
			migrated = await this.failUnavailableActiveRoute(migrated);
			return this.snapshot(migrated);
		}
		this.assertWorkerDeadline(params.workerDeadline);

		const route = await this.registry.acquireTaskRoute({
			ownerId,
			taskId: params.taskId,
			nodeId: params.target.nodeId,
			nodeInstanceId: params.target.nodeInstanceId,
			workspaceId: params.target.workspaceId,
			...(sourceNode === undefined ? {} : {
				sourceNodeId: sourceNode.nodeId,
				sourceNodeInstanceId: sourceNode.nodeInstanceId,
			}),
		});
		const resolved: ResolvedTaskRoute = {
			...params.target,
			ownerId,
			taskId: params.taskId,
			workspaceLeaseKey: route.workspaceLeaseKey,
			delegatedExecutionContext: route.delegatedExecutionContext,
			session: route.session,
		};
		const request: OwnedRoutedTaskStart = {
			...params,
			peerId: ownerId,
			workspaceLeaseKey: route.workspaceLeaseKey,
		};
		let persisted = false;
		try {
			const at = this.now();
			const startRequested: TaskDomainEvent = {
				type: 'agentStartRequested',
				at,
			};
			const record = taskReducer(
				createAcceptedRoutedTask(request, at),
				startRequested,
			);
			const result = await this.store.createRoutedIdempotent(request, record);
			this.rememberDashboardRecord(result.record);
			if (!result.created) {
				return this.snapshot(result.record);
			}
			persisted = true;
			this.scheduleWorkerDeadline(ownerId, params.taskId, params.workerDeadline);
			await this.publishAcceptedStart(record, startRequested);
			return {
				route: resolved,
				acknowledgement: this.snapshot(record),
			};
		} catch (error: unknown) {
			if (!persisted) {
				this.registry.releaseTaskRoute(ownerId, params.taskId);
				throw error;
			}
			try {
				await this.failActive(
					ownerId,
					params.taskId,
					'TASK_EXECUTION_FAILED',
					'The broker could not finish task acceptance.',
					true,
				);
			} catch (failureError: unknown) {
				throw new AggregateError(
					[error, failureError],
					'Task acceptance and failure persistence both failed.',
				);
			}
			throw error;
		}
	}

	private launchStartDispatch(
		ownerId: string,
		params: RoutedTaskStartParams,
		sourceLabel: string | undefined,
		route: ResolvedTaskRoute,
		outcome: BrokerTaskStartOutcome | undefined,
	): void {
		const key = taskKey(ownerId, params.taskId);
		if (this.startDispatches.has(key)) {
			return;
		}
		if (outcome !== undefined) {
			outcome.nodeRequestAttempted = true;
		}
		const operation = this.dispatchStart(ownerId, params, sourceLabel, route);
		let tracked!: Promise<void>;
		tracked = operation.catch(() => {
			this.recordBackgroundFailure(
				'The Window Node task start result could not be persisted safely.',
			);
		}).finally(() => {
			if (this.startDispatches.get(key) === tracked) {
				this.startDispatches.delete(key);
			}
		});
		this.startDispatches.set(key, tracked);
		void this.trackOperation(tracked);
	}

	/**
	 * Bounds the Node start request by the Agent start allowance, never waiting past the
	 * task's own worker deadline.
	 */
	private taskStartTimeoutMs(workerDeadline: string): number {
		const remainingMs = Date.parse(workerDeadline) - this.clock.now().valueOf();
		return Math.max(1, Math.min(LOCAL_BROKER_TASK_START_TIMEOUT_MS, remainingMs));
	}

	private async dispatchStart(
		ownerId: string,
		params: RoutedTaskStartParams,
		sourceLabel: string | undefined,
		route: ResolvedTaskRoute,
	): Promise<void> {
		let result: z.infer<typeof nodeTaskStartedResultSchema>;
		try {
			const rawResult = await route.session.request(
				LOCAL_BROKER_METHODS.taskStart,
				toJsonValue({
					...params,
					authenticatedOwnerId: ownerId,
					sourceLabel: sourceLabel ?? params.sourceNodeId ?? ownerId,
					delegationGrant: createDelegationGrant({
						taskId: params.taskId,
						targetNodeId: route.nodeId,
						targetNodeInstanceId: route.nodeInstanceId,
						workspaceIdentity: route.workspaceLeaseKey,
						requestHash: canonicalRoutedTaskRequestHash({
							...params,
							peerId: ownerId,
							workspaceLeaseKey: route.workspaceLeaseKey,
						}),
					}),
					delegatedExecutionContext: route.delegatedExecutionContext,
				}),
				this.taskStartTimeoutMs(params.workerDeadline),
			);
			result = nodeTaskStartedResultSchema.parse(rawResult);
			if (
				result.taskId !== params.taskId
				|| result.nodeId !== params.target.nodeId
				|| result.nodeInstanceId !== params.target.nodeInstanceId
			) {
				throw new Error('The Window Node returned a mismatched task start result.');
			}
		} catch (error: unknown) {
			const failure = nodeStartFailure(error);
			try {
				await this.enqueueTask(params.taskId, () =>
					this.failActive(
						ownerId,
						params.taskId,
						failure.code,
						failure.message,
						failure.retryable,
					),
				);
			} catch (failureError: unknown) {
				throw new AggregateError(
					[error, failureError],
					'Window Node task startup and failure persistence both failed.',
				);
			}
			return;
		}
		await this.enqueueTask(params.taskId, async () => {
			const current = await this.requireOwned(ownerId, params.taskId);
			if (current.state === 'startingAgent') {
				await this.persistEvent(ownerId, params.taskId, {
					type: 'agentStarted',
					at: this.now(),
					...(result.recoveryDescriptor === undefined
						? {}
						: { recoveryDescriptor: result.recoveryDescriptor }),
				});
			}
		});
	}

	private async publishAcceptedStart(
		record: TaskRecord,
		event: Extract<TaskDomainEvent, { readonly type: 'agentStartRequested' }>,
	): Promise<void> {
		try {
			await this.options.onTaskSnapshot?.(
				this.snapshot(record),
				record.schemaVersion === 2 ? record.sourceNodeId : undefined,
			);
		} catch {
			this.recordBackgroundFailure(
				'The accepted task snapshot could not be published safely.',
			);
		}
		try {
			await this.options.notificationSink?.publish(record, event);
		} catch {
			this.recordBackgroundFailure(
				'The accepted task notification could not be published safely.',
			);
		}
		try {
			this.changed();
		} catch {
			this.recordBackgroundFailure(
				'The accepted task change could not be reported safely.',
			);
		}
	}

	private async prevalidateStart(
		ownerId: string,
		params: RoutedTaskStartParams,
		sourceNode?: { readonly nodeId: string; readonly nodeInstanceId: string },
	): Promise<void> {
		this.assertTargetDevice(params);
		const records = await this.scanTaskStore();
		if (this.findExistingStart(records, ownerId, params) !== undefined) {
			return;
		}
		this.assertWorkerDeadline(params.workerDeadline);
		await this.registry.validateTaskRoute({
			ownerId,
			taskId: params.taskId,
			nodeId: params.target.nodeId,
			nodeInstanceId: params.target.nodeInstanceId,
			workspaceId: params.target.workspaceId,
			...(sourceNode === undefined ? {} : {
				sourceNodeId: sourceNode.nodeId,
				sourceNodeInstanceId: sourceNode.nodeInstanceId,
			}),
		});
	}

	private findExistingStart(
		records: readonly TaskRecord[],
		ownerId: string,
		params: RoutedTaskStartParams,
	): TaskRecord | undefined {
		const otherOwner = records.find((record) =>
			record.taskId === params.taskId && record.peerId !== ownerId,
		);
		if (otherOwner !== undefined) {
			throw new MeshDomainError(
				'TASK_ID_CONFLICT',
				'Task ID is already owned by another authenticated source.',
			);
		}
		const identifierMatch = records.find((record) =>
			record.peerId === ownerId
			&& (
				record.taskId === params.taskId
				|| (
					record.delegationRequestId === params.delegationRequestId
					&& record.schemaVersion === 2
					&& record.sourceWorkspaceIdentity === params.sourceWorkspaceIdentity
				)
			),
		);
		if (identifierMatch === undefined) {
			return undefined;
		}
		const request: OwnedRoutedTaskStart = {
			...params,
			peerId: ownerId,
			workspaceLeaseKey: identifierMatch.workspaceLeaseKey,
		};
		const existing = matchIdempotentRoutedStart(records, request);
		if (existing === undefined) {
			throw new MeshDomainError('IDEMPOTENCY_CONFLICT', 'Delegation idempotency semantics conflict.');
		}
		return existing;
	}

	private localStartParams(
		sourceNodeId: string,
		input: RoutedTaskStartParams,
	): { readonly source: string; readonly params: RoutedTaskStartParams } {
		const source = uuidSchema.parse(sourceNodeId);
		const parsed = routedTaskStartParamsSchema.parse(input);
		if (parsed.sourceNodeId !== undefined && parsed.sourceNodeId !== source) {
			throw new MeshDomainError(
				'TASK_ID_CONFLICT',
				'The local task source does not match sourceNodeId.',
			);
		}
		return {
			source,
			params: routedTaskStartParamsSchema.parse({
				...parsed,
				sourceNodeId: source,
			}),
		};
	}

	private async cancelCore(ownerId: string, taskId: string): Promise<TaskSnapshot> {
		const phase = await this.enqueueTask(taskId, async () => {
			const record = await this.enforceWorkerDeadline(
				await this.requireOwned(ownerId, taskId),
			);
			if (!activeStates.has(record.state)) {
				return { record, route: undefined };
			}
			if (record.state === 'cancelling') {
				this.scheduleCancellationDeadline(
					ownerId,
					taskId,
					record.cancellationDeadline ?? this.now(),
				);
				return { record, route: undefined };
			}
			const route = await this.requireLiveRoute(record);
			const cancellationDeadline = new Date(
				this.clock.now().valueOf() + this.cancellationDeadlineMs,
			).toISOString();
			const updated = await this.persistEvent(ownerId, taskId, {
				type: 'cancelRequested',
				at: this.now(),
				cancellationDeadline,
			});
			this.scheduleCancellationDeadline(ownerId, taskId, cancellationDeadline);
			return { record: updated, route };
		});
		if (phase.route === undefined) {
			return this.snapshot(phase.record);
		}

		try {
			const result = await phase.route.session.request(
				LOCAL_BROKER_METHODS.taskCancel,
				toJsonValue(nodeTaskCancelParamsSchema.parse({
					nodeId: phase.route.nodeId,
					nodeInstanceId: phase.route.nodeInstanceId,
					taskId,
				})),
			);
			nodeActionResultSchema.parse(result);
			const current = await this.enqueueTask(taskId, () =>
				this.requireOwned(ownerId, taskId),
			);
			return this.snapshot(current);
		} catch (error: unknown) {
			await this.enqueueTask(taskId, () =>
				this.failActive(
					ownerId,
					taskId,
					'TASK_CANCELLATION_UNCONFIRMED',
					'The Window Node did not accept the cancellation request.',
					true,
				),
			);
			throw error;
		}
	}

	private async answerCore(
		ownerId: string,
		input: z.infer<typeof taskAnswerParamsSchema>,
	): Promise<TaskSnapshot> {
		const phase = await this.enqueueTask(input.taskId, async () => {
			const record = await this.enforceWorkerDeadline(
				await this.requireOwned(ownerId, input.taskId),
			);
			if (record.answeredInputs[input.inputId] === input.answerId) {
				return { record, route: undefined };
			}
			if (
				record.state !== 'needsInput'
				|| record.pendingInput?.inputId !== input.inputId
			) {
				throw new MeshDomainError(
					'INPUT_NOT_PENDING',
					'The requested input is not pending.',
				);
			}
			return { record, route: await this.requireLiveRoute(record) };
		});
		if (phase.route === undefined) {
			return this.snapshot(phase.record);
		}
		const result = await phase.route.session.request(
			LOCAL_BROKER_METHODS.taskAnswer,
			toJsonValue(nodeTaskAnswerParamsSchema.parse({
				nodeId: phase.route.nodeId,
				nodeInstanceId: phase.route.nodeInstanceId,
				...input,
			})),
		);
		nodeActionResultSchema.parse(result);
		return this.enqueueTask(input.taskId, async () => {
			const current = await this.requireOwned(ownerId, input.taskId);
			if (current.answeredInputs[input.inputId] === input.answerId) {
				return this.snapshot(current);
			}
			if (
				current.state !== 'needsInput'
			) {
				throw new MeshDomainError(
					'INPUT_NOT_PENDING',
					'The requested input is no longer pending.',
				);
			}
			return this.snapshot(await this.persistEvent(ownerId, input.taskId, {
				type: 'inputAnswered',
				at: this.now(),
				inputId: input.inputId,
				answerId: input.answerId,
			}));
		});
	}

	private async applyNodeEvent(
		binding: NodeTaskBinding,
		params: NodeTaskEventParams,
	): Promise<TaskSnapshot> {
		let current = await this.requireOwned(binding.ownerId, params.taskId);
		this.assertEventMatchesRecord(current, binding, params);
		current = await this.enforceWorkerDeadline(current);
		if (current.state === 'timedOut') {
			return this.snapshot(current);
		}
		if (!activeStates.has(current.state)) {
			throw new MeshDomainError('AGENT_UNAVAILABLE', 'The task event route is no longer active.');
		}
		if (current.state === 'startingAgent') {
			current = await this.persistEvent(binding.ownerId, params.taskId, {
				type: 'agentStarted',
				at: params.at,
			});
		}

		const event = params.event;
		let domainEvent: TaskDomainEvent;
		switch (event.type) {
			case 'progress':
			case 'output':
			case 'outputTruncated':
			case 'tool':
			case 'terminal':
				domainEvent = { type: event.type, at: params.at, summary: event.summary };
				break;
			case 'inputRequired':
				domainEvent = {
					type: 'inputRequired',
					at: params.at,
					inputId: event.inputId,
					prompt: event.prompt,
				};
				break;
			case 'completed':
				domainEvent = { type: 'completed', at: params.at, summary: event.summary };
				break;
			case 'failed':
				domainEvent = {
					type: 'failed',
					at: params.at,
					code: event.failure.code,
					message: event.failure.message,
					retryable: event.failure.retryable,
				};
				break;
			case 'cancelled':
				if (current.state !== 'cancelling') {
					current = await this.persistEvent(binding.ownerId, params.taskId, {
						type: 'cancelRequested',
						at: params.at,
						cancellationDeadline: params.at,
					});
				}
				domainEvent = {
					type: 'cancelConfirmed',
					at: params.at,
					summary: event.summary,
				};
				break;
		}
		return this.snapshot(await this.persistEvent(
			binding.ownerId,
			params.taskId,
			domainEvent,
		));
	}

	private async failLostBinding(binding: NodeTaskBinding): Promise<void> {
		let record = await this.store.getOwned(binding.ownerId, binding.taskId);
		if (record === undefined || !activeStates.has(record.state)) {
			this.registry.releaseTaskRoute(binding.ownerId, binding.taskId);
			return;
		}
		record = await this.enforceWorkerDeadline(record);
		if (!activeStates.has(record.state)) {
			return;
		}
		await this.persistEvent(binding.ownerId, binding.taskId, {
			type: 'failed',
			at: this.now(),
			code: 'TASK_RECOVERY_UNAVAILABLE',
			message: 'The Window Node was lost and AgentRuntime has no recovery API.',
			retryable: true,
		});
	}

	private async failUnavailableActiveRoute(record: TaskRecord): Promise<TaskRecord> {
		record = await this.enforceWorkerDeadline(record);
		if (
			activeStates.has(record.state)
			&& this.registry.lookupTaskRoute(record.peerId, record.taskId) === undefined
		) {
			return this.persistEvent(record.peerId, record.taskId, {
				type: 'failed',
				at: this.now(),
				code: 'TASK_RECOVERY_UNAVAILABLE',
				message: 'The persisted Window Node task has no recoverable live route.',
				retryable: true,
			});
		}
		return record;
	}

	private async failActive(
		ownerId: string,
		taskId: string,
		code: string,
		message: string,
		retryable: boolean,
	): Promise<TaskRecord> {
		const current = await this.requireOwned(ownerId, taskId);
		if (!activeStates.has(current.state)) {
			return current;
		}
		return this.persistEvent(ownerId, taskId, {
			type: 'failed',
			at: this.now(),
			code,
			message,
			retryable,
		});
	}

	private async persistEvent(
		ownerId: string,
		taskId: string,
		event: TaskDomainEvent,
	): Promise<TaskRecord> {
		const before = await this.store.getOwned(ownerId, taskId);
		const record = await this.store.transitionOwned(ownerId, taskId, event);
		this.rememberDashboardRecord(record);
		if (before?.eventSeq === record.eventSeq) {
			if (terminalStates.has(record.state)) {
				this.clearCancellationDeadline(ownerId, taskId);
				this.clearWorkerDeadline(ownerId, taskId);
			}
			await this.options.onTaskSnapshot?.(
				this.snapshot(record),
				record.schemaVersion === 2 ? record.sourceNodeId : undefined,
			);
			return record;
		}
		if (terminalStates.has(record.state)) {
			this.clearCancellationDeadline(ownerId, taskId);
			this.clearWorkerDeadline(ownerId, taskId);
			this.registry.releaseTaskRoute(ownerId, taskId);
		}
		await this.options.onTaskSnapshot?.(
			this.snapshot(record),
			record.schemaVersion === 2 ? record.sourceNodeId : undefined,
		);
		await this.options.notificationSink?.publish(record, event);
		if (before?.state !== record.state) {
			this.changed();
		}
		return record;
	}

	private async requireOwned(ownerId: string, taskId: string): Promise<TaskRecord> {
		const record = await this.store.getOwned(ownerId, taskId);
		if (record === undefined || record.peerId !== ownerId) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'Task not found.');
		}
		if (record.schemaVersion === 1) {
			const migrated = await this.store.migrateOwnedV1(ownerId, taskId, this.deviceId);
			this.rememberDashboardRecord(migrated);
			return migrated;
		}
		this.rememberDashboardRecord(record);
		return record;
	}

	private async assertLocalTaskSource(sourceNodeId: string, taskId: string): Promise<void> {
		const source = uuidSchema.parse(sourceNodeId);
		const record = await this.requireOwned(this.deviceId, uuidSchema.parse(taskId));
		if (record.schemaVersion !== 2 || record.sourceNodeId !== source) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'Task not found.');
		}
	}

	private async requireLiveRoute(record: TaskRecord): Promise<ResolvedTaskRoute> {
		if (
			record.schemaVersion !== 2
			|| record.target.deviceId !== this.deviceId
			|| record.target.nodeId === undefined
			|| record.target.nodeInstanceId === undefined
		) {
			await this.failActive(
				record.peerId,
				record.taskId,
				'TASK_RECOVERY_UNAVAILABLE',
				'The task has no exact recoverable Window Node route.',
				true,
			);
			throw new MeshDomainError(
				'TASK_RECOVERY_UNAVAILABLE',
				'The task has no exact recoverable Window Node route.',
				true,
			);
		}
		const route = this.registry.lookupTaskRoute(record.peerId, record.taskId);
		if (
			route === undefined
			|| route.nodeId !== record.target.nodeId
			|| route.nodeInstanceId !== record.target.nodeInstanceId
			|| route.workspaceId !== record.target.workspaceId
		) {
			await this.failActive(
				record.peerId,
				record.taskId,
				'TASK_RECOVERY_UNAVAILABLE',
				'The exact Window Node task route is unavailable.',
				true,
			);
			throw new MeshDomainError(
				'TASK_RECOVERY_UNAVAILABLE',
				'The exact Window Node task route is unavailable.',
				true,
			);
		}
		return route;
	}

	private assertEventMatchesRecord(
		record: TaskRecord,
		binding: NodeTaskBinding,
		params: NodeTaskEventParams,
	): void {
		if (
			record.schemaVersion !== 2
			|| record.target.deviceId !== this.deviceId
			|| record.target.nodeId !== params.nodeId
			|| record.target.nodeInstanceId !== params.nodeInstanceId
			|| record.target.workspaceId !== binding.workspaceId
		) {
			throw new MeshDomainError(
				'AGENT_UNAVAILABLE',
				'The node event does not match the persisted exact task route.',
			);
		}
	}

	private assertTargetDevice(params: RoutedTaskStartParams): void {
		if (params.target.deviceId !== this.deviceId) {
			throw new MeshDomainError(
				'AGENT_UNAVAILABLE',
				'The routed task target device does not match this broker.',
			);
		}
	}

	private snapshot(record: TaskRecord): TaskSnapshot;
	private snapshot(
		record: TaskRecord,
		afterEventSeq: number,
	): TaskSnapshotAfterEventSeq;
	private snapshot(
		record: TaskRecord,
		afterEventSeq?: number,
	): TaskSnapshot | TaskSnapshotAfterEventSeq;
	private snapshot(
		record: TaskRecord,
		afterEventSeq?: number,
	): TaskSnapshot | TaskSnapshotAfterEventSeq {
		const wire = { ...record } as Record<string, unknown>;
		delete wire.recoveryDescriptor;
		delete wire.answeredInputs;
		delete wire.workspaceLeaseKey;
		delete wire.target;
		delete wire.sourceNodeId;
		delete wire.sourceWorkspaceIdentity;
		delete wire.timeoutMinutes;
		if (afterEventSeq === undefined) {
			return taskSnapshotSchema.parse({
				...wire,
				deviceId: this.deviceId,
			});
		}
		if (afterEventSeq > record.eventSeq) {
			throw new TypeError('afterEventSeq cannot exceed the current task event sequence.');
		}
		const earliest = record.earliestAvailableEventSeq ?? 1;
		return taskSnapshotAfterEventSeqSchema.parse({
			...wire,
			deviceId: this.deviceId,
			afterEventSeq,
			events: record.events.filter((event) => event.eventSeq > afterEventSeq),
			eventsTruncated: afterEventSeq + 1 < earliest,
			...(record.eventsTruncated ? { earliestAvailableEventSeq: earliest } : {}),
		});
	}

	private assertWorkerDeadline(workerDeadline: string): void {
		if (Date.parse(workerDeadline) <= this.clock.now().valueOf()) {
			throw new MeshDomainError(
				'TASK_EXECUTION_FAILED',
				'The task worker deadline has already expired.',
			);
		}
	}

	private async enforceWorkerDeadline(
		record: TaskRecord,
		force = false,
	): Promise<TaskRecord> {
		if (
			!activeStates.has(record.state)
			|| (!force && Date.parse(record.workerDeadline) > this.clock.now().valueOf())
		) {
			return record;
		}
		const route = this.registry.lookupTaskRoute(record.peerId, record.taskId);
		return this.persistTerminalAndStop(
			record.peerId,
			record.taskId,
			{
				type: 'timedOut',
				at: this.now(),
				message: 'The task exceeded its worker deadline.',
			},
			route,
			(candidate) => candidate.state === 'timedOut',
			'The timed-out Window Node task could not be stopped safely.',
		);
	}

	private async persistTerminalAndStop(
		ownerId: string,
		taskId: string,
		event: TaskDomainEvent,
		route: ResolvedTaskRoute | undefined,
		wasPersisted: (record: TaskRecord) => boolean,
		cleanupFailureMessage: string,
	): Promise<TaskRecord> {
		try {
			const record = await this.persistEvent(ownerId, taskId, event);
			if (wasPersisted(record)) {
				this.stopExactNodeTask(route, taskId, cleanupFailureMessage);
			}
			return record;
		} catch (error: unknown) {
			let persisted: TaskRecord | undefined;
			try {
				persisted = await this.store.getOwned(ownerId, taskId);
			} catch (verificationError: unknown) {
				throw new AggregateError(
					[error, verificationError],
					'Task terminal persistence could not be verified safely.',
				);
			}
			if (persisted !== undefined && wasPersisted(persisted)) {
				this.stopExactNodeTask(route, taskId, cleanupFailureMessage);
			}
			throw error;
		}
	}

	private stopExactNodeTask(
		route: ResolvedTaskRoute | undefined,
		taskId: string,
		failureMessage: string,
	): void {
		if (route === undefined) {
			return;
		}
		const operation = route.session.request(
			LOCAL_BROKER_METHODS.taskDispose,
			toJsonValue(nodeTaskCancelParamsSchema.parse({
				nodeId: route.nodeId,
				nodeInstanceId: route.nodeInstanceId,
				taskId,
			})),
		).then((result) => {
			nodeActionResultSchema.parse(result);
		});
		this.trackBackground(
			operation,
			failureMessage,
		);
	}

	private scheduleWorkerDeadline(
		ownerId: string,
		taskId: string,
		workerDeadline: string,
	): void {
		const key = taskKey(ownerId, taskId);
		this.clearWorkerDeadline(ownerId, taskId);
		if (this.disposed) {
			return;
		}
		const remaining = Math.max(
			0,
			Date.parse(workerDeadline) - this.clock.now().valueOf(),
		);
		const timer = setTimeout(() => {
			if (this.workerDeadlineTimers.get(key) !== timer) {
				return;
			}
			this.workerDeadlineTimers.delete(key);
			if (this.disposed) {
				return;
			}
			if (remaining > maximumTimerDelayMs) {
				this.scheduleWorkerDeadline(ownerId, taskId, workerDeadline);
				return;
			}
			this.trackBackground(
				this.enqueueTask(taskId, async () => {
					const current = await this.store.getOwned(ownerId, taskId);
					if (current !== undefined) {
						await this.enforceWorkerDeadline(current, true);
					}
				}),
				'The task worker deadline could not be finalized safely.',
			);
		}, Math.min(remaining, maximumTimerDelayMs));
		timer.unref();
		this.workerDeadlineTimers.set(key, timer);
	}

	private clearWorkerDeadline(ownerId: string, taskId: string): void {
		const key = taskKey(ownerId, taskId);
		const timer = this.workerDeadlineTimers.get(key);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.workerDeadlineTimers.delete(key);
		}
	}

	private scheduleCancellationDeadline(
		ownerId: string,
		taskId: string,
		cancellationDeadline: string,
	): void {
		const key = taskKey(ownerId, taskId);
		this.clearCancellationDeadline(ownerId, taskId);
		if (this.disposed) {
			return;
		}
		const remaining = Math.max(
			0,
			Date.parse(cancellationDeadline) - this.clock.now().valueOf(),
		);
		const timer = setTimeout(() => {
			if (this.cancellationTimers.get(key) !== timer) {
				return;
			}
			this.cancellationTimers.delete(key);
			if (this.disposed) {
				return;
			}
			if (remaining > maximumTimerDelayMs) {
				this.scheduleCancellationDeadline(ownerId, taskId, cancellationDeadline);
				return;
			}
			this.trackBackground(
				this.enqueueTask(taskId, async () => {
					const current = await this.store.getOwned(ownerId, taskId);
					if (current?.state === 'cancelling') {
						const route = this.registry.lookupTaskRoute(ownerId, taskId);
						await this.persistTerminalAndStop(
							ownerId,
							taskId,
							{
								type: 'failed',
								at: this.now(),
								code: 'TASK_CANCELLATION_UNCONFIRMED',
								message: 'Task cancellation was not confirmed before the deadline.',
								retryable: true,
							},
							route,
							(candidate) =>
								candidate.state === 'failed'
								&& candidate.failure?.code === 'TASK_CANCELLATION_UNCONFIRMED',
							'The unconfirmed Window Node task cancellation could not be disposed safely.',
						);
					}
				}),
				'The task cancellation deadline could not be finalized safely.',
			);
		}, Math.min(remaining, maximumTimerDelayMs));
		timer.unref();
		this.cancellationTimers.set(key, timer);
	}

	private clearCancellationDeadline(ownerId: string, taskId: string): void {
		const key = taskKey(ownerId, taskId);
		const timer = this.cancellationTimers.get(key);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.cancellationTimers.delete(key);
		}
	}

	private get cancellationDeadlineMs(): number {
		return this.options.cancellationDeadlineMs ?? defaultCancellationDeadlineMs;
	}

	private serializeStart<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.startQueue.then(operation, operation);
		this.startQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private enqueueTask<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.taskQueues.get(taskId) ?? Promise.resolve();
		const result = previous.then(operation, operation);
		const tail = result.then(() => undefined, () => undefined);
		this.taskQueues.set(taskId, tail);
		void tail.then(() => {
			if (this.taskQueues.get(taskId) === tail) {
				this.taskQueues.delete(taskId);
			}
		});
		return result;
	}

	private trackOperation<T>(operation: Promise<T>): Promise<T> {
		let tracked!: Promise<T>;
		tracked = operation.finally(() => this.operations.delete(tracked));
		this.operations.add(tracked);
		return tracked;
	}

	private trackBackground(operation: Promise<unknown>, safeMessage: string): void {
		const handled = operation.catch(() => {
			this.recordBackgroundFailure(safeMessage);
		});
		void this.trackOperation(handled);
	}

	private recordBackgroundFailure(message: string): void {
		const error = new Error(message);
		this.backgroundFailures.push(error);
		try {
			this.options.onBackgroundError?.(error);
		} catch {
			process.emitWarning('A Broker task background error listener failed.', {
				code: 'BROKER_TASK_ERROR_LISTENER_FAILED',
			});
		}
	}

	private async disposeCore(): Promise<void> {
		while (this.operations.size > 0) {
			await Promise.allSettled([...this.operations]);
		}
		await Promise.allSettled([...this.startDispatches.values()]);
		await Promise.allSettled([...this.taskQueues.values(), this.startQueue]);
		if (this.backgroundFailures.length > 0) {
			const failures = this.backgroundFailures.splice(0);
			throw new AggregateError(
				failures,
				'Broker task lifecycle background operations failed.',
			);
		}
	}

	private now(): string {
		return this.clock.now().toISOString();
	}

	private changed(): void {
		if (this.changeImmediate !== undefined || this.disposed) {
			return;
		}
		this.changeImmediate = setImmediate(() => {
			this.changeImmediate = undefined;
			if (!this.disposed) {
				this.options.onDidChange?.();
			}
		});
	}

	private rememberDashboardRecord(record: TaskRecord): void {
		const key = taskKey(record.peerId, record.taskId);
		this.dashboardTaskIndex.delete(key);
		this.dashboardTaskIndex.set(key, structuredClone(record));
		while (this.dashboardTaskIndex.size > dashboardTaskIndexLimit) {
			const terminal = [...this.dashboardTaskIndex].find(([, candidate]) =>
				terminalStates.has(candidate.state)
			);
			const oldest = terminal?.[0] ?? this.dashboardTaskIndex.keys().next().value;
			if (oldest === undefined) {
				return;
			}
			this.dashboardTaskIndex.delete(oldest);
		}
	}

	private scanTaskStore(): Promise<readonly TaskRecord[]> {
		this.storeListScans += 1;
		return this.store.list();
	}

	private assertActive(): void {
		if (this.disposed) {
			throw new MeshDomainError('WORKER_DRAINING', 'The broker is shutting down.');
		}
	}
}

function taskKey(ownerId: string, taskId: string): string {
	return `${ownerId}:${taskId}`;
}

function nodeStartFailure(error: unknown): {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
} {
	const reason = remoteMeshReason(error);
	if (reason !== undefined) {
		return {
			code: reason,
			message: safeNodeStartFailureMessage(reason),
			retryable: error instanceof LocalIpcRemoteError
				&& isRecord(error.data)
				&& error.data.retryable === true,
		};
	}
	if (error instanceof LocalIpcRemoteError) {
		return {
			code: 'TASK_EXECUTION_FAILED',
			message: 'The Window Node rejected the task start request.',
			retryable: false,
		};
	}
	return {
		code: 'TASK_RECOVERY_UNAVAILABLE',
		message: 'The Window Node task start outcome could not be confirmed.',
		retryable: true,
	};
}

function remoteMeshReason(error: unknown): MeshErrorReason | undefined {
	if (
		!(error instanceof LocalIpcRemoteError)
		|| !isRecord(error.data)
		|| typeof error.data.reason !== 'string'
	) {
		return undefined;
	}
	const reason = error.data.reason;
	return reason in MESH_ERROR_CODES
		&& MESH_ERROR_CODES[reason as MeshErrorReason] === error.code
		? reason as MeshErrorReason
		: undefined;
}

function safeNodeStartFailureMessage(reason: MeshErrorReason): string {
	switch (reason) {
		case 'AGENT_AUTH_REQUIRED':
			return 'The Window Node Agent runtime requires authentication.';
		case 'AGENT_UNAVAILABLE':
			return 'The Window Node Agent runtime is unavailable.';
		case 'TASK_EXECUTION_FAILED':
			return 'The Window Node could not start the task.';
		default:
			return 'The Window Node rejected the task start request.';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
	return value as JsonValue;
}
