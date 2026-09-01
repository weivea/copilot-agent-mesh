import { createHash } from 'node:crypto';

const maximumIdentityBytes = 1_024;
const workspaceIdentityPattern = /^sha256:[A-Za-z0-9_-]{43}$/u;

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

export function createWorkspaceScopeIdentity(
	workspaceIdentities: readonly string[],
): string {
	const identities = [...new Set(workspaceIdentities)].sort();
	if (
		identities.length === 0
		|| identities.some((identity) => !workspaceIdentityPattern.test(identity))
	) {
		throw new TypeError('Delegation source Workspace scope is invalid.');
	}
	if (identities.length === 1) {
		return identities[0];
	}
	const canonical = identities
		.map((identity) => `${Buffer.byteLength(identity, 'utf8')}:${identity}`)
		.join('');
	return `sha256:${createHash('sha256')
		.update('copilot-agent-mesh/delegation-workspace-scope/v1\0', 'utf8')
		.update(canonical, 'utf8')
		.digest('base64url')}`;
}
