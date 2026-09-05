import { z } from 'zod';

import {
	MESH_ERROR_CODES,
	brokerRemoteListResultSchema,
	brokerRemoteTaskAnswerParamsSchema,
	brokerRemoteTaskCancelParamsSchema,
	brokerRemoteTaskGetParamsSchema,
	brokerRemoteTaskStartParamsSchema,
	brokerLocalTaskStartParamsSchema,
	dashboardTaskCancelParamsSchema,
	dashboardTaskListResultSchema,
	dashboardTaskReservationResultSchema,
	delegatedExecutionContextSchema,
	nodeRegistrationResultSchema,
	dashboardNodeDirectoryResultSchema,
	JSON_RPC_ERROR_CODES,
	LOCAL_BROKER_METHODS,
	connectivitySnapshotSchema,
	type ConnectivityAction,
	type ConnectivitySnapshot,
	type BrokerRemoteListResult,
	remotePolicyDashboardSchema,
	remotePolicyActionParamsSchema,
	type RemotePolicyAction,
	type RemotePolicyDashboard,
	LOCAL_BROKER_NOTIFICATIONS,
	PROTOCOL_LIMITS,
	nodeDirectoryResultSchema,
	nodePolicyGetParamsSchema,
	nodePolicyResultSchema,
	nodePolicySetParamsSchema,
	peerPolicyCandidateListResultSchema,
	peerPolicyCandidateMutationParamsSchema,
	peerPolicyCandidateParamsSchema,
	nodeStatusSchema,
	nodeTaskAnswerParamsSchema,
	nodeTaskCancelParamsSchema,
	nodeTaskEventParamsSchema,
	nodeTaskStartedResultSchema,
	nodeTaskStartParamsSchema,
	routedTaskStartParamsSchema,
	taskAnswerParamsSchema,
	taskSnapshotAfterEventSeqSchema,
	taskSnapshotSchema,
	utf8String,
	uuidSchema,
	windowNodeDescriptorSchema,
	type DashboardNodeDirectoryResult,
	type DashboardTaskDirection,
	type DashboardTaskListResult,
	type DashboardTaskReservationResult,
	type DelegatedExecutionContext,
	type DelegationPrincipal,
	type WindowDelegationPrincipal,
	type NodeDirectoryResult,
	type NodePolicyResult,
	type NodePolicySetParams,
	type NodeStatus,
	type PeerPolicyCandidateListResult,
	type NodeTaskEventParams,
	type RoutedTaskStartParams,
	type TaskSnapshot,
	type TaskSnapshotAfterEventSeq,
	type WorkspaceClaimStatus,
	type MeshErrorReason,
} from '../../shared/protocol';
import type { MeshRemoteDirectorySnapshot } from '../../shared/toolProtocol';
import {
	AgentRuntimeError,
	type RegisteredLocalWorkspace,
	type WorkspaceResolver,
} from '../agentHost/AgentRuntime';
import { MeshDomainError } from '../domain/errors';
import type { Clock } from '../domain/ports';
import {
	LocalIpcClient,
	LocalIpcHandlerError,
	LocalIpcRemoteError,
	type JsonValue,
	type LocalIpcIdentity,
	type LocalIpcSession,
	type LocalIpcSessionOptions,
} from '../ipc';
import {
	NodeFileIdentityResolver,
	type FileIdentityFileSystem,
} from '../workspaces/NodeFileIdentityResolver';
import {
	createOpaqueWorkspaceIdentity,
	createWorkspaceScopeIdentity,
} from '../workspaces/OpaqueWorkspaceIdentity';
import type { FileIdentityResolver } from '../workspaces/WorkspaceRegistry';
import {
	WindowNodeTaskExecutorDisposalError,
	type WindowNodeTaskEventSink,
	type WindowNodeTaskExecutor,
} from './WindowNodeTaskExecutor';

const workspaceSourceEntrySchema = z.strictObject({
	localUri: z.string().url().refine(
		(value) => new URL(value).protocol === 'file:',
		'Workspace URI must use file:',
	),
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace name', 1),
	capabilityTags: z.array(utf8String(64, 'capability tag', 1)).max(32).default([]),
});
const workspaceClaimResultSchema = z.strictObject({
	workspaceId: uuidSchema,
	status: z.enum(['claimed', 'readOnly', 'conflict']),
	canExecute: z.boolean(),
});
const nullResultSchema = z.null();

export interface WindowNodeWorkspaceSourceEntry {
	readonly localUri: string;
	readonly name: string;
	readonly capabilityTags?: readonly string[];
}

export interface WindowNodeWorkspaceSource {
	list(): Promise<readonly WindowNodeWorkspaceSourceEntry[]>
		| readonly WindowNodeWorkspaceSourceEntry[];
}

export interface WindowNodeTimer {
	dispose(): void;
}

export interface WindowNodeScheduler {
	schedule(callback: () => void, delayMs: number): WindowNodeTimer;
}

export interface WindowNodeBackoffOptions {
	readonly initialDelayMs?: number;
	readonly maxDelayMs?: number;
	readonly multiplier?: number;
	readonly jitterRatio?: number;
	readonly random?: () => number;
}

export interface WindowNodeExecutor {
	start: WindowNodeTaskExecutor['start'];
	cancel: WindowNodeTaskExecutor['cancel'];
	disposeTask?: WindowNodeTaskExecutor['disposeTask'];
	answer: WindowNodeTaskExecutor['answer'];
	dispose: WindowNodeTaskExecutor['dispose'];
	readonly generationClosed?: boolean;
}

export interface WindowNodeExecutorContext {
	readonly workspaceResolver: WorkspaceResolver;
	readonly eventSink: WindowNodeTaskEventSink;
}

export type WindowNodeExecutorFactory = (
	context: WindowNodeExecutorContext,
) => WindowNodeExecutor;

export type WindowNodeClientState =
	| 'idle'
	| 'connecting'
	| 'online'
	| 'reconnecting'
	| 'disposed';

export interface WindowNodeClientSnapshot {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly label: string;
	readonly state: WindowNodeClientState;
	readonly registered: boolean;
	readonly workspaceCount: number;
	readonly conflicts: number;
}

export interface WindowNodeClientOptions extends LocalIpcSessionOptions {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly label: string;
	readonly capabilities: readonly string[];
	readonly status?: Exclude<NodeStatus, 'offline'>;
	readonly identity: LocalIpcIdentity;
	readonly brokerKey: Buffer | string;
	readonly executor: WindowNodeExecutor | WindowNodeExecutorFactory;
	readonly workspaceSource: WindowNodeWorkspaceSource | (() =>
		Promise<readonly WindowNodeWorkspaceSourceEntry[]>
		| readonly WindowNodeWorkspaceSourceEntry[]);
	readonly fileIdentityResolver?: FileIdentityResolver;
	readonly fileIdentityFileSystem?: FileIdentityFileSystem;
	readonly clock?: Clock | (() => Date);
	readonly scheduler?: WindowNodeScheduler;
	readonly backoff?: WindowNodeBackoffOptions;
	readonly heartbeatIntervalMs?: number;
	readonly handshakeTimeoutMs?: number;
	readonly onError?: (error: Error) => void;
}

