import * as assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type {
	ActionEnvelope,
	SessionConfigSchema,
	Snapshot,
} from '@microsoft/agent-host-protocol' with { 'resolution-mode': 'import' };

import {
	AhpAgentRuntime,
	AHP_EDITOR_0_9_PROTOCOL_OFFER,
	AHP_PROTOCOL_OFFER,
	ahpProtocolPolicyForHost,
	assertOutboundAhpActionSupported,
	buildMeshSessionTitle,
	DELEGATED_AGENT_CLIENT_TOOLS,
	listSessionsBounded,
	type AhpConnection,
	type AhpConnectionFactory,
	type AhpProtocolPolicy,
	type AhpSubscription,
	type AhpSubscriptionEvent,
} from '../agentHost/AhpAgentRuntime';
import { AhpEventMapper } from '../agentHost/AhpEventMapper';
import {
	AgentHostLauncher,
	OwnedAgentHost,
	type AgentHostLauncherLike,
	type AgentHostProbe,
	type LaunchedAgentHost,
} from '../agentHost/AgentHostLauncher';
import {
	AgentHostSourceSelector,
} from '../agentHost/AgentHostSourceSelector';
import {
	AgentRuntimeApprovalCapabilityIssuer,
	AgentRuntimeError,
	AgentRuntimeLifecycle,
	AsyncEventQueue,
	AsyncEventQueueCapacityError,
	createAgentRuntimeEventQueue,
	type AgentRuntimeEvent,
	type AgentRuntimeErrorCode,
	type AgentRuntimeLifecycleObserver,
	type AgentRuntimeLifecycleObservation,
	type AgentTaskRequest,
	type FirstTaskConfirmation,
} from '../agentHost/AgentRuntime';
import { VscodeLocalTaskApproval } from '../composition/VscodeAgentRuntime';
import type { StateStore } from '../domain/ports';
import { DelegatedToolInvocationRegistry } from '../tools/DelegatedToolInvocationRegistry';
import { MESH_TOOL_NAMES } from '../tools/toolManifest';
import {
	EditorExistingIdentityAuthBroker,
	VscodeAuthBroker,
	type AuthenticationApi,
	type AuthenticationRequest,
	type AuthBroker,
	type ProtectedResource,
} from '../agentHost/AuthBroker';
import { OwnedCommandError } from '../spikes/ownedProcess';

const workspaceUri = 'file:///tmp/copilot-agent-mesh-safe-workspace';
const protectedResource = {
	resource: 'https://agent.example.test',
	resource_name: 'Example Agent',
	authorization_servers: ['https://login.example.test'],
	scopes_supported: ['agent:run'],
};
const initializationOnlyResource = {
	resource: 'https://initialization.example.test',
	resource_name: 'Initialization Agent',
	scopes_supported: ['agent:initialize'],
};

test('pinned SDK iterator return does not wake an already parked next', async () => {
	const { AsyncBroadcastQueue } = await import(
		'../../third_party/agent-host-protocol/clients/typescript/src/client/async-queue.js'
	);
	const queue = new AsyncBroadcastQueue<number>();
	const reader = queue.reader();
	let settled = false;
	void reader.next().then(() => {
		settled = true;
	});

	await reader.return!();
	queue.close();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
});

test('agent event queue stays within count and byte bounds and preserves terminal events under output pressure', async () => {
	const queue = createAgentRuntimeEventQueue({ maxItems: 8, maxBytes: 512 });
	for (let index = 0; index < 20_000; index += 1) {
		await queue.push({ type: 'output', text: `${index}:${'界'.repeat(80)}` });
		assert.ok(queue.bufferedItems <= 8);
		assert.ok(queue.bufferedBytes <= 512);
	}

	const terminalEvents: readonly AgentRuntimeEvent[] = [
		{ type: 'terminal', summary: 'command finished' },
		{ type: 'completed' },
		{ type: 'cancelled' },
		{ type: 'failed', error: new AgentRuntimeError('TASK_EXECUTION_FAILED', 'failed safely') },
	];
	for (const event of terminalEvents) {
		await queue.push(event);
		assert.ok(queue.bufferedItems <= 8);
		assert.ok(queue.bufferedBytes <= 512);
	}
	queue.close();

	const retained: AgentRuntimeEvent[] = [];
	for await (const event of queue) {
		retained.push(event);
	}
	assert.equal(retained.filter(({ type }) => type === 'outputTruncated').length, 1);
	for (const event of terminalEvents) {
		assert.ok(retained.some(({ type }) => type === event.type), `${event.type} must be retained`);
	}

	const oversizedFailure = createAgentRuntimeEventQueue({ maxItems: 1, maxBytes: 256 });
	await oversizedFailure.push({
		type: 'failed',
		error: new AgentRuntimeError('TASK_EXECUTION_FAILED', 'bounded failure '.repeat(2_000)),
	});
	assert.equal(oversizedFailure.bufferedItems, 1);
	assert.ok(oversizedFailure.bufferedBytes <= 256);
	oversizedFailure.close();
	assert.equal((await oversizedFailure[Symbol.asyncIterator]().next()).value?.type, 'failed');
});

