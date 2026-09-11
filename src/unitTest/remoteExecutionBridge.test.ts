import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import type { NodeTaskEventParams, NodeTaskStartParams } from '../../shared/protocol';
import {
	AgentRuntimeApprovalCapabilityIssuer,
	AgentRuntimeError,
	createAgentRuntimeEventQueue,
	type AgentRuntime,
	type AgentRuntimeProbe,
	type AgentTaskAnswer,
	type AgentTaskHandle,
	type AgentTaskRequest,
	type RegisteredLocalWorkspace,
} from '../agentHost/AgentRuntime';
import { RemoteExecutionClient } from '../codespaces/RemoteExecutionClient';
import {
	REMOTE_EXECUTION_CLIENT_EXTENSION_ID,
	REMOTE_EXECUTION_COMMANDS,
	REMOTE_EXECUTION_HELPER_EXTENSION_ID,
	parseRemoteValue,
	remoteExecutionBudgets,
	remoteExecutionCallSchema,
	type RemoteExecutionAuthorization,
	type RemoteExecutionBudgets,
	type RemoteExecutionConnected,
	type RemoteExecutionEnvelope,
	type RemoteExecutionIdentity,
	type RemoteExecutionOperation,
	type RemoteExecutionTiming,
	type RemoteWorkspaceDescriptor,
} from '../codespaces/RemoteExecutionProtocol';
import {
	RemoteExecutionServer,
	type RemoteExecutionExecutor,
	type RemoteExecutionExecutorContext,
} from '../codespaces/RemoteExecutionServer';
import { MeshDomainError } from '../domain/errors';
import { canonicalRoutedTaskRequestHash } from '../domain/task';
import { createDelegationGrant } from '../node/DelegationGrant';
import { WindowNodeTaskExecutor, WindowNodeTaskExecutorDisposalError } from '../node/WindowNodeTaskExecutor';
import { redactRegisteredSensitiveValues } from '../security/SensitiveValueRedaction';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';

const DEVICE = uuid(1);
const NODE = uuid(2);
const INSTANCE = uuid(3);
const WORKSPACE = uuid(4);
const OWNER = uuid(5);
const TASK = uuid(6);
const SOURCE = uuid(7);
const VERSION = '0.5.0';
const AUTHORITY = 'codespaces+bridge-test';
const SOURCE_URI = 'file:///workspaces/current-folder';
const CANONICAL_URI = 'file:///workspaces/canonical-folder';
const FILE_IDENTITY = `codespaces:${createHash('sha256').update(AUTHORITY).digest('hex')}:fs:1:2`;
const WORKSPACE_IDENTITY = createOpaqueWorkspaceIdentity(FILE_IDENTITY);
const budgets: Partial<RemoteExecutionBudgets> = {
	connectTimeoutMs: 500,
	callTimeoutMs: 500,
	startTimeoutMs: 1_000,
	cleanupTimeoutMs: 500,
	leaseMs: 2_000,
	heartbeatIntervalMs: 50,
	pollWaitMs: 50,
	idlePollDelayMs: 1,
	eventBackpressureTimeoutMs: 500,
	eventAcknowledgementTimeoutMs: 500,
};

