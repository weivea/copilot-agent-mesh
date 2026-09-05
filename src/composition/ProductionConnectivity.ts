import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';

import {
	ACTIVE_TASK_STATUSES, connectivitySnapshotSchema,
	type ConnectivityActionParams, type ConnectivitySnapshot, type NodeIdentityParams,
	remotePolicyDashboardSchema,
	type RemotePolicyActionParams, type RemotePolicyDashboard, type TaskTarget,
} from '../../shared/protocol';
import type { ListenerService } from '../application/ListenerService';
import type { NodeRegistry } from '../broker/NodeRegistry';
import type { PeerPolicyService } from '../broker/PeerPolicyService';
import { RemotePeerPolicyService } from '../broker/RemotePeerPolicyService';
import { RemotePeerPolicyStore } from '../broker/RemotePeerPolicyStore';
import type { RemoteAllowedTarget } from '../broker/RemotePeerPolicyStore';
import { AccountSessionProvider } from '../connectivity/AccountSessionProvider';
import { BoundPeerTransport } from '../connectivity/BoundPeerTransport';
import type { BrokerConnectivity } from '../connectivity/BrokerConnectivity';
import {
	ConnectivityError, EMPTY_CONNECTIVITY_SETTINGS, connectivitySettingsSchema,
	type ConnectivityCode, type ConnectivitySettings,
} from '../connectivity/ConnectivitySchemas';
import { DevTunnelDiscoveryProvider, type DiscoveredEndpoint } from '../connectivity/DevTunnelDiscoveryProvider';
import { DevTunnelEndpointResolver } from '../connectivity/DevTunnelEndpointResolver';
import { DevTunnelManagement, normalizeConnectivityError } from '../connectivity/DevTunnelManagement';
import { DiscoveryService } from '../connectivity/DiscoveryService';
import { EndpointBindingStore } from '../connectivity/EndpointBindingStore';
import { probeConnectedPeer } from '../connectivity/ConnectivityProbe';
import { incomingPeerCatalog } from '../connectivity/IncomingPeerCatalog';
import { MeshDomainError } from '../domain/errors';
import { PairingService, type PairingRecordStore } from '../gateway/PairingService';
import { PeerRevocationService } from '../gateway/PeerRevocationService';
import type { SecretStore } from '../gateway/SecretStore';
import type { LocalIpcSession } from '../ipc';
import { parseConnectionUrl } from '../peer/ConnectionUrl';
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import type { PeerProfileStore } from '../peer/PeerProfile';
import type { AtomicFileStore } from '../storage/AtomicFileStore';
import { assertDocumentFence, FencedDocumentStore, type DocumentFence } from '../storage/FencedDocumentStore';
import type { FileTaskStore } from '../tasks/FileTaskStore';
import { CliDevTunnelExposureAdapter } from '../tunnel/CliDevTunnelExposureAdapter';
import { SdkDevTunnelExposureProvider } from '../tunnel/SdkDevTunnelExposureProvider';
import { SelectedExposureProvider } from '../tunnel/SelectedExposureProvider';
import type { LazyVscodeDevTunnelProvider } from './LazyVscodeDevTunnelProvider';
import type { ProductionRemoteTaskAdapter } from './ProductionRemoteTaskAdapter';
import { resolveWindowDisplayName } from '../broker/WindowName';

interface ConnectivityOptions {
	readonly vscodeApi: typeof vscode;
	readonly files: AtomicFileStore;
	readonly fence: DocumentFence;
	readonly deviceId: string;
	readonly profiles: PeerProfileStore;
	readonly records: PairingRecordStore;
	readonly secrets: SecretStore;
	readonly registry: NodeRegistry;
	readonly localPolicies: PeerPolicyService;
	readonly tasks: FileTaskStore;
	readonly cancelTask: (peerId: string, taskId: string) => Promise<unknown>;
	readonly listener: () => ListenerService | undefined;
	readonly remoteTasks: () => ProductionRemoteTaskAdapter;
	readonly cli: LazyVscodeDevTunnelProvider;
	readonly changed: () => void;
	readonly report: (code: ConnectivityCode) => void;
}

interface ActionBinding {
	readonly kind: 'candidate' | 'peer';
	readonly id: string;
}

type PolicyActionBinding = {
	readonly action: 'setRemoteAutoAccept';
	readonly workspaceId: string;
	readonly workspaceIdentity: string;
	readonly peerId: string;
	readonly workspaceName: string;
	readonly peerLabel: string;
	readonly revision: number;
} | {
	readonly action: 'setRemoteReceive';
	readonly workspaceId: string;
	readonly workspaceIdentity: string;
	readonly revision: number;
} | {
	readonly action: 'setRemoteAllowed';
	readonly target: RemoteAllowedTarget;
	readonly route: TaskTarget;
	readonly sourceScope: string;
	readonly revision: number;
};

export class ProductionConnectivity implements BrokerConnectivity {
	public readonly settings: FencedDocumentStore<ConnectivitySettings>;
	public readonly endpoints: EndpointBindingStore;
	public readonly remotePolicyStore: RemotePeerPolicyStore;
	public readonly remotePolicies: RemotePeerPolicyService;
	public readonly revocations: PeerRevocationService;
	public readonly pairing: PairingService;
	public readonly account: AccountSessionProvider;
	public readonly management: DevTunnelManagement;
	public readonly discovery: DiscoveryService;
	public readonly transport: BoundPeerTransport;
	public readonly peers: PeerConnectionManager;
	public readonly sdkExposure: SdkDevTunnelExposureProvider;
	public readonly exposure: SelectedExposureProvider;
	private readonly publisher: DevTunnelDiscoveryProvider;
	private ready = false;
	private settingsLoaded = false;
	private strictActivated = false;
	private disposed = false;
	private error: ConnectivityCode | undefined;
	private publishedKey: string | undefined;
	private publishing: Promise<void> | undefined;
	private actionQueue: Promise<void> = Promise.resolve();
	private readonly actions = new WeakMap<LocalIpcSession, Map<string, ActionBinding>>();
	private readonly policyActions = new WeakMap<LocalIpcSession, Map<string, PolicyActionBinding>>();
	private subscriptions: { dispose(): void }[] = [];

