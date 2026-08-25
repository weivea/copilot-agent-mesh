import { z } from 'zod';

import {
	PROTOCOL_LIMITS,
	utf8String,
	uuidSchema,
	type WorkspaceSummary,
} from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import type { Clock, IdGenerator, StateStore } from '../domain/ports';

const WORKSPACE_REGISTRY_KEY = 'copilotAgentMesh.workspaceRegistry';

const localWorkspaceSchema = z.strictObject({
	workspaceId: uuidSchema,
	localUri: z.string().url().refine((value) => new URL(value).protocol === 'file:', 'Workspace URI must use file:'),
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace name', 1),
	capabilityTags: z.array(utf8String(64, 'capability tag', 1)).max(32),
	enabled: z.boolean(),
	createdAt: z.string().datetime({ offset: true }),
	updatedAt: z.string().datetime({ offset: true }),
});

const workspaceRegistrySchema = z.strictObject({
	schemaVersion: z.literal(1),
	workspaces: z.array(localWorkspaceSchema),
});

export type LocalWorkspace = z.infer<typeof localWorkspaceSchema>;

export interface RegisterWorkspaceInput {
	readonly localUri: string;
	readonly name: string;
	readonly capabilityTags?: readonly string[];
}

export class WorkspaceRegistry {
	public constructor(
		private readonly state: StateStore,
		private readonly ids: IdGenerator,
		private readonly clock: Clock,
		private readonly isWorkspaceLeased: (workspaceId: string) => boolean = () => false,
	) {}

	public listLocal(): readonly LocalWorkspace[] {
		return this.read().workspaces;
	}

	public listForWire(): readonly WorkspaceSummary[] {
		return this.read().workspaces.map((workspace) => ({
			workspaceId: workspace.workspaceId,
			name: workspace.name,
			capabilityTags: [...workspace.capabilityTags],
			enabled: workspace.enabled,
			busy: this.isWorkspaceLeased(workspace.workspaceId),
		}));
	}

	public resolveEnabled(workspaceId: string): LocalWorkspace {
		const parsedId = uuidSchema.safeParse(workspaceId);
		const workspace = parsedId.success
			? this.read().workspaces.find((candidate) => candidate.workspaceId === parsedId.data)
			: undefined;
		if (workspace === undefined) {
			throw new MeshDomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.');
		}
		if (!workspace.enabled) {
			throw new MeshDomainError('WORKSPACE_DISABLED', 'Workspace is disabled.');
		}
		return workspace;
	}

	public async register(input: RegisterWorkspaceInput): Promise<LocalWorkspace> {
		const candidate = localWorkspaceSchema.pick({
			localUri: true,
			name: true,
			capabilityTags: true,
		}).safeParse({
			...input,
			capabilityTags: input.capabilityTags ?? [],
		});
		if (!candidate.success) {
			throw new TypeError(`Invalid local workspace: ${candidate.error.message}`);
		}

		const registry = this.read();
		const existing = registry.workspaces.find(
			(workspace) => workspace.localUri === candidate.data.localUri,
		);
		if (existing !== undefined) {
			return existing;
		}

		const at = this.clock.now().toISOString();
		const workspace = localWorkspaceSchema.parse({
			...candidate.data,
			workspaceId: this.ids.next(),
			enabled: true,
			createdAt: at,
			updatedAt: at,
		});
		await this.write([...registry.workspaces, workspace]);
		return workspace;
	}

	public async setEnabled(workspaceId: string, enabled: boolean): Promise<LocalWorkspace> {
		const registry = this.read();
		const index = registry.workspaces.findIndex((workspace) => workspace.workspaceId === workspaceId);
		if (index < 0) {
			throw new MeshDomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.');
		}
		if (!enabled && this.isWorkspaceLeased(workspaceId)) {
			throw new MeshDomainError('WORKSPACE_BUSY', 'An active task is using this workspace.');
		}
		const updated = localWorkspaceSchema.parse({
			...registry.workspaces[index],
			enabled,
			updatedAt: this.clock.now().toISOString(),
		});
		const workspaces = [...registry.workspaces];
		workspaces[index] = updated;
		await this.write(workspaces);
		return updated;
	}

	public async remove(workspaceId: string): Promise<void> {
		if (this.isWorkspaceLeased(workspaceId)) {
			throw new MeshDomainError('WORKSPACE_BUSY', 'An active task is using this workspace.');
		}
		const registry = this.read();
		const workspaces = registry.workspaces.filter(
			(workspace) => workspace.workspaceId !== workspaceId,
		);
		if (workspaces.length === registry.workspaces.length) {
			throw new MeshDomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.');
		}
		await this.write(workspaces);
	}

	private read(): z.infer<typeof workspaceRegistrySchema> {
		const stored = this.state.get<unknown>(WORKSPACE_REGISTRY_KEY);
		if (stored === undefined) {
			return { schemaVersion: 1, workspaces: [] };
		}
		const parsed = workspaceRegistrySchema.safeParse(stored);
		if (!parsed.success) {
			throw new TypeError(`Invalid persisted workspace registry: ${parsed.error.message}`);
		}
		return parsed.data;
	}

	private write(workspaces: readonly LocalWorkspace[]): Promise<void> {
		const registry = workspaceRegistrySchema.parse({
			schemaVersion: 1,
			workspaces,
		});
		return this.state.update(WORKSPACE_REGISTRY_KEY, registry);
	}
}
