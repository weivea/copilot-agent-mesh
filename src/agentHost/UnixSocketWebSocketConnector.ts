import { createHash } from 'node:crypto';
import { connect as connectSocket } from 'node:net';

import WebSocket from 'ws';

import {
	EditorSocketProxy,
	EditorSocketProxyError,
} from './EditorSocketProxy';

const defaultTimeoutMs = 10_000;
const maximumTokenBytes = 4_096;
const maximumPayloadBytes = 16 * 1024 * 1024;

export type UnixSocketWebSocketErrorCode =
	| 'CANCELLED'
	| 'CONNECT_FAILED'
	| 'EARLY_CLOSE'
	| 'INVALID_RESPONSE'
	| 'TOKEN_INVALID'
	| 'UPGRADE_AUTH_REJECTED'
	| 'UPGRADE_BUSY'
	| 'UPGRADE_FAILED'
	| 'UPGRADE_TIMEOUT';

export class UnixSocketWebSocketError extends Error {
	readonly endpointFingerprint?: string;

	public constructor(
		readonly code: UnixSocketWebSocketErrorCode,
		message: string,
		readonly statusCode?: number,
		readonly socketCode?: 'EACCES' | 'ECONNREFUSED' | 'ENOENT',
		readonly proxyStage?: 'target' | 'local',
	) {
		super(message);
		this.name = 'UnixSocketWebSocketError';
	}
}

export interface UnixSocketWebSocketConnectorOptions {
	readonly timeoutMs?: number;
	readonly proxyRoot?: string;
	readonly proxyNodeExecutable?: string;
	readonly connectionMode?: 'directThenProxy' | 'directOnly' | 'proxyOnly';
}

export class UnixSocketWebSocketConnector {
	private readonly timeoutMs: number;
	private readonly proxyRoot: string | undefined;
	private readonly proxyNodeExecutable: string | undefined;
	private readonly connectionMode: 'directThenProxy' | 'directOnly' | 'proxyOnly';

