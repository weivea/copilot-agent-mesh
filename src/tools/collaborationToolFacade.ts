import type {
	CollaborationRunToolResult,
	StartCollaborationToolInput,
	TaskToolErrorCode,
} from '../../shared/toolProtocol';

export interface CollaborationToolFacade {
	readonly sourceNodeId?: string;

	startCollaboration(
		input: StartCollaborationToolInput & { readonly collaborationRequestId: string },
		signal: AbortSignal,
	): Promise<CollaborationRunToolResult>;

	getCollaboration(
		runId: string,
		signal: AbortSignal,
	): Promise<CollaborationRunToolResult>;

	cancelCollaboration(
		runId: string,
		signal: AbortSignal,
	): Promise<CollaborationRunToolResult>;
}

export class CollaborationToolFacadeError extends Error {
	constructor(
		readonly code: TaskToolErrorCode,
		readonly retryable = false,
	) {
		super(code);
		this.name = 'CollaborationToolFacadeError';
	}
}
