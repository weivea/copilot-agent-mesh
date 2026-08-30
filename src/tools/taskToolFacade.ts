import type {
	DelegationAcceptance,
	DelegationIdentity,
	DelegationIntentInput,
	MeshDirectorySnapshot,
	PersistedDelegationIntent,
	TaskActionReceipt,
	TaskToolErrorCode,
	TaskToolReadResult,
	TaskToolSnapshot,
} from '../../shared/toolProtocol';

export interface DelegationTargetDisplay {
	readonly windowName: string;
	readonly workspaceName: string;
}

export interface TaskSnapshotSubscription {
	dispose(): void;
}

export interface TaskToolFacade {
	readonly sourceNodeId?: string;

	listWorkers(signal: AbortSignal): Promise<MeshDirectorySnapshot>;

	identifyDelegation?(intent: DelegationIntentInput): DelegationIdentity;

	describeDelegationTarget?(
		intent: DelegationIntentInput,
		signal: AbortSignal,
	): Promise<DelegationTargetDisplay>;

	subscribeToTask?(
		taskId: string,
		listener: (snapshot: TaskToolSnapshot) => void,
		onError: (error: unknown) => void,
	): TaskSnapshotSubscription;

	/**
	 * Resolves only after the intent and both IDs are durable. An exact retry
	 * with the same delegationRequestId recovers the same task, while reusing
	 * that ID for another payload conflicts. Inputs without an ID are fresh.
	 */
	persistDelegationIntent(intent: DelegationIntentInput): Promise<PersistedDelegationIntent>;

	/** @deprecated The P4 delegate path subscribes to authoritative task snapshots. */
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
