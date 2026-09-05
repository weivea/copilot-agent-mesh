import { TunnelConstraints } from '@microsoft/dev-tunnels-contracts';
import type { TunnelRelayStreamFactory } from '@microsoft/dev-tunnels-connections';
import WebSocket, { createWebSocketStream } from 'ws';

import { ConnectivityError } from '../connectivity/ConnectivitySchemas';
import { validateCapability } from '../connectivity/DevTunnelEndpointResolver';

/** The SDK's default factory has no abort parameter. Keep the actual relay socket owned here. */
export class SdkRelayStreamFactory implements TunnelRelayStreamFactory {
	public constructor(private readonly lifetime: AbortSignal) {}

	public async createRelayStream(relayUri: string, protocols: string[], accessToken?: string) {
		validateRelayUri(relayUri);
		validateCapability(accessToken);
		if (this.lifetime.aborted) {
			throw new ConnectivityError('CANCELLED');
		}
		const { NodeStream } = await import('@microsoft/dev-tunnels-ssh');
		if (this.lifetime.aborted) { throw new ConnectivityError('CANCELLED'); }
		const socket = new WebSocket(relayUri, protocols, {
			followRedirects: false,
			rejectUnauthorized: true,
			handshakeTimeout: 8000,
			perMessageDeflate: false,
			maxPayload: 4 * 1024 * 1024,
			headers: { Authorization: `tunnel ${accessToken}` },
		});
		const abort = (): void => { socket.terminate(); };
		this.lifetime.addEventListener('abort', abort, { once: true });
		socket.once('close', () => this.lifetime.removeEventListener('abort', abort));
		try {
			await new Promise<void>((resolve, reject) => {
				const fail = (): void => {
					cleanup();
					reject(new ConnectivityError(this.lifetime.aborted ? 'CANCELLED' : 'OFFLINE'));
				};
				const opened = (): void => { cleanup(); resolve(); };
				const cleanup = (): void => {
					socket.off('open', opened);
					socket.off('error', fail);
					socket.off('close', fail);
				};
				socket.once('open', opened);
				socket.once('error', fail);
				socket.once('close', fail);
			});
			// NodeStream is the released SSH SDK's public Duplex adapter, not a new Mesh transport.
			return { stream: new NodeStream(createWebSocketStream(socket)), protocol: socket.protocol };
		} catch {
			socket.on('error', () => undefined);
			socket.terminate();
			throw new ConnectivityError(this.lifetime.aborted ? 'CANCELLED' : 'OFFLINE');
		}
	}
}

export function validateRelayUri(input: string): void {
	let uri: URL;
	try { uri = new URL(input); } catch { throw new ConnectivityError('INVALID_ENDPOINT'); }
	const suffix = '.rel.tunnels.api.visualstudio.com';
	const prefix = uri.hostname.slice(0, -suffix.length).replace(/-data$/u, '');
	if (input.length > 1024 || /[\s\\]/u.test(input) || uri.protocol !== 'wss:' || !uri.hostname.endsWith(suffix)
		|| !TunnelConstraints.clusterIdRegex.test(prefix) || uri.username || uri.password
		|| uri.port || uri.hash || uri.search || uri.pathname === '/') {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
}
