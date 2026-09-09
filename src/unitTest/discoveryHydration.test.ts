import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import type { Tunnel } from '@microsoft/dev-tunnels-contracts';
import { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios';

import {
	ACCOUNT_IDENTITY_PREFIX, ADVERTISEMENT_PREFIX, ConnectivityError, PRIVATE_LABEL,
} from '../connectivity/ConnectivitySchemas';
import { DevTunnelDiscoveryProvider } from '../connectivity/DevTunnelDiscoveryProvider';
import { DevTunnelManagement } from '../connectivity/DevTunnelManagement';
import { DiscoveryService } from '../connectivity/DiscoveryService';
import { uuid } from './artifactStoreTestSupport';
import { advertisedTunnel, connectivityFixture, deferred, sdkResponse } from './connectivityTestSupport';

test('incomplete account-owned summaries are hydrated by exact ID before endpoint projection', async (t) => {
	for (const missing of ['empty', 'absent', 'protocol', 'forwarding'] as const) {
		await t.test(missing, async (t) => {
			const fixture = connectivityFixture();
			const detail = privateTunnel();
			const summary = structuredClone(detail);
			if (missing === 'empty') { summary.ports = []; }
			if (missing === 'absent') { delete summary.ports; }
			if (missing === 'protocol') { delete summary.ports![0].protocol; }
			if (missing === 'forwarding') { delete summary.ports![0].portForwardingUris; }
			const requests: URL[] = [];
			const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
				adapter: async (config) => {
					const url = new URL(config.url!);
					requests.push(url);
					assert.equal(config.headers.Authorization, 'github synthetic-test-oauth-value');
					assert.equal(config.maxRedirects, 0);
					assert.equal(url.searchParams.get('includePorts'), 'true');
					assert.equal(url.searchParams.has('tokenScopes'), false);
					if (url.pathname === '/tunnels') {
						return sdkResponse(config, JSON.stringify({ value: [{ value: [summary] }] }));
					}
					assert.equal(url.hostname, 'use2.rel.tunnels.api.visualstudio.com');
					assert.equal(url.pathname, `/tunnels/${detail.tunnelId}`);
					return sdkResponse(config, JSON.stringify(detail));
				},
			});
			t.after(async () => { await management.dispose(); fixture.account.dispose(); });
			const provider = new DevTunnelDiscoveryProvider(management);
			const result = await provider.list(new AbortController().signal);
			assert.equal(requests.length, 2);
			assert.deepEqual(result.endpoints, provider.project(detail));
			assert.equal(result.endpoints[0].hostHint, 'online');
			assert.equal(result.endpoints[0].admission, 'private-port-token');
			assert.equal(result.truncated, false);
			assert.doesNotMatch(JSON.stringify(result), /synthetic-test-oauth|accessTokens/u);
		});
	}
});

test('detail reads cannot introduce unlisted or non-Mesh resources', async (t) => {
	for (const tunnels of [[], [{ ...privateTunnel(), labels: [], ports: [] }]]) {
		await t.test(`listed entries: ${tunnels.length}`, async (t) => {
			const fixture = connectivityFixture();
			let calls = 0;
			const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
				adapter: async (config) => {
					calls += 1;
					const url = new URL(config.url!);
					// A GET could succeed for a shared resource, but must never be requested here.
					return sdkResponse(config, url.pathname === '/tunnels'
						? { value: [{ value: tunnels }] } : privateTunnel());
				},
			});
			t.after(async () => { await management.dispose(); fixture.account.dispose(); });
			assert.equal((await new DevTunnelDiscoveryProvider(management).list(new AbortController().signal)).endpoints.length, 0);
			assert.equal(calls, 1);
		});
	}
});

test('invalid listed resource IDs and advertisements are rejected before detail requests', async (t) => {
	const mutations: ((tunnel: Tunnel) => void)[] = [
		(tunnel) => { tunnel.clusterId = 'evil.example'; },
		(tunnel) => { tunnel.tunnelId = '../another-tunnel'; },
		(tunnel) => { tunnel.labels = [...tunnel.labels!, `${ADVERTISEMENT_PREFIX}${uuid(800)}`]; },
		(tunnel) => { tunnel.description = `${ACCOUNT_IDENTITY_PREFIX}invalid-json`; },
	];
	for (const [index, mutate] of mutations.entries()) {
		await t.test(String(index), async (t) => {
			const fixture = connectivityFixture();
			const summary = { ...privateTunnel(), ports: [] };
			mutate(summary);
			let requests = 0;
			const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
				adapter: async (config) => {
					requests += 1;
					return sdkResponse(config, { value: [{ value: [summary] }] });
				},
			});
			t.after(async () => { await management.dispose(); fixture.account.dispose(); });
			await assert.rejects(new DevTunnelDiscoveryProvider(management).list(new AbortController().signal), { code: 'INVALID_ENDPOINT' });
			assert.equal(requests, 1);
		});
	}
});

