import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Tunnel } from '@microsoft/dev-tunnels-contracts';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

import { ConnectivityOperation } from '../connectivity/ConnectivityOperations';
import { ADVERTISEMENT_PREFIX, ConnectivityError } from '../connectivity/ConnectivitySchemas';
import { DevTunnelDiscoveryProvider } from '../connectivity/DevTunnelDiscoveryProvider';
import { DevTunnelManagement, normalizeConnectivityError } from '../connectivity/DevTunnelManagement';
import { uuid } from './artifactStoreTestSupport';
import { advertisedTunnel, connectivityFixture, deferred, sdkResponse } from './connectivityTestSupport';

test('a slow successful list leaves an independent bounded budget for exact details', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	const listed = deferred();
	const releaseList = deferred();
	const detailed = deferred();
	const releaseDetail = deferred();
	const tunnel = namedTunnel('mesh-slow-list');
	const f = setup(t, async (config) => {
		if (isList(config)) {
			listed.resolve();
			await releaseList.promise;
			return sdkResponse(config, { value: [{ value: [{ ...tunnel, ports: [] }] }] });
		}
		detailed.resolve();
		await releaseDetail.promise;
		return sdkResponse(config, tunnel);
	}, { listTimeoutMs: 100, detailTimeoutMs: 100, roundTimeoutMs: 200 });
	const pending = f.provider.list(new AbortController().signal);
	await listed.promise;
	t.mock.timers.tick(90);
	releaseList.resolve();
	await detailed.promise;
	t.mock.timers.tick(50);
	releaseDetail.resolve();
	const result = await pending;
	assert.equal(result.endpoints.length, 1);
	assert.equal(result.failedCandidateCount, 0);
	assert.equal(result.error, undefined);
});

test('one timed-out detail does not discard validated peers or skip later healthy details', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	const ready = namedTunnel('mesh-ready');
	const slow = namedTunnel('mesh-slow');
	const later = namedTunnel('mesh-later');
	const started = deferred();
	const paths: string[] = [];
	const f = setup(t, async (config) => {
		const path = new URL(config.url!).pathname;
		paths.push(path);
		if (isList(config)) {
			return sdkResponse(config, { value: [{ value: [ready, { ...slow, ports: [] }, { ...later, ports: [] }] }] });
		}
		if (path.endsWith(slow.tunnelId!)) { started.resolve(); return abortRequest(config); }
		return sdkResponse(config, later);
	}, { detailTimeoutMs: 50, roundTimeoutMs: 200 });
	const pending = f.provider.list(new AbortController().signal);
	await started.promise;
	t.mock.timers.tick(50);
	const result = await pending;
	assert.deepEqual(result.endpoints.map((endpoint) => endpoint.locator.tunnelId), [ready.tunnelId, later.tunnelId]);
	assert.equal(result.error, 'TIMEOUT');
	assert.equal(result.failedCandidateCount, 1);
	assert.equal(result.deferredCandidateCount, 0);
	assert.equal(result.advertisements.length, 3);
	assert.equal(paths.length, 3);
});

test('the round deadline bounds all detail budgets and defers remaining work explicitly', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	const ready = namedTunnel('mesh-ready');
	const first = deferred();
	const second = deferred();
	let details = 0;
	const f = setup(t, async (config) => {
		if (isList(config)) {
			return sdkResponse(config, { value: [{ value: [
				ready, ...[1, 2, 3].map((index) => ({ ...namedTunnel(`mesh-wait-${index}`), ports: [] })),
			] }] });
		}
		details += 1;
		(details === 1 ? first : second).resolve();
		return abortRequest(config);
	}, { detailTimeoutMs: 80, roundTimeoutMs: 100 });
	const pending = f.provider.list(new AbortController().signal);
	await first.promise;
	t.mock.timers.tick(80);
	await second.promise;
	t.mock.timers.tick(20);
	const result = await pending;
	assert.equal(details, 2);
	assert.equal(result.endpoints.length, 1);
	assert.equal(result.failedCandidateCount, 2);
	assert.equal(result.deferredCandidateCount, 1);
	assert.equal(result.error, 'TIMEOUT');
});

test('offline incomplete advertisements are retained without requests unless a live binding needs their details', async (t) => {
	for (const needsDetail of [false, true]) {
		await t.test(String(needsDetail), async (t) => {
			const offline = namedTunnel('mesh-offline', 0);
			let calls = 0;
			const f = setup(t, async (config) => {
				calls += 1;
				return sdkResponse(config, isList(config) ? { value: [{ value: [{ ...offline, ports: [] }] }] } : offline);
			}, { needsDetail: () => needsDetail });
			const result = await f.provider.list(new AbortController().signal);
			assert.equal(calls, needsDetail ? 2 : 1);
			assert.equal(result.endpoints.length, needsDetail ? 1 : 0);
			assert.equal(result.advertisements.length, 1);
			assert.equal(result.deferredCandidateCount, needsDetail ? 0 : 1);
			assert.equal(result.error, undefined);
		});
	}
});

