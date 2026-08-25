import type { WorkspaceSummary } from '../../shared/protocol';
import type * as vscode from 'vscode';

import type { LocalDesktopWorkspaceGuard } from './LocalDesktopWorkspaceGuard';
import type { WorkspaceRegistry, LocalWorkspace } from '../workspaces/WorkspaceRegistry';
import type { WorkerOwnership } from '../storage/WorkerOwnerLock';

export class WorkspaceService {
	public constructor(
		private readonly registry: WorkspaceRegistry,
		private readonly guard: LocalDesktopWorkspaceGuard,
		private readonly workspaceFolders: () => readonly vscode.WorkspaceFolder[],
		private readonly activeWorkspaceFolder: () => vscode.WorkspaceFolder | undefined,
		private readonly selectWorkspaceFolder?: (
			folders: readonly vscode.WorkspaceFolder[],
		) => Promise<vscode.WorkspaceFolder | undefined>,
		private readonly capabilityTags: () => readonly string[] = () => [],
		private readonly ownership?: WorkerOwnership,
	) {}

	public async list(_authenticatedPeerId: string): Promise<{ readonly workspaces: readonly WorkspaceSummary[] }> {
		this.guard.assertAllowed();
		return { workspaces: await this.registry.listForWire() };
	}

	public listLocal(): Promise<readonly LocalWorkspace[]> {
		this.guard.assertAllowed();
		return this.ownership?.isOwner() === false
			? Promise.resolve(this.registry.listLocalSnapshot())
			: this.registry.listLocal();
	}

	public async registerCurrent(): Promise<LocalWorkspace> {
		await this.ownership?.assertOwner();
		this.guard.assertAllowed();
		const folders = this.workspaceFolders().filter((folder) => folder.uri.scheme === 'file');
		const active = this.activeWorkspaceFolder();
		let selected = active?.uri.scheme === 'file'
			? active
			: folders.length === 1 ? folders[0] : undefined;
		if (selected === undefined && folders.length > 1) {
			selected = await this.selectWorkspaceFolder?.(folders);
		}
		if (selected === undefined) {
			throw new Error('Select a local workspace folder before registering it.');
		}
		return this.registry.register({
			localUri: selected.uri.toString(),
			name: selected.name,
			capabilityTags: this.capabilityTags(),
		});
	}

	public async remove(workspaceId: string): Promise<void> {
		await this.ownership?.assertOwner();
		this.guard.assertAllowed();
		return this.registry.remove(workspaceId);
	}

	public async setEnabled(workspaceId: string, enabled: boolean): Promise<LocalWorkspace> {
		await this.ownership?.assertOwner();
		this.guard.assertAllowed();
		return this.registry.setEnabled(workspaceId, enabled);
	}
}
