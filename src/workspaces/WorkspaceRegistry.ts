import { z } from 'zod';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
	fileIdentity: utf8String(1_024, 'workspace file identity', 1),
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

export interface ResolvedFileIdentity {
	readonly canonicalUri: string;
	readonly identity: string;
}

export interface FileIdentityResolver {
	resolve(localUri: string): Promise<ResolvedFileIdentity>;
}

export class WorkspaceRegistry {
	public constructor(
		private readonly state: StateStore,
		private readonly ids: IdGenerator,
		private readonly clock: Clock,
		private readonly fileIdentityResolver: FileIdentityResolver,
		private readonly isWorkspaceLeased: (workspaceLeaseKey: string) => boolean = () => false,
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
			busy: this.isWorkspaceLeased(workspace.fileIdentity),
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

	public leaseKey(workspaceId: string): string {
		return this.resolveEnabled(workspaceId).fileIdentity;
	}

	public async register(input: RegisterWorkspaceInput): Promise<LocalWorkspace> {
		const lexicalUri = normalizeLocalFileUri(input.localUri);
		const resolvedIdentity = await this.fileIdentityResolver.resolve(lexicalUri);
		const canonicalUri = normalizeLocalFileUri(resolvedIdentity.canonicalUri);
		const candidate = localWorkspaceSchema.pick({
			localUri: true,
			fileIdentity: true,
			name: true,
			capabilityTags: true,
		}).safeParse({
			...input,
			localUri: canonicalUri,
			fileIdentity: resolvedIdentity.identity,
			capabilityTags: input.capabilityTags ?? [],
		});
		if (!candidate.success) {
			throw new TypeError(`Invalid local workspace: ${candidate.error.message}`);
		}

		const registry = this.read();
		const existing = registry.workspaces.find(
			(workspace) => workspace.fileIdentity === candidate.data.fileIdentity,
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
		const parsedId = uuidSchema.safeParse(workspaceId);
		const index = parsedId.success
			? registry.workspaces.findIndex((workspace) => workspace.workspaceId === parsedId.data)
			: -1;
		if (index < 0) {
			throw new MeshDomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.');
		}
		if (!enabled && this.isWorkspaceLeased(registry.workspaces[index].fileIdentity)) {
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
		const registry = this.read();
		const parsedId = uuidSchema.safeParse(workspaceId);
		const normalizedId = parsedId.success ? parsedId.data : undefined;
		const existing = registry.workspaces.find(
			(workspace) => workspace.workspaceId === normalizedId,
		);
		if (existing !== undefined && this.isWorkspaceLeased(existing.fileIdentity)) {
			throw new MeshDomainError('WORKSPACE_BUSY', 'An active task is using this workspace.');
		}
		const workspaces = registry.workspaces.filter(
			(workspace) => workspace.workspaceId !== normalizedId,
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

function normalizeLocalFileUri(value: string): string {
	let uri: URL;
	try {
		uri = new URL(value);
	} catch {
		throw new TypeError('Workspace URI must be a valid file URI.');
	}
	if (
		uri.protocol !== 'file:'
		|| uri.username.length > 0
		|| uri.password.length > 0
		|| uri.search.length > 0
		|| uri.hash.length > 0
	) {
		throw new TypeError('Workspace URI must be a local file URI without credentials, query, or fragment.');
	}
	let filePath: string;
	try {
		filePath = fileURLToPath(uri);
	} catch {
		throw new TypeError('Workspace URI contains an invalid file path.');
	}
	return pathToFileURL(resolve(filePath)).href;
}
