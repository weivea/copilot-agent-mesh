import type { AxiosAdapter } from 'axios';

import { ConnectivityError } from '../connectivity/ConnectivitySchemas';
import { validateManagementUri } from '../connectivity/DevTunnelUris';

/** The SDK registers its endpoint before linking connect() cancellation. */
export function sdkHostRequestAdapter(
	send: AxiosAdapter,
	lifetime: AbortSignal,
	isExactCleanup: (uri: URL) => boolean,
): AxiosAdapter {
	return async (config) => {
		const uri = validateManagementUri(config.url ?? '');
		const request = { ...config, timeout: Math.min(config.timeout ?? 10_000, 10_000), maxRedirects: 0 };
		if (config.method?.toLowerCase() === 'delete') {
			if (!isExactCleanup(uri)) { throw new ConnectivityError('INVALID_ENDPOINT'); }
			return send(request);
		}
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		config.signal?.addEventListener?.('abort', abort, { once: true });
		lifetime.addEventListener('abort', abort, { once: true });
		try {
			if (lifetime.aborted || config.signal?.aborted) { throw new ConnectivityError('CANCELLED'); }
			return await send({ ...request, signal: controller.signal });
		} finally {
			config.signal?.removeEventListener?.('abort', abort);
			lifetime.removeEventListener('abort', abort);
		}
	};
}
