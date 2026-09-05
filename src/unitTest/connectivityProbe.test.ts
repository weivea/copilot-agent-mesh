import assert from 'node:assert/strict';
import { test } from 'node:test';

import { probeConnectedPeer } from '../connectivity/ConnectivityProbe';

test('bounded probe uses the production numeric ping contract and never labels topology or Agent execution as passed', async () => {
	let calls = 0;
	const result = await probeConnectedPeer({
		request: async (method, params) => {
			calls += 1;
			assert.equal(method, 'mesh.ping');
			return { sentAt: params.sentAt, receivedAt: Date.now() };
		},
		disconnect: async () => undefined,
	}, async () => undefined);
	assert.equal(calls, 100);
	assert.equal(result.physicalTopology, 'unverified');
	assert.ok(result.applicationBytesUpperBound < 1024 * 1024);
});

test('probe timeout closes its exact connection and cannot produce a success result', async () => {
	let closed = 0;
	await assert.rejects(probeConnectedPeer({
		request: async () => new Promise(() => undefined),
		disconnect: async () => { closed += 1; },
	}, async () => undefined, { timeoutMs: 5 }), { code: 'TIMEOUT' });
	assert.equal(closed, 1);
});
