import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { DevTunnelDiscoveryProvider } from '../connectivity/DevTunnelDiscoveryProvider';
import { DevTunnelManagement } from '../connectivity/DevTunnelManagement';
import { DiscoveryService } from '../connectivity/DiscoveryService';
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
			return { endpoints: f.provider.project(advertisedTunnel()), truncated: false };
		}
		if (calls === 3) { timerStarted.resolve(); }
		return { endpoints: fresh, truncated: false };
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
		return { endpoints: [], truncated: false };
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
	f.provider.list = async () => { calls += 1; return { endpoints: [], truncated: false }; };
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
				return { endpoints: [], truncated: false };
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

function discoveryFixture(t: TestContext) {
	const fixture = connectivityFixture();
	const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
		adapter: async () => { throw new Error('Refresh lifecycle tests must not make management requests.'); },
	});
	const provider = new DevTunnelDiscoveryProvider(management);
	const clock = { now: 1000, enabled: true };
	const events: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
	const service = new DiscoveryService(provider, fixture.fence,
		() => clock.enabled, () => true, () => undefined, () => clock.now,
		(message, fields) => { events.push({ message, fields }); });
	t.after(async () => { await service.dispose(); await management.dispose(); fixture.account.dispose(); });
	return { ...fixture, provider, service, clock, events };
}
