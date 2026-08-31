import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
	createServer as createNetServer,
	type Server as NetServer,
	type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocketServer } from 'ws';

import {
	AgentHostSourceSelector,
} from '../agentHost/AgentHostSourceSelector';
import {
	deriveEditorAgentHostUserDataDir,
	EditorAgentHostLocator,
	EditorAgentHostLocatorError,
	type EditorAgentHostPlatformContext,
} from '../agentHost/EditorAgentHostLocator';
import {
	UnixSocketWebSocketConnector,
	UnixSocketWebSocketError,
} from '../agentHost/UnixSocketWebSocketConnector';
import {
	AgentRuntimeError,
	AgentRuntimeApprovalCapabilityIssuer,
	type AgentRuntime,
	type AgentRuntimeProbe,
	type AgentTaskHandle,
	type AgentTaskRequest,
} from '../agentHost/AgentRuntime';
import { redactText } from '../logging/StructuredLogger';
import { sanitizeError } from '../spikes/agentHostEndpoint';
import { sanitizeDelegationText } from '../tools/DelegationTextSanitizer';
import { redactRemoteText } from '../ui/DashboardRedaction';

const platformBase: Omit<EditorAgentHostPlatformContext, 'platform' | 'productName'> = {
	architecture: 'arm64',
	homeDirectory: '/home/mesh',
	environment: {},
};
const netServerSockets = new WeakMap<NetServer, Set<Socket>>();

test('derives Stable, Insiders, Linux, Windows, and override user-data directories without widening support', () => {
	assert.deepEqual(deriveEditorAgentHostUserDataDir({
		...platformBase,
		platform: 'darwin',
		productName: 'Visual Studio Code',
	}), {
		path: '/home/mesh/Library/Application Support/Code',
		validatedWorkerHost: true,
	});
	assert.equal(deriveEditorAgentHostUserDataDir({
		...platformBase,
		platform: 'darwin',
		productName: 'Visual Studio Code - Insiders',
	}).path, '/home/mesh/Library/Application Support/Code - Insiders');
	assert.deepEqual(deriveEditorAgentHostUserDataDir({
		...platformBase,
		platform: 'linux',
		architecture: 'x64',
		productName: 'Code',
		environment: { XDG_CONFIG_HOME: '/xdg' },
	}), {
		path: '/xdg/Code',
		validatedWorkerHost: false,
	});
	assert.equal(deriveEditorAgentHostUserDataDir({
		...platformBase,
		platform: 'linux',
		architecture: 'x64',
		productName: 'Code - Insiders',
	}).path, '/home/mesh/.config/Code - Insiders');
	assert.deepEqual(deriveEditorAgentHostUserDataDir({
		...platformBase,
		platform: 'win32',
		architecture: 'x64',
		productName: 'Visual Studio Code',
		environment: { APPDATA: 'C:\\Users\\mesh\\AppData\\Roaming' },
	}), {
		path: 'C:\\Users\\mesh\\AppData\\Roaming\\Code',
		validatedWorkerHost: false,
	});
	assert.deepEqual(deriveEditorAgentHostUserDataDir({
		...platformBase,
		platform: 'darwin',
		productName: 'Visual Studio Code',
	}, '/portable/vscode-data'), {
		path: '/portable/vscode-data',
		validatedWorkerHost: true,
	});
});

test('strict locator selects one live compatible editor socket and invokes the bounded command without a shell', async () => {
	const expected = '/safe/user-data';
	const socketPath = '/safe/editor.sock';
	const token = 'sensitive-connection-token';
	const calls: Array<{ executable: string; args: readonly string[] }> = [];
	const locator = createLocator(endpointDocument(expected, [
		editorEndpoint({ socketPath, token }),
	]), {
		runCommand: async (executable, args) => {
			calls.push({ executable, args });
			return args[0] === '--version'
				? '1.135.0\ncommit\narm64\n'
				: endpointDocument(expected, [editorEndpoint({ socketPath, token })]);
		},
	});

	const located = await locator.locate();
	assert.equal(located.version, '1.135.0');
	assert.equal(located.registryProtocolVersion, '1.0.0');
	assert.deepEqual(calls, [
		{ executable: '/safe/code', args: ['--version'] },
		{
			executable: '/safe/code',
			args: ['agent', 'endpoints', '--user-data-dir', expected],
		},
	]);
	assert.doesNotMatch(JSON.stringify(located), /sensitive|editor\.sock/u);
	located.dispose();
});

