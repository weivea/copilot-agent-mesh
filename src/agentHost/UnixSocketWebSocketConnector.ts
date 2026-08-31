import { connect as connectSocket } from 'node:net';

import WebSocket from 'ws';

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
	public constructor(
		readonly code: UnixSocketWebSocketErrorCode,
		message: string,
		readonly statusCode?: number,
	) {
		super(message);
		this.name = 'UnixSocketWebSocketError';
	}
}

export interface UnixSocketWebSocketConnectorOptions {
	readonly timeoutMs?: number;
}

export class UnixSocketWebSocketConnector {
	private readonly timeoutMs: number;

	public constructor(options: UnixSocketWebSocketConnectorOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
		if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
			throw new RangeError('Unix socket WebSocket timeout must be a positive safe integer.');
		}
	}

	public connect(
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
			const handleRawError = (): void => settleFailure(rawConnected
				? new UnixSocketWebSocketError(
					'EARLY_CLOSE',
					'The editor Agent Host socket closed before the WebSocket upgrade completed.',
				)
				: new UnixSocketWebSocketError(
					'CONNECT_FAILED',
					'The editor Agent Host socket connection failed.',
				));
			const handleRawClose = (): void => settleFailure(new UnixSocketWebSocketError(
				'EARLY_CLOSE',
				'The editor Agent Host socket closed before the WebSocket upgrade completed.',
			));
			const handleUnexpectedResponse = (
				_request: import('node:http').ClientRequest,
				response: import('node:http').IncomingMessage,
			): void => settleFailure(unexpectedResponse(response.statusCode));
			const handleWebSocketError = (): void => settleFailure(new UnixSocketWebSocketError(
				'UPGRADE_FAILED',
				'The editor Agent Host WebSocket upgrade failed.',
			));
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
