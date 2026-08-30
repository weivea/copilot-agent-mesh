import { z } from 'zod';

import {
	PROTOCOL_LIMITS,
	nodeDirectoryResultSchema,
	nodeHeartbeatParamsSchema,
	nodeIdentityParamsSchema,
	nodeRegisterParamsSchema,
	nodeWorkspaceClaimParamsSchema,
	nodeWorkspaceReleaseParamsSchema,
	serializedLocalResultBytes,
	timestampSchema,
	utf8String,
	uuidSchema,
	type NodeDirectoryResult,
	type NodeHeartbeatParams,
	type NodeIdentityParams,
	type NodeRegisterParams,
	type NodeStatus,
	type NodeWorkspaceClaimParams,
	type NodeWorkspaceReleaseParams,
	type WindowNodeDescriptor,
	type WorkspaceClaimStatus,
} from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import type { Clock, IdGenerator, StateStore } from '../domain/ports';
import type { LocalIpcSession } from '../ipc/LocalIpcTransport';
import type { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';

export const WORKSPACE_CATALOG_STATE_KEY = 'copilotAgentMesh.workspaceCatalog';

const workspaceCatalogEntrySchema = z.strictObject({
	workspaceId: uuidSchema,
	workspaceIdentity: utf8String(1_024, 'workspace identity', 1),
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace name', 1),
	capabilityTags: z.array(utf8String(64, 'capability tag', 1)).max(32),
	enabled: z.boolean(),
	createdAt: timestampSchema,
	updatedAt: timestampSchema,
});

export const workspaceCatalogV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	workspaces: z.array(workspaceCatalogEntrySchema).max(PROTOCOL_LIMITS.workspaceListCount),
}).superRefine((catalog, context) => {
	const workspaceIds = new Set<string>();
	const identities = new Set<string>();
	for (const [index, workspace] of catalog.workspaces.entries()) {
		if (workspaceIds.has(workspace.workspaceId)) {
			context.addIssue({
				code: 'custom',
				path: ['workspaces', index, 'workspaceId'],
				message: 'Workspace IDs must be unique',
			});
		}
		if (identities.has(workspace.workspaceIdentity)) {
			context.addIssue({
				code: 'custom',
				path: ['workspaces', index, 'workspaceIdentity'],
				message: 'Workspace identities must be unique',
			});
		}
		workspaceIds.add(workspace.workspaceId);
		identities.add(workspace.workspaceIdentity);
	}
});

const workspaceRegistryV1EntrySchema = z.strictObject({
	workspaceId: uuidSchema,
	registeredUri: z.string().url().refine(
		(value) => new URL(value).protocol === 'file:',
		'Workspace URI must use file:',
	),
	localUri: z.string().url().refine(
		(value) => new URL(value).protocol === 'file:',
		'Workspace URI must use file:',
	),
	fileIdentity: utf8String(1_024, 'workspace file identity', 1),
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace name', 1),
	capabilityTags: z.array(utf8String(64, 'capability tag', 1)).max(32),
	enabled: z.boolean(),
	stale: z.boolean().default(false),
	createdAt: timestampSchema,
	updatedAt: timestampSchema,
});

export const workspaceRegistryV1MigrationSchema = z.strictObject({
	schemaVersion: z.literal(1),
	workspaces: z.array(workspaceRegistryV1EntrySchema).max(PROTOCOL_LIMITS.workspaceListCount),
});

export type WorkspaceCatalogEntry = z.infer<typeof workspaceCatalogEntrySchema>;
export type WorkspaceCatalogV2 = z.infer<typeof workspaceCatalogV2Schema>;

export interface WorkspaceClaimResult {
	readonly workspaceId: string;
	readonly status: WorkspaceClaimStatus;
	readonly canExecute: boolean;
}

export interface TaskRouteRequest {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly workspaceId: string;
	readonly ownerId: string;
	readonly taskId: string;
	readonly sourceNodeId?: string;
	readonly sourceNodeInstanceId?: string;
}

export interface TaskRoute {
	readonly session: LocalIpcSession;
	readonly workspaceLeaseKey: string;
}

export interface ResolvedTaskRoute extends TaskRoute, NodeTaskBinding {}

export interface NodeTaskBinding extends TaskRouteRequest {
	readonly workspaceLeaseKey: string;
}

export interface AuthenticatedNodeTaskEvent {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly taskId: string;
}

export interface PeerWorkspaceSnapshot {
	readonly workspaceId: string;
	readonly workspaceIdentity: string;
	readonly name: string;
	readonly status: WorkspaceClaimStatus;
	readonly busy: boolean;
}

export interface PeerNodeSnapshot {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly label: string;
	readonly status: NodeStatus;
	readonly online: boolean;
	readonly workspaces: readonly PeerWorkspaceSnapshot[];
}

