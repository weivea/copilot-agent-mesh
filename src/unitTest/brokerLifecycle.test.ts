import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	BrokerLifecycle,
	type BrokerRuntime,
} from '../broker/BrokerLifecycle';
import {
	FencedStateStore,
	type BrokerOwnership,
	type BrokerOwnershipSnapshot,
} from '../storage/WorkerOwnerLock';

test('initial owner starts exactly one runtime and start is idempotent', async () => {
	const cluster = new OwnershipCluster();
	const ownership = cluster.create('owner', true);
	let creates = 0;
	let starts = 0;
	const lifecycle = new BrokerLifecycle(ownership, () => {
		creates += 1;
		return runtime({ start: () => {
			starts += 1;
		} });
	});

	await Promise.all([lifecycle.start(), lifecycle.start()]);

	assert.equal(lifecycle.getStatus().state, 'running');
	assert.equal(creates, 1);
	assert.equal(starts, 1);
	await lifecycle.dispose();
});

test('non-owner remains contending without creating a runtime', async () => {
	const cluster = new OwnershipCluster();
	cluster.create('owner', true);
	const ownership = cluster.create('node');
	const scheduler = new ManualScheduler();
	let creates = 0;
	const lifecycle = new BrokerLifecycle(
		ownership,
		() => {
			creates += 1;
			return runtime();
		},
		scheduler.options,
	);

	await lifecycle.start();

	assert.equal(lifecycle.getStatus().state, 'contending');
	assert.equal(creates, 0);
	assert.equal(scheduler.pending, 1);
	assert.equal('holderPid' in lifecycle.getStatus(), false);
	assert.equal('pid' in lifecycle.getStatus().ownership, false);
	await lifecycle.dispose();
});

test('graceful owner close elects a contender and starts its runtime', async () => {
	const cluster = new OwnershipCluster();
	const ownerRuntime = runtime();
	const ownerLifecycle = new BrokerLifecycle(
		cluster.create('owner', true),
		() => ownerRuntime,
	);
	const contenderScheduler = new ManualScheduler();
	let contenderStarts = 0;
	const contenderLifecycle = new BrokerLifecycle(
		cluster.create('contender'),
		() => runtime({ start: () => {
			contenderStarts += 1;
		} }),
		contenderScheduler.options,
	);
	await ownerLifecycle.start();
	await contenderLifecycle.start();

	await ownerLifecycle.dispose();
	contenderScheduler.fireNext();
	await waitFor(() => contenderLifecycle.getStatus().state === 'running');

	assert.equal(ownerRuntime.disposeCalls, 1);
	assert.equal(contenderStarts, 1);
	await contenderLifecycle.dispose();
});

test('a stale crashed owner is taken over on scheduled contention', async () => {
	const cluster = new OwnershipCluster();
	const crashed = cluster.create('crashed', true);
	const scheduler = new ManualScheduler();
	const contender = cluster.create('contender');
	let starts = 0;
	const lifecycle = new BrokerLifecycle(
		contender,
		() => runtime({ start: () => {
			starts += 1;
		} }),
		scheduler.options,
	);
	await lifecycle.start();
	cluster.crash(crashed);

	scheduler.fireNext();
	await waitFor(() => lifecycle.getStatus().state === 'running');

	assert.equal(starts, 1);
	assert.equal(contender.isOwner(), true);
	await lifecycle.dispose();
});

test('concurrent contenders elect one owner and start one runtime', async () => {
	const cluster = new OwnershipCluster();
	const crashed = cluster.create('crashed', true);
	const firstScheduler = new ManualScheduler();
	const secondScheduler = new ManualScheduler();
	let starts = 0;
	const first = new BrokerLifecycle(
		cluster.create('first'),
		() => runtime({ start: () => {
			starts += 1;
		} }),
		firstScheduler.options,
	);
	const second = new BrokerLifecycle(
		cluster.create('second'),
		() => runtime({ start: () => {
			starts += 1;
		} }),
		secondScheduler.options,
	);
	await Promise.all([first.start(), second.start()]);
	cluster.crash(crashed);

	firstScheduler.fireNext();
	secondScheduler.fireNext();
	await waitFor(() => (
		first.getStatus().state === 'running'
		|| second.getStatus().state === 'running'
	));
	await waitFor(() => starts === 1);

	assert.equal(starts, 1);
	assert.equal(
		Number(first.getStatus().state === 'running')
			+ Number(second.getStatus().state === 'running'),
		1,
	);
	await Promise.all([first.dispose(), second.dispose()]);
});

