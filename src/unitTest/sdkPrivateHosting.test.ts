import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AxiosError, type AxiosAdapter } from 'axios';
import { Emitter } from 'vscode-jsonrpc';
import {
	ConnectionStatus, type ConnectionStatusChangedEventArgs, type RefreshingTunnelAccessTokenEventArgs,
	type RefreshingTunnelEventArgs, type TunnelRelayStreamFactory,
} from '@microsoft/dev-tunnels-connections';
import { TunnelAccessControlEntryType, TunnelConnectionMode, type Tunnel } from '@microsoft/dev-tunnels-contracts';
import type { TunnelManagementHttpClient } from '@microsoft/dev-tunnels-management';

import { DevTunnelManagement } from '../connectivity/DevTunnelManagement';
import { SdkDevTunnelExposureProvider, type SdkTunnelHost } from '../tunnel/SdkDevTunnelExposureProvider';
import { SelectedExposureProvider } from '../tunnel/SelectedExposureProvider';
import type { RemoteExposureProvider } from '../tunnel/RemoteExposureProvider';
import { validateRelayUri } from '../tunnel/SdkRelayStreamFactory';
import { connectivityFixture, sdkResponse, syntheticCapability, TEST_LOCATOR } from './connectivityTestSupport';

test('SDK private hosting uses real published management contracts, a Host-only client and exact-port Connect capability without anonymous ACEs', async (t) => {
	const f = await sdkFixture();
	t.after(() => f.dispose());
	const exposure = await f.provider.start({ localPort: 43121, deviceId: 'unused-by-sdk' });
	assert.equal(exposure.provider, 'sdk');
	assert.equal(exposure.admission, 'private-port-token');
	assert.equal(f.hosts.length, 1);
	assert.equal(f.hosts[0].forwardConnectionsToLocalPorts, true);
	const created = f.api.calls.find((call) => call.method === 'put' && !call.path.includes('endpoints'));
	assert.ok(created);
	assert.deepEqual(created.body?.accessControl, { entries: [] });
	assert.deepEqual(created.body?.ports?.[0]?.accessControl, { entries: [] });
	assert.equal(created.scopes, 'host');
	const endpoint = f.api.calls.find((call) => call.path.includes('endpoints'));
	assert.ok(endpoint);
	assert.equal(endpoint.scheme, 'tunnel');
	const capability = f.api.calls.find((call) => call.path.endsWith('/ports/43121'));
	assert.equal(capability?.scopes, 'connect');
	assert.equal(f.probes, 1);
	assert.doesNotMatch(JSON.stringify(exposure), /build|decoderRevision|accessIndex|accessTokens/u);
	assert.doesNotMatch([...f.fs.files.values()].join(''), /eyJ|synthetic-test-oauth|synthetic-signature|accessTokens/u);
	await f.provider.stop();
	assert.equal(f.provider.getStatus().state, 'stopped');
	await f.provider.start({ localPort: 43121, deviceId: 'unused-by-sdk' });
	assert.equal(f.api.calls.filter((call) => call.method === 'put' && !call.path.includes('endpoints')).length, 1);
	await f.provider.deleteOwnedResource();
	assert.equal(f.provider.ownedResource(), undefined);
	assert.equal(f.api.tunnel, undefined);
});

test('missing capability, a wrong port and unexpected anonymous ACE each fail closed without a legacy host', async () => {
	for (const fault of ['missing', 'wrongPort', 'anonymous'] as const) {
		const f = await sdkFixture();
		try {
			f.api.fault = fault;
			await assert.rejects(f.provider.start({ localPort: 43121, deviceId: 'sdk-device' }));
			assert.notEqual(f.provider.getStatus().state, 'ready');
			assert.equal(f.api.calls.some((call) => call.body?.accessControl?.entries.some((entry) => entry.type === TunnelAccessControlEntryType.Anonymous)), false);
			assert.ok(f.provider.ownedResource());
			assert.equal(f.hosts.every((host) => host.disposed), true);
		} finally { await f.dispose(); }
	}
});

