import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	MESH_ERROR_CODES,
	type NodeDirectoryResult,
	type RoutedTaskStartParams,
	type TaskSnapshot,
} from '../../shared/protocol';
import type { DelegationIntentInput, TaskToolSnapshot } from '../../shared/toolProtocol';
import { LocalIpcRemoteError } from '../ipc';
import {
	deterministicTaskId,
	LocalBrokerTaskFacade,
} from '../tools/LocalBrokerTaskFacade';
import { TaskToolFacadeError } from '../tools/taskToolFacade';
import {
	createOpaqueWorkspaceIdentity,
	createWorkspaceScopeIdentity,
} from '../workspaces/OpaqueWorkspaceIdentity';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const NODE_ID = '00000000-0000-4000-8000-000000000002';
const NODE_INSTANCE_ID = '00000000-0000-4000-8000-000000000003';
const OTHER_NODE_ID = '00000000-0000-4000-8000-000000000004';
const OTHER_INSTANCE_ID = '00000000-0000-4000-8000-000000000005';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000006';
const DELEGATION_ID = '00000000-0000-4000-8000-000000000007';
const INPUT_ID = '00000000-0000-4000-8000-000000000008';
const ANSWER_ID = '00000000-0000-4000-8000-000000000009';
const SOURCE_IDENTITY_A = `sha256:${'A'.repeat(43)}`;
const SOURCE_IDENTITY_B = `sha256:${'B'.repeat(43)}`;

test('local facade lists this device and every broker-listed node opaquely', async () => {
	const client = new FakeWindowNodeClient();
	const facade = new LocalBrokerTaskFacade(client, { deviceName: 'Local Device' });

	const directory = await facade.listWorkers(new AbortController().signal);

	assert.deepStrictEqual(directory, {
		devices: [{
			deviceId: DEVICE_ID,
			deviceName: 'Local Device',
			locality: 'local',
			status: 'online',
			nodesTruncated: false,
			totalNodes: 2,
			nodes: [{
				nodeId: NODE_ID,
				nodeInstanceId: NODE_INSTANCE_ID,
				label: 'This Window',
				status: 'online',
				capabilities: ['tasks'],
				workspaces: [{
					workspaceId: WORKSPACE_ID,
					name: 'Repository',
					tags: ['typescript'],
					busy: false,
					claimStatus: 'claimed',
				}],
			}, {
				nodeId: OTHER_NODE_ID,
				nodeInstanceId: OTHER_INSTANCE_ID,
				label: 'Other Window',
				status: 'busy',
				capabilities: ['tasks', 'tests'],
				workspaces: [],
			}],
		}],
		truncated: false,
	});
	assert.doesNotMatch(JSON.stringify(directory), /file:|Users|prompt|secret|output/u);
});

test('local facade reports the exact target offline instead of selecting a replacement instance', async () => {
	const client = new FakeWindowNodeClient();
	const online = await client.listNodes();
	client.directory = {
		...online,
		nodes: online.nodes.map((node) => node.nodeId === NODE_ID
			? { ...node, nodeInstanceId: OTHER_INSTANCE_ID }
			: node),
	};
	const facade = new LocalBrokerTaskFacade(client, { deviceName: 'Local Device' });

	await assert.rejects(
		() => facade.describeDelegationTarget(intent(), new AbortController().signal),
		(error: unknown) =>
			error instanceof TaskToolFacadeError
			&& error.code === 'PEER_OFFLINE'
			&& error.retryable,
	);

	client.directory = {
		...online,
		nodes: online.nodes.map((node) => node.nodeId === NODE_ID
			? { ...node, status: 'offline' as const }
			: node),
	};
	await assert.rejects(
		() => facade.describeDelegationTarget(intent(), new AbortController().signal),
		(error: unknown) =>
			error instanceof TaskToolFacadeError
			&& error.code === 'PEER_OFFLINE',
	);
});

