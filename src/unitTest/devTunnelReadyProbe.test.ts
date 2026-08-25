import * as assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { suite, test } from 'node:test';

import { DevTunnelProviderError } from '../tunnel/DevTunnelProvider';
import { probeLoopbackHealth } from '../tunnel/DevTunnelReadyProbe';

suite('DevTunnelReadyProbe', () => {
	test('accepts only an exact loopback /healthz 204 response', async () => {
		const server = createServer((request, response) => {
			response.statusCode = request.url === '/healthz' ? 204 : 404;
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		assert.ok(address !== null && typeof address === 'object');
		try {
			await probeLoopbackHealth(address.port, '/healthz');
			await assert.rejects(
				probeLoopbackHealth(address.port, '/redirect'),
				(error: unknown) => hasCode(error, 'PORT_CONFLICT'),
			);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => {
				if (error === undefined) {
					resolve();
				} else {
					reject(error);
				}
			}));
		}
	});

	test('rejects a backslash path that escapes the loopback origin', async () => {
		await assert.rejects(
			probeLoopbackHealth(43123, '/\\attacker.invalid/healthz'),
			(error: unknown) => hasCode(error, 'HTTPS_HEALTH_FAILED'),
		);
	});
});

function hasCode(error: unknown, code: DevTunnelProviderError['code']): boolean {
	assert.ok(error instanceof DevTunnelProviderError);
	assert.equal(error.code, code);
	return true;
}
