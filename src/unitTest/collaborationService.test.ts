import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	taskSnapshotSchema,
	type CollaborationStartParams,
	type NodeDirectoryResult,
	type RoutedTaskStartParams,
	type TaskSnapshot,
} from '../../shared/protocol';
import {
	CollaborationService,
	type CollaborationCaller,
	type CollaborationTaskService,
} from '../broker/CollaborationService';
import { TaskRouteCatalog } from '../broker/TaskRouteCatalog';
import { createCollaborationRun } from '../domain/collaboration';
import { MeshDomainError } from '../domain/errors';
import { AtomicFileStore } from '../storage/AtomicFileStore';
import { ArtifactStore } from '../tasks/ArtifactStore';
import { FileCollaborationStore } from '../tasks/FileCollaborationStore';
import {
	MemoryAtomicFileSystem,
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
const caller: CollaborationCaller = {
	nodeId: FRONTEND_NODE_ID,
	nodeInstanceId: FRONTEND_INSTANCE_ID,
};

test('orchestrator completes backend artifact handoff, frontend, and both validations', async () => {
	const fixture = createFixture();
	const started = await fixture.service.start(caller, startParams());
	assert.equal(started.status, 'running');
	assert.equal(fixture.tasks.starts.length, 1);
	assert.equal(fixture.tasks.starts[0].target.workspaceId, BACKEND_WORKSPACE_ID);

	const backend = fixture.tasks.starts[0];
	assert.equal(
		fixture.taskRoutes.requireForNode(backend.taskId, FRONTEND_NODE_ID).target.workspaceId,
		BACKEND_WORKSPACE_ID,
	);
	fixture.tasks.complete(backend.taskId, contractSummary(backend.taskId));
	fixture.service.observeTaskSnapshot(fixture.tasks.require(backend.taskId));
	const afterBackend = await fixture.service.get(caller, started.runId);
	assert.equal(afterBackend.artifacts.length, 1);
	assert.equal(afterBackend.artifacts[0].producerTaskId, backend.taskId);
	assert.equal(fixture.tasks.starts.length, 2);
	const frontend = fixture.tasks.starts[1];
	assert.equal(frontend.target.workspaceId, FRONTEND_WORKSPACE_ID);
	assert.match(frontend.prompt, new RegExp(afterBackend.artifacts[0].artifactId, 'u'));
	assert.match(frontend.prompt, new RegExp(afterBackend.artifacts[0].sha256, 'u'));
	assert.match(frontend.prompt, /"endpoint":"\/api\/items"/u);

	fixture.tasks.complete(frontend.taskId, 'Frontend implementation completed.');
	fixture.service.observeTaskSnapshot(fixture.tasks.require(frontend.taskId));
	await fixture.service.get(caller, started.runId);
	assert.equal(fixture.tasks.starts.length, 4);
	const validations = fixture.tasks.starts.slice(2);
	assert.deepStrictEqual(
		new Set(validations.map(({ target }) => target.workspaceId)),
		new Set([FRONTEND_WORKSPACE_ID, BACKEND_WORKSPACE_ID]),
	);

	for (const validation of validations) {
		fixture.tasks.complete(validation.taskId, validationSummary('passed'));
		fixture.service.observeTaskSnapshot(fixture.tasks.require(validation.taskId));
	}
	const completed = await fixture.service.get(caller, started.runId);
	assert.equal(completed.status, 'completed', JSON.stringify(completed));
	assert.equal(completed.validations.length, 2);
	assert.ok(completed.validations.every(({ status }) => status === 'passed'));
	assert.equal(fixture.tasks.starts.length, 4);
	assert.equal(fixture.tasks.cancelled.length, 0);
	await fixture.service.dispose();
});

test('orchestrator exact retry and takeover recovery never duplicate an accepted task', async () => {
	let busy = false;
	const fixture = createFixture(() => directory(busy));
	const first = await fixture.service.start(caller, startParams());
	busy = true;
	const retry = await fixture.service.start(caller, startParams());
	assert.equal(retry.runId, first.runId);
	assert.equal(fixture.tasks.starts.length, 1);
	await assert.rejects(
		fixture.service.start(caller, { ...startParams(), goal: 'Different goal.' }),
		(error: unknown) =>
			error instanceof MeshDomainError
			&& error.reason === 'COLLABORATION_ID_CONFLICT',
	);
	await fixture.service.dispose();

	const recovered = new CollaborationService(
		DEVICE_ID,
		{ list: () => directory() },
		fixture.tasks,
		new TaskRouteCatalog(),
		fixture.runs,
		fixture.artifacts,
		{ now: () => new Date(AT) },
		{ enabled: () => true },
	);
	await recovered.initialize();
	assert.equal(fixture.tasks.starts.length, 1);
	const run = await recovered.get(caller, first.runId);
	assert.equal(run.status, 'running');
	await recovered.dispose();
});

test('takeover re-dispatches a running run task when no Broker task was persisted', async () => {
	const fixture = createFixture();
	const input = startParams();
	const orphaned = createCollaborationRun(FRONTEND_NODE_ID, input, AT);
	await fixture.runs.createIdempotent(FRONTEND_NODE_ID, input, orphaned);
	await fixture.runs.transition(orphaned.runId, {
		type: 'taskDispatching',
		taskId: orphaned.tasks[0].taskId,
		at: AT,
	});

	await fixture.service.initialize();

	assert.equal(fixture.tasks.starts.length, 1);
	assert.equal(fixture.tasks.starts[0].taskId, orphaned.tasks[0].taskId);
	assert.equal((await fixture.runs.get(orphaned.runId))?.status, 'running');
	await fixture.service.dispose();
});

test('orchestrator cancellation stops the exact active task and cancels pending DAG nodes', async () => {
	const fixture = createFixture();
	const run = await fixture.service.start(caller, startParams());
	const activeTaskId = fixture.tasks.starts[0].taskId;
	const cancelled = await fixture.service.cancel(caller, run.runId);
	assert.deepStrictEqual(fixture.tasks.cancelled, [activeTaskId]);
	assert.equal(cancelled.status, 'cancelled');
	assert.ok(cancelled.tasks.every(({ status }) => status === 'cancelled'));
	assert.equal(fixture.tasks.starts.length, 1);
	await fixture.service.dispose();
});

test('orchestrator blocks dependencies on failure and rejects unavailable participant routes', async () => {
	const fixture = createFixture();
	const run = await fixture.service.start(caller, startParams());
	const backend = fixture.tasks.starts[0];
	fixture.tasks.fail(backend.taskId);
	fixture.service.observeTaskSnapshot(fixture.tasks.require(backend.taskId));
	const failed = await fixture.service.get(caller, run.runId);
	assert.equal(failed.status, 'failed');
	assert.equal(failed.tasks[0].status, 'failed');
	assert.ok(failed.tasks.slice(1).every(({ status }) => status === 'blocked'));
	assert.equal(fixture.tasks.starts.length, 1);
	await fixture.service.dispose();

	const unavailable = createFixture(directory(true));
	await assert.rejects(
		unavailable.service.start(caller, {
			...startParams(),
			collaborationRequestId: uuid(90),
		}),
		(error: unknown) =>
			error instanceof MeshDomainError && error.reason === 'WORKSPACE_BUSY',
	);
	assert.equal((await unavailable.runs.list()).length, 0);
	await unavailable.service.dispose();
});

test('orchestrator fails closed when a completed backend emits an invalid artifact', async () => {
	const fixture = createFixture();
	const run = await fixture.service.start(caller, startParams());
	const backend = fixture.tasks.starts[0];
	fixture.tasks.complete(backend.taskId, 'Task completed without a contract.');
	fixture.service.observeTaskSnapshot(fixture.tasks.require(backend.taskId));
	const failed = await fixture.service.get(caller, run.runId);
	assert.equal(failed.status, 'failed');
	assert.equal(failed.tasks[0].failure?.code, 'ARTIFACT_INVALID');
	assert.equal(fixture.tasks.starts.length, 1);
	await fixture.service.dispose();
});

function createFixture(
	customDirectory: NodeDirectoryResult | (() => NodeDirectoryResult) = directory(),
) {
	const memory = new MemoryAtomicFileSystem();
	const files = new AtomicFileStore('memory', memory, {
		next: () => `temporary-${memory.files.size}`,
	});
	const runs = new FileCollaborationStore(files);
	const artifacts = new ArtifactStore(files);
	const tasks = new FakeTaskService();
	const taskRoutes = new TaskRouteCatalog();
	const service = new CollaborationService(
		DEVICE_ID,
		{
			list: () => typeof customDirectory === 'function'
				? customDirectory()
				: customDirectory,
		},
		tasks,
		taskRoutes,
		runs,
		artifacts,
		{ now: () => new Date(AT) },
		{ enabled: () => true },
	);
	return { service, tasks, taskRoutes, runs, artifacts };
}

class FakeTaskService implements CollaborationTaskService {
	public readonly starts: RoutedTaskStartParams[] = [];
	public readonly cancelled: string[] = [];
	private readonly snapshots = new Map<string, TaskSnapshot>();
	private readonly requests = new Map<string, RoutedTaskStartParams>();

	public async startLocal(
		_sourceNodeId: string,
		input: RoutedTaskStartParams,
	): Promise<TaskSnapshot> {
		const existing = this.snapshots.get(input.taskId);
		if (existing !== undefined) {
			return existing;
		}
		this.starts.push(structuredClone(input));
		this.requests.set(input.taskId, structuredClone(input));
		const snapshot = taskSnapshot(input, 'accepted');
		this.snapshots.set(input.taskId, snapshot);
		return snapshot;
	}

	public async prevalidateLocal(
		_sourceNodeId: string,
		_input: RoutedTaskStartParams,
	): Promise<void> {}

	public async reconcileStartFailure(
		_ownerId: string,
		taskId: string,
		outcome: { nodeRequestAttempted: boolean },
	) {
		const snapshot = this.snapshots.get(taskId);
		return snapshot === undefined && !outcome.nodeRequestAttempted
			? {
				kind: 'notDispatched' as const,
				taskPersisted: false as const,
				dispatchAttempted: false as const,
			}
			: { kind: 'retained' as const, snapshot };
	}

	public async getLocal(taskId: string): Promise<TaskSnapshot> {
		const snapshot = this.snapshots.get(taskId);
		if (snapshot === undefined) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'Task not found.');
		}
		return snapshot;
	}

	public async cancel(_ownerId: string, taskId: string): Promise<TaskSnapshot> {
		const request = this.requests.get(taskId);
		if (request === undefined) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'Task not found.');
		}
		this.cancelled.push(taskId);
		const snapshot = taskSnapshot(request, 'cancelled', 'Task cancellation was confirmed.');
		this.snapshots.set(taskId, snapshot);
		return snapshot;
	}

	public complete(taskId: string, summary: string): void {
		const request = this.requests.get(taskId);
		assert.ok(request);
		this.snapshots.set(taskId, taskSnapshot(request, 'completed', summary));
	}

	public fail(taskId: string): void {
		const request = this.requests.get(taskId);
		assert.ok(request);
		this.snapshots.set(taskId, taskSnapshot(request, 'failed'));
	}

	public require(taskId: string): TaskSnapshot {
		const snapshot = this.snapshots.get(taskId);
		assert.ok(snapshot);
		return snapshot;
	}
}

