import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from 'node:crypto';
import {
	chmod,
	lstat,
	mkdir,
	unlink,
} from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { TextDecoder } from 'node:util';

import { z } from 'zod';

export const LOCAL_IPC_MAX_FRAME_BYTES = 1024 * 1024;

const PROTOCOL_VERSION = 2;
const NONCE_BYTES = 32;
const PROOF_BYTES = 32;
const HEADER_BYTES = 4;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING_REQUESTS = 128;
const DEFAULT_MAX_OUTBOUND_BYTES = 2 * LOCAL_IPC_MAX_FRAME_BYTES;
const DEFAULT_BACKPRESSURE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PRE_AUTH_CONNECTIONS = 32;
const DEFAULT_PRE_AUTH_RATE_COUNT = 64;
const DEFAULT_PRE_AUTH_RATE_WINDOW_MS = 10_000;
const DEFAULT_PRE_AUTH_FRAME_COUNT = 4;
const DEFAULT_REPLAY_CACHE_SIZE = 4_096;
const DEFAULT_REPLAY_TTL_MS = 5 * 60_000;
const MAX_CONFIGURED_TIMEOUT_MS = 10 * 60_000;
const MAX_CONFIGURED_PENDING_REQUESTS = 1_024;
const MAX_CONFIGURED_OUTBOUND_BYTES = 8 * LOCAL_IPC_MAX_FRAME_BYTES;
const SAFE_CLOSE_MESSAGE = 'Local IPC connection closed.';
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
	z.null(),
	z.boolean(),
	z.number().finite(),
	z.string(),
	z.array(jsonValueSchema),
	z.record(z.string(), jsonValueSchema),
]));
const nonceSchema = z.string().regex(BASE64URL_32_PATTERN);
const clientIdSchema = z.string().min(1).max(128);
const methodSchema = z.string().min(1).max(256);
const requestIdSchema = z.string().min(1).max(128);

const helloFrameSchema = z.object({
	kind: z.literal('hello'),
	version: z.literal(PROTOCOL_VERSION),
	clientId: clientIdSchema,
	clientNonce: nonceSchema,
}).strict();
const challengeFrameSchema = z.object({
	kind: z.literal('challenge'),
	version: z.literal(PROTOCOL_VERSION),
	clientId: clientIdSchema,
	clientNonce: nonceSchema,
	serverNonce: nonceSchema,
	serverProof: nonceSchema,
}).strict();
const authenticateFrameSchema = z.object({
	kind: z.literal('authenticate'),
	version: z.literal(PROTOCOL_VERSION),
	clientId: clientIdSchema,
	clientNonce: nonceSchema,
	serverNonce: nonceSchema,
	clientProof: nonceSchema,
}).strict();
const authenticatedFrameSchema = z.object({
	kind: z.literal('authenticated'),
	version: z.literal(PROTOCOL_VERSION),
	clientId: clientIdSchema,
	clientNonce: nonceSchema,
	serverNonce: nonceSchema,
	serverProof: nonceSchema,
}).strict();
const requestFrameSchema = z.object({
	kind: z.literal('request'),
	jsonrpc: z.literal('2.0'),
	id: requestIdSchema,
	method: methodSchema,
	params: jsonValueSchema,
}).strict();
const notificationFrameSchema = z.object({
	kind: z.literal('notification'),
	jsonrpc: z.literal('2.0'),
	method: methodSchema,
	params: jsonValueSchema,
}).strict();
const resultFrameSchema = z.object({
	kind: z.literal('result'),
	jsonrpc: z.literal('2.0'),
	id: requestIdSchema,
	result: jsonValueSchema,
}).strict();
const errorFrameSchema = z.object({
	kind: z.literal('error'),
	jsonrpc: z.literal('2.0'),
	id: requestIdSchema,
	error: z.object({
		code: z.number().int(),
		message: z.string().min(1).max(512),
		data: jsonValueSchema.optional(),
	}).strict(),
}).strict();
const externalFrameSchema = z.discriminatedUnion('kind', [
	helloFrameSchema,
	challengeFrameSchema,
	authenticateFrameSchema,
	authenticatedFrameSchema,
	requestFrameSchema,
	notificationFrameSchema,
	resultFrameSchema,
	errorFrameSchema,
]);

type ExternalFrame = z.infer<typeof externalFrameSchema>;
type RequestFrame = z.infer<typeof requestFrameSchema>;
type NotificationFrame = z.infer<typeof notificationFrameSchema>;
type ResultFrame = z.infer<typeof resultFrameSchema>;
type ErrorFrame = z.infer<typeof errorFrameSchema>;

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { readonly [key: string]: JsonValue };

export interface LocalIpcIdentity {
	readonly userIdentity: string | Buffer;
	readonly deviceId: string;
	readonly tempDirectory?: string;
}

export interface LocalIpcEndpoint {
	readonly address: string;
	readonly parentDirectory?: string;
	readonly platform: NodeJS.Platform;
}

export type LocalIpcHandler = (
	method: string,
	params: JsonValue,
	session: LocalIpcSession,
) => JsonValue | Promise<JsonValue>;

export interface LocalIpcSessionOptions {
	readonly requestTimeoutMs?: number;
	readonly maxPendingRequests?: number;
	readonly maxOutboundBytes?: number;
	readonly backpressureTimeoutMs?: number;
}

export interface LocalIpcServerOptions extends LocalIpcSessionOptions {
	readonly identity: LocalIpcIdentity;
	readonly brokerKey: Buffer | string;
	readonly handler?: LocalIpcHandler;
	readonly handshakeTimeoutMs?: number;
	readonly maxPreAuthConnections?: number;
	readonly preAuthRateCount?: number;
	readonly preAuthRateWindowMs?: number;
	readonly maxPreAuthFrames?: number;
	readonly replayCacheSize?: number;
	readonly replayTtlMs?: number;
	readonly onSession?: (session: LocalIpcSession) => void;
	readonly onError?: (error: Error) => void;
}