class Deferred<T> {
	public readonly promise: Promise<T>;
	public resolve!: (value: T) => void;
	public reject!: (error: Error) => void;
	public constructor() {
		this.promise = new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

class FakeHandle implements AgentTaskHandle {
	public readonly events = createAgentRuntimeEventQueue();
	public readonly answers: AgentTaskAnswer[] = [];
	public readonly recovery;
	public cancelCalls = 0;
	public disposeCalls = 0;
	public constructor(public readonly taskId: string, request: AgentTaskRequest) {
		this.recovery = {
			clientId: 'bridge-runtime',
			sessionUri: request.continuation?.sessionUri ?? `copilot:session-${taskId}`,
			chatUri: request.continuation?.chatUri ?? `copilot:chat-${taskId}`,
			lastSeenServerSeq: 1,
		};
	}
	public async cancel(): Promise<void> {
		this.cancelCalls += 1;
	}
	public async answer(answer: AgentTaskAnswer): Promise<void> {
		this.answers.push(answer);
	}
	public async dispose(): Promise<void> {
		this.disposeCalls += 1;
		this.events.close();
	}
}

class FakeRuntime implements AgentRuntime {
	public readonly requests: AgentTaskRequest[] = [];
	public readonly handles = new Map<string, FakeHandle>();
	public disposeCalls = 0;
	public onStart: ((request: AgentTaskRequest) => Promise<void>) | undefined;
	public onDispose: (() => void) | undefined;
	public onCancelStart: ((taskId: string) => Promise<void> | void) | undefined;
	public async probe(): Promise<AgentRuntimeProbe> {
		return { available: true, featureEnabled: true, source: 'codespace-owned' };
	}
	public async start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		this.requests.push(request);
		await this.onStart?.(request);
		const handle = new FakeHandle(request.taskId, request);
		this.handles.set(request.taskId, handle);
		return handle;
	}
	public async dispose(): Promise<void> {
		this.disposeCalls += 1;
		this.onDispose?.();
		for (const handle of this.handles.values()) {
			handle.events.close();
		}
	}
	public async cancelStart(taskId: string): Promise<void> {
		if (this.onCancelStart === undefined) {
			throw new AgentRuntimeError('TASK_CANCELLATION_UNCONFIRMED', 'No pending startup cancellation hook.');
		}
		await this.onCancelStart(taskId);
	}
}

interface FixtureOptions {
	readonly budgets?: Partial<RemoteExecutionBudgets>;
	readonly clientBudgets?: Partial<RemoteExecutionBudgets>;
	readonly eventSink?: (event: NodeTaskEventParams) => Promise<void> | void;
	readonly createExecutor?: (context: RemoteExecutionExecutorContext) => RemoteExecutionExecutor | Promise<RemoteExecutionExecutor>;
	readonly invoke?: (command: string, input: unknown, next: () => Promise<unknown>) => Promise<unknown>;
	readonly onDisconnect?: (error: Error) => Promise<void> | void;
	readonly workspaceResolver?: (workspaceId: string) => Promise<RegisteredLocalWorkspace | undefined>;
	readonly clientTiming?: Partial<RemoteExecutionTiming>;
}

function fixture(t: TestContext, options: FixtureOptions = {}) {
	const runtime = new FakeRuntime();
	const events: NodeTaskEventParams[] = [];
	const errors: Error[] = [];
	const disconnects: Error[] = [];
	const invocations: { command: string; input: unknown }[] = [];
	const contexts: RemoteExecutionExecutorContext[] = [];
	const state = {
		workspaces: [descriptor()], allowed: true, factoryCalls: 0, readCalls: 0,
		readGate: undefined as Promise<void> | undefined,
	};
	const identity = clientIdentity();
	const server = new RemoteExecutionServer({
		extensionVersion: VERSION,
		budgets: { ...budgets, ...options.budgets },
		assertAllowed: () => {
			if (!state.allowed) {
				throw new MeshDomainError('WORKSPACE_UNTRUSTED', 'Private trust context.');
			}
		},
		readWorkspaces: async (authority) => {
			assert.equal(authority, AUTHORITY);
			state.readCalls += 1;
			await state.readGate;
			return state.workspaces;
		},
		createExecutor: (context) => {
			contexts.push(context);
			state.factoryCalls += 1;
			return options.createExecutor?.(context) ?? {
				executor: new WindowNodeTaskExecutor({
					...context,
					executionBackend: 'codespace-owned',
					runtime,
					approvalCapabilities: new AgentRuntimeApprovalCapabilityIssuer(),
					confirmationHost: { confirm: async () => 'once' },
					ids: randomUUID,
					clock: () => new Date(),
				}),
				probe: () => runtime.probe(),
			};
		},
		reportError: (error) => errors.push(error),
	});
	const client = new RemoteExecutionClient({
		identity,
		extensionVersion: VERSION,
		budgets: { ...budgets, ...options.budgets, ...options.clientBudgets },
		timing: options.clientTiming,
		invoke: async (command, input) => {
			invocations.push({ command, input: structuredClone(input) });
			const next = async () => {
				switch (command) {
					case REMOTE_EXECUTION_COMMANDS.connect: return server.connect(input);
					case REMOTE_EXECUTION_COMMANDS.call: return server.call(input);
					case REMOTE_EXECUTION_COMMANDS.disconnect: return server.disconnect(input);
					default: throw new Error('Unexpected bridge command.');
				}
			};
			return options.invoke === undefined ? next() : options.invoke(command, input, next);
		},
		workspaceResolver: {
			resolve: options.workspaceResolver
				?? (async (workspaceId) => workspaceId === WORKSPACE ? boundWorkspace() : undefined),
		},
		eventSink: {
			publish: async (event) => {
				events.push(event);
				await options.eventSink?.(event);
			},
		},
		onDisconnect: async (error) => {
			disconnects.push(error);
			await options.onDisconnect?.(error);
		},
		reportError: (error) => errors.push(error),
	});
	t.after(async () => {
		await Promise.allSettled([client.dispose(), server.dispose()]);
	});
	return { runtime, events, errors, disconnects, invocations, contexts, state, server, client, identity };
}

type Fixture = ReturnType<typeof fixture>;

test('bridge handshake is coalesced, extension-specific, and returns only the current remote file roots', async (t) => {
	const f = fixture(t);
	await Promise.all([f.client.connect(), f.client.connect(), f.client.connect()]);
	assert.equal(f.state.factoryCalls, 1);
	assert.equal(f.invocations.filter((entry) => entry.command === REMOTE_EXECUTION_COMMANDS.connect).length, 1);
	assert.notEqual(REMOTE_EXECUTION_CLIENT_EXTENSION_ID, REMOTE_EXECUTION_HELPER_EXTENSION_ID);
	assert.deepEqual(await f.client.listWorkspaces(), [
		{ localUri: SOURCE_URI, name: 'Codespace folder', capabilityTags: ['typescript'] },
	]);
	assert.deepEqual(await f.client.resolveIdentity(SOURCE_URI), { canonicalUri: CANONICAL_URI, identity: FILE_IDENTITY });
	assert.deepEqual(await f.client.resolveIdentity(CANONICAL_URI), { canonicalUri: CANONICAL_URI, identity: FILE_IDENTITY });
	assert.deepEqual(await f.client.probe(), { available: true, featureEnabled: true, source: 'codespace-owned' });
	assert.equal(f.runtime.requests.length, 0, 'connect and probe never start or authenticate a task');
	assert.ok(!redactRegisteredSensitiveValues(f.identity.token).includes(f.identity.token));
});

test('real WindowNodeTaskExecutor roundtrip preserves task input, answers, continuation, and authoritative cancellation', async (t) => {
	const f = fixture(t);
	const params = startParams();
	const receipt = await f.client.start(params);
	assert.equal(receipt.taskId, params.taskId);
	assert.equal(f.runtime.requests[0].executionBackend, 'codespace-owned');
	assert.equal(f.runtime.requests[0].requireEditor, undefined);
	assert.deepEqual(f.runtime.requests[0].delegatedExecutionContext, params.delegatedExecutionContext);
	const handle = f.runtime.handles.get(TASK)!;
	await handle.events.push({ type: 'progress', message: 'Working remotely' });
	await handle.events.push({
		type: 'inputRequired', request: { requestId: 'native-question', kind: 'chatInput', prompt: 'Choose a direction' },
	});
	await waitFor(() => f.events.some((event) => event.event.type === 'inputRequired'));
	const required = f.events.find((event) => event.event.type === 'inputRequired')!.event;
	assert.equal(required.type, 'inputRequired');
	const answer = { ...taskAddress(TASK), inputId: required.inputId, answerId: uuid(50), answer: 'Keep the public API' };
	await Promise.all([f.client.answer(answer), f.client.answer(answer)]);
	assert.equal(handle.answers.length, 1);
	assert.equal(handle.answers[0].requestId, 'native-question');
	await assert.rejects(f.client.answer({ ...answer, answer: 'Changed semantics' }), hasCode('IDEMPOTENCY_CONFLICT'));
	await handle.events.push({ type: 'terminal', summary: 'First turn finished' });
	await handle.events.push({ type: 'completed' });
	await waitFor(() => f.events.some((event) => event.event.type === 'completed'));
	const continuation = {
		sessionUri: receipt.recoveryDescriptor!.sessionId,
		chatUri: receipt.recoveryDescriptor!.conversationId!,
	};
	const followup = startParams({ taskId: uuid(60), continueFromTaskId: TASK, continuation });
	await f.client.start(followup);
	assert.deepEqual(f.runtime.requests[1].continuation, continuation);
	assert.equal(f.runtime.requests[1].executionBackend, 'codespace-owned');
	await f.client.cancel(taskAddress(followup.taskId));
	await f.client.cancel(taskAddress(followup.taskId));
	const continuedHandle = f.runtime.handles.get(followup.taskId)!;
	assert.equal(continuedHandle.cancelCalls, 1);
	assert.equal(f.events.some((event) => event.event.type === 'cancelled'), false, 'a cancel RPC is not a cancelled event');
	await continuedHandle.events.push({ type: 'cancelled' });
	await waitFor(() => f.events.some((event) => event.event.type === 'cancelled'));
	await f.client.disposeTask(taskAddress(followup.taskId));
	assert.equal(f.disconnects.length, 0);
	await f.client.dispose();
	await f.server.dispose();
});

test('events are acknowledged only after desktop acceptance while heartbeats continue during sink backpressure', async (t) => {
	const accepted = new Deferred<void>();
	const f = fixture(t, {
		budgets: { maxQueuedEvents: 1, heartbeatIntervalMs: 10 },
		eventSink: async (event) => { if (event.event.type === 'output') { await accepted.promise; } },
	});
	t.after(() => accepted.resolve());
	await f.client.start(startParams());
	const handle = f.runtime.handles.get(TASK)!;
	await handle.events.push({ type: 'output', text: 'First event' });
	await handle.events.push({
		type: 'inputRequired', request: { requestId: 'native-input', kind: 'chatInput', prompt: 'Please answer' },
	});
	await waitFor(() => f.events.length === 1);
	await waitFor(() => calls(f, 'heartbeat').length >= 2);
	assert.ok(calls(f, 'events').every((call) =>
		call.operation.kind === 'events' && call.operation.acknowledgedSeq === 0));
	accepted.resolve();
	await waitFor(() => f.events.some((event) => event.event.type === 'inputRequired'));
	await waitFor(() => calls(f, 'events').some((call) =>
		call.operation.kind === 'events' && call.operation.acknowledgedSeq >= 2));
	assert.deepEqual(f.events.map((event) => event.event.type), ['output', 'inputRequired']);
});

test('rejects wrong capability, helper generation, protocol, extension identity, and exact extension version', async (t) => {
	const f = fixture(t);
	const helper = success(await f.server.connect(connectInput(f.identity)));
	for (const override of [
		{ token: Buffer.alloc(32, 8).toString('base64url') },
		{ helperInstanceId: uuid(100) },
		{ clientId: uuid(101) },
	]) {
		assertError(await f.server.call({
			...authorization(f.identity, helper), ...override, requestId: randomUUID(), operation: { kind: 'probe' },
		}), 'AUTH_FAILED');
	}
	assertError(await f.server.call({
		...authorization(f.identity, helper), version: 2, requestId: randomUUID(), operation: { kind: 'probe' },
	}), 'PROTOCOL_INCOMPATIBLE');
	assertError(await f.server.connect({ ...connectInput(f.identity), extensionVersion: '9.0.0' }), 'PROTOCOL_INCOMPATIBLE');
	assertError(await f.server.connect({ ...connectInput(f.identity), extensionId: REMOTE_EXECUTION_HELPER_EXTENSION_ID }),
		'PROTOCOL_INCOMPATIBLE');
	assertError(await f.server.disconnect({
		...authorization(f.identity, helper), token: Buffer.alloc(32, 9).toString('base64url'),
	}), 'AUTH_FAILED');
	assert.equal((await rpc(f, helper, { kind: 'heartbeat' })).ok, true);
	assertError(await f.server.connect(connectInput({
		...f.identity, token: Buffer.alloc(32, 10).toString('base64url'),
	})), 'AUTH_FAILED');
	assertError(await f.server.connect(connectInput({ ...f.identity, nodeLabel: 'Changed window' })), 'IDEMPOTENCY_CONFLICT');
	assert.equal(f.runtime.requests.length, 0);
});

test('workspaces, exact target, delegation grant, and explicit owned backend are independently validated', async (t) => {
	const f = fixture(t);
	assertError(await f.server.connect(connectInput({ ...f.identity, expectedFolders: ['file:///private/elsewhere'] })),
		'WORKSPACE_NOT_FOUND');
	assert.equal(f.state.factoryCalls, 0);
	const helper = success(await f.server.connect(connectInput(f.identity)));
	assertError(await rpc(f, helper, { kind: 'resolve', uri: 'file:///private/arbitrary' }), 'WORKSPACE_NOT_FOUND');
	for (const workspace of [
		{ ...boundWorkspace(), uri: 'file:///private/arbitrary' },
		{ ...boundWorkspace(), workspaceIdentity: createOpaqueWorkspaceIdentity('different') },
		{ ...boundWorkspace(), workspaceId: uuid(99) },
	]) {
		const reply = await rpc(f, helper, { kind: 'start', params: startParams({ taskId: randomUUID() }), workspace });
		assert.equal(reply.ok, false);
	}
	const invalidGrant = startParams({ taskId: randomUUID() });
	assertError(await rpc(f, helper, {
		kind: 'start',
		params: { ...invalidGrant, delegationGrant: { ...invalidGrant.delegationGrant, requestHash: 'f'.repeat(64) } },
		workspace: boundWorkspace(),
	}), 'AUTH_FAILED');
	for (const params of [
		startParams({ taskId: randomUUID(), executionBackend: 'editor' }),
		startParams({ taskId: randomUUID(), executionBackend: undefined }),
		startParams({ taskId: randomUUID(), target: { ...startParams().target, nodeInstanceId: uuid(40) } }),
		startParams({ taskId: randomUUID(), delegatedExecutionContext: { kind: 'delegatedChild', taskId: uuid(42), capability: 'd'.repeat(43) } }),
	]) {
		assert.equal((await rpc(f, helper, { kind: 'start', params, workspace: boundWorkspace() })).ok, false);
	}
	assertError(await rpc(f, helper, {
		kind: 'start', params: startParams({ requireEditor: true }), workspace: boundWorkspace(),
	}), 'PROTOCOL_INCOMPATIBLE');
	assert.equal(f.runtime.requests.length, 0);
	assert.equal(await f.contexts[0].workspaceResolver.resolve(WORKSPACE), undefined, 'invalid starts do not bind workspace IDs');
});

test('request IDs and semantic task IDs deduplicate starts and reject changed bindings without replay', async (t) => {
	const f = fixture(t);
	const helper = success(await f.server.connect(connectInput(f.identity)));
	const params = startParams();
	const operation = { kind: 'start' as const, params, workspace: boundWorkspace() };
	const requestId = randomUUID();
	const [a, b] = await Promise.all([rpc(f, helper, operation, requestId), rpc(f, helper, operation, requestId)]);
	assert.deepEqual(a, b);
	assert.deepEqual(await rpc(f, helper, operation), a);
	assert.equal(f.runtime.requests.length, 1);
	const changed = { ...operation, params: startParams({ ...params, prompt: 'A different prompt', delegationGrant: undefined }) };
	assertError(await rpc(f, helper, changed, requestId), 'IDEMPOTENCY_CONFLICT');
	assertError(await rpc(f, helper, changed), 'TASK_ID_CONFLICT');
	assert.equal(f.runtime.requests.length, 1);
});

test('heartbeat and cancellation have admission independent of a long poll and another blocked runtime start', async (t) => {
	const gate = new Deferred<void>();
	const f = fixture(t, { budgets: { pollWaitMs: 200, maxInFlight: 1 } });
	const helper = success(await f.server.connect(connectInput(f.identity)));
	success(await rpc(f, helper, { kind: 'start', params: startParams(), workspace: boundWorkspace() }));
	const poll = rpc(f, helper, { kind: 'events', acknowledgedSeq: 0, waitMs: 200 });
	f.runtime.onStart = async () => gate.promise;
	const pendingStart = rpc(f, helper, { kind: 'start', params: startParams({ taskId: uuid(80) }), workspace: boundWorkspace() });
	await waitFor(() => f.runtime.requests.length === 2);
	const heartbeat = await raceTimeout(rpc(f, helper, { kind: 'heartbeat' }), 100);
	assert.equal(heartbeat.ok, true);
	assert.equal((await raceTimeout(rpc(f, helper, { kind: 'cancel', params: taskAddress(TASK) }), 100)).ok, true);
	assert.equal(f.runtime.handles.get(TASK)!.cancelCalls, 1);
	assertError(await rpc(f, helper, { kind: 'events', acknowledgedSeq: 0, waitMs: 1 }), 'RATE_LIMITED');
	gate.resolve();
	success(await pendingStart);
	success(await poll);
});

test('bounded event queue backpressures rather than dropping input or terminal events and enforces ACK sequence', async (t) => {
	const f = fixture(t, { budgets: { maxQueuedEvents: 1, maxPendingEvents: 1 } });
	const helper = success(await f.server.connect(connectInput(f.identity)));
	success(await rpc(f, helper, { kind: 'start', params: startParams(), workspace: boundWorkspace() }));
	const sink = f.contexts[0].eventSink;
	let outputAccepted = false;
	const output = Promise.resolve(sink.publish(taskEvent({ type: 'output', summary: 'Output' })))
		.then(() => { outputAccepted = true; });
	let inputAccepted = false;
	const input = Promise.resolve(sink.publish(taskEvent({ type: 'inputRequired', inputId: uuid(20), prompt: 'Input needed' })))
		.then(() => { inputAccepted = true; });
	const first = success(await rpc(f, helper, { kind: 'events', acknowledgedSeq: 0, waitMs: 1 }));
	assert.ok(first !== null && 'events' in first);
	assert.deepEqual(first.events.map((entry) => [entry.seq, entry.event.event.type]), [[1, 'output']]);
	assert.equal(outputAccepted, false, 'sending a batch is not an acknowledgement');
	assert.equal(inputAccepted, false);
	assertError(await rpc(f, helper, { kind: 'events', acknowledgedSeq: 2, waitMs: 1 }), 'PROTOCOL_INCOMPATIBLE');
	const second = success(await rpc(f, helper, { kind: 'events', acknowledgedSeq: 1, waitMs: 1 }));
	await output;
	assert.equal(inputAccepted, false);
	assert.ok(second !== null && 'events' in second);
	assert.deepEqual(second.events.map((entry) => [entry.seq, entry.event.event.type]), [[2, 'inputRequired']]);
	const terminal = Promise.resolve(sink.publish(taskEvent({ type: 'completed', summary: 'Done' })));
	const third = success(await rpc(f, helper, { kind: 'events', acknowledgedSeq: 2, waitMs: 1 }));
	await input;
	assert.ok(third !== null && 'events' in third);
	assert.deepEqual(third.events.map((entry) => [entry.seq, entry.event.event.type]), [[3, 'completed']]);
	success(await rpc(f, helper, { kind: 'events', acknowledgedSeq: 3, waitMs: 1 }));
	await terminal;
});

test('event queue and pending-publisher overflow explicitly retire the generation instead of silently losing events', async (t) => {
	const f = fixture(t, { budgets: { maxQueuedEvents: 1, maxPendingEvents: 1 } });
	const helper = success(await f.server.connect(connectInput(f.identity)));
	success(await rpc(f, helper, { kind: 'start', params: startParams(), workspace: boundWorkspace() }));
	const sink = f.contexts[0].eventSink;
	const firstRejected = assert.rejects(Promise.resolve(sink.publish(taskEvent({ type: 'output', summary: 'First' }))));
	const waiting = Promise.resolve(sink.publish(taskEvent({ type: 'inputRequired', inputId: uuid(22), prompt: 'Waiting' })));
	const waitingRejected = assert.rejects(waiting);
	await assert.rejects(Promise.resolve(sink.publish(taskEvent({ type: 'completed', summary: 'Never silently dropped' }))),
		hasCode('RATE_LIMITED'));
	await waitingRejected;
	await firstRejected;
	assert.equal((await rpc(f, helper, { kind: 'heartbeat' })).ok, false);
	await waitFor(() => f.runtime.disposeCalls === 1);
	assert.ok(f.errors.some(hasCode('RATE_LIMITED')));
});

test('a single event exceeding the byte budget fails explicitly and a stalled publisher has a finite deadline', async (t) => {
	const large = fixture(t, { budgets: { maxQueuedEventBytes: 400 } });
	const helper = success(await large.server.connect(connectInput(large.identity)));
	success(await rpc(large, helper, { kind: 'start', params: startParams(), workspace: boundWorkspace() }));
	await assert.rejects(Promise.resolve(large.contexts[0].eventSink.publish(
		taskEvent({ type: 'output', summary: 'x'.repeat(500) }),
	)), hasCode('RATE_LIMITED'));
	const stalled = fixture(t, { budgets: { maxQueuedEvents: 1, eventBackpressureTimeoutMs: 25 } });
	const other = success(await stalled.server.connect(connectInput(stalled.identity)));
	success(await rpc(stalled, other, { kind: 'start', params: startParams(), workspace: boundWorkspace() }));
	const queuedRejected = assert.rejects(Promise.resolve(stalled.contexts[0].eventSink.publish(
		taskEvent({ type: 'output', summary: 'Full' }),
	)));
	await assert.rejects(Promise.resolve(stalled.contexts[0].eventSink.publish(taskEvent({ type: 'completed', summary: 'Blocked' }))));
	await queuedRejected;
	assert.equal((await rpc(stalled, other, { kind: 'heartbeat' })).ok, false);
});

test('lease expiry revokes admission, aborts an outstanding poll, and asks the real executor to cancel and dispose', async (t) => {
	const f = fixture(t, { budgets: { leaseMs: 40, pollWaitMs: 500 } });
	const helper = success(await f.server.connect(connectInput(f.identity)));
	success(await rpc(f, helper, { kind: 'start', params: startParams(), workspace: boundWorkspace() }));
	const handle = f.runtime.handles.get(TASK)!;
	const poll = await rpc(f, helper, { kind: 'events', acknowledgedSeq: 0, waitMs: 500 });
	assert.equal(poll.ok, false);
	await waitFor(() => f.runtime.disposeCalls === 1);
	assert.equal(handle.cancelCalls, 1);
	assert.equal(handle.disposeCalls, 1);
	assert.equal((await rpc(f, helper, { kind: 'heartbeat' })).ok, false);
	assert.equal(f.events.length, 0);
});

test('replacement waits for exact previous cleanup; old disconnect and replay cannot close or rebind the replacement', async (t) => {
	const gate = new Deferred<void>();
	let factories = 0;
	const f = fixture(t, {
		createExecutor: (context) => {
			factories += 1;
			return minimalExecutor(context, factories === 1 ? () => gate.promise : async () => {});
		},
	});
	t.after(() => gate.resolve());
	const original = success(await f.server.connect(connectInput(f.identity)));
	const poll = rpc(f, original, { kind: 'events', acknowledgedSeq: 0, waitMs: 50 });
	const replacementIdentity = { ...f.identity, clientId: uuid(300), nodeInstanceId: uuid(301) };
	const connecting = f.server.connect(connectInput(replacementIdentity));
	await waitFor(() => f.errors.some(hasCode('TASK_RECOVERY_UNAVAILABLE')) || f.state.factoryCalls === 1);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(factories, 1);
	assert.equal((await rpc(f, original, { kind: 'heartbeat' })).ok, false);
	assert.equal((await poll).ok, false);
	gate.resolve();
	const replacement = success(await connecting);
	assert.notEqual(replacement.helperInstanceId, original.helperInstanceId);
	assert.equal(factories, 2);
	assert.equal((await f.server.disconnect(authorization(f.identity, original))).ok, true);
	assert.equal((await f.server.call({
		...authorization(replacementIdentity, replacement), requestId: randomUUID(), operation: { kind: 'heartbeat' },
	})).ok, true);
	assertError(await f.server.connect(connectInput(f.identity)), 'TASK_RECOVERY_UNAVAILABLE');
});

test('cleanup failure is sanitized, remains revoked, blocks replacement, and can retry the exact owned executor', async (t) => {
	let failCleanup = true;
	let cleanupCalls = 0;
	const secret = 'secret-token-or-private-prompt';
	const f = fixture(t, {
		createExecutor: (context) => minimalExecutor(context, async () => {
			cleanupCalls += 1;
			if (failCleanup) {
				throw new Error(`Cannot delete /private/path ${secret}`);
			}
		}),
	});
	const helper = success(await f.server.connect(connectInput(f.identity)));
	const disconnected = await f.server.disconnect(authorization(f.identity, helper));
	assertError(disconnected, 'TASK_EXECUTION_FAILED');
	assert.ok(!JSON.stringify(disconnected).includes(secret));
	assert.ok(!JSON.stringify(disconnected).includes('/private/path'));
	assert.ok(f.errors.some((error) => error.message.includes(secret)), 'original detail is sent only to the injected reporter');
	assert.equal((await rpc(f, helper, { kind: 'heartbeat' })).ok, false);
	const replacementIdentity = { ...f.identity, clientId: uuid(320), nodeInstanceId: uuid(321) };
	assert.equal((await f.server.connect(connectInput(replacementIdentity))).ok, false);
	assert.equal(f.state.factoryCalls, 1);
	await assert.rejects(f.server.dispose(), hasCode('TASK_CANCELLATION_UNCONFIRMED'));
	failCleanup = false;
	await f.server.dispose();
	assert.ok(cleanupCalls >= 3);
});

test('failed connect may retry before establishing a generation and hanging command calls are bounded', async (t) => {
	let attempts = 0;
	const f = fixture(t, {
		invoke: async (command, _input, next) => {
			if (command === REMOTE_EXECUTION_COMMANDS.connect && ++attempts === 1) {
				throw new Error('Private remote extension activation error');
			}
			return next();
		},
	});
	await assert.rejects(f.client.connect(), hasCode('AGENT_UNAVAILABLE'));
	assert.equal(f.client.generationClosed, false);
	await f.client.connect();
	assert.equal(attempts, 2);
	assert.equal(f.state.factoryCalls, 1);

	const unresolved = new Deferred<unknown>();
	const bounded = fixture(t, {
		clientBudgets: { connectTimeoutMs: 20, maxStateOperations: 1 },
		invoke: async () => unresolved.promise,
	});
	await assert.rejects(bounded.client.connect(), hasCode('AGENT_UNAVAILABLE'));
	await assert.rejects(bounded.client.connect(), hasCode('RATE_LIMITED'));
	assert.equal(bounded.invocations.length, 1, 'timed-out underlying promises still consume their bounded slot');
	unresolved.resolve({ ok: false, error: {
		code: 'AGENT_UNAVAILABLE', message: 'The Codespaces execution request could not be completed.', retryable: true,
	} });
});

test('late executor creation after a connect timeout is cleaned before a retry can establish a generation', async (t) => {
	const factory = new Deferred<void>();
	let creates = 0;
	let disposals = 0;
	const f = fixture(t, {
		budgets: { connectTimeoutMs: 20 },
		createExecutor: async (context) => {
			creates += 1;
			if (creates === 1) {
				await factory.promise;
			}
			return minimalExecutor(context, async () => { disposals += 1; });
		},
	});
	assert.equal((await f.server.connect(connectInput(f.identity))).ok, false);
	factory.resolve();
	await waitFor(() => disposals === 1);
	const connected = success(await f.server.connect(connectInput(f.identity)));
	assert.equal(connected.clientId, f.identity.clientId);
	assert.equal(creates, 2);
});

test('start timeout closes the client generation, interrupts the owned start, and never resubmits uncertain work', async (t) => {
	const gate = new Deferred<void>();
	const f = fixture(t, { clientBudgets: { startTimeoutMs: 30 } });
	f.runtime.onStart = () => gate.promise;
	f.runtime.onDispose = () => gate.reject(new Error('Owned generation was disposed'));
	await assert.rejects(f.client.start(startParams()), hasCode('TASK_RECOVERY_UNAVAILABLE'));
	await waitFor(() => f.disconnects.length === 1 && f.runtime.disposeCalls === 1);
	assert.equal(f.client.generationClosed, true);
	await assert.rejects(f.client.connect(), hasCode('TASK_RECOVERY_UNAVAILABLE'));
	await assert.rejects(f.client.start(startParams()), hasCode('TASK_RECOVERY_UNAVAILABLE'));
	assert.equal(f.runtime.requests.length, 1);
	assert.equal(f.events.length, 0);
});

test('sink failure is never acknowledged, surfaces onDisconnect once, and stops event and heartbeat pumps', async (t) => {
	const f = fixture(t, {
		eventSink: async () => { throw new Error('Private durable broker storage failure'); },
	});
	await f.client.start(startParams());
	await f.runtime.handles.get(TASK)!.events.push({ type: 'output', text: 'Do not acknowledge me' });
	await waitFor(() => f.disconnects.length === 1);
	assert.equal(f.client.generationClosed, true);
	assert.ok(calls(f, 'events').every((call) =>
		call.operation.kind === 'events' && call.operation.acknowledgedSeq === 0));
	assert.ok(!f.disconnects[0].message.includes('Private'));
	assert.ok(f.disconnects[0].message.includes('uncertain outcomes'));
	const count = f.invocations.length;
	await new Promise((resolve) => setTimeout(resolve, 70));
	assert.equal(f.invocations.length, count);
});

test('workspace bindings are revalidated beside the executor and continuation rejects changed scope or identity', async (t) => {
	const f = fixture(t);
	const helper = success(await f.server.connect(connectInput(f.identity)));
	const receipt = success(await rpc(f, helper, { kind: 'start', params: startParams(), workspace: boundWorkspace() }));
	assert.ok(receipt !== null && 'taskId' in receipt);
	assert.deepEqual(await f.contexts[0].workspaceResolver.resolve(WORKSPACE), boundWorkspace());
	f.state.workspaces = [{ ...descriptor(), canonicalUri: 'file:///workspaces/replaced', fileIdentity: 'codespaces:replacement' }];
	await assert.rejects(f.contexts[0].workspaceResolver.resolve(WORKSPACE), hasCode('WORKSPACE_NOT_FOUND'));
	assertError(await rpc(f, helper, {
		kind: 'start', params: startParams({ taskId: uuid(99) }), workspace: boundWorkspace(),
	}), 'WORKSPACE_NOT_FOUND');
	assert.equal(f.runtime.requests.length, 1);
});

test('trust revocation stops admission and requests cleanup instead of returning a successful probe', async (t) => {
	const f = fixture(t);
	const helper = success(await f.server.connect(connectInput(f.identity)));
	success(await rpc(f, helper, { kind: 'start', params: startParams(), workspace: boundWorkspace() }));
	f.state.allowed = false;
	assertError(await rpc(f, helper, { kind: 'probe' }), 'WORKSPACE_UNTRUSTED');
	await waitFor(() => f.runtime.disposeCalls === 1);
	assert.equal((await rpc(f, helper, { kind: 'heartbeat' })).ok, false);
});

test('unknown runtime exceptions and malformed command results cannot become successful fallback results', async (t) => {
	const f = fixture(t);
	f.runtime.onStart = async () => { throw new Error('private prompt /workspaces/secret and token'); };
	const helper = success(await f.server.connect(connectInput(f.identity)));
	const response = await rpc(f, helper, { kind: 'start', params: startParams(), workspace: boundWorkspace() });
	assertError(response, 'TASK_EXECUTION_FAILED');
	assert.ok(!JSON.stringify(response).includes('private'));
	assert.ok(!JSON.stringify(response).includes('secret'));
	const malformed = fixture(t, {
		invoke: async (command, input, next) => {
			if (command === REMOTE_EXECUTION_COMMANDS.call
				&& (input as { operation: { kind: string } }).operation.kind === 'probe') {
				return undefined;
			}
			return next();
		},
	});
	await malformed.client.connect();
	await assert.rejects(malformed.client.probe(), hasCode('TASK_RECOVERY_UNAVAILABLE'));
	await waitFor(() => malformed.disconnects.length === 1);
});

test('bounded validation rejects oversized, cyclic, accessor, and non-file command inputs before dispatch', async (t) => {
	const f = fixture(t);
	let getterCalls = 0;
	const accessor = Object.defineProperty({}, 'version', { enumerable: true, get: () => { getterCalls += 1; return 1; } });
	assertError(await f.server.connect(accessor), 'PROTOCOL_INCOMPATIBLE');
	assert.equal(getterCalls, 0);
	const cyclic: { value?: unknown } = {};
	cyclic.value = cyclic;
	assertError(await f.server.connect(cyclic), 'PROTOCOL_INCOMPATIBLE');
	assertError(await f.server.connect({ ...connectInput(f.identity), nodeLabel: 'x'.repeat(70_000) }), 'PROTOCOL_INCOMPATIBLE');
	assertError(await f.server.connect(connectInput({ ...f.identity, expectedFolders: ['vscode-remote://codespaces+bridge-test/workspace'] })),
		'PROTOCOL_INCOMPATIBLE');
	assertError(await f.server.connect(connectInput({ ...f.identity, token: 'a'.repeat(43) })), 'PROTOCOL_INCOMPATIBLE');
	assert.equal(f.state.factoryCalls, 0);
});

test('disconnect during delayed handshake cleans the exact late generation instead of rebinding it', async (t) => {
	const releaseReply = new Deferred<void>();
	const f = fixture(t, {
		invoke: async (command, _input, next) => {
			const reply = await next();
			if (command === REMOTE_EXECUTION_COMMANDS.connect) {
				await releaseReply.promise;
			}
			return reply;
		},
	});
	const connecting = f.client.connect();
	const rejected = assert.rejects(connecting, hasCode('TASK_RECOVERY_UNAVAILABLE'));
	await waitFor(() => f.state.factoryCalls === 1);
	const disposing = f.client.dispose();
	releaseReply.resolve();
	await rejected;
	await disposing;
	assert.equal(f.client.generationClosed, true);
	assert.equal(f.runtime.disposeCalls, 1);
	assert.equal(f.disconnects.length, 0);
});

test('request and task caches are finite, while the dedicated control path remains usable', async (t) => {
	const f = fixture(t, { budgets: { maxRequests: 1, maxTasks: 1 } });
	const helper = success(await f.server.connect(connectInput(f.identity)));
	const params = startParams();
	success(await rpc(f, helper, { kind: 'start', params, workspace: boundWorkspace() }));
	assertError(await rpc(f, helper, { kind: 'start', params: startParams({ taskId: uuid(100) }), workspace: boundWorkspace() }),
		'RATE_LIMITED');
	assert.equal((await rpc(f, helper, { kind: 'heartbeat' })).ok, true);
	assert.equal((await rpc(f, helper, { kind: 'cancel', params: taskAddress(TASK) })).ok, true);
});

test('client cache exhaustion cannot prevent cancellation or exact task disposal', async (t) => {
	const f = fixture(t, { budgets: { maxRequests: 1, maxTasks: 1 } });
	await f.client.start(startParams());
	await assert.rejects(f.client.start(startParams({ taskId: uuid(500) })), hasCode('RATE_LIMITED'));
	await f.client.cancel(taskAddress(TASK));
	await f.client.disposeTask(taskAddress(TASK));
	assert.equal(f.runtime.handles.get(TASK)!.cancelCalls, 1);
	assert.equal(f.runtime.handles.get(TASK)!.disposeCalls, 1);
});

test('a duplicate handshake racing lease expiry cannot resurrect its previously established generation', async (t) => {
	const gate = new Deferred<void>();
	const f = fixture(t, { budgets: { leaseMs: 40 } });
	success(await f.server.connect(connectInput(f.identity)));
	f.state.readGate = gate.promise;
	const retry = f.server.connect(connectInput(f.identity));
	await waitFor(() => f.runtime.disposeCalls === 1);
	gate.resolve();
	assertError(await retry, 'TASK_RECOVERY_UNAVAILABLE');
	assert.equal(f.state.factoryCalls, 1);
});

test('timed-out server dependencies retain their bounded admission slots without blocking heartbeats', async (t) => {
	const probe = new Deferred<AgentRuntimeProbe>();
	const f = fixture(t, {
		budgets: { callTimeoutMs: 20, maxInFlight: 1 },
		createExecutor: (context) => ({
			...minimalExecutor(context, async () => {}),
			probe: () => probe.promise,
		}),
	});
	const helper = success(await f.server.connect(connectInput(f.identity)));
	assertError(await rpc(f, helper, { kind: 'probe' }), 'TASK_RECOVERY_UNAVAILABLE');
	assertError(await rpc(f, helper, { kind: 'probe' }), 'RATE_LIMITED');
	assert.equal((await rpc(f, helper, { kind: 'heartbeat' })).ok, true);
	probe.resolve({ available: true, featureEnabled: true, source: 'codespace-owned' });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal((await rpc(f, helper, { kind: 'probe' })).ok, true);
});

test('continuations require an actually completed task, identical owner/source scope, and exact retained session', async (t) => {
	const f = fixture(t);
	const helper = success(await f.server.connect(connectInput(f.identity)));
	const receipt = success(await rpc(f, helper, { kind: 'start', params: startParams(), workspace: boundWorkspace() }));
	assert.ok(receipt !== null && 'taskId' in receipt && receipt.recoveryDescriptor !== undefined);
	const continuation = {
		sessionUri: receipt.recoveryDescriptor.sessionId,
		chatUri: receipt.recoveryDescriptor.conversationId!,
	};
	assertError(await rpc(f, helper, {
		kind: 'start',
		params: startParams({ taskId: uuid(501), continueFromTaskId: TASK, continuation }),
		workspace: boundWorkspace(),
	}), 'TASK_RECOVERY_UNAVAILABLE');
	const handle = f.runtime.handles.get(TASK)!;
	await handle.events.push({ type: 'terminal', summary: 'Completed for continuation' });
	await handle.events.push({ type: 'completed' });
	success(await rpc(f, helper, { kind: 'events', acknowledgedSeq: 0, waitMs: 50 }));
	success(await rpc(f, helper, { kind: 'events', acknowledgedSeq: 1, waitMs: 50 }));
	success(await rpc(f, helper, { kind: 'events', acknowledgedSeq: 2, waitMs: 1 }));
	await waitFor(() => handle.disposeCalls === 1);
	for (const changes of [
		{ authenticatedOwnerId: uuid(510) },
		{ sourceNodeId: uuid(511) },
		{ sourceWorkspaceIdentity: createOpaqueWorkspaceIdentity('other source') },
		{ continueFromTaskId: uuid(512) },
		{ continuation: { ...continuation, chatUri: 'copilot:unrelated-chat' } },
		{ continuation: { ...continuation, sessionUri: 'copilot:unrelated-session' } },
	] satisfies Partial<NodeTaskStartParams>[]) {
		assertError(await rpc(f, helper, {
			kind: 'start',
			params: startParams({ taskId: randomUUID(), continueFromTaskId: TASK, continuation, ...changes }),
			workspace: boundWorkspace(),
		}), 'TASK_RECOVERY_UNAVAILABLE');
	}
	assert.equal(f.runtime.requests.length, 1, 'a rejected continuation never falls back to a fresh task');
});

test('changed heartbeat generation and callback failures are surfaced, bounded, and never silently reconnected', async (t) => {
	const f = fixture(t, {
		budgets: { heartbeatIntervalMs: 10 },
		onDisconnect: async () => { throw new Error('Disconnect callback failed'); },
		invoke: async (command, input, next) => {
			if (command === REMOTE_EXECUTION_COMMANDS.call
				&& (input as { operation: { kind: string } }).operation.kind === 'heartbeat') {
				return { ok: true, result: { helperInstanceId: uuid(600) } };
			}
			return next();
		},
	});
	await f.client.connect();
	await waitFor(() => f.disconnects.length === 1 && f.runtime.disposeCalls === 1);
	assert.equal(f.client.generationClosed, true);
	assert.ok(f.errors.some((error) => error.message === 'Disconnect callback failed'));
	await assert.rejects(f.client.connect(), hasCode('TASK_RECOVERY_UNAVAILABLE'));
	await assert.rejects(f.client.dispose(), knownCompleteCleanup);
	assert.equal(f.state.factoryCalls, 1);
});

test('a missing helper command fails immediately and the production connect budget is five seconds', async (t) => {
	assert.equal(remoteExecutionBudgets().connectTimeoutMs, 5_000);
	const f = fixture(t, {
		invoke: async () => { throw new Error('Codespaces companion command is unavailable'); },
	});
	await assert.rejects(f.client.connect(), hasCode('AGENT_UNAVAILABLE'));
	assert.equal(f.state.factoryCalls, 0);
	assert.equal(f.client.generationClosed, false);
	await f.client.dispose();
});

test('real executor event-sink cleanup failure retains positive cleanup proof across the command boundary', async (t) => {
	const blocked = new Deferred<void>();
	let disconnectReply: unknown;
	const f = fixture(t, {
		budgets: { maxQueuedEvents: 1 },
		eventSink: async () => blocked.promise,
		invoke: async (command, _input, next) => {
			const reply = await next();
			if (command === REMOTE_EXECUTION_COMMANDS.disconnect) {
				disconnectReply = reply;
			}
			return reply;
		},
	});
	t.after(() => blocked.resolve());
	await f.client.start(startParams());
	const handle = f.runtime.handles.get(TASK)!;
	await handle.events.push({ type: 'output', text: 'Waiting for durable desktop acceptance' });
	await waitFor(() => f.events.length === 1);
	await handle.events.push({ type: 'output', text: 'Backpressured inside the actual executor' });
	await new Promise((resolve) => setImmediate(resolve));
	await assert.rejects(f.client.dispose(), knownCompleteCleanup);
	assert.deepEqual(disconnectReply, {
		ok: false,
		error: {
			code: 'TASK_EXECUTION_FAILED',
			message: 'The Codespaces execution request could not be completed.',
			retryable: false,
			cleanupComplete: true,
		},
	});
	assert.equal(handle.cancelCalls, 1);
	assert.equal(handle.disposeCalls, 1);
	assert.equal(f.runtime.disposeCalls, 1);
	const replacement = { ...f.identity, clientId: randomUUID(), nodeInstanceId: randomUUID() };
	assert.equal((await f.server.connect(connectInput(replacement))).ok, true);
	assert.equal(f.state.factoryCalls, 2, 'a cleaned old generation does not permanently block a replacement');
});

test('unknown cleanup stays unconfirmed, but a subsequent exact confirmed cleanup can retire the client safely', async (t) => {
	let complete = false;
	const f = fixture(t, {
		createExecutor: (context) => minimalExecutor(context, async () => {
			throw new WindowNodeTaskExecutorDisposalError([new Error('Private runtime cleanup detail')], complete);
		}),
	});
	await f.client.connect();
	await assert.rejects(f.client.dispose(), (error: unknown) =>
		hasCode('TASK_CANCELLATION_UNCONFIRMED')(error)
		&& error instanceof Error && error.message.includes('Reconnect the Codespace'));
	assert.equal(f.client.generationClosed, true);
	complete = true;
	await assert.rejects(f.client.dispose(), knownCompleteCleanup);
	assert.equal(f.state.factoryCalls, 1);
	assert.equal((await f.server.connect(connectInput({
		...f.identity, clientId: randomUUID(), nodeInstanceId: randomUUID(),
	}))).ok, true);
});

test('network failure and forged authentication cleanup proof never assert that remote cleanup completed', async (t) => {
	let rejectDisconnect = true;
	const network = fixture(t, {
		invoke: async (command, _input, next) => {
			if (command === REMOTE_EXECUTION_COMMANDS.disconnect && rejectDisconnect) {
				throw new Error('Transport connection lost');
			}
			return next();
		},
	});
	await network.client.connect();
	await assert.rejects(network.client.dispose(), hasCode('TASK_CANCELLATION_UNCONFIRMED'));
	rejectDisconnect = false;
	await network.client.dispose();
	const forged = fixture(t, {
		invoke: async (command, _input, next) => command === REMOTE_EXECUTION_COMMANDS.disconnect ? {
			ok: false, error: {
				code: 'AUTH_FAILED', message: 'The Codespaces execution request could not be completed.',
				retryable: false, cleanupComplete: true,
			},
		} : next(),
	});
	await forged.client.connect();
	await assert.rejects(forged.client.dispose(), hasCode('TASK_CANCELLATION_UNCONFIRMED'));
});

for (const action of ['cancel', 'disposeTask'] as const) {
	test(`${action} owns a client admission before workspace resolution and prevents every later retry from dispatching`, async (t) => {
		const workspace = new Deferred<RegisteredLocalWorkspace | undefined>();
		const entered = new Deferred<void>();
		const accepted = new Deferred<void>();
		let cancellationAccepted = false;
		const f = fixture(t, {
			workspaceResolver: async () => { entered.resolve(); return workspace.promise; },
			eventSink: async (event) => {
				if (event.event.type === 'cancelled') {
					await accepted.promise;
					cancellationAccepted = true;
				}
			},
		});
		t.after(() => { workspace.resolve(boundWorkspace()); accepted.resolve(); });
		await f.client.connect();
		const params = startParams();
		let startSettled = false;
		const starting = f.client.start(params).finally(() => { startSettled = true; });
		const rejected = assert.rejects(starting, hasCode('TASK_EXECUTION_FAILED'));
		await entered.promise;
		const stopping = f.client[action](taskAddress(TASK));
		if (action === 'cancel') {
			await waitFor(() => f.events.some((event) => event.event.type === 'cancelled'));
			assert.equal(startSettled, false);
			assert.equal(cancellationAccepted, false);
			accepted.resolve();
		}
		await raceTimeout(stopping, 100);
		await rejected;
		assert.equal(f.events.length, action === 'cancel' ? 1 : 0);
		assert.equal(cancellationAccepted, action === 'cancel');
		assert.equal(calls(f, 'start').length, 0);
		await assert.rejects(f.client.start(params), hasCode('TASK_EXECUTION_FAILED'));
		await assert.rejects(f.client.start(startParams({
			...params, prompt: 'Changed after cancellation', delegationGrant: undefined,
		})), hasCode('TASK_ID_CONFLICT'));
		workspace.resolve(boundWorkspace());
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls(f, 'start').length, 0);
		assert.equal(f.runtime.requests.length, 0);
		assert.equal(f.client.generationClosed, false);
	});

