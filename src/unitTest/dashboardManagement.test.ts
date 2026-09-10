import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

import {
	createDashboardManagementSchema, dashboardManagementSnapshotSchema, dashboardManagementActionParamsSchema,
	type DashboardManagementAction,
} from '../../shared/protocol';
import { managementKey } from '../broker/DashboardManagementKey';
import { RemotePeerPolicyService } from '../broker/RemotePeerPolicyService';
import { RemotePeerPolicyStore } from '../broker/RemotePeerPolicyStore';
import { ProductionDashboardManagement } from '../composition/ProductionDashboardManagement';
import { ProductionRemoteTaskAdapter } from '../composition/ProductionRemoteTaskAdapter';
import { InMemorySecretStore } from '../gateway/SecretStore';
import { PeerConnection } from '../peer/PeerConnection';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import { AtomicFileStore } from '../storage/AtomicFileStore';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';
import { MemoryAtomicFileSystem, TestOwnership, uuid } from './artifactStoreTestSupport';
import { formatMessage, localize, type MessageTranslator } from '../composition/ProductionLocalization';

const caller = { nodeId: uuid(1), nodeInstanceId: uuid(2) };
const deviceId = uuid(3);
const profileId = uuid(4);
const peerId = uuid(5);
const remoteRoot = createOpaqueWorkspaceIdentity('management-target-private-path');
const route = { deviceId, nodeId: uuid(6), nodeInstanceId: uuid(7), workspaceId: uuid(8) };
const allowedTarget = { profileId, profileGeneration: uuid(9), workspaceIdentity: remoteRoot };
type Options = ConstructorParameters<typeof ProductionDashboardManagement>[0];

