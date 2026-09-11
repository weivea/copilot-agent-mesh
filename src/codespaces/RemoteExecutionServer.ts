import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
	nodeTaskEventParamsSchema,
	type NodeTaskEventParams,
	type NodeTaskStartedResult,
	type NodeTaskStartParams,
} from '../../shared/protocol';
import type { AgentRuntimeProbe, WorkspaceResolver } from '../agentHost/AgentRuntime';
import { assertDelegationGrantBinding } from '../node/DelegationGrant';
import type { WindowNodeExecutor } from '../node/WindowNodeClient';
import {
	WindowNodeTaskExecutorDisposalError,
	type WindowNodeTaskEventSink,
} from '../node/WindowNodeTaskExecutor';
import {
	registerSensitiveValues,
	type SensitiveValueRegistration,
} from '../security/SensitiveValueRedaction';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';
import {
	REMOTE_EXECUTION_HELPER_EXTENSION_ID,
	REMOTE_EXECUTION_PROTOCOL_VERSION,
	bridgeError,
	parseRemoteValue,
	remoteDeadline,
	remoteExecutionBudgets,
	remoteExecutionCallSchema,
	remoteExecutionConnectedSchema,
	remoteExecutionConnectSchema,
	remoteExecutionDisconnectSchema,
	remoteExecutionException,
	remoteExecutionFailure,
	remoteExecutionResultSchemas,
	remoteExecutionTiming,
	remoteFingerprint,
	remoteValueBytes,
	remoteWorkspacesSchema,
	type RemoteBoundWorkspace,
	type RemoteExecutionAuthorization,
	type RemoteExecutionBudgets,
	type RemoteExecutionCall,
	type RemoteExecutionConnect,
	type RemoteExecutionConnected,
	type RemoteExecutionEnvelope,
	type RemoteExecutionEvent,
	type RemoteExecutionEvents,
	type RemoteExecutionOperation,
	type RemoteExecutionResult,
	type RemoteExecutionTimer,
	type RemoteExecutionTiming,
	type RemoteWorkspaceDescriptor,
} from './RemoteExecutionProtocol';

export interface RemoteExecutionExecutorContext {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly nodeLabel: string;
	readonly helperInstanceId: string;
	readonly workspaceResolver: WorkspaceResolver;
	readonly eventSink: WindowNodeTaskEventSink;
}
export interface RemoteExecutionExecutor {
	readonly executor: WindowNodeExecutor;
	probe(): Promise<AgentRuntimeProbe>;
}
export interface RemoteExecutionServerOptions {
	readonly extensionVersion: string;
	assertAllowed(): void | Promise<void>;
	readWorkspaces(authority: string): Promise<readonly RemoteWorkspaceDescriptor[]>;
	createExecutor(context: RemoteExecutionExecutorContext): RemoteExecutionExecutor | Promise<RemoteExecutionExecutor>;
	reportError(error: Error): void;
	readonly budgets?: Partial<RemoteExecutionBudgets>;
	readonly timing?: Partial<RemoteExecutionTiming>;
}

interface RequestRecord {
	readonly fingerprint: string;
	readonly operation: Promise<RemoteExecutionEnvelope<RemoteExecutionResult>>;
}
interface WorkspaceBinding {
	readonly workspace: RemoteBoundWorkspace;
	readonly sourceUri: string;
	readonly fileIdentity: string;
}
interface TaskBinding {
	readonly fingerprint: string;
	readonly scope: string;
	readonly workspaceId: string;
	readonly validationAbort: AbortController;
	dispatched: boolean;
	disposed: boolean;
	stopIntent?: 'cancel' | 'dispose';
	stopOperation?: Promise<void>;
	state: 'starting' | 'running' | 'completed' | 'cancelled' | 'failed';
	result?: NodeTaskStartedResult;
}
interface QueuedEvent {
	readonly value: RemoteExecutionEvent;
	readonly bytes: number;
	readonly publication: PendingEvent;
}
interface PendingEvent {
	readonly event: NodeTaskEventParams;
	readonly bytes: number;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	settled: boolean;
	timer?: RemoteExecutionTimer;
}
interface GenerationIdentity {
	readonly clientId: string;
	readonly helperInstanceId: string;
	readonly tokenHash: Buffer;
	readonly fingerprint: string;
}
interface Generation extends GenerationIdentity {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly nodeLabel: string;
	readonly authority: string;
	readonly expectedFolders: readonly string[];
	readonly abort: AbortController;
	readonly redaction: SensitiveValueRegistration;
	readonly requests: Map<string, RequestRecord>;
	readonly semanticRequests: Map<string, RequestRecord>;
	readonly controlRequestCounts: Map<string, number>;
	readonly workspaces: Map<string, WorkspaceBinding>;
	readonly tasks: Map<string, TaskBinding>;
	readonly events: QueuedEvent[];
	readonly pendingEvents: PendingEvent[];
	factory: Promise<RemoteExecutionExecutor>;
	binding?: RemoteExecutionExecutor;
	state: 'connecting' | 'active' | 'closing' | 'closed';
	established: boolean;
	expiresAt: number;
	leaseTimer?: RemoteExecutionTimer;
	cleanup?: Promise<void>;
	pollWake?: () => void;
	normalInFlight: number;
	normalRequestCount: number;
	controlInFlight: number;
	heartbeatInFlight: number;
	pollInFlight: number;
	queuedBytes: number;
	pendingBytes: number;
	acknowledgedSeq: number;
	deliveredSeq: number;
	nextSeq: number;
}

