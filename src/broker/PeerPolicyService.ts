import {
	PROTOCOL_LIMITS,
	nodeDirectoryResultSchema,
	nodeIdentityParamsSchema,
	nodePolicyResultSchema,
	nodePolicySetParamsSchema,
	peerPolicyCandidateListResultSchema,
	type NodeDirectoryResult,
	type NodeIdentityParams,
	type NodePolicyResult,
	type NodePolicySetParams,
	type PeerGateState,
	type PeerPolicyCandidateListResult,
	type WindowNodeDescriptor,
} from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import { containsUnsafeDashboardText } from '../ui/DashboardRedaction';
import type {
	NodeRegistry,
	PeerNodeSnapshot,
	PeerRouteAuthorizationContext,
	PeerRouteAuthorizer,
	TaskRouteRequest,
} from './NodeRegistry';
import type { PeerPolicyEntry, PeerPolicyStore } from './PeerPolicyStore';

export interface PeerPolicyServiceOptions {
	readonly enabled: () => boolean;
	readonly onDidChange?: () => void;
}

export class PeerPolicyService implements PeerRouteAuthorizer {
	private readonly listeners = new Set<() => void>();

	public constructor(
		private readonly store: PeerPolicyStore,
		private readonly registry: NodeRegistry,
		private readonly options: PeerPolicyServiceOptions,
	) {}

	public getPolicy(caller: NodeIdentityParams): NodePolicyResult {
		this.assertEnabled();
		const workspace = this.requireSingleOwnedWorkspace(caller);
		return this.projectPolicy(workspace.workspaceIdentity, workspace.name);
	}

	public async setPolicy(
		caller: NodeIdentityParams,
		params: NodePolicySetParams,
	): Promise<NodePolicyResult> {
		this.assertEnabled();
		const identity = nodeIdentityParamsSchema.parse(caller);
		const input = nodePolicySetParamsSchema.parse(params);
		if (input.nodeId !== identity.nodeId || input.nodeInstanceId !== identity.nodeInstanceId) {
			throw new MeshDomainError(
				'POLICY_FORBIDDEN',
				'The policy mutation does not belong to the authenticated Window Node.',
			);
		}
		const owned = this.requireOwnedWorkspace(identity, input.workspaceIdentity);
		if (input.allowlist?.includes(input.workspaceIdentity) === true) {
			throw new MeshDomainError(
				'POLICY_FORBIDDEN',
				'A workspace cannot allowlist itself.',
			);
		}
		const current = this.store.get(input.workspaceIdentity);
		const entry = await this.store.set(input.workspaceIdentity, {
			windowName: input.windowName ?? current?.windowName ?? owned.name,
			acceptsIncoming: input.acceptsIncoming ?? current?.acceptsIncoming ?? false,
			allowlist: input.allowlist === undefined
				? [...(current?.allowlist ?? [])]
				: [...input.allowlist],
		});
		this.changed();
		return this.toResult(input.workspaceIdentity, entry);
	}

	public listAuthorized(caller: NodeIdentityParams): NodeDirectoryResult {
		const identity = nodeIdentityParamsSchema.parse(caller);
		if (!this.options.enabled()) {
			return emptyDirectory(this.registry.list().deviceId);
		}
		const source = this.registry.peerNode(identity);
		if (source === undefined) {
			throw new MeshDomainError('POLICY_FORBIDDEN', 'The policy caller is not registered.');
		}
		const sourceWorkspaces = source.workspaces.filter(({ status }) => status === 'claimed');
		if (sourceWorkspaces.length === 0) {
			return emptyDirectory(this.registry.list().deviceId);
		}
		const raw = this.registry.list();
		const nodes = raw.nodes
			.filter((node) =>
				node.nodeId !== identity.nodeId
				&& this.gateState(
					source,
					this.registry.peerNode({
						nodeId: node.nodeId,
						nodeInstanceId: node.nodeInstanceId,
					}),
					undefined,
				) === 'allowed',
			)
			.map((node) => this.projectAuthorizedNode(node));
		return nodeDirectoryResultSchema.parse({
			deviceId: raw.deviceId,
			nodes,
			truncated: false,
			totalNodes: nodes.length,
		});
	}

