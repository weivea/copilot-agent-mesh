import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import type {
	AgentRuntime,
	AgentRuntimeEvent,
	AgentRuntimeProbe,
	AgentTaskAnswer,
	AgentTaskHandle,
	AgentTaskRequest,
} from '../agentHost/AgentRuntime';
import { AgentRuntimeError, createAgentRuntimeEventQueue } from '../agentHost/AgentRuntime';
import { MeshDomainError } from '../domain/errors';
import { canonicalRoutedTaskRequestHash } from '../domain/task';
import { toDeviceBrokerHandlerError } from '../broker/DeviceBroker';
import { LocalIpcRemoteError } from '../ipc';
import {
	WindowNodeTaskExecutor,
	type WindowNodeTaskConfirmationRequest,
	type WindowNodeTaskExecutorOptions,
} from '../node';
import { createDelegationGrant } from '../node/DelegationGrant';
import { toWindowNodeHandlerError } from '../node/WindowNodeClient';
import type { NodeTaskEventParams, NodeTaskStartParams } from '../../shared/protocol';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const NODE_ID = '00000000-0000-4000-8000-000000000002';
const NODE_INSTANCE_ID = '00000000-0000-4000-8000-000000000003';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000004';
const WORKSPACE_IDENTITY = `sha256:${'a'.repeat(43)}`;
const OWNER_ID = '00000000-0000-4000-8000-000000000005';
const TASK_ID = '00000000-0000-4000-8000-000000000006';
const INPUT_ID = '00000000-0000-4000-8000-000000000007';
const ANSWER_ID = '00000000-0000-4000-8000-000000000008';
const SECOND_INPUT_ID = '00000000-0000-4000-8000-00000000000b';

test('preserves stable Agent runtime failures across the authenticated local IPC boundary', () => {
	const auth = toWindowNodeHandlerError(
		new AgentRuntimeError('AGENT_AUTH_REQUIRED', 'Sensitive auth detail.', true),
	);
	assert.equal(auth.code, 1012);
	assert.equal(auth.message, 'The Window Node Agent runtime request could not be completed.');
	assert.deepEqual(auth.data, {
		reason: 'AGENT_AUTH_REQUIRED',
		retryable: true,
	});

	const configuration = toWindowNodeHandlerError(
		new AgentRuntimeError('AGENT_CONFIG_REQUIRED', 'Sensitive configuration detail.'),
	);
	assert.equal(configuration.code, 1013);
	assert.deepEqual(configuration.data, {
		reason: 'TASK_EXECUTION_FAILED',
		retryable: false,
	});

	const routed = toDeviceBrokerHandlerError(
		new LocalIpcRemoteError(1012, 'Safe target error.', {
			reason: 'AGENT_AUTH_REQUIRED',
			retryable: true,
		}),
	);
	assert.equal(routed.code, 1012);
	assert.deepEqual(routed.data, {
		reason: 'AGENT_AUTH_REQUIRED',
		retryable: true,
	});
});

class TestHandle implements AgentTaskHandle {
	public readonly events = createAgentRuntimeEventQueue();
	public readonly recovery = {
		clientId: 'client',
		sessionUri: 'session',
		chatUri: 'conversation',
		lastSeenServerSeq: 1,
	};
	public readonly answers: AgentTaskAnswer[] = [];
	public cancelCalls = 0;
	public disposeCalls = 0;

	public constructor(public readonly taskId: string) {}

	public cancel(): Promise<void> {
		this.cancelCalls += 1;
		return Promise.resolve();
	}

	public answer(answer: AgentTaskAnswer): Promise<void> {
		this.answers.push(answer);
		return Promise.resolve();
	}

	public dispose(): Promise<void> {
		this.disposeCalls += 1;
		this.events.close();
		return Promise.resolve();
	}
}

class TestRuntime implements AgentRuntime {
	public probeResult: AgentRuntimeProbe = { available: true, featureEnabled: true };
	public readonly requests: AgentTaskRequest[] = [];
	public readonly handles: TestHandle[] = [];