export class RemoteExecutionServer {
	private readonly budgets: RemoteExecutionBudgets;
	private readonly timing: RemoteExecutionTiming;
	private readonly generations = new Map<string, GenerationIdentity>();
	private current: Generation | undefined;
	private stateTail: Promise<void> = Promise.resolve();
	private stateOperations = 0;
	private disposed = false;
	private shutdown: Promise<void> | undefined;
	private disposal: Promise<void> | undefined;
	private workspaceReads = 0;

	public constructor(private readonly options: RemoteExecutionServerOptions) {
		this.budgets = remoteExecutionBudgets(options.budgets);
		this.timing = remoteExecutionTiming(options.timing);
		remoteExecutionConnectSchema.shape.extensionVersion.parse(options.extensionVersion);
	}

	public connect(input: unknown): Promise<RemoteExecutionEnvelope<RemoteExecutionConnected>> {
		return this.protect(async () => {
			const params = parseRemoteValue(remoteExecutionConnectSchema, input, this.budgets.maxConnectBytes);
			if (params.extensionVersion !== this.options.extensionVersion) {
				throw bridgeError('PROTOCOL_INCOMPATIBLE');
			}
			const attempt = { abort: new AbortController(), generation: undefined as Generation | undefined };
			const operation = this.serializeState(() => this.connectCore(params, attempt));
			const observed = this.result(() => operation);
			try {
				return await remoteDeadline(observed, this.budgets.connectTimeoutMs, this.timing);
			} catch (error: unknown) {
				attempt.abort.abort();
				if (attempt.generation !== undefined) {
					this.retire(attempt.generation);
				}
				throw error;
			}
		});
	}

	public call(input: unknown): Promise<RemoteExecutionEnvelope<RemoteExecutionResult>> {
		return this.protect(async () => {
			const params = parseRemoteValue(remoteExecutionCallSchema, input, this.budgets.maxRequestBytes);
			const generation = this.authenticate(params);
			const release = this.reserveCall(generation, params.operation.kind);
			// Keep the admission slot until the underlying work settles, not just its response timeout.
			let operation: Promise<RemoteExecutionEnvelope<RemoteExecutionResult>>;
			try {
				operation = (isMutation(params.operation)
					? this.mutation(generation, params)
					: this.result(() => this.execute(generation, params.operation))).finally(release);
			} catch (error: unknown) {
				release();
				throw error;
			}
			const timeout = params.operation.kind === 'start' ? this.budgets.startTimeoutMs
				: params.operation.kind === 'events'
					? Math.min(params.operation.waitMs, this.budgets.pollWaitMs) + this.budgets.callTimeoutMs
					: this.budgets.callTimeoutMs;
			return remoteDeadline(operation, Math.min(timeout, 2_147_483_647), this.timing, generation.abort.signal);
		});
	}

	public disconnect(input: unknown): Promise<RemoteExecutionEnvelope<null>> {
		return this.protect(async () => {
			const params = parseRemoteValue(remoteExecutionDisconnectSchema, input, this.budgets.maxConnectBytes);
			const generation = this.current;
			if (generation === undefined || !sameAuthorization(generation, params)) {
				const previous = this.generations.get(params.clientId);
				if (previous !== undefined && sameAuthorization(previous, params)
					&& previous.helperInstanceId !== generation?.helperInstanceId) {
					return { ok: true, result: null };
				}
				throw bridgeError('AUTH_FAILED');
			}
			// Revocation must precede both cleanup and the serialized transition queue.
			this.invalidate(generation);
			const cleanup = this.close(generation);
			void cleanup.catch((error: unknown) => this.report(error));
			const operation = this.serializeState(async () => {
				await cleanup;
				return null;
			});
			try {
				const reply = await remoteDeadline(this.result(() => operation), this.budgets.cleanupTimeoutMs, this.timing,
					undefined, bridgeError('TASK_CANCELLATION_UNCONFIRMED'));
				return !reply.ok && generation.state === 'closed'
					? { ...reply, error: { ...reply.error, cleanupComplete: true } }
					: reply;
			} catch (error: unknown) {
				if (generation.state === 'closed') {
					this.report(error);
					return remoteExecutionFailure(error, true);
				}
				throw error;
			}
		});
	}

	public dispose(): Promise<void> {
		if (this.disposal !== undefined) {
			return this.disposal;
		}
		this.disposed = true;
		const generation = this.current;
		if (generation !== undefined) {
			this.invalidate(generation);
		}
		if (this.shutdown === undefined) {
			const cleanup = generation === undefined ? Promise.resolve() : this.close(generation);
			const shutdown = Promise.allSettled([this.stateTail, cleanup]).then((results) => {
				const failures = results.filter((result) => result.status === 'rejected');
				if (failures.length > 0) {
					throw new AggregateError(failures.map((result) => result.reason), 'Codespaces cleanup failed.');
				}
			});
			this.shutdown = shutdown;
			void shutdown.catch(() => {
				if (this.shutdown === shutdown) {
					this.shutdown = undefined;
				}
			});
		}
		const operation = remoteDeadline(this.shutdown, this.budgets.cleanupTimeoutMs, this.timing,
			undefined, bridgeError('TASK_CANCELLATION_UNCONFIRMED')).catch((error: unknown) => {
			this.report(error);
			throw bridgeError('TASK_CANCELLATION_UNCONFIRMED');
		});
		const disposal = operation.finally(() => {
			if (this.disposal === disposal) {
				this.disposal = undefined;
			}
		});
		this.disposal = disposal;
		return disposal;
	}