export interface PeerRouteAuthorizationContext {
	readonly source: PeerNodeSnapshot | undefined;
	readonly target: PeerNodeSnapshot | undefined;
	readonly targetWorkspaceIdentity: string | undefined;
}

export interface PeerRouteAuthorizer {
	assertRouteAllowed(
		request: TaskRouteRequest,
		context: PeerRouteAuthorizationContext,
	): void;
	displayLabel?(node: PeerNodeSnapshot): string;
}

export interface RegistryTimer {
	dispose(): void;
}

export interface RegistryScheduler {
	repeat(callback: () => void, intervalMs: number): RegistryTimer;
}

export interface NodeRegistryOptions {
	readonly deviceId: string;
	readonly state: StateStore;
	readonly ids: IdGenerator;
	readonly clock: Clock;
	readonly workspaceLeases: WorkspaceLeaseManager;
	readonly heartbeatTtlMs?: number;
	readonly sweepIntervalMs?: number;
	readonly scheduler?: RegistryScheduler;
	readonly catalogStateKey?: string;
	readonly migrationStateKey?: string;
	readonly onNodeTasksLost?: (bindings: readonly NodeTaskBinding[]) => void;
}

interface WorkspaceObservation {
	readonly workspaceId: string;
	readonly workspaceIdentity: string;
	status: WorkspaceClaimStatus;
}

interface NodeRecord {
	readonly nodeId: string;
	nodeInstanceId: string;
	label: string;
	capabilities: readonly string[];
	status: NodeStatus;
	startedAt: string;
	lastHeartbeatAt: string;
	lastHeartbeatReceivedAt: number;
	offlineAt: number | undefined;
	session: LocalIpcSession | undefined;
	removeCloseListener: (() => void) | undefined;
	readonly workspaces: Map<string, WorkspaceObservation>;
	readonly workspaceHistory: Map<string, WorkspaceObservation>;
}

interface ActiveWorkspaceClaim {
	readonly workspaceIdentity: string;
	readonly workspaceId: string;
	readonly nodeId: string;
	readonly nodeInstanceId: string;
}

const defaultScheduler: RegistryScheduler = {
	repeat(callback, intervalMs) {
		const timer = setInterval(callback, intervalMs);
		timer.unref();
		return { dispose: () => clearInterval(timer) };
	},
};

export class NodeRegistry {
	private readonly nodes = new Map<string, NodeRecord>();
	private readonly claims = new Map<string, ActiveWorkspaceClaim>();
	private readonly taskBindings = new Map<string, NodeTaskBinding>();
	private catalog: WorkspaceCatalogV2 | undefined;
	private timer: RegistryTimer | undefined;
	private initializing: Promise<void> | undefined;
	private operationQueue: Promise<void> = Promise.resolve();
	private peerRouteAuthorizer: PeerRouteAuthorizer | undefined;
	private disposed = false;

	public constructor(private readonly options: NodeRegistryOptions) {
		uuidSchema.parse(options.deviceId);
		if (
			(options.heartbeatTtlMs ?? 30_000) <= 0
			|| (options.sweepIntervalMs ?? 5_000) <= 0
		) {
			throw new TypeError('Node heartbeat TTL and sweep interval must be positive.');
		}
	}

	public static async create(options: NodeRegistryOptions): Promise<NodeRegistry> {
		const registry = new NodeRegistry(options);
		await registry.initialize();
		return registry;
	}

	public initialize(): Promise<void> {
		this.assertNotDisposed();
		if (this.catalog !== undefined) {
			return Promise.resolve();
		}
		if (this.initializing !== undefined) {
			return this.initializing;
		}
		this.initializing = this.initializeCatalog();
		return this.initializing;
	}

