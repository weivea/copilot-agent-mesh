import { createHash } from 'node:crypto';

import {
	PROTOCOL_LIMITS,
	nodeTaskAnswerParamsSchema,
	nodeTaskCancelParamsSchema,
	nodeTaskEventParamsSchema,
	nodeTaskStartParamsSchema,
	nodeTaskStartedResultSchema,
	utf8String,
	uuidSchema,
	type NodeTaskAnswerParams,
	type NodeTaskCancelParams,
	type NodeTaskEventParams,
	type NodeTaskStartedResult,
	type NodeTaskStartParams,
	type DelegatedExecutionContext,
} from '../../shared/protocol';
import {
	AgentRuntimeError,
	type AgentInputRequest,
	type AgentRuntimeApprovalCapabilityIssuer,
	type AgentRuntime,
	type AgentRuntimeEvent,
	type AgentTaskAnswer,
	type AgentTaskHandle,
	type AgentTaskRequest,
	type RegisteredLocalWorkspace,
	type WorkspaceResolver,
} from '../agentHost/AgentRuntime';
import { MeshDomainError } from '../domain/errors';
import type { Clock, IdGenerator } from '../domain/ports';
import { sanitizeDelegationText } from '../tools/DelegationTextSanitizer';
import {
	assertDelegationGrantBinding,
	canAutoApproveToolConfirmation,
	type DelegationGrant,
} from './DelegationGrant';

const maximumTimerDelayMs = 2_147_483_647;

export interface WindowNodeTaskConfirmationRequest {
	readonly sourceWindowLabel: string;
	readonly targetWindowLabel: string;
	readonly workspaceDisplayName: string;
	readonly taskTitle: string;
	readonly prompt: string;
}

export type WindowNodeTaskConfirmationResult = 'once' | 'deny';

export interface WindowNodeTaskConfirmationHost {
	confirm(
		request: WindowNodeTaskConfirmationRequest,
		signal?: AbortSignal,
	): Promise<WindowNodeTaskConfirmationResult>;
}

export interface WindowNodeTaskEventSink {
	publish(event: NodeTaskEventParams): Promise<void> | void;
}

export interface WindowNodeTaskExecutorOptions {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly nodeLabel: string;
	readonly runtime: AgentRuntime;
	readonly workspaceResolver: WorkspaceResolver;
	readonly confirmationHost: WindowNodeTaskConfirmationHost;
	readonly approvalCapabilities?: AgentRuntimeApprovalCapabilityIssuer;
	readonly eventSink: WindowNodeTaskEventSink;
	readonly ids: IdGenerator | (() => string);
	readonly clock: Clock | (() => Date);
}

interface PendingInput {
	readonly publicInputId: string;
	readonly request: AgentInputRequest;
}

interface AnswerOperation {
	readonly answerId: string;
	readonly operation: Promise<void>;
}

interface ActiveTask {
	readonly handle: AgentTaskHandle;
	readonly workspace: RegisteredLocalWorkspace;
	readonly pendingInputs: Map<string, PendingInput>;
	readonly queuedInputs: AgentInputRequest[];
	readonly answeredInputs: Map<string, string>;
	readonly answerOperations: Map<string, AnswerOperation>;
	readonly autoApprovedInputs: Set<string>;
	outputSummary: string;
	outputTail: string;
	grant: DelegationGrant | undefined;
	delegatedExecutionContext: DelegatedExecutionContext | undefined;
	terminal: boolean;
	cleanupRequired: boolean;
	cancelComplete: boolean;
	disposeComplete: boolean;
	cancelOperation?: Promise<void>;
	disposeOperation?: Promise<void>;
	pump?: Promise<void>;
}

interface StartRecord {
	readonly fingerprint: string;
	operation: Promise<NodeTaskStartedResult>;
	result?: NodeTaskStartedResult;
	active?: ActiveTask;
	terminal: boolean;
	deadlineExpired: boolean;
	runtimeStartPending: boolean;
	readonly preStartAbort: AbortController;
	deadlineTimer?: NodeJS.Timeout;
}

class EventSinkFailure extends Error {
	public constructor(readonly cause: unknown) {
		super('The Window Node task event sink failed.');
		this.name = 'EventSinkFailure';
	}
}

export class WindowNodeTaskExecutorDisposalError extends AggregateError {
	public constructor(
		errors: readonly unknown[],
		public readonly cleanupComplete: boolean,
	) {
		super(errors, 'Window Node task executor cleanup failed.');
		this.name = 'WindowNodeTaskExecutorDisposalError';
	}
}

export class WindowNodeTaskExecutor {
	private readonly starts = new Map<string, StartRecord>();
	private readonly pumps = new Set<Promise<void>>();
	private readonly pumpFailures: unknown[] = [];
	private readonly deadlineOperations = new Set<Promise<void>>();
	private readonly deadlineFailures: Error[] = [];
	private readonly id: () => string;
	private readonly now: () => Date;
	private readonly nodeId: string;
	private readonly nodeInstanceId: string;
	private readonly nodeLabel: string;
	private disposed = false;
	private disposeComplete = false;
	private disposal: Promise<void> | undefined;
	private runtimeDisposal: Promise<void> | undefined;
	private runtimeStartTail: Promise<void> = Promise.resolve();

