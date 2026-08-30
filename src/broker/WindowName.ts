import { PROTOCOL_LIMITS, utf8ByteLength } from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import { containsUnsafeDashboardText } from '../ui/DashboardRedaction';

const invisibleOrControlPattern =
	/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const uriOrDrivePrefixPattern = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const githubTokenPrefixPattern = /^(?:gh[oprsu]_|github_pat_)/iu;
const longHexPattern = /^[A-Fa-f0-9]{32,}$/u;
const tokenAssignmentPattern =
	/^(?:authorization|bearer|token|access[\s_-]*token|auth[\s_-]*token|api[\s_-]*key|client[\s_-]*secret|private[\s_-]*key|password|secret)\b(?:\s*[:=])?\s*\S+/iu;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const maskedSecretPattern = /^\*{6,}$/u;

export function foldWindowName(value: string): string {
	return value.normalize('NFKC')
		.toLocaleUpperCase('en-US')
		.toLocaleLowerCase('en-US');
}

export function validateWindowName(value: string): void {
	const bytes = utf8ByteLength(value);
	if (bytes < 1 || bytes > PROTOCOL_LIMITS.nameBytes) {
		throw invalidWindowName(
			`Window names must be between 1 and ${PROTOCOL_LIMITS.nameBytes} UTF-8 bytes.`,
		);
	}
	const normalized = value.normalize('NFKC');
	if (
		value.trim().length === 0
		|| value !== value.trim()
		|| invisibleOrControlPattern.test(value)
		|| normalized !== normalized.trim()
		|| normalized.includes('/')
		|| normalized.includes('\\')
		|| normalized.startsWith('~')
		|| uriOrDrivePrefixPattern.test(normalized)
	) {
		throw invalidWindowName(
			'Window names cannot contain control or invisible characters, surrounding whitespace, or path and URI shapes.',
		);
	}

	const compact = normalized.replaceAll(/\s/gu, '');
	if (
		githubTokenPrefixPattern.test(compact)
		|| longHexPattern.test(compact)
		|| maskedSecretPattern.test(compact)
		|| tokenAssignmentPattern.test(normalized)
		|| (
			compact.length >= 40
			&& base64UrlPattern.test(compact)
			&& /[A-Za-z]/u.test(compact)
		)
	) {
		throw invalidWindowName('Window names cannot resemble credentials, tokens, or secrets.');
	}
}

export function resolveWindowDisplayName(
	storedName: string | undefined,
	workspaceName: string | undefined,
	nodeId: string,
): string {
	for (const candidate of [storedName, workspaceName]) {
		if (candidate !== undefined && isSafeWindowDisplayName(candidate)) {
			return candidate;
		}
	}

	function isSafeWindowDisplayName(value: string): boolean {
		try {
			validateWindowName(value);
			return !containsUnsafeDashboardText(value);
		} catch {
			return false;
		}
	}
	return nodeId.slice(0, 8);
}

function invalidWindowName(message: string): MeshDomainError {
	return new MeshDomainError('WINDOW_NAME_INVALID', message);
}
