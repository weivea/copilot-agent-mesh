import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RoutedTaskStartParams } from '../../shared/protocol';
import {
	TASK_ROUTE_CATALOG_LIMIT,
	TASK_ROUTE_CATALOG_STATE_KEY,
	TaskRouteCatalog,
} from '../broker/TaskRouteCatalog';
import { MeshDomainError } from '../domain/errors';
import type { StateStore } from '../domain/ports';

const LOCAL_NODE_ID = uuid(1);
const REMOTE_PEER_ID = uuid(2);
const TASK_ID = uuid(3);
const DELEGATION_ID = uuid(4);
const LOCAL_DEVICE_ID = uuid(5);
const REMOTE_DEVICE_ID = uuid(6);
const TARGET_NODE_ID = uuid(7);
const TARGET_INSTANCE_ID = uuid(8);
const WORKSPACE_ID = uuid(9);
const AT = '2026-08-25T12:00:00.000Z';

class MemoryState implements StateStore {
	public readonly values = new Map<string, unknown>();
	public writes = 0;

	public constructor(value?: unknown) {
		if (value !== undefined) {
			this.values.set(TASK_ROUTE_CATALOG_STATE_KEY, structuredClone(value));
		}
	}

	public get<T>(key: string): T | undefined {
		const value = this.values.get(key);
		return value === undefined ? undefined : structuredClone(value) as T;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.writes += 1;
		this.values.set(key, structuredClone(value));
	}
}

test('authoritative route reservation atomically fences local and remote starts', async () => {
	const state = new MemoryState();
	const catalog = new TaskRouteCatalog(state, () => new Date(AT));
	const local = startParams(LOCAL_DEVICE_ID);
	const remote = {
		...startParams(REMOTE_DEVICE_ID),
		sourceNodeId: LOCAL_NODE_ID,
	};

	const results = await Promise.allSettled([
		catalog.reserveLocal(local, { nodeId: LOCAL_NODE_ID }),
		catalog.reserveRemote(remote, REMOTE_PEER_ID, LOCAL_NODE_ID),
	]);

	assert.equal(results[0].status, 'fulfilled');
	assert.equal(results[1].status, 'rejected');
	assert.ok(
		results[1].status === 'rejected'
		&& results[1].reason instanceof MeshDomainError
		&& results[1].reason.reason === 'IDEMPOTENCY_CONFLICT',
	);
	assert.equal(state.writes, 1);
	const persisted = JSON.stringify(state.values.get(TASK_ROUTE_CATALOG_STATE_KEY));
	assert.match(persisted, new RegExp(TASK_ID, 'u'));
	assert.doesNotMatch(persisted, /private path|secret prompt|prompt|output|path|secret/u);

	const retry = await Promise.all([
		catalog.reserveLocal(local, { nodeId: LOCAL_NODE_ID }),
		catalog.reserveLocal(local, { nodeId: LOCAL_NODE_ID }),
	]);
	assert.deepStrictEqual(retry[0], retry[1]);
	assert.equal(state.writes, 1);
	const restoredCatalog = new TaskRouteCatalog(state, () => new Date(AT));
	assert.deepEqual(
		await restoredCatalog.reserveLocal(local, { nodeId: LOCAL_NODE_ID }),
		retry[0],
	);
	assert.equal(state.writes, 1);
	await assert.rejects(
		catalog.reserveLocal(
			{ ...local, prompt: 'changed payload' },
			{ nodeId: LOCAL_NODE_ID },
		),
		(error: unknown) =>
			error instanceof MeshDomainError && error.reason === 'IDEMPOTENCY_CONFLICT',
	);
	await assert.rejects(
		restoredCatalog.reserveLocal(
			{ ...local, timeoutMinutes: 59 },
			{ nodeId: LOCAL_NODE_ID },
		),
		(error: unknown) =>
			error instanceof MeshDomainError && error.reason === 'IDEMPOTENCY_CONFLICT',
	);
	assert.equal(catalog.requireForNode(TASK_ID, LOCAL_NODE_ID).routeKind, 'local');
	assert.throws(
		() => catalog.requireForNode(TASK_ID, uuid(10)),
		(error: unknown) =>
			error instanceof MeshDomainError && error.reason === 'TASK_NOT_FOUND',
	);
});

