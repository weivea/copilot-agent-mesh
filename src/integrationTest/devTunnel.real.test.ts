import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { WebSocketServer } from 'ws';

import {
	ChildProcessRunOptions,
	ChildProcessRunner,
	ChildProcessResult,
	OwnedChildProcess,
} from '../tunnel/ChildProcessRunner';
import { DevTunnelCliProvider } from '../tunnel/DevTunnelCliProvider';
import {
	isExactDevTunnelNotFound,
	SUPPORTED_DEVTUNNEL_BUILD,
} from '../tunnel/DevTunnelJsonDecoder';
import {
	DevTunnelStateStore,
	TunnelMetadata,
	TunnelRequest,
} from '../tunnel/DevTunnelProvider';

const optInFlag = 'MESH_DEVTUNNEL_E2E';

test('real Dev Tunnel lifecycle', { timeout: 180_000 }, async () => {
	assert.equal(
		process.env[optInFlag],
		'1',
		`${optInFlag}=1 is required because this test creates a public Dev Tunnel resource.`,
	);
	const executable = process.env.MESH_DEVTUNNEL_PATH ?? 'devtunnel';
	let runner: RecordingRunner | undefined;
	const store = new MemoryStore();
	const gateway = createServer((request, response) => {
		if (request.method === 'GET' && request.url === '/healthz') {
			response.writeHead(204).end();
			return;
		}
		response.writeHead(404).end();
	});
	const webSocketServer = new WebSocketServer({
		noServer: true,
	});
	gateway.on('upgrade', (request, socket, head) => {
		if (request.url !== '/mesh-probe') {
			socket.destroy();
			return;
		}
		webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
			webSocketServer.emit('connection', webSocket, request);
		});
	});
	webSocketServer.on('connection', (socket) => {
		socket.once('message', (data) => {
			if (data.toString('utf8') === 'mesh-probe') {
				socket.send('mesh-ok');
			} else {
				socket.close(1008);
			}
		});
	});
	await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
	const address = gateway.address();
	assert.ok(address !== null && typeof address === 'object');
	const unique = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
	const request: TunnelRequest = {
		accessDuration: '2d',
		healthPath: '/healthz',
		localPort: address.port,
		ownershipLabel: `copilot-agent-mesh-e2e-${unique}`,
		tunnelAlias: `came2e${unique}`,
		tunnelExpiration: '1d',
		wssExpectedResponse: 'mesh-ok',
		wssPath: '/mesh-probe',
		wssProbeRequest: 'mesh-probe',
	};
	const provider = new DevTunnelCliProvider({
		commandRunnerFactory: (allowedExecutableBasename) => {
			const created = new RecordingRunner(
				new ChildProcessRunner({
					allowedExecutableBasenames: [allowedExecutableBasename],
				}),
				allowedExecutableBasename,
			);
			runner = created;
			return created;
		},
		executable,
		maxRestartAttempts: 5,
		random: () => 0,
		restartBaseDelayMs: 100,
		restartMaxDelayMs: 1_000,
		showPollIntervalMs: 500,
		showTimeoutMs: 30_000,
		stateStore: store,
	});
	let cleanupConfirmed = false;
	try {
		const hosted = await provider.ensureHosted(request);
		const activeRunner = requireRunner(runner);
		assert.equal(hosted.build, SUPPORTED_DEVTUNNEL_BUILD);
		assert.equal(new URL(hosted.forwardingOrigin).protocol, 'https:');

		const renewed = await provider.renewAccess();
		assert.ok(new Date(renewed.accessExpiresAt).valueOf() > Date.now());

		const firstOrigin = hosted.forwardingOrigin;
		const fixtureOutput = process.env.MESH_DEVTUNNEL_FIXTURE_OUT;
		if (fixtureOutput !== undefined) {
			const shown = await activeRunner.runVerified(['show', hosted.tunnelId, '--json']);
			await writeFile(
				fixtureOutput,
				sanitizeHostedFixture(shown.stdout, hosted.tunnelId, request.localPort),
				{ encoding: 'utf8', flag: 'wx' },
			);
		}
		assert.equal(activeRunner.hosts.length, 1);
		await activeRunner.hosts[0].stop();
		await waitFor(
			() => activeRunner.hosts.length >= 2
				&& ['ready', 'circuit-open'].includes(provider.getStatus().state),
			60_000,
			() => {
				const status = provider.getStatus();
				return JSON.stringify({
					hosts: activeRunner.hosts.length,
					state: status.state,
					code: status.state === 'circuit-open' ? status.code : undefined,
					message: status.state === 'circuit-open' ? status.message : undefined,
				});
			},
		);
		const restartedStatus = provider.getStatus();
		assert.equal(
			restartedStatus.state,
			'ready',
			restartedStatus.state === 'circuit-open'
				? `${restartedStatus.message}; observed port status: ${activeRunner.lastPortStatus}`
					+ `; observed shape: ${activeRunner.lastShowShape}`
				: undefined,
		);
		if (restartedStatus.state === 'ready') {
			assert.equal(restartedStatus.tunnel.forwardingOrigin, firstOrigin);
		}

	} finally {
		let cleanupFailure: unknown;
		try {
			await provider.stop();
		} catch (error: unknown) {
			cleanupFailure = error;
		}
		const metadata = store.value;
		if (
			metadata !== undefined
			&& metadata.tunnelAlias === request.tunnelAlias
			&& metadata.ownershipLabel === request.ownershipLabel
			&& metadata.tunnelId.startsWith(`${request.tunnelAlias}.`)
		) {
			try {
				const activeRunner = requireRunner(runner);
				await activeRunner.runVerified(['delete', metadata.tunnelId]);
				await confirmOwnedTunnelDeleted(activeRunner, metadata);
				cleanupConfirmed = true;
				console.log(JSON.stringify({
					build: metadata.build,
					cleanup: 'confirmed-by-owned-id-and-exact-not-found',
				}));
			} catch (error: unknown) {
				cleanupFailure ??= error;
			}
		}
		try {
			await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
			await new Promise<void>((resolve, reject) => gateway.close((error) => {
				if (error === undefined) {
					resolve();
				} else {
					reject(error);
				}
			}));
		} catch (error: unknown) {
			cleanupFailure ??= error;
		}
		if (cleanupFailure !== undefined) {
			throw cleanupFailure;
		}
	}
	assert.equal(cleanupConfirmed, true);
	console.log(JSON.stringify({
		build: SUPPORTED_DEVTUNNEL_BUILD,
		cleanup: 'confirmed-by-owned-id',
		health: 'https-204',
		hostRestart: 'passed',
		runnerBasename: requireRunner(runner).allowedExecutableBasename,
		status: 'passed',
		wss: 'passed',
	}));
});

