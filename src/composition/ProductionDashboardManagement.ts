import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
	dashboardManagementActionParamsSchema, dashboardManagementSnapshotSchema,
	TERMINAL_TASK_STATUSES, uuidSchema, utf8ByteLength,
	type DashboardManagement, type DashboardManagementAction, type DashboardManagementActionParams,
	type NodeIdentityParams, type TaskTarget,
} from '../../shared/protocol';
import { managementKey } from '../broker/DashboardManagementKey';
import type { NodeRegistry } from '../broker/NodeRegistry';
import type { PeerPolicyService, PeerPolicyCandidateBinding } from '../broker/PeerPolicyService';
import type { RemotePeerPolicyService } from '../broker/RemotePeerPolicyService';
import type { RemoteAllowedTarget, RemotePeerPolicyStore } from '../broker/RemotePeerPolicyStore';
import type { AccountPeerEnrollment } from '../connectivity/AccountPeerEnrollment';
import type { EndpointBindingStore } from '../connectivity/EndpointBindingStore';
import { MeshDomainError } from '../domain/errors';
import type { PairingRecordStore } from '../gateway/PairingService';
import type { PeerRevocationService } from '../gateway/PeerRevocationService';
import type { LocalIpcSession } from '../ipc';
import type { PeerConnectionManager } from '../peer/PeerConnectionManager';
import type { PeerProfile, PeerProfileStore } from '../peer/PeerProfile';
import type { AtomicFileStore } from '../storage/AtomicFileStore';
import { assertDocumentFence, FencedDocumentStore, type DocumentFence } from '../storage/FencedDocumentStore';
import type { FileTaskStore } from '../tasks/FileTaskStore';
import { redactRemoteText } from '../ui/DashboardRedaction';
import type { ProductionRemoteTaskAdapter } from './ProductionRemoteTaskAdapter';
import { formatMessage, type MessageArgument, type MessageTranslator } from './ProductionLocalization';

const savedDeviceSchema = z.strictObject({
	deviceId: uuidSchema, peerIds: z.array(uuidSchema).max(128), profileIds: z.array(uuidSchema).max(128),
	deleted: z.boolean(), cleanupPending: z.boolean(), name: z.string().max(256).optional(),
});
const savedDevicesSchema = z.strictObject({
	schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), entries: z.array(savedDeviceSchema).max(1024)
		.refine((entries) => new Set(entries.map((entry) => entry.deviceId)).size === entries.length),
});
type Device = {
	deviceId: string; name: string; peerIds: string[]; profiles: PeerProfile[];
	profileIds: string[];
	state: DashboardManagement['devices'][number]['state']; cleanupPending: boolean;
	fingerprint: string;
};
type Binding = {
	action: DashboardManagementAction; caller: NodeIdentityParams; generation: string;
	scope: string; policyRevision: number;
	workspace?: { workspaceId: string; workspaceIdentity: string };
	peerId?: string;
	device?: Device;
	target?: RemoteAllowedTarget;
	route?: TaskTarget;
	localCandidate?: PeerPolicyCandidateBinding;
	confirmation?: string;
};
interface Options {
	readonly files: AtomicFileStore;
	readonly fence: DocumentFence;
	readonly deviceId: string;
	readonly registry: NodeRegistry;
	readonly localPolicies: PeerPolicyService;
	readonly remotePolicies: RemotePeerPolicyService;
	readonly remotePolicyStore: RemotePeerPolicyStore;
	readonly profiles: PeerProfileStore;
	readonly records: PairingRecordStore;
	readonly tasks: FileTaskStore;
	readonly cancelTask: (peerId: string, taskId: string) => Promise<unknown>;
	readonly peers: PeerConnectionManager;
	readonly endpoints: EndpointBindingStore;
	readonly enrollment: AccountPeerEnrollment;
	readonly revocations: PeerRevocationService;
	readonly remoteTasks: () => ProductionRemoteTaskAdapter;
	readonly legacyTasks?: () => readonly { taskId: string; profileId: string; state: string }[];
	readonly cancelLegacyTask?: (taskId: string) => Promise<unknown>;
	readonly ready: () => boolean;
	readonly assertCaller: (caller: NodeIdentityParams, session: LocalIpcSession) => void;
	readonly confirm: (message: string) => Promise<boolean>;
	readonly switchAccount: (validate: () => Promise<void>) => Promise<void>;
	readonly probe: (profileId: string, validate: () => Promise<void>) => Promise<void>;
	readonly revokePeer: (peerId: string) => Promise<void>;
	readonly incomingAdmissionBarrier: <T>(operation: () => Promise<T>) => Promise<T>;
	readonly changed: () => void;
	readonly translate?: MessageTranslator;
}

