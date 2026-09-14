import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { LOCAL_BROKER_HEARTBEAT_TTL_MS, LOCAL_BROKER_REQUEST_TIMEOUT_MS } from '../../shared/protocol';

import {
	createAgentRuntimeEventQueue,
	type AgentRuntime,
	type AgentRuntimeProbe,
	type AgentTaskAnswer,
	type AgentTaskHandle,
	type AgentTaskRequest,
} from '../agentHost/AgentRuntime';
import { BrokerTaskService, DeviceBroker, NodeRegistry, PeerPolicyService, PeerPolicyStore, TaskRouteCatalog } from '../broker';
import { describeCodespaceWorkspaces } from '../codespaces/CodespaceEnvironment';
import { DesktopCodespaceExecution } from '../codespaces/DesktopCodespaceExecution';
import { RemoteExecutionClient } from '../codespaces/RemoteExecutionClient';
import { RemoteExecutionServer } from '../codespaces/RemoteExecutionServer';
import type { StateStore } from '../domain/ports';
import type { BrokerOwnership } from '../storage/BrokerOwnerLock';
import { WindowNodeClient, WindowNodeTaskExecutor } from '../node';
import { AtomicFileStore } from '../storage/AtomicFileStore';
import { FileTaskStore } from '../tasks/FileTaskStore';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { LocalBrokerTaskFacade } from '../tools/LocalBrokerTaskFacade';
import { TaskToolsCore } from '../tools/taskToolsCore';
import { MemoryAtomicFileSystem, TestOwnership } from '../unitTest/artifactStoreTestSupport';
import { NodeFileIdentityResolver } from '../workspaces/NodeFileIdentityResolver';
import { AgentHostLauncher } from '../agentHost/AgentHostLauncher';
import { NativeChatControlRegistry, NativeChatExecution } from '../codespaces/nativeChat/NativeChatExecution';
import { NativeChatStore } from '../codespaces/nativeChat/NativeChatStore';

const directorySchema = z.object({
	status: z.literal('ok'),
	devices: z.array(z.object({
		nodes: z.array(z.object({
			nodeId: z.string(),
			workspaces: z.array(z.object({ targetHandle: z.string() })),
		})),
	})),
});
const taskReadSchema = z.object({
	status: z.literal('ok'),
	snapshot: z.object({
		taskId: z.string(),
		status: z.string(),
		summary: z.string().optional(),
		pendingInput: z.object({ inputId: z.string() }).optional(),
	}),
});

