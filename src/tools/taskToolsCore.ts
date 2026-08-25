import {
	DelegationIntentInput,
	MeshWorkerDirectorySnapshot,
	PersistedDelegationIntent,
	TASK_TOOL_DEADLINES_MS,
	TASK_TOOL_ERROR_CODES,
	TASK_TOOL_LIMITS,
	TaskActionReceipt,
	TaskArtifactReference,
	TaskPendingInputSummary,
	TaskToolErrorCode,
	TaskToolEvent,
	TaskToolReadResult,
	TaskToolSnapshot,
	TaskValidationSummary,
} from '../../shared/toolProtocol';
import { TASK_STATUSES, TaskStatus } from '../../shared/protocol';
import { TaskToolFacade, TaskToolFacadeError } from './taskToolFacade';
import { MESH_TOOL_NAMES } from './toolManifest';

export interface ToolCancellation {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ToolClock {
	sleep(delayMs: number): Promise<void>;
}

export interface DelegateTaskInput {
	readonly peerId: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly prompt: string;
	readonly acceptanceCriteria?: readonly string[];
	readonly timeoutMinutes?: number;
}

export interface GetTaskInput {
	readonly taskId: string;
	readonly afterEventSequence?: number;
	readonly maxEvents?: number;
}

export interface CancelTaskInput {
	readonly taskId: string;
}

export interface AnswerTaskInput {
	readonly taskId: string;
	readonly inputId: string;
	readonly answerId: string;
	readonly answer: string;
}

export interface DelegateInvocationPreparation {
	readonly invocationMessage: string;
	readonly confirmationTitle: string;
	readonly confirmationMessage: string;
}

export type ToolJsonResult = Readonly<Record<string, unknown>>;

export interface TaskToolsCoreOptions {
	readonly clock?: ToolClock;
	readonly outputByteLimit?: number;
}

interface OperationSuccess<T> {
	readonly kind: 'success';
	readonly value: T;
}

interface OperationFailure {
	readonly kind: 'failure';
	readonly error: unknown;
}

interface OperationCancelled {
	readonly kind: 'cancelled';
}

interface OperationTimedOut {
	readonly kind: 'timeout';
}

type OperationOutcome<T> = OperationSuccess<T> | OperationFailure | OperationCancelled | OperationTimedOut;

const systemClock: ToolClock = {
	sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

const neverCancelled: ToolCancellation = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => undefined }),
};

const safeErrorMessages: Readonly<Record<TaskToolErrorCode, string>> = {
	INVALID_INPUT: 'The tool input does not match the required schema or byte limits.',
	OUTPUT_INVALID: 'The mesh coordinator returned an invalid response.',
	OUTPUT_TOO_LARGE: 'The bounded mesh result cannot fit in the available output budget.',
	CANCELLED: 'The current tool wait was cancelled.',
	TIMEOUT: 'The mesh operation did not acknowledge within its application deadline.',
	AUTH_REQUIRED: 'Mesh authentication is required.',
	AUTH_FAILED: 'Mesh authentication failed.',
	PROTOCOL_INCOMPATIBLE: 'The selected worker uses an incompatible mesh protocol.',
	RATE_LIMITED: 'The mesh request was rate limited.',
	WORKSPACE_NOT_FOUND: 'The selected workspace was not found.',
	WORKSPACE_DISABLED: 'The selected workspace is disabled.',
	WORKSPACE_BUSY: 'The selected workspace is busy.',
	TASK_NOT_FOUND: 'The task was not found.',
	TASK_ID_CONFLICT: 'The task identifiers conflict with a different delegation.',
	TASK_NOT_CANCELLABLE: 'The task is not cancellable in its current state.',
	INPUT_NOT_PENDING: 'The requested task input is no longer pending.',
	AGENT_UNAVAILABLE: 'The remote coding agent is unavailable.',
	AGENT_AUTH_REQUIRED: 'The remote coding agent requires authentication.',
	TASK_EXECUTION_FAILED: 'The remote task failed.',
	TASK_RECOVERY_UNAVAILABLE: 'The remote task cannot currently be recovered.',
	WORKER_DRAINING: 'The selected worker is draining and cannot accept a task.',
	REMOTE_WORKSPACE_UNSUPPORTED: 'The selected remote workspace is unsupported.',
	TUNNEL_UNAVAILABLE: 'The worker connection is unavailable.',
	WORKSPACE_UNTRUSTED: 'The selected workspace is not trusted.',
	LOCAL_FILE_WORKSPACE_REQUIRED: 'The task requires a local filesystem-backed workspace.',
	TASK_CANCELLATION_UNCONFIRMED: 'The remote task cancellation was not confirmed.',
	DELEGATION_NOT_FOUND: 'The delegation intent was not found.',
	INTERNAL_ERROR: 'The mesh operation failed without a safe diagnostic.',
};

