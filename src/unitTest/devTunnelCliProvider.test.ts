import * as assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	ChildProcessExecutionError,
	ChildProcessRunOptions,
	ChildProcessResult,
	OwnedChildProcess,
	OwnedChildProcessExit,
} from '../tunnel/ChildProcessRunner';
import {
	DevTunnelCliProvider,
	DevTunnelCliProviderOptions,
} from '../tunnel/DevTunnelCliProvider';
import {
	DEVTUNNEL_DECODER_REVISION,
	SUPPORTED_DEVTUNNEL_BUILD,
} from '../tunnel/DevTunnelJsonDecoder';
import {
	DevTunnelProviderError,
	DevTunnelStateStore,
	TunnelMetadata,
	TunnelRequest,
} from '../tunnel/DevTunnelProvider';

const now = new Date('2026-08-25T01:00:00.000Z');
const tunnelId = 'came2etest.jpe1';
const request: TunnelRequest = {
	accessDuration: '7d',
	healthPath: '/healthz',
	localPort: 43123,
	ownershipLabel: 'copilot-agent-mesh-e2e-test',
	tunnelAlias: 'came2etest',
	tunnelExpiration: '30d',
	wssExpectedResponse: 'mesh-ok',
	wssPath: '/mesh-probe',
	wssProbeRequest: 'mesh-probe',
};

