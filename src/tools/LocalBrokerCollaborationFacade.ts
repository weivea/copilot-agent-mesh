import {
	MESH_ERROR_CODES,
	collaborationRunSnapshotSchema,
	type CollaborationStartParams,
} from '../../shared/protocol';
import type {
	CollaborationRunToolResult,
	StartCollaborationToolInput,
	TaskToolErrorCode,
} from '../../shared/toolProtocol';
import { LocalIpcRemoteError } from '../ipc';
import type { WindowNodeClient } from '../node/WindowNodeClient';
import {
	CollaborationToolFacadeError,
	type CollaborationToolFacade,
} from './collaborationToolFacade';

type CollaborationClient = Pick<
	WindowNodeClient,
	| 'nodeId'
	| 'startCollaboration'
	| 'getCollaboration'
	| 'cancelCollaboration'
	| 'answerCollaboration'
>;

export class LocalBrokerCollaborationFacade implements CollaborationToolFacade {
	public readonly sourceNodeId: string;

	public constructor(private readonly client: CollaborationClient) {
		this.sourceNodeId = client.nodeId;
	}

	public async startCollaboration(
		input: StartCollaborationToolInput & { readonly collaborationRequestId: string },
		signal: AbortSignal,
	): Promise<CollaborationRunToolResult> {
		try {
			const params: CollaborationStartParams = {
				collaborationRequestId: input.collaborationRequestId,
				title: input.title,
				goal: input.goal,
				frontend: input.frontend,
				backend: input.backend,
				timeoutMinutes: input.timeoutMinutes ?? 60,
			};
			const run = await raceAbort(
				this.client.startCollaboration(params),
				signal,
			);
			return { run: collaborationRunSnapshotSchema.parse(run) };
		} catch (error: unknown) {
			throw toFacadeError(error);
		}
	}

	public async getCollaboration(
		runId: string,
		signal: AbortSignal,
	): Promise<CollaborationRunToolResult> {
		try {
			return {
				run: collaborationRunSnapshotSchema.parse(
					await raceAbort(this.client.getCollaboration(runId), signal),
				),
			};
		} catch (error: unknown) {
			throw toFacadeError(error);
		}
	}

	public async cancelCollaboration(
		runId: string,
		signal: AbortSignal,
	): Promise<CollaborationRunToolResult> {
		try {
			return {
				run: collaborationRunSnapshotSchema.parse(
					await raceAbort(this.client.cancelCollaboration(runId), signal),
				),
			};
		} catch (error: unknown) {
			throw toFacadeError(error);
		}
	}

	public async answerCollaboration(
		input: {
			readonly runId: string;
			readonly taskId: string;
			readonly inputId: string;
			readonly answerId: string;
			readonly answer: string;
		},
		signal: AbortSignal,
	): Promise<CollaborationRunToolResult> {
		try {
			return {
				run: collaborationRunSnapshotSchema.parse(
					await raceAbort(this.client.answerCollaboration(input), signal),
				),
			};
		} catch (error: unknown) {
			throw toFacadeError(error);
		}
	}
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(new DOMException('Operation cancelled.', 'AbortError'));
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new DOMException('Operation cancelled.', 'AbortError'));
		signal.addEventListener('abort', abort, { once: true });
		void operation.then(
			(value) => {
				signal.removeEventListener('abort', abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort);
				reject(error);
			},
		);
	});
}

function toFacadeError(error: unknown): Error {
	if (error instanceof CollaborationToolFacadeError) {
		return error;
	}
	if (error instanceof DOMException && error.name === 'AbortError') {
		return new CollaborationToolFacadeError('CANCELLED', true);
	}
	if (error instanceof LocalIpcRemoteError) {
		const reason = meshReason(error);
		if (reason !== undefined) {
			return new CollaborationToolFacadeError(
				reason as TaskToolErrorCode,
				typeof error.data === 'object'
					&& error.data !== null
					&& 'retryable' in error.data
					&& error.data.retryable === true,
			);
		}
	}
	return new CollaborationToolFacadeError('INTERNAL_ERROR');
}

function meshReason(error: LocalIpcRemoteError): string | undefined {
	if (
		typeof error.data !== 'object'
		|| error.data === null
		|| !('reason' in error.data)
		|| typeof error.data.reason !== 'string'
	) {
		return undefined;
	}
	const reason = error.data.reason;
	return reason in MESH_ERROR_CODES ? reason : undefined;
}