	public constructor(private readonly options: WindowNodeTaskExecutorOptions) {
		this.nodeId = uuidSchema.parse(options.nodeId);
		this.nodeInstanceId = uuidSchema.parse(options.nodeInstanceId);
		this.nodeLabel = utf8String(
			PROTOCOL_LIMITS.nameBytes,
			'window node label',
			1,
		).parse(options.nodeLabel);
		const ids = options.ids;
		const clock = options.clock;
		this.id = typeof ids === 'function' ? ids : () => ids.next();
		this.now = typeof clock === 'function' ? clock : () => clock.now();
	}

	public start(input: NodeTaskStartParams): Promise<NodeTaskStartedResult> {
		this.assertActive();
		const params = nodeTaskStartParamsSchema.parse(input);
		this.assertTarget(params.target.nodeId, params.target.nodeInstanceId);
		const fingerprint = startFingerprint(params);
		const existing = this.starts.get(params.taskId);
		if (existing !== undefined) {
			if (existing.fingerprint !== fingerprint) {
				throw new MeshDomainError('TASK_ID_CONFLICT', 'Task ID is already bound to a different Window Node request.');
			}
			return existing.operation;
		}
		this.assertWithinWorkerDeadline(params.workerDeadline);

		const record: StartRecord = {
			fingerprint,
			operation: undefined as unknown as Promise<NodeTaskStartedResult>,
			terminal: false,
			deadlineExpired: false,
			runtimeStartPending: false,
			preStartAbort: new AbortController(),
		};
		this.scheduleWorkerDeadline(record, params.workerDeadline);
		const operation = this.startCore(params, record);
		record.operation = operation;
		this.starts.set(params.taskId, record);
		void operation.catch(() => {
			if (
				this.starts.get(params.taskId) === record
				&& record.result === undefined
				&& record.active === undefined
			) {
				this.clearWorkerDeadline(record);
				this.starts.delete(params.taskId);
			}
		});
		return operation;
	}

	public async cancel(input: NodeTaskCancelParams): Promise<void> {
		this.assertActive();
		const params = nodeTaskCancelParamsSchema.parse(input);
		this.assertTarget(params.nodeId, params.nodeInstanceId);
		const record = this.requireTask(params.taskId);
		await record.operation;
		const active = record.active;
		if (active === undefined || active.terminal) {
			throw new MeshDomainError('TASK_NOT_CANCELLABLE', 'The task is no longer cancellable.');
		}
		await this.cancelHandle(active);
	}

	public async disposeTask(input: NodeTaskCancelParams): Promise<void> {
		this.assertActive();
		const params = nodeTaskCancelParamsSchema.parse(input);
		this.assertTarget(params.nodeId, params.nodeInstanceId);
		const record = this.requireTask(params.taskId);
		await record.operation;
		const active = record.active;
		if (active === undefined) {
			return;
		}
		await this.stopActiveTask(record, active);
	}

	public async answer(input: NodeTaskAnswerParams): Promise<void> {
		this.assertActive();
		const params = nodeTaskAnswerParamsSchema.parse(input);
		this.assertTarget(params.nodeId, params.nodeInstanceId);
		const record = this.requireTask(params.taskId);
		await record.operation;
		const active = record.active;
		if (active === undefined || active.terminal) {
			throw new MeshDomainError('INPUT_NOT_PENDING', 'The requested input is not pending.');
		}
		if (active.answeredInputs.get(params.inputId) === params.answerId) {
			return;
		}
		const underway = active.answerOperations.get(params.inputId);
		if (underway !== undefined) {
			if (underway.answerId !== params.answerId) {
				throw new MeshDomainError('INPUT_NOT_PENDING', 'A different answer is already being submitted.');
			}
			return underway.operation;
		}
		const pending = active.pendingInputs.get(params.inputId);
		if (pending === undefined) {
			throw new MeshDomainError('INPUT_NOT_PENDING', 'The requested input is not pending.');
		}

		const operation = active.handle.answer(toAgentAnswer(pending.request, params.answer)).then(async () => {
			active.pendingInputs.delete(params.inputId);
			active.answeredInputs.set(params.inputId, params.answerId);
			await this.publishNextInput(record, active);
		});
		active.answerOperations.set(params.inputId, {
			answerId: params.answerId,
			operation,
		});
		try {
			await operation;
		} catch (error: unknown) {
			if (active.answerOperations.get(params.inputId)?.operation === operation) {
				active.answerOperations.delete(params.inputId);
			}
			throw error;
		}
	}

