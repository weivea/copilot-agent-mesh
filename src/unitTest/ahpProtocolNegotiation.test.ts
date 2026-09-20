import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocketServer } from 'ws';
import { z } from 'zod';

import {
	requireSelectedAhpProtocol,
	SdkAhpConnectionFactory,
} from '../agentHost/AhpAgentRuntime';

const initializeRequestSchema = z.object({
	jsonrpc: z.literal('2.0'),
	id: z.number(),
	method: z.literal('initialize'),
	params: z.object({
		channel: z.literal('ahp-root://'),
		protocolVersions: z.array(z.string()),
		initialSubscriptions: z.array(z.string()),
	}),
});

for (const source of [undefined, 'standalone'] as const) {
	for (const [registryProtocolVersion, serverVersion] of [
		['0.1.0', '0.9.0'],
		['0.9.0', '0.9.0'],
		['0.1.0', '1.0.0'],
		['0.9.0', '1.0.0'],
		['1.0.0', '1.0.0'],
	] as const) {
		test(`SDK standalone ${source ?? 'implicit'} negotiates ${serverVersion} from registry ${registryProtocolVersion}`, {
			timeout: 5_000,
		}, async (t) => {
			const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
			t.after(async () => {
				for (const socket of server.clients) { socket.terminate(); }
				await new Promise<void>((resolve, reject) => {
					server.close((error) => error === undefined ? resolve() : reject(error));
				});
			});
			let offered: readonly string[] | undefined;
			server.on('connection', (socket) => {
				socket.on('message', (data) => {
					const request = initializeRequestSchema.parse(JSON.parse(data.toString()));
					offered = request.params.protocolVersions;
					assert.deepEqual(request.params.initialSubscriptions, ['ahp-root://']);
					if (!offered.includes(serverVersion)) {
						socket.send(JSON.stringify({
							jsonrpc: '2.0', id: request.id,
							error: {
								code: -32005,
								message: 'No compatible protocol version.',
								data: { supportedVersions: [`^${serverVersion}`] },
							},
						}));
						return;
					}
					socket.send(JSON.stringify({
						jsonrpc: '2.0', id: request.id,
						result: {
							protocolVersion: serverVersion,
							serverSeq: 1,
							snapshots: [{ resource: 'ahp-root://', fromSeq: 1, state: { agents: [] } }],
						},
					}));
				});
			});
			await once(server, 'listening');
			const address = server.address();
			assert.ok(address && typeof address !== 'string');
			const connection = await new SdkAhpConnectionFactory().connect({
				endpoint: new URL(`ws://127.0.0.1:${address.port}`),
				version: serverVersion === '0.9.0' ? '1.138.0' : '1.135.0',
				registryProtocolVersion,
				source,
				onExit: () => ({ dispose() {} }),
				dispose: async () => undefined,
			});
			t.after(() => connection.shutdown());
			const result = await connection.initialize('standalone-protocol-test');
			assert.deepEqual(offered, registryProtocolVersion === '1.0.0' ? ['1.0.0'] : ['1.0.0', '0.9.0']);
			assert.equal(requireSelectedAhpProtocol(connection.protocolPolicy, result.protocolVersion), serverVersion);
			assert.equal(result.snapshots[0]?.resource, 'ahp-root://');
			await connection.shutdown();
		});
	}
}