test('stable task IDs survive facade reload and changed retries surface broker conflict', async () => {
	const client = new FakeWindowNodeClient();
	const firstFacade = new LocalBrokerTaskFacade(client, { deviceName: 'Local Device' });
	const first = await firstFacade.persistDelegationIntent(intent());
	const reloadedFacade = new LocalBrokerTaskFacade(client, { deviceName: 'Local Device' });
	const retry = await reloadedFacade.persistDelegationIntent(intent());

	assert.equal(first.taskId, deterministicTaskId(DELEGATION_ID));
	assert.equal(reloadedFacade.taskIdForDelegationRequest(DELEGATION_ID), first.taskId);
	assert.equal(retry.taskId, first.taskId);
	assert.equal(first.recovered, false);
	assert.equal(retry.recovered, true);
	assert.equal(client.startCalls, 2);
	assert.deepStrictEqual(client.lastStart?.target, {
		deviceId: DEVICE_ID,
		nodeId: NODE_ID,
		nodeInstanceId: NODE_INSTANCE_ID,
		workspaceId: WORKSPACE_ID,
	});
	assert.equal(client.lastStart?.sourceNodeId, NODE_ID);

	client.failTask(retry.taskId, 'AGENT_AUTH_REQUIRED');
	assert.deepStrictEqual(
		await reloadedFacade.waitForDelegationAcceptance(
			retry,
			new AbortController().signal,
		),
		{ status: 'accepted' },
	);
	assert.equal(client.startCalls, 2);
	await assert.rejects(
		reloadedFacade.persistDelegationIntent({
			...intent(),
			prompt: 'Changed payload.',
		}),
		(error: unknown) =>
			error instanceof TaskToolFacadeError && error.code === 'IDEMPOTENCY_CONFLICT',
	);

	const concurrentClient = new FakeWindowNodeClient();
	const concurrentFacade = new LocalBrokerTaskFacade(
		concurrentClient,
		{ deviceName: 'Local Device' },
	);
	const concurrent = await Promise.all([
		concurrentFacade.persistDelegationIntent(intent()),
		concurrentFacade.persistDelegationIntent(intent()),
	]);
	assert.equal(concurrent[0].taskId, concurrent[1].taskId);
	assert.deepStrictEqual(concurrent.map(({ recovered }) => recovered), [false, true]);
});

test('source Workspace identity scopes stable delegation keys independently of display names', async () => {
	const client = new FakeWindowNodeClient();
	const sourceA = new LocalBrokerTaskFacade(client, {
		deviceName: 'Same Display Name',
		sourceWorkspaceIdentity: () => SOURCE_IDENTITY_A,
	});
	const sourceAReloaded = new LocalBrokerTaskFacade(client, {
		deviceName: 'Renamed Display',
		sourceWorkspaceIdentity: () => SOURCE_IDENTITY_A,
	});
	const sourceB = new LocalBrokerTaskFacade(client, {
		deviceName: 'Same Display Name',
		sourceWorkspaceIdentity: () => SOURCE_IDENTITY_B,
	});

	const first = await sourceA.persistDelegationIntent(intent());
	const retry = await sourceAReloaded.persistDelegationIntent(intent());
	const independent = await sourceB.persistDelegationIntent(intent());

	assert.equal(first.taskId, deterministicTaskId(DELEGATION_ID, SOURCE_IDENTITY_A));
	assert.equal(sourceA.taskIdForDelegationRequest(DELEGATION_ID), first.taskId);
	assert.equal(retry.taskId, first.taskId);
	assert.notEqual(independent.taskId, first.taskId);
	assert.equal(independent.taskId, deterministicTaskId(DELEGATION_ID, SOURCE_IDENTITY_B));
	assert.equal(client.lastStart?.sourceWorkspaceIdentity, SOURCE_IDENTITY_B);
});

test('claimed Workspace-set scope is order-stable and changes only with membership', () => {
	const sourceC = createOpaqueWorkspaceIdentity('source-workspace-c');
	const first = createWorkspaceScopeIdentity([SOURCE_IDENTITY_A, SOURCE_IDENTITY_B]);
	const reordered = createWorkspaceScopeIdentity([SOURCE_IDENTITY_B, SOURCE_IDENTITY_A]);
	const changed = createWorkspaceScopeIdentity([SOURCE_IDENTITY_A, sourceC]);

	assert.equal(first, reordered);
	assert.notEqual(first, changed);
	assert.equal(createWorkspaceScopeIdentity([SOURCE_IDENTITY_A]), SOURCE_IDENTITY_A);
	assert.throws(() => createWorkspaceScopeIdentity([]), /scope is invalid/u);
});

test('task subscription reconciles an authoritative snapshot after Broker reconnect', async () => {
	const client = new FakeWindowNodeClient();
	const facade = new LocalBrokerTaskFacade(client, {
		deviceName: 'Local Device',
		sourceWorkspaceIdentity: () => SOURCE_IDENTITY_A,
	});
	const persisted = await facade.persistDelegationIntent(intent());
	const reconciled = new Promise<TaskToolSnapshot>((resolve, reject) => {
		const registration = facade.subscribeToTask(
			persisted.taskId,
			(snapshot) => {
				registration.dispose();
				resolve(snapshot);
			},
			reject,
		);
	});

	client.setRegistered(false);
	client.failTask(persisted.taskId, 'TASK_EXECUTION_FAILED');
	client.setRegistered(true);

	const snapshot = await reconciled;
	assert.equal(snapshot.taskId, persisted.taskId);
	assert.equal(snapshot.status, 'failed');
	assert.equal(client.stateListenerCount, 0);
});

