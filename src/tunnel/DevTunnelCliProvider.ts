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
	decodeDevTunnelCreateJson,
	decodeDevTunnelPortCreateJson,
	decodeDevTunnelShowJson,
	DevTunnelDecodeError,
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
import { delimiter, isAbsolute, join } from 'node:path';

interface DevTunnelCommandRunner {
	run(
		executable: string,
		args: readonly string[],
		options?: ChildProcessRunOptions,
	): Promise<ChildProcessResult>;
	startOwned(executable: string, args: readonly string[]): Promise<OwnedChildProcess>;
}

export interface DevTunnelCliProviderOptions {
	readonly architecture?: string;
	readonly binaryVerifier?: (executable: string) => Promise<boolean>;
	readonly commandRunner?: DevTunnelCommandRunner;
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
	private readonly commandRunner: DevTunnelCommandRunner;
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
	private lifecycleGeneration = 0;
	private metadata: TunnelMetadata | undefined;
	private request: TunnelRequest | undefined;
	private restartAttempt = 0;
	private restartTimer: NodeJS.Timeout | undefined;
	private status: DevTunnelRuntimeStatus = { state: 'idle' };
	private stopRequested = false;
	private trustedExecutable: string | undefined;

	constructor(options: DevTunnelCliProviderOptions) {
		this.architecture = options.architecture ?? process.arch;
		this.binaryVerifier = options.binaryVerifier ?? verifyOfficialExecutable;
		this.commandRunner = options.commandRunner ?? new ChildProcessRunner();
		this.executable = options.executable ?? 'devtunnel';
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

	async probe(): Promise<TunnelCapability> {
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
			if (!await this.binaryVerifier(trustedExecutable)) {
				return {
					loggedIn: false,
					supported: false,
					reason: 'CLI_UNSUPPORTED',
				};
			}
		} catch {
			return {
				loggedIn: false,
				supported: false,
				reason: 'CLI_UNSUPPORTED',
			};
		}
		this.trustedExecutable = trustedExecutable;
		let version: ChildProcessResult;
		try {
			version = await this.run(['--version'], 15_000, 32 * 1024);
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
			await this.run(['user', 'show'], 15_000, 32 * 1024);
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
		const metadata = this.metadata ?? await this.stateStore.load();
		if (metadata === undefined) {
			throw permanent('TUNNEL_METADATA_INVALID', 'No owned Dev Tunnel metadata exists.');
		}
		const now = this.now();
		if (new Date(metadata.accessExpiresAt).valueOf() <= now.valueOf()) {
			await this.openCircuitAndStop(
				'TUNNEL_ACCESS_EXPIRED',
				'The owned anonymous access entry has expired.',
			);
			throw permanent('TUNNEL_ACCESS_EXPIRED', 'The owned anonymous access entry has expired.');
		}
		try {
			const deleted = await this.run([
				'access',
				'delete',
				metadata.tunnelId,
				'--port-number',
				String(metadata.localPort),
				'--index',
				String(metadata.accessIndex),
				'--json',
			]);
			decodeDevTunnelAccessDeleteJson(metadata.build, deleted.stdout);
			const access = await this.createAccess(metadata);
			const renewed: TunnelMetadata = {
				...metadata,
				accessExpiresAt: access.expiresAt,
				accessIndex: access.index,
			};
			await this.stateStore.save(renewed);
			this.metadata = renewed;
			return renewed;
		} catch (error: unknown) {
			await this.openCircuitAndStop(
				'TUNNEL_ACCESS_EXPIRED',
				'The owned access entry was revoked but could not be renewed.',
			);
			throw error instanceof DevTunnelProviderError
				? error
				: permanent(
					'TUNNEL_ACCESS_EXPIRED',
					'The owned access entry was revoked but could not be renewed.',
				);
		}
	}

	async stop(): Promise<void> {
		this.stopRequested = true;
		this.lifecycleGeneration += 1;
		this.clearRestartTimer();
		const host = this.host;
		this.host = undefined;
		this.status = { state: 'stopped' };
		if (host !== undefined) {
			await host.stop();
		}
	}

	dispose(): Promise<void> {
		return this.stop();
	}

	private async ensureHostedOnce(request: TunnelRequest): Promise<HostedTunnel> {
		this.stopRequested = false;
		const generation = ++this.lifecycleGeneration;
		this.status = { state: 'starting' };
		try {
			const capability = await this.probe();
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
			if (metadata !== undefined) {
				validateMetadata(metadata, request);
			}
			await this.localHealthProbe(request.localPort, request.healthPath);
			let portExists = false;
			if (metadata !== undefined) {
				portExists = await this.validateExistingTunnel(metadata);
			} else {
				metadata = await this.createTunnel(request);
			}
			this.metadata = metadata;
			this.request = request;

			if (!metadata.provisioned) {
				metadata = await this.provisionPortAndAccess(metadata, portExists);
			}
			const accessExpiresAt = new Date(metadata.accessExpiresAt);
			if (!Number.isFinite(accessExpiresAt.valueOf()) || accessExpiresAt.valueOf() <= this.now().valueOf()) {
				throw permanent('TUNNEL_ACCESS_EXPIRED', 'The owned anonymous access entry has expired.');
			}
			if (accessExpiresAt.valueOf() - this.now().valueOf() <= renewalWindowMs) {
				this.metadata = metadata;
				metadata = await this.renewAccess();
			}

			const hosted = await this.startAndProbe(metadata, request, generation);
			this.metadata = hosted;
			this.restartAttempt = 0;
			this.status = { state: 'ready', tunnel: hosted };
			return hosted;
		} catch (error: unknown) {
			const providerError = toProviderError(error);
			if (!providerError.retryable) {
				this.openCircuit(providerError.code, providerError.message);
			}
			const host = this.host;
			this.host = undefined;
			if (host !== undefined) {
				await host.stop();
			}
			throw providerError;
		}
	}

	private async createTunnel(request: TunnelRequest): Promise<TunnelMetadata> {
		const created = await this.run([
			'create',
			request.tunnelAlias,
			'--labels',
			request.ownershipLabel,
			'--expiration',
			request.tunnelExpiration,
			'--json',
		]);
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
		await this.stateStore.save(metadata);
		return metadata;
	}

	private async provisionPortAndAccess(
		metadata: TunnelMetadata,
		portExists: boolean,
	): Promise<TunnelMetadata> {
		if (!portExists) {
			const port = await this.run([
				'port',
				'create',
				metadata.tunnelId,
				'--port-number',
				String(metadata.localPort),
				'--protocol',
				'http',
				'--json',
			]);
			decodeDevTunnelPortCreateJson(
				metadata.build,
				port.stdout,
				metadata.tunnelId,
				metadata.localPort,
			);
			await this.stateStore.save(metadata);
		}
		const access = await this.createAccess(metadata);
		const provisioned: TunnelMetadata = {
			...metadata,
			accessExpiresAt: access.expiresAt,
			accessIndex: access.index,
			provisioned: true,
		};
		await this.stateStore.save(provisioned);
		this.metadata = provisioned;
		return provisioned;
	}

	private async createAccess(metadata: TunnelMetadata) {
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
		]);
		return decodeDevTunnelAccessCreateJson(metadata.build, access.stdout, this.now());
	}

	private async validateExistingTunnel(metadata: TunnelMetadata): Promise<boolean> {
		let shown: ChildProcessResult;
		try {
			shown = await this.run(['show', metadata.tunnelId, '--json']);
		} catch {
			throw permanent(
				'TUNNEL_NOT_FOUND',
				'The persistent owned tunnel is unavailable; explicit recreation and peer re-pairing are required.',
			);
		}
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
		metadata: TunnelMetadata,
		request: TunnelRequest,
		generation: number,
	): Promise<HostedTunnel> {
		if (this.host !== undefined) {
			throw permanent('HOST_START_FAILED', 'An owned Dev Tunnel host is already running.');
		}
		const host = await this.commandRunner.startOwned(
			this.requireTrustedExecutable(),
			['host', metadata.tunnelId],
		);
		this.host = host;
		const readiness = this.discoverAndProbe(metadata, request);
		const forwardingOrigin = await Promise.race([
			readiness,
			host.exit.then(() => {
				throw transient('HOST_START_FAILED', 'The owned Dev Tunnel host exited before readiness.');
			}),
		]);
		if (generation !== this.lifecycleGeneration || this.stopRequested) {
			await host.stop();
			throw permanent('HOST_START_FAILED', 'Dev Tunnel hosting was stopped before readiness.');
		}
		const hosted: HostedTunnel = {
			...metadata,
			forwardingOrigin,
			status: 'ready',
		};
		await this.stateStore.save(hosted);
		this.watchHostExit(host, generation);
		return hosted;
	}

	private async discoverAndProbe(
		metadata: TunnelMetadata,
		request: TunnelRequest,
	): Promise<string> {
		const deadline = Date.now() + this.showTimeoutMs;
		let lastReadinessError: DevTunnelProviderError | undefined;
		while (Date.now() < deadline) {
			const shown = await this.run(['show', metadata.tunnelId, '--json']);
			const decoded = decodeDevTunnelShowJson(metadata.build, shown.stdout, {
				expectedOwnershipLabel: metadata.ownershipLabel,
				expectedPort: metadata.localPort,
				expectedTunnelId: metadata.tunnelId,
				requireForwardingUri: false,
			});
			if (decoded.forwardingOrigin !== undefined) {
				try {
					await this.healthProbe(decoded.forwardingOrigin, request.healthPath);
					await this.wssProbe(
						decoded.forwardingOrigin,
						request.wssPath,
						request.wssProbeRequest,
						request.wssExpectedResponse,
					);
					return decoded.forwardingOrigin;
				} catch (error: unknown) {
					const providerError = toProviderError(error);
					if (!providerError.retryable) {
						throw providerError;
					}
					lastReadinessError = providerError;
				}
			}
			await delay(this.showPollIntervalMs);
		}
		throw lastReadinessError ?? transient(
			'HTTPS_HEALTH_FAILED',
			'Dev Tunnel did not publish a forwarding URI before timeout.',
		);
	}

	private watchHostExit(host: OwnedChildProcess, generation: number): void {
		void host.exit.then(() => {
			if (
				this.host !== host
				|| this.stopRequested
				|| generation !== this.lifecycleGeneration
				|| this.status.state === 'circuit-open'
			) {
				return;
			}
			this.host = undefined;
			this.scheduleRestart(generation);
		});
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
		this.status = { state: 'backoff', attempt: this.restartAttempt, retryAt };
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			void this.restart(generation);
		}, delayMs);
	}

	private async restart(generation: number): Promise<void> {
		const metadata = this.metadata;
		const request = this.request;
		if (
			metadata === undefined
			|| request === undefined
			|| this.stopRequested
			|| generation !== this.lifecycleGeneration
		) {
			return;
		}
		try {
			const hosted = await this.startAndProbe(metadata, request, generation);
			this.metadata = hosted;
			this.restartAttempt = 0;
			this.status = { state: 'ready', tunnel: hosted };
		} catch (error: unknown) {
			const providerError = toProviderError(error);
			const failedHost = this.host;
			this.host = undefined;
			if (failedHost !== undefined) {
				await failedHost.stop().catch(() => undefined);
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
		this.status = { state: 'circuit-open', code, message };
	}

	private async openCircuitAndStop(
		code: DevTunnelProviderError['code'],
		message: string,
	): Promise<void> {
		this.lifecycleGeneration += 1;
		this.openCircuit(code, message);
		const host = this.host;
		this.host = undefined;
		if (host !== undefined) {
			await host.stop();
		}
	}

	private clearRestartTimer(): void {
		if (this.restartTimer !== undefined) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
	}

	private run(
		args: readonly string[],
		timeoutMs = commandTimeoutMs,
		maxOutputBytes = commandMaxOutputBytes,
	): Promise<ChildProcessResult> {
		return this.commandRunner.run(this.requireTrustedExecutable(), args, {
			timeoutMs,
			maxOutputBytes,
		});
	}

	private requireTrustedExecutable(): string {
		if (this.trustedExecutable === undefined) {
			throw permanent('CLI_UNSUPPORTED', 'The Dev Tunnel executable has not passed verification.');
		}
		return this.trustedExecutable;
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
	if (!/^copilot-agent-mesh-[a-z0-9-]{1,48}$/u.test(request.ownershipLabel)) {
		throw new RangeError('ownershipLabel must use the Copilot Agent Mesh ownership prefix.');
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
	if (error instanceof ChildProcessExecutionError) {
		return error.code === 'PROCESS_TIMEOUT'
			? transient('CLI_COMMAND_FAILED', 'The Dev Tunnel CLI command timed out.')
			: permanent('CLI_COMMAND_FAILED', 'The Dev Tunnel CLI command failed.');
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

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
	if (isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
		return realpath(executable);
	}
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		if (directory.length === 0) {
			continue;
		}
		const candidate = join(directory, executable);
		try {
			return await realpath(candidate);
		} catch {
			continue;
		}
	}
	throw new Error('Dev Tunnel executable was not found on PATH.');
}
