import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

import {
	nodeTaskAnswerParamsSchema,
	nodeTaskCancelParamsSchema,
	nodeTaskStartParamsSchema,
	type NodeTaskAnswerParams,
	type NodeTaskCancelParams,
	type NodeTaskEventParams,
	type NodeTaskStartedResult,
	type NodeTaskStartParams,
} from '../../shared/protocol';
import { AgentRuntimeError, type AgentRuntimeProbe, type WorkspaceResolver } from '../agentHost/AgentRuntime';
import { MeshDomainError } from '../domain/errors';
import type { WindowNodeExecutor, WindowNodeWorkspaceSourceEntry } from '../node/WindowNodeClient';
import {
	WindowNodeTaskExecutorDisposalError,
	type WindowNodeTaskEventSink,
} from '../node/WindowNodeTaskExecutor';
import { registerSensitiveValues, type SensitiveValueRegistration } from '../security/SensitiveValueRedaction';
import type { ResolvedFileIdentity } from '../workspaces/WorkspaceRegistry';
import {
	REMOTE_EXECUTION_CLIENT_EXTENSION_ID,
	REMOTE_EXECUTION_COMMANDS,
	bridgeError,
	parseRemoteValue,
	remoteBoundWorkspaceSchema,
	remoteDeadline,
	remoteDelay,
	remoteExecutionBudgets,
	remoteExecutionCallSchema,
	remoteExecutionConnectedSchema,
	remoteExecutionConnectSchema,
	remoteExecutionEnvelopeSchema,
	remoteExecutionException,
	remoteExecutionFailure,
	remoteExecutionIdentitySchema,
	remoteExecutionResultSchemas,
	remoteExecutionTiming,
	remoteFileUriSchema,
	remoteFingerprint,
	type RemoteBoundWorkspace,
	type RemoteExecutionAuthorization,
	type RemoteExecutionBudgets,
	type RemoteExecutionConnected,
	type RemoteExecutionIdentity,
	type RemoteExecutionOperation,
	type RemoteExecutionTiming,
} from './RemoteExecutionProtocol';

export interface RemoteExecutionClientOptions {
	readonly identity: RemoteExecutionIdentity;
	readonly extensionVersion: string;
	invoke(command: string, input: unknown): Promise<unknown>;
	readonly workspaceResolver: WorkspaceResolver;
	readonly eventSink: WindowNodeTaskEventSink;
	onDisconnect(error: Error): void | Promise<void>;
	readonly reportError?: (error: Error) => void;
	readonly reportFailure?: (diagnostic: RemoteExecutionFailureDiagnostic) => void;
	readonly budgets?: Partial<RemoteExecutionBudgets>;
	readonly timing?: Partial<RemoteExecutionTiming>;
}

export interface RemoteExecutionFailureDiagnostic {
	readonly operation: RemoteExecutionOperation['kind'] | 'brokerEventAck';
	readonly budgetMs: number;
	readonly elapsedMs: number;
}

type InvocationLane = 'normal' | 'control' | 'events' | 'heartbeat' | 'connect';
type MutationResult = NodeTaskStartedResult | null;
interface MutationRecord {
	readonly fingerprint: string;
	readonly requestId: string;
	operation?: Promise<MutationResult>;
	succeeded: boolean;
	result?: MutationResult;
}

interface TaskAdmission {
	readonly fingerprint: string;
	readonly operation: Promise<NodeTaskStartedResult>;
	readonly validationAbort: AbortController;
	readonly deliveryAbort: AbortController;
	forwarded: boolean;
	settled: boolean;
	disposed: boolean;
	stopIntent?: 'cancel' | 'dispose';
	stopOperation?: Promise<void>;
}

