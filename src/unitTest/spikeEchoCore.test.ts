import * as assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	MESH_SPIKE_CANCEL_TOOL_NAME,
	MESH_SPIKE_POLL_TOOL_NAME,
	prepareSpikeInvocation,
	SpikeCancellation,
	SpikeClock,
	SpikeEchoCoordinator,
} from '../tools/spikeEchoCore';

suite('SpikeEchoCoordinator', () => {
	for (const delaySeconds of [5, 15, 30] as const) {
		test(`returns a structured pending result after a ${delaySeconds}s delay`, async () => {
			const clock = new ManualClock();
			const coordinator = createCoordinator(clock);
			const invocation = coordinator.invoke({
				message: `echo after ${delaySeconds}`,
				delaySeconds,
				confirmationBudgetSeconds: delaySeconds,
				delegationRequestId: `request-${delaySeconds}`,
			});

			clock.advanceBy(delaySeconds * 1_000);
			const result = await invocation;

			assert.deepStrictEqual(result, {
				status: 'pending',
				delegationRequestId: `request-${delaySeconds}`,
				taskId: 'id-1',
				pollTool: MESH_SPIKE_POLL_TOOL_NAME,
				cancelTool: MESH_SPIKE_CANCEL_TOOL_NAME,
				echo: `echo after ${delaySeconds}`,
				delaySeconds,
			});
		});
	}

	test('cancellation stops this invocation wait but preserves the task', async () => {
		const clock = new ManualClock();
		const cancellation = new ManualCancellation();
		const coordinator = createCoordinator(clock);
		const invocation = coordinator.invoke({
			message: 'cancel this wait',
			delaySeconds: 30,
			confirmationBudgetSeconds: 30,
			delegationRequestId: 'cancel-request',
		}, cancellation);

		cancellation.cancel();
		const result = await invocation;

		assert.equal(result.status, 'cancelled');
		assert.equal(result.taskId, 'id-1');
		assert.equal(result.pollTool, MESH_SPIKE_POLL_TOOL_NAME);
		assert.equal(result.cancelTool, MESH_SPIKE_CANCEL_TOOL_NAME);
	});

	test('the application confirmation budget wins before a slow acknowledgement', async () => {
		const clock = new ManualClock();
		const coordinator = createCoordinator(clock);
		const invocation = coordinator.invoke({
			message: 'timeout this wait',
			delaySeconds: 30,
			confirmationBudgetSeconds: 5,
			delegationRequestId: 'timeout-request',
		});

		clock.advanceBy(5_001);
		const result = await invocation;

		assert.equal(result.status, 'timeout');
		assert.equal(result.taskId, 'id-1');
		if (result.status === 'timeout') {
			assert.equal(result.confirmationBudgetSeconds, 5);
		}
	});

	test('reconciles the same delegationRequestId without starting a second task', async () => {
		const clock = new ManualClock();
		const cancellation = new ManualCancellation();
		let starts = 0;
		const coordinator = createCoordinator(clock, () => starts += 1);
		const input = {
			message: 'reconcile me',
			delaySeconds: 15 as const,
			confirmationBudgetSeconds: 30 as const,
			delegationRequestId: 'stable-request',
		};
		const firstInvocation = coordinator.invoke(input, cancellation);

		cancellation.cancel();
		const cancelled = await firstInvocation;
		assert.equal(cancelled.status, 'cancelled');

		const retry = coordinator.invoke(input);
		clock.advanceBy(15_000);
		const reconciled = await retry;

		assert.equal(starts, 1);
		assert.equal(reconciled.status, 'pending');
		assert.equal(reconciled.taskId, cancelled.taskId);
	});

	test('preparation returns deterministic safe confirmation copy', () => {
		const input = {
			message: 'show a safe confirmation',
			delaySeconds: 5 as const,
			confirmationBudgetSeconds: 15 as const,
		};

		const first = prepareSpikeInvocation(input);
		const second = prepareSpikeInvocation(input);

		assert.deepStrictEqual(first, second);
		assert.match(first.confirmationMessage, /local VS Code extension host/);
		assert.match(first.confirmationMessage, /no workspace files are accessed/);
	});
});

function createCoordinator(clock: SpikeClock, onTaskStarted?: () => void): SpikeEchoCoordinator {
	let nextId = 0;
	return new SpikeEchoCoordinator({
		clock,
		newId: () => `id-${++nextId}`,
		onTaskStarted,
	});
}

class ManualClock implements SpikeClock {
	private now = 0;
	private readonly sleepers: Array<{ dueAt: number; resolve: () => void }> = [];

	sleep(delayMs: number): Promise<void> {
		return new Promise((resolve) => {
			this.sleepers.push({ dueAt: this.now + delayMs, resolve });
		});
	}

	advanceBy(delayMs: number): void {
		this.now += delayMs;
		const ready = this.sleepers.filter(({ dueAt }) => dueAt <= this.now);
		for (const sleeper of ready) {
			this.sleepers.splice(this.sleepers.indexOf(sleeper), 1);
			sleeper.resolve();
		}
	}
}

class ManualCancellation implements SpikeCancellation {
	isCancellationRequested = false;
	private readonly listeners = new Set<() => void>();

	onCancellationRequested(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	cancel(): void {
		this.isCancellationRequested = true;
		for (const listener of this.listeners) {
			listener();
		}
	}
}
