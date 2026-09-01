import {
	PROTOCOL_LIMITS,
	dashboardNodeDirectoryResultSchema,
	nodeDirectoryResultSchema,
	nodeIdentityParamsSchema,
	nodePolicyGetParamsSchema,
	nodePolicyResultSchema,
	nodePolicySetParamsSchema,
	peerPolicyCandidateListResultSchema,
	type DashboardNodeDirectoryResult,
	type NodeDirectoryResult,
	type NodeIdentityParams,
	type NodePolicyGetParams,
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
import { foldWindowName, resolveWindowDisplayName } from './WindowName';

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

	public getPolicy(caller: NodePolicyGetParams): NodePolicyResult {
		this.assertEnabled();
		const input = nodePolicyGetParamsSchema.parse(caller);
		const identity = {
			nodeId: input.nodeId,
			nodeInstanceId: input.nodeInstanceId,
		};
		const workspace = input.workspaceIdentity === undefined
			? this.requireSingleOwnedWorkspace(identity)
			: this.requireOwnedWorkspace(identity, input.workspaceIdentity);
		return this.projectPolicy(
			workspace.workspaceIdentity,
			workspace.name,
			identity.nodeId,
		);
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
		const effectiveNames = this.effectiveWorkspaceNames();
		const entry = await this.store.update(input.workspaceIdentity, (current) => ({
			windowName: input.windowName
				?? current?.windowName
				?? effectiveNames.get(input.workspaceIdentity)
				?? resolveWindowDisplayName(undefined, owned.name, identity.nodeId),
			acceptsIncoming: input.acceptsIncoming ?? current?.acceptsIncoming ?? false,
			allowlist: input.allowlist === undefined
				? [...(current?.allowlist ?? [])]
				: [...input.allowlist],
		}), [...effectiveNames].map(([workspaceIdentity, windowName]) => ({
			workspaceIdentity,
			windowName,
		})));
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
		const labels = this.effectiveNodeLabels();
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
			.map((node) => this.projectAuthorizedNode(node, labels.get(node.nodeId)));
		return nodeDirectoryResultSchema.parse({
			deviceId: raw.deviceId,
			nodes,
			truncated: false,
			totalNodes: nodes.length,
		});
	}

	public displayLabel(node: PeerNodeSnapshot): string {
		return this.effectiveNodeLabels().get(node.nodeId) ?? node.nodeId.slice(0, 8);
	}

	public listDashboard(caller: NodeIdentityParams): DashboardNodeDirectoryResult {
		this.requireCaller(caller);
		const raw = this.registry.list();
		const labels = this.effectiveNodeLabels();
		return dashboardNodeDirectoryResultSchema.parse({
			deviceId: raw.deviceId,
			nodes: raw.nodes.map((node) => {
				return {
					nodeId: node.nodeId,
					nodeInstanceId: node.nodeInstanceId,
					label: labels.get(node.nodeId) ?? node.nodeId.slice(0, 8),
					status: node.status,
					workspaces: node.workspaces.map((entry) => ({
						workspaceId: entry.workspaceId,
						name: safeDisplayName(entry.name, 'Workspace'),
						capabilityTags: entry.capabilityTags.map((tag) =>
							safeDisplayName(tag, 'Capability')
						),
						enabled: entry.enabled,
						busy: entry.busy,
						claimStatus: entry.claimStatus,
						...(entry.activeTaskId === undefined
							? {}
							: { activeTaskId: entry.activeTaskId }),
					})),
				};
			}),
			truncated: raw.truncated,
			totalNodes: raw.totalNodes,
		});
	}

	public listCandidates(caller: NodeIdentityParams): PeerPolicyCandidateListResult {
		this.assertEnabled();
		const identity = nodeIdentityParamsSchema.parse(caller);
		const source = this.registry.peerNode(identity);
		if (source === undefined) {
			throw new MeshDomainError('POLICY_FORBIDDEN', 'The policy caller is not registered.');
		}
		const labels = this.effectiveNodeLabels();
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
					label: labels.get(node.nodeId) ?? node.nodeId.slice(0, 8),
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

	private projectAuthorizedNode(
		node: WindowNodeDescriptor,
		label: string | undefined,
	): WindowNodeDescriptor {
		return {
			...node,
			label: label ?? node.nodeId.slice(0, 8),
			workspaces: node.workspaces.map((entry) => ({
				...entry,
				name: safeDisplayName(entry.name, 'Workspace'),
				acceptsIncoming: this.store.get(entry.workspaceIdentity)?.acceptsIncoming ?? false,
			})),
		};
	}

	private effectiveWorkspaceNames(): ReadonlyMap<string, string> {
		const names = new Map<string, string>();
		const used = new Set<string>();
		for (const [workspaceIdentity, entry] of Object.entries(this.store.snapshot().entries)) {
			names.set(workspaceIdentity, entry.windowName);
			used.add(entry.windowNameFold);
		}
		const claimed = this.registry.peerNodes()
			.flatMap((node) => node.workspaces
				.filter(({ status }) => status === 'claimed')
				.map((workspace) => ({ nodeId: node.nodeId, workspace })))
			.sort((left, right) =>
				left.workspace.workspaceIdentity.localeCompare(right.workspace.workspaceIdentity),
			);
		for (const [index, { nodeId, workspace }] of claimed.entries()) {
			if (names.has(workspace.workspaceIdentity)) {
				continue;
			}
			const candidate = resolveWindowDisplayName(undefined, workspace.name, nodeId);
			const windowName = used.has(foldWindowName(candidate))
				? allocateEffectiveFallback(nodeId, index, used)
				: candidate;
			names.set(workspace.workspaceIdentity, windowName);
			used.add(foldWindowName(windowName));
		}
		return names;
	}

	private effectiveNodeLabels(): ReadonlyMap<string, string> {
		const workspaceNames = this.effectiveWorkspaceNames();
		const nodes = this.registry.peerNodes();
		const labels = new Map<string, string>();
		const used = new Set<string>();
		const candidates = nodes.map((node) => {
			const workspace = node.workspaces.length === 1 ? node.workspaces[0] : undefined;
			const policy = workspace === undefined
				? undefined
				: this.store.get(workspace.workspaceIdentity);
			const ownsClaim = node.online && workspace?.status === 'claimed';
			return {
				node,
				candidate: workspace === undefined
					? node.nodeId.slice(0, 8)
					: workspaceNames.get(workspace.workspaceIdentity)
						?? resolveWindowDisplayName(undefined, workspace.name, node.nodeId),
				priority: policy === undefined
					? ownsClaim ? 2 : 3
					: ownsClaim ? 0 : 1,
			};
		}).sort((left, right) =>
			left.priority - right.priority || left.node.nodeId.localeCompare(right.node.nodeId),
		);
		for (const [index, { node, candidate }] of candidates.entries()) {
			const label = used.has(foldWindowName(candidate))
				? allocateEffectiveFallback(node.nodeId, index, used)
				: candidate;
			labels.set(node.nodeId, label);
			used.add(foldWindowName(label));
		}
		return labels;
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

	private projectPolicy(
		workspaceIdentity: string,
		fallbackName: string,
		nodeId: string,
	): NodePolicyResult {
		const entry = this.store.get(workspaceIdentity);
		return nodePolicyResultSchema.parse({
			workspaceIdentity,
			windowName: entry?.windowName
				?? this.effectiveWorkspaceNames().get(workspaceIdentity)
				?? resolveWindowDisplayName(undefined, fallbackName, nodeId),
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

function allocateEffectiveFallback(
	nodeId: string,
	index: number,
	used: ReadonlySet<string>,
): string {
	const shortNodeId = nodeId.slice(0, 8);
	for (let attempt = 0; ; attempt += 1) {
		const suffix = attempt === 0 ? `${index + 1}` : `${index + 1}-${attempt + 1}`;
		const candidate = attempt === 0 && !used.has(foldWindowName(shortNodeId))
			? shortNodeId
			: `${shortNodeId}-${suffix}`;
		if (!used.has(foldWindowName(candidate))) {
			return candidate;
		}
	}
}

function safeDisplayName(value: string, fallback: string): string {
	if (containsUnsafeDashboardText(value)) {
		return fallback;
	}
	return value;
}
