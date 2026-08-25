import { randomUUID } from 'node:crypto';

import {
	ACTIVE_TASK_STATUSES,
	type TaskSnapshot,
	type TaskSnapshotAfterEventSeq,
	type TaskStatus,
} from '../../shared/protocol';
import type {
	AgentInputRequest,
	AgentRuntime,
	AgentRuntimeEvent,
	AgentTaskAnswer,
	AgentTaskHandle,
} from '../agentHost/AgentRuntime';
import { AgentRuntimeError } from '../agentHost/AgentRuntime';
import { MeshDomainError } from '../domain/errors';
import {
	canonicalTaskRequestHash,
	createAcceptedTask,
	type OwnedTaskStart,
	type TaskRecord,
} from '../domain/task';
import type { TaskDomainEvent } from '../domain/taskReducer';
import { GatewayValidationError, type TaskService, type TaskStartParams } from '../gateway/GatewayRouter';
import type { FileTaskStore } from '../tasks/FileTaskStore';
import type { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import type { WorkspaceRegistry, LocalWorkspace } from '../workspaces/WorkspaceRegistry';
import type { LocalDesktopWorkspaceGuard } from './LocalDesktopWorkspaceGuard';
import type { WorkerOwnership } from '../storage/WorkerOwnerLock';
import {
	disabledE2eCapability,
	isE2eCapabilityEnabled,
	type E2eCapability,
} from '../composition/E2eCapability';

const activeStates = new Set<string>(ACTIVE_TASK_STATUSES);
const defaultCancellationDeadlineMs = 15_000;

export interface LocalTaskConfirmation {
	confirm(
		peerId: string,
		request: TaskStartParams,
		workspace: LocalWorkspace,
	): Promise<boolean>;
}

export interface TaskNotificationSink {
	publish(record: TaskRecord, event: TaskDomainEvent): Promise<void> | void;
}

export interface RemoteTaskRunnerOptions {
	readonly cancellationDeadlineMs?: number;
	readonly id?: () => string;
	readonly now?: () => Date;
	readonly notificationSink?: TaskNotificationSink;
	readonly onDidChange?: () => void;
	readonly ownership?: WorkerOwnership;
	readonly e2eCapability?: E2eCapability;
}

interface RunningTask {
	readonly peerId: string;
	readonly taskId: string;
	readonly workspaceLeaseKey: string;
	handle?: AgentTaskHandle;
	pending?: {
		readonly publicInputId: string;
		readonly request: AgentInputRequest;
	};
	outputSummary: string;
	cancellationTimer?: NodeJS.Timeout;
	deadlineTimer?: NodeJS.Timeout;
	stopBeforeStart?: boolean;
}

export class RemoteTaskRunner implements TaskService {
	private readonly running = new Map<string, RunningTask>();
	private readonly operations = new Set<Promise<void>>();
	private readonly startOperations = new Set<Promise<unknown>>();
	private readonly shutdown = new AbortController();
	private readonly cancellationDeadlineMs: number;
	private readonly id: () => string;
	private readonly now: () => Date;
	private startMutation = Promise.resolve();
	private readonly runtimeHandleCancellationRequests = new Set<string>();
	private disposed = false;

	public constructor(
		private readonly deviceId: string,
		private readonly runtime: AgentRuntime,
		private readonly workspaces: WorkspaceRegistry,
		private readonly store: FileTaskStore,
		private readonly leases: WorkspaceLeaseManager,
		private readonly guard: LocalDesktopWorkspaceGuard,
		private readonly confirmation: LocalTaskConfirmation,
		private readonly options: RemoteTaskRunnerOptions = {},
	) {
		this.cancellationDeadlineMs = options.cancellationDeadlineMs ?? defaultCancellationDeadlineMs;
		this.id = options.id ?? randomUUID;
		this.now = options.now ?? (() => new Date());
	}

	public async initialize(): Promise<void> {
		await this.options.ownership?.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		const active = await this.store.listForRecovery();
		this.leases.restoreFromTaskRecords(active);
		for (const record of active) {
			const failed = await this.store.transitionOwned(record.peerId, record.taskId, {
				type: 'failed',
				at: this.now().toISOString(),
				code: 'TASK_RECOVERY_UNAVAILABLE',
				message: 'The Agent Host session could not be recovered after extension restart.',
				retryable: true,
			});
			this.leases.releaseForPersistedTerminal(failed);
			this.changed();
		}
	}

	public start(authenticatedPeerId: string, params: TaskStartParams): Promise<TaskSnapshot> {
		this.assertActive();
		return this.trackStart(
			this.serializeStart(() => this.startCore(authenticatedPeerId, params)),
		);
	}

	private async startCore(
		authenticatedPeerId: string,
		params: TaskStartParams,
	): Promise<TaskSnapshot> {
		this.assertActive();
		await this.options.ownership?.assertOwner();
		this.guard.assertAllowed();
		const previous = (await this.store.list()).find((record) =>
			record.peerId === authenticatedPeerId
			&& (
				record.taskId === params.taskId
				|| record.delegationRequestId === params.delegationRequestId
			),
		);
		if (previous !== undefined) {
			const idempotent = await this.store.findIdempotentStart({
				...params,
				acceptanceCriteria: [...params.acceptanceCriteria],
				peerId: authenticatedPeerId,
				workspaceLeaseKey: previous.workspaceLeaseKey,
			});
			if (idempotent !== undefined) {
				return this.snapshot(idempotent);
			}
		}
		const workspace = await this.workspaces.resolveEnabled(params.workspaceId);
		const request: OwnedTaskStart = {
			...params,
			acceptanceCriteria: [...params.acceptanceCriteria],
			peerId: authenticatedPeerId,
			workspaceLeaseKey: workspace.fileIdentity,
		};
		const existing = await this.store.findIdempotentStart(request);
		if (existing !== undefined) {
			return this.snapshot(existing);
		}
		const probe = await this.runtime.probe();
		if (!probe.featureEnabled || !probe.available) {
			throw new AgentRuntimeError(
				probe.reason ?? 'AGENT_UNAVAILABLE',
				'The production Agent Host runtime is unavailable or disabled.',
				true,
			);
		}

		const at = this.now().toISOString();
		const accepted = createAcceptedTask(request, at);
		this.leases.acquire(workspace.fileIdentity, authenticatedPeerId, params.taskId);
		let persisted: TaskRecord;
		try {
			const result = await this.store.createIdempotent(request, accepted);
			persisted = result.record;
			if (!result.created) {
				this.leases.release(workspace.fileIdentity, authenticatedPeerId, params.taskId);
				return this.snapshot(persisted);
			}
		} catch (error) {
			this.leases.release(workspace.fileIdentity, authenticatedPeerId, params.taskId);
			throw error;
		}
		if (this.disposed) {
			const failed = await this.store.transitionOwned(authenticatedPeerId, params.taskId, {
				type: 'failed',
				at: this.now().toISOString(),
				code: 'TASK_EXECUTION_FAILED',
				message: 'The worker shut down while accepting the task.',
				retryable: true,
			});
			this.leases.releaseForPersistedTerminal(failed);
			throw new MeshDomainError('WORKER_DRAINING', 'The worker is shutting down.');
		}

		const running: RunningTask = {
			peerId: authenticatedPeerId,
			taskId: params.taskId,
			workspaceLeaseKey: workspace.fileIdentity,
			outputSummary: '',
		};
		this.running.set(runningKey(authenticatedPeerId, params.taskId), running);
		this.scheduleWorkerDeadline(running, params.workerDeadline);
		this.changed();
		this.track(this.runAccepted(running, params, workspace));
		return this.snapshot(persisted);
	}

	public async get(
		authenticatedPeerId: string,
		taskId: string,
		afterEventSeq?: number,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq> {
		this.assertActive();
		await this.options.ownership?.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		const record = await this.requireOwned(authenticatedPeerId, taskId);
		return afterEventSeq === undefined
			? this.snapshot(record)
			: this.snapshot(record, afterEventSeq);
	}

	public async cancel(authenticatedPeerId: string, taskId: string): Promise<TaskSnapshot> {
		this.assertActive();
		await this.options.ownership?.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		const record = await this.requireOwned(authenticatedPeerId, taskId);
		if (!activeStates.has(record.state)) {
			throw new MeshDomainError('TASK_NOT_CANCELLABLE', 'The task is no longer cancellable.');
		}
		if (record.state === 'cancelling') {
			return this.snapshot(record);
		}
		const deadline = new Date(this.now().valueOf() + this.cancellationDeadlineMs).toISOString();
		const updated = await this.transition(authenticatedPeerId, taskId, {
			type: 'cancelRequested',
			at: this.now().toISOString(),
			cancellationDeadline: deadline,
		});
		const running = this.running.get(runningKey(authenticatedPeerId, taskId));
		if (running?.handle === undefined) {
			if (running !== undefined) {
				running.stopBeforeStart = true;
				await this.finish(running, {
					type: 'cancelConfirmed',
					at: this.now().toISOString(),
					summary: 'Task cancellation was confirmed before Agent Host startup.',
				});
			} else {
				await this.failCancellation(authenticatedPeerId, taskId);
			}
		} else {
			this.scheduleCancellationDeadline(running);
			try {
				if (isE2eCapabilityEnabled(this.options.e2eCapability ?? disabledE2eCapability)) {
					this.runtimeHandleCancellationRequests.add(taskId);
				}
				await running.handle.cancel();
			} catch {
				await this.failCancellation(authenticatedPeerId, taskId);
			}
		}
		return this.snapshot(updated);
	}

	public runtimeHandleCancellationObservedForE2e(taskId: string): boolean {
		if (!isE2eCapabilityEnabled(this.options.e2eCapability ?? disabledE2eCapability)) {
			throw new Error('Runtime cancellation evidence is available only to the opted-in two-device E2E.');
		}
		const observed = this.runtimeHandleCancellationRequests.has(taskId);
		this.runtimeHandleCancellationRequests.delete(taskId);
		return observed;
	}

	public async answer(
		authenticatedPeerId: string,
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
	): Promise<TaskSnapshot> {
		this.assertActive();
		await this.options.ownership?.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		const record = await this.requireOwned(authenticatedPeerId, taskId);
		if (record.answeredInputs[inputId] === answerId) {
			return this.snapshot(record);
		}
		if (record.state !== 'needsInput' || record.pendingInput?.inputId !== inputId) {
			throw new MeshDomainError('INPUT_NOT_PENDING', 'The requested input is not pending.');
		}
		const running = this.running.get(runningKey(authenticatedPeerId, taskId));
		if (running?.handle === undefined || running.pending?.publicInputId !== inputId) {
			throw new MeshDomainError('INPUT_NOT_PENDING', 'The requested input is not available.');
		}
		await running.handle.answer(toAgentAnswer(running.pending.request, answer));
		running.pending = undefined;
		const updated = await this.transition(authenticatedPeerId, taskId, {
			type: 'inputAnswered',
			at: this.now().toISOString(),
			inputId,
			answerId,
		});
		return this.snapshot(updated);
	}

	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.shutdown.abort();
		await Promise.allSettled([...this.startOperations]);
		for (const running of this.running.values()) {
			running.stopBeforeStart = true;
			if (running.cancellationTimer !== undefined) {
				clearTimeout(running.cancellationTimer);
			}
			if (running.deadlineTimer !== undefined) {
				clearTimeout(running.deadlineTimer);
			}
			await running.handle?.cancel().catch(() => undefined);
			await running.handle?.dispose().catch(() => undefined);
		}
		await this.runtime.dispose().catch(() => undefined);
		await Promise.allSettled([...this.operations]);
		this.running.clear();
	}

	private async runAccepted(
		running: RunningTask,
		params: TaskStartParams,
		workspace: LocalWorkspace,
	): Promise<void> {
		try {
			const confirmed = await raceShutdown(
				this.confirmation.confirm(running.peerId, params, workspace),
				this.shutdown.signal,
			);
			if (confirmed === undefined) {
				await this.fail(
					running,
					'TASK_EXECUTION_FAILED',
					'The worker shut down before local task approval completed.',
					true,
				);
				return;
			}
			if (!confirmed) {
				await this.fail(running, 'TASK_EXECUTION_FAILED', 'The local user denied this remote task.', false);
				return;
			}
			if (running.stopBeforeStart) {
				return;
			}
			const starting = await this.transition(running.peerId, running.taskId, {
				type: 'agentStartRequested',
				at: this.now().toISOString(),
			});
			if (starting.state !== 'startingAgent') {
				return;
			}
			const handle = await this.runtime.start({
				taskId: params.taskId,
				title: params.title,
				prompt: params.prompt,
				acceptanceCriteria: params.acceptanceCriteria,
				workspaceId: params.workspaceId,
				allowInteractiveAuthentication: true,
				approvalContext: {
					peerId: running.peerId,
					workspaceId: params.workspaceId,
					requestHash: canonicalTaskRequestHash({
						...params,
						acceptanceCriteria: [...params.acceptanceCriteria],
						peerId: running.peerId,
						workspaceLeaseKey: workspace.fileIdentity,
					}),
				},
			});
			const current = await this.store.getOwned(running.peerId, running.taskId);
			if (running.stopBeforeStart || current?.state !== 'startingAgent') {
				await handle.dispose();
				return;
			}
			running.handle = handle;
			await this.transition(running.peerId, running.taskId, {
				type: 'agentStarted',
				at: this.now().toISOString(),
				recoveryDescriptor: {
					adapter: 'ahp',
					sessionId: handle.recovery.sessionUri,
					conversationId: handle.recovery.chatUri,
				},
			});
			for await (const event of handle.events) {
				await this.consume(running, event);
			}
			const afterEvents = await this.store.getOwned(running.peerId, running.taskId);
			if (afterEvents !== undefined && activeStates.has(afterEvents.state)) {
				await this.fail(running, 'TASK_EXECUTION_FAILED', 'The Agent Host task ended without a terminal event.', true);
			}
		} catch (error) {
			const normalized = normalizeAgentFailure(error);
			await this.fail(running, normalized.code, normalized.message, normalized.retryable);
		} finally {
			if (running.cancellationTimer !== undefined) {
				clearTimeout(running.cancellationTimer);
			}
			if (running.deadlineTimer !== undefined) {
				clearTimeout(running.deadlineTimer);
			}
			await running.handle?.dispose().catch(() => undefined);
			const current = await this.store.getOwned(running.peerId, running.taskId).catch(() => undefined);
			if (current !== undefined && !activeStates.has(current.state)) {
				this.leases.releaseForPersistedTerminal(current);
			}
			const key = runningKey(running.peerId, running.taskId);
			if (this.running.get(key) === running) {
				this.running.delete(key);
			}
			this.changed();
		}
	}

	private async consume(running: RunningTask, event: AgentRuntimeEvent): Promise<void> {
		switch (event.type) {
			case 'progress':
				await this.transition(running.peerId, running.taskId, {
					type: 'progress',
					at: this.now().toISOString(),
					summary: boundUtf8(event.message, 16_384),
				});
				return;
			case 'output':
				running.outputSummary = boundUtf8(running.outputSummary + event.text, 16_384);
				await this.transition(running.peerId, running.taskId, {
					type: 'output',
					at: this.now().toISOString(),
					summary: boundUtf8(event.text, 16_384),
				});
				return;
			case 'outputTruncated':
				await this.transition(running.peerId, running.taskId, {
					type: 'outputTruncated',
					at: this.now().toISOString(),
					summary: boundUtf8(event.message, 16_384),
				});
				return;
			case 'tool':
				await this.transition(running.peerId, running.taskId, {
					type: 'tool',
					at: this.now().toISOString(),
					summary: boundUtf8(`${event.name}: ${event.status}${event.summary === undefined ? '' : ` — ${event.summary}`}`, 16_384),
				});
				return;
			case 'terminal':
				await this.transition(running.peerId, running.taskId, {
					type: 'terminal',
					at: this.now().toISOString(),
					summary: boundUtf8(event.summary, 16_384),
				});
				return;
			case 'inputRequired': {
				if (!isStringAnswerableInput(event.request)) {
					await this.fail(
						running,
						'TASK_EXECUTION_FAILED',
						'The Agent Host requested structured input that this protocol version cannot answer safely.',
						false,
					);
					await running.handle?.cancel().catch(() => undefined);
					return;
				}
				const publicInputId = this.id();
				running.pending = { publicInputId, request: event.request };
				await this.transition(running.peerId, running.taskId, {
					type: 'inputRequired',
					at: this.now().toISOString(),
					inputId: publicInputId,
					prompt: boundUtf8(event.request.prompt, 32 * 1_024),
				});
				return;
			}
			case 'completed':
				await this.finish(running, {
					type: 'completed',
					at: this.now().toISOString(),
					summary: running.outputSummary || 'Task completed.',
				});
				return;
			case 'cancelled': {
				const current = await this.requireOwned(running.peerId, running.taskId);
				if (current.state !== 'cancelling') {
					await this.transition(running.peerId, running.taskId, {
						type: 'cancelRequested',
						at: this.now().toISOString(),
						cancellationDeadline: this.now().toISOString(),
					});
				}
				await this.finish(running, {
					type: 'cancelConfirmed',
					at: this.now().toISOString(),
					summary: 'Task cancellation was confirmed.',
				});
				return;
			}
			case 'failed':
				await this.fail(
					running,
					event.error.code,
					event.error.message,
					event.error.retryable,
				);
				return;
		}
	}

	private async transition(
		peerId: string,
		taskId: string,
		event: TaskDomainEvent,
	): Promise<TaskRecord> {
		const record = await this.store.transitionOwned(peerId, taskId, event);
		await Promise.resolve(this.options.notificationSink?.publish(record, event))
			.catch(() => undefined);
		this.changed();
		return record;
	}

	private async finish(running: RunningTask, event: TaskDomainEvent): Promise<void> {
		const record = await this.transition(running.peerId, running.taskId, event);
		if (!activeStates.has(record.state)) {
			this.leases.releaseForPersistedTerminal(record);
		}
	}

	private async fail(
		running: RunningTask,
		code: string,
		message: string,
		retryable: boolean,
	): Promise<void> {
		const current = await this.store.getOwned(running.peerId, running.taskId);
		if (current === undefined || !activeStates.has(current.state)) {
			return;
		}
		await this.finish(running, {
			type: 'failed',
			at: this.now().toISOString(),
			code: boundUtf8(code, 128),
			message: boundUtf8(message, 2_048),
			retryable,
		});
	}

	private async failCancellation(peerId: string, taskId: string): Promise<void> {
		const running = this.running.get(runningKey(peerId, taskId));
		if (running !== undefined) {
			if (running.cancellationTimer !== undefined) {
				clearTimeout(running.cancellationTimer);
				running.cancellationTimer = undefined;
			}
			await this.fail(
				running,
				'TASK_CANCELLATION_UNCONFIRMED',
				'Task cancellation was not confirmed before the deadline.',
				true,
			);
			await running.handle?.dispose().catch(() => undefined);
		}
	}

	private scheduleCancellationDeadline(running: RunningTask): void {
		running.cancellationTimer = setTimeout(() => {
			this.track(this.failCancellation(running.peerId, running.taskId));
		}, this.cancellationDeadlineMs);
	}

	private scheduleWorkerDeadline(running: RunningTask, workerDeadline: string): void {
		const delay = Math.max(0, Date.parse(workerDeadline) - this.now().valueOf());
		const maximumTimerDelay = 2_147_483_647;
		running.deadlineTimer = setTimeout(() => {
			if (delay > maximumTimerDelay) {
				this.scheduleWorkerDeadline(running, workerDeadline);
			} else {
				this.track(this.timeOut(running));
			}
		}, Math.min(delay, maximumTimerDelay));
	}

	private async timeOut(running: RunningTask): Promise<void> {
		const current = await this.store.getOwned(running.peerId, running.taskId);
		if (current === undefined || !activeStates.has(current.state)) {
			return;
		}
		running.stopBeforeStart = true;
		const record = await this.transition(running.peerId, running.taskId, {
			type: 'timedOut',
			at: this.now().toISOString(),
			message: 'The task exceeded its worker deadline.',
		});
		this.leases.releaseForPersistedTerminal(record);
		await running.handle?.cancel().catch(() => undefined);
		await running.handle?.dispose().catch(() => undefined);
	}

	private async requireOwned(peerId: string, taskId: string): Promise<TaskRecord> {
		const record = await this.store.getOwned(peerId, taskId);
		if (record === undefined || record.peerId !== peerId) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'Task not found.');
		}
		return record;
	}

	private snapshot(record: TaskRecord): TaskSnapshot;
	private snapshot(record: TaskRecord, afterEventSeq: number): TaskSnapshotAfterEventSeq;
	private snapshot(
		record: TaskRecord,
		afterEventSeq?: number,
	): TaskSnapshot | TaskSnapshotAfterEventSeq {
		const {
			recoveryDescriptor: _recoveryDescriptor,
			answeredInputs: _answeredInputs,
			workspaceLeaseKey: _workspaceLeaseKey,
			...wire
		} = record;
		if (afterEventSeq === undefined) {
			return { ...wire, deviceId: this.deviceId };
		}
		if (!Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0 || afterEventSeq > record.eventSeq) {
			throw new GatewayValidationError('The requested event sequence is invalid.');
		}
		const earliest = record.earliestAvailableEventSeq ?? 1;
		const eventsTruncated = afterEventSeq + 1 < earliest;
		return {
			...wire,
			deviceId: this.deviceId,
			afterEventSeq,
			events: record.events.filter((event) => event.eventSeq > afterEventSeq),
			eventsTruncated,
			...(record.eventsTruncated ? { earliestAvailableEventSeq: earliest } : {}),
		};
	}

	private track(operation: Promise<void>): void {
		let tracked!: Promise<void>;
		tracked = operation.catch(() => undefined).finally(() => this.operations.delete(tracked));
		this.operations.add(tracked);
	}

	private serializeStart<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.startMutation.then(operation, operation);
		this.startMutation = result.then(() => undefined, () => undefined);
		return result;
	}

	private trackStart<T>(operation: Promise<T>): Promise<T> {
		let tracked!: Promise<T>;
		tracked = operation.finally(() => this.startOperations.delete(tracked));
		this.startOperations.add(tracked);
		return tracked;
	}

	private changed(): void {
		this.options.onDidChange?.();
	}

	private assertActive(): void {
		if (this.disposed) {
			throw new MeshDomainError('WORKER_DRAINING', 'The worker is shutting down.');
		}
	}
}