export class RemoteExecutionClient implements WindowNodeExecutor {
	private readonly identity: RemoteExecutionIdentity;
	private readonly budgets: RemoteExecutionBudgets;
	private readonly timing: RemoteExecutionTiming;
	private readonly lifetime = new AbortController();
	private readonly redaction: SensitiveValueRegistration;
	private readonly mutations = new Map<string, MutationRecord>();
	private readonly tasks = new Map<string, TaskAdmission>();
	private readonly inFlight: Record<InvocationLane, number> = {
		normal: 0, control: 0, events: 0, heartbeat: 0, connect: 0,
	};
	private readonly pendingConnects = new Set<Promise<RemoteExecutionConnected>>();
	private readonly cleanups = new Map<string, Promise<void>>();
	private helper: RemoteExecutionConnected | undefined;
	private connecting: Promise<void> | undefined;
	private stopped = false;
	private acknowledgedSeq = 0;
	private eventPump: Promise<void> | undefined;
	private heartbeatPump: Promise<void> | undefined;
	private notification: Promise<void> | undefined;
	private notificationFailure: Error | undefined;
	private generationFailure: Error | undefined;
	private disposal: Promise<void> | undefined;
	private resolving = 0;
	private normalMutations = 0;

	public constructor(private readonly options: RemoteExecutionClientOptions) {
		this.budgets = remoteExecutionBudgets(options.budgets);
		this.timing = remoteExecutionTiming(options.timing);
		this.identity = parseRemoteValue(remoteExecutionIdentitySchema, options.identity, this.budgets.maxConnectBytes);
		remoteExecutionConnectSchema.shape.extensionVersion.parse(options.extensionVersion);
		this.redaction = registerSensitiveValues([this.identity.token]);
	}

	public get generationClosed(): boolean {
		return this.stopped;
	}

	public connect(): Promise<void> {
		if (this.stopped) {
			return Promise.reject(bridgeError('TASK_RECOVERY_UNAVAILABLE'));
		}
		if (this.helper !== undefined) {
			return Promise.resolve();
		}
		if (this.connecting !== undefined) {
			return this.connecting;
		}
		const connection = this.connectCore().finally(() => {
			if (this.connecting === connection) {
				this.connecting = undefined;
			}
		});
		this.connecting = connection;
		return connection;
	}

	public async listWorkspaces(): Promise<readonly WindowNodeWorkspaceSourceEntry[]> {
		const result = await this.request({ kind: 'describe' }, remoteExecutionResultSchemas.describe);
		return result.workspaces.map((workspace) => ({
			localUri: workspace.sourceUri, name: workspace.name, capabilityTags: [...workspace.capabilityTags],
		}));
	}

	public async resolveIdentity(uri: string): Promise<ResolvedFileIdentity> {
		return this.request({
			kind: 'resolve', uri: parseRemoteValue(remoteFileUriSchema, uri, this.budgets.maxRequestBytes),
		}, remoteExecutionResultSchemas.resolve);
	}

	public probe(): Promise<AgentRuntimeProbe> {
		return this.request({ kind: 'probe' }, remoteExecutionResultSchemas.probe);
	}

	public async start(input: NodeTaskStartParams): Promise<NodeTaskStartedResult> {
		const params = parseRemoteValue(nodeTaskStartParamsSchema, input, this.budgets.maxRequestBytes);
		this.assertTarget(params.target.nodeId, params.target.nodeInstanceId);
		if (params.executionBackend !== 'codespace-owned' || params.requireEditor === true
			|| params.delegatedExecutionContext.taskId !== params.taskId) {
			throw bridgeError('AUTH_FAILED');
		}
		if (this.stopped) {
			throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
		}
		const fingerprint = remoteFingerprint(params);
		const previous = this.tasks.get(params.taskId);
		if (previous !== undefined) {
			if (previous.fingerprint !== fingerprint) {
				throw bridgeError('TASK_ID_CONFLICT');
			}
			return previous.operation;
		}
		if (this.tasks.size >= this.budgets.maxTasks || this.normalMutations >= this.budgets.maxRequests) {
			throw bridgeError('RATE_LIMITED');
		}
		let admission!: TaskAdmission;
		const operation = Promise.resolve().then(() => this.startTask(params, admission));
		admission = {
			fingerprint, operation,
			validationAbort: new AbortController(),
			deliveryAbort: new AbortController(),
			forwarded: false, settled: false, disposed: false,
		};
		this.tasks.set(params.taskId, admission);
		return operation;
	}

	public async answer(input: NodeTaskAnswerParams): Promise<void> {
		const params = parseRemoteValue(nodeTaskAnswerParamsSchema, input, this.budgets.maxRequestBytes);
		const admission = this.assertTask(params);
		if (!admission.forwarded || admission.disposed) {
			throw bridgeError('INPUT_NOT_PENDING');
		}
		await this.mutation(`answer:${params.taskId}:${params.answerId}`,
			{ kind: 'answer', params }, remoteExecutionResultSchemas.answer);
	}

