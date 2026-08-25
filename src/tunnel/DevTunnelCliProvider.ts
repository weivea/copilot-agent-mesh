import {
	ChildProcessExecutionError,
	ChildProcessRunOptions,
	ChildProcessRunner,
	ChildProcessResult,
	OwnedChildProcess,
} from './ChildProcessRunner';
import {
	DEVTUNNEL_DECODER_REVISION,
	DEVTUNNEL_EXECUTABLE_SHA256,
	decodeDevTunnelAccessCreateJson,
	decodeDevTunnelAccessDeleteJson,
	decodeDevTunnelAccessListForAdoptionJson,
	decodeDevTunnelAccessListJson,
	decodeDevTunnelCreateJson,
	decodeDevTunnelPortCreateJson,
	decodeDevTunnelShowJson,
	DevTunnelDecodeError,
	isExactDevTunnelNotFound,
	LEGACY_UNSUPPORTED_DEVTUNNEL_BUILD,
	SUPPORTED_DEVTUNNEL_BUILD,
} from './DevTunnelJsonDecoder';
import {
	DevTunnelProvider,
	DevTunnelProviderError,
	DevTunnelRuntimeStatus,
	DevTunnelStateStore,
	HostedTunnel,
	TunnelCapability,
	TunnelMetadata,
	TunnelRequest,
} from './DevTunnelProvider';
import {
	probeDevTunnelHealth,
	probeDevTunnelWss,
	probeLoopbackHealth,
} from './DevTunnelReadyProbe';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

interface DevTunnelCommandRunner {
	run(
		executable: string,
		args: readonly string[],
		options?: ChildProcessRunOptions,
	): Promise<ChildProcessResult>;
	startOwned(executable: string, args: readonly string[]): Promise<OwnedChildProcess>;
}

class DevTunnelCommandFailure extends Error {
	constructor(
		readonly operation: string,
		readonly execution: ChildProcessExecutionError,
	) {
		super(execution.message, { cause: execution });
		this.name = 'DevTunnelCommandFailure';
	}
}

export interface DevTunnelCliProviderOptions {
	readonly architecture?: string;
	readonly binaryVerifier?: (executable: string) => Promise<boolean>;
	readonly commandRunner?: DevTunnelCommandRunner;
	readonly commandRunnerFactory?: (allowedExecutableBasename: string) => DevTunnelCommandRunner;
	readonly executable?: string;
	readonly healthProbe?: typeof probeDevTunnelHealth;
	readonly localHealthProbe?: typeof probeLoopbackHealth;
	readonly maxRestartAttempts?: number;
	readonly now?: () => Date;
	readonly platform?: NodeJS.Platform;
	readonly random?: () => number;
	readonly resolveExecutable?: (executable: string) => Promise<string>;
	readonly restartBaseDelayMs?: number;
	readonly restartMaxDelayMs?: number;
	readonly showPollIntervalMs?: number;
	readonly showTimeoutMs?: number;
	readonly stateStore: DevTunnelStateStore;
	readonly wssProbe?: typeof probeDevTunnelWss;
}

const commandTimeoutMs = 30_000;
const commandMaxOutputBytes = 256 * 1024;
const renewalWindowMs = 24 * 60 * 60 * 1_000;
const knownVersionLines = new Map([
	[`Tunnel CLI version: ${SUPPORTED_DEVTUNNEL_BUILD}`, SUPPORTED_DEVTUNNEL_BUILD],
	[`Tunnel CLI version: ${LEGACY_UNSUPPORTED_DEVTUNNEL_BUILD}`, LEGACY_UNSUPPORTED_DEVTUNNEL_BUILD],
]);

export class DevTunnelCliProvider implements DevTunnelProvider {
	private readonly architecture: string;
	private readonly binaryVerifier: (executable: string) => Promise<boolean>;
	private commandRunner: DevTunnelCommandRunner | undefined;
	private readonly commandRunnerFactory: (
		allowedExecutableBasename: string,
	) => DevTunnelCommandRunner;
	private readonly executable: string;
	private readonly healthProbe: typeof probeDevTunnelHealth;
	private readonly localHealthProbe: typeof probeLoopbackHealth;
	private readonly maxRestartAttempts: number;
	private readonly now: () => Date;
	private readonly platform: NodeJS.Platform;
	private readonly random: () => number;
	private readonly resolveExecutable: (executable: string) => Promise<string>;
	private readonly restartBaseDelayMs: number;
	private readonly restartMaxDelayMs: number;
	private readonly showPollIntervalMs: number;
	private readonly showTimeoutMs: number;
	private readonly stateStore: DevTunnelStateStore;
	private readonly wssProbe: typeof probeDevTunnelWss;

	private ensurePromise: Promise<HostedTunnel> | undefined;
	private inFlightRequest: TunnelRequest | undefined;
	private host: OwnedChildProcess | undefined;
	private hostStartPromise: Promise<OwnedChildProcess> | undefined;
	private lifecycleGeneration = 0;
	private lifecycleAbortController: AbortController | undefined;
	private lifecycleMutationTail: Promise<void> = Promise.resolve();
	private metadata: TunnelMetadata | undefined;
	private renewalGeneration: number | undefined;
	private renewalPromise: Promise<TunnelMetadata> | undefined;
	private request: TunnelRequest | undefined;
	private restartAttempt = 0;
	private restartTimer: NodeJS.Timeout | undefined;
	private status: DevTunnelRuntimeStatus = { state: 'idle' };
	private stopRequested = false;
	private trustedExecutable: string | undefined;