	private async connectCore(
		params: RemoteExecutionConnect,
		attempt: { readonly abort: AbortController; generation: Generation | undefined },
	): Promise<RemoteExecutionConnected> {
		this.assertConnectActive(attempt.abort.signal);
		await this.options.assertAllowed();
		this.assertConnectActive(attempt.abort.signal);
		const fingerprint = remoteFingerprint({ ...params, expectedFolders: [...params.expectedFolders].sort() });
		const previous = this.generations.get(params.clientId);
		if (previous !== undefined && !timingSafeEqual(previous.tokenHash, tokenHash(params.token))) {
			throw bridgeError('AUTH_FAILED');
		}
		if (previous !== undefined && previous.fingerprint !== fingerprint) {
			throw bridgeError('IDEMPOTENCY_CONFLICT');
		}
		if (previous !== undefined && (this.current?.helperInstanceId !== previous.helperInstanceId
			|| this.current.state !== 'active')) {
			throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
		}
		const workspaces = await this.readWorkspaces(params.authority, params.expectedFolders);
		this.assertConnectActive(attempt.abort.signal);
		if (previous !== undefined) {
			const current = this.current;
			if (current === undefined || current.helperInstanceId !== previous.helperInstanceId) {
				throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
			}
			this.assertLive(current);
			this.renewLease(current);
			return this.handshake(current, workspaces);
		}
		if (this.generations.size >= this.budgets.maxGenerations) {
			throw bridgeError('RATE_LIMITED');
		}
		if (this.current !== undefined) {
			await this.close(this.current);
			this.assertConnectActive(attempt.abort.signal);
		}
		const generation: Generation = {
			clientId: params.clientId,
			helperInstanceId: randomUUID(),
			tokenHash: tokenHash(params.token),
			fingerprint,
			nodeId: params.nodeId,
			nodeInstanceId: params.nodeInstanceId,
			nodeLabel: params.nodeLabel,
			authority: params.authority,
			expectedFolders: [...params.expectedFolders],
			abort: new AbortController(),
			redaction: registerSensitiveValues([params.token]),
			requests: new Map(),
			semanticRequests: new Map(),
			controlRequestCounts: new Map(),
			workspaces: new Map(),
			tasks: new Map(),
			events: [],
			pendingEvents: [],
			factory: undefined as unknown as Promise<RemoteExecutionExecutor>,
			state: 'connecting',
			established: false,
			expiresAt: 0,
			normalInFlight: 0,
			normalRequestCount: 0,
			controlInFlight: 0,
			heartbeatInFlight: 0,
			pollInFlight: 0,
			queuedBytes: 0,
			pendingBytes: 0,
			acknowledgedSeq: 0,
			deliveredSeq: 0,
			nextSeq: 1,
		};
		this.current = generation;
		attempt.generation = generation;
		generation.factory = Promise.resolve().then(() => this.options.createExecutor({
			nodeId: generation.nodeId,
			nodeInstanceId: generation.nodeInstanceId,
			nodeLabel: generation.nodeLabel,
			helperInstanceId: generation.helperInstanceId,
			workspaceResolver: { resolve: (workspaceId) => this.resolveBoundWorkspace(generation, workspaceId) },
			eventSink: { publish: (event) => this.publish(generation, event) },
		}));
		try {
			generation.binding = await generation.factory;
			this.assertConnectActive(attempt.abort.signal);
			if (generation.binding === undefined || generation.binding.executor === undefined
				|| typeof generation.binding.probe !== 'function'
				|| typeof generation.binding.executor.start !== 'function'
				|| typeof generation.binding.executor.answer !== 'function'
				|| typeof generation.binding.executor.cancel !== 'function'
				|| typeof generation.binding.executor.dispose !== 'function'
				|| generation.binding.executor.generationClosed === true) {
				throw bridgeError('AGENT_UNAVAILABLE');
			}
			if (generation.state !== 'connecting') {
				throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
			}
			generation.state = 'active';
			const reply = this.handshake(generation, workspaces);
			generation.established = true;
			this.generations.set(generation.clientId, {
				clientId: generation.clientId,
				helperInstanceId: generation.helperInstanceId,
				tokenHash: generation.tokenHash,
				fingerprint,
			});
			this.renewLease(generation);
			return reply;
		} catch (error: unknown) {
			this.retire(generation);
			throw error;
		}
	}

	private handshake(generation: Generation, workspaces: readonly RemoteWorkspaceDescriptor[]): RemoteExecutionConnected {
		return parseRemoteValue(remoteExecutionConnectedSchema, {
			version: REMOTE_EXECUTION_PROTOCOL_VERSION,
			extensionId: REMOTE_EXECUTION_HELPER_EXTENSION_ID,
			extensionVersion: this.options.extensionVersion,
			clientId: generation.clientId,
			nodeId: generation.nodeId,
			nodeInstanceId: generation.nodeInstanceId,
			helperInstanceId: generation.helperInstanceId,
			authority: generation.authority,
			workspaces,
			leaseMs: this.budgets.leaseMs,
			pollWaitMs: this.budgets.pollWaitMs,
		}, this.budgets.maxResponseBytes - 32);
	}

