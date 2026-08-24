import { createHash } from 'node:crypto';

export const OBSERVED_DEVTUNNEL_BUILD = '1.0.2006+dd9fe5139f';
export const DEVTUNNEL_DECODER_REVISION = 'show-json-1.0.2006-r1';

export type DevTunnelDecodeErrorCode =
	| 'FORWARDING_URI_AMBIGUOUS'
	| 'FORWARDING_URI_INVALID'
	| 'FORWARDING_URI_MISSING'
	| 'INVALID_JSON'
	| 'PORT_NOT_FOUND'
	| 'PORT_PROTOCOL_MISMATCH'
	| 'TUNNEL_ID_MISMATCH'
	| 'UNKNOWN_SHAPE';

export class DevTunnelDecodeError extends Error {
	constructor(
		readonly code: DevTunnelDecodeErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'DevTunnelDecodeError';
	}
}

export interface DecodeDevTunnelShowOptions {
	readonly expectedTunnelId: string;
	readonly expectedPort: number;
	readonly allowedHostSuffixes?: readonly string[];
}

export interface DecodedDevTunnel {
	readonly tunnelId: string;
	readonly port: number;
	readonly protocol: 'http';
	readonly forwardingOrigin: string;
}

const allowedRootKeys = new Set(['tunnel']);
const allowedTunnelKeys = new Set([
	'accessControl',
	'clientConnections',
	'currentDownloadRate',
	'currentUploadRate',
	'description',
	'hostConnections',
	'labels',
	'ports',
	'tunnelExpiration',
	'tunnelId',
]);
const allowedPortKeys = new Set([
	'accessControl',
	'clientConnections',
	'description',
	'labels',
	'portForwardingUris',
	'portNumber',
	'protocol',
]);
const defaultAllowedHostSuffixes = ['.devtunnels.ms'];

export function decodeDevTunnelShowJson(
	raw: string,
	options: DecodeDevTunnelShowOptions,
): DecodedDevTunnel {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new DevTunnelDecodeError('INVALID_JSON', 'Dev Tunnel output was not a JSON document.');
	}

	const root = requireRecord(parsed, 'UNKNOWN_SHAPE', 'Dev Tunnel output must be an object.');
	assertKnownKeys(root, allowedRootKeys);
	const tunnel = requireRecord(root.tunnel, 'UNKNOWN_SHAPE', 'Dev Tunnel output is missing the tunnel object.');
	assertKnownKeys(tunnel, allowedTunnelKeys);
	if (typeof tunnel.tunnelId !== 'string') {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output has an invalid tunnel ID.');
	}
	if (tunnel.tunnelId !== options.expectedTunnelId) {
		throw new DevTunnelDecodeError('TUNNEL_ID_MISMATCH', 'Dev Tunnel output identifies a different tunnel.');
	}
	assertOptionalNonnegativeInteger(tunnel.hostConnections);
	assertOptionalNonnegativeInteger(tunnel.clientConnections);
	assertOptionalStringArray(tunnel.labels);
	assertOptionalString(tunnel.tunnelExpiration);
	assertOptionalNullableString(tunnel.description);
	assertOptionalString(tunnel.currentUploadRate);
	assertOptionalString(tunnel.currentDownloadRate);
	assertOptionalArray(tunnel.accessControl);
	if (!Array.isArray(tunnel.ports)) {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output is missing the ports array.');
	}

	const ports = tunnel.ports.map((port) => {
		const record = requireRecord(port, 'UNKNOWN_SHAPE', 'Dev Tunnel port entries must be objects.');
		assertKnownKeys(record, allowedPortKeys);
		validatePortRecord(record);
		return record;
	});
	const matchingPorts = ports.filter((port) => port.portNumber === options.expectedPort);
	if (matchingPorts.length !== 1) {
		throw new DevTunnelDecodeError('PORT_NOT_FOUND', 'Dev Tunnel output did not contain one matching port.');
	}
	const port = matchingPorts[0];
	if (port.protocol !== 'http') {
		throw new DevTunnelDecodeError('PORT_PROTOCOL_MISMATCH', 'The matching Dev Tunnel port is not HTTP.');
	}
	if (!Array.isArray(port.portForwardingUris) || port.portForwardingUris.length === 0) {
		throw new DevTunnelDecodeError('FORWARDING_URI_MISSING', 'The matching port has no forwarding URI.');
	}
	if (port.portForwardingUris.length !== 1 || typeof port.portForwardingUris[0] !== 'string') {
		throw new DevTunnelDecodeError('FORWARDING_URI_AMBIGUOUS', 'The matching port must have one forwarding URI.');
	}

	const forwardingUri = parseForwardingUri(
		port.portForwardingUris[0],
		options.allowedHostSuffixes ?? defaultAllowedHostSuffixes,
	);
	return {
		tunnelId: options.expectedTunnelId,
		port: options.expectedPort,
		protocol: 'http',
		forwardingOrigin: forwardingUri.origin,
	};
}