test('agent event queue coalesces progress and backpressures nondroppable producers in FIFO order', async () => {
	const progress = createAgentRuntimeEventQueue({ maxItems: 4, maxBytes: 256 });
	for (let index = 0; index < 1_000; index += 1) {
		await progress.push({ type: 'progress', message: `step ${index}` });
	}
	assert.equal(progress.bufferedItems, 1);
	assert.deepEqual(await progress[Symbol.asyncIterator]().next(), {
		done: false,
		value: { type: 'progress', message: 'step 999' },
	});
	progress.close();

	const queue = new AsyncEventQueue<string>({
		maxItems: 2,
		maxBytes: 16,
		sizeOf: (value) => Buffer.byteLength(value),
	});
	await queue.push('first');
	await queue.push('second');
	let thirdSettled = false;
	const third = queue.push('third').then((result) => {
		thirdSettled = true;
		return result;
	});
	await Promise.resolve();
	assert.equal(thirdSettled, false);

	const iterator = queue[Symbol.asyncIterator]();
	assert.deepEqual(await iterator.next(), { done: false, value: 'first' });
	assert.equal(await third, true);
	assert.ok(queue.bufferedItems <= 2);
	assert.ok(queue.bufferedBytes <= 16);
	queue.close();
	assert.deepEqual(await iterator.next(), { done: false, value: 'second' });
	assert.deepEqual(await iterator.next(), { done: false, value: 'third' });
	assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test('agent event queue enforces byte limits with a waiting consumer', async () => {
	const queue = new AsyncEventQueue<string>({
		maxItems: 2,
		maxBytes: 4,
		sizeOf: (value) => Buffer.byteLength(value, 'utf8'),
	});
	const next = queue[Symbol.asyncIterator]().next();

	await assert.rejects(queue.push('oversized'), AsyncEventQueueCapacityError);
	assert.equal(queue.bufferedItems, 0);
	queue.close();
	assert.equal((await next).done, true);
});

test('agent event queue bounds pending producers and seals atomically on terminal admission', async () => {
	const queue = new AsyncEventQueue<string>({
		maxItems: 1,
		maxBytes: 16,
		sizeOf: (value) => Buffer.byteLength(value, 'utf8'),
	});
	await queue.push('first');
	const blocked = queue.push('second');

	await assert.rejects(queue.push('third'), AsyncEventQueueCapacityError);
	const terminal = queue.pushAndClose('terminal');
	assert.equal(await queue.push('late'), false);
	assert.equal(await blocked, false);

	const iterator = queue[Symbol.asyncIterator]();
	assert.deepEqual(await iterator.next(), { done: false, value: 'first' });
	assert.equal(await terminal, true);
	assert.deepEqual(await iterator.next(), { done: false, value: 'terminal' });
	assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test('runtime lifecycle awaits detached asynchronous cleanup and shares the same disposal', async () => {
	const lifecycle = new AgentRuntimeLifecycle();
	let releaseCleanup: (() => void) | undefined;
	let cleanupFinished = false;
	const cleanupGate = new Promise<void>((resolve) => {
		releaseCleanup = resolve;
	});
	lifecycle.track({
		probe: async () => ({ available: false, featureEnabled: false }),
		start: async () => { throw new Error('not used'); },
		dispose: async () => {
			await cleanupGate;
			cleanupFinished = true;
		},
	});

	const first = lifecycle.dispose();
	const second = lifecycle.dispose();
	assert.equal(first, second);
	assert.equal(cleanupFinished, false);
	releaseCleanup?.();
	await first;
	assert.equal(cleanupFinished, true);
});

test('runtime lifecycle restores failed cleanup ownership and retries disposal', async () => {
	const lifecycle = new AgentRuntimeLifecycle();
	let attempts = 0;
	lifecycle.track({
		probe: async () => ({ available: false, featureEnabled: false }),
		start: async () => { throw new Error('not used'); },
		dispose: async () => {
			attempts += 1;
			if (attempts === 1) {
				throw new Error('synthetic cleanup failure');
			}
		},
	});

	const failed = lifecycle.dispose();
	await assert.rejects(failed, /synthetic cleanup failure/u);
	const retry = lifecycle.dispose();
	assert.notEqual(retry, failed);
	await retry;
	assert.equal(attempts, 2);
	assert.equal(lifecycle.dispose(), retry);
});

test('owned Agent Host retains cleanup ownership after termination failure and retries safely', async () => {
	let terminationAttempts = 0;
	let removeCalls = 0;
	let released = 0;
	const host = new OwnedAgentHost(
		new ChildProcess(),
		12345,
		'/tmp/owned-agent-host-test',
		new URL('ws://127.0.0.1:1234/?tkn=secret'),
		'1.134.0',
		'0.1.0',
		'secret',
		{
			terminate: async () => {
				terminationAttempts += 1;
				if (terminationAttempts === 1) {
					throw new Error('termination secret failed');
				}
			},
			remove: async () => {
				removeCalls += 1;
			},
		},
		() => released += 1,
	);

	await assert.rejects(
		host.dispose(),
		(error: unknown) => error instanceof AgentRuntimeError
			&& !error.message.includes('secret')
			&& error.message.includes('remains tracked for retry'),
	);
	assert.equal(removeCalls, 0);
	assert.equal(released, 0);

	await host.dispose();
	assert.equal(terminationAttempts, 2);
	assert.equal(removeCalls, 1);
	assert.equal(released, 1);
});

test('owned Agent Host never signals a reused process group after termination already succeeded', async () => {
	let terminateCalls = 0;
	let removeCalls = 0;
	const host = new OwnedAgentHost(
		new ChildProcess(),
		12346,
		'/tmp/owned-agent-host-remove-test',
		new URL('ws://127.0.0.1:1234/?tkn=secret'),
		'1.134.0',
		'0.1.0',
		'secret',
		{
			terminate: async () => {
				terminateCalls += 1;
			},
			remove: async () => {
				removeCalls += 1;
				if (removeCalls === 1) {
					throw new Error('remove failed');
				}
			},
		},
		() => undefined,
	);

	await assert.rejects(host.dispose(), AgentRuntimeError);
	await host.dispose();
	assert.equal(terminateCalls, 1);
	assert.equal(removeCalls, 2);
});

test('launcher aborts and awaits an in-flight host launch during disposal', {
	skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async () => {
	const root = await mkdtemp(join(tmpdir(), 'agent-host-launcher-test-'));
	const executable = join(root, 'fake-code');
	const marker = join(root, 'host-pid');
	await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('1.134.0\\ncommit\\narch\\n');
} else if (args[0] === 'agent' && args[1] === 'endpoints') {
  const userData = args[args.indexOf('--user-data-dir') + 1];
  process.stdout.write(JSON.stringify({ userDataPath: userData, endpoints: [] }));
} else if (args[0] === 'agent' && args[1] === 'host') {
  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  process.exitCode = 1;
}
`);
	await chmod(executable, 0o700);
	const launcher = new AgentHostLauncher({
		storageRoot: join(root, 'storage'),
		configuredCodeCli: executable,
		startupTimeoutMs: 30_000,
	});
	try {
		const launch = launcher.launch();
		await waitForCondition(async () => {
			try {
				await readFile(marker, 'utf8');
				return true;
			} catch {
				return false;
			}
		});
		await launcher.dispose();
		await assert.rejects(launch, AgentRuntimeError);
		const pid = Number(await readFile(marker, 'utf8'));
		assert.equal(processExists(pid), false);
	} finally {
		await launcher.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test('launcher handles a host executable disappearing before spawn without an uncaught child error', {
	skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async () => {
	const root = await mkdtemp(join(tmpdir(), 'agent-host-spawn-error-test-'));
	const executable = join(root, 'fake-code');
	await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('1.134.0\\ncommit\\narch\\n');
} else if (args[0] === 'agent' && args[1] === 'endpoints') {
  const userData = args[args.indexOf('--user-data-dir') + 1];
  fs.unlinkSync(process.argv[1]);
  process.stdout.write(JSON.stringify({ userDataPath: userData, endpoints: [] }));
}
`);
	await chmod(executable, 0o700);
	const launcher = new AgentHostLauncher({
		storageRoot: join(root, 'storage'),
		configuredCodeCli: executable,
	});
	try {
		await assert.rejects(
			launcher.launch(),
			(error: unknown) => error instanceof AgentRuntimeError && error.code === 'AGENT_UNAVAILABLE',
		);
	} finally {
		await launcher.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test('launcher retains auxiliary command cleanup ownership after discovery cleanup fails', async () => {
	let terminationAttempts = 0;
	const launcher = new AgentHostLauncher({
		storageRoot: join('not-used', 'storage'),
		configuredCodeCli: join('fake', 'code'),
	}, {
		assertProcessControlSupported: () => undefined,
		runCommand: async () => {
			throw new OwnedCommandError('synthetic command cleanup failure', 424242, true);
		},
		terminate: async (processGroupId) => {
			assert.equal(processGroupId, 424242);
			terminationAttempts += 1;
			if (terminationAttempts === 1) {
				throw new Error('synthetic retained cleanup failure');
			}
		},
	});

	assert.deepEqual(await launcher.probe(), { available: false });
	await assert.rejects(launcher.dispose(), AgentRuntimeError);
	await launcher.dispose();
	assert.equal(terminationAttempts, 2);
});

test('production runtime initializes, authenticates, resolves config, runs a turn, answers input, and cancels', async () => {
	const transport = new FakeAhpTransport();
	const launcher = new FakeLauncher();
	const auth = new RecordingAuthBroker();
	const lifecycle: AgentRuntimeLifecycleObservation[] = [];
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
		workspaceResolver: trustedWorkspaceResolver(),
		configResolver: {
			resolve: async ({ completions }) => {
				const options = await completions('model', { target: 'workspace' }, 'test');
				completedDynamicConfig = true;
				return { model: options[0]?.value };
			},
		},
		cancellationTimeoutMs: 100,
		lifecycleObserver: {
			observeLifecycle: (observation) => lifecycle.push(observation),
		},
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
	assert.deepEqual(transport.completionQueries, ['test']);
	assert.equal(transport.created?.provider, 'dynamic-provider');
	assert.deepEqual(transport.created?.workingDirectories, [workspaceUri]);
	assert.deepEqual(lifecycle, [
		{
			taskId: 'task-1',
			eventType: 'session/materialized',
		},
		{
			taskId: 'task-1',
			eventType: 'session/hostObserved',
			sessionUri: handle.recovery.sessionUri,
			source: 'standalone',
			protocolOffer: ['1.0.0'],
			selectedProtocolVersion: '1.0.0',
		},
	]);
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
	assert.equal(lifecycle.at(-1)?.eventType, 'chat/turnCancelled');
	await handle.dispose();
	assert.equal(launcher.host.disposed, true);
});

	test('delegated runtime preserves history when the Host catalog appears only after disconnect', async () => {
		const catalog = new FakeAhpHostCatalog();
		const transport = new FakeAhpTransport(catalog);
		transport.completeAfterTurnDispatch = true;
		transport.hideCatalog = true;
		const launcher = new FakeLauncher();
		launcher.host.preserveTerminalSession = true;
		const lifecycle: AgentRuntimeLifecycleObservation[] = [];
		const runtime = createRuntime(
			launcher,
			new FakeConnectionFactory([transport]),
			undefined,
			undefined,
			{ observeLifecycle: (observation) => lifecycle.push(observation) },
		);

		const handle = await runtime.start({
			...taskRequest(),
			sourceWindowName: 'frontend',
			title: 'Implement bounded API',
		});
		const events = [];
		for await (const event of handle.events) {
			events.push(event);
		}
		assert.equal(events.at(-1)?.type, 'completed');
		assert.deepEqual(transport.dispatched.slice(0, 2).map(({ channel, action }) => ({
			channel,
			action,
		})), [
			{
				channel: transport.created?.sessionUri,
				action: {
					type: 'session/titleChanged',
					title: 'Mesh · frontend → Implement bounded API',
				},
			},
			{
				channel: 'ahp-chat:/default',
				action: transport.dispatched[1]?.action,
			},
		]);

		await handle.dispose();
		assert.equal(transport.disposeSessionCalls, 0);
		assert.equal(transport.shutdownCalls, 1);
		assert.equal(lifecycle.at(-1)?.eventType, 'session/clientDetached');
		assert.equal(transport.listSessionsCalls, 0);
		const sessionUri = transport.created!.sessionUri;
		assert.deepEqual(catalog.session(sessionUri), {
			status: 1,
			activeClientCount: 0,
			materialized: true,
		});

		const reconnected = new FakeAhpTransport(catalog);
		await reconnected.initialize('history-reader');
		assert.deepEqual(await reconnected.listSessions(), {
			items: [{ resource: sessionUri, status: 1 }],
		});
		await reconnected.shutdown();
	});

	test('bounded Session catalog listing follows cursors beyond the first page', async () => {
		const catalog = new FakeAhpHostCatalog();
		catalog.addMaterialized('ahp-session:/older-1');
		catalog.addMaterialized('ahp-session:/older-2');
		catalog.addMaterialized('ahp-session:/older-3');
		const transport = new FakeAhpTransport(catalog);
		transport.catalogPageSize = 2;
		await transport.initialize('catalog-reader');

		assert.deepEqual(await listSessionsBounded(transport), [
			{ resource: 'ahp-session:/older-1', status: 1 },
			{ resource: 'ahp-session:/older-2', status: 1 },
			{ resource: 'ahp-session:/older-3', status: 1 },
		]);
		assert.equal(transport.listSessionsCalls, 2);
	});

	test('bounded Session catalog listing omits optional limit after Host internal error', async () => {
		const catalog = new FakeAhpHostCatalog();
		catalog.addMaterialized('ahp-session:/retained');
		const transport = new FakeAhpTransport(catalog);
		transport.rejectCatalogLimit = true;
		await transport.initialize('catalog-reader');

		assert.deepEqual(await listSessionsBounded(transport), [
			{ resource: 'ahp-session:/retained', status: 1 },
		]);
		assert.equal(transport.listSessionsCalls, 2);
	});

	test('bounded Session catalog listing rejects an oversized Host-selected page', async () => {
		const catalog = new FakeAhpHostCatalog();
		for (let index = 0; index <= 10_000; index += 1) {
			catalog.addMaterialized(`ahp-session:/oversized-${index}`);
		}
		const transport = new FakeAhpTransport(catalog);
		transport.rejectCatalogLimit = true;
		transport.catalogPageSize = 10_001;
		transport.catalogDefaultPageSize = 10_001;
		await transport.initialize('catalog-reader');

		await assert.rejects(listSessionsBounded(transport), /bounded entry limit/);
		assert.equal(transport.listSessionsCalls, 2);
	});

	test('bounded Session catalog listing rejects cyclic cursors', async () => {
		const catalog = new FakeAhpHostCatalog();
		catalog.addMaterialized('ahp-session:/older-1');
		catalog.addMaterialized('ahp-session:/older-2');
		const transport = new FakeAhpTransport(catalog);
		transport.catalogPageSize = 1;
		transport.catalogCursorCycle = true;
		await transport.initialize('catalog-reader');

		await assert.rejects(listSessionsBounded(transport), /invalid Session catalog cursor/);
		assert.equal(transport.listSessionsCalls, 2);
	});

	test('bounded Session catalog listing caps page requests', async () => {
		const catalog = new FakeAhpHostCatalog();
		for (let index = 0; index < 101; index += 1) {
			catalog.addMaterialized(`ahp-session:/older-${index}`);
		}
		const transport = new FakeAhpTransport(catalog);
		transport.catalogPageSize = 2;
		await transport.initialize('catalog-reader');

		await assert.rejects(listSessionsBounded(transport), /bounded pagination limit/);
		assert.equal(transport.listSessionsCalls, 50);
	});

	test('disposing during terminal Session detach aborts promptly without publishing a terminal', async () => {
		const catalog = new FakeAhpHostCatalog();
		const transport = new FakeAhpTransport(catalog);
		transport.blockNextSessionUnsubscribe = true;
		const launcher = new FakeLauncher();
		launcher.host.preserveTerminalSession = true;
		const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
		const handle = await runtime.start({
			...taskRequest(),
			sourceWindowName: 'frontend',
		});
		await nextEvent(handle.events);
		void transport.emitChat({
			type: 'chat/turnComplete',
			turnId: currentTurnId(transport),
			duration: 0,
		});
		await transport.sessionUnsubscribeStarted;

		const startedAt = Date.now();
		await handle.dispose();
		assert.ok(Date.now() - startedAt < 500);
		assert.equal(transport.disposeSessionCalls, 1);
		assert.equal(transport.shutdownCalls, 1);
		assert.equal(catalog.session(transport.created!.sessionUri), undefined);
		assert.equal((await handle.events[Symbol.asyncIterator]().next()).done, true);
	});

	test('recovery during terminal Session detach does not reattach the departing client', async () => {
		const catalog = new FakeAhpHostCatalog();
		const first = new FakeAhpTransport(catalog);
		const recovered = new FakeAhpTransport(catalog);
		first.blockNextSessionUnsubscribe = true;
		const launcher = new FakeLauncher();
		launcher.host.preserveTerminalSession = true;
		const runtime = createRuntime(
			launcher,
			new FakeConnectionFactory([first, recovered]),
		);
		const handle = await runtime.start({
			...taskRequest(),
			sourceWindowName: 'frontend',
		});
		await nextEvent(handle.events);
		await first.emitChat({
			type: 'chat/turnComplete',
			turnId: currentTurnId(first),
			duration: 0,
		});
		await first.sessionUnsubscribeStarted;
		first.failRoot();
		await waitForCondition(() => recovered.reconnectRequests.length === 1);

		assert.deepEqual(
			recovered.reconnectRequests[0]?.subscriptions,
			['ahp-root://', 'ahp-chat:/default'],
		);
		assert.equal(
			recovered.reconnectRequests[0]?.subscriptions.includes(first.created!.sessionUri),
			false,
		);
		await handle.dispose();
	});

	test('delegated runtime ignores a terminal action for another turn', async () => {
		const catalog = new FakeAhpHostCatalog();
		const transport = new FakeAhpTransport(catalog);
		const launcher = new FakeLauncher();
		launcher.host.preserveTerminalSession = true;
		const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
		const handle = await runtime.start({
			...taskRequest(),
			sourceWindowName: 'frontend',
		});
		await nextEvent(handle.events);

		await transport.emitChat({
			type: 'chat/turnComplete',
			turnId: 'stale-turn',
			duration: 0,
		});
		await transport.emitChat({
			type: 'chat/delta',
			turnId: currentTurnId(transport),
			partId: 'part-1',
			content: 'current output',
		});
		assert.deepEqual(await nextEvent(handle.events), { type: 'output', text: 'current output' });

		await transport.emitChat({
			type: 'chat/turnComplete',
			turnId: currentTurnId(transport),
			duration: 0,
		});
		assert.deepEqual(await nextEvent(handle.events), { type: 'completed' });
		await handle.dispose();
		assert.equal(transport.disposeSessionCalls, 0);
	});

	test('delegated runtime preserves completed, cancelled, and failed terminal Sessions', async () => {
		for (const terminal of ['chat/turnComplete', 'chat/turnCancelled', 'chat/error'] as const) {
			const catalog = new FakeAhpHostCatalog();
			const transport = new FakeAhpTransport(catalog);
			const launcher = new FakeLauncher();
			launcher.host.preserveTerminalSession = true;
			const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
			const handle = await runtime.start({
				...taskRequest(),
				taskId: `task-${terminal}`,
				sourceWindowName: 'frontend',
			});
			await nextEvent(handle.events);

			await transport.emitChat(terminal === 'chat/error'
				? {
					type: terminal,
					turnId: currentTurnId(transport),
					duration: 0,
					part: { kind: 'error', error: { message: 'Synthetic failure.' } },
				}
				: {
					type: terminal,
					turnId: currentTurnId(transport),
					duration: 0,
				});
			const event = await nextEvent(handle.events);
			assert.equal(event.type, terminal === 'chat/turnComplete'
				? 'completed'
				: terminal === 'chat/turnCancelled' ? 'cancelled' : 'failed');
			await handle.dispose();

			const session = catalog.session(transport.created!.sessionUri);
			assert.equal(session?.status, terminal === 'chat/error' ? 2 : 1);
			assert.equal(session?.activeClientCount, 0);
			assert.deepEqual(
				transport.dispatched.find(({ action }) => action.type === 'session/activeClientRemoved')?.action,
				{
					type: 'session/activeClientRemoved',
					clientId: transport.created!.clientId,
				},
			);
			assert.equal(transport.disposeSessionCalls, 0);
		}
	});

	test('terminal Session cleanup retries a failed active-client unsubscribe', async () => {
		const catalog = new FakeAhpHostCatalog();
		const transport = new FakeAhpTransport(catalog);
		transport.completeAfterTurnDispatch = true;
		const launcher = new FakeLauncher();
		launcher.host.preserveTerminalSession = true;
		const lifecycle: AgentRuntimeLifecycleObservation[] = [];
		const runtime = createRuntime(
			launcher,
			new FakeConnectionFactory([transport]),
			undefined,
			undefined,
			{ observeLifecycle: (observation) => lifecycle.push(observation) },
		);
		const handle = await runtime.start({
			...taskRequest(),
			sourceWindowName: 'frontend',
		});
		for await (const _event of handle.events) {
			// Drain through the terminal event.
		}
		const sessionUri = transport.created!.sessionUri;
		transport.unsubscribeFailures.set('ahp-chat:/default', 1);

		await assert.rejects(
			handle.dispose(),
			(error: unknown) => error instanceof AgentRuntimeError && error.cleanupFailed,
		);
		assert.equal(catalog.session(sessionUri)?.activeClientCount, 0);
		assert.equal(transport.shutdownCalls, 0);
		assert.equal(
			lifecycle.some(({ eventType }) => eventType === 'session/clientDetached'),
			false,
		);

		await handle.dispose();
		assert.equal(catalog.session(sessionUri)?.activeClientCount, 0);
		assert.equal(transport.shutdownCalls, 1);
		assert.equal(lifecycle.at(-1)?.eventType, 'session/clientDetached');
	});

	test('failed terminal Session detach fails closed and disposes the orphaned editor Session', async () => {
		const catalog = new FakeAhpHostCatalog();
		const transport = new FakeAhpTransport(catalog);
		const launcher = new FakeLauncher();
		launcher.host.preserveTerminalSession = true;
		const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
		const handle = await runtime.start({
			...taskRequest(),
			sourceWindowName: 'frontend',
		});
		await nextEvent(handle.events);
		transport.unsubscribeFailures.set(transport.created!.sessionUri, 1);
		await transport.emitChat({
			type: 'chat/turnComplete',
			turnId: currentTurnId(transport),
			duration: 0,
		});
		const event = await nextEvent(handle.events);
		assert.equal(event.type, 'failed');

		await handle.dispose();
		assert.equal(transport.disposeSessionCalls, 1);
		assert.equal(catalog.session(transport.created!.sessionUri), undefined);
		assert.equal(transport.shutdownCalls, 1);
	});

	test('rejected active-client removal fails closed before Session unsubscribe', async () => {
		const catalog = new FakeAhpHostCatalog();
		const transport = new FakeAhpTransport(catalog);
		transport.rejectDispatchType = 'session/activeClientRemoved';
		const launcher = new FakeLauncher();
		launcher.host.preserveTerminalSession = true;
		const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
		const handle = await runtime.start({
			...taskRequest(),
			sourceWindowName: 'frontend',
		});
		await nextEvent(handle.events);
		await transport.emitChat({
			type: 'chat/turnComplete',
			turnId: currentTurnId(transport),
			duration: 0,
		});
		assert.equal((await nextEvent(handle.events)).type, 'failed');
		assert.equal(transport.unsubscribedUris.includes(transport.created!.sessionUri), false);

		await handle.dispose();
		assert.equal(transport.disposeSessionCalls, 1);
		assert.equal(catalog.session(transport.created!.sessionUri), undefined);
	});

	test('standalone terminal Sessions remain owned and are disposed', async () => {
		const transport = new FakeAhpTransport();
		transport.completeAfterTurnDispatch = true;
		const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([transport]));
		const handle = await runtime.start(taskRequest());
		for await (const _event of handle.events) {
			// Drain through the terminal event.
		}
		await handle.dispose();
		assert.equal(transport.disposeSessionCalls, 1);
	});

	test('delegated title rejection removes the provisional Session and leaves no running orphan', async () => {
		const transport = new FakeAhpTransport();
		transport.rejectDispatchType = 'session/titleChanged';
		const launcher = new FakeLauncher();
		launcher.host.preserveTerminalSession = true;
		const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));

		await assert.rejects(
			runtime.start({
				...taskRequest(),
				sourceWindowName: 'frontend',
			}),
			(error: unknown) => error instanceof AgentRuntimeError
				&& error.message === 'The Agent Host rejected a delegated Session action.',
		);
		assert.equal(transport.disposeSessionCalls, 1);
		assert.equal(transport.shutdownCalls, 1);
		assert.equal(launcher.host.disposed, true);
	});

	test('delegated title sanitizer removes raw, encoded, and credential-shaped values', () => {
		const title = buildMeshSessionTitle(
			'/private/var/editor.sock',
			'Inspect %2FUsers%2Fmesh%2Fdata token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
		);
		assert.match(title, /^Mesh · /u);
		assert.doesNotMatch(title, /private|Users|ghp_|abcdefghijklmnopqrstuvwxyz|%2F/iu);
		assert.ok(Buffer.byteLength(title, 'utf8') <= 256);
	});

	test('runtime requires the Agent Host to select exact protocol 1.0 before Session creation', async () => {
		assert.deepEqual(AHP_PROTOCOL_OFFER, ['1.0.0']);
		for (const selectedProtocolVersion of ['0.9.0', '1.1.0']) {
			const transport = new FakeAhpTransport();
			transport.selectedProtocolVersion = selectedProtocolVersion;
			const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([transport]));
			await assert.rejects(
				runtime.start(taskRequest()),
				(error: unknown) => error instanceof AgentRuntimeError
					&& error.code === 'AGENT_UNAVAILABLE'
					&& error.message === 'The Agent Host selected an incompatible protocol version.',
			);
			assert.equal(transport.created, undefined);
			assert.equal(transport.disposeSessionCalls, 0);
			assert.equal(transport.shutdownCalls, 1);
		}
	});

	test('protocol policy preserves exact 1.0 for standalone and registry 1.0 editors', () => {
		assert.deepEqual(ahpProtocolPolicyForHost({
			source: 'standalone',
			registryProtocolVersion: '0.9.0',
		}).offer, ['1.0.0']);
		assert.deepEqual(ahpProtocolPolicyForHost({
			source: 'editor',
			registryProtocolVersion: '1.0.0',
		}).offer, ['1.0.0']);
		assert.throws(
			() => ahpProtocolPolicyForHost({
				source: 'editor',
				registryProtocolVersion: '0.8.0',
			}),
			(error: unknown) => error instanceof AgentRuntimeError
				&& error.code === 'AGENT_UNAVAILABLE',
		);
	});

	test('registry 0.9 editor completes the current Session and turn path with the dual offer', async () => {
		const transport = new FakeAhpTransport();
		transport.protocolPolicy = { offer: AHP_EDITOR_0_9_PROTOCOL_OFFER };
		transport.selectedProtocolVersion = '0.9.0';
		transport.completeAfterTurnDispatch = true;
		const launcher = new FakeLauncher();
		launcher.host.source = 'editor';
		launcher.host.registryProtocolVersion = '0.9.0';
		launcher.host.preserveTerminalSession = true;
		const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));

		const handle = await runtime.start({
			...taskRequest(),
			sourceWindowName: 'source',
		});
		const events = [];
		for await (const event of handle.events) {
			events.push(event);
		}

		assert.deepEqual(transport.protocolPolicy.offer, ['1.0.0', '0.9.0']);
		assert.equal(transport.selectedProtocolVersion, '0.9.0');
		assert.equal(transport.createSessionCalls, 1);
		assert.deepEqual(
			transport.dispatched.slice(0, 2).map(({ action }) => action.type),
			['session/titleChanged', 'chat/turnStarted'],
		);
		assert.equal(events.at(-1)?.type, 'completed');
		await handle.dispose();
		assert.equal(transport.shutdownCalls, 1);
	});

	test('registry 1.0 editor completes the current Session and turn path with the exact offer', async () => {
		const transport = new FakeAhpTransport();
		transport.completeAfterTurnDispatch = true;
		const launcher = new FakeLauncher();
		launcher.host.source = 'editor';
		launcher.host.registryProtocolVersion = '1.0.0';
		launcher.host.preserveTerminalSession = true;
		const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));

		const handle = await runtime.start(taskRequest());
		const events = [];
		for await (const event of handle.events) {
			events.push(event);
		}

		assert.deepEqual(transport.protocolPolicy.offer, ['1.0.0']);
		assert.equal(transport.selectedProtocolVersion, '1.0.0');
		assert.equal(transport.createSessionCalls, 1);
		assert.equal(events.at(-1)?.type, 'completed');
		await handle.dispose();
		assert.equal(transport.shutdownCalls, 1);
	});

	test('outbound action guard rejects 1.0-only actions under 0.9 without weakening 1.0', async () => {
		const action = { type: 'chat/turnResume', turnId: 'turn-1' };
		const { isActionKnownToVersion } = await import('@microsoft/agent-host-protocol');
		assert.throws(
			() => assertOutboundAhpActionSupported(action, '0.9.0', isActionKnownToVersion),
			(error: unknown) => error instanceof AgentRuntimeError
				&& error.code === 'AGENT_UNAVAILABLE',
		);
		assert.doesNotThrow(
			() => assertOutboundAhpActionSupported(action, '1.0.0', isActionKnownToVersion),
		);
	});

	test('real selector runtimes never prompt target for validated peer approval across source outcomes', async () => {
		for (const outcome of ['editor', 'fallback', 'failure'] as const) {
			let modalCount = 0;
			const approval = new VscodeLocalTaskApproval({
				window: {
					showWarningMessage: async () => {
						modalCount += 1;
						return 'Run Once';
					},
				},
			} as never, {} as StateStore);
			const capabilities = new AgentRuntimeApprovalCapabilityIssuer();
			const editorTransport = new FakeAhpTransport();
			const standaloneTransport = new FakeAhpTransport();
			const editorLauncher = outcome === 'editor'
				? new FakeLauncher()
				: new FailingLauncher();
			const standaloneLauncher = outcome === 'failure'
				? new FailingLauncher()
				: new FakeLauncher();
			const editor = sourceRuntime(
				editorLauncher,
				new FakeConnectionFactory([editorTransport]),
				approval,
				capabilities,
			);
			const standalone = sourceRuntime(
				standaloneLauncher,
				new FakeConnectionFactory([standaloneTransport]),
				approval,
				capabilities,
			);
			const selector = new AgentHostSourceSelector({
				preferEditor: () => true,
				editor,
				standalone,
				confirmation: approval,
				workspaceResolver: trustedWorkspaceResolver(),
				approvalCapabilities: capabilities,
			});
			const request = taskRequest();
			const approved = {
				...request,
				approvalCapability: capabilities.issue(request),
			};

			if (outcome === 'failure') {
				await assert.rejects(
					selector.start(approved),
					(error: unknown) => error instanceof AgentRuntimeError
						&& error.code === 'AGENT_UNAVAILABLE',
				);
			} else {
				const handle = await selector.start(approved);
				await handle.dispose();
			}
			assert.equal(modalCount, 0, outcome);
			assert.equal(capabilities.accepts(approved), false, outcome);
			await selector.dispose();
		}
	});

	test('real selector runtimes prompt an ungranted task once before editor fallback', async () => {
		let modalCount = 0;
		const approval = new VscodeLocalTaskApproval({
			window: {
				showWarningMessage: async () => {
					modalCount += 1;
					return 'Run Once';
				},
			},
		} as never, {} as StateStore);
		const capabilities = new AgentRuntimeApprovalCapabilityIssuer();
		const standaloneTransport = new FakeAhpTransport();
		const editor = sourceRuntime(
			new FailingLauncher(),
			new FakeConnectionFactory([]),
			approval,
			capabilities,
		);
		const standalone = sourceRuntime(
			new FakeLauncher(),
			new FakeConnectionFactory([standaloneTransport]),
			approval,
			capabilities,
		);
		const selector = new AgentHostSourceSelector({
			preferEditor: () => true,
			editor,
			standalone,
			confirmation: approval,
			workspaceResolver: trustedWorkspaceResolver(),
			approvalCapabilities: capabilities,
		});

		const handle = await selector.start(taskRequest());
		assert.equal(modalCount, 1);
		await handle.dispose();
		await selector.dispose();
	});