export class TaskToolsCore {
	private readonly clock: ToolClock;
	private readonly outputByteLimit: number;

	constructor(
		private readonly facade: TaskToolFacade,
		options: TaskToolsCoreOptions = {},
	) {
		this.clock = options.clock ?? systemClock;
		this.outputByteLimit = options.outputByteLimit ?? TASK_TOOL_LIMITS.defaultOutputBytes;
		if (
			!Number.isSafeInteger(this.outputByteLimit)
			|| this.outputByteLimit < TASK_TOOL_LIMITS.minimumOutputBytes
		) {
			throw new Error(`outputByteLimit must be an integer of at least ${TASK_TOOL_LIMITS.minimumOutputBytes} bytes.`);
		}
	}

	prepareDelegateInvocation(rawInput: unknown): DelegateInvocationPreparation {
		const input = parseDelegateTaskInput(rawInput);
		const summary = input.title.replace(/\s+/g, ' ').slice(0, 160);
		return {
			invocationMessage: `Waiting up to ${TASK_TOOL_DEADLINES_MS.delegateTask / 1_000}s for worker acceptance`,
			confirmationTitle: 'Delegate this task to a mesh worker?',
			confirmationMessage: [
				`Peer: ${input.peerId}`,
				`Workspace: ${input.workspaceId}`,
				`Title: ${summary}`,
			].join('\n'),
		};
	}

	prepareCancelInvocation(rawInput: unknown): DelegateInvocationPreparation {
		const input = parseCancelTaskInput(rawInput);
		return {
			invocationMessage: 'Requesting remote task cancellation',
			confirmationTitle: 'Cancel this mesh task?',
			confirmationMessage: `Task: ${input.taskId}`,
		};
	}

	prepareAnswerInvocation(rawInput: unknown): DelegateInvocationPreparation {
		const input = parseAnswerTaskInput(rawInput);
		return {
			invocationMessage: 'Sending an answer to the remote task',
			confirmationTitle: 'Send this answer to the mesh task?',
			confirmationMessage: [
				`Task: ${input.taskId}`,
				`Input: ${input.inputId}`,
				`Answer ID: ${input.answerId}`,
			].join('\n'),
		};
	}

	async listWorkers(
		rawInput: unknown,
		cancellation: ToolCancellation = neverCancelled,
	): Promise<ToolJsonResult> {
		try {
			parseListWorkersInput(rawInput);
		} catch {
			return this.errorResult('INVALID_INPUT');
		}

		const outcome = await this.runBounded(
			(signal) => this.facade.listWorkers(signal),
			TASK_TOOL_DEADLINES_MS.listWorkers,
			cancellation,
		);
		if (outcome.kind !== 'success') {
			return this.outcomeResult(outcome);
		}

		try {
			return this.boundWorkerResult(parseWorkerDirectory(outcome.value));
		} catch {
			return this.errorResult('OUTPUT_INVALID');
		}
	}

	async delegateTask(
		rawInput: unknown,
		cancellation: ToolCancellation = neverCancelled,
	): Promise<ToolJsonResult> {
		let input: DelegationIntentInput;
		try {
			input = parseDelegateTaskInput(rawInput);
		} catch {
			return this.errorResult('INVALID_INPUT');
		}

		if (cancellation.isCancellationRequested) {
			return this.cancelledResult();
		}

		let persisted: PersistedDelegationIntent;
		try {
			persisted = parsePersistedIntent(await this.facade.persistDelegationIntent(input));
		} catch (error) {
			return this.errorFromUnknown(error);
		}

		if (cancellation.isCancellationRequested) {
			return this.delegateWaitResult('cancelled', persisted);
		}

		const outcome = await this.runBounded(
			(signal) => this.facade.waitForDelegationAcceptance({
				delegationRequestId: persisted.delegationRequestId,
				taskId: persisted.taskId,
			}, signal),
			TASK_TOOL_DEADLINES_MS.delegateTask,
			cancellation,
		);

		if (outcome.kind === 'success') {
			try {
				parseDelegationAcceptance(outcome.value);
			} catch {
				return this.delegateFailureResult(persisted, 'OUTPUT_INVALID');
			}
			return this.fitResult({
				status: 'pending',
				delegationRequestId: persisted.delegationRequestId,
				taskId: persisted.taskId,
				recovered: persisted.recovered,
				pollTool: MESH_TOOL_NAMES.getTask,
				cancelTool: MESH_TOOL_NAMES.cancelTask,
			});
		}
		if (outcome.kind === 'cancelled' || outcome.kind === 'timeout') {
			return this.delegateWaitResult(outcome.kind, persisted);
		}
		return this.delegateFailureFromUnknown(persisted, outcome.error);
	}