	public probe(): Promise<AgentRuntimeProbe> {
		return Promise.resolve(this.probeResult);
	}

	public start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		this.requests.push(request);
		const handle = new TestHandle(request.taskId);
		this.handles.push(handle);
		return Promise.resolve(handle);
	}

	public dispose(): Promise<void> {
		return Promise.resolve();
	}
}

class InterruptibleStartRuntime implements AgentRuntime {
	public disposeCalls = 0;
	public readonly startEntered: Promise<void>;
	private resolveStartEntered!: () => void;
	private rejectStart!: (error: Error) => void;

	public constructor() {
		this.startEntered = new Promise((resolve) => {
			this.resolveStartEntered = resolve;
		});
	}

	public probe(): Promise<AgentRuntimeProbe> {
		return Promise.resolve({ available: true, featureEnabled: true });
	}

	public start(): Promise<AgentTaskHandle> {
		this.resolveStartEntered();
		return new Promise((_, reject) => {
			this.rejectStart = reject;
		});
	}

	public dispose(): Promise<void> {
		this.disposeCalls += 1;
		this.rejectStart(new Error('Runtime start interrupted by disposal.'));
		return Promise.resolve();
	}
}

class RetryCleanupRuntime implements AgentRuntime {
	public readonly handle = new TestHandle(TASK_ID);
	public disposeCalls = 0;

	public probe(): Promise<AgentRuntimeProbe> {
		return Promise.resolve({ available: true, featureEnabled: true });
	}

	public start(): Promise<AgentTaskHandle> {
		return Promise.resolve(this.handle);
	}

	public dispose(): Promise<void> {
		this.disposeCalls += 1;
		return this.disposeCalls === 1
			? Promise.reject(new Error('runtime cleanup failed'))
			: Promise.resolve();
	}
}

class RetryCancelHandle extends TestHandle {
	public override cancel(): Promise<void> {
		this.cancelCalls += 1;
		return this.cancelCalls === 1
			? Promise.reject(new Error('handle cancellation cleanup failed'))
			: Promise.resolve();
	}
}

class RetryCancelRuntime implements AgentRuntime {
	public readonly handle = new RetryCancelHandle(TASK_ID);
	public disposeCalls = 0;

	public probe(): Promise<AgentRuntimeProbe> {
		return Promise.resolve({ available: true, featureEnabled: true });
	}

	public start(): Promise<AgentTaskHandle> {
		return Promise.resolve(this.handle);
	}

	public dispose(): Promise<void> {
		this.disposeCalls += 1;
		return Promise.resolve();
	}
}

interface Fixture {
	readonly runtime: TestRuntime;
	readonly events: NodeTaskEventParams[];
	readonly confirmations: WindowNodeTaskConfirmationRequest[];
	readonly executor: WindowNodeTaskExecutor;
}

function createFixture(
	overrides: Partial<WindowNodeTaskExecutorOptions> = {},
): Fixture {
	const runtime = new TestRuntime();
	const events: NodeTaskEventParams[] = [];
	const confirmations: WindowNodeTaskConfirmationRequest[] = [];
	const options: WindowNodeTaskExecutorOptions = {
		nodeId: NODE_ID,
		nodeInstanceId: NODE_INSTANCE_ID,
		nodeLabel: 'Target Window',
		runtime,
		workspaceResolver: {
			resolve: async (workspaceId) => workspaceId === WORKSPACE_ID
				? {
					workspaceId,
					workspaceIdentity: WORKSPACE_IDENTITY,
					displayName: 'Current Workspace',
					uri: 'file:///workspace',
				}
				: undefined,
		},
		confirmationHost: {
			confirm: async (request) => {
				confirmations.push(request);
				return 'once';
			},
		},
		eventSink: {
			publish: async (event) => {
				events.push(event);
			},
		},
		ids: { next: () => INPUT_ID },
		clock: { now: () => new Date('2026-08-25T12:00:00.000Z') },
		...overrides,
	};
	return {
		runtime,
		events,
		confirmations,
		executor: new WindowNodeTaskExecutor(options),
	};
}

