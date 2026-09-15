import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { DevTunnelDiscoveryProvider, type DiscoveredEndpoint, type DiscoveryListResult } from '../connectivity/DevTunnelDiscoveryProvider';
import { DevTunnelManagement } from '../connectivity/DevTunnelManagement';
import { DiscoveryService } from '../connectivity/DiscoveryService';
import { ConnectivityError, type ConnectivityCode } from '../connectivity/ConnectivitySchemas';
import { uuid } from './artifactStoreTestSupport';
import { advertisedTunnel, connectivityFixture, deferred } from './connectivityTestSupport';

test('refresh after invalidation waits for old work, fetches the new generation and resumes its timer', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const f = discoveryFixture(t);
	const firstStarted = deferred();
	const releaseFirst = deferred();
	const timerStarted = deferred();
	let calls = 0;
	const fresh = f.provider.project(advertisedTunnel()).map((endpoint) => ({
		...endpoint, locator: { ...endpoint.locator, advertisementId: uuid(880) },
	}));
	f.provider.list = async () => {
		calls += 1;
		if (calls === 1) {
			firstStarted.resolve();
			await releaseFirst.promise;
			return discoveryResult(f.provider.project(advertisedTunnel()));
		}
		if (calls === 3) { timerStarted.resolve(); }
		return discoveryResult(fresh);
	};
	let notifications = 0;
	f.service.onDidRefresh(() => { notifications += 1; });
	const original = f.service.refresh();
	await firstStarted.promise;
	f.service.invalidate();
	const replacement = f.service.refresh();
	assert.notEqual(replacement, original);
	assert.equal(f.service.refresh(), replacement);
	assert.equal(calls, 1);
	releaseFirst.resolve();
	await Promise.all([original, replacement]);
	assert.equal(calls, 2);
	assert.equal(notifications, 1);
	assert.deepEqual(f.service.endpoints(), fresh);
	assert.equal(f.service.snapshot().state, 'ready');
	assert.equal(f.service.snapshot().error, undefined);
	f.clock.now += 18_000;
	t.mock.timers.tick(18_000);
	await timerStarted.promise;
	await f.service.refresh();
	assert.equal(calls, 3);
	assert.equal(notifications, 2);
});

test('multiple invalidations skip superseded queued generations without concurrent requests', async (t) => {
	const f = discoveryFixture(t);
	const started = deferred();
	const release = deferred();
	let calls = 0;
	f.provider.list = async () => {
		calls += 1;
		if (calls === 1) { started.resolve(); await release.promise; }
		return discoveryResult();
	};
	const first = f.service.refresh();
	await started.promise;
	f.service.invalidate();
	const second = f.service.refresh();
	f.service.invalidate();
	const third = f.service.refresh();
	assert.equal(f.service.refresh(), third);
	release.resolve();
	await Promise.all([first, second, third]);
	assert.equal(calls, 2);
	assert.equal(f.service.snapshot().state, 'ready');
	assert.equal(f.events.filter((event) => event.message === 'Discovery refresh scheduled.').length, 1);
});

test('invalidation during the ownership preflight cannot start a stale directory query', async (t) => {
	const f = discoveryFixture(t);
	const started = deferred();
	const release = deferred();
	let ownershipChecks = 0;
	let calls = 0;
	f.ownership.assertOwner = async () => {
		ownershipChecks += 1;
		if (ownershipChecks === 1) { started.resolve(); await release.promise; }
	};
	f.provider.list = async () => { calls += 1; return discoveryResult(); };
	const first = f.service.refresh();
	await started.promise;
	f.service.invalidate();
	const second = f.service.refresh();
	release.resolve();
	await Promise.all([first, second]);
	assert.equal(calls, 1);
	assert.equal(f.service.snapshot().state, 'ready');
});

