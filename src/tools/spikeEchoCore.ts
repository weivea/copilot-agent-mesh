export const MESH_SPIKE_ECHO_TOOL_NAME = 'mesh_spike_echo';
export const MESH_SPIKE_POLL_TOOL_NAME = 'mesh_get_task';
export const MESH_SPIKE_CANCEL_TOOL_NAME = 'mesh_cancel_task';

export type SpikeDelaySeconds = 5 | 15 | 30;

export interface SpikeEchoInput {
	message: string;
	delaySeconds?: SpikeDelaySeconds;
	confirmationBudgetSeconds?: SpikeDelaySeconds;
	delegationRequestId?: string;
}

export interface NormalizedSpikeEchoInput {
	message: string;
	delaySeconds: SpikeDelaySeconds;
	confirmationBudgetSeconds: SpikeDelaySeconds;
	delegationRequestId?: string;
}

interface SpikeResultBase {
	delegationRequestId: string;
	taskId: string;
	pollTool: typeof MESH_SPIKE_POLL_TOOL_NAME;
	cancelTool: typeof MESH_SPIKE_CANCEL_TOOL_NAME;
}

export interface SpikePendingResult extends SpikeResultBase {
	status: 'pending';
	echo: string;
	delaySeconds: SpikeDelaySeconds;
}

export interface SpikeCancelledResult extends SpikeResultBase {
	status: 'cancelled';
	message: string;
}

export interface SpikeTimeoutResult extends SpikeResultBase {
	status: 'timeout';
	message: string;
	confirmationBudgetSeconds: SpikeDelaySeconds;
}

export interface SpikeConflictResult extends SpikeResultBase {
	status: 'conflict';
	message: string;
}

export type SpikeEchoResult =
	| SpikePendingResult
	| SpikeCancelledResult
	| SpikeTimeoutResult
	| SpikeConflictResult;

export interface SpikeClock {
	sleep(delayMs: number): Promise<void>;
}

export interface SpikeCancellation {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface SpikeEchoCoordinatorOptions {
	clock?: SpikeClock;
	newId: () => string;
	onTaskStarted?: (requestId: string, taskId: string) => void;
}

interface SpikeTaskRecord {
	semanticKey: string;
	taskId: string;
	acknowledgement: Promise<SpikePendingResult>;
}

const allowedDelays = new Set<number>([5, 15, 30]);

const systemClock: SpikeClock = {
	sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

const neverCancelled: SpikeCancellation = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => undefined }),
};

export class SpikeEchoCoordinator {
	private readonly clock: SpikeClock;
	private readonly tasksByRequestId = new Map<string, SpikeTaskRecord>();

	constructor(private readonly options: SpikeEchoCoordinatorOptions) {
		this.clock = options.clock ?? systemClock;
	}

	async invoke(input: SpikeEchoInput, cancellation: SpikeCancellation = neverCancelled): Promise<SpikeEchoResult> {
		const normalized = normalizeSpikeInput(input);
		const requestId = normalized.delegationRequestId ?? this.options.newId();
		const semanticKey = JSON.stringify([normalized.message, normalized.delaySeconds]);
		let task = this.tasksByRequestId.get(requestId);

		if (task !== undefined && task.semanticKey !== semanticKey) {
			return {
				status: 'conflict',
				delegationRequestId: requestId,
				taskId: task.taskId,
				pollTool: MESH_SPIKE_POLL_TOOL_NAME,
				cancelTool: MESH_SPIKE_CANCEL_TOOL_NAME,
				message: 'The delegationRequestId already identifies a different spike task.',
			};
		}

		if (task === undefined) {
			task = this.startTask(requestId, normalized, semanticKey);
			this.tasksByRequestId.set(requestId, task);
		}

		if (cancellation.isCancellationRequested) {
			return cancelledResult(requestId, task.taskId);
		}

		let cancelWait: (() => void) | undefined;
		const cancellationPromise = new Promise<{ kind: 'cancelled' }>((resolve) => {
			cancelWait = () => resolve({ kind: 'cancelled' });
		});
		const subscription = cancellation.onCancellationRequested(() => cancelWait?.());

		try {
			const outcome = await Promise.race([
				task.acknowledgement.then((result) => ({ kind: 'pending' as const, result })),
				// An acknowledgement arriving exactly at the budget boundary is still on time.
				this.clock.sleep(normalized.confirmationBudgetSeconds * 1_000 + 1)
					.then(() => ({ kind: 'timeout' as const })),
				cancellationPromise,
			]);

			if (outcome.kind === 'pending') {
				return outcome.result;
			}
			if (outcome.kind === 'cancelled') {
				return cancelledResult(requestId, task.taskId);
			}
			return {
				status: 'timeout',
				delegationRequestId: requestId,
				taskId: task.taskId,
				pollTool: MESH_SPIKE_POLL_TOOL_NAME,
				cancelTool: MESH_SPIKE_CANCEL_TOOL_NAME,
				confirmationBudgetSeconds: normalized.confirmationBudgetSeconds,
				message: 'The invocation acknowledgement wait timed out; the simulated task remains available for reconciliation.',
			};
		} finally {
			subscription.dispose();
			cancelWait = undefined;
		}
	}