test('renewal failure shuts down private hosting; account change cannot silently reuse a resource under a different account', async (t) => {
	const f = await sdkFixture();
	t.after(() => f.dispose());
	await f.provider.start({ localPort: 43121, deviceId: 'sdk-device' });
	f.api.failHostRefresh = true;
	await assert.rejects(f.provider.renew());
	assert.equal(f.provider.getStatus().state, 'circuit-open');
	assert.equal(f.hosts[0].disposed, true);
	f.api.failHostRefresh = false;
	f.account.setBinding({ ...f.account.current()!, accountRef: '00000000-0000-4000-8000-000000000799' });
	await assert.rejects(f.provider.start({ localPort: 43121, deviceId: 'sdk-device' }), { code: 'ACCOUNT_CHANGED' });
	assert.equal(f.hosts.length, 1);
});

test('SDK cleanup failure is retryable and an old active/unknown host remains a persistent stop barrier across repeated starts', async (t) => {
	const f = await sdkFixture();
	t.after(() => f.dispose());
	await f.provider.start({ localPort: 43121, deviceId: 'sdk-device' });
	f.api.failEndpointDelete = true;
	await assert.rejects(f.provider.stop(), { code: 'CLEANUP_FAILED' });
	assert.equal(f.provider.getStatus().state, 'cleanup-failed');
	f.api.failEndpointDelete = false;
	await f.provider.retryCleanup();
	assert.equal(f.provider.getStatus().state, 'stopped');
	const ledger = [...f.fs.files.keys()].find((path) => path.endsWith('/sdk-hosting.json'));
	assert.ok(ledger);
	const stored = JSON.parse(f.fs.files.get(ledger)!);
	stored.owned.phase = 'hosting';
	f.fs.files.set(ledger, JSON.stringify(stored));
	f.api.hostCount = undefined;
	const restored = f.newProvider();
	await restored.initialize();
	for (let index = 0; index < 2; index += 1) {
		await assert.rejects(restored.start({ localPort: 43121, deviceId: 'sdk-device' }), { code: 'CLEANUP_FAILED' });
		assert.equal(restored.ownedResource()?.phase, 'hosting');
	}
	await restored.dispose();
});

test('only one backend can host; a private start failure never invokes CLI until explicit stop and selection', async (t) => {
	const f = await sdkFixture();
	t.after(() => f.dispose());
	let cliStarts = 0;
	const cli: RemoteExposureProvider = {
		providerId: 'cli', probe: async () => ({ supported: true }),
		start: async () => {
			cliStarts += 1;
			return { provider: 'cli', admission: 'legacy-mesh-auth', forwardingOrigin: 'https://mesh-test-43121.use2.devtunnels.ms',
				localPort: 43121, resource: TEST_LOCATOR, ownershipLabel: 'legacy-owned' };
		},
		stop: async () => undefined, dispose: async () => undefined,
		getStatus: () => ({ state: 'stopped' }), onDidChange: () => ({ dispose: () => undefined }),
	};
	let selected: 'cli' | 'sdk' = 'sdk';
	const selector = new SelectedExposureProvider(cli, f.provider, () => selected, () => true);
	f.api.fault = 'missing';
	await assert.rejects(selector.start({ localPort: 43121, deviceId: 'sdk-device' }));
	assert.equal(cliStarts, 0);
	selected = 'cli';
	await assert.rejects(selector.start({ localPort: 43121, deviceId: 'sdk-device' }), { code: 'MIGRATION_REQUIRED' });
	assert.equal(cliStarts, 0);
	await selector.stop();
	await selector.start({ localPort: 43121, deviceId: 'sdk-device' });
	assert.equal(cliStarts, 1);
	await selector.dispose();
});

test('relay targets reject credential-bearing and non-service URIs before constructing a socket', () => {
	for (const uri of [
		'wss://evil.example/host/one', 'ws://use2-data.rel.tunnels.api.visualstudio.com/host/one',
		'wss://user:secret@use2-data.rel.tunnels.api.visualstudio.com/host/one',
		'wss://use2-data.rel.tunnels.api.visualstudio.com/host/one?token=synthetic',
	]) { assert.throws(() => validateRelayUri(uri), { code: 'INVALID_ENDPOINT' }); }
	validateRelayUri('wss://use2-data.rel.tunnels.api.visualstudio.com/host/one');
});