	test(`${action} reserves ownership even while the initial helper handshake is unresolved`, async (t) => {
		const handshake = new Deferred<void>();
		const entered = new Deferred<void>();
		let workspaceReads = 0;
		const f = fixture(t, {
			invoke: async (command, _input, next) => {
				const reply = await next();
				if (command === REMOTE_EXECUTION_COMMANDS.connect) {
					entered.resolve();
					await handshake.promise;
				}
				return reply;
			},
			workspaceResolver: async () => { workspaceReads += 1; return boundWorkspace(); },
		});
		t.after(() => handshake.resolve());
		const params = startParams();
		const rejected = assert.rejects(f.client.start(params), hasCode('TASK_EXECUTION_FAILED'));
		await entered.promise;
		await raceTimeout(f.client[action](taskAddress(TASK)), 100);
		await rejected;
		assert.equal(f.events.length, action === 'cancel' ? 1 : 0);
		handshake.resolve();
		await f.client.connect();
		assert.equal(workspaceReads, 0);
		assert.equal(calls(f, 'start').length, 0);
		assert.equal(f.runtime.requests.length, 0);
	});

	test(`${action} stops a server admission during remote filesystem validation without waiting for that validation`, async (t) => {
		const filesystem = new Deferred<void>();
		const accepted = new Deferred<void>();
		const f = fixture(t, {
			eventSink: async (event) => {
				if (event.event.type === 'cancelled') {
					await accepted.promise;
				}
			},
		});
		t.after(() => { filesystem.resolve(); accepted.resolve(); });
		await f.client.connect();
		const reads = f.state.readCalls;
		f.state.readGate = filesystem.promise;
		const params = startParams();
		let startSettled = false;
		const starting = f.client.start(params).finally(() => { startSettled = true; });
		const rejected = assert.rejects(starting, hasCode('TASK_EXECUTION_FAILED'));
		await waitFor(() => f.state.readCalls > reads);
		const stopping = f.client[action](taskAddress(TASK));
		if (action === 'cancel') {
			await waitFor(() => f.events.some((event) => event.event.type === 'cancelled'));
			assert.equal(startSettled, false, 'enqueueing a cancellation cannot release the rejected start');
			accepted.resolve();
		}
		await raceTimeout(stopping, 100);
		await rejected;
		assert.equal(f.runtime.requests.length, 0);
		assert.equal(f.events.length, action === 'cancel' ? 1 : 0);
		await assert.rejects(f.client.start(params), hasCode('TASK_EXECUTION_FAILED'));
		await assert.rejects(f.client.start(startParams({
			...params, prompt: 'Different admitted request', delegationGrant: undefined,
		})), hasCode('TASK_ID_CONFLICT'));
		const forwarded = calls(f, 'start')[0];
		assert.ok(forwarded.operation.kind === 'start');
		assertError(await f.server.call(forwarded), 'TASK_EXECUTION_FAILED');
		assertError(await f.server.call({ ...forwarded, requestId: randomUUID() }), 'TASK_EXECUTION_FAILED');
		assertError(await f.server.call({
			...forwarded,
			requestId: randomUUID(),
			operation: {
				...forwarded.operation,
				params: startParams({ ...params, prompt: 'Conflicting server retry', delegationGrant: undefined }),
			},
		}), 'TASK_ID_CONFLICT');
		filesystem.resolve();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(f.runtime.requests.length, 0);
		assert.equal(calls(f, 'start').length, 1);
		assert.equal(f.client.generationClosed, false);
	});
}