	private mutation(generation: Generation, params: RemoteExecutionCall):
		Promise<RemoteExecutionEnvelope<RemoteExecutionResult>> {
		const fingerprint = remoteFingerprint(params.operation);
		const previous = generation.requests.get(params.requestId);
		if (previous !== undefined) {
			if (previous.fingerprint !== fingerprint) {
				throw bridgeError('IDEMPOTENCY_CONFLICT');
			}
			return previous.operation;
		}
		const key = mutationIdentity(params.operation);
		const sameMutation = generation.semanticRequests.get(key);
		if (sameMutation !== undefined && sameMutation.fingerprint !== fingerprint) {
			throw bridgeError(params.operation.kind === 'start' ? 'TASK_ID_CONFLICT' : 'IDEMPOTENCY_CONFLICT');
		}
		let stopping: TaskBinding | undefined;
		if (params.operation.kind === 'cancel' || params.operation.kind === 'disposeTask') {
			this.assertTarget(generation, params.operation.params.nodeId, params.operation.params.nodeInstanceId);
			const task = generation.tasks.get(params.operation.params.taskId);
			if (task === undefined) {
				throw bridgeError('TASK_NOT_FOUND');
			}
			const count = generation.controlRequestCounts.get(key) ?? 0;
			if (count >= this.budgets.maxControlInFlight) {
				throw bridgeError('RATE_LIMITED');
			}
			// Each admitted task has its own bounded cancel/dispose reserve, even when the normal cache is full.
			generation.controlRequestCounts.set(key, count + 1);
			if (params.operation.kind === 'cancel' && (task.disposed
				|| (!task.dispatched && task.state === 'failed' && task.stopIntent === undefined))) {
				throw bridgeError('TASK_NOT_CANCELLABLE');
			}
			task.stopIntent ??= params.operation.kind === 'cancel' ? 'cancel' : 'dispose';
			if (params.operation.kind === 'disposeTask') {
				task.disposed = true;
				this.retireTaskPublications(generation, params.operation.params.taskId);
			}
			if (!task.dispatched) {
				stopping = task;
			}
		} else {
			if (generation.normalRequestCount >= this.budgets.maxRequests) {
				throw bridgeError('RATE_LIMITED');
			}
			generation.normalRequestCount += 1;
		}
		if (params.operation.kind === 'start') {
			this.admitStart(generation, params.operation);
		}
		const record = sameMutation ?? {
			fingerprint,
			operation: this.result(() => Promise.resolve().then(() => this.execute(generation, params.operation))),
		};
		generation.requests.set(params.requestId, record);
		generation.semanticRequests.set(key, record);
		if (stopping !== undefined) {
			stopping.stopOperation ??= record.operation.then((reply) => {
				if (!reply.ok) {
					throw remoteExecutionException(reply.error);
				}
			});
			void stopping.stopOperation.catch(() => undefined);
			stopping.validationAbort.abort(bridgeError('TASK_EXECUTION_FAILED'));
		}
		return record.operation;
	}

	private async execute(generation: Generation, operation: RemoteExecutionOperation): Promise<RemoteExecutionResult> {
		this.assertLive(generation);
		if (operation.kind !== 'start') {
			await this.assertAllowed(generation);
		}
		const binding = generation.binding;
		if (binding === undefined) {
			throw bridgeError('AGENT_UNAVAILABLE');
		}
		let value: RemoteExecutionResult;
		switch (operation.kind) {
			case 'describe':
				value = { workspaces: [...await this.currentWorkspaces(generation)].map((workspace) => ({
					...workspace, capabilityTags: [...workspace.capabilityTags],
				})) };
				break;
			case 'resolve': {
				const current = await this.currentWorkspaces(generation);
				const workspace = current.find((entry) => entry.sourceUri === operation.uri || entry.canonicalUri === operation.uri);
				if (workspace === undefined) {
					throw bridgeError('WORKSPACE_NOT_FOUND');
				}
				value = { canonicalUri: workspace.canonicalUri, identity: workspace.fileIdentity };
				break;
			}
			case 'probe': {
				const probe = await binding.probe();
				value = parseRemoteValue(remoteExecutionResultSchemas.probe, {
					...probe,
					...(probe.degradation === undefined ? {} : {
						degradation: { ...probe.degradation, message: 'The Codespaces execution request could not be completed.' },
					}),
				}, this.budgets.maxResponseBytes - 32);
				break;
			}
			case 'start':
				value = await this.start(generation, operation);
				break;
			case 'answer':
			case 'cancel':
			case 'disposeTask': {
				this.assertTarget(generation, operation.params.nodeId, operation.params.nodeInstanceId);
				const task = generation.tasks.get(operation.params.taskId);
				if (task === undefined) {
					throw bridgeError('TASK_NOT_FOUND');
				}
				if (operation.kind === 'answer') {
					if (!task.dispatched || task.disposed) {
						throw bridgeError('INPUT_NOT_PENDING');
					}
					await binding.executor.answer(operation.params);
				} else if (operation.kind === 'cancel') {
					if (task.disposed) {
						throw bridgeError('TASK_NOT_CANCELLABLE');
					}
					if (task.dispatched) {
						await binding.executor.cancel(operation.params);
					} else {
						await this.publish(generation, {
							...operation.params,
							at: new Date().toISOString(),
							event: { type: 'cancelled', summary: 'Cancelled before the executor was dispatched.' },
						});
					}
				} else {
					if (task.dispatched) {
						if (binding.executor.disposeTask === undefined) {
							throw bridgeError('AGENT_UNAVAILABLE');
						}
						await binding.executor.disposeTask(operation.params);
					}
				}
				value = null;
				break;
			}
			case 'events':
				value = await this.events(generation, operation.acknowledgedSeq, operation.waitMs);
				break;
			case 'heartbeat':
				this.renewLease(generation);
				value = { helperInstanceId: generation.helperInstanceId };
				break;
		}
		this.assertLive(generation);
		return parseRemoteValue<RemoteExecutionResult>(
			remoteExecutionResultSchemas[operation.kind], value, this.budgets.maxResponseBytes - 32,
		);
	}

