import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
	ActionEnvelope,
	SessionConfigSchema,
	Snapshot,
} from '@microsoft/agent-host-protocol' with { 'resolution-mode': 'import' };

import {
	AhpAgentRuntime,
	type AhpConnection,
	type AhpConnectionFactory,
	type AhpSubscription,
	type AhpSubscriptionEvent,
} from '../agentHost/AhpAgentRuntime';
import { AhpEventMapper } from '../agentHost/AhpEventMapper';
import type {
	AgentHostLauncherLike,
	AgentHostProbe,
	LaunchedAgentHost,
} from '../agentHost/AgentHostLauncher';
import {
	AgentRuntimeError,
	AsyncEventQueue,
	type AgentRuntimeEvent,
	type AgentTaskRequest,
} from '../agentHost/AgentRuntime';
import {
	VscodeAuthBroker,
	type AuthenticationApi,
	type AuthenticationRequest,
	type AuthBroker,
} from '../agentHost/AuthBroker';

const workspaceUri = 'file:///tmp/copilot-agent-mesh-safe-workspace';
const protectedResource = {
	resource: 'https://agent.example.test',
	resource_name: 'Example Agent',
	authorization_servers: ['https://login.example.test'],
	scopes_supported: ['agent:run'],
};

test('production runtime initializes, authenticates, resolves config, runs a turn, answers input, and cancels', async () => {
	const transport = new FakeAhpTransport();
	const launcher = new FakeLauncher();
	const auth = new RecordingAuthBroker();
	let confirmed = false;
	let completedDynamicConfig = false;
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: new FakeConnectionFactory([transport]),
		authBroker: auth,
		confirmation: {
			confirm: async () => {
				confirmed = true;
				return 'once';
			},
		},
		configResolver: {
			resolve: async ({ completions }) => {
				const options = await completions('model', { target: 'workspace' });
				completedDynamicConfig = true;
				return { model: options[0]?.value };
			},
		},
		cancellationTimeoutMs: 100,
	});

	const handle = await runtime.start(taskRequest());
	assert.equal(confirmed, true);
	assert.equal(transport.initialized, true);
	assert.equal(auth.requests.length, 1);
	assert.deepEqual(transport.authenticated, [{
		resource: protectedResource.resource,
		token: 'test-token',
		scopes: ['agent:run'],
	}]);
	assert.equal(completedDynamicConfig, true);
	assert.equal(transport.created?.provider, 'dynamic-provider');
	assert.deepEqual(transport.created?.workingDirectories, [workspaceUri]);
	assert.equal(transport.dispatched[0]?.action.type, 'chat/turnStarted');
	assert.equal(
		((transport.dispatched[0]?.action as Record<string, unknown>).message as Record<string, unknown>).text,
		'Make a harmless change.\n\nAcceptance criteria:\n- Finish successfully',
	);

	await nextEvent(handle.events); // turn-start progress
	transport.emitChat({
		type: 'chat/delta',
		turnId: 'turn-1',
		partId: 'part-1',
		content: 'hello',
	});
	assert.deepEqual(await nextEvent(handle.events), { type: 'output', text: 'hello' });

	transport.emitChat({
		type: 'chat/inputRequested',
		request: {
			id: 'input-1',
			message: 'Choose a value',
			questions: [{ id: 'name', prompt: 'Name', kind: 'text', required: true }],
		},
	});
	const inputEvent = await nextEvent(handle.events);
	assert.equal(inputEvent.type, 'inputRequired');
	if (inputEvent.type === 'inputRequired') {
		await handle.answer({
			requestId: inputEvent.request.requestId,
			outcome: 'accept',
			values: { name: 'mesh' },
		});
	}
	assert.equal(transport.dispatched.at(-1)?.action.type, 'chat/inputCompleted');

	transport.emitChat({
		type: 'chat/toolCallReady',
		turnId: 'turn-1',
		toolCallId: 'tool-1',
		invocationMessage: 'Run harmless tool',
	});
	const approvalEvent = await nextEvent(handle.events);
	assert.equal(approvalEvent.type, 'inputRequired');
	if (approvalEvent.type === 'inputRequired') {
		await handle.answer({ requestId: approvalEvent.request.requestId, outcome: 'accept' });
	}
	assert.equal(transport.dispatched.at(-1)?.action.type, 'chat/toolCallConfirmed');

	await handle.cancel();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal((await nextEvent(handle.events)).type, 'cancelled');
	await handle.dispose();
	assert.equal(launcher.host.disposed, true);
});