/** Private identities never cross the management RPC. Handles are consumed before validation. */
export class ProductionDashboardManagement {
	private readonly document: FencedDocumentStore<z.infer<typeof savedDevicesSchema>>;
	private readonly handles = new WeakMap<LocalIpcSession, Map<string, Binding>>();
	private queue: Promise<void> = Promise.resolve();
	private initialized = false;

	public constructor(private readonly options: Options) {
		this.document = new FencedDocumentStore(options.files, 'peers/saved-devices.json', savedDevicesSchema,
			{ schemaVersion: 1, revision: 0, entries: [] }, options.fence);
	}

	public async initialize(): Promise<void> {
		await this.document.initialize();
		this.initialized = true;
	}

	public deviceDenied(deviceId: string): boolean {
		return !this.initialized || this.document.snapshot().entries.some((entry) => entry.deviceId === deviceId);
	}

	public assertDeviceAllowed(deviceId: string): void {
		if (this.deviceDenied(deviceId)) { throw forbidden(this.t('This saved device is revoked.')); }
	}

	public assertPeerAllowed(peerId: string): void {
		if (!this.initialized || this.document.snapshot().entries.some((entry) => entry.peerIds.includes(peerId))) {
			throw forbidden(this.t('This saved device is revoked.'));
		}
	}

	public assertProfileAllowed(profileId: string): void {
		if (!this.initialized || this.document.snapshot().entries.some((entry) => entry.profileIds.includes(profileId))) {
			throw forbidden(this.t('This saved device is revoked.'));
		}
	}

	public isDeleted(deviceId: string): boolean {
		return this.initialized && this.document.snapshot().entries.some((entry) => entry.deviceId === deviceId && entry.deleted);
	}