test('six existing tools collaborate through the real Broker, Codespaces bridge and target executor', async (t) => {
	const f = await fixture(t);
	const before = directorySchema.parse(await f.sourceTools.listWorkers({ scope: 'local' }));
	assert.equal(before.devices.flatMap((device) => device.nodes).length, 0);
	await f.authorizeBothDirections();
	const targetHandle = await handleFor(f.sourceTools, f.target.nodeId);
	const request = { targetHandle, delegationRequestId: randomUUID(), title: 'Remote work', prompt: 'Use the remote workspace.', mode: 'submit' };
	const submitted = await f.sourceTools.delegateTask(request);
	assert.equal(submitted.s, 4);
	const taskId = z.string().parse(submitted.t);
	await waitFor(() => f.remote.handles.has(taskId));
	const handle = f.remote.handles.get(taskId)!;
	assert.equal(f.remote.requests[0].executionBackend, 'codespace-owned');
	assert.equal(f.remote.requests[0].requireEditor, undefined);
	assert.equal((await f.sourceTools.delegateTask(request)).t, taskId);
	assert.equal(f.remote.requests.length, 1);
	assert.equal((await f.sourceTools.delegateTask({ ...request, prompt: 'Different request.' })).e, 'IDEMPOTENCY_CONFLICT');
	const running = z.object({ tasks: z.array(z.object({ taskId: z.string() })) }).parse(await f.sourceTools.listTasks({}));
	assert.ok(running.tasks.some((task) => task.taskId === taskId));
	await handle.events.push({
		type: 'inputRequired',
		request: { requestId: 'runtime-input', kind: 'chatInput', prompt: 'Continue?' },
	});
	const input = taskReadSchema.parse(await f.sourceTools.getTask({ taskId, waitFor: 'outcome', waitSeconds: 5 }));
	assert.equal(input.snapshot.status, 'needsInput');
	assert.ok(input.snapshot.pendingInput);
	const answer = {
		taskId, inputId: input.snapshot.pendingInput.inputId,
		answerId: randomUUID(), answer: 'Continue.',
	};
	assert.equal((await f.sourceTools.answerTask(answer)).status, 'ok');
	assert.equal(handle.answers.length, 1);
	const completed = taskReadSchema.parse(await f.sourceTools.getTask({ taskId, waitFor: 'outcome', waitSeconds: 5 }));
	assert.equal(completed.snapshot.status, 'completed');

	const followup = await f.sourceTools.delegateTask({
		targetHandle, delegationRequestId: randomUUID(), title: 'Follow up', prompt: 'Continue the same session.',
		continueFromTaskId: taskId, mode: 'submit',
	});
	assert.equal(followup.s, 4);
	const nextId = z.string().parse(followup.t);
	assert.notEqual(nextId, taskId);
	await waitFor(() => f.remote.handles.has(nextId));
	assert.deepEqual(f.remote.requests[1].continuation, {
		sessionUri: handle.recovery.sessionUri, chatUri: handle.recovery.chatUri,
	});
	assert.equal(f.remote.requests[1].requireEditor, undefined);
	await waitFor(() => f.remoteStarted.has(nextId));
	assert.equal((await f.sourceTools.cancelTask({ taskId: nextId })).status, 'ok');
	const cancelled = taskReadSchema.parse(await f.sourceTools.getTask({ taskId: nextId, waitFor: 'outcome', waitSeconds: 5 }));
	assert.equal(cancelled.snapshot.status, 'cancelled');
	assert.equal(f.remote.handles.get(nextId)!.cancelCalls, 1);
	await waitFor(() => f.nativeStore.sessionForTask(nextId)?.turns.at(-1)?.status === 'cancelled');
	const transcript = f.nativeStore.sessionForTask(nextId)!;
	assert.equal(transcript.id, taskId);
	assert.equal(transcript.turns.length, 2);
	assert.equal(transcript.turns[0].status, 'completed');
	assert.ok(transcript.turns[0].entries.some((entry) => entry.kind === 'input'));
	assert.ok(transcript.turns[0].entries.some((entry) => entry.text.includes('Remote result.')));
	assert.equal(f.brokerStarts, 1);
	assert.deepEqual(f.errors, []);
});

test('slow Codespaces output acknowledgement preserves the full Chinese response in source and native history', async (t) => {
	const f = await fixture(t, { outputDelayMs: 40 });
	await f.authorizeBothDirections();
	const submitted = await f.sourceTools.delegateTask({
		targetHandle: await handleFor(f.sourceTools, f.target.nodeId),
		delegationRequestId: randomUUID(), title: 'Streaming response', prompt: 'Return the complete response.', mode: 'submit',
	});
	const taskId = z.string().parse(submitted.t);
	await waitFor(() => f.remoteStarted.has(taskId));
	const body = '逐字发送的中文和表情🙂，每一段都要按顺序完整返回。\n'.repeat(60);
	const text = `First word ${body}Final ending.`;
	const handle = f.remote.handles.get(taskId)!;
	await handle.events.push({ type: 'output', text: 'First word ' });
	for (const character of `${body}Final ending.`) { await handle.events.push({ type: 'output', text: character }); }
	await handle.events.push({ type: 'completed' });
	const result = taskReadSchema.parse(await f.sourceTools.getTask({ taskId, waitFor: 'outcome', waitSeconds: 5 }));
	assert.equal(result.snapshot.status, 'completed');
	await waitFor(() => f.nativeStore.sessionForTask(taskId)?.turns.at(-1)?.status === 'completed');
	const entries = f.nativeStore.sessionForTask(taskId)!.turns.at(-1)!.entries;
	assert.equal(entries.filter((entry) => entry.kind === 'output').map((entry) => entry.text).join(''), text);
	assert.ok(!entries.some((entry) => entry.text.includes('consumer was catching up')));
	assert.equal(result.snapshot.summary, text.replace(/\s+/gu, ' ').trim());
	assert.equal(f.remote.requests.length, 1, 'Recovering output must not execute another model turn.');
	assert.deepEqual(f.errors, []);
});