	public constructor(options: UnixSocketWebSocketConnectorOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
		this.proxyRoot = options.proxyRoot;
		this.proxyNodeExecutable = options.proxyNodeExecutable;
		this.connectionMode = options.connectionMode ?? 'directThenProxy';
		if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
			throw new RangeError('Unix socket WebSocket timeout must be a positive safe integer.');
		}
	}

	public async connect(
		socketPath: string,
		connectionToken: string,
		signal?: AbortSignal,
	): Promise<WebSocket> {
		if (signal?.aborted === true) {
			return Promise.reject(cancelled());
		}
		if (
			Buffer.byteLength(connectionToken, 'utf8') < 1
			|| Buffer.byteLength(connectionToken, 'utf8') > maximumTokenBytes
			|| /[\u0000-\u001f\u007f]/u.test(connectionToken)
		) {
			return Promise.reject(new UnixSocketWebSocketError(
				'TOKEN_INVALID',
				'The editor Agent Host connection token is invalid.',
			));
		}
		const endpointFingerprint = editorEndpointFingerprint(socketPath, connectionToken);
		if (this.connectionMode === 'proxyOnly') {
			return this.connectThroughProxy(
				socketPath,
				connectionToken,
				endpointFingerprint,
				signal,
			);
		}
		try {
			return await this.connectAtPath(
				socketPath,
				connectionToken,
				endpointFingerprint,
				signal,
			);
		} catch (error) {
			if (
				this.connectionMode === 'directOnly'
				|| !(error instanceof UnixSocketWebSocketError)
				|| error.code !== 'CONNECT_FAILED'
				|| error.socketCode !== 'ECONNREFUSED'
			) {
				throw error;
			}
			return this.connectThroughProxy(
				socketPath,
				connectionToken,
				endpointFingerprint,
				signal,
			);
		}
	}

	private connectAtPath(
		socketPath: string,
		connectionToken: string,
		endpointFingerprint: string,
		signal?: AbortSignal,
	): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const rawSocket = connectSocket({ path: socketPath });
			let webSocket: WebSocket | undefined;
			let settled = false;
			let upgradeValidated = false;
			let rawConnected = false;
			const startedAt = Date.now();
			const timer = setTimeout(() => {
				settleFailure(new UnixSocketWebSocketError(
					'UPGRADE_TIMEOUT',
					'The editor Agent Host connection timed out.',
				));
			}, this.timeoutMs);

			const cleanup = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', handleAbort);
				rawSocket.removeListener('error', handleRawError);
				rawSocket.removeListener('close', handleRawClose);
				rawSocket.removeListener('connect', handleRawConnect);
				if (webSocket !== undefined) {
					webSocket.removeListener('open', handleOpen);
					webSocket.removeListener('error', handleWebSocketError);
					webSocket.removeListener('close', handleWebSocketClose);
					webSocket.removeListener('unexpected-response', handleUnexpectedResponse);
					webSocket.removeListener('upgrade', handleUpgrade);
				}
			};
			const scrubInspectableState = (): void => {
				if (webSocket !== undefined) {
					Object.defineProperty(webSocket, '_url', {
						configurable: true,
						value: 'ws://localhost/',
						writable: true,
					});
				}
			};
			const settleFailure = (error: UnixSocketWebSocketError): void => {
				if (settled) {
					return;
				}
				settled = true;
				Object.defineProperty(error, 'endpointFingerprint', {
					configurable: false,
					enumerable: true,
					value: endpointFingerprint,
					writable: false,
				});
				cleanup();
				scrubInspectableState();
				if (webSocket !== undefined) {
					webSocket.once('error', () => undefined);
					webSocket.terminate();
				} else {
					rawSocket.destroy();
				}
				reject(error);
			};
			const handleAbort = (): void => settleFailure(cancelled());
			const handleRawError = (error: NodeJS.ErrnoException): void => settleFailure(rawConnected
				? new UnixSocketWebSocketError(
					'EARLY_CLOSE',
					'The editor Agent Host socket closed before the WebSocket upgrade completed.',
				)
				: new UnixSocketWebSocketError(
					'CONNECT_FAILED',
					'The editor Agent Host socket connection failed.',
					undefined,
					socketErrorCode(error.code),
				));
			const handleRawClose = (): void => settleFailure(new UnixSocketWebSocketError(
				'EARLY_CLOSE',
				'The editor Agent Host socket closed before the WebSocket upgrade completed.',
			));
			const handleUnexpectedResponse = (
				_request: import('node:http').ClientRequest,
				response: import('node:http').IncomingMessage,
			): void => settleFailure(unexpectedResponse(response.statusCode));
			const handleWebSocketError = (error: Error & { code?: unknown }): void =>
				settleFailure(webSocketFailure(error));
			const handleWebSocketClose = (): void => settleFailure(new UnixSocketWebSocketError(
				'EARLY_CLOSE',
				'The editor Agent Host WebSocket closed before opening.',
			));
			const handleUpgrade = (response: import('node:http').IncomingMessage): void => {
				if (!validateUpgradeResponse(response)) {
					settleFailure(new UnixSocketWebSocketError(
						'INVALID_RESPONSE',
						'The editor Agent Host returned an invalid WebSocket upgrade response.',
					));
					return;
				}
				upgradeValidated = true;
			};
			const handleOpen = (): void => {
				if (!upgradeValidated || webSocket === undefined) {
					settleFailure(new UnixSocketWebSocketError(
						'INVALID_RESPONSE',
						'The editor Agent Host WebSocket opened without a validated upgrade response.',
					));
					return;
				}
				settled = true;
				cleanup();
				scrubInspectableState();
				resolve(webSocket);
			};
			const handleRawConnect = (): void => {
				rawConnected = true;
				const remainingMs = Math.max(1, this.timeoutMs - (Date.now() - startedAt));
				const target = `ws://localhost/?tkn=${encodeURIComponent(connectionToken)}`;
				try {
					webSocket = new WebSocket(target, {
						createConnection: () => rawSocket,
						followRedirects: false,
						handshakeTimeout: remainingMs,
						maxPayload: maximumPayloadBytes,
						perMessageDeflate: false,
					});
				} catch {
					settleFailure(new UnixSocketWebSocketError(
						'UPGRADE_FAILED',
						'The editor Agent Host WebSocket upgrade could not be started.',
					));
					return;
				}
				webSocket.once('open', handleOpen);
				webSocket.once('error', handleWebSocketError);
				webSocket.once('close', handleWebSocketClose);
				webSocket.once('unexpected-response', handleUnexpectedResponse);
				webSocket.once('upgrade', handleUpgrade);
			};

			rawSocket.once('connect', handleRawConnect);
			rawSocket.once('error', handleRawError);
			rawSocket.once('close', handleRawClose);
			signal?.addEventListener('abort', handleAbort, { once: true });
		});
	}

	private async connectThroughProxy(
		targetPath: string,
		connectionToken: string,
		endpointFingerprint: string,
		signal?: AbortSignal,
	): Promise<WebSocket> {
		if (this.proxyRoot === undefined) {
			throw fingerprintError(
				connectionFailed(),
				endpointFingerprint,
			);
		}
		let proxy: EditorSocketProxy;
		try {
			proxy = await EditorSocketProxy.open({
				targetPath,
				ownershipMarker: this.proxyRoot,
				...(this.proxyNodeExecutable === undefined
					? {}
					: { nodeExecutable: this.proxyNodeExecutable }),
				timeoutMs: this.timeoutMs,
				signal,
			});
		} catch (error) {
			throw error instanceof EditorSocketProxyError
				? fingerprintError(new UnixSocketWebSocketError(
					error.code,
					error.message,
					undefined,
					error.socketCode,
					'target',
				), endpointFingerprint)
				: fingerprintError(connectionFailed(), endpointFingerprint);
		}
		try {
			const webSocket = await this.connectAtProxy(
				proxy,
				connectionToken,
				endpointFingerprint,
				signal,
			);
			proxy.bind(webSocket);
			return webSocket;
		} catch (error) {
			await proxy.dispose();
			if (error instanceof UnixSocketWebSocketError) {
				Object.defineProperty(error, 'proxyStage', {
					configurable: false,
					enumerable: true,
					value: 'local',
					writable: false,
				});
			}
			throw error;
		}
	}

	private connectAtProxy(
		proxy: EditorSocketProxy,
		connectionToken: string,
		endpointFingerprint: string,
		signal?: AbortSignal,
	): Promise<WebSocket> {
		if (signal?.aborted === true) {
			return Promise.reject(fingerprintError(cancelled(), endpointFingerprint));
		}
		return new Promise((resolve, reject) => {
			let settled = false;
			let upgradeValidated = false;
			let webSocket: WebSocket | undefined;
			const timer = setTimeout(() => {
				settleFailure(new UnixSocketWebSocketError(
					'UPGRADE_TIMEOUT',
					'The editor Agent Host proxy WebSocket timed out.',
				));
			}, this.timeoutMs);
			const cleanup = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', handleAbort);
				if (webSocket !== undefined) {
					webSocket.removeListener('open', handleOpen);
					webSocket.removeListener('error', handleError);
					webSocket.removeListener('close', handleClose);
					webSocket.removeListener('unexpected-response', handleUnexpectedResponse);
					webSocket.removeListener('upgrade', handleUpgrade);
				}
			};
			const scrub = (): void => {
				if (webSocket !== undefined) {
					Object.defineProperty(webSocket, '_url', {
						configurable: true,
						value: 'ws://localhost/',
						writable: true,
					});
				}
			};
			const settleFailure = (error: UnixSocketWebSocketError): void => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				scrub();
				webSocket?.once('error', () => undefined);
				webSocket?.terminate();
				reject(fingerprintError(error, endpointFingerprint));
			};
			const handleAbort = (): void => settleFailure(cancelled());
			const handleError = (error: Error & { code?: unknown }): void =>
				settleFailure(webSocketFailure(error));
			const handleClose = (): void => settleFailure(new UnixSocketWebSocketError(
				'EARLY_CLOSE',
				'The editor Agent Host proxy WebSocket closed before opening.',
			));
			const handleUnexpectedResponse = (
				_request: import('node:http').ClientRequest,
				response: import('node:http').IncomingMessage,
			): void => settleFailure(unexpectedResponse(response.statusCode));
			const handleUpgrade = (response: import('node:http').IncomingMessage): void => {
				if (!validateUpgradeResponse(response)) {
					settleFailure(new UnixSocketWebSocketError(
						'INVALID_RESPONSE',
						'The editor Agent Host proxy returned an invalid WebSocket response.',
					));
					return;
				}
				upgradeValidated = true;
			};
			const handleOpen = (): void => {
				if (!upgradeValidated || webSocket === undefined) {
					settleFailure(new UnixSocketWebSocketError(
						'INVALID_RESPONSE',
						'The editor Agent Host proxy opened without a validated response.',
					));
					return;
				}
				settled = true;
				cleanup();
				scrub();
				resolve(webSocket);
			};
			try {
				webSocket = new WebSocket(
					`ws://127.0.0.1:${proxy.port}/?tkn=${encodeURIComponent(connectionToken)}`,
					{
						headers: {
							'X-Mesh-Editor-Proxy': proxy.authenticationToken,
						},
						followRedirects: false,
						handshakeTimeout: this.timeoutMs,
						maxPayload: maximumPayloadBytes,
						perMessageDeflate: false,
					},
				);
			} catch {
				settleFailure(new UnixSocketWebSocketError(
					'UPGRADE_FAILED',
					'The editor Agent Host proxy WebSocket could not be started.',
				));
				return;
			}
			webSocket.once('open', handleOpen);
			webSocket.once('error', handleError);
			webSocket.once('close', handleClose);
			webSocket.once('unexpected-response', handleUnexpectedResponse);
			webSocket.once('upgrade', handleUpgrade);
			signal?.addEventListener('abort', handleAbort, { once: true });
		});
	}
}

