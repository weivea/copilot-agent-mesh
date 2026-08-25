import type { TaskStatus } from './protocol';

export const TASK_TOOL_LIMITS = {
	idBytes: 128,
	deviceNameBytes: 256,
	workspaceNameBytes: 256,
	capabilityBytes: 128,
	titleBytes: 256,
	promptBytes: 128 * 1024,
	acceptanceCriteriaCount: 32,
	acceptanceCriterionBytes: 4 * 1024,
	answerBytes: 32 * 1024,
	errorMessageBytes: 2 * 1024,
	maxWorkers: 128,
	maxWorkspacesPerWorker: 128,
	maxCapabilitiesPerWorker: 64,
	maxEvents: 100,
	maxArtifacts: 32,
	minimumOutputBytes: 1_024,
	defaultOutputBytes: 32 * 1024,
} as const;

export const TASK_TOOL_DEADLINES_MS = {
	listWorkers: 5_000,
	delegateTask: 15_000,
	getTask: 10_000,
	cancelTask: 10_000,
	answerTask: 10_000,
} as const;

export const TASK_TOOL_ERROR_CODES = [
	'INVALID_INPUT',
	'OUTPUT_INVALID',
	'OUTPUT_TOO_LARGE',
	'CANCELLED',
	'TIMEOUT',
	'AUTH_REQUIRED',
	'AUTH_FAILED',
	'PROTOCOL_INCOMPATIBLE',
	'RATE_LIMITED',
	'WORKSPACE_NOT_FOUND',
	'WORKSPACE_DISABLED',
	'WORKSPACE_BUSY',
	'TASK_NOT_FOUND',
	'TASK_ID_CONFLICT',
	'TASK_NOT_CANCELLABLE',
	'INPUT_NOT_PENDING',
	'AGENT_UNAVAILABLE',
	'AGENT_AUTH_REQUIRED',
	'TASK_EXECUTION_FAILED',
	'TASK_RECOVERY_UNAVAILABLE',
	'WORKER_DRAINING',
	'REMOTE_WORKSPACE_UNSUPPORTED',
	'TUNNEL_UNAVAILABLE',
	'WORKSPACE_UNTRUSTED',
	'LOCAL_FILE_WORKSPACE_REQUIRED',
	'TASK_CANCELLATION_UNCONFIRMED',
	'DELEGATION_NOT_FOUND',
	'INTERNAL_ERROR',
] as const;

export type TaskToolErrorCode = typeof TASK_TOOL_ERROR_CODES[number];

export interface MeshWorkspaceToolSummary {
	readonly workspaceId: string;
	readonly name: string;
	readonly tags: readonly string[];
	readonly busy: boolean;
}

export interface MeshWorkerToolSummary {
	readonly peerId: string;
	readonly deviceName: string;
	readonly capabilities: readonly string[];
	readonly workspaces: readonly MeshWorkspaceToolSummary[];
}

export interface MeshWorkerDirectorySnapshot {
	readonly workers: readonly MeshWorkerToolSummary[];
}

export interface DelegationIntentInput {
	readonly peerId: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly prompt: string;
	readonly acceptanceCriteria: readonly string[];
	readonly timeoutMinutes?: number;
}

export interface PersistedDelegationIntent {
	readonly delegationRequestId: string;
	readonly taskId: string;
	readonly recovered: boolean;
}

export interface DelegationAcceptance {
	readonly status: 'accepted';
}

export interface TaskArtifactReference {
	readonly artifactId: string;
	readonly label: string;
	readonly mediaType?: string;
}

export interface TaskValidationSummary {
	readonly status: 'passed' | 'failed' | 'notRun';
	readonly summary?: string;
}

export interface TaskPendingInputSummary {
	readonly inputId: string;
	readonly prompt: string;
	readonly choices?: readonly string[];
}

export interface TaskToolSnapshot {
	readonly taskId: string;
	readonly status: TaskStatus;
	readonly title: string;
	readonly updatedAt: string;
	readonly phase?: string;
	readonly summary?: string;
	readonly validation?: TaskValidationSummary;
	readonly artifacts?: readonly TaskArtifactReference[];
	readonly pendingInput?: TaskPendingInputSummary;
}

export interface TaskToolEvent {
	readonly sequence: number;
	readonly type: string;
	readonly at: string;
	readonly summary: string;
}

export interface TaskEventGap {
	readonly expectedFrom: number;
	readonly availableFrom: number;
}

export interface TaskToolReadResult {
	readonly snapshot: TaskToolSnapshot;
	readonly eventCursor: number;
	readonly events: readonly TaskToolEvent[];
	readonly eventGap?: TaskEventGap;
	readonly truncated: boolean;
}

export interface TaskActionReceipt {
	readonly taskId: string;
	readonly status: TaskStatus;
}