test('the first task survives a 31-second Broker acknowledgement pause with production budgets', { timeout: 60_000 }, async (t) => {
	const f = await fixture(t, { productionTiming: true, brokerEventDelayMs: 31_000 });
	await f.authorizeBothDirections();
	const startedAt = Date.now();
	const waiting = f.sourceTools.delegateTask({
		targetHandle: await handleFor(f.sourceTools, f.target.nodeId),
		delegationRequestId: randomUUID(), title: 'Slow Broker first task', prompt: 'Complete once after the Broker resumes.',
	});
	await waitFor(() => f.remote.requests.length === 1 && f.remoteStarted.has(f.remote.requests[0].taskId));
	const taskId = f.remote.requests[0].taskId;
	const handle = f.remote.handles.get(taskId)!;
	await handle.events.push({ type: 'output', text: 'The first task completed without replay.\n' });
	await handle.events.push({ type: 'completed' });
	const result = await waiting;
	assert.equal(result.s, 0);
	assert.equal(result.t, taskId);
	assert.equal(taskReadSchema.parse(await f.sourceTools.getTask({ taskId })).snapshot.status, 'completed');
	assert.ok(Date.now() - startedAt >= 31_000);
	assert.equal(f.source.snapshot().registered, true);
	assert.equal(f.target.snapshot().registered, true);
	assert.equal(f.remote.requests.length, 1);
	await waitFor(() => f.nativeStore.sessionForTask(taskId)?.turns.at(-1)?.status === 'completed');
	assert.deepEqual(f.errors, []);
});

test('a Codespaces window uses the unchanged tools to delegate back to a desktop window', async (t) => {
	const f = await fixture(t);
	await f.authorizeBothDirections();
	const targetHandle = await handleFor(f.targetTools, f.source.nodeId);
	const waiting = f.targetTools.delegateTask({
		targetHandle, delegationRequestId: randomUUID(), title: 'Desktop task', prompt: 'Run in the desktop workspace.',
	});
	await waitFor(() => f.local.handles.size === 1);
	const handle = [...f.local.handles.values()][0];
	await handle.events.push({ type: 'output', text: 'Desktop result.' });
	await handle.events.push({ type: 'completed' });
	assert.equal((await waiting).s, 0);
	assert.equal(f.local.requests[0].executionBackend, undefined);
	assert.equal(f.remote.requests.length, 0);
	assert.equal(f.errors.length, 0);
});

test('desktop delegation reaches the Codespaces executor through native CLI version discovery', async (t) => {
	const f = await fixture(t);
	const calls: string[][] = [];
	const launcher = new AgentHostLauncher({
		storageRoot: 'unused-probe-storage', configuredCodeCli: 'native-cli-fixture',
	}, {
		assertProcessControlSupported() {},
		runCommand: async (_executable, args) => {
			calls.push([...args]);
			assert.deepEqual(args, ['--version']);
			return 'code 1.137.0 (commit 645f29cc3176500b4b5762ba887cf2a7f0ffdf2c)\n';
		},
	});
	t.after(() => launcher.dispose());
	f.remote.probe = async () => {
		const probe = await launcher.probe();
		return { available: probe.available, featureEnabled: true, version: probe.version, source: 'codespace-owned' };
	};
	await f.authorizeBothDirections();
	const targetHandle = await handleFor(f.sourceTools, f.target.nodeId);
	const submitted = await f.sourceTools.delegateTask({
		targetHandle, delegationRequestId: randomUUID(), title: 'Native CLI task',
		prompt: 'Respond from the Codespaces runtime.', mode: 'submit',
	});
	assert.equal(submitted.s, 4);
	const taskId = z.string().parse(submitted.t);
	await waitFor(() => f.remote.handles.has(taskId));
	assert.deepEqual(calls, [['--version']]);
	await f.remote.handles.get(taskId)!.events.push({ type: 'completed' });
	const completed = taskReadSchema.parse(await f.sourceTools.getTask({
		taskId, waitFor: 'outcome', waitSeconds: 5,
	}));
	assert.equal(completed.snapshot.status, 'completed');
	assert.equal(f.errors.length, 0);
});