export function editorEndpointFingerprint(socketPath: string, connectionToken: string): string {
	return createHash('sha256')
		.update('copilot-agent-mesh/editor-endpoint/v1\0', 'utf8')
		.update(socketPath, 'utf8')
		.update('\0', 'utf8')
		.update(connectionToken, 'utf8')
		.digest('hex')
		.slice(0, 16);
}

function validateUpgradeResponse(response: import('node:http').IncomingMessage): boolean {
	if (response.statusCode !== 101) {
		return false;
	}
	if (!headerHasToken(response.headers.upgrade, 'websocket')) {
		return false;
	}
	if (!headerHasToken(response.headers.connection, 'upgrade')) {
		return false;
	}
	if (response.headers['sec-websocket-protocol'] !== undefined || response.headers['sec-websocket-extensions'] !== undefined) {
		return false;
	}
	const accepted = response.headers['sec-websocket-accept'];
	// ws verifies the exact Sec-WebSocket-Accept digest before emitting upgrade.
	return typeof accepted === 'string' && /^[A-Za-z0-9+/]{27}=$/u.test(accepted);
}

function headerHasToken(value: string | string[] | undefined, expected: string): boolean {
	const values = Array.isArray(value) ? value : [value ?? ''];
	return values.some((entry) =>
		entry.split(',').some((token) => token.trim().toLowerCase() === expected));
}

