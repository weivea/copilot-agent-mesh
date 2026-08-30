import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
	isAbsolute,
	posix,
	win32,
} from 'node:path';

import type WebSocket from 'ws';

import {
	discoverCodeCli,
	type AgentHostProbe,
} from './AgentHostLauncher';
import type { UnixSocketWebSocketConnector } from './UnixSocketWebSocketConnector';
import {
	runOwnedCommand,
	type RunOwnedCommandOptions,
} from '../spikes/ownedProcess';
import {
	registerSensitiveValues,
	type SensitiveValueRegistration,
} from '../security/SensitiveValueRedaction';

const endpointCommandTimeoutMs = 10_000;
const endpointOutputLimitBytes = 1024 * 1024;
const supportedProtocolVersion = '1.0.0';

export type EditorAgentHostLocatorErrorCode =
	| 'CANCELLED'
	| 'COMMAND_FAILED'
	| 'INCOMPATIBLE_PROTOCOL'
	| 'INVALID_ENDPOINT_DOCUMENT'
	| 'MULTIPLE_EDITOR_ENDPOINTS'
	| 'NO_EDITOR_ENDPOINT'
	| 'STALE_EDITOR_ENDPOINT'
	| 'UNSUPPORTED_TRANSPORT'
	| 'USER_DATA_MISMATCH'
	| 'USER_DATA_UNAVAILABLE';

export class EditorAgentHostLocatorError extends Error {
	public constructor(readonly code: EditorAgentHostLocatorErrorCode, message: string) {
		super(message);
		this.name = 'EditorAgentHostLocatorError';
	}
}

export interface EditorAgentHostPlatformContext {
	readonly platform: NodeJS.Platform;
	readonly architecture: string;
	readonly homeDirectory: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly productName: string;
}

export interface EditorAgentHostUserDataStrategy {
	derive(context: EditorAgentHostPlatformContext): string;
}

export interface DerivedEditorAgentHostUserData {
	readonly path: string;
	readonly validatedWorkerHost: boolean;
}

export interface EditorAgentHostLocatorOptions {
	readonly configuredCodeCli?: string;
	readonly configuredUserDataDir?: unknown;
	readonly commandTimeoutMs?: number;
	readonly platform?: Partial<EditorAgentHostPlatformContext>;
}

interface EditorAgentHostLocatorDependencies {
	readonly canonicalize: (path: string) => Promise<string>;
	readonly isProcessAlive: (pid: number) => boolean;
	readonly runCommand: (
		executable: string,
		args: readonly string[],
		options: RunOwnedCommandOptions,
	) => Promise<string>;
}

interface ParsedEndpointDocument {
	readonly userDataPath: string;
	readonly endpoints: readonly ParsedEndpoint[];
}

interface ParsedEndpoint {
	readonly schemaVersion: 2;
	readonly type: string;
	readonly pid: number;
	readonly instanceId: string;
	readonly protocolVersion: string;
	readonly connectionToken: string;
	readonly endpoint: {
		readonly type: string;
		readonly path?: string;
	};
	readonly quality?: string;
}

export class LocatedEditorAgentHost {
	readonly version: string;
	readonly registryProtocolVersion = supportedProtocolVersion;
	#connectionToken: string;
	#socketPath: string;
	#registration: SensitiveValueRegistration | undefined;

	public constructor(options: {
		readonly connectionToken: string;
		readonly socketPath: string;
		readonly version: string;
		readonly sensitiveValues: readonly string[];
	}) {
		this.#connectionToken = options.connectionToken;
		this.#socketPath = options.socketPath;
		this.version = options.version;
		this.#registration = registerSensitiveValues(options.sensitiveValues);
	}

	public connect(
		connector: UnixSocketWebSocketConnector,
		signal?: AbortSignal,
	): Promise<WebSocket> {
		return connector.connect(this.#socketPath, this.#connectionToken, signal);
	}

	public dispose(): void {
		this.#registration?.dispose();
		this.#registration = undefined;
	}
}

export class EditorAgentHostLocator {
	private readonly dependencies: EditorAgentHostLocatorDependencies;
	private readonly commandTimeoutMs: number;
	private readonly platform: EditorAgentHostPlatformContext;

	public constructor(
		private readonly options: EditorAgentHostLocatorOptions = {},
		dependencies: Partial<EditorAgentHostLocatorDependencies> = {},
	) {
		this.commandTimeoutMs = options.commandTimeoutMs ?? endpointCommandTimeoutMs;
		if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) {
			throw new RangeError('Editor Agent Host endpoint timeout must be a positive safe integer.');
		}
		this.platform = currentPlatformContext(options.platform);
		this.dependencies = {
			canonicalize: realpath,
			isProcessAlive: processIsAlive,
			runCommand: runOwnedCommand,
			...dependencies,
		};
	}

	public async probe(signal?: AbortSignal): Promise<AgentHostProbe> {
		let located: LocatedEditorAgentHost | undefined;
		try {
			located = await this.locate(signal);
			return {
				available: true,
				version: located.version,
				architecture: this.platform.architecture,
			};
		} catch {
			return { available: false };
		} finally {
			located?.dispose();
		}
	}