test('the normal empty-poll pause cannot let a real executor startup rejection overtake cancelled-event acceptance', async (t) => {
	const paused = new Deferred<void>();
	const startGate = new Deferred<void>();
	const sinkGate = new Deferred<void>();
	const cancelledRuntime = new Deferred<void>();
	let resumePoll: (() => void) | undefined;
	let pauseOnce = true;
	let accepted = false;
	let settled = false;
	const f = fixture(t, {
		budgets: { pollWaitMs: 5, heartbeatIntervalMs: 20 },
		clientBudgets: { idlePollDelayMs: 10 },
		clientTiming: {
			schedule: (callback, delay) => {
				if (delay === 10 && pauseOnce) {
					pauseOnce = false;
					resumePoll = callback;
					paused.resolve();
					return { dispose: () => { resumePoll = undefined; } };
				}
				const timer = setTimeout(callback, delay);
				return { dispose: () => clearTimeout(timer) };
			},
		},
		eventSink: async (event) => {
			if (event.event.type === 'cancelled') {
				await sinkGate.promise;
				accepted = true;
			}
		},
	});
	t.after(() => { resumePoll?.(); sinkGate.resolve(); startGate.resolve(); });
	f.runtime.onStart = async () => startGate.promise;
	f.runtime.onCancelStart = () => {
		startGate.reject(new Error('Startup cancelled without launching a turn'));
		cancelledRuntime.resolve();
	};
	await f.client.connect();
	await paused.promise;
	const starting = f.client.start(startParams()).catch((error: unknown) => {
		settled = true;
		assert.equal(accepted, true, 'the Broker acceptance boundary must precede the start failure');
		throw error;
	});
	const rejected = assert.rejects(starting, hasCode('TASK_EXECUTION_FAILED'));
	await waitFor(() => f.runtime.requests.length === 1);
	const cancelling = f.client.cancel(taskAddress(TASK));
	await cancelledRuntime.promise;
	await waitFor(() => calls(f, 'heartbeat').length >= 2);
	assert.equal(settled, false);
	assert.equal(f.events.length, 0);
	resumePoll?.();
	await waitFor(() => f.events.some((event) => event.event.type === 'cancelled'));
	assert.equal(settled, false);
	sinkGate.resolve();
	await cancelling;
	await rejected;
	assert.equal(f.runtime.handles.size, 0);
	assert.equal(f.client.generationClosed, false);
	assert.ok(calls(f, 'events').some((call) =>
		call.operation.kind === 'events' && call.operation.acknowledgedSeq === 1));
});

