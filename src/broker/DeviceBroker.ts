import { z } from 'zod';

import {
	COLLABORATION_LOCAL_METHODS,
	MESH_ERROR_CODES,
	brokerRemoteListResultSchema,
	brokerRemoteTaskAnswerParamsSchema,
	brokerRemoteTaskCancelParamsSchema,
	brokerRemoteTaskGetParamsSchema,
	brokerRemoteTaskStartParamsSchema,
	JSON_RPC_ERROR_CODES,
	LOCAL_BROKER_METHODS,
	collaborationListResultSchema,
	collaborationRunParamsSchema,
	collaborationRunSnapshotSchema,
	collaborationStartParamsSchema,
	nodeHeartbeatParamsSchema,
	nodeIdentityParamsSchema,
	nodeRegisterParamsSchema,
	nodeTaskAnswerParamsSchema,
	nodeTaskCancelParamsSchema,
	nodeTaskEventParamsSchema,
	nodeWorkspaceClaimParamsSchema,
	nodeWorkspaceReleaseParamsSchema,
	routedTaskStartParamsSchema,
	taskSnapshotAfterEventSeqSchema,
	taskSnapshotSchema,
	uuidSchema,
	type NodeDirectoryResult,
	type RoutedTaskStartParams,
	type TaskSnapshot,
	type TaskSnapshotAfterEventSeq,
	type MeshErrorReason,
} from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import {
	LocalIpcHandlerError,
	LocalIpcRemoteError,
	LocalIpcServer,
	type JsonValue,
	type LocalIpcIdentity,
	type LocalIpcSession,
	type LocalIpcSessionOptions,
} from '../ipc';
import type { BrokerOwnership } from '../storage/BrokerOwnerLock';
import type {
	RemoteTaskRouteAdapter,
	RemoteTaskStartOutcome,
} from '../tools/LocalBrokerTaskFacade';
import type {
	BrokerTaskService,
	BrokerTaskStartOutcome,
} from './BrokerTaskService';
import type { CollaborationService } from './CollaborationService';
import type { NodeRegistry } from './NodeRegistry';
import {
	TaskRouteCatalog,
	type TaskRouteRecord,
	type TaskRouteReservation,
} from './TaskRouteCatalog';

const emptyParamsSchema = z.strictObject({});
const localTaskGetParamsSchema = nodeIdentityParamsSchema.extend({
	taskId: uuidSchema,
	afterEventSeq: z.number().int().nonnegative().optional(),
});

interface RegisteredSession {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
}

export interface DeviceBrokerOptions extends LocalIpcSessionOptions {
	readonly identity: LocalIpcIdentity;
	readonly brokerKey: Buffer | string;
	readonly ownership: BrokerOwnership;
	readonly registry: NodeRegistry;
	readonly taskService: BrokerTaskService;
	readonly collaborationService?: CollaborationService;
	readonly remoteTaskService?: RemoteTaskRouteAdapter;
	readonly taskRoutes?: TaskRouteCatalog;
	readonly handshakeTimeoutMs?: number;
	readonly onError?: (error: Error) => void;
}

/**
 * Owns the authenticated local RPC boundary for the current device broker.
 */
export class DeviceBroker {
	private readonly server: LocalIpcServer;
	public readonly taskRoutes: TaskRouteCatalog;
	private readonly registrations = new WeakMap<LocalIpcSession, RegisteredSession>();
	private readonly activeHandlers = new Set<Promise<JsonValue>>();
	private started = false;
	private disposed = false;
	private disposeRequested = false;
	private disposal: Promise<void> | undefined;
	private serverDisposed = false;
	private taskServiceDisposed = false;
	private collaborationServiceDisposed = false;
	private registryDisposed = false;