test('detail hydration rejects changed resource, advertisement, admission and device identity', async (t) => {
	const mutations: [string, (tunnel: Tunnel) => void][] = [
		['resource', (tunnel) => { tunnel.tunnelId = 'unlisted-resource'; }],
		['cluster', (tunnel) => { tunnel.clusterId = 'jpe1'; }],
		['advertisement', (tunnel) => {
			tunnel.labels = [...tunnel.labels!.filter((label) => !label.startsWith(ADVERTISEMENT_PREFIX)), `${ADVERTISEMENT_PREFIX}${uuid(800)}`];
		}],
		['discovery labels', (tunnel) => { tunnel.labels = tunnel.labels!.filter((label) => label !== 'mesh-protocol-v2'); }],
		['private admission', (tunnel) => {
			tunnel.labels = tunnel.labels!.filter((label) => label !== PRIVATE_LABEL);
			tunnel.description = undefined;
		}],
		['device ID', (tunnel) => {
			const identity = JSON.parse(tunnel.description!.slice(ACCOUNT_IDENTITY_PREFIX.length));
			tunnel.description = `${ACCOUNT_IDENTITY_PREFIX}${JSON.stringify({ ...identity, deviceId: uuid(802) })}`;
		}],
		['device key', (tunnel) => { tunnel.description = privateTunnel().description; }],
		['removed identity', (tunnel) => { tunnel.description = undefined; }],
	];
	for (const [name, mutate] of mutations) {
		await t.test(name, async (t) => {
			const fixture = connectivityFixture();
			const original = privateTunnel();
			const detail = structuredClone(original);
			mutate(detail);
			const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
				adapter: async (config) => sdkResponse(config, new URL(config.url!).pathname === '/tunnels'
					? { value: [{ value: [{ ...original, ports: [] }] }] } : detail),
			});
			t.after(async () => { await management.dispose(); fixture.account.dispose(); });
			await assert.rejects(new DevTunnelDiscoveryProvider(management).list(new AbortController().signal), { code: 'BINDING_CHANGED' });
		});
	}
});

test('hydrated endpoints retain forwarding URI validation and unknown/offline presence', async (t) => {
	for (const presence of ['unknown', 'offline', 'invalid-uri'] as const) {
		await t.test(presence, async (t) => {
			const fixture = connectivityFixture();
			const detail = privateTunnel();
			detail.status = presence === 'unknown' ? {} : { hostConnectionCount: 0 };
			if (presence === 'invalid-uri') { detail.ports![0].portForwardingUris = ['https://evil.example/']; }
			const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
				adapter: async (config) => sdkResponse(config, new URL(config.url!).pathname === '/tunnels'
					? { value: [{ value: [{ ...detail, ports: [], status: { hostConnectionCount: 1 } }] }] } : detail),
			});
			t.after(async () => { await management.dispose(); fixture.account.dispose(); });
			const result = new DevTunnelDiscoveryProvider(management).list(new AbortController().signal);
			if (presence === 'invalid-uri') { await assert.rejects(result, { code: 'INVALID_ENDPOINT' }); }
			else { assert.equal((await result).endpoints[0].hostHint, presence); }
		});
	}
});

test('hydration preserves resource, request and endpoint caps including newly read ports', async (t) => {
	for (const [count, portsPerTunnel] of [[12, 1], [2, 6]]) {
		await t.test(`${count} tunnels, ${portsPerTunnel} ports`, async (t) => {
			const fixture = connectivityFixture();
			const tunnels = Array.from({ length: count }, (_, index): Tunnel => {
				const tunnelId = `mesh-cap-${index}`;
				return {
					...advertisedTunnel(), tunnelId,
					ports: Array.from({ length: portsPerTunnel }, (_, portIndex) => ({
						portNumber: 43121 + portIndex, protocol: 'http',
						portForwardingUris: [`https://${tunnelId}-${43121 + portIndex}.use2.devtunnels.ms`],
					})),
				};
			});
			let requests = 0;
			const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
				adapter: async (config) => {
					requests += 1;
					const url = new URL(config.url!);
					if (url.pathname === '/tunnels') {
						assert.equal(url.searchParams.get('limit'), '10');
						return sdkResponse(config, { value: [{ value: tunnels.map((tunnel) => ({ ...tunnel, ports: [] })) }] });
					}
					const detail = tunnels.find((tunnel) => url.pathname === `/tunnels/${tunnel.tunnelId}`);
					assert.ok(detail);
					return sdkResponse(config, detail);
				},
			});
			t.after(async () => { await management.dispose(); fixture.account.dispose(); });
			const result = await new DevTunnelDiscoveryProvider(management).list(new AbortController().signal);
			assert.equal(requests, 1 + Math.min(10, count));
			assert.equal(result.endpoints.length, 10);
			assert.equal(result.truncated, true);
		});
	}
});