	private admitStart(
		generation: Generation,
		operation: Extract<RemoteExecutionOperation, { kind: 'start' }>,
	): TaskBinding {
		const { params, workspace } = operation;
		this.assertTarget(generation, params.target.nodeId, params.target.nodeInstanceId);
		if (params.executionBackend !== 'codespace-owned' || params.requireEditor === true
			|| workspace.workspaceId !== params.target.workspaceId
			|| params.delegatedExecutionContext.taskId !== params.taskId) {
			throw bridgeError('AUTH_FAILED');
		}
		try {
			assertDelegationGrantBinding(params, workspace);
		} catch (error: unknown) {
			this.report(error);
			throw bridgeError('AUTH_FAILED');
		}
		const fingerprint = remoteFingerprint(operation);
		const previous = generation.tasks.get(params.taskId);
		if (previous !== undefined) {
			if (previous.fingerprint !== fingerprint) {
				throw bridgeError('TASK_ID_CONFLICT');
			}
			return previous;
		}
		if (generation.tasks.size >= this.budgets.maxTasks) {
			throw bridgeError('RATE_LIMITED');
		}
		const admission: TaskBinding = {
			fingerprint,
			scope: taskScope(params, workspace.workspaceIdentity),
			workspaceId: workspace.workspaceId,
			validationAbort: new AbortController(),
			dispatched: false, disposed: false, state: 'starting',
		};
		generation.tasks.set(params.taskId, admission);
		return admission;
	}

	private async start(
		generation: Generation,
		operation: Extract<RemoteExecutionOperation, { kind: 'start' }>,
	): Promise<NodeTaskStartedResult> {
		const record = generation.tasks.get(operation.params.taskId);
		if (record === undefined) {
			throw bridgeError('TASK_NOT_FOUND');
		}
		try {
			return await this.startAdmitted(generation, operation, record);
		} catch (error: unknown) {
			if (!record.dispatched && record.stopIntent !== undefined) {
				// Cancellation publication, not validation completion, orders the rejected start.
				await record.stopOperation;
				throw bridgeError('TASK_EXECUTION_FAILED');
			}
			if (record.state === 'starting') {
				record.state = 'failed';
			}
			throw error;
		}
	}

	private async startAdmitted(
		generation: Generation,
		operation: Extract<RemoteExecutionOperation, { kind: 'start' }>,
		record: TaskBinding,
	): Promise<NodeTaskStartedResult> {
		const { params, workspace } = operation;
		const signal = AbortSignal.any([generation.abort.signal, record.validationAbort.signal]);
		this.assertAdmission(generation, record);
		await remoteDeadline(this.assertAllowed(generation), this.budgets.callTimeoutMs, this.timing, signal);
		this.assertAdmission(generation, record);
		const descriptions = await remoteDeadline(this.currentWorkspaces(generation), this.budgets.callTimeoutMs,
			this.timing, signal, bridgeError('WORKSPACE_NOT_FOUND', true));
		this.assertAdmission(generation, record);
		const descriptor = descriptions.find((entry) => entry.canonicalUri === workspace.uri
			&& createOpaqueWorkspaceIdentity(entry.fileIdentity) === workspace.workspaceIdentity);
		if (descriptor === undefined) {
			throw bridgeError('WORKSPACE_NOT_FOUND');
		}
		const bound = { ...workspace, displayName: descriptor.name };
		try {
			assertDelegationGrantBinding(params, bound);
		} catch (error: unknown) {
			this.report(error);
			throw bridgeError('AUTH_FAILED');
		}
		const approval = params.remoteTaskApproval;
		if (approval !== undefined && (params.sourceNodeId !== undefined
			|| approval.peerId !== params.authenticatedOwnerId || approval.taskId !== params.taskId
			|| approval.workspaceIdentity !== bound.workspaceIdentity)) {
			throw bridgeError('AUTH_FAILED');
		}
		const scope = taskScope(params, workspace.workspaceIdentity);
		if (params.continueFromTaskId !== undefined) {
			const previous = generation.tasks.get(params.continueFromTaskId);
			if (previous === undefined || previous.state !== 'completed' || previous.scope !== scope
				|| previous.result?.recoveryDescriptor?.sessionId !== params.continuation?.sessionUri
				|| previous.result?.recoveryDescriptor?.conversationId !== params.continuation?.chatUri) {
				throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
			}
		}
		const existingWorkspace = generation.workspaces.get(workspace.workspaceId);
		if (existingWorkspace !== undefined && (existingWorkspace.sourceUri !== descriptor.sourceUri
			|| existingWorkspace.fileIdentity !== descriptor.fileIdentity
			|| existingWorkspace.workspace.uri !== descriptor.canonicalUri)) {
			throw bridgeError('WORKSPACE_NOT_FOUND');
		}
		this.assertAdmission(generation, record);
		generation.workspaces.set(workspace.workspaceId, {
			workspace: bound, sourceUri: descriptor.sourceUri, fileIdentity: descriptor.fileIdentity,
		});
		record.dispatched = true;
		const result = parseRemoteValue(remoteExecutionResultSchemas.start,
			await generation.binding!.executor.start(params), this.budgets.maxResponseBytes - 32);
		this.assertLive(generation);
		if (result.taskId !== params.taskId || result.nodeId !== generation.nodeId
			|| result.nodeInstanceId !== generation.nodeInstanceId
			|| (params.continuation !== undefined && (
				result.recoveryDescriptor?.sessionId !== params.continuation.sessionUri
				|| result.recoveryDescriptor.conversationId !== params.continuation.chatUri
			))) {
			this.retire(generation);
			throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
		}
		record.result = result;
		if (record.state === 'starting') {
			record.state = 'running';
		}
		return result;
	}

