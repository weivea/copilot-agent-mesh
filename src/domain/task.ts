import { createHash } from 'node:crypto';

import {
	persistedTaskRecordSchema,
	routedTaskStartParamsSchema,
	taskStartParamsSchema,
	uuidSchema,
	type PersistedTaskRecord,
	type PersistedTaskRecordV2,
	type RoutedTaskStartParams,
	type TaskStartParams,
} from '../../shared/protocol';
import { MeshDomainError } from './errors';

export type TaskRecord = PersistedTaskRecord;

export interface OwnedTaskStart extends TaskStartParams {
	readonly peerId: string;
	readonly workspaceLeaseKey: string;
}

export interface OwnedRoutedTaskStart extends RoutedTaskStartParams {
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

function normalizeOwnedRoutedTaskStart(request: OwnedRoutedTaskStart): OwnedRoutedTaskStart {
	const { peerId, workspaceLeaseKey, ...params } = request;
	const parsed = routedTaskStartParamsSchema.safeParse(params);
	const parsedPeerId = uuidSchema.safeParse(peerId);
	if (!parsed.success) {
		throw new TypeError(`Invalid routed task request: ${parsed.error.message}`);
	}
	if (!parsedPeerId.success) {
		throw new TypeError(`Invalid routed task request: ${parsedPeerId.error.message}`);
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

export function canonicalRoutedTaskRequest(request: OwnedRoutedTaskStart): string {
	const normalized = normalizeOwnedRoutedTaskStart(request);
	const fields = [
		normalized.peerId,
		normalized.delegationRequestId,
		normalized.taskId,
		normalized.target.deviceId,
		normalized.target.nodeId,
		normalized.target.nodeInstanceId,
		normalized.target.workspaceId,
		normalized.sourceNodeId ?? '',
		normalized.title,
		normalized.prompt,
		String(normalized.acceptanceCriteria.length),
		...normalized.acceptanceCriteria,
		normalized.workerDeadline,
	];
	return fields.map(lengthPrefix).join('');
}

export function canonicalRoutedTaskRequestHash(request: OwnedRoutedTaskStart): string {
	return createHash('sha256')
		.update(canonicalRoutedTaskRequest(request), 'utf8')
		.digest('hex');
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

export function createAcceptedRoutedTask(
	request: OwnedRoutedTaskStart,
	at: string,
): PersistedTaskRecordV2 {
	const normalized = normalizeOwnedRoutedTaskStart(request);
	return persistedTaskRecordSchema.parse({
		schemaVersion: 2,
		taskId: normalized.taskId,
		delegationRequestId: normalized.delegationRequestId,
		requestHash: canonicalRoutedTaskRequestHash(normalized),
		peerId: normalized.peerId,
		workspaceId: normalized.target.workspaceId,
		workspaceLeaseKey: normalized.workspaceLeaseKey,
		target: normalized.target,
		...(normalized.sourceNodeId === undefined
			? {}
			: { sourceNodeId: normalized.sourceNodeId }),
		title: normalized.title,
		state: 'accepted',
		createdAt: at,
		updatedAt: at,
		eventSeq: 0,
		workerDeadline: normalized.workerDeadline,
		answeredInputs: {},
		events: [],
		eventsTruncated: false,
	}) as PersistedTaskRecordV2;
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

export function matchIdempotentRoutedStart(
	records: readonly TaskRecord[],
	request: OwnedRoutedTaskStart,
): TaskRecord | undefined {
	const normalized = normalizeOwnedRoutedTaskStart(request);
	const sameScope = records.filter((record) => record.peerId === normalized.peerId);
	const match = sameScope.find((record) =>
		record.delegationRequestId === normalized.delegationRequestId
		|| record.taskId === normalized.taskId,
	);
	if (match === undefined) {
		return undefined;
	}

	const expectedHash = match.schemaVersion === 1 || match.target.nodeId === undefined
		? canonicalTaskRequestHash({
			delegationRequestId: normalized.delegationRequestId,
			taskId: normalized.taskId,
			workspaceId: normalized.target.workspaceId,
			title: normalized.title,
			prompt: normalized.prompt,
			acceptanceCriteria: [...normalized.acceptanceCriteria],
			workerDeadline: normalized.workerDeadline,
			peerId: normalized.peerId,
			workspaceLeaseKey: normalized.workspaceLeaseKey,
		})
		: canonicalRoutedTaskRequestHash(normalized);
	const targetMatches = match.schemaVersion === 1 || (
		match.target.deviceId === normalized.target.deviceId
		&& match.target.workspaceId === normalized.target.workspaceId
		&& (
			match.target.nodeId === undefined
			|| (
				match.target.nodeId === normalized.target.nodeId
				&& match.target.nodeInstanceId === normalized.target.nodeInstanceId
				&& match.sourceNodeId === normalized.sourceNodeId
			)
		)
	);
	if (
		match.delegationRequestId !== normalized.delegationRequestId
		|| match.taskId !== normalized.taskId
		|| match.requestHash !== expectedHash
		|| match.workspaceId !== normalized.target.workspaceId
		|| !targetMatches
	) {
		throw new MeshDomainError(
			'TASK_ID_CONFLICT',
			'The task identifiers are already associated with a different routed request.',
		);
	}
	return match;
}

export function migrateTaskRecordV1(
	record: TaskRecord,
	deviceId: string,
): PersistedTaskRecordV2 {
	if (record.schemaVersion === 2) {
		return record;
	}
	return persistedTaskRecordSchema.parse({
		...record,
		schemaVersion: 2,
		target: {
			deviceId: uuidSchema.parse(deviceId),
			workspaceId: record.workspaceId,
		},
	}) as PersistedTaskRecordV2;
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