	constructor(options: DevTunnelCliProviderOptions) {
		this.architecture = options.architecture ?? process.arch;
		this.binaryVerifier = options.binaryVerifier ?? verifyOfficialExecutable;
		this.commandRunner = options.commandRunner;
		this.commandRunnerFactory = options.commandRunnerFactory ?? (
			(allowedExecutableBasename) => new ChildProcessRunner({
				allowedExecutableBasenames: [allowedExecutableBasename],
			})
		);
		this.executable = options.executable ?? '';
		this.healthProbe = options.healthProbe ?? probeDevTunnelHealth;
		this.localHealthProbe = options.localHealthProbe ?? probeLoopbackHealth;
		this.maxRestartAttempts = options.maxRestartAttempts ?? 5;
		this.now = options.now ?? (() => new Date());
		this.platform = options.platform ?? process.platform;
		this.random = options.random ?? Math.random;
		this.resolveExecutable = options.resolveExecutable ?? resolveExecutablePath;
		this.restartBaseDelayMs = options.restartBaseDelayMs ?? 500;
		this.restartMaxDelayMs = options.restartMaxDelayMs ?? 30_000;
		this.showPollIntervalMs = options.showPollIntervalMs ?? 250;
		this.showTimeoutMs = options.showTimeoutMs ?? 20_000;
		this.stateStore = options.stateStore;
		this.wssProbe = options.wssProbe ?? probeDevTunnelWss;
		for (const [name, value] of [
			['maxRestartAttempts', this.maxRestartAttempts],
			['restartBaseDelayMs', this.restartBaseDelayMs],
			['restartMaxDelayMs', this.restartMaxDelayMs],
			['showPollIntervalMs', this.showPollIntervalMs],
			['showTimeoutMs', this.showTimeoutMs],
		] as const) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new RangeError(`${name} must be a positive safe integer.`);
			}
		}
	}

	getStatus(): DevTunnelRuntimeStatus {
		return this.status;
	}

	async probe(signal?: AbortSignal): Promise<TunnelCapability> {
		if (this.platform !== 'darwin' || this.architecture !== 'arm64') {
			return {
				loggedIn: false,
				supported: false,
				reason: 'CLI_UNSUPPORTED',
			};
		}
		let trustedExecutable: string;
		try {
			trustedExecutable = await this.resolveExecutable(this.executable);
			throwIfAborted(signal);
			if (!await this.binaryVerifier(trustedExecutable)) {
				return {
					loggedIn: false,
					supported: false,
					reason: 'CLI_UNSUPPORTED',
				};
			}
			throwIfAborted(signal);
		} catch {
			return {
				loggedIn: false,
				supported: false,
				reason: 'CLI_UNSUPPORTED',
			};
		}
		this.trustedExecutable = trustedExecutable;
		this.commandRunner ??= this.commandRunnerFactory(basename(trustedExecutable));
		let version: ChildProcessResult;
		try {
			version = await this.run(['--version'], 15_000, 32 * 1024, signal);
		} catch {
			return {
				loggedIn: false,
				supported: false,
				reason: 'CLI_UNSUPPORTED',
			};
		}
		const build = decodeVersion(version.stdout);
		let loggedIn = false;
		try {
			await this.run(['user', 'show'], 15_000, 32 * 1024, signal);
			loggedIn = true;
		} catch {
			loggedIn = false;
		}
		const binarySupported = build === SUPPORTED_DEVTUNNEL_BUILD;
		return {
			build,
			loggedIn,
			supported: binarySupported && loggedIn,
			reason: !binarySupported
				? 'CLI_UNSUPPORTED'
				: loggedIn ? undefined : 'LOGIN_REQUIRED',
		};
	}

	ensureHosted(request: TunnelRequest): Promise<HostedTunnel> {
		try {
			validateRequest(request);
			if (this.status.state === 'ready') {
				validateEquivalentRequest(this.request, request);
				return Promise.resolve(this.status.tunnel);
			}
			if (this.ensurePromise !== undefined) {
				validateEquivalentRequest(this.inFlightRequest, request);
				return this.ensurePromise;
			}
			if (this.status.state === 'circuit-open') {
				return Promise.reject(permanent(
					this.status.code,
					this.status.message ?? 'The Dev Tunnel circuit breaker is open.',
				));
			}
		} catch (error: unknown) {
			return Promise.reject(error);
		}
		const ownedRequest = { ...request };
		this.inFlightRequest = ownedRequest;
		this.ensurePromise = this.ensureHostedOnce(ownedRequest).finally(() => {
			this.ensurePromise = undefined;
			this.inFlightRequest = undefined;
		});
		return this.ensurePromise;
	}

	async renewAccess(): Promise<TunnelMetadata> {
		const generation = this.lifecycleGeneration;
		const signal = this.lifecycleAbortController?.signal;
		if (signal === undefined) {
			throw permanent('HOST_START_FAILED', 'No active Dev Tunnel lifecycle can renew access.');
		}
		this.assertLifecycleActive(generation);
		if (
			this.renewalPromise !== undefined
			&& this.renewalGeneration === generation
		) {
			return this.renewalPromise;
		}
		const renewal = this.withLifecycleMutation(
			() => this.renewAccessOnce(generation, signal),
		);
		const tracked = renewal.finally(() => {
			if (this.renewalPromise === tracked) {
				this.renewalGeneration = undefined;
				this.renewalPromise = undefined;
			}
		});
		this.renewalGeneration = generation;
		this.renewalPromise = tracked;
		return tracked;
	}

	private async renewAccessOnce(
		generation: number,
		signal: AbortSignal,
	): Promise<TunnelMetadata> {
		this.assertLifecycleActive(generation);
		const metadata = await this.stateStore.load();
		this.assertLifecycleActive(generation);
		if (metadata === undefined) {
			throw permanent('TUNNEL_METADATA_INVALID', 'No owned Dev Tunnel metadata exists.');
		}
		if (this.request === undefined) {
			throw permanent('TUNNEL_METADATA_INVALID', 'No owned Dev Tunnel request metadata exists.');
		}
		validateMetadata(metadata, this.request);
		this.metadata = metadata;
		const now = this.now();
		if (new Date(metadata.accessExpiresAt).valueOf() <= now.valueOf()) {
			await this.openCircuitAndStop(
				'TUNNEL_ACCESS_EXPIRED',
				'The owned anonymous access entry has expired.',
			);
			throw permanent('TUNNEL_ACCESS_EXPIRED', 'The owned anonymous access entry has expired.');
		}
		let destructiveRenewalStarted = false;
		try {
			this.assertLifecycleActive(generation);
			const listed = await this.run([
				'access',
				'list',
				metadata.tunnelId,
				'--port-number',
				String(metadata.localPort),
				'--json',
			], commandTimeoutMs, commandMaxOutputBytes, signal);
			decodeDevTunnelAccessListJson(metadata.build, listed.stdout, {
				expectedExpiration: metadata.accessExpiresAt,
				expectedIndex: metadata.accessIndex,
			});
			this.assertLifecycleActive(generation);
			await this.assertExactExecutable(generation, signal);
			this.assertLifecycleActive(generation);
			destructiveRenewalStarted = true;
			const deleted = await this.run([
				'access',
				'delete',
				metadata.tunnelId,
				'--port-number',
				String(metadata.localPort),
				'--index',
				String(metadata.accessIndex),
				'--json',
			], commandTimeoutMs, commandMaxOutputBytes, signal);
			decodeDevTunnelAccessDeleteJson(metadata.build, deleted.stdout);
			const access = await this.createAccess(metadata, generation, signal);
			const renewed: TunnelMetadata = {
				...metadata,
				accessExpiresAt: access.expiresAt,
				accessIndex: access.index,
			};
			this.assertLifecycleActive(generation);
			await this.stateStore.save(renewed);
			this.assertLifecycleActive(generation);
			this.metadata = renewed;
			return renewed;
		} catch (error: unknown) {
			if (!this.lifecycleIsActive(generation)) {
				throw toProviderError(error);
			}
			const providerError = toProviderError(error);
			if (
				!destructiveRenewalStarted
				&& error instanceof DevTunnelProviderError
				&& providerError.code === 'CLI_UNSUPPORTED'
			) {
				await this.openCircuitAndStop(providerError.code, providerError.message);
				throw providerError;
			}
			if (!destructiveRenewalStarted && providerError.retryable) {
				throw providerError;
			}
			const failureMessage = destructiveRenewalStarted
				? 'The owned access entry was revoked but could not be renewed.'
				: 'The existing access entry no longer matches provider ownership metadata.';
			await this.openCircuitAndStop(
				'TUNNEL_ACCESS_EXPIRED',
				failureMessage,
			);
			throw permanent('TUNNEL_ACCESS_EXPIRED', failureMessage);
		}
	}

	async stop(): Promise<void> {
		this.stopRequested = true;
		this.lifecycleAbortController?.abort();
		this.lifecycleAbortController = undefined;
		this.lifecycleGeneration += 1;
		this.clearRestartTimer();
		const pendingHost = this.hostStartPromise;
		if (pendingHost !== undefined) {
			try {
				await pendingHost;
			} catch {
				// A failed spawn has no owned process handle to clean up.
			}
		}
		const host = this.host;
		if (host === undefined) {
			this.status = { state: 'stopped' };
			return;
		}
		try {
			await host.stop();
			if (this.host === host) {
				this.host = undefined;
			}
			this.status = { state: 'stopped' };
		} catch (error: unknown) {
			this.status = {
				state: 'cleanup-failed',
				message: 'The owned Dev Tunnel host could not be stopped; retry stop().',
			};
			throw error;
		}
	}

	dispose(): Promise<void> {
		return this.stop();
	}

	async deleteOwnedForE2e(): Promise<'deleted' | 'already-absent'> {
		if (process.env.MESH_TWO_DEVICE_E2E !== '1') {
			throw new Error('Owned Tunnel deletion is available only to the opted-in two-device E2E.');
		}
		await this.stop();
		const metadata = await this.stateStore.load();
		if (metadata === undefined) {
			return 'already-absent';
		}
		if (
			metadata.build !== SUPPORTED_DEVTUNNEL_BUILD
			|| metadata.decoderRevision !== DEVTUNNEL_DECODER_REVISION
			|| !metadata.ownershipLabel.startsWith('copilot-agent-mesh-')
			|| !metadata.tunnelId.startsWith(`${metadata.tunnelAlias}.`)
		) {
			throw permanent(
				'TUNNEL_METADATA_INVALID',
				'The persisted Tunnel does not satisfy exact owned-resource deletion invariants.',
			);
		}
		const capability = await this.probe();
		if (!capability.supported || capability.build !== metadata.build) {
			throw permanent('CLI_UNSUPPORTED', 'The exact trusted Dev Tunnel CLI is unavailable for cleanup.');
		}
		const shown = await this.run(
			['show', metadata.tunnelId, '--json'],
			commandTimeoutMs,
			commandMaxOutputBytes,
			undefined,
			[2],
		);
		if (isExactDevTunnelNotFound(metadata.build, shown, metadata.tunnelId)) {
			return 'already-absent';
		}
		if (shown.exitCode !== 0) {
			throw transient('CLI_COMMAND_FAILED', 'Owned Tunnel cleanup could not inspect the exact resource.');
		}
		decodeDevTunnelShowJson(metadata.build, shown.stdout, {
			expectedOwnershipLabel: metadata.ownershipLabel,
			expectedPort: metadata.localPort,
			expectedTunnelId: metadata.tunnelId,
			requireForwardingUri: false,
		});
		await this.run(['delete', metadata.tunnelId]);
		const deadline = Date.now() + commandTimeoutMs;
		do {
			const confirmation = await this.run(
				['show', metadata.tunnelId, '--json'],
				commandTimeoutMs,
				commandMaxOutputBytes,
				undefined,
				[2],
			);
			if (isExactDevTunnelNotFound(metadata.build, confirmation, metadata.tunnelId)) {
				return 'deleted';
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		} while (Date.now() < deadline);
		throw transient(
			'CLI_COMMAND_FAILED',
			'Owned Tunnel deletion was not confirmed by the exact versioned not-found response.',
		);
	}

	private async ensureHostedOnce(request: TunnelRequest): Promise<HostedTunnel> {
		this.stopRequested = false;
		const generation = ++this.lifecycleGeneration;
		const abortController = new AbortController();
		this.lifecycleAbortController = abortController;
		const signal = abortController.signal;
		this.status = { state: 'starting' };
		let hostStartAttempted = false;
		try {
			const capability = await this.probe(signal);
			this.assertLifecycleActive(generation);
			if (!capability.supported) {
				if (capability.reason === 'LOGIN_REQUIRED') {
					throw permanent('LOGIN_REQUIRED', 'Dev Tunnel CLI login is required.');
				}
				throw permanent(
					'CLI_UNSUPPORTED',
					`Dev Tunnel requires the official darwin/arm64 ${SUPPORTED_DEVTUNNEL_BUILD} executable; no global CLI upgrade was attempted.`,
				);
			}

			let metadata = await this.stateStore.load();
			this.assertLifecycleActive(generation);
			if (metadata !== undefined) {
				validateMetadata(metadata, request);
			}
			await this.localHealthProbe(request.localPort, request.healthPath, { signal });
			this.assertLifecycleActive(generation);
			let portExists = false;
			if (metadata !== undefined) {
				portExists = await this.validateExistingTunnel(metadata, generation, signal);
			} else {
				metadata = await this.createTunnel(request, generation, signal);
			}
			this.assertLifecycleActive(generation);
			this.metadata = metadata;
			this.request = request;

			if (!metadata.provisioned) {
				metadata = await this.provisionPortAndAccess(metadata, portExists, generation, signal);
			}
			const accessExpiresAt = new Date(metadata.accessExpiresAt);
			if (!Number.isFinite(accessExpiresAt.valueOf()) || accessExpiresAt.valueOf() <= this.now().valueOf()) {
				throw permanent('TUNNEL_ACCESS_EXPIRED', 'The owned anonymous access entry has expired.');
			}
			if (accessExpiresAt.valueOf() - this.now().valueOf() <= renewalWindowMs) {
				this.metadata = metadata;
				metadata = await this.renewAccess();
			}

			hostStartAttempted = true;
			const hosted = await this.startAndProbe(request, generation, signal);
			this.assertLifecycleActive(generation);
			this.metadata = hosted;
			this.restartAttempt = 0;
			this.status = { state: 'ready', tunnel: hosted };
			return hosted;
		} catch (error: unknown) {
			const providerError = toProviderError(error);
			const lifecycleActive = this.lifecycleIsActive(generation);
			const cleanupFailed = this.getStatus().state === 'cleanup-failed';
			if (
				lifecycleActive
				&& !cleanupFailed
				&& !providerError.retryable
			) {
				this.openCircuit(providerError.code, providerError.message);
			} else if (
				lifecycleActive
				&& !cleanupFailed
				&& hostStartAttempted
				&& this.metadata !== undefined
				&& this.request !== undefined
			) {
				this.scheduleRestart(generation);
			}
			throw providerError;
		}
	}

	private async createTunnel(
		request: TunnelRequest,
		generation: number,
		signal: AbortSignal,
	): Promise<TunnelMetadata> {
		this.assertLifecycleActive(generation);
		const created = await this.run([
			'create',
			request.tunnelAlias,
			'--labels',
			request.ownershipLabel,
			'--expiration',
			request.tunnelExpiration,
			'--json',
		], commandTimeoutMs, commandMaxOutputBytes, signal);
		const decoded = decodeDevTunnelCreateJson(
			SUPPORTED_DEVTUNNEL_BUILD,
			created.stdout,
			request.tunnelAlias,
			request.ownershipLabel,
		);
		const now = this.now();
		const metadata: TunnelMetadata = {
			accessDuration: request.accessDuration,
			accessExpiresAt: now.toISOString(),
			accessIndex: 0,
			build: SUPPORTED_DEVTUNNEL_BUILD,
			decoderRevision: DEVTUNNEL_DECODER_REVISION,
			localPort: request.localPort,
			ownershipLabel: request.ownershipLabel,
			provisioned: false,
			tunnelAlias: request.tunnelAlias,
			tunnelExpiresAt: addDuration(now, request.tunnelExpiration).toISOString(),
			tunnelId: decoded.tunnelId,
		};
		this.assertLifecycleActive(generation);
		await this.stateStore.save(metadata);
		this.assertLifecycleActive(generation);
		return metadata;
	}

	private async provisionPortAndAccess(
		metadata: TunnelMetadata,
		portExists: boolean,
		generation: number,
		signal: AbortSignal,
	): Promise<TunnelMetadata> {
		let access: { readonly expiresAt: string; readonly index: number } | undefined;
		if (!portExists) {
			this.assertLifecycleActive(generation);
			const port = await this.run([
				'port',
				'create',
				metadata.tunnelId,
				'--port-number',
				String(metadata.localPort),
				'--protocol',
				'http',
				'--json',
			], commandTimeoutMs, commandMaxOutputBytes, signal);
			decodeDevTunnelPortCreateJson(
				metadata.build,
				port.stdout,
				metadata.tunnelId,
				metadata.localPort,
			);
			this.assertLifecycleActive(generation);
			await this.stateStore.save(metadata);
			this.assertLifecycleActive(generation);
		} else {
			this.assertLifecycleActive(generation);
			const listed = await this.run([
				'access',
				'list',
				metadata.tunnelId,
				'--port-number',
				String(metadata.localPort),
				'--json',
			], commandTimeoutMs, commandMaxOutputBytes, signal);
			this.assertLifecycleActive(generation);
			access = decodeDevTunnelAccessListForAdoptionJson(
				metadata.build,
				listed.stdout,
				this.now(),
			);
		}
		access ??= await this.createAccess(metadata, generation, signal);
		const provisioned: TunnelMetadata = {
			...metadata,
			accessExpiresAt: access.expiresAt,
			accessIndex: access.index,
			provisioned: true,
		};
		this.assertLifecycleActive(generation);
		await this.stateStore.save(provisioned);
		this.assertLifecycleActive(generation);
		this.metadata = provisioned;
		return provisioned;
	}

	private async createAccess(
		metadata: TunnelMetadata,
		generation: number,
		signal: AbortSignal,
	) {
		this.assertLifecycleActive(generation);
		const access = await this.run([
			'access',
			'create',
			metadata.tunnelId,
			'--port-number',
			String(metadata.localPort),
			'--anonymous',
			'--expiration',
			metadata.accessDuration,
			'--json',
		], commandTimeoutMs, commandMaxOutputBytes, signal);
		this.assertLifecycleActive(generation);
		return decodeDevTunnelAccessCreateJson(metadata.build, access.stdout, this.now());
	}

	private async validateExistingTunnel(
		metadata: TunnelMetadata,
		generation: number,
		signal: AbortSignal,
	): Promise<boolean> {
		this.assertLifecycleActive(generation);
		const shown = await this.showTunnel(metadata, signal);
		this.assertLifecycleActive(generation);
		const decoded = decodeDevTunnelShowJson(metadata.build, shown.stdout, {
			allowMissingPort: !metadata.provisioned,
			expectedOwnershipLabel: metadata.ownershipLabel,
			expectedPort: metadata.localPort,
			expectedTunnelId: metadata.tunnelId,
			requireForwardingUri: false,
		});
		return decoded.portExists;
	}

	private async startAndProbe(
		request: TunnelRequest,
		generation: number,
		signal: AbortSignal,
	): Promise<HostedTunnel> {
		return this.withLifecycleMutation(async () => {
			this.assertLifecycleActive(generation);
			let metadata = await this.stateStore.load();
			this.assertLifecycleActive(generation);
			if (metadata === undefined) {
				throw permanent('TUNNEL_METADATA_INVALID', 'No owned Dev Tunnel metadata exists.');
			}
			validateMetadata(metadata, request);
			this.metadata = metadata;
			const accessExpiresAt = new Date(metadata.accessExpiresAt);
			if (!Number.isFinite(accessExpiresAt.valueOf()) || accessExpiresAt.valueOf() <= this.now().valueOf()) {
				throw permanent('TUNNEL_ACCESS_EXPIRED', 'The owned anonymous access entry has expired.');
			}
			if (accessExpiresAt.valueOf() - this.now().valueOf() <= renewalWindowMs) {
				metadata = await this.renewAccessOnce(generation, signal);
			}
			const hosted = await this.startAndProbeLocked(metadata, request, generation, signal);
			this.metadata = hosted;
			return hosted;
		});
	}

	private async startAndProbeLocked(
		metadata: TunnelMetadata,
		request: TunnelRequest,
		generation: number,
		signal: AbortSignal,
	): Promise<HostedTunnel> {
		this.assertLifecycleActive(generation);
		if (this.host !== undefined) {
			throw permanent('HOST_START_FAILED', 'An owned Dev Tunnel host is already running.');
		}
		await this.validateHostFallbackInvariant(metadata, generation, signal);
		this.assertLifecycleActive(generation);
		if (!await this.binaryVerifier(this.requireTrustedExecutable())) {
			throw permanent(
				'CLI_UNSUPPORTED',
				'The Dev Tunnel executable changed after its exact-build probe; host fallback was blocked.',
			);
		}
		this.assertLifecycleActive(generation);
		const hostStart = this.requireCommandRunner().startOwned(
			this.requireTrustedExecutable(),
			['host', metadata.tunnelId],
		);
		this.hostStartPromise = hostStart;
		let host: OwnedChildProcess;
		try {
			host = await hostStart;
		} finally {
			if (this.hostStartPromise === hostStart) {
				this.hostStartPromise = undefined;
			}
		}
		this.host = host;
		if (!this.lifecycleIsActive(generation)) {
			await this.stopHostOrMarkCleanupFailed(host);
			this.assertLifecycleActive(generation);
		}
		let readyPublished = false;
		let hostExited = false;
		const hostExit = host.exit.then(() => {
			hostExited = true;
			if (
				readyPublished
				&& this.host === host
				&& this.lifecycleIsActive(generation)
				&& this.status.state !== 'circuit-open'
			) {
				this.host = undefined;
				this.scheduleRestart(generation);
			}
		});
		const readinessAbortController = new AbortController();
		const abortReadiness = (): void => readinessAbortController.abort();
		signal.addEventListener('abort', abortReadiness, { once: true });
		if (signal.aborted) {
			abortReadiness();
		}
		const readiness = this.discoverAndProbe(
			metadata,
			request,
			generation,
			readinessAbortController.signal,
		);
		let forwardingOrigin: string;
		try {
			forwardingOrigin = await Promise.race([
				readiness,
				hostExit.then(() => {
					throw transient(
						'HOST_START_FAILED',
						`Dev Tunnel ${metadata.build} exited before the strictly validated fixed port became ready.`,
					);
				}),
			]);
		} catch (error: unknown) {
			abortReadiness();
			await readiness.catch(() => undefined);
			if (this.host === host) {
				await this.stopHostOrMarkCleanupFailed(host);
			}
			throw error;
		} finally {
			signal.removeEventListener('abort', abortReadiness);
		}
		try {
			if (!this.lifecycleIsActive(generation)) {
				throw permanent('HOST_START_FAILED', 'Dev Tunnel hosting was stopped before readiness.');
			}
			const hosted: HostedTunnel = {
				...metadata,
				forwardingOrigin,
				status: 'ready',
			};
			this.assertLifecycleActive(generation);
			await this.stateStore.save(hosted);
			this.assertLifecycleActive(generation);
			if (hostExited) {
				throw transient(
					'HOST_START_FAILED',
					`Dev Tunnel ${metadata.build} exited after readiness but before the host became authoritative.`,
				);
			}
			readyPublished = true;
			return hosted;
		} catch (error: unknown) {
			if (this.host === host) {
				await this.stopHostOrMarkCleanupFailed(host);
			}
			throw error;
		}
	}

	private async validateHostFallbackInvariant(
		metadata: TunnelMetadata,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		if (metadata.build !== SUPPORTED_DEVTUNNEL_BUILD) {
			throw permanent('CLI_UNSUPPORTED', 'The port-safe host fallback is not validated for this build.');
		}
		this.assertLifecycleActive(generation);
		const shown = await this.showTunnel(metadata, signal);
		this.assertLifecycleActive(generation);
		decodeDevTunnelShowJson(metadata.build, shown.stdout, {
			expectedOwnershipLabel: metadata.ownershipLabel,
			expectedPort: metadata.localPort,
			expectedTunnelId: metadata.tunnelId,
			requireForwardingUri: false,
		});
		this.assertLifecycleActive(generation);
		const listed = await this.run([
			'access',
			'list',
			metadata.tunnelId,
			'--port-number',
			String(metadata.localPort),
			'--json',
		], commandTimeoutMs, commandMaxOutputBytes, signal);
		this.assertLifecycleActive(generation);
		decodeDevTunnelAccessListJson(metadata.build, listed.stdout, {
			expectedExpiration: metadata.accessExpiresAt,
			expectedIndex: metadata.accessIndex,
		});
	}

	private async assertExactExecutable(
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		this.assertLifecycleActive(generation);
		if (!await this.binaryVerifier(this.requireTrustedExecutable())) {
			throw permanent(
				'CLI_UNSUPPORTED',
				'The Dev Tunnel executable hash changed before a protected lifecycle mutation.',
			);
		}
		this.assertLifecycleActive(generation);
		const version = await this.run(['--version'], 15_000, 32 * 1024, signal);
		this.assertLifecycleActive(generation);
		if (decodeVersion(version.stdout) !== SUPPORTED_DEVTUNNEL_BUILD) {
			throw permanent(
				'CLI_UNSUPPORTED',
				'The Dev Tunnel executable build changed before a protected lifecycle mutation.',
			);
		}
	}

	private async discoverAndProbe(
		metadata: TunnelMetadata,
		request: TunnelRequest,
		generation: number,
		signal: AbortSignal,
	): Promise<string> {
		const deadline = Date.now() + this.showTimeoutMs;
		let lastReadinessError: DevTunnelProviderError | undefined;
		while (Date.now() < deadline) {
			this.assertLifecycleActive(generation);
			const shown = await this.showTunnel(metadata, signal);
			const decoded = decodeDevTunnelShowJson(metadata.build, shown.stdout, {
				expectedOwnershipLabel: metadata.ownershipLabel,
				expectedPort: metadata.localPort,
				expectedTunnelId: metadata.tunnelId,
				requireForwardingUri: false,
			});
			if (decoded.forwardingOrigin !== undefined) {
				try {
					await this.healthProbe(
						decoded.forwardingOrigin,
						request.healthPath,
						{ signal },
					);
					await this.wssProbe(
						decoded.forwardingOrigin,
						request.wssPath,
						request.wssProbeRequest,
						request.wssExpectedResponse,
						{ signal },
					);
					this.assertLifecycleActive(generation);
					return decoded.forwardingOrigin;
				} catch (error: unknown) {
					const providerError = toProviderError(error);
					if (!providerError.retryable) {
						throw providerError;
					}
					lastReadinessError = providerError;
				}
			}
			await delay(this.showPollIntervalMs, signal);
		}
		throw lastReadinessError ?? transient(
			'HTTPS_HEALTH_FAILED',
			'Dev Tunnel did not publish a forwarding URI before timeout.',
		);
	}

	private scheduleRestart(generation: number): void {
		if (
			this.stopRequested
			|| generation !== this.lifecycleGeneration
			|| this.status.state === 'circuit-open'
		) {
			return;
		}
		this.restartAttempt += 1;
		if (this.restartAttempt > this.maxRestartAttempts) {
			this.openCircuit('HOST_CIRCUIT_OPEN', 'The owned Dev Tunnel host exceeded its restart limit.');
			return;
		}
		const ceiling = Math.min(
			this.restartMaxDelayMs,
			this.restartBaseDelayMs * (2 ** (this.restartAttempt - 1)),
		);
		const delayMs = Math.floor(this.random() * ceiling);
		const retryAt = new Date(this.now().valueOf() + delayMs).toISOString();
		this.assertLifecycleActive(generation);
		this.status = { state: 'backoff', attempt: this.restartAttempt, retryAt };
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			void this.restart(generation);
		}, delayMs);
	}

	private async restart(generation: number): Promise<void> {
		const request = this.request;
		const signal = this.lifecycleAbortController?.signal;
		if (
			this.metadata === undefined
			|| request === undefined
			|| signal === undefined
			|| this.stopRequested
			|| generation !== this.lifecycleGeneration
		) {
			return;
		}
		try {
			const hosted = await this.startAndProbe(request, generation, signal);
			this.assertLifecycleActive(generation);
			this.metadata = hosted;
			this.restartAttempt = 0;
			this.status = { state: 'ready', tunnel: hosted };
		} catch (error: unknown) {
			const providerError = toProviderError(error);
			const lifecycleActive = this.lifecycleIsActive(generation);
			if (!lifecycleActive) {
				return;
			}
			if (this.status.state === 'cleanup-failed') {
				return;
			}
			if (!providerError.retryable) {
				this.openCircuit(providerError.code, providerError.message);
				return;
			}
			this.scheduleRestart(generation);
		}
	}

	private openCircuit(code: DevTunnelProviderError['code'], message?: string): void {
		this.clearRestartTimer();
		this.lifecycleAbortController?.abort();
		this.status = { state: 'circuit-open', code, message };
	}

	private async openCircuitAndStop(
		code: DevTunnelProviderError['code'],
		message: string,
	): Promise<void> {
		this.lifecycleGeneration += 1;
		this.lifecycleAbortController?.abort();
		this.openCircuit(code, message);
		const host = this.host;
		if (host !== undefined) {
			try {
				await host.stop();
				if (this.host === host) {
					this.host = undefined;
				}

			} catch (error: unknown) {
				this.status = {
					state: 'cleanup-failed',
					message: 'The owned Dev Tunnel host could not be stopped; retry stop().',
				};
				throw error;
			}
		}
	}

	private async stopHostOrMarkCleanupFailed(host: OwnedChildProcess): Promise<void> {
		try {
			await host.stop();
			if (this.host === host) {
				this.host = undefined;
			}
		} catch (error: unknown) {
			this.status = {
				state: 'cleanup-failed',
				message: 'The owned Dev Tunnel host could not be stopped; retry stop().',
			};
			throw error;
		}
	}

	private clearRestartTimer(): void {
		if (this.restartTimer !== undefined) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
	}

	private async run(
		args: readonly string[],
		timeoutMs = commandTimeoutMs,
		maxOutputBytes = commandMaxOutputBytes,
		signal?: AbortSignal,
		acceptedExitCodes?: readonly number[],
	): Promise<ChildProcessResult> {
		try {
			return await this.requireCommandRunner().run(this.requireTrustedExecutable(), args, {
				acceptedExitCodes,
				timeoutMs,
				maxOutputBytes,
				signal,
			});
		} catch (error) {
			if (error instanceof ChildProcessExecutionError) {
				throw new DevTunnelCommandFailure(args[0] ?? 'unknown', error);
			}
			throw error;
		}
	}

	private async showTunnel(
		metadata: TunnelMetadata,
		signal: AbortSignal,
	): Promise<ChildProcessResult> {
		const shown = await this.run(
			['show', metadata.tunnelId, '--json'],
			commandTimeoutMs,
			commandMaxOutputBytes,
			signal,
			[2],
		);
		if (shown.exitCode === 0) {
			return shown;
		}

		if (isExactDevTunnelNotFound(metadata.build, shown, metadata.tunnelId)) {
			throw permanent(
				'TUNNEL_NOT_FOUND',
				'The persistent owned tunnel is unavailable; explicit recreation and peer re-pairing are required.',
			);
		}
		throw transient(
			'CLI_COMMAND_FAILED',
			'Dev Tunnel show failed without the exact versioned not-found response.',
		);
	}

	private async withLifecycleMutation<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.lifecycleMutationTail;
		let release: (() => void) | undefined;
		this.lifecycleMutationTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release?.();
		}
	}

	private lifecycleIsActive(generation: number): boolean {
		return !this.stopRequested
			&& generation === this.lifecycleGeneration
			&& this.lifecycleAbortController?.signal.aborted === false;
	}

	private assertLifecycleActive(generation: number): void {
		if (!this.lifecycleIsActive(generation)) {
			throw permanent('HOST_START_FAILED', 'The Dev Tunnel lifecycle was stopped.');
		}
	}

	private requireTrustedExecutable(): string {
		if (this.trustedExecutable === undefined) {
			throw permanent('CLI_UNSUPPORTED', 'The Dev Tunnel executable has not passed verification.');
		}
		return this.trustedExecutable;
	}

	private requireCommandRunner(): DevTunnelCommandRunner {
		if (this.commandRunner === undefined) {
			throw permanent('CLI_UNSUPPORTED', 'The trusted Dev Tunnel process runner is unavailable.');
		}
		return this.commandRunner;
	}
}