	async getTask(
		rawInput: unknown,
		cancellation: ToolCancellation = neverCancelled,
	): Promise<ToolJsonResult> {
		let input: Required<Pick<GetTaskInput, 'taskId' | 'maxEvents'>> & Pick<GetTaskInput, 'afterEventSequence'>;
		try {
			input = parseGetTaskInput(rawInput);
		} catch {
			return this.errorResult('INVALID_INPUT');
		}

		const outcome = await this.runBounded(
			(signal) => this.facade.getTask(input, signal),
			TASK_TOOL_DEADLINES_MS.getTask,
			cancellation,
		);
		if (outcome.kind !== 'success') {
			return this.outcomeResult(outcome);
		}

		try {
			return this.boundTaskResult(parseTaskReadResult(outcome.value, input.maxEvents));
		} catch {
			return this.errorResult('OUTPUT_INVALID');
		}
	}

	async cancelTask(
		rawInput: unknown,
		cancellation: ToolCancellation = neverCancelled,
	): Promise<ToolJsonResult> {
		let input: CancelTaskInput;
		try {
			input = parseCancelTaskInput(rawInput);
		} catch {
			return this.errorResult('INVALID_INPUT');
		}

		const outcome = await this.runBounded(
			(signal) => this.facade.cancelOwnedTask(input, signal),
			TASK_TOOL_DEADLINES_MS.cancelTask,
			cancellation,
		);
		return this.actionOutcomeResult(outcome);
	}

	async answerTask(
		rawInput: unknown,
		cancellation: ToolCancellation = neverCancelled,
	): Promise<ToolJsonResult> {
		let input: AnswerTaskInput;
		try {
			input = parseAnswerTaskInput(rawInput);
		} catch {
			return this.errorResult('INVALID_INPUT');
		}

		const outcome = await this.runBounded(
			(signal) => this.facade.answerOwnedTask(input, signal),
			TASK_TOOL_DEADLINES_MS.answerTask,
			cancellation,
		);
		return this.actionOutcomeResult(outcome);
	}