interface WorkspaceObservation {
	readonly workspaceIdentity: string;
	readonly workspaceId: string;
	readonly status: WorkspaceClaimStatus;
	readonly sourceUri: string;
	readonly workspace: RegisteredLocalWorkspace;
}

export type PeerPolicyWorkspaceSelection =
	| {
		readonly kind: 'selected';
		readonly workspaceIdentity: string;
		readonly workspaceId: string;
		readonly workspaceName: string;
		readonly claimStatus: 'claimed';
	}
	| {
		readonly kind: 'unavailable';
		readonly workspaceName: string;
		readonly claimStatus: 'unclaimed' | 'readOnly' | 'conflict' | 'ambiguous';
	};

const defaultScheduler: WindowNodeScheduler = {
	schedule(callback, delayMs) {
		const timer = setTimeout(callback, delayMs);
		timer.unref();
		return { dispose: () => clearTimeout(timer) };
	},
};

/**
 * Reconnecting authenticated Window Node client and local broker facade.
 */
export class WindowNodeClient implements WorkspaceResolver {
	public readonly eventSink: WindowNodeTaskEventSink = {
		publish: (event) => this.publishTaskEvent(event),
	};

	public readonly nodeId: string;
	public readonly nodeInstanceId: string;
	public readonly label: string;
	private readonly capabilities: readonly string[];
	private readonly status: Exclude<NodeStatus, 'offline'>;
	private readonly startedAt: string;
	private readonly now: () => Date;
	private readonly scheduler: WindowNodeScheduler;
	private readonly identityResolver: FileIdentityResolver;
	private readonly executorFactory: WindowNodeExecutorFactory | undefined;
	private executor: WindowNodeExecutor | undefined;
	private readonly retiredExecutors = new WeakSet<WindowNodeExecutor>();
	private readonly workspaces = new Map<string, RegisteredLocalWorkspace>();
	private readonly observations = new Map<string, WorkspaceObservation>();
	private readonly knownWorkspaceIds = new Map<string, string>();
	private client: LocalIpcClient | undefined;
	private session: LocalIpcSession | undefined;
	private windowDelegationPrincipal: WindowDelegationPrincipal | undefined;
	private removeCloseListener: (() => void) | undefined;
	private heartbeatTimer: WindowNodeTimer | undefined;
	private reconnectTimer: WindowNodeTimer | undefined;
	private connectionOperation: Promise<void> | undefined;
	private executorTransitionOperation: Promise<void> | undefined;
	private transitioningExecutor: WindowNodeExecutor | undefined;
	private executorTransitionFailure: unknown;
	private firstConnection: Promise<void> | undefined;
	private resolveFirstConnection: (() => void) | undefined;
	private rejectFirstConnection: ((error: Error) => void) | undefined;
	private reconnectAttempt = 0;
	private readonly stateListeners = new Set<() => void>();
	private readonly taskSnapshotListeners = new Set<(snapshot: TaskSnapshot) => void>();
	private stateValue: WindowNodeClientState = 'idle';
	private registered = false;
	private started = false;
	private reconnectBlocked = false;
	private readonly lifecycleFailures: Error[] = [];
	private disposed = false;
	private disposeComplete = false;
	private disposal: Promise<void> | undefined;

	public constructor(private readonly options: WindowNodeClientOptions) {
		this.nodeId = uuidSchema.parse(options.nodeId);
		this.nodeInstanceId = uuidSchema.parse(options.nodeInstanceId);
		this.label = utf8String(
			PROTOCOL_LIMITS.nameBytes,
			'window node label',
			1,
		).parse(options.label);
		this.capabilities = z.array(
			utf8String(PROTOCOL_LIMITS.identifierBytes, 'node capability', 1),
		).max(32).parse(options.capabilities);
		this.status = nodeStatusSchema.exclude(['offline']).parse(options.status ?? 'online');
		const clock = options.clock;
		this.now = typeof clock === 'function'
			? clock
			: clock === undefined
				? () => new Date()
				: () => clock.now();
		this.startedAt = this.now().toISOString();
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.identityResolver = options.fileIdentityResolver
			?? new NodeFileIdentityResolver(options.fileIdentityFileSystem);
		this.validateTimingOptions();
		this.executorFactory = typeof options.executor === 'function'
			? options.executor
			: undefined;
		this.executor = this.executorFactory === undefined
			? options.executor as WindowNodeExecutor
			: this.createExecutor();
	}

	public get deviceId(): string {
		return this.options.identity.deviceId;
	}

	public snapshot(): WindowNodeClientSnapshot {
		return {
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			label: this.label,
			state: this.stateValue,
			registered: this.registered,
			workspaceCount: this.observations.size,
			conflicts: [...this.observations.values()].filter(
				({ status }) => status === 'conflict',
			).length,
		};
	}

	public onDidChange(listener: () => void): { dispose(): void } {
		this.stateListeners.add(listener);
		return { dispose: () => this.stateListeners.delete(listener) };
	}

	public onTaskSnapshot(listener: (snapshot: TaskSnapshot) => void): { dispose(): void } {
		this.taskSnapshotListeners.add(listener);
		return { dispose: () => this.taskSnapshotListeners.delete(listener) };
	}

