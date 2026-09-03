import type { TaskToolErrorCode } from '../../shared/toolProtocol';
import type { ToolJsonResult } from './taskToolsCore';

export type TaskToolInvocationPhase =
	| 'prepareFailed'
	| 'prepared'
	| 'invokeStarted'
	| 'invokeCompleted';

export interface TaskToolInvocationObservation {
	readonly toolName: string;
	readonly phase: TaskToolInvocationPhase;
	readonly input: unknown;
	readonly result?: ToolJsonResult;
	readonly errorCode?: TaskToolErrorCode;
}

export interface TaskToolInvocationObserver {
	observe(observation: TaskToolInvocationObservation): void;
}