	private assertAdmission(generation: Generation, record: TaskBinding): void {
		this.assertLive(generation);
		if (record.stopIntent !== undefined || record.disposed) {
			throw bridgeError('TASK_EXECUTION_FAILED');
		}
	}

	private async resolveBoundWorkspace(generation: Generation, workspaceId: string): Promise<RemoteBoundWorkspace | undefined> {
		await this.assertAllowed(generation);
		const bound = generation.workspaces.get(workspaceId);
		if (bound === undefined) {
			return undefined;
		}
		const current = await this.currentWorkspaces(generation);
		const descriptor = current.find((entry) => entry.sourceUri === bound.sourceUri
			&& entry.canonicalUri === bound.workspace.uri && entry.fileIdentity === bound.fileIdentity
			&& createOpaqueWorkspaceIdentity(entry.fileIdentity) === bound.workspace.workspaceIdentity);
		if (descriptor === undefined) {
			throw bridgeError('WORKSPACE_NOT_FOUND');
		}
		return { ...bound.workspace, displayName: descriptor.name };
	}

	private async currentWorkspaces(generation: Generation): Promise<readonly RemoteWorkspaceDescriptor[]> {
		const workspaces = await this.readWorkspaces(generation.authority, generation.expectedFolders);
		this.assertLive(generation);
		return workspaces;
	}

	private async readWorkspaces(authority: string, expectedFolders: readonly string[]): Promise<readonly RemoteWorkspaceDescriptor[]> {
		if (this.workspaceReads >= this.budgets.maxInFlight) {
			throw bridgeError('RATE_LIMITED', true);
		}
		this.workspaceReads += 1;
		let workspaces: ReturnType<typeof remoteWorkspacesSchema.parse>;
		try {
			workspaces = parseRemoteValue(remoteWorkspacesSchema,
				await this.options.readWorkspaces(authority), this.budgets.maxResponseBytes - 32);
		} finally {
			this.workspaceReads -= 1;
		}
		if (workspaces.length !== expectedFolders.length
			|| workspaces.some((workspace) => !expectedFolders.includes(workspace.sourceUri))) {
			throw bridgeError('WORKSPACE_NOT_FOUND');
		}
		return workspaces;
	}

	private async publish(generation: Generation, input: NodeTaskEventParams): Promise<void> {
		try {
			this.assertLive(generation);
			const event = parseRemoteValue(nodeTaskEventParamsSchema, input, this.budgets.maxRequestBytes);
			this.assertTarget(generation, event.nodeId, event.nodeInstanceId);
			const task = generation.tasks.get(event.taskId);
			if (task === undefined) {
				throw bridgeError('TASK_NOT_FOUND');
			}
			if (task.disposed) {
				return;
			}
			const bytes = remoteValueBytes({ seq: Number.MAX_SAFE_INTEGER, event });
			if (bytes > Math.min(this.budgets.maxQueuedEventBytes, this.budgets.maxEventBatchBytes)) {
				throw bridgeError('RATE_LIMITED');
			}
			const fits = generation.pendingEvents.length === 0 && this.eventFits(generation, bytes);
			if (!fits && (generation.pendingEvents.length >= this.budgets.maxPendingEvents
					|| generation.pendingBytes + bytes > this.budgets.maxPendingEventBytes)) {
				throw bridgeError('RATE_LIMITED');
			}
			if (event.event.type === 'completed' || event.event.type === 'cancelled' || event.event.type === 'failed') {
				task.state = event.event.type;
			}
			await new Promise<void>((resolve, reject) => {
				const pending: PendingEvent = { event, bytes, resolve, reject, settled: false };
				if (fits) {
					this.enqueueEvent(generation, pending);
				} else {
					generation.pendingEvents.push(pending);
					generation.pendingBytes += bytes;
					pending.timer = this.timing.schedule(() => {
						this.report(bridgeError('RATE_LIMITED'));
						this.retire(generation);
					}, this.budgets.eventBackpressureTimeoutMs);
				}
			});
		} catch (error: unknown) {
			this.report(error);
			this.retire(generation);
			throw error;
		}
	}