async function fixture(translate?: MessageTranslator) {
	const fs = new MemoryAtomicFileSystem();
	const files = new AtomicFileStore(join(process.cwd(), '.management-test-memory'), fs, { next: randomUUID });
	const ownership = new TestOwnership('management-generation');
	const fence = { ownership, generation: ownership.generation };
	const session = { closed: false } as Options['assertCaller'] extends (caller: infer _C, session: infer S) => void ? S : never;
	const sources = [1, 2].map((value) => ({
		workspaceId: uuid(20 + value), workspaceIdentity: createOpaqueWorkspaceIdentity(`management-source-${value}`),
		name: `Source ${value}`, status: 'claimed' as 'claimed' | 'readOnly', busy: false,
	}));
	const profiles = new InMemoryPeerProfileStore();
	await profiles.store({
		id: profileId, generation: allowedTarget.profileGeneration, workerDeviceId: deviceId,
		peerId: uuid(12), credentialKeyRef: 'mesh.remotePeer.test', rpcEndpoint: 'wss://example.invalid/mesh',
	});
	const remotePolicyStore = new RemotePeerPolicyStore(files, fence);
	await remotePolicyStore.initialize();
	const receiving = new Set<string>();
	let online = true;
	let targetPresent = true;
	let authenticationGeneration = 'test-connection-generation';
	let confirmResult = true;
	let onConfirm: (() => void | Promise<void>) | undefined;
	let onDirectoryRead: (() => void | Promise<void>) | undefined;
	let onBarrier: (() => void) | undefined;
	let failCleanup = false;
	let callerOnline = true;
	const incoming: { taskId: string; peerId: string; state: string }[] = [];
	const outgoing: { taskId: string; state: string }[] = [];
	const legacy: { taskId: string; profileId: string; state: string }[] = [];
	const confirmations: string[] = [];
	const cancellations: string[] = [];
	const revocations: string[] = [];
	const localMutations: { source: string; allowed: boolean }[] = [];
	let discoveryCalls = 0;
	let barrierCalls = 0;
	let forgotten = false;
	let deletedProfile = false;
	let offlineLocal = false;
	const registry = {
		peerNode: (identity: typeof caller) => identity.nodeId === caller.nodeId && identity.nodeInstanceId === caller.nodeInstanceId
			? { ...caller, online: callerOnline, workspaces: sources } : undefined,
		peerNodes: () => [{ ...caller, online: true, workspaces: sources }],
		list: () => ({ deviceId: uuid(99), nodes: [], totalNodes: 0, truncated: false }),
		catalogSnapshot: () => ({ workspaces: sources.map((source) => ({ ...source, enabled: source.status === 'claimed' })) }),
		setWorkspaceEnabled: async (workspaceId: string, enabled: boolean) => {
			sources.find((source) => source.workspaceId === workspaceId)!.status = enabled ? 'claimed' : 'readOnly';
		},
	} as unknown as Options['registry'];
	const localPolicies = {
		acceptsIncoming: (identity: string) => receiving.has(identity),
		setRemoteReceive: async (_caller: typeof caller, identity: string, enabled: boolean) => {
			if (enabled) { receiving.add(identity); } else { receiving.delete(identity); }
		},
		listCandidates: (input: { workspaceIdentity: string }) => offlineLocal ? [{
			candidate: { self: false, online: false, allowlisted: true, canToggle: true, windowLabel: 'Saved local window', workspaceName: 'Saved Workspace' },
			sourceWorkspaceIdentity: input.workspaceIdentity, targetWorkspaceIdentity: createOpaqueWorkspaceIdentity('saved-local-target'),
		}] : [],
		setCandidateAllowed: async (_caller: typeof caller, binding: { sourceWorkspaceIdentity: string }, allowed: boolean) => {
			localMutations.push({ source: binding.sourceWorkspaceIdentity, allowed });
		},
	} as unknown as Options['localPolicies'];
	const endpoints = {
		get: () => ({ profileGeneration: allowedTarget.profileGeneration }),
		references: () => [],
	} as unknown as Options['endpoints'];
	const remotePolicies = new RemotePeerPolicyService(remotePolicyStore, registry, localPolicies, endpoints, profiles, {
		strict: () => true, enabled: () => true, ready: () => true,
		assertPeerAllowed: (id) => assert.ok(!revocations.includes(id)),
		assertPeerActive: async (id) => assert.ok(id === peerId && !revocations.includes(id)),
	});
	let remoteTasks = {
		cachedDevices: () => ({
			devices: [{
				deviceId, peerId: profileId, deviceName: 'Remote laptop',
				nodes: targetPresent ? [{ ...route, label: 'Remote window', status: 'online',
					workspaces: [{ workspaceId: route.workspaceId, name: 'Remote Workspace' }] }] : [],
			}], totalDevices: 1, truncated: false,
		}),
		listDevices: async () => { discoveryCalls += 1; await onDirectoryRead?.(); return remoteTasks.cachedDevices(); },
		lookupTarget: () => online && targetPresent ? {
			profileId, profileGeneration: allowedTarget.profileGeneration, deviceId,
			node: { ...route, workspaces: [{ workspaceId: route.workspaceId, workspaceIdentity: remoteRoot }] },
		} : undefined,
		associatedTasks: () => outgoing,
		cancelTask: async (taskId: string) => { cancellations.push(taskId); return { taskId, state: 'cancelling' }; },
		withAdmissionBarrier: async <T>(action: () => Promise<T>) => { barrierCalls += 1; onBarrier?.(); return action(); },
		forgetDevice: () => { forgotten = true; },
	} as unknown as ReturnType<Options['remoteTasks']>;
	const options: Options = {
		translate,
		files, fence, deviceId: uuid(99), registry, localPolicies, remotePolicies, remotePolicyStore,
		profiles, endpoints, remoteTasks: () => remoteTasks,
		legacyTasks: () => legacy,
		cancelLegacyTask: async (taskId) => { cancellations.push(taskId); },
		records: {
			listPeers: async () => [{ peerId, coordinatorDeviceId: deviceId }],
			listPending: async () => [],
		} as unknown as Options['records'],
		tasks: { list: async () => incoming } as unknown as Options['tasks'],
		cancelTask: async (_peerId, taskId) => { cancellations.push(taskId); },
		enrollment: { entries: () => [], blockDevice: async () => undefined } as unknown as Options['enrollment'],
		revocations: { snapshot: () => revocations.map((id) => ({ peerId: id, cleanupPending: false, taskCancellationPending: false })) } as unknown as Options['revocations'],
		peers: {
			get: () => deletedProfile ? undefined : {
				snapshot: () => ({ state: online ? 'online' : 'offline' }),
				authenticatedBinding: () => online ? { connectionGeneration: authenticationGeneration,
					profileGeneration: allowedTarget.profileGeneration, deviceId } : undefined,
			},
			disconnect: async () => { online = false; },
			remove: async () => {
				if (failCleanup) { throw new Error('credential cleanup failed'); }
				await profiles.delete(profileId);
				deletedProfile = true;
			},
		} as unknown as Options['peers'],
		ready: () => true,
		assertCaller: (identity, currentSession) => {
			assert.equal(currentSession.closed, false);
			assert.equal(identity.nodeId, caller.nodeId);
			assert.ok(callerOnline);
		},
		confirm: async (message) => { confirmations.push(message); await onConfirm?.(); return confirmResult; },
		switchAccount: async (validate) => { await validate(); },
		probe: async (_profileId, validate) => { await validate(); },
		revokePeer: async (id) => { revocations.push(id); },
		incomingAdmissionBarrier: async (action) => { barrierCalls += 1; return action(); },
		changed: () => undefined,
	};
	let management = new ProductionDashboardManagement(options);
	await management.initialize();
	return {
		management, options, profiles, incoming, outgoing, legacy, sources, receiving, confirmations,
		cancellations, revocations, localMutations, ownership, session,
		snapshot: () => management.snapshot(caller, session),
		act: (action: DashboardManagementAction, actionHandle: string, enabled?: boolean) =>
			management.act(caller, { ...caller, action, actionHandle, ...(enabled === undefined ? {} : { enabled }) }, session),
		restart: async () => { management = new ProductionDashboardManagement(options); await management.initialize(); return management; },
		set online(value: boolean) { online = value; },
		set targetPresent(value: boolean) { targetPresent = value; },
		set authenticationGeneration(value: string) { authenticationGeneration = value; },
		set remoteAdapter(value: ReturnType<Options['remoteTasks']>) { remoteTasks = value; },
		set confirmResult(value: boolean) { confirmResult = value; },
		set onConfirm(value: (() => void | Promise<void>) | undefined) { onConfirm = value; },
		set onDirectoryRead(value: (() => void | Promise<void>) | undefined) { onDirectoryRead = value; },
		set onBarrier(value: (() => void) | undefined) { onBarrier = value; },
		set failCleanup(value: boolean) { failCleanup = value; },
		set callerOnline(value: boolean) { callerOnline = value; },
		set offlineLocal(value: boolean) { offlineLocal = value; },
		get discoveryCalls() { return discoveryCalls; },
		get barrierCalls() { return barrierCalls; },
		get forgotten() { return forgotten; },
	};
}

