import { MeshDomainError } from '../domain/errors';

export interface WorkspaceFolderDescriptor {
	readonly uriScheme: string;
	readonly uriAuthority?: string;
}

export interface LocalDesktopEnvironment {
	readonly remoteName: string | undefined;
	readonly uiKind?: 'desktop' | 'web';
	readonly extensionKind?: 'ui' | 'workspace';
	readonly isTrusted: boolean;
	readonly workspaceFolders: readonly WorkspaceFolderDescriptor[] | undefined;
}

export interface WorkspaceGuardOptions {
	readonly requireWorkspace: boolean;
}

export class LocalDesktopWorkspaceGuard {
	public constructor(
		private readonly environment: () => LocalDesktopEnvironment,
	) {}

	public assertAllowed(options: WorkspaceGuardOptions = { requireWorkspace: true }): void {
		const environment = this.environment();
		const codespaces = environment.remoteName === 'codespaces'
			&& environment.uiKind === 'desktop'
			&& environment.extensionKind === 'ui';
		if (environment.uiKind === 'web' || (environment.remoteName !== undefined && !codespaces)) {
			throw new MeshDomainError(
				'REMOTE_WORKSPACE_UNSUPPORTED',
				'Mesh supports local desktop workspaces and Codespaces attached to desktop VS Code.',
			);
		}
		if (!environment.isTrusted) {
			throw new MeshDomainError(
				'WORKSPACE_UNTRUSTED',
				'Trust this workspace before using Copilot Agent Mesh.',
			);
		}
		if (!options.requireWorkspace) {
			return;
		}

		const folders = environment.workspaceFolders;
		if (folders === undefined || folders.length === 0) {
			throw new MeshDomainError(
				'LOCAL_FILE_WORKSPACE_REQUIRED',
				'Open at least one local file workspace folder.',
			);
		}
		if (codespaces) {
			const authority = folders[0].uriAuthority;
			if (
				authority === undefined || !/^codespaces\+[^/\s\\?#]+$/u.test(authority)
				|| folders.some((folder) =>
					folder.uriScheme !== 'vscode-remote' || folder.uriAuthority !== authority)
			) {
				throw new MeshDomainError(
					'REMOTE_WORKSPACE_UNSUPPORTED',
					'All folders must belong to the attached Codespace.',
				);
			}
		} else if (folders.some((folder) => folder.uriScheme !== 'file')) {
			throw new MeshDomainError(
				'LOCAL_FILE_WORKSPACE_REQUIRED',
				'All workspace folders must use the local file scheme.',
			);
		}
	}
}