	private async runBounded<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		deadlineMs: number,
		cancellation: ToolCancellation,
	): Promise<OperationOutcome<T>> {
		if (cancellation.isCancellationRequested) {
			return { kind: 'cancelled' };
		}

		const abortController = new AbortController();
		let signalCancellation: (() => void) | undefined;
		const cancellationPromise = new Promise<OperationCancelled>((resolve) => {
			signalCancellation = () => resolve({ kind: 'cancelled' });
		});
		const subscription = cancellation.onCancellationRequested(() => signalCancellation?.());
		const operationPromise = Promise.resolve()
			.then(() => operation(abortController.signal))
			.then<OperationOutcome<T>, OperationOutcome<T>>(
				(value) => ({ kind: 'success', value }),
				(error: unknown) => ({ kind: 'failure', error }),
			);

		try {
			const outcome = await Promise.race([
				operationPromise,
				this.clock.sleep(deadlineMs).then<OperationTimedOut>(() => ({ kind: 'timeout' })),
				cancellationPromise,
			]);
			if (outcome.kind !== 'success' && outcome.kind !== 'failure') {
				abortController.abort();
			}
			return outcome;
		} finally {
			subscription.dispose();
			signalCancellation = undefined;
		}
	}

	private actionOutcomeResult(outcome: OperationOutcome<TaskActionReceipt>): ToolJsonResult {
		if (outcome.kind !== 'success') {
			return this.outcomeResult(outcome);
		}
		try {
			const receipt = parseTaskActionReceipt(outcome.value);
			return this.fitResult({
				status: 'ok',
				taskId: receipt.taskId,
				taskStatus: receipt.status,
			});
		} catch {
			return this.errorResult('OUTPUT_INVALID');
		}
	}

	private outcomeResult(outcome: Exclude<OperationOutcome<unknown>, OperationSuccess<unknown>>): ToolJsonResult {
		if (outcome.kind === 'cancelled') {
			return this.cancelledResult();
		}
		if (outcome.kind === 'timeout') {
			return this.fitResult({
				status: 'timeout',
				error: {
					code: 'TIMEOUT',
					message: safeErrorMessages.TIMEOUT,
					retryable: true,
				},
			});
		}
		return this.errorFromUnknown(outcome.error);
	}

	private cancelledResult(): ToolJsonResult {
		return this.fitResult({
			status: 'cancelled',
			error: {
				code: 'CANCELLED',
				message: safeErrorMessages.CANCELLED,
				retryable: true,
			},
		});
	}

	private delegateWaitResult(
		status: 'cancelled' | 'timeout',
		persisted: PersistedDelegationIntent,
	): ToolJsonResult {
		const code = status === 'cancelled' ? 'CANCELLED' : 'TIMEOUT';
		return this.fitResult({
			status,
			delegationRequestId: persisted.delegationRequestId,
			taskId: persisted.taskId,
			recovered: persisted.recovered,
			pollTool: MESH_TOOL_NAMES.getTask,
			cancelTool: MESH_TOOL_NAMES.cancelTask,
			error: {
				code,
				message: status === 'cancelled'
					? 'The current acknowledgement wait was cancelled; the durable delegation remains available for polling or explicit cancellation.'
					: 'Worker acceptance was not confirmed before the application deadline; the durable delegation remains available for polling or explicit cancellation.',
				retryable: true,
			},
		});
	}

	private errorFromUnknown(error: unknown): ToolJsonResult {
		if (error instanceof TaskToolFacadeError && TASK_TOOL_ERROR_CODES.includes(error.code)) {
			return this.errorResult(error.code, error.retryable);
		}
		return this.errorResult('INTERNAL_ERROR');
	}

	private delegateFailureFromUnknown(
		persisted: PersistedDelegationIntent,
		error: unknown,
	): ToolJsonResult {
		if (error instanceof TaskToolFacadeError && TASK_TOOL_ERROR_CODES.includes(error.code)) {
			return this.delegateFailureResult(persisted, error.code, error.retryable);
		}
		return this.delegateFailureResult(persisted, 'INTERNAL_ERROR');
	}

	private delegateFailureResult(
		persisted: PersistedDelegationIntent,
		code: TaskToolErrorCode,
		retryable = false,
	): ToolJsonResult {
		return this.fitResult({
			status: 'error',
			delegationRequestId: persisted.delegationRequestId,
			taskId: persisted.taskId,
			recovered: persisted.recovered,
			pollTool: MESH_TOOL_NAMES.getTask,
			cancelTool: MESH_TOOL_NAMES.cancelTask,
			error: {
				code,
				message: safeErrorMessages[code],
				retryable,
			},
		});
	}

	private errorResult(code: TaskToolErrorCode, retryable = false): ToolJsonResult {
		return this.fitResult({
			status: 'error',
			error: {
				code,
				message: safeErrorMessages[code],
				retryable,
			},
		});
	}

	private boundWorkerResult(directory: MeshWorkerDirectorySnapshot): ToolJsonResult {
		const workers: Array<{
			peerId: string;
			deviceName: string;
			capabilities: string[];
			workspaces: Array<{
				workspaceId: string;
				name: string;
				tags: string[];
				busy: boolean;
			}>;
		}> = [];
		const result: {
			status: string;
			workers: typeof workers;
			truncated: boolean;
		} = { status: 'ok', workers, truncated: false };

		for (const sourceWorker of directory.workers) {
			const worker = {
				peerId: sourceWorker.peerId,
				deviceName: sourceWorker.deviceName,
				capabilities: [] as string[],
				workspaces: [] as Array<{
					workspaceId: string;
					name: string;
					tags: string[];
					busy: boolean;
				}>,
			};
			workers.push(worker);
			if (utf8JsonBytes(result) > this.outputByteLimit) {
				workers.pop();
				result.truncated = true;
				break;
			}

			for (const capability of sourceWorker.capabilities) {
				worker.capabilities.push(capability);
				if (utf8JsonBytes(result) > this.outputByteLimit) {
					worker.capabilities.pop();
					result.truncated = true;
					break;
				}
			}
			if (result.truncated) {
				break;
			}

			for (const sourceWorkspace of sourceWorker.workspaces) {
				const workspace = {
					workspaceId: sourceWorkspace.workspaceId,
					name: sourceWorkspace.name,
					tags: [] as string[],
					busy: sourceWorkspace.busy,
				};
				worker.workspaces.push(workspace);
				if (utf8JsonBytes(result) > this.outputByteLimit) {
					worker.workspaces.pop();
					result.truncated = true;
					break;
				}
				for (const tag of sourceWorkspace.tags) {
					workspace.tags.push(tag);
					if (utf8JsonBytes(result) > this.outputByteLimit) {
						workspace.tags.pop();
						result.truncated = true;
						break;
					}
				}
				if (result.truncated) {
					break;
				}
			}
			if (result.truncated) {
				break;
			}
		}
		return this.fitResult(result);
	}

	private boundTaskResult(read: TaskToolReadResult): ToolJsonResult {
		const result: {
			status: string;
			snapshot: TaskToolSnapshot;
			eventCursor: number;
			events: TaskToolEvent[];
			eventGap?: TaskToolReadResult['eventGap'];
			truncated: boolean;
		} = {
			status: 'ok',
			snapshot: { ...read.snapshot },
			eventCursor: read.eventCursor,
			events: read.events.map((event) => ({ ...event })),
			...(read.eventGap === undefined ? {} : { eventGap: { ...read.eventGap } }),
			truncated: read.truncated,
		};

		while (utf8JsonBytes(result) > this.outputByteLimit && result.events.length > 0) {
			result.events.shift();
			result.truncated = true;
		}
		if (utf8JsonBytes(result) > this.outputByteLimit && result.snapshot.artifacts !== undefined) {
			result.snapshot = { ...result.snapshot, artifacts: [] };
			result.truncated = true;
		}
		if (utf8JsonBytes(result) > this.outputByteLimit && result.snapshot.summary !== undefined) {
			result.snapshot = { ...result.snapshot, summary: boundedUtf8(result.snapshot.summary, 256) };
			result.truncated = true;
		}
		return this.fitResult(result);
	}

	private fitResult(result: Record<string, unknown>): ToolJsonResult {
		if (utf8JsonBytes(result) <= this.outputByteLimit) {
			return result;
		}
		const fallback = {
			status: 'error',
			error: {
				code: 'OUTPUT_TOO_LARGE',
				message: safeErrorMessages.OUTPUT_TOO_LARGE,
				retryable: false,
			},
		};
		if (utf8JsonBytes(fallback) > this.outputByteLimit) {
			throw new Error('outputByteLimit cannot hold the minimum safe result.');
		}
		return fallback;
	}
}