function taskSnapshot(
	request: RoutedTaskStartParams,
	state: TaskSnapshot['state'],
	summary?: string,
): TaskSnapshot {
	const terminal = state === 'completed' || state === 'cancelled' || state === 'failed';
	const event = terminal ? [{
		eventSeq: 1,
		at: AT,
		type: state,
		...(summary === undefined ? {} : { summary }),
	}] : [];
	return taskSnapshotSchema.parse({
		schemaVersion: 2,
		taskId: request.taskId,
		delegationRequestId: request.delegationRequestId,
		requestHash: 'a'.repeat(64),
		peerId: DEVICE_ID,
		workspaceId: request.target.workspaceId,
		title: request.title,
		state,
		createdAt: AT,
		updatedAt: AT,
		eventSeq: event.length,
		workerDeadline: request.workerDeadline,
		...(state === 'cancelled' ? { cancellationDeadline: AT } : {}),
		...(state === 'completed' || state === 'cancelled' ? { summary: summary ?? 'Done.' } : {}),
		...(state === 'failed' ? {
			failure: {
				code: 'TASK_EXECUTION_FAILED',
				message: 'Task failed safely.',
				retryable: false,
			},
		} : {}),
		events: event,
		eventsTruncated: false,
		deviceId: DEVICE_ID,
	});
}

