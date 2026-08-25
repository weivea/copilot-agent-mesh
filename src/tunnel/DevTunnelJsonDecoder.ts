import { createHash } from 'node:crypto';

export const LEGACY_UNSUPPORTED_DEVTUNNEL_BUILD = '1.0.2006+dd9fe5139f';
export const SUPPORTED_DEVTUNNEL_BUILD = '1.0.2030+fc9273aa0f';
export const DEVTUNNEL_DECODER_REVISION = 'show-json-1.0.2030-r1';
export const DEVTUNNEL_EXECUTABLE_SHA256 = '004f3cc8ebcce61223bacac80d31937eb2e92eaee9a05600a1cb62fb5f775afe';
export const DEVTUNNEL_HOSTED_FIXTURE_SHA256 = 'd561eed56125ea53d2e97f1dcc5107575f7fb1df2eb2032a955338c9fb7a5ace';

export type DevTunnelDecodeErrorCode =
	| 'ACCESS_INVALID'
	| 'FORWARDING_URI_AMBIGUOUS'
	| 'FORWARDING_URI_INVALID'
	| 'FORWARDING_URI_MISSING'
	| 'INVALID_JSON'
	| 'PORT_NOT_FOUND'
	| 'PORT_PROTOCOL_MISMATCH'
	| 'TUNNEL_ID_MISMATCH'
	| 'UNKNOWN_SHAPE'
	| 'UNSUPPORTED_BUILD';

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
	readonly expectedOwnershipLabel?: string;
	readonly expectedPort: number;
	readonly allowMissingPort?: boolean;
	readonly allowedHostSuffixes?: readonly string[];
	readonly requireForwardingUri?: boolean;
}

export interface DecodedDevTunnel {
	readonly tunnelId: string;
	readonly port: number;
	readonly portExists: boolean;
	readonly protocol: 'http';
	readonly forwardingOrigin?: string;
}

export interface DecodedCreatedTunnel {
	readonly tunnelId: string;
}

export interface DecodedAccess {
	readonly expiresAt: string;
	readonly index: 0;
}

const allowedRootKeys = new Set(['tunnel']);
const allowedTunnelKeys = new Set([
	'accessControl',
	'clientConnections',
	'currentDownloadRate',
	'currentUploadRate',
	'description',
	'downloadTotal',
	'hostConnections',
	'labels',
	'ports',
	'tunnelExpiration',
	'tunnelId',
	'uploadTotal',
]);
const allowedPortKeys = new Set([
	'accessControl',
	'clientConnections',
	'description',
	'labels',
	'portNumber',
	'portUri',
	'protocol',
	'status',
]);
const allowedCreatedTunnelKeys = new Set([
	'accessControl',
	'clientConnections',
	'currentDownloadRate',
	'currentUploadRate',
	'description',
	'hostConnections',
	'labels',
	'tunnelExpiration',
	'tunnelId',
]);
const allowedCreatedPortKeys = new Set([
	'accessControl',
	'clientConnections',
	'description',
	'labels',
	'portNumber',
	'protocol',
	'tunnelId',
]);
const allowedAccessEntryKeys = new Set(['expiration', 'scopes', 'subjects', 'type']);
const defaultAllowedHostSuffixes = ['.devtunnels.ms'];

export function decodeDevTunnelCreateJson(
	build: string,
	raw: string,
	expectedAlias: string,
	expectedLabel: string,
): DecodedCreatedTunnel {
	assertSupportedBuild(build);
	const root = parseRoot(raw, new Set(['tunnel']));
	const tunnel = requireRecord(root.tunnel, 'UNKNOWN_SHAPE', 'Dev Tunnel output is missing the tunnel object.');
	assertKnownKeys(tunnel, allowedCreatedTunnelKeys);
	validateTunnelSummary(tunnel);
	if (!Array.isArray(tunnel.labels) || !tunnel.labels.includes(expectedLabel)) {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Created tunnel is missing its ownership label.');
	}
	if (
		typeof tunnel.tunnelId !== 'string'
		|| !new RegExp(`^${escapeRegExp(expectedAlias)}\\.[a-z0-9]+$`, 'u').test(tunnel.tunnelId)
	) {
		throw new DevTunnelDecodeError('TUNNEL_ID_MISMATCH', 'Created tunnel ID does not match its requested alias.');
	}
	return { tunnelId: tunnel.tunnelId };
}