suite('DevTunnelCliProvider', () => {
	test('provisions one exact-build tunnel and starts one owned host', async () => {
		const runner = new FakeRunner();
		const store = new MemoryStore();
		const provider = createProvider(runner, store);

		const [first, second] = await Promise.all([
			provider.ensureHosted(request),
			provider.ensureHosted(request),
		]);
		const third = await provider.ensureHosted({ ...request });

		assert.deepStrictEqual(second, first);
		assert.deepStrictEqual(third, first);
		assert.equal(first.tunnelId, tunnelId);
		assert.equal(first.forwardingOrigin, 'https://fixture-43123.jpe1.devtunnels.ms');
		assert.equal(runner.hosts.length, 1);
		assert.deepStrictEqual(runner.commands.map((args) => args.slice(0, 2).join(' ')), [
			'--version',
			'user show',
			'create came2etest',
			'port create',
			'access create',
			'show came2etest.jpe1',
		]);
		assert.equal(store.value?.provisioned, true);
		assert.equal(provider.getStatus().state, 'ready');

		await provider.stop();
		assert.equal(runner.hosts[0].stopCount, 1);
	});

	test('fails closed on the installed legacy build without provisioning', async () => {
		const runner = new FakeRunner('1.0.2006+dd9fe5139f');
		const provider = createProvider(runner, new MemoryStore());

		await assert.rejects(
			provider.ensureHosted(request),
			(error: unknown) => hasProviderCode(error, 'CLI_UNSUPPORTED'),
		);
		assert.equal(runner.commands.some((args) => args[0] === 'create'), false);
		assert.equal(provider.getStatus().state, 'circuit-open');
	});

	test('fails closed when the exact build executable hash is not allowlisted', async () => {
		const runner = new FakeRunner();
		const provider = createProvider(runner, new MemoryStore(), {
			binaryVerifier: async () => false,
		});

		await assert.rejects(
			provider.ensureHosted(request),
			(error: unknown) => hasProviderCode(error, 'CLI_UNSUPPORTED'),
		);
		assert.equal(runner.commands.some((args) => args[0] === 'create'), false);
	});

	test('constructs the default runner boundary from the verified official basename', async () => {
		const runner = new FakeRunner();
		let allowedBasename: string | undefined;
		const provider = new DevTunnelCliProvider({
			architecture: 'arm64',
			binaryVerifier: async () => true,
			commandRunnerFactory: (basename) => {
				allowedBasename = basename;
				return runner;
			},
			executable: '/download/osx-arm64-devtunnel',
			healthProbe: async () => undefined,
			localHealthProbe: async () => undefined,
			now: () => now,
			platform: 'darwin',
			resolveExecutable: async () => '/verified/osx-arm64-devtunnel',
			showPollIntervalMs: 1,
			showTimeoutMs: 100,
			stateStore: new MemoryStore(),
			wssProbe: async () => undefined,
		});

		await provider.ensureHosted(request);

		assert.equal(allowedBasename, 'osx-arm64-devtunnel');
		await provider.stop();
	});

	test('rejects a differing concurrent request instead of coalescing it', async () => {
		const runner = new FakeRunner();
		runner.pauseCreate = true;
		const provider = createProvider(runner, new MemoryStore());
		const first = provider.ensureHosted(request);
		await runner.waitForCreate();

		await assert.rejects(
			provider.ensureHosted({ ...request, localPort: 43124 }),
			(error: unknown) => hasProviderCode(error, 'PORT_MIGRATION_REQUIRED'),
		);
		runner.continueCreate();
		await first;
		await provider.stop();
	});

	test('blocks a persisted port change and requires explicit migration', async () => {
		const runner = new FakeRunner();
		const store = new MemoryStore(createMetadata({ localPort: 43124 }));
		const provider = createProvider(runner, store);

		await assert.rejects(
			provider.ensureHosted(request),
			(error: unknown) => hasProviderCode(error, 'PORT_MIGRATION_REQUIRED'),
		);
		assert.equal(runner.commands.some((args) => args[0] === 'show'), false);
		assert.equal(runner.hosts.length, 0);
	});

	test('cancels a pending restart when stopped during backoff', async () => {
		const runner = new FakeRunner();
		const provider = createProvider(runner, new MemoryStore(), {
			random: () => 0.9,
			restartBaseDelayMs: 50,
		});

		await provider.ensureHosted(request);

		runner.hosts[0].finish({ exitCode: 1, signal: null });
		await waitFor(() => provider.getStatus().state === 'backoff');
		await provider.stop();
		await delay(80);

		assert.equal(runner.hosts.length, 1);
		assert.equal(provider.getStatus().state, 'stopped');
	});

	test('aborts an in-flight create without overwriting stopped state', async () => {
		const runner = new FakeRunner();
		runner.pauseCreate = true;
		const store = new MemoryStore();
		const provider = createProvider(runner, store);
		const starting = provider.ensureHosted(request);
		await runner.waitForCreate();

		await provider.stop();
		await assert.rejects(starting);

		assert.equal(provider.getStatus().state, 'stopped');
		assert.equal(store.value, undefined);
		assert.equal(runner.commands.some((args) => args.slice(0, 2).join(' ') === 'port create'), false);
		assert.equal(runner.hosts.length, 0);
	});

	test('aborts in-flight port configuration before access or host side effects', async () => {
		const runner = new FakeRunner();
		runner.pausePortCreate = true;
		const store = new MemoryStore();
		const provider = createProvider(runner, store);
		const starting = provider.ensureHosted(request);
		await runner.waitForPortCreate();

		await provider.stop();
		await assert.rejects(starting);

		assert.equal(provider.getStatus().state, 'stopped');
		assert.equal(store.value?.provisioned, false);
		assert.equal(runner.commands.some((args) => args.slice(0, 2).join(' ') === 'access create'), false);
		assert.equal(runner.hosts.length, 0);
	});

	test('aborts WSS readiness and keeps the stopped lifecycle authoritative', async () => {
		let reachProbe: (() => void) | undefined;
		const probeReached = new Promise<void>((resolve) => {
			reachProbe = resolve;
		});
		const runner = new FakeRunner();
		const provider = createProvider(runner, new MemoryStore(), {
			wssProbe: async (
				_forwardingOrigin,
				_path,
				_requestMessage,
				_expectedResponse,
				options,
			) => new Promise<void>((_resolve, reject) => {
				reachProbe?.();
				const abort = (): void => reject(new DevTunnelProviderError(
					'WSS_PROBE_FAILED',
					'Injected WSS abort.',
					true,
				));
				options?.signal?.addEventListener('abort', abort, { once: true });
			}),
		});
		const starting = provider.ensureHosted(request);
		await probeReached;

		await provider.stop();
		await assert.rejects(starting);

		assert.equal(provider.getStatus().state, 'stopped');
		assert.equal(runner.hosts[0].stopCount, 1);
	});

	test('renews the owned port-scoped ACE and persists its expiration', async () => {
		const runner = new FakeRunner();
		const store = new MemoryStore();
		const provider = createProvider(runner, store);
		await provider.ensureHosted(request);
		runner.accessExpiration = '2026-09-08T01:00:00.000Z';

		const renewed = await provider.renewAccess();

		assert.equal(renewed.accessExpiresAt, runner.accessExpiration);
		assert.ok(runner.commands.some((args) => args.slice(0, 2).join(' ') === 'access delete'));
		assert.equal(store.value?.accessExpiresAt, runner.accessExpiration);
		await provider.stop();
	});

	test('serializes concurrent access renewals', async () => {
		const runner = new FakeRunner();
		const provider = createProvider(runner, new MemoryStore());
		await provider.ensureHosted(request);
		runner.accessExpiration = '2026-09-08T01:00:00.000Z';

		const [first, second] = await Promise.all([
			provider.renewAccess(),
			provider.renewAccess(),
		]);

		assert.deepStrictEqual(second, first);
		assert.equal(
			runner.commands.filter((args) => args.slice(0, 2).join(' ') === 'access list').length,
			1,
		);
		assert.equal(
			runner.commands.filter((args) => args.slice(0, 2).join(' ') === 'access delete').length,
			1,
		);
		await provider.stop();
	});

	test('refuses to delete when the current ACE set is not uniquely provider-owned', async () => {
		const runner = new FakeRunner();
		const provider = createProvider(runner, new MemoryStore());
		await provider.ensureHosted(request);
		runner.extraAccessEntry = true;

		await assert.rejects(
			provider.renewAccess(),
			(error: unknown) => hasProviderCode(error, 'TUNNEL_ACCESS_EXPIRED'),
		);

		assert.equal(runner.commands.some((args) => args.slice(0, 2).join(' ') === 'access delete'), false);
		assert.equal(provider.getStatus().state, 'circuit-open');
	});

	test('keeps a pre-delete access-list timeout transient', async () => {
		const runner = new FakeRunner();
		const provider = createProvider(runner, new MemoryStore());
		await provider.ensureHosted(request);
		runner.accessListTimeout = true;

		await assert.rejects(
			provider.renewAccess(),
			(error: unknown) => {
				assert.ok(error instanceof DevTunnelProviderError);
				assert.equal(error.code, 'CLI_COMMAND_FAILED');
				assert.equal(error.retryable, true);
				return true;
			},
		);

		assert.equal(runner.commands.some((args) => args.slice(0, 2).join(' ') === 'access delete'), false);
		assert.equal(provider.getStatus().state, 'ready');
		await provider.stop();
	});

	test('classifies only exact show not-found as permanent', async () => {
		const missingRunner = new FakeRunner();
		missingRunner.showNotFound = true;
		const missingProvider = createProvider(
			missingRunner,
			new MemoryStore(createMetadata()),
		);
		await assert.rejects(
			missingProvider.ensureHosted(request),
			(error: unknown) => hasProviderCode(error, 'TUNNEL_NOT_FOUND'),
		);

		const timeoutRunner = new FakeRunner();
		timeoutRunner.showTimeout = true;
		const timeoutProvider = createProvider(
			timeoutRunner,
			new MemoryStore(createMetadata()),
		);
		await assert.rejects(
			timeoutProvider.ensureHosted(request),
			(error: unknown) => {
				assert.ok(error instanceof DevTunnelProviderError);
				assert.equal(error.code, 'CLI_COMMAND_FAILED');
				assert.equal(error.retryable, true);
				return true;
			},
		);
		assert.notEqual(timeoutProvider.getStatus().state, 'circuit-open');
	});

	test('resumes an owned tunnel interrupted before fixed-port provisioning', async () => {
		const runner = new FakeRunner();
		runner.hasPort = false;
		const store = new MemoryStore(createMetadata({
			accessExpiresAt: now.toISOString(),
			provisioned: false,
		}));
		const provider = createProvider(runner, store);

		const hosted = await provider.ensureHosted(request);

		assert.equal(hosted.status, 'ready');
		assert.ok(runner.commands.some((args) => args.slice(0, 2).join(' ') === 'port create'));
		assert.equal(store.value?.provisioned, true);
		await provider.stop();
	});

	test('stops the host and suppresses restart after ACE renewal fails', async () => {
		const runner = new FakeRunner();
		const provider = createProvider(runner, new MemoryStore());
		await provider.ensureHosted(request);
		runner.failAccessCreate = true;

		await assert.rejects(
			provider.renewAccess(),
			(error: unknown) => hasProviderCode(error, 'TUNNEL_ACCESS_EXPIRED'),
		);
		await delay(20);

		assert.equal(runner.hosts[0].stopCount, 1);
		assert.equal(runner.hosts.length, 1);
		assert.equal(provider.getStatus().state, 'circuit-open');
	});

	test('opens the circuit and stops the failed host on permanent restart schema drift', async () => {
		const runner = new FakeRunner();
		const provider = createProvider(runner, new MemoryStore(), {
			random: () => 0,
			restartBaseDelayMs: 1,
		});
		await provider.ensureHosted(request);
		runner.invalidShow = true;

		runner.hosts[0].finish({ exitCode: 1, signal: null });
		await waitFor(() => provider.getStatus().state === 'circuit-open');

		assert.equal(runner.hosts.length, 2);
		assert.equal(runner.hosts[1].stopCount, 1);
		const status = provider.getStatus();
		assert.equal(status.state, 'circuit-open');
		if (status.state === 'circuit-open') {
			assert.equal(status.code, 'CLI_UNSUPPORTED');
		}
	});

	test('cancels readiness when the owned host exits before WSS succeeds', async () => {
		let reachProbe: (() => void) | undefined;
		const probeReached = new Promise<void>((resolve) => {
			reachProbe = resolve;
		});
		let readinessAborted = false;
		const runner = new FakeRunner();
		const provider = createProvider(runner, new MemoryStore(), {
			wssProbe: async (
				_forwardingOrigin,
				_path,
				_requestMessage,
				_expectedResponse,
				options,
			) => new Promise<void>((_resolve, reject) => {
				reachProbe?.();
				const abort = (): void => {
					readinessAborted = true;
					reject(new DevTunnelProviderError('WSS_PROBE_FAILED', 'Injected WSS abort.', true));
				};
				options?.signal?.addEventListener('abort', abort, { once: true });
			}),
		});
		const starting = provider.ensureHosted(request);
		await probeReached;

		runner.hosts[0].finish({ exitCode: 1, signal: null });
		await assert.rejects(
			starting,
			(error: unknown) => hasProviderCode(error, 'CLI_UNSUPPORTED'),
		);

		assert.equal(readinessAborted, true);
		assert.equal(runner.hosts[0].stopCount, 1);
		assert.equal(provider.getStatus().state, 'circuit-open');
	});

	test('does not publish ready when the host exits during hosted-state persistence', async () => {
		const runner = new FakeRunner();
		const store = new MemoryStore();
		store.beforeSave = (metadata) => {
			if (metadata.forwardingOrigin !== undefined) {
				runner.hosts[0].finish({ exitCode: 1, signal: null });
			}
		};
		const provider = createProvider(runner, store);

		await assert.rejects(
			provider.ensureHosted(request),
			(error: unknown) => hasProviderCode(error, 'CLI_UNSUPPORTED'),
		);

		assert.equal(provider.getStatus().state, 'circuit-open');
		assert.equal(runner.hosts[0].stopCount, 1);
	});
});