test('cancel interrupts an outstanding Codespaces start without a phantom failed task or a new execution', async (t) => {
	const f = await fixture(t);
	await f.authorizeBothDirections();
	const targetHandle = await handleFor(f.sourceTools, f.target.nodeId);
	f.remote.blockNextStart = true;
	const submitted = await f.sourceTools.delegateTask({
		targetHandle, delegationRequestId: randomUUID(), title: 'Cold start', prompt: 'Wait for startup.', mode: 'submit',
	});
	assert.equal(submitted.s, 4);
	const taskId = z.string().parse(submitted.t);
	await waitFor(() => f.remote.requests.some((request) => request.taskId === taskId));
	assert.equal((await f.sourceTools.cancelTask({ taskId })).status, 'ok');
	const cancelled = taskReadSchema.parse(await f.sourceTools.getTask({ taskId, waitFor: 'outcome', waitSeconds: 5 }));
	assert.equal(cancelled.snapshot.status, 'cancelled');
	assert.equal(f.remote.handles.has(taskId), false);
	assert.deepEqual(f.remote.cancelledStarts, [taskId]);
	const next = await f.sourceTools.delegateTask({
		targetHandle, delegationRequestId: randomUUID(), title: 'Next task', prompt: 'Fresh execution.', mode: 'submit',
	});
	assert.equal(next.s, 4);
	const nextId = z.string().parse(next.t);
	await waitFor(() => f.remote.handles.has(nextId));
	await f.remote.handles.get(nextId)!.events.push({ type: 'completed' });
	assert.equal(taskReadSchema.parse(await f.sourceTools.getTask({ taskId: nextId, waitFor: 'outcome', waitSeconds: 5 })).snapshot.status, 'completed');
});

test('native cancellation rejects stale generations while input remains source-owned', async (t) => {
	const f = await fixture(t);
	await f.authorizeBothDirections();
	const targetHandle = await handleFor(f.sourceTools, f.target.nodeId);
	const submitted = await f.sourceTools.delegateTask({
		targetHandle, delegationRequestId: randomUUID(), title: 'Native controls', prompt: 'Ask the target user.', mode: 'submit',
	});
	const taskId = z.string().parse(submitted.t);
	await waitFor(() => f.remote.handles.has(taskId));
	const handle = f.remote.handles.get(taskId)!;
	await handle.events.push({
		type: 'inputRequired', request: { requestId: 'native-question', kind: 'chatInput', prompt: 'Continue?' },
	});
	await waitFor(() => f.nativeStore.sessionForTask(taskId)?.turns.at(-1)?.pendingInput !== undefined);
	const session = f.nativeStore.sessionForTask(taskId)!;
	const inputId = session.turns.at(-1)!.pendingInput!.inputId;
	await assert.rejects(f.nativeControls.cancel(randomUUID(), taskId), /no longer live/);
	assert.equal((await f.sourceTools.answerTask({ taskId, inputId, answerId: randomUUID(), answer: 'Continue.' })).status, 'ok');
	assert.equal(handle.answers.length, 1);
	assert.equal(taskReadSchema.parse(await f.sourceTools.getTask({ taskId, waitFor: 'outcome', waitSeconds: 5 })).snapshot.status, 'completed');
	await waitFor(() => !f.nativeControls.isLive(session.generation, taskId));
	await assert.rejects(f.nativeControls.cancel(session.generation, taskId), /no longer live/);
	const next = await f.sourceTools.delegateTask({
		targetHandle, delegationRequestId: randomUUID(), title: 'Native cancel', prompt: 'Wait for cancellation.', mode: 'submit',
	});
	const nextId = z.string().parse(next.t);
	await waitFor(() => f.remoteStarted.has(nextId));
	await f.nativeControls.cancel(f.nativeStore.sessionForTask(nextId)!.generation, nextId);
	assert.equal(taskReadSchema.parse(await f.sourceTools.getTask({ taskId: nextId, waitFor: 'outcome', waitSeconds: 5 })).snapshot.status, 'cancelled');
	assert.equal(f.remote.handles.get(nextId)!.cancelCalls, 1);
	assert.equal(f.errors.length, 0);
});

