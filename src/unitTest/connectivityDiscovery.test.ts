import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios';

import { ConnectivityError, DISCOVERY_LABELS } from '../connectivity/ConnectivitySchemas';
import { DevTunnelDiscoveryProvider } from '../connectivity/DevTunnelDiscoveryProvider';
import { createGuardedTunnelHttpAdapter, DevTunnelManagement, guardedTunnelHttpAdapter } from '../connectivity/DevTunnelManagement';
import { DiscoveryService } from '../connectivity/DiscoveryService';
import { validateForwardingOrigin, validateManagementUri } from '../connectivity/DevTunnelUris';
import { advertisedTunnel, connectivityFixture, sdkResponse } from './connectivityTestSupport';

test('SDK discovery requests owned, all-label metadata without tokenScopes and projects unknown presence', async (t) => {
	const fixture = connectivityFixture();
	const requests: URL[] = [];
	const adapter: AxiosAdapter = async (config) => {
		requests.push(new URL(config.url!));
		assert.equal(config.headers.Authorization, 'github synthetic-test-oauth-value');
		assert.equal(config.maxRedirects, 0);
		return sdkResponse(config, { value: [{ regionName: 'test', value: [advertisedTunnel()] }] });
	};
	const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, { adapter });
	t.after(async () => { await management.dispose(); fixture.account.dispose(); });
	const provider = new DevTunnelDiscoveryProvider(management);
	const result = await provider.list(new AbortController().signal);
	assert.equal(result.endpoints.length, 1);
	assert.equal(result.endpoints[0].hostHint, 'unknown');
	assert.equal(requests[0].searchParams.has('tokenScopes'), false);
	assert.equal(requests[0].searchParams.get('global'), 'true');
	assert.equal(requests[0].searchParams.get('allLabels'), 'true');
	for (const label of DISCOVERY_LABELS) { assert.match(requests[0].search, new RegExp(label, 'u')); }
	assert.doesNotMatch(JSON.stringify(result), /synthetic-test-oauth|account|Workspace|accessTokens/u);
});

test('disabled discovery and a non-owner never request authentication or management', async (t) => {
	const fixture = connectivityFixture();
	let calls = 0;
	let enabled = false;
	const management = new DevTunnelManagement(fixture.account, fixture.fence, () => enabled, {
		adapter: async (config) => { calls += 1; return sdkResponse(config, {}); },
	});
	t.after(async () => { await management.dispose(); fixture.account.dispose(); });
	const list = () => new DevTunnelDiscoveryProvider(management).list(new AbortController().signal);
	await assert.rejects(list(), { code: 'DISABLED' });
	enabled = true;
	fixture.ownership.owner = false;
	await assert.rejects(list());
	assert.equal(calls, 0);
	assert.equal(fixture.authentication.requests.length, 0);
});

test('silent account reads reject missing sessions, wrong accounts and changed scopes without broader consent', async (t) => {
	const fixture = connectivityFixture();
	t.after(() => fixture.account.dispose());
	fixture.authentication.session = undefined;
	await assert.rejects(fixture.account.authorization(new AbortController().signal), { code: 'AUTH_REQUIRED' });
	fixture.authentication.session = {
		id: 's', account: { id: 'wrong-account', label: 'Test' },
		scopes: ['read:org', 'user:email'], accessToken: 'fake',
	};
	await assert.rejects(fixture.account.authorization(new AbortController().signal), { code: 'ACCOUNT_CHANGED' });
	fixture.authentication.session = {
		...fixture.authentication.session,
		account: { id: 'approved-test-account', label: 'Test' }, scopes: ['repo', 'read:org', 'user:email'],
	};
	await assert.rejects(fixture.account.authorization(new AbortController().signal), { code: 'SCOPES_CHANGED' });
	assert.ok(fixture.authentication.requests.every((request) => request.silent === true && request.createIfNone === undefined));
});

test('silent reuse selects the persisted ID but supplies the native provider account label', async (t) => {
	const fixture = connectivityFixture();
	t.after(() => fixture.account.dispose());
	const native = fixture.authentication.session!.account;
	assert.notEqual(native.id, native.label);
	const getSession = fixture.authentication.getSession.bind(fixture.authentication);
	fixture.authentication.getSession = async (provider, scopes, options) => {
		assert.deepEqual(options.account, native);
		return getSession(provider, scopes, options);
	};
	assert.equal(await fixture.account.authorization(new AbortController().signal), 'github synthetic-test-oauth-value');
	fixture.authentication.accounts = [{ ...native, id: 'different-id-with-the-same-label' }];
	await assert.rejects(fixture.account.authorization(new AbortController().signal), { code: 'ACCOUNT_CHANGED' });
	assert.equal(fixture.authentication.requests.length, 1);
});

test('native authentication rejection stays an authentication error without exposing provider diagnostics', async (t) => {
	const fixture = connectivityFixture();
	t.after(() => fixture.account.dispose());
	fixture.authentication.getSession = async () => {
		throw new Error('Native provider rejected token=synthetic-private-value /private/test-profile');
	};
	await assert.rejects(fixture.account.select('github'), (error: unknown) =>
		error instanceof ConnectivityError && error.code === 'AUTH_REQUIRED'
		&& !JSON.stringify(error).includes('synthetic-private-value'));
});

