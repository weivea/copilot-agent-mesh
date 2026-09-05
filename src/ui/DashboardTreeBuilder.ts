import { utf8ByteLength, type RemotePolicyAction, type RemotePolicyDashboard } from '../../shared/protocol';
import type { DashboardSnapshot, DashboardTaskTarget } from './DashboardFacade';
import { DASHBOARD_TREE_BYTES, dashboardDeviceTreeSchema, type DashboardDeviceTree, type DashboardTreeWorkspace } from './DashboardTree';
import { redactRemoteText } from './DashboardRedaction';

export class DashboardTreeBuilder {
	private readonly keys = new Map<string, string>();
	private nextKey = 0;

	public build(
		snapshot: DashboardSnapshot,
		policy: RemotePolicyDashboard,
		options: {
			readonly currentPolicyWorkspaceId?: string;
			readonly delegate: (target: DashboardTaskTarget) => string;
			readonly remoteAction: (action: RemotePolicyAction, handle: string) => string;
			readonly onTruncated?: () => void;
		},
	): DashboardDeviceTree {
		const retained = new Set<string>();
		const key = (identity: string): string => {
			retained.add(identity);
			let value = this.keys.get(identity);
			if (value === undefined) {
				value = `tree-${++this.nextKey}`;
				this.keys.set(identity, value);
			}
			return value;
		};
		const tree: DashboardDeviceTree = [];
		const sources = snapshot.localNodes ?? [];
		tree.push({
			key: key('local-device'),
			name: redactRemoteText(snapshot.device.name),
			locality: 'local',
			state: snapshot.broker?.state === 'running' || snapshot.broker?.state === 'contending' ? 'online' : 'offline',
			nodes: sources.map((node) => {
				const identity = `local:${node.nodeId}:${node.nodeInstanceId}`;
				const candidate = snapshot.policyCandidates?.find((item) =>
					item.nodeId === node.nodeId && item.nodeInstanceId === node.nodeInstanceId);
				return {
					key: key(identity),
					label: redactRemoteText(node.label),
					thisWindow: node.thisWindow,
					status: node.status,
					workspaces: node.workspaces.map((workspace): DashboardTreeWorkspace => {
						const receive = node.thisWindow ? policy.workspaces.find((entry) => entry.workspaceId === workspace.workspaceId) : undefined;
						const current = node.thisWindow && workspace.workspaceId === options.currentPolicyWorkspaceId;
						const gateState = node.thisWindow ? 'self' : candidate?.gateState ?? 'unavailable';
						const canDelegate = !node.thisWindow && candidate?.gateState === 'allowed'
							&& snapshot.device.deviceId !== undefined
							&& workspace.enabled && !workspace.busy && workspace.claimStatus === 'claimed'
							&& node.workspaces.length === 1 && ['online', 'busy'].includes(node.status);
						const receiveActionHandle = receive !== undefined
							? options.remoteAction('setRemoteReceive', receive.receiveActionHandle)
							: current && snapshot.thisWindow.canSetAcceptIncoming ? snapshot.thisWindow.acceptActionHandle : undefined;
						return {
							key: key(`${identity}:${workspace.workspaceId}`),
							name: redactRemoteText(workspace.name),
							claimStatus: workspace.claimStatus,
							enabled: workspace.enabled,
							busy: workspace.busy,
							acceptsIncoming: receive?.acceptsIncoming ?? (current ? snapshot.thisWindow.acceptsIncoming : candidate?.acceptsIncoming ?? false),
							allowlisted: !node.thisWindow && candidate?.allowlisted === true,
							gateState, canDelegate,
							...(canDelegate && snapshot.device.deviceId ? {
								delegateActionHandle: options.delegate({
									deviceId: snapshot.device.deviceId, nodeId: node.nodeId, nodeInstanceId: node.nodeInstanceId,
									workspaceId: workspace.workspaceId,
								}),
							} : {}),
							...(!node.thisWindow && candidate?.canToggle && candidate.actionHandle ? { allowActionHandle: candidate.actionHandle } : {}),
							...(receiveActionHandle ? {
								receiveActionHandle,
								receiveAction: receive ? 'setRemoteReceive' as const : 'setAcceptIncoming' as const,
							} : {}),
							incomingPeers: (receive?.incomingPeers ?? []).map((peer) => ({
								key: key(`${identity}:${workspace.workspaceId}:incoming:${peer.peerId}`),
								label: redactRemoteText(peer.label),
								autoAccept: peer.autoAccept,
								actionHandle: options.remoteAction('setRemoteAutoAccept', peer.actionHandle),
							})),
						};
					}),
				};
			}),
		});
		for (const device of snapshot.remoteDevices ?? []) {
			const identity = `remote:${device.peerId}:${device.deviceId}`;
			const state = policy.peerStates.find((entry) => entry.profileId === device.peerId && entry.deviceId === device.deviceId)?.state ?? 'unknown';
			tree.push({
				key: key(identity),
				name: redactRemoteText(device.name),
				locality: 'remote', state,
				nodes: (state === 'online' || state === 'unknown' ? device.nodes : []).map((node) => ({
					key: key(`${identity}:${node.nodeId}:${node.nodeInstanceId}`),
					label: redactRemoteText(node.label),
					thisWindow: false, status: node.status,
					workspaces: node.workspaces.map((workspace): DashboardTreeWorkspace => {
						const target = policy.remoteTargets.find((entry) =>
							entry.profileId === device.peerId && entry.deviceId === device.deviceId
							&& entry.nodeId === node.nodeId && entry.nodeInstanceId === node.nodeInstanceId
							&& entry.workspaceId === workspace.workspaceId);
						const canDelegate = target?.canDelegate === true && workspace.enabled && !workspace.busy
							&& workspace.claimStatus === 'claimed' && state === 'online'
							&& ['online', 'busy'].includes(node.status) && node.workspaces.length === 1;
						const gateState = state === 'unknown' ? 'unavailable' : state !== 'online' || node.status === 'offline' ? 'offline'
							: node.workspaces.length !== 1 ? 'multiWorkspace'
								: workspace.claimStatus !== 'claimed' || !workspace.enabled ? 'notClaimed'
									: target === undefined ? 'unavailable' : !target.allowlisted ? 'notAllowed'
										: !target.acceptsIncoming ? 'notAccepting' : 'allowed';
						return {
							key: key(`${identity}:${node.nodeId}:${node.nodeInstanceId}:${workspace.workspaceId}`),
							name: redactRemoteText(workspace.name), claimStatus: workspace.claimStatus,
							enabled: workspace.enabled, busy: workspace.busy, acceptsIncoming: target?.acceptsIncoming ?? false,
							allowlisted: target?.allowlisted ?? false, gateState, canDelegate, incomingPeers: [],
							...(canDelegate ? {
								delegateActionHandle: options.delegate({ deviceId: device.deviceId, peerId: device.peerId,
									nodeId: node.nodeId, nodeInstanceId: node.nodeInstanceId, workspaceId: workspace.workspaceId }),
							} : {}),
							...(target?.actionHandle ? { allowActionHandle: options.remoteAction('setRemoteAllowed', target.actionHandle) } : {}),
						};
					}),
				})),
			});
		}
		for (const identity of this.keys.keys()) {
			if (!retained.has(identity)) { this.keys.delete(identity); }
		}
		if (utf8ByteLength(JSON.stringify(tree)) <= DASHBOARD_TREE_BYTES) {
			return dashboardDeviceTreeSchema.parse(tree);
		}
		options.onTruncated?.();
		return dashboardDeviceTreeSchema.parse(boundTree(tree));
	}

