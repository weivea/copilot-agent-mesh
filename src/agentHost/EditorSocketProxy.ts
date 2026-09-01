import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';

import type WebSocket from 'ws';

const helperSource = String.raw`
const crypto = require('node:crypto');
const net = require('node:net');
let client;
const pendingClients = new Set();
let server;
let stopping = false;
let target;
process.umask(0o077);
function stop(code) {
	if (stopping) return;
	stopping = true;
	for (const pending of pendingClients) pending.destroy();
	pendingClients.clear();
	client?.destroy();
	target?.destroy();
	server?.close();
	setTimeout(() => process.exit(code), 0);
}
function equal(left, right) {
	const a = Buffer.from(left, 'utf8');
	const b = Buffer.from(right, 'utf8');
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}
process.once('disconnect', () => stop(0));
process.once('SIGTERM', () => stop(0));
process.on('message', (message) => {
	if (message?.shutdown === true) {
		stop(0);
		return;
	}
	if (
		message?.schemaVersion !== 1
		|| typeof message.targetPath !== 'string'
		|| !require('node:path').isAbsolute(message.targetPath)
		|| typeof message.authenticationToken !== 'string'
		|| !/^[A-Za-z0-9_-]{43}$/.test(message.authenticationToken)
	) {
		stop(2);
		return;
	}
	target = net.connect({ path: message.targetPath });
	target.once('error', (error) => {
		const code = ['EACCES', 'ECONNREFUSED', 'ENOENT'].includes(error?.code)
			? error.code
			: 'UNKNOWN';
		process.send?.({ schemaVersion: 1, ready: false, code }, () => stop(1));
	});
	target.once('connect', () => {
		server = net.createServer((incoming) => {
			if (client) {
				incoming.once('error', () => undefined);
				incoming.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
				return;
			}
			pendingClients.add(incoming);
			let buffered = Buffer.alloc(0);
			let finished = false;
			incoming.setTimeout(2000, () => incoming.destroy());
			const rejectRequest = (status) => {
				if (finished) return;
				finished = true;
				incoming.removeListener('data', authenticate);
				pendingClients.delete(incoming);
				incoming.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
			};
			const authenticate = (chunk) => {
				buffered = Buffer.concat([buffered, chunk]);
				if (buffered.byteLength > 16 * 1024) {
					rejectRequest('431 Request Header Fields Too Large');
					return;
				}
				const end = buffered.indexOf('\r\n\r\n');
				if (end < 0) return;
				const lines = buffered.subarray(0, end).toString('latin1').split('\r\n');
				const headers = lines.filter((line) => /^x-mesh-editor-proxy:/i.test(line));
				const supplied = headers.length === 1 ? headers[0].slice(headers[0].indexOf(':') + 1).trim() : '';
				if (!equal(supplied, message.authenticationToken)) {
					rejectRequest('403 Forbidden');
					return;
				}
				if (client) {
					rejectRequest('409 Conflict');
					return;
				}
				finished = true;
				incoming.removeListener('data', authenticate);
				pendingClients.delete(incoming);
				client = incoming;
				incoming.setTimeout(0);
				server.close();
				for (const pending of pendingClients) pending.destroy();
				pendingClients.clear();
				const forwarded = lines
					.filter((line) => !/^x-mesh-editor-proxy:/i.test(line))
					.join('\r\n') + '\r\n\r\n';
				target.write(forwarded, 'latin1');
				target.write(buffered.subarray(end + 4));
				incoming.pipe(target);
				target.pipe(incoming);
				incoming.once('close', () => stop(0));
			};
			incoming.on('data', authenticate);
			incoming.once('error', () => {
				incoming.removeListener('data', authenticate);
				pendingClients.delete(incoming);
				if (incoming === client) stop(1);
			});
			incoming.once('close', () => {
				pendingClients.delete(incoming);
			});
		});
		target.once('close', () => stop(0));
		server.once('error', () => stop(2));
		server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				stop(2);
				return;
			}
			process.send?.({ schemaVersion: 1, ready: true, port: address.port });
		});
	});
});
`;

export interface EditorSocketProxyOptions {
	readonly targetPath: string;
	readonly ownershipMarker: string;
	readonly nodeExecutable?: string;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

export class EditorSocketProxyError extends Error {
	public constructor(
		readonly code: 'CANCELLED' | 'CONNECT_FAILED',
		message: string,
		readonly socketCode?: 'EACCES' | 'ECONNREFUSED' | 'ENOENT',
	) {
		super(message);
		this.name = 'EditorSocketProxyError';
	}
}

export class EditorSocketProxy {
	private disposal: Promise<void> | undefined;

	private constructor(
		readonly port: number,
		readonly authenticationToken: string,
		private readonly child: ChildProcess,
	) {
		Object.defineProperty(this, 'authenticationToken', {
			configurable: false,
			enumerable: false,
			value: authenticationToken,
			writable: false,
		});
	}