test('management schemas strictly separate UUID backend handles from UI aliases and enforce boolean actions', async () => {
	const f = await fixture();
	const snapshot = await f.snapshot();
	assert.ok(dashboardManagementSnapshotSchema.safeParse(snapshot).success);
	const alias = createDashboardManagementSchema(z.string().regex(/^[A-Za-z0-9_-]{32}$/u));
	assert.equal(alias.safeParse(snapshot).success, false);
	assert.ok(alias.safeParse({ available: true, truncated: false, devices: [], targets: [], workspaces: [], accountActionHandle: 'a'.repeat(32) }).success);
	assert.equal(dashboardManagementActionParamsSchema.safeParse({ ...caller, action: 'setWorkspaceReceiving', actionHandle: uuid(50) }).success, false);
	assert.equal(dashboardManagementActionParamsSchema.safeParse({ ...caller, action: 'deleteSavedDevice', actionHandle: uuid(50), enabled: false }).success, false);
	assert.doesNotMatch(JSON.stringify(snapshot), /workspaceIdentity|profileId|deviceId|nodeId|sha256:|private-path/u);
	assert.doesNotMatch(JSON.stringify(snapshot), /"[^"]*grant[^"]*"\s*:/iu);
	assert.equal(dashboardManagementSnapshotSchema.safeParse({
		...snapshot, targets: snapshot.targets.map((target) => ({ ...target, grants: target.sources })),
	}).success, false, 'The old outbound-sensitive target field must not be accepted.');
	assert.equal(dashboardManagementSnapshotSchema.safeParse({
		...snapshot, workspaces: snapshot.workspaces.map((workspace) => ({
			...workspace, incomingPeers: workspace.incomingPeers.map((peer) => ({ ...peer, grantActionHandle: uuid(51) })),
		})),
	}).success, false, 'The old incoming action-handle field must not be accepted.');
});