test('located endpoint values are dynamically redacted in raw, encoded, nested, log, task, and Webview text', async () => {
	const userDataPath = '/safe/dynamic-user-data';
	const socketPath = '/safe/dynamic-editor.sock';
	const token = 'mesh-dynamic-connection-token';
	const instanceId = 'mesh-dynamic-endpoint-instance';
	const executable = '/safe/dynamic-code';
	const locator = new EditorAgentHostLocator({
		configuredCodeCli: executable,
		configuredUserDataDir: userDataPath,
		platform: {
			platform: 'darwin',
			architecture: 'arm64',
			homeDirectory: '/home/mesh',
			environment: {},
			productName: 'Visual Studio Code',
		},
	}, {
		canonicalize: async (path) => path,
		isProcessAlive: () => true,
		runCommand: async (_command, args) => args[0] === '--version'
			? '1.135.0\ncommit\narm64\n'
			: endpointDocument(userDataPath, [{
				...editorEndpoint({ socketPath, token }),
				instanceId,
			}]),
	});
	const located = await locator.locate();
	try {
		const sensitive = [userDataPath, socketPath, token, instanceId, executable];
		const nested = JSON.stringify({
			cause: {
				message: sensitive.map((value) => `${value} ${encodeURIComponent(value)}`).join(' | '),
			},
			errors: sensitive.map((value) => ({ message: value })),
			url: `ws://localhost/?tkn=${token}`,
		});
		for (const value of [
			redactText(nested),
			sanitizeError(new Error(nested)).message,
			sanitizeDelegationText(nested, 8_192),
			redactRemoteText(nested),
		]) {
			for (const secret of sensitive) {
				assert.equal(value.includes(secret), false);
				assert.equal(value.toLowerCase().includes(encodeURIComponent(secret).toLowerCase()), false);
			}
		}
	} finally {
		located.dispose();
	}
});

test('locator fails closed for canonical mismatch, strict schema, no endpoint, multiple, stale, transport, and protocol', async () => {
	const expected = '/safe/user-data';
	const cases: ReadonlyArray<{
		readonly name: string;
		readonly document: string;
		readonly alive?: (pid: number) => boolean;
		readonly canonicalize?: (path: string) => Promise<string>;
		readonly code: EditorAgentHostLocatorError['code'];
	}> = [
		{
			name: 'canonical mismatch',
			document: endpointDocument('/other/user-data', [editorEndpoint()]),
			canonicalize: async (path) => path,
			code: 'USER_DATA_MISMATCH',
		},
		{
			name: 'strict schema',
			document: JSON.stringify({ userDataPath: expected, endpoints: [], extra: true }),
			code: 'INVALID_ENDPOINT_DOCUMENT',
		},
		{
			name: 'none',
			document: endpointDocument(expected, []),
			code: 'NO_EDITOR_ENDPOINT',
		},
		{
			name: 'multiple',
			document: endpointDocument(expected, [
				editorEndpoint({ pid: 101 }),
				editorEndpoint({ pid: 102 }),
			]),
			code: 'MULTIPLE_EDITOR_ENDPOINTS',
		},
		{
			name: 'stale',
			document: endpointDocument(expected, [editorEndpoint()]),
			alive: () => false,
			code: 'STALE_EDITOR_ENDPOINT',
		},
		{
			name: 'transport',
			document: endpointDocument(expected, [editorEndpoint({ transport: 'tcp', socketPath: undefined })]),
			code: 'UNSUPPORTED_TRANSPORT',
		},
		{
			name: 'protocol',
			document: endpointDocument(expected, [editorEndpoint({ protocolVersion: '2.0.0' })]),
			code: 'INCOMPATIBLE_PROTOCOL',
		},
	];

	for (const scenario of cases) {
		const locator = createLocator(scenario.document, {
			isProcessAlive: scenario.alive,
			canonicalize: scenario.canonicalize,
		});
		await assert.rejects(
			locator.locate(),
			(error: unknown) => error instanceof EditorAgentHostLocatorError
				&& error.code === scenario.code
				&& !error.message.includes('/safe')
				&& !error.message.includes('token'),
			scenario.name,
		);
	}
});

