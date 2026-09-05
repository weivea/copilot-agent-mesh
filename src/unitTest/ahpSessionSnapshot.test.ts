import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocketServer } from 'ws';
import { z } from 'zod';

import { SdkAhpConnectionFactory } from '../agentHost/AhpAgentRuntime';

const requestSchema = z.object({
	jsonrpc: z.literal('2.0'),
	id: z.union([z.number(), z.string()]).optional(),
	method: z.string(),
	params: z.record(z.string(), z.unknown()).optional(),
});

test('SDK Session re-read returns fresh state without replacing the subscription and keeps catalog metadata', {
	timeout: 5_000,
}, async (context) => {
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	context.after(async () => {
		for (const socket of server.clients) {
			socket.terminate();
		}
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error === undefined ? resolve() : reject(error));
		});
	});
	const sessionUri = 'copilotcli:/snapshot-test';
	let directory = 'file:///target';
	let subscribeRequests = 0;
	let unsubscribeRequests = 0;
	let observeUnsubscribe!: () => void;
	const unsubscribed = new Promise<void>((resolve) => { observeUnsubscribe = resolve; });
	server.on('connection', (socket) => {
		socket.on('message', (data) => {
			const request = requestSchema.parse(JSON.parse(data.toString()));
			if (request.id === undefined) {
				if (request.method === 'unsubscribe') {
					unsubscribeRequests += 1;
					observeUnsubscribe();
				}
				return;
			}
			let result: unknown;
			switch (request.method) {
				case 'initialize':
					result = {
						protocolVersion: '0.9.0', serverSeq: 1,
						snapshots: [{ resource: 'ahp-root://', fromSeq: 1, state: { agents: [] } }],
					};
					break;
				case 'subscribe':
					assert.equal(request.params?.channel, sessionUri);
					subscribeRequests += 1;
					result = {
						snapshot: {
							resource: sessionUri, fromSeq: 2,
							state: {
								provider: 'copilotcli', workingDirectories: [directory],
								config: { schema: { type: 'object', properties: {} }, values: { isolation: 'folder' } },
							},
						},
					};
					break;
				case 'listSessions':
					result = {
						items: [{
							resource: sessionUri, provider: 'copilotcli', status: 1,
							workingDirectories: [directory],
						}],
					};
					break;
				default:
					throw new Error(`Unexpected SDK request: ${request.method}`);
			}
			socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
		});
	});
	await once(server, 'listening');
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	const connection = await new SdkAhpConnectionFactory().connect({
		endpoint: new URL(`ws://127.0.0.1:${address.port}`),
		version: '1.136.1',
		registryProtocolVersion: '0.9.0',
		source: 'editor',
		onExit: () => ({ dispose() {} }),
		dispose: async () => undefined,
	});
	context.after(() => connection.shutdown());
	await connection.initialize('snapshot-reader');
	const initial = await connection.subscribe(sessionUri);
	assert.ok(initial.snapshot);
	assert.equal(Object.hasOwn(initial.snapshot.state, 'resource'), false);
	const iterator = initial.subscription[Symbol.asyncIterator]();
	const next = iterator.next();
	directory = 'file:///materialized-target';
	const refreshed = await connection.readSessionSnapshot(sessionUri);
	assert.ok(refreshed);
	assert.equal('workingDirectories' in refreshed.state, true);
	if ('workingDirectories' in refreshed.state) {
		assert.deepEqual(refreshed.state.workingDirectories, [directory]);
	}
	assert.equal(subscribeRequests, 2);
	assert.equal(unsubscribeRequests, 0);
	assert.deepEqual((await connection.listSessions()).items, [{
		resource: sessionUri, provider: 'copilotcli', status: 1, workingDirectories: [directory],
	}]);
	const socket = [...server.clients][0];
	assert.ok(socket);
	socket.send(JSON.stringify({
		jsonrpc: '2.0', method: 'action',
		params: {
			channel: sessionUri, serverSeq: 3,
			action: { type: 'session/titleChanged', title: 'Still subscribed' },
		},
	}));
	assert.equal((await next).done, false);
	const end = iterator.next();
	await connection.unsubscribe(sessionUri);
	await unsubscribed;
	assert.equal((await end).done, true);
	assert.equal(unsubscribeRequests, 1);
	await initial.subscription.close();
	await connection.shutdown();
});
