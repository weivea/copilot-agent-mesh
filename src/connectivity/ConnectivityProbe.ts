import { pingResultSchema } from '../../shared/protocol';
import { ConnectivityError } from './ConnectivitySchemas';
import { abortable, ConnectivityOperation } from './ConnectivityOperations';

export interface ConnectivityProbeResult {
	readonly protocolVersion: 2;
	readonly replies: number;
	readonly applicationBytesUpperBound: number;
	readonly durationMs: number;
	readonly physicalTopology: 'unverified';
}

/** A no-model probe of an already authenticated connection; it creates no cloud resource. */
export async function probeConnectedPeer(
	peer: { request(method: string, params: Record<string, unknown>): Promise<unknown>; disconnect(): Promise<void> },
	assertCurrent: () => Promise<void>,
	options: { readonly count?: number; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<ConnectivityProbeResult> {
	const count = options.count ?? 100;
	if (!Number.isSafeInteger(count) || count < 1 || count > 100) { throw new RangeError('Invalid bounded probe count.'); }
	const timeout = options.timeoutMs ?? 60_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) { throw new RangeError('Invalid probe deadline.'); }
	const operation = new ConnectivityOperation(timeout, options.signal);
	const startedAt = Date.now();
	let bytes = 0;
	let replies = 0;
	let closing: Promise<void> | undefined;
	const disconnect = (): void => { closing ??= peer.disconnect(); void closing.catch(() => undefined); };
	operation.controller.signal.addEventListener('abort', disconnect, { once: true });
	try {
		for (; replies < count; replies += 1) {
			operation.assertActive();
			await assertCurrent();
			const sentAt = Date.now();
			const result = pingResultSchema.parse(await abortable(peer.request('mesh.ping', { sentAt }), operation.controller.signal));
			if (result.sentAt !== sentAt) { throw new ConnectivityError('INVALID_ENDPOINT'); }
			bytes += 512 + Buffer.byteLength(JSON.stringify(result));
			if (bytes > 1024 * 1024) { throw new ConnectivityError('POLICY_DENIED'); }
		}
		return { protocolVersion: 2, replies, applicationBytesUpperBound: bytes,
			durationMs: Date.now() - startedAt, physicalTopology: 'unverified' };
	} catch (error: unknown) {
		operation.assertActive();
		throw error;
	} finally {
		operation.controller.signal.removeEventListener('abort', disconnect);
		operation.dispose();
		if (closing !== undefined) { await closing; }
	}
}