	private eventFits(generation: Generation, bytes: number): boolean {
		return generation.events.length < this.budgets.maxQueuedEvents
			&& generation.queuedBytes + bytes <= this.budgets.maxQueuedEventBytes;
	}

	private enqueueEvent(generation: Generation, publication: PendingEvent): void {
		if (generation.nextSeq > Number.MAX_SAFE_INTEGER) {
			throw bridgeError('RATE_LIMITED');
		}
		publication.timer?.dispose();
		publication.timer = this.timing.schedule(() => {
			this.report(bridgeError('RATE_LIMITED'));
			this.retire(generation);
		}, this.budgets.eventAcknowledgementTimeoutMs);
		generation.events.push({
			value: { seq: generation.nextSeq++, event: publication.event },
			bytes: publication.bytes,
			publication,
		});
		generation.queuedBytes += publication.bytes;
		generation.pollWake?.();
	}

	private async events(generation: Generation, acknowledgedSeq: number, waitMs: number): Promise<RemoteExecutionEvents> {
		if (acknowledgedSeq < generation.acknowledgedSeq || acknowledgedSeq > generation.deliveredSeq) {
			throw bridgeError('PROTOCOL_INCOMPATIBLE');
		}
		generation.acknowledgedSeq = acknowledgedSeq;
		while (generation.events[0] !== undefined && generation.events[0].value.seq <= acknowledgedSeq) {
			const acknowledged = generation.events.shift()!;
			generation.queuedBytes -= acknowledged.bytes;
			this.settlePublication(acknowledged.publication);
		}
		while (generation.pendingEvents[0] !== undefined && this.eventFits(generation, generation.pendingEvents[0].bytes)) {
			const pending = generation.pendingEvents.shift()!;
			generation.pendingBytes -= pending.bytes;
			this.enqueueEvent(generation, pending);
		}
		if (generation.events.length === 0) {
			await new Promise<void>((resolve) => {
				let timer: RemoteExecutionTimer | undefined;
				const wake = () => {
					timer?.dispose();
					if (generation.pollWake === wake) {
						generation.pollWake = undefined;
					}
					resolve();
				};
				generation.pollWake = wake;
				timer = this.timing.schedule(wake, Math.min(waitMs, this.budgets.pollWaitMs));
			});
		}
		this.assertLive(generation);
		const events: RemoteExecutionEvent[] = [];
		let bytes = 0;
		for (const item of generation.events) {
			if (events.length >= this.budgets.maxEventBatchCount
				|| bytes + item.bytes > this.budgets.maxEventBatchBytes) {
				break;
			}
			bytes += item.bytes;
			events.push(item.value);
		}
		generation.deliveredSeq = events.at(-1)?.seq ?? generation.deliveredSeq;
		return { acknowledgedSeq, events };
	}

	private settlePublication(publication: PendingEvent, error?: Error): void {
		if (publication.settled) {
			return;
		}
		publication.settled = true;
		publication.timer?.dispose();
		if (error === undefined) {
			publication.resolve();
		} else {
			publication.reject(error);
		}
	}

	private retireTaskPublications(generation: Generation, taskId: string): void {
		// Disposal is cleanup, not a terminal assertion. Retire this route without waiting on a Broker
		// that may itself be awaiting disposeTask while accepting the terminal event.
		for (const queued of generation.events) {
			if (queued.value.event.taskId === taskId) {
				this.settlePublication(queued.publication);
			}
		}
		for (let index = generation.pendingEvents.length - 1; index >= 0; index -= 1) {
			const pending = generation.pendingEvents[index];
			if (pending.event.taskId === taskId) {
				generation.pendingEvents.splice(index, 1);
				generation.pendingBytes -= pending.bytes;
				this.settlePublication(pending);
			}
		}
	}

	private authenticate(params: RemoteExecutionAuthorization): Generation {
		const generation = this.current;
		if (generation === undefined || !sameAuthorization(generation, params)) {
			throw bridgeError('AUTH_FAILED');
		}
		this.assertLive(generation);
		return generation;
	}

	private reserveCall(generation: Generation, kind: RemoteExecutionOperation['kind']): () => void {
		const lane = kind === 'events' ? 'pollInFlight'
			: kind === 'heartbeat' ? 'heartbeatInFlight'
				: kind === 'cancel' || kind === 'disposeTask' ? 'controlInFlight' : 'normalInFlight';
		const limit = lane === 'pollInFlight' || lane === 'heartbeatInFlight' ? 1
			: lane === 'controlInFlight' ? this.budgets.maxControlInFlight : this.budgets.maxInFlight;
		if (generation[lane] >= limit) {
			throw bridgeError('RATE_LIMITED', true);
		}
		generation[lane] += 1;
		return () => { generation[lane] -= 1; };
	}

	private async assertAllowed(generation: Generation): Promise<void> {
		this.assertLive(generation);
		try {
			await this.options.assertAllowed();
		} catch (error: unknown) {
			this.retire(generation, error instanceof Error ? error : undefined);
			throw error;
		}
		this.assertLive(generation);
	}

	private assertLive(generation: Generation): void {
		if (this.disposed || this.current !== generation || generation.state !== 'active') {
			throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
		}
		if (this.timing.now() >= generation.expiresAt) {
			this.retire(generation);
			throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
		}
	}

	private assertTarget(generation: Generation, nodeId: string, nodeInstanceId: string): void {
		if (nodeId !== generation.nodeId || nodeInstanceId !== generation.nodeInstanceId) {
			throw bridgeError('AUTH_FAILED');
		}
	}

