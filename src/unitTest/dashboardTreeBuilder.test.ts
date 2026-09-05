import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RemotePolicyDashboard } from '../../shared/protocol';
import type { DashboardSnapshot, DashboardTaskTarget } from '../ui/DashboardFacade';
import { DashboardTreeBuilder } from '../ui/DashboardTreeBuilder';
import { dashboardDeviceTreeSchema } from '../ui/DashboardTree';
import { uuid } from './artifactStoreTestSupport';

function fixture() {
	const current = { nodeId: uuid(2), nodeInstanceId: uuid(3) };
	const other = { nodeId: uuid(5), nodeInstanceId: uuid(6) };
	const remote = { deviceId: uuid(10), nodeId: uuid(11), nodeInstanceId: uuid(12), workspaceId: uuid(13), profileId: uuid(14) };
	const snapshot: DashboardSnapshot = {
		device: { deviceId: uuid(1), name: 'Mac A', platform: 'macOS', architecture: 'arm64', vscodeVersion: '1.136.1', extensionVersion: '0.4.0' },
		thisWindow: {
			name: 'shared-name', workspaceName: 'shared-project', claimStatus: 'claimed', previewEnabled: true,
			canRename: true, acceptsIncoming: true, canSetAcceptIncoming: true, acceptActionHandle: 'r'.repeat(32),
			agentHost: { source: 'editor', label: 'Editor', degraded: false },
		},
		broker: { state: 'running', role: 'owner', takeover: 'stable', holder: 'thisWindow' },
		listener: {
			state: 'stopped', gateway: { state: 'stopped', label: 'Stopped' }, tunnel: { state: 'stopped', label: 'Stopped' },
			agentHost: { state: 'ready', label: 'Editor' }, canStart: true, canStop: false, canCopyConnectionUrl: false,
		},
		localNodes: [current, other].map((identity, index) => ({
			...identity, label: 'shared-name', status: 'online' as const, thisWindow: index === 0,
			workspaces: [{ workspaceId: index === 0 ? uuid(4) : uuid(7), name: 'shared-project', capabilityTags: [],
				enabled: true, busy: false, claimStatus: 'claimed' as const }],
		})),
		policyCandidates: [current, other].map((identity, index) => ({
			...identity, windowLabel: 'shared-name', workspaceName: 'shared-project',
			online: true, acceptsIncoming: true, busy: false, allowlisted: index !== 0, self: index === 0,
			canToggle: index !== 0, claimState: 'claimed', gateState: 'allowed',
			...(index !== 0 ? { actionHandle: 'a'.repeat(32) } : {}),
		})),
		remoteDevices: [{
			deviceId: remote.deviceId, peerId: remote.profileId, name: 'Lab Mac', state: 'online',
			nodes: [{
				nodeId: remote.nodeId, nodeInstanceId: remote.nodeInstanceId, label: 'Backend window', status: 'online',
				thisWindow: false, workspaces: [{
					workspaceId: remote.workspaceId, name: 'orders-api', capabilityTags: [], enabled: true, busy: false, claimStatus: 'claimed',
				}],
			}],
		}],
		workspaces: [], peers: [], tasks: [], errors: [],
	};
	const policy: RemotePolicyDashboard = {
		workspaces: [{
			workspaceId: uuid(4), name: 'shared-project', acceptsIncoming: true, receiveActionHandle: uuid(20),
			incomingPeers: [{ peerId: uuid(21), label: 'Device bbbbbbbb (peer cccccccc)', autoAccept: false, actionHandle: uuid(22) }],
		}],
		remoteTargets: [{ ...remote, allowlisted: true, acceptsIncoming: true, canDelegate: true, actionHandle: uuid(23) }],
		peerStates: [{ profileId: remote.profileId, deviceId: remote.deviceId, state: 'online' }],
		truncated: false,
	};
	const delegates: DashboardTaskTarget[] = [];
	let handleIndex = 0;
	const nextHandle = () => (++handleIndex).toString().padStart(32, '0');
	const options = {
		currentPolicyWorkspaceId: uuid(4),
		delegate: (target: DashboardTaskTarget) => { delegates.push(target); return nextHandle(); },
		remoteAction: () => nextHandle(),
	};
	return { snapshot, policy, options, delegates, remote };
}

test('tree preserves Device to Window to Workspace routes, omits raw IDs and never makes the current window a target', () => {
	const f = fixture();
	const tree = new DashboardTreeBuilder().build(f.snapshot, f.policy, f.options);
	assert.equal(tree.length, 2);
	assert.equal(tree[0].nodes.length, 2);
	assert.equal(tree[0].nodes[0].workspaces[0].canDelegate, false);
	assert.equal(tree[0].nodes[0].workspaces[0].delegateActionHandle, undefined);
	assert.equal(tree[0].nodes[0].workspaces[0].incomingPeers[0].autoAccept, false);
	assert.equal(tree[0].nodes[0].workspaces[0].receiveAction, 'setRemoteReceive');
	assert.equal(tree[1].name, 'Lab Mac');
	assert.equal(tree[1].nodes[0].label, 'Backend window');
	assert.equal(tree[1].nodes[0].workspaces[0].name, 'orders-api');
	assert.equal(tree[1].nodes[0].workspaces[0].canDelegate, true);
	assert.deepEqual(f.delegates[1], {
		deviceId: f.remote.deviceId, peerId: f.remote.profileId, nodeId: f.remote.nodeId,
		nodeInstanceId: f.remote.nodeInstanceId, workspaceId: f.remote.workspaceId,
	});
	assert.doesNotMatch(JSON.stringify(tree), /00000000-0000|workspaceId|nodeId|profileId|peerId|sha256:/u);
});