test('management localization preserves English mocks and translates template keys with display-only arguments', async () => {
	assert.equal(localize({}, 'Device "{0}" has {1} tasks.', 'Laptop', 2), 'Device "Laptop" has 2 tasks.');
	assert.equal(formatMessage('{0}: {1}', '$& {2}', false), '$& {2}: false');
	const translations: { message: string; args: (string | number | boolean)[] }[] = [];
	const f = await fixture((message, ...args) => {
		translations.push({ message, args });
		return `Localized: ${formatMessage(message, ...args)}`;
	});

	let snapshot = await f.snapshot();
	await f.act('setWindowTargetAllowed', snapshot.targets[0].allSourcesActionHandle!, true);
	assert.match(f.confirmations[0], /^Localized: Apply/u);
	assert.deepEqual(translations.find((entry) => entry.message === 'Apply this target permission to ALL these source Workspaces: {0}?')?.args,
		['"Source 1", "Source 2"']);
	snapshot = await f.snapshot();
	await f.act('setIncomingDeviceGrant', snapshot.workspaces[0].incomingPeers[0].allowActionHandle!, true);
	snapshot = await f.snapshot();
	await f.act('setDeviceAutoAccept', snapshot.workspaces[0].incomingPeers[0].autoAcceptActionHandle!, true);
	assert.ok(translations.some((entry) => entry.message.startsWith('Automatically accept future tasks from "{0}"')
		&& entry.args[0] === 'Remote laptop' && entry.args[1] === 'Source 1'));
	f.confirmResult = false;
	snapshot = await f.snapshot();
	await f.act('deleteSavedDevice', snapshot.devices[0].deleteActionHandle!);
	assert.ok(translations.some((entry) => entry.message.startsWith('Delete saved device "{0}" ({1})?')
		&& entry.args[0] === 'Remote laptop' && entry.args[1] === 'Localized: Online'));
	assert.equal(f.management.deviceDenied(deviceId), false);
});

test('shared management schema rejects deletion handles unless zero unfinished tasks are proven and no blocker exists', async () => {
	const f = await fixture();
	const snapshot = await f.snapshot();
	const device = snapshot.devices[0];
	assert.ok(device.deleteActionHandle);
	for (const activeTaskCount of [undefined, 1, 3]) {
		assert.equal(dashboardManagementSnapshotSchema.safeParse({
			...snapshot, devices: [{ ...device, activeTaskCount }],
		}).success, false);
	}
	assert.equal(dashboardManagementSnapshotSchema.safeParse({
		...snapshot, devices: [{ ...device, activeTaskCount: 0, deleteBlockedReason: 'Task status is not authoritative.' }],
	}).success, false);
	assert.equal(dashboardManagementSnapshotSchema.safeParse({
		...snapshot, devices: [{ ...device, activeTaskCount: 0 }],
	}).success, true);
});

test('exact source grants do not authorize other roots; explicit bulk confirms every affected source', async () => {
	const f = await fixture();
	let snapshot = await f.snapshot();
	const target = snapshot.targets[0];
	assert.equal(target.sources.length, 2);
	assert.equal(f.discoveryCalls, 0, 'Reading settings must not query remote directories.');
	await f.act('setTargetAllowed', target.sources[0].actionHandle!, true);
	assert.equal(f.options.remotePolicies.policy(f.sources[0].workspaceIdentity).allowlist.length, 1);
	assert.equal(f.options.remotePolicies.policy(f.sources[1].workspaceIdentity).allowlist.length, 0);
	assert.equal(f.options.remotePolicies.sourceAllows(caller, allowedTarget), false,
		'Editing one root must not weaken the all-source dispatch gate.');
	assert.equal(f.confirmations.length, 0);
	snapshot = await f.snapshot();
	assert.equal(snapshot.targets[0].allSourcesAllowed, 'some');
	await f.act('setWindowTargetAllowed', snapshot.targets[0].allSourcesActionHandle!, true);
	assert.equal(f.options.remotePolicies.policy(f.sources[1].workspaceIdentity).allowlist.length, 1);
	assert.equal(f.options.remotePolicies.sourceAllows(caller, allowedTarget), true);
	assert.match(f.confirmations[0], /Source 1.*Source 2/u);
	assert.equal(f.discoveryCalls, 2, 'Each explicit enable revalidates the remote directory.');
});

test('enabling target access refreshes directory evidence and rejects disappeared windows', async () => {
	for (const action of ['setTargetAllowed', 'setWindowTargetAllowed'] as const) {
		const f = await fixture();
		const target = (await f.snapshot()).targets[0];
		const handle = action === 'setTargetAllowed' ? target.sources[0].actionHandle! : target.allSourcesActionHandle!;
		f.onDirectoryRead = () => { f.targetPresent = false; };
		await assert.rejects(f.act(action, handle, true), /exact currently authenticated target/u);
		assert.equal(f.discoveryCalls, 1);
		assert.equal(f.options.remotePolicies.policy(f.sources[0].workspaceIdentity).allowlist.length, 0);
	}
});