function directory(backendBusy = false): NodeDirectoryResult {
	return {
		deviceId: DEVICE_ID,
		nodes: [
			{
				nodeId: FRONTEND_NODE_ID,
				nodeInstanceId: FRONTEND_INSTANCE_ID,
				label: 'Frontend Window',
				status: 'online',
				capabilities: ['agentRuntime'],
				startedAt: AT,
				lastHeartbeatAt: AT,
				workspaces: [{
					workspaceId: FRONTEND_WORKSPACE_ID,
					name: 'frontend',
					capabilityTags: ['frontend'],
					enabled: true,
					busy: false,
					claimStatus: 'claimed',
				}],
			},
			{
				nodeId: BACKEND_NODE_ID,
				nodeInstanceId: BACKEND_INSTANCE_ID,
				label: 'Backend Window',
				status: 'online',
				capabilities: ['agentRuntime'],
				startedAt: AT,
				lastHeartbeatAt: AT,
				workspaces: [{
					workspaceId: BACKEND_WORKSPACE_ID,
					name: 'backend',
					capabilityTags: ['backend'],
					enabled: true,
					busy: backendBusy,
					claimStatus: 'claimed',
				}],
			},
		],
		truncated: false,
		totalNodes: 2,
	};
}

function startParams(): CollaborationStartParams {
	return {
		collaborationRequestId: REQUEST_ID,
		title: 'Implement items API',
		goal: 'Implement the backend items API and consume it from the frontend.',
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

function contractSummary(_taskId: string): string {
	return [
		'MESH_CONTRACT_ARTIFACT_V1_BEGIN',
		JSON.stringify({
			schemaVersion: 1,
			label: 'Items API contract',
			mediaType: 'application/schema+json',
			content: {
				endpoint: '/api/items',
				response: {
					type: 'array',
					items: { type: 'string' },
				},
			},
		}),
		'MESH_CONTRACT_ARTIFACT_V1_END',
	].join('\n');
}

function validationSummary(status: 'passed' | 'failed'): string {
	return [
		'MESH_VALIDATION_RESULT_V1_BEGIN',
		JSON.stringify({
			schemaVersion: 1,
			status,
			summary: status === 'passed' ? 'Relevant project checks passed.' : 'Project checks failed.',
		}),
		'MESH_VALIDATION_RESULT_V1_END',
	].join('\n');
}