	public async cancel(input: NodeTaskCancelParams): Promise<void> {
		const params = parseRemoteValue(nodeTaskCancelParamsSchema, input, this.budgets.maxRequestBytes);
		const admission = this.assertTask(params);
		if (admission.disposed || (!admission.forwarded && admission.settled && admission.stopIntent === undefined)) {
			throw bridgeError('TASK_NOT_CANCELLABLE');
		}
		if (!admission.forwarded) {
			return this.stopLocalAdmission(admission, params, 'cancel');
		}
		admission.stopIntent ??= 'cancel';
		await this.mutation(`cancel:${params.taskId}`,
			{ kind: 'cancel', params }, remoteExecutionResultSchemas.cancel);
	}

	public async disposeTask(input: NodeTaskCancelParams): Promise<void> {
		const params = parseRemoteValue(nodeTaskCancelParamsSchema, input, this.budgets.maxRequestBytes);
		const admission = this.assertTask(params);
		admission.disposed = true;
		admission.deliveryAbort.abort();
		if (!admission.forwarded) {
			return this.stopLocalAdmission(admission, params, 'dispose');
		}
		admission.stopIntent ??= 'dispose';
		await this.mutation(`disposeTask:${params.taskId}`,
			{ kind: 'disposeTask', params }, remoteExecutionResultSchemas.disposeTask);
	}