class RecordingRunner {
	readonly hosts: OwnedChildProcess[] = [];
	lastPortStatus = '<absent>';
	lastShowShape = '<absent>';
	private verifiedExecutable: string | undefined;

	constructor(
		private readonly runner: ChildProcessRunner,
		readonly allowedExecutableBasename: string,
	) {}

	async run(
		executable: string,
		args: readonly string[],
		options?: ChildProcessRunOptions,
	): Promise<ChildProcessResult> {
		this.verifiedExecutable = executable;
		const result = await this.runner.run(executable, args, options);
		if (args[0] === 'show' && result.exitCode === 0) {
			const parsed = JSON.parse(result.stdout) as {
				tunnel?: { ports?: Array<{ status?: unknown }> };
			};
			const status = parsed.tunnel?.ports?.[0]?.status;
			this.lastPortStatus = typeof status === 'string' ? status : `<${typeof status}>`;
			this.lastShowShape = JSON.stringify({
				tunnel: parsed.tunnel === undefined
					? '<undefined>'
					: Object.fromEntries(Object.entries(parsed.tunnel).map(
						([key, value]) => [key, Array.isArray(value) ? `array(${value.length})` : typeof value],
					)),
				port: parsed.tunnel?.ports?.[0] === undefined
					? '<undefined>'
					: Object.fromEntries(Object.entries(parsed.tunnel.ports[0]).map(
						([key, value]) => [key, Array.isArray(value) ? `array(${value.length})` : typeof value],
					)),
			});
		}
		return result;
	}