	public constructor(private readonly options: ConnectivityOptions) {
		const { files, fence } = options;
		this.settings = new FencedDocumentStore(files, 'connectivity/settings.json',
			connectivitySettingsSchema, EMPTY_CONNECTIVITY_SETTINGS, fence);
		this.endpoints = new EndpointBindingStore(files, fence);
		this.remotePolicyStore = new RemotePeerPolicyStore(files, fence);
		this.account = new AccountSessionProvider(options.vscodeApi.authentication, fence);
		this.management = new DevTunnelManagement(this.account, fence, () =>
			this.ready && this.flag('crossDeviceDiscovery'));
		this.publisher = new DevTunnelDiscoveryProvider(this.management);
		this.discovery = new DiscoveryService(this.publisher, fence,
			() => this.ready && this.flag('crossDeviceDiscovery'), () => this.account.current() !== undefined, options.changed);
		this.revocations = new PeerRevocationService(files, fence, options.records, options.secrets,
			(peerId) => options.listener()?.closePeer(peerId),
			async (peerId) => {
				const results = await Promise.allSettled([
					this.remotePolicyStore.removePeer(peerId),
					(async () => {
						const tasks = (await options.tasks.list()).filter((task) =>
							task.peerId === peerId && (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.state));
						const cancelled = await Promise.allSettled(tasks.map((task) => options.cancelTask(peerId, task.taskId)));
						if (cancelled.some((result) => result.status === 'rejected')) {
							throw new Error('Revoked peer task cancellation requires retry.');
						}
					})(),
				]);
				if (results.some((result) => result.status === 'rejected')) {
					throw new Error('Revoked peer grant or task cleanup requires retry.');
				}
			}, options.changed);
		this.pairing = new PairingService(options.deviceId, options.secrets, options.records, {
			accessControl: {
				assertAllowed: (peerId) => {
					this.assertReady();
					this.revocations.assertAllowed(peerId);
				},
				revoke: (peerId) => this.revocations.revoke(peerId),
				retryCleanup: () => this.revocations.retryCleanup(),
			},
		});
		this.remotePolicies = new RemotePeerPolicyService(
			this.remotePolicyStore, options.registry, options.localPolicies, this.endpoints, options.profiles,
			{
				strict: () => this.strict(),
				enabled: () => this.flag('crossDeviceDelegation'),
				ready: () => this.ready,
				draining: () => this.currentSettings().migrationPending,
				assertPeerAllowed: (id) => this.revocations.assertAllowed(id),
				assertPeerActive: (id) => this.pairing.assertActivePeer(id),
			},
		);
		this.transport = new BoundPeerTransport(this.endpoints, new DevTunnelEndpointResolver(this.management),
			this.account, fence, () => this.ready);
		this.peers = new PeerConnectionManager(options.deviceId, options.profiles, options.secrets,
			this.transport, {
				ownership: fence.ownership,
				onProfileRemoved: async (profile) => {
					if (this.ready && profile.generation !== undefined) { await this.endpoints.remove(profile.id, profile.generation); }
				},
			});
		this.sdkExposure = new SdkDevTunnelExposureProvider(files, fence, this.management, this.account, {
			enabled: () => this.ready && this.flag('crossDeviceDiscovery')
				&& this.flag('devTunnelSdkHosting') && this.currentSettings().publishEnabled,
			advertisementId: () => this.currentSettings().advertisementId,
		});
		this.exposure = new SelectedExposureProvider(new CliDevTunnelExposureAdapter(options.cli),
			this.sdkExposure, () => this.currentSettings().hostingBackend, () =>
				this.ready && !this.currentSettings().migrationPending
				&& (this.currentSettings().hostingBackend === 'cli' || this.flag('devTunnelSdkHosting')));
	}

	public isReady(): boolean { return this.ready; }
	public strict(): boolean { return this.strictActivated || this.flag('crossDeviceDelegation'); }
	public beginShutdown(): void {
		this.disposed = true;
		this.ready = false;
		this.management.invalidate();
		this.discovery.invalidate();
		this.sdkExposure.cancel();
	}

	public async initialize(): Promise<void> {
		try {
			await this.settings.initialize();
			this.settingsLoaded = true;
			this.strictActivated = this.currentSettings().strictPolicyActivated || this.flag('crossDeviceDelegation');
			if (this.strictActivated && !this.currentSettings().strictPolicyActivated) {
				await this.settings.update((value) => ({ ...value, strictPolicyActivated: true }));
			}
			await Promise.all([
				this.endpoints.initialize(), this.remotePolicyStore.initialize(),
				this.revocations.initialize(), this.sdkExposure.initialize(),
			]);
			this.account.initialize();
			this.account.setBinding(this.currentSettings().account);
			this.ready = true;
			this.subscriptions = [
				this.account.onDidChange(() => {
					this.publishedKey = undefined;
					this.discovery.invalidate();
					if (this.sdkExposure.getStatus().state !== 'stopped') {
						void this.options.listener()?.stop().catch(() => this.recordError('CLEANUP_FAILED'));
					}
				}),
				this.options.vscodeApi.workspace.onDidChangeConfiguration((event) => {
					if (['crossDeviceDiscovery', 'crossDeviceDelegation', 'devTunnelSdkHosting']
						.some((key) => event.affectsConfiguration(`copilotAgentMesh.experimental.${key}`))) {
						this.strictActivated ||= this.flag('crossDeviceDelegation');
						this.management.invalidate();
						this.discovery.invalidate();
						void this.configurationChanged().catch(() => this.blockRemote());
					}
				}),
			];
			// Denial is live before any cleanup can fail and before the Listener accepts connections.
			await this.pairing.retryRevocationCleanup().catch(() => this.recordError('CLEANUP_FAILED'));
			for (const binding of this.endpoints.references()) {
				const profile = await this.options.profiles.get(binding.profileId);
				if (profile === undefined || profile.generation !== binding.profileGeneration || profile.cleanupPending) {
					await this.endpoints.remove(binding.profileId, binding.profileGeneration);
				}
			}
			if (this.flag('crossDeviceDiscovery') && this.currentSettings().account !== undefined) {
				void this.discovery.refresh().catch(() => this.recordError('DISCOVERY_UNAVAILABLE'));
			}
		} catch {
			this.blockRemote();
		}
		this.options.changed();
	}