test('disable and disposal cancel queued refreshes instead of restarting discovery', async (t) => {
	for (const action of ['disable', 'dispose'] as const) {
		await t.test(action, async (t) => {
			t.mock.timers.enable({ apis: ['setTimeout'] });
			const f = discoveryFixture(t);
			const started = deferred();
			const release = deferred();
			let calls = 0;
			f.provider.list = async () => {
				calls += 1; started.resolve(); await release.promise;
				return discoveryResult();
			};
			const first = f.service.refresh();
			await started.promise;
			f.service.invalidate();
			const queued = f.service.refresh();
			f.clock.enabled = false;
			const disposing = action === 'dispose' ? f.service.dispose() : undefined;
			if (action === 'disable') { f.service.invalidate(); }
			release.resolve();
			await Promise.all([first, queued, disposing]);
			f.clock.now += 120_000;
			t.mock.timers.tick(120_000);
			assert.equal(calls, 1);
			assert.equal(f.events.filter((event) => event.message === 'Discovery refresh scheduled.').length, 0);
			await assert.rejects(f.service.refresh(), { code: action === 'dispose' ? 'CANCELLED' : 'DISABLED' });
		});
	}
});

test('partial refreshes preserve only verified live endpoints and mark previous candidates stale until recovery', async (t) => {
	const f = discoveryFixture(t);
	const previous = f.provider.project(advertisedTunnel());
	const fresh = previous.map((endpoint) => ({
		...endpoint, locator: { ...endpoint.locator, advertisementId: uuid(889) },
	}));
	f.provider.list = async () => discoveryResult(previous);
	await f.service.refresh();
	const staleHandle = f.service.snapshot().candidates[0].candidateHandle;
	f.provider.list = async () => ({ ...discoveryResult(fresh), failedCandidateCount: 1, error: 'TIMEOUT' });
	f.clock.now += 10_001;
	await f.service.refresh();
	assert.equal(f.service.snapshot().state, 'partial');
	assert.equal(f.service.snapshot().error, 'TIMEOUT');
	assert.equal(f.service.snapshot().failedCandidateCount, 1);
	assert.deepEqual(f.service.endpoints(), fresh);
	assert.equal(f.service.snapshot().candidates.filter((candidate) => candidate.stale).length, 1);
	assert.throws(() => f.service.select(staleHandle), { code: 'BINDING_CHANGED' });
	f.provider.list = async () => discoveryResult(fresh);
	f.clock.now += 10_001;
	await f.service.refresh();
	assert.equal(f.service.snapshot().state, 'ready');
	assert.equal(f.service.snapshot().error, undefined);
	assert.equal(f.service.snapshot().candidates.length, 1);
	assert.equal(f.service.snapshot().failedCandidateCount, 0);
});

test('full transient failures stale the cache, while account and identity failures clear it', async (t) => {
	for (const code of ['TIMEOUT', 'AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED', 'BINDING_CHANGED', 'INVALID_ENDPOINT'] as const) {
		await t.test(code, async (t) => {
			const f = discoveryFixture(t);
			f.provider.list = async () => discoveryResult(f.provider.project(advertisedTunnel()));
			await f.service.refresh();
			const handle = f.service.snapshot().candidates[0].candidateHandle;
			f.provider.list = async () => { throw new ConnectivityError(code); };
			f.clock.now += 10_001;
			await f.service.refresh();
			assert.deepEqual(f.service.endpoints(), []);
			assert.deepEqual(f.service.advertisements(), []);
			assert.equal(f.service.snapshot().error, code);
			assert.equal(f.service.snapshot().candidates.length, code === 'TIMEOUT' ? 1 : 0);
			assert.throws(() => f.service.select(handle), { code: 'BINDING_CHANGED' });
		});
	}
});

test('ownership preflight failure cannot leave previously fresh endpoints selectable', async (t) => {
	const f = discoveryFixture(t);
	f.provider.list = async () => discoveryResult(f.provider.project(advertisedTunnel()));
	await f.service.refresh();
	const handle = f.service.snapshot().candidates[0].candidateHandle;
	f.ownership.owner = false;
	f.clock.now += 10_001;
	await assert.rejects(f.service.refresh());
	assert.deepEqual(f.service.endpoints(), []);
	assert.equal(f.service.snapshot().state, 'error');
	assert.throws(() => f.service.select(handle), { code: 'BINDING_CHANGED' });
});

test('idle polling slows down and explicit demand accelerates it without a burst of requests', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const f = discoveryFixture(t, { active: () => false, random: () => 0 });
	let calls = 0;
	const demand = deferred();
	f.provider.list = async () => {
		calls += 1;
		if (calls === 2) { demand.resolve(); }
		return discoveryResult();
	};
	await f.service.refresh();
	assert.equal(f.events.at(-1)?.fields.delayMs, 60_000);
	f.clock.now += 5000;
	await f.service.refresh({ interactive: true });
	assert.equal(calls, 1);
	assert.equal(f.events.at(-1)?.fields.delayMs, 5000);
	f.clock.now += 5000;
	t.mock.timers.tick(5000);
	await demand.promise;
	await f.service.refresh();
	assert.equal(calls, 2);
	assert.equal(f.events.at(-1)?.fields.delayMs, 15_000);
	f.clock.now += 60_001;
	await f.service.refresh();
	assert.equal(f.events.at(-1)?.fields.delayMs, 60_000);
});