export function parseListWorkersInput(value: unknown): Record<string, never> {
	const input = expectRecord(value, 'input');
	expectExactKeys(input, []);
	return {};
}

export function parseDelegateTaskInput(value: unknown): DelegationIntentInput {
	const input = expectRecord(value, 'input');
	expectExactKeys(input, ['peerId', 'workspaceId', 'title', 'prompt', 'acceptanceCriteria', 'timeoutMinutes']);
	const peerId = expectString(input.peerId, 'peerId', TASK_TOOL_LIMITS.idBytes);
	const workspaceId = expectString(input.workspaceId, 'workspaceId', TASK_TOOL_LIMITS.idBytes);
	const title = expectString(input.title, 'title', TASK_TOOL_LIMITS.titleBytes);
	const prompt = expectString(input.prompt, 'prompt', TASK_TOOL_LIMITS.promptBytes);
	const acceptanceCriteria = input.acceptanceCriteria === undefined
		? []
		: expectStringArray(
			input.acceptanceCriteria,
			'acceptanceCriteria',
			TASK_TOOL_LIMITS.acceptanceCriteriaCount,
			TASK_TOOL_LIMITS.acceptanceCriterionBytes,
		);
	const timeoutMinutes = input.timeoutMinutes === undefined
		? undefined
		: expectInteger(input.timeoutMinutes, 'timeoutMinutes', 1, 1_440);
	return {
		peerId,
		workspaceId,
		title,
		prompt,
		acceptanceCriteria,
		...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
	};
}

export function parseGetTaskInput(
	value: unknown,
): Required<Pick<GetTaskInput, 'taskId' | 'maxEvents'>> & Pick<GetTaskInput, 'afterEventSequence'> {
	const input = expectRecord(value, 'input');
	expectExactKeys(input, ['taskId', 'afterEventSequence', 'maxEvents']);
	const taskId = expectString(input.taskId, 'taskId', TASK_TOOL_LIMITS.idBytes);
	const afterEventSequence = input.afterEventSequence === undefined
		? undefined
		: expectInteger(input.afterEventSequence, 'afterEventSequence', 0, Number.MAX_SAFE_INTEGER);
	const maxEvents = input.maxEvents === undefined
		? 20
		: expectInteger(input.maxEvents, 'maxEvents', 1, TASK_TOOL_LIMITS.maxEvents);
	return {
		taskId,
		maxEvents,
		...(afterEventSequence === undefined ? {} : { afterEventSequence }),
	};
}

