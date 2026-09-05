import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';

import type { GatewayRouter } from './GatewayRouter';
import type { PairingService } from './PairingService';
import { RpcPeer, type RpcPeerOptions } from './RpcPeer';

export interface GatewayServerOptions extends RpcPeerOptions {
	readonly unauthenticatedGlobalLimit?: number;
	readonly unauthenticatedPerSourceLimit?: number;
	readonly closeHttpServer?: (server: Server) => Promise<void>;
}

export interface GatewayAddress {
	readonly host: '127.0.0.1';
	readonly port: number;
}

export class GatewayServer {
	private readonly httpServer: Server;
	private readonly webSocketServer: WebSocketServer;
	private readonly peers = new Set<RpcPeer>();
	private readonly sourceCounts = new Map<string, number>();
	private readonly globalLimit: number;
	private readonly perSourceLimit: number;
	private started = false;
	private disposed = false;
	private starting: Promise<GatewayAddress> | undefined;
	private stopping: Promise<void> | undefined;

	public constructor(
		private readonly pairing: PairingService,
		private readonly router: GatewayRouter,
		private readonly options: GatewayServerOptions = {},
	) {
		this.globalLimit = options.unauthenticatedGlobalLimit ?? 16;
		this.perSourceLimit = options.unauthenticatedPerSourceLimit ?? 4;
		this.httpServer = createServer((request, response) => {
			if (request.method === 'GET' && request.url === '/healthz') {
				response.writeHead(204);
				response.end();
				return;
			}
			response.writeHead(404, {
				'cache-control': 'no-store',
				'content-length': '0',
			});
			response.end();
		});
		this.webSocketServer = new WebSocketServer({
			noServer: true,
			maxPayload: 1_048_576,
			perMessageDeflate: false,
		});
		this.httpServer.on('upgrade', (request, socket, head) => {
			if (request.url !== '/agent-mesh/rpc') {
				socket.destroy();
				return;
			}
			const source = request.socket.remoteAddress ?? 'unknown';
			if (!this.reserveUnauthenticated(source)) {
				rejectUpgrade(socket);
				return;
			}
			let reserved = true;
			const release = (): void => {
				if (!reserved) {
					return;
				}
				reserved = false;
				this.releaseUnauthenticated(source);
			};
			socket.once('close', release);
			socket.once('error', release);
			try {
				this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
					let peer: RpcPeer;
					peer = new RpcPeer(
						webSocket,
						this.pairing,
						this.router,
						release,
						() => {
							release();
							this.peers.delete(peer);
						},
						this.options,
					);
					this.peers.add(peer);
					this.webSocketServer.emit('connection', webSocket, request);
				});
			} catch {
				release();
				socket.destroy();
			}
		});
	}

	public start(preferredPort?: number): Promise<GatewayAddress> {
		if (this.started || this.starting !== undefined) {
			throw new Error('Gateway server is already started.');
		}
		if (this.disposed) {
			throw new Error('Gateway server is disposed.');
		}
		if (preferredPort !== undefined && (
			!Number.isInteger(preferredPort)
			|| preferredPort < 1
			|| preferredPort > 65_535
		)) {
			throw new Error('Preferred gateway port is invalid.');
		}
		this.starting = this.startCore(preferredPort);
		return this.starting;
	}

	private async startCore(preferredPort?: number): Promise<GatewayAddress> {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				this.httpServer.off('listening', onListening);
				reject(error);
			};
			const onListening = (): void => {
				this.httpServer.off('error', onError);
				resolve();
			};
			this.httpServer.once('error', onError);
			this.httpServer.once('listening', onListening);
			this.httpServer.listen(preferredPort ?? 0, '127.0.0.1');
		});
		this.started = true;
		const address = this.httpServer.address();
		if (address === null || typeof address === 'string') {
			throw new Error('Gateway listener address is unavailable.');
		}
		return { host: '127.0.0.1', port: address.port };
	}

	public dispose(): Promise<void> {
		if (this.stopping !== undefined) {
			return this.stopping;
		}

		this.disposed = true;
		let stopping!: Promise<void>;
		stopping = this.stop().catch((error: unknown) => {
			if (this.stopping === stopping) {
				this.stopping = undefined;
			}
			throw error;
		});
		this.stopping = stopping;
		return stopping;
	}

	public async notifyPeer(
		peerId: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<void> {
		await Promise.all(
			[...this.peers].map((peer) => peer.notifyPeer(peerId, method, params)),
		);
	}

	public closePeer(peerId: string): void {
		for (const peer of [...this.peers]) {
			peer.revokePeer(peerId);
		}
	}

	private async stop(): Promise<void> {
		await this.starting?.catch(() => undefined);
		for (const peer of [...this.peers]) {
			peer.close();
		}
		for (const client of this.webSocketServer.clients) {
			client.terminate();
		}
		if (this.started) {
			await new Promise<void>((resolve) => {
				this.webSocketServer.close(() => resolve());
			});
			await (this.options.closeHttpServer ?? closeHttpServer)(this.httpServer);
		}
		this.started = false;
	}

	private reserveUnauthenticated(source: string): boolean {
		const total = [...this.sourceCounts.values()].reduce((sum, value) => sum + value, 0);
		const sourceCount = this.sourceCounts.get(source) ?? 0;
		if (total >= this.globalLimit || sourceCount >= this.perSourceLimit) {
			return false;
		}
		this.sourceCounts.set(source, sourceCount + 1);
		return true;
	}

	private releaseUnauthenticated(source: string): void {
		const count = this.sourceCounts.get(source);
		if (count === undefined || count <= 1) {
			this.sourceCounts.delete(source);
		} else {
			this.sourceCounts.set(source, count - 1);
		}
	}
}

function closeHttpServer(server: Server): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error === undefined) {
				resolve();
			} else {
				reject(error);
			}
		});
	});
}

function rejectUpgrade(socket: Duplex): void {
	socket.end(
		'HTTP/1.1 503 Service Unavailable\r\n'
		+ 'Connection: close\r\n'
		+ 'Content-Length: 0\r\n\r\n',
	);
}