	public start(): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new Error('Window Node client is disposed.'));
		}
		if (this.firstConnection === undefined) {
			this.firstConnection = new Promise<void>((resolve, reject) => {
				this.resolveFirstConnection = resolve;
				this.rejectFirstConnection = reject;
			});
		}
		if (!this.started) {
			this.started = true;
			this.transition('connecting');
			this.connectNow();
		}
		return this.firstConnection;
	}

	public connect(): Promise<void> {
		return this.start();
	}

	public async resolve(workspaceId: string): Promise<RegisteredLocalWorkspace | undefined> {
		const id = uuidSchema.safeParse(workspaceId);
		return id.success ? this.workspaces.get(id.data) : undefined;
	}

	public selectPeerPolicyWorkspace(
		activeWorkspaceUri?: string,
	): PeerPolicyWorkspaceSelection {
		const observations = [...this.observations.values()];
		const active = activeWorkspaceUri === undefined
			? undefined
			: observations.find(({ sourceUri, workspace }) =>
				sourceUri === activeWorkspaceUri || workspace.uri === activeWorkspaceUri,
			);
		if (active !== undefined) {
			return policyWorkspaceSelection(active);
		}
		const claimed = observations.filter(({ status }) => status === 'claimed');
		if (claimed.length === 1) {
			return policyWorkspaceSelection(claimed[0]);
		}
		if (observations.length === 1) {
			return policyWorkspaceSelection(observations[0]);
		}
		return {
			kind: 'unavailable',
			workspaceName: observations.length === 0 ? 'No Workspace' : 'Multiple Workspaces',
			claimStatus: observations.length === 0 ? 'unclaimed' : 'ambiguous',
		};
	}

	public delegationSourceScopeIdentity(): string {
		return createWorkspaceScopeIdentity(
			[...this.observations.values()]
				.filter(({ status }) => status === 'claimed')
				.map(({ workspaceIdentity }) => workspaceIdentity),
		);
	}

	public listNodes(): Promise<NodeDirectoryResult> {
		return this.request(LOCAL_BROKER_METHODS.list, {}, nodeDirectoryResultSchema);
	}

	public listDashboardNodes(): Promise<DashboardNodeDirectoryResult> {
		return this.request(
			LOCAL_BROKER_METHODS.dashboardList,
			toJsonValue({
				nodeId: this.nodeId,
				nodeInstanceId: this.nodeInstanceId,
			}),
			dashboardNodeDirectoryResultSchema,
		);
	}

	public connectivitySnapshot(): Promise<ConnectivitySnapshot> {
		return this.request(LOCAL_BROKER_METHODS.connectivitySnapshot, {
			nodeId: this.nodeId, nodeInstanceId: this.nodeInstanceId,
		}, connectivitySnapshotSchema);
	}

	public async connectivityAction(action: ConnectivityAction, actionHandle?: string): Promise<void> {
		await this.requireConnected().request(LOCAL_BROKER_METHODS.connectivityAction, {
			nodeId: this.nodeId, nodeInstanceId: this.nodeInstanceId, action,
			...(actionHandle === undefined ? {} : { actionHandle }),
		}, 180_000);
	}

	public cachedRemoteDevices(): Promise<BrokerRemoteListResult> {
		return this.request(LOCAL_BROKER_METHODS.remoteCachedList, {}, brokerRemoteListResultSchema);
	}

	public remotePolicyDashboard(): Promise<RemotePolicyDashboard> {
		return this.request(LOCAL_BROKER_METHODS.remotePolicyDashboard, {
			nodeId: this.nodeId, nodeInstanceId: this.nodeInstanceId,
		}, remotePolicyDashboardSchema);
	}

	public async remotePolicyAction(action: RemotePolicyAction, actionHandle: string, enabled: boolean): Promise<void> {
		const params = remotePolicyActionParamsSchema.parse({
			nodeId: this.nodeId, nodeInstanceId: this.nodeInstanceId, action, actionHandle, enabled,
		});
		await this.requireConnected().request(LOCAL_BROKER_METHODS.remotePolicyAction, toJsonValue(params), 180_000);
	}

	public getPeerPolicy(workspaceIdentity?: string): Promise<NodePolicyResult> {
		const params = nodePolicyGetParamsSchema.parse({
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			...(workspaceIdentity === undefined ? {} : { workspaceIdentity }),
		});
		return this.request(
			LOCAL_BROKER_METHODS.policyGet,
			toJsonValue(params),
			nodePolicyResultSchema,
		);
	}

	public setPeerPolicy(
		patch: Omit<NodePolicySetParams, 'nodeId' | 'nodeInstanceId'>,
	): Promise<NodePolicyResult> {
		const params = nodePolicySetParamsSchema.parse({
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			...patch,
		});
		return this.request(
			LOCAL_BROKER_METHODS.policySet,
			toJsonValue(params),
			nodePolicyResultSchema,
		);
	}

	public listPeerPolicyCandidates(workspaceIdentity: string): Promise<PeerPolicyCandidateListResult> {
		const params = peerPolicyCandidateParamsSchema.parse({
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			workspaceIdentity,
		});
		return this.request(
			LOCAL_BROKER_METHODS.policyCandidates,
			toJsonValue(params),
			peerPolicyCandidateListResultSchema,
		);
	}

	public setPeerPolicyCandidate(
		workspaceIdentity: string,
		actionHandle: string,
		allowed: boolean,
	): Promise<NodePolicyResult> {
		const params = peerPolicyCandidateMutationParamsSchema.parse({
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			workspaceIdentity,
			actionHandle,
			allowed,
		});
		return this.request(
			LOCAL_BROKER_METHODS.policyCandidateSet,
			toJsonValue(params),
			nodePolicyResultSchema,
		);
	}

	public listDashboardTasks(): Promise<DashboardTaskListResult> {
		return this.request(
			LOCAL_BROKER_METHODS.dashboardTasks,
			toJsonValue({
				nodeId: this.nodeId,
				nodeInstanceId: this.nodeInstanceId,
			}),
			dashboardTaskListResultSchema,
		);
	}

	public cancelDashboardTask(
		actionHandle: string,
		direction: DashboardTaskDirection,
	): Promise<TaskSnapshot> {
		const params = dashboardTaskCancelParamsSchema.parse({
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			actionHandle,
			direction,
		});
		return this.request(
			LOCAL_BROKER_METHODS.dashboardTaskCancel,
			toJsonValue(params),
			taskSnapshotSchema,
		);
	}

	public reserveDashboardTask(
		actionHandle: string,
		direction: DashboardTaskDirection,
	): Promise<DashboardTaskReservationResult> {
		const params = dashboardTaskCancelParamsSchema.parse({
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			actionHandle,
			direction,
		});
		return this.request(
			LOCAL_BROKER_METHODS.dashboardTaskReserve,
			toJsonValue(params),
			dashboardTaskReservationResultSchema,
		);
	}

	public releaseDashboardTask(
		reservationHandle: string,
		direction: DashboardTaskDirection,
	): Promise<void> {
		const params = dashboardTaskCancelParamsSchema.parse({
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			actionHandle: reservationHandle,
			direction,
		});
		return this.request(
			LOCAL_BROKER_METHODS.dashboardTaskRelease,
			toJsonValue(params),
			z.null(),
		).then(() => undefined);
	}

	public listRemoteDevices(): Promise<MeshRemoteDirectorySnapshot> {
		return this.request(
			LOCAL_BROKER_METHODS.remoteList,
			{},
			brokerRemoteListResultSchema,
		);
	}

	public startRemoteTask(
		input: RoutedTaskStartParams,
		peerId: string,
	): Promise<TaskSnapshot> {
		return this.startRemoteTaskCore(input, peerId);
	}

	public startRemoteTaskFromDelegatedChild(
		input: RoutedTaskStartParams,
		peerId: string,
		context: DelegatedExecutionContext,
	): Promise<TaskSnapshot> {
		return this.startRemoteTaskCore(input, peerId, delegatedExecutionContextSchema.parse(context));
	}

	private startRemoteTaskCore(
		input: RoutedTaskStartParams,
		peerId: string,
		context?: DelegatedExecutionContext,
	): Promise<TaskSnapshot> {
		const parsed = routedTaskStartParamsSchema.parse(input);
		if (parsed.sourceNodeId !== undefined && parsed.sourceNodeId !== this.nodeId) {
			throw new MeshDomainError(
				'TASK_ID_CONFLICT',
				'The task source does not match this Window Node.',
			);
		}
		const params = brokerRemoteTaskStartParamsSchema.parse({
			...parsed,
			sourceNodeId: this.nodeId,
			peerId,
			delegationPrincipal: this.delegationPrincipal(context),
		});
		return this.request(
			LOCAL_BROKER_METHODS.remoteTaskStart,
			toJsonValue(params),
			taskSnapshotSchema,
		);
	}

	public getRemoteTask(
		taskId: string,
		afterEventSeq?: number,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq | undefined> {
		const params = brokerRemoteTaskGetParamsSchema.parse({
			taskId,
			...(afterEventSeq === undefined ? {} : { afterEventSeq }),
		});
		const schema = z.union([
			afterEventSeq === undefined ? taskSnapshotSchema : taskSnapshotAfterEventSeqSchema,
			z.null(),
		]);
		return this.request(
			LOCAL_BROKER_METHODS.remoteTaskGet,
			toJsonValue(params),
			schema,
		).then((result) => result ?? undefined);
	}

	public cancelRemoteTask(taskId: string): Promise<TaskSnapshot | undefined> {
		const params = brokerRemoteTaskCancelParamsSchema.parse({ taskId });
		return this.request(
			LOCAL_BROKER_METHODS.remoteTaskCancel,
			toJsonValue(params),
			z.union([taskSnapshotSchema, z.null()]),
		).then((result) => result ?? undefined);
	}

	public answerRemoteTask(
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
	): Promise<TaskSnapshot | undefined> {
		const params = brokerRemoteTaskAnswerParamsSchema.parse({
			taskId,
			inputId,
			answerId,
			answer,
		});
		return this.request(
			LOCAL_BROKER_METHODS.remoteTaskAnswer,
			toJsonValue(params),
			z.union([taskSnapshotSchema, z.null()]),
		).then((result) => result ?? undefined);
	}

	public startTask(input: RoutedTaskStartParams): Promise<TaskSnapshot> {
		return this.startTaskCore(input);
	}

	public startTaskFromDelegatedChild(
		input: RoutedTaskStartParams,
		context: DelegatedExecutionContext,
	): Promise<TaskSnapshot> {
		return this.startTaskCore(input, delegatedExecutionContextSchema.parse(context));
	}

	private startTaskCore(
		input: RoutedTaskStartParams,
		context?: DelegatedExecutionContext,
	): Promise<TaskSnapshot> {
		const parsed = routedTaskStartParamsSchema.parse(input);
		if (parsed.sourceNodeId !== undefined && parsed.sourceNodeId !== this.nodeId) {
			throw new MeshDomainError(
				'TASK_ID_CONFLICT',
				'The task source does not match this Window Node.',
			);
		}
		const params = brokerLocalTaskStartParamsSchema.parse({
			...parsed,
			sourceNodeId: this.nodeId,
			delegationPrincipal: this.delegationPrincipal(context),
		});
		return this.request(
			LOCAL_BROKER_METHODS.taskStart,
			toJsonValue(params),
			taskSnapshotSchema,
		);
	}

	public getTask(
		taskId: string,
		afterEventSeq?: number,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq> {
		const params = {
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			taskId: uuidSchema.parse(taskId),
			...(afterEventSeq === undefined ? {} : { afterEventSeq }),
		};
		return this.request(
			'node.task.get',
			toJsonValue(params),
			afterEventSeq === undefined
				? taskSnapshotSchema
				: taskSnapshotAfterEventSeqSchema,
		);
	}

	public cancelTask(taskId: string): Promise<TaskSnapshot> {
		const params = nodeTaskCancelParamsSchema.parse({
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			taskId,
		});
		return this.request(
			LOCAL_BROKER_METHODS.taskCancel,
			toJsonValue(params),
			taskSnapshotSchema,
		);
	}

	public answerTask(
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
	): Promise<TaskSnapshot> {
		const answerInput = taskAnswerParamsSchema.parse({
			taskId,
			inputId,
			answerId,
			answer,
		});
		const params = nodeTaskAnswerParamsSchema.parse({
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			...answerInput,
		});
		return this.request(
			LOCAL_BROKER_METHODS.taskAnswer,
			toJsonValue(params),
			taskSnapshotSchema,
		);
	}

	public async refreshWorkspaces(): Promise<void> {
		const session = this.requireConnected();
		await this.claimCurrentWorkspaces(session);
	}

	public async publishTaskEvent(event: NodeTaskEventParams): Promise<void> {
		const params = nodeTaskEventParamsSchema.parse(event);
		if (
			params.nodeId !== this.nodeId
			|| params.nodeInstanceId !== this.nodeInstanceId
		) {
			throw new MeshDomainError(
				'AGENT_UNAVAILABLE',
				'The task event does not belong to this Window Node.',
			);
		}
		const session = this.requireConnected();
		const result = await session.request(
			LOCAL_BROKER_METHODS.taskEvent,
			toJsonValue(params),
		);
		nullResultSchema.parse(result);
	}

	public dispose(): Promise<void> {
		if (this.disposal !== undefined) {
			return this.disposal;
		}
		if (this.disposeComplete) {
			return Promise.resolve();
		}
		let disposal!: Promise<void>;
		disposal = this.disposeOnce().then(() => {
			this.disposeComplete = true;
		}).finally(() => {
			if (!this.disposeComplete && this.disposal === disposal) {
				this.disposal = undefined;
			}
		});
		this.disposal = disposal;
		return disposal;
	}

	private connectNow(): void {
		if (
			this.disposed
			|| this.reconnectBlocked
			|| this.connectionOperation !== undefined
			|| this.executorTransitionOperation !== undefined
		) {
			return;
		}
		this.reconnectTimer?.dispose();
		this.reconnectTimer = undefined;
		if (this.executor === undefined) {
			if (this.executorFactory === undefined) {
				this.blockReconnect(
					'The Window Node cannot reconnect with a disposed one-shot executor.',
					false,
				);
				return;
			}
			try {
				this.executor = this.createExecutor();
			} catch {
				this.reportSafeError(
					'A fresh Window Node executor could not be created; Broker reconnect is delayed.',
				);
				this.transition('reconnecting');
				this.scheduleReconnect();
				return;
			}
		}
		const operation = this.connectOnce();
		this.connectionOperation = operation;
		const finished = (): void => {
			if (this.connectionOperation === operation) {
				this.connectionOperation = undefined;
			}
			if (
				!this.disposed
				&& !this.reconnectBlocked
				&& this.stateValue === 'reconnecting'
				&& this.executorTransitionOperation === undefined
				&& this.reconnectTimer === undefined
			) {
				this.scheduleReconnect();
			}
		};
		void operation.then(finished, finished);
	}

	private async connectOnce(): Promise<void> {
		const client = new LocalIpcClient({
			identity: this.options.identity,
			brokerKey: this.options.brokerKey,
			clientId: this.nodeInstanceId,
			...(this.options.requestTimeoutMs === undefined ? {} : {
				requestTimeoutMs: this.options.requestTimeoutMs,
			}),
			...(this.options.maxPendingRequests === undefined ? {} : {
				maxPendingRequests: this.options.maxPendingRequests,
			}),
			...(this.options.maxOutboundBytes === undefined ? {} : {
				maxOutboundBytes: this.options.maxOutboundBytes,
			}),
			...(this.options.backpressureTimeoutMs === undefined ? {} : {
				backpressureTimeoutMs: this.options.backpressureTimeoutMs,
			}),
			...(this.options.handshakeTimeoutMs === undefined ? {} : {
				handshakeTimeoutMs: this.options.handshakeTimeoutMs,
			}),
			handler: (method, params, session) =>
				this.handleBrokerRequestSafely(method, params, session),
		});
		this.client = client;
		try {
			const session = await client.connect();
			if (this.disposed || this.client !== client) {
				client.dispose();
				return;
			}
			this.session = session;
			this.removeCloseListener = session.onClose(() => this.handleDisconnect(session, client));
			const registration = nodeRegistrationResultSchema.parse(await session.request(
				LOCAL_BROKER_METHODS.register,
				toJsonValue({
					nodeId: this.nodeId,
					nodeInstanceId: this.nodeInstanceId,
					label: this.label,
					capabilities: [...this.capabilities],
					status: this.status,
					startedAt: this.startedAt,
				}),
			));
			this.windowDelegationPrincipal = registration.delegationPrincipal;
			this.assertCurrent(session);
			this.registered = true;
			await this.claimCurrentWorkspaces(session);
			this.assertCurrent(session);
			this.reconnectAttempt = 0;
			this.transition('online');
			this.scheduleHeartbeat(session);
			this.resolveFirstConnection?.();
			this.resolveFirstConnection = undefined;
			this.rejectFirstConnection = undefined;
		} catch (error) {
			if (this.client === client && this.session !== undefined) {
				this.session.close();
			} else {
				client.dispose();
			}
			this.reportSafeError(
				'The Window Node could not connect to the local Device Broker.',
				localIpcMeshReason(error),
			);
			this.transition('reconnecting');
			if (
				this.executorTransitionOperation === undefined
				&& !this.reconnectBlocked
			) {
				this.scheduleReconnect();
			}
		}
	}

	private async claimCurrentWorkspaces(session: LocalIpcSession): Promise<void> {
		this.assertCurrent(session);
		const entries = await this.readWorkspaceSource();
		const nextIdentities = new Set<string>();
		for (const entry of entries) {
			let resolved;
			try {
				resolved = await this.identityResolver.resolve(entry.localUri);
			} catch {
				throw new MeshDomainError(
					'WORKSPACE_NOT_FOUND',
					'A local workspace could not be resolved safely.',
				);
			}

			this.assertCurrent(session);
			const workspaceIdentity = createOpaqueWorkspaceIdentity(resolved.identity);
			nextIdentities.add(workspaceIdentity);
			const result = workspaceClaimResultSchema.parse(await session.request(
				LOCAL_BROKER_METHODS.claimWorkspace,
				toJsonValue({
					nodeId: this.nodeId,
					nodeInstanceId: this.nodeInstanceId,
					...(this.knownWorkspaceIds.has(workspaceIdentity)
						? { workspaceId: this.knownWorkspaceIds.get(workspaceIdentity)! }
						: {}),
					workspaceIdentity,
					name: entry.name,
					capabilityTags: [...entry.capabilityTags],
				}),
			));
			const workspace: RegisteredLocalWorkspace = {
				workspaceId: result.workspaceId,
				workspaceIdentity,
				displayName: entry.name,
				uri: resolved.canonicalUri,
			};
			this.knownWorkspaceIds.set(workspaceIdentity, result.workspaceId);
			this.observations.set(workspaceIdentity, {
				workspaceIdentity,
				workspaceId: result.workspaceId,
				status: result.status,
				sourceUri: entry.localUri,
				workspace,
			});
			if (result.status === 'claimed' && result.canExecute) {
				this.workspaces.set(result.workspaceId, workspace);
			} else {
				this.workspaces.delete(result.workspaceId);
			}
		}

		const removed = [...this.observations.values()].filter(
			(observation) => !nextIdentities.has(observation.workspaceIdentity),
		);
		for (const observation of removed) {
			nullResultSchema.parse(await session.request(
				LOCAL_BROKER_METHODS.releaseWorkspace,
				toJsonValue({
					nodeId: this.nodeId,
					nodeInstanceId: this.nodeInstanceId,
					workspaceId: observation.workspaceId,
				}),
			));
			this.observations.delete(observation.workspaceIdentity);
			this.workspaces.delete(observation.workspaceId);
		}
		this.changed();
	}

	private delegationPrincipal(
		childContext: DelegatedExecutionContext | undefined,
	): DelegationPrincipal {
		if (childContext !== undefined) {
			return childContext;
		}
		if (this.windowDelegationPrincipal === undefined) {
			throw new MeshDomainError(
				'AUTH_REQUIRED',
				'The Window Node has no authenticated delegation principal.',
			);
		}
		return this.windowDelegationPrincipal;
	}

	private async readWorkspaceSource(): Promise<readonly z.infer<typeof workspaceSourceEntrySchema>[]> {
		let entries: readonly WindowNodeWorkspaceSourceEntry[];
		try {
			entries = typeof this.options.workspaceSource === 'function'
				? await this.options.workspaceSource()
				: await this.options.workspaceSource.list();
			return z.array(workspaceSourceEntrySchema)
				.max(PROTOCOL_LIMITS.workspaceListCount)
				.parse(entries);
		} catch {
			throw new MeshDomainError(
				'WORKSPACE_NOT_FOUND',
				'The current local workspace set could not be read safely.',
			);
		}
	}

	private async handleBrokerRequestSafely(
		method: string,
		params: JsonValue,
		session: LocalIpcSession,
	): Promise<JsonValue> {
		let requestExecutor: WindowNodeExecutor | undefined;
		try {
			if (this.disposed && isDashboardNotification(method)) {
				if (method === LOCAL_BROKER_NOTIFICATIONS.taskSnapshot) {
					taskSnapshotSchema.parse(params);
				} else {
					z.strictObject({}).parse(params);
				}
				return null;
			}
			this.assertCurrent(session);
			if (!this.registered) {
				throw new MeshDomainError('AUTH_REQUIRED', 'Window Node registration is incomplete.');
			}
			const executor = this.executor;
			if (executor === undefined) {
				throw new MeshDomainError(
					'AGENT_UNAVAILABLE',
					'The Window Node executor generation is unavailable.',
				);
			}
			requestExecutor = executor;
			switch (method) {
				case LOCAL_BROKER_NOTIFICATIONS.policyChanged:
					z.strictObject({}).parse(params);
					this.changed();
					return null;
				case LOCAL_BROKER_NOTIFICATIONS.dashboardChanged:
					z.strictObject({}).parse(params);
					this.changed();
					return null;
				case LOCAL_BROKER_NOTIFICATIONS.taskSnapshot: {
					const snapshot = taskSnapshotSchema.parse(params);
					for (const listener of [...this.taskSnapshotListeners]) {
						listener(snapshot);
					}
					return null;
				}
				case LOCAL_BROKER_METHODS.taskStart: {
					const input = nodeTaskStartParamsSchema.parse(params);
					this.assertTaskTarget(input.target.nodeId, input.target.nodeInstanceId);
					if (!this.workspaces.has(input.target.workspaceId)) {
						throw new MeshDomainError(
							'WORKSPACE_NOT_FOUND',
							'The requested workspace is not claimed by this Window Node.',
						);
					}
					return toJsonValue(nodeTaskStartedResultSchema.parse(
						await executor.start(input),
					));
				}
				case LOCAL_BROKER_METHODS.taskCancel: {
					const input = nodeTaskCancelParamsSchema.parse(params);
					this.assertTaskTarget(input.nodeId, input.nodeInstanceId);
					await executor.cancel(input);
					return null;
				}
				case LOCAL_BROKER_METHODS.taskDispose: {
					const input = nodeTaskCancelParamsSchema.parse(params);
					this.assertTaskTarget(input.nodeId, input.nodeInstanceId);
					if (executor.disposeTask === undefined) {
						throw new MeshDomainError(
							'AGENT_UNAVAILABLE',
							'The Window Node executor cannot safely dispose an exact task.',
						);
					}
					await executor.disposeTask(input);
					return null;
				}
				case LOCAL_BROKER_METHODS.taskAnswer: {
					const input = nodeTaskAnswerParamsSchema.parse(params);
					this.assertTaskTarget(input.nodeId, input.nodeInstanceId);
					await executor.answer(input);
					return null;
				}
				default:
					throw new LocalIpcHandlerError(
						JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
						'Local RPC method not found.',
					);
			}
		} catch (error: unknown) {
			if (
				method === LOCAL_BROKER_METHODS.taskStart
				&& isClosedTaskStartGeneration(requestExecutor, error)
			) {
				const mapped = toWindowNodeHandlerError(error);
				throw new LocalIpcHandlerError(
					mapped.code,
					mapped.message,
					mapped.data,
					true,
				);
			}
			throw toWindowNodeHandlerError(error);
		}
	}

	private handleDisconnect(session: LocalIpcSession, client: LocalIpcClient): void {
		if (this.session !== session || this.client !== client) {
			return;
		}
		const executor = this.executor;
		this.executor = undefined;
		this.removeCloseListener?.();
		this.removeCloseListener = undefined;
		this.heartbeatTimer?.dispose();
		this.heartbeatTimer = undefined;
		this.registered = false;
		this.windowDelegationPrincipal = undefined;
		this.session = undefined;
		this.client = undefined;
		this.observations.clear();
		this.workspaces.clear();
		client.dispose();
		if (!this.disposed) {
			this.reportSafeError('The local Device Broker connection closed.');
			this.transition('reconnecting');
		}
		this.beginExecutorTransition(executor);
	}

	private beginExecutorTransition(executor: WindowNodeExecutor | undefined): void {
		if (this.executorTransitionOperation !== undefined) {
			this.blockReconnect(
				'Overlapping Window Node executor cleanup was prevented.',
				true,
			);
			return;
		}
		if (executor !== undefined) {
			this.retiredExecutors.add(executor);
			this.transitioningExecutor = executor;
		}
		let operation: Promise<void>;
		try {
			operation = executor?.dispose() ?? Promise.resolve();
		} catch {
			operation = Promise.reject(new Error('Window Node executor cleanup failed.'));
		}
		this.executorTransitionOperation = operation;
		void operation.then(
			() => {
				if (this.executorTransitionOperation === operation) {
					this.executorTransitionOperation = undefined;
				}
				if (this.disposed) {
					if (this.transitioningExecutor === executor) {
						this.transitioningExecutor = undefined;
						this.executorTransitionFailure = undefined;
					}
					return;
				}
				if (this.transitioningExecutor === executor) {
					this.transitioningExecutor = undefined;
					this.executorTransitionFailure = undefined;
				}
				if (this.executorFactory === undefined) {
					this.blockReconnect(
						'The Window Node cannot reconnect after disposing its one-shot executor.',
						false,
					);
					return;
				}
				this.scheduleReconnect();
			},
			(error: unknown) => {
				if (this.executorTransitionOperation === operation) {
					this.executorTransitionOperation = undefined;
				}
				if (
					error instanceof WindowNodeTaskExecutorDisposalError
					&& error.cleanupComplete
				) {
					if (this.transitioningExecutor === executor) {
						this.transitioningExecutor = undefined;
						this.executorTransitionFailure = undefined;
					}
					this.reportSafeError(
						'The disconnected Window Node task failed, but its executor was cleaned up safely.',
					);
					if (this.disposed) {
						return;
					}
					if (this.executorFactory === undefined) {
						this.blockReconnect(
							'The Window Node cannot reconnect after disposing its one-shot executor.',
							false,
						);
						return;
					}
					this.scheduleReconnect();
					return;
				}
				this.executorTransitionFailure = error;
				this.blockReconnect(
					'The disconnected Window Node executor could not be cleaned up; Broker reclaim is blocked.',
					false,
				);
			},
		);
	}

	private createExecutor(): WindowNodeExecutor {
		const factory = this.executorFactory;
		if (factory === undefined) {
			throw new Error('A Window Node executor factory is unavailable.');
		}
		const executor = factory({
			workspaceResolver: this,
			eventSink: this.eventSink,
		});
		if (this.retiredExecutors.has(executor)) {
			throw new Error('The Window Node executor factory reused a retired generation.');
		}
		return executor;
	}

	private blockReconnect(message: string, cleanupFailed: boolean): void {
		this.reconnectBlocked = true;
		this.reconnectTimer?.dispose();
		this.reconnectTimer = undefined;
		if (cleanupFailed) {
			this.lifecycleFailures.push(new Error(message));
		}
		if (this.rejectFirstConnection !== undefined) {
			this.rejectFirstConnection(new Error(message));
			this.resolveFirstConnection = undefined;
			this.rejectFirstConnection = undefined;
		}
		this.reportSafeError(message);
	}

	private scheduleHeartbeat(session: LocalIpcSession): void {
		this.heartbeatTimer?.dispose();
		this.heartbeatTimer = this.scheduler.schedule(() => {
			this.heartbeatTimer = undefined;
			void this.sendHeartbeat(session);
		}, this.options.heartbeatIntervalMs ?? 10_000);
	}

	private async sendHeartbeat(session: LocalIpcSession): Promise<void> {
		if (this.disposed || this.session !== session || !this.registered) {
			return;
		}
		try {
			const descriptor = await session.request(
				LOCAL_BROKER_METHODS.heartbeat,
				toJsonValue({
					nodeId: this.nodeId,
					nodeInstanceId: this.nodeInstanceId,
					status: this.status,
					at: this.now().toISOString(),
				}),
			);
			windowNodeDescriptorSchema.parse(descriptor);
			this.scheduleHeartbeat(session);
		} catch {
			session.close();
		}
	}

	private scheduleReconnect(): void {
		if (
			this.disposed
			|| this.reconnectBlocked
			|| this.executorTransitionOperation !== undefined
			|| this.reconnectTimer !== undefined
		) {
			return;
		}
		const delay = this.reconnectDelay(this.reconnectAttempt);
		this.reconnectAttempt += 1;
		this.reconnectTimer = this.scheduler.schedule(() => {
			this.reconnectTimer = undefined;
			this.connectNow();
		}, delay);
	}

	private reconnectDelay(attempt: number): number {
		const initial = this.options.backoff?.initialDelayMs ?? 100;
		const maximum = this.options.backoff?.maxDelayMs ?? 5_000;
		const multiplier = this.options.backoff?.multiplier ?? 2;
		const jitter = this.options.backoff?.jitterRatio ?? 0.2;
		const random = this.options.backoff?.random ?? Math.random;
		const base = Math.min(maximum, initial * multiplier ** Math.min(attempt, 32));
		const sample = random();
		const boundedSample = Number.isFinite(sample)
			? Math.max(0, Math.min(1, sample))
			: 0.5;
		const factor = 1 + ((boundedSample * 2) - 1) * jitter;
		return Math.max(0, Math.min(maximum, Math.round(base * factor)));
	}

	private request<T>(
		method: string,
		params: JsonValue,
		schema: z.ZodType<T>,
	): Promise<T> {
		const session = this.requireConnected();
		return session.request(method, params).then((result) => schema.parse(result));
	}

	private requireConnected(): LocalIpcSession {
		if (
			this.disposed
			|| !this.registered
			|| this.session === undefined
			|| this.session.closed
		) {
			throw new MeshDomainError('AGENT_UNAVAILABLE', 'The local Device Broker is unavailable.');
		}
		return this.session;
	}

	private assertCurrent(session: LocalIpcSession): void {
		if (
			this.disposed
			|| this.session !== session
			|| session.closed
		) {
			throw new MeshDomainError('AGENT_UNAVAILABLE', 'The Window Node route is stale.');
		}
	}

	private assertTaskTarget(nodeId: string, nodeInstanceId: string): void {
		if (nodeId !== this.nodeId || nodeInstanceId !== this.nodeInstanceId) {
			throw new MeshDomainError('AGENT_UNAVAILABLE', 'The Window Node route is stale.');
		}
	}

	private validateTimingOptions(): void {
		const values = [
			this.options.heartbeatIntervalMs ?? 10_000,
			this.options.backoff?.initialDelayMs ?? 100,
			this.options.backoff?.maxDelayMs ?? 5_000,
		];
		if (values.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > 600_000)) {
			throw new TypeError('Window Node timer intervals must be bounded positive integers.');
		}
		const multiplier = this.options.backoff?.multiplier ?? 2;
		const jitter = this.options.backoff?.jitterRatio ?? 0.2;
		if (
			!Number.isFinite(multiplier)
			|| multiplier < 1
			|| multiplier > 16
			|| !Number.isFinite(jitter)
			|| jitter < 0
			|| jitter > 1
		) {
			throw new TypeError('Window Node reconnect backoff is invalid.');
		}
	}

	private reportSafeError(message: string, code?: MeshErrorReason): void {
		try {
			this.options.onError?.(Object.assign(
				new Error(message),
				code === undefined ? {} : { code },
			));
		} catch {
			process.emitWarning('A Window Node error listener failed.', {
				code: 'WINDOW_NODE_ERROR_LISTENER_FAILED',
			});
		}
	}

	private transition(state: WindowNodeClientState): void {
		if (this.stateValue === state) {
			return;
		}
		this.stateValue = state;
		this.changed();
	}

	private changed(): void {
		for (const listener of this.stateListeners) {
			try {
				listener();
			} catch {
				process.emitWarning('A Window Node status listener failed.', {
					code: 'WINDOW_NODE_STATUS_LISTENER_FAILED',
				});
			}
		}
	}

	private async disposeOnce(): Promise<void> {
		this.disposed = true;
		this.transition('disposed');
		this.reconnectTimer?.dispose();
		this.reconnectTimer = undefined;
		this.heartbeatTimer?.dispose();
		this.heartbeatTimer = undefined;

		const failures: unknown[] = [];
		const session = this.session;
		if (session !== undefined && !session.closed && this.registered) {
			for (const observation of this.observations.values()) {
				try {
					nullResultSchema.parse(await session.request(
						LOCAL_BROKER_METHODS.releaseWorkspace,
						toJsonValue({
							nodeId: this.nodeId,
							nodeInstanceId: this.nodeInstanceId,
							workspaceId: observation.workspaceId,
						}),
					));
				} catch (error: unknown) {
					failures.push(error);
				}
			}
			try {
				nullResultSchema.parse(await session.request(
					LOCAL_BROKER_METHODS.unregister,
					toJsonValue({
						nodeId: this.nodeId,
						nodeInstanceId: this.nodeInstanceId,
					}),
				));
			} catch (error: unknown) {
				failures.push(error);
			}
		}

		this.registered = false;
		this.windowDelegationPrincipal = undefined;
		this.removeCloseListener?.();
		this.removeCloseListener = undefined;
		this.session = undefined;
		this.client?.dispose();
		this.client = undefined;
		if (this.connectionOperation !== undefined) {
			await this.connectionOperation;
		}
		const transition = this.executorTransitionOperation;
		if (transition !== undefined) {
			try {
				await transition;
			} catch (error: unknown) {
				if (!isCleanupCompleteExecutorError(error)) {
					failures.push(error);
				}
			}
		}
		this.observations.clear();
		this.workspaces.clear();
		const executor = this.executor;
		if (executor !== undefined) {
			try {
				await executor.dispose();
				if (this.executor === executor) {
					this.executor = undefined;
				}
			} catch (error: unknown) {
				if (
					error instanceof WindowNodeTaskExecutorDisposalError
					&& error.cleanupComplete
				) {
					this.reportSafeError(
						'The Window Node task failed, but its executor was cleaned up safely.',
					);
					if (this.executor === executor) {
						this.executor = undefined;
					}
				} else {
					failures.push(error);
				}
			}
		}
		if (transition === undefined && this.transitioningExecutor !== undefined) {
			const retired = this.transitioningExecutor;
			try {
				await retired.dispose();
				if (this.transitioningExecutor === retired) {
					this.transitioningExecutor = undefined;
					this.executorTransitionFailure = undefined;
				}
			} catch (error: unknown) {
				failures.push(error);
				this.executorTransitionFailure = error;
			}
		}
		if (
			this.executorTransitionFailure !== undefined
			&& !failures.includes(this.executorTransitionFailure)
		) {
			failures.push(this.executorTransitionFailure);
		}
		failures.push(...this.lifecycleFailures);
		if (this.rejectFirstConnection !== undefined) {
			this.rejectFirstConnection(new Error('Window Node client was disposed before connecting.'));
			this.resolveFirstConnection = undefined;
			this.rejectFirstConnection = undefined;
		}
		this.stateListeners.clear();
		this.taskSnapshotListeners.clear();
		if (failures.length > 0) {
			throw new AggregateError(failures, 'Window Node client cleanup failed.');
		}
	}
}