test('AHP subscription pump applies bounded output pressure before accepting terminal completion', async () => {
	const transport = new FakeAhpTransport();
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);

	for (let index = 0; index < 10_000; index += 1) {
		await transport.emitChat({
			type: 'chat/delta',
			turnId: 'turn-1',
			partId: `part-${index}`,
			content: `${index}:${'x'.repeat(1_000)}`,
		});
	}
	await transport.emitChat({
		type: 'chat/turnComplete',
		turnId: currentTurnId(transport),
		duration: 1,
	});

	const events: AgentRuntimeEvent[] = [];
	for await (const event of handle.events) {
		events.push(event);
	}
	assert.ok(events.some(({ type }) => type === 'outputTruncated'));
	assert.equal(events.at(-1)?.type, 'completed');
	await handle.dispose();
});

test('runtime resolves workspace IDs through the trusted registry and ignores forged caller metadata', async () => {
	const transport = new FakeAhpTransport();
	const launcher = new FakeLauncher();
	let confirmedWorkspace = '';
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: new FakeConnectionFactory([transport]),
		authBroker: new RecordingAuthBroker(),
		confirmation: {
			confirm: async (request) => {
				confirmedWorkspace = request.workspace.uri;
				return 'once';
			},
		},
		workspaceResolver: trustedWorkspaceResolver(),
		configResolver: { resolve: async () => ({ model: 'test-model' }) },
	});

	const forged = {
		...taskRequest(),
		workspace: {
			workspaceId: 'workspace-1',
			displayName: 'Forged Workspace',
			uri: 'file:///tmp/forged-workspace',
			registered: true,
		},
	} as AgentTaskRequest;

	const handle = await runtime.start(forged);
	assert.equal(confirmedWorkspace, workspaceUri);
	assert.deepEqual(transport.created?.workingDirectories, [workspaceUri]);
	await handle.dispose();

	await assert.rejects(
		runtime.start({ ...taskRequest(), workspaceId: 'unregistered-workspace' }),
		(error: unknown) => error instanceof AgentRuntimeError && error.code === 'AGENT_UNAVAILABLE',
	);
	assert.equal(launcher.launchCalls, 1);
	await runtime.dispose();
});

test('runtime correlates an observed child AHP Mesh call and clears it on cancellation', async () => {
	const transport = new FakeAhpTransport();
	const launcher = new FakeLauncher();
	const delegatedToolInvocations = new DelegatedToolInvocationRegistry();
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: new FakeConnectionFactory([transport]),
		authBroker: new RecordingAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
		configResolver: { resolve: async () => ({ model: 'test-model' }) },
		delegatedToolInvocations,
	});
	const executionContext = {
		kind: 'delegatedChild' as const,
		taskId: '00000000-0000-4000-8000-000000000080',
		capability: 'c'.repeat(43),
	};
	const input = {
		delegationRequestId: '00000000-0000-4000-8000-000000000081',
		deviceId: '00000000-0000-4000-8000-000000000082',
		nodeId: '00000000-0000-4000-8000-000000000083',
		nodeInstanceId: '00000000-0000-4000-8000-000000000084',
		workspaceId: '00000000-0000-4000-8000-000000000085',
		title: 'Nested task',
		prompt: 'Attempt nested delegation.',
		acceptanceCriteria: ['Rejected'],
	};
	const handle = await runtime.start({
		...taskRequest(),
		taskId: executionContext.taskId,
		delegatedExecutionContext: executionContext,
	});
	await nextEvent(handle.events);
	await transport.emitChat({
		type: 'chat/toolCallStart',
		turnId: 'turn-1',
		toolCallId: 'mesh-call-1',
		toolName: MESH_TOOL_NAMES.delegateTask,
		displayName: 'Delegate Task',
	});
	await nextEvent(handle.events);
	await transport.emitChat({
		type: 'chat/toolCallReady',
		turnId: 'turn-1',
		toolCallId: 'mesh-call-1',
		invocationMessage: 'Delegate task',
		toolInput: JSON.stringify(input),
		confirmed: 'not-needed',
	});
	await nextEvent(handle.events);
	assert.deepEqual(delegatedToolInvocations.consume(input), executionContext);

	await transport.emitChat({
		type: 'chat/toolCallReady',
		turnId: 'turn-1',
		toolCallId: 'mesh-call-2',
		invocationMessage: 'Delegate task',
		toolInput: JSON.stringify(input),
		confirmed: 'not-needed',
	});
	await nextEvent(handle.events);
	assert.equal(delegatedToolInvocations.size, 1);
	assert.deepEqual(delegatedToolInvocations.consume(input), executionContext);
	await transport.emitChat({
		type: 'chat/toolCallStart',
		turnId: 'turn-1',
		toolCallId: 'mesh-call-2',
		toolName: MESH_TOOL_NAMES.delegateTask,
		displayName: 'Delegate Task',
	});
	await nextEvent(handle.events);
	await transport.emitChat({
		type: 'chat/toolCallReady',
		turnId: 'turn-1',
		toolCallId: 'mesh-call-2',
		invocationMessage: 'Delegate task',
		toolInput: JSON.stringify(input),
		confirmed: 'not-needed',
	});
	await nextEvent(handle.events);
	assert.equal(delegatedToolInvocations.size, 2);
	await transport.emitChat({
		type: 'chat/turnComplete',
		turnId: 'foreign-turn',
		duration: 0,
	});
	assert.equal(delegatedToolInvocations.size, 2);
	await handle.cancel();
	assert.equal(delegatedToolInvocations.size, 0);
	await handle.dispose();
	await runtime.dispose();
});

test('runtime explicitly rejects the removed legacy always approval', async () => {
	const launcher = new FakeLauncher();
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: new FakeConnectionFactory([new FakeAhpTransport()]),
		authBroker: new RecordingAuthBroker(),
		confirmation: {
			confirm: async () => 'always' as never,
		},
		workspaceResolver: trustedWorkspaceResolver(),
	});
	await assert.rejects(
		runtime.start(taskRequest()),
		(error: unknown) =>
			error instanceof AgentRuntimeError
			&& error.code === 'TASK_EXECUTION_FAILED',
	);
	assert.equal(launcher.launchCalls, 0);
});

test('runtime attaches the root subscription before initialize and preserves notifications from that window', async () => {
	const transport = new FakeAhpTransport();
	transport.notificationDuringInitialize = [protectedResource, initializationOnlyResource];
	const auth = new RecordingAuthBroker();
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher: new FakeLauncher(),
		connections: new FakeConnectionFactory([transport]),
		authBroker: auth,
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
		configResolver: { resolve: async () => ({ model: 'test-model' }) },
	});

	const handle = await runtime.start(taskRequest());
	await waitForCondition(() => auth.requests.filter(({ reason }) => reason === 'tokenInvalid').length === 2);
	assert.equal(transport.rootAttachedBeforeInitialize, true);
	assert.equal(auth.requests.filter(({ resources }) =>
		resources.some(({ resource }) => resource === protectedResource.resource),
	).length, 2);
	assert.ok(auth.requests.some(({ reason, resources }) =>
		reason === 'tokenInvalid'
		&& resources.some(({ resource }) => resource === initializationOnlyResource.resource),
	));
	await handle.dispose();
});

test('non-interactive dynamic Session config fails with a stable configuration boundary', async () => {
	const transport = new FakeAhpTransport();
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher: new FakeLauncher(),
		connections: new FakeConnectionFactory([transport]),
		authBroker: new RecordingAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
	});

	await assert.rejects(
		runtime.start(taskRequest()),
		(error: unknown) => error instanceof AgentRuntimeError && error.code === 'AGENT_CONFIG_REQUIRED',
	);
});

test('runtime disposal aborts and awaits interactive Session configuration', async () => {
	const transport = new FakeAhpTransport();
	const launcher = new FakeLauncher();
	let configEntered!: () => void;
	const entered = new Promise<void>((resolve) => {
		configEntered = resolve;
	});
	let configSignal: AbortSignal | undefined;
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: new FakeConnectionFactory([transport]),
		authBroker: new RecordingAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
		configResolver: {
			resolve: async (request) => {
				configSignal = request.signal;
				configEntered();
				return new Promise(() => undefined);
			},
		},
	});

	const start = runtime.start({
		...taskRequest(),
		allowInteractiveAuthentication: true,
	});
	await entered;
	const disposal = runtime.dispose();

	await assert.rejects(start, AgentRuntimeError);
	await disposal;
	assert.equal(configSignal?.aborted, true);
	assert.equal(launcher.host.disposed, true);
});

test('start failure cleans the task, AHP connection, and owned host without losing the auth error', async () => {
	const transport = new FakeAhpTransport();
	transport.shutdownFails = true;
	const launcher = new FakeLauncher();
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: new FakeConnectionFactory([transport]),
		authBroker: new FailingAuthBroker('AGENT_AUTH_REQUIRED'),
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
	});

	await assert.rejects(
		runtime.start(taskRequest()),
		(error: unknown) => error instanceof AgentRuntimeError
			&& error.code === 'AGENT_AUTH_REQUIRED'
			&& error.cleanupFailed
			&& error.cause instanceof AggregateError
			&& !error.message.includes('not-a-real-token'),
	);
	assert.equal(transport.disposeSessionCalls, 0);
	assert.equal(transport.shutdownCalls, 1);
	assert.equal(launcher.host.disposed, true);

	transport.shutdownFails = false;
	await runtime.dispose();
	assert.equal(transport.disposeSessionCalls, 0);
	assert.equal(transport.shutdownCalls, 2);
});