	private startTask(
		requestId: string,
		input: NormalizedSpikeEchoInput,
		semanticKey: string,
	): SpikeTaskRecord {
		const taskId = this.options.newId();
		this.options.onTaskStarted?.(requestId, taskId);
		const acknowledgement = this.clock.sleep(input.delaySeconds * 1_000).then<SpikePendingResult>(() => ({
			status: 'pending' as const,
			delegationRequestId: requestId,
			taskId,
			pollTool: MESH_SPIKE_POLL_TOOL_NAME,
			cancelTool: MESH_SPIKE_CANCEL_TOOL_NAME,
			echo: input.message,
			delaySeconds: input.delaySeconds,
		}));

		return { semanticKey, taskId, acknowledgement };
	}
}

export interface SpikeInvocationPreparation {
	invocationMessage: string;
	confirmationTitle: string;
	confirmationMessage: string;
}

export function prepareSpikeInvocation(input: SpikeEchoInput): SpikeInvocationPreparation {
	const normalized = normalizeSpikeInput(input);
	const summary = normalized.message.replace(/\s+/g, ' ').slice(0, 120);
	return {
		invocationMessage: `Waiting up to ${normalized.confirmationBudgetSeconds}s for the mesh spike acknowledgement`,
		confirmationTitle: 'Start the Mesh Spike Echo task?',
		confirmationMessage: [
			'Target device: local VS Code extension host.',
			'Workspace: simulated only; no workspace files are accessed.',
			`Task: ${summary}`,
			`Simulated acknowledgement delay: ${normalized.delaySeconds} seconds.`,
		].join('\n'),
	};
}

export function normalizeSpikeInput(input: SpikeEchoInput): NormalizedSpikeEchoInput {
	const message = input.message.trim();
	if (message.length === 0 || message.length > 200) {
		throw new Error('message must contain between 1 and 200 characters.');
	}

	const delaySeconds = input.delaySeconds ?? 5;
	const confirmationBudgetSeconds = input.confirmationBudgetSeconds ?? 15;
	if (!allowedDelays.has(delaySeconds)) {
		throw new Error('delaySeconds must be 5, 15, or 30.');
	}
	if (!allowedDelays.has(confirmationBudgetSeconds)) {
		throw new Error('confirmationBudgetSeconds must be 5, 15, or 30.');
	}

	const delegationRequestId = input.delegationRequestId?.trim();
	if (delegationRequestId !== undefined && (delegationRequestId.length === 0 || delegationRequestId.length > 128)) {
		throw new Error('delegationRequestId must contain between 1 and 128 characters.');
	}

	return {
		message,
		delaySeconds,
		confirmationBudgetSeconds,
		delegationRequestId,
	};
}

function cancelledResult(requestId: string, taskId: string): SpikeCancelledResult {
	return {
		status: 'cancelled',
		delegationRequestId: requestId,
		taskId,
		pollTool: MESH_SPIKE_POLL_TOOL_NAME,
		cancelTool: MESH_SPIKE_CANCEL_TOOL_NAME,
		message: 'The invocation wait was cancelled; the simulated task remains available for reconciliation.',
	};
}