test('authoritative catalog prunes oldest terminal route but retains ambiguous routes', async () => {
	const terminalState = new MemoryState(catalogState('completed'));
	const terminalCatalog = new TaskRouteCatalog(terminalState, () => new Date(AT));
	await terminalCatalog.reserveLocal(
		startParams(LOCAL_DEVICE_ID, uuid(20_001), uuid(21_001)),
		{ nodeId: LOCAL_NODE_ID },
	);
	const terminalRoutes = routes(terminalState);
	assert.equal(terminalRoutes.length, TASK_ROUTE_CATALOG_LIMIT);
	assert.equal(terminalRoutes.some(({ taskId }) => taskId === uuid(1_000)), false);
	assert.equal(terminalRoutes.some(({ taskId }) => taskId === uuid(20_001)), true);

	const ambiguousState = new MemoryState(catalogState('ambiguous'));
	const ambiguousCatalog = new TaskRouteCatalog(ambiguousState, () => new Date(AT));
	await assert.rejects(
		ambiguousCatalog.reserveLocal(
			startParams(LOCAL_DEVICE_ID, uuid(20_002), uuid(21_002)),
			{ nodeId: LOCAL_NODE_ID },
		),
		(error: unknown) =>
			error instanceof MeshDomainError && error.reason === 'RATE_LIMITED',
	);
	assert.equal(routes(ambiguousState).length, TASK_ROUTE_CATALOG_LIMIT);
});

test('authoritative catalog conditionally releases only an unshared exact ambiguous attempt', async () => {
	const state = new MemoryState();
	const catalog = new TaskRouteCatalog(state, () => new Date(AT));
	const input = startParams(LOCAL_DEVICE_ID);
	const first = await catalog.reserveLocalAttempt(input, { nodeId: LOCAL_NODE_ID });
	const retry = await catalog.reserveLocalAttempt(input, { nodeId: LOCAL_NODE_ID });

	assert.equal(await catalog.releaseAmbiguous(first, {
		taskPersisted: false,
		dispatchAttempted: false,
	}), false);
	assert.equal(routes(state).length, 1);
	await catalog.retainAmbiguous(retry);
	assert.equal(routes(state).length, 1);

	const fresh = startParams(LOCAL_DEVICE_ID, uuid(30_001), uuid(31_001));
	const releasable = await catalog.reserveLocalAttempt(fresh, { nodeId: LOCAL_NODE_ID });
	assert.equal(await catalog.releaseAmbiguous(releasable, {
		taskPersisted: false,
		dispatchAttempted: false,
	}), true);
	assert.equal(catalog.get(fresh.taskId), undefined);
});

test('authoritative route catalog fails closed for unknown or corrupt versions', () => {
	for (const value of [
		{ schemaVersion: 2, routes: [] },
		{ schemaVersion: 1, routes: [{ taskId: TASK_ID, prompt: 'secret prompt' }] },
	]) {
		assert.throws(
			() => new TaskRouteCatalog(new MemoryState(value)),
			/Invalid persisted authoritative task route catalog/u,
		);
	}
});

function startParams(
	deviceId: string,
	taskId = TASK_ID,
	delegationRequestId = DELEGATION_ID,
): RoutedTaskStartParams {
	return {
		delegationRequestId,
		taskId,
		target: {
			deviceId,
			nodeId: TARGET_NODE_ID,
			nodeInstanceId: TARGET_INSTANCE_ID,
			workspaceId: WORKSPACE_ID,
		},
		sourceNodeId: LOCAL_NODE_ID,
		sourceWorkspaceIdentity: `sha256:${'A'.repeat(43)}`,
		title: 'Safe title',
		prompt: 'secret prompt with private path',
		acceptanceCriteria: ['Tests pass.'],
		timeoutMinutes: 60,
		workerDeadline: '2026-08-25T13:00:00.000Z',
	};
}

function catalogState(state: 'completed' | 'ambiguous'): unknown {
	return {
		schemaVersion: 1,
		routes: Array.from({ length: TASK_ROUTE_CATALOG_LIMIT }, (_, index) => ({
			taskId: uuid(index + 1_000),
			delegationRequestId: uuid(index + 3_000),
			requestHash: 'a'.repeat(64),
			target: {
				deviceId: LOCAL_DEVICE_ID,
				nodeId: TARGET_NODE_ID,
				nodeInstanceId: TARGET_INSTANCE_ID,
				workspaceId: WORKSPACE_ID,
			},
			routeKind: 'local',
			sourceNodeId: LOCAL_NODE_ID,
			createdAt: new Date(Date.parse(AT) + index).toISOString(),
			state,
			...(state === 'completed'
				? { terminalAt: new Date(Date.parse(AT) + index).toISOString() }
				: {}),
		})),
	};
}

function routes(state: MemoryState): Array<{ readonly taskId: string }> {
	return (state.values.get(TASK_ROUTE_CATALOG_STATE_KEY) as {
		readonly routes: Array<{ readonly taskId: string }>;
	}).routes;
}

function uuid(index: number): string {
	return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}
