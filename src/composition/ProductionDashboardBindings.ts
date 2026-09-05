import { randomBytes, randomUUID } from 'node:crypto';

import type * as vscode from 'vscode';
import { z } from 'zod';

import {
	ACTIVE_TASK_STATUSES,
	connectivitySnapshotSchema,
	DISABLED_CONNECTIVITY_SNAPSHOT,
	JSON_RPC_ERROR_CODES,
	PROTOCOL_LIMITS,
	utf8String,
	type ConnectivityAction,
	type ConnectivitySnapshot,
	type DashboardTaskDirection,
} from '../../shared/protocol';
import type {
	MeshDeviceToolSummary,
	MeshRemoteDirectorySnapshot,
	MeshWorkerDirectorySnapshot,
} from '../../shared/toolProtocol';
import type { AgentRuntime, AgentRuntimeProbe } from '../agentHost/AgentRuntime';
import type { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import type { WorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import type {
	BrokerLifecycle,
	BrokerLifecycleStatus,
} from '../broker/BrokerLifecycle';
import { resolveWindowDisplayName } from '../broker/WindowName';
import { LocalIpcRemoteError } from '../ipc';
import type { DeviceProfile } from '../storage/DeviceProfileStore';
import type { LocalBrokerTaskFacade } from '../tools/LocalBrokerTaskFacade';
import type {
	DashboardNodeSnapshot,
	DashboardTaskSummarySnapshot,
	DashboardServiceBindings,
	DashboardSnapshot,
	DashboardTaskTarget,
	DashboardWindowRenameSession,
} from '../ui/DashboardFacade';
import {
	DashboardActionError,
	type DashboardActionErrorCode,
} from '../ui/DashboardActionError';
import type { WindowNodeClient } from '../node/WindowNodeClient';
import type { LocalIpcRemoteTaskAdapter } from '../node/LocalIpcRemoteTaskAdapter';
import type { ProductionBrokerRuntime } from './ProductionBrokerRuntime';

const activeTaskStates = new Set<string>(ACTIVE_TASK_STATUSES);

interface RemoteTaskActionBinding {
	readonly taskId: string;
	readonly lifecycleGeneration: string;
}

export interface ProductionDashboardBindingsOptions {
	readonly vscodeApi: typeof vscode;
	readonly changed: vscode.EventEmitter<void>;
	readonly profile: () => DeviceProfile;
	readonly node: WindowNodeClient;
	readonly localTasks: LocalBrokerTaskFacade;
	readonly remoteTasks: LocalIpcRemoteTaskAdapter;
	readonly runtime: () => AgentRuntime;
	readonly guard: LocalDesktopWorkspaceGuard;
	readonly workerPlatform: WorkerPlatformSupport;
	readonly lifecycle: BrokerLifecycle<ProductionBrokerRuntime>;
	readonly ownerRuntime: () => ProductionBrokerRuntime | undefined;
}

export class ProductionDashboardBindings implements DashboardServiceBindings, vscode.Disposable {
	private readonly subscriptions: Array<{ dispose(): void }> = [];
	private readonly acceptActions = new Map<string, {
		readonly workspaceIdentity: string;
		readonly workspaceId: string;
	}>();
	private readonly remoteTaskActions = new Map<string, RemoteTaskActionBinding>();
	private readonly remoteTaskHandlesById = new Map<string, string>();
	private remoteHandleGeneration = 'uninitialized';

	public constructor(private readonly options: ProductionDashboardBindingsOptions) {
		this.subscriptions.push(
			options.node.onDidChange(() => options.changed.fire()),
			options.lifecycle.onDidChange(() => {
				this.refreshRemoteHandleGeneration();
				options.changed.fire();
			}),
		);
		const onDidChangeActiveTextEditor = options.vscodeApi.window.onDidChangeActiveTextEditor;
		if (typeof onDidChangeActiveTextEditor === 'function') {
			this.subscriptions.push(onDidChangeActiveTextEditor(() => options.changed.fire()));
		}
	}

	public readonly onDidChange = (listener: () => void): vscode.Disposable =>
		this.options.changed.event(listener);

	public async getSnapshot(): Promise<DashboardSnapshot> {
		this.acceptActions.clear();
		this.refreshRemoteHandleGeneration();
		this.options.guard.assertAllowed({ requireWorkspace: false });
		const profile = this.options.profile();
		const owner = this.options.ownerRuntime();
		const lifecycle = this.options.lifecycle.snapshot();
		const errors: DashboardSnapshot['errors'][number][] = [];
		let localDirectory: Awaited<ReturnType<WindowNodeClient['listDashboardNodes']>> = {
			deviceId: profile.deviceId,
			nodes: [],
			truncated: false,
			totalNodes: 0,
		};
		try {
			localDirectory = await this.options.node.listDashboardNodes();
		} catch {
			errors.push({
				code: 'LOCAL_BROKER_UNAVAILABLE',
				message: 'The local Window Node directory is reconnecting.',
				action: 'Wait for Broker takeover or refresh the dashboard.',
			});
		}
		if (localDirectory.truncated) {
			errors.push({
				code: 'NODE_DIRECTORY_TRUNCATED',
				message: 'The local Window Node directory was truncated to the transport budget.',
				action: 'Narrow the active Window Nodes or refresh after offline cleanup.',
			});
		}
		const localNodes = localDirectory.nodes.map((node) =>
			toDashboardNode(node, this.options.node.nodeId),
		);
		for (const node of localNodes) {
			if (node.workspaces.some(({ claimStatus }) => claimStatus === 'conflict')) {
				errors.push({
					code: 'WORKSPACE_CLAIM_CONFLICT',
					message: 'A workspace is already claimed by another local Window Node.',
					action: 'Run the task in the claiming window or close the duplicate workspace.',
				});
			}
		}
		const policySelection = this.options.node.selectPeerPolicyWorkspace(
			this.activeWorkspaceUri(),
		);
		const thisWindowBase = await this.thisWindowSnapshot(localNodes, errors, policySelection);

		let connectivity: ConnectivitySnapshot;
		try {
			connectivity = connectivitySnapshotSchema.parse(await this.options.node.connectivitySnapshot());
		} catch {
			connectivity = {
				...DISABLED_CONNECTIVITY_SNAPSHOT,
				state: 'error',
				error: 'DISCOVERY_UNAVAILABLE',
			};
			errors.push({
				code: 'CONNECTIVITY_UNAVAILABLE',
				message: 'Cross-device settings could not be read from the local Device Broker.',
				action: 'Refresh local status after Broker reconnection. Local Window Node controls remain separate.',
			});
		}

		let remoteDirectory: MeshRemoteDirectorySnapshot = {
			devices: [],
			truncated: false,
			totalDevices: 0,
		};
		try {
			remoteDirectory = await this.options.node.cachedRemoteDevices();
		} catch {
			errors.push({
				code: 'REMOTE_DIRECTORY_UNAVAILABLE',
				message: 'Cached remote Device and Node status is unavailable.',
				action: 'Refresh local status after Broker reconnection. Use Mesh Tools for an explicit worker refresh.',
			});
		}
		if (
			remoteDirectory.truncated
			|| remoteDirectory.devices.some(({ nodesTruncated }) => nodesTruncated)
		) {
			errors.push({
				code: 'REMOTE_DIRECTORY_TRUNCATED',
				message: 'The remote Device or Window Node directory was truncated to the transport budget.',
				action: 'Choose from the visible explicit targets or reduce directory metadata.',
			});
		}
		const remoteDevices: NonNullable<DashboardSnapshot['remoteDevices']> = remoteDirectory.devices.map(
			(device) => ({
			deviceId: device.deviceId,
			peerId: device.peerId!,
			name: device.deviceName,
			state: device.status === 'incompatible' ? 'incompatible' : 'online',
			nodes: device.nodes.map((node) => ({
				nodeId: node.nodeId,
				nodeInstanceId: node.nodeInstanceId,
				label: node.label,
				status: node.status,
				thisWindow: false,
				workspaces: node.workspaces.map((workspace) => ({
					workspaceId: workspace.workspaceId,
					name: workspace.name,
					capabilityTags: [...workspace.tags],
					enabled: workspace.claimStatus === 'claimed',
					busy: workspace.busy,
					claimStatus: workspace.claimStatus,
				})),
			})),
			}),
		);

		const runtimePreviewEnabled = thisWindowBase.previewEnabled || connectivity.delegationEnabled;
		const runtimeProbe: AgentRuntimeProbe = runtimePreviewEnabled
			? await this.options.runtime().probe(
				!thisWindowBase.previewEnabled && connectivity.delegationEnabled ? { requireEditor: true } : undefined,
			).catch(() => ({
				available: false,
				featureEnabled: false,
				reason: 'AGENT_UNAVAILABLE' as const,
			}))
			: {
				available: false,
				featureEnabled: false,
				reason: 'AGENT_UNAVAILABLE',
			};
		const listener = listenerSnapshot(owner, runtimeProbe, this.options.workerPlatform);
		const thisWindow: DashboardSnapshot['thisWindow'] = {
			...thisWindowBase,
			acceptsIncoming: !thisWindowBase.previewEnabled
				&& thisWindowBase.claimStatus === 'claimed'
				&& connectivity.claimedWorkspaceCount === 1
				? connectivity.receivingWorkspaceCount === 1
				: thisWindowBase.acceptsIncoming,
			...(thisWindowBase.canSetAcceptIncoming && policySelection.kind === 'selected'
				? {
					acceptActionHandle: this.issueBindingHandle(this.acceptActions, {
						workspaceIdentity: policySelection.workspaceIdentity,
						workspaceId: policySelection.workspaceId,
					}),
				}
				: {}),
			agentHost: !runtimePreviewEnabled ? {
				source: 'unavailable',
				label: 'Unavailable (Preview off)',
				degraded: false,
				detail: 'Enable local or cross-device delegation before an Agent Host source is selected.',
			} : {
				source: runtimeProbe.source === 'editor'
					? 'editor'
					: runtimeProbe.source === 'standalone' ? 'standalone' : 'unavailable',
				label: listener.agentHost.label,
				degraded: runtimeProbe.degradation !== undefined,
				...(runtimeProbe.degradation === undefined ? {} : {
					reason: runtimeProbe.degradation.reason,
					detail: runtimeProbe.degradation.message,
				}),
			},
		};
		let policyCandidates: NonNullable<DashboardSnapshot['policyCandidates']> = [];
		if (thisWindow.previewEnabled && policySelection.kind === 'selected') {
			try {
				const candidates = await this.options.node.listPeerPolicyCandidates(
					policySelection.workspaceIdentity,
				);
				policyCandidates = candidates.candidates;
				if (candidates.truncated) {
					errors.push({
						code: 'PEER_CANDIDATES_TRUNCATED',
						message: 'The local peer candidate list reached its safe display bound.',
						action: 'Close stale Window Nodes and refresh.',
					});
				}
			} catch {
				errors.push({
					code: 'PEER_CANDIDATES_UNAVAILABLE',
					message: 'Local peer policy candidates could not be refreshed.',
					action: 'Wait for Broker takeover or refresh the dashboard.',
				});
			}
		}
		let outgoingTasks: NonNullable<DashboardSnapshot['outgoingTasks']> = [];
		let incomingTasks: NonNullable<DashboardSnapshot['incomingTasks']> = [];
		try {
			const dashboardTasks = await this.options.node.listDashboardTasks();
			outgoingTasks = dashboardTasks.tasks
				.filter(({ direction }) => direction === 'outgoing')
				.map(({ direction: _direction, ...task }) => task);
			incomingTasks = dashboardTasks.tasks
				.filter(({ direction }) => direction === 'incoming')
				.map(({ direction: _direction, ...task }) => task);
			if (dashboardTasks.truncated) {
				errors.push({
					code: 'DASHBOARD_TASKS_TRUNCATED',
					message: 'The Dashboard task list reached its safe display bound.',
					action: 'Refresh after older tasks expire.',
				});
			}
		} catch {
			errors.push({
				code: 'DASHBOARD_TASKS_UNAVAILABLE',
				message: 'Incoming and outgoing task status could not be refreshed.',
				action: 'Wait for Broker reconnection or refresh the dashboard.',
			});
		}
		if (lifecycle.error !== undefined) {
			errors.push({
				code: lifecycle.error.code,
				message: lifecycle.error.message,
				action: 'The lifecycle will retry with bounded backoff.',
			});
		}
		if (listener.state === 'error' && owner?.listener.snapshot().error !== undefined) {
			errors.push({
				code: owner.listener.snapshot().error!.code,
				message: 'The Listener, Gateway, or Tunnel did not reach a ready state.',
				action: 'Check Listener settings and the Dev Tunnel sign-in state.',
			});
		}

		const allNodes = [...localNodes, ...remoteDevices.flatMap(({ nodes }) => nodes)];
		const workspaceNames = new Map(
			allNodes.flatMap((node) =>
				node.workspaces.map((workspace) => [workspace.workspaceId, workspace.name] as const),
			),
		);
		const remoteNames = new Map(remoteDevices.map((device) => [device.deviceId, device.name]));
		const knownRemoteTasks = this.options.remoteTasks.listKnownTasks();
		const remoteTasks: DashboardSnapshot['tasks'] = knownRemoteTasks
			.map((snapshot) => ({
				taskId: snapshot.taskId,
				title: snapshot.title,
				peerName: remoteNames.get(snapshot.deviceId) ?? 'Remote Device',
				workspaceName: workspaceNames.get(snapshot.workspaceId) ?? 'Remote workspace',
				state: snapshot.state,
				phase: 'Remote Window Node',
				canCancel: activeTaskStates.has(snapshot.state),
				needsInput: snapshot.state === 'needsInput',
				error: snapshot.failure === undefined ? undefined : {
					code: snapshot.failure.code,
					message: 'The remote task failed without exposing diagnostic output here.',
					action: snapshot.failure.retryable ? 'Retry with a new delegation request.' : undefined,
				},
			}));
		const reservedTaskHandles = new Set(
			[...outgoingTasks, ...incomingTasks]
				.flatMap(({ actionHandle }) => actionHandle === undefined ? [] : [actionHandle]),
		);
		const retainedRemoteTaskIds = new Set(
			knownRemoteTasks
				.filter(({ state }) => activeTaskStates.has(state))
				.map(({ taskId }) => taskId),
		);
		this.pruneRemoteTaskActions(retainedRemoteTaskIds);
		const remoteDashboardTasks: DashboardTaskSummarySnapshot[] = knownRemoteTasks.map((snapshot) => {
			const canCancel = activeTaskStates.has(snapshot.state);
			return {
				...(canCancel ? {
					actionHandle: this.stableRemoteTaskHandle(snapshot.taskId, reservedTaskHandles),
				} : {}),
				counterpartLabel: remoteNames.get(snapshot.deviceId) ?? 'Remote Device',
				workspaceName: workspaceNames.get(snapshot.workspaceId) ?? 'Remote Workspace',
				title: snapshot.title,
				state: snapshot.state,
				startedAt: snapshot.createdAt,
				shortId: snapshot.taskId.slice(0, 8),
				canCancel,
			};
		});
		const combinedOutgoingTasks = [...outgoingTasks, ...remoteDashboardTasks]
			.sort((left, right) =>
				compareDashboardTimestampsDescending(left.startedAt, right.startedAt)
			);
		if (combinedOutgoingTasks.length > 500) {
			errors.push({
				code: 'DASHBOARD_TASKS_TRUNCATED',
				message: 'The outgoing task list reached its safe display bound.',
				action: 'Refresh after older tasks expire.',
			});
		}
		outgoingTasks = combinedOutgoingTasks.slice(0, 500);
		const tasks: DashboardSnapshot['tasks'] = remoteTasks;
		const legacyWorkspaces = uniqueWorkspaces(localNodes);
		const broker = brokerSnapshot(lifecycle);
		return {
			device: {
				deviceId: profile.deviceId,
				name: profile.name,
				platform: platformLabel(profile.platform),
				architecture: profile.architecture,
				vscodeVersion: profile.vscodeVersion,
				extensionVersion: profile.extensionVersion,
			},
			broker,
			thisWindow,
			connectivity,
			policyCandidates,
			outgoingTasks,
			incomingTasks,
			listener,
			localNodes,
			remoteDevices,
			workspaces: legacyWorkspaces.map((workspace) => ({
				workspaceId: workspace.workspaceId,
				name: workspace.name,
				capabilityTags: workspace.capabilityTags,
				enabled: workspace.enabled,
				busy: workspace.busy,
				activeTaskId: workspace.activeTaskId,
			})),
			peers: remoteDevices.map((device) => ({
				peerId: device.peerId,
				name: device.name,
				state: device.state,
				workspaceCount: device.nodes.reduce(
					(count, node) => count + node.workspaces.length,
					0,
				),
			})),
			tasks,
			errors,
		};
	}

	public async configureDeviceName(name: string): Promise<void> {
		const owner = this.requireOwner();
		this.options.guard.assertAllowed({ requireWorkspace: false });
		await this.options.vscodeApi.workspace.getConfiguration('copilotAgentMesh').update(
			'deviceName',
			name,
			this.options.vscodeApi.ConfigurationTarget.Global,
		);
		await owner.device.rename(name);
		this.options.changed.fire();
	}

	public async prepareWindowRename(): Promise<DashboardWindowRenameSession> {
		this.options.guard.assertAllowed({ requireWorkspace: false });
		if (!this.peerDelegationEnabled()) {
			throw new DashboardActionError(
				'PEER_DELEGATION_DISABLED',
				'Enable the Peer Delegation Preview before renaming this window.',
			);
		}
		const selection = this.options.node.selectPeerPolicyWorkspace(
			this.activeWorkspaceUri(),
		);
		if (selection.kind !== 'selected') {
			throw renameSelectionError(selection.claimStatus);
		}
		let policy;
		try {
			policy = await this.options.node.getPeerPolicy(selection.workspaceIdentity);
		} catch (error: unknown) {
			throw toDashboardPolicyError(error);
		}
		return {
			currentName: resolveWindowDisplayName(
				policy.windowName,
				selection.workspaceName,
				this.options.node.nodeId,
			),
			rename: async (name: string) => {
				this.options.guard.assertAllowed({ requireWorkspace: false });
				if (!this.peerDelegationEnabled()) {
					throw new DashboardActionError(
						'PEER_DELEGATION_DISABLED',
						'Enable the Peer Delegation Preview before renaming this window.',
					);
				}
				const live = this.options.node.selectPeerPolicyWorkspace(
					this.activeWorkspaceUri(),
				);
				if (
					live.kind !== 'selected'
					|| live.workspaceIdentity !== selection.workspaceIdentity
					|| live.workspaceId !== selection.workspaceId
				) {
					throw new DashboardActionError(
						'WORKSPACE_SELECTION_AMBIGUOUS',
						'The active Workspace changed while renaming. Reopen rename and try again.',
					);
				}
				try {
					await this.options.node.setPeerPolicy({
						workspaceIdentity: selection.workspaceIdentity,
						windowName: name,
					});
				} catch (error: unknown) {
					throw toDashboardPolicyError(error);
				}
				this.options.changed.fire();
			},
		};
	}

	public async setAcceptIncoming(actionHandle: string, enabled: boolean): Promise<void> {
		this.options.guard.assertAllowed({ requireWorkspace: false });
		if (!this.peerDelegationEnabled()) {
			throw new DashboardActionError(
				'PEER_DELEGATION_DISABLED',
				'Enable the Peer Delegation Preview before accepting incoming tasks.',
			);
		}
		const binding = this.acceptActions.get(actionHandle);
		this.acceptActions.delete(actionHandle);
		if (binding === undefined) {
			throw new DashboardActionError(
				'STALE_ACTION',
				'This receive-policy action is stale. Refresh the Dashboard and try again.',
			);
		}
		const selection = this.requirePolicySelection();
		if (
			selection.workspaceIdentity !== binding.workspaceIdentity
			|| selection.workspaceId !== binding.workspaceId
		) {
			throw new DashboardActionError(
				'WORKSPACE_SELECTION_AMBIGUOUS',
				'The active Workspace changed. Refresh the Dashboard before changing its receive policy.',
			);
		}
		try {
			await this.options.node.setPeerPolicy({
				workspaceIdentity: selection.workspaceIdentity,
				acceptsIncoming: enabled,
			});
		} catch (error: unknown) {
			throw toDashboardPolicyError(error);
		}
		this.options.changed.fire();
	}

	public async setPeerAllowed(actionHandle: string, allowed: boolean): Promise<void> {
		this.options.guard.assertAllowed({ requireWorkspace: false });
		if (!this.peerDelegationEnabled()) {
			throw new DashboardActionError(
				'PEER_DELEGATION_DISABLED',
				'Enable the Peer Delegation Preview before changing peer access.',
			);
		}
		const selection = this.requirePolicySelection();
		try {
			await this.options.node.setPeerPolicyCandidate(
				selection.workspaceIdentity,
				actionHandle,
				allowed,
			);
		} catch (error: unknown) {
			throw toDashboardPolicyError(error);
		}
		this.options.changed.fire();
	}

	public async connectivityAction(action: ConnectivityAction, actionHandle?: string): Promise<void> {
		this.options.guard.assertAllowed({ requireWorkspace: false });
		await this.options.node.connectivityAction(action, actionHandle);
		this.options.changed.fire();
	}

	public async prepareDashboardTaskCancellation(
		actionHandle: string,
		direction: DashboardTaskDirection,
	): Promise<{
		cancel(): Promise<void>;
		release(): Promise<void>;
	}> {
		const remoteBinding = this.remoteTaskActions.get(actionHandle);
		this.remoteTaskActions.delete(actionHandle);
		if (remoteBinding !== undefined) {
			this.remoteTaskHandlesById.delete(remoteBinding.taskId);
		}
		if (remoteBinding !== undefined) {
			if (direction !== 'outgoing') {
				throw new DashboardActionError(
					'STALE_ACTION',
					'The task action does not match its Dashboard direction.',
				);
			}
			if (remoteBinding.lifecycleGeneration !== this.currentRemoteHandleGeneration()) {
				throw new DashboardActionError(
					'STALE_ACTION',
					'The Broker ownership generation changed. Refresh the Dashboard and try again.',
				);
			}
			const remoteTaskId = remoteBinding.taskId;
			return {
				cancel: async () => {
					if (remoteBinding.lifecycleGeneration !== this.currentRemoteHandleGeneration()) {
						throw new DashboardActionError(
							'STALE_ACTION',
							'The Broker ownership generation changed while confirming cancellation.',
						);
					}
					const current = this.options.remoteTasks.listKnownTasks().find(
						({ taskId }) => taskId === remoteTaskId,
					);
					if (current === undefined || !activeTaskStates.has(current.state)) {
						throw new DashboardActionError(
							'STALE_ACTION',
							'The remote task is no longer cancellable.',
						);
					}
					const controller = deadlineSignal(10_000);
					try {
						const snapshot = await this.options.remoteTasks.cancelTask(
							remoteTaskId,
							controller.signal,
						);
						if (snapshot?.taskId !== remoteTaskId) {
							throw new DashboardActionError(
								'TASK_NOT_FOUND',
								'The remote task is no longer available to this window.',
							);
						}
					} finally {
						controller.abort();
					}
					this.options.changed.fire();
				},
				release: async () => undefined,
			};
		}
		let reservation;
		try {
			reservation = await this.options.node.reserveDashboardTask(actionHandle, direction);
		} catch (error: unknown) {
			throw toDashboardTaskError(error);
		}
		return {
			cancel: async () => {
				try {
					await this.options.node.cancelDashboardTask(
						reservation.reservationHandle,
						direction,
					);
				} catch (error: unknown) {
					throw toDashboardTaskError(error);
				}
				this.options.changed.fire();
			},
			release: async () => {
				try {
					await this.options.node.releaseDashboardTask(
						reservation.reservationHandle,
						direction,
					);
				} catch (error: unknown) {
					throw toDashboardTaskError(error);
				}
			},
		};
	}

	public async registerCurrentWorkspace(): Promise<void> {
		this.options.guard.assertAllowed();
		await this.options.node.refreshWorkspaces();
		this.options.changed.fire();
	}

	public async removeWorkspace(workspaceId: string): Promise<void> {
		await this.requireOwner().registry.setWorkspaceEnabled(workspaceId, false);
		await this.options.node.refreshWorkspaces().catch(() => undefined);
		this.options.changed.fire();
	}

	public async setWorkspaceEnabled(workspaceId: string, enabled: boolean): Promise<void> {
		await this.requireOwner().registry.setWorkspaceEnabled(workspaceId, enabled);
		await this.options.node.refreshWorkspaces().catch(() => undefined);
		this.options.changed.fire();
	}

	public async startListener(): Promise<void> {
		await this.requireOwner().listener.start();
		this.options.changed.fire();
	}

	public async stopListener(): Promise<void> {
		await this.requireOwner().listener.stop();
		this.options.changed.fire();
	}

	public createConnectionUrl(): Promise<string> {
		return this.requireOwner().listener.createConnectionUrl();
	}

	public async addPeer(connectionUrl: string): Promise<void> {
		await this.requireOwner().peers.add(connectionUrl);
		this.options.changed.fire();
	}

	public async removePeer(peerId: string): Promise<void> {
		await this.requireOwner().peers.remove(peerId);
		this.options.changed.fire();
	}

	public async runTask(request: {
		readonly target?: DashboardTaskTarget;
		readonly title: string;
		readonly instruction: string;
	}): Promise<void> {
		const target = request.target ?? await this.pickExplicitTarget();
		if (target === undefined) {
			return;
		}
		const title = utf8String(
			PROTOCOL_LIMITS.taskTitleBytes,
			'task title',
			1,
		).parse(request.title.trim());
		const instruction = utf8String(
			PROTOCOL_LIMITS.taskPromptBytes,
			'task instruction',
			1,
		).parse(request.instruction.trim());
		const delegationRequestId = randomUUID();
		await this.options.localTasks.persistDelegationIntent({
			delegationRequestId,
			deviceId: target.deviceId,
			nodeId: target.nodeId,
			nodeInstanceId: target.nodeInstanceId,
			workspaceId: target.workspaceId,
			...(target.peerId === undefined ? {} : { peerId: target.peerId }),
			title,
			prompt: instruction,
			acceptanceCriteria: [],
			timeoutMinutes: 60,
		});
		this.options.changed.fire();
	}

	public async cancelTask(taskId: string): Promise<void> {
		const controller = deadlineSignal(10_000);
		try {
			await this.options.localTasks.cancelOwnedTask({ taskId }, controller.signal);
			this.options.changed.fire();
		} finally {
			controller.abort();
		}
	}

	public dispose(): void {
		this.acceptActions.clear();
		this.remoteTaskActions.clear();
		this.remoteTaskHandlesById.clear();
		for (const subscription of this.subscriptions.splice(0)) {
			subscription.dispose();
		}
	}

	private async thisWindowSnapshot(
		localNodes: readonly DashboardNodeSnapshot[],
		errors: DashboardSnapshot['errors'][number][],
		selection: ReturnType<WindowNodeClient['selectPeerPolicyWorkspace']>,
	): Promise<DashboardSnapshot['thisWindow']> {
		const previewEnabled = this.peerDelegationEnabled();
		const node = localNodes.find(({ thisWindow }) => thisWindow);
		if (selection.kind !== 'selected') {
			const workspaceName = resolveWindowDisplayName(
				undefined,
				selection.workspaceName,
				this.options.node.nodeId,
			);
			return {
				name: node?.label ?? this.options.node.nodeId.slice(0, 8),
				workspaceName,
				claimStatus: selection.claimStatus,
				previewEnabled,
				canRename: false,
				acceptsIncoming: false,
				canSetAcceptIncoming: false,
				agentHost: unavailableAgentHostSnapshot(),
				detail: selection.claimStatus === 'ambiguous'
					? 'Select an editor in one claimed Workspace before renaming.'
					: 'This window does not have a mutable claimed Workspace.',
			};
		}

		const workspaceName = node?.workspaces.find(
			({ workspaceId }) => workspaceId === selection.workspaceId,
		)?.name ?? resolveWindowDisplayName(
			undefined,
			selection.workspaceName,
			this.options.node.nodeId,
		);
		let name = node?.workspaces.length === 1
			? node.label
			: resolveWindowDisplayName(undefined, workspaceName, this.options.node.nodeId);
		let canRename = previewEnabled;
		let acceptsIncoming = false;
		let canSetAcceptIncoming = previewEnabled;
		if (previewEnabled) {
			try {
				const policy = await this.options.node.getPeerPolicy(selection.workspaceIdentity);
				name = resolveWindowDisplayName(
					policy.windowName,
					workspaceName,
					this.options.node.nodeId,
				);
				acceptsIncoming = policy.acceptsIncoming;
			} catch {
				canRename = false;
				canSetAcceptIncoming = false;
				errors.push({
					code: 'PEER_POLICY_UNAVAILABLE',
					message: 'This window policy is reconnecting.',
					action: 'Wait for Broker takeover or refresh the dashboard.',
				});
			}
		}
		return {
			name,
			workspaceName,
			claimStatus: 'claimed',
			previewEnabled,
			canRename,
			acceptsIncoming,
			canSetAcceptIncoming,
			agentHost: unavailableAgentHostSnapshot(),
			...(previewEnabled ? {} : {
				detail: 'Enable copilotAgentMesh.experimental.peerDelegation to rename this window.',
			}),
		};
	}

	private activeWorkspaceUri(): string | undefined {
		const documentUri = this.options.vscodeApi.window.activeTextEditor?.document.uri;
		return documentUri === undefined
			? undefined
			: this.options.vscodeApi.workspace.getWorkspaceFolder(documentUri)?.uri.toString();
	}

	private peerDelegationEnabled(): boolean {
		return this.options.vscodeApi.workspace.getConfiguration('copilotAgentMesh')
			.get<boolean>('experimental.peerDelegation', false);
	}

	private requirePolicySelection(): Extract<
		ReturnType<WindowNodeClient['selectPeerPolicyWorkspace']>,
		{ kind: 'selected' }
	> {
		const selection = this.options.node.selectPeerPolicyWorkspace(
			this.activeWorkspaceUri(),
		);
		if (selection.kind !== 'selected') {
			throw renameSelectionError(selection.claimStatus);
		}
		return selection;
	}

	private issueBindingHandle<T>(
		actions: Map<string, T>,
		value: T,
		forbidden: ReadonlySet<string> = new Set(),
	): string {
		if (actions.size >= 500) {
			throw new DashboardActionError(
				'STALE_ACTION',
				'The Dashboard action registry reached its safe bound. Refresh and try again.',
			);
		}
		let handle: string;
		do {
			handle = randomBytes(24).toString('base64url');
		} while (actions.has(handle) || forbidden.has(handle));
		actions.set(handle, value);
		return handle;
	}

	private stableRemoteTaskHandle(
		taskId: string,
		forbidden: ReadonlySet<string>,
	): string {
		const existing = this.remoteTaskHandlesById.get(taskId);
		const existingBinding = existing === undefined
			? undefined
			: this.remoteTaskActions.get(existing);
		if (
			existing !== undefined
			&& existingBinding?.taskId === taskId
			&& existingBinding.lifecycleGeneration === this.remoteHandleGeneration
		) {
			return existing;
		}
		const handle = this.issueBindingHandle(this.remoteTaskActions, {
			taskId,
			lifecycleGeneration: this.remoteHandleGeneration,
		}, forbidden);
		this.remoteTaskHandlesById.set(taskId, handle);
		return handle;
	}

	private pruneRemoteTaskActions(retainedTaskIds: ReadonlySet<string>): void {
		for (const [taskId, handle] of this.remoteTaskHandlesById) {
			if (retainedTaskIds.has(taskId)) {
				continue;
			}
			this.remoteTaskHandlesById.delete(taskId);
			this.remoteTaskActions.delete(handle);
		}
	}

	private currentRemoteHandleGeneration(): string {
		const snapshot = this.options.lifecycle.snapshot();
		return `${snapshot.generation ?? 'none'}:${snapshot.ownership?.generation ?? 'none'}:${snapshot.state}`;
	}

	private refreshRemoteHandleGeneration(): void {
		const generation = this.currentRemoteHandleGeneration();
		if (generation === this.remoteHandleGeneration) {
			return;
		}
		this.remoteHandleGeneration = generation;
		this.remoteTaskActions.clear();
		this.remoteTaskHandlesById.clear();
	}

	private requireOwner(): ProductionBrokerRuntime {
		const owner = this.options.ownerRuntime();
		if (owner === undefined || this.options.lifecycle.snapshot().state !== 'running') {
			throw new Error('This window does not currently own the Device Broker service.');
		}
		return owner;
	}

	private async pickExplicitTarget(): Promise<DashboardTaskTarget | undefined> {
		const profile = this.options.profile();
		const local = await this.options.node.listNodes();
		const controller = deadlineSignal(5_000);
		let remote: readonly MeshDeviceToolSummary[] = [];
		try {
			remote = (await this.options.remoteTasks.listDevices(controller.signal)).devices;
		} finally {
			controller.abort();
		}
		const devices = [{
			deviceId: profile.deviceId,
			deviceName: profile.name,
			peerId: undefined,
			nodes: local.nodes,
		}, ...remote.map((device) => ({
			deviceId: device.deviceId,
			deviceName: device.deviceName,
			peerId: device.peerId,
			nodes: device.nodes,
		}))];
		const device = (await this.options.vscodeApi.window.showQuickPick(
			devices.map((candidate) => ({
				label: candidate.deviceName,
				description: candidate.deviceId === profile.deviceId ? 'This Device' : 'Remote Device',
				candidate,
			})),
			{
				title: 'Select a target Device',
				placeHolder: 'Choose one explicit Device route',
				ignoreFocusOut: true,
			},
		))?.candidate;
		if (device === undefined) {
			return undefined;
		}
		const nodes = device.nodes.filter((node) =>
			node.status === 'online' || node.status === 'busy',
		);
		const node = (await this.options.vscodeApi.window.showQuickPick(
			nodes.map((candidate) => ({
				label: candidate.label,
				description: candidate.status,
				candidate,
			})),
			{
				title: 'Select a target Window Node',
				placeHolder: 'Choose one explicit Window Node instance',
				ignoreFocusOut: true,
			},
		))?.candidate;
		if (node === undefined) {
			return undefined;
		}
		const workspaces = node.workspaces.filter((workspace) =>
			workspace.claimStatus === 'claimed'
			&& (!('enabled' in workspace) || workspace.enabled)
			&& !workspace.busy,
		);
		const workspace = (await this.options.vscodeApi.window.showQuickPick(
			workspaces.map((candidate) => ({
				label: candidate.name,
				description: 'capabilityTags' in candidate
					? candidate.capabilityTags.join(', ')
					: candidate.tags.join(', '),
				candidate,
			})),
			{
				title: 'Select a target Workspace',
				placeHolder: 'Choose one explicitly claimed Workspace',
				ignoreFocusOut: true,
			},
		))?.candidate;
		return workspace === undefined ? undefined : {
			deviceId: device.deviceId,
			nodeId: node.nodeId,
			nodeInstanceId: node.nodeInstanceId,
			workspaceId: workspace.workspaceId,
			...(device.peerId === undefined ? {} : { peerId: device.peerId }),
		};
	}
}

function toDashboardPolicyError(error: unknown): Error {
	if (error instanceof DashboardActionError) {
		return error;
	}
	if (error instanceof z.ZodError) {
		return new DashboardActionError(
			'WINDOW_NAME_INVALID',
			'The window name is empty or exceeds the UTF-8 protocol limit.',
		);
	}
	if (error instanceof LocalIpcRemoteError) {
		const reason = remoteErrorReason(error);
		if (
			reason === 'WINDOW_NAME_CONFLICT'
			|| reason === 'WINDOW_NAME_INVALID'
			|| reason === 'POLICY_FORBIDDEN'
		) {
			return new DashboardActionError(
				reason,
				reason === 'WINDOW_NAME_CONFLICT'
					? 'Another Workspace already uses an equivalent window name.'
					: reason === 'WINDOW_NAME_INVALID'
						? 'The window name contains a path, invisible character, or secret-like value.'
						: 'The policy action is stale or does not belong to the current Workspace.',
			);
		}

		if (error.code === JSON_RPC_ERROR_CODES.INVALID_PARAMS) {
			return new DashboardActionError(
				'WINDOW_NAME_INVALID',
				'The window name is empty or exceeds the UTF-8 protocol limit.',
			);
		}
	}
	return error instanceof Error
		? error
		: new Error('The window rename failed without diagnostic details.');
}

function toDashboardTaskError(error: unknown): Error {
	if (error instanceof LocalIpcRemoteError) {
		const reason = remoteErrorReason(error);
		if (reason === 'TASK_NOT_FOUND') {
			return new DashboardActionError(
				'STALE_ACTION',
				'This task action is stale. Refresh the Dashboard and try again.',
			);
		}
	}
	return error instanceof Error
		? error
		: new Error('The task cancellation failed without diagnostic details.');
}

function renameSelectionError(
	claimStatus: 'unclaimed' | 'readOnly' | 'conflict' | 'ambiguous',
): DashboardActionError {
	return claimStatus === 'ambiguous'
		? new DashboardActionError(
			'WORKSPACE_SELECTION_AMBIGUOUS',
			'Select an editor in the Workspace you want to rename, then retry.',
		)
		: new DashboardActionError(
			'POLICY_FORBIDDEN',
			'Only a Workspace claimed by this window can be renamed.',
		);
}

function remoteErrorReason(error: LocalIpcRemoteError): DashboardActionErrorCode | 'TASK_NOT_FOUND' | undefined {
	if (
		typeof error.data !== 'object'
		|| error.data === null
		|| Array.isArray(error.data)
		|| !('reason' in error.data)
	) {
		return undefined;
	}
	const reason = error.data.reason;
	return typeof reason === 'string' && [
		'WINDOW_NAME_CONFLICT',
		'WINDOW_NAME_INVALID',
		'POLICY_FORBIDDEN',
		'TASK_NOT_FOUND',
	].includes(reason)
		? reason as DashboardActionErrorCode | 'TASK_NOT_FOUND'
		: undefined;
}

function unavailableAgentHostSnapshot(): DashboardSnapshot['thisWindow']['agentHost'] {
	return {
		source: 'unavailable',
		label: 'Determining',
		degraded: false,
	};
}

function brokerSnapshot(
	status: BrokerLifecycleStatus,
): NonNullable<DashboardSnapshot['broker']> {
	return {
		state: status.state,
		role: status.owner ? 'owner' : 'contender',
		takeover: status.state === 'takingOver'
			? 'takingOver'
			: status.state === 'contending' ? 'waiting'
				: status.state === 'stopping' || status.state === 'disposed' ? 'stopping'
					: status.state === 'error' ? 'error' : 'stable',
		holder: status.owner
			? 'thisWindow'
			: status.holderWindowId === undefined ? 'none' : 'anotherWindow',
		...(status.error === undefined ? {} : {
			error: {
				code: status.error.code,
				message: status.error.message,
				action: 'The lifecycle will retry automatically.',
			},
		}),
	};
}

function listenerSnapshot(
	owner: ProductionBrokerRuntime | undefined,
	runtimeProbe: {
		readonly available: boolean;
		readonly featureEnabled: boolean;
		readonly reason?: string;
		readonly source?: 'editor' | 'standalone';
		readonly degradation?: {
			readonly reason: string;
			readonly message: string;
		};
	},
	workerPlatform: WorkerPlatformSupport,
): DashboardSnapshot['listener'] {
	const agentHost = runtimeProbe.available
		? runtimeProbe.source === 'editor'
			? {
				state: 'ready' as const,
				label: 'Editor',
				detail: 'Tasks use the current VS Code instance Agent Host.',
			}
			: runtimeProbe.degradation === undefined
				? {
					state: 'ready' as const,
					label: 'Standalone',
					detail: 'Tasks use the owned standalone Agent Host.',
				}
				: {
					state: 'ready' as const,
					label: 'Standalone (degraded)',
					detail: runtimeProbe.degradation.message,
				}
		: {
			state: 'unavailable' as const,
			label: runtimeProbe.featureEnabled ? 'Unavailable' : 'Disabled',
			detail: workerPlatform.supported
				? 'Enable the Agent Host feature after satisfying the AHP compatibility gate.'
				: workerPlatform.agentMessage,
			action: workerPlatform.supported
				? 'Configure copilotAgentMesh.experimental.agentHost.'
				: 'Use macOS arm64 for task execution.',
		};
	if (owner === undefined) {
		return {
			state: 'unavailable',
			gateway: {
				state: 'unavailable',
				label: 'Owner window only',
				detail: 'Gateway ownership is held by another Window Node.',
			},
			tunnel: {
				state: 'unavailable',
				label: 'Owner window only',
				detail: 'The single Device Tunnel is managed by the Broker owner.',
			},
			agentHost,
			canStart: false,
			canStop: false,
			canCopyConnectionUrl: false,
		};
	}
	const listener = owner.listener.snapshot();
	const tunnelReady = listener.tunnel.state === 'ready';
	return {
		state: listener.state,
		gateway: listener.state === 'running'
			? { state: 'ready', label: 'Ready', detail: 'Loopback Gateway is accepting authenticated peers.' }
			: listener.state === 'error'
				? { state: 'error', label: 'Error', detail: 'Gateway startup did not complete.' }
				: { state: 'stopped', label: 'Stopped' },
		tunnel: tunnelReady
			? { state: 'ready', label: 'Ready', detail: 'The single Device Tunnel is hosted.' }
			: listener.state === 'error'
				? {
					state: listener.error?.code === 'CLI_UNSUPPORTED' ? 'unavailable' : 'error',
					label: listener.error?.code === 'CLI_UNSUPPORTED' ? 'Unsupported' : 'Error',
					detail: listener.error?.message ?? 'The Device Tunnel is unavailable.',
				}
				: { state: 'stopped', label: 'Stopped' },
		agentHost,
		canStart: workerPlatform.supported
			&& (listener.state === 'stopped' || listener.state === 'error'),
		canStop: listener.state === 'running'
			|| listener.state === 'starting'
			|| listener.state === 'error',
		canCopyConnectionUrl: listener.state === 'running' && tunnelReady,
	};
}

function toDashboardNode(
	node: Awaited<ReturnType<WindowNodeClient['listDashboardNodes']>>['nodes'][number],
	thisNodeId: string,
): DashboardNodeSnapshot {
	return {
		nodeId: node.nodeId,
		nodeInstanceId: node.nodeInstanceId,
		label: node.label,
		status: node.status,
		thisWindow: node.nodeId === thisNodeId,
		workspaces: node.workspaces.map((workspace) => ({
			workspaceId: workspace.workspaceId,
			name: workspace.name,
			capabilityTags: [...workspace.capabilityTags],
			enabled: workspace.enabled,
			busy: workspace.busy,
			claimStatus: workspace.claimStatus,
			activeTaskId: workspace.activeTaskId,
		})),
	};
}

function uniqueWorkspaces(
	nodes: readonly DashboardNodeSnapshot[],
): readonly DashboardNodeSnapshot['workspaces'][number][] {
	const values = new Map<string, DashboardNodeSnapshot['workspaces'][number]>();
	for (const node of nodes) {
		for (const workspace of node.workspaces) {
			values.set(workspace.workspaceId, workspace);
		}
	}
	return [...values.values()];
}

function deadlineSignal(delayMs: number): AbortController {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), delayMs);
	controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
	return controller;
}