	public async locate(signal?: AbortSignal): Promise<LocatedEditorAgentHost> {
		throwIfCancelled(signal);
		const derived = deriveEditorAgentHostUserDataDir(
			this.platform,
			readEditorAgentHostUserDataDirSetting(this.options.configuredUserDataDir),
		);
		let expectedUserDataPath: string;
		try {
			expectedUserDataPath = await this.dependencies.canonicalize(derived.path);
		} catch {
			throw new EditorAgentHostLocatorError(
				'USER_DATA_UNAVAILABLE',
				'The configured or derived VS Code user-data directory is unavailable.',
			);
		}
		throwIfCancelled(signal);

		let code: Awaited<ReturnType<typeof discoverCodeCli>>;
		let output: string;
		try {
			code = await discoverCodeCli(
				this.options.configuredCodeCli,
				signal,
				this.dependencies.runCommand,
			);
			output = await this.dependencies.runCommand(
				code.executable,
				['agent', 'endpoints', '--user-data-dir', derived.path],
				{
					timeoutMs: this.commandTimeoutMs,
					maxOutputBytes: endpointOutputLimitBytes,
					signal,
				},
			);
		} catch {
			throwIfCancelled(signal);
			throw new EditorAgentHostLocatorError(
				'COMMAND_FAILED',
				'VS Code editor Agent Host endpoint discovery failed.',
			);
		}
		throwIfCancelled(signal);

		const document = parseEditorEndpointDocument(output);
		let documentUserDataPath: string;
		try {
			documentUserDataPath = await this.dependencies.canonicalize(document.userDataPath);
		} catch {
			throw new EditorAgentHostLocatorError(
				'USER_DATA_MISMATCH',
				'The endpoint registry user-data directory could not be verified.',
			);
		}
		if (documentUserDataPath !== expectedUserDataPath) {
			throw new EditorAgentHostLocatorError(
				'USER_DATA_MISMATCH',
				'The endpoint registry did not belong to the expected VS Code user-data directory.',
			);
		}

		const endpoint = selectEditorEndpoint(document, this.dependencies.isProcessAlive);
		return new LocatedEditorAgentHost({
			connectionToken: endpoint.connectionToken,
			socketPath: endpoint.endpoint.path!,
			version: code.version,
			sensitiveValues: [
				endpoint.connectionToken,
				endpoint.endpoint.path!,
				endpoint.instanceId,
				document.userDataPath,
				expectedUserDataPath,
				code.executable,
			],
		});
	}
}

export function deriveEditorAgentHostUserDataDir(
	context: EditorAgentHostPlatformContext,
	override?: string,
): DerivedEditorAgentHostUserData {
	const configured = override?.trim();
	if (configured !== undefined && configured.length > 0) {
		if (!isAbsoluteForPlatform(configured, context.platform)) {
			throw new EditorAgentHostLocatorError(
				'USER_DATA_UNAVAILABLE',
				'The VS Code user-data directory override must be absolute.',
			);
		}
		return {
			path: configured,
			validatedWorkerHost: context.platform === 'darwin' && context.architecture === 'arm64',
		};
	}
	const strategy = strategyFor(context.platform);
	return {
		path: strategy.derive(context),
		validatedWorkerHost: context.platform === 'darwin' && context.architecture === 'arm64',
	};
}

export function readEditorAgentHostUserDataDirSetting(value: unknown): string | undefined {
	if (value === undefined || value === '') {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new EditorAgentHostLocatorError(
			'USER_DATA_UNAVAILABLE',
			'The VS Code user-data directory override must be a string.',
		);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (!isAbsolute(trimmed)) {
		throw new EditorAgentHostLocatorError(
			'USER_DATA_UNAVAILABLE',
			'The VS Code user-data directory override must be absolute.',
		);
	}
	return trimmed;
}

function strategyFor(platform: NodeJS.Platform): EditorAgentHostUserDataStrategy {
	switch (platform) {
		case 'darwin':
			return {
				derive: (context) => posix.join(
					context.homeDirectory,
					'Library',
					'Application Support',
					isInsiders(context.productName) ? 'Code - Insiders' : 'Code',
				),
			};
		case 'linux':
			return {
				derive: (context) => posix.join(
					context.environment.XDG_CONFIG_HOME?.trim() || posix.join(context.homeDirectory, '.config'),
					isInsiders(context.productName) ? 'Code - Insiders' : 'Code',
				),
			};
		case 'win32':
			return {
				derive: (context) => {
					const appData = context.environment.APPDATA?.trim();
					if (appData === undefined || appData.length === 0) {
						throw new EditorAgentHostLocatorError(
							'USER_DATA_UNAVAILABLE',
							'APPDATA is required to derive the VS Code user-data directory.',
						);
					}
					return win32.join(appData, isInsiders(context.productName) ? 'Code - Insiders' : 'Code');
				},
			};
		default:
			throw new EditorAgentHostLocatorError(
				'USER_DATA_UNAVAILABLE',
				'This platform has no VS Code user-data directory strategy.',
			);
	}
}

function currentPlatformContext(
	override: Partial<EditorAgentHostPlatformContext> | undefined,
): EditorAgentHostPlatformContext {
	return {
		platform: override?.platform ?? process.platform,
		architecture: override?.architecture ?? process.arch,
		homeDirectory: override?.homeDirectory ?? homedir(),
		environment: override?.environment ?? process.env,
		productName: override?.productName ?? 'Visual Studio Code',
	};
}

function isInsiders(productName: string): boolean {
	return /\binsiders\b/iu.test(productName);
}

function isAbsoluteForPlatform(path: string, platform: NodeJS.Platform): boolean {
	return platform === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path);
}