test('runtime reconnects with the recovery descriptor and fails truthfully on host crash', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	recovered.reconnectResult = {
		type: 'replay',
		actions: [envelope('ahp-chat:/default', {
			type: 'chat/delta',
			turnId: 'turn-1',
			partId: 'part-1',
			content: 'replayed',
		}, 9)],
		missing: [],
	};
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.created = first.created;

	first.failChat();
	assert.deepEqual(await nextEvent(handle.events), { type: 'progress', message: 'Reconnecting to Agent Host.' });
	assert.deepEqual(await nextEvent(handle.events), { type: 'output', text: 'replayed' });
	assert.deepEqual(await nextEvent(handle.events), { type: 'progress', message: 'Agent Host connection recovered.' });
	assert.equal(handle.recovery.lastSeenServerSeq, 9);

	launcher.host.crash();
	const failed = await nextEvent(handle.events);
	assert.equal(failed.type, 'failed');
	if (failed.type === 'failed') {
		assert.equal(failed.error.code, 'TASK_RECOVERY_UNAVAILABLE');
	}
	await handle.dispose();
});

test('runtime iterates dependent session config and restores completion from a reconnect snapshot', async () => {
	const first = new FakeAhpTransport();
	first.iterativeConfig = true;
	const recovered = new FakeAhpTransport();
	const launcher = new FakeLauncher();
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: new FakeConnectionFactory([first, recovered]),
		authBroker: new RecordingAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		configResolver: {
			resolve: async ({ schema, values }) => ({
				...values,
				...(schema.required?.includes('target') ? { target: 'workspace' } : {}),
				...(schema.required?.includes('model') ? { model: 'test-model' } : {}),
			}),
		},
	});
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	assert.deepEqual(first.created?.config, { target: 'workspace', model: 'test-model' });
	assert.equal(first.resolveConfigCalls, 3);

	const turnId = first.dispatched[0]?.action.turnId;
	assert.equal(typeof turnId, 'string');
	recovered.created = first.created;
	recovered.reconnectResult = {
		type: 'snapshot',
		snapshots: [{
			resource: 'ahp-chat:/default',
			fromSeq: 20,
			state: {
				resource: 'ahp-chat:/default',
				title: 'Recovered',
				status: 1,
				modifiedAt: new Date(0).toISOString(),
				activeTurn: undefined,
				turns: [{
					id: turnId,
					message: { text: 'safe', origin: { kind: 'user' } },
					responseParts: [],
					usage: undefined,
					state: 'complete',
				}],
			},
		} as Snapshot],
	};
	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal((await nextEvent(handle.events)).type, 'completed');
	await handle.dispose();
});

test('VS Code auth broker is silent-first, requires explicit interaction, and only succeeds after AHP accepts', async () => {
	const calls: unknown[] = [];
	const authentication: AuthenticationApi = {
		getSession: async (_providerId, _scopes, options) => {
			calls.push(options ?? {});
			return options?.silent === true
				? undefined
				: {
					id: 'session',
					accessToken: 'secret-token',
					account: { id: 'account', label: 'Account' },
					scopes: ['agent:run'],
				};
		},
	};
	const broker = new VscodeAuthBroker(authentication, () => ({
		providerId: 'configured-provider',
		scopes: ['agent:run'],
	}));

	await assert.rejects(
		broker.authenticate(
			{ resources: [protectedResource], interactive: false, reason: 'initial' },
			async () => undefined,
		),
		(error: unknown) => error instanceof AgentRuntimeError && error.code === 'AGENT_AUTH_REQUIRED',
	);
	assert.deepEqual(calls, [{ silent: true }]);

	let pushedToken = '';
	await broker.authenticate(
		{ resources: [protectedResource], interactive: true, reason: 'challenge' },
		async (_resource, token) => {
			pushedToken = token;
		},
	);
	assert.equal(pushedToken, 'secret-token');
	assert.equal(calls.length, 2);
	assert.ok(typeof calls[1] === 'object' && calls[1] !== null && 'forceNewSession' in calls[1]);

	await assert.rejects(
		broker.authenticate(
			{ resources: [protectedResource], interactive: true, reason: 'tokenInvalid' },
			async () => {
				throw new Error('rejected token secret-token');
			},
		),
		(error: unknown) => error instanceof AgentRuntimeError
			&& error.code === 'AGENT_AUTH_FAILED'
			&& !error.message.includes('secret-token'),
	);
});