test('locator normalizes command failure, timeout, and cancellation without sensitive command details', async () => {
	const locator = createLocator(endpointDocument('/safe/user-data', [editorEndpoint()]), {
		runCommand: async () => {
			throw new Error('/safe/code /safe/user-data token=sensitive');
		},
	});
	await assert.rejects(
		locator.locate(),
		(error: unknown) => error instanceof EditorAgentHostLocatorError
			&& error.code === 'COMMAND_FAILED'
			&& !error.message.includes('/safe')
			&& !error.message.includes('sensitive'),
	);

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		locator.locate(controller.signal),
		(error: unknown) => error instanceof EditorAgentHostLocatorError && error.code === 'CANCELLED',
	);
});

test('Unix socket connector performs authenticated upgrade, scrubs inspectable URL, and isolates concurrent clients', {
	skip: process.platform === 'win32',
}, async () => {
	await withSocketPath(async (socketPath) => {
		const { server, webSockets } = await startWebSocketServer(socketPath, 'connection-token');
		try {
			const connector = new UnixSocketWebSocketConnector({ timeoutMs: 1_000 });
			const [first, second] = await Promise.all([
				connector.connect(socketPath, 'connection-token'),
				connector.connect(socketPath, 'connection-token'),
			]);
			assert.equal(first.readyState, first.OPEN);
			assert.equal(second.readyState, second.OPEN);
			assert.equal(first.url, 'ws://localhost/');
			assert.doesNotMatch(JSON.stringify(first), /connection-token|editor\.sock/u);

			first.close();
			await once(first, 'close');
			assert.equal(second.readyState, second.OPEN);
			second.close();
			second.close();
			await once(second, 'close');
			assert.equal(webSockets.clients.size, 0);
		} finally {
			await closeWebSocketServer(server, webSockets);
		}
	});
});

test('Unix socket connector rejects token/status/header failures, timeout, cancellation, and early close safely', {
	skip: process.platform === 'win32',
}, async () => {
	await withSocketPath(async (socketPath) => {
		const { server, webSockets } = await startWebSocketServer(socketPath, 'expected-token');
		try {
			await assertConnectorFailure(
				new UnixSocketWebSocketConnector({ timeoutMs: 500 }).connect(socketPath, 'wrong-token'),
				'UPGRADE_FAILED',
				socketPath,
				'wrong-token',
			);
		} finally {
			await closeWebSocketServer(server, webSockets);
		}
	});

	await withSocketPath(async (socketPath) => {
		const server = createTrackedNetServer((socket) => {
			socket.once('data', () => {
				socket.end([
					'HTTP/1.1 101 Switching Protocols',
					'Connection: Upgrade',
					'Upgrade: websocket',
					'Sec-WebSocket-Accept: invalid',
					'',
					'',
				].join('\r\n'));
			});
		});
		await listen(server, socketPath);
		try {
			await assertConnectorFailure(
				new UnixSocketWebSocketConnector({ timeoutMs: 500 }).connect(socketPath, 'token'),
				'INVALID_RESPONSE',
				socketPath,
				'token',
			);
		} finally {
			await closeNetServer(server);
		}
	});

	await withSocketPath(async (socketPath) => {
		const server = createTrackedNetServer(() => undefined);
		await listen(server, socketPath);
		try {
			await assertConnectorFailure(
				new UnixSocketWebSocketConnector({ timeoutMs: 25 }).connect(socketPath, 'token'),
				'UPGRADE_TIMEOUT',
				socketPath,
				'token',
			);
		} finally {
			await closeNetServer(server);
		}
	});

	await withSocketPath(async (socketPath) => {
		const server = createTrackedNetServer((socket) => socket.destroy());
		await listen(server, socketPath);
		try {
			await assertConnectorFailure(
				new UnixSocketWebSocketConnector({ timeoutMs: 500 }).connect(socketPath, 'token'),
				'EARLY_CLOSE',
				socketPath,
				'token',
			);
		} finally {
			await closeNetServer(server);
		}
	});

	await withSocketPath(async (socketPath) => {
		const server = createTrackedNetServer(() => undefined);
		await listen(server, socketPath);
		const controller = new AbortController();
		const connection = new UnixSocketWebSocketConnector({ timeoutMs: 500 })
			.connect(socketPath, 'token', controller.signal);
		controller.abort();
		try {
			await assertConnectorFailure(connection, 'CANCELLED', socketPath, 'token');
		} finally {
			await closeNetServer(server);
		}
	});
});