test('a later start retries failed startup cleanup before launching another Agent task', async () => {
	const firstTransport = new FakeAhpTransport();
	firstTransport.shutdownFails = true;
	const secondTransport = new FakeAhpTransport();
	const launcher = new FakeLauncher();
	const connections = new FakeConnectionFactory([firstTransport, secondTransport]);
	let authenticationAttempts = 0;
	const authBroker: AuthBroker = {
		authenticate: async (request, pushToken) => {
			authenticationAttempts += 1;
			if (authenticationAttempts === 1) {
				throw new AgentRuntimeError('AGENT_AUTH_REQUIRED', 'Authentication is not ready.');
			}
			for (const resource of request.resources.filter(({ required }) => required !== false)) {
				await pushToken(resource.resource, 'test-token', resource.scopes_supported ?? []);
			}
		},
	};
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections,
		authBroker,
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
		configResolver: { resolve: async () => ({ model: 'test-model' }) },
	});

	const first = runtime.start(taskRequest());
	const queued = runtime.start({ ...taskRequest(), taskId: 'task-2' });
	await assert.rejects(
		first,
		(error: unknown) => error instanceof AgentRuntimeError
			&& error.code === 'AGENT_AUTH_REQUIRED'
			&& error.cleanupFailed,
	);
	assert.equal(connections.connectCalls, 1);
	assert.equal(launcher.launchCalls, 1);

	await assert.rejects(
		queued,
		(error: unknown) => error instanceof AgentRuntimeError
			&& error.cleanupFailed,
	);
	assert.equal(firstTransport.shutdownCalls, 2);
	assert.equal(connections.connectCalls, 1);
	assert.equal(launcher.launchCalls, 1);
	firstTransport.shutdownFails = false;
	const handle = await runtime.start({ ...taskRequest(), taskId: 'task-3' });
	assert.equal(firstTransport.shutdownCalls, 3);
	assert.equal(connections.connectCalls, 2);
	assert.equal(launcher.launchCalls, 2);
	assert.equal(secondTransport.initialized, true);
	await handle.dispose();
	await runtime.dispose();
});

test('provisional Session dispatches its first turn before session/ready', async () => {
	const transport = new FakeAhpTransport();
	transport.sessionStartsProvisional = true;
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));

	const handle = await runtime.start(taskRequest());
	assert.equal(transport.dispatched[0]?.action.type, 'chat/turnStarted');
	assert.equal(transport.dispatched[0]?.channel, transport.sessionDefaultChat);
	await handle.dispose();
});

test('terminal provisional Session waits for session/ready before leaving its active client', async () => {
	const transport = new FakeAhpTransport();
	transport.sessionStartsProvisional = true;
	const launcher = new FakeLauncher();
	launcher.host.preserveTerminalSession = true;
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	const terminal = nextEvent(handle.events);

	await transport.emitChat({
		type: 'chat/turnComplete',
		turnId: currentTurnId(transport),
		duration: 0,
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(transport.unsubscribedUris.includes(transport.created!.sessionUri), false);

	await transport.emitSession({ type: 'session/ready' });
	assert.equal((await terminal).type, 'completed');
	assert.equal(transport.unsubscribedUris.includes(transport.created!.sessionUri), true);
	await handle.dispose();
	assert.equal(transport.disposeSessionCalls, 0);
});

test('authoritative cancellation remains cancelled when a provisional Session never materializes', async () => {
	const catalog = new FakeAhpHostCatalog();
	const transport = new FakeAhpTransport(catalog);
	transport.sessionStartsProvisional = true;
	const launcher = new FakeLauncher();
	launcher.host.preserveTerminalSession = true;
	const runtime = createRuntime(
		launcher,
		new FakeConnectionFactory([transport]),
		undefined,
		undefined,
		undefined,
		{
			cancellationTimeoutMs: 15,
			terminalSessionMaterializationTimeoutMs: 30,
		},
	);
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);

	await handle.cancel();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal((await nextEvent(handle.events)).type, 'cancelled');
	await new Promise<void>((resolve) => setTimeout(resolve, 40));
	await assert.rejects(
		handle.dispose(),
		(error: unknown) =>
			error instanceof AgentRuntimeError
			&& error.cleanupFailed
			&& error.code !== 'TASK_CANCELLATION_UNCONFIRMED',
	);
	assert.equal(transport.disposeSessionCalls, 1);
	assert.equal(catalog.session(transport.created!.sessionUri), undefined);
	await handle.dispose();
});

test('authoritative error remains failed when a provisional Session never materializes', async () => {
	const catalog = new FakeAhpHostCatalog();
	const transport = new FakeAhpTransport(catalog);
	transport.sessionStartsProvisional = true;
	const launcher = new FakeLauncher();
	launcher.host.preserveTerminalSession = true;
	const runtime = createRuntime(
		launcher,
		new FakeConnectionFactory([transport]),
		undefined,
		undefined,
		undefined,
		{ terminalSessionMaterializationTimeoutMs: 20 },
	);
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);

	await transport.emitChat({
		type: 'chat/error',
		turnId: currentTurnId(transport),
		duration: 0,
		part: { kind: 'error', error: { message: 'Confirmed failure.' } },
	});
	const event = await nextEvent(handle.events);
	assert.equal(event.type, 'failed');
	if (event.type === 'failed') {
		assert.equal(event.error.message, 'Confirmed failure.');
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 30));
	await assert.rejects(
		handle.dispose(),
		(error: unknown) => error instanceof AgentRuntimeError && error.cleanupFailed,
	);
	assert.equal(transport.disposeSessionCalls, 1);
	await handle.dispose();
});

test('exact authoritative terminals clear cancellation confirmation before slow history detach', async () => {
	for (const [terminal, expected] of [
		['chat/turnCancelled', 'cancelled'],
		['chat/error', 'failed'],
		['chat/turnComplete', 'completed'],
	] as const) {
		const catalog = new FakeAhpHostCatalog();
		const transport = new FakeAhpTransport(catalog);
		const launcher = new FakeLauncher();
		launcher.host.preserveTerminalSession = true;
		const runtime = createRuntime(
			launcher,
			new FakeConnectionFactory([transport]),
			undefined,
			undefined,
			undefined,
			{ cancellationTimeoutMs: 20 },
		);
		const handle = await runtime.start(taskRequest());
		await nextEvent(handle.events);
		transport.ackDispatches = false;

		await handle.cancel();
		assert.equal((await nextEvent(handle.events)).type, 'progress');
		await transport.emitChat(terminal === 'chat/error'
			? {
				type: terminal,
				turnId: currentTurnId(transport),
				duration: 0,
				part: { kind: 'error', error: { message: 'Confirmed failure.' } },
			}
			: {
				type: terminal,
				turnId: currentTurnId(transport),
				duration: 0,
			});
		await waitForCondition(() =>
			transport.dispatched.some(({ action }) => action.type === 'session/activeClientRemoved'));
		await new Promise<void>((resolve) => setTimeout(resolve, 40));
		await transport.acknowledgeDispatch('session/activeClientRemoved');
		assert.equal((await nextEvent(handle.events)).type, expected);

		await handle.dispose();
		assert.equal(transport.disposeSessionCalls, 0);
		assert.equal(catalog.session(transport.created!.sessionUri)?.activeClientCount, 0);
	}
});

test('disposing an authoritative cancellation during materialization wait removes the orphan', async () => {
	const catalog = new FakeAhpHostCatalog();
	const transport = new FakeAhpTransport(catalog);
	transport.sessionStartsProvisional = true;
	const launcher = new FakeLauncher();
	launcher.host.preserveTerminalSession = true;
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);

	await handle.cancel();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	await transport.emitChat({
		type: 'chat/turnCancelled',
		turnId: currentTurnId(transport),
		duration: 0,
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	await handle.dispose();
	assert.equal(transport.disposeSessionCalls, 1);
	assert.equal(catalog.session(transport.created!.sessionUri), undefined);
});

test('disposing an authoritative cancellation during detach wait removes the orphan', async () => {
	const catalog = new FakeAhpHostCatalog();
	const transport = new FakeAhpTransport(catalog);
	const launcher = new FakeLauncher();
	launcher.host.preserveTerminalSession = true;
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	transport.ackDispatches = false;

	await handle.cancel();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	await transport.emitChat({
		type: 'chat/turnCancelled',
		turnId: currentTurnId(transport),
		duration: 0,
	});
	await waitForCondition(() =>
		transport.dispatched.some(({ action }) => action.type === 'session/activeClientRemoved'));

	await handle.dispose();
	assert.equal(transport.disposeSessionCalls, 1);
	assert.equal(catalog.session(transport.created!.sessionUri), undefined);
});

test('AHP 0.8 creationFailed Session snapshots fail with the reported error', async () => {
	const transport = new FakeAhpTransport();
	transport.sessionCreationFailed = true;
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));

	await assert.rejects(
		runtime.start(taskRequest()),
		(error: unknown) =>
			error instanceof AgentRuntimeError
			&& error.code === 'TASK_EXECUTION_FAILED'
			&& error.message === 'Legacy Session creation failed.',
	);
	assert.equal(launcher.host.disposed, true);
});

test('runtime rejects a mismatched Host-echoed Session without recording local identity', async () => {
	const transport = new FakeAhpTransport();
	transport.sessionSnapshotResource = 'ahp-session:/foreign';
	const launcher = new FakeLauncher();
	const lifecycle: AgentRuntimeLifecycleObservation[] = [];
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: new FakeConnectionFactory([transport]),
		authBroker: new RecordingAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
		configResolver: { resolve: async () => ({ model: 'test-model' }) },
		lifecycleObserver: {
			observeLifecycle: (observation) => lifecycle.push(observation),
		},
	});

	await assert.rejects(
		runtime.start(taskRequest()),
		(error: unknown) => error instanceof AgentRuntimeError
			&& error.code === 'TASK_EXECUTION_FAILED'
			&& /mismatched resource/u.test(error.message),
	);
	assert.deepEqual(lifecycle, []);
	assert.equal(transport.unsubscribedUris.includes(transport.created?.sessionUri ?? ''), true);
	assert.equal(launcher.host.disposed, true);
});

test('connection failure cleans the detached owned host before surfacing startup failure', async () => {
	const launcher = new FakeLauncher();
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: { connect: async () => { throw new Error('connection failed'); } },
		authBroker: new RecordingAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
	});

	await assert.rejects(runtime.start(taskRequest()), AgentRuntimeError);
	assert.equal(launcher.host.disposed, true);
});

test('runtime disposal aborts and awaits an in-flight editor connection start', async () => {
	const launcher = new FakeLauncher();
	let connectEntered!: () => void;
	const entered = new Promise<void>((resolve) => {
		connectEntered = resolve;
	});
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: {
			connect: async (_host, signal) => {
				connectEntered();
				return new Promise<AhpConnection>((_resolve, reject) => {
					const abort = () => reject(new Error('connection aborted'));
					if (signal?.aborted === true) {
						abort();
					} else {
						signal?.addEventListener('abort', abort, { once: true });
					}
				});
			},
		},
		authBroker: new RecordingAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
	});

	const start = runtime.start(taskRequest());
	await entered;
	await runtime.dispose();
	await assert.rejects(start, AgentRuntimeError);
	assert.equal(launcher.host.disposed, true);
});

test('runtime disposal drains cleanup ownership recorded by an in-flight start', async () => {
	const host = new FakeHost();
	host.disposeFailuresRemaining = 1;
	let launchEntered!: () => void;
	let releaseLaunch!: () => void;
	const entered = new Promise<void>((resolve) => {
		launchEntered = resolve;
	});
	const launchGate = new Promise<void>((resolve) => {
		releaseLaunch = resolve;
	});
	const launcher: AgentHostLauncherLike = {
		probe: async () => ({ available: true, executable: '/safe/code', version: '1.134.0' }),
		launch: async () => {
			launchEntered();
			await launchGate;
			return host;
		},
		dispose: () => host.dispose(),
	};
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: new FakeConnectionFactory([new FakeAhpTransport()]),
		authBroker: new RecordingAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
		configResolver: { resolve: async () => ({ model: 'test-model' }) },
	});

	const start = runtime.start(taskRequest());
	await entered;
	const disposal = runtime.dispose();
	releaseLaunch();

	await assert.rejects(
		start,
		(error: unknown) => error instanceof AgentRuntimeError && error.cleanupFailed,
	);
	await disposal;
	assert.equal(host.disposeFailuresRemaining, 0);
	assert.equal(host.disposed, true);
});

test('root connection loss before Session creation fails startup instead of entering Session recovery', async () => {
	const transport = new FakeAhpTransport();
	transport.failRootDuringConfig = true;
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));

	await assert.rejects(
		runtime.start(taskRequest()),
		(error: unknown) => error instanceof AgentRuntimeError && error.code === 'AGENT_UNAVAILABLE',
	);
	assert.equal(launcher.host.disposed, true);
	assert.equal(transport.shutdownCalls, 1);
});

test('startup resumes Session and Chat subscription on the recovered generation', async () => {
	const first = new FakeAhpTransport();
	first.blockSessionSubscriptions = true;
	const recovered = new FakeAhpTransport();
	recovered.sessionDefaultChat = 'ahp-chat:/recovered';
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([first, recovered]));
	const started = runtime.start(taskRequest());
	await waitForCondition(() => first.subscribeAttempts.some((uri) => uri.startsWith('ahp-session:')));
	const sessionUri = first.subscribeAttempts.find((uri) => uri.startsWith('ahp-session:'))!;
	recovered.created = first.created;
	recovered.reconnectResult = {
		type: 'replay',
		actions: [envelope(sessionUri, {
			type: 'session/defaultChatChanged',
			defaultChat: 'ahp-chat:/recovered',
		}, 5)],
		missing: [],
	};
	first.failRoot();

	const handle = await started;
	assert.equal(first.dispatched.length, 0);
	assert.equal(recovered.subscribedUris.includes(sessionUri), true);
	assert.equal(recovered.subscribedUris.includes('ahp-chat:/recovered'), true);
	assert.equal(recovered.dispatched[0]?.channel, 'ahp-chat:/recovered');
	assert.equal(recovered.dispatched[0]?.action.type, 'chat/turnStarted');
	await handle.dispose();
});

test('startup follows a changed default Chat when recovery occurs during Chat subscription', async () => {
	const first = new FakeAhpTransport();
	first.blockSubscribe('ahp-chat:/default');
	const recovered = new FakeAhpTransport();
	const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([first, recovered]));
	const started = runtime.start(taskRequest());
	await waitForCondition(() => first.subscribeAttempts.includes('ahp-chat:/default'));
	recovered.created = first.created;
	recovered.reconnectResult = {
		type: 'replay',
		actions: [envelope(first.created!.sessionUri, {
			type: 'session/defaultChatChanged',
			defaultChat: 'ahp-chat:/recovered',
		}, 5)],
		missing: [],
	};
	first.failRoot();

	const handle = await started;
	assert.equal(recovered.unsubscribedUris.includes('ahp-chat:/default'), true);
	assertCleanupOrder(recovered, 'ahp-chat:/default');
	assert.equal(recovered.subscribedUris.includes('ahp-chat:/recovered'), true);
	assert.equal(recovered.dispatched[0]?.channel, 'ahp-chat:/recovered');
	await handle.dispose();
});

test('startup never dispatches a turn or returns a handle after the task becomes terminal', async () => {
	const transport = new FakeAhpTransport();
	transport.completeAfterChatSubscribe = true;
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));

	await assert.rejects(
		runtime.start(taskRequest()),
		(error: unknown) => error instanceof AgentRuntimeError && error.code === 'TASK_EXECUTION_FAILED',
	);
	assert.equal(transport.dispatched.length, 0);
	assert.equal(launcher.host.disposed, true);
});

