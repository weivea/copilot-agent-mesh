import WebSocket from 'ws';

import { PROTOCOL_LIMITS } from '../../shared/protocol';
import { ConnectivityError } from '../connectivity/ConnectivitySchemas';

export interface PeerSocketConnector {
	connect(endpoint: string, signal: AbortSignal): Promise<WebSocket>;
}

export class WebSocketPeerSocketConnector implements PeerSocketConnector {
	public constructor(private readonly capability?: (signal: AbortSignal) => Promise<string>) {}

	public async connect(endpoint: string, signal: AbortSignal): Promise<WebSocket> {
		const uri = new URL(endpoint);
		if (uri.protocol !== 'wss:' || uri.username !== '' || uri.password !== ''
			|| uri.search !== '' || uri.hash !== '' || uri.pathname !== '/agent-mesh/rpc') {
			throw new ConnectivityError('INVALID_ENDPOINT');
		}
		const capability = await this.capability?.(signal);
		if (signal.aborted) {
			throw new ConnectivityError('CANCELLED');
		}
		return new WebSocket(endpoint, {
			perMessageDeflate: false,
			maxPayload: PROTOCOL_LIMITS.frameBytes,
			followRedirects: false,
			handshakeTimeout: 8000,
			headers: {
				'X-Tunnel-Skip-AntiPhishing-Page': 'true',
				...(capability === undefined ? {} : { 'X-Tunnel-Authorization': `tunnel ${capability}` }),
			},
		});
	}
}