export function decodeDevTunnelPortCreateJson(
	build: string,
	raw: string,
	expectedTunnelId: string,
	expectedPort: number,
): void {
	assertSupportedBuild(build);
	const root = parseRoot(raw, new Set(['port']));
	const port = requireRecord(root.port, 'UNKNOWN_SHAPE', 'Dev Tunnel output is missing the port object.');
	assertKnownKeys(port, allowedCreatedPortKeys);
	validatePortRecord(port);
	if (port.tunnelId !== expectedTunnelId) {
		throw new DevTunnelDecodeError('TUNNEL_ID_MISMATCH', 'Created port identifies a different tunnel.');
	}
	if (port.portNumber !== expectedPort) {
		throw new DevTunnelDecodeError('PORT_NOT_FOUND', 'Created port does not match the requested port.');
	}
	if (port.protocol !== 'http') {
		throw new DevTunnelDecodeError('PORT_PROTOCOL_MISMATCH', 'Created port is not HTTP.');
	}
}

export function decodeDevTunnelAccessCreateJson(
	build: string,
	raw: string,
	now: Date,
): DecodedAccess {
	assertSupportedBuild(build);
	const root = parseRoot(raw, new Set(['accessControlEntries']));
	if (!Array.isArray(root.accessControlEntries) || root.accessControlEntries.length !== 1) {
		throw new DevTunnelDecodeError('ACCESS_INVALID', 'Dev Tunnel did not create exactly one access entry.');
	}
	const entry = requireRecord(
		root.accessControlEntries[0],
		'ACCESS_INVALID',
		'Dev Tunnel access entry must be an object.',
	);
	assertKnownKeys(entry, allowedAccessEntryKeys);
	if (
		entry.type !== 'Anonymous'
		|| !Array.isArray(entry.subjects)
		|| entry.subjects.length !== 0
		|| !Array.isArray(entry.scopes)
		|| entry.scopes.length !== 1
		|| entry.scopes[0] !== 'connect'
		|| typeof entry.expiration !== 'string'
	) {
		throw new DevTunnelDecodeError('ACCESS_INVALID', 'Dev Tunnel created an unexpected access entry.');
	}
	const expiration = new Date(entry.expiration);
	if (!Number.isFinite(expiration.valueOf()) || expiration.valueOf() <= now.valueOf()) {
		throw new DevTunnelDecodeError('ACCESS_INVALID', 'Dev Tunnel access expiration is invalid.');
	}
	return {
		expiresAt: expiration.toISOString(),
		index: 0,
	};
}

export function decodeDevTunnelAccessDeleteJson(build: string, raw: string): void {
	assertSupportedBuild(build);
	const root = parseRoot(raw, new Set(['accessControlEntries']));
	if (!Array.isArray(root.accessControlEntries) || root.accessControlEntries.length !== 0) {
		throw new DevTunnelDecodeError('ACCESS_INVALID', 'Dev Tunnel did not revoke the owned access entry.');
	}
}