test('reconnecting to an empty remote directory cannot grant a stale cached root through either management enable action', async (t) => {
	for (const action of ['setTargetAllowed', 'setWindowTargetAllowed'] as const) {
		const f = await fixture();
		let hasWindow = true;
		let nodeReads = 0;
		const connection = new PeerConnection(profileId, uuid(99), f.profiles, new InMemorySecretStore(), {
			connect: async (profile) => ({
				profile,
				onClose: () => () => undefined,
				close: async () => undefined,
				request: async (method) => {
					if (method === 'device.getInfo') {
						return { deviceId, name: 'Remote laptop', platform: 'darwin', architecture: 'arm64',
							vscodeVersion: '1.136.1', extensionVersion: '0.5.0', protocolVersion: 2 };
					}
					assert.equal(method, 'node.list', 'This regression must not dispatch an Agent task.');
					nodeReads += 1;
					return {
						deviceId, truncated: false, totalNodes: hasWindow ? 1 : 0,
						nodes: hasWindow ? [{
							nodeId: route.nodeId, nodeInstanceId: route.nodeInstanceId, label: 'Remote window',
							status: 'online', capabilities: ['tasks'], startedAt: '2026-09-01T00:00:00.000Z',
							lastHeartbeatAt: '2026-09-01T00:00:00.000Z',
							workspaces: [{
								workspaceId: route.workspaceId, workspaceIdentity: remoteRoot, name: 'Remote Workspace',
								capabilityTags: [], enabled: true, busy: false, claimStatus: 'claimed', acceptsIncoming: true,
							}],
						}] : [],
					};
				},
			}),
		}, () => undefined);
		t.after(() => connection.disconnect());
		f.options.peers.get = (id) => id === profileId ? connection : undefined;
		f.options.peers.listConnections = () => [connection];
		f.options.peers.isEnabled = (id) => id === profileId;
		const adapter = new ProductionRemoteTaskAdapter(f.options.peers, f.profiles);
		f.remoteAdapter = adapter;
		await connection.connect();
		await adapter.listDevices(new AbortController().signal);
		const target = (await f.snapshot()).targets[0];
		const handle = action === 'setTargetAllowed' ? target.sources[0].actionHandle : target.allSourcesActionHandle;
		assert.ok(handle);
		assert.equal(nodeReads, 1, 'Rendering settings must only consume the authenticated local cache.');
		await connection.disconnect();
		hasWindow = false;
		await connection.connect();
		assert.deepEqual(adapter.cachedDevices().devices[0].nodes, []);
		assert.equal(adapter.lookupTarget(profileId, route), undefined);
		assert.equal(nodeReads, 1, 'Transport reconnection and cached reads must not implicitly query node.list.');
		await assert.rejects(f.act(action, handle, true), /exact currently authenticated target/u);
		assert.equal(nodeReads, 2, 'An explicit enable must fetch current node.list before editing policy.');
		assert.ok(f.sources.every((source) => f.options.remotePolicies.policy(source.workspaceIdentity).allowlist.length === 0));
		assert.equal(f.options.remotePolicies.sourceAllows(caller, allowedTarget), false);
		assert.deepEqual((await f.snapshot()).targets, []);
		assert.equal(nodeReads, 2, 'Rendering after rejection must not perform another remote query.');
	}
});

test('authorization scope is rechecked after the remote directory refresh', async () => {
	const f = await fixture();
	const target = (await f.snapshot()).targets[0];
	f.onDirectoryRead = () => { f.sources.pop(); };
	await assert.rejects(f.act('setTargetAllowed', target.sources[0].actionHandle!, true), /claims or permissions changed/u);
	assert.equal(f.options.remotePolicies.policy(f.sources[0].workspaceIdentity).allowlist.length, 0);
});

test('removing saved offline authorization does not need a remote directory query', async () => {
	const f = await fixture();
	let target = (await f.snapshot()).targets[0];
	await f.act('setTargetAllowed', target.sources[0].actionHandle!, true);
	assert.equal(f.discoveryCalls, 1);
	f.online = false;
	f.targetPresent = false;
	target = (await f.snapshot()).targets.find((entry) => entry.locality === 'remote')!;
	assert.equal(target.online, false);
	await f.act('setTargetAllowed', target.sources[0].actionHandle!, false);
	assert.equal(f.discoveryCalls, 1);
	assert.deepEqual(f.options.remotePolicies.policy(f.sources[0].workspaceIdentity).allowlist, []);
});