export interface LocalIpcClientOptions extends LocalIpcSessionOptions {
	readonly identity: LocalIpcIdentity;
	readonly clientId: string;
	readonly brokerKey: Buffer | string;
	readonly handler?: LocalIpcHandler;
	readonly handshakeTimeoutMs?: number;
}

export class LocalIpcRemoteError extends Error {
	public constructor(
		public readonly code: number,
		message: string,
		public readonly data?: JsonValue,
	) {
		super(message);
		this.name = 'LocalIpcRemoteError';
	}
}

export class LocalIpcHandlerError extends Error {
	public constructor(
		public readonly code: number,
		message: string,
		public readonly data?: JsonValue,
	) {
		super(message);
		this.name = 'LocalIpcHandlerError';
		if (!Number.isInteger(code)
			|| message.length === 0
			|| message.length > 512
			|| (data !== undefined && !jsonValueSchema.safeParse(data).success)) {
			throw new Error('Invalid local IPC handler error.');
		}
	}
}

export function deriveLocalIpcEndpoint(identity: LocalIpcIdentity): LocalIpcEndpoint {
	const userIdentity = identityBytes(identity.userIdentity);
	if (identity.deviceId.length === 0 || Buffer.byteLength(identity.deviceId, 'utf8') > 256) {
		throw new Error('Invalid local IPC device identity.');
	}
	const platform = process.platform;
	const digest = createHash('sha256')
		.update('copilot-agent-mesh/local-ipc-endpoint/v1\0', 'utf8')
		.update(lengthPrefix(userIdentity))
		.update(lengthPrefix(Buffer.from(identity.deviceId, 'utf8')))
		.digest('hex');
	if (platform === 'win32') {
		return {
			address: `\\\\.\\pipe\\copilot-agent-mesh-${digest.slice(0, 32)}`,
			platform,
		};
	}
	const parentDirectory = path.join(identity.tempDirectory ?? os.tmpdir(), `cam-${digest.slice(0, 16)}`);
	if (Buffer.byteLength(path.join(parentDirectory, 'ipc.sock'), 'utf8') > 90) {
		throw new Error('Local IPC endpoint path is too long.');
	}
	return {
		address: path.join(parentDirectory, 'ipc.sock'),
		parentDirectory,
		platform,
	};
}

export class LengthPrefixedJsonDecoder {
	private readonly header = Buffer.alloc(HEADER_BYTES);
	private headerBytes = 0;
	private payload: Buffer | undefined;
	private payloadBytes = 0;

	public push(chunk: Buffer): ExternalFrame[] {
		const frames: ExternalFrame[] = [];
		let offset = 0;
		while (offset < chunk.byteLength) {
			if (this.payload === undefined) {
				const headerBytes = Math.min(HEADER_BYTES - this.headerBytes, chunk.byteLength - offset);
				chunk.copy(this.header, this.headerBytes, offset, offset + headerBytes);
				this.headerBytes += headerBytes;
				offset += headerBytes;
				if (this.headerBytes < HEADER_BYTES) {
					continue;
				}
				const length = this.header.readUInt32BE(0);
				if (length === 0 || length > LOCAL_IPC_MAX_FRAME_BYTES) {
					throw new Error('Invalid local IPC frame length.');
				}
				this.payload = Buffer.allocUnsafe(length);
				this.payloadBytes = 0;
				this.headerBytes = 0;
			}
			const payloadBytes = Math.min(
				this.payload.byteLength - this.payloadBytes,
				chunk.byteLength - offset,
			);
			chunk.copy(this.payload, this.payloadBytes, offset, offset + payloadBytes);
			this.payloadBytes += payloadBytes;
			offset += payloadBytes;
			if (this.payloadBytes === this.payload.byteLength) {
				frames.push(parseExternalFrame(this.payload));
				this.payload = undefined;
				this.payloadBytes = 0;
			}
		}
		return frames;
	}

	public finish(): void {
		if (this.payload !== undefined || this.headerBytes !== 0) {
			throw new Error('Truncated local IPC frame.');
		}
	}
}

export class LocalIpcSession {
	private readonly handlers = new Map<string, LocalIpcHandler>();

	public constructor(
		private readonly peer: IpcPeer,
		public readonly clientId: string,
		defaultHandler?: LocalIpcHandler,
	) {
		if (defaultHandler !== undefined) {
			this.peer.setDefaultHandler(defaultHandler);
		}
		this.peer.attachSession(this);
	}

	public request<T extends JsonValue = JsonValue>(method: string, params: JsonValue): Promise<T> {
		return this.peer.request(method, params) as Promise<T>;
	}

	public notify(method: string, params: JsonValue): Promise<void> {
		return this.peer.notify(method, params);
	}

	public handle(method: string, handler: LocalIpcHandler): () => void {
		if (!methodSchema.safeParse(method).success) {
			throw new Error('Invalid local IPC method.');
		}
		if (this.handlers.has(method)) {
			throw new Error('A local IPC handler is already registered.');
		}
		this.handlers.set(method, handler);
		return () => {
			if (this.handlers.get(method) === handler) {
				this.handlers.delete(method);
			}
		};
	}

	public onClose(listener: (error?: Error) => void): () => void {
		return this.peer.onClose(listener);
	}

	public close(): void {
		this.peer.close();
	}

	public dispose(): void {
		this.close();
	}

	public get closed(): boolean {
		return this.peer.closed;
	}

	public dispatch(method: string, params: JsonValue): JsonValue | Promise<JsonValue> {
		const handler = this.handlers.get(method);
		if (handler !== undefined) {
			return handler(method, params, this);
		}
		return this.peer.dispatchDefault(method, params, this);
	}
}