	private assertConnectActive(signal: AbortSignal): void {
		if (this.disposed || signal.aborted) {
			throw bridgeError('TASK_RECOVERY_UNAVAILABLE');
		}
	}

	private renewLease(generation: Generation): void {
		generation.leaseTimer?.dispose();
		generation.expiresAt = this.timing.now() + this.budgets.leaseMs;
		generation.leaseTimer = this.timing.schedule(() => {
			this.report(bridgeError('TASK_RECOVERY_UNAVAILABLE'));
			this.retire(generation);
		}, this.budgets.leaseMs);
	}

	private invalidate(generation: Generation, reason: Error = bridgeError('TASK_RECOVERY_UNAVAILABLE')): void {
		if (generation.state === 'closed' || generation.state === 'closing') {
			return;
		}
		generation.state = 'closing';
		generation.leaseTimer?.dispose();
		generation.leaseTimer = undefined;
		generation.abort.abort(reason);
		generation.pollWake?.();
		for (const queued of generation.events) {
			this.settlePublication(queued.publication, bridgeError('TASK_RECOVERY_UNAVAILABLE'));
		}
		for (const pending of generation.pendingEvents.splice(0)) {
			this.settlePublication(pending, bridgeError('TASK_RECOVERY_UNAVAILABLE'));
		}
		generation.pendingBytes = 0;
	}

	private retire(generation: Generation, reason?: Error): void {
		this.invalidate(generation, reason);
		void this.close(generation).catch((error: unknown) => this.report(error));
	}

	private close(generation: Generation): Promise<void> {
		this.invalidate(generation);
		if (generation.state === 'closed') {
			return Promise.resolve();
		}
		if (generation.cleanup !== undefined) {
			return generation.cleanup;
		}
		const cleanup = generation.factory.then(
			(binding) => binding.executor.dispose(),
			() => undefined,
		).then(
			() => this.finishClose(generation),
			(error: unknown) => {
				if (error instanceof WindowNodeTaskExecutorDisposalError && error.cleanupComplete) {
					this.finishClose(generation);
				}
				throw error;
			},
		);
		generation.cleanup = cleanup;
		void cleanup.catch(() => {
			if (generation.cleanup === cleanup) {
				generation.cleanup = undefined;
			}
		});
		return cleanup;
	}

	private finishClose(generation: Generation): void {
		generation.state = 'closed';
		generation.redaction.dispose();
		generation.events.length = 0;
		generation.queuedBytes = 0;
		generation.requests.clear();
		generation.semanticRequests.clear();
		generation.controlRequestCounts.clear();
		generation.tasks.clear();
		generation.workspaces.clear();
		if (this.current === generation) {
			this.current = undefined;
		}
	}

	private serializeState<T>(operation: () => Promise<T>): Promise<T> {
		if (this.stateOperations >= this.budgets.maxStateOperations) {
			throw bridgeError('RATE_LIMITED', true);
		}
		this.stateOperations += 1;
		const result = this.stateTail.then(operation);
		this.stateTail = result.then(
			() => { this.stateOperations -= 1; },
			() => { this.stateOperations -= 1; },
		);
		return result;
	}

	private result<T>(operation: () => Promise<T> | T): Promise<RemoteExecutionEnvelope<T>> {
		return this.protect(async () => ({ ok: true, result: await operation() }));
	}

	private async protect<T>(
		operation: () => Promise<RemoteExecutionEnvelope<T>>,
	): Promise<RemoteExecutionEnvelope<T>> {
		try {
			return await operation();
		} catch (error: unknown) {
			this.report(error);
			return remoteExecutionFailure(error);
		}
	}

	private report(error: unknown): void {
		try {
			this.options.reportError(error instanceof Error ? error : bridgeError('TASK_EXECUTION_FAILED'));
		} catch {
			// A broken logger must not create an unhandled rejection or reactivate a revoked capability.
		}
	}
}

function tokenHash(token: string): Buffer {
	return createHash('sha256').update(token, 'utf8').digest();
}

function sameAuthorization(generation: GenerationIdentity, params: RemoteExecutionAuthorization): boolean {
	const tokenMatches = timingSafeEqual(generation.tokenHash, tokenHash(params.token));
	return tokenMatches && generation.clientId === params.clientId && generation.helperInstanceId === params.helperInstanceId;
}

function isMutation(operation: RemoteExecutionOperation): boolean {
	return operation.kind === 'start' || operation.kind === 'answer'
		|| operation.kind === 'cancel' || operation.kind === 'disposeTask';
}

function mutationIdentity(operation: RemoteExecutionOperation): string {
	switch (operation.kind) {
		case 'start':
		case 'cancel':
		case 'disposeTask':
			return `${operation.kind}:${operation.params.taskId}`;
		case 'answer':
			return `answer:${operation.params.taskId}:${operation.params.answerId}`;
		default:
			throw bridgeError('PROTOCOL_INCOMPATIBLE');
	}
}

function taskScope(params: NodeTaskStartParams, workspaceIdentity: string): string {
	return remoteFingerprint({
		owner: params.authenticatedOwnerId,
		sourceNodeId: params.sourceNodeId,
		sourceWorkspaceIdentity: params.sourceWorkspaceIdentity,
		target: params.target,
		workspaceIdentity,
	});
}
