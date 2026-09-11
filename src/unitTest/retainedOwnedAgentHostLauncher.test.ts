import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import type WebSocket from 'ws';

import type { AgentHostLauncherLike, LaunchedAgentHost } from '../agentHost/AgentHostLauncher';
import { AgentRuntimeError, type AgentHostSource } from '../agentHost/AgentRuntime';
import { RetainedOwnedAgentHostLauncher } from '../agentHost/RetainedOwnedAgentHostLauncher';

test('retained owned launcher probes without starting a Host', async (t) => {
	const native = new TestLauncher();
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	t.after(() => launcher.dispose());
	assert.equal((await launcher.probe()).available, true);
	assert.equal(native.probeCalls, 1);
	assert.equal(native.launchCalls, 0);
	assert.equal(launcher.hasLiveHost, false);
});

test('concurrent owned launches coalesce into independent leases with a stable Host fingerprint', async (t) => {
	const native = new TestLauncher();
	native.launchBarrier = deferred();
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	t.after(() => launcher.dispose());
	const pending = [launcher.launch(), launcher.launch(), launcher.launch()];
	await native.launchStarted.promise;
	assert.equal(native.launchCalls, 1);
	native.launchBarrier.resolve();
	const leases = await Promise.all(pending);
	assert.equal(new Set(leases).size, 3);
	assert.equal(new Set(leases.map((lease) => lease.endpointFingerprint)).size, 1);
	for (const lease of leases) {
		assert.equal(lease.source, 'codespace-owned');
		assert.equal(lease.preserveTerminalSession, true);
		assert.equal(lease.version, native.host.version);
		assert.equal(lease.registryProtocolVersion, native.host.registryProtocolVersion);
		assert.equal(lease.endpoint.href, native.host.endpoint.href);
		assert.match(lease.endpointFingerprint!, /^[0-9a-f]{64}$/u);
		assert.equal(lease.openWebSocket, undefined);
	}
	assert.equal(launcher.hasLiveHost, true);
	await Promise.all(leases.map((lease) => lease.dispose()));
	assert.equal(native.host.disposeCalls, 0);
	assert.equal(native.disposeCalls, 0);
	assert.equal((await launcher.probe()).available, true);
	assert.equal(native.probeCalls, 0);
	const later = await launcher.launch();
	assert.equal(later.endpointFingerprint, leases[0].endpointFingerprint);
	assert.equal(native.launchCalls, 1);
});

test('releasing a completed-task lease preserves the Host and owner disposal cleans it exactly once', async () => {
	const native = new TestLauncher();
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	const lease = await launcher.launch();
	await lease.dispose();
	await lease.dispose();
	assert.equal(native.host.disposeCalls, 0);
	assert.throws(() => lease.endpoint, isRuntimeError('TASK_RECOVERY_UNAVAILABLE'));
	const disposal = launcher.dispose();
	assert.equal(launcher.dispose(), disposal);
	await disposal;
	await launcher.dispose();
	assert.equal(native.disposeCalls, 1);
	assert.equal(native.host.disposeCalls, 1);
	assert.equal(native.host.disposed, true);
	assert.equal((await launcher.probe()).available, false);
	await assert.rejects(launcher.launch(), isRuntimeError('AGENT_UNAVAILABLE'));
});

test('cancelling one launch waiter does not cancel another task sharing Host startup', async (t) => {
	const native = new TestLauncher();
	native.launchBarrier = deferred();
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	t.after(() => launcher.dispose());
	const controller = new AbortController();
	const cancelled = launcher.launch(controller.signal);
	const cancellation = assert.rejects(cancelled, isRuntimeError('AGENT_UNAVAILABLE'));
	const other = launcher.launch();
	await native.launchStarted.promise;
	controller.abort();
	await cancellation;
	assert.equal(native.launchSignal?.aborted, false);
	native.launchBarrier.resolve();
	assert.equal((await other).source, 'codespace-owned');
	assert.equal(native.launchCalls, 1);
	assert.equal(launcher.failure, undefined);
});

test('an already-cancelled task never starts a Host or disrupts existing leases', async (t) => {
	const native = new TestLauncher();
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	t.after(() => launcher.dispose());
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(launcher.launch(controller.signal), isRuntimeError('AGENT_UNAVAILABLE'));
	assert.equal(native.launchCalls, 0);
	const lease = await launcher.launch();
	await assert.rejects(launcher.launch(controller.signal), isRuntimeError('AGENT_UNAVAILABLE'));
	assert.equal(lease.endpoint.href, native.host.endpoint.href);
	assert.equal(native.launchCalls, 1);
});