export class LocalIpcServer {
	public readonly endpoint: LocalIpcEndpoint;
	private readonly key: Buffer;
	private readonly server = net.createServer();
	private readonly sessionsByClientId = new Map<string, LocalIpcSession>();
	private readonly preAuthPeers = new Set<IpcPeer>();
	private readonly attemptTimes: number[] = [];
	private readonly replayCache: ReplayCache;
	private listenPromise: Promise<void> | undefined;
	private disposePromise: Promise<void> | undefined;
	private socketIdentity: SocketIdentity | undefined;
	private disposed = false;
	private disposeComplete = false;

	public constructor(private readonly options: LocalIpcServerOptions) {
		validateServerOptions(options);
		this.endpoint = deriveLocalIpcEndpoint(options.identity);
		this.key = normalizeBrokerKey(options.brokerKey);
		this.replayCache = new ReplayCache(
			options.replayCacheSize ?? DEFAULT_REPLAY_CACHE_SIZE,
			options.replayTtlMs ?? DEFAULT_REPLAY_TTL_MS,
		);
		this.server.on('connection', (socket) => this.accept(socket));
		this.server.on('error', (error) => {
			if (!this.disposed) {
				this.options.onError?.(safeError(error, 'Local IPC server failed.'));
			}
		});
	}

	public get sessions(): readonly LocalIpcSession[] {
		return [...this.sessionsByClientId.values()];
	}

	public listen(): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new Error('Local IPC server is disposed.'));
		}
		this.listenPromise ??= this.startListening();
		return this.listenPromise;
	}

	public dispose(): Promise<void> {
		if (this.disposePromise !== undefined) {
			return this.disposePromise;
		}
		if (this.disposeComplete) {
			return Promise.resolve();
		}
		let disposal!: Promise<void>;
		disposal = this.disposeOnce().then(() => {
			this.disposeComplete = true;
		}).finally(() => {
			if (!this.disposeComplete && this.disposePromise === disposal) {
				this.disposePromise = undefined;
			}
		});
		this.disposePromise = disposal;
		return disposal;
	}

	private async startListening(): Promise<void> {
		if (this.endpoint.parentDirectory !== undefined) {
			await prepareUnixDirectory(this.endpoint.parentDirectory);
			await removeSocketIfPresent(this.endpoint.address);
		}
		if (this.disposed) {
			throw new Error('Local IPC server is disposed.');
		}
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				this.server.off('listening', onListening);
				reject(safeError(error, 'Local IPC server failed to listen.'));
			};
			const onListening = (): void => {
				this.server.off('error', onError);
				resolve();
			};
			this.server.once('error', onError);
			this.server.once('listening', onListening);
			this.server.listen(this.endpoint.address);
		});
		if (this.endpoint.parentDirectory !== undefined) {
			this.socketIdentity = await secureUnixSocket(this.endpoint.address);
		}
	}

	private accept(socket: net.Socket): void {
		if (this.disposed || !this.consumeAttempt() || this.preAuthPeers.size >= (
			this.options.maxPreAuthConnections ?? DEFAULT_MAX_PRE_AUTH_CONNECTIONS
		)) {
			socket.destroy();
			return;
		}
		socket.setNoDelay(true);
		const peer = new IpcPeer(socket, 'server', this.key, {
			...this.options,
			handshakeTimeoutMs: this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
			maxPreAuthFrames: this.options.maxPreAuthFrames ?? DEFAULT_PRE_AUTH_FRAME_COUNT,
			claimClientNonce: (nonce) => this.replayCache.claim(nonce),
			onAuthenticated: (clientId) => this.authenticated(peer, clientId),
			onReady: (clientId) => this.ready(peer, clientId),
		});
		this.preAuthPeers.add(peer);
		peer.onClose((error) => {
			this.preAuthPeers.delete(peer);
			const session = [...this.sessionsByClientId.entries()]
				.find(([, candidate]) => candidate === peer.session);
			if (session !== undefined) {
				this.sessionsByClientId.delete(session[0]);
			}
			if (error !== undefined && !this.disposed) {
				this.options.onError?.(error);
			}
		});
	}

	private authenticated(peer: IpcPeer, clientId: string): void {
		if (this.disposed || peer.closed) {
			peer.close(new Error(SAFE_CLOSE_MESSAGE));
			return;
		}
		new LocalIpcSession(peer, clientId, this.options.handler);
	}

	private ready(peer: IpcPeer, clientId: string): void {
		this.preAuthPeers.delete(peer);
		const session = peer.session;
		if (this.disposed || peer.closed || session === undefined) {
			peer.close(new Error(SAFE_CLOSE_MESSAGE));
			return;
		}
		const previous = this.sessionsByClientId.get(clientId);
		this.sessionsByClientId.set(clientId, session);
		if (previous !== undefined && previous !== session) {
			previous.close();
		}
		this.options.onSession?.(session);
	}

	private consumeAttempt(): boolean {
		const now = Date.now();
		const windowMs = this.options.preAuthRateWindowMs ?? DEFAULT_PRE_AUTH_RATE_WINDOW_MS;
		while (this.attemptTimes.length > 0 && this.attemptTimes[0] <= now - windowMs) {
			this.attemptTimes.shift();
		}
		if (this.attemptTimes.length >= (
			this.options.preAuthRateCount ?? DEFAULT_PRE_AUTH_RATE_COUNT
		)) {
			return false;
		}
		this.attemptTimes.push(now);
		return true;
	}

	private async disposeOnce(): Promise<void> {
		this.disposed = true;
		for (const peer of this.preAuthPeers) {
			peer.close();
		}
		for (const session of this.sessionsByClientId.values()) {
			session.close();
		}
		this.preAuthPeers.clear();
		this.sessionsByClientId.clear();
		if (this.listenPromise !== undefined) {
			try {
				await this.listenPromise;
			} catch {
				// A failed or cancelled listen has no open server to close.
			}
		}
		if (this.server.listening) {
			await new Promise<void>((resolve, reject) => this.server.close((error) => {
				if (error === undefined) {
					resolve();
				} else {
					reject(safeError(error, 'Local IPC server failed to close.'));
				}
			}));
		}
		if (this.endpoint.parentDirectory !== undefined && this.socketIdentity !== undefined) {
			await removeSocketIfPresent(this.endpoint.address, this.socketIdentity);
		}
		this.key.fill(0);
	}
}

