import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AxiosHeaders } from 'axios';

import { sdkHostRequestAdapter } from '../tunnel/SdkHostRequestAdapter';
import { sdkResponse } from './connectivityTestSupport';

test('a cancelled host cannot send control requests but exact endpoint DELETE remains bounded and usable', async () => {
	const lifetime = new AbortController();
	let requests = 0;
	const adapter = sdkHostRequestAdapter(async (config) => {
		requests += 1;
		assert.equal(config.timeout, 10000);
		return sdkResponse(config, {});
	}, lifetime.signal, (uri) => uri.pathname === '/tunnels/owned/endpoints/exact');
	lifetime.abort();
	const config = {
		url: 'https://use2.rel.tunnels.api.visualstudio.com/tunnels/owned/endpoints/exact',
		headers: new AxiosHeaders(), method: 'put', timeout: 60000,
	};
	await assert.rejects(adapter(config), { code: 'CANCELLED' });
	assert.equal(requests, 0);
	await adapter({ ...config, method: 'delete' });
	await assert.rejects(adapter({ ...config, method: 'delete', url: config.url.replace('/exact', '/foreign') }), { code: 'INVALID_ENDPOINT' });
	assert.equal(requests, 1);
});
