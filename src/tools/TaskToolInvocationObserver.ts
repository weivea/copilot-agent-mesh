import type { TaskToolErrorCode } from '../../shared/toolProtocol';
import type { ToolJsonResult } from './taskToolsCore';

export type TaskToolInvocationPhase =
	| 'prepareStarted'
	| 'prepareFailed'
	| 'prepared'
	| 'invokeStarted'
	| 'taskAvailable'
	| 'invokeCompleted';

export interface TaskToolInvocationObservation {
	readonly toolName: string;
	readonly phase: TaskToolInvocationPhase;
	readonly input: unknown;
	readonly result?: ToolJsonResult;
	readonly errorCode?: TaskToolErrorCode;
	readonly preparationSequence?: number;
	readonly invocationSequence?: number;
	readonly invocationId?: string;
}

export interface TaskToolInvocationObserver {
	observe(observation: TaskToolInvocationObservation): void;
}

export interface TaskToolInvocationGate {
	assertDelegateInvocationAllowed(): void;
	reserveDelegateInvocation(invocationId: string): void;
}