	public register(params: NodeRegisterParams, session: LocalIpcSession): WindowNodeDescriptor {
		this.assertReady();
		const input = nodeRegisterParamsSchema.parse(params);
		if (session.closed) {
			throw new MeshDomainError('AGENT_UNAVAILABLE', 'The Window Node route is closed.');
		}
		const instanceOwner = [...this.nodes.values()].find(
			(node) =>
				node.nodeInstanceId === input.nodeInstanceId
				&& node.nodeId !== input.nodeId,
		);
		if (instanceOwner !== undefined) {
			throw new MeshDomainError(
				'AGENT_UNAVAILABLE',
				'The Window Node instance is already registered to another node.',
			);
		}

		const existing = this.nodes.get(input.nodeId);
		if (
			existing !== undefined
			&& existing.nodeInstanceId === input.nodeInstanceId
		) {
			if (this.sameRegistration(existing, input, session)) {
				return this.descriptor(existing);
			}
			if (
				existing.status !== 'offline'
				|| existing.session !== undefined
				|| !this.sameInstanceMetadata(existing, input)
			) {
				throw new MeshDomainError(
					'AGENT_UNAVAILABLE',
					'Window Node re-registration changed live instance metadata or route.',
				);
			}
			const now = this.options.clock.now();
			existing.status = input.status;
			existing.lastHeartbeatAt = now.toISOString();
			existing.lastHeartbeatReceivedAt = now.getTime();
			existing.offlineAt = undefined;
			existing.session = session;
			existing.removeCloseListener = this.listenForNodeClose(existing, session);
			return this.descriptor(existing);
		}
		if (existing !== undefined) {
			this.loseNode(existing, true);
			if (this.hasTaskBindings(existing)) {
				throw new MeshDomainError(
					'AGENT_UNAVAILABLE',
					'The prior Window Node instance is retained for active task cleanup.',
				);
			}
		} else {
			const liveCount = [...this.nodes.values()].filter(
				(node) => node.status !== 'offline',
			).length;
			if (liveCount >= PROTOCOL_LIMITS.nodeListCount) {
				throw new MeshDomainError('AGENT_UNAVAILABLE', 'Live Window Node directory is full.');
			}
			this.evictOfflineTombstones(1);
			if (this.nodes.size >= PROTOCOL_LIMITS.nodeListCount) {
				throw new MeshDomainError(
					'AGENT_UNAVAILABLE',
					'Window Node tombstones are retained for active task cleanup.',
				);
			}
		}

		const now = this.options.clock.now();
		const node: NodeRecord = {
			nodeId: input.nodeId,
			nodeInstanceId: input.nodeInstanceId,
			label: input.label,
			capabilities: [...input.capabilities],
			status: input.status,
			startedAt: input.startedAt,
			lastHeartbeatAt: now.toISOString(),
			lastHeartbeatReceivedAt: now.getTime(),
			offlineAt: undefined,
			session,
			removeCloseListener: undefined,
			workspaces: new Map(),
			workspaceHistory: new Map(),
		};
		node.removeCloseListener = this.listenForNodeClose(node, session);
		this.nodes.set(node.nodeId, node);
		return this.descriptor(node);
	}

	public heartbeat(params: NodeHeartbeatParams): WindowNodeDescriptor {
		this.assertReady();
		const input = nodeHeartbeatParamsSchema.parse(params);
		const node = this.requireLiveNode(input);
		if (Date.parse(input.at) < Date.parse(node.lastHeartbeatAt)) {
			throw new MeshDomainError('AGENT_UNAVAILABLE', 'Stale Window Node heartbeat.');
		}
		node.status = input.status;
		node.lastHeartbeatAt = input.at;
		node.lastHeartbeatReceivedAt = this.options.clock.now().getTime();
		return this.descriptor(node);
	}

	public unregister(params: NodeIdentityParams, closeSession = true): void {
		this.assertReady();
		const input = nodeIdentityParamsSchema.parse(params);
		const node = this.requireExactNode(input);
		if (node.status !== 'offline') {
			this.loseNode(node, closeSession);
		}
	}

	public sweepExpired(): readonly string[] {
		this.assertReady();
		const expired: string[] = [];
		const cutoff = this.options.clock.now().getTime() - (this.options.heartbeatTtlMs ?? 30_000);
		for (const node of this.nodes.values()) {
			if (
				node.status !== 'offline'
				&& node.lastHeartbeatReceivedAt <= cutoff
			) {
				expired.push(node.nodeId);
				this.loseNode(node, true);
			}
		}
		return expired.sort();
	}

	public list(): NodeDirectoryResult {
		this.assertReady();
		const available = [...this.nodes.values()]
			.sort((left, right) => left.nodeId.localeCompare(right.nodeId))
			.slice(0, PROTOCOL_LIMITS.nodeListCount)
			.map((node) => this.descriptor(node));
		const nodes: WindowNodeDescriptor[] = [];
		for (const node of available) {
			const candidate = {
				deviceId: this.options.deviceId,
				nodes: [...nodes, node],
				truncated: nodes.length + 1 < available.length,
				totalNodes: available.length,
			};
			if (serializedLocalResultBytes(candidate) > PROTOCOL_LIMITS.frameBytes) {
				break;
			}
			nodes.push(node);
		}
		return nodeDirectoryResultSchema.parse({
			deviceId: this.options.deviceId,
			nodes,
			truncated: nodes.length < available.length,
			totalNodes: available.length,
		});
	}

	public lookupNodeLabel(nodeId: string): string | undefined {
		this.assertReady();
		const id = uuidSchema.parse(nodeId);
		const node = this.nodes.get(id);
		if (
			node === undefined
			|| node.status === 'offline'
			|| node.session === undefined
			|| node.session.closed
		) {
			return undefined;
		}
		return this.peerRouteAuthorizer?.displayLabel?.(this.peerSnapshot(node)) ?? node.label;
	}

