import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

import WebSocket, { type RawData } from 'ws';

import { GatewayRouter, GatewayValidationError } from './GatewayRouter';
import { PairingProtocolError } from './PairingCrypto';
import { PairingService } from './PairingService';

const textDecoder = new TextDecoder('utf-8', { fatal: true });

export interface RpcPeerOptions {
	readonly preAuthMaxBytes?: number;
	readonly preAuthRateCount?: number;
	readonly preAuthRateWindowMs?: number;
	readonly handshakeTimeoutMs?: number;
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatTimeoutMs?: number;
	readonly outboxMaxBytes?: number;
	readonly outboxMaxEvents?: number;
	readonly now?: () => number;
}

interface RpcRequest {
	readonly jsonrpc: '2.0';
	readonly id: string;
	readonly method: string;
	readonly params: Record<string, unknown>;
}

interface QueuedMessage {
	readonly data: Buffer;
	resolve(): void;
	reject(error: Error): void;
}

export class RpcPeer {
	public readonly connectionId = randomUUID();
	private readonly preAuthMaxBytes: number;
	private readonly preAuthRateCount: number;
	private readonly preAuthRateWindowMs: number;
	private readonly heartbeatIntervalMs: number;
	private readonly heartbeatTimeoutMs: number;
	private readonly outboxMaxBytes: number;
	private readonly outboxMaxEvents: number;
	private readonly now: () => number;
	private readonly queue: QueuedMessage[] = [];
	private readonly messageTimes: number[] = [];
	private handshakeTimer: NodeJS.Timeout | undefined;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private authenticatedPeerId: string | undefined;
	private lastPongAt: number;
	private outboxBytes = 0;
	private outboxEvents = 0;
	private authenticationFailures = 0;
	private sending = false;
	private disposed = false;

	public constructor(
		private readonly socket: WebSocket,
		private readonly pairing: PairingService,
		private readonly router: GatewayRouter,
		private readonly onAuthenticated: (peerId: string) => void,
		private readonly onDisposed: () => void,
		options: RpcPeerOptions = {},
	) {
		this.preAuthMaxBytes = options.preAuthMaxBytes ?? 64 * 1024;
		this.preAuthRateCount = options.preAuthRateCount ?? 8;
		this.preAuthRateWindowMs = options.preAuthRateWindowMs ?? 10_000;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
		this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000;
		this.outboxMaxBytes = options.outboxMaxBytes ?? 256 * 1024;
		this.outboxMaxEvents = options.outboxMaxEvents ?? 128;
		this.now = options.now ?? Date.now;
		this.lastPongAt = this.now();
		this.handshakeTimer = setTimeout(
			() => this.close(1008, 'Authentication deadline exceeded.'),
			options.handshakeTimeoutMs ?? 30_000,
		);
		this.socket.on('message', (data, isBinary) => {
			void this.receive(data, isBinary).catch(() => {
				if (!this.disposed) {
					this.close(1011, 'Request processing failed.');
				}
			});
		});
		this.socket.on('pong', () => {
			this.lastPongAt = this.now();
		});
		this.socket.once('close', () => this.dispose());
		this.socket.once('error', () => this.dispose());
	}

