import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	persistedCollaborationRunSchema,
	type CollaborationStartParams,
} from '../../shared/protocol';
import {
	collaborationReducer,
	createCollaborationRun,
	readyCollaborationTasks,
} from '../domain/collaboration';
import { MeshDomainError } from '../domain/errors';
import { AtomicFileStore } from '../storage/AtomicFileStore';
import { FileCollaborationStore } from '../tasks/FileCollaborationStore';
import {
	MemoryAtomicFileSystem,
	TestOwnership,
	uuid,
} from './collaborationTestSupport';

const DEVICE_ID = uuid(1);
const FRONTEND_NODE_ID = uuid(2);
const FRONTEND_INSTANCE_ID = uuid(3);
const FRONTEND_WORKSPACE_ID = uuid(4);
const BACKEND_NODE_ID = uuid(5);
const BACKEND_INSTANCE_ID = uuid(6);
const BACKEND_WORKSPACE_ID = uuid(7);
const REQUEST_ID = uuid(8);
const AT = '2026-08-30T06:00:00.000Z';

test('collaboration reducer schedules the DAG and propagates dependency failure', () => {
	let run = createCollaborationRun(FRONTEND_NODE_ID, startParams(), AT);
	assert.equal(run.status, 'pending');
	assert.deepStrictEqual(
		readyCollaborationTasks(run).map(({ role, kind }) => `${role}:${kind}`),
		['backend:implementation'],
	);

	const backend = run.tasks[0];
	run = collaborationReducer(run, {
		type: 'taskDispatching',
		taskId: backend.taskId,
		at: next(1),
	});
	assert.equal(run.status, 'running');
	run = collaborationReducer(run, {
		type: 'taskFailed',
		taskId: backend.taskId,
		at: next(2),
		failure: {
			code: 'TASK_EXECUTION_FAILED',
			message: 'Backend failed safely.',
			retryable: false,
		},
	});
	assert.equal(run.status, 'failed');
	assert.equal(run.tasks[0].status, 'failed');
	assert.ok(run.tasks.slice(1).every(({ status }) => status === 'blocked'));
	assert.ok(run.tasks.slice(1).every(({ block }) => block?.code === 'DEPENDENCY_FAILED'));
	assert.deepStrictEqual(readyCollaborationTasks(run), []);
});

test('collaboration reducer cancels active work and never starts pending dependencies', () => {
	let run = createCollaborationRun(FRONTEND_NODE_ID, startParams(), AT);
	const backend = run.tasks[0];
	run = collaborationReducer(run, {
		type: 'taskDispatching',
		taskId: backend.taskId,
		at: next(1),
	});
	run = collaborationReducer(run, { type: 'cancelRequested', at: next(2) });
	assert.equal(run.status, 'running');
	assert.equal(run.tasks[0].status, 'running');
	assert.ok(run.tasks.slice(1).every(({ status }) => status === 'cancelled'));

	run = collaborationReducer(run, {
		type: 'taskCancelled',
		taskId: backend.taskId,
		at: next(3),
	});
	assert.equal(run.status, 'cancelled');
	assert.ok(run.tasks.every(({ status }) => status === 'cancelled'));
});

test('collaboration schema rejects cycles and duplicate workspaces', () => {
	const run = createCollaborationRun(FRONTEND_NODE_ID, startParams(), AT);
	assert.throws(() => persistedCollaborationRunSchema.parse({
		...run,
		tasks: run.tasks.map((task, index) => index === 0
			? { ...task, dependsOn: [run.tasks[1].taskId] }
			: task),
	}));
	assert.throws(
		() => createCollaborationRun(FRONTEND_NODE_ID, {
			...startParams(),
			backend: {
				...startParams().backend,
				workspaceId: FRONTEND_WORKSPACE_ID,
			},
		}, AT),
		(error: unknown) =>
			error instanceof MeshDomainError
			&& error.reason === 'COLLABORATION_DAG_INVALID',
	);
});

test('file collaboration store provides exact idempotency and generation fencing', async () => {
	const memory = new MemoryAtomicFileSystem();
	const ownership = new TestOwnership();
	const store = new FileCollaborationStore(
		new AtomicFileStore('memory', memory, { next: () => 'temporary-id' }),
		{ ownership, generation: ownership.generation },
	);
	const input = startParams();
	const run = createCollaborationRun(FRONTEND_NODE_ID, input, AT);
	const first = await store.createIdempotent(FRONTEND_NODE_ID, input, run);
	const retry = await store.createIdempotent(FRONTEND_NODE_ID, input, run);
	assert.equal(first.created, true);
	assert.equal(retry.created, false);
	assert.equal(retry.run.runId, first.run.runId);

	await assert.rejects(
		store.createIdempotent(
			FRONTEND_NODE_ID,
			{ ...input, goal: 'A different goal.' },
			createCollaborationRun(
				FRONTEND_NODE_ID,
				{ ...input, goal: 'A different goal.' },
				AT,
			),
		),
		(error: unknown) =>
			error instanceof MeshDomainError
			&& error.reason === 'COLLABORATION_ID_CONFLICT',
	);

	ownership.generation = 'generation-2';
	await assert.rejects(
		store.transition(run.runId, {
			type: 'taskDispatching',
			taskId: run.tasks[0].taskId,
			at: next(1),
		}),
		(error: unknown) =>
			error instanceof MeshDomainError && error.reason === 'WORKER_DRAINING',
	);
	const recovered = new FileCollaborationStore(
		new AtomicFileStore('memory', memory, { next: () => 'next-id' }),
		{ ownership, generation: ownership.generation },
	);
	assert.equal((await recovered.get(run.runId))?.status, 'pending');
});

function startParams(): CollaborationStartParams {
	return {
		collaborationRequestId: REQUEST_ID,
		title: 'Ship frontend and backend',
		goal: 'Implement a bounded API and consume it.',
		frontend: {
			deviceId: DEVICE_ID,
			nodeId: FRONTEND_NODE_ID,
			nodeInstanceId: FRONTEND_INSTANCE_ID,
			workspaceId: FRONTEND_WORKSPACE_ID,
		},
		backend: {
			deviceId: DEVICE_ID,
			nodeId: BACKEND_NODE_ID,
			nodeInstanceId: BACKEND_INSTANCE_ID,
			workspaceId: BACKEND_WORKSPACE_ID,
		},
		timeoutMinutes: 60,
	};
}

function next(offset: number): string {
	return new Date(Date.parse(AT) + offset * 1_000).toISOString();
}