class FakeRunner {
	readonly commands: string[][] = [];
	readonly hosts: FakeOwnedHost[] = [];
	accessExpiration = '2026-09-01T01:00:00.000Z';
	listedAccessExpiration = '2026-09-01T01:00:00.000Z';
	accessListTimeout = false;
	failAccessCreate = false;
	extraAccessEntry = false;
	hasPort = true;
	invalidShow = false;
	pauseCreate = false;
	pausePortCreate = false;
	showNotFound = false;
	showTimeout = false;
	private createContinuation: (() => void) | undefined;
	private createReached: (() => void) | undefined;
	private readonly createReachedPromise = new Promise<void>((resolve) => {
		this.createReached = resolve;
	});
	private portCreateReached: (() => void) | undefined;
	private readonly portCreateReachedPromise = new Promise<void>((resolve) => {
		this.portCreateReached = resolve;
	});

	constructor(private readonly build = SUPPORTED_DEVTUNNEL_BUILD) {}

	async run(
		_executable: string,
		args: readonly string[],
		options?: ChildProcessRunOptions,
	): Promise<ChildProcessResult> {
		this.commands.push([...args]);
		const command = args.slice(0, 2).join(' ');
		if (args[0] === '--version') {
			return result(`Tunnel CLI version: ${this.build}\n`);
		}
		if (command === 'user show') {
			return result('');
		}
		if (args[0] === 'create') {
			this.createReached?.();
			if (this.pauseCreate) {
				await this.waitForCreateContinuation(options?.signal);
			}
			return result(JSON.stringify({
				tunnel: {
					tunnelId,
					hostConnections: 0,
					clientConnections: 0,
					labels: [request.ownershipLabel],
					tunnelExpiration: '30 days',
					description: '',
					currentUploadRate: '0 B/s',
					currentDownloadRate: '0 B/s',
					accessControl: [],
				},
			}));
		}
		if (command === 'port create') {
			this.portCreateReached?.();
			if (this.pausePortCreate) {
				await this.waitForCreateContinuation(options?.signal);
			}
			this.hasPort = true;
			return result(JSON.stringify({
				port: {
					tunnelId,
					portNumber: request.localPort,
					protocol: 'http',
					accessControl: [],
					clientConnections: 0,
				},
			}));
		}
		if (command === 'access list') {
			if (this.accessListTimeout) {
				throw new ChildProcessExecutionError('PROCESS_TIMEOUT', 'Injected access-list timeout.');
			}
			const entries = [{
				type: 'Anonymous',
				subjects: [],
				scopes: ['connect'],
				expiration: this.listedAccessExpiration,
			}];
			if (this.extraAccessEntry) {
				entries.push({
					type: 'Anonymous',
					subjects: [],
					scopes: ['connect'],
					expiration: this.listedAccessExpiration,
				});
			}
			return result(JSON.stringify({ accessControlEntries: entries }));
		}
		if (command === 'access create') {
			if (this.failAccessCreate) {
				throw new Error('Injected access create failure.');
			}
			this.listedAccessExpiration = this.accessExpiration;
			return result(JSON.stringify({
				accessControlEntries: [{
					type: 'Anonymous',
					subjects: [],
					scopes: ['connect'],
					expiration: this.accessExpiration,
				}],
			}));
		}
		if (command === 'access delete') {
			return result(JSON.stringify({ accessControlEntries: [] }));
		}
		if (args[0] === 'show') {
			if (this.showTimeout) {
				throw new ChildProcessExecutionError('PROCESS_TIMEOUT', 'Injected show timeout.');
			}
			if (this.showNotFound) {
				return {
					exitCode: 2,
					stdout: '',
					stderr: 'Tunnel not found in jpe1: came2etest\n',
				};
			}
			if (this.invalidShow) {
				return result(JSON.stringify({
					...hostedFixture(),
					unknown: true,
				}));
			}
			return result(JSON.stringify(hostedFixture(this.hasPort)));
		}
		throw new Error(`Unexpected fake command: ${args.join(' ')}`);
	}

