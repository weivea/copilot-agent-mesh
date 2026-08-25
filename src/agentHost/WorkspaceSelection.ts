export type WorkspaceSelectionPlan<T> =
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'selected'; readonly workspace: T }
	| { readonly kind: 'prompt'; readonly workspaces: readonly T[] };

export function planWorkspaceSelection<T>(
	workspaces: readonly T[],
	activeWorkspace: T | undefined,
	isSame: (left: T, right: T) => boolean,
): WorkspaceSelectionPlan<T> {
	if (workspaces.length === 0) {
		return { kind: 'unavailable' };
	}
	if (activeWorkspace !== undefined) {
		const selected = workspaces.find((workspace) => isSame(workspace, activeWorkspace));
		if (selected !== undefined) {
			return { kind: 'selected', workspace: selected };
		}
	}
	if (workspaces.length === 1) {
		return { kind: 'selected', workspace: workspaces[0]! };
	}
	return { kind: 'prompt', workspaces };
}
