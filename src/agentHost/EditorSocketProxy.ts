import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type WebSocket from 'ws';

const helperSource = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const root = path.resolve(process.argv.at(-2));
let client;
let proxyPath;
let server;
let stopping = false;
let target;
process.umask(0o077);
function stop(code) {
	if (stopping) return;
	stopping = true;
	client?.destroy();
	target?.destroy();
	server?.close();
	if (proxyPath) {
		try { fs.rmSync(proxyPath, { force: true }); } catch {}
	}
	setTimeout(() => process.exit(code), 0);
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
		|| !path.isAbsolute(message.targetPath)
		|| typeof message.proxyPath !== 'string'
		|| path.dirname(path.resolve(message.proxyPath)) !== root
	) {
		stop(2);
		return;
	}
	proxyPath = path.resolve(message.proxyPath);
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
				incoming.destroy();
				return;
			}
			client = incoming;
			server.close();
			client.pipe(target);
			target.pipe(client);
			client.once('close', () => stop(0));
			target.once('close', () => client?.destroy());
		});
		server.once('error', () => stop(2));
		try { fs.rmSync(proxyPath, { force: true }); } catch {}
		server.listen(proxyPath, () => {
			process.send?.({ schemaVersion: 1, ready: true });
		});
	});
});
`;

export interface EditorSocketProxyOptions {
	readonly targetPath: string;
	readonly root: string;
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
	private disposed = false;

	private constructor(
		readonly socketPath: string,
		private readonly root: string,
		private readonly child: ChildProcess,
	) {}

	public static async open(options: EditorSocketProxyOptions): Promise<EditorSocketProxy> {
		if (!isAbsolute(options.targetPath) || !isAbsolute(options.root)) {
			throw new TypeError('Editor socket proxy paths must be absolute.');
		}
		if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
			throw new RangeError('Editor socket proxy timeout must be positive.');
		}
		if (options.signal?.aborted === true) {
			throw cancelled();
		}
		const connectionRoot = await mkdtemp(
			process.platform === 'darwin'
				? '/tmp/cam-ep-'
				: join(tmpdir(), 'cam-ep-'),
		);
		await chmod(connectionRoot, 0o700);
		const socketPath = join(connectionRoot, 'proxy.sock');
		const child = spawn(
			process.execPath,
			['-e', helperSource, '--', connectionRoot, options.root],
			{
				env: helperEnvironment(),
				shell: false,
				stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			},
		);
		try {
			await waitUntilReady(child, {
				targetPath: options.targetPath,
				proxyPath: socketPath,
				timeoutMs: options.timeoutMs,
				signal: options.signal,
			});
			return new EditorSocketProxy(socketPath, connectionRoot, child);
		} catch (error) {
			await stopChild(child);
			await rm(connectionRoot, { recursive: true, force: true });
			throw error;
		}
	}

	public bind(webSocket: WebSocket): void {
		webSocket.once('close', () => {
			void this.dispose();
		});
		this.child.once('exit', () => {
			void rm(this.root, { recursive: true, force: true });
			if (webSocket.readyState === webSocket.OPEN) {
				webSocket.terminate();
			}
		});
	}

	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		await stopChild(this.child);
		await rm(this.root, { recursive: true, force: true });
	}
}

async function waitUntilReady(
	child: ChildProcess,
	options: {
		readonly targetPath: string;
		readonly proxyPath: string;
		readonly timeoutMs: number;
		readonly signal?: AbortSignal;
	},
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
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
			const response = value as { ready?: unknown; code?: unknown };
			if (response.ready === true) {
				finish(resolve);
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
			proxyPath: options.proxyPath,
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