export class LocalIpcClient {
	public readonly endpoint: LocalIpcEndpoint;
	private readonly key: Buffer;
	private session: LocalIpcSession | undefined;
	private peer: IpcPeer | undefined;
	private connectPromise: Promise<LocalIpcSession> | undefined;
	private disposed = false;

	public constructor(private readonly options: LocalIpcClientOptions) {
		validateSessionOptions(options);
		if (options.handshakeTimeoutMs !== undefined) {
			boundedPositiveInteger(
				options.handshakeTimeoutMs,
				'handshake timeout',
				MAX_CONFIGURED_TIMEOUT_MS,
			);
		}
		this.endpoint = deriveLocalIpcEndpoint(options.identity);
		this.key = normalizeBrokerKey(options.brokerKey);
		if (!clientIdSchema.safeParse(options.clientId).success) {
			throw new Error('Invalid local IPC client identity.');
		}
	}

	public connect(): Promise<LocalIpcSession> {
		if (this.disposed) {
			return Promise.reject(new Error('Local IPC client is disposed.'));
		}
		this.connectPromise ??= this.connectOnce();
		return this.connectPromise;
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.peer?.close();
		this.session?.close();
		this.key.fill(0);
	}

	private async connectOnce(): Promise<LocalIpcSession> {
		const socket = net.createConnection(this.endpoint.address);
		socket.setNoDelay(true);
		const peer = new IpcPeer(socket, 'client', this.key, {
			...this.options,
			handshakeTimeoutMs: this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
			clientId: this.options.clientId,
		});
		this.peer = peer;
		const session = new LocalIpcSession(peer, this.options.clientId, this.options.handler);
		try {
			await peer.authenticate();
			if (this.disposed || peer.closed) {
				throw new Error('Local IPC client was disposed while connecting.');
			}
			this.session = session;
			return session;
		} catch (error: unknown) {
			peer.close();
			throw safeError(error, 'Local IPC authentication failed.');
		}
	}
}

interface IpcPeerOptions extends LocalIpcSessionOptions {
	readonly handshakeTimeoutMs: number;
	readonly maxPreAuthFrames?: number;
	readonly clientId?: string;
	readonly claimClientNonce?: (nonce: string) => boolean;
	readonly onAuthenticated?: (clientId: string) => void;
	readonly onReady?: (clientId: string) => void;
}

interface PendingRequest {
	readonly resolve: (value: JsonValue) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

interface PendingWrite {
	readonly bytes: number;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	settled: boolean;
}

class IpcPeer {
	public session: LocalIpcSession | undefined;
	private readonly decoder = new LengthPrefixedJsonDecoder();
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly incomingRequestIds = new Set<string>();
	private readonly pendingWrites = new Set<PendingWrite>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	private readonly handshakeTimer: NodeJS.Timeout;
	private readonly requestTimeoutMs: number;
	private readonly maxPendingRequests: number;
	private readonly maxOutboundBytes: number;
	private readonly backpressureTimeoutMs: number;
	private defaultHandler: LocalIpcHandler | undefined;
	private authenticationResolve: ((clientId: string) => void) | undefined;
	private authenticationReject: ((error: Error) => void) | undefined;
	private backpressureTimer: NodeJS.Timeout | undefined;
	private pendingWriteBytes = 0;
	private incomingNotifications = 0;
	private preAuthFrames = 0;
	private state: 'awaiting-hello' | 'awaiting-challenge' | 'awaiting-authenticate'
		| 'awaiting-authenticated' | 'authenticated' | 'closed';
	private clientNonce: string | undefined;
	private serverNonce: string | undefined;
	private authenticatedClientId: string | undefined;

	public constructor(
		private readonly socket: net.Socket,
		private readonly role: 'server' | 'client',
		private readonly key: Buffer,
		private readonly options: IpcPeerOptions,
	) {
		this.state = role === 'server' ? 'awaiting-hello' : 'awaiting-challenge';
		this.requestTimeoutMs = boundedPositiveInteger(
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			'request timeout',
			MAX_CONFIGURED_TIMEOUT_MS,
		);
		this.maxPendingRequests = boundedPositiveInteger(
			options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
			'pending request limit',
			MAX_CONFIGURED_PENDING_REQUESTS,
		);
		this.maxOutboundBytes = boundedPositiveInteger(
			options.maxOutboundBytes ?? DEFAULT_MAX_OUTBOUND_BYTES,
			'outbound byte limit',
			MAX_CONFIGURED_OUTBOUND_BYTES,
		);
		this.backpressureTimeoutMs = boundedPositiveInteger(
			options.backpressureTimeoutMs ?? DEFAULT_BACKPRESSURE_TIMEOUT_MS,
			'backpressure timeout',
			MAX_CONFIGURED_TIMEOUT_MS,
		);
		this.handshakeTimer = setTimeout(
			() => this.fail(new Error('Local IPC authentication deadline exceeded.')),
			boundedPositiveInteger(
				options.handshakeTimeoutMs,
				'handshake timeout',
				MAX_CONFIGURED_TIMEOUT_MS,
			),
		);
		this.socket.on('data', (chunk) => this.receive(chunk));
		this.socket.on('drain', () => this.clearBackpressureTimer());
		this.socket.once('end', () => this.ended());
		this.socket.once('close', () => this.finishClose());
		this.socket.once('error', (error) => this.fail(safeError(error, SAFE_CLOSE_MESSAGE)));
		if (role === 'client') {
			this.clientNonce = randomValue();
			void this.send({
				kind: 'hello',
				version: PROTOCOL_VERSION,
				clientId: options.clientId!,
				clientNonce: this.clientNonce,
			}).catch((error: unknown) => this.fail(safeError(error, SAFE_CLOSE_MESSAGE)));
		}
	}