	public async snapshot(caller: NodeIdentityParams, session: LocalIpcSession): Promise<DashboardManagement> {
		this.options.assertCaller(caller, session);
		const handles = new Map<string, Binding>();
		this.handles.set(session, handles);
		if (!this.initialized || !this.options.ready()) {
			return { available: false, truncated: false, devices: [], workspaces: [], targets: [] };
		}
		const sources = this.sources(caller);
		const scope = this.scope(caller);
		const policyRevision = this.options.remotePolicies.revision();
		let remoteEditable = true;
		try { this.options.remotePolicies.requireEnabled(); } catch { remoteEditable = false; }
		const issue = (action: DashboardManagementAction, rest: Partial<Binding> = {}): string => {
			const handle = randomUUID();
			handles.set(handle, { ...rest, action, caller: { ...caller }, generation: this.options.fence.generation, scope, policyRevision });
			return handle;
		};
		const devices = await this.devices();
		this.options.assertCaller(caller, session);
		const snapshot: DashboardManagement = {
			available: true, truncated: devices.length > 32 || sources.length > 32,
			accountActionHandle: issue('switchAccount'), devices: [], workspaces: [], targets: [],
		};
		let taskRecords: Awaited<ReturnType<FileTaskStore['list']>> | undefined;
		try { taskRecords = await this.options.tasks.list(); } catch { /* An unreadable task store blocks deletion. */ }
		for (const device of devices.slice(0, 32)) {
			let activeTaskCount: number | undefined;
			let deleteBlockedReason: string | undefined;
			try {
				if (taskRecords === undefined) { throw forbidden('Task status is unavailable.'); }
				activeTaskCount = (await this.activeTasks(device, taskRecords)).length;
				if (activeTaskCount > 0) { deleteBlockedReason = this.t('This device has unfinished tasks. Wait for authoritative completion before deleting it.'); }
			} catch {
				deleteBlockedReason = this.t('Task status is unavailable. Refresh before deleting this device.');
			}
			const online = device.profiles.find((profile) =>
				profile.generation !== undefined && this.authenticatedProfile(profile)
				&& this.options.endpoints.get(profile.id)?.profileGeneration === profile.generation);
			snapshot.devices.push({
				key: managementKey('device', device.deviceId), name: device.name,
				state: device.state, cleanupPending: device.cleanupPending,
				...(activeTaskCount === undefined ? {} : { activeTaskCount }),
				...(deleteBlockedReason ? { deleteBlockedReason } : { deleteActionHandle: issue('deleteSavedDevice', { device }) }),
				...(device.state !== 'revoked' || device.cleanupPending ? { revokeActionHandle: issue('revokeDevice', { device }) } : {}),
				...(online && device.state === 'online' ? { probeActionHandle: issue('probeDevice', { device }) } : {}),
			});
		}
		const peerDevices = new Map(devices.flatMap((device) => device.peerIds.map((id) => [id, device] as const)));
		const peers = (await this.options.records.listPeers()).filter((peer) =>
			!this.options.revocations.snapshot().some((entry) => entry.peerId === peer.peerId)
			&& !this.deviceDenied(peer.coordinatorDeviceId) && !peer.cleanupPending);
		const catalog = this.options.registry.catalogSnapshot();
		for (const workspace of sources.slice(0, 32)) {
			const policy = this.options.remotePolicies.policy(workspace.workspaceIdentity);
			const enabled = catalog.workspaces.find((entry) => entry.workspaceId === workspace.workspaceId)?.enabled === true;
			const claimed = workspace.status === 'claimed';
			snapshot.workspaces.push({
				key: managementKey('workspace', workspace.workspaceId), name: safeName(workspace.name, this.t('Workspace')),
				enabled, acceptsIncoming: this.options.localPolicies.acceptsIncoming(workspace.workspaceIdentity),
				...(claimed ? { receiveActionHandle: issue('setWorkspaceReceiving', { workspace }) } : {}),
				enableActionHandle: issue('setWorkspaceEnabled', { workspace }),
				...(enabled ? { removeActionHandle: issue('removeManagedWorkspace', { workspace }) } : {}),
				incomingPeers: peers.slice(0, 32).map((peer) => {
					const name = peerDevices.get(peer.peerId)?.name ?? this.t('Paired device');
					const allowed = policy.incomingPeerIds.includes(peer.peerId);
					return {
						key: managementKey('peer', peer.peerId), name, allowed,
						autoAccept: policy.autoAcceptPeerIds.includes(peer.peerId),
						...(claimed && remoteEditable ? { allowActionHandle: issue('setIncomingDeviceGrant', { workspace, peerId: peer.peerId }) } : {}),
						...(claimed && remoteEditable && allowed ? { autoAcceptActionHandle: issue('setDeviceAutoAccept', {
							workspace, peerId: peer.peerId,
							confirmation: this.t('Automatically accept future tasks from "{0}" in Workspace "{1}"? This skips only task-start confirmation. Tool approvals, receive and device grants still apply.',
								name, safeName(workspace.name, this.t('Workspace'))),
						}) } : {}),
					};
				}),
			});
			if (peers.length > 32) { snapshot.truncated = true; }
		}
		const claimed = sources.filter((source) => source.status === 'claimed');
		const remote = this.options.remoteTasks();
		const targets = new Map<string, { target: RemoteAllowedTarget; route?: TaskTarget; deviceName: string; windowName: string; workspaceName: string }>();
		for (const device of remote.cachedDevices().devices) {
			const state = devices.find((entry) => entry.deviceId === device.deviceId)?.state;
			if (device.peerId === undefined || (state !== 'online' && state !== 'busy')) { continue; }
			for (const node of device.nodes) {
				for (const workspace of node.workspaces) {
					const route = { deviceId: device.deviceId, nodeId: node.nodeId, nodeInstanceId: node.nodeInstanceId, workspaceId: workspace.workspaceId };
					const metadata = remote.lookupTarget(device.peerId, route);
					const actual = metadata?.node.workspaces.find((entry) => entry.workspaceId === workspace.workspaceId);
					if (!metadata || !actual) { continue; }
					const target = { profileId: metadata.profileId, profileGeneration: metadata.profileGeneration, workspaceIdentity: actual.workspaceIdentity };
					targets.set(targetIdentity(target), { target, route, deviceName: safeName(device.deviceName, this.t('Remote device')),
						windowName: safeName(node.label, this.t('Window')), workspaceName: safeName(workspace.name, this.t('Workspace')) });
				}
			}
		}
		for (const source of claimed) {
			for (const target of this.options.remotePolicies.policy(source.workspaceIdentity).allowlist) {
				if (!targets.has(targetIdentity(target))) {
					targets.set(targetIdentity(target), { target,
						deviceName: devices.find((device) => device.profiles.some((profile) => profile.id === target.profileId))?.name ?? this.t('Saved device'),
						windowName: this.t('Saved window'), workspaceName: this.t('Saved Workspace') });
				}
			}
		}
		for (const value of targets.values()) {
			if (snapshot.targets.length >= 128) { snapshot.truncated = true; break; }
			const { target, route } = value;
			const sourcePermissions = claimed.map((source) => {
				const allowed = this.options.remotePolicies.policy(source.workspaceIdentity).allowlist.some((entry) => targetIdentity(entry) === targetIdentity(target));
				return {
					sourceKey: managementKey('workspace', source.workspaceId), allowed,
					...(remoteEditable && (route || allowed) ? { actionHandle: issue('setTargetAllowed', { workspace: source, target, route }) } : {}),
				};
			});
			snapshot.targets.push({
				key: route ? managementKey('target', target.profileId, route.nodeId, route.nodeInstanceId, route.workspaceId)
					: managementKey('target', targetIdentity(target)),
				deviceName: value.deviceName, windowName: value.windowName, workspaceName: value.workspaceName,
				locality: 'remote', online: route !== undefined, sources: sourcePermissions,
				...(remoteEditable && claimed.length > 1 ? { allSourcesActionHandle: issue('setWindowTargetAllowed', {
					target, route, confirmation: this.t('Apply this target permission to ALL these source Workspaces: {0}?',
						claimed.map((source) => `"${safeName(source.name, this.t('Workspace'))}"`).join(', ')),
				}) } : {}),
				allSourcesAllowed: sourcePermissions.every((source) => source.allowed) && sourcePermissions.length > 0
					? 'all' : sourcePermissions.some((source) => source.allowed) ? 'some' : 'none',
			});
		}
		const local = new Map<string, DashboardManagement['targets'][number]>();
		for (const source of claimed) {
			let candidates: readonly PeerPolicyCandidateBinding[];
			try { candidates = this.options.localPolicies.listCandidates({ ...caller, workspaceIdentity: source.workspaceIdentity }); }
			catch { continue; }
			for (const candidate of candidates) {
				if (candidate.candidate.self || candidate.targetWorkspaceIdentity === undefined) { continue; }
				const id = candidate.targetWorkspaceIdentity;
				let target = local.get(id);
				if (!target) {
					if (snapshot.targets.length + local.size >= 128) { snapshot.truncated = true; continue; }
					const targetWorkspace = this.options.registry.peerNodes().flatMap((node) => node.workspaces)
						.find((workspace) => workspace.workspaceIdentity === id);
					target = {
						key: candidate.targetNodeId && candidate.targetNodeInstanceId && targetWorkspace
							? managementKey('target', 'local', candidate.targetNodeId, candidate.targetNodeInstanceId, targetWorkspace.workspaceId)
							: managementKey('target', 'local', id),
						deviceName: this.t('This device'), windowName: safeName(candidate.candidate.windowLabel, this.t('Window')),
						workspaceName: safeName(candidate.candidate.workspaceName, this.t('Workspace')),
						locality: 'local', online: candidate.candidate.online, sources: [], allSourcesAllowed: 'none',
					};
					local.set(id, target);
				}
				target.sources.push({
					sourceKey: managementKey('workspace', source.workspaceId), allowed: candidate.candidate.allowlisted,
					...(candidate.candidate.canToggle ? { actionHandle: issue('setTargetAllowed', { workspace: source, localCandidate: candidate }) } : {}),
				});
			}
		}
		for (const target of local.values()) {
			target.allSourcesAllowed = target.sources.every((source) => source.allowed) ? 'all' : target.sources.some((source) => source.allowed) ? 'some' : 'none';
			snapshot.targets.push(target);
		}
		// Leave transport headroom for JSON-RPC and the rest of the Dashboard.
		while (utf8ByteLength(JSON.stringify(snapshot)) > 192 * 1024) {
			snapshot.truncated = true;
			if (snapshot.targets.length) { snapshot.targets.pop(); }
			else if (snapshot.workspaces.length) { snapshot.workspaces.pop(); }
			else { snapshot.devices.pop(); }
		}
		this.options.assertCaller(caller, session);
		return dashboardManagementSnapshotSchema.parse(snapshot);
	}