	toJSON(): Readonly<{ kind: 'editorSocketProxy'; port: number }> {
		return {
			kind: 'editorSocketProxy',
			port: this.port,
		};
	}

	public static async open(options: EditorSocketProxyOptions): Promise<EditorSocketProxy> {
		if (
			!isAbsolute(options.targetPath)
			|| !isAbsolute(options.ownershipMarker)
			|| (options.nodeExecutable !== undefined && !isAbsolute(options.nodeExecutable))
		) {
			throw new TypeError('Editor socket proxy paths must be absolute.');
		}
		if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
			throw new RangeError('Editor socket proxy timeout must be positive.');
		}
		if (options.signal?.aborted === true) {
			throw cancelled();
		}
		const authenticationToken = randomBytes(32).toString('base64url');
		const child = spawn(
			options.nodeExecutable ?? process.execPath,
			['-e', helperSource, '--', options.ownershipMarker],
			{
				env: helperEnvironment(),
				shell: false,
				stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			},
		);
		child.on('error', () => undefined);
		try {
			const port = await waitUntilReady(child, {
				targetPath: options.targetPath,
				authenticationToken,
				timeoutMs: options.timeoutMs,
				signal: options.signal,
			});
			return new EditorSocketProxy(port, authenticationToken, child);
		} catch (error) {
			await stopChild(child);
			throw error;
		}
	}

	public bind(webSocket: WebSocket): void {
		webSocket.once('close', () => {
			void this.dispose();
		});
		this.child.once('exit', () => {
			if (webSocket.readyState === webSocket.OPEN) {
				webSocket.terminate();
			}
		});
	}

	public async dispose(): Promise<void> {
		this.disposal ??= stopChild(this.child);
		await this.disposal;
	}
}

async function waitUntilReady(
	child: ChildProcess,
	options: {
		readonly targetPath: string;
		readonly authenticationToken: string;
		readonly timeoutMs: number;
		readonly signal?: AbortSignal;
	},
): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		let settled = false;
		const finish = (operation: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', abort);
			child.removeListener('error', failed);
			child.removeListener('exit', exited);
			child.removeListener('message', message);
			operation();
		};
		const abort = () => finish(() => reject(cancelled()));
		const failed = () => finish(() => reject(connectionFailed()));
		const exited = () => finish(() => reject(connectionFailed()));
		const message = (value: unknown) => {
			if (
				typeof value !== 'object'
				|| value === null
				|| Array.isArray(value)
				|| (value as { schemaVersion?: unknown }).schemaVersion !== 1
			) {
				finish(() => reject(connectionFailed()));
				return;
			}
			const response = value as { ready?: unknown; code?: unknown; port?: unknown };
			if (
				response.ready === true
				&& Number.isSafeInteger(response.port)
				&& Number(response.port) >= 1
				&& Number(response.port) <= 65_535
			) {
				finish(() => resolve(Number(response.port)));
				return;
			}
			const socketCode = ['EACCES', 'ECONNREFUSED', 'ENOENT'].includes(String(response.code))
				? response.code as 'EACCES' | 'ECONNREFUSED' | 'ENOENT'
				: undefined;
			finish(() => reject(new EditorSocketProxyError(
				'CONNECT_FAILED',
				'The editor Agent Host socket proxy could not connect.',
				socketCode,
			)));
		};
		const timer = setTimeout(failed, options.timeoutMs);
		child.once('error', failed);
		child.once('exit', exited);
		child.on('message', message);
		options.signal?.addEventListener('abort', abort, { once: true });
		child.send({
			schemaVersion: 1,
			targetPath: options.targetPath,
			authenticationToken: options.authenticationToken,
		}, (error) => {
			if (error !== null && error !== undefined) {
				failed();
			}
		});
	});
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	if (child.connected) {
		child.send({ shutdown: true }, () => undefined);
	}
	if (await waitForExit(child, 500)) {
		return;
	}
	child.kill('SIGTERM');
	if (await waitForExit(child, 1_000)) {
		return;
	}
	child.kill('SIGKILL');
	await waitForExit(child, 1_000);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.removeListener('exit', exited);
			resolve(false);
		}, timeoutMs);
		const exited = () => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once('exit', exited);
	});
}

function helperEnvironment(): NodeJS.ProcessEnv {
	return {
		ELECTRON_RUN_AS_NODE: '1',
		...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
		...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
		...(process.env.TEMP === undefined ? {} : { TEMP: process.env.TEMP }),
		...(process.env.TMP === undefined ? {} : { TMP: process.env.TMP }),
	};
}

function cancelled(): EditorSocketProxyError {
	return new EditorSocketProxyError(
		'CANCELLED',
		'The editor Agent Host socket proxy was cancelled.',
	);
}

function connectionFailed(): EditorSocketProxyError {
	return new EditorSocketProxyError(
		'CONNECT_FAILED',
		'The editor Agent Host socket proxy could not start.',
	);
}