test('disposal retires queued and late events for only that task, including a Broker sink awaiting disposal', async (t) => {
	let disposingTask: Promise<void> | undefined;
	let targetClient: RemoteExecutionClient;
	const f = fixture(t, {
		eventSink: async (event) => {
			if (event.taskId === TASK) {
				disposingTask = targetClient.disposeTask(taskAddress(TASK));
				await disposingTask;
				throw new Error('The Broker route was already removed by internal disposal');
			}
		},
	});
	targetClient = f.client;
	await f.client.start(startParams());
	const other = uuid(800);
	await f.client.start(startParams({ taskId: other }));
	await f.runtime.handles.get(TASK)!.events.push({ type: 'output', text: 'Retire this delivery route' });
	await waitFor(() => disposingTask !== undefined);
	await raceTimeout(disposingTask!, 100);
	const eventsBeforeLate = f.events.length;
	await f.contexts[0].eventSink.publish(taskEvent({ type: 'cancelled', summary: 'Late terminal after disposal' }));
	assert.equal(f.events.length, eventsBeforeLate);
	await f.runtime.handles.get(other)!.events.push({ type: 'completed' });
	await waitFor(() => f.events.some((event) => event.taskId === other && event.event.type === 'completed'));
	assert.equal(f.client.generationClosed, false);
	assert.equal(f.disconnects.length, 0);
});