function startParams(changes: Partial<NodeTaskStartParams> = {}): NodeTaskStartParams {
	const params = {
		delegationRequestId: '00000000-0000-4000-8000-000000000009',
		taskId: TASK_ID,
		target: {
			deviceId: DEVICE_ID,
			nodeId: NODE_ID,
			nodeInstanceId: NODE_INSTANCE_ID,
			workspaceId: WORKSPACE_ID,
		},
		sourceNodeId: '00000000-0000-4000-8000-00000000000a',
		title: 'Implement task',
		prompt: 'Complete prompt text',
		acceptanceCriteria: ['It works'],
		workerDeadline: '2026-08-25T13:00:00.000Z',
		authenticatedOwnerId: OWNER_ID,
		sourceLabel: 'Source Window',
		...changes,
	};
	return {
		...params,
		delegatedExecutionContext: changes.delegatedExecutionContext ?? {
			kind: 'delegatedChild',
			taskId: params.taskId,
			capability: 'd'.repeat(43),
		},
		delegationGrant: changes.delegationGrant ?? createDelegationGrant({
			taskId: params.taskId,
			targetNodeId: params.target.nodeId,
			targetNodeInstanceId: params.target.nodeInstanceId,
			workspaceIdentity: WORKSPACE_IDENTITY,
			requestHash: canonicalRoutedTaskRequestHash({
				delegationRequestId: params.delegationRequestId,
				taskId: params.taskId,
				target: params.target,
				sourceNodeId: params.sourceNodeId,
				sourceWorkspaceIdentity: params.sourceWorkspaceIdentity,
				title: params.title,
				prompt: params.prompt,
				acceptanceCriteria: [...params.acceptanceCriteria],
				timeoutMinutes: params.timeoutMinutes,
				workerDeadline: params.workerDeadline,
				peerId: params.authenticatedOwnerId,
				workspaceLeaseKey: WORKSPACE_IDENTITY,
			}),
		}),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	assert.fail('Timed out waiting for asynchronous task processing.');
}

function isReason(error: unknown, reason: string): boolean {
	return error instanceof MeshDomainError && error.reason === reason;
}

test('validates exact routes, local workspaces, and production runtime availability', async () => {
	const route = createFixture();
	assert.throws(
		() => route.executor.start(startParams({
			target: { ...startParams().target, nodeInstanceId: '00000000-0000-4000-8000-00000000000b' },
		})),
		(error: unknown) => isReason(error, 'AGENT_UNAVAILABLE'),
	);
	await route.executor.dispose();

	const workspace = createFixture();
	await assert.rejects(
		workspace.executor.start(startParams({
			target: { ...startParams().target, workspaceId: '00000000-0000-4000-8000-00000000000c' },
		})),
		(error: unknown) => isReason(error, 'WORKSPACE_NOT_FOUND'),
	);
	await workspace.executor.dispose();

	const runtime = new TestRuntime();
	runtime.probeResult = { available: false, featureEnabled: false };
	const unavailable = createFixture({ runtime });
	await assert.rejects(
		unavailable.executor.start(startParams()),
		(error: unknown) => error instanceof AgentRuntimeError && error.code === 'AGENT_UNAVAILABLE',
	);
	await unavailable.executor.dispose();
});

test('rejects a task start whose absolute worker deadline has expired', async () => {
	const fixture = createFixture();
	assert.throws(
		() => fixture.executor.start(startParams({
			workerDeadline: '2026-08-25T12:00:00.000Z',
		})),
		(error: unknown) =>
			isReason(error, 'TASK_EXECUTION_FAILED')
			&& error instanceof Error
			&& error.message.includes('deadline'),
	);
	assert.equal(fixture.runtime.requests.length, 0);
	await fixture.executor.dispose();
});

test('worker deadline independently cancels and disposes the real task handle', async () => {
	const fixture = createFixture();
	await fixture.executor.start(startParams({
		workerDeadline: '2026-08-25T12:00:00.025Z',
	}));
	const handle = fixture.runtime.handles[0];
	await waitFor(() => handle.cancelCalls === 1 && handle.disposeCalls === 1);
	assert.deepEqual(fixture.events, []);
	await fixture.executor.dispose();
	assert.equal(handle.cancelCalls, 1);
	assert.equal(handle.disposeCalls, 1);
});

test('worker deadline interrupts a runtime start that has not returned a handle', async () => {
	const runtime = new InterruptibleStartRuntime();
	const fixture = createFixture({
		runtime,
		clock: { now: () => new Date() },
	});
	const start = fixture.executor.start(startParams({
		workerDeadline: new Date(Date.now() + 30).toISOString(),
	}));
	await runtime.startEntered;
	await waitFor(() => runtime.disposeCalls === 1);
	await assert.rejects(
		start,
		(error: unknown) => isReason(error, 'TASK_EXECUTION_FAILED'),
	);
	await fixture.executor.dispose();
	assert.equal(fixture.executor.generationClosed, true);
	assert.equal(runtime.disposeCalls, 1);
});

test('shutdown interrupts a pending runtime start before awaiting it', async () => {
	const runtime = new InterruptibleStartRuntime();
	const fixture = createFixture({
		runtime,
		clock: { now: () => new Date() },
	});
	const start = fixture.executor.start(startParams({
		workerDeadline: new Date(Date.now() + 60_000).toISOString(),
	}));
	await runtime.startEntered;
	const disposal = fixture.executor.dispose();
	assert.equal(runtime.disposeCalls, 1);
	await assert.rejects(
		start,
		(error: unknown) => isReason(error, 'WORKER_DRAINING'),
	);
	await disposal;
	assert.equal(runtime.disposeCalls, 1);
});

test('starts once for exact retries, rejects conflicts, and supplies complete confirmation details', async () => {
	const fixture = createFixture();
	const params = startParams();
	const first = fixture.executor.start(params);
	const retry = fixture.executor.start(structuredClone(params));
	assert.strictEqual(first, retry);
	assert.deepEqual(await first, {
		taskId: TASK_ID,
		nodeId: NODE_ID,
		nodeInstanceId: NODE_INSTANCE_ID,
		recoveryDescriptor: {
			adapter: 'ahp',
			sessionId: 'session',
			conversationId: 'conversation',
		},
	});
	assert.equal(fixture.runtime.requests.length, 1);
	assert.deepEqual(fixture.confirmations, [{
		sourceWindowLabel: 'Source Window',
		targetWindowLabel: 'Target Window',
		workspaceDisplayName: 'Current Workspace',
		taskTitle: 'Implement task',
		prompt: 'Complete prompt text',
	}]);
	assert.throws(
		() => fixture.executor.start(startParams({ title: 'Changed task' })),
		(error: unknown) => isReason(error, 'TASK_ID_CONFLICT'),
	);
	await fixture.executor.dispose();
});

test('reports confirmation denial as an explicit safe failure without starting the runtime', async () => {
	const fixture = createFixture({
		confirmationHost: { confirm: async () => 'deny' },
	});
	await assert.rejects(
		fixture.executor.start(startParams()),
		(error: unknown) =>
			isReason(error, 'TASK_EXECUTION_FAILED')
			&& error instanceof Error
			&& error.message.includes('denied'),
	);
	assert.equal(fixture.runtime.requests.length, 0);
	await fixture.executor.dispose();
});

test('target executor rejects the removed legacy always confirmation', async () => {
	const fixture = createFixture({
		confirmationHost: { confirm: async () => 'always' as never },
	});
	await assert.rejects(
		fixture.executor.start(startParams()),
		(error: unknown) => isReason(error, 'TASK_EXECUTION_FAILED'),
	);
	assert.equal(fixture.runtime.requests.length, 0);
	await fixture.executor.dispose();
});

test('maps and UTF-8 bounds runtime events while preserving terminal semantics', async () => {
	const fixture = createFixture();
	await fixture.executor.start(startParams());
	const handle = fixture.runtime.handles[0];
	const longText = '界'.repeat(8_000);
	const runtimeEvents: AgentRuntimeEvent[] = [
		{ type: 'progress', message: longText },
		{ type: 'output', text: longText },
		{ type: 'outputTruncated', message: longText },
		{ type: 'tool', name: 'shell', status: 'running', summary: longText },
		{ type: 'terminal', summary: longText },
		{ type: 'completed' },
	];
	for (const event of runtimeEvents) {
		await handle.events.push(event);
	}
	await waitFor(() => fixture.events.at(-1)?.event.type === 'completed');
	assert.deepEqual(
		fixture.events.map(({ event }) => event.type),
		['progress', 'output', 'outputTruncated', 'tool', 'terminal', 'completed'],
	);
	for (const event of fixture.events) {
		if ('summary' in event.event) {
			assert.ok(Buffer.byteLength(event.event.summary, 'utf8') <= 16 * 1_024);
		}
	}
	assert.equal(handle.disposeCalls, 1);
	await fixture.executor.dispose();
});

test('publishes public input IDs and maps exact idempotent answers to the runtime request', async () => {
	const fixture = createFixture();
	await fixture.executor.start(startParams());
	const handle = fixture.runtime.handles[0];
	await handle.events.push({
		type: 'inputRequired',
		request: {
			requestId: 'runtime-private-id',
			kind: 'chatInput',
			prompt: '界'.repeat(12_000),
			fields: [{ id: 'response', prompt: 'Answer', required: true, type: 'string' }],
		},
	});
	await waitFor(() => fixture.events.some(({ event }) => event.type === 'inputRequired'));
	const input = fixture.events.find(({ event }) => event.type === 'inputRequired')?.event;
	assert.equal(input?.type, 'inputRequired');
	if (input?.type !== 'inputRequired') {
		assert.fail('Expected input event.');
	}
	assert.equal(input.inputId, INPUT_ID);
	assert.ok(Buffer.byteLength(input.prompt, 'utf8') <= 32 * 1_024);

	const answer = {
		nodeId: NODE_ID,
		nodeInstanceId: NODE_INSTANCE_ID,
		taskId: TASK_ID,
		inputId: INPUT_ID,
		answerId: ANSWER_ID,
		answer: 'the answer',
	};
	await Promise.all([fixture.executor.answer(answer), fixture.executor.answer(answer)]);
	assert.deepEqual(handle.answers, [{
		requestId: 'runtime-private-id',
		outcome: 'accept',
		values: { response: 'the answer' },
	}]);
	await handle.events.push({ type: 'completed' });
	await waitFor(() => fixture.events.at(-1)?.event.type === 'completed');
	await fixture.executor.dispose();
});

test('auto-approves one provable local file confirmation and escalates sensitive input', async () => {
	const workspaceUri = `${pathToFileURL(process.cwd()).href}/`;
	const fixture = createFixture({
		workspaceResolver: {
			resolve: async (workspaceId) => workspaceId === WORKSPACE_ID
				? {
					workspaceId,
					workspaceIdentity: WORKSPACE_IDENTITY,
					displayName: 'Current Workspace',
					uri: workspaceUri,
				}
				: undefined,
		},
	});
	const params = startParams();
	await fixture.executor.start(params);
	const handle = fixture.runtime.handles[0];
	assert.deepEqual(
		fixture.executor.delegatedExecutionContext(TASK_ID),
		params.delegatedExecutionContext,
	);
	const safeRequest = {
		requestId: 'safe-write',
		kind: 'toolConfirmation',
		prompt: 'Write file?',
		confirmationEvidence: {
			phase: 'operation',
			toolName: 'write_file',
			fileEdits: [{ afterUri: new URL('generated.ts', workspaceUri).href }],
		},
	} as const;
	await handle.events.push({ type: 'inputRequired', request: safeRequest });
	await waitFor(() => handle.answers.length === 1);
	assert.deepEqual(handle.answers, [{
		requestId: 'safe-write',
		outcome: 'accept',
	}]);
	assert.equal(
		fixture.events.some(({ event }) => event.type === 'inputRequired'),
		false,
	);

	await handle.events.push({ type: 'inputRequired', request: safeRequest });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(handle.answers.length, 1);

	await handle.events.push({
		type: 'inputRequired',
		request: {
			requestId: 'authentication',
			kind: 'toolAuthentication',
			prompt: 'Authenticate?',
		},
	});
	await waitFor(() => fixture.events.some(({ event }) => event.type === 'inputRequired'));
	assert.equal(
		fixture.events.filter(({ event }) => event.type === 'inputRequired').length,
		1,
	);

	await handle.events.push({ type: 'completed' });
	await waitFor(() => fixture.events.at(-1)?.event.type === 'completed');
	assert.equal(fixture.executor.delegatedExecutionContext(TASK_ID), undefined);
	await assert.rejects(
		fixture.executor.start(startParams({
			taskId: '00000000-0000-4000-8000-00000000000d',
			delegationRequestId: '00000000-0000-4000-8000-00000000000e',
			delegationGrant: params.delegationGrant,
		})),
		/The delegation grant is not bound/u,
	);
	await fixture.executor.dispose();
});

test('maps one bounded string answer across structured Agent input fields', async () => {
	const fixture = createFixture();
	await fixture.executor.start(startParams());
	const handle = fixture.runtime.handles[0];
	await handle.events.push({
		type: 'inputRequired',
		request: {
			requestId: 'runtime-structured-input',
			kind: 'chatInput',
			prompt: 'Approve the requested operation.',
			fields: [{
				id: 'confirmed',
				prompt: 'Confirm',
				required: true,
				type: 'boolean',
			}, {
				id: 'permission',
				prompt: 'Permission',
				required: true,
				type: 'singleSelect',
				options: [{ id: 'allow', label: 'Allow', approve: true }],
			}],
		},
	});
	await waitFor(() => fixture.events.some(({ event }) => event.type === 'inputRequired'));
	await fixture.executor.answer({
		nodeId: NODE_ID,
		nodeInstanceId: NODE_INSTANCE_ID,
		taskId: TASK_ID,
		inputId: INPUT_ID,
		answerId: ANSWER_ID,
		answer: '继续',
	});
	assert.deepEqual(handle.answers, [{
		requestId: 'runtime-structured-input',
		outcome: 'accept',
		values: {
			confirmed: true,
			permission: 'allow',
		},
	}]);
	await handle.events.push({ type: 'completed' });
	await waitFor(() => fixture.events.at(-1)?.event.type === 'completed');
	await fixture.executor.dispose();
});

test('queues concurrent Agent inputs and publishes them one at a time', async () => {
	const inputIds = [INPUT_ID, SECOND_INPUT_ID];
	const fixture = createFixture({
		ids: { next: () => inputIds.shift()! },
	});
	await fixture.executor.start(startParams());
	const handle = fixture.runtime.handles[0];
	await handle.events.push({
		type: 'inputRequired',
		request: {
			requestId: 'runtime-first-input',
			kind: 'toolConfirmation',
			prompt: 'Approve first tool?',
		},
	});
	await handle.events.push({
		type: 'inputRequired',
		request: {
			requestId: 'runtime-second-input',
			kind: 'toolConfirmation',
			prompt: 'Approve second tool?',
		},
	});
	await waitFor(() => fixture.events.some(({ event }) => event.type === 'inputRequired'));
	assert.equal(
		fixture.events.filter(({ event }) => event.type === 'inputRequired').length,
		1,
	);
	await fixture.executor.answer({
		nodeId: NODE_ID,
		nodeInstanceId: NODE_INSTANCE_ID,
		taskId: TASK_ID,
		inputId: INPUT_ID,
		answerId: ANSWER_ID,
		answer: '继续',
	});
	await waitFor(() =>
		fixture.events.filter(({ event }) => event.type === 'inputRequired').length === 2,
	);
	await fixture.executor.answer({
		nodeId: NODE_ID,
		nodeInstanceId: NODE_INSTANCE_ID,
		taskId: TASK_ID,
		inputId: SECOND_INPUT_ID,
		answerId: '00000000-0000-4000-8000-00000000000c',
		answer: 'approve',
	});
	assert.deepEqual(
		handle.answers.map(({ requestId, outcome }) => ({ requestId, outcome })),
		[
			{ requestId: 'runtime-first-input', outcome: 'accept' },
			{ requestId: 'runtime-second-input', outcome: 'accept' },
		],
	);
	await handle.events.push({ type: 'completed' });
	await waitFor(() => fixture.events.at(-1)?.event.type === 'completed');
	await fixture.executor.dispose();
});

test('fences and deduplicates cancellation against the real runtime handle', async () => {
	const fixture = createFixture();
	await fixture.executor.start(startParams());
	const cancel = {
		nodeId: NODE_ID,
		nodeInstanceId: NODE_INSTANCE_ID,
		taskId: TASK_ID,
	};
	await Promise.all([fixture.executor.cancel(cancel), fixture.executor.cancel(cancel)]);
	assert.equal(fixture.runtime.handles[0].cancelCalls, 1);
	await assert.rejects(
		fixture.executor.cancel({ ...cancel, nodeId: '00000000-0000-4000-8000-00000000000b' }),
		(error: unknown) => isReason(error, 'AGENT_UNAVAILABLE'),
	);
	await fixture.runtime.handles[0].events.push({ type: 'cancelled' });
	await waitFor(() => fixture.events.at(-1)?.event.type === 'cancelled');
	await fixture.executor.dispose();
});

test('stops a task on sink failure and reports it during disposal', async () => {
	const fixture = createFixture({
		eventSink: {
			publish: async () => {
				throw new Error('sink unavailable');
			},
		},
	});
	await fixture.executor.start(startParams());
	const handle = fixture.runtime.handles[0];
	await handle.events.push({ type: 'progress', message: 'working' });
	await waitFor(() => handle.cancelCalls === 1 && handle.disposeCalls === 1);
	await assert.rejects(fixture.executor.dispose(), AggregateError);
});

test('dispose is idempotent and cancels, disposes, and waits for active pumps', async () => {
	const fixture = createFixture();
	await fixture.executor.start(startParams());
	const first = fixture.executor.dispose();
	const retry = fixture.executor.dispose();
	assert.strictEqual(first, retry);
	await first;
	assert.equal(fixture.runtime.handles[0].cancelCalls, 1);
	assert.equal(fixture.runtime.handles[0].disposeCalls, 1);
});

test('dispose retries failed runtime cleanup without re-disposing successful handles', async () => {
	const runtime = new RetryCleanupRuntime();
	const fixture = createFixture({ runtime });
	await fixture.executor.start(startParams());

	await assert.rejects(fixture.executor.dispose(), /cleanup failed/u);
	assert.equal(runtime.disposeCalls, 1);
	assert.equal(runtime.handle.cancelCalls, 1);
	assert.equal(runtime.handle.disposeCalls, 1);

	await fixture.executor.dispose();
	await fixture.executor.dispose();
	assert.equal(runtime.disposeCalls, 2);
	assert.equal(runtime.handle.cancelCalls, 1);
	assert.equal(runtime.handle.disposeCalls, 1);
});

test('dispose retries only failed handle cleanup and keeps successful runtime disposal', async () => {
	const runtime = new RetryCancelRuntime();
	const fixture = createFixture({ runtime });
	await fixture.executor.start(startParams());

	await assert.rejects(fixture.executor.dispose(), /cleanup failed/u);
	assert.equal(runtime.disposeCalls, 1);
	assert.equal(runtime.handle.cancelCalls, 1);
	assert.equal(runtime.handle.disposeCalls, 1);

	await fixture.executor.dispose();
	assert.equal(runtime.disposeCalls, 1);
	assert.equal(runtime.handle.cancelCalls, 2);
	assert.equal(runtime.handle.disposeCalls, 1);
});