test('old owner generation is fenced from shared-state writes', async () => {
	const cluster = new OwnershipCluster();
	const oldOwner = cluster.create('old-owner', true);
	const generation = oldOwner.currentGeneration();
	const state = new MemoryState();
	const fenced = new FencedStateStore(state, oldOwner, generation);
	cluster.lose(oldOwner);
	await cluster.create('new-owner').contend();

	await assert.rejects(
		fenced.update('shared', 'stale'),
		/generation changed before/u,
	);
	assert.equal(state.updateCalls, 0);
});

test('ownership loss during asynchronous start disposes before contending', async () => {
	const cluster = new OwnershipCluster();
	const ownership = cluster.create('owner', true);
	const scheduler = new ManualScheduler();
	const startGate = deferred<void>();
	const partialRuntime = runtime({ start: () => startGate.promise });
	const lifecycle = new BrokerLifecycle(
		ownership,
		() => partialRuntime,
		scheduler.options,
	);

	const start = lifecycle.start();
	await waitFor(() => lifecycle.getStatus().state === 'starting');
	cluster.lose(ownership);
	assert.equal(partialRuntime.disposeCalls, 0);
	startGate.resolve(undefined);
	await start;
	await waitFor(() => lifecycle.getStatus().state === 'contending');

	assert.equal(partialRuntime.disposeCalls, 1);
	assert.notEqual(lifecycle.getStatus().state, 'running');
	await lifecycle.dispose();
});

test('start failure is explicit and retries only from the owned timer', async () => {
	const cluster = new OwnershipCluster();
	const ownership = cluster.create('owner', true);
	const scheduler = new ManualScheduler();
	let creates = 0;
	const failedRuntime = runtime({ start: () => {
		throw new Error('injected start failure');
	} });
	const lifecycle = new BrokerLifecycle(
		ownership,
		() => {
			creates += 1;
			return creates === 1 ? failedRuntime : runtime();
		},
		scheduler.options,
	);

	await assert.rejects(lifecycle.start(), /injected start failure/u);
	assert.equal(lifecycle.getStatus().state, 'error');
	assert.equal(
		lifecycle.getStatus().error?.code,
		'BROKER_RUNTIME_START_FAILED',
	);
	assert.equal(failedRuntime.disposeCalls, 1);
	assert.equal(creates, 1);
	assert.equal(scheduler.pending, 1);

	scheduler.fireNext();
	await waitFor(() => lifecycle.getStatus().state === 'running');
	assert.equal(creates, 2);
	await lifecycle.dispose();
});

test('runtime start and stop operations never overlap', async () => {
	const cluster = new OwnershipCluster();
	const ownership = cluster.create('owner', true);
	const startGate = deferred<void>();
	let activeOperations = 0;
	let maximumActiveOperations = 0;
	const enter = (): void => {
		activeOperations += 1;
		maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
	};
	const leave = (): void => {
		activeOperations -= 1;
	};
	const lifecycle = new BrokerLifecycle(ownership, () => runtime({
		start: async () => {
			enter();
			await startGate.promise;
			leave();
		},
		dispose: () => {
			enter();
			leave();
		},
	}));

	const start = lifecycle.start();
	await waitFor(() => lifecycle.getStatus().state === 'starting');
	cluster.lose(ownership);
	startGate.resolve(undefined);
	await start;
	await waitFor(() => lifecycle.getStatus().state === 'contending');

	assert.equal(maximumActiveOperations, 1);
	await lifecycle.dispose();
});

test('dispose is idempotent and clears owned timers before the lock', async () => {
	const cluster = new OwnershipCluster();
	cluster.create('owner', true);
	const ownership = cluster.create('node');
	const scheduler = new ManualScheduler();
	const lifecycle = new BrokerLifecycle(
		ownership,
		() => runtime(),
		scheduler.options,
	);
	await lifecycle.start();

	await Promise.all([lifecycle.dispose(), lifecycle.dispose()]);

	assert.equal(lifecycle.getStatus().state, 'disposed');
	assert.equal(scheduler.pending, 0);
	assert.equal(scheduler.clearCalls, 1);
	assert.equal(ownership.disposeCalls, 1);
	scheduler.fireAll();
	assert.equal(ownership.contendCalls, 0);
});