	public setPeerRouteAuthorizer(authorizer: PeerRouteAuthorizer): void {
		this.assertNotDisposed();
		if (this.peerRouteAuthorizer !== undefined && this.peerRouteAuthorizer !== authorizer) {
			throw new Error('The Node Registry peer route authorizer is already configured.');
		}
		this.peerRouteAuthorizer = authorizer;
	}

	public peerNode(identity: NodeIdentityParams): PeerNodeSnapshot | undefined {
		this.assertReady();
		const parsed = nodeIdentityParamsSchema.parse(identity);
		const node = this.nodes.get(parsed.nodeId);
		if (node === undefined || node.nodeInstanceId !== parsed.nodeInstanceId) {
			return undefined;
		}
		return this.peerSnapshot(node);
	}

	public peerNodes(): readonly PeerNodeSnapshot[] {
		this.assertReady();
		return [...this.nodes.values()]
			.sort((left, right) => left.nodeId.localeCompare(right.nodeId))
			.map((node) => this.peerSnapshot(node));
	}

	public claimWorkspace(params: NodeWorkspaceClaimParams): Promise<WorkspaceClaimResult> {
		return this.runExclusive(async () => {
			this.assertReady();
			const input = nodeWorkspaceClaimParamsSchema.parse(params);
			const node = this.requireLiveNode(input);
			const catalogEntry = await this.upsertCatalogEntry(input);
			if (this.requireLiveNode(input) !== node) {
				throw new MeshDomainError('AGENT_UNAVAILABLE', 'Window Node route changed during claim.');
			}
			const existingObservation = node.workspaces.get(input.workspaceIdentity);
			const active = this.claims.get(input.workspaceIdentity);

			if (!catalogEntry.enabled) {
				const observation = {
					workspaceId: catalogEntry.workspaceId,
					workspaceIdentity: input.workspaceIdentity,
					status: 'readOnly',
				} as const;
				node.workspaces.set(input.workspaceIdentity, observation);
				node.workspaceHistory.set(input.workspaceIdentity, observation);
				return claimResult(catalogEntry.workspaceId, 'readOnly');
			}
			if (
				active !== undefined
				&& (
					active.nodeId !== node.nodeId
					|| active.nodeInstanceId !== node.nodeInstanceId
				)
			) {
				const observation = {
					workspaceId: catalogEntry.workspaceId,
					workspaceIdentity: input.workspaceIdentity,
					status: 'conflict',
				} as const;
				node.workspaces.set(input.workspaceIdentity, observation);
				node.workspaceHistory.set(input.workspaceIdentity, observation);
				return claimResult(catalogEntry.workspaceId, 'conflict');
			}
			if (
				existingObservation !== undefined
				&& existingObservation.workspaceId !== catalogEntry.workspaceId
			) {
				throw new MeshDomainError('WORKSPACE_BUSY', 'Workspace claim identity changed.');
			}
			this.claims.set(input.workspaceIdentity, {
				workspaceId: catalogEntry.workspaceId,
				workspaceIdentity: input.workspaceIdentity,
				nodeId: node.nodeId,
				nodeInstanceId: node.nodeInstanceId,
			});
			const observation = {
				workspaceId: catalogEntry.workspaceId,
				workspaceIdentity: input.workspaceIdentity,
				status: 'claimed',
			} as const;
			node.workspaces.set(input.workspaceIdentity, observation);
			node.workspaceHistory.set(input.workspaceIdentity, observation);
			return claimResult(catalogEntry.workspaceId, 'claimed');
		});
	}

	public releaseWorkspace(params: NodeWorkspaceReleaseParams): void {
		this.assertReady();
		const input = nodeWorkspaceReleaseParamsSchema.parse(params);
		const node = this.requireLiveNode(input);
		const observation = [...node.workspaces.values()].find(
			(workspace) => workspace.workspaceId === input.workspaceId,
		);
		if (observation === undefined) {
			return;
		}
		const active = this.claims.get(observation.workspaceIdentity);
		if (
			active !== undefined
			&& active.nodeId === input.nodeId
			&& active.nodeInstanceId === input.nodeInstanceId
		) {
			this.claims.delete(observation.workspaceIdentity);
		}
		node.workspaces.delete(observation.workspaceIdentity);
		node.workspaceHistory.delete(observation.workspaceIdentity);
	}

	public acquireTaskRoute(request: TaskRouteRequest): Promise<TaskRoute> {
		return this.runExclusive(async () => {
			const { identity, node, claim } = this.requireAvailableTaskRoute(request);
			this.options.workspaceLeases.acquire(
				claim.workspaceIdentity,
				identity.ownerId,
				identity.taskId,
			);
			const binding: NodeTaskBinding = {
				...identity,
				workspaceLeaseKey: claim.workspaceIdentity,
			};
			this.taskBindings.set(identity.taskId, binding);
			return {
				session: node.session!,
				workspaceLeaseKey: claim.workspaceIdentity,
			};
		});
	}

