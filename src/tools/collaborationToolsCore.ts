import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
	collaborationRunSnapshotSchema,
	taskTargetSchema,
	uuidSchema,
	utf8String,
	PROTOCOL_LIMITS,
} from '../../shared/protocol';
import {
	TASK_TOOL_DEADLINES_MS,
	TASK_TOOL_ERROR_CODES,
	TASK_TOOL_LIMITS,
	type StartCollaborationToolInput,
	type TaskToolErrorCode,
} from '../../shared/toolProtocol';
import {
	CollaborationToolFacadeError,
	type CollaborationToolFacade,
} from './collaborationToolFacade';
import type {
	DelegateInvocationPreparation,
	ToolCancellation,
	ToolClock,
	ToolJsonResult,
} from './taskToolsCore';

const startInputSchema = z.strictObject({
	collaborationRequestId: uuidSchema.optional(),
	title: utf8String(PROTOCOL_LIMITS.taskTitleBytes, 'collaboration title', 1),
	goal: utf8String(PROTOCOL_LIMITS.collaborationGoalBytes, 'collaboration goal', 1),
	frontend: taskTargetSchema,
	backend: taskTargetSchema,
	timeoutMinutes: z.number().int().min(1).max(1_440).optional(),
});

const runInputSchema = z.strictObject({ runId: uuidSchema });

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

export interface CollaborationToolsCoreOptions {
	readonly clock?: ToolClock;
	readonly outputByteLimit?: number;
	readonly id?: () => string;
}

export class CollaborationToolsCore {
	private readonly clock: ToolClock;
	private readonly outputByteLimit: number;
	private readonly id: () => string;

	public constructor(
		private readonly facade: CollaborationToolFacade,
		options: CollaborationToolsCoreOptions = {},
	) {
		this.clock = options.clock ?? systemClock;
		this.outputByteLimit = options.outputByteLimit ?? TASK_TOOL_LIMITS.defaultOutputBytes;
		this.id = options.id ?? randomUUID;
	}

	public prepareStartInvocation(rawInput: unknown): DelegateInvocationPreparation {
		const input = startInputSchema.parse(rawInput);
		return {
			invocationMessage: 'Creating a durable same-device collaboration run',
			confirmationTitle: 'Start local multi-project collaboration?',
			confirmationMessage: [
				`Frontend workspace: ${input.frontend.workspaceId}`,
				`Backend workspace: ${input.backend.workspaceId}`,
				`Title: ${input.title}`,
				`Goal:\n${input.goal}`,
			].join('\n'),
		};
	}

	public prepareCancelInvocation(rawInput: unknown): DelegateInvocationPreparation {
		const input = runInputSchema.parse(rawInput);
		return {
			invocationMessage: 'Cancelling the active collaboration task',
			confirmationTitle: 'Cancel this collaboration run?',
			confirmationMessage: `Collaboration run: ${input.runId}`,
		};
	}

	public async start(
		rawInput: unknown,
		cancellation: ToolCancellation = neverCancelled,
	): Promise<ToolJsonResult> {
		let input: StartCollaborationToolInput & { collaborationRequestId: string };
		try {
			const parsed = startInputSchema.parse(rawInput);
			input = {
				...parsed,
				collaborationRequestId: parsed.collaborationRequestId ?? this.id(),
			};
		} catch {
			return this.errorResult('INVALID_INPUT');
		}
		if (
			input.frontend.deviceId !== input.backend.deviceId
			|| input.frontend.workspaceId === input.backend.workspaceId
		) {
			return this.errorResult('COLLABORATION_DAG_INVALID');
		}
		const outcome = await this.runBounded(
			(signal) => this.facade.startCollaboration(input, signal),
			TASK_TOOL_DEADLINES_MS.startCollaboration,
			cancellation,
		);
		return this.result(outcome, input.collaborationRequestId);
	}

	public async get(
		rawInput: unknown,
		cancellation: ToolCancellation = neverCancelled,
	): Promise<ToolJsonResult> {
		let runId: string;
		try {
			runId = runInputSchema.parse(rawInput).runId;
		} catch {
			return this.errorResult('INVALID_INPUT');
		}
		const outcome = await this.runBounded(
			(signal) => this.facade.getCollaboration(runId, signal),
			TASK_TOOL_DEADLINES_MS.getCollaboration,
			cancellation,
		);
		return this.result(outcome);
	}

	public async cancel(
		rawInput: unknown,
		cancellation: ToolCancellation = neverCancelled,
	): Promise<ToolJsonResult> {
		let runId: string;
		try {
			runId = runInputSchema.parse(rawInput).runId;
		} catch {
			return this.errorResult('INVALID_INPUT');
		}
		const outcome = await this.runBounded(
			(signal) => this.facade.cancelCollaboration(runId, signal),
			TASK_TOOL_DEADLINES_MS.cancelCollaboration,
			cancellation,
		);
		return this.result(outcome);
	}