test('manual retry bypasses local failure backoff but never the management rate-limit cooldown', async (t) => {
	for (const code of ['TIMEOUT', 'RATE_LIMITED'] as const) {
		await t.test(code, async (t) => {
			const f = discoveryFixture(t, { random: () => 0 });
			let failure: ConnectivityCode | undefined = code;
			let calls = 0;
			f.provider.list = async () => {
				calls += 1;
				if (failure !== undefined) { throw new ConnectivityError(failure, code === 'RATE_LIMITED' ? 60_000 : undefined); }
				return discoveryResult();
			};
			await f.service.refresh();
			failure = undefined;
			f.clock.now += 10_001;
			await f.service.refresh({ interactive: true });
			assert.equal(calls, code === 'RATE_LIMITED' ? 1 : 2);
			if (code === 'RATE_LIMITED') {
				f.clock.now += 50_000;
				await f.service.refresh({ interactive: true });
			}
			assert.equal(f.service.snapshot().error, undefined);
			assert.equal(f.service.snapshot().state, 'ready');
		});
	}
});

test('remote tool demand accelerates idle discovery but does not bypass a failed round backoff', async (t) => {
	const f = discoveryFixture(t, { active: () => false, random: () => 0 });
	let fail = false;
	let calls = 0;
	f.provider.list = async () => {
		calls += 1;
		if (fail) { throw new ConnectivityError('TIMEOUT'); }
		return discoveryResult();
	};
	await f.service.refresh();
	f.clock.now += 5000;
	await f.service.refresh({ demand: true });
	assert.equal(calls, 1);
	assert.equal(f.events.at(-1)?.fields.delayMs, 10_000);
	f.clock.now += 10_000;
	fail = true;
	await f.service.refresh({ demand: true });
	assert.equal(calls, 2);
	f.clock.now += 15_000;
	await f.service.refresh({ demand: true });
	assert.equal(calls, 2);
	assert.equal(f.events.at(-1)?.fields.delayMs, 45_000);
});

test('failed rounds back off within a hard cap and a delayed scheduled refresh is measured', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const f = discoveryFixture(t, { random: () => 0 });
	f.provider.list = async () => { throw new ConnectivityError('TIMEOUT'); };
	for (const expected of [60_000, 120_000, 240_000, 300_000, 300_000]) {
		await f.service.refresh();
		assert.equal(f.events.at(-1)?.fields.delayMs, expected);
		f.clock.now += expected;
	}
	const refreshed = deferred();
	f.provider.list = async () => { refreshed.resolve(); return discoveryResult(); };
	f.clock.now += 5000;
	t.mock.timers.tick(300_000);
	await refreshed.promise;
	await f.service.refresh();
	assert.ok(f.events.some((event) => event.message === 'Discovery refresh timer delayed.' && event.fields.timerDelayMs === 5000));
	assert.equal(f.events.at(-1)?.fields.delayMs, 15_000);
});

function discoveryResult(endpoints: readonly DiscoveredEndpoint[] = []): DiscoveryListResult {
	return { endpoints, advertisements: [], truncated: false, failedCandidateCount: 0, deferredCandidateCount: 0 };
}

function discoveryFixture(t: TestContext, options: ConstructorParameters<typeof DiscoveryService>[7] = {}) {
	const fixture = connectivityFixture();
	const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
		adapter: async () => { throw new Error('Refresh lifecycle tests must not make management requests.'); },
	});
	const provider = new DevTunnelDiscoveryProvider(management);
	const clock = { now: 1000, enabled: true };
	const events: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
	const service = new DiscoveryService(provider, fixture.fence,
		() => clock.enabled, () => true, () => undefined, () => clock.now,
		(message, fields) => { events.push({ message, fields }); }, options);
	t.after(async () => { await service.dispose(); await management.dispose(); fixture.account.dispose(); });
	return { ...fixture, provider, service, clock, events };
}