	public dispose(): Promise<void> {
		if (this.disposal !== undefined) {
			return this.disposal;
		}
		if (this.disposeComplete) {
			return Promise.resolve();
		}
		this.disposed = true;
		for (const record of this.starts.values()) {
			this.clearWorkerDeadline(record);
		}
		let disposal!: Promise<void>;
		disposal = this.disposeCore().then(() => {
			this.disposeComplete = true;
		}, (error: unknown) => {
			if (
				error instanceof WindowNodeTaskExecutorDisposalError
				&& error.cleanupComplete
			) {
				this.disposeComplete = true;
			}
			throw error;
		}).finally(() => {
			if (!this.disposeComplete && this.disposal === disposal) {
				this.disposal = undefined;
			}
		});
		this.disposal = disposal;
		return disposal;
	}

	public get generationClosed(): boolean {
		return this.disposed;
	}

	public delegatedExecutionContext(taskId: string): DelegatedExecutionContext | undefined {
		const active = this.starts.get(uuidSchema.parse(taskId))?.active;
		return active?.delegatedExecutionContext === undefined
			? undefined
			: { ...active.delegatedExecutionContext };
	}

	private async startCore(
		params: NodeTaskStartParams,
		record: StartRecord,
	): Promise<NodeTaskStartedResult> {
		this.assertRecordWithinWorkerDeadline(record, params.workerDeadline);
		this.assertActive();
		const workspace = await abortablePreStartOperation(
			this.resolveWorkspace(params.target.workspaceId),
			record.preStartAbort.signal,
		);
		const grant = assertDelegationGrantBinding(params, workspace);
		this.assertRecordWithinWorkerDeadline(record, params.workerDeadline);
		const probe = await abortablePreStartOperation(
			this.options.runtime.probe(params.requireEditor ? { requireEditor: true } : undefined),
			record.preStartAbort.signal,
		);
		if (!probe.featureEnabled || (!probe.available && probe.canStart !== true)) {
			throw new AgentRuntimeError(
				probe.reason ?? 'AGENT_UNAVAILABLE',
				'The production Agent runtime is unavailable or disabled.',
				true,
			);
		}
		await abortablePreStartOperation(
			this.options.runtime.prepareStart?.(params.requireEditor ? { requireEditor: true } : undefined) ?? Promise.resolve(),
			record.preStartAbort.signal,
		);
		this.assertRecordWithinWorkerDeadline(record, params.workerDeadline);
		this.assertActive();
		const baseRuntimeRequest = {
			taskId: params.taskId,
			title: params.title,
			prompt: params.prompt,
			acceptanceCriteria: [...params.acceptanceCriteria],
			workspaceId: workspace.workspaceId,
			sourceWindowName: params.sourceLabel,
			...(params.requireEditor ? { requireEditor: true as const } : {}),
			allowInteractiveAuthentication: true,
			delegatedExecutionContext: { ...params.delegatedExecutionContext },
			approvalContext: {
				peerId: params.authenticatedOwnerId,
				workspaceId: workspace.workspaceId,
				requestHash: record.fingerprint,
			},
		} satisfies AgentTaskRequest;
		if (params.sourceNodeId === undefined) {
			const confirmation = await abortablePreStartOperation(
				this.options.confirmationHost.confirm({
					sourceWindowLabel: params.sourceLabel,
					targetWindowLabel: this.nodeLabel,
					workspaceDisplayName: workspace.displayName,
					taskTitle: params.title,
					prompt: params.prompt,
				}, record.preStartAbort.signal),
				record.preStartAbort.signal,
			);
			if (confirmation !== 'once') {
				throw new MeshDomainError(
					'TASK_EXECUTION_FAILED',
					'The local user denied this remote task.',
				);
			}
		}
		this.assertRecordWithinWorkerDeadline(record, params.workerDeadline);
		this.assertActive();

		const handle = await this.withRuntimeStartGate(record, async () => {
			await abortablePreStartOperation(
				this.options.runtime.prepareStart?.(params.requireEditor ? { requireEditor: true } : undefined) ?? Promise.resolve(),
				record.preStartAbort.signal,
			);
			this.assertRecordWithinWorkerDeadline(record, params.workerDeadline);
			this.assertActive();
			record.runtimeStartPending = true;
			try {
				const approvalCapability = this.options.approvalCapabilities?.issue(baseRuntimeRequest);
				return await this.options.runtime.start({
					...baseRuntimeRequest,
					...(approvalCapability === undefined ? {} : { approvalCapability }),
				});
			} catch (error: unknown) {
				if (record.deadlineExpired) {
					throw new MeshDomainError(
						'TASK_EXECUTION_FAILED',
						'The task worker deadline expired before the Agent runtime start completed.',
					);
				}
				if (this.disposed) {
					throw new MeshDomainError('WORKER_DRAINING', 'The Window Node is shutting down.');
				}
				throw error;
			} finally {
				record.runtimeStartPending = false;
			}
		});
		const active: ActiveTask = {
			handle,
			workspace,
			pendingInputs: new Map(),
			queuedInputs: [],
			answeredInputs: new Map(),
			answerOperations: new Map(),
			autoApprovedInputs: new Set(),
			outputSummary: '',
			outputTail: '',
			grant,
			delegatedExecutionContext: { ...params.delegatedExecutionContext },
			terminal: false,
			cleanupRequired: false,
			cancelComplete: false,
			disposeComplete: false,
		};
		record.active = active;
		if (record.deadlineExpired || this.deadlineHasPassed(params.workerDeadline)) {
			record.deadlineExpired = true;
			await this.stopActiveTask(record, active);
			throw new MeshDomainError(
				'TASK_EXECUTION_FAILED',
				'The task worker deadline expired before the Agent runtime start completed.',
			);
		}
		if (handle.taskId !== params.taskId) {
			this.destroyGrant(active);
			active.cleanupRequired = true;
			const cleanup = await Promise.allSettled([
				this.cancelHandle(active),
				this.disposeHandle(active),
			]);
			throwCleanupFailures(cleanup, 'The Agent runtime returned a mismatched task handle.');
			record.active = undefined;
			throw new AgentRuntimeError(
				'TASK_EXECUTION_FAILED',
				'The Agent runtime returned a mismatched task handle.',
			);
		}

		if (this.disposed) {
			this.destroyGrant(active);
			active.cleanupRequired = true;
			const cleanup = await Promise.allSettled([
				this.cancelHandle(active),
				this.disposeHandle(active),
			]);
			throwCleanupFailures(cleanup, 'The Window Node shut down while starting the task.');
			record.active = undefined;
			throw new MeshDomainError('WORKER_DRAINING', 'The Window Node is shutting down.');
		}

		let result: NodeTaskStartedResult;
		try {
			result = nodeTaskStartedResultSchema.parse({
				taskId: params.taskId,
				nodeId: this.nodeId,
				nodeInstanceId: this.nodeInstanceId,
				recoveryDescriptor: {
					adapter: 'ahp',
					sessionId: handle.recovery.sessionUri,
					conversationId: handle.recovery.chatUri,
				},
			});
		} catch (error: unknown) {
			this.destroyGrant(active);
			active.cleanupRequired = true;
			const cleanup = await Promise.allSettled([
				this.cancelHandle(active),
				this.disposeHandle(active),
			]);
			throwCleanupFailures(cleanup, 'The Agent runtime returned an invalid recovery descriptor.', error);
			record.active = undefined;
			throw error;
		}
		record.result = result;
		const pump = this.pump(record, active);
		active.pump = pump;
		this.trackPump(pump);
		return result;
	}