test('candidate backoff preserves errors, resets for new advertisements, and clears only after verified recovery', async (t) => {
	let now = 0;
	let details = 0;
	let broken = true;
	let tunnel = namedTunnel('mesh-retry');
	const f = setup(t, async (config) => {
		if (isList(config)) {
			return sdkResponse(config, { value: [{ value: [{ ...tunnel, ports: [] }] }] });
		}
		details += 1;
		if (broken) { throw new AxiosError('synthetic-private-value', 'ETIMEDOUT', config); }
		return sdkResponse(config, tunnel);
	}, { now: () => now });
	const list = () => f.provider.list(new AbortController().signal);
	assert.equal((await list()).failedCandidateCount, 1);
	now = 10_000;
	const deferredResult = await list();
	assert.equal(details, 1);
	assert.equal(deferredResult.deferredCandidateCount, 1);
	assert.equal(deferredResult.error, 'TIMEOUT');
	now = 30_000;
	assert.equal((await list()).failedCandidateCount, 1);
	assert.equal(details, 2);
	now = 40_000;
	assert.equal((await list()).deferredCandidateCount, 1);
	assert.equal(details, 2);
	tunnel = { ...tunnel, labels: [...tunnel.labels!.filter((label) => !label.startsWith(ADVERTISEMENT_PREFIX)),
		`${ADVERTISEMENT_PREFIX}${uuid(899)}`] };
	broken = false;
	const recovered = await list();
	assert.equal(details, 3);
	assert.equal(recovered.error, undefined);
	assert.equal(recovered.endpoints.length, 1);
	assert.equal(recovered.deferredCandidateCount, 0);
	assert.doesNotMatch(JSON.stringify(f.events), /synthetic-private-value|Authorization|accessTokens/u);
});

test('a complete fresh summary recovers without waiting for a previous detail backoff', async (t) => {
	let complete = false;
	let details = 0;
	const tunnel = namedTunnel('mesh-recovered');
	const f = setup(t, async (config) => {
		if (isList(config)) {
			return sdkResponse(config, { value: [{ value: [{ ...tunnel, ...(complete ? {} : { ports: [] }) }] }] });
		}
		details += 1;
		throw new AxiosError('timeout', 'ETIMEDOUT', config);
	});
	assert.equal((await f.provider.list(new AbortController().signal)).error, 'TIMEOUT');
	complete = true;
	const recovered = await f.provider.list(new AbortController().signal);
	assert.equal(details, 1);
	assert.equal(recovered.error, undefined);
	assert.equal(recovered.endpoints.length, 1);
});

test('account changes between list and details abort the whole generation rather than mixing accounts', async (t) => {
	let calls = 0;
	const f = setup(t, async (config) => {
		calls += 1;
		return sdkResponse(config, { value: [{ value: [{ ...namedTunnel('mesh-account'), ports: [] }] }] });
	});
	const run = f.management.run.bind(f.management);
	f.management.run = async (action, signal, options) => {
		const result = await run(action, signal, options);
		if (options?.phase === 'discovery.list') { f.authentication.changed(); }
		return result;
	};
	await assert.rejects(f.provider.list(new AbortController().signal), { code: 'CANCELLED' });
	assert.equal(calls, 1);
});

test('authentication failures are fatal even when other summaries were valid', async (t) => {
	const f = setup(t, async (config) => {
		if (isList(config)) {
			return sdkResponse(config, { value: [{ value: [namedTunnel('mesh-safe'), { ...namedTunnel('mesh-auth'), ports: [] }] }] });
		}
		throw new AxiosError('private-auth-diagnostic', 'AUTH', config, undefined, sdkResponse(config, {}, 403));
	});
	await assert.rejects(f.provider.list(new AbortController().signal), { code: 'AUTH_REQUIRED' });
});

test('a known authentication rejection cannot be downgraded to a partial timeout by a late deadline', async (t) => {
	let now = 0;
	t.mock.method(Date, 'now', () => now);
	const f = setup(t, async (config) => {
		if (isList(config)) {
			return sdkResponse(config, { value: [{ value: [namedTunnel('mesh-safe'), { ...namedTunnel('mesh-auth'), ports: [] }] }] });
		}
		now = 200;
		throw new AxiosError('private-auth-diagnostic', 'AUTH', config, undefined, sdkResponse(config, {}, 401));
	}, { listTimeoutMs: 100, detailTimeoutMs: 100, roundTimeoutMs: 150 });
	await assert.rejects(f.provider.list(new AbortController().signal), { code: 'AUTH_REQUIRED' });
});