export function parseCancelTaskInput(value: unknown): CancelTaskInput {
	const input = expectRecord(value, 'input');
	expectExactKeys(input, ['taskId']);
	return { taskId: expectString(input.taskId, 'taskId', TASK_TOOL_LIMITS.idBytes) };
}

export function parseAnswerTaskInput(value: unknown): AnswerTaskInput {
	const input = expectRecord(value, 'input');
	expectExactKeys(input, ['taskId', 'inputId', 'answerId', 'answer']);
	return {
		taskId: expectString(input.taskId, 'taskId', TASK_TOOL_LIMITS.idBytes),
		inputId: expectString(input.inputId, 'inputId', TASK_TOOL_LIMITS.idBytes),
		answerId: expectString(input.answerId, 'answerId', TASK_TOOL_LIMITS.idBytes),
		answer: expectString(input.answer, 'answer', TASK_TOOL_LIMITS.answerBytes),
	};
}

export async function fitToolResultToTokenBudget(
	value: ToolJsonResult,
	tokenBudget: number,
	countTokens: (text: string) => PromiseLike<number>,
): Promise<ToolJsonResult> {
	if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1) {
		return { status: 'error', error: { code: 'OUTPUT_TOO_LARGE' } };
	}

	let candidate = value;
	while (await countTokens(JSON.stringify(candidate)) > tokenBudget) {
		const smaller = shrinkToolResult(candidate);
		if (smaller === undefined) {
			const fallback = { status: 'error', error: { code: 'OUTPUT_TOO_LARGE' } };
			if (await countTokens(JSON.stringify(fallback)) <= tokenBudget) {
				return fallback;
			}
			return { status: 'error' };
		}
		candidate = smaller;
	}
	return candidate;
}

function parseWorkerDirectory(value: unknown): MeshWorkerDirectorySnapshot {
	const directory = expectRecord(value, 'worker directory');
	expectExactKeys(directory, ['workers']);
	const workers = expectArray(directory.workers, 'workers', TASK_TOOL_LIMITS.maxWorkers).map((workerValue) => {
		const worker = expectRecord(workerValue, 'worker');
		expectExactKeys(worker, ['peerId', 'deviceName', 'capabilities', 'workspaces']);
		const workspaces = expectArray(
			worker.workspaces,
			'workspaces',
			TASK_TOOL_LIMITS.maxWorkspacesPerWorker,
		).map((workspaceValue) => {
			const workspace = expectRecord(workspaceValue, 'workspace');
			expectExactKeys(workspace, ['workspaceId', 'name', 'tags', 'busy']);
			return {
				workspaceId: expectString(workspace.workspaceId, 'workspaceId', TASK_TOOL_LIMITS.idBytes),
				name: expectString(workspace.name, 'workspace name', TASK_TOOL_LIMITS.workspaceNameBytes),
				tags: expectStringArray(
					workspace.tags,
					'workspace tags',
					TASK_TOOL_LIMITS.maxCapabilitiesPerWorker,
					TASK_TOOL_LIMITS.capabilityBytes,
				),
				busy: expectBoolean(workspace.busy, 'busy'),
			};
		});
		return {
			peerId: expectString(worker.peerId, 'peerId', TASK_TOOL_LIMITS.idBytes),
			deviceName: expectString(worker.deviceName, 'deviceName', TASK_TOOL_LIMITS.deviceNameBytes),
			capabilities: expectStringArray(
				worker.capabilities,
				'capabilities',
				TASK_TOOL_LIMITS.maxCapabilitiesPerWorker,
				TASK_TOOL_LIMITS.capabilityBytes,
			),
			workspaces,
		};
	});
	return { workers };
}

function parsePersistedIntent(value: unknown): PersistedDelegationIntent {
	const persisted = expectRecord(value, 'persisted delegation intent');
	expectExactKeys(persisted, ['delegationRequestId', 'taskId', 'recovered']);
	return {
		delegationRequestId: expectString(
			persisted.delegationRequestId,
			'delegationRequestId',
			TASK_TOOL_LIMITS.idBytes,
		),
		taskId: expectString(persisted.taskId, 'taskId', TASK_TOOL_LIMITS.idBytes),
		recovered: expectBoolean(persisted.recovered, 'recovered'),
	};
}