	public constructor(private readonly options: DeviceBrokerOptions) {
		if (!options.ownership.isOwner()) {
			throw new Error('Only the current Broker owner can construct a Device Broker.');
		}
		this.taskRoutes = options.taskRoutes ?? new TaskRouteCatalog();
		this.server = new LocalIpcServer({
			identity: options.identity,
			brokerKey: options.brokerKey,
			...(options.requestTimeoutMs === undefined ? {} : {
				requestTimeoutMs: options.requestTimeoutMs,
			}),
			...(options.maxPendingRequests === undefined ? {} : {
				maxPendingRequests: options.maxPendingRequests,
			}),
			...(options.maxOutboundBytes === undefined ? {} : {
				maxOutboundBytes: options.maxOutboundBytes,
			}),
			...(options.backpressureTimeoutMs === undefined ? {} : {
				backpressureTimeoutMs: options.backpressureTimeoutMs,
			}),
			...(options.handshakeTimeoutMs === undefined ? {} : {
				handshakeTimeoutMs: options.handshakeTimeoutMs,
			}),
			handler: (method, params, session) => this.handleSafely(method, params, session),
			onSession: (session) => {
				session.onClose(() => this.registrations.delete(session));
			},
			onError: options.onError,
		});
	}

	public get endpoint() {
		return this.server.endpoint;
	}

	public async start(): Promise<void> {
		if (this.disposeRequested || this.disposed) {
			throw new Error('Device Broker is disposed.');
		}
		if (this.started) {
			return;
		}
		await this.options.ownership.assertOwner();
		await this.server.listen();
		this.started = true;
	}

	public listNodes(): NodeDirectoryResult {
		this.assertActive();
		return this.options.registry.list();
	}

	public async startRemote(
		authenticatedPeerId: string,
		input: RoutedTaskStartParams,
	): Promise<TaskSnapshot> {
		this.assertActive();
		const params = routedTaskStartParamsSchema.parse(input);
		return this.startLocalRoute(
			params,
			{ peerId: authenticatedPeerId },
			authenticatedPeerId,
			() => this.options.taskService.prevalidateRemote(authenticatedPeerId, params),
			(outcome) =>
				this.options.taskService.startRemote(authenticatedPeerId, params, outcome),
		);
	}

