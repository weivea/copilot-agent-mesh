import { MeshDomainError } from '../domain/errors';

export interface WorkspaceFolderDescriptor {
	readonly uriScheme: string;
}

export interface LocalDesktopEnvironment {
	readonly remoteName: string | undefined;
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
		if (environment.remoteName !== undefined) {
			throw new MeshDomainError(
				'REMOTE_WORKSPACE_UNSUPPORTED',
				'Copilot Agent Mesh v1 only supports local desktop workspaces.',
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
		if (folders.some((folder) => folder.uriScheme !== 'file')) {
			throw new MeshDomainError(
				'LOCAL_FILE_WORKSPACE_REQUIRED',
				'All workspace folders must use the local file scheme.',
			);
		}
	}
}