	public validateTaskRoute(request: TaskRouteRequest): Promise<void> {
		return this.runExclusive(async () => {
			this.requireAvailableTaskRoute(request);
		});
	}

	public releaseTaskRoute(ownerId: string, taskId: string): boolean {
		const owner = uuidSchema.parse(ownerId);
		const task = uuidSchema.parse(taskId);
		const binding = this.taskBindings.get(task);
		if (binding === undefined || binding.ownerId !== owner) {
			return false;
		}
		this.options.workspaceLeases.release(binding.workspaceLeaseKey, owner, task);
		this.taskBindings.delete(task);
		return true;
	}

	public lookupTaskRoute(
		ownerId: string,
		taskId: string,
	): ResolvedTaskRoute | undefined {
		this.assertReady();
		const owner = uuidSchema.parse(ownerId);
		const task = uuidSchema.parse(taskId);
		const binding = this.taskBindings.get(task);
		if (binding === undefined || binding.ownerId !== owner) {
			return undefined;
		}
		const node = this.nodes.get(binding.nodeId);
		if (
			node === undefined
			|| node.nodeInstanceId !== binding.nodeInstanceId
			|| node.status === 'offline'
			|| node.session === undefined
			|| node.session.closed
		) {
			return undefined;
		}
		return {
			...binding,
			session: node.session,
		};
	}

	public authenticateTaskEvent(
		session: LocalIpcSession,
		event: AuthenticatedNodeTaskEvent,
	): NodeTaskBinding {
		this.assertReady();
		const identity = nodeTaskEventIdentitySchema.parse(event);
		const binding = this.taskBindings.get(identity.taskId);
		const node = this.nodes.get(identity.nodeId);
		if (
			binding === undefined
			|| binding.nodeId !== identity.nodeId
			|| binding.nodeInstanceId !== identity.nodeInstanceId
			|| node === undefined
			|| node.nodeInstanceId !== identity.nodeInstanceId
			|| node.status === 'offline'
			|| node.session !== session
			|| session.closed
		) {
			throw new MeshDomainError(
				'AGENT_UNAVAILABLE',
				'The Window Node task event route is stale or mismatched.',
			);
		}
		return { ...binding };
	}

	public catalogSnapshot(): WorkspaceCatalogV2 {
		this.assertReady();
		return structuredClone(this.catalog!);
	}

	public setWorkspaceEnabled(workspaceId: string, enabled: boolean): Promise<WorkspaceCatalogEntry> {
		return this.runExclusive(async () => {
			this.assertReady();
			const id = uuidSchema.parse(workspaceId);
			const catalog = this.catalog!;
			const index = catalog.workspaces.findIndex((workspace) => workspace.workspaceId === id);
			if (index < 0) {
				throw new MeshDomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.');
			}
			const current = catalog.workspaces[index];
			if (!enabled && this.options.workspaceLeases.isLeased(current.workspaceIdentity)) {
				throw new MeshDomainError('WORKSPACE_BUSY', 'An active task is using this workspace.');
			}
			const updated = workspaceCatalogEntrySchema.parse({
				...current,
				enabled,
				updatedAt: this.options.clock.now().toISOString(),
			});
			const workspaces = [...catalog.workspaces];
			workspaces[index] = updated;
			await this.writeCatalog(workspaces);
			if (!enabled) {
				this.claims.delete(current.workspaceIdentity);
				for (const node of this.nodes.values()) {
					const observation = node.workspaces.get(current.workspaceIdentity);
					if (observation !== undefined) {
						observation.status = 'readOnly';
					}
				}
			}
			return structuredClone(updated);
		});
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.timer?.dispose();
		this.timer = undefined;
		for (const node of this.nodes.values()) {
			if (node.status !== 'offline') {
				this.loseNode(node, true);
			} else {
				node.removeCloseListener?.();
				node.removeCloseListener = undefined;
			}
		}
		this.disposed = true;
	}

	private async initializeCatalog(): Promise<void> {
		const catalogKey = this.options.catalogStateKey ?? WORKSPACE_CATALOG_STATE_KEY;
		const migrationKey = this.options.migrationStateKey ?? 'copilotAgentMesh.workspaceRegistry';
		const current = this.options.state.get<unknown>(catalogKey);
		if (current !== undefined) {
			if (schemaVersionOf(current) === 1) {
				const migrated = migrateWorkspaceRegistryV1(current);
				await this.options.state.update(catalogKey, migrated);
				this.catalog = migrated;
			} else {
				this.catalog = workspaceCatalogV2Schema.parse(current);
			}
		} else {
			const legacy = this.options.state.get<unknown>(migrationKey);
			let next: WorkspaceCatalogV2;
			if (legacy === undefined) {
				next = { schemaVersion: 2, workspaces: [] };
			} else {
				next = migrateWorkspaceRegistryV1(legacy);
			}
			await this.options.state.update(catalogKey, next);
			this.catalog = next;
		}
		if (!this.disposed) {
			this.timer = (this.options.scheduler ?? defaultScheduler).repeat(
				() => {
					if (!this.disposed) {
						this.sweepExpired();
					}
				},
				this.options.sweepIntervalMs ?? 5_000,
			);
		}
	}