	public get closed(): boolean {
		return this.state === 'closed';
	}

	public attachSession(session: LocalIpcSession): void {
		if (this.session !== undefined || this.state === 'closed') {
			throw new Error('Invalid local IPC session attachment.');
		}
		this.session = session;
	}

	public setDefaultHandler(handler: LocalIpcHandler): void {
		this.defaultHandler = handler;
	}

	public dispatchDefault(
		method: string,
		params: JsonValue,
		session: LocalIpcSession,
	): JsonValue | Promise<JsonValue> {
		if (this.defaultHandler === undefined) {
			throw new LocalIpcHandlerError(-32601, 'Method not found.');
		}
		return this.defaultHandler(method, params, session);
	}

	public authenticate(): Promise<string> {
		if (this.role !== 'client') {
			return Promise.reject(new Error('Only a client can initiate authentication.'));
		}
		return new Promise<string>((resolve, reject) => {
			if (this.state === 'authenticated' && this.authenticatedClientId !== undefined) {
				resolve(this.authenticatedClientId);
				return;
			}
			if (this.state === 'closed') {
				reject(new Error(SAFE_CLOSE_MESSAGE));
				return;
			}
			this.authenticationResolve = resolve;
			this.authenticationReject = reject;
		});
	}

	public request(method: string, params: JsonValue): Promise<JsonValue> {
		if (this.state !== 'authenticated') {
			return Promise.reject(new Error('Local IPC session is not authenticated.'));
		}
		if (this.pendingRequests.size >= this.maxPendingRequests) {
			return Promise.reject(new Error('Local IPC pending request limit exceeded.'));
		}
		const id = randomBytes(16).toString('base64url');
		return new Promise<JsonValue>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.fail(new Error('Local IPC request timed out.'));
				}
			}, this.requestTimeoutMs);
			this.pendingRequests.set(id, { resolve, reject, timer });
			void this.send({
				kind: 'request',
				jsonrpc: '2.0',
				id,
				method,
				params,
			}).catch((error: unknown) => {
				const pending = this.pendingRequests.get(id);
				if (pending !== undefined) {
					clearTimeout(pending.timer);
					this.pendingRequests.delete(id);
					pending.reject(safeError(error, 'Local IPC request failed.'));
				}
			});
		});
	}

	public notify(method: string, params: JsonValue): Promise<void> {
		if (this.state !== 'authenticated') {
			return Promise.reject(new Error('Local IPC session is not authenticated.'));
		}
		return this.send({
			kind: 'notification',
			jsonrpc: '2.0',
			method,
			params,
		});
	}

	public onClose(listener: (error?: Error) => void): () => void {
		if (this.state === 'closed') {
			queueMicrotask(() => {
				try {
					listener();
				} catch {
					process.emitWarning('A local IPC close listener failed.', {
						code: 'LOCAL_IPC_CLOSE_LISTENER_FAILED',
					});
				}
			});
			return () => undefined;
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	public close(error?: Error): void {
		if (this.state === 'closed') {
			return;
		}
		this.fail(error);
	}

	private receive(chunk: Buffer): void {
		if (this.state === 'closed') {
			return;
		}
		try {
			const frames = this.decoder.push(chunk);
			for (const frame of frames) {
				if (this.state !== 'authenticated') {
					this.preAuthFrames += 1;
					if (this.preAuthFrames > (
						this.options.maxPreAuthFrames ?? DEFAULT_PRE_AUTH_FRAME_COUNT
					)) {
						throw new Error('Local IPC pre-authentication frame limit exceeded.');
					}
				}
				this.receiveFrame(frame);
			}
		} catch (error: unknown) {
			this.fail(safeError(error, 'Invalid local IPC frame.'));
		}
	}

	private receiveFrame(frame: ExternalFrame): void {
		if (this.state === 'awaiting-hello' && frame.kind === 'hello') {
			this.receiveHello(frame);
			return;
		}
		if (this.state === 'awaiting-challenge' && frame.kind === 'challenge') {
			this.receiveChallenge(frame);
			return;
		}
		if (this.state === 'awaiting-authenticate' && frame.kind === 'authenticate') {
			this.receiveAuthenticate(frame);
			return;
		}
		if (this.state === 'awaiting-authenticated' && frame.kind === 'authenticated') {
			this.receiveAuthenticated(frame);
			return;
		}
		if (this.state === 'authenticated') {
			if (frame.kind === 'request') {
				if (this.incomingRequestIds.has(frame.id)
					|| this.incomingRequestIds.size >= this.maxPendingRequests) {
					throw new Error('Local IPC inbound request limit exceeded.');
				}
				this.incomingRequestIds.add(frame.id);
				void this.handleRequest(frame);
				return;
			}
			if (frame.kind === 'notification') {
				if (this.incomingNotifications >= this.maxPendingRequests) {
					throw new Error('Local IPC inbound notification limit exceeded.');
				}
				this.incomingNotifications += 1;
				void this.handleNotification(frame);
				return;
			}
			if (frame.kind === 'result' || frame.kind === 'error') {
				this.receiveResponse(frame);
				return;
			}
		}
		throw new Error('Unexpected local IPC frame.');
	}

	private receiveHello(frame: z.infer<typeof helloFrameSchema>): void {
		if (this.role !== 'server' || this.options.claimClientNonce?.(frame.clientNonce) !== true) {
			throw new Error('Local IPC authentication failed.');
		}
		this.clientNonce = frame.clientNonce;
		this.serverNonce = randomValue();
		this.authenticatedClientId = frame.clientId;
		this.state = 'awaiting-authenticate';
		const transcript = authTranscript(frame.clientId, frame.clientNonce, this.serverNonce);
		void this.send({
			kind: 'challenge',
			version: PROTOCOL_VERSION,
			clientId: frame.clientId,
			clientNonce: frame.clientNonce,
			serverNonce: this.serverNonce,
			serverProof: proof(this.key, 'server-challenge', transcript),
		}).catch((error: unknown) => this.fail(safeError(error, SAFE_CLOSE_MESSAGE)));
	}

	private receiveChallenge(frame: z.infer<typeof challengeFrameSchema>): void {
		const clientId = this.options.clientId!;
		if (frame.clientId !== clientId
			|| frame.clientNonce !== this.clientNonce
			|| !verifyProof(
				this.key,
				'server-challenge',
				authTranscript(clientId, frame.clientNonce, frame.serverNonce),
				frame.serverProof,
			)) {
			throw new Error('Local IPC authentication failed.');
		}
		this.serverNonce = frame.serverNonce;
		this.authenticatedClientId = clientId;
		this.state = 'awaiting-authenticated';
		void this.send({
			kind: 'authenticate',
			version: PROTOCOL_VERSION,
			clientId,
			clientNonce: frame.clientNonce,
			serverNonce: frame.serverNonce,
			clientProof: proof(
				this.key,
				'client-response',
				authTranscript(clientId, frame.clientNonce, frame.serverNonce),
			),
		}).catch((error: unknown) => this.fail(safeError(error, SAFE_CLOSE_MESSAGE)));
	}

	private receiveAuthenticate(frame: z.infer<typeof authenticateFrameSchema>): void {
		if (frame.clientId !== this.authenticatedClientId
			|| frame.clientNonce !== this.clientNonce
			|| frame.serverNonce !== this.serverNonce
			|| !verifyProof(
				this.key,
				'client-response',
				authTranscript(frame.clientId, frame.clientNonce, frame.serverNonce),
				frame.clientProof,
			)) {
			throw new Error('Local IPC authentication failed.');
		}
		this.state = 'authenticated';
		clearTimeout(this.handshakeTimer);
		this.options.onAuthenticated?.(frame.clientId);
		void this.send({
			kind: 'authenticated',
			version: PROTOCOL_VERSION,
			clientId: frame.clientId,
			clientNonce: frame.clientNonce,
			serverNonce: frame.serverNonce,
			serverProof: proof(
				this.key,
				'server-finished',
				authTranscript(frame.clientId, frame.clientNonce, frame.serverNonce),
			),
		}).then(() => {
			if (!this.closed) {
				this.options.onReady?.(frame.clientId);
			}
		}).catch((error: unknown) => this.fail(safeError(error, SAFE_CLOSE_MESSAGE)));
	}

	private receiveAuthenticated(frame: z.infer<typeof authenticatedFrameSchema>): void {
		if (frame.clientId !== this.authenticatedClientId
			|| frame.clientNonce !== this.clientNonce
			|| frame.serverNonce !== this.serverNonce
			|| !verifyProof(
				this.key,
				'server-finished',
				authTranscript(frame.clientId, frame.clientNonce, frame.serverNonce),
				frame.serverProof,
			)) {
			throw new Error('Local IPC authentication failed.');
		}
		this.state = 'authenticated';
		clearTimeout(this.handshakeTimer);
		this.authenticationResolve?.(frame.clientId);
		this.authenticationResolve = undefined;
		this.authenticationReject = undefined;
	}

	private async handleRequest(frame: RequestFrame): Promise<void> {
		try {
			if (this.session === undefined) {
				throw new Error('Local IPC session is unavailable.');
			}
			const result = await this.session.dispatch(frame.method, frame.params);
			const parsed = jsonValueSchema.safeParse(result);
			if (!parsed.success) {
				throw new Error('Local IPC handler returned an invalid result.');
			}
			await this.send({
				kind: 'result',
				jsonrpc: '2.0',
				id: frame.id,
				result: parsed.data,
			});
		} catch (error: unknown) {
			const rpcError = error instanceof LocalIpcHandlerError
				? error
				: new LocalIpcHandlerError(-32603, 'Internal error.');
			try {
				await this.send({
					kind: 'error',
					jsonrpc: '2.0',
					id: frame.id,
					error: {
						code: rpcError.code,
						message: rpcError.message,
						...(rpcError.data === undefined ? {} : { data: rpcError.data }),
					},
				});
			} catch (sendError: unknown) {
				this.fail(safeError(sendError, SAFE_CLOSE_MESSAGE));
			}
		} finally {
			this.incomingRequestIds.delete(frame.id);
		}
	}

	private async handleNotification(frame: NotificationFrame): Promise<void> {
		try {
			if (this.session === undefined) {
				throw new Error('Local IPC session is unavailable.');
			}
			await this.session.dispatch(frame.method, frame.params);
		} catch (error: unknown) {
			this.fail(safeError(error, 'Local IPC notification handler failed.'));
		} finally {
			if (this.incomingNotifications > 0) {
				this.incomingNotifications -= 1;
			}
		}
	}

	private receiveResponse(frame: ResultFrame | ErrorFrame): void {
		const pending = this.pendingRequests.get(frame.id);
		if (pending === undefined) {
			throw new Error('Unexpected local IPC response.');
		}
		this.pendingRequests.delete(frame.id);
		clearTimeout(pending.timer);
		if (frame.kind === 'result') {
			pending.resolve(frame.result);
		} else {
			pending.reject(new LocalIpcRemoteError(
				frame.error.code,
				frame.error.message,
				frame.error.data,
			));
		}
	}

	private send(frame: ExternalFrame): Promise<void> {
		if (this.state === 'closed' || this.socket.destroyed) {
			return Promise.reject(new Error(SAFE_CLOSE_MESSAGE));
		}
		let encoded: Buffer;
		try {
			encoded = encodeFrame(frame);
		} catch (error: unknown) {
			return Promise.reject(safeError(error, 'Invalid outbound local IPC frame.'));
		}
		if (this.pendingWriteBytes + encoded.byteLength > this.maxOutboundBytes) {
			this.fail(new Error('Local IPC outbound byte limit exceeded.'));
			return Promise.reject(new Error('Local IPC outbound byte limit exceeded.'));
		}
		return new Promise<void>((resolve, reject) => {
			const pending: PendingWrite = {
				bytes: encoded.byteLength,
				resolve,
				reject,
				settled: false,
			};
			this.pendingWrites.add(pending);
			this.pendingWriteBytes += encoded.byteLength;
			const writable = this.socket.write(encoded, (error?: Error | null) => {
				if (pending.settled) {
					return;
				}
				pending.settled = true;
				this.pendingWrites.delete(pending);
				this.pendingWriteBytes -= pending.bytes;
				if (error === undefined || error === null) {
					pending.resolve();
				} else {
					pending.reject(new Error('Local IPC write failed.'));
				}
			});
			if (!writable && this.backpressureTimer === undefined) {
				this.backpressureTimer = setTimeout(
					() => this.fail(new Error('Local IPC backpressure deadline exceeded.')),
					this.backpressureTimeoutMs,
				);
			}
		});
	}

	private clearBackpressureTimer(): void {
		if (this.backpressureTimer !== undefined) {
			clearTimeout(this.backpressureTimer);
			this.backpressureTimer = undefined;
		}
	}

	private ended(): void {
		try {
			this.decoder.finish();
			this.fail();
		} catch (error: unknown) {
			this.fail(safeError(error, 'Invalid trailing local IPC data.'));
		}
	}

	private fail(error?: Error): void {
		if (this.state === 'closed') {
			return;
		}
		const wasConnecting = this.state !== 'authenticated';
		this.state = 'closed';
		clearTimeout(this.handshakeTimer);
		this.clearBackpressureTimer();
		if (wasConnecting) {
			this.authenticationReject?.(error ?? new Error(SAFE_CLOSE_MESSAGE));
			this.authenticationResolve = undefined;
			this.authenticationReject = undefined;
		}
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error ?? new Error(SAFE_CLOSE_MESSAGE));
		}
		this.pendingRequests.clear();
		this.incomingRequestIds.clear();
		this.incomingNotifications = 0;
		for (const pending of this.pendingWrites) {
			if (!pending.settled) {
				pending.settled = true;
				pending.reject(error ?? new Error(SAFE_CLOSE_MESSAGE));
			}
		}
		this.pendingWrites.clear();
		this.pendingWriteBytes = 0;
		this.socket.destroy();
		for (const listener of this.closeListeners) {
			try {
				listener(error);
			} catch {
				process.emitWarning('A local IPC close listener failed.', {
					code: 'LOCAL_IPC_CLOSE_LISTENER_FAILED',
				});
			}
		}
		this.closeListeners.clear();
	}

	private finishClose(): void {
		this.fail();
	}
}

