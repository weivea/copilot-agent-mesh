import { z } from 'zod';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	PROTOCOL_LIMITS,
	utf8String,
	uuidSchema,
	workspaceListResultSchema,
	type WorkspaceSummary,
} from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import type { Clock, IdGenerator, StateStore } from '../domain/ports';

const WORKSPACE_REGISTRY_KEY = 'copilotAgentMesh.workspaceRegistry';

const localWorkspaceSchema = z.strictObject({
	workspaceId: uuidSchema,
	registeredUri: z.string().url().refine((value) => new URL(value).protocol === 'file:', 'Workspace URI must use file:'),
	localUri: z.string().url().refine((value) => new URL(value).protocol === 'file:', 'Workspace URI must use file:'),
	fileIdentity: utf8String(1_024, 'workspace file identity', 1),
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace name', 1),
	capabilityTags: z.array(utf8String(64, 'capability tag', 1)).max(32),
	enabled: z.boolean(),
	stale: z.boolean().default(false),
	createdAt: z.string().datetime({ offset: true }),
	updatedAt: z.string().datetime({ offset: true }),
});

const workspaceRegistrySchema = z.strictObject({
	schemaVersion: z.literal(1),
	workspaces: z.array(localWorkspaceSchema).max(PROTOCOL_LIMITS.workspaceListCount),
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

export interface WorkspaceLeaseCoordinator {
	isLeased(workspaceLeaseKey: string): boolean;
	acquire(workspaceLeaseKey: string, peerId: string, taskId: string): void;
}

export class WorkspaceRegistry {
	private operationQueue: Promise<void> = Promise.resolve();

	public constructor(
		private readonly state: StateStore,
		private readonly ids: IdGenerator,
		private readonly clock: Clock,
		private readonly fileIdentityResolver: FileIdentityResolver,
		private readonly workspaceLeases: WorkspaceLeaseCoordinator,
	) {}

	public listLocal(): Promise<readonly LocalWorkspace[]> {
		return this.runExclusive(async () =>
			(await this.revalidateAllUnlocked()).workspaces,
		);
	}

	public listLocalSnapshot(): readonly LocalWorkspace[] {
		return structuredClone(this.read().workspaces);
	}

	public listForWire(): Promise<readonly WorkspaceSummary[]> {
		return this.runExclusive(async () => {
			const workspaces = (await this.revalidateAllUnlocked()).workspaces.map((workspace) => ({
				workspaceId: workspace.workspaceId,
				name: workspace.name,
				capabilityTags: [...workspace.capabilityTags],
				enabled: workspace.enabled,
				busy: this.workspaceLeases.isLeased(workspace.fileIdentity),
			}));
			return workspaceListResultSchema.parse({ workspaces }).workspaces;
		});
	}

	public resolveEnabled(workspaceId: string): Promise<LocalWorkspace> {
		return this.runExclusive(() => this.resolveEnabledUnlocked(workspaceId));
	}

	public revalidate(workspaceId: string): Promise<LocalWorkspace> {
		return this.runExclusive(async () => {
			const registry = this.read();
			const index = this.findWorkspaceIndex(registry, workspaceId);
			const refreshed = await this.revalidateWorkspaceUnlocked(registry, index, true);
			return refreshed.workspace;
		});
	}

	private async resolveEnabledUnlocked(workspaceId: string): Promise<LocalWorkspace> {
		const parsedId = uuidSchema.safeParse(workspaceId);
		const registry = this.read();
		const index = parsedId.success
			? registry.workspaces.findIndex((candidate) => candidate.workspaceId === parsedId.data)
			: -1;
		if (index < 0) {
			throw new MeshDomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.');
		}
		const { workspace } = await this.revalidateWorkspaceUnlocked(registry, index);
		if (!workspace.enabled) {
			throw new MeshDomainError('WORKSPACE_DISABLED', 'Workspace is disabled.');
		}
		return workspace;
	}

	public acquireLease(
		workspaceId: string,
		peerId: string,
		taskId: string,
	): Promise<string> {
		return this.runExclusive(async () => {
			const workspace = await this.resolveEnabledUnlocked(workspaceId);
			this.workspaceLeases.acquire(workspace.fileIdentity, peerId, taskId);
			return workspace.fileIdentity;
		});
	}

	public async register(input: RegisterWorkspaceInput): Promise<LocalWorkspace> {
		return this.runExclusive(async () => {
			const registry = await this.revalidateAllUnlocked();
			const candidate = await this.resolveRegistrationInput(input);
			const sameRegistrationIndex = registry.workspaces.findIndex(
				(workspace) => workspace.registeredUri === candidate.registeredUri,
			);
			if (sameRegistrationIndex >= 0) {
				const previous = registry.workspaces[sameRegistrationIndex];
				if (
					previous.fileIdentity === candidate.fileIdentity
					&& previous.localUri === candidate.localUri
					&& !previous.stale
				) {
					return previous;
				}
				const identityChanged = previous.fileIdentity !== candidate.fileIdentity;
				if (identityChanged && this.workspaceLeases.isLeased(previous.fileIdentity)) {
					await this.disableWorkspaceUnlocked(registry, sameRegistrationIndex);
					throw new MeshDomainError(
						'WORKSPACE_BUSY',
						'Workspace identity changed while an active task is using it.',
					);
				}
				const collision = identityChanged
					? registry.workspaces.find(
					(workspace, index) =>
						index !== sameRegistrationIndex
						&& workspace.fileIdentity === candidate.fileIdentity,
					)
					: undefined;
				if (collision !== undefined) {
					await this.disableWorkspaceUnlocked(registry, sameRegistrationIndex);
					return collision;
				}
				const updated = localWorkspaceSchema.parse({
					...previous,
					...candidate,
					stale: false,
					updatedAt: this.clock.now().toISOString(),
				});
				const workspaces = [...registry.workspaces];
				workspaces[sameRegistrationIndex] = updated;
				await this.write(workspaces);
				return updated;
			}
			const existing = registry.workspaces.find(
				(workspace) => workspace.fileIdentity === candidate.fileIdentity,
			);
			if (existing !== undefined) {
				if (existing.stale) {
					const refreshed = localWorkspaceSchema.parse({
						...existing,
						...candidate,
						enabled: false,
						stale: false,
						updatedAt: this.clock.now().toISOString(),
					});
					const workspaces = registry.workspaces.map((workspace) =>
						workspace.workspaceId === existing.workspaceId ? refreshed : workspace,
					);
					await this.write(workspaces);
					return refreshed;
				}
				return existing;
			}
			if (registry.workspaces.length >= PROTOCOL_LIMITS.workspaceListCount) {
				throw new TypeError(
					`Workspace registry cannot contain more than ${PROTOCOL_LIMITS.workspaceListCount} entries.`,
				);
			}
			const at = this.clock.now().toISOString();
			const workspace = localWorkspaceSchema.parse({
				...candidate,
				workspaceId: this.ids.next(),
				enabled: true,
				stale: false,
				createdAt: at,
				updatedAt: at,
			});
			await this.write([...registry.workspaces, workspace]);
			return workspace;
		});
	}

	public async setEnabled(workspaceId: string, enabled: boolean): Promise<LocalWorkspace> {
		return this.runExclusive(async () => {
			const parsedId = uuidSchema.safeParse(workspaceId);
			const registry = this.read();
			const index = parsedId.success
				? registry.workspaces.findIndex((workspace) => workspace.workspaceId === parsedId.data)
				: -1;
			if (index < 0) {
				throw new MeshDomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.');
			}
			const refreshed = await this.revalidateWorkspaceUnlocked(registry, index);
			const current = refreshed.workspace;
			if (enabled && current.stale) {
				throw new MeshDomainError(
					'WORKSPACE_DISABLED',
					'Workspace must be explicitly revalidated or registered before it can be enabled.',
				);
			}
			if (!enabled && this.workspaceLeases.isLeased(current.fileIdentity)) {
				throw new MeshDomainError('WORKSPACE_BUSY', 'An active task is using this workspace.');
			}
			if (enabled && !current.enabled) {
				const liveIdentity = await this.resolveFileIdentity(current.registeredUri);
				if (
					liveIdentity.localUri !== current.localUri
					|| liveIdentity.fileIdentity !== current.fileIdentity
				) {
					throw new MeshDomainError(
						'WORKSPACE_BUSY',
						'Workspace identity must stabilize before it can be enabled.',
					);
				}
			}
			if (
				enabled
				&& refreshed.registry.workspaces.some((workspace) =>
					workspace.workspaceId !== current.workspaceId
					&& workspace.fileIdentity === current.fileIdentity
					&& workspace.enabled,
				)
			) {
				throw new MeshDomainError(
					'WORKSPACE_BUSY',
					'Another workspace registration resolves to the same filesystem identity.',
				);
			}
			const updated = localWorkspaceSchema.parse({
				...current,
				enabled,
				updatedAt: this.clock.now().toISOString(),
			});
			const workspaces = [...refreshed.registry.workspaces];
			const refreshedIndex = workspaces.findIndex(
				(workspace) => workspace.workspaceId === current.workspaceId,
			);
			workspaces[refreshedIndex] = updated;
			await this.write(workspaces);
			return updated;
		});
	}

	public async remove(workspaceId: string): Promise<void> {
		return this.runExclusive(async () => {
			const parsedId = uuidSchema.safeParse(workspaceId);
			const registry = this.read();
			const index = parsedId.success
				? registry.workspaces.findIndex((workspace) => workspace.workspaceId === parsedId.data)
				: -1;
			if (index < 0) {
				throw new MeshDomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.');
			}
			const refreshed = await this.revalidateWorkspaceUnlocked(registry, index);
			if (this.workspaceLeases.isLeased(refreshed.workspace.fileIdentity)) {
				throw new MeshDomainError('WORKSPACE_BUSY', 'An active task is using this workspace.');
			}
			await this.write(refreshed.registry.workspaces.filter(
				(workspace) => workspace.workspaceId !== refreshed.workspace.workspaceId,
			));
		});
	}

	private async resolveRegistrationInput(
		input: RegisterWorkspaceInput,
	): Promise<Pick<LocalWorkspace, 'registeredUri' | 'localUri' | 'fileIdentity' | 'name' | 'capabilityTags'>> {
		const registeredUri = normalizeLocalFileUri(input.localUri);
		const identity = await this.resolveFileIdentity(registeredUri);
		const candidate = localWorkspaceSchema.pick({
			registeredUri: true,
			localUri: true,
			fileIdentity: true,
			name: true,
			capabilityTags: true,
		}).safeParse({
			...input,
			registeredUri,
			...identity,
			capabilityTags: input.capabilityTags ?? [],
		});
		if (!candidate.success) {
			throw new TypeError(`Invalid local workspace: ${candidate.error.message}`);
		}
		return candidate.data;
	}

	private async resolveFileIdentity(
		registeredUri: string,
	): Promise<Pick<LocalWorkspace, 'localUri' | 'fileIdentity'>> {
		const resolved = await this.fileIdentityResolver.resolve(
			normalizeLocalFileUri(registeredUri),
		);
		const candidate = localWorkspaceSchema.pick({
			localUri: true,
			fileIdentity: true,
		}).safeParse({
			localUri: normalizeLocalFileUri(resolved.canonicalUri),
			fileIdentity: resolved.identity,
		});
		if (!candidate.success) {
			throw new TypeError(`Invalid resolved workspace identity: ${candidate.error.message}`);
		}
		return candidate.data;
	}

	private async revalidateAllUnlocked(): Promise<z.infer<typeof workspaceRegistrySchema>> {
		let registry = this.read();
		for (const workspace of [...registry.workspaces]) {
			const index = registry.workspaces.findIndex(
				(candidate) => candidate.workspaceId === workspace.workspaceId,
			);
			if (index >= 0) {
				registry = (await this.revalidateWorkspaceUnlocked(registry, index)).registry;
			}
		}
		return registry;
	}

	private async revalidateWorkspaceUnlocked(
		registry: z.infer<typeof workspaceRegistrySchema>,
		index: number,
		force = false,
	): Promise<{
		readonly registry: z.infer<typeof workspaceRegistrySchema>;
		readonly workspace: LocalWorkspace;
	}> {
		const previous = registry.workspaces[index];
		if (previous.stale && !force) {
			return { registry, workspace: previous };
		}
		let identity: Pick<LocalWorkspace, 'localUri' | 'fileIdentity'>;
		try {
			identity = await this.resolveFileIdentity(previous.registeredUri);
		} catch (error) {
			if (!isWorkspaceUnavailableError(error)) {
				throw error;
			}
			const stale = await this.markWorkspaceStaleUnlocked(registry, index);
			return { registry: stale.registry, workspace: stale.workspace };
		}
		if (
			previous.localUri === identity.localUri
			&& previous.fileIdentity === identity.fileIdentity
			&& !previous.stale
		) {
			return { registry, workspace: previous };
		}
		const identityChanged = previous.fileIdentity !== identity.fileIdentity;
		const collision = identityChanged && registry.workspaces.some((workspace, candidateIndex) =>
			candidateIndex !== index && workspace.fileIdentity === identity.fileIdentity,
		);
		if (
			identityChanged
			&& (this.workspaceLeases.isLeased(previous.fileIdentity) || collision)
		) {
			const disabled = await this.disableWorkspaceUnlocked(registry, index);
			return { registry: disabled.registry, workspace: disabled.workspace };
		}
		const updated = localWorkspaceSchema.parse({
			...previous,
			...identity,
			stale: false,
			updatedAt: this.clock.now().toISOString(),
		});
		const workspaces = [...registry.workspaces];
		workspaces[index] = updated;
		await this.write(workspaces);
		return {
			registry: { schemaVersion: 1, workspaces },
			workspace: updated,
		};
	}

	private async markWorkspaceStaleUnlocked(
		registry: z.infer<typeof workspaceRegistrySchema>,
		index: number,
	): Promise<{
		readonly registry: z.infer<typeof workspaceRegistrySchema>;
		readonly workspace: LocalWorkspace;
	}> {
		const previous = registry.workspaces[index];
		if (previous.stale && !previous.enabled) {
			return { registry, workspace: previous };
		}
		const stale = localWorkspaceSchema.parse({
			...previous,
			enabled: false,
			stale: true,
			updatedAt: this.clock.now().toISOString(),
		});
		const workspaces = [...registry.workspaces];
		workspaces[index] = stale;
		await this.write(workspaces);
		return {
			registry: { schemaVersion: 1, workspaces },
			workspace: stale,
		};
	}

	private async disableWorkspaceUnlocked(
		registry: z.infer<typeof workspaceRegistrySchema>,
		index: number,
	): Promise<{
		readonly registry: z.infer<typeof workspaceRegistrySchema>;
		readonly workspace: LocalWorkspace;
	}> {
		const previous = registry.workspaces[index];
		if (!previous.enabled) {
			return { registry, workspace: previous };
		}
		const disabled = localWorkspaceSchema.parse({
			...previous,
			enabled: false,
			updatedAt: this.clock.now().toISOString(),
		});
		const workspaces = [...registry.workspaces];
		workspaces[index] = disabled;
		await this.write(workspaces);
		return {
			registry: { schemaVersion: 1, workspaces },
			workspace: disabled,
		};
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

	private findWorkspaceIndex(
		registry: z.infer<typeof workspaceRegistrySchema>,
		workspaceId: string,
	): number {
		const parsedId = uuidSchema.safeParse(workspaceId);
		const index = parsedId.success
			? registry.workspaces.findIndex((workspace) => workspace.workspaceId === parsedId.data)
			: -1;
		if (index < 0) {
			throw new MeshDomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.');
		}
		return index;
	}

	private write(workspaces: readonly LocalWorkspace[]): Promise<void> {
		const registry = workspaceRegistrySchema.parse({
			schemaVersion: 1,
			workspaces,
		});
		return this.state.update(WORKSPACE_REGISTRY_KEY, registry);
	}

	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationQueue.then(operation, operation);
		this.operationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function isWorkspaceUnavailableError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null || !('code' in error)) {
		return false;
	}
	return new Set([
		'EACCES',
		'ELOOP',
		'ENOENT',
		'ENOTDIR',
		'EPERM',
		'ESTALE',
	]).has(String(error.code));
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
