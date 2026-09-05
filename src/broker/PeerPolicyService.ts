import {
	PROTOCOL_LIMITS,
	dashboardNodeDirectoryResultSchema,
	nodeDirectoryResultSchema,
	nodeIdentityParamsSchema,
	nodePolicyGetParamsSchema,
	nodePolicyResultSchema,
	nodePolicySetParamsSchema,
	peerPolicyCandidateParamsSchema,
	type DashboardNodeDirectoryResult,
	type NodeDirectoryResult,
	type NodeIdentityParams,
	type NodePolicyGetParams,
	type NodePolicyResult,
	type NodePolicySetParams,
	type PeerGateState,
	type PeerPolicyCandidate,
	type PeerPolicyCandidateParams,
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

export interface PeerPolicyCandidateBinding {
	readonly candidate: Omit<PeerPolicyCandidate, 'actionHandle'>;
	readonly sourceWorkspaceIdentity: string;
	readonly targetWorkspaceIdentity?: string;
	readonly targetNodeId?: string;
	readonly targetNodeInstanceId?: string;
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

	public acceptsIncoming(workspaceIdentity: string): boolean {
		return this.store.get(workspaceIdentity)?.acceptsIncoming === true;
	}

	public async setRemoteReceive(
		caller: NodeIdentityParams,
		workspaceIdentity: string,
		enabled: boolean,
	): Promise<void> {
		const owned = this.requireOwnedWorkspace(caller, workspaceIdentity);
		const names = this.effectiveWorkspaceNames();
		await this.store.update(workspaceIdentity, (current) => {
			this.requireOwnedWorkspace(caller, workspaceIdentity);
			return {
				windowName: current?.windowName ?? names.get(workspaceIdentity)
					?? resolveWindowDisplayName(undefined, owned.name, caller.nodeId),
				acceptsIncoming: enabled,
				allowlist: [...(current?.allowlist ?? [])],
			};
		}, [...names].map(([identity, windowName]) => ({ workspaceIdentity: identity, windowName })));
		this.changed();
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
		const raw = this.registry.list({ includeOffline: false });
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

	public listCandidates(caller: PeerPolicyCandidateParams): readonly PeerPolicyCandidateBinding[] {
		this.assertEnabled();
		const input = peerPolicyCandidateParamsSchema.parse(caller);
		const identity = { nodeId: input.nodeId, nodeInstanceId: input.nodeInstanceId };
		const source = this.requireCaller(identity);
		this.requireOwnedWorkspace(identity, input.workspaceIdentity);
		const sourcePolicy = this.projectPolicy(
			input.workspaceIdentity,
			source.workspaces.find(({ workspaceIdentity }) =>
				workspaceIdentity === input.workspaceIdentity
			)?.name ?? 'Workspace',
			input.nodeId,
		);
		const labels = this.effectiveNodeLabels();
		const onlineNodes = this.registry.peerNodes().filter(({ online }) => online);
		const representedIdentities = new Set(
			onlineNodes.flatMap(({ workspaces }) =>
				workspaces.map(({ workspaceIdentity }) => workspaceIdentity)
			),
		);
		const candidates: PeerPolicyCandidateBinding[] = onlineNodes
			.map((node) => {
				const workspace = node.workspaces.length === 1 ? node.workspaces[0] : undefined;
				const policy = workspace === undefined
					? undefined
					: this.store.get(workspace.workspaceIdentity);
				const self = node.nodeId === identity.nodeId
					&& node.nodeInstanceId === identity.nodeInstanceId;
				const allowlisted = workspace !== undefined
					&& sourcePolicy.allowlist.includes(workspace.workspaceIdentity);
				const claimState = node.workspaces.length > 1
					? 'multiWorkspace' as const
					: workspace?.status === 'claimed'
						? 'claimed' as const
						: 'unclaimed' as const;
				return {
					candidate: {
						nodeId: node.nodeId,
						nodeInstanceId: node.nodeInstanceId,
						windowLabel: labels.get(node.nodeId) ?? node.nodeId.slice(0, 8),
						workspaceName: node.workspaces.length > 1
							? `${node.workspaces.length} workspaces`
							: workspace === undefined
								? 'No Workspace'
								: safeDisplayName(workspace.name, 'Workspace'),
						online: node.online,
						acceptsIncoming: policy?.acceptsIncoming ?? false,
						busy: node.workspaces.some(({ busy }) => busy),
						allowlisted,
						self,
						canToggle: !self
							&& workspace !== undefined
							&& (node.online || allowlisted),
						claimState,
						gateState: self
							? workspace?.status === 'claimed' ? 'allowed' : 'notClaimed'
							: this.candidateGateState(source, node),
					},
					sourceWorkspaceIdentity: input.workspaceIdentity,
					...(workspace === undefined ? {} : {
						targetWorkspaceIdentity: workspace.workspaceIdentity,
						targetNodeId: node.nodeId,
						targetNodeInstanceId: node.nodeInstanceId,
					}),
				};
			});
			for (const targetWorkspaceIdentity of sourcePolicy.allowlist) {
				if (
					representedIdentities.has(targetWorkspaceIdentity)
				) {
				continue;
			}
			const stored = this.store.get(targetWorkspaceIdentity);
			candidates.push({
				candidate: {
					windowLabel: safeDisplayName(stored?.windowName ?? 'Offline peer', 'Offline peer'),
					workspaceName: 'Saved Workspace',
					online: false,
					acceptsIncoming: stored?.acceptsIncoming ?? false,
					busy: false,
					allowlisted: true,
					self: false,
					canToggle: true,
					claimState: 'unclaimed',
					gateState: 'offline',
				},
				sourceWorkspaceIdentity: input.workspaceIdentity,
				targetWorkspaceIdentity,
			});
		}
		return candidates.sort((left, right) =>
			candidatePriority(left) - candidatePriority(right)
			|| left.candidate.windowLabel.localeCompare(right.candidate.windowLabel),
		);
	}

	public async setCandidateAllowed(
		caller: NodeIdentityParams,
		binding: PeerPolicyCandidateBinding,
		allowed: boolean,
	): Promise<NodePolicyResult> {
		this.assertEnabled();
		const identity = nodeIdentityParamsSchema.parse(caller);
		const owned = this.requireOwnedWorkspace(identity, binding.sourceWorkspaceIdentity);
		const targetWorkspaceIdentity = binding.targetWorkspaceIdentity;
		if (targetWorkspaceIdentity === undefined || targetWorkspaceIdentity === binding.sourceWorkspaceIdentity) {
			throw new MeshDomainError('POLICY_FORBIDDEN', 'The policy candidate cannot be selected.');
		}
		const validateTarget = (): void => {
			this.requireOwnedWorkspace(identity, binding.sourceWorkspaceIdentity);
			if (binding.targetNodeId === undefined && binding.targetNodeInstanceId === undefined) {
				if (allowed) {
					throw new MeshDomainError(
						'POLICY_FORBIDDEN',
						'An offline policy entry cannot be newly allowlisted.',
					);
				}
				return;
			}
			if (binding.targetNodeId === undefined || binding.targetNodeInstanceId === undefined) {
				throw new MeshDomainError('POLICY_FORBIDDEN', 'The policy candidate binding is incomplete.');
			}
			const live = this.registry.peerNode({
				nodeId: binding.targetNodeId,
				nodeInstanceId: binding.targetNodeInstanceId,
			});
			const workspace = live?.workspaces.length === 1 ? live.workspaces[0] : undefined;
			if (workspace?.workspaceIdentity !== targetWorkspaceIdentity) {
				throw new MeshDomainError('POLICY_FORBIDDEN', 'The policy candidate is stale.');
			}
			if (allowed && (!live?.online || workspace.status !== 'claimed')) {
				throw new MeshDomainError('POLICY_FORBIDDEN', 'Only a live claimed candidate can be allowlisted.');
			}
		};
		validateTarget();
		const effectiveNames = this.effectiveWorkspaceNames();
		const entry = await this.store.update(binding.sourceWorkspaceIdentity, (current) => {
			validateTarget();
			const allowlist = new Set(current?.allowlist ?? []);
			if (allowed) {
				allowlist.add(targetWorkspaceIdentity);
			} else {
				allowlist.delete(targetWorkspaceIdentity);
			}
			return {
				windowName: current?.windowName
					?? effectiveNames.get(binding.sourceWorkspaceIdentity)
					?? resolveWindowDisplayName(undefined, owned.name, identity.nodeId),
				acceptsIncoming: current?.acceptsIncoming ?? false,
				allowlist: [...allowlist],
			};
		}, [...effectiveNames].map(([workspaceIdentity, windowName]) => ({
			workspaceIdentity,
			windowName,
		})));
		this.changed();
		return this.toResult(binding.sourceWorkspaceIdentity, entry);
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

function candidatePriority(binding: PeerPolicyCandidateBinding): number {
	if (!binding.candidate.online) {
		return 3;
	}
	return binding.candidate.allowlisted
		? 0
		: binding.candidate.self ? 1 : 2;
}
