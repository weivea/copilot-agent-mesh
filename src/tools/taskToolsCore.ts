import { randomUUID } from 'node:crypto';

import {
	DelegationIntentInput,
	DelegationIdentity,
	MeshDirectorySnapshot,
	PersistedDelegationIntent,
	TASK_TOOL_DEADLINES_MS,
	TASK_TOOL_ERROR_CODES,
	TASK_TOOL_LIMITS,
	TaskActionReceipt,
	TaskArtifactReference,
	TaskFailureSummary,
	TaskPendingInputSummary,
	TaskToolErrorCode,
	TaskToolEvent,
	TaskToolReadResult,
	TaskToolSnapshot,
	TaskValidationSummary,
} from '../../shared/toolProtocol';
import {
	TASK_STATUSES,
	type DelegatedExecutionContext,
	TaskStatus,
} from '../../shared/protocol';
import {
	DelegationWaiter,
	type DelegationOutcome,
	type ToolCancellation,
	type ToolClock,
} from './DelegationWaiter';
import { sanitizeDelegationText } from './DelegationTextSanitizer';
import { TaskToolFacade, TaskToolFacadeError } from './taskToolFacade';
import { MESH_TOOL_NAMES } from './toolManifest';
import type { DelegatedToolInvocationRegistry } from './DelegatedToolInvocationRegistry';

export type { ToolCancellation, ToolClock } from './DelegationWaiter';

export interface ToolDeadlineTimer {
	readonly promise: Promise<void>;
	dispose(): void;
}

export interface DelegateTaskInput {
	readonly delegationRequestId?: string;
	readonly deviceId: string;
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly workspaceId: string;
	readonly peerId?: string;
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
	readonly id?: () => string;
	readonly delegatedToolInvocations?: DelegatedToolInvocationRegistry;
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
	createTimer: (delayMs) => {
		let handle: NodeJS.Timeout | undefined;
		const promise = new Promise<void>((resolve) => {
			handle = setTimeout(resolve, delayMs);
		});
		return {
			promise,
			dispose: () => {
				if (handle !== undefined) {
					clearTimeout(handle);
					handle = undefined;
				}
			},
		};
	},
};

const neverCancelled: ToolCancellation = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => undefined }),
};

const canonicalIdentifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
	IDEMPOTENCY_CONFLICT: 'The delegation request ID is already bound to different task semantics.',
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
	PEER_NOT_ALLOWED: 'The source workspace has not allowlisted the target window.',
	PEER_NOT_ACCEPTING: 'The target window is not accepting incoming tasks.',
	PEER_OFFLINE: 'The exact target window workspace claim is offline.',
	PEER_MULTI_WORKSPACE: 'The target window must claim exactly one workspace.',
	WINDOW_NAME_CONFLICT: 'The requested window name is already in use.',
	POLICY_FORBIDDEN: 'The caller cannot modify that peer policy.',
	DELEGATION_RECURSION: 'A delegated child task cannot delegate another task.',
	ARTIFACT_NOT_FOUND: 'The required artifact was not found.',
	ARTIFACT_FORBIDDEN: 'The artifact is not authorized for this task.',
	ARTIFACT_INVALID: 'The artifact failed its bounded JSON policy.',
	ARTIFACT_CORRUPT: 'The artifact failed its integrity check.',
	ARTIFACT_LIMIT_EXCEEDED: 'The artifact count or byte limit was exceeded.',
	INTERNAL_ERROR: 'The mesh operation failed without a safe diagnostic.',
};

export class TaskToolsCore {
	private readonly clock: ToolClock;
	private readonly outputByteLimit: number;
	private readonly id: () => string;
	private readonly delegatedToolInvocations: DelegatedToolInvocationRegistry | undefined;

	constructor(
		private readonly facade: TaskToolFacade,
		options: TaskToolsCoreOptions = {},
	) {
		this.clock = options.clock ?? systemClock;
		this.outputByteLimit = options.outputByteLimit ?? TASK_TOOL_LIMITS.defaultOutputBytes;
		this.id = options.id ?? randomUUID;
		this.delegatedToolInvocations = options.delegatedToolInvocations;
		if (
			!Number.isSafeInteger(this.outputByteLimit)
			|| this.outputByteLimit < TASK_TOOL_LIMITS.minimumOutputBytes
		) {
			throw new Error(`outputByteLimit must be an integer of at least ${TASK_TOOL_LIMITS.minimumOutputBytes} bytes.`);
		}
	}