class ReplayCache {
	private readonly values = new Map<string, number>();

	public constructor(
		private readonly maxSize: number,
		private readonly ttlMs: number,
	) {
		boundedPositiveInteger(maxSize, 'replay cache size', 65_536);
		boundedPositiveInteger(ttlMs, 'replay cache lifetime', 24 * 60 * 60_000);
	}

	public claim(value: string): boolean {
		const now = Date.now();
		for (const [nonce, expiresAt] of this.values) {
			if (expiresAt > now) {
				break;
			}
			this.values.delete(nonce);
		}
		if (this.values.has(value)) {
			return false;
		}
		while (this.values.size >= this.maxSize) {
			const oldest = this.values.keys().next().value as string | undefined;
			if (oldest === undefined) {
				break;
			}
			this.values.delete(oldest);
		}
		this.values.set(value, now + this.ttlMs);
		return true;
	}
}

function identityBytes(value: string | Buffer): Buffer {
	const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
	if (bytes.byteLength === 0 || bytes.byteLength > 4_096) {
		throw new Error('Invalid local IPC user identity.');
	}
	return bytes;
}

function normalizeBrokerKey(value: Buffer | string): Buffer {
	let key: Buffer;
	if (Buffer.isBuffer(value)) {
		key = Buffer.from(value);
	} else {
		if (!BASE64URL_32_PATTERN.test(value)) {
			throw new Error('Invalid local IPC broker key.');
		}
		key = Buffer.from(value, 'base64url');
		if (key.toString('base64url') !== value) {
			throw new Error('Invalid local IPC broker key.');
		}
	}
	if (key.byteLength !== 32) {
		key.fill(0);
		throw new Error('Invalid local IPC broker key.');
	}
	return key;
}