export function computeSanitizedFixtureHash(raw: string): string {
	return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function parseForwardingUri(value: string, allowedHostSuffixes: readonly string[]): URL {
	const schemeDelimiter = value.indexOf('://');
	const remainder = schemeDelimiter >= 0 ? value.slice(schemeDelimiter + 3) : '';
	const authorityEnd = remainder.search(/[/?#]/u);
	const authority = authorityEnd >= 0 ? remainder.slice(0, authorityEnd) : remainder;
	const pathAndSuffix = authorityEnd >= 0 ? remainder.slice(authorityEnd) : '';
	if (
		value.trim() !== value
		|| authority.includes('@')
		|| pathAndSuffix.includes('?')
		|| pathAndSuffix.includes('#')
	) {
		throw new DevTunnelDecodeError('FORWARDING_URI_INVALID', 'The forwarding URI failed validation.');
	}

	let uri: URL;
	try {
		uri = new URL(value);
	} catch {
		throw new DevTunnelDecodeError('FORWARDING_URI_INVALID', 'The forwarding URI is not a valid URL.');
	}

	const hostname = uri.hostname.toLowerCase();
	const hostAllowed = allowedHostSuffixes.some((suffix) => {
		const normalizedSuffix = suffix.toLowerCase();
		return normalizedSuffix.startsWith('.')
			? hostname.endsWith(normalizedSuffix)
			: hostname === normalizedSuffix;
	});
	if (
		uri.protocol !== 'https:'
		|| uri.username.length > 0
		|| uri.password.length > 0
		|| uri.search.length > 0
		|| uri.hash.length > 0
		|| !hostAllowed
	) {
		throw new DevTunnelDecodeError('FORWARDING_URI_INVALID', 'The forwarding URI failed validation.');
	}
	return uri;
}

function requireRecord(
	value: unknown,
	code: DevTunnelDecodeErrorCode,
	message: string,
): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new DevTunnelDecodeError(code, message);
	}
	return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): void {
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output contained an unknown field.');
	}
}

function validatePortRecord(port: Record<string, unknown>): void {
	if (
		typeof port.portNumber !== 'number'
		|| !Number.isSafeInteger(port.portNumber)
		|| port.portNumber < 1
		|| port.portNumber > 65_535
		|| typeof port.protocol !== 'string'
		|| !['auto', 'http', 'https'].includes(port.protocol)
	) {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output contained an invalid port.');
	}
	if (
		port.portForwardingUris !== undefined
		&& (
			!Array.isArray(port.portForwardingUris)
			|| port.portForwardingUris.some((uri) => typeof uri !== 'string')
		)
	) {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output contained invalid forwarding URIs.');
	}
	assertOptionalStringArray(port.labels);
	assertOptionalNullableString(port.description);
	assertOptionalNonnegativeInteger(port.clientConnections);
	assertOptionalArray(port.accessControl);
}

function assertOptionalArray(value: unknown): void {
	if (value !== undefined && !Array.isArray(value)) {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output contained an invalid array field.');
	}
}

function assertOptionalNonnegativeInteger(value: unknown): void {
	if (
		value !== undefined
		&& (
			typeof value !== 'number'
			|| !Number.isSafeInteger(value)
			|| value < 0
		)
	) {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output contained an invalid numeric field.');
	}
}

function assertOptionalNullableString(value: unknown): void {
	if (value !== undefined && value !== null && typeof value !== 'string') {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output contained an invalid text field.');
	}
}

function assertOptionalString(value: unknown): void {
	if (value !== undefined && typeof value !== 'string') {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output contained an invalid text field.');
	}
}

function assertOptionalStringArray(value: unknown): void {
	if (
		value !== undefined
		&& (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
	) {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output contained an invalid string array.');
	}
}