	runVerified(
		args: readonly string[],
		options?: ChildProcessRunOptions,
	): Promise<ChildProcessResult> {
		if (this.verifiedExecutable === undefined) {
			throw new Error('The Dev Tunnel executable has not been verified by the provider.');
		}
		return this.run(this.verifiedExecutable, args, options);
	}
	async startOwned(executable: string, args: readonly string[]): Promise<OwnedChildProcess> {
		const host = await this.runner.startOwned(executable, args);
		this.hosts.push(host);
		return host;
	}
}

function requireRunner(runner: RecordingRunner | undefined): RecordingRunner {
	assert.ok(runner, 'The provider did not construct its hash-gated process runner.');
	return runner;
}

async function confirmOwnedTunnelDeleted(
	runner: RecordingRunner,
	metadata: TunnelMetadata,
): Promise<void> {
	const deadline = Date.now() + 30_000;
	let lastObservation = 'no response';
	do {
		try {
			const shown = await runner.runVerified(
				['show', metadata.tunnelId, '--json'],
				{ acceptedExitCodes: [2] },
			);
			if (isExactDevTunnelNotFound(metadata.build, shown, metadata.tunnelId)) {
				return;
			}
			lastObservation = `exit ${shown.exitCode}`;
		} catch {
			lastObservation = 'transient command failure';
		}
		if (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	} while (Date.now() < deadline);
	throw new Error(
		`Owned tunnel cleanup never returned the exact versioned not-found response (${lastObservation}).`,
	);
}

class MemoryStore implements DevTunnelStateStore {
	value: TunnelMetadata | undefined;

	async load(): Promise<TunnelMetadata | undefined> {
		return this.value;
	}

	async save(metadata: TunnelMetadata): Promise<void> {
		this.value = metadata;
	}
}

function sanitizeHostedFixture(raw: string, tunnelId: string, port: number): string {
	const parsed = JSON.parse(raw) as {
		tunnel: {
			accessControl?: unknown[];
			clientConnections?: number;
			currentDownloadRate?: string;
			currentUploadRate?: string;
			description?: string | null;
			downloadTotal?: string;
			hostConnections?: number;
			labels?: string[];
			ports: Array<{
				accessControl?: unknown[];
				clientConnections?: number;
				description?: string | null;
				labels?: string[];
				portNumber: number;
				portUri?: string;
				protocol: string;
			}>;
			tunnelExpiration?: string;
			tunnelId: string;
			uploadTotal?: string;
		};
	};
	assert.equal(parsed.tunnel.tunnelId, tunnelId);
	const target = parsed.tunnel.ports.find((candidate) => candidate.portNumber === port);
	assert.ok(target);
	const fixture = {
		tunnel: {
			tunnelId: 'came2efixt.jpe1',
			hostConnections: 1,
			clientConnections: 0,
			labels: ['copilot-agent-mesh-e2e-fixture'],
			tunnelExpiration: '<redacted>',
			description: '<redacted>',
			currentUploadRate: '<redacted>',
			currentDownloadRate: '<redacted>',
			uploadTotal: '<redacted>',
			downloadTotal: '<redacted>',
			ports: [{
				portNumber: 43123,
				protocol: 'http',
				portUri: 'https://fixture-43123.jpe1.devtunnels.ms/',
				status: '<redacted>',
			}],
			accessControl: [],
		},
	};
	return `${JSON.stringify(fixture, null, 2)}\n`;
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
	diagnostic: () => string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for the Dev Tunnel host to restart: ${diagnostic()}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