test('local facade converts get, cancel, answer, and abort behavior', async () => {
	const client = new FakeWindowNodeClient();
	const facade = new LocalBrokerTaskFacade(client, { deviceName: 'Local Device' });
	const persisted = await facade.persistDelegationIntent(intent());
	client.setEvents(persisted.taskId, 3);

	const read = await facade.getTask({
		taskId: persisted.taskId,
		afterEventSequence: 0,
		maxEvents: 2,
	}, new AbortController().signal);
	assert.equal(read.events.length, 2);
	assert.equal(read.eventCursor, 2);
	assert.equal(read.truncated, true);

	const cancelled = await facade.cancelOwnedTask(
		{ taskId: persisted.taskId },
		new AbortController().signal,
	);
	const answered = await facade.answerOwnedTask({
		taskId: persisted.taskId,
		inputId: INPUT_ID,
		answerId: ANSWER_ID,
		answer: 'Proceed.',
	}, new AbortController().signal);
	assert.equal(cancelled.status, 'cancelled');
	assert.equal(answered.status, 'running');
	assert.deepStrictEqual(client.answers, [{
		taskId: persisted.taskId,
		inputId: INPUT_ID,
		answerId: ANSWER_ID,
		answer: 'Proceed.',
	}]);

	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(
		facade.getTask({ taskId: persisted.taskId, maxEvents: 20 }, aborted.signal),
		(error: unknown) => error instanceof Error && error.name === 'AbortError',
	);
});

test('local facade never invents remote devices or uses routing metadata as a target', async () => {
	const client = new FakeWindowNodeClient();
	const facade = new LocalBrokerTaskFacade(client, { deviceName: 'Local Device' });
	const remoteDeviceId = '00000000-0000-4000-8000-00000000000a';

	assert.equal((await facade.listWorkers(new AbortController().signal)).devices.length, 1);
	await assert.rejects(
		facade.persistDelegationIntent({
			...intent(),
			deviceId: remoteDeviceId,
			peerId: '00000000-0000-4000-8000-00000000000b',
		}),
		(error: unknown) =>
			error instanceof TaskToolFacadeError
			&& error.code === 'TUNNEL_UNAVAILABLE'
			&& error.retryable,
	);
	await assert.rejects(
		facade.persistDelegationIntent({ ...intent(), peerId: remoteDeviceId }),
		(error: unknown) =>
			error instanceof TaskToolFacadeError && error.code === 'INVALID_INPUT',
	);
});

test('local IPC Mesh reasons map safely without trusting mismatched error data', async () => {
	const client = new FakeWindowNodeClient();
	const facade = new LocalBrokerTaskFacade(client, { deviceName: 'Local Device' });
	client.listError = new LocalIpcRemoteError(
		MESH_ERROR_CODES.RATE_LIMITED,
		'Safe local broker error.',
		{ reason: 'RATE_LIMITED', retryable: true },
	);
	await assert.rejects(
		facade.listWorkers(new AbortController().signal),
		(error: unknown) =>
			error instanceof TaskToolFacadeError
			&& error.code === 'RATE_LIMITED'
			&& error.retryable,
	);

	client.listError = new LocalIpcRemoteError(
		MESH_ERROR_CODES.TASK_ID_CONFLICT,
		'Untrusted detail.',
		{ reason: 'TASK_NOT_FOUND', retryable: true },
	);
	await assert.rejects(
		facade.listWorkers(new AbortController().signal),
		(error: unknown) =>
			error instanceof TaskToolFacadeError
			&& error.code === 'INTERNAL_ERROR'
			&& !error.retryable,
	);
});

function intent(): DelegationIntentInput {
	return {
		delegationRequestId: DELEGATION_ID,
		deviceId: DEVICE_ID,
		nodeId: NODE_ID,
		nodeInstanceId: NODE_INSTANCE_ID,
		workspaceId: WORKSPACE_ID,
		title: 'Run focused tests',
		prompt: 'Implement the requested change.',
		acceptanceCriteria: ['Focused tests pass.'],
		timeoutMinutes: 30,
	};
}

class FakeWindowNodeClient {
	readonly deviceId = DEVICE_ID;
	readonly nodeId = NODE_ID;
	readonly nodeInstanceId = NODE_INSTANCE_ID;
	readonly label = 'This Window';
	readonly answers: Array<{
		taskId: string;
		inputId: string;
		answerId: string;
		answer: string;
	}> = [];
	readonly tasks = new Map<string, {
		input: RoutedTaskStartParams;
		snapshot: TaskSnapshot;
	}>();
	private readonly stateListeners = new Set<() => void>();
	private registered = true;
	startCalls = 0;
	lastStart?: RoutedTaskStartParams;
	listError?: unknown;
	directory?: NodeDirectoryResult;

	get stateListenerCount(): number {
		return this.stateListeners.size;
	}

	snapshot(): { readonly registered: boolean } {
		return { registered: this.registered };
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.stateListeners.add(listener);
		return { dispose: () => this.stateListeners.delete(listener) };
	}