test('source selector uses editor first, falls back exactly once, publishes safe status, and preserves default-off standalone behavior', async () => {
	const editor = new FakeRuntime();
	const standalone = new FakeRuntime();
	let preferEditor = false;
	const selector = new AgentHostSourceSelector(selectorOptions({
		preferEditor: () => preferEditor,
		editor,
		standalone,
	}));
	const changes: unknown[] = [];
	selector.onDidSourceStatusChange((status) => changes.push(status));

	await selector.start(taskRequest());
	assert.equal(editor.starts, 0);
	assert.equal(standalone.starts, 1);
	assert.deepEqual(selector.sourceStatus(), { source: 'standalone', degraded: false });

	preferEditor = true;
	editor.startError = new AgentRuntimeError(
		'AGENT_UNAVAILABLE',
		'/private/editor.sock?tkn=sensitive',
	);
	await selector.start(taskRequest());
	assert.equal(editor.starts, 1);
	assert.equal(standalone.starts, 2);
	assert.deepEqual(selector.sourceStatus(), {
		source: 'standalone',
		degraded: true,
		reason: 'EDITOR_START_FAILED',
		message: 'Editor Agent Host startup failed; standalone mode is in use.',
		failure: {
			code: 'AGENT_UNAVAILABLE',
			stage: 'task',
			message: 'The selected editor Agent Host attempt failed safely.',
		},
	});
	assert.doesNotMatch(JSON.stringify(changes), /private|sensitive|tkn/iu);
	await selector.dispose();
	assert.equal(editor.disposals, 1);
	assert.equal(standalone.disposals, 1);
});

test('source selector reports standalone failure explicitly and does not fallback for auth failures', async () => {
	const editor = new FakeRuntime();
	const standalone = new FakeRuntime();
	const selector = new AgentHostSourceSelector(selectorOptions({
		preferEditor: () => true,
		editor,
		standalone,
	}));
	editor.startError = new AgentRuntimeError('AGENT_UNAVAILABLE', 'editor unavailable');
	standalone.startError = new Error('standalone unavailable');
	await assert.rejects(
		selector.start(taskRequest()),
		(error: unknown) => error instanceof AgentRuntimeError
			&& error.code === 'AGENT_UNAVAILABLE'
			&& error.message === 'The editor Agent Host was unavailable and the standalone fallback failed.',
	);
	assert.equal(editor.starts, 1);
	assert.equal(standalone.starts, 1);

	editor.startError = new AgentRuntimeError('AGENT_AUTH_REQUIRED', 'Authentication required.');
	standalone.startError = undefined;
	await assert.rejects(selector.start(taskRequest()), { code: 'AGENT_AUTH_REQUIRED' });
	assert.equal(standalone.starts, 1);
	assert.deepEqual(selector.sourceStatus(), {
		source: 'editor',
		degraded: false,
		failure: {
			code: 'AGENT_AUTH_REQUIRED',
			stage: 'session',
			message: 'The selected editor Agent Host requires authentication in its editor profile.',
		},
	});
	const probe = await selector.probe();
	assert.equal(probe.source, 'editor');
	assert.equal(probe.available, false);
	assert.equal(probe.reason, 'AGENT_AUTH_REQUIRED');
	await selector.dispose();
	await selector.dispose();
});