for (const termination of ['disconnect', 'lease', 'ackTimeout'] as const) {
	test(`${termination} rejects queued acknowledgement waiters without blocking executor cleanup`, async (t) => {
		const f = fixture(t, {
			budgets: {
				leaseMs: termination === 'lease' ? 40 : 2_000,
				eventAcknowledgementTimeoutMs: termination === 'ackTimeout' ? 25 : 500,
			},
		});
		const helper = success(await f.server.connect(connectInput(f.identity)));
		success(await rpc(f, helper, { kind: 'start', params: startParams(), workspace: boundWorkspace() }));
		const publication = assert.rejects(Promise.resolve(f.contexts[0].eventSink.publish(
			taskEvent({ type: 'output', summary: 'Delivered but not acknowledged' }),
		)), hasCode('TASK_RECOVERY_UNAVAILABLE'));
		success(await rpc(f, helper, { kind: 'events', acknowledgedSeq: 0, waitMs: 1 }));
		if (termination === 'disconnect') {
			success(await f.server.disconnect(authorization(f.identity, helper)));
		}
		await publication;
		await waitFor(() => f.runtime.disposeCalls === 1);
		assert.equal((await rpc(f, helper, { kind: 'heartbeat' })).ok, false);
	});
}

function descriptor(): RemoteWorkspaceDescriptor {
	return { sourceUri: SOURCE_URI, canonicalUri: CANONICAL_URI, fileIdentity: FILE_IDENTITY, name: 'Codespace folder', capabilityTags: ['typescript'] };
}