	private async upsertCatalogEntry(
		input: NodeWorkspaceClaimParams,
	): Promise<WorkspaceCatalogEntry> {
		const catalog = this.catalog!;
		const byIdentity = catalog.workspaces.find(
			(workspace) => workspace.workspaceIdentity === input.workspaceIdentity,
		);
		if (input.workspaceId !== undefined) {
			const byId = catalog.workspaces.find(
				(workspace) => workspace.workspaceId === input.workspaceId,
			);
			if (byId !== undefined && byId.workspaceIdentity !== input.workspaceIdentity) {
				throw new MeshDomainError(
					'WORKSPACE_BUSY',
					'Workspace ID belongs to a different physical identity.',
				);
			}
			if (byIdentity !== undefined && byIdentity.workspaceId !== input.workspaceId) {
				throw new MeshDomainError(
					'WORKSPACE_BUSY',
					'Physical workspace identity belongs to a different workspace ID.',
				);
			}
		}
		if (byIdentity !== undefined) {
			if (
				byIdentity.name === input.name
				&& arraysEqual(byIdentity.capabilityTags, input.capabilityTags)
			) {
				return byIdentity;
			}
			const updated = workspaceCatalogEntrySchema.parse({
				...byIdentity,
				name: input.name,
				capabilityTags: [...input.capabilityTags],
				updatedAt: this.options.clock.now().toISOString(),
			});
			await this.writeCatalog(catalog.workspaces.map((workspace) =>
				workspace.workspaceId === updated.workspaceId ? updated : workspace,
			));
			return updated;
		}
		if (catalog.workspaces.length >= PROTOCOL_LIMITS.workspaceListCount) {
			throw new MeshDomainError('WORKSPACE_BUSY', 'Workspace catalog is full.');
		}
		const at = this.options.clock.now().toISOString();
		const entry = workspaceCatalogEntrySchema.parse({
			workspaceId: input.workspaceId ?? this.options.ids.next(),
			workspaceIdentity: input.workspaceIdentity,
			name: input.name,
			capabilityTags: [...input.capabilityTags],
			enabled: true,
			createdAt: at,
			updatedAt: at,
		});
		await this.writeCatalog([...catalog.workspaces, entry]);
		return entry;
	}

	private async writeCatalog(workspaces: readonly WorkspaceCatalogEntry[]): Promise<void> {
		const next = workspaceCatalogV2Schema.parse({
			schemaVersion: 2,
			workspaces,
		});
		await this.options.state.update(
			this.options.catalogStateKey ?? WORKSPACE_CATALOG_STATE_KEY,
			next,
		);
		this.catalog = next;
	}

	private requireExactNode(identity: NodeIdentityParams): NodeRecord {
		const node = this.nodes.get(identity.nodeId);
		if (node === undefined || node.nodeInstanceId !== identity.nodeInstanceId) {
			throw new MeshDomainError('AGENT_UNAVAILABLE', 'Window Node instance is stale.');
		}
		return node;
	}

	private requireLiveNode(identity: NodeIdentityParams): NodeRecord {
		const node = this.requireExactNode(identity);
		if (node.status === 'offline' || node.session === undefined || node.session.closed) {
			throw new MeshDomainError('AGENT_UNAVAILABLE', 'Window Node is offline.');
		}
		return node;
	}

	private requireAvailableTaskRoute(request: TaskRouteRequest): {
		readonly identity: TaskRouteRequest;
		readonly node: NodeRecord;
		readonly claim: ActiveWorkspaceClaim;
	} {
		this.assertReady();
		const identity = taskRouteRequestSchema.parse(request);
		this.peerRouteAuthorizer?.assertRouteAllowed(
			identity,
			this.peerRouteAuthorizationContext(identity),
		);
		const node = this.requireLiveNode(identity);
		const claim = [...this.claims.values()].find(
			(candidate) =>
				candidate.workspaceId === identity.workspaceId
				&& candidate.nodeId === identity.nodeId
				&& candidate.nodeInstanceId === identity.nodeInstanceId,
		);
		if (claim === undefined) {
			throw new MeshDomainError(
				'WORKSPACE_NOT_FOUND',
				'The exact Window Node instance does not claim this workspace.',
			);
		}
		const catalogEntry = this.catalog!.workspaces.find(
			(workspace) => workspace.workspaceId === claim.workspaceId,
		);
		if (catalogEntry === undefined || !catalogEntry.enabled) {
			throw new MeshDomainError('WORKSPACE_DISABLED', 'Workspace is disabled.');
		}
		const existing = this.taskBindings.get(identity.taskId);
		if (
			existing !== undefined
			&& !sameTaskBinding(existing, identity, claim.workspaceIdentity)
		) {
			throw new MeshDomainError('TASK_ID_CONFLICT', 'Task route identity conflicts.');
		}
		const leaseOwner = this.options.workspaceLeases.owner(claim.workspaceIdentity);
		if (
			leaseOwner !== undefined
			&& (
				leaseOwner.peerId !== identity.ownerId
				|| leaseOwner.taskId !== identity.taskId
			)
		) {
			throw new MeshDomainError('WORKSPACE_BUSY', 'An active task is using this workspace.');
		}
		return { identity, node, claim };
	}