test('failed runtime disposal retains ownership and lets a later disposal retry succeed', async () => {
	const cluster = new OwnershipCluster();
	const ownership = cluster.create('owner', true);
	const contenderScheduler = new ManualScheduler();
	let cleanupFailures = 1;
	const ownedRuntime = runtime({ dispose: () => {
		if (cleanupFailures > 0) {
			cleanupFailures -= 1;
			throw new Error('runtime cleanup failed');
		}
	} });
	const lifecycle = new BrokerLifecycle(ownership, () => ownedRuntime);
	let contenderStarts = 0;
	const contender = new BrokerLifecycle(
		cluster.create('contender'),
		() => runtime({ start: () => {
			contenderStarts += 1;
		} }),
		contenderScheduler.options,
	);
	await lifecycle.start();
	await contender.start();

	const failedDisposal = lifecycle.dispose();
	assert.equal(lifecycle.dispose(), failedDisposal);
	await assert.rejects(failedDisposal, (error: unknown) =>
		error instanceof AggregateError
		&& error.errors.length === 1
		&& error.errors[0] instanceof Error
		&& error.errors[0].message === 'runtime cleanup failed',
	);

	assert.equal(lifecycle.getStatus().state, 'error');
	assert.equal(lifecycle.getStatus().error?.code, 'BROKER_RUNTIME_DISPOSE_FAILED');
	assert.equal(lifecycle.getStatus().error?.retryable, true);
	assert.equal(ownership.isOwner(), true);
	assert.equal(ownership.disposeCalls, 0);
	assert.equal(ownership.lossListenerCount, 1);
	assert.equal(ownedRuntime.disposeCalls, 1);
	await assert.rejects(lifecycle.start(), /disposed/u);

	contenderScheduler.fireNext();
	await waitFor(() => contenderScheduler.pending === 1);
	assert.equal(contenderStarts, 0);
	assert.equal(ownership.isOwner(), true);

	await lifecycle.dispose();
	assert.equal(lifecycle.getStatus().state, 'disposed');
	assert.equal(ownedRuntime.disposeCalls, 2);
	assert.equal(ownership.disposeCalls, 1);
	assert.equal(ownership.lossListenerCount, 0);

	contenderScheduler.fireNext();
	await waitFor(() => contender.getStatus().state === 'running');
	assert.equal(contenderStarts, 1);
	await contender.dispose();
});

test('ownership listener release failure is retryable and delays lock release', async () => {
	const cluster = new OwnershipCluster();
	const delegate = cluster.create('owner', true);
	let listenerDisposeCalls = 0;
	let ownershipDisposeCalls = 0;
	const ownership: BrokerOwnership = {
		isOwner: () => delegate.isOwner(),
		currentGeneration: () => delegate.currentGeneration(),
		snapshot: () => delegate.snapshot(),
		assertOwner: () => delegate.assertOwner(),
		contend: () => delegate.contend(),
		onDidLoseOwnership: (listener) => {
			const subscription = delegate.onDidLoseOwnership(listener);
			return {
				dispose: () => {
					listenerDisposeCalls += 1;
					if (listenerDisposeCalls === 1) {
						throw new Error('listener cleanup failed');
					}
					subscription.dispose();
				},
			};
		},
		dispose: async () => {
			ownershipDisposeCalls += 1;
			await delegate.dispose();
		},
	};
	const ownedRuntime = runtime();
	const lifecycle = new BrokerLifecycle(ownership, () => ownedRuntime);
	await lifecycle.start();

	await assert.rejects(lifecycle.dispose(), (error: unknown) =>
		error instanceof AggregateError
		&& error.errors.length === 1
		&& error.errors[0] instanceof Error
		&& error.errors[0].message === 'listener cleanup failed',
	);
	assert.equal(lifecycle.getStatus().error?.code, 'BROKER_OWNERSHIP_RELEASE_FAILED');
	assert.equal(ownedRuntime.disposeCalls, 1);
	assert.equal(listenerDisposeCalls, 1);
	assert.equal(ownershipDisposeCalls, 0);
	assert.equal(delegate.isOwner(), true);

	await lifecycle.dispose();
	assert.equal(ownedRuntime.disposeCalls, 1);
	assert.equal(listenerDisposeCalls, 2);
	assert.equal(ownershipDisposeCalls, 1);
	assert.equal(lifecycle.getStatus().state, 'disposed');
});

interface RuntimeHooks {
	readonly start?: () => Promise<void> | void;
	readonly dispose?: () => Promise<void> | void;
}

interface TestRuntime extends BrokerRuntime {
	readonly disposeCalls: number;
}