function boundWorkspace() {
	return { workspaceId: WORKSPACE, workspaceIdentity: WORKSPACE_IDENTITY, displayName: 'Codespace folder', uri: CANONICAL_URI };
}

function clientIdentity(): RemoteExecutionIdentity {
	return {
		version: 1, clientId: randomUUID(), nodeId: NODE, nodeInstanceId: INSTANCE,
		nodeLabel: 'Codespace window', authority: AUTHORITY, expectedFolders: [SOURCE_URI],
		token: Buffer.alloc(32, 7).toString('base64url'),
	};
}

function connectInput(identity: RemoteExecutionIdentity) {
	return { ...identity, extensionId: REMOTE_EXECUTION_CLIENT_EXTENSION_ID, extensionVersion: VERSION };
}

function authorization(identity: RemoteExecutionIdentity, helper: RemoteExecutionConnected): RemoteExecutionAuthorization {
	return { version: 1, clientId: identity.clientId, helperInstanceId: helper.helperInstanceId, token: identity.token };
}

function taskAddress(taskId: string) {
	return { nodeId: NODE, nodeInstanceId: INSTANCE, taskId };
}

function taskEvent(event: NodeTaskEventParams['event']): NodeTaskEventParams {
	return { ...taskAddress(TASK), at: new Date().toISOString(), event };
}