	async prepareDelegateInvocation(
		rawInput: unknown,
		cancellation: ToolCancellation = neverCancelled,
	): Promise<DelegateInvocationPreparation> {
		const input = parseDelegateTaskInput(rawInput);
		const displayOutcome = await this.runBounded(
			(signal) => {
				if (this.facade.describeDelegationTarget === undefined) {
					throw new TaskToolFacadeError('OUTPUT_INVALID');
				}
				return this.facade.describeDelegationTarget(input, signal);
			},
			TASK_TOOL_DEADLINES_MS.listWorkers,
			cancellation,
		);
		if (displayOutcome.kind !== 'success') {
			throw new Error('The selected delegation target is unavailable.');
		}
		const windowName = safeDelegationText(displayOutcome.value.windowName, 256);
		const workspaceName = safeDelegationText(displayOutcome.value.workspaceName, 256);
		const summary = safeDelegationText(input.title, TASK_TOOL_LIMITS.titleBytes);
		return {
			invocationMessage: `Delegating to “${windowName}”…`,
			confirmationTitle: `Delegate to “${windowName}”`,
			confirmationMessage: [
				`Target window: ${windowName}`,
				`Workspace: ${workspaceName}`,
				`Task: ${summary}`,
				'Continue grants approval for this task only.',
				'Automatically approved: non-control-plane structured file changes proven to stay inside this Workspace.',
				'Terminal commands, execution/instruction-control files, and operations without authoritative path evidence still require confirmation.',
				'Never auto-approved: network authentication, cross-Workspace writes, secret access, external publishing, or Workspace command configuration.',
				'The task may run for at most 60 minutes.',
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
		let input: DelegationIntentInput & {
			readonly delegationRequestId: string;
			readonly timeoutMinutes: number;
		};
		let delegatedExecutionContext: DelegatedExecutionContext | undefined;
		try {
			const parsed = parseDelegateTaskInput(rawInput);
			delegatedExecutionContext = this.delegatedToolInvocations?.consume(parsed);
			input = {
				...parsed,
				delegationRequestId: parsed.delegationRequestId ?? this.id(),
				timeoutMinutes: parsed.timeoutMinutes
					?? TASK_TOOL_LIMITS.defaultTimeoutMinutes,
			};
		} catch {
			return this.errorResult('INVALID_INPUT');
		}

		let identity: DelegationIdentity;
		try {
			if (this.facade.identifyDelegation === undefined) {
				throw new TaskToolFacadeError('OUTPUT_INVALID');
			}
			identity = this.facade.identifyDelegation(input);
			input = {
				...input,
				sourceWorkspaceIdentity: identity.sourceWorkspaceIdentity,
			};
		} catch (error: unknown) {
			return this.errorFromUnknown(error);
		}
		const timeoutMinutes = input.timeoutMinutes;
		const waiter = new DelegationWaiter({
			taskId: identity.taskId,
			timeoutMinutes,
			cancellation,
			clock: this.clock,
			subscribe: (listener, onError) => {
				if (this.facade.subscribeToTask === undefined) {
					throw new TaskToolFacadeError('OUTPUT_INVALID');
				}
				return this.facade.subscribeToTask(identity.taskId, listener, onError);
			},
			start: async (onTaskAvailable) => {
				const persisted = parsePersistedIntent(
					await this.facade.persistDelegationIntent(input, delegatedExecutionContext),
				);
				if (
					persisted.taskId !== identity.taskId
					|| persisted.delegationRequestId !== identity.delegationRequestId
				) {
					throw new TaskToolFacadeError('OUTPUT_INVALID');
				}
				onTaskAvailable();
				const read = await this.facade.getTask(
					{ taskId: identity.taskId, maxEvents: 1 },
					new AbortController().signal,
				);
				return parseTaskReadResult(read, 1).snapshot;
			},
			cancel: async () => {
				try {
					const receipt = await this.facade.cancelOwnedTask(
						{ taskId: identity.taskId },
						new AbortController().signal,
					);
					if (receipt.taskId !== identity.taskId) {
						throw new TaskToolFacadeError('OUTPUT_INVALID');
					}
				} catch (error: unknown) {
					if (
						!(error instanceof TaskToolFacadeError)
						|| error.code !== 'TASK_NOT_CANCELLABLE'
					) {
						throw error;
					}
				}
				const read = await this.facade.getTask(
					{ taskId: identity.taskId, maxEvents: 1 },
					new AbortController().signal,
				);
				return parseTaskReadResult(read, 1).snapshot;
			},
			sanitizeText: (value) => safeDelegationText(
				value,
				TASK_TOOL_LIMITS.errorMessageBytes,
			),
		});
		return this.fitDelegationResult(this.compactDelegationOutcome(
			await waiter.wait(),
			identity.delegationRequestId,
		));
	}

	private compactDelegationOutcome(
		outcome: DelegationOutcome,
		delegationRequestId: string,
	): ToolJsonResult {
		switch (outcome.kind) {
			case 'completed':
				return {
					s: 0,
					t: outcome.taskId,
					d: delegationRequestId,
					r: outcome.result,
				};
			case 'needsInput':
				return {
					s: 1,
					t: outcome.taskId,
					d: delegationRequestId,
					i: outcome.inputId,
					q: safeDelegationText(outcome.question, TASK_TOOL_LIMITS.errorMessageBytes),
				};
			case 'failed':
				return {
					s: 2,
					t: outcome.taskId,
					d: delegationRequestId,
					e: normalizeErrorCode(outcome.code),
				};
			case 'cancelled':
				return {
					s: 3,
					t: outcome.taskId,
					d: delegationRequestId,
					e: outcome.code,
					x: outcome.reason,
				};
		}
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
			const read = parseTaskReadResult(
				outcome.value,
				input.maxEvents,
				input.afterEventSequence,
			);
			if (read.snapshot.taskId !== input.taskId) {
				return this.errorResult('OUTPUT_INVALID');
			}
			return this.boundTaskResult(read, input.afterEventSequence ?? 0);
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
		return this.actionOutcomeResult(outcome, input.taskId);
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
		return this.actionOutcomeResult(outcome, input.taskId);
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
		const deadline = this.clock.createTimer(deadlineMs);
		const operationPromise = Promise.resolve()
			.then(() => operation(abortController.signal))
			.then<OperationOutcome<T>, OperationOutcome<T>>(
				(value) => ({ kind: 'success', value }),
				(error: unknown) => ({ kind: 'failure', error }),
			);

		try {
			const outcome = await Promise.race([
				operationPromise,
				deadline.promise.then<OperationTimedOut>(() => ({ kind: 'timeout' })),
				cancellationPromise,
			]);
			if (outcome.kind !== 'success' && outcome.kind !== 'failure') {
				abortController.abort();
			}
			return outcome;
		} finally {
			deadline.dispose();
			subscription.dispose();
			signalCancellation = undefined;
		}
	}

	private actionOutcomeResult(
		outcome: OperationOutcome<TaskActionReceipt>,
		expectedTaskId: string,
	): ToolJsonResult {
		if (outcome.kind !== 'success') {
			return this.outcomeResult(outcome);
		}
		try {
			const receipt = parseTaskActionReceipt(outcome.value);
			if (receipt.taskId !== expectedTaskId) {
				return this.errorResult('OUTPUT_INVALID');
			}
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

	private errorFromUnknown(error: unknown): ToolJsonResult {
		if (error instanceof TaskToolFacadeError && TASK_TOOL_ERROR_CODES.includes(error.code)) {
			return this.errorResult(error.code, error.retryable);
		}
		return this.errorResult('INTERNAL_ERROR');
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

	private boundWorkerResult(directory: MeshDirectorySnapshot): ToolJsonResult {
		const devices: Array<{
			deviceId: string;
			deviceName: string;
			locality: 'local' | 'remote';
			status: 'online' | 'incompatible';
			peerId?: string;
			nodes: Array<{
				nodeId: string;
				nodeInstanceId: string;
				label: string;
				status: 'online' | 'busy' | 'offline' | 'conflict' | 'draining';
				capabilities: string[];
				workspaces: Array<{
					workspaceId: string;
					name: string;
					tags: string[];
					busy: boolean;
					claimStatus: 'claimed' | 'readOnly' | 'conflict';
				}>;
			}>;
		}> = [];
		const result: {
			status: string;
			devices: typeof devices;
			truncated: boolean;
		} = { status: 'ok', devices, truncated: false };
		const sourceTruncated = directory.truncated
			|| directory.devices.some(({ nodesTruncated }) => nodesTruncated);

		for (const sourceDevice of directory.devices) {
			const device = {
				deviceId: sourceDevice.deviceId,
				deviceName: sourceDevice.deviceName,
				locality: sourceDevice.locality,
				status: sourceDevice.status,
				...(sourceDevice.peerId === undefined ? {} : { peerId: sourceDevice.peerId }),
				nodes: [] as typeof devices[number]['nodes'],
			};
			devices.push(device);
			if (utf8JsonBytes(result) > this.outputByteLimit) {
				devices.pop();
				result.truncated = true;
				break;
			}

			for (const sourceNode of sourceDevice.nodes) {
				const node = {
					nodeId: sourceNode.nodeId,
					nodeInstanceId: sourceNode.nodeInstanceId,
					label: sourceNode.label,
					status: sourceNode.status,
					capabilities: [] as string[],
					workspaces: [] as typeof devices[number]['nodes'][number]['workspaces'],
				};
				device.nodes.push(node);
				if (utf8JsonBytes(result) > this.outputByteLimit) {
					device.nodes.pop();
					result.truncated = true;
					break;
				}
				for (const capability of sourceNode.capabilities) {
					node.capabilities.push(capability);
					if (utf8JsonBytes(result) > this.outputByteLimit) {
						node.capabilities.pop();
						result.truncated = true;
						break;
					}
				}
				if (result.truncated) {
					break;
				}
				for (const sourceWorkspace of sourceNode.workspaces) {
					const workspace = {
						workspaceId: sourceWorkspace.workspaceId,
						name: sourceWorkspace.name,
						tags: [] as string[],
						busy: sourceWorkspace.busy,
						claimStatus: sourceWorkspace.claimStatus,
					};
					node.workspaces.push(workspace);
					if (utf8JsonBytes(result) > this.outputByteLimit) {
						node.workspaces.pop();
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
			if (result.truncated) {
				break;
			}
		}
		result.truncated ||= sourceTruncated;
		return this.fitResult(result);
	}

	private boundTaskResult(read: TaskToolReadResult, afterEventSequence: number): ToolJsonResult {
		const result: {
			status: string;
			snapshot: TaskToolSnapshot;
			eventCursor: number;
			events: TaskToolEvent[];
			eventGap?: TaskToolReadResult['eventGap'];
			answerTool?: typeof MESH_TOOL_NAMES.answerTask;
			truncated: boolean;
		} = {
			status: 'ok',
			snapshot: {
				taskId: read.snapshot.taskId,
				status: read.snapshot.status,
				title: safeDelegationText(read.snapshot.title, TASK_TOOL_LIMITS.titleBytes),
				updatedAt: read.snapshot.updatedAt,
				...(read.snapshot.phase === undefined
					? {}
					: {
						phase: safeDelegationText(
							read.snapshot.phase,
							TASK_TOOL_LIMITS.errorMessageBytes,
						),
					}),
				...(read.snapshot.summary === undefined
					? {}
					: {
						summary: safeDelegationText(
							read.snapshot.summary,
							TASK_TOOL_LIMITS.errorMessageBytes,
						),
					}),
				...(read.snapshot.validation === undefined
					? {}
					: {
						validation: {
							status: read.snapshot.validation.status,
							...(read.snapshot.validation.summary === undefined
								? {}
								: {
									summary: safeDelegationText(
										read.snapshot.validation.summary,
										TASK_TOOL_LIMITS.errorMessageBytes,
									),
								}),
						},
					}),
				...(read.snapshot.artifacts === undefined
					? {}
					: {
						artifacts: read.snapshot.artifacts.map((artifact) => ({
							artifactId: artifact.artifactId,
							label: safeDelegationText(
								artifact.label,
								TASK_TOOL_LIMITS.errorMessageBytes,
							),
							...(artifact.mediaType === undefined
								? {}
								: {
									mediaType: safeDelegationText(
										artifact.mediaType,
										TASK_TOOL_LIMITS.errorMessageBytes,
									),
								}),
						})),
					}),
				...(read.snapshot.pendingInput === undefined
					? {}
					: {
						pendingInput: {
							inputId: read.snapshot.pendingInput.inputId,
							prompt: safeDelegationText(
								read.snapshot.pendingInput.prompt,
								TASK_TOOL_LIMITS.errorMessageBytes,
							),
							...(read.snapshot.pendingInput.choices === undefined
								? {}
								: {
									choices: read.snapshot.pendingInput.choices.map((choice) =>
										safeDelegationText(
											choice,
											TASK_TOOL_LIMITS.errorMessageBytes,
										)),
								}),
						},
					}),
				...(read.snapshot.failure === undefined
					? {}
					: {
						failure: {
							code: safeDelegationText(
								read.snapshot.failure.code,
								TASK_TOOL_LIMITS.errorMessageBytes,
							),
							message: safeDelegationText(
								read.snapshot.failure.message,
								TASK_TOOL_LIMITS.errorMessageBytes,
							),
							retryable: read.snapshot.failure.retryable,
						},
					}),
			},
			eventCursor: read.eventCursor,
			events: read.events.map((event) => ({
				sequence: event.sequence,
				type: safeDelegationText(event.type, TASK_TOOL_LIMITS.errorMessageBytes),
				at: event.at,
				summary: safeDelegationText(
					event.summary,
					TASK_TOOL_LIMITS.errorMessageBytes,
				),
			})),
			...(read.eventGap === undefined ? {} : { eventGap: { ...read.eventGap } }),
			...(read.snapshot.status === 'needsInput' ? { answerTool: MESH_TOOL_NAMES.answerTask } : {}),
			truncated: read.truncated,
		};

		while (utf8JsonBytes(result) > this.outputByteLimit && result.events.length > 0) {
			const removed = result.events.shift();
			if (removed === undefined) {
				break;
			}
			result.eventGap = {
				expectedFrom: result.eventGap?.expectedFrom ?? afterEventSequence + 1,
				availableFrom: removed.sequence + 1,
			};
			result.truncated = true;
		}
		if (result.events.length === 0 && result.eventGap !== undefined) {
			result.eventCursor = afterEventSequence;
		}
		while (
			utf8JsonBytes(result) > this.outputByteLimit
			&& result.snapshot.artifacts !== undefined
			&& result.snapshot.artifacts.length > 0
		) {
			result.snapshot = {
				...result.snapshot,
				artifacts: result.snapshot.artifacts.slice(0, -1),
			};
			result.truncated = true;
		}
		if (
			utf8JsonBytes(result) > this.outputByteLimit
			&& result.snapshot.artifacts !== undefined
		) {
			const { artifacts: _artifacts, ...withoutArtifacts } = result.snapshot;
			result.snapshot = withoutArtifacts;
			result.truncated = true;
		}
		while (
			utf8JsonBytes(result) > this.outputByteLimit
			&& result.snapshot.summary !== undefined
			&& Buffer.byteLength(result.snapshot.summary, 'utf8') > 32
		) {
			result.snapshot = {
				...result.snapshot,
				summary: halveUtf8(result.snapshot.summary, 32),
			};
			result.truncated = true;
		}
		if (
			utf8JsonBytes(result) > this.outputByteLimit
			&& result.snapshot.summary !== undefined
		) {
			const { summary: _summary, ...withoutSummary } = result.snapshot;
			result.snapshot = withoutSummary;
			result.truncated = true;
		}
		if (
			utf8JsonBytes(result) > this.outputByteLimit
			&& result.snapshot.phase !== undefined
		) {
			const { phase: _phase, ...withoutPhase } = result.snapshot;
			result.snapshot = withoutPhase;
			result.truncated = true;
		}
		while (
			utf8JsonBytes(result) > this.outputByteLimit
			&& Buffer.byteLength(result.snapshot.title, 'utf8') > 1
		) {
			result.snapshot = {
				...result.snapshot,
				title: halveUtf8(result.snapshot.title, 1),
			};
			result.truncated = true;
		}
		while (
			utf8JsonBytes(result) > this.outputByteLimit
			&& result.snapshot.validation?.summary !== undefined
		) {
			const validationSummary = result.snapshot.validation.summary;
			result.snapshot = {
				...result.snapshot,
				validation: Buffer.byteLength(validationSummary, 'utf8') > 128
					? { ...result.snapshot.validation, summary: halveUtf8(validationSummary, 128) }
					: { status: result.snapshot.validation.status },
			};
			result.truncated = true;
		}
		while (
			utf8JsonBytes(result) > this.outputByteLimit
			&& result.snapshot.failure !== undefined
			&& Buffer.byteLength(result.snapshot.failure.message, 'utf8') > 1
		) {
			result.snapshot = {
				...result.snapshot,
				failure: {
					...result.snapshot.failure,
					message: halveUtf8(result.snapshot.failure.message, 1),
				},
			};
			result.truncated = true;
		}
		while (
			utf8JsonBytes(result) > this.outputByteLimit
			&& result.snapshot.pendingInput?.choices !== undefined
			&& result.snapshot.pendingInput.choices.length > 0
		) {
			result.snapshot = {
				...result.snapshot,
				pendingInput: {
					...result.snapshot.pendingInput,
					choices: result.snapshot.pendingInput.choices.slice(0, -1),
				},
			};
			result.truncated = true;
		}
		if (
			utf8JsonBytes(result) > this.outputByteLimit
			&& result.snapshot.pendingInput?.choices !== undefined
		) {
			const { choices: _choices, ...withoutChoices } = result.snapshot.pendingInput;
			result.snapshot = {
				...result.snapshot,
				pendingInput: withoutChoices,
			};
			result.truncated = true;
		}
		while (
			utf8JsonBytes(result) > this.outputByteLimit
			&& result.snapshot.pendingInput !== undefined
			&& Buffer.byteLength(result.snapshot.pendingInput.prompt, 'utf8') > 1
		) {
			result.snapshot = {
				...result.snapshot,
				pendingInput: {
					...result.snapshot.pendingInput,
					prompt: halveUtf8(result.snapshot.pendingInput.prompt, 1),
				},
			};
			result.truncated = true;
		}
		if (
			utf8JsonBytes(result) > this.outputByteLimit
			&& result.snapshot.validation !== undefined
		) {
			const { validation: _validation, ...withoutValidation } = result.snapshot;
			result.snapshot = withoutValidation;
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

	private fitDelegationResult(result: ToolJsonResult): ToolJsonResult {
		let candidate = result;
		while (utf8JsonBytes(candidate) > this.outputByteLimit) {
			const smaller = shrinkCompactDelegationResult(candidate);
			if (smaller === undefined || utf8JsonBytes(smaller) >= utf8JsonBytes(candidate)) {
				const fallback = compactDelegationOutputFailure(candidate);
				if (fallback === undefined) {
					throw new Error('Compact delegation result is missing required identity.');
				}
				candidate = fallback;
				break;
			}
			candidate = smaller;
		}
		if (utf8JsonBytes(candidate) > this.outputByteLimit) {
			throw new Error('outputByteLimit cannot hold compact delegation identity.');
		}
		return candidate;
	}
}

export function parseListWorkersInput(value: unknown): Record<string, never> {
	const input = expectRecord(value, 'input');
	expectExactKeys(input, []);
	return {};
}

export function parseDelegateTaskInput(value: unknown): DelegationIntentInput {
	const input = expectRecord(value, 'input');
	expectExactKeys(input, [
		'delegationRequestId',
		'deviceId',
		'nodeId',
		'nodeInstanceId',
		'peerId',
		'workspaceId',
		'title',
		'prompt',
		'acceptanceCriteria',
		'timeoutMinutes',
	]);
	const delegationRequestId = input.delegationRequestId === undefined
		? undefined
		: expectIdentifier(input.delegationRequestId, 'delegationRequestId');
	const deviceId = expectIdentifier(input.deviceId, 'deviceId');
	const nodeId = expectIdentifier(input.nodeId, 'nodeId');
	const nodeInstanceId = expectIdentifier(input.nodeInstanceId, 'nodeInstanceId');
	const peerId = input.peerId === undefined ? undefined : expectIdentifier(input.peerId, 'peerId');
	const workspaceId = expectIdentifier(input.workspaceId, 'workspaceId');
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
		: expectInteger(
			input.timeoutMinutes,
			'timeoutMinutes',
			1,
			TASK_TOOL_LIMITS.maxTimeoutMinutes,
		);
	return {
		...(delegationRequestId === undefined ? {} : { delegationRequestId }),
		deviceId,
		nodeId,
		nodeInstanceId,
		workspaceId,
		...(peerId === undefined ? {} : { peerId }),
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
	const taskId = expectIdentifier(input.taskId, 'taskId');
	const afterEventSequence = input.afterEventSequence === undefined
		? undefined
		: expectInteger(input.afterEventSequence, 'afterEventSequence', 0, Number.MAX_SAFE_INTEGER - 1);
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
	return { taskId: expectIdentifier(input.taskId, 'taskId') };
}

export function parseAnswerTaskInput(value: unknown): AnswerTaskInput {
	const input = expectRecord(value, 'input');
	expectExactKeys(input, ['taskId', 'inputId', 'answerId', 'answer']);
	return {
		taskId: expectIdentifier(input.taskId, 'taskId'),
		inputId: expectIdentifier(input.inputId, 'inputId'),
		answerId: expectIdentifier(input.answerId, 'answerId'),
		answer: expectString(input.answer, 'answer', TASK_TOOL_LIMITS.answerBytes),
	};
}

export async function serializeToolResultToTokenBudget(
	value: ToolJsonResult,
	tokenBudget: number,
	countTokens: (text: string) => PromiseLike<number>,
): Promise<string> {
	const normalizedBudget = Number.isSafeInteger(tokenBudget) && tokenBudget >= 0 ? tokenBudget : 0;
	let candidate = value;
	let serialized = JSON.stringify(candidate);
	while (await countTokens(serialized) > normalizedBudget) {
		const smaller = shrinkToolResult(candidate);
		if (smaller === undefined) {
			if (isCompactDelegationResult(candidate)) {
				return serialized;
			}
			for (const fallback of [
				'{"status":"error","error":{"code":"OUTPUT_TOO_LARGE"}}',
				'{"status":"error"}',
				'{}',
				'',
			]) {
				if (await countTokens(fallback) <= normalizedBudget) {
					return fallback;
				}
			}
			await countTokens('');
			return '';
		}
		const smallerSerialized = JSON.stringify(smaller);
		if (smallerSerialized === serialized) {
			if (isCompactDelegationResult(candidate)) {
				return serialized;
			}
			for (const fallback of [
				'{"status":"error","error":{"code":"OUTPUT_TOO_LARGE"}}',
				'{"status":"error"}',
				'{}',
				'',
			]) {
				if (await countTokens(fallback) <= normalizedBudget) {
					return fallback;
				}
			}
			await countTokens('');
			return '';
		}
		candidate = smaller;
		serialized = smallerSerialized;
	}
	await countTokens(serialized);
	return serialized;
}

function parseWorkerDirectory(value: unknown): MeshDirectorySnapshot {
	const directory = expectRecord(value, 'worker directory');
	expectExactKeys(directory, ['devices', 'truncated']);
	const devices = expectArray(directory.devices, 'devices', TASK_TOOL_LIMITS.maxDevices)
		.map((deviceValue) => {
			const device = expectRecord(deviceValue, 'device');
			expectExactKeys(device, [
				'deviceId',
				'deviceName',
				'locality',
				'status',
				'peerId',
				'nodes',
				'nodesTruncated',
				'totalNodes',
			]);
			const locality = expectEnum(device.locality, 'locality', ['local', 'remote'] as const);
			const peerId = device.peerId === undefined
				? undefined
				: expectIdentifier(device.peerId, 'peerId');
			if (locality === 'local' && peerId !== undefined) {
				throw new Error('local devices cannot include remote routing metadata.');
			}
			const nodes = expectArray(
				device.nodes,
				'nodes',
				TASK_TOOL_LIMITS.maxNodesPerDevice,
			).map((nodeValue) => {
				const node = expectRecord(nodeValue, 'node');
				expectExactKeys(node, [
					'nodeId',
					'nodeInstanceId',
					'label',
					'status',
					'capabilities',
					'workspaces',
				]);
				const workspaces = expectArray(
					node.workspaces,
					'workspaces',
					TASK_TOOL_LIMITS.maxWorkspacesPerNode,
				).map((workspaceValue) => {
					const workspace = expectRecord(workspaceValue, 'workspace');
					expectExactKeys(workspace, [
						'workspaceId',
						'name',
						'tags',
						'busy',
						'claimStatus',
					]);
					return {
						workspaceId: expectIdentifier(workspace.workspaceId, 'workspaceId'),
						name: expectString(
							workspace.name,
							'workspace name',
							TASK_TOOL_LIMITS.workspaceNameBytes,
						),
						tags: expectStringArray(
							workspace.tags,
							'workspace tags',
							TASK_TOOL_LIMITS.maxTagsPerWorkspace,
							TASK_TOOL_LIMITS.capabilityBytes,
						),
						busy: expectBoolean(workspace.busy, 'busy'),
						claimStatus: expectEnum(
							workspace.claimStatus,
							'claimStatus',
							['claimed', 'readOnly', 'conflict'] as const,
						),
					};
				});
				return {
					nodeId: expectIdentifier(node.nodeId, 'nodeId'),
					nodeInstanceId: expectIdentifier(node.nodeInstanceId, 'nodeInstanceId'),
					label: expectString(node.label, 'node label', TASK_TOOL_LIMITS.nodeLabelBytes),
					status: expectEnum(
						node.status,
						'node status',
						['online', 'busy', 'offline', 'conflict', 'draining'] as const,
					),
					capabilities: expectStringArray(
						node.capabilities,
						'capabilities',
						TASK_TOOL_LIMITS.maxCapabilitiesPerNode,
						TASK_TOOL_LIMITS.capabilityBytes,
					),
					workspaces,
				};
			});
			const nodesTruncated = expectBoolean(device.nodesTruncated, 'nodesTruncated');
			const totalNodes = expectInteger(
				device.totalNodes,
				'totalNodes',
				nodes.length,
				TASK_TOOL_LIMITS.maxNodesPerDevice,
			);
			if (
				(nodesTruncated && totalNodes === nodes.length)
				|| (!nodesTruncated && totalNodes !== nodes.length)
			) {
				throw new Error('device node truncation metadata is inconsistent.');
			}
			return {
				deviceId: expectIdentifier(device.deviceId, 'deviceId'),
				deviceName: expectString(
					device.deviceName,
					'deviceName',
					TASK_TOOL_LIMITS.deviceNameBytes,
				),
				locality,
				status: expectEnum(
					device.status,
					'device status',
					['online', 'incompatible'] as const,
				),
				...(peerId === undefined ? {} : { peerId }),
				nodes,
				nodesTruncated,
				totalNodes,
			};
		});
	return {
		devices,
		truncated: expectBoolean(directory.truncated, 'truncated'),
	};
}

function parsePersistedIntent(value: unknown): PersistedDelegationIntent {
	const persisted = expectRecord(value, 'persisted delegation intent');
	expectExactKeys(persisted, ['delegationRequestId', 'taskId', 'recovered']);
	return {
		delegationRequestId: expectIdentifier(persisted.delegationRequestId, 'delegationRequestId'),
		taskId: expectIdentifier(persisted.taskId, 'taskId'),
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

function parseTaskReadResult(
	value: unknown,
	requestedMaxEvents: number,
	afterEventSequence?: number,
): TaskToolReadResult {
	const read = expectRecord(value, 'task read result');
	expectExactKeys(read, ['snapshot', 'eventCursor', 'events', 'eventGap', 'truncated']);
	const events = expectArray(read.events, 'events', requestedMaxEvents).map(parseTaskEvent);
	const eventGap = read.eventGap === undefined ? undefined : parseEventGap(read.eventGap);
	const eventCursor = expectInteger(read.eventCursor, 'eventCursor', 0, Number.MAX_SAFE_INTEGER);
	const truncated = expectBoolean(read.truncated, 'truncated');
	const requestedCursor = afterEventSequence ?? 0;
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		const previousSequence = index === 0
			? (eventGap?.availableFrom ?? requestedCursor + 1) - 1
			: events[index - 1].sequence;
		if (event.sequence !== previousSequence + 1) {
			throw new Error('task events must be strictly consecutive and newer than the requested cursor.');
		}
	}
	const lastSequence = events.at(-1)?.sequence;
	if (eventCursor !== (lastSequence ?? requestedCursor)) {
		throw new Error('eventCursor must equal the last returned event or afterEventSequence.');
	}
	if (eventGap !== undefined) {
		if (!truncated) {
			throw new Error('eventGap requires a truncated task read result.');
		}
		if (eventGap.expectedFrom >= eventGap.availableFrom) {
			throw new Error('eventGap must identify a non-empty forward gap.');
		}
		if (eventGap.expectedFrom !== requestedCursor + 1) {
			throw new Error('eventGap.expectedFrom must follow afterEventSequence.');
		}
		if (events.length > 0 && events[0].sequence !== eventGap.availableFrom) {
			throw new Error('the first returned event must match eventGap.availableFrom.');
		}
	} else if (!truncated && events.length > 0 && events[0].sequence !== requestedCursor + 1) {
		throw new Error('a discontinuous event sequence requires eventGap metadata.');
	}
	return {
		snapshot: parseTaskSnapshot(read.snapshot),
		eventCursor,
		events,
		...(eventGap === undefined ? {} : { eventGap }),
		truncated,
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
		'failure',
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
	const failure = snapshot.failure === undefined ? undefined : parseTaskFailure(snapshot.failure);
	if (status === 'needsInput' && pendingInput === undefined) {
		throw new Error('needsInput task snapshot must include pendingInput.');
	}
	if (pendingInput !== undefined && status !== 'needsInput' && status !== 'recovering') {
		throw new Error('pendingInput is only valid for a needsInput or recovering task snapshot.');
	}
	const failureStatus = status === 'failed' || status === 'timedOut';
	if (failureStatus !== (failure !== undefined)) {
		throw new Error('failure is required only for failed or timedOut task snapshots.');
	}
	return {
		taskId: expectIdentifier(snapshot.taskId, 'taskId'),
		status,
		title: expectString(snapshot.title, 'title', TASK_TOOL_LIMITS.titleBytes),
		updatedAt: expectTimestamp(snapshot.updatedAt, 'updatedAt'),
		...(phase === undefined ? {} : { phase }),
		...(summary === undefined ? {} : { summary }),
		...(validation === undefined ? {} : { validation }),
		...(artifacts === undefined ? {} : { artifacts }),
		...(pendingInput === undefined ? {} : { pendingInput }),
		...(failure === undefined ? {} : { failure }),
	};
}

function parseTaskEvent(value: unknown): TaskToolEvent {
	const event = expectRecord(value, 'task event');
	expectExactKeys(event, ['sequence', 'type', 'at', 'summary']);
	return {
		sequence: expectInteger(event.sequence, 'sequence', 1, Number.MAX_SAFE_INTEGER),
		type: expectString(event.type, 'event type', 128),
		at: expectTimestamp(event.at, 'event time'),
		summary: expectString(event.summary, 'event summary', 16 * 1024),
	};
}

function parseEventGap(value: unknown): TaskToolReadResult['eventGap'] {
	const gap = expectRecord(value, 'event gap');
	expectExactKeys(gap, ['expectedFrom', 'availableFrom']);
	return {
		expectedFrom: expectInteger(gap.expectedFrom, 'expectedFrom', 1, Number.MAX_SAFE_INTEGER),
		availableFrom: expectInteger(gap.availableFrom, 'availableFrom', 1, Number.MAX_SAFE_INTEGER),
	};
}

function parseTaskFailure(value: unknown): TaskFailureSummary {
	const failure = expectRecord(value, 'task failure');
	expectExactKeys(failure, ['code', 'message', 'retryable']);
	return {
		code: expectString(failure.code, 'failure code', TASK_TOOL_LIMITS.failureCodeBytes),
		message: expectString(failure.message, 'failure message', TASK_TOOL_LIMITS.errorMessageBytes),
		retryable: expectBoolean(failure.retryable, 'failure retryable'),
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
		artifactId: expectIdentifier(artifact.artifactId, 'artifactId'),
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
		inputId: expectIdentifier(pendingInput.inputId, 'inputId'),
		prompt: expectString(pendingInput.prompt, 'input prompt', 16 * 1024),
		...(choices === undefined ? {} : { choices }),
	};
}

function parseTaskActionReceipt(value: unknown): TaskActionReceipt {
	const receipt = expectRecord(value, 'task action receipt');
	expectExactKeys(receipt, ['taskId', 'status']);
	return {
		taskId: expectIdentifier(receipt.taskId, 'taskId'),
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

function expectIdentifier(value: unknown, field: string): string {
	if (typeof value !== 'string' || !canonicalIdentifierPattern.test(value)) {
		throw new Error(`${field} must be a canonical lowercase UUID.`);
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

function expectEnum<const T extends readonly string[]>(
	value: unknown,
	field: string,
	values: T,
): T[number] {
	if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
		throw new Error(`${field} is invalid.`);
	}
	return value as T[number];
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
	let result = '';
	let bytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, 'utf8');
		if (bytes + characterBytes > maxBytes) {
			break;
		}
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function halveUtf8(value: string, minimumBytes: number): string {
	const currentBytes = Buffer.byteLength(value, 'utf8');
	return boundedUtf8(value, Math.max(minimumBytes, Math.floor(currentBytes / 2)));
}

function shrinkToolResult(value: ToolJsonResult): ToolJsonResult | undefined {
	const compactDelegation = compactDelegationResult(value);
	if (compactDelegation !== undefined) {
		return compactDelegation;
	}
	if (isRecord(value.run)) {
		const run = value.run;
		if (Array.isArray(run.artifacts) && run.artifacts.length > 0) {
			return {
				...value,
				run: { ...run, artifacts: run.artifacts.slice(0, -1) },
				truncated: true,
			};
		}
		if (Array.isArray(run.validations) && run.validations.length > 0) {
			return {
				...value,
				run: { ...run, validations: run.validations.slice(0, -1) },
				truncated: true,
			};
		}
		if (
			Array.isArray(run.tasks)
			&& run.tasks.some((task) =>
				isRecord(task)
				&& Object.keys(task).some((key) =>
					!['taskId', 'role', 'kind', 'status', 'pendingInput'].includes(key),
				),
			)
		) {
			return {
				...value,
				run: {
					...run,
					tasks: run.tasks.map((task) => {
						if (!isRecord(task)) {
							return task;
						}
						return {
							taskId: task.taskId,
							role: task.role,
							kind: task.kind,
							status: task.status,
							...(task.pendingInput === undefined
								? {}
								: { pendingInput: task.pendingInput }),
						};
					}),
				},
				truncated: true,
			};
		}
		if (Array.isArray(run.participants) && run.participants.length > 0) {
			const { participants: _participants, ...withoutParticipants } = run;
			return { ...value, run: withoutParticipants, truncated: true };
		}
		if (
			Array.isArray(run.tasks)
			&& run.tasks.length > 0
			&& typeof run.runId === 'string'
			&& typeof run.status === 'string'
		) {
			return {
				status: typeof value.status === 'string' ? value.status : 'ok',
				run: {
					runId: run.runId,
					status: run.status,
					tasks: run.tasks.map((task) =>
						isRecord(task)
							? {
								taskId: task.taskId,
								status: task.status,
								...(task.pendingInput === undefined
									? {}
									: { pendingInput: task.pendingInput }),
							}
							: task,
					),
				},
				...(value.answerTool === undefined ? {} : { answerTool: value.answerTool }),
				truncated: true,
			};
		}
		if (typeof run.runId === 'string' && typeof run.status === 'string') {
			return {
				status: typeof value.status === 'string' ? value.status : 'ok',
				run: { runId: run.runId, status: run.status },
				truncated: true,
			};
		}
	}
	if (Array.isArray(value.events) && value.events.length > 0) {
		const [removed, ...events] = value.events;
		const eventGap = leadingEventGap(value.eventGap, removed);
		const eventCursor = events.length === 0 && eventGap !== undefined
			? eventGap.expectedFrom - 1
			: value.eventCursor;
		return {
			...value,
			events,
			...(typeof eventCursor === 'number' ? { eventCursor } : {}),
			...(eventGap === undefined ? {} : { eventGap }),
			truncated: true,
		};
	}
	if (Array.isArray(value.devices) && value.devices.length > 0) {
		const smallerDirectory = shrinkDirectoryDevices(value.devices);
		if (smallerDirectory !== undefined) {
			return {
				...value,
				devices: smallerDirectory,
				truncated: true,
			};
		}
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
		if (snapshot.phase !== undefined) {
			const { phase: _phase, ...withoutPhase } = snapshot;
			return { ...value, snapshot: withoutPhase, truncated: true };
		}
		if (isRecord(snapshot.failure) && typeof snapshot.failure.message === 'string' && snapshot.failure.message.length > 1) {
			return {
				...value,
				snapshot: {
					...snapshot,
					failure: {
						...snapshot.failure,
						message: halveUtf8(snapshot.failure.message, 1),
					},
				},
				truncated: true,
			};
		}
		if (isRecord(snapshot.validation) && snapshot.validation.summary !== undefined) {
			const { summary: _summary, ...compactValidation } = snapshot.validation;
			return {
				...value,
				snapshot: { ...snapshot, validation: compactValidation },
				truncated: true,
			};
		}

		if (snapshot.validation !== undefined) {
			const { validation: _validation, ...withoutValidation } = snapshot;
			return { ...value, snapshot: withoutValidation, truncated: true };
		}
		if (isRecord(snapshot.pendingInput)) {
			const pendingInput = snapshot.pendingInput;
			if (Array.isArray(pendingInput.choices) && pendingInput.choices.length > 0) {
				return {
					...value,
					snapshot: {
						...snapshot,
						pendingInput: { ...pendingInput, choices: pendingInput.choices.slice(0, -1) },
					},
					truncated: true,
				};
			}
			if (Array.isArray(pendingInput.choices)) {
				const { choices: _choices, ...withoutChoices } = pendingInput;
				return {
					...value,
					snapshot: {
						...snapshot,
						pendingInput: withoutChoices,
					},
					truncated: true,
				};
			}
			if (typeof pendingInput.prompt === 'string' && pendingInput.prompt.length > 1) {
				return {
					...value,
					snapshot: {
						...snapshot,
						pendingInput: {
							...pendingInput,
							prompt: pendingInput.prompt.slice(0, Math.max(1, Math.floor(pendingInput.prompt.length / 2))),
						},
					},
					truncated: true,
				};
			}
			if (
				snapshot.status === 'needsInput'
				&& typeof snapshot.taskId === 'string'
				&& typeof pendingInput.inputId === 'string'
				&& typeof pendingInput.prompt === 'string'
			) {
				return {
					status: typeof value.status === 'string' ? value.status : 'ok',
					...compactTaskEventWindow(value),
					snapshot: {
						taskId: snapshot.taskId,
						status: 'needsInput',
						pendingInput: {
							inputId: pendingInput.inputId,
							prompt: pendingInput.prompt,
						},
					},
					answerTool: MESH_TOOL_NAMES.answerTask,
					truncated: true,
				};
			}
		}
		if (
			(snapshot.status === 'failed' || snapshot.status === 'timedOut')
			&& typeof snapshot.taskId === 'string'
			&& isRecord(snapshot.failure)
			&& typeof snapshot.failure.code === 'string'
			&& typeof snapshot.failure.message === 'string'
			&& typeof snapshot.failure.retryable === 'boolean'
		) {
			return {
				status: typeof value.status === 'string' ? value.status : 'ok',
				...compactTaskEventWindow(value),
				snapshot: {
					taskId: snapshot.taskId,
					status: snapshot.status,
					failure: {
						code: snapshot.failure.code,
						message: snapshot.failure.message,
						retryable: snapshot.failure.retryable,
					},
				},
				truncated: true,
			};
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

function shrinkDirectoryDevices(devices: readonly unknown[]): readonly unknown[] | undefined {
	const lastDevice = devices.at(-1);
	if (!isRecord(lastDevice)) {
		return devices.slice(0, -1);
	}
	const nodes = Array.isArray(lastDevice.nodes) ? lastDevice.nodes : [];
	const lastNode = nodes.at(-1);
	if (isRecord(lastNode)) {
		const workspaces = Array.isArray(lastNode.workspaces) ? lastNode.workspaces : [];
		const lastWorkspace = workspaces.at(-1);
		if (
			isRecord(lastWorkspace)
			&& Array.isArray(lastWorkspace.tags)
			&& lastWorkspace.tags.length > 0
		) {
			return replaceLast(devices, {
				...lastDevice,
				nodes: replaceLast(nodes, {
					...lastNode,
					workspaces: replaceLast(workspaces, {
						...lastWorkspace,
						tags: lastWorkspace.tags.slice(0, -1),
					}),
				}),
			});
		}
		if (workspaces.length > 0) {
			return replaceLast(devices, {
				...lastDevice,
				nodes: replaceLast(nodes, {
					...lastNode,
					workspaces: workspaces.slice(0, -1),
				}),
			});
		}
		if (Array.isArray(lastNode.capabilities) && lastNode.capabilities.length > 0) {
			return replaceLast(devices, {
				...lastDevice,
				nodes: replaceLast(nodes, {
					...lastNode,
					capabilities: lastNode.capabilities.slice(0, -1),
				}),
			});
		}
		if (nodes.length > 0) {
			return replaceLast(devices, {
				...lastDevice,
				nodes: nodes.slice(0, -1),
			});
		}
	}
	return devices.slice(0, -1);
}

function replaceLast(values: readonly unknown[], replacement: unknown): readonly unknown[] {
	return [...values.slice(0, -1), replacement];
}

function compactTaskEventWindow(value: ToolJsonResult): ToolJsonResult {
	return {
		...(Array.isArray(value.events) ? { events: value.events } : {}),
		...(typeof value.eventCursor === 'number' ? { eventCursor: value.eventCursor } : {}),
		...(isRecord(value.eventGap) ? { eventGap: value.eventGap } : {}),
	};
}

function leadingEventGap(value: unknown, removed: unknown): Record<string, number> | undefined {
	const sequence = isRecord(removed) ? removed.sequence : undefined;
	if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= 0) {
		return undefined;
	}
	const expectedFrom = isRecord(value) && Number.isSafeInteger(value.expectedFrom)
		&& (value.expectedFrom as number) > 0
		? value.expectedFrom as number
		: sequence;
	return {
		expectedFrom,
		availableFrom: sequence + 1,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeDelegationText(value: string, maxBytes: number): string {
	return sanitizeDelegationText(value, maxBytes);
}

function normalizeErrorCode(code: string): TaskToolErrorCode {
	return (TASK_TOOL_ERROR_CODES as readonly string[]).includes(code)
		? code as TaskToolErrorCode
		: 'TASK_EXECUTION_FAILED';
}

function isCompactDelegationResult(value: ToolJsonResult): boolean {
	return typeof value.s === 'number'
		&& value.s >= 0
		&& value.s <= 3;
}

function compactDelegationResult(value: ToolJsonResult): ToolJsonResult | undefined {
	if (isCompactDelegationResult(value)) {
		return shrinkCompactDelegationResult(value);
	}
	if (
		value.status === 'pending'
		&& value.phase === 'persisting'
		&& value.reconciliationPending === true
		&& value.retrySameIntent === true
	) {
		return {
			s: 3,
			...(typeof value.delegationRequestId === 'string'
				? { d: value.delegationRequestId }
				: {}),
			r: 1,
		};
	}
	if (
		typeof value.taskId !== 'string'
		|| typeof value.delegationRequestId !== 'string'
	) {
		return undefined;
	}

	if (value.status === 'pending') {
		return {
			s: 0,
			t: value.taskId,
			d: value.delegationRequestId,
		};
	}
	if (value.status === 'cancelled' || value.status === 'timeout') {
		return {
			s: 1,
			t: value.taskId,
			d: value.delegationRequestId,
			r: 1,
		};
	}
	if (value.status === 'error' && isRecord(value.error) && typeof value.error.code === 'string') {
		return {
			s: 2,
			t: value.taskId,
			d: value.delegationRequestId,
			e: value.error.code,
			r: value.error.retryable === true ? 1 : 0,
		};
	}
	return undefined;
}

function shrinkCompactDelegationResult(value: ToolJsonResult): ToolJsonResult | undefined {
	if (value.s === 0 && isRecord(value.r)) {
		const result = value.r;
		if (Array.isArray(result.artifacts) && result.artifacts.length > 0) {
			return { ...value, r: { ...result, artifacts: result.artifacts.slice(0, -1) } };
		}
		if (result.artifacts !== undefined) {
			const { artifacts: _artifacts, ...withoutArtifacts } = result;
			return { ...value, r: withoutArtifacts };
		}
		if (result.validation !== undefined) {
			const { validation: _validation, ...withoutValidation } = result;
			return { ...value, r: withoutValidation };
		}
		if (typeof result.summary === 'string' && result.summary.length > 1) {
			return {
				...value,
				r: { summary: halveUtf8(result.summary, 1) },
			};
		}
		return compactDelegationOutputFailure(value);
	}
	if (value.s === 1 && typeof value.q === 'string' && value.q.length > 1) {
		return { ...value, q: halveUtf8(value.q, 1) };
	}
	if (value.s === 1) {
		return compactDelegationOutputFailure(value);
	}
	return undefined;
}

function compactDelegationOutputFailure(value: ToolJsonResult): ToolJsonResult | undefined {
	if (typeof value.t !== 'string' || typeof value.d !== 'string') {
		return undefined;
	}
	return {
		s: 2,
		t: value.t,
		d: value.d,
		e: 'OUTPUT_TOO_LARGE',
	};
}
