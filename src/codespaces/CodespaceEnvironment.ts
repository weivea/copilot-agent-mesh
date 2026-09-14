import { createHash } from 'node:crypto';

import {
	LocalDesktopWorkspaceGuard,
	type LocalDesktopEnvironment,
} from '../application/LocalDesktopWorkspaceGuard';
import { MeshDomainError } from '../domain/errors';
import type { FileIdentityResolver } from '../workspaces/WorkspaceRegistry';
import { boundUtf8 } from '../workspaces/WorkspaceMetadata';

export const CODESPACES_COMPANION_ID = 'weivea.copilot-agent-mesh-codespaces';
export const CODESPACES_SETUP_COMMAND = 'copilotAgentMesh.codespaces.setup';
export const CODESPACES_PREPARE_RUNTIME_COMMAND = 'copilotAgentMesh.codespaces.prepareRuntime';

export interface CodespaceFolder {
	readonly uri: string;
	readonly name: string;
	readonly capabilityTags?: readonly string[];
}

export interface DesktopCodespaceBinding {
	readonly authority: string;
	readonly expectedFolders: readonly string[];
}

export interface CodespaceExecutionEnvironment {
	readonly remoteName: string | undefined;
	readonly uiKind: 'desktop' | 'web';
	readonly extensionKind: 'ui' | 'workspace';
	readonly isTrusted: boolean;
	readonly platform: NodeJS.Platform;
	readonly architecture: string;
}

export function desktopCodespaceBinding(
	environment: LocalDesktopEnvironment,
	folders: readonly CodespaceFolder[],
): DesktopCodespaceBinding | undefined {
	if (environment.remoteName !== 'codespaces') {
		return undefined;
	}
	new LocalDesktopWorkspaceGuard(() => environment).assertAllowed();
	const authority = environment.workspaceFolders?.[0]?.uriAuthority;
	if (authority === undefined || environment.workspaceFolders?.length !== folders.length) {
		throw unsupportedWorkspace();
	}
	assertCodespaceAuthority(authority);
	return {
		authority,
		expectedFolders: folders.map((folder) => codespaceFileUri(folder.uri, authority)),
	};
}

export function codespaceFileUri(remoteUri: string, authority: string): string {
	assertCodespaceAuthority(authority);
	const uri = parseWorkspaceUri(remoteUri);
	if (uri.protocol !== 'vscode-remote:' || decodedAuthority(uri) !== authority) {
		throw unsupportedWorkspace();
	}
	const file = new URL('file:///');
	file.pathname = uri.pathname;
	return file.href;
}

export function assertCodespaceAuthority(authority: string): void {
	if (authority.length > 1024 || !/^codespaces\+[^/\s\\?#:@]+$/u.test(authority)) {
		throw unsupportedWorkspace();
	}
}

export function assertCodespaceExecutionEnvironment(environment: CodespaceExecutionEnvironment): void {
	if (!environment.isTrusted) {
		throw new MeshDomainError('WORKSPACE_UNTRUSTED', 'Trust the Codespace before using Mesh execution.');
	}
	if (
		environment.remoteName !== 'codespaces'
		|| environment.uiKind !== 'desktop'
		|| environment.extensionKind !== 'workspace'
		|| environment.platform !== 'linux'
		|| !['x64', 'arm64'].includes(environment.architecture)
	) {
		throw new MeshDomainError(
			'REMOTE_WORKSPACE_UNSUPPORTED',
			'The Mesh companion requires a Linux Codespace attached to desktop VS Code.',
		);
	}
}

export async function describeCodespaceWorkspaces(
	authority: string,
	folders: readonly CodespaceFolder[],
	resolver: FileIdentityResolver,
): Promise<readonly {
	readonly sourceUri: string;
	readonly canonicalUri: string;
	readonly fileIdentity: string;
	readonly name: string;
	readonly capabilityTags: readonly string[];
}[]> {
	assertCodespaceAuthority(authority);
	if (folders.length === 0 || folders.length > 128) {
		throw unsupportedWorkspace();
	}
	const namespace = createHash('sha256').update(authority, 'utf8').digest('hex');
	const descriptions = [];
	for (const folder of folders) {
		const uri = parseWorkspaceUri(folder.uri);
		const sourceUri = uri.protocol === 'vscode-remote:'
			? codespaceFileUri(folder.uri, authority)
			: uri.protocol === 'file:' && (uri.host === '' || uri.host === 'localhost')
				? uri.href : undefined;
		if (sourceUri === undefined) {
			throw unsupportedWorkspace();
		}
		const resolved = await resolver.resolve(sourceUri);
		descriptions.push({
			sourceUri,
			canonicalUri: resolved.canonicalUri,
			fileIdentity: `codespaces:${namespace}:${resolved.identity}`,
			name: boundUtf8(folder.name, 256),
			capabilityTags: (folder.capabilityTags ?? [])
				.map((tag) => boundUtf8(tag.trim(), 64))
				.filter((tag) => tag.length > 0),
		});
	}
	return descriptions;
}

function parseWorkspaceUri(value: string | undefined): URL {
	if (value === undefined || !URL.canParse(value)) {
		throw unsupportedWorkspace();
	}
	const uri = new URL(value);
	if (
		uri.username || uri.password || uri.port || uri.search || uri.hash
		|| !uri.pathname.startsWith('/') || /[\u0000\r\n\\]/u.test(uri.pathname)
	) {
		throw unsupportedWorkspace();
	}
	return uri;
}

function decodedAuthority(uri: URL): string {
	try {
		const authority = decodeURIComponent(uri.host);
		assertCodespaceAuthority(authority);
		return authority;
	} catch (error: unknown) {
		if (error instanceof URIError) {
			throw unsupportedWorkspace();
		}
		throw error;
	}
}

function unsupportedWorkspace(): MeshDomainError {
	return new MeshDomainError(
		'REMOTE_WORKSPACE_UNSUPPORTED',
		'The workspace does not belong to this desktop Codespaces connection.',
	);
}