test('cancelling every pending task lease leaves startup owned by the generation, not by the cancelled tasks', async () => {
	const native = new TestLauncher();
	native.launchBarrier = deferred();
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	const controller = new AbortController();
	const pending = launcher.launch(controller.signal);
	const rejected = assert.rejects(pending, isRuntimeError('AGENT_UNAVAILABLE'));
	await native.launchStarted.promise;
	controller.abort();
	await rejected;
	assert.equal(native.launchSignal?.aborted, false);
	assert.equal(launcher.failure, undefined);
	const replacementLease = launcher.launch();
	native.launchBarrier.resolve();
	await replacementLease;
	assert.equal(native.host.disposeCalls, 0);
	assert.equal(native.launchCalls, 1);
	await launcher.dispose();
	assert.equal(native.host.disposeCalls, 1);
});

test('owner disposal cancels pending leases and awaits a late successful native launch before cleanup', async () => {
	const native = new TestLauncher();
	native.launchBarrier = deferred();
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	const first = assert.rejects(launcher.launch(), isRuntimeError('AGENT_UNAVAILABLE'));
	const second = assert.rejects(launcher.launch(), isRuntimeError('AGENT_UNAVAILABLE'));
	await native.launchStarted.promise;
	let disposed = false;
	const disposal = launcher.dispose();
	void disposal.then(() => { disposed = true; });
	await Promise.all([first, second]);
	assert.equal(native.launchSignal?.aborted, true);
	assert.equal(disposed, false);
	assert.equal(native.disposeCalls, 0);
	native.launchBarrier.resolve();
	await disposal;
	assert.equal(native.host.disposed, true);
	assert.equal(native.host.disposeCalls, 1);
	assert.equal(native.disposeCalls, 1);
});

test('disposing an unused owned launcher cannot launch anything', async () => {
	const native = new TestLauncher();
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	await launcher.dispose();
	assert.equal(native.launchCalls, 0);
	assert.equal(native.host.disposeCalls, 0);
	await assert.rejects(launcher.launch(), isRuntimeError('AGENT_UNAVAILABLE'));
});

test('failed owned cleanup is visible and retained for an explicit, coalesced disposal retry', async () => {
	const native = new TestLauncher();
	native.host.disposeFailures = 1;
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	const lease = await launcher.launch();
	await lease.dispose();
	await assert.rejects(launcher.dispose(), (error: unknown) =>
		error instanceof AgentRuntimeError && error.cleanupFailed && error.code === 'AGENT_UNAVAILABLE');
	assert.equal(native.host.disposed, false);
	assert.equal(native.host.disposeCalls, 1);
	await assert.rejects(launcher.launch(), isRuntimeError('AGENT_UNAVAILABLE'));
	const retry = launcher.dispose();
	assert.equal(launcher.dispose(), retry);
	await retry;
	await launcher.dispose();
	assert.equal(native.host.disposed, true);
	assert.equal(native.disposeCalls, 2);
	assert.equal(native.host.disposeCalls, 2);
});

test('failed partial startup cleanup remains owned and cannot be bypassed by another launch', async () => {
	const native = new TestLauncher();
	native.launchFailure = new AgentRuntimeError('AGENT_UNAVAILABLE', 'Synthetic startup cleanup failure.', false, undefined, true);
	native.host.disposeFailures = 1;
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	await assert.rejects(launcher.launch(), (error: unknown) => error === native.launchFailure);
	assert.equal(launcher.failure?.cleanupFailed, true);
	await assert.rejects(launcher.launch(), isRuntimeError('TASK_RECOVERY_UNAVAILABLE'));
	assert.equal((await launcher.probe()).available, false);
	assert.equal(native.launchCalls, 1);
	await assert.rejects(launcher.dispose(), (error: unknown) => error instanceof AgentRuntimeError && error.cleanupFailed);
	await launcher.dispose();
	assert.equal(native.host.disposed, true);
	assert.equal(native.host.disposeCalls, 2);
});

test('leases preserve native exit delivery and late notification without restarting a dead Host', async (t) => {
	const native = new TestLauncher();
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	t.after(() => launcher.dispose());
	const released = await launcher.launch();
	const active = await launcher.launch();
	const releasedErrors: AgentRuntimeError[] = [];
	const activeErrors: AgentRuntimeError[] = [];
	const lateErrors: AgentRuntimeError[] = [];
	released.onExit((error) => releasedErrors.push(error));
	active.onExit((error) => activeErrors.push(error));
	launcher.onDidFail(() => { throw new Error('Ignored status observer failure.'); });
	await released.dispose();
	const error = new AgentRuntimeError('TASK_RECOVERY_UNAVAILABLE', 'Native exit notification.');
	native.host.exit(error);
	active.onExit((failure) => lateErrors.push(failure));
	await Promise.resolve();
	assert.deepEqual(releasedErrors, []);
	assert.deepEqual(activeErrors, [error]);
	assert.deepEqual(lateErrors, [error]);
	assert.equal(launcher.hasLiveHost, false);
	assert.equal((await launcher.probe()).available, false);
	assert.throws(() => active.endpoint, isRuntimeError('TASK_RECOVERY_UNAVAILABLE'));
	await assert.rejects(launcher.launch(), isRuntimeError('TASK_RECOVERY_UNAVAILABLE'));
	assert.equal(native.launchCalls, 1);
});