	public async snapshot(caller: NodeIdentityParams, session: LocalIpcSession): Promise<ConnectivitySnapshot> {
		this.assertCaller(caller, session);
		const settings = this.currentSettings();
		const discovery = this.discovery.snapshot();
		const claimed = this.options.registry.peerNode(caller)?.workspaces.filter((workspace) => workspace.status === 'claimed') ?? [];
		const peerError = this.ready ? this.peers.listConnections().flatMap((connection) => {
			if (this.endpoints.get(connection.profileId) === undefined
				|| ['online', 'connecting'].includes(connection.snapshot().state)) { return []; }
			return [this.transport.lastError(connection.profileId) ?? 'OFFLINE' as const];
		})[0] : undefined;
		const error = this.error ?? peerError ?? discovery.error;
		const handles = new Map<string, ActionBinding>();
		this.actions.set(session, handles);
		const issue = (kind: ActionBinding['kind'], id: string): string => {
			const handle = randomUUID(); handles.set(handle, { kind, id }); return handle;
		};
		const incoming: ConnectivitySnapshot['incomingPeers'] = [];
		let incomingTruncated = false;
		if (this.ready) {
			const catalog = await this.incomingPeers();
			incomingTruncated = catalog.length > 256;
			for (const peer of catalog.slice(0, 256)) {
				incoming.push({
					actionHandle: issue('peer', peer.peerId), label: `Peer ${peer.peerId.slice(0, 8)}`,
					state: peer.state, cleanupPending: peer.cleanupPending,
				});
			}

		}
		return connectivitySnapshotSchema.parse({
			discoveryEnabled: this.flag('crossDeviceDiscovery'), delegationEnabled: this.flag('crossDeviceDelegation'),
			strictPolicyActivated: this.strict(), publishEnabled: settings.publishEnabled,
			hostingBackend: settings.hostingBackend, migrationPending: settings.migrationPending,
			accountProvider: settings.account?.providerId ?? 'none',
			claimedWorkspaceCount: claimed.length,
			receivingWorkspaceCount: claimed.filter((workspace) => this.options.localPolicies.acceptsIncoming(workspace.workspaceIdentity)).length,
			state: !this.ready || error !== undefined
				? ['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED'].includes(error ?? '') ? 'authRequired' : 'error'
				: discovery.state,
			...(error === undefined ? {} : { error }),
			truncated: discovery.truncated || incomingTruncated, incomingPeers: incoming,
			candidates: discovery.candidates.map(({ candidateHandle, ...candidate }) => ({
				...candidate, actionHandle: issue('candidate', candidateHandle),
			})),
		});
	}

	public async policySnapshot(caller: NodeIdentityParams, session: LocalIpcSession): Promise<RemotePolicyDashboard> {
		this.assertCaller(caller, session);
		this.remotePolicies.requireEnabled();
		const handles = new Map<string, PolicyActionBinding>();
		this.policyActions.set(session, handles);
		const peers = await this.options.records.listPeers();
		this.assertCaller(caller, session);
		const revoked = new Set(this.revocations.snapshot().map((entry) => entry.peerId));
		const sources = this.remotePolicies.sources(caller);
		const revision = this.remotePolicies.revision();
		const issue = (binding: PolicyActionBinding) => {
			const handle = randomUUID();
			handles.set(handle, binding);
			return handle;
		};
		const workspaces = sources.map((workspace) => {
			const policy = this.remotePolicies.policy(workspace.workspaceIdentity);
			const name = resolveWindowDisplayName(undefined, workspace.name, caller.nodeId);
			return {
				workspaceId: workspace.workspaceId,
				name,
				acceptsIncoming: this.options.localPolicies.acceptsIncoming(workspace.workspaceIdentity),
				receiveActionHandle: issue({
					action: 'setRemoteReceive', workspaceId: workspace.workspaceId, workspaceIdentity: workspace.workspaceIdentity, revision,
				}),
				incomingPeers: peers.filter((peer) =>
					!revoked.has(peer.peerId) && policy.incomingPeerIds.includes(peer.peerId))
					.map((peer) => {
						const label = `Device ${peer.coordinatorDeviceId.slice(0, 8)} (peer ${peer.peerId.slice(0, 8)})`;
						return {
							peerId: peer.peerId, label, autoAccept: policy.autoAcceptPeerIds.includes(peer.peerId),
							actionHandle: issue({
								action: 'setRemoteAutoAccept', workspaceId: workspace.workspaceId,
								workspaceIdentity: workspace.workspaceIdentity, peerId: peer.peerId,
								workspaceName: name, peerLabel: label, revision,
							}),
						};
					}),
			};
		});
		const remote = this.options.remoteTasks();
		const remoteTargets: RemotePolicyDashboard['remoteTargets'] = [];
		const peerStates: RemotePolicyDashboard['peerStates'] = [];
		for (const profile of (await this.options.profiles.list()).filter((entry) =>
			!entry.cleanupPending && entry.peerId !== undefined && entry.credentialKeyRef !== undefined
			&& entry.invitationId === undefined && entry.pendingEnrollmentId === undefined).slice(0, 32)) {
			const state = this.peers.get(profile.id)?.snapshot().state ?? 'offline';
			peerStates.push({
				profileId: profile.id, deviceId: profile.workerDeviceId,
				state: state === 'rePairRequired' ? 'authFailed' : state,
			});
		}
		let truncated = false;
		for (const device of remote.cachedDevices().devices) {
			if (device.peerId === undefined) { continue; }
			for (const node of device.nodes) {
				for (const workspace of node.workspaces) {
					const route = { deviceId: device.deviceId, nodeId: node.nodeId, nodeInstanceId: node.nodeInstanceId, workspaceId: workspace.workspaceId };
					const metadata = remote.lookupTarget(device.peerId, route);
					const actual = metadata?.node.workspaces.find((entry) => entry.workspaceId === workspace.workspaceId);
					if (metadata === undefined || actual === undefined) { continue; }
					if (remoteTargets.length >= 128) { truncated = true; continue; }
					const target = { profileId: metadata.profileId, profileGeneration: metadata.profileGeneration, workspaceIdentity: actual.workspaceIdentity };
					const allowlisted = this.remotePolicies.sourceAllows(caller, target);
					remoteTargets.push({
						...route, profileId: device.peerId, allowlisted, acceptsIncoming: actual.acceptsIncoming,
						canDelegate: this.remotePolicies.outgoingAllowed(caller, metadata, workspace.workspaceId),
						actionHandle: issue({ action: 'setRemoteAllowed', target, route, sourceScope: this.remotePolicies.sourceScope(caller), revision }),
					});
				}
			}
		}
		return remotePolicyDashboardSchema.parse({ workspaces, remoteTargets, peerStates, truncated });
	}