	private withRuntimeStartGate<T>(
		record: StartRecord,
		operation: () => Promise<T>,
	): Promise<T> {
		const predecessor = this.runtimeStartTail;
		let releaseTurn!: () => void;
		const turn = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		this.runtimeStartTail = predecessor.then(() => turn, () => turn);
		return abortablePreStartOperation(
			predecessor.catch(() => undefined),
			record.preStartAbort.signal,
		)
			.then(operation)
			.finally(releaseTurn);
	}

	private async pump(record: StartRecord, active: ActiveTask): Promise<void> {
		try {
			for await (const event of active.handle.events) {
				if (active.terminal) {
					return;
				}
				const terminal = await this.consume(record, active, event);
				if (terminal) {
					return;
				}
			}
			if (!this.disposed && !active.terminal) {
				this.destroyGrant(active);
				await this.publish(record, {
					type: 'failed',
					failure: {
						code: 'TASK_EXECUTION_FAILED',
						message: 'The Agent runtime ended without a terminal event.',
						retryable: true,
					},
				});
				active.terminal = true;
				record.terminal = true;
				this.clearWorkerDeadline(record);
			}
		} catch (error: unknown) {
			this.destroyGrant(active);
			if (error instanceof EventSinkFailure) {
				active.cleanupRequired = true;
				const cleanup = await Promise.allSettled([
					this.cancelHandle(active),
					this.disposeHandle(active),
				]);
				throwCleanupFailures(cleanup, error.message, error.cause);
				throw error;
			}
			if (!this.disposed && !active.terminal) {
				try {
					const failure = normalizeAgentFailure(error);
					this.destroyGrant(active);
					await this.publish(record, {
						type: 'failed',
						failure: {
							code: boundUtf8(failure.code, 128),
							message: safeTaskText(failure.message, PROTOCOL_LIMITS.errorMessageBytes),
							retryable: failure.retryable,
						},
					});
					active.terminal = true;
					record.terminal = true;
					this.clearWorkerDeadline(record);
				} catch (publishError: unknown) {
					active.cleanupRequired = true;
					const cleanup = await Promise.allSettled([
						this.cancelHandle(active),
						this.disposeHandle(active),
					]);
					throwCleanupFailures(cleanup, 'The Window Node task failed and its failure event could not be published.', publishError);
					throw publishError;
				}
			}
		} finally {
			this.destroyGrant(active);
			this.clearWorkerDeadline(record);
			const cleanup = await Promise.allSettled([this.disposeHandle(active)]);
			throwCleanupFailures(cleanup, 'The Agent task handle could not be disposed.');
			if (
				record.active === active
				&& (
					!active.cleanupRequired
					|| (active.cancelComplete && active.disposeComplete)
				)
			) {
				record.active = undefined;
			}
		}
	}