test('nonfallback editor errors replace stale standalone probe status without leaking details', async () => {
	const editor = new FakeRuntime();
	const standalone = new FakeRuntime();
	const selector = new AgentHostSourceSelector(selectorOptions({
		preferEditor: () => true,
		editor,
		standalone,
	}));
	editor.probeResult = { available: false, featureEnabled: true };
	await selector.probe();
	assert.equal(selector.sourceStatus().source, 'standalone');
	editor.startError = new AgentRuntimeError(
		'AGENT_CONFIG_REQUIRED',
		'/private/editor.sock?tkn=secret requires configuration',
	);

	await assert.rejects(selector.start(taskRequest()), { code: 'AGENT_CONFIG_REQUIRED' });
	assert.equal(standalone.starts, 0);
	assert.deepEqual(selector.sourceStatus(), {
		source: 'editor',
		degraded: false,
		failure: {
			code: 'AGENT_CONFIG_REQUIRED',
			stage: 'session',
			message: 'The selected editor Agent Host requires Session configuration.',
		},
	});
	assert.doesNotMatch(JSON.stringify(selector.sourceStatus()), /private|secret|tkn/iu);
	await selector.dispose();
});

test('source selector does not fallback while editor cleanup remains failed', async () => {
	const editor = new FakeRuntime();
	const standalone = new FakeRuntime();
	editor.startError = new AgentRuntimeError(
		'AGENT_UNAVAILABLE',
		'editor cleanup failed',
		false,
		undefined,
		true,
	);
	const selector = new AgentHostSourceSelector(selectorOptions({
		preferEditor: () => true,
		editor,
		standalone,
	}));

	await assert.rejects(
		selector.start(taskRequest()),
		(error: unknown) => error instanceof AgentRuntimeError
			&& error.cleanupFailed,
	);
	assert.equal(standalone.starts, 0);
	await selector.dispose();
});

test('source selector retries failed runtime disposal', async () => {
	const editor = new FakeRuntime();
	const standalone = new FakeRuntime();
	editor.disposeErrors.push(new Error('first cleanup failed'));
	const selector = new AgentHostSourceSelector(selectorOptions({
		preferEditor: () => true,
		editor,
		standalone,
	}));

	await assert.rejects(selector.dispose(), { code: 'AGENT_UNAVAILABLE' });
	await selector.dispose();
	assert.equal(editor.disposals, 2);
	assert.equal(standalone.disposals, 2);
});

test('source selector preserves the safe standalone fallback failure category', async () => {
	const editor = new FakeRuntime();
	const standalone = new FakeRuntime();
	editor.startError = new AgentRuntimeError('AGENT_UNAVAILABLE', 'editor unavailable');
	standalone.startError = new AgentRuntimeError(
		'AGENT_AUTH_REQUIRED',
		'/private/profile token=mesh-sensitive',
	);
	const selector = new AgentHostSourceSelector(selectorOptions({
		preferEditor: () => true,
		editor,
		standalone,
	}));

	await assert.rejects(
		selector.start(taskRequest()),
		(error: unknown) => error instanceof AgentRuntimeError
			&& error.code === 'AGENT_AUTH_REQUIRED'
			&& error.message === 'The standalone Agent Host fallback requires authentication.'
			&& !error.message.includes('private')
			&& !error.message.includes('sensitive')
			&& error.cause === undefined,
	);
	await selector.dispose();
});