	setRegistered(registered: boolean): void {
		this.registered = registered;
		for (const listener of this.stateListeners) {
			listener();
		}
	}

	async listNodes(): Promise<NodeDirectoryResult> {
		if (this.listError !== undefined) {
			throw this.listError;
		}
		return this.directory ?? {
			deviceId: DEVICE_ID,
			truncated: false,
			totalNodes: 2,
			nodes: [{
				nodeId: NODE_ID,
				nodeInstanceId: NODE_INSTANCE_ID,
				label: 'This Window',
				status: 'online',
				capabilities: ['tasks'],
				startedAt: '2026-08-25T00:00:00.000Z',
				lastHeartbeatAt: '2026-08-25T00:00:01.000Z',
				workspaces: [{
					workspaceId: WORKSPACE_ID,
					workspaceIdentity: `sha256:${'A'.repeat(43)}`,
					name: 'Repository',
					capabilityTags: ['typescript'],
					enabled: true,
					busy: false,
					acceptsIncoming: false,
					claimStatus: 'claimed',
				}],
			}, {
				nodeId: OTHER_NODE_ID,
				nodeInstanceId: OTHER_INSTANCE_ID,
				label: 'Other Window',
				status: 'busy',
				capabilities: ['tasks', 'tests'],
				startedAt: '2026-08-25T00:00:00.000Z',
				lastHeartbeatAt: '2026-08-25T00:00:01.000Z',
				workspaces: [],
			}],
		};
	}

	async startTask(input: RoutedTaskStartParams): Promise<TaskSnapshot> {
		this.startCalls += 1;
		this.lastStart = structuredClone(input);
		const existing = this.tasks.get(input.taskId);
		if (existing !== undefined) {
			if (JSON.stringify(existing.input) !== JSON.stringify(input)) {
				throw meshError('IDEMPOTENCY_CONFLICT');
			}
			return existing.snapshot;
		}
		const snapshot = taskSnapshot(input);
		this.tasks.set(input.taskId, { input: structuredClone(input), snapshot });
		return snapshot;
	}

	async getTask(taskId: string): Promise<TaskSnapshot> {
		const task = this.tasks.get(taskId);
		if (task === undefined) {
			throw meshError('TASK_NOT_FOUND');
		}
		return task.snapshot;
	}

	async cancelTask(taskId: string): Promise<TaskSnapshot> {
		const task = this.requireTask(taskId);
		task.snapshot = { ...task.snapshot, state: 'cancelled' };
		return task.snapshot;
	}

	async answerTask(
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
	): Promise<TaskSnapshot> {
		const task = this.requireTask(taskId);
		this.answers.push({ taskId, inputId, answerId, answer });
		task.snapshot = { ...task.snapshot, state: 'running' };
		return task.snapshot;
	}

	setEvents(taskId: string, count: number): void {
		const task = this.requireTask(taskId);
		task.snapshot = {
			...task.snapshot,
			eventSeq: count,
			events: Array.from({ length: count }, (_, index) => ({
				eventSeq: index + 1,
				at: '2026-08-25T00:00:01.000Z',
				type: 'progress',
				summary: `Progress ${index + 1}`,
			})),
		};
	}

	failTask(taskId: string, code: string): void {
		const task = this.requireTask(taskId);
		task.snapshot = {
			...task.snapshot,
			state: 'failed',
			failure: {
				code,
				message: 'Safe asynchronous startup failure.',
				retryable: true,
			},
		};
	}

	private requireTask(taskId: string): {
		input: RoutedTaskStartParams;
		snapshot: TaskSnapshot;
	} {
		const task = this.tasks.get(taskId);
		if (task === undefined) {
			throw meshError('TASK_NOT_FOUND');
		}
		return task;
	}
}

function taskSnapshot(input: RoutedTaskStartParams): TaskSnapshot {
	const createdAt = new Date(Date.parse(input.workerDeadline) - 30 * 60_000).toISOString();
	return {
		schemaVersion: 2,
		taskId: input.taskId,
		delegationRequestId: input.delegationRequestId,
		requestHash: 'a'.repeat(64),
		peerId: DEVICE_ID,
		workspaceId: input.target.workspaceId,
		title: input.title,
		state: 'running',
		createdAt,
		updatedAt: createdAt,
		eventSeq: 0,
		workerDeadline: input.workerDeadline,
		events: [],
		eventsTruncated: false,
		deviceId: DEVICE_ID,
	};
}

function meshError(reason: keyof typeof MESH_ERROR_CODES): LocalIpcRemoteError {
	return new LocalIpcRemoteError(
		MESH_ERROR_CODES[reason],
		'Safe local broker error.',
		{ reason, retryable: reason === 'TASK_NOT_FOUND' },
	);
}