test('cancellation during native history admission cannot start a later Agent turn', async (t) => {
	const f = await fixture(t);
	await f.authorizeBothDirections();
	const begin = f.nativeStore.beginTask.bind(f.nativeStore);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	let entered = false;
	f.nativeStore.beginTask = async (input) => {
		entered = true;
		await pending;
		return begin(input);
	};
	try {
		const submitted = await f.sourceTools.delegateTask({
			targetHandle: await handleFor(f.sourceTools, f.target.nodeId),
			delegationRequestId: randomUUID(), title: 'Pending history', prompt: 'Do not start after cancellation.', mode: 'submit',
		});
		const taskId = z.string().parse(submitted.t);
		await waitFor(() => entered);
		const cancellation = f.sourceTools.cancelTask({ taskId });
		await waitFor(() => f.remote.cancelledStarts.includes(taskId));
		release();
		await cancellation;
		assert.equal(taskReadSchema.parse(await f.sourceTools.getTask({ taskId, waitFor: 'outcome', waitSeconds: 5 })).snapshot.status, 'cancelled');
		assert.equal(f.remote.requests.length, 0);
		assert.equal(f.remote.handles.size, 0);
	} finally { release(); }
});

test('a reported native history failure does not rewrite the acknowledged Mesh task result or retry execution', async (t) => {
	const f = await fixture(t);
	await f.authorizeBothDirections();
	const submitted = await f.sourceTools.delegateTask({
		targetHandle: await handleFor(f.sourceTools, f.target.nodeId),
		delegationRequestId: randomUUID(), title: 'History failure', prompt: 'Return a result once.', mode: 'submit',
	});
	const taskId = z.string().parse(submitted.t);
	await waitFor(() => f.remote.handles.has(taskId));
	const append = f.nativeStore.append.bind(f.nativeStore);
	f.nativeStore.append = async () => { throw new Error('Injected transcript write failure.'); };
	const handle = f.remote.handles.get(taskId)!;
	await handle.events.push({ type: 'output', text: 'The actual Agent result.\n\n' });
	await handle.events.push({ type: 'completed' });
	assert.equal(taskReadSchema.parse(await f.sourceTools.getTask({ taskId, waitFor: 'outcome', waitSeconds: 5 })).snapshot.status, 'completed');
	await waitFor(() => f.errors.length > 0);
	f.nativeStore.append = append;
	assert.match(f.errors[0].message, /history could not be saved/);
	assert.equal(f.remote.requests.length, 1);
	assert.notEqual(f.nativeStore.sessionForTask(taskId)?.turns.at(-1)?.status, 'completed');
});

class RuntimeHandle implements AgentTaskHandle {
	public readonly events = createAgentRuntimeEventQueue();
	public readonly answers: AgentTaskAnswer[] = [];
	public cancelCalls = 0;
	public readonly recovery;