	public dispose(): void { this.keys.clear(); }
}

function boundTree(tree: DashboardDeviceTree): DashboardDeviceTree {
	const bounded: DashboardDeviceTree = [];
	let bytes = 2;
	for (const device of tree) {
		const projectedDevice = { ...device, nodes: [] as typeof device.nodes };
		const deviceBytes = utf8ByteLength(JSON.stringify(projectedDevice)) + (bounded.length > 0 ? 1 : 0);
		if (bytes + deviceBytes > DASHBOARD_TREE_BYTES) { break; }
		bytes += deviceBytes;
		bounded.push(projectedDevice);
		const nodes = device.locality === 'local'
			? [...device.nodes].sort((left, right) => Number(right.thisWindow) - Number(left.thisWindow))
			: device.nodes;
		for (const node of nodes) {
			const projectedNode = { ...node, workspaces: [] as typeof node.workspaces };
			const nodeBytes = utf8ByteLength(JSON.stringify(projectedNode)) + (projectedDevice.nodes.length > 0 ? 1 : 0);
			if (bytes + nodeBytes > DASHBOARD_TREE_BYTES) { break; }
			bytes += nodeBytes;
			projectedDevice.nodes.push(projectedNode);
			for (const workspace of node.workspaces) {
				const workspaceBytes = utf8ByteLength(JSON.stringify(workspace)) + (projectedNode.workspaces.length > 0 ? 1 : 0);
				if (bytes + workspaceBytes > DASHBOARD_TREE_BYTES) { break; }
				bytes += workspaceBytes;
				projectedNode.workspaces.push(workspace);
			}
		}
	}
	return bounded;
}