function startParams(changes: Partial<NodeTaskStartParams> = {}): NodeTaskStartParams {
	const params = {
		delegationRequestId: uuid(8),
		taskId: TASK,
		target: { deviceId: DEVICE, nodeId: NODE, nodeInstanceId: INSTANCE, workspaceId: WORKSPACE },
		sourceNodeId: SOURCE,
		title: 'Task in Codespace',
		prompt: 'Make the requested change',
		acceptanceCriteria: ['It works remotely'],
		workerDeadline: new Date(Date.now() + 60_000).toISOString(),
		authenticatedOwnerId: OWNER,
		sourceLabel: 'Desktop source',
		executionBackend: 'codespace-owned' as const,
		...changes,
	};
	return {
		...params,
		delegatedExecutionContext: changes.delegatedExecutionContext ?? {
			kind: 'delegatedChild', taskId: params.taskId, capability: 'd'.repeat(43),
		},
		delegationGrant: changes.delegationGrant ?? createDelegationGrant({
			taskId: params.taskId,
			targetNodeId: params.target.nodeId,
			targetNodeInstanceId: params.target.nodeInstanceId,
			workspaceIdentity: WORKSPACE_IDENTITY,
			requestHash: canonicalRoutedTaskRequestHash({
				delegationRequestId: params.delegationRequestId,
				taskId: params.taskId,
				continueFromTaskId: params.continueFromTaskId,
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

function rpc(f: Fixture, helper: RemoteExecutionConnected, operation: RemoteExecutionOperation, requestId: string = randomUUID()) {
	return f.server.call({ ...authorization(f.identity, helper), requestId, operation });
}

function calls(f: Fixture, kind: RemoteExecutionOperation['kind']) {
	return f.invocations.filter((entry) => entry.command === REMOTE_EXECUTION_COMMANDS.call)
		.map((entry) => parseRemoteValue(remoteExecutionCallSchema, entry.input, 1_048_576))
		.filter((call) => call.operation.kind === kind);
}

function success<T>(reply: RemoteExecutionEnvelope<T>): T {
	assert.equal(reply.ok, true, JSON.stringify(reply));
	assert.ok(reply.ok);
	return reply.result;
}

function assertError(reply: RemoteExecutionEnvelope<unknown>, code: string): void {
	assert.equal(reply.ok, false);
	assert.ok(!reply.ok);
	assert.equal(reply.error.code, code);
	assert.equal(reply.error.message, 'The Codespaces execution request could not be completed.');
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof AgentRuntimeError ? error.code === code
		: error instanceof MeshDomainError && error.reason === code;
}

function knownCompleteCleanup(error: unknown): boolean {
	return error instanceof WindowNodeTaskExecutorDisposalError && error.cleanupComplete;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.fail('Timed out waiting for bridge processing.');
}

async function raceTimeout<T>(operation: Promise<T>, delayMs: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('Independent bridge control operation was blocked.')), delayMs);
		})]);
	} finally {
		clearTimeout(timer);
	}
}

function minimalExecutor(context: RemoteExecutionExecutorContext, dispose: () => Promise<void>): RemoteExecutionExecutor {
	return {
		executor: {
			start: async (params) => ({ taskId: params.taskId, nodeId: context.nodeId, nodeInstanceId: context.nodeInstanceId }),
			answer: async () => {},
			cancel: async () => {},
			disposeTask: async () => {},
			dispose,
		},
		probe: async () => ({ available: true, featureEnabled: true, source: 'codespace-owned' }),
	};
}

function uuid(value: number): string {
	return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}