	public dispose(): Promise<void> {
		if (this.disposal !== undefined) {
			return this.disposal;
		}
		const pending = [...this.pendingConnects];
		this.stop();
		const operation = (async () => {
			const cleanupOperations = [
				...(this.helper === undefined ? [] : [this.disconnectHelper(this.helper)]),
				...pending.map((connection) => connection.then((helper) => this.disconnectHelper(helper))),
			];
			const settled = await remoteDeadline(Promise.allSettled([
				...cleanupOperations,
				this.eventPump,
				this.heartbeatPump,
				this.notification,
			]), this.budgets.cleanupTimeoutMs, this.timing, undefined, bridgeError('TASK_CANCELLATION_UNCONFIRMED'));
			const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : []);
			if (failures.some((error) => !cleanupConfirmed(error))) {
				throw cleanupUnconfirmed();
			}
			this.redaction.dispose();
			const diagnostics = [
				...failures,
				...(this.generationFailure === undefined ? [] : [this.generationFailure]),
				...(this.notificationFailure === undefined ? [] : [this.notificationFailure]),
			];
			if (diagnostics.length > 0) {
				throw new WindowNodeTaskExecutorDisposalError(diagnostics, true);
			}
		})();
		const disposal = operation.catch((error: unknown) => {
			this.report(error);
			throw cleanupConfirmed(error) ? error : cleanupUnconfirmed();
		}).finally(() => {
			if (this.disposal === disposal) {
				this.disposal = undefined;
			}
		});
		this.disposal = disposal;
		return disposal;
	}

	private async startTask(params: NodeTaskStartParams, admission: TaskAdmission): Promise<NodeTaskStartedResult> {
		const signal = AbortSignal.any([this.lifetime.signal, admission.validationAbort.signal]);
		try {
			this.assertAdmission(admission);
			await remoteDeadline(this.connect(), this.budgets.connectTimeoutMs, this.timing, signal);
			this.assertAdmission(admission);
			const workspace = await this.resolveWorkspace(params.target.workspaceId, signal);
			this.assertAdmission(admission);
			const result = await this.mutation(`start:${params.taskId}`, {
				kind: 'start', params, workspace,
			}, remoteExecutionResultSchemas.start, this.budgets.startTimeoutMs, admission);
			if (result === null || result.taskId !== params.taskId
				|| result.nodeId !== this.identity.nodeId || result.nodeInstanceId !== this.identity.nodeInstanceId) {
				const error = bridgeError('TASK_RECOVERY_UNAVAILABLE');
				this.fail(error);
				throw error;
			}
			return result;
		} catch (error: unknown) {
			if (!admission.forwarded && admission.stopIntent !== undefined) {
				// The Broker must accept the local cancellation before it observes the rejected start.
				await admission.stopOperation;
				throw bridgeError('TASK_EXECUTION_FAILED');
			}
			throw error;
		} finally {
			admission.settled = true;
		}
	}

	private stopLocalAdmission(
		admission: TaskAdmission,
		params: NodeTaskCancelParams,
		intent: 'cancel' | 'dispose',
	): Promise<void> {
		admission.stopIntent ??= intent;
		if (admission.stopOperation === undefined) {
			admission.stopOperation = Promise.resolve().then(async () => {
				if (admission.stopIntent === 'cancel' && !admission.disposed) {
					await this.deliverEvent(admission, {
						...params,
						at: new Date().toISOString(),
						event: { type: 'cancelled', summary: 'Cancelled before remote execution was dispatched.' },
					});
				}
			}).catch((error: unknown) => {
				this.fail(error);
				throw safeException(error);
			});
		}
		admission.validationAbort.abort(bridgeError('TASK_EXECUTION_FAILED'));
		return admission.stopOperation;
	}

	private assertAdmission(admission: TaskAdmission): void {
		if (this.stopped) {
			throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
		}
		if (admission.stopIntent !== undefined || admission.disposed) {
			throw bridgeError('TASK_EXECUTION_FAILED');
		}
	}

	private async connectCore(): Promise<void> {
		const input = parseRemoteValue(remoteExecutionConnectSchema, {
			...this.identity,
			extensionId: REMOTE_EXECUTION_CLIENT_EXTENSION_ID,
			extensionVersion: this.options.extensionVersion,
		}, this.budgets.maxConnectBytes);
		const raw = this.invoke(REMOTE_EXECUTION_COMMANDS.connect, input, 'connect');
		const connection = raw.then((value) => {
			const reply = parseRemoteValue(remoteExecutionEnvelopeSchema(remoteExecutionConnectedSchema),
				value, this.budgets.maxResponseBytes);
			if (!reply.ok) {
				throw remoteExecutionException(reply.error);
			}
			this.validateHandshake(reply.result);
			return reply.result;
		}, (error: unknown) => {
			this.report(error);
			throw bridgeError('AGENT_UNAVAILABLE', true);
		});
		this.pendingConnects.add(connection);
		void connection.then((helper) => {
			this.pendingConnects.delete(connection);
			if (this.stopped) {
				void this.disconnectHelper(helper).catch((error: unknown) => this.report(error));
			}
		}, () => { this.pendingConnects.delete(connection); });
		const helper = await remoteDeadline(connection, this.budgets.connectTimeoutMs, this.timing,
			this.lifetime.signal, bridgeError('AGENT_UNAVAILABLE', true));
		if (this.stopped) {
			throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
		}
		this.helper = helper;
		this.eventPump = this.pumpEvents().catch((error: unknown) => this.fail(error));
		this.heartbeatPump = this.pumpHeartbeats().catch((error: unknown) => this.fail(error));
	}

	private validateHandshake(helper: RemoteExecutionConnected): void {
		if (helper.extensionVersion !== this.options.extensionVersion
			|| helper.clientId !== this.identity.clientId || helper.nodeId !== this.identity.nodeId
			|| helper.nodeInstanceId !== this.identity.nodeInstanceId || helper.authority !== this.identity.authority
			|| helper.workspaces.length !== this.identity.expectedFolders.length
			|| helper.workspaces.some((workspace) => !this.identity.expectedFolders.includes(workspace.sourceUri))) {
			throw bridgeError('PROTOCOL_INCOMPATIBLE');
		}
		if (this.helper !== undefined && this.helper.helperInstanceId !== helper.helperInstanceId) {
			throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
		}
	}

	private async resolveWorkspace(workspaceId: string, signal: AbortSignal): Promise<RemoteBoundWorkspace> {
		if (this.resolving >= this.budgets.maxInFlight) {
			throw bridgeError('RATE_LIMITED', true);
		}
		this.resolving += 1;
		const operation = Promise.resolve().then(() => this.options.workspaceResolver.resolve(workspaceId));
		void operation.then(
			() => { this.resolving -= 1; },
			() => { this.resolving -= 1; },
		);
		try {
			const workspace = await remoteDeadline(operation, this.budgets.callTimeoutMs, this.timing,
				signal, bridgeError('WORKSPACE_NOT_FOUND', true));
			if (workspace === undefined || workspace.workspaceId !== workspaceId) {
				throw bridgeError('WORKSPACE_NOT_FOUND');
			}
			return parseRemoteValue(remoteBoundWorkspaceSchema, workspace, this.budgets.maxRequestBytes);
		} catch (error: unknown) {
			if (!signal.aborted) {
				this.report(error);
			}
			throw safeException(error);
		}
	}

	private mutation(
		key: string,
		operation: RemoteExecutionOperation,
		schema: z.ZodType<MutationResult>,
		timeoutMs = this.budgets.callTimeoutMs,
		admission?: TaskAdmission,
	): Promise<MutationResult> {
		this.assertConnected();
		const fingerprint = remoteFingerprint(operation);
		let record = this.mutations.get(key);
		if (record !== undefined && record.fingerprint !== fingerprint) {
			throw bridgeError(operation.kind === 'start' ? 'TASK_ID_CONFLICT' : 'IDEMPOTENCY_CONFLICT');
		}
		if (record === undefined) {
			if (operation.kind !== 'cancel' && operation.kind !== 'disposeTask') {
				if (this.normalMutations >= this.budgets.maxRequests) {
					throw bridgeError('RATE_LIMITED');
				}
				this.normalMutations += 1;
			}
			record = { fingerprint, requestId: randomUUID(), succeeded: false };
			this.mutations.set(key, record);
		}
		if (record.succeeded) {
			return Promise.resolve(record.result!);
		}
		if (record.operation !== undefined) {
			return record.operation;
		}
		const current = record;
		const pending = this.request(operation, schema, timeoutMs, current.requestId, admission).then((result) => {
			current.result = result;
			current.succeeded = true;
			return result;
		}).finally(() => {
			if (current.operation === pending) {
				current.operation = undefined;
			}
		});
		current.operation = pending;
		return pending;
	}

	private async request<T>(
		operation: RemoteExecutionOperation,
		schema: z.ZodType<T>,
		timeoutMs = this.budgets.callTimeoutMs,
		requestId: string = randomUUID(),
		admission?: TaskAdmission,
	): Promise<T> {
		await this.connect();
		const startedAt = this.timing.now();
		const helper = this.assertConnected();
		const input = parseRemoteValue(remoteExecutionCallSchema, {
			...this.authorization(helper), requestId, operation,
		}, this.budgets.maxRequestBytes);
		const lane: InvocationLane = operation.kind === 'events' ? 'events'
			: operation.kind === 'heartbeat' ? 'heartbeat'
				: operation.kind === 'cancel' || operation.kind === 'disposeTask' ? 'control' : 'normal';
		// Admission errors are ordinary explicit backpressure, not evidence of a lost generation.
		const raw = this.invoke(REMOTE_EXECUTION_COMMANDS.call, input, lane, admission === undefined ? undefined : () => {
			this.assertAdmission(admission);
			admission.forwarded = true;
		});
		let reply;
		try {
			reply = parseRemoteValue(remoteExecutionEnvelopeSchema(schema),
				await remoteDeadline(raw, timeoutMs, this.timing, this.lifetime.signal), this.budgets.maxResponseBytes);
			this.assertConnected();
		} catch (error: unknown) {
			this.reportFailure(operation.kind, timeoutMs, startedAt);
			this.report(error);
			const failure = bridgeError('TASK_RECOVERY_UNAVAILABLE');
			this.fail(failure);
			throw failure;
		}
		if (!reply.ok) {
			const error = remoteExecutionException(reply.error);
			if (reply.error.code === 'AUTH_FAILED' || reply.error.code === 'PROTOCOL_INCOMPATIBLE'
				|| reply.error.code === 'TASK_RECOVERY_UNAVAILABLE' || reply.error.code === 'WORKER_DRAINING') {
				this.fail(error);
			}
			throw error;
		}
		return reply.result;
	}

	private async pumpEvents(): Promise<void> {
		while (!this.stopped) {
			const helper = this.assertConnected();
			const acknowledgedSeq = this.acknowledgedSeq;
			const waitMs = Math.min(this.budgets.pollWaitMs, helper.pollWaitMs);
			const result = await this.request(
				{ kind: 'events', acknowledgedSeq, waitMs },
				remoteExecutionResultSchemas.events,
				Math.min(waitMs + this.budgets.callTimeoutMs, 2_147_483_647),
			);
			if (result.acknowledgedSeq !== acknowledgedSeq) {
				throw bridgeError('PROTOCOL_INCOMPATIBLE');
			}
			for (const entry of result.events) {
				this.assertConnected();
				const admission = this.tasks.get(entry.event.taskId);
				if (entry.seq !== this.acknowledgedSeq + 1 || admission === undefined) {
					throw bridgeError('PROTOCOL_INCOMPATIBLE');
				}
				this.assertTarget(entry.event.nodeId, entry.event.nodeInstanceId);
				await this.deliverEvent(admission, entry.event);
				this.assertConnected();
				this.acknowledgedSeq = entry.seq;
			}
			if (result.events.length === 0) {
				await remoteDelay(this.budgets.idlePollDelayMs, this.timing, this.lifetime.signal);
			}
		}
	}

	private async deliverEvent(admission: TaskAdmission, event: NodeTaskEventParams): Promise<void> {
		if (admission.disposed) {
			return;
		}
		const startedAt = this.timing.now();
		try {
			await remoteDeadline(Promise.resolve().then(() => {
				if (!admission.disposed) {
					return this.options.eventSink.publish(event);
				}
			}), this.budgets.eventDeliveryTimeoutMs, this.timing,
			AbortSignal.any([this.lifetime.signal, admission.deliveryAbort.signal]));
		} catch (error: unknown) {
			// Explicit disposal revokes this exact delivery route; draining its in-flight frames is cleanup.
			if (!admission.disposed) {
				this.reportFailure('brokerEventAck', this.budgets.eventDeliveryTimeoutMs, startedAt);
				throw error;
			}
		}
	}

	private async pumpHeartbeats(): Promise<void> {
		const helper = this.assertConnected();
		const interval = Math.max(1, Math.min(this.budgets.heartbeatIntervalMs, Math.floor(helper.leaseMs / 3)));
		while (!this.stopped) {
			await remoteDelay(interval, this.timing, this.lifetime.signal);
			if (this.stopped) {
				return;
			}
			const result = await this.request({ kind: 'heartbeat' }, remoteExecutionResultSchemas.heartbeat);
			if (result.helperInstanceId !== helper.helperInstanceId) {
				throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
			}
		}
	}

	private invoke(command: string, input: unknown, lane: InvocationLane, beforeDispatch?: () => void): Promise<unknown> {
		const maximum = lane === 'events' || lane === 'heartbeat' ? 1
			: lane === 'control' ? this.budgets.maxControlInFlight
				: lane === 'connect' ? this.budgets.maxStateOperations : this.budgets.maxInFlight;
		if (this.inFlight[lane] >= maximum) {
			throw bridgeError('RATE_LIMITED', true);
		}
		beforeDispatch?.();
		this.inFlight[lane] += 1;
		let operation: Promise<unknown>;
		try {
			operation = Promise.resolve(this.options.invoke(command, input));
		} catch (error: unknown) {
			operation = Promise.reject(error);
		}
		void operation.then(
			() => { this.inFlight[lane] -= 1; },
			(error: unknown) => {
				this.inFlight[lane] -= 1;
				if (this.stopped) {
					this.report(error);
				}
			},
		);
		return operation;
	}

	private authorization(helper: RemoteExecutionConnected): RemoteExecutionAuthorization {
		return {
			version: this.identity.version, clientId: this.identity.clientId,
			helperInstanceId: helper.helperInstanceId, token: this.identity.token,
		};
	}

	private assertConnected(): RemoteExecutionConnected {
		if (this.stopped || this.helper === undefined) {
			throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
		}
		return this.helper;
	}

	private assertTarget(nodeId: string, nodeInstanceId: string): void {
		if (nodeId !== this.identity.nodeId || nodeInstanceId !== this.identity.nodeInstanceId) {
			throw bridgeError('AUTH_FAILED');
		}
	}

	private assertTask(params: NodeTaskCancelParams): TaskAdmission {
		if (this.stopped) {
			throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
		}
		this.assertTarget(params.nodeId, params.nodeInstanceId);
		const admission = this.tasks.get(params.taskId);
		if (admission === undefined) {
			throw bridgeError('TASK_NOT_FOUND');
		}
		return admission;
	}

	private stop(): void {
		if (!this.stopped) {
			this.stopped = true;
			this.lifetime.abort();
		}
	}

	private fail(error: unknown): void {
		if (this.stopped) {
			return;
		}
		this.stop();
		const failure = disconnectDiagnostic(error);
		this.generationFailure = failure;
		this.report(error);
		this.notification = remoteDeadline(
			Promise.resolve().then(() => this.options.onDisconnect(failure)),
			this.budgets.callTimeoutMs, this.timing,
		).catch((notificationError: unknown) => {
			this.notificationFailure = safeException(notificationError);
			this.report(notificationError);
		});
		if (this.helper !== undefined) {
			void this.disconnectHelper(this.helper).catch((cleanupError: unknown) => this.report(cleanupError));
		}
	}

	private disconnectHelper(helper: RemoteExecutionConnected): Promise<void> {
		const previous = this.cleanups.get(helper.helperInstanceId);
		if (previous !== undefined) {
			return previous;
		}
		const operation = (async () => {
			const reply = parseRemoteValue(remoteExecutionEnvelopeSchema(remoteExecutionResultSchemas.disposeTask),
				await remoteDeadline(
					this.invoke(REMOTE_EXECUTION_COMMANDS.disconnect, this.authorization(helper), 'control'),
					this.budgets.cleanupTimeoutMs, this.timing, undefined, bridgeError('TASK_CANCELLATION_UNCONFIRMED'),
				), this.budgets.maxResponseBytes);
			if (!reply.ok) {
				const error = remoteExecutionException(reply.error);
				throw reply.error.cleanupComplete === true
					? new WindowNodeTaskExecutorDisposalError([error], true)
					: error;
			}
		})().catch((error: unknown) => {
			this.report(error);
			throw cleanupConfirmed(error) ? error : cleanupUnconfirmed();
		});
		this.cleanups.set(helper.helperInstanceId, operation);
		void operation.catch((error: unknown) => {
			if (!cleanupConfirmed(error) && this.cleanups.get(helper.helperInstanceId) === operation) {
				this.cleanups.delete(helper.helperInstanceId);
			}
		});
		return operation;
	}

	private report(error: unknown): void {
		try {
			this.options.reportError?.(error instanceof Error ? error : bridgeError('TASK_EXECUTION_FAILED'));
		} catch {
			// Reporting must not prevent capability revocation or leak an asynchronous rejection.
		}
	}

	private reportFailure(operation: RemoteExecutionFailureDiagnostic['operation'], budgetMs: number, startedAt: number): void {
		try {
			this.options.reportFailure?.({
				operation, budgetMs, elapsedMs: Math.max(0, this.timing.now() - startedAt),
			});
		} catch {
			// Diagnostics cannot change transport cleanup or capability revocation.
		}
	}
}

function safeException(error: unknown): Error {
	return remoteExecutionException(remoteExecutionFailure(error).error);
}

function cleanupConfirmed(error: unknown): error is WindowNodeTaskExecutorDisposalError {
	return error instanceof WindowNodeTaskExecutorDisposalError && error.cleanupComplete;
}

function cleanupUnconfirmed(): AgentRuntimeError {
	return new AgentRuntimeError(
		'TASK_CANCELLATION_UNCONFIRMED',
		'Codespaces cleanup could not be confirmed. Reconnect the Codespace and retry cleanup; do not resubmit tasks with uncertain outcomes.',
		true,
	);
}

function disconnectDiagnostic(error: unknown): Error {
	const safe = safeException(error);
	const message = 'The Codespaces execution generation is unavailable. Check companion setup and reconnect the Codespace; do not resubmit tasks with uncertain outcomes.';
	return safe instanceof AgentRuntimeError
		? new AgentRuntimeError(safe.code, message, safe.retryable)
		: safe instanceof MeshDomainError
			? new MeshDomainError(safe.reason, message, safe.retryable)
			: new AgentRuntimeError('TASK_RECOVERY_UNAVAILABLE', message);
}