	waitForCreate(): Promise<void> {
		return this.createReachedPromise;
	}

	waitForPortCreate(): Promise<void> {
		return this.portCreateReachedPromise;
	}

	continueCreate(): void {
		this.createContinuation?.();
	}

	private waitForCreateContinuation(signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const abort = (): void => {
				signal?.removeEventListener('abort', abort);
				reject(new ChildProcessExecutionError(
					'PROCESS_ABORTED',
					'Injected create abort.',
				));
			};
			this.createContinuation = () => {
				signal?.removeEventListener('abort', abort);
				resolve();
			};
			signal?.addEventListener('abort', abort, { once: true });
			if (signal?.aborted === true) {
				abort();
			}
		});
	}

	async startOwned(_executable: string, args: readonly string[]): Promise<OwnedChildProcess> {
		assert.deepStrictEqual(args, [
			'host',
			tunnelId,
			'--port-number',
			String(request.localPort),
		]);
		const host = new FakeOwnedHost(this.hosts.length + 100);
		this.hosts.push(host);
		return host;
	}
}

class FakeOwnedHost implements OwnedChildProcess {
	readonly exit: Promise<OwnedChildProcessExit>;
	stopCount = 0;
	private resolveExit: ((result: OwnedChildProcessExit) => void) | undefined;