	private async consume(
		record: StartRecord,
		active: ActiveTask,
		event: AgentRuntimeEvent,
	): Promise<boolean> {
		switch (event.type) {
			case 'progress':
				await this.publish(record, {
					type: 'progress',
					summary: safeTaskText(event.message, PROTOCOL_LIMITS.outputEventBytes),
				});
				return false;
			case 'output': {
				const safeOutput = safeTaskText(event.text, PROTOCOL_LIMITS.outputEventBytes);
				active.outputSummary = boundUtf8(
					active.outputSummary + safeOutput,
					PROTOCOL_LIMITS.terminalSummaryBytes,
				);
				active.outputTail = boundUtf8Tail(
					active.outputTail + safeOutput,
					PROTOCOL_LIMITS.terminalSummaryBytes,
				);
				await this.publish(record, {
					type: 'output',
					summary: safeOutput,
				});
				return false;
			}
			case 'outputTruncated':
				await this.publish(record, {
					type: 'outputTruncated',
					summary: safeTaskText(event.message, PROTOCOL_LIMITS.outputEventBytes),
				});
				return false;
			case 'tool':
				await this.publish(record, {
					type: 'tool',
					summary: safeTaskText(
						`${event.name}: ${event.status}${event.summary === undefined ? '' : ` — ${event.summary}`}`,
						PROTOCOL_LIMITS.outputEventBytes,
					),
				});
				return false;
			case 'terminal':
				await this.publish(record, {
					type: 'terminal',
					summary: safeTaskText(event.summary, PROTOCOL_LIMITS.outputEventBytes),
				});
				return false;
			case 'inputRequired':
				await this.consumeInput(record, active, event.request);
				return false;
			case 'completed':
				this.destroyGrant(active);
				await this.publish(record, {
					type: 'completed',
					summary: structuredCompletionSummary(
						active.outputSummary,
						active.outputTail,
					) || 'Task completed.',
				});
				active.terminal = true;
				record.terminal = true;
				this.clearWorkerDeadline(record);
				return true;
			case 'cancelled':
				this.destroyGrant(active);
				await this.publish(record, {
					type: 'cancelled',
					summary: 'Task cancellation was confirmed.',
				});
				active.terminal = true;
				record.terminal = true;
				this.clearWorkerDeadline(record);
				return true;
			case 'failed':
				this.destroyGrant(active);
				await this.publish(record, {
					type: 'failed',
					failure: {
						code: boundUtf8(event.error.code, 128),
						message: safeTaskText(event.error.message, PROTOCOL_LIMITS.errorMessageBytes),
						retryable: event.error.retryable,
					},
				});
				active.terminal = true;
				record.terminal = true;
				this.clearWorkerDeadline(record);
				return true;
		}
	}

	private async consumeInput(
		record: StartRecord,
		active: ActiveTask,
		request: AgentInputRequest,
	): Promise<void> {
		if (
			request.kind === 'toolConfirmation'
			&& active.grant !== undefined
			&& !active.autoApprovedInputs.has(request.requestId)
			&& await canAutoApproveToolConfirmation(
				active.grant,
				active.handle.taskId,
				active.workspace,
				request,
			)
		) {
			active.autoApprovedInputs.add(request.requestId);
			await active.handle.answer({
				requestId: request.requestId,
				outcome: 'accept',
			});
			return;
		}
		const inputKind = (request as { readonly kind: string }).kind;
		if (isKnownAgentInputKind(inputKind) && !isStringAnswerableInput(request)) {
			throw new AgentRuntimeError(
				'TASK_EXECUTION_FAILED',
				'The Agent runtime requested input that this protocol version cannot answer safely.',
			);
		}
		if (active.pendingInputs.size > 0) {
			if (active.queuedInputs.length >= 32) {
				throw new AgentRuntimeError(
					'TASK_EXECUTION_FAILED',
					'The Agent runtime exceeded the pending input queue limit.',
				);
			}
			active.queuedInputs.push(request);
			return;
		}
		await this.publishInput(record, active, request);
	}

	private async publishNextInput(
		record: StartRecord,
		active: ActiveTask,
	): Promise<void> {
		const next = active.queuedInputs[0];
		if (next === undefined || active.terminal) {
			return;
		}
		await this.publishInput(record, active, next);
		active.queuedInputs.shift();
	}

	private async publishInput(
		record: StartRecord,
		active: ActiveTask,
		request: AgentInputRequest,
	): Promise<void> {
		const publicInputId = this.id();
		const pending = { publicInputId, request };
		active.pendingInputs.set(publicInputId, pending);
		try {
			await this.publish(record, {
				type: 'inputRequired',
				inputId: publicInputId,
				prompt: safeTaskText(request.prompt, PROTOCOL_LIMITS.taskAnswerBytes),
			});
		} catch (error: unknown) {
			active.pendingInputs.delete(publicInputId);
			throw error;
		}
	}