function parseDelegationAcceptance(value: unknown): void {
	const acceptance = expectRecord(value, 'delegation acceptance');
	expectExactKeys(acceptance, ['status']);
	if (acceptance.status !== 'accepted') {
		throw new Error('delegation acceptance status is invalid.');
	}
}

function parseTaskReadResult(value: unknown, requestedMaxEvents: number): TaskToolReadResult {
	const read = expectRecord(value, 'task read result');
	expectExactKeys(read, ['snapshot', 'eventCursor', 'events', 'eventGap', 'truncated']);
	const events = expectArray(read.events, 'events', requestedMaxEvents).map(parseTaskEvent);
	const eventGap = read.eventGap === undefined ? undefined : parseEventGap(read.eventGap);
	return {
		snapshot: parseTaskSnapshot(read.snapshot),
		eventCursor: expectInteger(read.eventCursor, 'eventCursor', 0, Number.MAX_SAFE_INTEGER),
		events,
		...(eventGap === undefined ? {} : { eventGap }),
		truncated: expectBoolean(read.truncated, 'truncated'),
	};
}

function parseTaskSnapshot(value: unknown): TaskToolSnapshot {
	const snapshot = expectRecord(value, 'task snapshot');
	expectExactKeys(snapshot, [
		'taskId',
		'status',
		'title',
		'updatedAt',
		'phase',
		'summary',
		'validation',
		'artifacts',
		'pendingInput',
	]);
	const status = expectTaskStatus(snapshot.status);
	const phase = optionalString(snapshot.phase, 'phase', 256);
	const summary = optionalString(snapshot.summary, 'summary', 16 * 1024);
	const validation = snapshot.validation === undefined ? undefined : parseValidation(snapshot.validation);
	const artifacts = snapshot.artifacts === undefined
		? undefined
		: expectArray(snapshot.artifacts, 'artifacts', TASK_TOOL_LIMITS.maxArtifacts).map(parseArtifact);
	const pendingInput = snapshot.pendingInput === undefined
		? undefined
		: parsePendingInput(snapshot.pendingInput);
	return {
		taskId: expectString(snapshot.taskId, 'taskId', TASK_TOOL_LIMITS.idBytes),
		status,
		title: expectString(snapshot.title, 'title', TASK_TOOL_LIMITS.titleBytes),
		updatedAt: expectTimestamp(snapshot.updatedAt, 'updatedAt'),
		...(phase === undefined ? {} : { phase }),
		...(summary === undefined ? {} : { summary }),
		...(validation === undefined ? {} : { validation }),
		...(artifacts === undefined ? {} : { artifacts }),
		...(pendingInput === undefined ? {} : { pendingInput }),
	};
}

function parseTaskEvent(value: unknown): TaskToolEvent {
	const event = expectRecord(value, 'task event');
	expectExactKeys(event, ['sequence', 'type', 'at', 'summary']);
	return {
		sequence: expectInteger(event.sequence, 'sequence', 0, Number.MAX_SAFE_INTEGER),
		type: expectString(event.type, 'event type', 128),
		at: expectTimestamp(event.at, 'event time'),
		summary: expectString(event.summary, 'event summary', 16 * 1024),
	};
}

function parseEventGap(value: unknown): TaskToolReadResult['eventGap'] {
	const gap = expectRecord(value, 'event gap');
	expectExactKeys(gap, ['expectedFrom', 'availableFrom']);
	return {
		expectedFrom: expectInteger(gap.expectedFrom, 'expectedFrom', 0, Number.MAX_SAFE_INTEGER),
		availableFrom: expectInteger(gap.availableFrom, 'availableFrom', 0, Number.MAX_SAFE_INTEGER),
	};
}

function parseValidation(value: unknown): TaskValidationSummary {
	const validation = expectRecord(value, 'validation');
	expectExactKeys(validation, ['status', 'summary']);
	if (validation.status !== 'passed' && validation.status !== 'failed' && validation.status !== 'notRun') {
		throw new Error('validation status is invalid.');
	}
	const summary = optionalString(validation.summary, 'validation summary', 16 * 1024);
	return {
		status: validation.status,
		...(summary === undefined ? {} : { summary }),
	};
}

function parseArtifact(value: unknown): TaskArtifactReference {
	const artifact = expectRecord(value, 'artifact');
	expectExactKeys(artifact, ['artifactId', 'label', 'mediaType']);
	const mediaType = optionalString(artifact.mediaType, 'mediaType', 256);
	return {
		artifactId: expectString(artifact.artifactId, 'artifactId', TASK_TOOL_LIMITS.idBytes),
		label: expectString(artifact.label, 'artifact label', 512),
		...(mediaType === undefined ? {} : { mediaType }),
	};
}