	private loseNode(node: NodeRecord, closeSession: boolean): void {
		node.removeCloseListener?.();
		node.removeCloseListener = undefined;
		const session = node.session;
		node.session = undefined;
		node.status = 'offline';
		node.offlineAt = this.options.clock.now().getTime();
		for (const workspace of node.workspaces.values()) {
			const active = this.claims.get(workspace.workspaceIdentity);
			if (
				active !== undefined
				&& active.nodeId === node.nodeId
				&& active.nodeInstanceId === node.nodeInstanceId
			) {
				this.claims.delete(workspace.workspaceIdentity);
			}
		}
		node.workspaces.clear();
		const lostBindings = [...this.taskBindings.values()]
			.filter((binding) =>
				binding.nodeId === node.nodeId
				&& binding.nodeInstanceId === node.nodeInstanceId,
			)
			.map((binding) => ({ ...binding }));
		if (closeSession && session !== undefined && !session.closed) {
			session.close();
		}
		if (lostBindings.length > 0) {
			this.options.onNodeTasksLost?.(lostBindings);
		}
	}

	private evictOfflineTombstones(requiredSlots: number): void {
		let remaining = Math.max(
			0,
			this.nodes.size + requiredSlots - PROTOCOL_LIMITS.nodeListCount,
		);
		if (remaining === 0) {
			return;
		}
		const candidates = [...this.nodes.values()]
			.filter((node) =>
				node.status === 'offline'
				&& !this.hasTaskBindings(node),
			)
			.sort((left, right) =>
				(left.offlineAt ?? left.lastHeartbeatReceivedAt)
					- (right.offlineAt ?? right.lastHeartbeatReceivedAt)
				|| left.startedAt.localeCompare(right.startedAt)
				|| left.nodeId.localeCompare(right.nodeId),
			);
		for (const candidate of candidates) {
			if (remaining === 0) {
				break;
			}
			if (this.nodes.get(candidate.nodeId) === candidate) {
				this.nodes.delete(candidate.nodeId);
				remaining -= 1;
			}
		}
	}

	private hasTaskBindings(node: NodeRecord): boolean {
		return [...this.taskBindings.values()].some((binding) =>
			binding.nodeId === node.nodeId
				&& binding.nodeInstanceId === node.nodeInstanceId,
		);
	}

	private descriptor(node: NodeRecord): WindowNodeDescriptor {
		const workspaces = [...node.workspaces.values()]
			.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
			.slice(0, PROTOCOL_LIMITS.workspaceListCount)
			.map((observation) => {
				const catalog = this.catalog!.workspaces.find(
					(workspace) => workspace.workspaceId === observation.workspaceId,
				);
				if (catalog === undefined) {
					throw new Error('Window Node workspace is missing from the catalog.');
				}
				const owner = this.options.workspaceLeases.owner(observation.workspaceIdentity);
				return {
					workspaceId: catalog.workspaceId,
					workspaceIdentity: observation.workspaceIdentity,
					name: catalog.name,
					capabilityTags: [...catalog.capabilityTags],
					enabled: catalog.enabled,
					busy: owner !== undefined,
					acceptsIncoming: false,
					claimStatus: observation.status,
					...(owner === undefined ? {} : { activeTaskId: owner.taskId }),
				};
			});
		return {
			nodeId: node.nodeId,
			nodeInstanceId: node.nodeInstanceId,
			label: node.label,
			status: node.status,
			capabilities: [...node.capabilities],
			startedAt: node.startedAt,
			lastHeartbeatAt: node.lastHeartbeatAt,
			workspaces,
		};
	}