	public listCandidates(caller: NodeIdentityParams): PeerPolicyCandidateListResult {
		this.assertEnabled();
		const identity = nodeIdentityParamsSchema.parse(caller);
		const source = this.registry.peerNode(identity);
		if (source === undefined) {
			throw new MeshDomainError('POLICY_FORBIDDEN', 'The policy caller is not registered.');
		}
		const candidates = this.registry.peerNodes()
			.filter((node) => node.nodeId !== identity.nodeId)
			.slice(0, PROTOCOL_LIMITS.nodeListCount)
			.map((node) => {
				const workspace = node.workspaces.length === 1 ? node.workspaces[0] : undefined;
				const policy = workspace === undefined
					? undefined
					: this.store.get(workspace.workspaceIdentity);
				return {
					nodeId: shortId(node.nodeId),
					nodeInstanceId: shortId(node.nodeInstanceId),
					...(workspace === undefined ? {} : { workspaceId: shortId(workspace.workspaceId) }),
					label: safeDisplayName(
						policy?.windowName ?? workspace?.name ?? node.label,
						shortId(node.nodeId),
					),
					...(node.workspaces.length > 1
						? { workspaceName: `${node.workspaces.length} workspaces` }
						: workspace === undefined
							? {}
							: { workspaceName: safeDisplayName(workspace.name, 'Workspace') }),
					online: node.online,
					acceptsIncoming: policy?.acceptsIncoming ?? false,
					busy: node.workspaces.some(({ busy }) => busy),
					gateState: this.candidateGateState(source, node),
				};
			});
		return peerPolicyCandidateListResultSchema.parse({
			candidates,
			truncated: false,
			totalCandidates: candidates.length,
		});
	}

	public assertRouteAllowed(
		request: TaskRouteRequest,
		context: PeerRouteAuthorizationContext,
	): void {
		if (request.sourceNodeId === undefined) {
			return;
		}
		if (!this.options.enabled()) {
			throw new MeshDomainError(
				'PEER_NOT_ACCEPTING',
				'Peer window delegation is disabled.',
			);
		}
		const state = this.gateState(
			context.source,
			context.target,
			context.targetWorkspaceIdentity,
		);
		switch (state) {
			case 'allowed':
				return;
			case 'notAllowed':
				throw new MeshDomainError(
					'PEER_NOT_ALLOWED',
					'The source workspace has not allowlisted the target workspace.',
				);
			case 'notAccepting':
				throw new MeshDomainError(
					'PEER_NOT_ACCEPTING',
					'The target workspace is not accepting incoming tasks.',
				);
			case 'multiWorkspace':
				throw new MeshDomainError(
					'PEER_MULTI_WORKSPACE',
					'Peer delegation requires the target Window Node to claim exactly one workspace.',
				);
			case 'offline':
			case 'notClaimed':
				throw new MeshDomainError(
					'PEER_OFFLINE',
					'The exact target Window Node workspace claim is not online.',
					true,
				);
		}
	}

	public onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	private gateState(
		source: PeerNodeSnapshot | undefined,
		target: PeerNodeSnapshot | undefined,
		targetWorkspaceIdentity: string | undefined,
	): PeerGateState {
		const targetIdentity = targetWorkspaceIdentity
			?? (target?.workspaces.length === 1
				? target.workspaces[0].workspaceIdentity
				: undefined);
		const sourceWorkspaces = source?.workspaces
			.filter(({ status }) => status === 'claimed') ?? [];
		const sourceAllows = targetIdentity !== undefined
			&& sourceWorkspaces.length > 0
			&& sourceWorkspaces.every(({ workspaceIdentity }) =>
					this.store.get(workspaceIdentity)?.allowlist.includes(targetIdentity) === true,
				);
		if (!sourceAllows) {
			return 'notAllowed';
		}
		if (this.store.get(targetIdentity)?.acceptsIncoming !== true) {
			return 'notAccepting';
		}
		if (target === undefined || !target.online) {
			return 'offline';
		}
		if (target.workspaces.length !== 1) {
			return target.workspaces.length > 1 ? 'multiWorkspace' : 'notClaimed';
		}
		const workspace = target.workspaces[0];
		if (
			workspace.workspaceIdentity !== targetIdentity
			|| workspace.status !== 'claimed'
		) {
			return 'notClaimed';
		}
		return 'allowed';
	}