test('a non-owner does not obtain an account token, create a resource or construct an SDK host', async (t) => {
	const f = await sdkFixture();
	t.after(async () => { f.ownership.owner = true; await f.dispose(); });
	f.ownership.owner = false;
	await assert.rejects(f.provider.start({ localPort: 43121, deviceId: 'sdk-device' }));
	assert.equal(f.api.calls.length, 0);
	assert.equal(f.authentication.requests.length, 0);
	assert.equal(f.hosts.length, 0);
});

test('stop aborts the actual SDK endpoint-registration HTTP request and still completes exact endpoint cleanup', async (t) => {
	const f = await sdkFixture();
	t.after(() => f.dispose());
	f.api.blockEndpointPut = true;
	const start = f.provider.start({ localPort: 43121, deviceId: 'sdk-device' });
	const rejected = assert.rejects(start, { code: 'CANCELLED' });
	await f.api.endpointStarted;
	const stoppedAt = Date.now();
	await f.provider.stop();
	await rejected;
	assert.ok(Date.now() - stoppedAt < 1000);
	assert.equal(f.api.endpointAborted, 1);
	assert.equal(f.provider.getStatus().state, 'stopped');
	assert.ok(f.api.calls.some((call) => call.method === 'delete' && call.path.endsWith('/endpoints/test-owned-endpoint')));
	assert.equal(f.provider.ownedResource()?.endpointId, undefined);
});

test('the production default constructs the published SDK host and reaches scoped endpoint registration without a host double', async (t) => {
	const f = await sdkFixture();
	const provider = f.newProvider(true);
	await provider.initialize();
	t.after(async () => { await provider.dispose(); await f.dispose(); });
	// The offline service deliberately omits a relay URI, so the real SDK must stop
	// before any data-plane connection rather than fabricate a ready host.
	await assert.rejects(provider.start({ localPort: 43121, deviceId: 'sdk-device' }));
	const registration = f.api.calls.find((call) => call.method === 'put' && call.path.includes('/endpoints/'));
	assert.ok(registration);
	assert.match(registration.path, /\/endpoints\/[0-9a-f-]+-relay$/u);
	assert.equal(registration.scheme, 'tunnel');
	assert.equal(Object.hasOwn(registration.body ?? {}, 'hostPublicKeys'), true);
	assert.notEqual(provider.getStatus().state, 'ready');
	assert.equal(f.hosts.length, 0);
});

async function sdkFixture() {
	const base = connectivityFixture();
	const api = new TestTunnelApi();
	const management = new DevTunnelManagement(base.account, base.fence, () => true, { adapter: api.adapter });
	const hosts: TestSdkHost[] = [];
	let probes = 0;
	const newProvider = (publishedHost = false) => new SdkDevTunnelExposureProvider(base.files, base.fence, management, base.account, {
		enabled: () => true, advertisementId: () => TEST_LOCATOR.advertisementId,
		hostAdapter: api.adapter,
		hostFactory: publishedHost ? undefined : (client) => { const host = new TestSdkHost(client); hosts.push(host); return host; },
		probe: async (_origin, token) => {
			assert.equal(token, api.connectCapability); // synthetic private-service fixture, not a live ingress gate
			probes += 1;
		},
	});
	const provider = newProvider();
	await provider.initialize();
	return {
		...base, api, provider, hosts, newProvider,
		get probes() { return probes; },
		dispose: async () => { await provider.dispose(); await management.dispose(); base.account.dispose(); },
	};
}