function runtime(hooks: RuntimeHooks = {}): TestRuntime {
	let disposeCalls = 0;
	return {
		start: async () => hooks.start?.(),
		dispose: async () => {
			disposeCalls += 1;
			await hooks.dispose?.();
		},
		get disposeCalls() {
			return disposeCalls;
		},
	};
}

class OwnershipCluster {
	private generationSequence = 0;
	private owner: TestOwnership | undefined;

	public create(instanceId: string, owner = false): TestOwnership {
		const ownership = new TestOwnership(this, instanceId);
		if (owner) {
			assert.equal(this.owner, undefined);
			this.claim(ownership);
		}
		return ownership;
	}

	public claim(contender: TestOwnership): boolean {
		if (this.owner === undefined) {
			this.owner = contender;
			contender.generation = `generation-${++this.generationSequence}`;
		}
		return this.owner === contender;
	}

	public isOwner(ownership: TestOwnership): boolean {
		return this.owner === ownership;
	}

	public snapshot(instanceId: string): BrokerOwnershipSnapshot {
		return {
			owner: this.owner?.instanceId === instanceId,
			instanceId,
			generation: this.owner?.generation,
			holderInstanceId: this.owner?.instanceId,
		};
	}

	public lose(ownership: TestOwnership): void {
		if (this.owner !== ownership) {
			return;
		}
		this.owner = undefined;
		ownership.generation = undefined;
		ownership.emitLoss();
	}

	public crash(ownership: TestOwnership): void {
		if (this.owner === ownership) {
			this.owner = undefined;
			ownership.generation = undefined;
		}
	}

	public release(ownership: TestOwnership): void {
		if (this.owner === ownership) {
			this.owner = undefined;
			ownership.generation = undefined;
		}
	}
}

class TestOwnership implements BrokerOwnership {
	private readonly lossListeners = new Set<() => void>();
	public contendCalls = 0;
	public disposeCalls = 0;
	public generation: string | undefined;
	private disposed = false;

	public constructor(
		private readonly cluster: OwnershipCluster,
		public readonly instanceId: string,
	) {}

	public isOwner(): boolean {
		return !this.disposed && this.cluster.isOwner(this);
	}

	public currentGeneration(): string | undefined {
		return this.isOwner() ? this.generation : undefined;
	}

	public snapshot(): BrokerOwnershipSnapshot {
		return this.cluster.snapshot(this.instanceId);
	}

	public async assertOwner(): Promise<void> {
		if (!this.isOwner()) {
			throw new Error('not owner');
		}
	}

	public async contend(): Promise<boolean> {
		this.contendCalls += 1;
		if (this.disposed) {
			throw new Error('disposed');
		}
		return this.cluster.claim(this);
	}

	public onDidLoseOwnership(listener: () => void): { dispose(): void } {
		this.lossListeners.add(listener);
		return { dispose: () => this.lossListeners.delete(listener) };
	}

	public emitLoss(): void {
		for (const listener of this.lossListeners) {
			listener();
		}
	}

	public get lossListenerCount(): number {
		return this.lossListeners.size;
	}

	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposeCalls += 1;
		this.disposed = true;
		this.cluster.release(this);
		this.lossListeners.clear();
	}
}

class ManualScheduler {
	private readonly timers: ManualTimer[] = [];
	public clearCalls = 0;

	public readonly options = {
		contentionIntervalMs: 1,
		retryBaseDelayMs: 1,
		retryMaxDelayMs: 4,
		setTimer: (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
			const timer = { callback, delayMs, active: true };
			this.timers.push(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (value: ReturnType<typeof setTimeout>): void => {
			const timer = value as unknown as ManualTimer;
			if (timer.active) {
				timer.active = false;
				this.clearCalls += 1;
			}
		},
	};

	public get pending(): number {
		return this.timers.filter((timer) => timer.active).length;
	}

	public fireNext(): void {
		const timer = this.timers.find((candidate) => candidate.active);
		assert.ok(timer, 'Expected a scheduled lifecycle timer.');
		timer.active = false;
		timer.callback();
	}

	public fireAll(): void {
		for (const timer of this.timers) {
			if (timer.active) {
				timer.active = false;
				timer.callback();
			}
		}
	}
}

interface ManualTimer {
	readonly callback: () => void;
	readonly delayMs: number;
	active: boolean;
}

class MemoryState {
	private readonly values = new Map<string, unknown>();
	public updateCalls = 0;

	public get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.updateCalls += 1;
		this.values.set(key, value);
	}
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.fail('Timed out waiting for lifecycle state.');
}