	public close(code = 1001, reason = 'Gateway is closing.'): void {
		if (this.socket.readyState === WebSocket.OPEN) {
			this.socket.close(code, reason);
			return;
		}
		if (this.socket.readyState !== WebSocket.CLOSED) {
			this.socket.terminate();
		}
		this.dispose();
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.handshakeTimer !== undefined) {
			clearTimeout(this.handshakeTimer);
		}
		if (this.heartbeatTimer !== undefined) {
			clearInterval(this.heartbeatTimer);
		}
		this.pairing.disposeConnection(this.connectionId);
		for (const message of this.queue.splice(0)) {
			message.reject(new Error('Connection is closed.'));
		}
		this.onDisposed();
	}

	private async receive(data: RawData, isBinary: boolean): Promise<void> {
		if (this.disposed) {
			return;
		}
		const bytes = rawDataToBuffer(data);
		if (isBinary) {
			this.close(1003, 'Binary frames are not supported.');
			return;
		}
		if (this.authenticatedPeerId === undefined) {
			if (bytes.byteLength > this.preAuthMaxBytes) {
				this.close(1009, 'Pre-authentication frame is too large.');
				return;
			}
			if (!this.consumePreAuthRate()) {
				await this.sendError(null, 1003, 'Rate limit exceeded.', 'RATE_LIMITED');
				this.close(1008, 'Rate limit exceeded.');
				return;
			}
		}
		let value: unknown;
		try {
			value = JSON.parse(textDecoder.decode(bytes)) as unknown;
		} catch {
			await this.sendError(null, -32700, 'Parse error.');
			return;
		}
		if (Array.isArray(value)) {
			await this.sendError(null, -32600, 'JSON-RPC batches are not supported.');
			return;
		}
		let request: RpcRequest;
		try {
			request = parseRequest(value);
		} catch {
			await this.sendError(null, -32600, 'Invalid Request.');
			return;
		}
		try {
			const result = await this.dispatch(request);
			await this.send({ jsonrpc: '2.0', id: request.id, result });
		} catch (error: unknown) {
			await this.handleDispatchError(request.id, error);
		}
	}

	private async dispatch(request: RpcRequest): Promise<unknown> {
		if (request.method === 'mesh.hello') {
			if (this.authenticatedPeerId !== undefined) {
				throw new RpcFailure(1001, 'Authentication failed.', 'AUTH_FAILED');
			}
			return this.pairing.hello(
				this.connectionId,
				request.params as unknown as Parameters<PairingService['hello']>[1],
			);
		}
		if (request.method === 'mesh.authenticate') {
			assertExactParams(request.params, ['sessionId', 'proof']);
			const authenticated = await this.pairing.authenticate(
				this.connectionId,
				stringValue(request.params.sessionId),
				stringValue(request.params.proof),
			);
			if (authenticated.peerId !== undefined) {
				this.markAuthenticated(authenticated.peerId);
			}
			return authenticated.result;
		}
		if (request.method === 'mesh.enrollmentCommit') {
			const hasSession = Object.hasOwn(request.params, 'sessionId');
			assertExactParams(
				request.params,
				hasSession
					? ['sessionId', 'enrollmentId', 'peerId', 'proof']
					: ['enrollmentId', 'peerId', 'proof'],
			);
			const peerId = await this.pairing.commit(
				this.connectionId,
				hasSession ? stringValue(request.params.sessionId) : undefined,
				stringValue(request.params.enrollmentId),
				stringValue(request.params.peerId),
				stringValue(request.params.proof),
			);
			this.markAuthenticated(peerId);
			return { committed: true, peerId };
		}
		if (this.authenticatedPeerId === undefined) {
			throw new RpcFailure(1000, 'Authentication is required.', 'AUTH_REQUIRED');
		}
		if (request.method === 'mesh.ping') {
			assertExactParams(request.params, ['sentAt']);
			if (typeof request.params.sentAt !== 'number'
				|| !Number.isFinite(request.params.sentAt)) {
				throw new GatewayValidationError();
			}
			return { sentAt: request.params.sentAt, receivedAt: this.now() };
		}
		if (!this.router.hasMethod(request.method)) {
			throw new RpcFailure(-32601, 'Method not found.');
		}
		return this.router.dispatch(this.authenticatedPeerId, request.method, request.params);
	}

	private markAuthenticated(peerId: string): void {
		if (this.authenticatedPeerId !== undefined
			|| this.disposed
			|| this.socket.readyState !== WebSocket.OPEN) {
			return;
		}
		this.authenticatedPeerId = peerId;
		if (this.handshakeTimer !== undefined) {
			clearTimeout(this.handshakeTimer);
			this.handshakeTimer = undefined;
		}
		this.lastPongAt = this.now();
		this.heartbeatTimer = setInterval(() => {
			if (this.now() - this.lastPongAt >= this.heartbeatTimeoutMs) {
				this.socket.terminate();
				this.dispose();
				return;
			}
			if (this.socket.readyState === WebSocket.OPEN) {
				this.socket.ping();
			}
		}, this.heartbeatIntervalMs);
		this.onAuthenticated(peerId);
	}

	private consumePreAuthRate(): boolean {
		const threshold = this.now() - this.preAuthRateWindowMs;
		while (this.messageTimes.length > 0 && this.messageTimes[0] <= threshold) {
			this.messageTimes.shift();
		}
		if (this.messageTimes.length >= this.preAuthRateCount) {
			return false;
		}
		this.messageTimes.push(this.now());
		return true;
	}

	private async handleDispatchError(id: string, error: unknown): Promise<void> {
		if (error instanceof PairingProtocolError) {
			const protocolMismatch = error.reason === 'PROTOCOL_INCOMPATIBLE';
			await this.sendError(
				id,
				protocolMismatch ? 1002 : error.reason === 'INVALID_PARAMS' ? -32602 : 1001,
				error.message,
				error.reason,
			);
			if (error.reason === 'AUTH_FAILED') {
				this.authenticationFailures += 1;
				if (this.authenticationFailures >= 5) {
					this.close(1008, 'Authentication failed.');
				}
			}
			if (protocolMismatch) {
				this.close(1002, 'Protocol incompatible.');
			}
			return;
		}
		if (error instanceof GatewayValidationError) {
			await this.sendError(id, -32602, 'Invalid params.');
			return;
		}
		if (error instanceof RpcFailure) {
			await this.sendError(id, error.code, error.message, error.reason);
			return;
		}
		await this.sendError(id, -32603, 'Internal error.');
	}

	private sendError(
		id: string | null,
		code: number,
		message: string,
		reason?: string,
	): Promise<void> {
		return this.send({
			jsonrpc: '2.0',
			id,
			error: {
				code,
				message,
				...(reason === undefined ? {} : { data: { reason } }),
			},
		});
	}

	private send(value: unknown): Promise<void> {
		if (this.disposed || this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error('Connection is closed.'));
		}
		const data = Buffer.from(JSON.stringify(value), 'utf8');
		if (this.outboxEvents + 1 > this.outboxMaxEvents
			|| this.outboxBytes + this.socket.bufferedAmount + data.byteLength > this.outboxMaxBytes) {
			this.close(1013, 'Outbound queue capacity exceeded.');
			return Promise.reject(new Error('Outbound queue capacity exceeded.'));
		}
		this.outboxBytes += data.byteLength;
		this.outboxEvents += 1;
		return new Promise<void>((resolve, reject) => {
			this.queue.push({ data, resolve, reject });
			this.flush();
		});
	}

	private flush(): void {
		if (this.sending || this.disposed || this.socket.readyState !== WebSocket.OPEN) {
			return;
		}
		const message = this.queue.shift();
		if (message === undefined) {
			return;
		}
		this.sending = true;
		this.socket.send(message.data, { binary: false, compress: false }, (error) => {
			this.sending = false;
			this.outboxBytes -= message.data.byteLength;
			this.outboxEvents -= 1;
			if (error === undefined || error === null) {
				message.resolve();
			} else {
				message.reject(new Error('WebSocket send failed.'));
			}
			this.flush();
		});
	}
}

class RpcFailure extends Error {
	public constructor(
		public readonly code: number,
		message: string,
		public readonly reason?: string,
	) {
		super(message);
	}
}

function parseRequest(value: unknown): RpcRequest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Invalid request.');
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key))
		|| record.jsonrpc !== '2.0'
		|| typeof record.id !== 'string'
		|| record.id.length === 0
		|| record.id.length > 128
		|| typeof record.method !== 'string'
		|| record.method.length === 0
		|| typeof record.params !== 'object'
		|| record.params === null
		|| Array.isArray(record.params)) {
		throw new Error('Invalid request.');
	}
	return record as unknown as RpcRequest;
}

function assertExactParams(
	params: Record<string, unknown>,
	keys: readonly string[],
): void {
	if (Object.keys(params).length !== keys.length
		|| keys.some((key) => !Object.hasOwn(params, key))) {
		throw new GatewayValidationError();
	}
}

function stringValue(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
		throw new GatewayValidationError();
	}
	return value;
}

function rawDataToBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data);
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data);
	}
	throw new Error('Unsupported WebSocket frame representation.');
}