	constructor(readonly pid: number) {
		this.exit = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
	}

	finish(result: OwnedChildProcessExit): void {
		this.resolveExit?.(result);
	}

	async stop(): Promise<void> {
		this.stopCount += 1;
		this.finish({ exitCode: null, signal: 'SIGTERM' });
	}
}

class MemoryStore implements DevTunnelStateStore {
	beforeSave: ((metadata: TunnelMetadata) => void) | undefined;

	constructor(public value?: TunnelMetadata) {}

	async load(): Promise<TunnelMetadata | undefined> {
		return this.value;
	}

	async save(metadata: TunnelMetadata): Promise<void> {
		this.beforeSave?.(metadata);
		this.value = metadata;
	}
}

function createProvider(
	runner: FakeRunner,
	store: MemoryStore,
	overrides: {
		readonly binaryVerifier?: () => Promise<boolean>;
		readonly random?: () => number;
		readonly restartBaseDelayMs?: number;
		readonly wssProbe?: DevTunnelCliProviderOptions['wssProbe'];
	} = {},
): DevTunnelCliProvider {
	return new DevTunnelCliProvider({
		architecture: 'arm64',
		binaryVerifier: overrides.binaryVerifier ?? (async () => true),
		commandRunner: runner,
		executable: 'devtunnel',
		healthProbe: async () => undefined,
		localHealthProbe: async () => undefined,
		now: () => now,
		platform: 'darwin',
		random: overrides.random,
		resolveExecutable: async () => '/verified/devtunnel',
		restartBaseDelayMs: overrides.restartBaseDelayMs,
		restartMaxDelayMs: 100,
		showPollIntervalMs: 1,
		showTimeoutMs: 100,
		stateStore: store,
		wssProbe: overrides.wssProbe ?? (async () => undefined),
	});
}

