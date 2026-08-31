import type { ToolJsonResult } from './taskToolsCore';

export type TaskToolInvocationPhase =
	| 'prepared'
	| 'invokeStarted'
	| 'invokeCompleted';

export interface TaskToolInvocationObservation {
	readonly toolName: string;
	readonly phase: TaskToolInvocationPhase;
	readonly input: unknown;
	readonly result?: ToolJsonResult;
}

export interface TaskToolInvocationObserver {
	observe(observation: TaskToolInvocationObservation): void;
}
