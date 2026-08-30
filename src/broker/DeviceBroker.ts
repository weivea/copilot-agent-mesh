import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import {
	MESH_ERROR_CODES,
	GATEWAY_NOTIFICATIONS,
	ACTIVE_TASK_STATUSES,
	PROTOCOL_LIMITS,
	brokerRemoteListResultSchema,
	brokerRemoteTaskAnswerParamsSchema,
	brokerRemoteTaskCancelParamsSchema,
	brokerRemoteTaskGetParamsSchema,
	brokerRemoteTaskStartParamsSchema,
	brokerLocalTaskStartParamsSchema,
	dashboardTaskCancelParamsSchema,
	dashboardTaskListResultSchema,
	dashboardTaskReservationResultSchema,
	JSON_RPC_ERROR_CODES,
	LOCAL_BROKER_METHODS,
	LOCAL_BROKER_NOTIFICATIONS,
	nodeHeartbeatParamsSchema,
	nodeIdentityParamsSchema,
	nodeRegistrationResultSchema,
	nodePolicyGetParamsSchema,
	nodePolicySetParamsSchema,
	peerPolicyCandidateListResultSchema,
	peerPolicyCandidateMutationParamsSchema,
	peerPolicyCandidateParamsSchema,
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
	type DashboardTaskDirection,
} from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import type { TaskRecord } from '../domain/task';
import { containsUnsafeDashboardText } from '../ui/DashboardRedaction';
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
import type { NodeRegistry } from './NodeRegistry';
import type {
	PeerPolicyCandidateBinding,
	PeerPolicyService,
} from './PeerPolicyService';
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

interface DashboardTaskBinding {
	readonly ownerId: string;
	readonly taskId: string;
	readonly direction: DashboardTaskDirection;
}

interface DashboardActionRegistry {
	readonly candidates: Map<string, PeerPolicyCandidateBinding>;
	readonly tasks: Map<string, DashboardTaskBinding>;
	readonly taskHandlesByKey: Map<string, string>;
	readonly taskReservations: Map<string, DashboardTaskBinding>;
}

export interface DeviceBrokerOptions extends LocalIpcSessionOptions {
	readonly identity: LocalIpcIdentity;
	readonly brokerKey: Buffer | string;
	readonly ownership: BrokerOwnership;
	readonly registry: NodeRegistry;
	readonly peerPolicies: PeerPolicyService;
	readonly taskService: BrokerTaskService;
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
	private readonly dashboardActions = new WeakMap<LocalIpcSession, DashboardActionRegistry>();
	private readonly sessions = new Set<LocalIpcSession>();
	private readonly activeHandlers = new Set<Promise<JsonValue>>();
	private readonly dashboardNotificationImmediates = new Map<LocalIpcSession, NodeJS.Immediate>();
	private readonly dashboardTaskStates = new Map<string, string>();
	private dashboardNotificationsSent = 0;
	private readonly policySubscription: { dispose(): void };
	private started = false;
	private disposed = false;
	private disposeRequested = false;
	private disposal: Promise<void> | undefined;
	private serverDisposed = false;
	private taskServiceDisposed = false;
	private registryDisposed = false;

