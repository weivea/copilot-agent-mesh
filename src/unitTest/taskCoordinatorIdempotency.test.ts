import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	TaskCoordinator,
	type CoordinatorPeerConnection,
	type CoordinatorPeerManager,
	type LegacyCoordinatorDelegationInput,
} from '../application/TaskCoordinator';
import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import { TaskToolFacadeError } from '../tools/taskToolFacade';

const peerId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const deviceId = '00000000-0000-4000-8000-000000000003';
const requestId = '00000000-0000-4000-8000-000000000004';
const firstTaskId = '00000000-0000-4000-8000-000000000005';
const secondTaskId = '00000000-0000-4000-8000-000000000006';
const firstGeneratedRequestId = '00000000-0000-4000-8000-000000000007';
const secondGeneratedRequestId = '00000000-0000-4000-8000-000000000008';

test('a completed same-payload rerun without a key creates and audits a new task', async () => {
	const starts: Record<string, unknown>[] = [];
	const ids = [
		firstGeneratedRequestId,
		firstTaskId,
		secondGeneratedRequestId,
		secondTaskId,
	];
	const coordinator = createCoordinator(async (method, params) => {
		assert.equal(method, 'task.start');
		starts.push(params);
		return completedSnapshot(params);
	}, () => ids.shift()!);

	const first = await coordinator.startTask(delegationInput(), new AbortController().signal);
	const second = await coordinator.startTask(delegationInput(), new AbortController().signal);

	assert.equal(first.taskId, firstTaskId);
	assert.equal(second.taskId, secondTaskId);
	assert.notEqual(first.delegationRequestId, second.delegationRequestId);
	assert.deepStrictEqual(
		starts.map(({ taskId }) => taskId),
		[firstTaskId, secondTaskId],
	);
	assert.equal(coordinator.listKnownTasks().length, 2);
});

test('an explicit ACK retry recovers the same durable task ID', async () => {
	const starts: Record<string, unknown>[] = [];
	const coordinator = createCoordinator(async (_method, params) => {
		starts.push(params);
		return completedSnapshot(params);
	}, () => firstTaskId);
	const input = { ...delegationInput(), delegationRequestId: requestId };

	const first = await coordinator.startTask(input, new AbortController().signal);
	const retry = await coordinator.startTask(input, new AbortController().signal);

	assert.equal(first.taskId, firstTaskId);
	assert.equal(first.recovered, false);
	assert.equal(retry.taskId, firstTaskId);
	assert.equal(retry.recovered, true);
	assert.deepStrictEqual(
		starts.map(({ delegationRequestId, taskId }) => ({ delegationRequestId, taskId })),
		[
			{ delegationRequestId: requestId, taskId: firstTaskId },
			{ delegationRequestId: requestId, taskId: firstTaskId },
		],
	);
	assert.equal(coordinator.listKnownTasks().length, 1);
});

test('an explicit inflight retry recovers the same durable task ID', async () => {
	const gate = new Deferred<void>();
	const starts: Record<string, unknown>[] = [];
	const coordinator = createCoordinator(async (_method, params) => {
		starts.push(params);
		await gate.promise;
		return completedSnapshot(params);
	}, () => firstTaskId);
	const input = { ...delegationInput(), delegationRequestId: requestId };

	const first = coordinator.startTask(input, new AbortController().signal);
	await waitFor(() => starts.length === 1);
	const retry = coordinator.startTask(input, new AbortController().signal);
	await waitFor(() => starts.length === 2);
	gate.resolve();
	const [firstResult, retryResult] = await Promise.all([first, retry]);

	assert.equal(firstResult.taskId, firstTaskId);
	assert.equal(retryResult.taskId, firstTaskId);
	assert.equal(retryResult.recovered, true);
	assert.deepStrictEqual(starts.map(({ taskId }) => taskId), [firstTaskId, firstTaskId]);
});

test('reusing an explicit key with a different payload conflicts', async () => {
	const coordinator = createCoordinator(async (_method, params) => completedSnapshot(params), () => firstTaskId);
	await coordinator.persistDelegationIntent({
		...delegationInput(),
		delegationRequestId: requestId,
	});

	await assert.rejects(
		coordinator.persistDelegationIntent({
			...delegationInput(),
			delegationRequestId: requestId,
			prompt: 'A different task payload.',
		}),
		(error: unknown) => (
			error instanceof TaskToolFacadeError
			&& error.code === 'TASK_ID_CONFLICT'
		),
	);
	assert.equal(coordinator.listKnownTasks().length, 1);
});

function createCoordinator(
	request: CoordinatorPeerConnection['request'],
	id: () => string,
): TaskCoordinator {
	const connection: CoordinatorPeerConnection = {
		profileId: peerId,
		snapshot: () => ({ state: 'online' }),
		request,
	};
	const peers: CoordinatorPeerManager = {
		listConnections: () => [connection],
		isEnabled: () => true,
		get: () => connection,
	};
	return new TaskCoordinator(
		peers,
		new InMemoryPeerProfileStore(),
		new MemoryState(),
		new LocalDesktopWorkspaceGuard(() => ({
			remoteName: undefined,
			isTrusted: true,
			workspaceFolders: [{ uriScheme: 'file' }],
		})),
		id,
		() => new Date('2026-08-25T00:00:00.000Z'),
	);
}

function delegationInput(): LegacyCoordinatorDelegationInput {
	return {
		peerId,
		workspaceId,
		title: 'Run focused tests',
		prompt: 'Implement and verify the requested behavior.',
		acceptanceCriteria: ['Focused tests pass.'],
		timeoutMinutes: 30,
	};
}

function completedSnapshot(params: Record<string, unknown>): Record<string, unknown> {
	return {
		schemaVersion: 1,
		taskId: params.taskId,
		delegationRequestId: params.delegationRequestId,
		requestHash: 'a'.repeat(64),
		peerId,
		workspaceId,
		title: params.title,
		state: 'completed',
		createdAt: '2026-08-25T00:00:00.000Z',
		updatedAt: '2026-08-25T00:00:01.000Z',
		eventSeq: 0,
		workerDeadline: params.workerDeadline,
		summary: 'Done.',
		events: [],
		eventsTruncated: false,
		deviceId,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 100 && !predicate(); index += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal(predicate(), true);
}

class Deferred<T> {
	public readonly promise: Promise<T>;
	private resolvePromise!: (value: T | PromiseLike<T>) => void;

	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: T): void {
		this.resolvePromise(value);
	}
}

class MemoryState {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}
