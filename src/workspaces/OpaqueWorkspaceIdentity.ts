import { createHash } from 'node:crypto';

const maximumIdentityBytes = 1_024;

export function createOpaqueWorkspaceIdentity(fileIdentity: string): string {
	const bytes = Buffer.byteLength(fileIdentity, 'utf8');
	if (bytes < 1 || bytes > maximumIdentityBytes) {
		throw new TypeError('Workspace identity source is invalid.');
	}
	return `sha256:${createHash('sha256')
		.update('copilot-agent-mesh/window-workspace-identity/v1\0', 'utf8')
		.update(fileIdentity, 'utf8')
		.digest('base64url')}`;
}