	public policyAction(caller: NodeIdentityParams, input: RemotePolicyActionParams, session: LocalIpcSession): Promise<void> {
		const binding = this.policyActions.get(session)?.get(input.actionHandle);
		this.policyActions.get(session)?.delete(input.actionHandle);
		if (binding === undefined || binding.action !== input.action) {
			throw new MeshDomainError('POLICY_FORBIDDEN', 'This Workspace policy action is stale or belongs to a different window.');
		}
		const validate = async () => {
			await assertDocumentFence(this.options.fence);
			this.assertCaller(caller, session);
			this.remotePolicies.requireEnabled();
			if (this.remotePolicies.revision() !== binding.revision) {
				throw new MeshDomainError('POLICY_FORBIDDEN', 'Remote policy changed while this action was open. Refresh and try again.');
			}
			if (binding.action !== 'setRemoteAllowed') {
				if (!this.remotePolicies.sources(caller).some((workspace) =>
					workspace.workspaceIdentity === binding.workspaceIdentity && workspace.workspaceId === binding.workspaceId)) {
					throw new MeshDomainError('POLICY_FORBIDDEN', 'The target Workspace claim changed.');
				}
			} else if (this.remotePolicies.sourceScope(caller) !== binding.sourceScope) {
				throw new MeshDomainError('POLICY_FORBIDDEN', 'The source Workspace claims changed.');
			}
		};
		const operation = this.actionQueue.then(async () => {
			await validate();
			if (binding.action === 'setRemoteAutoAccept') {
				if (input.enabled && !await this.confirm(
					`Automatically accept future tasks from ${binding.peerLabel} in Workspace "${binding.workspaceName}"? `
					+ 'This skips only the target task-start prompt. Receive, peer grants and sensitive tool approvals still apply. '
					+ 'Turn this off here to require confirmation for future tasks.',
				)) {
					return;
				}
				await validate();
				await this.remotePolicies.setAutoAccept(caller, binding.workspaceIdentity, binding.peerId, input.enabled, binding.revision);
			} else if (binding.action === 'setRemoteReceive') {
				await this.remotePolicies.setReceive(caller, binding.workspaceIdentity, input.enabled);
			} else {
				if (input.enabled) {
					const remote = this.options.remoteTasks();
					await remote.listDevices(new AbortController().signal);
					const target = remote.lookupTarget(binding.target.profileId, binding.route);
					if (target?.profileGeneration !== binding.target.profileGeneration
						|| !target.node.workspaces.some((entry) => entry.workspaceIdentity === binding.target.workspaceIdentity && entry.workspaceId === binding.route.workspaceId)) {
						throw new MeshDomainError('PEER_OFFLINE', 'The exact remote target changed.');
					}
				}
				await validate();
				await this.remotePolicies.setAllowedForWindow(
					caller, binding.sourceScope, binding.target, input.enabled, binding.revision,
				);
			}
			this.options.changed();
		});
		this.actionQueue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	public act(caller: NodeIdentityParams, input: ConnectivityActionParams, session: LocalIpcSession): Promise<void> {
		const binding = input.actionHandle === undefined ? undefined : this.actions.get(session)?.get(input.actionHandle);
		if (input.actionHandle !== undefined) {
			this.actions.get(session)?.delete(input.actionHandle);
			if (binding === undefined) { throw new MeshDomainError('POLICY_FORBIDDEN', 'The connectivity action is stale.'); }
		}
		const operation = this.actionQueue.then(async () => {
			await assertDocumentFence(this.options.fence);
			this.assertCaller(caller, session);
			this.assertReady();
			try {
				switch (input.action) {
					case 'configureConnectivity': await this.configure(caller, session); break;
					case 'refreshRemoteTargets':
						if (!this.remotePolicies.remoteDirectoryAvailable()) { throw new ConnectivityError('DISABLED'); }
						await this.options.remoteTasks().listDevices(new AbortController().signal);
						break;
					case 'refreshDiscovery':
						await this.discovery.refresh();
						await this.publishCurrent();
						break;
					case 'pairDiscoveredPeer':
						if (binding?.kind !== 'candidate') { throw new ConnectivityError('BINDING_CHANGED'); }
						await this.pairCandidate(this.discovery.select(binding.id), caller, session);
						break;
					case 'configureRemotePolicy': await this.configurePolicy(caller, session); break;
					case 'revokeIncomingPeer':
						if (binding?.kind !== 'peer') { throw new ConnectivityError('BINDING_CHANGED'); }
						if (await this.confirm('Revoke this incoming peer? All its connections and handshakes will close. Its tasks receive authoritative cancellation requests; credentials remain denied even if cleanup fails.')) {
							this.assertCaller(caller, session);
							await this.pairing.revokePeer(binding.id);
						}
						break;
					case 'retryConnectivityCleanup':
						await this.pairing.retryRevocationCleanup();
						await this.sdkExposure.retryCleanup();
						break;
				}
				this.error = undefined;
			} catch (error: unknown) {
				const normalized = normalizeConnectivityError(error);
				this.recordError(normalized.code);
				throw new MeshDomainError('POLICY_FORBIDDEN', normalized.message);
			} finally { this.options.changed(); }
		});
		this.actionQueue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	public exposureChanged(): void {
		if (this.ready && this.currentSettings().publishEnabled && this.exposure.getStatus().state === 'ready') {
			void this.publishCurrent().catch((error: unknown) => this.recordError(normalizeConnectivityError(error).code));
		}
	}

	public async dispose(): Promise<void> {
		this.beginShutdown();
		for (const subscription of this.subscriptions.splice(0)) { subscription.dispose(); }
		this.management.invalidate();
		await this.discovery.dispose();
		await this.publishing?.catch((error: unknown) => {
			const normalized = normalizeConnectivityError(error);
			if (normalized.code !== 'CANCELLED') { this.options.report(normalized.code); }
		});
		await this.management.dispose();
		this.account.dispose();
	}

	private async configure(caller: NodeIdentityParams, session: LocalIpcSession): Promise<void> {
		const items = [
			{ label: this.flag('crossDeviceDiscovery') ? 'Disable account discovery' : 'Enable account discovery', id: 'discovery' },
			{ label: 'Authorize GitHub discovery account', id: 'github' },
			{ label: 'Authorize Microsoft discovery account (Entra or MSA gate required)', id: 'microsoft' },
			{ label: 'Clear discovery account (does not revoke Mesh peers)', id: 'clear' },
			{ label: this.currentSettings().publishEnabled ? 'Disable Mesh advertisement updates' : 'Allow publishing this Mesh endpoint', id: 'publish' },
			{ label: this.flag('crossDeviceDelegation') ? 'Disable new cross-device tasks (keep strict policy)' : 'Activate strict cross-device delegation', id: 'strict' },
			{ label: 'Switch to SDK private hosting and start', id: 'sdk' },
			{ label: 'Explicitly switch or fall back to CLI legacy hosting and start', id: 'cli' },
			{ label: 'Retry selected host after a failed migration', id: 'retry' },
			{ label: 'Delete the exact owned SDK resource', id: 'deleteSdk' },
			{ label: 'Delete the exact owned CLI resource', id: 'deleteCli' },
			{ label: 'Select an incoming peer to revoke (including peers outside the bounded view)', id: 'revokePeer' },
			{ label: 'Probe a bound connection (100 pings, no model, no resource creation)', id: 'probe' },
		];
		const picked = await this.options.vscodeApi.window.showQuickPick(items, { title: 'Mesh cross-device configuration (Broker owner)' });
		if (picked === undefined) { return; }
		this.assertCaller(caller, session);
		switch (picked.id) {
			case 'revokePeer': {
				const peer = await this.options.vscodeApi.window.showQuickPick(
					(await this.incomingPeers()).filter((entry) => entry.state !== 'revoked' || entry.cleanupPending)
						.map((entry) => ({ label: `Peer ${entry.peerId.slice(0, 8)} (${entry.state})`, peerId: entry.peerId })),
					{ title: 'Select the exact incoming peer; this is not a name-based resource deletion' },
				);
				if (peer !== undefined && await this.confirm('Persistently revoke this peer, close its connections and request cancellation of its target tasks?')) {
					this.assertCaller(caller, session);
					await this.pairing.revokePeer(peer.peerId);
				}
				break;
			}
			case 'probe': {
				const peer = await this.options.vscodeApi.window.showQuickPick(
					this.peers.listConnections().filter((connection) =>
						connection.snapshot().state === 'online' && this.endpoints.get(connection.profileId) !== undefined)
						.map((connection) => ({ label: `Peer ${connection.profileId.slice(0, 8)}`, connection })),
					{ title: 'Select an already authenticated bound connection' },
				);
				if (peer === undefined || !await this.confirm('Send at most 100 Mesh pings, 1 MiB application traffic and 60 seconds to this bound peer? Timeout closes this exact connection. This does not run an Agent or prove physical-device or Chat UI acceptance.')) { return; }
				const result = await probeConnectedPeer(peer.connection, async () => {
					this.assertCaller(caller, session);
					await assertDocumentFence(this.options.fence);
				});
				await this.options.vscodeApi.window.showInformationMessage(
					`Mesh protocol v2: ${result.replies} ping replies, at most ${result.applicationBytesUpperBound} application bytes in ${result.durationMs} ms. Physical topology, Agent execution and Chat UI remain separately unverified.`,
				);
				break;
			}
			case 'discovery':
				if (this.flag('crossDeviceDiscovery') && !await this.confirm('Stop future account queries and advertisement updates? Existing service-side advertisements remain until the exact resource is deleted. This does not revoke Mesh peers.')) { return; }
				await this.setFlag('crossDeviceDiscovery', !this.flag('crossDeviceDiscovery')); break;
			case 'github':
			case 'microsoft': {
				if (!this.flag('crossDeviceDiscovery')) { throw new ConnectivityError('DISABLED'); }
				const accounts = await this.options.vscodeApi.authentication.getAccounts(picked.id);
				const selected = await this.options.vscodeApi.window.showQuickPick([
					...accounts.map((account) => ({ label: account.label, account })),
					{ label: 'Sign in with a different account', account: undefined },
				], { title: 'Select the exact Dev Tunnels account (native authentication only)' });
				if (selected === undefined) { return; }
				this.assertCaller(caller, session);
				const binding = await this.account.select(picked.id, selected.account);
				this.assertCaller(caller, session);
				await this.settings.update((value) => ({ ...value, account: binding }));
				this.account.setBinding(binding);
				await this.discovery.refresh();
				break;
			}
			case 'clear':
				if (!await this.confirm('Clear the discovery account and stop private hosting? Pairing, task history and existing service advertisements are not deleted. Delete the exact owned resource first if it should disappear from discovery.')) { return; }
				this.assertCaller(caller, session);
				if (this.currentSettings().hostingBackend === 'sdk') { await this.requireListener().stop(); }
				await this.settings.update((value) => ({ ...value, account: undefined, publishEnabled: false }));
				this.account.setBinding(undefined);
				break;
			case 'publish':
				if (!this.flag('crossDeviceDiscovery') || this.account.current() === undefined) { throw new ConnectivityError('AUTH_REQUIRED'); }
				if (this.currentSettings().publishEnabled
					&& !await this.confirm('Stop future advertisement updates? This does not remove existing discovery markers. Stop and delete the exact owned resource to withdraw that candidate.')) { return; }
				if (!this.currentSettings().publishEnabled
					&& !await this.confirm('Publish only opaque Mesh/protocol markers on this exact owned tunnel? No Workspace, path, task, invitation, or credential is published. CLI hosting has a separate login.')) { return; }
				this.assertCaller(caller, session);
				await this.settings.update((value) => ({
					...value, publishEnabled: !value.publishEnabled, advertisementId: value.advertisementId ?? randomUUID(),
				}));
				await this.publishCurrent();
				break;
			case 'strict':
				if (!this.flag('crossDeviceDelegation')) {
					if (!await this.confirm('Activate strict remote policy for all paired devices? Existing peers get no automatic Workspace grants. Disabling this feature later will not restore legacy authorization. Remote tasks still require target confirmation and its existing editor Host.')) { return; }
					this.assertCaller(caller, session);
					this.strictActivated = true;
					await this.settings.update((value) => ({ ...value, strictPolicyActivated: true }));
				}
				await this.setFlag('crossDeviceDelegation', !this.flag('crossDeviceDelegation'));
				break;
			case 'cli':
			case 'sdk': await this.migrate(picked.id, caller, session); break;
			case 'retry': await this.migrate(this.currentSettings().hostingBackend, caller, session); break;
			case 'deleteSdk':
				if (await this.confirm('Stop hosting and delete only the exact SDK tunnel recorded by Mesh? Bound peers must explicitly rebind after a replacement is created.')) {
					this.assertCaller(caller, session);
					await this.requireListener().stop();
					await this.sdkExposure.deleteOwnedResource();
				}
				break;
			case 'deleteCli':
				if (await this.confirm('Stop hosting and delete only the exact CLI tunnel recorded by Mesh? This withdraws its advertisement. Drain or cancel its tasks first.')) {
					this.assertCaller(caller, session);
					await this.requireListener().stop();
					await this.options.cli.deleteOwnedResource();
				}
				break;
		}
	}

	private async pairCandidate(endpoint: DiscoveredEndpoint, caller: NodeIdentityParams, session: LocalIpcSession): Promise<void> {
		const accountRef = this.account.current()?.accountRef;
		const profiles = (await this.options.profiles.list()).filter((profile) => !profile.cleanupPending && profile.peerId !== undefined);
		const picked = await this.options.vscodeApi.window.showQuickPick([
			{ label: 'Import a one-time invitation (new pairing)', id: '' },
			...profiles.map((profile) => ({ label: `Rebind paired device ${profile.workerDeviceId.slice(0, 8)}`, id: profile.id })),
		], { title: 'Bind this candidate only after Mesh identity proof' });
		if (picked === undefined) { return; }
		let profileId: string | undefined;
		try {
			if (picked.id === '') {
				const invitation = await this.options.vscodeApi.window.showInputBox({
					title: 'Import the target device one-time invitation', password: true, ignoreFocusOut: true,
					prompt: 'The invitation stays in the native Extension Host, never the Dashboard or discovery directory.',
				});
				if (invitation === undefined) { return; }
				this.assertCaller(caller, session);
				if (this.account.current()?.accountRef !== accountRef) { throw new ConnectivityError('ACCOUNT_CHANGED'); }
				const parsed = parseConnectionUrl(invitation);
				if (parsed.workerDeviceId === this.options.deviceId) { throw new ConnectivityError('POLICY_DENIED'); }
				if (new URL(parsed.rpcEndpoint).origin.replace(/^wss:/u, 'https:') !== endpoint.origin) {
					throw new ConnectivityError('BINDING_CHANGED');
				}
				const connection = await this.peers.add(invitation, async (profile) => {
					profileId = profile.id;
					await this.transport.prepare(profile, endpoint);
				});
				profileId = connection.profileId;
			} else {
				const existing = await this.options.profiles.get(picked.id);
				if (existing === undefined || existing.peerId === undefined || existing.cleanupPending) { throw new ConnectivityError('BINDING_CHANGED'); }
				if (existing.workerDeviceId === this.options.deviceId) { throw new ConnectivityError('POLICY_DENIED'); }
				if (this.endpoints.get(existing.id)?.admission === 'private-port-token'
					&& endpoint.admission === 'legacy-mesh-auth'
					&& !await this.confirm('Explicitly rebind from private port admission to legacy outer admission? The Mesh peer must still prove its original identity and all strict Workspace policy remains in force.')) { return; }
				this.assertCaller(caller, session);
				if (this.account.current()?.accountRef !== accountRef) { throw new ConnectivityError('ACCOUNT_CHANGED'); }
				await this.peers.disconnect(existing.id);
				let profile = existing;
				if (existing.generation === undefined) {
					profile = { ...existing, generation: randomUUID() };
					if (!await this.options.profiles.replace?.(profile, existing)) { throw new ConnectivityError('BINDING_CHANGED'); }
				}
				profileId = profile.id;
				await this.transport.prepare(profile, endpoint);
				await this.peers.connect(profile.id);
			}
			this.assertCaller(caller, session);
			await this.options.remoteTasks().listDevices(new AbortController().signal);
		} finally {
			if (profileId !== undefined && await this.options.profiles.get(profileId) === undefined) {
				this.transport.forget(profileId);
			}
		}
	}

	private async configurePolicy(caller: NodeIdentityParams, session: LocalIpcSession): Promise<void> {
		this.remotePolicies.requireEnabled();
		const workspaces = this.remotePolicies.sources(caller);
		const picked = await this.options.vscodeApi.window.showQuickPick(workspaces.map((workspace) => ({
			label: workspace.name, workspaceIdentity: workspace.workspaceIdentity,
		})), { title: 'Select this caller window workspace policy' });
		if (picked === undefined) { return; }
		const identity = picked.workspaceIdentity;
		const action = await this.options.vscodeApi.window.showQuickPick([
			{ label: this.options.localPolicies.acceptsIncoming(identity) ? 'Disable Accept Incoming Tasks' : 'Enable Accept Incoming Tasks', id: 'receive' },
			{ label: 'Authorize or revoke incoming paired devices for this Workspace', id: 'incoming' },
			{ label: 'Allow an authenticated remote Workspace from this source', id: 'outgoing' },
			{ label: 'Remove a saved outgoing authorization (including offline peers)', id: 'remove' },
		], { title: 'Remote grants are directional; receive is shared with local policy' });
		if (action === undefined) { return; }
		this.assertCaller(caller, session);
		if (action.id === 'receive') {
			await this.remotePolicies.setReceive(caller, identity, !this.options.localPolicies.acceptsIncoming(identity));
		} else if (action.id === 'incoming') {
			const policy = this.remotePolicies.policy(identity);
			const candidates = (await this.options.records.listPeers()).filter((peer) =>
				!this.revocations.snapshot().some((entry) => entry.peerId === peer.peerId));
			const peer = await this.options.vscodeApi.window.showQuickPick(candidates.map((value) => ({
				label: `${policy.incomingPeerIds.includes(value.peerId) ? 'Revoke' : 'Grant'} device ${value.coordinatorDeviceId.slice(0, 8)} (peer ${value.peerId.slice(0, 8)})`,
				peerId: value.peerId,
			})), { title: 'B authorizes a paired device, not A individual windows' });
			if (peer !== undefined) {
				this.assertCaller(caller, session);
				await this.remotePolicies.setIncomingGrant(caller, identity, peer.peerId, !policy.incomingPeerIds.includes(peer.peerId));
			}
		} else if (action.id === 'remove') {
			const saved = await this.options.vscodeApi.window.showQuickPick(this.remotePolicies.policy(identity).allowlist.map((target) => ({
				label: `Remove peer ${target.profileId.slice(0, 8)} / workspace ${target.workspaceIdentity.slice(7, 15)}`, target,
			})), { title: 'Remove this source authorization only; accepted tasks keep their ownership' });
			if (saved !== undefined) {
				this.assertCaller(caller, session);
				await this.remotePolicies.setAllowed(caller, identity, saved.target, false);
			}
		} else {
			const remote = this.options.remoteTasks();
			const directory = await remote.listDevices(new AbortController().signal);
			const candidates = directory.devices.flatMap((device) => device.peerId === undefined ? [] : device.nodes.flatMap((node) =>
				node.workspaces.map((workspace) => ({
					label: `${device.deviceName} / ${node.label} / ${workspace.name}`,
					target: { deviceId: device.deviceId, nodeId: node.nodeId, nodeInstanceId: node.nodeInstanceId, workspaceId: workspace.workspaceId },
					profileId: device.peerId!,
				}))));
			const target = await this.options.vscodeApi.window.showQuickPick(candidates, { title: 'B must first grant this device and enable receive' });
			if (target !== undefined) {
				this.assertCaller(caller, session);
				const metadata = remote.lookupTarget(target.profileId, target.target);
				const workspace = metadata?.node.workspaces.find((value) => value.workspaceId === target.target.workspaceId);
				if (metadata === undefined || workspace === undefined) { throw new ConnectivityError('BINDING_CHANGED'); }
				await this.remotePolicies.setAllowed(caller, identity, {
					profileId: metadata.profileId, profileGeneration: metadata.profileGeneration, workspaceIdentity: workspace.workspaceIdentity,
				}, true);
			}
		}
	}

	private async migrate(backend: 'cli' | 'sdk', caller: NodeIdentityParams, session: LocalIpcSession): Promise<void> {
		if ((await this.options.tasks.list()).some((task) => (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.state))) {
			throw new ConnectivityError('MIGRATION_REQUIRED');
		}
		if (backend === 'sdk' && (!this.flag('crossDeviceDiscovery') || !this.currentSettings().publishEnabled || this.account.current() === undefined)) {
			throw new ConnectivityError('AUTH_REQUIRED');
		}
		if (!await this.confirm(backend === 'sdk'
			? 'Stop the old host and create/start one private SDK tunnel with one port? Existing resources are retained. Peers must explicitly rebind to the new locator. Private failures never fall back automatically.'
			: 'Explicitly use CLI legacy hosting? The outer port allows anonymous access; Mesh authentication and activated strict Workspace policy remain mandatory. Private peers require explicit locator rebinding.')) { return; }
		const previous = this.currentSettings().hostingBackend;
		const oldResource = previous === backend ? 'Retain' : await this.options.vscodeApi.window.showQuickPick(
			['Retain', 'Delete exact owned resource'], { title: 'After the old host stops, retain or delete its resource?' });
		if (oldResource === undefined) { return; }
		this.assertCaller(caller, session);
		await this.settings.update((value) => ({ ...value, migrationPending: true }));
		if ((await this.options.tasks.list()).some((task) => (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.state))) {
			throw new ConnectivityError('MIGRATION_REQUIRED');
		}
		await this.requireListener().stop();
		this.assertCaller(caller, session);
		if (oldResource !== 'Retain') {
			if (previous === 'sdk') { await this.sdkExposure.deleteOwnedResource(); }
			else { await this.options.cli.deleteOwnedResource(); }
		}
		if (backend === 'sdk') { await this.setFlag('devTunnelSdkHosting', true); }
		await this.settings.update((value) => ({ ...value, hostingBackend: backend, migrationPending: false }));
		try { await this.requireListener().start(); }
		catch (error: unknown) {
			await this.settings.update((value) => ({ ...value, migrationPending: true }));
			throw error;
		}
		await this.publishCurrent();
	}

	private publishCurrent(): Promise<void> {
		if (this.publishing !== undefined) { return this.publishing; }
		const operation = this.publishCore().finally(() => {
			if (this.publishing === operation) { this.publishing = undefined; }
		});
		this.publishing = operation;
		return operation;
	}
	private async publishCore(): Promise<void> {
		const settings = this.currentSettings();
		const status = this.exposure.getStatus();
		if (!this.ready || !settings.publishEnabled || !this.flag('crossDeviceDiscovery')
			|| status.state !== 'ready' || settings.advertisementId === undefined) { return; }
		const key = `${JSON.stringify(status.tunnel.resource)}:${settings.advertisementId}:${settings.account?.accountRef}`;
		if (key === this.publishedKey) { return; }
		if (status.tunnel.provider === 'cli') {
			await this.publisher.publish(status.tunnel.resource, status.tunnel.localPort,
				status.tunnel.ownershipLabel, settings.advertisementId, new AbortController().signal,
				async (advertisementId) => {
					await this.settings.update((value) => ({ ...value, advertisementId }));
				});
		}
		this.publishedKey = `${JSON.stringify(status.tunnel.resource)}:${this.currentSettings().advertisementId}:${this.currentSettings().account?.accountRef}`;
	}
	private async configurationChanged(): Promise<void> {
		if (this.strictActivated && !this.currentSettings().strictPolicyActivated) {
			await this.settings.update((value) => ({ ...value, strictPolicyActivated: true }));
		}
		if (this.currentSettings().hostingBackend === 'sdk'
			&& (!this.flag('crossDeviceDiscovery') || !this.flag('devTunnelSdkHosting'))) {
			await this.requireListener().stop();
		}
		if (this.flag('crossDeviceDiscovery') && this.currentSettings().account !== undefined) {
			await this.discovery.refresh();
		}
		this.options.changed();
	}
	private currentSettings(): ConnectivitySettings {
		return this.settingsLoaded ? this.settings.snapshot() : EMPTY_CONNECTIVITY_SETTINGS;
	}
	private async incomingPeers() {
		return incomingPeerCatalog(
			await this.options.records.listPeers(), await this.options.records.listPending(), this.revocations.snapshot(),
		);
	}
	private flag(name: 'crossDeviceDiscovery' | 'crossDeviceDelegation' | 'devTunnelSdkHosting'): boolean {
		return this.options.vscodeApi.workspace.getConfiguration('copilotAgentMesh').get<boolean>(`experimental.${name}`, false);
	}
	private async setFlag(name: string, enabled: boolean): Promise<void> {
		await this.options.vscodeApi.workspace.getConfiguration('copilotAgentMesh')
			.update(`experimental.${name}`, enabled, this.options.vscodeApi.ConfigurationTarget.Global);
	}
	private confirm(message: string): Promise<boolean> {
		return Promise.resolve(this.options.vscodeApi.window.showWarningMessage(message, { modal: true }, 'Continue')).then((answer) => answer === 'Continue');
	}
	private assertCaller(caller: NodeIdentityParams, session: LocalIpcSession): void {
		if (this.disposed || session.closed || !this.options.registry.peerNode(caller)?.online) {
			throw new MeshDomainError('AUTH_FAILED', 'The authenticated connectivity action window is no longer available.');
		}
	}
	private assertReady(): void {
		if (!this.ready || this.disposed) { throw new ConnectivityError('DISCOVERY_UNAVAILABLE'); }
	}
	private requireListener(): ListenerService {
		const listener = this.options.listener();
		if (listener === undefined) { throw new ConnectivityError('OFFLINE'); }
		return listener;
	}
	private recordError(code: ConnectivityCode): void {
		this.error = code; this.options.report(code); this.options.changed();
	}
	private blockRemote(): void {
		this.ready = false; this.management.invalidate(); this.discovery.invalidate();
		this.recordError('DISCOVERY_UNAVAILABLE');
	}
}
