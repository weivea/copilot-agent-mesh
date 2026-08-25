import {
	MESH_ERROR_CODES,
	type MeshErrorCode,
	type MeshErrorReason,
} from '../../shared/protocol';

export class MeshDomainError extends Error {
	public readonly code: MeshErrorCode;

	public constructor(
		public readonly reason: MeshErrorReason,
		message: string,
		public readonly retryable = false,
	) {
		super(message);
		this.name = 'MeshDomainError';
		this.code = MESH_ERROR_CODES[reason];
	}
}

export class InvalidTaskTransitionError extends Error {
	public constructor(state: string, event: string) {
		super(`Task event "${event}" is not valid in state "${state}".`);
		this.name = 'InvalidTaskTransitionError';
	}
}