test('event mapper reports authoritative turn completion and bounded terminal summaries', () => {
	const mapper = new AhpEventMapper();
	assert.deepEqual(mapper.map(envelope('ahp-chat:/default', {
		type: 'chat/turnComplete',
		turnId: 'turn-1',
		duration: 1,
	}, 10)), [{ type: 'completed' }]);
	assert.deepEqual(mapper.map(envelope('ahp-terminal:/one', {
		type: 'terminal/data',
		data: '\u001B[31mhello\u001B[0m',
	}, 11)), [{ type: 'terminal', summary: 'hello' }]);
});

test('event mapper routes MCP authentication through a protected-resource challenge', () => {
	const mapper = new AhpEventMapper();
	const [event] = mapper.map(envelope('ahp-chat:/default', {
		type: 'chat/toolCallAuthRequired',
		turnId: 'turn-1',
		toolCallId: 'tool-1',
		auth: {
			reason: 'required',
			resource: protectedResource,
			requiredScopes: ['agent:run'],
		},
	}, 12));
	assert.equal(event?.type, 'inputRequired');
	if (event?.type !== 'inputRequired') {
		return;
	}
	const answer = mapper.createAnswer({ requestId: event.request.requestId, outcome: 'accept' });
	assert.deepEqual(answer, {
		authentication: {
			...protectedResource,
			required: true,
		},
		requestId: event.request.requestId,
	});
	assert.deepEqual(
		mapper.createAnswer({ requestId: event.request.requestId, outcome: 'accept' }),
		answer,
	);
	mapper.completeAuthentication(event.request.requestId);
	assert.throws(
		() => mapper.createAnswer({ requestId: event.request.requestId, outcome: 'accept' }),
		(error: unknown) => error instanceof AgentRuntimeError,
	);
});

test('event mapper enforces integer and freeform select input constraints', () => {
		const mapper = new AhpEventMapper();
		const [event] = mapper.map(envelope('ahp-chat:/default', {
			type: 'chat/inputRequested',
			request: {
				id: 'structured',
				questions: [
					{ id: 'count', message: 'Count', kind: 'integer', required: true, min: 1, max: 2 },
					{
						id: 'choice',
						message: 'Choice',
						kind: 'single-select',
						required: true,
						options: [{ id: 'known', label: 'Known' }],
						allowFreeformInput: true,
					},
				],
			},
		}, 13));
		assert.equal(event?.type, 'inputRequired');
		if (event?.type !== 'inputRequired') {
			return;
		}
		assert.equal(event.request.fields?.[0]?.prompt, 'Count');
		assert.equal(event.request.fields?.[1]?.prompt, 'Choice');
		assert.throws(
			() => mapper.createAnswer({
				requestId: event.request.requestId,
				outcome: 'accept',
				values: { count: 1.5, choice: 'known' },
			}),
			(error: unknown) => error instanceof AgentRuntimeError,
		);

		const retryMapper = new AhpEventMapper();
		const [retryEvent] = retryMapper.map(envelope('ahp-chat:/default', {
			type: 'chat/inputRequested',
			request: {
				id: 'structured',
				questions: [
					{ id: 'count', message: 'Count', kind: 'integer', required: true, min: 1, max: 2 },
					{
						id: 'choice',
						message: 'Choice',
						kind: 'single-select',
						required: true,
						options: [{ id: 'known', label: 'Known' }],
						allowFreeformInput: true,
					},
				],
			},
		}, 14));
		assert.equal(retryEvent?.type, 'inputRequired');
		if (retryEvent?.type === 'inputRequired') {
			const dispatch = retryMapper.createAnswer({
				requestId: retryEvent.request.requestId,
				outcome: 'accept',
				values: {
					count: 2,
					choice: { freeformValues: ['custom'] },
				},
			});
			assert.ok('action' in dispatch);
		}
});