	private peerRouteAuthorizationContext(
		request: TaskRouteRequest,
	): PeerRouteAuthorizationContext {
		const source = request.sourceNodeId === undefined || request.sourceNodeInstanceId === undefined
			? undefined
			: this.peerNode({
				nodeId: request.sourceNodeId,
				nodeInstanceId: request.sourceNodeInstanceId,
			});
		const target = this.peerNode({
			nodeId: request.nodeId,
			nodeInstanceId: request.nodeInstanceId,
		});
		const targetWorkspaceIdentity = this.catalog!.workspaces.find(
			(workspace) => workspace.workspaceId === request.workspaceId,
		)?.workspaceIdentity;
		return { source, target, targetWorkspaceIdentity };
	}

	private peerSnapshot(node: NodeRecord): PeerNodeSnapshot {
		const online = (
			(node.status === 'online' || node.status === 'busy')
			&& node.session !== undefined
			&& !node.session.closed
		);
		const observations = online ? node.workspaces : node.workspaceHistory;
		return {
			nodeId: node.nodeId,
			nodeInstanceId: node.nodeInstanceId,
			label: node.label,
			status: node.status,
			online,
			workspaces: [...observations.values()]
				.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
				.map((observation) => {
					const catalog = this.catalog!.workspaces.find(
						(workspace) => workspace.workspaceId === observation.workspaceId,
					);
					if (catalog === undefined) {
						throw new Error('Peer workspace is missing from the catalog.');
					}
					return {
						workspaceId: observation.workspaceId,
						workspaceIdentity: observation.workspaceIdentity,
						name: catalog.name,
						status: online ? observation.status : 'readOnly',
						busy: this.options.workspaceLeases.isLeased(observation.workspaceIdentity),
					};
				}),
		};
	}

	private sameRegistration(
		node: NodeRecord,
		input: NodeRegisterParams,
		session: LocalIpcSession,
	): boolean {
		return node.session === session
			&& node.label === input.label
			&& node.status === input.status
			&& node.startedAt === input.startedAt
			&& arraysEqual(node.capabilities, input.capabilities);
	}

	private sameInstanceMetadata(node: NodeRecord, input: NodeRegisterParams): boolean {
		return node.label === input.label
			&& node.startedAt === input.startedAt
			&& arraysEqual(node.capabilities, input.capabilities);
	}

	private listenForNodeClose(
		node: NodeRecord,
		session: LocalIpcSession,
	): () => void {
		return session.onClose(() => {
			if (
				this.nodes.get(node.nodeId) === node
				&& node.session === session
				&& node.status !== 'offline'
			) {
				this.loseNode(node, false);
			}
		});
	}

	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationQueue.then(operation, operation);
		this.operationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private assertReady(): void {
		this.assertNotDisposed();
		if (this.catalog === undefined) {
			throw new Error('NodeRegistry.initialize() must complete before use.');
		}
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new Error('NodeRegistry is disposed.');
		}
	}
}

const taskRouteRequestSchema = z.strictObject({
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
	workspaceId: uuidSchema,
	ownerId: uuidSchema,
	taskId: uuidSchema,
	sourceNodeId: uuidSchema.optional(),
	sourceNodeInstanceId: uuidSchema.optional(),
}).superRefine((request, context) => {
	if ((request.sourceNodeId === undefined) !== (request.sourceNodeInstanceId === undefined)) {
		context.addIssue({
			code: 'custom',
			path: ['sourceNodeInstanceId'],
			message: 'Source node ID and instance ID must be provided together',
		});
	}
});

const nodeTaskEventIdentitySchema = z.strictObject({
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
	taskId: uuidSchema,
});

function claimResult(workspaceId: string, status: WorkspaceClaimStatus): WorkspaceClaimResult {
	return {
		workspaceId,
		status,
		canExecute: status === 'claimed',
	};
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameTaskBinding(
	existing: NodeTaskBinding,
	request: TaskRouteRequest,
	workspaceLeaseKey: string,
): boolean {
	return existing.nodeId === request.nodeId
		&& existing.nodeInstanceId === request.nodeInstanceId
		&& existing.workspaceId === request.workspaceId
		&& existing.ownerId === request.ownerId
		&& existing.taskId === request.taskId
		&& existing.workspaceLeaseKey === workspaceLeaseKey;
}

function schemaVersionOf(value: unknown): unknown {
	return typeof value === 'object' && value !== null && 'schemaVersion' in value
		? value.schemaVersion
		: undefined;
}

export function migrateWorkspaceRegistryV1(value: unknown): WorkspaceCatalogV2 {
	const parsed = workspaceRegistryV1MigrationSchema.parse(value);
	return workspaceCatalogV2Schema.parse({
		schemaVersion: 2,
		workspaces: parsed.workspaces.map((workspace) => ({
			workspaceId: workspace.workspaceId,
			workspaceIdentity: createOpaqueWorkspaceIdentity(workspace.fileIdentity),
			name: workspace.name,
			capabilityTags: workspace.capabilityTags,
			enabled: workspace.enabled,
			createdAt: workspace.createdAt,
			updatedAt: workspace.updatedAt,
		})),
	});
}
