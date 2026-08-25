import type {
	DelegationAcceptance,
	DelegationIntentInput,
	MeshWorkerDirectorySnapshot,
	PersistedDelegationIntent,
	TaskActionReceipt,
	TaskToolErrorCode,
	TaskToolReadResult,
} from '../../shared/toolProtocol';

export interface TaskToolFacade {
	listWorkers(signal: AbortSignal): Promise<MeshWorkerDirectorySnapshot>;

	/**
	 * Resolves only after the intent and both IDs are durable. An exact retry
	 * with the same delegationRequestId recovers the same task, while reusing
	 * that ID for another payload conflicts. Inputs without an ID are fresh.
	 */
	persistDelegationIntent(intent: DelegationIntentInput): Promise<PersistedDelegationIntent>;

	/**
	 * Aborting the signal stops only this acknowledgement wait. It must not
	 * cancel or mutate a task that may already have been accepted by a worker.
	 */
	waitForDelegationAcceptance(
		request: Pick<PersistedDelegationIntent, 'delegationRequestId' | 'taskId'>,
		signal: AbortSignal,
	): Promise<DelegationAcceptance>;

	getTask(
		request: { readonly taskId: string; readonly afterEventSequence?: number; readonly maxEvents: number },
		signal: AbortSignal,
	): Promise<TaskToolReadResult>;

	/**
	 * Implementations must resolve task ownership from their authenticated
	 * coordinator context. Callers cannot supply or override an owner ID.
	 */
	cancelOwnedTask(request: { readonly taskId: string }, signal: AbortSignal): Promise<TaskActionReceipt>;

	/**
	 * Implementations must resolve task ownership from their authenticated
	 * coordinator context. Callers cannot supply or override an owner ID.
	 */
	answerOwnedTask(
		request: {
			readonly taskId: string;
			readonly inputId: string;
			readonly answerId: string;
			readonly answer: string;
		},
		signal: AbortSignal,
	): Promise<TaskActionReceipt>;
}

export class TaskToolFacadeError extends Error {
	constructor(
		readonly code: TaskToolErrorCode,
		readonly retryable = false,
	) {
		super(code);
		this.name = 'TaskToolFacadeError';
	}
}