	public async getRemote(
		authenticatedPeerId: string,
		taskId: string,
		afterEventSeq?: number,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq> {
		this.assertActive();
		this.taskRoutes.requireInbound(taskId, authenticatedPeerId);
		const snapshot = await this.options.taskService.get(
			authenticatedPeerId,
			taskId,
			afterEventSeq,
		);
		await this.taskRoutes.markSnapshot(snapshot);
		return snapshot;
	}

	public async cancelRemote(authenticatedPeerId: string, taskId: string): Promise<TaskSnapshot> {
		this.assertActive();
		this.taskRoutes.requireInbound(taskId, authenticatedPeerId);
		const snapshot = await this.options.taskService.cancel(authenticatedPeerId, taskId);
		await this.taskRoutes.markSnapshot(snapshot);
		return snapshot;
	}

	public async answerRemote(
		authenticatedPeerId: string,
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
	): Promise<TaskSnapshot> {
		this.assertActive();
		this.taskRoutes.requireInbound(taskId, authenticatedPeerId);
		const snapshot = await this.options.taskService.answer(
			authenticatedPeerId,
			taskId,
			inputId,
			answerId,
			answer,
		);
		await this.taskRoutes.markSnapshot(snapshot);
		return snapshot;
	}

	public dispose(): Promise<void> {
		if (this.disposal !== undefined) {
			return this.disposal;
		}
		this.disposeRequested = true;
		let disposal!: Promise<void>;
		disposal = this.disposeOnce().finally(() => {
			if (!this.disposed && this.disposal === disposal) {
				this.disposal = undefined;
			}
		});
		this.disposal = disposal;
		return disposal;
	}

	private handleSafely(
		method: string,
		params: JsonValue,
		session: LocalIpcSession,
	): Promise<JsonValue> {
		const operation = this.handle(method, params, session).catch((error: unknown) => {
			throw toDeviceBrokerHandlerError(error);
		});
		this.activeHandlers.add(operation);
		void operation.then(
			() => this.activeHandlers.delete(operation),
			() => this.activeHandlers.delete(operation),
		);
		return operation;
	}

	private async handle(
		method: string,
		params: JsonValue,
		session: LocalIpcSession,
	): Promise<JsonValue> {
		this.assertActive();
		if (method === LOCAL_BROKER_METHODS.register) {
			const input = nodeRegisterParamsSchema.parse(params);
			if (session.clientId !== input.nodeInstanceId) {
				throw new MeshDomainError(
					'AUTH_FAILED',
					'The authenticated client does not match the Window Node instance.',
				);
			}
			const current = this.registrations.get(session);
			if (
				current !== undefined
				&& (
					current.nodeId !== input.nodeId
					|| current.nodeInstanceId !== input.nodeInstanceId
				)
			) {
				throw new MeshDomainError(
					'AUTH_FAILED',
					'The authenticated session is already bound to another Window Node.',
				);
			}
			const descriptor = this.options.registry.register(input, session);
			this.registrations.set(session, {
				nodeId: input.nodeId,
				nodeInstanceId: input.nodeInstanceId,
			});
			this.options.collaborationService?.topologyChanged();
			return toJsonValue(descriptor);
		}

		const binding = this.requireRegistration(session);
		switch (method) {
			case LOCAL_BROKER_METHODS.heartbeat: {
				const input = nodeHeartbeatParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				const descriptor = this.options.registry.heartbeat(input);
				this.options.collaborationService?.topologyChanged();
				return toJsonValue(descriptor);
			}
			case LOCAL_BROKER_METHODS.unregister: {
				const input = nodeIdentityParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				this.options.registry.unregister(input, false);
				this.registrations.delete(session);
				this.options.collaborationService?.topologyChanged();
				return null;
			}
			case LOCAL_BROKER_METHODS.list:
				emptyParamsSchema.parse(params);
				return toJsonValue(this.options.registry.list());
			case LOCAL_BROKER_METHODS.claimWorkspace: {
				const input = nodeWorkspaceClaimParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				const result = await this.options.registry.claimWorkspace(input);
				this.options.collaborationService?.topologyChanged();
				return toJsonValue(result);
			}
			case LOCAL_BROKER_METHODS.releaseWorkspace: {
				const input = nodeWorkspaceReleaseParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				this.options.registry.releaseWorkspace(input);
				this.options.collaborationService?.topologyChanged();
				return null;
			}
			case LOCAL_BROKER_METHODS.taskStart: {
				const input = routedTaskStartParamsSchema.parse(params);
				if (input.sourceNodeId !== binding.nodeId) {
					throw new MeshDomainError(
						'AUTH_FAILED',
						'The task source does not match the authenticated Window Node.',
					);
				}
				const snapshot = await this.startLocalRoute(
					input,
					{ nodeId: binding.nodeId },
					this.options.identity.deviceId,
					() => this.options.taskService.prevalidateLocal(binding.nodeId, input),
					(outcome) =>
						this.options.taskService.startLocal(binding.nodeId, input, outcome),
				);
				return toJsonValue(snapshot);
			}
			case LOCAL_BROKER_METHODS.taskCancel: {
				const input = nodeTaskCancelParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				return toJsonValue(await this.cancelRoutedTask(binding, input.taskId));
			}
			case LOCAL_BROKER_METHODS.taskAnswer: {
				const input = nodeTaskAnswerParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				return toJsonValue(await this.answerRoutedTask(
					binding,
					input.taskId,
					input.inputId,
					input.answerId,
					input.answer,
				));
			}
			case LOCAL_BROKER_METHODS.taskEvent: {
				const input = nodeTaskEventParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				await this.options.taskService.acceptNodeEvent(session, input);
				return null;
			}
			case 'node.task.get': {
				const input = localTaskGetParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				const snapshot = await this.getRoutedTask(
					binding,
					input.taskId,
					input.afterEventSeq,
				);
				return toJsonValue(input.afterEventSeq === undefined
					? taskSnapshotSchema.parse(snapshot)
					: taskSnapshotAfterEventSeqSchema.parse(snapshot));
			}
			case LOCAL_BROKER_METHODS.remoteList: {
				emptyParamsSchema.parse(params);
				const directory = await this.requireRemoteTaskService().listDevices(
					new AbortController().signal,
				);
				return toJsonValue(brokerRemoteListResultSchema.parse(directory));
			}
			case LOCAL_BROKER_METHODS.remoteTaskStart: {
				const input = brokerRemoteTaskStartParamsSchema.parse(params);
				if (
					input.sourceNodeId !== undefined
					&& input.sourceNodeId !== binding.nodeId
				) {
					throw new MeshDomainError(
						'AUTH_FAILED',
						'The remote task source does not match the authenticated Window Node.',
					);
				}
				const routeInput: RoutedTaskStartParams = {
					delegationRequestId: input.delegationRequestId,
					taskId: input.taskId,
					target: input.target,
					sourceNodeId: input.sourceNodeId,
					title: input.title,
					prompt: input.prompt,
					acceptanceCriteria: input.acceptanceCriteria,
					workerDeadline: input.workerDeadline,
				};
				const { sourceNodeId: _sourceNodeId, ...remoteInput } = routeInput;
				const remoteTasks = this.requireRemoteTaskService();
				this.taskRoutes.assertRemoteCompatible(routeInput, input.peerId, binding.nodeId);
				await remoteTasks.prevalidateStartTask?.(
					remoteInput,
					{ peerId: input.peerId },
				);
				const reservation = await this.taskRoutes.reserveRemoteAttempt(
					routeInput,
					input.peerId,
					binding.nodeId,
				);
				const outcome: RemoteTaskStartOutcome = {
					taskStartRequestAttempted: false,
				};
				let snapshot: TaskSnapshot;
				try {
					snapshot = await remoteTasks.startTask(
						remoteInput,
						{ peerId: input.peerId },
						outcome,
					);
					await this.taskRoutes.markSnapshot(snapshot);
					await this.taskRoutes.retainAmbiguous(reservation);
				} catch (error: unknown) {
					await this.settleRemoteStartFailure(reservation, outcome, error);
					throw error;
				}
				return toJsonValue(taskSnapshotSchema.parse(snapshot));
			}
			case LOCAL_BROKER_METHODS.remoteTaskGet: {
				const input = brokerRemoteTaskGetParamsSchema.parse(params);
				const route = this.taskRoutes.get(input.taskId);
				if (!isOutboundRouteForNode(route, binding.nodeId)) {
					return null;
				}
				const snapshot = await this.requireRemoteTaskService().getTask(
					input.taskId,
					input.afterEventSeq,
					new AbortController().signal,
				);
				const found = requireRoutedSnapshot(snapshot, route);
				await this.taskRoutes.markSnapshot(found);
				return toJsonValue(input.afterEventSeq === undefined
					? taskSnapshotSchema.parse(found)
					: taskSnapshotAfterEventSeqSchema.parse(found));
			}
			case LOCAL_BROKER_METHODS.remoteTaskCancel: {
				const input = brokerRemoteTaskCancelParamsSchema.parse(params);
				const route = this.taskRoutes.get(input.taskId);
				if (!isOutboundRouteForNode(route, binding.nodeId)) {
					return null;
				}
				const snapshot = requireRoutedSnapshot(
					await this.requireRemoteTaskService().cancelTask(
						input.taskId,
						new AbortController().signal,
					),
					route,
				);
				await this.taskRoutes.markSnapshot(snapshot);
				return toJsonValue(taskSnapshotSchema.parse(snapshot));
			}
			case LOCAL_BROKER_METHODS.remoteTaskAnswer: {
				const input = brokerRemoteTaskAnswerParamsSchema.parse(params);
				const route = this.taskRoutes.get(input.taskId);
				if (!isOutboundRouteForNode(route, binding.nodeId)) {
					return null;
				}
				const snapshot = requireRoutedSnapshot(
					await this.requireRemoteTaskService().answerTask(
						input.taskId,
						input.inputId,
						input.answerId,
						input.answer,
						new AbortController().signal,
					),
					route,
				);
				await this.taskRoutes.markSnapshot(snapshot);
				return toJsonValue(taskSnapshotSchema.parse(snapshot));
			}
			case COLLABORATION_LOCAL_METHODS.start: {
				const input = collaborationStartParamsSchema.parse(params);
				return toJsonValue(collaborationRunSnapshotSchema.parse(
					await this.requireCollaborationService().start(binding, input),
				));
			}
			case COLLABORATION_LOCAL_METHODS.get: {
				const input = collaborationRunParamsSchema.parse(params);
				return toJsonValue(collaborationRunSnapshotSchema.parse(
					await this.requireCollaborationService().get(binding, input.runId),
				));
			}
			case COLLABORATION_LOCAL_METHODS.list:
				emptyParamsSchema.parse(params);
				return toJsonValue(collaborationListResultSchema.parse(
					await this.requireCollaborationService().list(binding),
				));
			case COLLABORATION_LOCAL_METHODS.cancel: {
				const input = collaborationRunParamsSchema.parse(params);
				return toJsonValue(collaborationRunSnapshotSchema.parse(
					await this.requireCollaborationService().cancel(binding, input.runId),
				));
			}
			default:
				throw new LocalIpcHandlerError(
					JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
					'Local RPC method not found.',
				);
		}
	}

	private async startLocalRoute(
		input: RoutedTaskStartParams,
		source: { readonly nodeId?: string; readonly peerId?: string },
		ownerId: string,
		prevalidate: () => Promise<void>,
		start: (outcome: BrokerTaskStartOutcome) => Promise<TaskSnapshot>,
	): Promise<TaskSnapshot> {
		this.taskRoutes.assertLocalCompatible(input, source);
		await prevalidate();
		const reservation = await this.taskRoutes.reserveLocalAttempt(input, source);
		const outcome: BrokerTaskStartOutcome = { nodeRequestAttempted: false };
		try {
			const snapshot = await start(outcome);
			await this.taskRoutes.markSnapshot(snapshot);
			await this.taskRoutes.retainAmbiguous(reservation);
			return snapshot;
		} catch (error: unknown) {
			try {
				const reconciliation = await this.options.taskService.reconcileStartFailure(
					ownerId,
					input.taskId,
					outcome,
				);
				if (reconciliation.kind === 'notDispatched') {
					await this.taskRoutes.releaseAmbiguous(reservation, reconciliation);
				} else {
					await this.taskRoutes.retainAmbiguous(reservation);
					if (reconciliation.snapshot !== undefined) {
						await this.taskRoutes.markSnapshot(reconciliation.snapshot);
					}
				}
			} catch (reconciliationError: unknown) {
				await this.taskRoutes.retainAmbiguous(reservation).catch(() => undefined);
				throw new AggregateError(
					[error, reconciliationError],
					'Task startup failed and its authoritative route could not be reconciled.',
				);
			}
			throw error;
		}
	}

	private async settleRemoteStartFailure(
		reservation: TaskRouteReservation,
		outcome: RemoteTaskStartOutcome,
		startError: unknown,
	): Promise<void> {
		try {
			if (outcome.taskStartRequestAttempted) {
				await this.taskRoutes.retainAmbiguous(reservation);
			} else {
				await this.taskRoutes.releaseAmbiguous(reservation, {
					taskPersisted: false,
					dispatchAttempted: false,
				});
			}
		} catch (reconciliationError: unknown) {
			await this.taskRoutes.retainAmbiguous(reservation).catch(() => undefined);
			throw new AggregateError(
				[startError, reconciliationError],
				'Remote task startup failed and its authoritative route could not be reconciled.',
			);
		}
	}

	private requireRegistration(session: LocalIpcSession): RegisteredSession {
		const binding = this.registrations.get(session);
		if (binding === undefined || session.closed) {
			throw new MeshDomainError(
				'AUTH_REQUIRED',
				'Window Node registration is required.',
			);
		}
		return binding;
	}

	private assertIdentity(
		binding: RegisteredSession,
		identity: { readonly nodeId: string; readonly nodeInstanceId: string },
	): void {
		if (
			identity.nodeId !== binding.nodeId
			|| identity.nodeInstanceId !== binding.nodeInstanceId
		) {
			throw new MeshDomainError(
				'AUTH_FAILED',
				'The request does not match the authenticated Window Node.',
			);
		}
	}

	private requireRemoteTaskService(): RemoteTaskRouteAdapter {
		if (this.options.remoteTaskService === undefined) {
			throw new MeshDomainError(
				'TUNNEL_UNAVAILABLE',
				'Remote task routing is unavailable.',
				true,
			);
		}

		return this.options.remoteTaskService;
	}

	private requireCollaborationService(): CollaborationService {
		const service = this.options.collaborationService;
		if (service === undefined) {
			throw new MeshDomainError(
				'FEATURE_DISABLED',
				'Same-device collaboration is unavailable.',
			);
		}
		return service;
	}

	private async getRoutedTask(
		binding: RegisteredSession,
		taskId: string,
		afterEventSeq?: number,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq> {
		const route = this.taskRoutes.requireForNode(taskId, binding.nodeId);
		const snapshot = route.routeKind === 'local'
			? await this.options.taskService.getLocal(taskId, afterEventSeq)
			: await this.requireRemoteTaskService().getTask(
				taskId,
				afterEventSeq,
				new AbortController().signal,
			);
		const found = requireRoutedSnapshot(snapshot, route);
		await this.taskRoutes.markSnapshot(found);
		return found;
	}

	private async cancelRoutedTask(
		binding: RegisteredSession,
		taskId: string,
	): Promise<TaskSnapshot> {
		const route = this.taskRoutes.requireForNode(taskId, binding.nodeId);
		const snapshot = route.routeKind === 'local'
			? await this.options.taskService.cancelLocal(binding.nodeId, taskId)
			: await this.requireRemoteTaskService().cancelTask(
				taskId,
				new AbortController().signal,
			);
		const found = requireRoutedSnapshot(snapshot, route);
		await this.taskRoutes.markSnapshot(found);
		return taskSnapshotSchema.parse(found);
	}

	private async answerRoutedTask(
		binding: RegisteredSession,
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
	): Promise<TaskSnapshot> {
		const route = this.taskRoutes.requireForNode(taskId, binding.nodeId);
		const snapshot = route.routeKind === 'local'
			? await this.options.taskService.answerLocal(
				binding.nodeId,
				taskId,
				inputId,
				answerId,
				answer,
			)
			: await this.requireRemoteTaskService().answerTask(
				taskId,
				inputId,
				answerId,
				answer,
				new AbortController().signal,
			);
		const found = requireRoutedSnapshot(snapshot, route);
		await this.taskRoutes.markSnapshot(found);
		return taskSnapshotSchema.parse(found);
	}

	private assertActive(): void {
		if (this.disposeRequested || this.disposed || !this.options.ownership.isOwner()) {
			throw new MeshDomainError('WORKER_DRAINING', 'The Device Broker is shutting down.');
		}
	}

	private async disposeOnce(): Promise<void> {
		const failures: unknown[] = [];
		if (!this.serverDisposed) {
			try {
				await this.server.dispose();
				this.serverDisposed = true;
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		await this.drainActiveHandlers();
		for (const resource of [
			{
				pending: () => !this.collaborationServiceDisposed,
				dispose: () => this.options.collaborationService?.dispose() ?? Promise.resolve(),
				complete: () => {
					this.collaborationServiceDisposed = true;
				},
			},
			{
				pending: () => !this.taskServiceDisposed,
				dispose: () => this.options.taskService.dispose(),
				complete: () => {
					this.taskServiceDisposed = true;
				},
			},
			{
				pending: () => !this.registryDisposed,
				dispose: () => this.options.registry.dispose(),
				complete: () => {
					this.registryDisposed = true;
				},
			},
		]) {
			if (!resource.pending()) {
				continue;
			}
			try {
				await resource.dispose();
				resource.complete();
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, 'Device Broker cleanup failed.');
		}
		this.started = false;
		this.disposed = true;
	}

	private async drainActiveHandlers(): Promise<void> {
		while (this.activeHandlers.size > 0) {
			await Promise.allSettled([...this.activeHandlers]);
		}
	}
}

export function toDeviceBrokerHandlerError(error: unknown): LocalIpcHandlerError {
	if (error instanceof LocalIpcHandlerError) {
		return error;
	}
	if (error instanceof MeshDomainError) {
		return new LocalIpcHandlerError(
			error.code,
			'The local mesh request could not be completed.',
			{ reason: error.reason, retryable: error.retryable },
		);
	}
	if (error instanceof LocalIpcRemoteError) {
		const reason = remoteMeshReason(error);
		if (reason !== undefined) {
			return new LocalIpcHandlerError(
				error.code,
				'The routed Window Node request could not be completed.',
				{
					reason,
					...(isRecord(error.data) && error.data.retryable === true
						? { retryable: true }
						: {}),
				},
			);
		}
		return new LocalIpcHandlerError(
			error.code,
			'The routed Window Node request failed safely.',
			error.data,
		);
	}
	if (error instanceof z.ZodError || error instanceof TypeError) {
		return new LocalIpcHandlerError(
			JSON_RPC_ERROR_CODES.INVALID_PARAMS,
			'Invalid local RPC parameters.',
		);
	}

	function remoteMeshReason(error: LocalIpcRemoteError): MeshErrorReason | undefined {
		if (!isRecord(error.data) || typeof error.data.reason !== 'string') {
			return undefined;
		}
		const reason = error.data.reason;
		return reason in MESH_ERROR_CODES
			&& MESH_ERROR_CODES[reason as MeshErrorReason] === error.code
			? reason as MeshErrorReason
			: undefined;
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}
	return new LocalIpcHandlerError(
		JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
		'The local mesh request failed safely.',
		process.env.MESH_MULTI_WINDOW_E2E === '1'
			? { diagnostic: safeErrorKind(error) }
			: undefined,
	);
}

function safeErrorKind(error: unknown): string {
	if (error instanceof AggregateError) {
		return `AggregateError(${error.errors.map(safeErrorKind).join(',')})`.slice(0, 256);
	}
	if (error instanceof Error) {
		const code = 'code' in error && typeof error.code === 'string'
			? `:${error.code}`
			: '';
		return `${error.name}${code}`.slice(0, 256);
	}
	return typeof error;
}

function toJsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function requireRoutedSnapshot<T extends TaskSnapshot | TaskSnapshotAfterEventSeq>(
	snapshot: T | undefined,
	route: TaskRouteRecord,
): T {
	if (snapshot === undefined) {
		throw new MeshDomainError('TASK_NOT_FOUND', 'Task not found.');
	}
	if (
		snapshot.taskId !== route.taskId
		|| snapshot.delegationRequestId !== route.delegationRequestId
		|| snapshot.deviceId !== route.target.deviceId
		|| snapshot.workspaceId !== route.target.workspaceId
	) {
		throw new MeshDomainError(
			'PROTOCOL_INCOMPATIBLE',
			'The routed task response does not match its authoritative route.',
		);
	}
	return snapshot;
}

function isOutboundRouteForNode(
	route: TaskRouteRecord | undefined,
	nodeId: string,
): route is TaskRouteRecord {
	return route?.routeKind === 'remote' && route.sourceNodeId === nodeId;
}
