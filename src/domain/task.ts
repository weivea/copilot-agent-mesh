import { createHash } from 'node:crypto';

import {
	taskStartParamsSchema,
	uuidSchema,
	type PersistedTaskRecord,
	type TaskStartParams,
} from '../../shared/protocol';
import { MeshDomainError } from './errors';

export type TaskRecord = PersistedTaskRecord;

export interface OwnedTaskStart extends TaskStartParams {
	readonly peerId: string;
}

export function canonicalTaskRequest(request: OwnedTaskStart): string {
	const { peerId, ...params } = request;
	const parsed = taskStartParamsSchema.safeParse(params);
	const parsedPeerId = uuidSchema.safeParse(peerId);
	if (!parsed.success) {
		throw new TypeError(`Invalid task request: ${parsed.error.message}`);
	}
	if (!parsedPeerId.success) {
		throw new TypeError(`Invalid task request: ${parsedPeerId.error.message}`);
	}

	const fields = [
		parsedPeerId.data,
		parsed.data.delegationRequestId,
		parsed.data.taskId,
		parsed.data.workspaceId,
		parsed.data.title,
		parsed.data.prompt,
		String(parsed.data.acceptanceCriteria.length),
		...parsed.data.acceptanceCriteria,
		parsed.data.workerDeadline,
	];

	return fields.map(lengthPrefix).join('');
}

export function canonicalTaskRequestHash(request: OwnedTaskStart): string {
	return createHash('sha256').update(canonicalTaskRequest(request), 'utf8').digest('hex');
}

export function createAcceptedTask(request: OwnedTaskStart, at: string): TaskRecord {
	const requestHash = canonicalTaskRequestHash(request);
	return {
		schemaVersion: 1,
		taskId: request.taskId,
		delegationRequestId: request.delegationRequestId,
		requestHash,
		peerId: request.peerId,
		workspaceId: request.workspaceId,
		title: request.title,
		state: 'accepted',
		createdAt: at,
		updatedAt: at,
		eventSeq: 0,
		workerDeadline: request.workerDeadline,
		answeredInputs: {},
		events: [],
		eventsTruncated: false,
	};
}

export function matchIdempotentStart(
	records: readonly TaskRecord[],
	request: OwnedTaskStart,
): TaskRecord | undefined {
	const requestHash = canonicalTaskRequestHash(request);
	const sameScope = records.filter((record) => record.peerId === request.peerId);
	const match = sameScope.find((record) =>
		record.delegationRequestId === request.delegationRequestId
		|| record.taskId === request.taskId,
	);

	if (match === undefined) {
		return undefined;
	}

	if (
		match.delegationRequestId !== request.delegationRequestId
		|| match.taskId !== request.taskId
		|| match.requestHash !== requestHash
	) {
		throw new MeshDomainError(
			'TASK_ID_CONFLICT',
			'The task identifiers are already associated with a different request.',
		);
	}

	return match;
}

export function getOwnedTask(
	record: TaskRecord | undefined,
	authenticatedPeerId: string,
): TaskRecord {
	if (record === undefined || record.peerId !== authenticatedPeerId) {
		throw new MeshDomainError('TASK_NOT_FOUND', 'Task not found.');
	}
	return record;
}

function lengthPrefix(value: string): string {
	return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}