function createRuntime(launcher: FakeLauncher, connections: AhpConnectionFactory): AhpAgentRuntime {
	return new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections,
		authBroker: new RecordingAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		configResolver: { resolve: async () => ({ model: 'test-model' }) },
		cancellationTimeoutMs: 100,
	});
}

function taskRequest(): AgentTaskRequest {
	return {
		taskId: 'task-1',
		title: 'Harmless task',
		prompt: 'Make a harmless change.',
		acceptanceCriteria: ['Finish successfully'],
		workspace: {
			workspaceId: 'workspace-1',
			displayName: 'Safe Workspace',
			uri: workspaceUri,
			registered: true,
		},
	};
}

class RecordingAuthBroker implements AuthBroker {
	readonly requests: AuthenticationRequest[] = [];

	async authenticate(
		request: AuthenticationRequest,
		pushToken: (resource: string, token: string, scopes: readonly string[]) => Promise<void>,
	): Promise<void> {
		this.requests.push(request);
		for (const resource of request.resources.filter(({ required }) => required !== false)) {
			await pushToken(resource.resource, 'test-token', resource.scopes_supported ?? []);
		}
	}
}

class FakeLauncher implements AgentHostLauncherLike {
	readonly host = new FakeHost();

	async probe(): Promise<AgentHostProbe> {
		return { available: true, executable: '/safe/code', version: '1.134.0' };
	}

	async launch(): Promise<LaunchedAgentHost> {
		return this.host;
	}

	async dispose(): Promise<void> {
		await this.host.dispose();
	}
}

class FakeHost implements LaunchedAgentHost {
	readonly endpoint = new URL('ws://127.0.0.1:1234/?tkn=not-a-real-token');
	readonly version = '1.134.0';
	readonly registryProtocolVersion = '0.1.0';
	disposed = false;
	private listeners = new Set<(error: AgentRuntimeError) => void>();

