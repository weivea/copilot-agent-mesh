import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TaskToolSnapshot } from '../../shared/toolProtocol';
import {
	DelegationWaiter,
	type DelegationWaiterOptions,
	type ToolCancellation,
	type ToolClock,
} from '../tools/DelegationWaiter';

const TASK_ID = '00000000-0000-4000-8000-000000000901';
const INPUT_ID = '00000000-0000-4000-8000-000000000902';

test('subscribes before start and disposes every resource after a fast terminal event', async () => {
	const fixture = waiterFixture();
	let starts = 0;
	fixture.onSubscribe = (listener) => listener(snapshot('completed', {
		summary: 'Done.',
		validation: {
			status: 'passed',
			summary: 'Checked /private/project',
		},
		artifacts: [{
			artifactId: INPUT_ID,
			label: 'Report /private/project',
			mediaType: 'text/plain',
		}],
	}));
	fixture.start = async () => {
		starts += 1;
		return snapshot('running');
	};

	assert.deepEqual(await fixture.waiter().wait(), {
		kind: 'completed',
		taskId: TASK_ID,
		result: {
			summary: 'Done.',
			validation: { status: 'passed', summary: 'Checked [redacted]' },
			artifacts: [{
				artifactId: INPUT_ID,
				label: 'Report [redacted]',
				mediaType: 'text/plain',
			}],
		},
	});

	await Promise.resolve();
	assert.equal(starts, 1);
	assert.deepEqual(fixture.counts(), {
		subscriptions: 0,
		timers: 0,
		tokenRegistrations: 0,
		cancels: 0,
	});
});

test('a fast terminal event cannot mask a start idempotency conflict', async () => {
	const fixture = waiterFixture();
	fixture.onSubscribe = (listener) => listener(snapshot('completed', {
		summary: 'Historical completion.',
	}));
	fixture.start = async () => {
		throw Object.assign(
			new Error('The retry payload conflicts with the persisted task.'),
			{ code: 'IDEMPOTENCY_CONFLICT' },
		);
	};

	assert.deepEqual(await fixture.waiter().wait(), {
		kind: 'failed',
		taskId: TASK_ID,
		code: 'IDEMPOTENCY_CONFLICT',
		message: 'The retry payload conflicts with the persisted task.',
	});
});

test('budget cancellation is sent once and preserves a racing authoritative completion state', async () => {
	const fixture = waiterFixture();
	const pending = fixture.waiter().wait();
	fixture.fireBudget();
	fixture.fireBudget();
	await Promise.resolve();
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(fixture.counts().cancels, 1);
	fixture.emit(snapshot('completed', { summary: 'Too late.' }));

	assert.deepEqual(await pending, {
		kind: 'cancelled',
		taskId: TASK_ID,
		reason: 'budget',
		code: 'TIMEOUT',
		taskState: 'completed',
	});
	assert.equal(fixture.counts().subscriptions, 0);
	assert.equal(fixture.counts().timers, 0);
	assert.equal(fixture.counts().tokenRegistrations, 0);
});

test('token and independent peer cancellations remain distinct', async () => {
	const tokenFixture = waiterFixture();
	const tokenPending = tokenFixture.waiter().wait();
	tokenFixture.fireToken();
	tokenFixture.fireToken();
	await Promise.resolve();
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	tokenFixture.emit(snapshot('cancelled'));
	assert.deepEqual(await tokenPending, {
		kind: 'cancelled',
		taskId: TASK_ID,
		reason: 'token',
		code: 'CANCELLED',
	});
	assert.equal(tokenFixture.counts().cancels, 1);

	const peerFixture = waiterFixture();
	const peerPending = peerFixture.waiter().wait();
	peerFixture.emit(snapshot('cancelled'));
	assert.deepEqual(await peerPending, {
		kind: 'cancelled',
		taskId: TASK_ID,
		reason: 'peer',
		code: 'CANCELLED',
	});
	assert.equal(peerFixture.counts().cancels, 0);
});

test('cancellation before persistence waits for start reconciliation before cancelling', async () => {
	const fixture = waiterFixture();
	let resolveStart!: (snapshot: TaskToolSnapshot) => void;
	fixture.start = () => new Promise<TaskToolSnapshot>((resolve) => {
		resolveStart = resolve;
	});
	const pending = fixture.waiter().wait();
	fixture.fireToken();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(fixture.counts().cancels, 0);

	resolveStart(snapshot('running'));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(fixture.counts().cancels, 1);
	fixture.emit(snapshot('cancelled'));
	assert.deepEqual(await pending, {
		kind: 'cancelled',
		taskId: TASK_ID,
		reason: 'token',
		code: 'CANCELLED',
	});
});

test('needsInput cannot win after cancellation has been requested', async () => {
	const fixture = waiterFixture();
	const pending = fixture.waiter().wait();
	fixture.fireToken();
	await new Promise<void>((resolve) => setImmediate(resolve));
	fixture.emit(snapshot('needsInput', {
		pendingInput: {
			inputId: INPUT_ID,
			prompt: 'This question is stale.',
		},
	}));
	const marker = Symbol('still-pending');
	assert.equal(
		await Promise.race([pending, Promise.resolve(marker)]),
		marker,
	);
	fixture.emit(snapshot('cancelled'));
	assert.equal((await pending).kind, 'cancelled');
});

