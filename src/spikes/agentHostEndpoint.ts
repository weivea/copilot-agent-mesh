export interface AgentHostEndpointDocument {
	userDataPath: string;
	endpoints: AgentHostEndpoint[];
}

export interface AgentHostEndpoint {
	schemaVersion: number;
	type: string;
	pid: number;
	instanceId: string;
	protocolVersion: string;
	connectionToken: string;
	endpoint: {
		type: string;
		host: string;
		port: number;
	};
	quality?: string;
}

export interface SelectedAgentHostEndpoint {
	instanceId: string;
	pid: number;
	registryProtocolVersion: string;
	url: URL;
}

export type EndpointSelectionErrorCode = 'INVALID_ENDPOINT_JSON' | 'NO_OWNED_ENDPOINT' | 'MULTIPLE_OWNED_ENDPOINTS';

export class EndpointSelectionError extends Error {
	constructor(
		readonly code: EndpointSelectionErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'EndpointSelectionError';
	}
}

export function parseEndpointDocument(json: string): AgentHostEndpointDocument {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw invalidEndpointJson('Agent Host endpoint output is not valid JSON.');
	}

	if (!isRecord(value) || typeof value.userDataPath !== 'string' || !Array.isArray(value.endpoints)) {
		throw invalidEndpointJson('Agent Host endpoint output must contain userDataPath and endpoints.');
	}

	return {
		userDataPath: value.userDataPath,
		endpoints: value.endpoints.map((endpoint, index) => parseEndpoint(endpoint, index)),
	};
}

export function selectOwnedStandaloneEndpoint(options: {
	baselineInstanceIds: ReadonlySet<string>;
	document: AgentHostEndpointDocument;
	ownedPids: ReadonlySet<number>;
	expectedToken: string;
}): SelectedAgentHostEndpoint {
	const matches = options.document.endpoints.filter((endpoint) =>
		!options.baselineInstanceIds.has(endpoint.instanceId)
		&& endpoint.type === 'standalone'
		&& options.ownedPids.has(endpoint.pid)
		&& endpoint.connectionToken === options.expectedToken,
	);

	if (matches.length === 0) {
		throw new EndpointSelectionError(
			'NO_OWNED_ENDPOINT',
			'No new standalone Agent Host endpoint matched the owned PID and connection token.',
		);
	}
	if (matches.length > 1) {
		throw new EndpointSelectionError(
			'MULTIPLE_OWNED_ENDPOINTS',
			'Multiple new standalone Agent Host endpoints matched the owned PID and connection token.',
		);
	}

	const endpoint = matches[0];
	if (!endpoint) {
		throw new EndpointSelectionError('NO_OWNED_ENDPOINT', 'The selected Agent Host endpoint disappeared.');
	}
	if (endpoint.endpoint.type !== 'tcp') {
		throw invalidEndpointJson(`Unsupported Agent Host endpoint transport "${endpoint.endpoint.type}".`);
	}
	if (!isLoopbackHost(endpoint.endpoint.host)) {
		throw invalidEndpointJson('The owned Agent Host endpoint must use a loopback host.');
	}

	const urlHost = endpoint.endpoint.host === '::1' ? '[::1]' : endpoint.endpoint.host;
	const url = new URL(`ws://${urlHost}:${endpoint.endpoint.port}`);
	url.searchParams.set('tkn', endpoint.connectionToken);
	if (url.protocol !== 'ws:' || url.searchParams.get('tkn') !== options.expectedToken) {
		throw invalidEndpointJson('The Agent Host WebSocket URL failed validation.');
	}

	return {
		instanceId: endpoint.instanceId,
		pid: endpoint.pid,
		registryProtocolVersion: endpoint.protocolVersion,
		url,
	};
}

export async function waitForOwnedStandaloneEndpoint(options: {
	baselineInstanceIds: ReadonlySet<string>;
	discover: (remainingMs: number) => Promise<AgentHostEndpointDocument>;
	ownedPids: () => ReadonlySet<number>;
	expectedToken: string;
	timeoutMs: number;
	pollIntervalMs: number;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
}): Promise<SelectedAgentHostEndpoint> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const deadline = now() + options.timeoutMs;

	do {
		const remainingMs = Math.max(1, deadline - now());
		const document = await options.discover(remainingMs);
		try {
			return selectOwnedStandaloneEndpoint({
				baselineInstanceIds: options.baselineInstanceIds,
				document,
				ownedPids: options.ownedPids(),
				expectedToken: options.expectedToken,
			});
		} catch (error) {
			if (!(error instanceof EndpointSelectionError) || error.code !== 'NO_OWNED_ENDPOINT') {
				throw error;
			}
		}
		if (now() >= deadline) {
			break;
		}
		await sleep(options.pollIntervalMs);
	} while (now() <= deadline);

	throw new EndpointSelectionError(
		'NO_OWNED_ENDPOINT',
		`Timed out after ${options.timeoutMs}ms waiting for the owned Agent Host endpoint.`,
	);
}

export function redactSecrets(value: string, secrets: readonly string[] = []): string {
	let redacted = value;
	for (const secret of secrets) {
		if (secret.length > 0) {
			redacted = redacted.split(secret).join('<redacted>');
		}
	}

	return redacted
		.replace(/([?&](?:tkn|token)=)[^&\s"']+/giu, '$1<redacted>')
		.replace(/("(?:connectionToken|token)"\s*:\s*")[^"]*(")/giu, '$1<redacted>$2')
		.replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/giu, '$1<redacted>');
}

export function requireGlobalWebSocket(): void {
	if (typeof globalThis.WebSocket !== 'function') {
		throw new Error(
			'globalThis.WebSocket is unavailable; the Agent Host spike cannot continue until an AhpTransport fallback is explicitly configured.',
		);
	}
}

function parseEndpoint(value: unknown, index: number): AgentHostEndpoint {
	if (!isRecord(value)
		|| typeof value.schemaVersion !== 'number'
		|| value.schemaVersion !== 2
		|| typeof value.type !== 'string'
		|| !isPositiveInteger(value.pid)
		|| typeof value.instanceId !== 'string'
		|| value.instanceId.length === 0
		|| typeof value.protocolVersion !== 'string'
		|| typeof value.connectionToken !== 'string'
		|| value.connectionToken.length === 0
		|| !isRecord(value.endpoint)
		|| typeof value.endpoint.type !== 'string'
		|| typeof value.endpoint.host !== 'string'
		|| !isValidPort(value.endpoint.port)
		|| (value.quality !== undefined && typeof value.quality !== 'string')) {
		throw invalidEndpointJson(`Agent Host endpoint at index ${index} has an invalid schema.`);
	}

	return {
		schemaVersion: value.schemaVersion,
		type: value.type,
		pid: value.pid,
		instanceId: value.instanceId,
		protocolVersion: value.protocolVersion,
		connectionToken: value.connectionToken,
		endpoint: {
			type: value.endpoint.type,
			host: value.endpoint.host,
			port: value.endpoint.port,
		},
		quality: value.quality,
	};
}

function invalidEndpointJson(message: string): EndpointSelectionError {
	return new EndpointSelectionError('INVALID_ENDPOINT_JSON', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidPort(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535;
}

function isLoopbackHost(host: string): boolean {
	return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