test('startup observes terminal actions delivered immediately after turn dispatch', async () => {
	const transport = new FakeAhpTransport();
	transport.completeAfterTurnDispatch = true;
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));

	const handle = await runtime.start(taskRequest());
	assert.deepEqual(await nextEvent(handle.events), { type: 'completed' });
	assert.equal(transport.dispatched.length, 1);
	await handle.dispose();
	assert.equal(launcher.host.disposed, true);
});

test('disposing runtime rejects a pending default Chat without waiting for timeout', async () => {
	const transport = new FakeAhpTransport();
	transport.sessionStartsPending = true;
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
	const started = runtime.start(taskRequest());
	await waitForCondition(() => transport.subscribedUris.some((uri) => uri.startsWith('ahp-session:')));

	await runtime.dispose();
	await assert.rejects(
		started,
		(error: unknown) => error instanceof AgentRuntimeError && error.code === 'TASK_EXECUTION_FAILED',
	);
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
	const recoveryBeforeLoss = handle.recovery;

	first.failChat();
	assert.deepEqual(await nextEvent(handle.events), { type: 'progress', message: 'Reconnecting to Agent Host.' });
	assert.deepEqual(await nextEvent(handle.events), { type: 'output', text: 'replayed' });
	assert.deepEqual(await nextEvent(handle.events), { type: 'progress', message: 'Agent Host connection recovered.' });
	assert.equal(handle.recovery.lastSeenServerSeq, 9);
	assert.deepEqual(recovered.reconnectRequests, [{
		clientId: recoveryBeforeLoss.clientId,
		lastSeenServerSeq: recoveryBeforeLoss.lastSeenServerSeq,
		subscriptions: ['ahp-root://', recoveryBeforeLoss.sessionUri, recoveryBeforeLoss.chatUri],
	}]);

	launcher.host.crash();
	const failed = await nextEvent(handle.events);
	assert.equal(failed.type, 'failed');
	if (failed.type === 'failed') {
		assert.equal(failed.error.code, 'TASK_RECOVERY_UNAVAILABLE');
	}
	await handle.dispose();
});

test('runtime drops replayed child correlations and accepts only fresh calls after recovery', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	const input = {
		delegationRequestId: '00000000-0000-4000-8000-0000000000a1',
		deviceId: '00000000-0000-4000-8000-0000000000a2',
		nodeId: '00000000-0000-4000-8000-0000000000a3',
		nodeInstanceId: '00000000-0000-4000-8000-0000000000a4',
		workspaceId: '00000000-0000-4000-8000-0000000000a5',
		title: 'Recovered nested task',
		prompt: 'Attempt nested delegation after recovery.',
		acceptanceCriteria: ['Rejected'],
	};
	recovered.reconnectResult = {
		type: 'replay',
		actions: [
			envelope('ahp-chat:/default', {
				type: 'chat/toolCallStart',
				turnId: 'turn-1',
				toolCallId: 'replayed-tool',
				toolName: MESH_TOOL_NAMES.delegateTask,
				displayName: 'Delegate Task',
			}, 9),
			envelope('ahp-chat:/default', {
				type: 'chat/toolCallReady',
				turnId: 'turn-1',
				toolCallId: 'replayed-tool',
				invocationMessage: 'Delegate task',
				toolInput: JSON.stringify(input),
				confirmed: 'not-needed',
			}, 10),
		],
		missing: [],
	};
	const registry = new DelegatedToolInvocationRegistry();
	const launcher = new FakeLauncher();
	const runtime = createRuntime(
		launcher,
		new FakeConnectionFactory([first, recovered]),
		new RecordingAuthBroker(),
		registry,
	);
	const executionContext = {
		kind: 'delegatedChild' as const,
		taskId: '00000000-0000-4000-8000-0000000000a0',
		capability: 'd'.repeat(43),
	};
	const handle = await runtime.start({
		...taskRequest(),
		taskId: executionContext.taskId,
		delegatedExecutionContext: executionContext,
	});
	await nextEvent(handle.events);
	recovered.created = first.created;

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal((await nextEvent(handle.events)).type, 'tool');
	assert.equal((await nextEvent(handle.events)).type, 'tool');
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal(registry.size, 0);

	await recovered.emitChat({
		type: 'chat/toolCallStart',
		turnId: 'turn-2',
		toolCallId: 'fresh-tool',
		toolName: MESH_TOOL_NAMES.delegateTask,
		displayName: 'Delegate Task',
	});
	await nextEvent(handle.events);
	await recovered.emitChat({
		type: 'chat/toolCallReady',
		turnId: 'turn-2',
		toolCallId: 'fresh-tool',
		invocationMessage: 'Delegate task',
		toolInput: JSON.stringify(input),
		confirmed: 'not-needed',
	});
	await nextEvent(handle.events);
	assert.deepEqual(registry.consume(input), executionContext);
	await handle.dispose();
	await runtime.dispose();
});

test('dispose aborts and awaits in-flight recovery before releasing owned resources', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	recovered.blockReconnect();
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.created = first.created;

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	await handle.dispose();
	assert.equal(recovered.shutdownCalls, 1);
	assert.equal(launcher.host.disposed, true);
});

test('dispose propagates abort to blocked recovery authentication and waits for it to settle', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	recovered.reconnectResult = { type: 'replay', actions: [], missing: [] };
	const broker = new AbortableRecoveryAuthBroker();
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([first, recovered]), broker);
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.created = first.created;

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	await waitForCondition(() => broker.recoveryStarted);
	await handle.dispose();
	assert.equal(broker.recoveryAborted, true);
	assert.equal(recovered.shutdownCalls, 1);
	assert.equal(launcher.host.disposed, true);
});

test('dispose aborts auth notifications and prevents a late token submission', async () => {
	const transport = new FakeAhpTransport();
	const broker = new LateTokenAuthBroker();
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]), broker);
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	assert.equal(transport.authenticated.length, 1);

	transport.emitRootAuth([protectedResource]);
	await waitForCondition(() => broker.notificationStarted);
	await handle.dispose();
	assert.equal(broker.latePushRejected, true);
	assert.equal(transport.authenticated.length, 1);
	assert.equal(launcher.host.disposed, true);
});

test('recovery resends unacknowledged turn and input actions with their original client sequences', async () => {
	const first = new FakeAhpTransport();
	first.ackDispatches = false;
	const recovered = new FakeAhpTransport();
	recovered.reconnectResult = { type: 'replay', actions: [], missing: [] };
	const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.created = first.created;

	first.emitChat({
		type: 'chat/inputRequested',
		request: {
			id: 'resend-input',
			message: 'Name',
			questions: [{ id: 'name', message: 'Name', kind: 'text', required: true }],
		},
	});
	const input = await nextEvent(handle.events);
	assert.equal(input.type, 'inputRequired');
	if (input.type !== 'inputRequired') {
		return;
	}
	await handle.answer({
		requestId: input.request.requestId,
		outcome: 'accept',
		values: { name: 'mesh' },
	});
	assert.deepEqual(first.dispatched.map(({ clientSeq }) => clientSeq), [1, 2]);

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.deepEqual(recovered.dispatched, first.dispatched);
	recovered.emitChat({
		type: 'chat/delta',
		turnId: 'turn-1',
		partId: 'post-ack',
		content: 'acknowledged',
	});
	assert.equal((await nextEvent(handle.events)).type, 'output');
	await assert.rejects(
		handle.answer({
			requestId: input.request.requestId,
			outcome: 'accept',
			values: { name: 'mesh' },
		}),
		(error: unknown) => error instanceof AgentRuntimeError
			&& error.message.includes('no longer pending'),
	);
	await handle.dispose();
});

test('recovery resends unacknowledged cancellation and rejects writes until candidate takeover', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	recovered.reconnectResult = { type: 'replay', actions: [], missing: [] };
	recovered.blockReconnect();
	const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.created = first.created;
	first.ackDispatches = false;
	await handle.cancel();
	assert.equal((await nextEvent(handle.events)).type, 'progress');

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	await assert.rejects(
		handle.cancel(),
		(error: unknown) => error instanceof AgentRuntimeError && error.retryable,
	);
	recovered.releaseReconnect();
	await waitForCondition(() => recovered.dispatched.length === 1);
	assert.deepEqual(recovered.dispatched[0], first.dispatched.at(-1));
	await handle.dispose();
});

test('runtime preserves non-missing recovery connection failures', async () => {
	const first = new FakeAhpTransport();
	let connects = 0;
	const runtime = createRuntime(new FakeLauncher(), {
		connect: async () => {
			connects += 1;
			if (connects === 1) {
				return first;
			}
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'Transient recovery connection failure.');
		},
	});
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	const failed = await nextEvent(handle.events);
	assert.equal(failed.type, 'failed');
	if (failed.type === 'failed') {
		assert.equal(failed.error.code, 'AGENT_UNAVAILABLE');
	}
	await handle.dispose();
});

test('recovery fails rather than taking over without the root subscription', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	recovered.reconnectResult = { type: 'replay', actions: [], missing: ['ahp-root://'] };
	const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.created = first.created;

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	const failed = await nextEvent(handle.events);
	assert.equal(failed.type, 'failed');
	if (failed.type === 'failed') {
		assert.equal(failed.error.code, 'TASK_RECOVERY_UNAVAILABLE');
	}
	await handle.dispose();
});

test('recovery succeeds when only the stale connection shutdown fails and retries cleanup on dispose', async () => {
	const first = new FakeAhpTransport();
	first.shutdownFails = true;
	const recovered = new FakeAhpTransport();
	recovered.reconnectResult = { type: 'replay', actions: [], missing: [] };
	const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.created = first.created;

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.deepEqual(await nextEvent(handle.events), { type: 'progress', message: 'Agent Host connection recovered.' });
	assert.equal(first.shutdownCalls, 1);
	first.shutdownFails = false;
	await handle.dispose();
	assert.equal(first.shutdownCalls, 2);
});

test('recovery subscribes newly owned terminals through the candidate connection', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.reconnectResult = {
		type: 'replay',
		actions: [envelope('ahp-root://', {
			type: 'root/terminalsChanged',
			terminals: [{
				resource: 'ahp-terminal:/recovered',
				label: 'Recovered terminal',
				claim: { kind: 'session', session: handle.recovery.sessionUri },
			}],
		}, 8)],
		missing: [],
	};
	recovered.created = first.created;

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.deepEqual(recovered.subscribedUris, ['ahp-terminal:/recovered']);
	assert.deepEqual(first.subscribedUris, [handle.recovery.sessionUri, 'ahp-chat:/default']);
	await handle.dispose();
});

test('recovery stops before subscribing terminals after replay completes the task', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.created = first.created;
	recovered.reconnectResult = {
		type: 'replay',
		actions: [
			envelope('ahp-root://', {
				type: 'root/terminalsChanged',
				terminals: [{
					resource: 'ahp-terminal:/late',
					label: 'Late terminal',
					claim: { kind: 'session', session: handle.recovery.sessionUri },
				}],
			}, 8),
			envelope('ahp-chat:/default', {
				type: 'chat/turnComplete',
				turnId: currentTurnId(first),
				duration: 0,
			}, 9),
		],
		missing: [],
	};

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal((await nextEvent(handle.events)).type, 'completed');
	await waitForCondition(() => recovered.shutdownCalls === 1);
	assert.equal(recovered.subscribedUris.includes('ahp-terminal:/late'), false);
	await handle.dispose();
});

test('recovery applies replayed Session readiness before an earlier terminal action', async () => {
	const catalog = new FakeAhpHostCatalog();
	const first = new FakeAhpTransport(catalog);
	first.sessionStartsProvisional = true;
	const recovered = new FakeAhpTransport(catalog);
	const launcher = new FakeLauncher();
	launcher.host.preserveTerminalSession = true;
	const runtime = createRuntime(launcher, new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start({
		...taskRequest(),
		sourceWindowName: 'frontend',
	});
	await nextEvent(handle.events);
	recovered.created = first.created;
	recovered.reconnectResult = {
		type: 'replay',
		actions: [
			envelope('ahp-chat:/default', {
				type: 'chat/turnComplete',
				turnId: currentTurnId(first),
				duration: 0,
			}, 8),
			envelope(first.created!.sessionUri, { type: 'session/ready' }, 9),
		],
		missing: [],
	};

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal((await nextEvent(handle.events)).type, 'completed');
	await handle.dispose();
	assert.equal(recovered.disposeSessionCalls, 0);
});

test('recovery applies Session readiness before an earlier terminal Chat snapshot', async () => {
	const catalog = new FakeAhpHostCatalog();
	const first = new FakeAhpTransport(catalog);
	first.sessionStartsProvisional = true;
	const recovered = new FakeAhpTransport(catalog);
	const launcher = new FakeLauncher();
	launcher.host.preserveTerminalSession = true;
	const runtime = createRuntime(launcher, new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start({
		...taskRequest(),
		sourceWindowName: 'frontend',
	});
	await nextEvent(handle.events);
	const turnId = currentTurnId(first);
	recovered.created = first.created;
	recovered.reconnectResult = {
		type: 'snapshot',
		snapshots: [
			{
				resource: 'ahp-chat:/default',
				fromSeq: 8,
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
			} as Snapshot,
			{
				resource: first.created!.sessionUri,
				fromSeq: 9,
				state: {
					resource: first.created!.sessionUri,
					provider: 'dynamic-provider',
					title: 'Task',
					status: 1,
					lifecycle: 'ready',
					activeClients: [],
					chats: [],
					defaultChat: 'ahp-chat:/default',
				},
			} as Snapshot,
			{
				resource: 'ahp-root://',
				fromSeq: 10,
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
			} as Snapshot,
		],
	};

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal((await nextEvent(handle.events)).type, 'completed');
	await handle.dispose();
	assert.equal(recovered.disposeSessionCalls, 0);
});

test('intentional terminal removal does not trigger connection recovery', async () => {
	const transport = new FakeAhpTransport();
	const connections = new FakeConnectionFactory([transport]);
	const runtime = createRuntime(new FakeLauncher(), connections);
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	transport.emitRootAction({
		type: 'root/terminalsChanged',
		terminals: [{
			resource: 'ahp-terminal:/temporary',
			label: 'Temporary terminal',
			claim: { kind: 'session', session: handle.recovery.sessionUri },
		}],
	});
	await waitForCondition(() => transport.subscribedUris.includes('ahp-terminal:/temporary'));

	transport.emitRootAction({ type: 'root/terminalsChanged', terminals: [] });
	await waitForCondition(() => transport.unsubscribedUris.includes('ahp-terminal:/temporary'));
	assertCleanupOrder(transport, 'ahp-terminal:/temporary');
	assert.equal(connections.connectCalls, 1);
	await handle.dispose();
});

test('terminal subscription updates are serialized independently per connection generation', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	first.blockSubscribe('ahp-terminal:/old');
	recovered.blockReconnect();
	const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	first.emitRootAction({
		type: 'root/terminalsChanged',
		terminals: [{
			resource: 'ahp-terminal:/old',
			label: 'Old terminal',
			claim: { kind: 'session', session: handle.recovery.sessionUri },
		}],
	});
	await waitForCondition(() => first.subscribeAttempts.includes('ahp-terminal:/old'));
	recovered.reconnectResult = {
		type: 'replay',
		actions: [envelope('ahp-root://', {
			type: 'root/terminalsChanged',
			terminals: [{
				resource: 'ahp-terminal:/candidate',
				label: 'Candidate terminal',
				claim: { kind: 'session', session: handle.recovery.sessionUri },
			}],
		}, 9)],
		missing: [],
	};
	recovered.created = first.created;

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	first.failSubscribe('ahp-terminal:/old');
	recovered.releaseReconnect();
	await waitForCondition(() => recovered.subscribedUris.includes('ahp-terminal:/candidate'));
	recovered.emitChat({
		type: 'chat/delta',
		turnId: 'turn-1',
		partId: 'after-stale-terminal-error',
		content: 'still recovered',
	});
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal((await nextEvent(handle.events)).type, 'output');
	assert.equal(recovered.subscribedUris.includes('ahp-terminal:/old'), false);
	await handle.dispose();
});

test('recovery always reconciles the latest known terminals when replay has no root update', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	recovered.reconnectResult = { type: 'replay', actions: [], missing: [] };
	const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.created = first.created;
	first.blockSubscribe('ahp-terminal:/latest');
	first.emitRootAction({
		type: 'root/terminalsChanged',
		terminals: [{
			resource: 'ahp-terminal:/latest',
			label: 'Latest terminal',
			claim: { kind: 'session', session: handle.recovery.sessionUri },
		}],
	});
	await waitForCondition(() => first.subscribeAttempts.includes('ahp-terminal:/latest'));

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	await waitForCondition(() => recovered.subscribedUris.includes('ahp-terminal:/latest'));
	first.releaseSubscribe('ahp-terminal:/latest');
	await handle.dispose();
});