function decodeVersion(stdout: string): string | undefined {
	const matchingLines = stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => knownVersionLines.has(line));
	if (matchingLines.length !== 1) {
		return undefined;
	}
	return knownVersionLines.get(matchingLines[0]);
}

function validateRequest(request: TunnelRequest): void {
	if (
		!Number.isSafeInteger(request.localPort)
		|| request.localPort < 1
		|| request.localPort > 65_535
	) {
		throw new RangeError('localPort must be a valid TCP port.');
	}
	if (!/^[a-z][a-z0-9]{5,48}$/u.test(request.tunnelAlias)) {
		throw new RangeError('tunnelAlias must be 6-49 lowercase alphanumeric characters.');
	}
	if (!/^copilot-agent-mesh-[a-z0-9-]{1,31}$/u.test(request.ownershipLabel)) {
		throw new RangeError(
			'ownershipLabel must use the Copilot Agent Mesh ownership prefix and fit the 50-character service limit.',
		);
	}
	if (
		!isSafeOriginRelativePath(request.healthPath)
		|| !isSafeOriginRelativePath(request.wssPath)
	) {
		throw new RangeError('Probe paths must be origin-relative paths.');
	}

	function isSafeOriginRelativePath(path: string): boolean {
		if (
			!/^\/(?!\/)/u.test(path)
			|| path.trim() !== path
			|| /[\\?#]/u.test(path)
		) {
			return false;
		}
		const base = new URL('http://127.0.0.1');
		return new URL(path, base).origin === base.origin;
	}
	parseDuration(request.accessDuration);
	parseDuration(request.tunnelExpiration);
}

function validateMetadata(metadata: TunnelMetadata, request: TunnelRequest): void {
	if (
		metadata.build !== SUPPORTED_DEVTUNNEL_BUILD
		|| metadata.decoderRevision !== DEVTUNNEL_DECODER_REVISION
		|| metadata.tunnelAlias !== request.tunnelAlias
		|| metadata.ownershipLabel !== request.ownershipLabel
		|| !metadata.tunnelId.startsWith(`${request.tunnelAlias}.`)
	) {
		throw permanent('TUNNEL_METADATA_INVALID', 'Persisted Dev Tunnel ownership metadata is invalid.');
	}
	if (metadata.localPort !== request.localPort) {
		throw permanent(
			'PORT_MIGRATION_REQUIRED',
			'The persisted Dev Tunnel port differs from the requested port; explicit migration and peer re-pairing are required.',
		);
	}
}

function validateEquivalentRequest(
	current: TunnelRequest | undefined,
	request: TunnelRequest,
): void {
	if (current === undefined) {
		throw permanent('TUNNEL_METADATA_INVALID', 'The ready Dev Tunnel request metadata is unavailable.');
	}
	if (current.localPort !== request.localPort) {
		throw permanent(
			'PORT_MIGRATION_REQUIRED',
			'The ready Dev Tunnel uses another port; explicit migration and peer re-pairing are required.',
		);
	}
	if (
		current.accessDuration !== request.accessDuration
		|| current.healthPath !== request.healthPath
		|| current.ownershipLabel !== request.ownershipLabel
		|| current.tunnelAlias !== request.tunnelAlias
		|| current.tunnelExpiration !== request.tunnelExpiration
		|| current.wssExpectedResponse !== request.wssExpectedResponse
		|| current.wssPath !== request.wssPath
		|| current.wssProbeRequest !== request.wssProbeRequest
	) {
		throw permanent(
			'TUNNEL_METADATA_INVALID',
			'A different Dev Tunnel request cannot replace the ready owned host.',
		);
	}
}

function addDuration(date: Date, duration: `${number}h` | `${number}d`): Date {
	return new Date(date.valueOf() + parseDuration(duration));
}

function parseDuration(duration: `${number}h` | `${number}d`): number {
	const match = /^([1-9][0-9]*)([hd])$/u.exec(duration);
	if (match === null) {
		throw new RangeError('Dev Tunnel duration must be a positive hour or day value.');
	}
	const amount = Number(match[1]);
	const multiplier = match[2] === 'h' ? 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000;
	const milliseconds = amount * multiplier;
	if (!Number.isSafeInteger(milliseconds)) {
		throw new RangeError('Dev Tunnel duration is too large.');
	}
	return milliseconds;
}

function toProviderError(error: unknown): DevTunnelProviderError {
	if (error instanceof DevTunnelProviderError) {
		return error;
	}
	if (error instanceof DevTunnelCommandFailure) {
		if (error.execution.code === 'PROCESS_TIMEOUT') {
			return transient('CLI_COMMAND_FAILED', `The Dev Tunnel CLI ${error.operation} command timed out.`);
		}
		if (error.execution.code === 'PROCESS_EXIT_NONZERO') {
			return transient(
				'CLI_COMMAND_FAILED',
				`The Dev Tunnel CLI ${error.operation} command failed transiently.`,
			);
		}
		return permanent('CLI_COMMAND_FAILED', `The Dev Tunnel CLI ${error.operation} command failed.`);
	}
	if (error instanceof ChildProcessExecutionError) {
		if (error.code === 'PROCESS_TIMEOUT') {
			return transient('CLI_COMMAND_FAILED', 'The Dev Tunnel CLI command timed out.');
		}
		if (error.code === 'PROCESS_EXIT_NONZERO') {
			return transient('CLI_COMMAND_FAILED', 'The Dev Tunnel CLI command failed transiently.');
		}
		return permanent('CLI_COMMAND_FAILED', 'The Dev Tunnel CLI command failed.');
	}
	if (error instanceof DevTunnelDecodeError) {
		return permanent(
			'CLI_UNSUPPORTED',
			`Dev Tunnel ${DEVTUNNEL_DECODER_REVISION} rejected the CLI response (${error.code}): ${error.message}`,
		);
	}
	return permanent('CLI_COMMAND_FAILED', 'The Dev Tunnel provider rejected an incompatible response.');
}

function permanent(
	code: DevTunnelProviderError['code'],
	message: string,
): DevTunnelProviderError {
	return new DevTunnelProviderError(code, message, false);
}

function transient(
	code: DevTunnelProviderError['code'],
	message: string,
): DevTunnelProviderError {
	return new DevTunnelProviderError(code, message, true);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted === true) {
		return Promise.reject(new ChildProcessExecutionError(
			'PROCESS_ABORTED',
			'The Dev Tunnel lifecycle was cancelled.',
		));
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', abort);
			resolve();
		}, milliseconds);
		const abort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			reject(new ChildProcessExecutionError(
				'PROCESS_ABORTED',
				'The Dev Tunnel lifecycle was cancelled.',
			));
		};
		signal?.addEventListener('abort', abort, { once: true });
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) {
		throw new ChildProcessExecutionError(
			'PROCESS_ABORTED',
			'The Dev Tunnel lifecycle was cancelled.',
		);
	}
}

async function verifyOfficialExecutable(path: string): Promise<boolean> {
	const hash = createHash('sha256');
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.once('error', reject);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.once('end', resolve);
	});
	return hash.digest('hex') === DEVTUNNEL_EXECUTABLE_SHA256;
}

async function resolveExecutablePath(executable: string): Promise<string> {
	if (executable.length === 0) {
		throw new Error('An explicit Dev Tunnel executable path is required.');
	}
	if (!isAbsolute(executable) && !executable.includes('/') && !executable.includes('\\')) {
		throw new Error('Dev Tunnel executable discovery through PATH is not supported.');
	}
	return realpath(executable);
}