class TestSdkHost implements SdkTunnelHost {
	public tunnel: Tunnel | null = null;
	public disposed = false;
	public streamFactory!: TunnelRelayStreamFactory;
	public forwardConnectionsToLocalPorts = false;
	private readonly status = new Emitter<ConnectionStatusChangedEventArgs>();
	private readonly token = new Emitter<RefreshingTunnelAccessTokenEventArgs>();
	private readonly refresh = new Emitter<RefreshingTunnelEventArgs>();
	public readonly connectionStatusChanged = this.status.event;
	public readonly refreshingTunnelAccessToken = this.token.event;
	public readonly refreshingTunnel = this.refresh.event;
	public constructor(private readonly client: TunnelManagementHttpClient) {}
	public async connect(tunnel: Tunnel): Promise<void> {
		this.tunnel = tunnel;
		await this.client.updateTunnelEndpoint(tunnel, {
			id: 'test-owned-endpoint', hostId: 'test-host', connectionMode: TunnelConnectionMode.TunnelRelay,
		});
		this.status.fire({ previousStatus: ConnectionStatus.None, status: ConnectionStatus.Connected });
	}
	public async dispose(): Promise<void> {
		if (this.tunnel !== null) { await this.client.deleteTunnelEndpoints(this.tunnel, 'test-owned-endpoint'); }
		this.disposed = true;
	}
}

class TestTunnelApi {
	public readonly connectCapability = syntheticCapability();
	public blockEndpointPut = false;
	public endpointAborted = 0;
	private endpointObserved!: () => void;
	public readonly endpointStarted = new Promise<void>((resolve) => { this.endpointObserved = resolve; });
	public tunnel: Tunnel | undefined;
	public fault: 'missing' | 'wrongPort' | 'anonymous' | undefined;
	public failHostRefresh = false;
	public failEndpointDelete = false;
	public hostCount: number | undefined = 0;
	public readonly calls: { path: string; method?: string; scopes: string | null; scheme: string; body?: Tunnel }[] = [];
	public readonly adapter: AxiosAdapter = async (config) => {
		const url = new URL(config.url!);
		const body: Tunnel | undefined = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
		this.calls.push({ path: url.pathname, method: config.method, scopes: url.searchParams.get('tokenScopes'),
			scheme: String(config.headers.Authorization ?? '').split(' ')[0], body });
		const error = (status: number): never => {
			throw new AxiosError('synthetic-service-failure', 'ERR_BAD_RESPONSE', config, undefined, sdkResponse(config, {}, status));
		};
		if (url.pathname.startsWith('/clusters')) {
			return sdkResponse(config, { recommendedClusterId: 'use2', recommendations: [] });
		}
		if (url.pathname.includes('/endpoints/')) {
			if (config.method === 'put' && this.blockEndpointPut) {
				this.endpointObserved();
				return new Promise((_, reject) => {
					const abort = () => {
						this.endpointAborted += 1;
						reject(new AxiosError('Synthetic aborted request', 'ERR_CANCELED', config));
					};
					if (config.signal?.aborted) { abort(); }
					else { config.signal?.addEventListener?.('abort', abort, { once: true }); }
				});
			}
			if (config.method === 'delete' && this.failEndpointDelete) { error(503); }
			return sdkResponse(config, body ?? {});
		}
		if (config.method === 'delete') { this.tunnel = undefined; return sdkResponse(config, {}); }
		if (config.method === 'put') {
			this.tunnel = { ...body, clusterId: 'use2' };
		}
		if (this.tunnel === undefined) { return error(404); }
		const result = structuredClone(this.tunnel);
		result.status = { hostConnectionCount: this.hostCount };
		if (this.fault === 'anonymous') {
			result.accessControl = { entries: [{ type: TunnelAccessControlEntryType.Anonymous, subjects: [], scopes: ['connect'] }] };
		}
		if (url.pathname.includes('/ports/')) {
			return sdkResponse(config, {
				portNumber: this.fault === 'wrongPort' ? 80 : 43121, protocol: 'http',
				portForwardingUris: ['https://mesh-test-43121.use2.devtunnels.ms'],
				accessTokens: this.fault === 'missing' ? {} : { connect: this.connectCapability },
			});
		}
		if (url.searchParams.get('tokenScopes') === 'host') {
			if (this.failHostRefresh && config.method === 'get') { error(401); }
			result.accessTokens = { host: syntheticCapability(43121, 'host') };
		}
		return sdkResponse(config, result);
	};
}