test('needsInput preserves its identity and sanitized bounded question', async () => {
	const fixture = waiterFixture();
	const pending = fixture.waiter().wait();
	fixture.emit(snapshot('needsInput', {
		pendingInput: {
			inputId: INPUT_ID,
			prompt: 'Choose /private/project',
		},
	}));
	assert.deepEqual(await pending, {
		kind: 'needsInput',
		taskId: TASK_ID,
		inputId: INPUT_ID,
		question: 'Choose [redacted]',
	});
});

test('setup, start, cancellation, and listener failures retain task identity', async (t) => {
	await t.test('setup', async () => {
		const fixture = waiterFixture();
		fixture.subscribeError = new Error('subscription failed');
		const outcome = await fixture.waiter().wait();
		assert.equal(outcome.kind, 'failed');
		assert.equal(outcome.taskId, TASK_ID);
		assert.deepEqual(fixture.counts(), {
			subscriptions: 0,
			timers: 0,
			tokenRegistrations: 0,
			cancels: 0,
		});
	});

	await t.test('start', async () => {
		const fixture = waiterFixture();
		fixture.start = async () => {
			throw Object.assign(new Error('start failed'), { code: 'AGENT_START_FAILED' });
		};
		assert.deepEqual(await fixture.waiter().wait(), {
			kind: 'failed',
			taskId: TASK_ID,
			code: 'AGENT_START_FAILED',
			message: 'start failed',
		});
	});

	await t.test('cancel', async () => {
		const fixture = waiterFixture();
		fixture.cancel = async () => {
			throw Object.assign(new Error('cancel failed'), { code: 'BROKER_UNAVAILABLE' });
		};
		const pending = fixture.waiter().wait();
		fixture.fireToken();
		assert.deepEqual(await pending, {
			kind: 'failed',
			taskId: TASK_ID,
			code: 'BROKER_UNAVAILABLE',
			message: 'cancel failed',
		});
	});

	await t.test('listener', async () => {
		const fixture = waiterFixture();
		fixture.sanitize = () => {
			throw new Error('listener failed');
		};
		const pending = fixture.waiter().wait();
		fixture.emit(snapshot('completed'));
		assert.deepEqual(await pending, {
			kind: 'failed',
			taskId: TASK_ID,
			code: 'OUTPUT_INVALID',
			message: 'The delegated task failed.',
		});
	});
});

interface WaiterFixture {
	readonly waiter: () => DelegationWaiter;
	readonly counts: () => {
		readonly subscriptions: number;
		readonly timers: number;
		readonly tokenRegistrations: number;
		readonly cancels: number;
	};
	emit(snapshot: TaskToolSnapshot): void;
	fireBudget(): void;
	fireToken(): void;
	onSubscribe?: (listener: (snapshot: TaskToolSnapshot) => void) => void;
	subscribeError?: Error;
	start: () => Promise<TaskToolSnapshot>;
	cancel: () => Promise<TaskToolSnapshot>;
	sanitize: (value: string) => string;
}

function waiterFixture(): WaiterFixture {
	let listener: ((snapshot: TaskToolSnapshot) => void) | undefined;
	let budgetListener: (() => void) | undefined;
	let tokenListener: (() => void) | undefined;
	let subscriptions = 0;
	let timers = 0;
	let tokenRegistrations = 0;
	let cancels = 0;
	const fixture: WaiterFixture = {
		start: async () => snapshot('running'),
		cancel: async () => {
			cancels += 1;
			return snapshot('cancelling');
		},
		sanitize: (value: string) => value.replace('/private/project', '[redacted]'),
		waiter: () => new DelegationWaiter({
			taskId: TASK_ID,
			timeoutMinutes: 60,
			cancellation: {
				isCancellationRequested: false,
				onCancellationRequested: (next) => {
					tokenRegistrations += 1;
					tokenListener = next;
					return {
						dispose: () => {
							tokenRegistrations -= 1;
							tokenListener = undefined;
						},
					};
				},
			} satisfies ToolCancellation,
			clock: {
				createTimer: () => {
					timers += 1;
					let resolve!: () => void;
					const promise = new Promise<void>((next) => {
						resolve = next;
					});
					budgetListener = resolve;
					return {
						promise,
						dispose: () => {
							timers -= 1;
							budgetListener = undefined;
						},
					};
				},
			} satisfies ToolClock,
			subscribe: (next) => {
				if (fixture.subscribeError !== undefined) {
					throw fixture.subscribeError;
				}
				subscriptions += 1;
				listener = next;
				fixture.onSubscribe?.(next);
				return {
					dispose: () => {
						subscriptions -= 1;
						listener = undefined;
					},
				};
			},
			start: () => fixture.start(),
			cancel: () => fixture.cancel(),
			sanitizeText: (value) => fixture.sanitize(value),
		} satisfies DelegationWaiterOptions),
		counts: () => ({
			subscriptions,
			timers,
			tokenRegistrations,
			cancels,
		}),
		emit: (value: TaskToolSnapshot) => listener?.(value),
		fireBudget: () => budgetListener?.(),
		fireToken: () => tokenListener?.(),
	};
	return fixture;
}

function snapshot(
	status: TaskToolSnapshot['status'],
	overrides: Partial<TaskToolSnapshot> = {},
): TaskToolSnapshot {
	return {
		taskId: TASK_ID,
		status,
		title: 'Delegated task',
		updatedAt: '2026-09-01T12:00:00.000Z',
		...overrides,
	};
}