	public constructor(private readonly options: DeviceBrokerOptions) {
		if (!options.ownership.isOwner()) {
			throw new Error('Only the current Broker owner can construct a Device Broker.');
		}
		this.taskRoutes = options.taskRoutes ?? new TaskRouteCatalog();
		this.policySubscription = options.peerPolicies.onDidChange(() => {
			this.notifyPolicyChanged();
		});
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
				this.sessions.add(session);
				session.onClose(() => {
					const immediate = this.dashboardNotificationImmediates.get(session);
					if (immediate !== undefined) {
						clearImmediate(immediate);
						this.dashboardNotificationImmediates.delete(session);
					}
					this.registrations.delete(session);
					this.dashboardActions.delete(session);
					this.sessions.delete(session);
					this.notifyDashboardChanged(session);
				});
			},
			onError: options.onError,
		});
	}

	public get endpoint() {
		return this.server.endpoint;
	}

	public dashboardMetrics(): {
		readonly notificationsSent: number;
		readonly pendingNotifications: number;
	} {
		return {
			notificationsSent: this.dashboardNotificationsSent,
			pendingNotifications: this.dashboardNotificationImmediates.size,
		};
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

	private notifyPolicyChanged(): void {
		for (const session of [...this.sessions]) {
			if (session.closed || this.registrations.get(session) === undefined) {
				continue;
			}
			this.dashboardActions.get(session)?.candidates.clear();

			void session.notify(LOCAL_BROKER_NOTIFICATIONS.policyChanged, {}).catch(
				(error: unknown) => this.options.onError?.(
					error instanceof Error
						? error
						: new Error('A peer policy notification failed.'),
				),
			);
		}
	}

	private notifyDashboardChanged(
		excluded?: LocalIpcSession,
		invalidateTaskActions = true,
	): void {
		if (this.disposeRequested || this.disposed) {
			return;
		}
		for (const session of [...this.sessions]) {
			if (
				session === excluded
				|| session.closed
				|| this.registrations.get(session) === undefined
			) {
				continue;
			}
			if (invalidateTaskActions) {
				this.invalidateDashboardTaskActions(session);
			}
			if (this.dashboardNotificationImmediates.has(session)) {
				continue;
			}
			const immediate = setImmediate(() => {
				this.dashboardNotificationImmediates.delete(session);
				if (
					this.disposeRequested
					|| this.disposed
					|| session.closed
					|| this.registrations.get(session) === undefined
				) {
					return;
				}
				this.dashboardNotificationsSent += 1;
				void session.notify(LOCAL_BROKER_NOTIFICATIONS.dashboardChanged, {}).catch(
					(error: unknown) => this.options.onError?.(
						error instanceof Error
							? error
							: new Error('A dashboard notification failed.'),
					),
				);
			});
			this.dashboardNotificationImmediates.set(session, immediate);
		}
	}

	public publishTaskSnapshot(snapshot: TaskSnapshot, sourceNodeId?: string): void {
		const previousState = this.dashboardTaskStates.get(snapshot.taskId);
		this.dashboardTaskStates.delete(snapshot.taskId);
		this.dashboardTaskStates.set(snapshot.taskId, snapshot.state);
		while (this.dashboardTaskStates.size > 1_000) {
			const oldest = this.dashboardTaskStates.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.dashboardTaskStates.delete(oldest);
		}
		if (previousState !== snapshot.state) {
			this.notifyDashboardChanged(undefined, false);
		}
		const source = sourceNodeId;
		if (source === undefined) {
			return;
		}
		for (const session of [...this.sessions]) {
			const binding = this.registrations.get(session);
			if (session.closed || binding?.nodeId !== source) {
				continue;
			}
			void session.notify(
				LOCAL_BROKER_NOTIFICATIONS.taskSnapshot,
				toJsonValue(snapshot),
			).catch((error: unknown) => this.options.onError?.(
				error instanceof Error
					? error
					: new Error('A task snapshot notification failed.'),
			));
		}
	}

	public async reconcileRemoteTaskNotification(
		profileId: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<void> {
		if (
			method !== GATEWAY_NOTIFICATIONS.taskStateChanged
			&& method !== GATEWAY_NOTIFICATIONS.taskInputRequired
			&& method !== GATEWAY_NOTIFICATIONS.taskCompleted
		) {
			return;
		}
		const peerId = uuidSchema.parse(profileId);
		const taskId = uuidSchema.parse(params.taskId);
		const route = this.taskRoutes.get(taskId);
		if (
			route === undefined
			|| route.routeKind !== 'remote'
			|| route.peerId !== peerId
			|| route.sourceNodeId === undefined
		) {
			return;
		}
		const snapshot = await this.requireRemoteTaskService().getTask(
			taskId,
			undefined,
			new AbortController().signal,
		);
		if (snapshot === undefined || 'afterEventSeq' in snapshot) {
			throw new MeshDomainError(
				'TASK_NOT_FOUND',
				'The notified remote task has no authoritative snapshot.',
			);
		}
		await this.taskRoutes.markSnapshot(snapshot);
		this.publishTaskSnapshot(snapshot, route.sourceNodeId);
	}

	public async reconcileRemoteTasks(): Promise<void> {
		const failures: unknown[] = [];
		for (const route of this.taskRoutes.list()) {
			if (
				route.routeKind !== 'remote'
				|| route.sourceNodeId === undefined
				|| route.state === 'completed'
				|| route.state === 'failed'
				|| route.state === 'cancelled'
				|| route.state === 'timedOut'
			) {
				continue;
			}
			try {
				const snapshot = await this.requireRemoteTaskService().getTask(
					route.taskId,
					undefined,
					new AbortController().signal,
				);
				if (snapshot === undefined || 'afterEventSeq' in snapshot) {
					continue;
				}
				await this.taskRoutes.markSnapshot(snapshot);
				this.publishTaskSnapshot(snapshot, route.sourceNodeId);
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				'One or more retained remote tasks could not be reconciled.',
			);
		}
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
			const delegationPrincipal = this.options.registry.windowDelegationPrincipal(
				session,
				{
					nodeId: input.nodeId,
					nodeInstanceId: input.nodeInstanceId,
				},
			);
			this.registrations.set(session, {
				nodeId: input.nodeId,
				nodeInstanceId: input.nodeInstanceId,
			});
			this.notifyDashboardChanged(session);
			return toJsonValue(nodeRegistrationResultSchema.parse({
				node: descriptor,
				delegationPrincipal,
			}));
		}

		const binding = this.requireRegistration(session);
		switch (method) {
			case LOCAL_BROKER_METHODS.heartbeat: {
				const input = nodeHeartbeatParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				const descriptor = this.options.registry.heartbeat(input);
				return toJsonValue(descriptor);
			}
			case LOCAL_BROKER_METHODS.unregister: {
				const input = nodeIdentityParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				this.options.registry.unregister(input, false);
				this.registrations.delete(session);
				this.dashboardActions.delete(session);
				this.notifyDashboardChanged();
				return null;
			}
			case LOCAL_BROKER_METHODS.list:
				emptyParamsSchema.parse(params);
				return toJsonValue(this.options.peerPolicies.listAuthorized(binding));
			case LOCAL_BROKER_METHODS.dashboardList: {
				const input = nodeIdentityParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				return toJsonValue(this.options.peerPolicies.listDashboard(input));
			}
			case LOCAL_BROKER_METHODS.claimWorkspace: {
				const input = nodeWorkspaceClaimParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				const result = await this.options.registry.claimWorkspace(input);
				this.notifyDashboardChanged();
				return toJsonValue(result);
			}
			case LOCAL_BROKER_METHODS.releaseWorkspace: {
				const input = nodeWorkspaceReleaseParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				this.options.registry.releaseWorkspace(input);
				this.notifyDashboardChanged();
				return null;
			}
			case LOCAL_BROKER_METHODS.policyGet: {
				const input = nodePolicyGetParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				return toJsonValue(this.options.peerPolicies.getPolicy(input));
			}
			case LOCAL_BROKER_METHODS.policySet: {
				const input = nodePolicySetParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				return toJsonValue(await this.options.peerPolicies.setPolicy(binding, input));
			}
			case LOCAL_BROKER_METHODS.policyCandidates: {
				const input = peerPolicyCandidateParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				const actions = this.resetCandidateActions(session);
				const bindings = this.options.peerPolicies.listCandidates(input);
				const visibleBindings = bindings.slice(0, PROTOCOL_LIMITS.nodeListCount);
				const candidates = visibleBindings.map((candidateBinding) => {
					const actionHandle = candidateBinding.candidate.canToggle
						? this.issueDashboardHandle(actions, candidateBinding)
						: undefined;
					return {
						...candidateBinding.candidate,
						...(actionHandle === undefined ? {} : { actionHandle }),
					};
				});
				return toJsonValue(peerPolicyCandidateListResultSchema.parse({
					candidates,
					truncated: bindings.length > visibleBindings.length,
					totalCandidates: bindings.length,
				}));
			}
			case LOCAL_BROKER_METHODS.policyCandidateSet: {
				const input = peerPolicyCandidateMutationParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				const actions = this.dashboardActions.get(session)?.candidates;
				const candidate = actions?.get(input.actionHandle);
				actions?.delete(input.actionHandle);
				if (candidate === undefined) {
					throw new MeshDomainError('POLICY_FORBIDDEN', 'The policy candidate action is stale.');
				}
				if (candidate.sourceWorkspaceIdentity !== input.workspaceIdentity) {
					throw new MeshDomainError('POLICY_FORBIDDEN', 'The policy candidate source changed.');
				}
				return toJsonValue(await this.options.peerPolicies.setCandidateAllowed(
					binding,
					candidate,
					input.allowed,
				));
			}
			case LOCAL_BROKER_METHODS.dashboardTasks: {
				const input = nodeIdentityParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				return toJsonValue(await this.listDashboardTasks(session, binding));
			}
			case LOCAL_BROKER_METHODS.dashboardTaskReserve: {
				const input = dashboardTaskCancelParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				const actions = this.dashboardActionRegistry(session);
				const task = actions.tasks.get(input.actionHandle);
				actions.tasks.delete(input.actionHandle);
				if (task === undefined || task.direction !== input.direction) {
					throw new MeshDomainError('TASK_NOT_FOUND', 'The dashboard task action is stale.');
				}
				this.options.taskService.assertDashboardTaskCancellable(
					binding.nodeId,
					binding.nodeInstanceId,
					task.ownerId,
					task.taskId,
					task.direction,
				);
				if (task.direction === 'outgoing') {
					this.taskRoutes.requireForNode(task.taskId, binding.nodeId);
				}
				actions.taskHandlesByKey.delete(dashboardTaskBindingKey(task));
				const reservationHandle = this.issueDashboardHandle(
					actions.taskReservations,
					task,
				);
				return toJsonValue(dashboardTaskReservationResultSchema.parse({
					reservationHandle,
				}));
			}
			case LOCAL_BROKER_METHODS.dashboardTaskCancel: {
				const input = dashboardTaskCancelParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				const actions = this.dashboardActions.get(session)?.taskReservations;
				const task = actions?.get(input.actionHandle);
				actions?.delete(input.actionHandle);
				if (task === undefined || task.direction !== input.direction) {
					throw new MeshDomainError('TASK_NOT_FOUND', 'The dashboard task action is stale.');
				}
				this.options.taskService.assertDashboardTaskCancellable(
					binding.nodeId,
					binding.nodeInstanceId,
					task.ownerId,
					task.taskId,
					task.direction,
				);
				if (task.direction === 'outgoing') {
					this.taskRoutes.requireForNode(task.taskId, binding.nodeId);
				}
				const snapshot = task.direction === 'outgoing'
					? await this.cancelRoutedTask(binding, task.taskId)
					: await this.options.taskService.cancelForTarget(
						binding.nodeId,
						binding.nodeInstanceId,
						task.ownerId,
						task.taskId,
					);
				return toJsonValue(taskSnapshotSchema.parse(snapshot));
			}
			case LOCAL_BROKER_METHODS.dashboardTaskRelease: {
				const input = dashboardTaskCancelParamsSchema.parse(params);
				this.assertIdentity(binding, input);
				const reservations = this.dashboardActions.get(session)?.taskReservations;
				const task = reservations?.get(input.actionHandle);
				reservations?.delete(input.actionHandle);
				if (task === undefined || task.direction !== input.direction) {
					throw new MeshDomainError('TASK_NOT_FOUND', 'The dashboard task reservation is stale.');
				}
				return null;
			}
			case LOCAL_BROKER_METHODS.taskStart: {
				const input = brokerLocalTaskStartParamsSchema.parse(params);
				if (input.sourceNodeId !== binding.nodeId) {
					throw new MeshDomainError(
						'AUTH_FAILED',
						'The task source does not match the authenticated Window Node.',
					);
				}
				this.options.registry.assertDelegationPrincipal(
					session,
					binding,
					input.delegationPrincipal,
				);
				const {
					delegationPrincipal: _delegationPrincipal,
					...routeInput
				} = input;
				const snapshot = await this.startLocalRoute(
					routeInput,
					{ nodeId: binding.nodeId },
					this.options.identity.deviceId,
					() => this.options.taskService.prevalidateLocal(binding, routeInput),
					(outcome) =>
						this.options.taskService.startLocal(binding, routeInput, outcome),
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
				this.options.registry.assertDelegationPrincipal(
					session,
					binding,
					input.delegationPrincipal,
				);
				const routeInput: RoutedTaskStartParams = {
					delegationRequestId: input.delegationRequestId,
					taskId: input.taskId,
					target: input.target,
					sourceNodeId: input.sourceNodeId,
					sourceWorkspaceIdentity: input.sourceWorkspaceIdentity,
					title: input.title,
					prompt: input.prompt,
					acceptanceCriteria: input.acceptanceCriteria,
					timeoutMinutes: input.timeoutMinutes,
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

	private async listDashboardTasks(
		session: LocalIpcSession,
		binding: RegisteredSession,
	): Promise<ReturnType<typeof dashboardTaskListResultSchema.parse>> {
		const actions = this.dashboardActionRegistry(session);
		const records = await this.options.taskService.listDashboardRecords();
		const activeStates = new Set<string>(ACTIVE_TASK_STATUSES);
		const projected = records
			.flatMap((record) => {
				const direction = dashboardTaskDirection(record, binding, this.options.identity.deviceId);
				if (direction === undefined) {
					return [];
				}
				const counterpart = this.dashboardTaskCounterpart(record, direction);
				return [{
					binding: {
						ownerId: record.peerId,
						taskId: record.taskId,
						direction,
					},
					task: {
						direction,
						counterpartLabel: counterpart.label,
						workspaceName: counterpart.workspaceName,
						title: safeDashboardLabel(record.title, 'Delegated task'),
						state: record.state,
						startedAt: record.createdAt,
						shortId: record.taskId.slice(0, 8),
						canCancel: activeStates.has(record.state),
					},
				}];
			})
			.sort((left, right) =>
				compareDashboardTimestampsDescending(
					left.task.startedAt,
					right.task.startedAt,
				)
			);
		const visible = projected.slice(0, 500);
		const retainedTaskKeys = new Set(
			visible
				.filter(({ task }) => task.canCancel)
				.map(({ binding: taskBinding }) => dashboardTaskBindingKey(taskBinding)),
		);
		this.pruneDashboardTaskActions(actions, retainedTaskKeys);
		const tasks = visible.map(({ binding: taskBinding, task }) => {
			if (!task.canCancel) {
				return task;
			}
			return {
				...task,
				actionHandle: this.stableDashboardTaskHandle(actions, taskBinding),
			};
		});
		return dashboardTaskListResultSchema.parse({
			tasks,
			truncated: projected.length > visible.length,
			totalTasks: projected.length,
		});
	}

	private dashboardTaskCounterpart(
		record: TaskRecord,
		direction: DashboardTaskDirection,
	): { readonly label: string; readonly workspaceName: string } {
		if (record.schemaVersion !== 2) {
			return { label: 'Window', workspaceName: 'Workspace' };
		}
		const node = direction === 'outgoing'
			&& record.target.nodeId !== undefined
			&& record.target.nodeInstanceId !== undefined
			? this.options.registry.peerNode({
				nodeId: record.target.nodeId,
				nodeInstanceId: record.target.nodeInstanceId,
			})
			: direction === 'incoming' && record.sourceNodeId !== undefined
				? this.options.registry.peerNodes().find(({ nodeId }) =>
					nodeId === record.sourceNodeId
				)
				: undefined;
		const workspace = direction === 'outgoing'
			? node?.workspaces.find(({ workspaceId }) => workspaceId === record.workspaceId)
			: record.sourceWorkspaceIdentity === undefined
				? undefined
				: node?.workspaces.find(({ workspaceIdentity }) =>
					workspaceIdentity === record.sourceWorkspaceIdentity
				);
		return {
			label: node === undefined
				? direction === 'outgoing' ? 'Offline peer' : 'Connected source'
				: this.options.peerPolicies.displayLabel(node),
			workspaceName: safeDashboardLabel(workspace?.name ?? 'Workspace', 'Workspace'),
		};
	}

	private resetCandidateActions(
		session: LocalIpcSession,
	): Map<string, PeerPolicyCandidateBinding> {
		const registry = this.dashboardActionRegistry(session);
		registry.candidates.clear();
		return registry.candidates;
	}

	private dashboardActionRegistry(session: LocalIpcSession): DashboardActionRegistry {
		let registry = this.dashboardActions.get(session);
		if (registry === undefined) {
			registry = {
				candidates: new Map(),
				tasks: new Map(),
				taskHandlesByKey: new Map(),
				taskReservations: new Map(),
			};
			this.dashboardActions.set(session, registry);
		}
		return registry;
	}

	private stableDashboardTaskHandle(
		actions: DashboardActionRegistry,
		binding: DashboardTaskBinding,
	): string {
		const key = dashboardTaskBindingKey(binding);
		const existingHandle = actions.taskHandlesByKey.get(key);
		if (existingHandle !== undefined) {
			const existing = actions.tasks.get(existingHandle);
			if (existing !== undefined && dashboardTaskBindingKey(existing) === key) {
				return existingHandle;
			}
			actions.taskHandlesByKey.delete(key);
		}
		const handle = this.issueDashboardHandle(actions.tasks, binding);
		actions.taskHandlesByKey.set(key, handle);
		return handle;
	}

	private pruneDashboardTaskActions(
		actions: DashboardActionRegistry,
		retainedKeys: ReadonlySet<string>,
	): void {
		for (const [key, handle] of actions.taskHandlesByKey) {
			if (retainedKeys.has(key)) {
				continue;
			}
			actions.taskHandlesByKey.delete(key);
			actions.tasks.delete(handle);
		}
	}

	private invalidateDashboardTaskActions(session: LocalIpcSession): void {
		const actions = this.dashboardActions.get(session);
		actions?.tasks.clear();
		actions?.taskHandlesByKey.clear();
		actions?.taskReservations.clear();
	}

	private issueDashboardHandle<T>(actions: Map<string, T>, binding: T): string {
		if (actions.size >= 500) {
			throw new MeshDomainError('RATE_LIMITED', 'The dashboard action registry is full.');
		}
		let handle: string;
		do {
			handle = randomBytes(24).toString('base64url');
		} while (actions.has(handle));
		actions.set(handle, binding);
		return handle;
	}

	private assertActive(): void {
		if (this.disposeRequested || this.disposed || !this.options.ownership.isOwner()) {
			throw new MeshDomainError('WORKER_DRAINING', 'The Device Broker is shutting down.');
		}
	}

	private async disposeOnce(): Promise<void> {
		this.policySubscription.dispose();
		for (const immediate of this.dashboardNotificationImmediates.values()) {
			clearImmediate(immediate);
		}
		this.dashboardNotificationImmediates.clear();
		this.dashboardTaskStates.clear();
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

function dashboardTaskDirection(
	record: TaskRecord,
	binding: RegisteredSession,
	deviceId: string,
): DashboardTaskDirection | undefined {
	if (record.schemaVersion !== 2) {
		return undefined;
	}
	if (
		record.peerId === deviceId
		&& record.sourceNodeId === binding.nodeId
		&& record.target.nodeId !== undefined
		&& record.target.nodeInstanceId !== undefined
	) {
		return 'outgoing';
	}
	if (
		record.target.nodeId === binding.nodeId
		&& record.target.nodeInstanceId === binding.nodeInstanceId
	) {
		return 'incoming';
	}
	return undefined;
}

function dashboardTaskBindingKey(binding: DashboardTaskBinding): string {
	return `${binding.ownerId}:${binding.taskId}:${binding.direction}`;
}

function safeDashboardLabel(value: string, fallback: string): string {
	return containsUnsafeDashboardText(value) ? fallback : value;
}

function compareDashboardTimestampsDescending(left: string, right: string): number {
	const leftTime = Date.parse(left);
	const rightTime = Date.parse(right);
	if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
		return rightTime - leftTime;
	}
	return right.localeCompare(left);
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
