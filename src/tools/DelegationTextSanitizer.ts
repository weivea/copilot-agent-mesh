import {
	containsCredentialText,
	containsUnsafeDashboardText,
} from '../ui/DashboardRedaction';

const redaction = '[redacted sensitive details]';
const redactionSentinel = '__MESH_REDACTED__';
const benignWhitespacePattern = /[\t\r\n]+/gu;
const remainingControlPattern = /[\u0000-\u001f\u007f-\u009f]/gu;
const formatControlPattern = /\p{Cf}/gu;

/**
 * Preserves useful remote task prose while removing unsafe spans. Dashboard
 * labels intentionally fail closed as a whole; delegation results need
 * span-level redaction so ordinary multiline Agent output remains meaningful.
 */
export function sanitizeDelegationText(value: string, maxBytes: number): string {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new TypeError('Delegation text byte limit must be a positive integer.');
	}
	// Inspect the original field before whitespace normalization can erase the
	// boundary between an assignment value and a continuation line.
	if (containsCredentialText(value)) {
		return boundedUtf8(redaction, maxBytes);
	}
	let sanitized = value
		.replace(benignWhitespacePattern, ' ')
		.replace(formatControlPattern, redactionSentinel)
		.replace(remainingControlPattern, redactionSentinel)
		.replace(/\S+/gu, (span) =>
			containsUnsafeDelegationSpan(span) ? redactionSentinel : span)
		.replace(/\s+/gu, ' ')
		.trim();
	sanitized = sanitized.replaceAll(redactionSentinel, redaction);
	if (sanitized.length === 0) {
		sanitized = redaction;
	}
	return boundedUtf8(sanitized, maxBytes);
}

function containsUnsafeDelegationSpan(span: string): boolean {
	const candidate = span.replace(/^[("'[{]+|[.,;!?)"'\]}:]+$/gu, '');
	if (
		candidate.length === 0
		|| /^(?:application|audio|font|image|message|model|multipart|text|video)\/[a-z0-9.+-]+$/iu
			.test(candidate)
	) {
		return false;
	}
	return containsUnsafeDashboardText(candidate);
}

function boundedUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
		return value;
	}
	let result = '';
	let bytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, 'utf8');
		if (bytes + characterBytes > maxBytes) {
			break;
		}
		result += character;
		bytes += characterBytes;
	}
	return result;
}