function createMetadata(overrides: Partial<TunnelMetadata> = {}): TunnelMetadata {
	return {
		accessDuration: request.accessDuration,
		accessExpiresAt: '2026-09-01T01:00:00.000Z',
		accessIndex: 0,
		build: SUPPORTED_DEVTUNNEL_BUILD,
		decoderRevision: DEVTUNNEL_DECODER_REVISION,
		localPort: request.localPort,
		ownershipLabel: request.ownershipLabel,
		provisioned: true,
		tunnelAlias: request.tunnelAlias,
		tunnelExpiresAt: '2026-09-24T01:00:00.000Z',
		tunnelId,
		...overrides,
	};
}

function hostedFixture(hasPort = true) {
	const fixture = {
		tunnel: {
			tunnelId,
			hostConnections: 1,
			clientConnections: 0,
			labels: [request.ownershipLabel],
			tunnelExpiration: '30 days',
			description: '',
			currentUploadRate: '0 B/s',
			currentDownloadRate: '0 B/s',
			ports: [{
				portNumber: request.localPort,
				protocol: 'http',
				portUri: 'https://fixture-43123.jpe1.devtunnels.ms/',
			}],
			accessControl: [],
		},
	};
	if (!hasPort) {
		delete (fixture.tunnel as Partial<typeof fixture.tunnel>).ports;
	}
	return fixture;
}

function result(stdout: string): ChildProcessResult {
	return { exitCode: 0, stderr: '', stdout };
}

function hasProviderCode(error: unknown, code: DevTunnelProviderError['code']): boolean {
	assert.ok(error instanceof DevTunnelProviderError);
	assert.equal(error.code, code);
	return true;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 500;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for provider status.');
		}
		await delay(1);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