test('source selector retains the actual degraded execution source across availability probes', async () => {
	const editor = new FakeRuntime();
	const standalone = new FakeRuntime();
	editor.startError = new AgentRuntimeError('AGENT_UNAVAILABLE', 'editor connect failed');
	const selector = new AgentHostSourceSelector(selectorOptions({
		preferEditor: () => true,
		editor,
		standalone,
	}));

	await selector.start(taskRequest());
	editor.probeResult = { available: true, featureEnabled: true };
	const probe = await selector.probe();
	assert.equal(editor.probes, 0);
	assert.equal(standalone.probes, 1);
	assert.deepEqual(probe.degradation, {
		reason: 'EDITOR_START_FAILED',
		message: 'Editor Agent Host startup failed; standalone mode is in use.',
	});
	assert.deepEqual(selector.sourceStatus(), {
		source: 'standalone',
		degraded: true,
		reason: 'EDITOR_START_FAILED',
		message: 'Editor Agent Host startup failed; standalone mode is in use.',
		failure: {
			code: 'AGENT_UNAVAILABLE',
			stage: 'task',
			message: 'The selected editor Agent Host attempt failed safely.',
		},
	});
	await selector.dispose();
});

test('source status observer failures cannot orphan a successfully started handle', async () => {
	const editor = new FakeRuntime();
	const standalone = new FakeRuntime();
	const selector = new AgentHostSourceSelector(selectorOptions({
		preferEditor: () => true,
		editor,
		standalone,
	}));
	selector.onDidSourceStatusChange(() => {
		throw new Error('observer failed');
	});

	const handle = await selector.start(taskRequest());
	assert.equal(handle.taskId, 'task-id');
	assert.equal(editor.starts, 1);
	assert.equal(standalone.starts, 0);
	await handle.dispose();
	await selector.dispose();
});

test('source selector disposal aborts a pending approval without starting either source', async () => {
	const editor = new FakeRuntime();
	const standalone = new FakeRuntime();
	let approvalEntered!: () => void;
	const entered = new Promise<void>((resolve) => {
		approvalEntered = resolve;
	});
	const selector = new AgentHostSourceSelector({
		...selectorOptions({
			preferEditor: () => true,
			editor,
			standalone,
		}),
		confirmation: {
			confirm: async () => {
				approvalEntered();
				return new Promise<'once'>(() => undefined);
			},
		},
	});

	const start = selector.start(taskRequest());
	await entered;
	await selector.dispose();
	await assert.rejects(
		start,
		(error: unknown) => error instanceof AgentRuntimeError
			&& error.code === 'AGENT_UNAVAILABLE',
	);
	assert.equal(editor.starts, 0);
	assert.equal(standalone.starts, 0);
});

function createLocator(
	document: string,
	overrides: {
		readonly canonicalize?: (path: string) => Promise<string>;
		readonly isProcessAlive?: (pid: number) => boolean;
		readonly runCommand?: (
			executable: string,
			args: readonly string[],
		) => Promise<string>;
	} = {},
): EditorAgentHostLocator {
	return new EditorAgentHostLocator({
		configuredCodeCli: '/safe/code',
		configuredUserDataDir: '/safe/user-data',
		platform: {
			platform: 'darwin',
			architecture: 'arm64',
			homeDirectory: '/home/mesh',
			environment: {},
			productName: 'Visual Studio Code',
		},
	}, {
		canonicalize: overrides.canonicalize ?? (async (path) => path),
		isProcessAlive: overrides.isProcessAlive ?? (() => true),
		runCommand: overrides.runCommand ?? (async (_executable, args) =>
			args[0] === '--version' ? '1.135.0\ncommit\narm64\n' : document),
	});
}

function endpointDocument(userDataPath: string, endpoints: readonly unknown[]): string {
	return JSON.stringify({ userDataPath, endpoints });
}

function editorEndpoint(options: {
	readonly pid?: number;
	readonly protocolVersion?: string;
	readonly socketPath?: string;
	readonly token?: string;
	readonly transport?: string;
} = {}): Record<string, unknown> {
	return {
		schemaVersion: 2,
		type: 'editor',
		pid: options.pid ?? 100,
		instanceId: `instance-${options.pid ?? 100}`,
		protocolVersion: options.protocolVersion ?? '1.0.0',
		connectionToken: options.token ?? 'connection-token',
		endpoint: {
			type: options.transport ?? 'socket',
			...(options.socketPath === undefined && options.transport === 'tcp'
				? {}
				: { path: options.socketPath ?? '/safe/editor.sock' }),
		},
	};
}