function randomValue(): string {
	return randomBytes(NONCE_BYTES).toString('base64url');
}

function authTranscript(clientId: string, clientNonce: string, serverNonce: string): Buffer {
	return Buffer.concat([
		lengthPrefix(Buffer.from(String(PROTOCOL_VERSION), 'ascii')),
		lengthPrefix(Buffer.from(clientId, 'utf8')),
		lengthPrefix(Buffer.from(clientNonce, 'ascii')),
		lengthPrefix(Buffer.from(serverNonce, 'ascii')),
	]);
}

function proof(key: Buffer, purpose: string, transcript: Buffer): string {
	return createHmac('sha256', key)
		.update(`copilot-agent-mesh/local-ipc/${purpose}/v1\0`, 'utf8')
		.update(transcript)
		.digest('base64url');
}

function verifyProof(
	key: Buffer,
	purpose: string,
	transcript: Buffer,
	candidate: string,
): boolean {
	if (!BASE64URL_32_PATTERN.test(candidate)) {
		return false;
	}
	const expected = Buffer.from(proof(key, purpose, transcript), 'base64url');
	const received = Buffer.from(candidate, 'base64url');
	return received.byteLength === PROOF_BYTES && timingSafeEqual(expected, received);
}

function lengthPrefix(value: Buffer): Buffer {
	const result = Buffer.allocUnsafe(4 + value.byteLength);
	result.writeUInt32BE(value.byteLength, 0);
	value.copy(result, 4);
	return result;
}