function platformLabel(platform: NodeJS.Platform): string {
	return platform === 'darwin'
		? 'macOS'
		: platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform;
}

function compareDashboardTimestampsDescending(left: string, right: string): number {
	const leftTime = Date.parse(left);
	const rightTime = Date.parse(right);
	if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
		return rightTime - leftTime;
	}
	return right.localeCompare(left);
}


/**
 * Legacy v1 picker retained for API compatibility. It always invokes both
 * explicit pickers when IDs are absent and never chooses array element zero.
 */
export async function selectDashboardTaskTarget(
	directory: MeshWorkerDirectorySnapshot,
	requestedPeerId: string | undefined,
	requestedWorkspaceId: string | undefined,
	isEnabled: (peerId: string) => boolean,
	pickWorker: (
		workers: MeshWorkerDirectorySnapshot['workers'],
	) => Promise<MeshWorkerDirectorySnapshot['workers'][number] | undefined>,
	pickWorkspace: (
		workspaces: MeshWorkerDirectorySnapshot['workers'][number]['workspaces'],
	) => Promise<MeshWorkerDirectorySnapshot['workers'][number]['workspaces'][number] | undefined>,
): Promise<{
	readonly worker: MeshWorkerDirectorySnapshot['workers'][number];
	readonly workspace: MeshWorkerDirectorySnapshot['workers'][number]['workspaces'][number];
} | undefined> {
	const enabledWorkers = directory.workers.filter(({ peerId }) => isEnabled(peerId));
	const worker = requestedPeerId === undefined
		? await pickWorker(enabledWorkers)
		: enabledWorkers.find(({ peerId }) => peerId === requestedPeerId);
	if (worker === undefined) {
		return undefined;
	}
	const availableWorkspaces = worker.workspaces.filter(({ busy }) => !busy);
	const workspace = requestedWorkspaceId === undefined
		? await pickWorkspace(availableWorkspaces)
		: availableWorkspaces.find(({ workspaceId }) => workspaceId === requestedWorkspaceId);
	return workspace === undefined ? undefined : { worker, workspace };
}