async function withSocketPath(run: (socketPath: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'mesh-editor-host-'));
	try {
		await run(join(root, 'editor.sock'));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function startWebSocketServer(
	socketPath: string,
	expectedToken: string,
): Promise<{ readonly server: HttpServer; readonly webSockets: WebSocketServer }> {
	const server = createHttpServer();
	const webSockets = new WebSocketServer({ noServer: true });
	server.on('upgrade', (request, socket, head) => {
		if (request.url !== `/?tkn=${expectedToken}`) {
			socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
			return;
		}
		webSockets.handleUpgrade(request, socket, head, (client) => {
			webSockets.emit('connection', client, request);
		});
	});
	await listen(server, socketPath);
	return { server, webSockets };
}

async function listen(server: HttpServer | NetServer, socketPath: string): Promise<void> {
	server.listen(socketPath);
	await once(server, 'listening');
}

async function closeWebSocketServer(server: HttpServer, webSockets: WebSocketServer): Promise<void> {
	for (const client of webSockets.clients) {
		client.terminate();
	}
	await Promise.all([
		new Promise<void>((resolve) => webSockets.close(() => resolve())),
		new Promise<void>((resolve) => server.close(() => resolve())),
	]);
}

async function closeNetServer(server: NetServer): Promise<void> {
	for (const socket of netServerSockets.get(server) ?? []) {
		socket.destroy();
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

function createTrackedNetServer(handler: (socket: Socket) => void): NetServer {
	const sockets = new Set<Socket>();
	const server = createNetServer((socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
		handler(socket);
	});
	netServerSockets.set(server, sockets);
	return server;
}

async function assertConnectorFailure(
	connection: Promise<unknown>,
	code: UnixSocketWebSocketError['code'],
	socketPath: string,
	token: string,
): Promise<void> {
	await assert.rejects(
		connection,
		(error: unknown) => error instanceof UnixSocketWebSocketError
			&& error.code === code
			&& !error.message.includes(socketPath)
			&& !error.message.includes(token),
	);
}

class FakeRuntime implements AgentRuntime {
	starts = 0;
	probes = 0;
	disposals = 0;
	startError: unknown;
	readonly disposeErrors: unknown[] = [];
	probeResult: AgentRuntimeProbe = { available: true, featureEnabled: true };

	public async probe(): Promise<AgentRuntimeProbe> {
		this.probes += 1;
		return this.probeResult;
	}

	public async start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		this.starts += 1;
		if (this.startError !== undefined) {
			throw this.startError;
		}
		return {
			taskId: request.taskId,
			events: (async function* () {
				yield { type: 'completed' as const };
			})(),
			recovery: {
				clientId: 'client',
				sessionUri: 'ahp-session:/session',
				chatUri: 'ahp-chat:/chat',
				lastSeenServerSeq: 1,
			},
			cancel: async () => undefined,
			answer: async () => undefined,
			dispose: async () => undefined,
		};
	}

	public async dispose(): Promise<void> {
		this.disposals += 1;
		const error = this.disposeErrors.shift();
		if (error !== undefined) {
			throw error;
		}
	}
}

function taskRequest(): AgentTaskRequest {
	return {
		taskId: 'task-id',
		title: 'Safe task',
		prompt: 'Safe prompt',
		workspaceId: 'workspace-id',
	};
}

function selectorOptions(options: {
	readonly preferEditor: () => boolean;
	readonly editor: AgentRuntime;
	readonly standalone: AgentRuntime;
}): ConstructorParameters<typeof AgentHostSourceSelector>[0] {
	return {
		...options,
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: {
			resolve: async (workspaceId) => ({
				workspaceId,
				displayName: 'Workspace',
				uri: 'file:///workspace',
			}),
		},
		approvalCapabilities: new AgentRuntimeApprovalCapabilityIssuer(),
	};
}