	public act(caller: NodeIdentityParams, raw: DashboardManagementActionParams, session: LocalIpcSession): Promise<void> {
		const input = dashboardManagementActionParamsSchema.parse(raw);
		const binding = this.handles.get(session)?.get(input.actionHandle);
		this.handles.get(session)?.delete(input.actionHandle);
		if (!binding || binding.action !== input.action) { throw forbidden(this.t('The management action is stale or belongs to another window.')); }
		const validate = async (): Promise<void> => {
			await assertDocumentFence(this.options.fence);
			this.options.assertCaller(caller, session);
			if (!this.options.ready() || binding.generation !== this.options.fence.generation
				|| binding.caller.nodeId !== caller.nodeId || binding.caller.nodeInstanceId !== caller.nodeInstanceId
				|| input.nodeId !== caller.nodeId || input.nodeInstanceId !== caller.nodeInstanceId) {
				throw forbidden('The authenticated management caller changed.');
			}
			if (binding.workspace || binding.target || binding.localCandidate) {
				if (this.scope(caller) !== binding.scope || this.options.remotePolicies.revision() !== binding.policyRevision) {
					throw forbidden('Workspace claims or permissions changed. Refresh before editing.');
				}
				if (binding.workspace && !this.sources(caller).some((source) =>
					source.workspaceId === binding.workspace!.workspaceId && source.workspaceIdentity === binding.workspace!.workspaceIdentity)) {
					throw forbidden('The exact Workspace changed.');
				}
			}
			if (binding.device) {
				const device = (await this.devices()).find((entry) => entry.deviceId === binding.device!.deviceId);
				if (!device || device.fingerprint !== binding.device.fingerprint || device.state !== binding.device.state) {
					throw forbidden('The exact device or its connection state changed. Refresh before continuing.');
				}
			}
		};
		const operation = this.queue.then(async () => {
			await validate();
			if (input.action === 'switchAccount') { await this.options.switchAccount(validate); }
			else if (input.action === 'probeDevice') {
				const profile = binding.device!.profiles.find((entry) =>
					entry.generation !== undefined && this.authenticatedProfile(entry)
					&& this.options.endpoints.get(entry.id)?.profileGeneration === entry.generation);
				if (!profile) { throw forbidden('The exact authenticated connection is no longer online.'); }
				await this.options.probe(profile.id, validate);
			} else if (input.action === 'revokeDevice' || input.action === 'deleteSavedDevice') {
				const device = binding.device!;
				if (input.action === 'deleteSavedDevice' && (await this.activeTasks(device)).length) {
					throw forbidden('Saved device deletion is blocked by unfinished tasks.');
				}
				if (!await this.options.confirm(input.action === 'deleteSavedDevice'
					? this.t('Delete saved device "{0}" ({1})? Trust and related permissions will be revoked. Task history is retained.', device.name, this.stateLabel(device.state))
					: this.t('Revoke trust for "{0}" ({1})? Connections will close and unfinished tasks receive authoritative cancellation requests. The revocation record is retained.', device.name, this.stateLabel(device.state)))) { return; }
				await validate();
				await this.denyDevice(device, input.action === 'deleteSavedDevice', validate);
				await this.cleanupDevice(device, input.action === 'deleteSavedDevice');
			} else if (input.action === 'setWorkspaceEnabled' || input.action === 'removeManagedWorkspace') {
				if (input.action === 'removeManagedWorkspace' && !await this.options.confirm(this.t('Remove this Workspace from managed execution? Its registry entry is disabled; permissions and task history are retained.'))) { return; }
				await validate();
				await this.options.registry.setWorkspaceEnabled(binding.workspace!.workspaceId, input.action === 'setWorkspaceEnabled' && input.enabled === true);
			} else if (input.action === 'setWorkspaceReceiving') {
				await this.options.localPolicies.setRemoteReceive(caller, binding.workspace!.workspaceIdentity, input.enabled!);
			} else if (input.action === 'setIncomingDeviceGrant') {
				await this.options.remotePolicies.setIncomingGrant(caller, binding.workspace!.workspaceIdentity, binding.peerId!, input.enabled!);
			} else if (input.action === 'setDeviceAutoAccept') {
				if (input.enabled && !await this.options.confirm(binding.confirmation!)) { return; }
				await validate();
				await this.options.remotePolicies.setAutoAccept(caller, binding.workspace!.workspaceIdentity, binding.peerId!, input.enabled!, binding.policyRevision);
			} else if (binding.localCandidate) {
				await this.options.localPolicies.setCandidateAllowed(caller, binding.localCandidate, input.enabled!);
			} else {
				if (input.action === 'setWindowTargetAllowed') {
					if (!await this.options.confirm(binding.confirmation!)) { return; }
					await validate();
				}
				if (input.enabled) {
					if (binding.route === undefined) {
						throw forbidden('Only the exact currently authenticated target can be newly allowed.');
					}
					const remote = this.options.remoteTasks();
					await remote.listDevices(AbortSignal.timeout(10_000));
					await validate();
					const metadata = remote.lookupTarget(binding.target!.profileId, binding.route);
					if (!metadata || metadata.profileGeneration !== binding.target!.profileGeneration
						|| !metadata.node.workspaces.some((workspace) => workspace.workspaceId === binding.route!.workspaceId
							&& workspace.workspaceIdentity === binding.target!.workspaceIdentity)) {
						throw forbidden('Only the exact currently authenticated target can be newly allowed.');
					}
				}
				await validate();
				if (input.action === 'setWindowTargetAllowed') {
					await this.options.remotePolicies.setAllowedForWindow(caller, this.options.remotePolicies.sourceScope(caller),
						binding.target!, input.enabled!, binding.policyRevision);
				} else {
					await this.options.remotePolicies.setAllowed(caller, binding.workspace!.workspaceIdentity, binding.target!, input.enabled!);
				}
			}
		}).catch((error: unknown) => {
			if (error instanceof MeshDomainError) {
				throw new MeshDomainError(error.reason, this.t(error.message), error.retryable);
			}
			throw error;
		}).finally(() => this.options.changed());
		this.queue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	private t(message: string, ...args: MessageArgument[]): string {
		return (this.options.translate ?? formatMessage)(message, ...args);
	}

	private stateLabel(state: Device['state']): string {
		const labels: Record<Device['state'], string> = {
			connecting: 'Connecting', online: 'Online', busy: 'Busy', offline: 'Offline',
			authFailed: 'Authentication failed', incompatible: 'Incompatible', unknown: 'Unknown',
			pending: 'Pending', revoked: 'Revoked',
		};
		return this.t(labels[state]);
	}

	private sources(caller: NodeIdentityParams) {
		return this.options.registry.peerNode(caller)?.workspaces.filter((workspace) => workspace.status !== 'conflict') ?? [];
	}

	private scope(caller: NodeIdentityParams): string {
		return JSON.stringify(this.sources(caller).map((source) => [source.workspaceId, source.workspaceIdentity, source.status]).sort());
	}

	private authenticatedProfile(profile: PeerProfile): boolean {
		const connection = this.options.peers.get(profile.id);
		const authentication = connection?.authenticatedBinding?.();
		return connection?.snapshot().state === 'online' && authentication !== undefined
			&& authentication.profileGeneration === profile.generation && authentication.deviceId === profile.workerDeviceId;
	}

	private async devices(): Promise<Device[]> {
		const profiles = await this.options.profiles.list();
		const records = await this.options.records.listPeers();
		const pending = await this.options.records.listPending();
		const enrolled = this.options.enrollment.entries();
		const saved = this.document.snapshot().entries;
		const cached = this.options.remoteTasks().cachedDevices().devices;
		const ids = new Set([
			...profiles.map((entry) => entry.workerDeviceId), ...records.map((entry) => entry.coordinatorDeviceId),
			...pending.map((entry) => entry.coordinatorDeviceId), ...enrolled.map((entry) => entry.deviceId),
			...saved.map((entry) => entry.deviceId), ...cached.map((entry) => entry.deviceId),
		]);
		const devices: Device[] = [];
		for (const deviceId of ids) {
			if (deviceId === this.options.deviceId || this.isDeleted(deviceId)) { continue; }
			const ownProfiles = profiles.filter((profile) => profile.workerDeviceId === deviceId);
			const entry = saved.find((value) => value.deviceId === deviceId);
			const peerIds = [...new Set([
				...records.filter((record) => record.coordinatorDeviceId === deviceId).map((record) => record.peerId),
				...pending.filter((record) => record.coordinatorDeviceId === deviceId).map((record) => record.peerId),
				...enrolled.filter((record) => record.deviceId === deviceId).flatMap((record) => [record.incomingPeerId, ...record.legacyIncomingPeerIds]),
				...entry?.peerIds ?? [],
			])].sort();
			const profileIds = [...new Set([
				...ownProfiles.map((profile) => profile.id), ...entry?.profileIds ?? [],
				...enrolled.filter((record) => record.deviceId === deviceId).map((record) => record.profileId),
			])].sort();
			const revocations = this.options.revocations.snapshot().filter((record) => peerIds.includes(record.peerId));
			const states = ownProfiles.map((profile) => {
				const state = this.options.peers.get(profile.id)?.snapshot().state;
				return state === 'online' && !this.authenticatedProfile(profile) ? 'unknown' : state;
			});
			const state: Device['state'] = entry || revocations.length ? 'revoked'
				: states.includes('online') ? 'online' : states.includes('busy') ? 'busy'
					: states.includes('connecting') ? 'connecting' : states.includes('authFailed') || states.includes('rePairRequired') ? 'authFailed'
						: states.includes('incompatible') ? 'incompatible'
							: states.includes('unknown') ? 'unknown' : pending.some((record) => record.coordinatorDeviceId === deviceId) ? 'pending'
								: ownProfiles.length || records.some((record) => record.coordinatorDeviceId === deviceId) ? 'offline' : 'unknown';
			devices.push({
				deviceId, name: safeName(cached.find((device) => device.deviceId === deviceId)?.deviceName ?? entry?.name ?? this.t('Saved device'), this.t('Saved device')),
				peerIds, profiles: ownProfiles, profileIds, state,
				cleanupPending: entry?.cleanupPending === true || revocations.some((record) => record.cleanupPending || record.taskCancellationPending)
					|| ownProfiles.some((profile) => profile.cleanupPending === true),
				fingerprint: JSON.stringify([peerIds, ownProfiles.map((profile) => [profile.id, profile.generation, profile.credentialKeyRef, profile.cleanupPending]).sort(),
					enrolled.filter((record) => record.deviceId === deviceId).map((record) => [record.accountRef, record.profileId, record.profileGeneration]),
					ownProfiles.map((profile) => [profile.id, this.options.peers.get(profile.id)?.authenticatedBinding?.()])]),
			});
		}
		return devices.sort((left, right) => left.deviceId.localeCompare(right.deviceId));
	}

	private async activeTasks(
		device: Device, records?: Awaited<ReturnType<FileTaskStore['list']>>,
	): Promise<{ taskId: string; state: string }[]> {
		const incoming = (records ?? await this.options.tasks.list()).filter((task) => device.peerIds.includes(task.peerId));
		const outgoing = this.options.remoteTasks().associatedTasks(device.deviceId, device.profileIds);
		const legacy = this.options.legacyTasks?.().filter((task) => device.profileIds.includes(task.profileId)) ?? [];
		return [...incoming, ...outgoing, ...legacy].filter((task) => !(TERMINAL_TASK_STATUSES as readonly string[]).includes(task.state));
	}

	private async denyDevice(device: Device, deleting: boolean, validate: () => Promise<void>): Promise<void> {
		await this.options.incomingAdmissionBarrier(() => this.options.remoteTasks().withAdmissionBarrier(async () => {
			await validate();
			if (deleting && (await this.activeTasks(device)).length) {
				throw forbidden('A task started while confirmation was open. Deletion is blocked.');
			}
			await this.document.update((document) => ({
				...document, entries: [
					...document.entries.filter((entry) => entry.deviceId !== device.deviceId),
					{ deviceId: device.deviceId, peerIds: device.peerIds, profileIds: device.profileIds,
						deleted: false, cleanupPending: true, name: device.name },
				],
			}), validate);
		}));
	}

	private async cleanupDevice(selected: Device, deleting: boolean): Promise<void> {
		const failures: unknown[] = [];
		// Wait out pre-existing enrollment writes before removing their credentials.
		await this.options.enrollment.blockDevice(selected.deviceId);
		const device = (await this.devices()).find((entry) => entry.deviceId === selected.deviceId);
		if (!device) { throw forbidden('The saved device cleanup binding changed.'); }
		await this.document.update((document) => ({
			...document, entries: document.entries.map((entry) => entry.deviceId === device.deviceId
				? { ...entry, peerIds: device.peerIds, profileIds: device.profileIds } : entry),
		}));
		// Cancel outgoing work on the still-authenticated connection before disconnecting it.
		for (const task of this.options.remoteTasks().associatedTasks(device.deviceId, device.profileIds)) {
			if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(task.state)) { continue; }
			try {
				if (await this.options.remoteTasks().cancelTask(task.taskId, new AbortController().signal) === undefined) {
					throw forbidden('Authoritative task cancellation could not be requested.');
				}
			}
			catch (error) { failures.push(error); }
		}
		for (const task of this.options.legacyTasks?.().filter((task) => device.profileIds.includes(task.profileId)) ?? []) {
			if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(task.state)) { continue; }
			try {
				if (!this.options.cancelLegacyTask) { throw forbidden('Legacy cancellation is unavailable.'); }
				await this.options.cancelLegacyTask(task.taskId);
			} catch (error) { failures.push(error); }
		}
		try {
			for (const task of (await this.options.tasks.list()).filter((entry) =>
				device.peerIds.includes(entry.peerId) && !(TERMINAL_TASK_STATUSES as readonly string[]).includes(entry.state))) {
				try { await this.options.cancelTask(task.peerId, task.taskId); }
				catch (error) { failures.push(error); }
			}
		} catch (error) { failures.push(error); }
		for (const peerId of device.peerIds) {
			try { await this.options.revokePeer(peerId); }
			catch (error) { failures.push(error); }
			try { await this.options.remotePolicyStore.removePeer(peerId); }
			catch (error) { failures.push(error); }
		}
		try { await this.options.remotePolicyStore.removeProfiles(device.profileIds); }
		catch (error) { failures.push(error); }
		for (const profile of device.profiles) {
			try {
				await this.options.peers.disconnect(profile.id);
				await this.options.peers.remove(profile.id);
				if (await this.options.profiles.get(profile.id) !== undefined) { throw forbidden('Saved profile cleanup did not complete.'); }
			} catch (error) { failures.push(error); }
		}
		for (const reference of this.options.endpoints.references().filter((entry) => device.profileIds.includes(entry.profileId))) {
			try { await this.options.endpoints.remove(reference.profileId, reference.profileGeneration); }
			catch (error) { failures.push(error); }
		}
		if (failures.length) { throw forbidden('Trust is denied, but device permission, credential or task cleanup needs retry. The saved record was retained.'); }
		if (deleting && (await this.activeTasks(device)).length) { throw forbidden('Deletion is blocked until all associated tasks are terminal.'); }
		await this.document.update((document) => ({
			...document, entries: document.entries.map((entry) => entry.deviceId === device.deviceId
				? { ...entry, cleanupPending: false, deleted: deleting, ...(deleting ? { name: undefined } : {}) } : entry),
		}));
		if (deleting) { this.options.remoteTasks().forgetDevice(device.deviceId); }
	}
}

function targetIdentity(target: RemoteAllowedTarget): string {
	return JSON.stringify([target.profileId, target.profileGeneration, target.workspaceIdentity]);
}

function forbidden(message: string): MeshDomainError {
	return new MeshDomainError('POLICY_FORBIDDEN', message);
}

function safeName(value: string, fallback: string): string {
	const redacted = redactRemoteText(value);
	return [...redacted].reduce((result, char) => utf8ByteLength(result + char) <= 256 ? result + char : result, '') || fallback;
}
