import {
	nodeDirectoryResultSchema, type NodeDirectoryResult, type NodeIdentityParams,
	type TaskTarget, type WindowNodeDescriptor,
} from '../../shared/protocol';
import type { MeshRemoteDirectorySnapshot } from '../../shared/toolProtocol';
import { REMOTE_POLICY_CAPABILITY } from '../connectivity/ConnectivitySchemas';
import type { EndpointBindingStore } from '../connectivity/EndpointBindingStore';
import { MeshDomainError } from '../domain/errors';
import type { PeerProfileStore } from '../peer/PeerProfile';
import { createWorkspaceScopeIdentity } from '../workspaces/OpaqueWorkspaceIdentity';
import type {
	NodeRegistry, PeerNodeSnapshot, PeerRouteAuthorizer, PeerRouteAuthorizationContext, TaskRouteRequest,
} from './NodeRegistry';
import type { PeerPolicyService } from './PeerPolicyService';
import type { RemotePeerPolicyStore, RemoteAllowedTarget } from './RemotePeerPolicyStore';

export interface AuthenticatedRemoteTarget {
	readonly profileId: string;
	readonly profileGeneration: string;
	readonly deviceId: string;
	readonly node: WindowNodeDescriptor;
}

export class RemotePeerPolicyService implements PeerRouteAuthorizer {
	public constructor(
		private readonly store: RemotePeerPolicyStore,
		private readonly registry: NodeRegistry,
		private readonly local: PeerPolicyService,
		private readonly bindings: EndpointBindingStore,
		private readonly profiles: PeerProfileStore,
		private readonly options: {
			readonly strict: () => boolean;
			readonly enabled: () => boolean;
			readonly ready: () => boolean;
			readonly draining?: () => boolean;
			readonly assertPeerAllowed: (peerId: string) => void;
			readonly assertPeerActive: (peerId: string) => Promise<void>;
		},
	) {}

	public strict(): boolean {
		return this.options.strict();
	}

	public remoteDirectoryAvailable(): boolean {
		return this.options.ready() && this.options.draining?.() !== true
			&& (!this.strict() || this.options.enabled());
	}

	public requireEnabled(): void {
		if (!this.options.ready() || !this.options.enabled() || !this.strict()) {
			throw new MeshDomainError('PEER_NOT_ALLOWED', 'Strict cross-device delegation is disabled or blocked.');
		}
		this.assertNotDraining();
	}

	public assertNotDraining(): void {
		if (this.options.draining?.()) {
			throw new MeshDomainError('WORKER_DRAINING', 'Remote hosting migration is draining accepted tasks.', true);
		}
	}

	public sources(caller: NodeIdentityParams): readonly PeerNodeSnapshot['workspaces'][number][] {
		const node = this.registry.peerNode(caller);
		const workspaces = node?.online ? node.workspaces.filter((workspace) => workspace.status === 'claimed') : [];
		if (workspaces.length === 0) {
			throw new MeshDomainError('POLICY_FORBIDDEN', 'The authenticated source has no live workspace claim.');
		}
		return workspaces;
	}

	public sourceScope(caller: NodeIdentityParams): string {
		return createWorkspaceScopeIdentity(this.sources(caller).map((workspace) => workspace.workspaceIdentity));
	}

	public async setAllowed(
		caller: NodeIdentityParams, workspaceIdentity: string, target: RemoteAllowedTarget, allowed: boolean,
	): Promise<void> {
		this.requireEnabled();
		const validate = async (): Promise<void> => {
			this.requireOwned(caller, workspaceIdentity);
			if (allowed) {
				const profile = await this.profiles.get(target.profileId);
				const binding = this.bindings.get(target.profileId);
				if (profile?.generation !== target.profileGeneration || profile.cleanupPending
					|| binding?.profileGeneration !== target.profileGeneration) {
					throw new MeshDomainError('PEER_NOT_ALLOWED', 'The approved remote peer binding changed.');
				}
			}
		};
		await validate();
		await this.store.update(workspaceIdentity, (entry) => {
			const allowlist = entry.allowlist.filter((candidate) => !sameTarget(candidate, target));
			return { ...entry, allowlist: allowed ? [...allowlist, target] : allowlist };
		}, validate);
	}