test('management consumes handles and fences wrong actions, sessions, caller instances and broker generations', async () => {
	const f = await fixture();
	const handle = (await f.snapshot()).workspaces[0].receiveActionHandle!;
	assert.throws(() => f.act('setWorkspaceEnabled', handle, true), /stale/u);
	assert.throws(() => f.act('setWorkspaceReceiving', handle, true), /stale/u);
	const fresh = (await f.snapshot()).workspaces[0].receiveActionHandle!;
	assert.throws(() => f.management.act(caller, { ...caller, action: 'setWorkspaceReceiving', actionHandle: fresh, enabled: true },
		{ closed: false } as typeof f.session), /stale/u);
	await assert.rejects(f.management.act({ ...caller, nodeInstanceId: uuid(55) }, {
		...caller, action: 'setWorkspaceReceiving', actionHandle: fresh, enabled: true,
	}, f.session), /caller changed/u);
	const stale = (await f.snapshot()).workspaces[0].receiveActionHandle!;
	f.ownership.generation = 'replaced-generation';
	await assert.rejects(f.act('setWorkspaceReceiving', stale, true), /generation changed/u);
});

test('incoming grants include ungranted paired devices, and auto-accept true always requires native confirmation', async () => {
	const f = await fixture();
	let snapshot = await f.snapshot();
	assert.equal(snapshot.workspaces[0].incomingPeers[0].allowed, false);
	assert.equal(snapshot.workspaces[0].incomingPeers[0].autoAcceptActionHandle, undefined);
	await f.act('setIncomingDeviceGrant', snapshot.workspaces[0].incomingPeers[0].allowActionHandle!, true);
	snapshot = await f.snapshot();
	assert.equal(snapshot.workspaces[0].incomingPeers[0].autoAccept, false);
	f.confirmResult = false;
	await f.act('setDeviceAutoAccept', snapshot.workspaces[0].incomingPeers[0].autoAcceptActionHandle!, true);
	assert.deepEqual(f.options.remotePolicies.policy(f.sources[0].workspaceIdentity).autoAcceptPeerIds, []);
	f.confirmResult = true;
	snapshot = await f.snapshot();
	await f.act('setDeviceAutoAccept', snapshot.workspaces[0].incomingPeers[0].autoAcceptActionHandle!, true);
	assert.deepEqual(f.options.remotePolicies.policy(f.sources[0].workspaceIdentity).autoAcceptPeerIds, [peerId]);
	assert.deepEqual(f.options.remotePolicies.policy(f.sources[1].workspaceIdentity).autoAcceptPeerIds, []);
	assert.match(f.confirmations[1], /Source 1.*task-start/u);
	snapshot = await f.snapshot();
	await f.act('setIncomingDeviceGrant', snapshot.workspaces[0].incomingPeers[0].allowActionHandle!, false);
	assert.deepEqual(f.options.remotePolicies.policy(f.sources[0].workspaceIdentity).autoAcceptPeerIds, []);
});

test('confirmation-time Workspace changes reject bulk and auto-accept before a policy write', async () => {
	const f = await fixture();
	const snapshot = await f.snapshot();
	f.onConfirm = () => { f.sources.pop(); };
	await assert.rejects(f.act('setWindowTargetAllowed', snapshot.targets[0].allSourcesActionHandle!, true), /claims or permissions changed/u);
	assert.equal(f.options.remotePolicies.policy(f.sources[0].workspaceIdentity).allowlist.length, 0);
});

test('saved deletion is blocked by every incoming/outgoing nonterminal status, including unknown and ambiguous', async () => {
	for (const direction of ['incoming', 'outgoing']) {
		for (const state of ['accepted', 'startingAgent', 'running', 'needsInput', 'recovering', 'cancelling', 'unknown', 'ambiguous']) {
			const f = await fixture();
			if (direction === 'incoming') { f.incoming.push({ taskId: uuid(60), peerId, state }); }
			else { f.outgoing.push({ taskId: uuid(60), state }); }
			const device = (await f.snapshot()).devices[0];
			assert.equal(device.activeTaskCount, 1, `${direction}/${state}`);
			assert.equal(device.deleteActionHandle, undefined);
			assert.ok(device.deleteBlockedReason);
			assert.ok(device.revokeActionHandle, 'Revoke must remain independent of deletion.');
			assert.equal(f.confirmations.length, 0);
		}
	}
});

test('deletion rechecks task admissions after native confirmation and inside both admission barriers', async () => {
	for (const timing of ['confirmation', 'barrier']) {
		const f = await fixture();
		const device = (await f.snapshot()).devices[0];
		const insert = () => { f.incoming.push({ taskId: uuid(61), peerId, state: 'needsInput' }); };
		if (timing === 'confirmation') { f.onConfirm = insert; } else { f.onBarrier = insert; }
		await assert.rejects(f.act('deleteSavedDevice', device.deleteActionHandle!), /task|Deletion/u);
		assert.equal(f.management.deviceDenied(deviceId), false);
		assert.equal(f.forgotten, false);
		assert.equal(f.incoming.length, 1);
		assert.equal(f.barrierCalls, 2);
	}
});

