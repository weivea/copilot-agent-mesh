import { z } from 'zod';

import { MeshDomainError } from '../domain/errors';
import { CodespaceCliInstallerError } from './CodespaceCliInstaller';

const preparationFailureCodeSchema = z.enum([
	'UNSUPPORTED_ENVIRONMENT', 'ENVIRONMENT_CHECK_FAILED', 'INVALID_RELEASE', 'UNSAFE_URL',
	'NETWORK_ERROR', 'INTEGRITY_MISMATCH', 'SIZE_LIMIT', 'INVALID_ARCHIVE', 'INVALID_INSTALLATION',
	'INCOMPATIBLE_INSTALLATION', 'INSTALL_IN_PROGRESS', 'INSTALL_FAILED', 'TIMED_OUT',
	'PROTOCOL_INCOMPATIBLE', 'REMOTE_WORKSPACE_UNSUPPORTED', 'WORKSPACE_UNTRUSTED',
	'CLEANUP_FAILED', 'PREPARATION_FAILED',
]);
export type CodespacePreparationFailureCode = z.infer<typeof preparationFailureCodeSchema>;

export const codespacePreparedSchema = z.union([
	z.strictObject({ ready: z.literal(true) }),
	z.strictObject({ ready: z.literal(false), error: z.strictObject({ code: preparationFailureCodeSchema }).optional() }),
]);
export type CodespacePreparedResult = z.infer<typeof codespacePreparedSchema>;

export const CODESPACE_PREPARATION_MESSAGES: Readonly<Record<CodespacePreparationFailureCode, string>> = {
	UNSUPPORTED_ENVIRONMENT: 'The native runtime requires Linux x64/arm64 and glibc 2.28 or newer. Check uname -m and getconf GNU_LIBC_VERSION in the Codespace terminal.',
	ENVIRONMENT_CHECK_FAILED: 'The system libc version could not be detected. Run getconf GNU_LIBC_VERSION in the Codespace terminal; missing diagnostic data does not mean glibc is too old.',
	INVALID_RELEASE: 'A verified native CLI release is unavailable for this VS Code version. Check the companion Output for release details.',
	UNSAFE_URL: 'The runtime download address did not match the official pinned release.',
	NETWORK_ERROR: 'The Codespace could not download the runtime from the official VS Code service. Check its outbound network access.',
	INTEGRITY_MISMATCH: 'The runtime failed its integrity check. See the companion Output; do not bypass verification.',
	SIZE_LIMIT: 'The runtime download or installation exceeded a safety limit.',
	INVALID_ARCHIVE: 'The runtime archive failed validation and was not installed.',
	INVALID_INSTALLATION: 'The private runtime cache is invalid. See the companion Output for the exact failure.',
	INCOMPATIBLE_INSTALLATION: 'The cached runtime does not match this platform or release. See the companion Output.',
	INSTALL_IN_PROGRESS: 'Another window is preparing this Codespaces runtime. Wait for it to finish and retry.',
	INSTALL_FAILED: 'Native runtime installation failed. See Output: Copilot Agent Mesh - Codespaces.',
	TIMED_OUT: 'Runtime preparation timed out. Check the Codespace connection and retry.',
	PROTOCOL_INCOMPATIBLE: 'The desktop and Codespaces companion versions do not match. Reload the window after installing the matching companion.',
	REMOTE_WORKSPACE_UNSUPPORTED: 'The companion must run inside a Linux Codespace attached to desktop VS Code.',
	WORKSPACE_UNTRUSTED: 'Trust the Codespace workspace before preparing its runtime.',
	CLEANUP_FAILED: 'Runtime preparation left cleanup work pending. See the companion Output before retrying.',
	PREPARATION_FAILED: 'Runtime preparation failed. See Output: Copilot Agent Mesh - Codespaces for the underlying error.',
};

export class CodespacePreparationError extends Error {
	public constructor(readonly code: CodespacePreparationFailureCode) {
		super(CODESPACE_PREPARATION_MESSAGES[code]);
		this.name = 'CodespacePreparationError';
	}
}

export function codespacePreparationFailure(error: unknown): CodespacePreparedResult {
	if (error instanceof Error && (error.name === 'AbortError'
		|| error instanceof CodespaceCliInstallerError && error.code === 'CANCELLED')) {
		return { ready: false };
	}
	const candidate = error instanceof AggregateError ? 'CLEANUP_FAILED'
		: error instanceof CodespaceCliInstallerError ? error.code
			: error instanceof MeshDomainError ? error.reason : 'PREPARATION_FAILED';
	const parsed = preparationFailureCodeSchema.safeParse(candidate);
	return { ready: false, error: { code: parsed.success ? parsed.data : 'PREPARATION_FAILED' } };
}