function cancelled(): UnixSocketWebSocketError {
	return new UnixSocketWebSocketError(
		'CANCELLED',
		'The editor Agent Host connection was cancelled.',
	);
}

function unexpectedResponse(statusCode: number | undefined): UnixSocketWebSocketError {
	if (statusCode === 401 || statusCode === 403) {
		return new UnixSocketWebSocketError(
			'UPGRADE_AUTH_REJECTED',
			'The editor Agent Host rejected WebSocket authentication.',
			statusCode,
		);
	}
	if ([409, 423, 429, 503].includes(statusCode ?? 0)) {
		return new UnixSocketWebSocketError(
			'UPGRADE_BUSY',
			'The editor Agent Host is not ready for another WebSocket client.',
			statusCode,
		);
	}
	return new UnixSocketWebSocketError(
		'UPGRADE_FAILED',
		'The editor Agent Host rejected the WebSocket upgrade.',
		statusCode,
	);
}

function webSocketFailure(error: Error & { code?: unknown }): UnixSocketWebSocketError {
	const unexpected = /^Unexpected server response: (\d{3})$/u.exec(error.message);
	if (unexpected !== null) {
		return unexpectedResponse(Number(unexpected[1]));
	}
	const socketCode = socketErrorCode(error.code);
	if (socketCode !== undefined) {
		return new UnixSocketWebSocketError(
			'CONNECT_FAILED',
			'The editor Agent Host socket connection failed.',
			undefined,
			socketCode,
		);
	}
	if (error.code === 'ETIMEDOUT') {
		return new UnixSocketWebSocketError(
			'UPGRADE_TIMEOUT',
			'The editor Agent Host connection timed out.',
		);
	}
	if (/Sec-WebSocket-Accept|upgrade header|connection header/iu.test(error.message)) {
		return new UnixSocketWebSocketError(
			'INVALID_RESPONSE',
			'The editor Agent Host returned an invalid WebSocket upgrade response.',
		);
	}
	if (
		error.code === 'ECONNRESET'
		|| error.code === 'EPIPE'
		|| /socket hang up|closed before/iu.test(error.message)
	) {
		return new UnixSocketWebSocketError(
			'EARLY_CLOSE',
			'The editor Agent Host connection closed during the WebSocket upgrade.',
		);
	}
	return new UnixSocketWebSocketError(
		'UPGRADE_FAILED',
		'The editor Agent Host WebSocket upgrade failed.',
	);
}

function socketErrorCode(
	code: unknown,
): 'EACCES' | 'ECONNREFUSED' | 'ENOENT' | undefined {
	return ['EACCES', 'ECONNREFUSED', 'ENOENT'].includes(String(code))
		? code as 'EACCES' | 'ECONNREFUSED' | 'ENOENT'
		: undefined;
}

function fingerprintError(
	error: UnixSocketWebSocketError,
	endpointFingerprint: string,
): UnixSocketWebSocketError {
	Object.defineProperty(error, 'endpointFingerprint', {
		configurable: false,
		enumerable: true,
		value: endpointFingerprint,
		writable: false,
	});
	return error;
}

function connectionFailed(): UnixSocketWebSocketError {
	return new UnixSocketWebSocketError(
		'CONNECT_FAILED',
		'The editor Agent Host socket proxy is unavailable.',
	);
}