	onExit(listener: (error: AgentRuntimeError) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	crash(): void {
		for (const listener of this.listeners) {
			listener(new AgentRuntimeError('TASK_RECOVERY_UNAVAILABLE', 'Owned host crashed.'));
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

class FakeConnectionFactory implements AhpConnectionFactory {
	constructor(private readonly transports: FakeAhpTransport[]) {}

	async connect(): Promise<AhpConnection> {
		const transport = this.transports.shift();
		assert.ok(transport, 'Expected another fake AHP transport.');
		return transport;
	}
}

class FakeAhpTransport implements AhpConnection {
	initialized = false;
	authenticated: Array<{ resource: string; token: string; scopes: readonly string[] }> = [];
	created: {
		sessionUri: string;
		provider: string;
		workingDirectories: readonly string[];
		config: Readonly<Record<string, unknown>>;
		clientId: string;
	} | undefined;
	dispatched: Array<{ channel: string; action: Record<string, unknown> }> = [];
	reconnectResult: Awaited<ReturnType<AhpConnection['reconnect']>> = {
		type: 'snapshot',
		snapshots: [],
	};
	iterativeConfig = false;
	resolveConfigCalls = 0;
	private readonly queues = new Map<string, FakeSubscription>();

	async initialize(): Promise<Awaited<ReturnType<AhpConnection['initialize']>>> {
		this.initialized = true;
		return {
			protocolVersion: '0.8.0',
			serverSeq: 1,
			snapshots: [{
				resource: 'ahp-root://',
				fromSeq: 1,
				state: {
					agents: [{
						provider: 'dynamic-provider',
						displayName: 'Dynamic Provider',
						description: 'Test provider',
						models: [],
						protectedResources: [protectedResource],
					}],
					terminals: [],
				},
			} as Snapshot],
		};
	}

	async reconnect(): Promise<Awaited<ReturnType<AhpConnection['reconnect']>>> {
		return this.reconnectResult;
	}

	attachSubscription(uri: string): AhpSubscription {
		return this.queue(uri);
	}

	async subscribe(uri: string): Promise<{ readonly snapshot?: Snapshot; readonly subscription: AhpSubscription }> {
		if (uri.startsWith('ahp-session:')) {
			return {
				snapshot: {
					resource: uri,
					fromSeq: 2,
					state: {
						resource: uri,
						provider: 'dynamic-provider',
						title: 'Task',
						status: 1,
						lifecycle: 'ready',
						activeClients: [],
						chats: [],
						defaultChat: 'ahp-chat:/default',
					},
				} as Snapshot,
				subscription: this.queue(uri),
			};
		}
		return {
			snapshot: {
				resource: uri,
				fromSeq: 3,
				state: {
					resource: uri,
					title: 'Chat',
					status: 1,
					modifiedAt: new Date(0).toISOString(),
					turns: [],
				},
			} as Snapshot,
			subscription: this.queue(uri),
		};
	}

	async authenticate(resource: string, token: string, scopes: readonly string[]): Promise<void> {
		this.authenticated.push({ resource, token, scopes });
	}

	async resolveSessionConfig(
		_provider: string,
		_workingDirectory: string,
		config: Readonly<Record<string, unknown>>,
	): Promise<{ readonly schema: SessionConfigSchema; readonly values: Record<string, unknown> }> {
		this.resolveConfigCalls += 1;
		if (this.iterativeConfig) {
			const required = config.target === undefined
				? ['target']
				: config.model === undefined
					? ['model']
					: [];
			return {
				schema: {
					type: 'object',
					properties: {
						target: { type: 'string', title: 'Target' },
						model: { type: 'string', title: 'Model' },
					},
					required,
				},
				values: { ...config },
			};
		}
		return {
			schema: {
				type: 'object',
				properties: {
					model: {
						type: 'string',
						title: 'Model',
						enumDynamic: true,
					},
				},
				required: ['model'],
			},
			values: { ...config },
		};
	}

	async sessionConfigCompletions(): Promise<readonly { readonly value: string; readonly label: string }[]> {
		return [{ value: 'test-model', label: 'Test Model' }];
	}

	async createSession(params: NonNullable<FakeAhpTransport['created']>): Promise<void> {
		this.created = params;
	}

	async listSessions(): Promise<readonly { readonly resource: string }[]> {
		return this.created === undefined ? [] : [{ resource: this.created.sessionUri }];
	}

	dispatch(channel: string, action: unknown): void {
		assert.equal(typeof action, 'object');
		assert.ok(action);
		const record = action as Record<string, unknown>;
		this.dispatched.push({ channel, action: record });
		if (record.type === 'chat/turnCancelled') {
			this.emit(channel, record);
		}
	}

	async unsubscribe(uri: string): Promise<void> {
		this.queue(uri).finish();
	}

	async disposeSession(): Promise<void> {}

	async shutdown(): Promise<void> {
		for (const queue of this.queues.values()) {
			queue.finish();
		}
	}

	emitChat(action: Record<string, unknown>): void {
		this.emit('ahp-chat:/default', action);
	}

	failChat(): void {
		this.queue('ahp-chat:/default').fail(new Error('transport closed'));
	}

	private emit(channel: string, action: Record<string, unknown>): void {
		this.queue(channel).push({
			type: 'action',
			params: envelope(channel, action, 4),
		});
	}

	private queue(uri: string): FakeSubscription {
		let queue = this.queues.get(uri);
		if (queue === undefined) {
			queue = new FakeSubscription();
			this.queues.set(uri, queue);
		}
		return queue;
	}
}

class FakeSubscription implements AhpSubscription {
	private readonly queue = new AsyncEventQueue<AhpSubscriptionEvent>();
	private failure: Error | undefined;

	push(event: AhpSubscriptionEvent): void {
		this.queue.push(event);
	}

	fail(error: Error): void {
		this.failure = error;
		this.queue.close();
	}

	finish(): void {
		this.queue.close();
	}

	async close(): Promise<void> {
		this.finish();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AhpSubscriptionEvent> {
		for await (const event of this.queue) {
			yield event;
		}
		if (this.failure !== undefined) {
			throw this.failure;
		}
	}
}

function envelope(channel: string, action: Record<string, unknown>, serverSeq: number): ActionEnvelope {
	return {
		channel,
		action,
		serverSeq,
		origin: undefined,
	} as unknown as ActionEnvelope;
}

async function nextEvent(events: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent> {
	const iterator = events[Symbol.asyncIterator]();
	const result = await Promise.race([
		iterator.next(),
		new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Timed out waiting for event.')), 1_000)),
	]);
	assert.equal(result.done, false);
	return result.value;
}
