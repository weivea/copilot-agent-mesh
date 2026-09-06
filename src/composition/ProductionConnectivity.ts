import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import { isAxiosError } from 'axios';

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
import { AccountDeviceIdentityStore } from '../connectivity/AccountDeviceIdentity';
import { AccountPeerEnrollment } from '../connectivity/AccountPeerEnrollment';
import { BoundPeerTransport } from '../connectivity/BoundPeerTransport';
import type { BrokerConnectivity } from '../connectivity/BrokerConnectivity';
import {
	ConnectivityError, EMPTY_CONNECTIVITY_SETTINGS, connectivitySettingsSchema,
	tunnelResourceSchema, type AccountBinding, type ConnectivityCode, type ConnectivitySettings,
} from '../connectivity/ConnectivitySchemas';
import { DevTunnelDiscoveryProvider } from '../connectivity/DevTunnelDiscoveryProvider';
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
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import type { PeerProfileStore } from '../peer/PeerProfile';
import type { AtomicFileStore } from '../storage/AtomicFileStore';
import { assertDocumentFence, FencedDocumentStore, type DocumentFence } from '../storage/FencedDocumentStore';
import type { FileTaskStore } from '../tasks/FileTaskStore';
import { SdkDevTunnelExposureProvider } from '../tunnel/SdkDevTunnelExposureProvider';
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
	public readonly exposure: SdkDevTunnelExposureProvider;
	public readonly identity: AccountDeviceIdentityStore;
	public readonly enrollment: AccountPeerEnrollment;
	private ready = false;
	private settingsLoaded = false;
	private disposed = false;
	private error: ConnectivityCode | undefined;
	private connectionState: ConnectivitySnapshot['connectionState'] = 'disabled';
	private stopRequested = false;
	private stopEpoch = 0;
	private starting = false;
	private accountReaction: Promise<void> = Promise.resolve();
	private recoveryTimer: NodeJS.Timeout | undefined;
	private recoveryAttempts = 0;
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
		this.identity = new AccountDeviceIdentityStore(files, fence, options.secrets, options.deviceId);
		this.management = new DevTunnelManagement(this.account, fence, () =>
			this.ready && this.account.current() !== undefined);
		this.discovery = new DiscoveryService(new DevTunnelDiscoveryProvider(this.management), fence,
			() => this.connectionsEnabled() && this.connectionState === 'online',
			() => this.account.current() !== undefined, options.changed);
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
					if (!this.enrollment.permitsIncoming(peerId)) {
						throw new MeshDomainError('AUTH_FAILED', 'Enable same-account connections before authenticating this device.');
					}
				},
				revoke: (peerId) => this.revocations.revoke(peerId),
				retryCleanup: () => this.revocations.retryCleanup(),
			},
		});
		this.remotePolicies = new RemotePeerPolicyService(
			this.remotePolicyStore, options.registry, options.localPolicies, this.endpoints, options.profiles,
			{
				strict: () => this.strict(),
				enabled: () => this.connectionsEnabled(),
				ready: () => this.ready,
				draining: () => this.stopRequested || this.currentSettings().cleanupPending,
				assertPeerAllowed: (id) => this.revocations.assertAllowed(id),
				assertPeerActive: (id) => this.pairing.assertActivePeer(id),
			},
		);
		this.transport = new BoundPeerTransport(this.endpoints, new DevTunnelEndpointResolver(this.management),
			this.account, fence, () => this.connectionsEnabled(), {}, (profile) => this.enrollment.permitsOutgoing(profile.id));
		this.peers = new PeerConnectionManager(options.deviceId, options.profiles, options.secrets,
			this.transport, {
				ownership: fence.ownership,
				onProfileRemoved: async (profile) => {
					const incoming = this.enrollment.incomingForProfile(profile.id);
					if (incoming !== undefined) { await this.revokeDevice(incoming); }
					if (this.ready && profile.generation !== undefined) { await this.endpoints.remove(profile.id, profile.generation); }
				},
			});
		this.enrollment = new AccountPeerEnrollment(
			files, fence, options.deviceId, this.account, this.identity, this.pairing, options.records,
			options.profiles, options.secrets, this.endpoints, this.transport, this.peers, {
				enabled: () => this.connectionsEnabled(),
				isRevoked: (peerId) => this.revocations.snapshot().some((entry) => entry.peerId === peerId),
				report: (code) => this.recordError(code),
			},
		);
		this.sdkExposure = new SdkDevTunnelExposureProvider(files, fence, this.management, this.account, {
			enabled: () => this.connectionsEnabled(),
			advertisementId: () => this.currentSettings().advertisementId,
			identity: () => this.identity.current(this.account.current()?.accountRef),
		});
		this.exposure = this.sdkExposure;
	}

	public isReady(): boolean { return this.ready; }
	public strict(): boolean { return true; }
	public connectionsEnabled(): boolean {
		return this.ready && this.currentSettings().enabled && !this.stopRequested && !this.disposed;
	}
	public beginShutdown(): void {
		this.disposed = true;
		this.ready = false;
		this.stopRequested = true;
		this.stopEpoch += 1;
		this.clearRecovery();
		this.management.invalidate();
		this.discovery.invalidate();
		this.sdkExposure.cancel();
	}

	public async initialize(): Promise<void> {
		try {
			await this.settings.initialize();
			this.settingsLoaded = true;
			const savedAccount = this.currentSettings().account;
			if (savedAccount !== undefined && !this.currentSettings().accounts.some((account) =>
				account.providerId === savedAccount.providerId && account.accountId === savedAccount.accountId)) {
				await this.settings.update((value) => ({ ...value, accounts: [...value.accounts, savedAccount] }));
			}
			if (!this.currentSettings().strictPolicyActivated) {
				await this.settings.update((value) => ({ ...value, strictPolicyActivated: true }));
			}
			await Promise.all([
				this.endpoints.initialize(), this.remotePolicyStore.initialize(),
				this.revocations.initialize(), this.sdkExposure.initialize(),
				this.identity.initialize(), this.enrollment.initialize(),
			]);
			this.account.initialize();
			this.account.setBinding(this.currentSettings().account);
			this.ready = true;
			this.subscriptions = [
				this.account.onDidChange(() => {
					this.discovery.invalidate();
					if (!this.starting && this.connectionsEnabled()) {
						this.accountReaction = this.actionQueue.then(() => this.refreshAccount())
							.catch((error: unknown) => this.recordError(normalizeConnectivityError(error).code));
						this.actionQueue = this.accountReaction;
					}
				}),
				this.discovery.onDidRefresh(() => {
					void this.enrollment.synchronize(this.discovery.endpoints())
						.then(() => this.refreshConnectedDirectory())
						.catch((error: unknown) => this.recordError(normalizeConnectivityError(error).code));
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
		} catch {
			this.blockRemote();
		}
		this.options.changed();
	}

	public async snapshot(caller: NodeIdentityParams, session: LocalIpcSession): Promise<ConnectivitySnapshot> {
		this.assertCaller(caller, session);
		const settings = this.currentSettings();
		const discovery = this.discovery.snapshot(this.options.deviceId);
		const claimed = this.options.registry.peerNode(caller)?.workspaces.filter((workspace) => workspace.status === 'claimed') ?? [];
		const error = this.error ?? discovery.error;
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
			enabled: settings.enabled,
			connectionState: !this.ready ? 'error' : this.connectionState,
			accountLabel: settings.account?.accountLabel,
			connectedDeviceCount: this.peers.listConnections().filter((connection) => connection.snapshot().state === 'online').length,
			discoveryEnabled: this.connectionsEnabled(), delegationEnabled: this.connectionsEnabled(),
			strictPolicyActivated: true, publishEnabled: this.connectionsEnabled(),
			hostingBackend: 'sdk', migrationPending: settings.cleanupPending,
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
		if (input.action === 'disableConnectivity') {
			this.assertCaller(caller, session);
			this.stopEpoch += 1;
			this.stopRequested = true;
			this.clearRecovery();
			this.sdkExposure.cancel();
			this.discovery.invalidate();
		}
		const stopEpoch = this.stopEpoch;
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
					case 'enableConnectivity': await this.enableConnections(true, () => this.assertCaller(caller, session), false, stopEpoch); break;
					case 'disableConnectivity': await this.disableConnections(); break;
					case 'configureConnectivity': await this.configure(caller, session); break;
					case 'refreshRemoteTargets':
						if (!this.remotePolicies.remoteDirectoryAvailable()) { throw new ConnectivityError('DISABLED'); }
						await this.options.remoteTasks().listDevices(new AbortController().signal);
						break;
					case 'refreshDiscovery':
						await this.discovery.refresh();
						break;
					case 'pairDiscoveredPeer':
						throw new ConnectivityError('POLICY_DENIED');
					case 'configureRemotePolicy': await this.configurePolicy(caller, session); break;
					case 'revokeIncomingPeer':
						if (binding?.kind !== 'peer') { throw new ConnectivityError('BINDING_CHANGED'); }
						if (await this.confirm('Revoke this incoming peer? All its connections and handshakes will close. Its tasks receive authoritative cancellation requests; credentials remain denied even if cleanup fails.')) {
							this.assertCaller(caller, session);
							await this.revokeDevice(binding.id);
						}
						break;
					case 'retryConnectivityCleanup':
						await this.pairing.retryRevocationCleanup();
						if (this.currentSettings().cleanupPending || !this.currentSettings().enabled) {
							if (this.currentSettings().cleanupPending) {
								await this.ensureAccount(true, async () => {
									this.assertCaller(caller, session);
									await assertDocumentFence(this.options.fence);
									if (stopEpoch !== this.stopEpoch) { throw new ConnectivityError('CANCELLED'); }
								}, this.error !== undefined && isAuthenticationError(this.error));
							}
							await this.disableConnections();
						} else {
							await this.enableConnections(true, () => this.assertCaller(caller, session), false, stopEpoch);
						}
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
		if (this.connectionsEnabled() && this.connectionState === 'online' && this.exposure.getStatus().state !== 'ready') {
			this.connectionState = 'error';
			this.recordError('OFFLINE');
			this.scheduleRecovery();
		}
	}

	public async dispose(): Promise<void> {
		this.beginShutdown();
		for (const subscription of this.subscriptions.splice(0)) { subscription.dispose(); }
		this.management.invalidate();
		await this.discovery.dispose();
		await this.enrollment.suspend();
		await this.accountReaction;
		await this.management.dispose();
		this.account.dispose();
	}

	private async configure(caller: NodeIdentityParams, session: LocalIpcSession): Promise<void> {
		const stopEpoch = this.stopEpoch;
		const items = [
			{ label: 'Switch account and enable cross-device connections', id: 'account' },
			{ label: 'Manage this Workspace remote permissions', id: 'workspace' },
			{ label: 'Revoke a trusted device', id: 'revokePeer' },
			{ label: 'Connection diagnostics (100 pings, no Agent task)', id: 'probe' },
		];
		const picked = await this.options.vscodeApi.window.showQuickPick(items, { title: 'Cross-device connections' });
		if (picked === undefined) { return; }
		this.assertCaller(caller, session);
		switch (picked.id) {
			case 'account':
				if (this.currentSettings().enabled && !await this.confirm(
					'Switch the cross-device account? Current connections will close and this device\'s Tunnel will be deleted. Workspace permissions are not transferred to a different account.',
				)) { return; }
				if (stopEpoch !== this.stopEpoch) { throw new ConnectivityError('CANCELLED'); }
				if (this.currentSettings().cleanupPending) {
					await this.ensureAccount(true, async () => {
						this.assertCaller(caller, session);
						if (stopEpoch !== this.stopEpoch) { throw new ConnectivityError('CANCELLED'); }
					}, true);
				}
				await this.disableConnections();
				await this.enableConnections(true, () => this.assertCaller(caller, session), true, stopEpoch);
				break;
			case 'workspace': await this.configurePolicy(caller, session); break;
			case 'revokePeer': {
				const peer = await this.options.vscodeApi.window.showQuickPick(
					(await this.incomingPeers()).filter((entry) => entry.state !== 'revoked' || entry.cleanupPending)
						.map((entry) => ({ label: `Peer ${entry.peerId.slice(0, 8)} (${entry.state})`, peerId: entry.peerId })),
					{ title: 'Select the exact incoming peer; this is not a name-based resource deletion' },
				);
				if (peer !== undefined && await this.confirm('Persistently revoke this peer, close its connections and request cancellation of its target tasks?')) {
					this.assertCaller(caller, session);
					await this.revokeDevice(peer.peerId);
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

	public async restore(): Promise<void> {
		if (!this.ready) { return; }
		const stopEpoch = this.stopEpoch;
		const operation = this.actionQueue.then(async () => {
			if (this.currentSettings().enabled) {
				await this.enableConnections(false, () => this.assertReady(), false, stopEpoch);
			} else if (this.currentSettings().cleanupPending) {
				await this.disableConnections();
			}
		});
		this.actionQueue = operation.catch((error: unknown) => {
			this.recordError(normalizeConnectivityError(error).code);
		});
		await this.actionQueue;
	}

	private async enableConnections(
		interactive: boolean, validateCaller: () => void, chooseAccount = false, stopEpoch = this.stopEpoch,
	): Promise<void> {
		if (stopEpoch !== this.stopEpoch) { throw new ConnectivityError('CANCELLED'); }
		if (this.connectionsEnabled() && this.connectionState === 'online' && !chooseAccount) { return; }
		this.assertReady();
		this.stopRequested = false;
		this.clearRecovery();
		if (interactive) { this.recoveryAttempts = 0; }
		const selectAccount = chooseAccount || (this.currentSettings().cleanupPending
			&& this.error !== undefined && isAuthenticationError(this.error));
		this.starting = true;
		this.connectionState = 'authenticating';
		this.error = undefined;
		this.options.changed();
		const validate = async (): Promise<void> => {
			await assertDocumentFence(this.options.fence);
			this.assertReady();
			validateCaller();
			if (this.stopRequested || stopEpoch !== this.stopEpoch) { throw new ConnectivityError('CANCELLED'); }
		};
		let hostAttempted = false;
		let accountReady = false;
		try {
			await this.ensureAccount(interactive, validate, selectAccount);
			await validate();
			const account = this.account.current();
			if (account === undefined) { throw new ConnectivityError('AUTH_REQUIRED'); }
			await this.identity.load(account);
			await validate();
			accountReady = true;
			await this.settings.update((value) => ({ ...value, enabled: true, cleanupPending: true }));
			await this.cleanupConnectionResources();
			await validate();
			await this.settings.update((value) => ({
				...value, enabled: true, cleanupPending: false, hostingBackend: 'sdk',
				strictPolicyActivated: true, migrationPending: false, publishEnabled: true,
				advertisementId: randomUUID(),
			}));
			this.connectionState = 'starting';
			this.options.changed();
			hostAttempted = true;
			await this.requireListener().start();
			await validate();
			this.connectionState = 'online';
			this.recoveryAttempts = 0;
			this.options.changed();
			void this.discovery.refresh().catch((error: unknown) => this.recordError(normalizeConnectivityError(error).code));
		} catch (error: unknown) {
			const normalized = normalizeConnectivityError(error);
			if (hostAttempted) {
				await this.settings.update((value) => ({ ...value, cleanupPending: true }));
				try {
					await this.cleanupConnectionResources();
					await this.settings.update((value) => ({ ...value, cleanupPending: false }));
				} catch (cleanupError: unknown) {
					this.options.report(normalizeConnectivityError(cleanupError).code);
				}
			}
			this.connectionState = this.currentSettings().cleanupPending ? 'cleanupPending'
				: isAuthenticationError(normalized.code) ? 'authRequired'
				: normalized.code === 'CANCELLED' && !accountReady
					? this.currentSettings().enabled ? 'authRequired' : 'disabled' : 'error';
			if (normalized.code !== 'CANCELLED') { this.recordError(normalized.code); }
			if (!isAuthenticationError(normalized.code) && !['BINDING_CHANGED', 'CLEANUP_FAILED'].includes(normalized.code)
				&& (normalized.code !== 'CANCELLED' || accountReady)) {
				this.scheduleRecovery();
			}
			throw normalized;
		} finally {
			this.starting = false;
			this.options.changed();
		}
	}

	private async disableConnections(): Promise<void> {
		this.stopRequested = true;
		this.clearRecovery();
		this.connectionState = 'stopping';
		this.discovery.invalidate();
		this.sdkExposure.cancel();
		await this.settings.update((value) => ({
			...value, enabled: false, publishEnabled: false, cleanupPending: true,
		}));
		this.options.changed();
		try {
			await this.cleanupConnectionResources();
			await this.settings.update((value) => ({ ...value, cleanupPending: false, migrationPending: false }));
			this.connectionState = 'disabled';
			this.error = undefined;
		} catch (error: unknown) {
			this.connectionState = 'cleanupPending';
			const normalized = normalizeConnectivityError(error);
			this.recordError(normalized.code);
			throw normalized;
		} finally { this.options.changed(); }
	}

	private async cleanupConnectionResources(): Promise<void> {
		const failures: ConnectivityError[] = [];
		for (const action of [
			() => this.enrollment.suspend(),
			() => this.requireListener().stop(),
			() => this.options.cli.stop(),
			() => this.sdkExposure.deleteOwnedResource(),
			() => this.retireLegacyResource(),
		]) {
			try { await action(); }
			catch (error: unknown) { failures.push(normalizeConnectivityError(error)); }
		}
		if (failures.length > 0) {
			throw failures.find((error) => isAuthenticationError(error.code)) ?? new ConnectivityError('CLEANUP_FAILED');
		}
	}

	private async retireLegacyResource(): Promise<void> {
		if (this.currentSettings().legacyResourceRetired) { return; }
		const metadata = await this.options.cli.ownedResourceForMigration();
		if (metadata !== undefined) {
			const compact = this.options.deviceId.replaceAll('-', '');
			const expectedLabel = `copilot-agent-mesh-${compact.slice(0, 31)}`;
			const [tunnelId, clusterId, extra] = metadata.tunnelId.split('.');
			const resource = tunnelResourceSchema.parse({ tunnelId, clusterId });
			if (extra !== undefined || tunnelId !== metadata.tunnelAlias || metadata.ownershipLabel !== expectedLabel
				|| metadata.tunnelAlias !== `cam${compact.slice(0, 18)}`) {
				throw new ConnectivityError('BINDING_CHANGED');
			}
			await this.management.run(async (client, token) => {
				const read = async () => {
					try { return await client.getTunnel(resource, { includePorts: true, followRedirects: false }, token); }
					catch (error: unknown) {
						if (isAxiosError(error) && error.response?.status === 404) { return null; }
						throw error;
					}
				};
				const tunnel = await read();
				if (tunnel === null) { return; }
				const owned = await client.listTunnels(clusterId, undefined, {
					labels: [expectedLabel], requireAllLabels: true, limit: 10, followRedirects: false,
				}, token);
				if (!owned.some((candidate) => candidate.tunnelId === tunnelId && candidate.clusterId === clusterId)
					|| !tunnel.labels?.includes(expectedLabel)
					|| (metadata.provisioned && !tunnel.ports?.some((port) => port.portNumber === metadata.localPort))) {
					throw new ConnectivityError('ACCOUNT_CHANGED');
				}
				const hostCount = tunnel.status?.hostConnectionCount;
				if ((typeof hostCount === 'number' ? hostCount : hostCount?.current) !== 0) {
					throw new ConnectivityError('CLEANUP_FAILED');
				}
				await client.deleteTunnel(resource, { followRedirects: false }, token);
				if (await read() !== null) {
					throw new ConnectivityError('CLEANUP_FAILED');
				}
			});
		}
		await this.settings.update((value) => ({ ...value, legacyResourceRetired: true }));
	}

	private async ensureAccount(
		interactive: boolean, validate: () => Promise<void>, forceSelection = false,
	): Promise<void> {
		if (!forceSelection && this.account.current() !== undefined) {
			try {
				await this.account.authorization(new AbortController().signal);
				return;
			} catch (error: unknown) {
				if (!(error instanceof ConnectivityError) || !isAuthenticationError(error.code) || !interactive) { throw error; }
			}
		}
		if (!interactive) { throw new ConnectivityError('AUTH_REQUIRED'); }
		const providers = ['github', 'microsoft'] as const;
		const accounts = (await Promise.all(providers.map(async (providerId) =>
			(await this.options.vscodeApi.authentication.getAccounts(providerId)).map((account) => ({
				label: account.label, description: providerId === 'github' ? 'GitHub' : 'Microsoft',
				providerId, account,
			}))))).flat();
		await validate();
		let providerId: AccountBinding['providerId'] = 'github';
		let selectedAccount: vscode.AuthenticationSessionAccountInformation | undefined;
		if (accounts.length > 0 || forceSelection) {
			const selected = await this.options.vscodeApi.window.showQuickPick([
				...accounts,
				...providers.map((provider) => ({
					label: `Sign in with ${provider === 'github' ? 'GitHub' : 'Microsoft'}`,
					description: 'Use a different account', providerId: provider,
					account: undefined,
				})),
			], {
				title: 'Enable cross-device connections',
				placeHolder: 'Your devices using this account connect automatically. Workspace task permissions stay separate.',
			});
			if (selected === undefined) { throw new ConnectivityError('CANCELLED'); }
			providerId = selected.providerId;
			selectedAccount = selected.account;
		}
		await validate();
		const selected = await this.account.select(providerId, selectedAccount);
		const previous = this.currentSettings().accounts.find((account) =>
			account.providerId === selected.providerId && account.accountId === selected.accountId);
		const binding = previous === undefined ? selected : { ...selected, accountRef: previous.accountRef };
		await validate();
		const owned = this.sdkExposure.ownedResource();
		if (owned !== undefined && owned.accountRef !== binding.accountRef) {
			throw new ConnectivityError('ACCOUNT_CHANGED');
		}
		await this.settings.update((value) => ({
			...value, account: binding,
			accounts: [...value.accounts.filter((account) => account.accountRef !== binding.accountRef), binding],
		}));
		this.account.setBinding(binding);
	}

	private async revokeDevice(peerId: string): Promise<void> {
		const ids = await this.enrollment.block(peerId);
		const records = await this.options.records.listPeers();
		const pending = await this.options.records.listPending();
		const results = await Promise.allSettled([
			this.enrollment.disconnectDevice(peerId),
			...ids.filter((id) => records.some((record) => record.peerId === id) || pending.some((record) => record.peerId === id))
				.map((id) => this.pairing.revokePeer(id)),
		]);
		if (results.some((result) => result.status === 'rejected')) { throw new ConnectivityError('CLEANUP_FAILED'); }
	}

	private async refreshConnectedDirectory(): Promise<void> {
		if (!this.connectionsEnabled() || this.connectionState !== 'online') { return; }
		await this.options.remoteTasks().listDevices(new AbortController().signal);
		if (this.error === 'OFFLINE') { this.error = undefined; }
		this.options.changed();
	}

	private async refreshAccount(): Promise<void> {
		if (!this.connectionsEnabled()) { return; }
		try {
			await this.account.authorization(new AbortController().signal);
			if (!this.connectionsEnabled()) { return; }
			if (this.sdkExposure.getStatus().state === 'ready') {
				await this.sdkExposure.renew();
				await this.discovery.refresh();
			} else { this.scheduleRecovery(); }
		} catch (error: unknown) {
			if (!this.connectionsEnabled()) { return; }
			const normalized = normalizeConnectivityError(error);
			this.clearRecovery();
			this.connectionState = isAuthenticationError(normalized.code) ? 'authRequired' : 'error';
			await this.enrollment.suspend();
			await this.requireListener().stop();
			this.recordError(normalized.code);
			if (!isAuthenticationError(normalized.code)) { this.scheduleRecovery(); }
		}
	}

	private scheduleRecovery(): void {
		if (!this.connectionsEnabled() || this.recoveryTimer !== undefined || this.recoveryAttempts >= 5) { return; }
		const delay = Math.min(30_000, 2000 * 2 ** this.recoveryAttempts++);
		const stopEpoch = this.stopEpoch;
		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = undefined;
			const operation = this.actionQueue.then(async () => {
				if (stopEpoch === this.stopEpoch && this.connectionsEnabled() && this.connectionState !== 'online') {
					await this.enableConnections(false, () => this.assertReady(), false, stopEpoch);
				}
			});
			this.actionQueue = operation.catch((error: unknown) => this.recordError(normalizeConnectivityError(error).code));
		}, delay);
		this.recoveryTimer.unref();
	}

	private clearRecovery(): void {
		if (this.recoveryTimer !== undefined) { clearTimeout(this.recoveryTimer); }
		this.recoveryTimer = undefined;
	}

	private currentSettings(): ConnectivitySettings {
		return this.settingsLoaded ? this.settings.snapshot() : EMPTY_CONNECTIVITY_SETTINGS;
	}
	private async incomingPeers() {
		return incomingPeerCatalog(
			await this.options.records.listPeers(), await this.options.records.listPending(), this.revocations.snapshot(),
		);
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

function isAuthenticationError(code: ConnectivityCode): boolean {
	return ['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED'].includes(code);
}