	public async setIncomingGrant(
		caller: NodeIdentityParams, workspaceIdentity: string, peerId: string, allowed: boolean,
	): Promise<void> {
		this.requireEnabled();
		const validate = async (): Promise<void> => {
			this.requireOwned(caller, workspaceIdentity);
			if (allowed) {
				await this.options.assertPeerActive(peerId);
			}
		};
		await validate();
		await this.store.update(workspaceIdentity, (entry) => ({
			...entry,
			incomingPeerIds: allowed
				? [...new Set([...entry.incomingPeerIds, peerId])]
				: entry.incomingPeerIds.filter((value) => value !== peerId),
		}), validate);
	}

	public async setReceive(caller: NodeIdentityParams, workspaceIdentity: string, enabled: boolean): Promise<void> {
		this.requireEnabled();
		this.requireOwned(caller, workspaceIdentity);
		await this.local.setRemoteReceive(caller, workspaceIdentity, enabled);
	}

	public policy(workspaceIdentity: string) {
		return this.store.get(workspaceIdentity);
	}

	public async listIncoming(peerId: string): Promise<NodeDirectoryResult> {
		await this.options.assertPeerActive(peerId);
		const raw = this.registry.list();
		if (!this.strict()) {
			return {
				...raw,
				nodes: raw.nodes.map((node) => ({
					...node, capabilities: node.capabilities.filter((value) => value !== REMOTE_POLICY_CAPABILITY),
				})),
			};
		}
		this.requireEnabled();
		const nodes = raw.nodes.filter((node) => {
			const target = this.registry.peerNode({ nodeId: node.nodeId, nodeInstanceId: node.nodeInstanceId });
			return target?.online && target.workspaces.length === 1
				&& target.workspaces[0].status === 'claimed'
				&& node.workspaces[0]?.enabled
				&& this.canReceive(peerId, target.workspaces[0].workspaceIdentity);
		}).map((node) => ({
			...node,
			capabilities: [...node.capabilities.filter((value) => value !== REMOTE_POLICY_CAPABILITY).slice(0, 31), REMOTE_POLICY_CAPABILITY],
			workspaces: node.workspaces.map((workspace) => ({
				...workspace, acceptsIncoming: this.local.acceptsIncoming(workspace.workspaceIdentity),
			})),
		}));
		return nodeDirectoryResultSchema.parse({ deviceId: raw.deviceId, nodes, truncated: false, totalNodes: nodes.length });
	}

	public filterOutgoing(
		caller: NodeIdentityParams, directory: MeshRemoteDirectorySnapshot,
		lookup: (profileId: string, target: TaskTarget) => AuthenticatedRemoteTarget | undefined,
	): MeshRemoteDirectorySnapshot {
		if (!this.remoteDirectoryAvailable()) {
			return { devices: [], totalDevices: 0, truncated: false };
		}
		if (!this.strict()) {
			return directory;
		}
		this.requireEnabled();
		const devices = directory.devices.flatMap((device) => {
			if (device.peerId === undefined) {
				return [];
			}
			const profileId = device.peerId;
			const nodes = device.nodes.flatMap((node) => {
				const workspaces = node.workspaces.filter((workspace) => {
					const target = lookup(profileId, { deviceId: device.deviceId, nodeId: node.nodeId, nodeInstanceId: node.nodeInstanceId, workspaceId: workspace.workspaceId });
					return target !== undefined && this.isOutgoingAllowed(caller, target, workspace.workspaceId);
				});
				return workspaces.length === 0 ? [] : [{ ...node, workspaces }];
			});
			return nodes.length === 0 ? [] : [{ ...device, nodes, totalNodes: nodes.length, nodesTruncated: false }];
		});
		return { devices, totalDevices: devices.length, truncated: false };
	}