	private candidateGateState(
		source: PeerNodeSnapshot,
		target: PeerNodeSnapshot,
	): PeerGateState {
		if (!target.online) {
			return 'offline';
		}
		if (target.workspaces.length > 1) {
			return 'multiWorkspace';
		}
		if (target.workspaces.length === 0) {
			return 'notClaimed';
		}
		return this.gateState(source, target, target.workspaces[0].workspaceIdentity);
	}

	private projectAuthorizedNode(node: WindowNodeDescriptor): WindowNodeDescriptor {
		const workspace = node.workspaces[0];
		const policy = workspace === undefined
			? undefined
			: this.store.get(workspace.workspaceIdentity);
		return {
			...node,
			label: safeDisplayName(
				policy?.windowName ?? workspace?.name ?? node.label,
				shortId(node.nodeId),
			),
			workspaces: node.workspaces.map((entry) => ({
				...entry,
				name: safeDisplayName(entry.name, 'Workspace'),
				acceptsIncoming: this.store.get(entry.workspaceIdentity)?.acceptsIncoming ?? false,
			})),
		};
	}

	private requireSingleOwnedWorkspace(caller: NodeIdentityParams) {
		const node = this.requireCaller(caller);
		const workspaces = node.workspaces.filter(({ status }) => status === 'claimed');
		if (workspaces.length !== 1) {
			throw new MeshDomainError(
				'POLICY_FORBIDDEN',
				'Policy lookup requires exactly one claimed caller workspace.',
			);
		}
		return workspaces[0];
	}

	private requireOwnedWorkspace(caller: NodeIdentityParams, workspaceIdentity: string) {
		const node = this.requireCaller(caller);
		const workspace = node.workspaces.find((candidate) =>
			candidate.workspaceIdentity === workspaceIdentity
				&& candidate.status === 'claimed',
		);
		if (workspace === undefined) {
			throw new MeshDomainError(
				'POLICY_FORBIDDEN',
				'A Window Node can only edit its own claimed workspace policy.',
			);
		}
		return workspace;
	}

	private requireCaller(caller: NodeIdentityParams): PeerNodeSnapshot {
		const identity = nodeIdentityParamsSchema.parse(caller);
		const node = this.registry.peerNode(identity);
		if (node === undefined || !node.online) {
			throw new MeshDomainError('POLICY_FORBIDDEN', 'The policy caller is not registered.');
		}
		return node;
	}

	private projectPolicy(workspaceIdentity: string, fallbackName: string): NodePolicyResult {
		const entry = this.store.get(workspaceIdentity);
		return nodePolicyResultSchema.parse({
			workspaceIdentity,
			windowName: entry?.windowName ?? fallbackName,
			acceptsIncoming: entry?.acceptsIncoming ?? false,
			allowlist: [...(entry?.allowlist ?? [])],
		});
	}

	private toResult(workspaceIdentity: string, entry: PeerPolicyEntry): NodePolicyResult {
		return nodePolicyResultSchema.parse({
			workspaceIdentity,
			windowName: entry.windowName,
			acceptsIncoming: entry.acceptsIncoming,
			allowlist: [...entry.allowlist],
		});
	}

	private assertEnabled(): void {
		if (!this.options.enabled()) {
			throw new MeshDomainError(
				'POLICY_FORBIDDEN',
				'Peer window delegation is disabled.',
			);
		}
	}

	private changed(): void {
		this.options.onDidChange?.();
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}

function emptyDirectory(deviceId: string): NodeDirectoryResult {
	return {
		deviceId,
		nodes: [],
		truncated: false,
		totalNodes: 0,
	};
}

function shortId(value: string): string {
	return value.slice(0, 8);
}

function safeDisplayName(value: string, fallback: string): string {
	if (containsUnsafeDashboardText(value)) {
		return fallback;
	}
	return value;
}