function parsePendingInput(value: unknown): TaskPendingInputSummary {
	const pendingInput = expectRecord(value, 'pending input');
	expectExactKeys(pendingInput, ['inputId', 'prompt', 'choices']);
	const choices = pendingInput.choices === undefined
		? undefined
		: expectStringArray(pendingInput.choices, 'choices', 32, 4 * 1024);
	return {
		inputId: expectString(pendingInput.inputId, 'inputId', TASK_TOOL_LIMITS.idBytes),
		prompt: expectString(pendingInput.prompt, 'input prompt', 16 * 1024),
		...(choices === undefined ? {} : { choices }),
	};
}

function parseTaskActionReceipt(value: unknown): TaskActionReceipt {
	const receipt = expectRecord(value, 'task action receipt');
	expectExactKeys(receipt, ['taskId', 'status']);
	return {
		taskId: expectString(receipt.taskId, 'taskId', TASK_TOOL_LIMITS.idBytes),
		status: expectTaskStatus(receipt.status),
	};
}

function expectTaskStatus(value: unknown): TaskStatus {
	const status = TASK_STATUSES.find((candidate) => candidate === value);
	if (status === undefined) {
		throw new Error('task status is invalid.');
	}
	return status;
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${field} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function expectExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
	const allowed = new Set(allowedKeys);
	if (Object.keys(value).some((key) => !allowed.has(key))) {
		throw new Error('object contains an unsupported property.');
	}
}

function expectString(value: unknown, field: string, maxBytes: number): string {
	if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
		throw new Error(`${field} is invalid.`);
	}
	return value;
}

function optionalString(value: unknown, field: string, maxBytes: number): string | undefined {
	return value === undefined ? undefined : expectString(value, field, maxBytes);
}

function expectStringArray(
	value: unknown,
	field: string,
	maxItems: number,
	maxItemBytes: number,
): readonly string[] {
	return expectArray(value, field, maxItems).map((item) => expectString(item, field, maxItemBytes));
}

function expectArray(value: unknown, field: string, maxItems: number): readonly unknown[] {
	if (!Array.isArray(value) || value.length > maxItems) {
		throw new Error(`${field} must be an array with at most ${maxItems} items.`);
	}
	return value;
}

function expectBoolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') {
		throw new Error(`${field} must be a boolean.`);
	}
	return value;
}

function expectInteger(value: unknown, field: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
	}
	return value as number;
}

function expectTimestamp(value: unknown, field: string): string {
	const timestamp = expectString(value, field, 64);
	if (!Number.isFinite(Date.parse(timestamp))) {
		throw new Error(`${field} must be an ISO timestamp.`);
	}
	return timestamp;
}

function utf8JsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function boundedUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
		return value;
	}
	let end = Math.min(value.length, maxBytes);
	while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) {
		end -= 1;
	}
	return value.slice(0, end);
}

function shrinkToolResult(value: ToolJsonResult): ToolJsonResult | undefined {
	if (Array.isArray(value.events) && value.events.length > 0) {
		return {
			...value,
			events: value.events.slice(1),
			truncated: true,
		};
	}
	if (Array.isArray(value.workers) && value.workers.length > 0) {
		return {
			...value,
			workers: value.workers.slice(0, -1),
			truncated: true,
		};
	}
	if (isRecord(value.snapshot)) {
		const snapshot = value.snapshot;
		if (snapshot.summary !== undefined) {
			const { summary: _summary, ...withoutSummary } = snapshot;
			return { ...value, snapshot: withoutSummary, truncated: true };
		}
		if (snapshot.artifacts !== undefined) {
			const { artifacts: _artifacts, ...withoutArtifacts } = snapshot;
			return { ...value, snapshot: withoutArtifacts, truncated: true };
		}
		if (snapshot.pendingInput !== undefined) {
			const { pendingInput: _pendingInput, ...withoutPendingInput } = snapshot;
			return { ...value, snapshot: withoutPendingInput, truncated: true };
		}
	}
	if (isRecord(value.error) && (value.error.message !== undefined || value.error.retryable !== undefined)) {
		const { message: _message, retryable: _retryable, ...compactError } = value.error;
		return { ...value, error: compactError };
	}
	if (value.recovered !== undefined) {
		const { recovered: _recovered, ...withoutRecovered } = value;
		return withoutRecovered;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