function encodeFrame(value: ExternalFrame): Buffer {
	const parsed = externalFrameSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error('Invalid local IPC frame.');
	}
	const payload = Buffer.from(JSON.stringify(parsed.data), 'utf8');
	if (payload.byteLength === 0 || payload.byteLength > LOCAL_IPC_MAX_FRAME_BYTES) {
		throw new Error('Local IPC frame size limit exceeded.');
	}
	return lengthPrefix(payload);
}

function parseExternalFrame(payload: Buffer): ExternalFrame {
	let value: unknown;
	try {
		const decoder = new TextDecoder('utf-8', { fatal: true });
		value = JSON.parse(decoder.decode(payload)) as unknown;
	} catch {
		throw new Error('Invalid local IPC JSON.');
	}
	const parsed = externalFrameSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error('Invalid local IPC frame.');
	}
	return parsed.data;
}

interface SocketIdentity {
	readonly device: number;
	readonly inode: number;
}

async function prepareUnixDirectory(directoryPath: string): Promise<void> {
	try {
		await mkdir(directoryPath, { mode: 0o700 });
	} catch (error: unknown) {
		if (!isNodeError(error) || error.code !== 'EEXIST') {
			throw safeError(error, 'Unable to prepare local IPC directory.');
		}
		try {
			const existing = await lstat(directoryPath);
			if (!existing.isDirectory()
				|| (typeof process.getuid === 'function' && existing.uid !== process.getuid())) {
				throw new Error('Local IPC directory is unsafe.');
			}
		} catch (statError: unknown) {
			throw safeError(statError, 'Unable to verify local IPC directory.');
		}
	}
	try {
		await chmod(directoryPath, 0o700);
	} catch (error: unknown) {
		throw safeError(error, 'Unable to secure local IPC directory.');
	}
}

async function secureUnixSocket(socketPath: string): Promise<SocketIdentity> {
	try {
		const socketStat = await lstat(socketPath);
		if (!socketStat.isSocket()) {
			throw new Error('Local IPC endpoint is not a socket.');
		}
		await chmod(socketPath, 0o600);
		return { device: socketStat.dev, inode: socketStat.ino };
	} catch (error: unknown) {
		throw safeError(error, 'Unable to secure local IPC endpoint.');
	}
}

async function removeSocketIfPresent(
	socketPath: string,
	expected?: SocketIdentity,
): Promise<void> {
	try {
		const stat = await lstat(socketPath);
		if (!stat.isSocket()) {
			throw new Error('Local IPC endpoint is not a socket.');
		}
		if (expected !== undefined
			&& (stat.dev !== expected.device || stat.ino !== expected.inode)) {
			return;
		}
		if (expected === undefined) {
			if (await socketIsActive(socketPath)) {
				throw new Error('Local IPC endpoint is already active.');
			}
			const current = await lstat(socketPath);
			if (!current.isSocket() || current.dev !== stat.dev || current.ino !== stat.ino) {
				throw new Error('Local IPC endpoint changed during stale-socket cleanup.');
			}
		}
		await unlink(socketPath);
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === 'ENOENT') {
			return;
		}
		throw safeError(error, 'Unable to prepare local IPC endpoint.');
	}
}

function socketIsActive(socketPath: string): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let settled = false;
		const timer = setTimeout(() => {
			finish();
			socket.destroy();
			reject(new Error('Unable to verify stale local IPC endpoint.'));
		}, 250);
		const finish = (): boolean => {
			if (settled) {
				return false;
			}
			settled = true;
			clearTimeout(timer);
			socket.removeAllListeners();
			return true;
		};
		socket.once('connect', () => {
			if (finish()) {
				socket.destroy();
				resolve(true);
			}
		});
		socket.once('error', (error: NodeJS.ErrnoException) => {
			if (!finish()) {
				return;
			}
			socket.destroy();
			if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
				resolve(false);
			} else {
				reject(new Error('Unable to verify stale local IPC endpoint.'));
			}
		});
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

function safeError(error: unknown, fallback: string): Error {
	if (error instanceof LocalIpcRemoteError || error instanceof LocalIpcHandlerError) {
		return error;
	}
	return new Error(fallback);
}

function validateSessionOptions(options: LocalIpcSessionOptions): void {
	if (options.requestTimeoutMs !== undefined) {
		boundedPositiveInteger(
			options.requestTimeoutMs,
			'request timeout',
			MAX_CONFIGURED_TIMEOUT_MS,
		);
	}
	if (options.maxPendingRequests !== undefined) {
		boundedPositiveInteger(
			options.maxPendingRequests,
			'pending request limit',
			MAX_CONFIGURED_PENDING_REQUESTS,
		);
	}
	if (options.maxOutboundBytes !== undefined) {
		boundedPositiveInteger(
			options.maxOutboundBytes,
			'outbound byte limit',
			MAX_CONFIGURED_OUTBOUND_BYTES,
		);
	}
	if (options.backpressureTimeoutMs !== undefined) {
		boundedPositiveInteger(
			options.backpressureTimeoutMs,
			'backpressure timeout',
			MAX_CONFIGURED_TIMEOUT_MS,
		);
	}
}

function validateServerOptions(options: LocalIpcServerOptions): void {
	validateSessionOptions(options);
	const values: ReadonlyArray<readonly [number | undefined, string, number]> = [
		[options.handshakeTimeoutMs, 'handshake timeout', MAX_CONFIGURED_TIMEOUT_MS],
		[options.maxPreAuthConnections, 'pre-authentication connection limit', 256],
		[options.preAuthRateCount, 'pre-authentication rate limit', 1_024],
		[options.preAuthRateWindowMs, 'pre-authentication rate window', 60_000],
		[options.maxPreAuthFrames, 'pre-authentication frame limit', 16],
		[options.replayCacheSize, 'replay cache size', 65_536],
		[options.replayTtlMs, 'replay cache lifetime', 24 * 60 * 60_000],
	];
	for (const [value, name, maximum] of values) {
		if (value !== undefined) {
			boundedPositiveInteger(value, name, maximum);
		}
	}
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
		throw new Error(`Invalid local IPC ${name}.`);
	}
	return value;
}