	public async assertOutgoing(caller: NodeIdentityParams, target: AuthenticatedRemoteTarget | undefined, workspaceId: string): Promise<void> {
		if (!this.strict()) {
			return;
		}
		this.requireEnabled();
		if (target !== undefined) {
			const profile = await this.profiles.get(target.profileId);
			if (profile?.generation !== target.profileGeneration || profile.cleanupPending) {
				throw new MeshDomainError('PEER_NOT_ALLOWED', 'The authenticated peer profile generation changed.');
			}
		}
		this.requireEnabled();
		if (target === undefined || !this.isOutgoingAllowed(caller, target, workspaceId)) {
			throw new MeshDomainError('PEER_NOT_ALLOWED', 'Every source workspace must allow this bound remote workspace.');
		}
	}

	public assertRouteAllowed(request: TaskRouteRequest, context: PeerRouteAuthorizationContext): void {
		if (request.remotePeerId === undefined) {
			if (this.strict() && request.sourceNodeId === undefined) {
				throw new MeshDomainError('AUTH_FAILED', 'A server-bound remote peer principal is required.');
			}
			this.local.assertRouteAllowed(request, context);
			return;
		}
		if (request.remotePeerId !== request.ownerId || request.sourceNodeId !== undefined) {
			throw new MeshDomainError('AUTH_FAILED', 'The remote peer principal is invalid.');
		}
		this.options.assertPeerAllowed(request.remotePeerId);
		this.assertNotDraining();
		if (!this.strict()) {
			return;
		}
		this.requireEnabled();
		const identity = context.targetWorkspaceIdentity;
		if (identity === undefined || !this.store.get(identity).incomingPeerIds.includes(request.remotePeerId)) {
			throw new MeshDomainError('PEER_NOT_ALLOWED', 'The paired device has no grant for this workspace.');
		}
		if (!this.local.acceptsIncoming(identity)) {
			throw new MeshDomainError('PEER_NOT_ACCEPTING', 'The target workspace is not accepting incoming tasks.');
		}
		if (!context.target?.online || context.target.workspaces.length !== 1
			|| context.target.workspaces[0].status !== 'claimed') {
			throw new MeshDomainError('PEER_OFFLINE', 'The exact target workspace claim is unavailable.', true);
		}
	}

	public displayLabel(node: PeerNodeSnapshot): string {
		return this.local.displayLabel(node);
	}

	private isOutgoingAllowed(caller: NodeIdentityParams, target: AuthenticatedRemoteTarget, workspaceId: string): boolean {
		const binding = this.bindings.get(target.profileId);
		const workspace = target.node.workspaces.find((value) => value.workspaceId === workspaceId);
		if (binding?.profileGeneration !== target.profileGeneration || binding.expectedWorkerDeviceId !== target.deviceId
			|| !target.node.capabilities.includes(REMOTE_POLICY_CAPABILITY)
			|| !['online', 'busy'].includes(target.node.status) || target.node.workspaces.length !== 1
			|| workspace?.claimStatus !== 'claimed' || !workspace.enabled || !workspace.acceptsIncoming) {
			return false;
		}
		const required = { profileId: target.profileId, profileGeneration: target.profileGeneration, workspaceIdentity: workspace.workspaceIdentity };
		return this.sources(caller).every((source) =>
			this.store.get(source.workspaceIdentity).allowlist.some((candidate) => sameTarget(candidate, required)));
	}

	private canReceive(peerId: string, identity: string): boolean {
		return this.local.acceptsIncoming(identity) && this.store.get(identity).incomingPeerIds.includes(peerId);
	}

	private requireOwned(caller: NodeIdentityParams, workspaceIdentity: string): void {
		this.requireEnabled();
		if (!this.sources(caller).some((workspace) => workspace.workspaceIdentity === workspaceIdentity)) {
			throw new MeshDomainError('POLICY_FORBIDDEN', 'Only the claiming window can edit this remote policy.');
		}
	}
}

function sameTarget(left: RemoteAllowedTarget, right: RemoteAllowedTarget): boolean {
	return left.profileId === right.profileId && left.profileGeneration === right.profileGeneration
		&& left.workspaceIdentity === right.workspaceIdentity;
}