	private async publish(
		record: StartRecord,
		event: NodeTaskEventParams['event'],
	): Promise<void> {
		const params = nodeTaskEventParamsSchema.parse({
			nodeId: this.nodeId,
			nodeInstanceId: this.nodeInstanceId,
			taskId: record.result?.taskId,
			at: this.now().toISOString(),
			event,
		});
		try {
			await this.options.eventSink.publish(params);
		} catch (error: unknown) {
			throw new EventSinkFailure(error);
		}
	}

	private async resolveWorkspace(workspaceId: string): Promise<RegisteredLocalWorkspace> {
		const workspace = await this.options.workspaceResolver.resolve(workspaceId);
		if (workspace === undefined || workspace.workspaceId !== workspaceId) {
			throw new MeshDomainError(
				'WORKSPACE_NOT_FOUND',
				'The exact Window Node instance does not resolve this workspace.',
			);
		}
		return workspace;
	}

	private assertTarget(nodeId: string, nodeInstanceId: string): void {
		if (nodeId !== this.nodeId || nodeInstanceId !== this.nodeInstanceId) {
			throw new MeshDomainError('AGENT_UNAVAILABLE', 'The Window Node route is stale or mismatched.');
		}
	}

	private requireTask(taskId: string): StartRecord {
		const record = this.starts.get(taskId);
		if (record === undefined) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'Task not found.');
		}
		return record;
	}

	private assertActive(): void {
		if (this.disposed) {
			throw new MeshDomainError('WORKER_DRAINING', 'The Window Node is shutting down.');
		}
	}

	private assertWithinWorkerDeadline(workerDeadline: string): void {
		if (this.deadlineHasPassed(workerDeadline)) {
			throw new MeshDomainError(
				'TASK_EXECUTION_FAILED',
				'The task worker deadline has already expired.',
			);
		}
	}

	private assertRecordWithinWorkerDeadline(
		record: StartRecord,
		workerDeadline: string,
	): void {
		if (record.deadlineExpired || this.deadlineHasPassed(workerDeadline)) {
			record.deadlineExpired = true;
			this.clearWorkerDeadline(record);
			throw new MeshDomainError(
				'TASK_EXECUTION_FAILED',
				'The task worker deadline expired before execution could start.',
			);
		}
	}

	private deadlineHasPassed(workerDeadline: string): boolean {
		return Date.parse(workerDeadline) <= this.now().valueOf();
	}

	private scheduleWorkerDeadline(record: StartRecord, workerDeadline: string): void {
		this.clearWorkerDeadline(record);
		if (this.disposed || record.terminal) {
			return;
		}
		const remaining = Math.max(0, Date.parse(workerDeadline) - this.now().valueOf());
		const timer = setTimeout(() => {
			if (record.deadlineTimer !== timer) {
				return;
			}
			record.deadlineTimer = undefined;
			if (this.disposed || record.terminal) {
				return;
			}
			if (remaining > maximumTimerDelayMs) {
				this.scheduleWorkerDeadline(record, workerDeadline);
				return;
			}
			record.deadlineExpired = true;
			record.preStartAbort.abort(new MeshDomainError(
				'TASK_EXECUTION_FAILED',
				'The task worker deadline expired before execution could start.',
			));
			const active = record.active;
			if (active !== undefined) {
				this.trackDeadlineOperation(this.stopActiveTask(record, active));
			} else if (record.runtimeStartPending) {
				void this.dispose().catch(() => undefined);
			}
		}, Math.min(remaining, maximumTimerDelayMs));
		timer.unref();
		record.deadlineTimer = timer;
	}

	private clearWorkerDeadline(record: StartRecord): void {
		if (record.deadlineTimer !== undefined) {
			clearTimeout(record.deadlineTimer);
			record.deadlineTimer = undefined;
		}
	}

	private async stopActiveTask(record: StartRecord, active: ActiveTask): Promise<void> {
		this.destroyGrant(active);
		active.terminal = true;
		active.cleanupRequired = true;
		record.terminal = true;
		this.clearWorkerDeadline(record);
		const cleanup = await Promise.allSettled([
			this.cancelHandle(active),
			this.disposeHandle(active),
		]);
		throwCleanupFailures(
			cleanup,
			'The Agent task handle could not be stopped safely.',
		);
	}

	private cancelHandle(active: ActiveTask): Promise<void> {
		if (active.cancelComplete) {
			return Promise.resolve();
		}
		if (active.cancelOperation === undefined) {
			let operation!: Promise<void>;
			let result: Promise<void>;
			try {
				result = Promise.resolve(active.handle.cancel());
			} catch (error: unknown) {
				result = Promise.reject(error);
			}
			operation = result.then(() => {
				active.cancelComplete = true;
			}, (error: unknown) => {
				if (active.cancelOperation === operation) {
					active.cancelOperation = undefined;
				}
				throw error;
			});
			active.cancelOperation = operation;
		}
		return active.cancelOperation;
	}

	private disposeHandle(active: ActiveTask): Promise<void> {
		if (active.disposeComplete) {
			return Promise.resolve();
		}
		if (active.disposeOperation === undefined) {
			let operation!: Promise<void>;
			let result: Promise<void>;
			try {
				result = Promise.resolve(active.handle.dispose());
			} catch (error: unknown) {
				result = Promise.reject(error);
			}
			operation = result.then(() => {
				active.disposeComplete = true;
			}, (error: unknown) => {
				if (active.disposeOperation === operation) {
					active.disposeOperation = undefined;
				}
				throw error;
			});
			active.disposeOperation = operation;
		}
		return active.disposeOperation;
	}

	private trackPump(pump: Promise<void>): void {
		this.pumps.add(pump);
		void pump.then(
			() => this.pumps.delete(pump),
			(error: unknown) => {
				this.pumps.delete(pump);
				this.pumpFailures.push(error);
			},
		);
	}

	private trackDeadlineOperation(operation: Promise<void>): void {
		let tracked!: Promise<void>;
		tracked = operation.catch(() => {
			this.deadlineFailures.push(
				new Error('The Agent task handle could not be stopped at its worker deadline.'),
			);
		}).finally(() => this.deadlineOperations.delete(tracked));
		this.deadlineOperations.add(tracked);
	}

	private async disposeCore(): Promise<void> {
		for (const record of this.starts.values()) {
			record.preStartAbort.abort(new MeshDomainError(
				'WORKER_DRAINING',
				'The Window Node is shutting down.',
			));
		}
		const runtimeOperation = this.disposeRuntime();
		const startOperations = [...this.starts.values()].map(({ operation }) => operation);
		await Promise.allSettled(startOperations);
		const activeTasks = [...this.starts.values()]
			.map(({ active }) => active)
			.filter((active): active is ActiveTask => active !== undefined);
		for (const active of activeTasks) {
			this.destroyGrant(active);
			active.cleanupRequired = true;
		}
		const cleanup = await Promise.allSettled(activeTasks.flatMap((active) => [
			this.cancelHandle(active),
			this.disposeHandle(active),
		]));
		await Promise.allSettled([...this.pumps]);
		const deadlineOperations = await Promise.allSettled([...this.deadlineOperations]);
		const runtime = await Promise.allSettled([runtimeOperation]);
		const deadlineFailures = this.deadlineFailures.splice(0);
		const pumpFailures = this.pumpFailures.splice(0);
		const cleanupFailures = [
			...rejectedReasons(cleanup),
			...rejectedReasons(deadlineOperations),
			...rejectedReasons(runtime),
			...deadlineFailures,
			...pumpFailures.filter((failure) => !(failure instanceof EventSinkFailure)),
		];
		if (cleanupFailures.length === 0) {
			this.starts.clear();
		}
		const failures = [
			...cleanupFailures,
			...pumpFailures.filter((failure) => failure instanceof EventSinkFailure),
		];
		if (failures.length > 0) {
			throw new WindowNodeTaskExecutorDisposalError(
				failures,
				cleanupFailures.length === 0,
			);
		}
	}

	private disposeRuntime(): Promise<void> {
		if (this.runtimeDisposal === undefined) {
			let operation!: Promise<void>;
			let result: Promise<void>;
			try {
				result = Promise.resolve(this.options.runtime.dispose());
			} catch (error: unknown) {
				result = Promise.reject(error);
			}
			operation = result.catch((error: unknown) => {
				if (this.runtimeDisposal === operation) {
					this.runtimeDisposal = undefined;
				}
				throw error;
			});
			this.runtimeDisposal = operation;
		}
		return this.runtimeDisposal;
	}

	private destroyGrant(active: ActiveTask): void {
		active.grant = undefined;
		active.delegatedExecutionContext = undefined;
	}
}