	public constructor(public readonly taskId: string, request: AgentTaskRequest) {
		this.recovery = {
			clientId: randomUUID(),
			sessionUri: request.continuation?.sessionUri ?? `copilotcli:/${randomUUID()}`,
			chatUri: request.continuation?.chatUri ?? `ahp-chat:/${randomUUID()}`,
			lastSeenServerSeq: 1,
		};
	}
	public async cancel(): Promise<void> {
		this.cancelCalls += 1;
		await this.events.push({ type: 'cancelled' });
	}
	public async answer(answer: AgentTaskAnswer): Promise<void> {
		this.answers.push(answer);
		await this.events.push({ type: 'output', text: 'Remote result.' });
		await this.events.push({ type: 'completed' });
	}
	public async dispose(): Promise<void> { this.events.close(); }
}

class Runtime implements AgentRuntime {
	public readonly handles = new Map<string, RuntimeHandle>();
	public readonly requests: AgentTaskRequest[] = [];
	public readonly cancelledStarts: string[] = [];
	public blockNextStart = false;
	private readonly pending = new Map<string, (error: Error) => void>();
	public async probe(): Promise<AgentRuntimeProbe> { return { available: true, featureEnabled: true }; }
	public async start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		this.requests.push(request);
		if (this.blockNextStart) {
			this.blockNextStart = false;
			await new Promise<never>((_resolve, reject) => { this.pending.set(request.taskId, reject); });
		}
		const handle = new RuntimeHandle(request.taskId, request);
		this.handles.set(request.taskId, handle);
		return handle;
	}
	public async cancelStart(taskId: string): Promise<void> {
		this.cancelledStarts.push(taskId);
		this.pending.get(taskId)?.(new Error('The pending runtime start was cancelled.'));
		this.pending.delete(taskId);
	}
	public async dispose(): Promise<void> {
		for (const reject of this.pending.values()) { reject(new Error('The runtime stopped.')); }
		this.pending.clear();
	}
}