export function decodeDevTunnelShowJson(
	build: string,
	raw: string,
	options: DecodeDevTunnelShowOptions,
): DecodedDevTunnel {
	assertSupportedBuild(build);
	const root = parseRoot(raw, allowedRootKeys);
	const tunnel = requireRecord(root.tunnel, 'UNKNOWN_SHAPE', 'Dev Tunnel output is missing the tunnel object.');
	assertKnownKeys(tunnel, allowedTunnelKeys);
	validateTunnelSummary(tunnel);
	if (tunnel.tunnelId !== options.expectedTunnelId) {
		throw new DevTunnelDecodeError('TUNNEL_ID_MISMATCH', 'Dev Tunnel output identifies a different tunnel.');
	}
	if (
		options.expectedOwnershipLabel !== undefined
		&& (
			!Array.isArray(tunnel.labels)
			|| !tunnel.labels.includes(options.expectedOwnershipLabel)
		)
	) {
		throw new DevTunnelDecodeError('TUNNEL_ID_MISMATCH', 'Dev Tunnel output is missing its ownership label.');
	}
	if (tunnel.ports === undefined && options.allowMissingPort === true) {
		return {
			tunnelId: options.expectedTunnelId,
			port: options.expectedPort,
			portExists: false,
			protocol: 'http',
		};
	}
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
	if (matchingPorts.length === 0 && options.allowMissingPort === true) {
		return {
			tunnelId: options.expectedTunnelId,
			port: options.expectedPort,
			portExists: false,
			protocol: 'http',
		};
	}
	if (matchingPorts.length !== 1) {
		throw new DevTunnelDecodeError('PORT_NOT_FOUND', 'Dev Tunnel output did not contain one matching port.');
	}
	const port = matchingPorts[0];
	if (port.protocol !== 'http') {
		throw new DevTunnelDecodeError('PORT_PROTOCOL_MISMATCH', 'The matching Dev Tunnel port is not HTTP.');
	}
	if (port.portUri === undefined) {
		if (options.requireForwardingUri === true) {
			throw new DevTunnelDecodeError('FORWARDING_URI_MISSING', 'The matching port has no forwarding URI.');
		}
		return {
			tunnelId: options.expectedTunnelId,
			port: options.expectedPort,
			portExists: true,
			protocol: 'http',
		};
	}
	if (typeof port.portUri !== 'string' || port.portUri.length === 0) {
		throw new DevTunnelDecodeError('FORWARDING_URI_INVALID', 'The matching port has an invalid forwarding URI.');
	}

	const forwardingUri = parseForwardingUri(
		port.portUri,
		options.allowedHostSuffixes ?? defaultAllowedHostSuffixes,
	);
	return {
		tunnelId: options.expectedTunnelId,
		port: options.expectedPort,
		portExists: true,
		protocol: 'http',
		forwardingOrigin: forwardingUri.origin,
	};
}

export function computeSanitizedFixtureHash(raw: string): string {
	return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function assertSupportedBuild(build: string): void {
	if (build !== SUPPORTED_DEVTUNNEL_BUILD) {
		throw new DevTunnelDecodeError('UNSUPPORTED_BUILD', 'No strict decoder exists for this Dev Tunnel build.');
	}
}

function parseRoot(raw: string, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new DevTunnelDecodeError('INVALID_JSON', 'Dev Tunnel output was not a JSON document.');
	}
	const root = requireRecord(parsed, 'UNKNOWN_SHAPE', 'Dev Tunnel output must be an object.');
	assertKnownKeys(root, allowedKeys);
	return root;
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

function validateTunnelSummary(tunnel: Record<string, unknown>): void {
	if (typeof tunnel.tunnelId !== 'string') {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output has an invalid tunnel ID.');
	}
	assertOptionalNonnegativeInteger(tunnel.hostConnections);
	assertOptionalNonnegativeInteger(tunnel.clientConnections);
	assertOptionalStringArray(tunnel.labels);
	assertOptionalString(tunnel.tunnelExpiration);
	assertOptionalNullableString(tunnel.description);
	assertOptionalString(tunnel.currentUploadRate);
	assertOptionalString(tunnel.currentDownloadRate);
	assertOptionalString(tunnel.uploadTotal);
	assertOptionalString(tunnel.downloadTotal);
	assertOptionalArray(tunnel.accessControl);
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
	const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
	if (unknownKeys.length > 0) {
		throw new DevTunnelDecodeError(
			'UNKNOWN_SHAPE',
			`Dev Tunnel output contained unknown field(s): ${unknownKeys.join(', ')}.`,
		);
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
	if (port.tunnelId !== undefined && typeof port.tunnelId !== 'string') {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel port has an invalid tunnel ID.');
	}
	if (port.portUri !== undefined && typeof port.portUri !== 'string') {
		throw new DevTunnelDecodeError('UNKNOWN_SHAPE', 'Dev Tunnel output contained an invalid forwarding URI.');
	}
	assertOptionalStringArray(port.labels);
	assertOptionalNullableString(port.description);
	assertOptionalNonnegativeInteger(port.clientConnections);
	assertOptionalArray(port.accessControl);
	assertOptionalString(port.status);
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