test('list and hydration share the original management deadline rather than resetting it', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const fixture = connectivityFixture();
	const listed = deferred();
	const releaseList = deferred();
	const detailStarted = deferred();
	let detailAborted = false;
	const adapter: AxiosAdapter = async (config) => {
		if (new URL(config.url!).pathname === '/tunnels') {
			listed.resolve();
			await releaseList.promise;
			return sdkResponse(config, { value: [{ value: [{ ...advertisedTunnel(), ports: [] }] }] });
		}
		detailStarted.resolve();
		return new Promise((_, reject) => {
			const abort = () => { detailAborted = true; reject(new AxiosError('cancelled', 'ERR_CANCELED', config)); };
			if (config.signal?.aborted) { abort(); }
			else { config.signal?.addEventListener?.('abort', abort, { once: true }); }
		});
	};
	const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, { adapter, timeoutMs: 100 });
	t.after(async () => { await management.dispose(); fixture.account.dispose(); });
	const rejected = assert.rejects(new DevTunnelDiscoveryProvider(management).list(new AbortController().signal), { code: 'TIMEOUT' });
	await listed.promise;
	t.mock.timers.tick(60);
	releaseList.resolve();
	await detailStarted.promise;
	t.mock.timers.tick(39);
	assert.equal(detailAborted, false);
	t.mock.timers.tick(1);
	await rejected;
	assert.equal(detailAborted, true);
});

test('cancellation and account invalidation abort pending hydration without further requests', async (t) => {
	for (const reason of ['cancel', 'account'] as const) {
		await t.test(reason, async (t) => {
			const fixture = connectivityFixture();
			const started = deferred();
			const controller = new AbortController();
			let requests = 0;
			let aborted = false;
			const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
				adapter: async (config) => {
					requests += 1;
					if (new URL(config.url!).pathname === '/tunnels') {
						return sdkResponse(config, { value: [{ value: [{ ...advertisedTunnel(), ports: [] }] }] });
					}
					started.resolve();
					return new Promise((_, reject) => {
						const abort = () => { aborted = true; reject(new AxiosError('private-cancel-detail', 'ERR_CANCELED', config)); };
						if (config.signal?.aborted) { abort(); }
						else { config.signal?.addEventListener?.('abort', abort, { once: true }); }
					});
				},
			});
			t.after(async () => { await management.dispose(); fixture.account.dispose(); });
			const rejected = assert.rejects(new DevTunnelDiscoveryProvider(management).list(controller.signal), { code: 'CANCELLED' });
			await started.promise;
			if (reason === 'cancel') { controller.abort(); }
			else { fixture.authentication.changed(); }
			await rejected;
			assert.equal(aborted, true);
			assert.equal(requests, 2);
		});
	}
});

test('detail read failures remain explicit and rate limiting retains its cooldown', async (t) => {
	for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [404, 'OFFLINE'], [429, 'RATE_LIMITED']] as const) {
		await t.test(String(status), async (t) => {
			const fixture = connectivityFixture();
			let requests = 0;
			const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
				adapter: async (config) => {
					requests += 1;
					if (new URL(config.url!).pathname === '/tunnels') {
						return sdkResponse(config, { value: [{ value: [{ ...advertisedTunnel(), ports: [] }] }] });
					}
					throw new AxiosError('private-failure', 'ERR_BAD_RESPONSE', config, undefined, {
						...sdkResponse(config, {}, status), headers: new AxiosHeaders({ 'retry-after': '60' }),
					});
				},
			});
			t.after(async () => { await management.dispose(); fixture.account.dispose(); });
			const provider = new DevTunnelDiscoveryProvider(management);
			await assert.rejects(provider.list(new AbortController().signal), (error: unknown) =>
				error instanceof ConnectivityError && error.code === code && !JSON.stringify(error).includes('private-failure'));
			if (status === 429) {
				await assert.rejects(provider.list(new AbortController().signal), { code: 'RATE_LIMITED' });
				assert.equal(requests, 2);
			}
		});
	}
});

test('a failed detail refresh does not replace a previous directory with an empty success', async (t) => {
	const fixture = connectivityFixture();
	let fail = false;
	let now = 1000;
	const management = new DevTunnelManagement(fixture.account, fixture.fence, () => true, {
		adapter: async (config) => {
			if (new URL(config.url!).pathname === '/tunnels') {
				return sdkResponse(config, { value: [{ value: [{ ...advertisedTunnel(), ...(fail ? { ports: [] } : {}) }] }] });
			}
			throw new AxiosError('not found', 'ERR_BAD_RESPONSE', config, undefined, sdkResponse(config, {}, 404));
		},
	});
	const discovery = new DiscoveryService(new DevTunnelDiscoveryProvider(management), fixture.fence,
		() => true, () => true, () => undefined, () => now);
	t.after(async () => { await discovery.dispose(); await management.dispose(); fixture.account.dispose(); });
	await discovery.refresh();
	const previous = discovery.endpoints();
	fail = true;
	now += 10_001;
	await discovery.refresh();
	assert.equal(discovery.snapshot().state, 'error');
	assert.equal(discovery.snapshot().error, 'OFFLINE');
	assert.deepEqual(discovery.endpoints(), previous);
});

function privateTunnel(): Tunnel {
	const tunnel = advertisedTunnel();
	const publicKey = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
	return {
		...tunnel, labels: [...tunnel.labels, PRIVATE_LABEL],
		description: `${ACCOUNT_IDENTITY_PREFIX}${JSON.stringify({ deviceId: uuid(801), publicKey })}`,
		status: { hostConnectionCount: 1 },
	};
}