function localIpcMeshReason(error: unknown): MeshErrorReason | undefined {
	if (
		!(error instanceof LocalIpcRemoteError)
		|| typeof error.data !== 'object'
		|| error.data === null
		|| Array.isArray(error.data)
		|| !('reason' in error.data)
		|| typeof error.data.reason !== 'string'
		|| !Object.hasOwn(MESH_ERROR_CODES, error.data.reason)
	) {
		return undefined;
	}
	return error.data.reason as MeshErrorReason;
}

export function toWindowNodeHandlerError(error: unknown): LocalIpcHandlerError {
	if (error instanceof LocalIpcHandlerError) {
		return error;
	}
	if (error instanceof MeshDomainError) {
		return new LocalIpcHandlerError(
			error.code,
			'The Window Node request could not be completed.',
			{ reason: error.reason, retryable: error.retryable },
		);
	}
	const runtimeError = findAgentRuntimeError(error);
	if (runtimeError !== undefined) {
		const reason = agentRuntimeMeshReason(runtimeError.code);
		return new LocalIpcHandlerError(
			MESH_ERROR_CODES[reason],
			'The Window Node Agent runtime request could not be completed.',
			{ reason, retryable: runtimeError.retryable },
		);
	}
	if (error instanceof z.ZodError || error instanceof TypeError) {
		return new LocalIpcHandlerError(
			JSON_RPC_ERROR_CODES.INVALID_PARAMS,
			'Invalid Window Node RPC parameters.',
		);
	}

	function agentRuntimeMeshReason(code: AgentRuntimeError['code']): MeshErrorReason {
		switch (code) {
			case 'AGENT_UNAVAILABLE':
			case 'AGENT_AUTH_REQUIRED':
			case 'TASK_EXECUTION_FAILED':
			case 'TASK_RECOVERY_UNAVAILABLE':
			case 'TASK_CANCELLATION_UNCONFIRMED':
				return code;
			case 'AGENT_AUTH_FAILED':
				return 'AUTH_FAILED';
			case 'AGENT_CONFIG_REQUIRED':
				return 'TASK_EXECUTION_FAILED';
		}
	}
	return new LocalIpcHandlerError(
		JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
		'The Window Node request failed safely.',
		process.env.MESH_MULTI_WINDOW_E2E === '1'
			? { diagnostic: safeErrorKind(error) }
			: undefined,
	);
}