function parseEditorEndpointDocument(json: string): ParsedEndpointDocument {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw invalidDocument();
	}
	if (
		!isRecord(value)
		|| !hasOnlyKeys(value, ['userDataPath', 'endpoints'])
		|| typeof value.userDataPath !== 'string'
		|| !isAbsolute(value.userDataPath)
		|| !Array.isArray(value.endpoints)
	) {
		throw invalidDocument();
	}
	return {
		userDataPath: value.userDataPath,
		endpoints: value.endpoints.map((endpoint) => parseEndpoint(endpoint)),
	};
}

function parseEndpoint(value: unknown): ParsedEndpoint {
	if (
		!isRecord(value)
		|| !hasOnlyKeys(value, [
			'schemaVersion',
			'type',
			'pid',
			'instanceId',
			'protocolVersion',
			'connectionToken',
			'endpoint',
			'quality',
		])
		|| value.schemaVersion !== 2
		|| typeof value.type !== 'string'
		|| !isPositiveInteger(value.pid)
		|| typeof value.instanceId !== 'string'
		|| value.instanceId.length < 1
		|| value.instanceId.length > 512
		|| typeof value.protocolVersion !== 'string'
		|| typeof value.connectionToken !== 'string'
		|| value.connectionToken.length < 1
		|| value.connectionToken.length > 4_096
		|| !isRecord(value.endpoint)
		|| !hasOnlyKeys(value.endpoint, ['type', 'path'])
		|| typeof value.endpoint.type !== 'string'
		|| (value.endpoint.path !== undefined && typeof value.endpoint.path !== 'string')
		|| (value.quality !== undefined && typeof value.quality !== 'string')
	) {
		throw invalidDocument();
	}
	return {
		schemaVersion: 2,
		type: value.type,
		pid: value.pid,
		instanceId: value.instanceId,
		protocolVersion: value.protocolVersion,
		connectionToken: value.connectionToken,
		endpoint: {
			type: value.endpoint.type,
			path: value.endpoint.path,
		},
		quality: value.quality,
	};
}

function selectEditorEndpoint(
	document: ParsedEndpointDocument,
	isProcessAlive: (pid: number) => boolean,
): ParsedEndpoint {
	const editor = document.endpoints.filter((endpoint) => endpoint.type === 'editor');
	if (editor.length === 0) {
		throw new EditorAgentHostLocatorError(
			'NO_EDITOR_ENDPOINT',
			'No editor Agent Host endpoint is registered for this VS Code user-data directory.',
		);
	}
	const socket = editor.filter((endpoint) =>
		endpoint.endpoint.type === 'socket'
		&& endpoint.endpoint.path !== undefined
		&& isAbsolute(endpoint.endpoint.path));
	if (socket.length === 0) {
		throw new EditorAgentHostLocatorError(
			'UNSUPPORTED_TRANSPORT',
			'The editor Agent Host does not expose a supported socket endpoint.',
		);
	}
	const compatible = socket.filter((endpoint) => endpoint.protocolVersion === supportedProtocolVersion);
	if (compatible.length === 0) {
		throw new EditorAgentHostLocatorError(
			'INCOMPATIBLE_PROTOCOL',
			'The editor Agent Host protocol is incompatible with the client offer.',
		);
	}
	const live = compatible.filter((endpoint) => isProcessAlive(endpoint.pid));
	if (live.length === 0) {
		throw new EditorAgentHostLocatorError(
			'STALE_EDITOR_ENDPOINT',
			'The registered editor Agent Host endpoint is stale.',
		);
	}
	if (live.length > 1) {
		throw new EditorAgentHostLocatorError(
			'MULTIPLE_EDITOR_ENDPOINTS',
			'Multiple live compatible editor Agent Host endpoints were registered.',
		);
	}
	return live[0]!;
}

function invalidDocument(): EditorAgentHostLocatorError {
	return new EditorAgentHostLocatorError(
		'INVALID_ENDPOINT_DOCUMENT',
		'VS Code returned an invalid Agent Host endpoint document.',
	);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) {
		throw new EditorAgentHostLocatorError(
			'CANCELLED',
			'Editor Agent Host endpoint discovery was cancelled.',
		);
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return isErrno(error, 'EPERM');
	}
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = new Set(allowed);
	return Object.keys(value).every((key) => keys.has(key));
}