	private async runBounded<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		deadlineMs: number,
		cancellation: ToolCancellation,
	): Promise<
		| { readonly kind: 'success'; readonly value: T }
		| { readonly kind: 'failure'; readonly error: unknown }
		| { readonly kind: 'cancelled' }
		| { readonly kind: 'timeout' }
	> {
		if (cancellation.isCancellationRequested) {
			return { kind: 'cancelled' };
		}
		const controller = new AbortController();
		const timer = this.clock.createTimer(deadlineMs);
		let cancel!: () => void;
		const cancelled = new Promise<{ readonly kind: 'cancelled' }>((resolve) => {
			cancel = () => resolve({ kind: 'cancelled' });
		});
		const subscription = cancellation.onCancellationRequested(cancel);
		try {
			const outcome = await Promise.race([
				Promise.resolve().then(() => operation(controller.signal)).then(
					(value) => ({ kind: 'success' as const, value }),
					(error: unknown) => ({ kind: 'failure' as const, error }),
				),
				timer.promise.then(() => ({ kind: 'timeout' as const })),
				cancelled,
			]);
			if (outcome.kind === 'cancelled' || outcome.kind === 'timeout') {
				controller.abort();
			}
			return outcome;
		} finally {
			timer.dispose();
			subscription.dispose();
		}
	}

	private result(
		outcome:
			| { readonly kind: 'success'; readonly value: unknown }
			| { readonly kind: 'failure'; readonly error: unknown }
			| { readonly kind: 'cancelled' }
			| { readonly kind: 'timeout' },
		collaborationRequestId?: string,
	): ToolJsonResult {
		if (outcome.kind === 'cancelled') {
			return this.errorResult('CANCELLED', true);
		}
		if (outcome.kind === 'timeout') {
			return this.errorResult('TIMEOUT', true, collaborationRequestId);
		}
		if (outcome.kind === 'failure') {
			if (
				outcome.error instanceof CollaborationToolFacadeError
				&& TASK_TOOL_ERROR_CODES.includes(outcome.error.code)
			) {
				return this.errorResult(
					outcome.error.code,
					outcome.error.retryable,
					collaborationRequestId,
				);
			}
			return this.errorResult('INTERNAL_ERROR', false, collaborationRequestId);
		}
		const value = typeof outcome.value === 'object' && outcome.value !== null
			&& 'run' in outcome.value
			? outcome.value.run
			: undefined;
		const parsed = collaborationRunSnapshotSchema.safeParse(value);
		if (!parsed.success) {
			return this.errorResult('OUTPUT_INVALID');
		}
		const result = {
			status: 'ok',
			run: parsed.data,
			getTool: 'mesh_get_collaboration',
			cancelTool: 'mesh_cancel_collaboration',
			...(parsed.data.tasks.some(({ status }) => status === 'needsInput')
				? { answerTool: 'mesh_answer_task' }
				: {}),
		};
		return Buffer.byteLength(JSON.stringify(result), 'utf8') <= this.outputByteLimit
			? result
			: this.errorResult('OUTPUT_TOO_LARGE');
	}

	private errorResult(
		code: TaskToolErrorCode,
		retryable = false,
		collaborationRequestId?: string,
	): ToolJsonResult {
		return {
			status: 'error',
			...(collaborationRequestId === undefined ? {} : { collaborationRequestId }),
			error: {
				code,
				message: safeMessages[code],
				retryable,
			},
		};
	}
}

const safeMessages: Readonly<Record<TaskToolErrorCode, string>> = {
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
	AGENT_UNAVAILABLE: 'The local coding agent is unavailable.',
	AGENT_AUTH_REQUIRED: 'The local coding agent requires authentication.',
	TASK_EXECUTION_FAILED: 'The collaboration task failed.',
	TASK_RECOVERY_UNAVAILABLE: 'The collaboration task cannot currently be recovered.',
	WORKER_DRAINING: 'The selected worker is draining and cannot accept a task.',
	REMOTE_WORKSPACE_UNSUPPORTED: 'The selected remote workspace is unsupported.',
	TUNNEL_UNAVAILABLE: 'The worker connection is unavailable.',
	WORKSPACE_UNTRUSTED: 'The selected workspace is not trusted.',
	LOCAL_FILE_WORKSPACE_REQUIRED: 'The task requires a local filesystem-backed workspace.',
	TASK_CANCELLATION_UNCONFIRMED: 'The task cancellation was not confirmed.',
	DELEGATION_NOT_FOUND: 'The delegation intent was not found.',
	COLLABORATION_NOT_FOUND: 'The collaboration run was not found.',
	COLLABORATION_ID_CONFLICT: 'The collaboration identity conflicts with another request.',
	COLLABORATION_NOT_CANCELLABLE: 'The collaboration run is no longer cancellable.',
	COLLABORATION_DAG_INVALID: 'The collaboration participants or dependency graph are invalid.',
	ARTIFACT_NOT_FOUND: 'The required collaboration artifact was not found.',
	ARTIFACT_FORBIDDEN: 'The collaboration artifact is not authorized for this task.',
	ARTIFACT_INVALID: 'The collaboration artifact failed its bounded JSON policy.',
	ARTIFACT_CORRUPT: 'The collaboration artifact failed its integrity check.',
	ARTIFACT_LIMIT_EXCEEDED: 'The collaboration artifact count or byte limit was exceeded.',
	FEATURE_DISABLED: 'Same-device multi-project collaboration Preview is disabled.',
	VALIDATION_FAILED: 'A workspace validation failed.',
	INTERNAL_ERROR: 'The mesh operation failed without a safe diagnostic.',
};