function policyWorkspaceSelection(
	observation: WorkspaceObservation,
): PeerPolicyWorkspaceSelection {
	if (observation.status !== 'claimed') {
		return {
			kind: 'unavailable',
			workspaceName: observation.workspace.displayName,
			claimStatus: observation.status,
		};
	}
	return {
		kind: 'selected',
		workspaceIdentity: observation.workspaceIdentity,
		workspaceId: observation.workspaceId,
		workspaceName: observation.workspace.displayName,
		claimStatus: 'claimed',
	};
}

function safeErrorKind(error: unknown): string {
	if (error instanceof AggregateError) {
		return `AggregateError(${error.errors.map(safeErrorKind).join(',')})`;
	}
	if (error instanceof Error) {
		const code = 'code' in error && typeof error.code === 'string'
			? `:${error.code}`
			: '';
		return `${error.name}${code}`.slice(0, 256);
	}
	return typeof error;
}

function findAgentRuntimeError(
	value: unknown,
): { readonly code: AgentRuntimeError['code']; readonly retryable: boolean } | undefined {
	if (value instanceof AgentRuntimeError) {
		return value;
	}
	if (value instanceof AggregateError) {
		for (const nested of value.errors) {
			const candidate = findAgentRuntimeError(nested);
			if (candidate !== undefined) {
				return candidate;
			}
		}
	}
	if (
		typeof value === 'object'
		&& value !== null
		&& 'code' in value
		&& typeof value.code === 'string'
		&& [
			'AGENT_UNAVAILABLE',
			'AGENT_AUTH_REQUIRED',
			'AGENT_AUTH_FAILED',
			'AGENT_CONFIG_REQUIRED',
			'TASK_EXECUTION_FAILED',
			'TASK_RECOVERY_UNAVAILABLE',
			'TASK_CANCELLATION_UNCONFIRMED',
		].includes(value.code)
	) {
		return {
			code: value.code as AgentRuntimeError['code'],
			retryable: 'retryable' in value && value.retryable === true,
		};
	}
	return undefined;
}

function isClosedTaskStartGeneration(
	executor: WindowNodeExecutor | undefined,
	error: unknown,
): boolean {
	if (
		executor?.generationClosed === true
		|| error instanceof WindowNodeTaskExecutorDisposalError
		|| (error instanceof MeshDomainError && error.reason === 'WORKER_DRAINING')
	) {
		return true;
	}
	return error instanceof AggregateError
		&& error.errors.some((nested) => isClosedTaskStartGeneration(executor, nested));
}

function isCleanupCompleteExecutorError(error: unknown): boolean {
	return error instanceof WindowNodeTaskExecutorDisposalError && error.cleanupComplete;
}

function toJsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isDashboardNotification(method: string): boolean {
	return method === LOCAL_BROKER_NOTIFICATIONS.policyChanged
		|| method === LOCAL_BROKER_NOTIFICATIONS.taskSnapshot
		|| method === LOCAL_BROKER_NOTIFICATIONS.dashboardChanged;
}