test('device state changes during native confirmation reject deletion instead of acting on stale online status', async () => {
	const f = await fixture();
	const handle = (await f.snapshot()).devices[0].deleteActionHandle!;
	f.onConfirm = () => { f.online = false; };
	await assert.rejects(f.act('deleteSavedDevice', handle), /connection state changed/u);
	assert.equal(f.management.deviceDenied(deviceId), false);
	assert.ok(await f.profiles.get(profileId));
});

test('re-authentication invalidates device actions even when the transport returns to the same online state', async () => {
	const f = await fixture();
	const handle = (await f.snapshot()).devices[0].deleteActionHandle!;
	f.onConfirm = () => { f.authenticationGeneration = 'replacement-authenticated-session'; };
	await assert.rejects(f.act('deleteSavedDevice', handle), /connection state changed/u);
	assert.equal(f.management.deviceDenied(deviceId), false);
	assert.equal((await f.snapshot()).devices[0].state, 'online');
});

test('an online transport with an obsolete authenticated profile cannot advertise live targets or a probe', async () => {
	const f = await fixture();
	await f.profiles.store({ ...(await f.profiles.get(profileId))!, generation: uuid(90) });
	const snapshot = await f.snapshot();
	assert.equal(snapshot.devices[0].state, 'unknown');
	assert.equal(snapshot.devices[0].probeActionHandle, undefined);
	assert.deepEqual(snapshot.targets, []);
});

test('independent online revoke requests outgoing cancellation, removes grants and credentials, and keeps active history', async () => {
	const f = await fixture();
	f.outgoing.push({ taskId: uuid(62), state: 'needsInput' });
	f.incoming.push({ taskId: uuid(63), peerId, state: 'recovering' });
	await f.options.remotePolicies.setAllowed(caller, f.sources[0].workspaceIdentity, allowedTarget, true);
	await f.options.remotePolicies.setIncomingGrant(caller, f.sources[0].workspaceIdentity, peerId, true);
	const device = (await f.snapshot()).devices[0];
	await f.act('revokeDevice', device.revokeActionHandle!);
	assert.deepEqual(f.cancellations, [uuid(62), uuid(63)]);
	assert.deepEqual(f.revocations, [peerId]);
	assert.equal(f.management.deviceDenied(deviceId), true);
	assert.throws(() => f.management.assertPeerAllowed(peerId));
	assert.equal(await f.profiles.get(profileId), undefined);
	assert.deepEqual(f.options.remotePolicies.policy(f.sources[0].workspaceIdentity).allowlist, []);
	assert.deepEqual(f.options.remotePolicies.policy(f.sources[0].workspaceIdentity).incomingPeerIds, []);
	assert.equal(f.outgoing.length, 1);
	assert.equal(f.incoming.length, 1);
	assert.equal((await f.snapshot()).devices[0].state, 'revoked');
	assert.equal((await f.snapshot()).devices[0].deleteActionHandle, undefined);
});

test('unknown native legacy tasks also block deletion and receive cancellation during independent revoke', async () => {
	const f = await fixture();
	f.legacy.push({ taskId: uuid(71), profileId, state: 'unknown' });
	const device = (await f.snapshot()).devices[0];
	assert.equal(device.activeTaskCount, 1);
	assert.equal(device.deleteActionHandle, undefined);
	await f.act('revokeDevice', device.revokeActionHandle!);
	assert.deepEqual(f.cancellations, [uuid(71)]);
	assert.equal(f.legacy.length, 1);
});

test('failed cleanup is visible and retryable; completed saved deletion persists across restart and stale cache', async () => {
	const f = await fixture();
	f.outgoing.push({ taskId: uuid(64), state: 'completed' });
	f.incoming.push({ taskId: uuid(65), peerId, state: 'cancelled' });
	const device = (await f.snapshot()).devices[0];
	f.failCleanup = true;
	await assert.rejects(f.act('deleteSavedDevice', device.deleteActionHandle!), /cleanup needs retry/u);
	let snapshot = await f.snapshot();
	assert.equal(snapshot.devices[0].cleanupPending, true);
	assert.equal(snapshot.devices[0].state, 'revoked');
	assert.equal(f.forgotten, false);
	assert.equal(f.management.deviceDenied(deviceId), true);
	f.failCleanup = false;
	await f.act('deleteSavedDevice', snapshot.devices[0].deleteActionHandle!);
	snapshot = await f.snapshot();
	assert.deepEqual(snapshot.devices, []);
	assert.equal(f.forgotten, true);
	const restarted = await f.restart();
	assert.equal(restarted.deviceDenied(deviceId), true);
	assert.deepEqual((await f.snapshot()).devices, []);
	const saved = await f.options.files.readJson('peers/saved-devices.json') as { entries: { name?: string }[] };
	assert.equal(saved.entries[0].name, undefined, 'Only the denial tombstone remains, not a saved display label.');
	assert.equal(f.outgoing.length, 1);
	assert.equal(f.incoming.length, 1);
});