test('an already-exited native Host is rejected before granting a usable lease', async (t) => {
	const native = new TestLauncher();
	native.host.exit(new AgentRuntimeError('TASK_RECOVERY_UNAVAILABLE', 'Exited before publication.'));
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	t.after(() => launcher.dispose());
	await assert.rejects(launcher.launch(), isRuntimeError('TASK_RECOVERY_UNAVAILABLE'));
	assert.equal(launcher.hasLiveHost, false);
	assert.equal(native.launchCalls, 1);
});

test('retained leases preserve native socket opening and close a socket returned after lease release', async (t) => {
	const native = new TestLauncher();
	const opening = deferred();
	let terminated = false;
	let receivedSignal: AbortSignal | undefined;
	const socket = { terminate: () => { terminated = true; } } as WebSocket;
	native.host.openWebSocket = async (signal) => {
		receivedSignal = signal;
		await opening.promise;
		return socket;
	};
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	t.after(() => launcher.dispose());
	const lease = await launcher.launch();
	const controller = new AbortController();
	const pending = lease.openWebSocket!(controller.signal);
	const rejected = assert.rejects(pending, isRuntimeError('TASK_RECOVERY_UNAVAILABLE'));
	assert.equal(receivedSignal, controller.signal);
	await lease.dispose();
	opening.resolve();
	await rejected;
	assert.equal(terminated, true);
	assert.equal(native.host.disposeCalls, 0);
});

test('a borrowed editor Host is never relabelled as a Codespace-owned lease', async (t) => {
	const native = new TestLauncher();
	native.host.source = 'editor';
	const launcher = new RetainedOwnedAgentHostLauncher(native);
	t.after(() => launcher.dispose());
	await assert.rejects(launcher.launch(), isRuntimeError('AGENT_UNAVAILABLE'));
	assert.equal(launcher.hasLiveHost, false);
});

class TestLauncher implements AgentHostLauncherLike {
	readonly host = new TestHost();
	readonly launchStarted = deferred();
	launchBarrier: ReturnType<typeof deferred> | undefined;
	launchFailure: AgentRuntimeError | undefined;
	launchSignal: AbortSignal | undefined;
	launchCalls = 0;
	probeCalls = 0;
	disposeCalls = 0;

	async probe() {
		this.probeCalls += 1;
		return { available: true, version: this.host.version };
	}

	async launch(signal?: AbortSignal): Promise<LaunchedAgentHost> {
		this.launchCalls += 1;
		this.launchSignal = signal;
		this.launchStarted.resolve();
		await this.launchBarrier?.promise;
		if (this.launchFailure !== undefined) { throw this.launchFailure; }
		return this.host;
	}

	async dispose(): Promise<void> {
		this.disposeCalls += 1;
		if (this.launchCalls > 0) { await this.host.dispose(); }
	}
}

class TestHost implements LaunchedAgentHost {
	readonly endpoint = new URL('ws://127.0.0.1:1234/?tkn=synthetic-token');
	readonly version = '1.136.2';
	readonly registryProtocolVersion = '0.9.0';
	source: AgentHostSource = 'standalone';
	openWebSocket?: LaunchedAgentHost['openWebSocket'];
	disposeCalls = 0;
	disposeFailures = 0;
	disposed = false;
	private readonly listeners = new Set<(error: AgentRuntimeError) => void>();
	private exitError: AgentRuntimeError | undefined;

	onExit(listener: (error: AgentRuntimeError) => void): { dispose(): void } {
		this.listeners.add(listener);
		if (this.exitError !== undefined) {
			const error = this.exitError;
			queueMicrotask(() => {
				if (this.listeners.has(listener)) { listener(error); }
			});
		}
		return { dispose: () => this.listeners.delete(listener) };
	}

	exit(error: AgentRuntimeError): void {
		this.exitError = error;
		for (const listener of this.listeners) { listener(error); }
	}

	async dispose(): Promise<void> {
		this.disposeCalls += 1;
		if (this.disposeFailures > 0) {
			this.disposeFailures -= 1;
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'Synthetic cleanup failure.', false, undefined, true);
		}
		this.disposed = true;
		this.listeners.clear();
	}
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => { resolve = complete; });
	return { promise, resolve };
}

function isRuntimeError(code: AgentRuntimeError['code']): (error: unknown) => boolean {
	return (error) => error instanceof AgentRuntimeError && error.code === code;
}
