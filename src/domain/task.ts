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
	readonly workspaceLeaseKey: string;
}

function normalizeOwnedTaskStart(request: OwnedTaskStart): OwnedTaskStart {
	const { peerId, workspaceLeaseKey, ...params } = request;
	const parsed = taskStartParamsSchema.safeParse(params);
	const parsedPeerId = uuidSchema.safeParse(peerId);
	if (!parsed.success) {
		throw new TypeError(`Invalid task request: ${parsed.error.message}`);
	}
	if (!parsedPeerId.success) {
		throw new TypeError(`Invalid task request: ${parsedPeerId.error.message}`);
	}
	if (
		typeof workspaceLeaseKey !== 'string'
		|| Buffer.byteLength(workspaceLeaseKey, 'utf8') === 0
		|| Buffer.byteLength(workspaceLeaseKey, 'utf8') > 1_024
	) {
		throw new TypeError('Workspace lease key must contain between 1 and 1024 UTF-8 bytes.');
	}
	return {
		...parsed.data,
		peerId: parsedPeerId.data,
		workspaceLeaseKey,
	};
}

export function canonicalTaskRequest(request: OwnedTaskStart): string {
	const normalized = normalizeOwnedTaskStart(request);
	const fields = [
		normalized.peerId,
		normalized.delegationRequestId,
		normalized.taskId,
		normalized.workspaceId,
		normalized.title,
		normalized.prompt,
		String(normalized.acceptanceCriteria.length),
		...normalized.acceptanceCriteria,
		normalized.workerDeadline,
	];

	return fields.map(lengthPrefix).join('');
}

export function canonicalTaskRequestHash(request: OwnedTaskStart): string {
	return createHash('sha256').update(canonicalTaskRequest(request), 'utf8').digest('hex');
}

export function createAcceptedTask(request: OwnedTaskStart, at: string): TaskRecord {
	const normalized = normalizeOwnedTaskStart(request);
	const requestHash = canonicalTaskRequestHash(normalized);
	return {
		schemaVersion: 1,
		taskId: normalized.taskId,
		delegationRequestId: normalized.delegationRequestId,
		requestHash,
		peerId: normalized.peerId,
		workspaceId: normalized.workspaceId,
		workspaceLeaseKey: normalized.workspaceLeaseKey,
		title: normalized.title,
		state: 'accepted',
		createdAt: at,
		updatedAt: at,
		eventSeq: 0,
		workerDeadline: normalized.workerDeadline,
		answeredInputs: {},
		events: [],
		eventsTruncated: false,
	};
}

export function matchIdempotentStart(
	records: readonly TaskRecord[],
	request: OwnedTaskStart,
): TaskRecord | undefined {
	const normalized = normalizeOwnedTaskStart(request);
	const requestHash = canonicalTaskRequestHash(normalized);
	const sameScope = records.filter((record) => record.peerId === normalized.peerId);
	const match = sameScope.find((record) =>
		record.delegationRequestId === normalized.delegationRequestId
		|| record.taskId === normalized.taskId,
	);

	if (match === undefined) {
		return undefined;
	}

	if (
		match.delegationRequestId !== normalized.delegationRequestId
		|| match.taskId !== normalized.taskId
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
	const parsedPeerId = uuidSchema.safeParse(authenticatedPeerId);
	if (
		record === undefined
		|| !parsedPeerId.success
		|| record.peerId !== parsedPeerId.data
	) {
		throw new MeshDomainError('TASK_NOT_FOUND', 'Task not found.');
	}
	return record;
}

function lengthPrefix(value: string): string {
	return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}