export class WorkerTaskService extends RemoteTaskRunner {}

function normalizeAgentFailure(error: unknown): AgentRuntimeError {
	if (error instanceof AgentRuntimeError) {
		return error;
	}
	return new AgentRuntimeError(
		'TASK_EXECUTION_FAILED',
		'The Agent Host task failed without a safe diagnostic.',
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
			outcome: selected?.approve === true || ['yes', 'approve', 'accept'].includes(normalized)
				? 'accept'
				: 'decline',
			selectedOptionId: selected?.id,
		};
	}
	if (request.kind === 'toolAuthentication') {
		return {
			requestId: request.requestId,
			outcome: ['yes', 'approve', 'accept', 'authenticate'].includes(normalized)
				? 'accept'
				: 'decline',
		};
	}
	return {
		requestId: request.requestId,
		outcome: 'accept',
		values: request.fields?.[0] === undefined
			? {}
			: { [request.fields[0].id]: answer },
	};
}

function isStringAnswerableInput(request: AgentInputRequest): boolean {
	if (request.kind !== 'chatInput') {
		return true;
	}
	const fields = request.fields ?? [];
	return fields.length <= 1 && fields.every((field) => field.type === 'string');
}

function runningKey(peerId: string, taskId: string): string {
	return `${peerId}:${taskId}`;
}

function raceShutdown<T>(operation: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) {
		return Promise.resolve(undefined);
	}
	return new Promise<T | undefined>((resolve, reject) => {
		const aborted = (): void => resolve(undefined);
		signal.addEventListener('abort', aborted, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener('abort', aborted);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', aborted);
				reject(error);
			},
		);
	});
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