test('SDK timeout cancels its actual HTTP signal; account changes cancel active requests', async (t) => {
	const fixture = connectivityFixture();
	let aborted = 0;
	let started!: () => void;
	let startedPromise = new Promise<void>((resolve) => { started = resolve; });
	const adapter: AxiosAdapter = async (config) => new Promise((_, reject) => {
		started();
		const abort = (): void => { aborted += 1; reject(new AxiosError('synthetic-private-detail', 'ERR_CANCELED', config)); };
		if (config.signal?.aborted) { abort(); }
		else { config.signal?.addEventListener?.('abort', abort, { once: true }); }
	});

	const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, { adapter, timeoutMs: 20 });
	t.after(async () => { await management.dispose(); fixture.account.dispose(); });
	const provider = new DevTunnelDiscoveryProvider(management);
	await assert.rejects(provider.list(new AbortController().signal), { code: 'TIMEOUT' });
	startedPromise = new Promise<void>((resolve) => { started = resolve; });
	const request = provider.list(new AbortController().signal);
	await startedPromise;
	fixture.authentication.changed();
	await assert.rejects(request, { code: 'CANCELLED' });
	assert.equal(aborted, 2);
});

test('rate limiting is bounded and cannot leak raw SDK request headers through errors', async (t) => {
	const fixture = connectivityFixture();
	let calls = 0;
	const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
		adapter: async (config) => {
			calls += 1;
			throw new AxiosError('secret-synthetic-original-error', 'RATE_LIMIT', config, undefined, {
				...sdkResponse(config, {}, 429), headers: new AxiosHeaders({ 'retry-after': '999999' }),
			});
		},
	});
	t.after(async () => { await management.dispose(); fixture.account.dispose(); });
	await assert.rejects(new DevTunnelDiscoveryProvider(management).list(new AbortController().signal), (error: unknown) =>
		error instanceof ConnectivityError && error.code === 'RATE_LIMITED' && error.retryAfterMs === 300_000
		&& !JSON.stringify(error).includes('synthetic'));
	await assert.rejects(new DevTunnelDiscoveryProvider(management).list(new AbortController().signal), { code: 'RATE_LIMITED' });
	assert.equal(calls, 1);
});

test('management redirects preserve method/path/query and keep credentials only on validated service clusters', async () => {
	let requests = 0;
	let destination = 'https://use2.rel.tunnels.api.visualstudio.com/tunnels?global=true';
	const send: AxiosAdapter = async (config) => {
		requests += 1;
		if (new URL(config.url!).hostname.startsWith('global.')) {
			throw new AxiosError('redirect', 'REDIRECT', config, undefined, {
				...sdkResponse(config, {}, 307), headers: new AxiosHeaders({ location: destination }),
			});
		}
		assert.equal(config.maxRedirects, 0);
		assert.equal(config.headers.Authorization, 'synthetic-service-credential');
		return sdkResponse(config, {});
	};
	const config = { url: 'https://global.rel.tunnels.api.visualstudio.com/tunnels?global=true',
		method: 'get', headers: new AxiosHeaders({ Authorization: 'synthetic-service-credential' }) };
	await createGuardedTunnelHttpAdapter(send)(config);
	assert.equal(requests, 2);
	destination = 'https://evil.example/tunnels?global=true';
	await assert.rejects(createGuardedTunnelHttpAdapter(send)(config), { code: 'INVALID_ENDPOINT' });
	assert.equal(requests, 3);
	destination = 'https://use2.rel.tunnels.api.visualstudio.com/different-path';
	await assert.rejects(createGuardedTunnelHttpAdapter(send)(config), { code: 'INVALID_ENDPOINT' });
	assert.equal(requests, 4);
});

test('URI validation rejects redirects, userinfo, lookalike domains, ports, secret queries and fragments', async () => {
	for (const uri of [
		'https://evil.example/', 'http://x.devtunnels.ms/', 'https://x.devtunnels.ms.evil.example/',
		'https://user:pass@abc-43121.devtunnels.ms/', 'https://abc-43121.devtunnels.ms:444/',
		'https://abc-43121.devtunnels.ms/?token=private', 'https://abc-43121.devtunnels.ms/#private',
		'https://abc-43121.devtunnels.ms/redirect',
	]) { assert.throws(() => validateForwardingOrigin(uri), { code: 'INVALID_ENDPOINT' }); }
	assert.throws(() => validateForwardingOrigin('https://abc-111.devtunnels.ms/', 222), { code: 'INVALID_ENDPOINT' });
	assert.throws(() => validateManagementUri('https://global.rel.tunnels.api.visualstudio.com.evil.example/'));
	await assert.rejects(guardedTunnelHttpAdapter({
		url: 'https://evil.example/tunnels', method: 'get', headers: new AxiosHeaders({ Authorization: 'synthetic' }),
	}), { code: 'INVALID_ENDPOINT' });
});

test('candidate snapshots contain only short markers, invalidate handles on account change, and never expose Workspace data', async (t) => {
	const fixture = connectivityFixture();
	const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
		adapter: async (config) => sdkResponse(config, { value: [{ value: [advertisedTunnel()] }] }),
	});
	let now = 1000;
	const discovery = new DiscoveryService(new DevTunnelDiscoveryProvider(management), fixture.fence,
		() => true, () => true, () => undefined, () => now);
	t.after(async () => { await discovery.dispose(); await management.dispose(); fixture.account.dispose(); });
	await discovery.refresh();
	const snapshot = discovery.snapshot();
	assert.equal(snapshot.candidates[0].hostHint, 'unknown');
	assert.doesNotMatch(JSON.stringify(snapshot), /mesh-test|devtunnels|43121|accountId|Workspace|secret/u);
	now += 120_001;
	assert.equal(discovery.snapshot().candidates[0].stale, true);
	assert.throws(() => discovery.select(snapshot.candidates[0].candidateHandle), { code: 'BINDING_CHANGED' });
	discovery.invalidate();
	assert.equal(discovery.snapshot().candidates.length, 0);
});