test('known identity, policy and authentication failures take precedence over a concurrent deadline', () => {
	for (const code of ['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED', 'BINDING_CHANGED', 'INVALID_ENDPOINT', 'POLICY_DENIED', 'PRIVATE_ACCESS_REQUIRED'] as const) {
		assert.equal(normalizeConnectivityError(new ConnectivityError(code), new ConnectivityError('TIMEOUT')).code, code);
	}
});

test('unsafe summaries cannot be hidden behind deferred or slow candidates', async (t) => {
	let calls = 0;
	const f = setup(t, async (config) => {
		calls += 1;
		return sdkResponse(config, { value: [{ value: [
			{ ...namedTunnel('mesh-offline', 0), ports: [] },
			{ ...namedTunnel('mesh-invalid', 0), ports: [], clusterId: 'untrusted.example' },
		] }] });
	});
	await assert.rejects(f.provider.list(new AbortController().signal), { code: 'INVALID_ENDPOINT' });
	assert.equal(calls, 1);
});

test('management diagnostics distinguish authentication waits from HTTP time without credentials', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	const started = deferred();
	const release = deferred();
	let requests = 0;
	const f = setup(t, async (config) => {
		requests += 1;
		return sdkResponse(config, { value: [] });
	}, { listTimeoutMs: 100 });
	const getAccounts = f.authentication.getAccounts.bind(f.authentication);
	f.authentication.getAccounts = async () => { started.resolve(); await release.promise; return getAccounts(); };
	t.after(() => release.resolve());
	const pending = assert.rejects(f.provider.list(new AbortController().signal), { code: 'TIMEOUT' });
	await started.promise;
	t.mock.timers.tick(100);
	await pending;
	assert.equal(requests, 0);
	const timing = f.events.find((event) => event.message === 'Connectivity management operation timing.')?.fields;
	assert.equal(timing?.phase, 'discovery.list');
	assert.equal(timing?.stage, 'authorization');
	assert.equal(timing?.authMs, 100);
	assert.equal(timing?.httpMs, 0);
	assert.equal(timing?.code, 'TIMEOUT');
	assert.doesNotMatch(JSON.stringify(f.events), /synthetic-test-oauth|Authorization|accessTokens/u);
});

test('connectivity cancellation keeps its original cause and reports delayed deadlines', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let now = 0;
	t.mock.method(Date, 'now', () => now);
	const parent = new AbortController();
	const cancelled = new ConnectivityOperation(100, parent.signal);
	const timed = new ConnectivityOperation(100);
	t.after(() => { cancelled.dispose(); timed.dispose(); });
	parent.abort();
	now = 175;
	t.mock.timers.tick(100);
	assert.equal(cancelled.cancellationError?.code, 'CANCELLED');
	assert.equal(timed.cancellationError?.code, 'TIMEOUT');
	assert.equal(timed.deadlineDelayMs, 75);
});

function namedTunnel(tunnelId: string, hostConnectionCount = 1): Tunnel {
	const base = advertisedTunnel();
	return { ...base, tunnelId, status: { hostConnectionCount },
		ports: base.ports.map((port) => ({ ...port, portForwardingUris: [`https://${tunnelId}-${port.portNumber}.use2.devtunnels.ms`] })) };
}

function isList(config: InternalAxiosRequestConfig): boolean { return new URL(config.url!).pathname === '/tunnels'; }

function abortRequest(config: InternalAxiosRequestConfig): Promise<never> {
	return new Promise((_, reject) => {
		const abort = () => reject(new AxiosError('cancelled', 'ERR_CANCELED', config));
		if (config.signal?.aborted) { abort(); }
		else { config.signal?.addEventListener?.('abort', abort, { once: true }); }
	});
}

function setup(t: TestContext, adapter: AxiosAdapter, options: ConstructorParameters<typeof DevTunnelDiscoveryProvider>[2] = {}) {
	const base = connectivityFixture();
	const events: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
	const diagnostics = (message: string, fields: Readonly<Record<string, unknown>>) => { events.push({ message, fields }); };
	const management = new DevTunnelManagement(base.account, base.fence, () => true, { adapter, diagnostics });
	const provider = new DevTunnelDiscoveryProvider(management, diagnostics, options);
	t.after(async () => { await management.dispose(); base.account.dispose(); });
	return { ...base, provider, management, events };
}
