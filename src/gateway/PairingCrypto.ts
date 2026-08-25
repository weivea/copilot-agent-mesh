import {
	createHash,
	createHmac,
	hkdfSync,
	randomBytes,
	timingSafeEqual,
} from 'node:crypto';

export const NONCE_BYTES = 32;
export const SECRET_BYTES = 32;

export function encodeBase64Url(value: Uint8Array): string {
	return Buffer.from(value).toString('base64url');
}

export function decodeFixedBase64Url(value: unknown, bytes: number, field: string): Buffer {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
		throw new PairingProtocolError('INVALID_PARAMS', `${field} is invalid.`);
	}
	const decoded = Buffer.from(value, 'base64url');
	if (decoded.byteLength !== bytes || encodeBase64Url(decoded) !== value) {
		throw new PairingProtocolError('INVALID_PARAMS', `${field} is invalid.`);
	}
	return decoded;
}

export function randomBase64Url(bytes: number): string {
	return encodeBase64Url(randomBytes(bytes));
}

export function lengthPrefixed(...fields: readonly (string | Uint8Array | number)[]): Buffer {
	const parts: Buffer[] = [];
	for (const field of fields) {
		const value = typeof field === 'number'
			? Buffer.from(String(field), 'utf8')
			: typeof field === 'string'
				? Buffer.from(field, 'utf8')
				: Buffer.from(field);
		const size = Buffer.allocUnsafe(4);
		size.writeUInt32BE(value.byteLength);
		parts.push(size, value);
	}
	return Buffer.concat(parts);
}

export function hmac(key: Uint8Array, ...fields: readonly (string | Uint8Array | number)[]): Buffer {
	return createHmac('sha256', key).update(lengthPrefixed(...fields)).digest();
}

export function safeEqual(actual: Uint8Array, expected: Uint8Array): boolean {
	return actual.byteLength === expected.byteLength
		&& timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export interface EnrollmentTranscript {
	readonly version: number;
	readonly invitationId: string;
	readonly workerDeviceId: string;
	readonly coordinatorDeviceId: string;
	readonly sessionId: string;
	readonly clientNonce: string;
	readonly serverNonce: string;
}

export function enrollmentProof(
	secret: Uint8Array,
	label: 'mesh/server-proof/v1' | 'mesh/client-proof/v1',
	transcript: EnrollmentTranscript,
): Buffer {
	return hmac(
		secret,
		label,
		transcript.version,
		transcript.invitationId,
		transcript.workerDeviceId,
		transcript.coordinatorDeviceId,
		transcript.sessionId,
		transcript.clientNonce,
		transcript.serverNonce,
	);
}

export function enrollmentTranscriptHash(transcript: EnrollmentTranscript): Buffer {
	return createHash('sha256').update(lengthPrefixed(
		'mesh/enrollment-transcript/v1',
		transcript.version,
		transcript.invitationId,
		transcript.workerDeviceId,
		transcript.coordinatorDeviceId,
		transcript.sessionId,
		transcript.clientNonce,
		transcript.serverNonce,
	)).digest();
}

export function derivePeerRoot(secret: Uint8Array, transcript: EnrollmentTranscript): Buffer {
	const hash = enrollmentTranscriptHash(transcript);
	return Buffer.from(hkdfSync(
		'sha256',
		secret,
		hash,
		lengthPrefixed(
			'copilot-agent-mesh/peer-root/v1',
			transcript.version,
			transcript.workerDeviceId,
			transcript.coordinatorDeviceId,
		),
		SECRET_BYTES,
	));
}

export interface ReconnectTranscript {
	readonly version: number;
	readonly peerId: string;
	readonly workerDeviceId: string;
	readonly coordinatorDeviceId: string;
	readonly sessionId: string;
	readonly clientNonce: string;
	readonly serverNonce: string;
}

export function reconnectProof(
	rootKey: Uint8Array,
	label: 'mesh/reconnect-server-proof/v1' | 'mesh/reconnect-client-proof/v1',
	transcript: ReconnectTranscript,
): Buffer {
	return hmac(
		rootKey,
		label,
		transcript.version,
		transcript.peerId,
		transcript.workerDeviceId,
		transcript.coordinatorDeviceId,
		transcript.sessionId,
		transcript.clientNonce,
		transcript.serverNonce,
	);
}

export class PairingProtocolError extends Error {
	public constructor(
		public readonly reason: string,
		message: string,
	) {
		super(message);
		this.name = 'PairingProtocolError';
	}
}