class State implements StateStore {
	private readonly values = new Map<string, unknown>();
	public get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
	public async update(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
}

class Ownership extends TestOwnership implements BrokerOwnership {
	public async contend(): Promise<boolean> { return true; }
	public onDidLoseOwnership(): { dispose(): void } { return { dispose() {} }; }
	public async dispose(): Promise<void> {}
}

async function fixture(t: TestContext, options: { outputDelayMs?: number; productionTiming?: boolean; brokerEventDelayMs?: number } = {}) {
	const root = await realpath(await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cam-cs-')));
	const cleanups: Array<() => Promise<void>> = [() => rm(root, { recursive: true, force: true })];
	let stopping = false;
	t.after(async () => {
		stopping = true;
		const failures: unknown[] = [];
		for (const cleanup of cleanups.reverse()) {
			try { await cleanup(); } catch (error: unknown) { failures.push(error); }
		}
		if (failures.length) { throw new AggregateError(failures, 'Codespaces collaboration fixture cleanup failed.'); }
	});
	await mkdir(join(root, 'source'));
	await mkdir(join(root, 'target'));
	const sourceUri = pathToFileURL(join(root, 'source')).href;
	const targetUri = pathToFileURL(join(root, 'target')).href;
	const authority = 'codespaces+mesh-component';
	const identity = { userIdentity: randomUUID(), deviceId: randomUUID(), tempDirectory: root };
	const brokerKey = randomBytes(32);
	const clock = { now: () => new Date() };
	const ownership = new Ownership();
	const files = new AtomicFileStore('memory', new MemoryAtomicFileSystem(), { next: randomUUID });
	const peerStore = new PeerPolicyStore(files, { ownership, generation: ownership.generation, clock });
	await peerStore.initialize();
	const registry = await NodeRegistry.create({
		deviceId: identity.deviceId, state: new State(), ids: { next: randomUUID }, clock,
		workspaceLeases: new WorkspaceLeaseManager(),
		...(options.productionTiming ? { heartbeatTtlMs: LOCAL_BROKER_HEARTBEAT_TTL_MS } : {}),
	});
	const policies = new PeerPolicyService(peerStore, registry, { enabled: () => true });
	registry.setPeerRouteAuthorizer(policies);
	let broker!: DeviceBroker;
	const service = new BrokerTaskService(identity.deviceId, registry, new FileTaskStore(files, clock), clock, {
		onTaskSnapshot: (snapshot, sourceNodeId) => broker.publishTaskSnapshot(snapshot, sourceNodeId),
	});
	if (options.brokerEventDelayMs !== undefined) {
		const accept = service.acceptNodeEvent.bind(service);
		let delayed = false;
		service.acceptNodeEvent = async (...args) => {
			if (!delayed && args[1].event.type === 'output') {
				delayed = true;
				await new Promise((resolve) => setTimeout(resolve, options.brokerEventDelayMs));
			}
			return accept(...args);
		};
	}
	await service.initialize();
	broker = new DeviceBroker({
		identity, brokerKey, ownership, registry, peerPolicies: policies, taskService: service,
		taskRoutes: new TaskRouteCatalog(new State(), clock.now),
		requestTimeoutMs: options.productionTiming ? LOCAL_BROKER_REQUEST_TIMEOUT_MS : 5_000,
	});
	cleanups.push(() => broker.dispose());
	await broker.start();
	const errors: Error[] = [];
	const reportError = (error: Error) => { if (!stopping) { errors.push(error); } };
	const local = new Runtime();
	const remote = new Runtime();
	const nativeStore = new NativeChatStore({ rootDirectory: join(root, 'native-history') });
	await nativeStore.initialize();
	const nativeControls = new NativeChatControlRegistry();
	const remoteStarted = new Set<string>();
	cleanups.push(() => nativeStore.flush());
	const server = new RemoteExecutionServer({
		extensionVersion: '0.5.0', assertAllowed() {},
		readWorkspaces: (remoteAuthority) => describeCodespaceWorkspaces(remoteAuthority, [
			{ uri: targetUri, name: 'Codespace repository' },
		], new NodeFileIdentityResolver()),
		createExecutor: (context) => {
			const observation = new NativeChatExecution({
				generation: context.helperInstanceId, nodeId: context.nodeId, nodeInstanceId: context.nodeInstanceId,
				workspaceResolver: context.workspaceResolver, store: nativeStore, controls: nativeControls,
				reportError: (error) => reportError(error instanceof Error ? error : new Error('Native history failed.')),
			});
			const executor = new WindowNodeTaskExecutor({
				...context, executionBackend: 'codespace-owned', runtime: observation.runtime(remote),
				eventSink: observation.eventSink({
					publish: async (event) => {
						if (event.event.type === 'output' && options.outputDelayMs !== undefined) {
							await new Promise((resolve) => setTimeout(resolve, options.outputDelayMs));
						}
						await context.eventSink.publish(event);
					},
				}),
				observeInputAnswer: observation.observeInputAnswer,
				confirmationHost: { confirm: async () => 'once' }, ids: randomUUID, clock,
			});
			const observed = observation.attach(executor);
			return {
				executor: {
					...observed,
					start: async (params) => {
						const result = await observed.start(params);
						remoteStarted.add(params.taskId);
						return result;
					},
				},
				probe: () => remote.probe(),
			};
		},
		reportError,
	});
	cleanups.push(() => server.dispose());
	const sourceNodeId = randomUUID();
	const sourceInstanceId = randomUUID();
	const source = new WindowNodeClient({
		identity, brokerKey, nodeId: sourceNodeId, nodeInstanceId: sourceInstanceId,
		label: 'Desktop', capabilities: ['agentRuntime', 'tasks'],
		...(options.productionTiming ? { requestTimeoutMs: LOCAL_BROKER_REQUEST_TIMEOUT_MS } : {}),
		workspaceSource: () => [{ localUri: sourceUri, name: 'Desktop repository' }],
		executor: (context) => new WindowNodeTaskExecutor({
			...context, nodeId: sourceNodeId, nodeInstanceId: sourceInstanceId, nodeLabel: 'Desktop',
			runtime: local, confirmationHost: { confirm: async () => 'once' }, ids: randomUUID, clock,
		}),
	});
	cleanups.push(() => source.dispose());
	const targetNodeId = randomUUID();
	const targetInstanceId = randomUUID();
	let execution!: DesktopCodespaceExecution;
	let target!: WindowNodeClient;
	target = new WindowNodeClient({
		identity, brokerKey, nodeId: targetNodeId, nodeInstanceId: targetInstanceId,
		label: 'Codespace', capabilities: ['agentRuntime', 'tasks', 'codespace-owned'],
		...(options.productionTiming ? { requestTimeoutMs: LOCAL_BROKER_REQUEST_TIMEOUT_MS } : {}),
		workspaceSource: () => execution.listWorkspaces(),
		fileIdentityResolver: { resolve: (uri) => execution.resolveIdentity(uri) },
		executor: (context) => {
			const connection = new RemoteExecutionClient({
				...context,
				identity: {
					version: 1, clientId: randomUUID(), nodeId: targetNodeId, nodeInstanceId: targetInstanceId,
					nodeLabel: 'Codespace', authority, expectedFolders: [targetUri],
					token: randomBytes(32).toString('base64url'),
				},
				extensionVersion: '0.5.0',
				invoke: async (command, input) => {
					switch (command) {
						case 'copilotAgentMesh.codespaces.connect': return server.connect(input);
						case 'copilotAgentMesh.codespaces.call': return server.call(input);
						case 'copilotAgentMesh.codespaces.disconnect': return server.disconnect(input);
						default: throw new Error('Unknown bridge command.');
					}
				},
				onDisconnect: (error) => { reportError(error); target.invalidateExecutor(execution); },
			});
			execution = new DesktopCodespaceExecution(connection, reportError);
			return execution;
		},
	});
	cleanups.push(() => target.dispose());
	await execution.initialize();
	await source.start();
	await target.start();
	const sourceSelection = source.selectPeerPolicyWorkspace();
	const targetSelection = target.selectPeerPolicyWorkspace();
	assert.equal(sourceSelection.kind, 'selected');
	assert.equal(targetSelection.kind, 'selected');
	const sourceFacade = new LocalBrokerTaskFacade(source, {
		deviceName: 'Desktop device', sourceWorkspaceIdentity: () => source.delegationSourceScopeIdentity(),
	});
	const targetFacade = new LocalBrokerTaskFacade(target, {
		deviceName: 'Desktop device', sourceWorkspaceIdentity: () => target.delegationSourceScopeIdentity(),
	});
	cleanups.push(async () => { sourceFacade.dispose(); targetFacade.dispose(); });
	return {
		source, target, remote, local, errors, brokerStarts: 1, nativeStore, nativeControls, remoteStarted,
		sourceTools: new TaskToolsCore(sourceFacade), targetTools: new TaskToolsCore(targetFacade),
		authorizeBothDirections: async () => {
			await source.setPeerPolicy({
				workspaceIdentity: sourceSelection.workspaceIdentity,
				allowlist: [targetSelection.workspaceIdentity], acceptsIncoming: true,
			});
			await target.setPeerPolicy({
				workspaceIdentity: targetSelection.workspaceIdentity,
				allowlist: [sourceSelection.workspaceIdentity], acceptsIncoming: true,
			});
		},
	};
}

async function handleFor(tools: TaskToolsCore, nodeId: string): Promise<string> {
	const directory = directorySchema.parse(await tools.listWorkers({ scope: 'local' }));
	const node = directory.devices.flatMap((device) => device.nodes).find((candidate) => candidate.nodeId === nodeId);
	assert.ok(node);
	return node.workspaces[0].targetHandle;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) { throw new Error('Timed out waiting for the real collaboration route.'); }
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}