function abortablePreStartOperation<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(preStartAbortReason(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener('abort', abort);
			reject(preStartAbortReason(signal));
		};
		signal.addEventListener('abort', abort, { once: true });
		void operation.then(
			(value) => {
				signal.removeEventListener('abort', abort);
				if (!signal.aborted) {
					resolve(value);
				}
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort);
				if (!signal.aborted) {
					reject(error);
				}
			},
		);
	});
}

function preStartAbortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new MeshDomainError('WORKER_DRAINING', 'The Window Node task start was interrupted.');
}

function startFingerprint(params: NodeTaskStartParams): string {
	return createHash('sha256').update(JSON.stringify(params)).digest('hex');
}

function safeTaskText(value: string, maxBytes: number): string {
	return sanitizeDelegationText(value, maxBytes);
}

function normalizeAgentFailure(error: unknown): AgentRuntimeError {
	if (error instanceof AgentRuntimeError) {
		return error;
	}
	return new AgentRuntimeError(
		'TASK_EXECUTION_FAILED',
		'The Agent runtime task failed without a safe diagnostic.',
		false,
	);
}

function toAgentAnswer(request: AgentInputRequest, answer: string): AgentTaskAnswer {
	const normalized = answer.trim().toLowerCase();
	if (request.kind === 'toolConfirmation') {
		const selected = request.options?.find((option) =>
			option.id === answer || option.label.toLowerCase() === normalized,
		);
		return {
			requestId: request.requestId,
			outcome: selected?.approve === true || isAffirmative(normalized)
				? 'accept'
				: 'decline',
			selectedOptionId: selected?.id,
		};
	}
	if (request.kind === 'toolAuthentication') {
		return {
			requestId: request.requestId,
			outcome: isAffirmative(normalized) || normalized === 'authenticate'
				? 'accept'
				: 'decline',
		};
	}
	if (request.kind !== 'chatInput') {
		throw new MeshDomainError(
			'INPUT_NOT_PENDING',
			'The pending input kind cannot be answered safely.',
		);
	}
	const fields = request.fields ?? [];
	return {
		requestId: request.requestId,
		outcome: 'accept',
		values: Object.fromEntries(
			fields.map((field) => [field.id, parseFieldAnswer(field, answer)]),
		),
	};
}