test('duplicate names and reordered snapshots cannot transfer tree selection to another node instance', () => {
	const f = fixture();
	const builder = new DashboardTreeBuilder();
	const first = builder.build(f.snapshot, f.policy, f.options);
	assert.notEqual(first[0].nodes[0].key, first[0].nodes[1].key);
	const second = builder.build({ ...f.snapshot, localNodes: [...f.snapshot.localNodes!].reverse() }, f.policy, f.options);
	assert.equal(second[0].nodes[1].key, first[0].nodes[0].key);
	const changed = builder.build({
		...f.snapshot,
		localNodes: [{ ...f.snapshot.localNodes![0], nodeInstanceId: uuid(99) }, f.snapshot.localNodes![1]],
	}, f.policy, f.options);
	assert.notEqual(changed[0].nodes[0].key, first[0].nodes[0].key);
	assert.equal(changed[0].nodes[1].key, first[0].nodes[1].key);
});

test('cached unknown state is not online readiness, and disconnected devices have no executable stale children', () => {
	const f = fixture();
	const builder = new DashboardTreeBuilder();
	const unknown = builder.build(f.snapshot, { ...f.policy, peerStates: [] }, f.options);
	assert.equal(unknown[1].state, 'unknown');
	assert.equal(unknown[1].nodes[0].workspaces[0].canDelegate, false);
	const offline = builder.build(f.snapshot, {
		...f.policy, peerStates: [{ ...f.policy.peerStates[0], state: 'offline' }],
	}, f.options);
	assert.deepEqual(offline[1].nodes, []);
	assert.equal(offline[1].state, 'offline');
});

test('multi-Workspace targets remain visible but cannot be delegated to, and display paths are redacted', () => {
	const f = fixture();
	const other = f.snapshot.localNodes![1];
	const tree = new DashboardTreeBuilder().build({
		...f.snapshot,
		localNodes: [f.snapshot.localNodes![0], {
			...other, label: '/Users/private/window', workspaces: [
				other.workspaces[0], { ...other.workspaces[0], workspaceId: uuid(30), name: 'file:///private/repo' },
			],
		}],
	}, f.policy, f.options);
	assert.equal(tree[0].nodes[1].workspaces.length, 2);
	assert.equal(tree[0].nodes[1].workspaces.some((workspace) => workspace.canDelegate), false);
	assert.doesNotMatch(JSON.stringify(tree), /Users|file:|private\/repo/u);
});

test('tree schema rejects raw identities, duplicated keys, unbound actions and foreign incoming policies', () => {
	const f = fixture();
	const tree = new DashboardTreeBuilder().build(f.snapshot, f.policy, f.options);
	assert.equal(dashboardDeviceTreeSchema.safeParse([{ ...tree[0], deviceId: uuid(1) }]).success, false);
	const duplicate = structuredClone(tree);
	duplicate[1].key = duplicate[0].key;
	assert.equal(dashboardDeviceTreeSchema.safeParse(duplicate).success, false);
	const unbound = structuredClone(tree);
	unbound[1].nodes[0].workspaces[0].delegateActionHandle = undefined;
	assert.equal(dashboardDeviceTreeSchema.safeParse(unbound).success, false);
	const foreign = structuredClone(tree);
	foreign[1].nodes[0].workspaces[0].incomingPeers = tree[0].nodes[0].workspaces[0].incomingPeers;
	assert.equal(dashboardDeviceTreeSchema.safeParse(foreign).success, false);
});

test('offline windows disappear from both device trees while paired devices and saved authorizations remain', () => {
	const f = fixture();
	const builder = new DashboardTreeBuilder();
	const node = { ...f.snapshot.localNodes![1], status: 'offline' as const, workspaces: [] };
	const tree = builder.build({
		...f.snapshot, localNodes: [f.snapshot.localNodes![0], node],
		remoteDevices: f.snapshot.remoteDevices?.map((device) => ({
			...device, nodes: device.nodes.map((node) => ({ ...node, status: 'offline' })),
		})),
	}, f.policy, f.options);
	assert.equal(tree[0].nodes.length, 1);
	assert.equal(tree[0].nodes[0].thisWindow, true);
	assert.equal(tree[1].nodes.length, 0);
	assert.equal(tree[1].name, 'Lab Mac');
	assert.equal(f.snapshot.policyCandidates?.[1].allowlisted, true);
	const reopened = builder.build(f.snapshot, f.policy, f.options);
	assert.equal(reopened[0].nodes.length, 2);
	assert.equal(reopened[1].nodes.length, 1);
});
test('large directories remain bounded and explicitly report omission without hiding current-window policy', () => {
	const f = fixture();
	const other = f.snapshot.localNodes![1];
	let truncated = false;
	const tree = new DashboardTreeBuilder().build({
		...f.snapshot,
		localNodes: [
			...Array.from({ length: 100 }, (_, nodeIndex) => ({
				...other, nodeId: uuid(100 + nodeIndex), label: 'Long window name '.repeat(10),
				workspaces: Array.from({ length: 32 }, (_, index) => ({
					...other.workspaces[0], workspaceId: uuid(1_000 + nodeIndex * 32 + index), name: 'Long Workspace name '.repeat(10),
				})),
			})),
			f.snapshot.localNodes![0],
		],
	}, f.policy, { ...f.options, onTruncated: () => { truncated = true; } });
	assert.equal(truncated, true);
	assert.equal(tree[0].nodes[0].thisWindow, true);
	assert.equal(tree[0].nodes[0].workspaces[0].incomingPeers.length, 1);
	assert.ok(Buffer.byteLength(JSON.stringify(tree)) <= 512 * 1024);
	assert.equal(dashboardDeviceTreeSchema.safeParse(tree).success, true);
});