test('dispose cancels and awaits terminal subscription updates and cleans a late subscription', async () => {
	const transport = new FakeAhpTransport();
	transport.ignoreSubscribeAbort = true;
	const launcher = new FakeLauncher();
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	transport.blockSubscribe('ahp-terminal:/late');
	transport.emitRootAction({
		type: 'root/terminalsChanged',
		terminals: [{
			resource: 'ahp-terminal:/late',
			label: 'Late terminal',
			claim: { kind: 'session', session: handle.recovery.sessionUri },
		}],
	});
	await waitForCondition(() => transport.subscribeAttempts.includes('ahp-terminal:/late'));

	let disposed = false;
	const disposal = handle.dispose().then(() => {
		disposed = true;
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.equal(disposed, false);
	transport.releaseSubscribe('ahp-terminal:/late');
	await disposal;
	assert.equal(transport.unsubscribedUris.includes('ahp-terminal:/late'), true);
	assertCleanupOrder(transport, 'ahp-terminal:/late');
	assert.equal(launcher.host.disposed, true);
});

test('dispose fails promptly and closes the connection when a subscription pump cannot settle', async () => {
	const transport = new FakeAhpTransport();
	const launcher = new FakeLauncher();
	launcher.host.preserveTerminalSession = true;
	const lifecycle: AgentRuntimeLifecycleObservation[] = [];
	const runtime = createRuntime(
		launcher,
		new FakeConnectionFactory([transport]),
		undefined,
		undefined,
		{ observeLifecycle: (observation) => lifecycle.push(observation) },
		{ subscriptionPumpSettleTimeoutMs: 20 },
	);
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	await transport.emitChat({
		type: 'chat/turnComplete',
		turnId: currentTurnId(transport),
		duration: 0,
	});
	assert.equal((await nextEvent(handle.events)).type, 'completed');
	transport.unsubscribeDoesNotWake.add('ahp-chat:/default');

	const startedAt = Date.now();
	await assert.rejects(
		handle.dispose(),
		(error: unknown) =>
			error instanceof AgentRuntimeError
			&& error.cleanupFailed
			&& /subscription pumps/u.test(error.message),
	);
	assert.ok(Date.now() - startedAt < 500);
	assert.equal(transport.shutdownCalls, 1);
	assert.equal(launcher.host.disposed, true);
	await handle.dispose();
	assert.equal(lifecycle.some(({ eventType }) => eventType === 'session/subscriptionPumpsSettled'), false);
	assert.equal(lifecycle.some(({ eventType }) => eventType === 'session/clientDetached'), false);
});

test('runtime disposal can be retried after cleanup failure and retains task ownership', async () => {
	const transport = new FakeAhpTransport();
	const launcher = new FakeLauncher();
	launcher.host.disposeFailuresRemaining = 2;
	const runtime = createRuntime(launcher, new FakeConnectionFactory([transport]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);

	await assert.rejects(runtime.dispose(), AgentRuntimeError);
	assert.equal(launcher.host.disposed, false);
	await runtime.dispose();
	assert.equal(launcher.host.disposed, true);
	assert.equal(transport.disposeSessionCalls, 1);
	assert.equal(transport.shutdownCalls, 1);
	await handle.dispose();
});

test('authentication deduplication is scoped to each AHP connection', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	recovered.reconnectResult = { type: 'replay', actions: [], missing: [] };
	const broker = new BlockingConnectionAuthBroker();
	const runtime = createRuntime(
		new FakeLauncher(),
		new FakeConnectionFactory([first, recovered]),
		broker,
	);
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.created = first.created;

	first.emitRootAuth([protectedResource]);
	await waitForCondition(() => broker.requests.length === 2);
	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.equal(broker.requests.length, 3);
	assert.equal(first.authenticated.length, 1);
	assert.equal(recovered.authenticated.length, 1);
	broker.rejectBlocked(new AgentRuntimeError('AGENT_AUTH_REQUIRED', 'The stale connection rejected authentication.'));
	recovered.emitChat({
		type: 'chat/delta',
		turnId: 'turn-1',
		partId: 'after-stale-auth',
		content: 'recovered',
	});
	assert.equal((await nextEvent(handle.events)).type, 'output');
	assert.equal(first.authenticated.length, 1);
	assert.equal(recovered.authenticated.length, 1);
	await handle.dispose();
});

for (const authCode of ['AGENT_AUTH_REQUIRED', 'AGENT_AUTH_FAILED'] as const) {
	test(`runtime preserves ${authCode} when recovery authentication fails`, async () => {
		const first = new FakeAhpTransport();
		const recovered = new FakeAhpTransport();
		recovered.reconnectResult = { type: 'replay', actions: [], missing: [] };
		const launcher = new FakeLauncher();
		const broker = new FailingRecoveryAuthBroker(authCode);
		const runtime = createRuntime(launcher, new FakeConnectionFactory([first, recovered]), broker);
		const handle = await runtime.start(taskRequest());
		await nextEvent(handle.events);
		recovered.created = first.created;

		first.failChat();
		assert.equal((await nextEvent(handle.events)).type, 'progress');
		const failed = await nextEvent(handle.events);
		assert.equal(failed.type, 'failed');
		if (failed.type === 'failed') {
			assert.equal(failed.error.code, authCode);
		}
		assert.equal(recovered.shutdownCalls, 1);
		await handle.dispose();
	});
}

test('runtime restores undelivered response parts and completion from a reconnect snapshot', async () => {
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
		workspaceResolver: trustedWorkspaceResolver(),
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
	first.emitChat({
		type: 'chat/delta',
		turnId,
		partId: 'answer',
		content: 'Hello ',
	});
	assert.deepEqual(await nextEvent(handle.events), { type: 'output', text: 'Hello ' });
	first.emitChat({
		type: 'chat/reasoning',
		turnId,
		partId: 'reason',
		content: 'think',
	});
	assert.deepEqual(await nextEvent(handle.events), { type: 'progress', message: 'think' });
	first.emitChat({
		type: 'chat/responsePart',
		turnId,
		part: { kind: 'systemNotification', content: 'already shown' },
	});
	assert.deepEqual(await nextEvent(handle.events), { type: 'output', text: 'already shown' });
	recovered.created = first.created;
	recovered.reconnectResult = {
		type: 'snapshot',
		snapshots: [
			{
				resource: 'ahp-root://',
				fromSeq: 20,
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
			} as Snapshot,
			{
				resource: first.created!.sessionUri,
				fromSeq: 20,
				state: {
					resource: first.created!.sessionUri,
					provider: 'dynamic-provider',
					title: 'Task',
					status: 1,
					lifecycle: 'ready',
					activeClients: [],
					chats: [],
					defaultChat: 'ahp-chat:/default',
				},
			} as Snapshot,
			{
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
					responseParts: [
						{ kind: 'markdown', id: 'answer', content: 'Hello world' },
						{ kind: 'reasoning', id: 'reason', content: 'thinking' },
						{ kind: 'systemNotification', content: 'already shown' },
						{ kind: 'systemNotification', content: 'already shown' },
						{ kind: 'systemNotification', content: 'done notice' },
						{
							kind: 'toolCall',
							toolCall: {
								toolCallId: 'tool-recovered',
								toolName: 'safe_tool',
								displayName: 'Safe tool',
								status: 'completed',
								invocationMessage: 'Run safe tool',
								confirmed: 'not-needed',
								success: true,
								pastTenseMessage: 'Ran safe tool',
								content: [],
							},
						},
					],
					usage: undefined,
					state: 'complete',
				}],
			},
			} as Snapshot,
		],
	};
	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	assert.deepEqual(await nextEvent(handle.events), { type: 'output', text: 'world' });
	assert.deepEqual(await nextEvent(handle.events), { type: 'progress', message: 'ing' });
	assert.deepEqual(await nextEvent(handle.events), { type: 'output', text: 'already shown' });
	assert.deepEqual(await nextEvent(handle.events), { type: 'output', text: 'done notice' });
	assert.deepEqual(await nextEvent(handle.events), {
		type: 'tool',
		name: 'tool-recovered',
		status: 'completed',
		summary: 'Ran safe tool',
	});
	assert.deepEqual(await nextEvent(handle.events), { type: 'completed' });
	await handle.dispose();
});

test('snapshot recovery fails when the active chat snapshot is missing', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	recovered.created = first.created;
	recovered.reconnectResult = {
		type: 'snapshot',
		snapshots: [
			{ resource: 'ahp-root://', fromSeq: 10, state: {} } as Snapshot,
			{ resource: first.created!.sessionUri, fromSeq: 10, state: {} } as Snapshot,
		],
	};

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	const failed = await nextEvent(handle.events);
	assert.equal(failed.type, 'failed');
	if (failed.type === 'failed') {
		assert.equal(failed.error.code, 'TASK_RECOVERY_UNAVAILABLE');
	}
	await handle.dispose();
});

test('snapshot recovery reports the durable AHP 1.0 error response part', async () => {
	const first = new FakeAhpTransport();
	const recovered = new FakeAhpTransport();
	const runtime = createRuntime(new FakeLauncher(), new FakeConnectionFactory([first, recovered]));
	const handle = await runtime.start(taskRequest());
	await nextEvent(handle.events);
	const turnId = first.dispatched[0]?.action.turnId;
	assert.equal(typeof turnId, 'string');
	recovered.created = first.created;
	recovered.reconnectResult = {
		type: 'snapshot',
		snapshots: [
			{
				resource: 'ahp-root://',
				fromSeq: 10,
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
			} as Snapshot,
			{
				resource: first.created!.sessionUri,
				fromSeq: 10,
				state: {
					resource: first.created!.sessionUri,
					provider: 'dynamic-provider',
					title: 'Task',
					status: 2,
					lifecycle: 'ready',
					activeClients: [],
					chats: [],
					defaultChat: 'ahp-chat:/default',
				},
			} as Snapshot,
			{
				resource: 'ahp-chat:/default',
				fromSeq: 10,
				state: {
					resource: 'ahp-chat:/default',
					title: 'Recovered',
					status: 2,
					modifiedAt: new Date(0).toISOString(),
					activeTurn: undefined,
					turns: [{
						id: turnId,
						message: { text: 'safe', origin: { kind: 'user' } },
						responseParts: [{
							kind: 'error',
							error: { message: 'Durable AHP 1.0 failure.' },
						}],
						usage: undefined,
						state: 'error',
					}],
				},
			} as Snapshot,
		],
	};

	first.failChat();
	assert.equal((await nextEvent(handle.events)).type, 'progress');
	const failed = await nextEvent(handle.events);
	assert.equal(failed.type, 'failed');
	if (failed.type === 'failed') {
		assert.equal(failed.error.message, 'Durable AHP 1.0 failure.');
	}
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

test('editor identity broker skips initial token injection and runs with the host identity', async () => {
	const transport = new FakeAhpTransport();
	transport.completeAfterTurnDispatch = true;
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher: new FakeLauncher(),
		connections: new FakeConnectionFactory([transport]),
		authBroker: new EditorExistingIdentityAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
		configResolver: { resolve: async () => ({ model: 'test-model' }) },
	});

	const handle = await runtime.start(taskRequest());
	const events = [];
	for await (const event of handle.events) {
		events.push(event);
	}
	assert.equal(transport.initialized, true);
	assert.ok(transport.created);
	assert.deepEqual(transport.authenticated, []);
	assert.equal(events.at(-1)?.type, 'completed');
	await handle.dispose();
});

test('editor identity broker fails closed on challenges without pushing credentials', async () => {
	const broker = new EditorExistingIdentityAuthBroker();
	let pushes = 0;
	await broker.authenticate(
		{ resources: [protectedResource], interactive: true, reason: 'initial' },
		async () => {
			pushes += 1;
		},
	);
	assert.equal(pushes, 0);

	for (const reason of ['challenge', 'tokenInvalid'] as const) {
		await assert.rejects(
			broker.authenticate(
				{ resources: [protectedResource], interactive: true, reason },
				async () => {
					pushes += 1;
				},
			),
			(error: unknown) => error instanceof AgentRuntimeError
				&& error.code === 'AGENT_AUTH_REQUIRED'
				&& error.message === 'Authenticate the Agent Host in the selected editor profile before retrying.'
				&& !error.message.includes(protectedResource.resource),
		);
	}
	assert.equal(pushes, 0);

	const abort = new AbortController();
	abort.abort();
	await assert.rejects(
		broker.authenticate(
			{
				resources: [protectedResource],
				interactive: false,
				reason: 'initial',
				signal: abort.signal,
			},
			async () => {
				pushes += 1;
			},
		),
		(error: unknown) => error instanceof DOMException && error.name === 'AbortError',
	);
	assert.equal(pushes, 0);
});

test('editor runtime reports createSession authentication challenges without token injection', async () => {
	const transport = new FakeAhpTransport();
	transport.createSessionAuthRequired = true;
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher: new FakeLauncher(),
		connections: new FakeConnectionFactory([transport]),
		authBroker: new EditorExistingIdentityAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
		configResolver: { resolve: async () => ({ model: 'test-model' }) },
	});

	await assert.rejects(
		runtime.start(taskRequest()),
		(error: unknown) => error instanceof AgentRuntimeError
			&& error.code === 'AGENT_AUTH_REQUIRED'
			&& error.message === 'Authenticate the Agent Host in the selected editor profile before retrying.',
	);
	assert.equal(transport.initialized, true);
	assert.deepEqual(transport.authenticated, []);
	assert.equal(transport.createSessionCalls, 1);
	await runtime.dispose();
});