function isStringAnswerableInput(request: AgentInputRequest): boolean {
	return request.kind !== 'chatInput'
		|| (request.fields?.every(({ type }) =>
			['string', 'number', 'integer', 'boolean', 'singleSelect', 'multiSelect'].includes(type),
		) ?? true);
}

function isKnownAgentInputKind(value: string): value is AgentInputRequest['kind'] {
	return value === 'chatInput'
		|| value === 'toolConfirmation'
		|| value === 'toolAuthentication';
}


function parseFieldAnswer(
	field: NonNullable<AgentInputRequest['fields']>[number],
	answer: string,
): string | number | boolean | readonly string[] {
	const trimmed = answer.trim();
	switch (field.type) {
		case 'string':
			return answer;
		case 'number':
		case 'integer': {
			const value = Number(trimmed);
			if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) {
				throw new MeshDomainError(
					'INPUT_NOT_PENDING',
					'The task answer is not a valid number for the pending input.',
				);
			}
			return value;
		}
		case 'boolean':
			if (isAffirmative(trimmed.toLowerCase())) {
				return true;
			}
			if (['false', 'no', 'decline', 'deny'].includes(trimmed.toLowerCase())) {
				return false;
			}
			throw new MeshDomainError(
				'INPUT_NOT_PENDING',
				'The task answer is not a valid boolean for the pending input.',
			);
		case 'singleSelect':
			return selectOption(field.options, trimmed);
		case 'multiSelect':
			return trimmed
				.split(',')
				.map((value) => selectOption(field.options, value.trim()));
	}
}

function selectOption(
	options: NonNullable<AgentInputRequest['fields']>[number]['options'],
	answer: string,
): string {
	const normalized = answer.toLowerCase();
	const selected = options?.find((option) =>
		option.id === answer || option.label.toLowerCase() === normalized,
	) ?? (
		isAffirmative(normalized)
			? options?.find((option) => /(?:^|[\s_-])(yes|approve|accept|allow)(?:$|[\s_-])/iu.test(
				`${option.id} ${option.label}`,
			))
			: undefined
	) ?? (options?.length === 1 ? options[0] : undefined);
	if (selected === undefined) {
		throw new MeshDomainError(
			'INPUT_NOT_PENDING',
			'The task answer does not match a pending input option.',
		);
	}
	return selected.id;
}

function isAffirmative(answer: string): boolean {
	return [
		'yes',
		'approve',
		'accept',
		'continue',
		'ok',
		'是',
		'可以',
		'继续',
		'同意',
		'批准',
		'确认',
		'允许',
	].includes(answer);
}

function boundUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
		return value;
	}
	let result = '';
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, 'utf8');
		if (bytes + size > maxBytes) {
			break;
		}
		result += character;
		bytes += size;
	}
	return result;
}

function boundUtf8Tail(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
		return value;
	}
	let result = '';
	let bytes = 0;
	for (const character of [...value].reverse()) {
		const size = Buffer.byteLength(character, 'utf8');
		if (bytes + size > maxBytes) {
			break;
		}
		result = character + result;
		bytes += size;
	}
	return result;
}

function structuredCompletionSummary(prefix: string, tail: string): string {
	for (const [start, end] of [
		['MESH_CONTRACT_ARTIFACT_V1_BEGIN', 'MESH_CONTRACT_ARTIFACT_V1_END'],
		['MESH_VALIDATION_RESULT_V1_BEGIN', 'MESH_VALIDATION_RESULT_V1_END'],
	] as const) {
		const startIndex = tail.lastIndexOf(start);
		const endIndex = tail.indexOf(end, startIndex + start.length);
		if (startIndex >= 0 && endIndex >= 0) {
			return tail.slice(startIndex, endIndex + end.length);
		}
	}
	return prefix;
}

function rejectedReasons(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
	return results
		.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
		.map(({ reason }) => reason);
}

function throwCleanupFailures(
	results: readonly PromiseSettledResult<unknown>[],
	message: string,
	primary?: unknown,
): void {
	const failures = rejectedReasons(results);
	if (failures.length > 0 && primary !== undefined) {
		failures.unshift(primary);
	}
	if (failures.length > 0) {
		throw new AggregateError(failures, message);
	}
}