test('failed authoritative cancellation leaves explicit cleanup-pending denial and never clears unfinished tasks', async () => {
	const f = await fixture();
	f.outgoing.push({ taskId: uuid(72), state: 'recovering' });
	f.options.remoteTasks().cancelTask = async () => { throw new Error('Cancellation unavailable'); };
	const handle = (await f.snapshot()).devices[0].revokeActionHandle!;
	await assert.rejects(f.act('revokeDevice', handle), /cleanup needs retry/u);
	const device = (await f.snapshot()).devices[0];
	assert.equal(device.state, 'revoked');
	assert.equal(device.cleanupPending, true);
	assert.equal(device.activeTaskCount, 1);
	assert.equal(device.deleteActionHandle, undefined);
	assert.ok(device.revokeActionHandle);
	assert.equal(f.outgoing.length, 1);
});

test('cached directory-only devices remain unknown, never live targets, while authenticated profiles without targets are manageable', async () => {
	const f = await fixture();
	await f.profiles.delete(profileId);
	f.options.records.listPeers = async () => [];
	let snapshot = await f.snapshot();
	assert.equal(snapshot.devices[0].state, 'unknown');
	assert.equal(snapshot.devices[0].probeActionHandle, undefined);
	assert.deepEqual(snapshot.targets, []);
	const other = await fixture();
	other.options.remoteTasks().cachedDevices = () => ({ devices: [], totalDevices: 0, truncated: false });
	snapshot = await other.snapshot();
	assert.equal(snapshot.devices[0].state, 'online');
	assert.ok(snapshot.devices[0].revokeActionHandle);
	assert.deepEqual(snapshot.targets, []);
});

test('offline cached nodes do not count as live targets; saved local and remote grants remain removable', async () => {
	const f = await fixture();
	await f.options.remotePolicies.setAllowed(caller, f.sources[0].workspaceIdentity, allowedTarget, true);
	f.online = false;
	f.offlineLocal = true;
	const snapshot = await f.snapshot();
	assert.equal(snapshot.devices[0].state, 'offline');
	assert.equal(snapshot.devices[0].probeActionHandle, undefined);
	const remote = snapshot.targets.find((target) => target.locality === 'remote')!;
	assert.equal(remote.online, false);
	assert.equal(remote.sources[1].actionHandle, undefined);
	await assert.rejects(f.act('setTargetAllowed', remote.sources[0].actionHandle!, true), /currently authenticated/u);
	const refreshed = await f.snapshot();
	await f.act('setTargetAllowed', refreshed.targets.find((target) => target.locality === 'remote')!.sources[0].actionHandle!, false);
	const local = (await f.snapshot()).targets.find((target) => target.locality === 'local')!;
	assert.equal(local.online, false);
	await f.act('setTargetAllowed', local.sources[0].actionHandle!, false);
	assert.deepEqual(f.localMutations, [{ source: f.sources[0].workspaceIdentity, allowed: false }]);
	assert.equal(f.discoveryCalls, 0);
});

test('management keys join private identities, never duplicate display names, and lifecycle enable is separate from receiving', async () => {
	const f = await fixture();
	const snapshot = await f.snapshot();
	assert.equal(snapshot.workspaces[0].key, managementKey('workspace', f.sources[0].workspaceId));
	assert.equal(snapshot.targets[0].key, managementKey('target', profileId, route.nodeId, route.nodeInstanceId, route.workspaceId));
	await f.act('setWorkspaceReceiving', snapshot.workspaces[0].receiveActionHandle!, true);
	assert.equal(f.sources[0].status, 'claimed');
	await f.act('setWorkspaceEnabled', (await f.snapshot()).workspaces[0].enableActionHandle!, false);
	const disabled = (await f.snapshot()).workspaces[0];
	assert.equal(disabled.enabled, false);
	assert.equal(disabled.acceptsIncoming, true);
	assert.ok(disabled.enableActionHandle);
	await f.act('setWorkspaceEnabled', disabled.enableActionHandle!, true);
	assert.equal(f.sources[0].status, 'claimed');
});