test('VS Code auth broker aborts an in-flight authentication prompt without submitting a token', async () => {
	const abort = new AbortController();
	let submitted = false;
	const broker = new VscodeAuthBroker(
		{
			getSession: () => new Promise(() => undefined),
		},
		() => ({ providerId: 'configured-provider', scopes: ['agent:run'] }),
	);
	const authentication = broker.authenticate(
		{
			resources: [protectedResource],
			interactive: true,
			reason: 'tokenInvalid',
			signal: abort.signal,
		},
		async () => {
			submitted = true;
		},
	);
	abort.abort();
	await assert.rejects(authentication, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
	assert.equal(submitted, false);
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

test('delegated Agent sessions contribute no Mesh tools', () => {
	assert.deepEqual(DELEGATED_AGENT_CLIENT_TOOLS, []);
	for (const meshTool of Object.values(MESH_TOOL_NAMES)) {
		assert.equal(DELEGATED_AGENT_CLIENT_TOOLS.includes(meshTool as never), false);
	}
});

test('event mapper retains only structured file confirmation evidence', () => {
	const mapper = new AhpEventMapper();
	mapper.map(envelope('ahp-chat:/default', {
		type: 'chat/toolCallStart',
		turnId: 'turn-1',
		toolCallId: 'tool-1',
		toolName: 'write_file',
		displayName: 'Write File',
	}, 10));
	const [event] = mapper.map(envelope('ahp-chat:/default', {
		type: 'chat/toolCallReady',
		turnId: 'turn-1',
		toolCallId: 'tool-1',
		invocationMessage: 'Write a file',
		toolInput: '{"path":"/sensitive/raw/path"}',
		riskAssessment: {
			kind: 'model',
			status: 'complete',
			reason: 'Untrusted prose',
			safety: 1,
		},
		edits: {
			items: [{
				after: {
					uri: 'file:///workspace/new.ts',
					content: { uri: 'ahp-content:/after' },
				},
			}],
		},
	}, 11));
	assert.equal(event?.type, 'inputRequired');
	if (event?.type !== 'inputRequired') {
		return;
	}
	assert.deepEqual(event.request.confirmationEvidence, {
		phase: 'operation',
		toolName: 'write_file',
		fileEdits: [{ afterUri: 'file:///workspace/new.ts' }],
	});
	assert.equal(JSON.stringify(event.request).includes('/sensitive/raw/path'), false);
	assert.equal(JSON.stringify(event.request).includes('Untrusted prose'), false);

	const mapperWithoutStart = new AhpEventMapper();
	const [unknown] = mapperWithoutStart.map(envelope('ahp-chat:/default', {
		type: 'chat/toolCallReady',
		turnId: 'turn-1',
		toolCallId: 'tool-1',
		invocationMessage: 'Write a file',
		edits: { items: [] },
	}, 12));
	assert.equal(
		unknown?.type === 'inputRequired'
			? unknown.request.confirmationEvidence
			: 'unexpected',
		undefined,
	);
});

test('event mapper accepts AHP 1.0 and 0.8 turn error shapes', () => {
	const mapper = new AhpEventMapper();
	const actions = [
		{
			type: 'chat/error',
			turnId: 'turn-1',
			duration: 1,
			part: { kind: 'error', error: { message: 'AHP 1.0 failure.' } },
		},
		{
			type: 'chat/error',
			turnId: 'turn-2',
			duration: 1,
			error: { message: 'AHP 0.8 failure.' },
		},
	];
	for (const [index, action] of actions.entries()) {
		const [mapped] = mapper.map(envelope('ahp-chat:/default', action, 12 + index));
		assert.equal(mapped?.type, 'failed');
		if (mapped?.type === 'failed') {
			assert.equal(mapped.error.message, index === 0 ? 'AHP 1.0 failure.' : 'AHP 0.8 failure.');
		}
	}
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

test('event mapper enforces text input minimum and maximum lengths', () => {
		for (const value of ['a', 'toolong']) {
			const mapper = new AhpEventMapper();
			const [event] = mapper.map(envelope('ahp-chat:/default', {
				type: 'chat/inputRequested',
				request: {
					id: `text-${value}`,
					message: 'Text',
					questions: [{
						id: 'text',
						message: 'Text',
						kind: 'text',
						required: true,
						min: 2,
						max: 4,
					}],
				},
			}, 15));
			assert.equal(event?.type, 'inputRequired');
			if (event?.type === 'inputRequired') {
				assert.throws(
					() => mapper.createAnswer({
						requestId: event.request.requestId,
						outcome: 'accept',
						values: { text: value },
					}),
					(error: unknown) => error instanceof AgentRuntimeError,
				);
			}
		}
});

for (const outcome of ['decline', 'cancel'] as const) {
		test(`event mapper allows ${outcome} without required structured answers`, () => {
			const mapper = new AhpEventMapper();
			const [event] = mapper.map(envelope('ahp-chat:/default', {
				type: 'chat/inputRequested',
				request: {
					id: `structured-${outcome}`,
					message: 'Required question',
					questions: [{ id: 'required', message: 'Required', kind: 'text', required: true }],
				},
			}, 15));
			assert.equal(event?.type, 'inputRequired');
			if (event?.type !== 'inputRequired') {
				return;
			}
			assert.deepEqual(mapper.createAnswer({
				requestId: event.request.requestId,
				outcome,
			}), {
				channel: 'ahp-chat:/default',
				requestId: `structured-${outcome}`,
				action: {
					type: 'chat/inputCompleted',
					requestId: `structured-${outcome}`,
					response: outcome,
					answers: undefined,
				},
			});
		});
}

function createRuntime(
		launcher: FakeLauncher,
		connections: AhpConnectionFactory,
		authBroker: AuthBroker = new RecordingAuthBroker(),
		delegatedToolInvocations?: DelegatedToolInvocationRegistry,
		lifecycleObserver?: AgentRuntimeLifecycleObserver,
		timeouts?: {
			readonly cancellationTimeoutMs?: number;
			readonly terminalSessionMaterializationTimeoutMs?: number;
			readonly subscriptionPumpSettleTimeoutMs?: number;
		},
): AhpAgentRuntime {
		return new AhpAgentRuntime({
			enabled: () => true,
			launcher,
			connections,
			authBroker,
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: trustedWorkspaceResolver(),
		configResolver: { resolve: async () => ({ model: 'test-model' }) },
		cancellationTimeoutMs: timeouts?.cancellationTimeoutMs ?? 100,
		terminalSessionMaterializationTimeoutMs: timeouts?.terminalSessionMaterializationTimeoutMs,
		subscriptionPumpSettleTimeoutMs: timeouts?.subscriptionPumpSettleTimeoutMs,
		delegatedToolInvocations,
		lifecycleObserver,
	});
}

function sourceRuntime(
	launcher: AgentHostLauncherLike,
	connections: AhpConnectionFactory,
	confirmation: FirstTaskConfirmation,
	approvalCapabilities: AgentRuntimeApprovalCapabilityIssuer,
): AhpAgentRuntime {
	return new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections,
		authBroker: new RecordingAuthBroker(),
		confirmation,
		approvalCapabilities,
		workspaceResolver: trustedWorkspaceResolver(),
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
		workspaceId: 'workspace-1',
	};
}

function trustedWorkspaceResolver() {
	return {
		resolve: async (workspaceId: string) => workspaceId === 'workspace-1'
			? { workspaceId, displayName: 'Safe Workspace', uri: workspaceUri }
			: undefined,
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

class FailingAuthBroker implements AuthBroker {
	constructor(private readonly code: Extract<AgentRuntimeErrorCode, 'AGENT_AUTH_REQUIRED' | 'AGENT_AUTH_FAILED'>) {}

	async authenticate(): Promise<void> {
		throw new AgentRuntimeError(this.code, 'Authentication could not be completed.');
	}
}

class FailingRecoveryAuthBroker implements AuthBroker {
	private initial = true;

	constructor(private readonly code: Extract<AgentRuntimeErrorCode, 'AGENT_AUTH_REQUIRED' | 'AGENT_AUTH_FAILED'>) {}

	async authenticate(
		request: AuthenticationRequest,
		pushToken: (resource: string, token: string, scopes: readonly string[]) => Promise<void>,
	): Promise<void> {
		if (!this.initial && request.reason === 'tokenInvalid') {
			throw new AgentRuntimeError(this.code, 'Recovery authentication could not be completed.');
		}
		this.initial = false;
		for (const resource of request.resources.filter(({ required }) => required !== false)) {
			await pushToken(resource.resource, 'test-token', resource.scopes_supported ?? []);
		}
	}
}

class BlockingConnectionAuthBroker implements AuthBroker {
	readonly requests: AuthenticationRequest[] = [];
	private release: (() => void) | undefined;
	private reject: ((error: Error) => void) | undefined;

	async authenticate(
		request: AuthenticationRequest,
		pushToken: (resource: string, token: string, scopes: readonly string[]) => Promise<void>,
	): Promise<void> {
		this.requests.push(request);
		if (this.requests.length === 2) {
			await new Promise<void>((resolve, reject) => {
				this.release = resolve;
				this.reject = reject;
				request.signal?.addEventListener(
					'abort',
					() => reject(new DOMException('Stale authentication aborted.', 'AbortError')),
					{ once: true },
				);
			});
		}

		for (const resource of request.resources.filter(({ required }) => required !== false)) {
			await pushToken(resource.resource, 'test-token', resource.scopes_supported ?? []);
		}
	}

	releaseBlocked(): void {
		this.release?.();
	}

	rejectBlocked(error: Error): void {
		this.reject?.(error);
	}
}

class AbortableRecoveryAuthBroker implements AuthBroker {
	recoveryStarted = false;
	recoveryAborted = false;

	async authenticate(
		request: AuthenticationRequest,
		pushToken: (resource: string, token: string, scopes: readonly string[]) => Promise<void>,
	): Promise<void> {
		if (request.reason === 'tokenInvalid') {
			this.recoveryStarted = true;
			await new Promise<void>((_resolve, reject) => {
				const handleAbort = () => {
					this.recoveryAborted = true;
					reject(new DOMException('Authentication aborted.', 'AbortError'));
				};
				request.signal?.addEventListener('abort', handleAbort, { once: true });
			});
			return;
		}
		for (const resource of request.resources.filter(({ required }) => required !== false)) {
			await pushToken(resource.resource, 'test-token', resource.scopes_supported ?? []);
		}
	}
}

class LateTokenAuthBroker implements AuthBroker {
	notificationStarted = false;
	latePushRejected = false;

	async authenticate(
		request: AuthenticationRequest,
		pushToken: (resource: string, token: string, scopes: readonly string[]) => Promise<void>,
	): Promise<void> {
		if (request.reason !== 'tokenInvalid') {
			for (const resource of request.resources.filter(({ required }) => required !== false)) {
				await pushToken(resource.resource, 'test-token', resource.scopes_supported ?? []);
			}
			return;
		}
		this.notificationStarted = true;
		await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
		try {
			await pushToken(protectedResource.resource, 'late-token', protectedResource.scopes_supported ?? []);
		} catch {
			this.latePushRejected = true;
		}
	}
}

class FakeLauncher implements AgentHostLauncherLike {
	readonly host = new FakeHost();
	launchCalls = 0;

	async probe(): Promise<AgentHostProbe> {
		return { available: true, executable: '/safe/code', version: '1.134.0' };
	}

	async launch(): Promise<LaunchedAgentHost> {
		this.launchCalls += 1;
		return this.host;
	}

	async dispose(): Promise<void> {
		await this.host.dispose();
	}
}

class FailingLauncher implements AgentHostLauncherLike {
	public async probe(): Promise<AgentHostProbe> {
		return { available: false };
	}

	public async launch(): Promise<LaunchedAgentHost> {
		throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'Synthetic source failure.');
	}

	public async dispose(): Promise<void> {}
}

class FakeHost implements LaunchedAgentHost {
	readonly endpoint = new URL('ws://127.0.0.1:1234/?tkn=not-a-real-token');
	readonly version = '1.134.0';
	registryProtocolVersion = '0.1.0';
	source: 'editor' | 'standalone' | undefined;
	preserveTerminalSession = false;
	disposed = false;
	disposeFailuresRemaining = 0;
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
		if (this.disposeFailuresRemaining > 0) {
			this.disposeFailuresRemaining -= 1;
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'Synthetic host cleanup failure.', false, undefined, true);
		}
		this.disposed = true;
	}
}

class FakeConnectionFactory implements AhpConnectionFactory {
	connectCalls = 0;

	constructor(private readonly transports: FakeAhpTransport[]) {}

	async connect(): Promise<AhpConnection> {
		this.connectCalls += 1;
		const transport = this.transports.shift();
		assert.ok(transport, 'Expected another fake AHP transport.');
		return transport;
	}
}

class FakeAhpHostCatalog {
	private readonly sessions = new Map<string, {
		status: number;
		activeClients: Set<string>;
		materialized: boolean;
		activeTurnId?: string;
	}>();

	create(sessionUri: string, clientId: string): void {
		this.sessions.set(sessionUri, {
			status: 1,
			activeClients: new Set([clientId]),
			materialized: false,
		});
	}

	record(sessionUri: string, action: Record<string, unknown>): void {
		const session = this.sessions.get(sessionUri);
		if (session === undefined) {
			return;
		}
		if (action.type === 'chat/turnStarted' && typeof action.turnId === 'string') {
			session.activeTurnId = action.turnId;
			session.status = 8;
			return;
		}
		if (
			(
				action.type === 'chat/turnComplete'
				|| action.type === 'chat/turnCancelled'
				|| action.type === 'chat/error'
			)
			&& action.turnId === session.activeTurnId
		) {
			session.activeTurnId = undefined;
			session.status = action.type === 'chat/error' ? 2 : 1;
			session.materialized = true;
			return;
		}
		if (
			action.type === 'session/activeClientRemoved'
			&& typeof action.clientId === 'string'
		) {
			session.activeClients.delete(action.clientId);
		}
	}

	removeClient(sessionUri: string, clientId: string): void {
		this.sessions.get(sessionUri)?.activeClients.delete(clientId);
	}

	dispose(sessionUri: string): void {
		this.sessions.delete(sessionUri);
	}

	list(): readonly { readonly resource: string; readonly status: number }[] {
		return [...this.sessions]
			.filter(([, session]) => session.materialized && session.activeClients.size === 0)
			.map(([resource, session]) => ({ resource, status: session.status }));
	}

	addMaterialized(resource: string, status = 1): void {
		this.sessions.set(resource, {
			status,
			activeClients: new Set(),
			materialized: true,
		});
	}

	session(sessionUri: string): {
		readonly status: number;
		readonly activeClientCount: number;
		readonly materialized: boolean;
	} | undefined {
		const session = this.sessions.get(sessionUri);
		return session === undefined
			? undefined
			: {
				status: session.status,
				activeClientCount: session.activeClients.size,
				materialized: session.materialized,
			};
	}
}

class FakeAhpTransport implements AhpConnection {
	protocolPolicy: AhpProtocolPolicy = { offer: AHP_PROTOCOL_OFFER };
	initialized = false;
	initializedClientId = '';
	ackDispatches = true;
	rejectDispatchType: string | undefined;
	selectedProtocolVersion = '1.0.0';
	nextClientSeq = 1;
	authenticated: Array<{ resource: string; token: string; scopes: readonly string[] }> = [];
	created: {
		sessionUri: string;
		provider: string;
		workingDirectories: readonly string[];
		config: Readonly<Record<string, unknown>>;
		clientId: string;
	} | undefined;
	dispatched: Array<{ channel: string; action: Record<string, unknown>; clientSeq: number }> = [];
	reconnectResult: Awaited<ReturnType<AhpConnection['reconnect']>> = {
		type: 'snapshot',
		snapshots: [],
	};
	readonly reconnectRequests: Array<{
		readonly clientId: string;
		readonly lastSeenServerSeq: number;
		readonly subscriptions: readonly string[];
	}> = [];
	iterativeConfig = false;
	completeAfterChatSubscribe = false;
	completeAfterTurnDispatch = false;
	ignoreSubscribeAbort = false;
	sessionStartsPending = false;
	sessionStartsProvisional = false;
	sessionCreationFailed = false;
	sessionSnapshotResource: string | undefined;
	createSessionAuthRequired = false;
	createSessionCalls = 0;
	sessionDefaultChat = 'ahp-chat:/default';
	blockSessionSubscriptions = false;
	notificationDuringInitialize: readonly ProtectedResource[] = [];
	rootAttachedBeforeInitialize = false;
	disposeSessionCalls = 0;
	shutdownCalls = 0;

	assertActionSupported(action: unknown, selected: '1.0.0' | '0.9.0'): void {
		assertOutboundAhpActionSupported(
			action,
			selected,
			(_action, version) => version === '1.0.0'
				|| (typeof action === 'object'
					&& action !== null
					&& 'type' in action
					&& action.type !== 'chat/turnResume'),
		);
	}
	shutdownFails = false;
	listSessionsCalls = 0;
	catalogOmissionsRemaining = 0;
	catalogFailuresRemaining = 0;
	catalogPageSize = 200;
	catalogDefaultPageSize = 200;
	catalogCursorCycle = false;
	rejectCatalogLimit = false;
	hideCatalog = false;
	blockNextSessionUnsubscribe = false;
	private resolveSessionUnsubscribeStarted!: () => void;
	readonly sessionUnsubscribeStarted = new Promise<void>((resolve) => {
		this.resolveSessionUnsubscribeStarted = resolve;
	});
	readonly unsubscribeFailures = new Map<string, number>();
	failRootDuringConfig = false;
	resolveConfigCalls = 0;
	readonly subscribedUris: string[] = [];
	readonly completionQueries: string[] = [];
	readonly unsubscribedUris: string[] = [];
	readonly cleanupOperations: string[] = [];
	readonly unsubscribeDoesNotWake = new Set<string>();
	private readonly attachedUris = new Set<string>();
	private readonly queues = new Map<string, FakeSubscription>();
	private reconnectRelease: (() => void) | undefined;
	private reconnectReject: ((error: Error) => void) | undefined;
	private reconnectBarrier: Promise<void> | undefined;
	private readonly subscribeBarriers = new Map<string, {
		readonly promise: Promise<void>;
		readonly release: () => void;
		readonly reject: (error: Error) => void;
	}>();
	readonly subscribeAttempts: string[] = [];
	private shutdownComplete = false;

	constructor(private readonly hostCatalog?: FakeAhpHostCatalog) {}

	async initialize(clientId: string): Promise<Awaited<ReturnType<AhpConnection['initialize']>>> {
		this.assertOpen();
		this.initialized = true;
		this.initializedClientId = clientId;
		this.rootAttachedBeforeInitialize = this.attachedUris.has('ahp-root://');
		if (this.notificationDuringInitialize.length > 0 && this.rootAttachedBeforeInitialize) {
			this.queue('ahp-root://').push({
				type: 'authRequired',
				params: { resources: this.notificationDuringInitialize },
			});
		}
		return {
			protocolVersion: this.selectedProtocolVersion,
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

	async reconnect(
		clientId: string,
		lastSeenServerSeq: number,
		subscriptions: readonly string[],
	): Promise<Awaited<ReturnType<AhpConnection['reconnect']>>> {
		this.assertOpen();
		this.initializedClientId = clientId;
		this.reconnectRequests.push({ clientId, lastSeenServerSeq, subscriptions: [...subscriptions] });
		await this.reconnectBarrier;
		return this.reconnectResult;
	}

	blockReconnect(): void {
		this.reconnectBarrier = new Promise<void>((resolve, reject) => {
			this.reconnectRelease = resolve;
			this.reconnectReject = reject;
		});
	}

	releaseReconnect(): void {
		this.reconnectRelease?.();
		this.reconnectBarrier = undefined;
	}

	blockSubscribe(uri: string): void {
		let release: () => void = () => undefined;
		let rejectBarrier: (error: Error) => void = () => undefined;
		const promise = new Promise<void>((resolve, reject) => {
			release = resolve;
			rejectBarrier = reject;
		});
		this.subscribeBarriers.set(uri, { promise, release, reject: rejectBarrier });
	}

	releaseSubscribe(uri: string): void {
		this.subscribeBarriers.get(uri)?.release();
		this.subscribeBarriers.delete(uri);
	}

	failSubscribe(uri: string): void {
		this.subscribeBarriers.get(uri)?.reject(new Error('stale terminal subscription failed'));
		this.subscribeBarriers.delete(uri);
	}

	attachSubscription(uri: string): AhpSubscription {
		this.assertOpen();
		this.attachedUris.add(uri);
		return this.queue(uri);
	}

	async subscribe(uri: string, signal?: AbortSignal): Promise<{
		readonly snapshot?: Snapshot;
		readonly subscription: AhpSubscription;
	}> {
		this.assertOpen();
		this.subscribeAttempts.push(uri);
		if (this.blockSessionSubscriptions && uri.startsWith('ahp-session:') && !this.subscribeBarriers.has(uri)) {
			this.blockSubscribe(uri);
		}
		const barrier = this.subscribeBarriers.get(uri);
		const handleAbort = () => barrier?.reject(new DOMException('Subscription aborted.', 'AbortError'));
		if (!this.ignoreSubscribeAbort) {
			signal?.addEventListener('abort', handleAbort, { once: true });
		}
		try {
			await barrier?.promise;
		} finally {
			if (!this.ignoreSubscribeAbort) {
				signal?.removeEventListener('abort', handleAbort);
			}
		}
		this.subscribedUris.push(uri);
		if (uri.startsWith('ahp-session:')) {
			const resource = this.sessionSnapshotResource ?? uri;
			return {
				snapshot: {
					resource,
					fromSeq: 2,
					state: {
						resource,
						provider: 'dynamic-provider',
						title: 'Task',
						status: 1,
						lifecycle: this.sessionCreationFailed
							? 'creationFailed'
							: this.sessionStartsPending || this.sessionStartsProvisional
								? 'creating'
								: 'ready',
						...(this.sessionCreationFailed
							? { creationError: { message: 'Legacy Session creation failed.' } }
							: {}),
						activeClients: [],
						chats: [],
						defaultChat: this.sessionStartsPending ? undefined : this.sessionDefaultChat,
					},
				} as Snapshot,
				subscription: this.queue(uri),
			};
		}
		if (this.completeAfterChatSubscribe && uri.startsWith('ahp-chat:')) {
			queueMicrotask(() => this.emitChat({
				type: 'chat/turnComplete',
				turnId: 'premature-turn',
				duration: 0,
			}));
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
		this.assertOpen();
		this.authenticated.push({ resource, token, scopes });
	}

	async resolveSessionConfig(
		_provider: string,
		_workingDirectory: string,
		config: Readonly<Record<string, unknown>>,
	): Promise<{ readonly schema: SessionConfigSchema; readonly values: Record<string, unknown> }> {
		this.assertOpen();
		this.resolveConfigCalls += 1;
		if (this.failRootDuringConfig) {
			this.failRootDuringConfig = false;
			this.queue('ahp-root://').fail(new Error('startup transport closed'));
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
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

	async sessionConfigCompletions(
		_provider: string,
		_workingDirectory: string,
		_config: Readonly<Record<string, unknown>>,
		_property: string,
		query: string,
	): Promise<readonly { readonly value: string; readonly label: string }[]> {
		this.assertOpen();
		this.completionQueries.push(query);
		return [{ value: 'test-model', label: 'Test Model' }];
	}

	async createSession(params: NonNullable<FakeAhpTransport['created']>): Promise<void> {
		this.assertOpen();
		this.createSessionCalls += 1;
		if (this.createSessionAuthRequired) {
			throw Object.assign(new Error('Authentication required.'), {
				code: -32007,
				data: { resources: [protectedResource] },
			});
		}
		this.created = params;
		this.hostCatalog?.create(params.sessionUri, params.clientId);
	}

	async listSessions(limit?: number, cursor?: string): Promise<{
		readonly items: readonly {
			readonly resource: string;
			readonly status?: number;
		}[];
		readonly nextCursor?: string;
	}> {
		this.assertOpen();
		this.listSessionsCalls += 1;
		if (this.rejectCatalogLimit && limit !== undefined) {
			throw Object.assign(new Error('synthetic Host internal error'), { code: -32603 });
		}
		if (this.catalogFailuresRemaining > 0) {
			this.catalogFailuresRemaining -= 1;
			throw new Error('synthetic catalog failure');
		}
		if (this.catalogOmissionsRemaining > 0) {
			this.catalogOmissionsRemaining -= 1;
			return { items: [] };
		}
		const sessions = this.hideCatalog
			? []
			: this.hostCatalog !== undefined
			? this.hostCatalog.list()
			: this.created === undefined ? [] : [{ resource: this.created.sessionUri, status: 1 }];
		const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
		const pageSize = Math.min(limit ?? this.catalogDefaultPageSize, this.catalogPageSize);
		const items = sessions.slice(offset, offset + pageSize);
		const nextOffset = offset + items.length;
		return {
			items,
			...(nextOffset < sessions.length
				? { nextCursor: this.catalogCursorCycle ? cursor ?? '0' : String(nextOffset) }
				: {}),
		};
	}

	dispatch(channel: string, action: unknown, clientSeq?: number): number {
		this.assertOpen();
		assert.equal(typeof action, 'object');
		assert.ok(action);
		const record = action as Record<string, unknown>;
		const sequence = clientSeq ?? this.nextClientSeq++;
		this.nextClientSeq = Math.max(this.nextClientSeq, sequence + 1);
		this.dispatched.push({ channel, action: record, clientSeq: sequence });
		if (this.ackDispatches) {
			const origin = {
				clientId: this.initializedClientId,
				clientSeq: sequence,
			};
			if (record.type === this.rejectDispatchType) {
				this.queue(channel).push({
					type: 'action',
					params: {
						...envelope(channel, record, 4, origin),
						rejectionReason: 'Synthetic rejection.',
					},
				});
			} else {
				this.emit(channel, record, origin);
			}
		}
		if (this.completeAfterTurnDispatch && record.type === 'chat/turnStarted') {
			queueMicrotask(() => this.emitChat({
				type: 'chat/turnComplete',
				turnId: record.turnId,
				duration: 0,
			}));
		}
		return sequence;
	}

	async unsubscribe(uri: string): Promise<void> {
		this.assertOpen();
		if (uri === this.created?.sessionUri && this.blockNextSessionUnsubscribe) {
			this.blockNextSessionUnsubscribe = false;
			this.queue(uri).finish();
			this.resolveSessionUnsubscribeStarted();
			await new Promise<void>(() => undefined);
		}
		const failures = this.unsubscribeFailures.get(uri) ?? 0;
		if (failures > 0) {
			this.unsubscribeFailures.set(uri, failures - 1);
			throw new Error('synthetic unsubscribe failure');
		}
		this.unsubscribedUris.push(uri);
		this.cleanupOperations.push(`unsubscribe:${uri}`);
		if (!this.unsubscribeDoesNotWake.has(uri)) {
			this.queue(uri).finish();
		}
	}

	async disposeSession(uri: string): Promise<void> {
		this.assertOpen();
		this.disposeSessionCalls += 1;
		this.hostCatalog?.dispose(uri);
	}

	async shutdown(): Promise<void> {
		this.shutdownCalls += 1;
		this.reconnectReject?.(new Error('connection shut down'));
		for (const queue of this.queues.values()) {
			queue.finish();
		}
		if (this.shutdownFails) {
			throw new Error('synthetic shutdown failure');
		}
		this.shutdownComplete = true;
	}

	private assertOpen(): void {
		assert.equal(this.shutdownComplete, false, 'AHP request was issued after connection shutdown.');
	}

	emitChat(action: Record<string, unknown>): Promise<boolean> {
		return this.emit('ahp-chat:/default', action);
	}

	emitSession(action: Record<string, unknown>): Promise<boolean> {
		assert.ok(this.created);
		return this.emit(this.created.sessionUri, action);
	}

	emitRootAuth(resources: readonly ProtectedResource[]): Promise<boolean> {
		return this.queue('ahp-root://').push({
			type: 'authRequired',
			params: { resources },
		});
	}

	emitRootAction(action: Record<string, unknown>): Promise<boolean> {
		return this.emit('ahp-root://', action);
	}

	acknowledgeDispatch(type: string): Promise<boolean> {
		const dispatched = [...this.dispatched].reverse().find(({ action }) => action.type === type);
		assert.ok(dispatched, `Expected a dispatched ${type} action.`);
		return this.emit(dispatched.channel, dispatched.action, {
			clientId: this.initializedClientId,
			clientSeq: dispatched.clientSeq,
		});
	}

	failChat(): void {
		this.queue('ahp-chat:/default').fail(new Error('transport closed'));
	}

	failRoot(): void {
		this.queue('ahp-root://').fail(new Error('transport closed'));
	}

	private emit(
		channel: string,
		action: Record<string, unknown>,
		origin?: { readonly clientId: string; readonly clientSeq: number },
	): Promise<boolean> {
		if (channel.startsWith('ahp-chat:') && this.created !== undefined) {
			this.hostCatalog?.record(this.created.sessionUri, action);
		} else if (channel === this.created?.sessionUri) {
			this.hostCatalog?.record(channel, action);
		}
		return this.queue(channel).push({
			type: 'action',
			params: envelope(channel, action, 4, origin),
		});
	}

	private queue(uri: string): FakeSubscription {
		let queue = this.queues.get(uri);
		if (queue === undefined) {
			queue = new FakeSubscription(() => {
				this.cleanupOperations.push(`close:${uri}`);
			});
			this.queues.set(uri, queue);
		}
		return queue;
	}
}

function currentTurnId(transport: FakeAhpTransport): string {
	const turnStarted = transport.dispatched.find(({ action }) => action.type === 'chat/turnStarted');
	if (typeof turnStarted?.action.turnId !== 'string') {
		assert.fail('Expected a dispatched Agent Host turn.');
	}
	return turnStarted.action.turnId;
}

class FakeSubscription implements AhpSubscription {
	private readonly values: AhpSubscriptionEvent[] = [];
	private waiter: {
		resolve: (result: IteratorResult<AhpSubscriptionEvent>) => void;
		reject: (error: Error) => void;
	} | undefined;
	private failure: Error | undefined;
	private closed = false;
	private detached = false;

	constructor(private readonly didClose: () => void) {}

	push(event: AhpSubscriptionEvent): Promise<boolean> {
		if (this.closed) {
			return Promise.resolve(false);
		}
		const waiter = this.waiter;
		if (waiter !== undefined) {
			this.waiter = undefined;
			waiter.resolve({ done: false, value: event });
		} else {
			this.values.push(event);
		}
		return Promise.resolve(true);
	}

	fail(error: Error): void {
		this.failure = error;
		this.finish();
	}

	finish(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const waiter = this.waiter;
		this.waiter = undefined;
		if (waiter !== undefined && !this.detached) {
			if (this.failure !== undefined) {
				waiter.reject(this.failure);
			} else {
				waiter.resolve({ done: true, value: undefined });
			}
		}
	}

	async close(): Promise<void> {
		this.didClose();
		this.detached = true;
		// Match the pinned SDK: return() detaches the cursor without resolving
		// an already parked next().
		this.waiter = undefined;
	}

	[Symbol.asyncIterator](): AsyncIterator<AhpSubscriptionEvent> {
		return {
			next: () => {
				if (this.detached) {
					return Promise.resolve({ done: true, value: undefined });
				}
				const value = this.values.shift();
				if (value !== undefined) {
					return Promise.resolve({ done: false, value });
				}
				if (this.failure !== undefined) {
					return Promise.reject(this.failure);
				}
				if (this.closed) {
					return Promise.resolve({ done: true, value: undefined });
				}
				return new Promise<IteratorResult<AhpSubscriptionEvent>>((resolve, reject) => {
					this.waiter = { resolve, reject };
				});
			},
		};
	}
}

function assertCleanupOrder(transport: FakeAhpTransport, uri: string): void {
	const unsubscribe = transport.cleanupOperations.indexOf(`unsubscribe:${uri}`);
	const close = transport.cleanupOperations.indexOf(`close:${uri}`);
	assert.notEqual(unsubscribe, -1, `Expected ${uri} to be unsubscribed.`);
	assert.notEqual(close, -1, `Expected ${uri} iterator to be closed.`);
	assert.ok(unsubscribe < close, `Expected ${uri} unsubscribe before iterator close.`);
}

function envelope(
	channel: string,
	action: Record<string, unknown>,
	serverSeq: number,
	origin?: { readonly clientId: string; readonly clientSeq: number },
): ActionEnvelope {
	return {
		channel,
		action,
		serverSeq,
		origin,
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

async function waitForCondition(condition: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!await condition()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for condition.');
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
	}
}
