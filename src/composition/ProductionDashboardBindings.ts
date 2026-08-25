import { randomUUID } from 'node:crypto';

import type * as vscode from 'vscode';

import { ACTIVE_TASK_STATUSES } from '../../shared/protocol';
import type { AgentRuntime } from '../agentHost/AgentRuntime';
import type { DeviceService } from '../application/DeviceService';
import type { ListenerService } from '../application/ListenerService';
import type { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import type { TaskCoordinator } from '../application/TaskCoordinator';
import type { WorkspaceService } from '../application/WorkspaceService';
import type { PeerConnectionManager } from '../peer/PeerConnectionManager';
import type { PeerProfileStore } from '../peer/PeerProfile';
import type { FileTaskStore } from '../tasks/FileTaskStore';
import type { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import type { MeshWorkerDirectorySnapshot } from '../../shared/toolProtocol';
import type { WorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import type { WorkerOwnership } from '../storage/WorkerOwnerLock';
import type {
	DashboardServiceBindings,
	DashboardSnapshot,
	PeerState,
} from '../ui/DashboardFacade';

const activeTaskStates = new Set<string>(ACTIVE_TASK_STATUSES);

export class ProductionDashboardBindings implements DashboardServiceBindings, vscode.Disposable {
	private readonly subscriptions: Array<{ dispose(): void }> = [];
	private remoteRefreshTimer: NodeJS.Timeout | undefined;

	public constructor(
		private readonly vscodeApi: typeof vscode,
		private readonly changed: vscode.EventEmitter<void>,
		private readonly device: DeviceService,
		private readonly workspaces: WorkspaceService,
		private readonly listener: ListenerService,
		private readonly peers: PeerConnectionManager,
		private readonly peerProfiles: PeerProfileStore,
		private readonly coordinator: TaskCoordinator,
		private readonly workerTasks: FileTaskStore,
		private readonly leases: WorkspaceLeaseManager,
		private readonly runtime: AgentRuntime,
		private readonly guard: LocalDesktopWorkspaceGuard,
		private readonly workerPlatform: WorkerPlatformSupport,
		private readonly ownership: WorkerOwnership,
	) {
		this.subscriptions.push(
			listener.onDidChange(() => changed.fire()),
			{
				dispose: peers.onDidChange(() => {
					changed.fire();
					this.scheduleRemoteRefresh();
				}),
			},
			{
				dispose: peers.onNotification(() => this.scheduleRemoteRefresh()),
			},
		);
	}

	public readonly onDidChange = (listener: () => void): vscode.Disposable =>
		this.changed.event(listener);

	public async getSnapshot(): Promise<DashboardSnapshot> {
		this.guard.assertAllowed({ requireWorkspace: false });
		const profile = this.device.current();
		const listener = this.listener.snapshot();
		const runtimeProbe = await this.runtime.probe().catch(() => ({
			available: false,
			featureEnabled: false,
			reason: 'AGENT_UNAVAILABLE' as const,
		}));
		const localWorkspaces = await this.workspaces.listLocal().catch(() => []);
		const peerProfiles = await this.peerProfiles.list();
		const directoryController = new AbortController();
		const directoryTimer = setTimeout(() => directoryController.abort(), 2_000);
		const directory = await this.coordinator.listWorkers(directoryController.signal)
			.catch(() => ({ workers: [] }));
		clearTimeout(directoryTimer);
		const workersByPeer = new Map(
			directory.workers.map((worker) => [worker.peerId, worker]),
		);
		const connections = new Map(
			this.peers.listConnections().map((connection) => [connection.profileId, connection.snapshot()]),
		);
		const workerRecords = this.ownership.isOwner() ? await this.workerTasks.list() : [];
		const coordinatorTasks = this.coordinator.listKnownTasks();
		const workspaceNames = new Map(
			localWorkspaces.map((workspace) => [workspace.workspaceId, workspace.name]),
		);
		const profileNames = new Map(
			peerProfiles.map((peer) => [peer.id, peer.workerDeviceId]),
		);
		const tasks: DashboardSnapshot['tasks'] = [
			...coordinatorTasks.map(({ intent, snapshot }) => ({
				taskId: intent.taskId,
				title: intent.title,
				peerName: workersByPeer.get(intent.peerId)?.deviceName
					?? profileNames.get(intent.peerId)
					?? 'Remote device',
				workspaceName: snapshot === undefined
					? 'Remote workspace'
					: workersByPeer.get(intent.peerId)?.workspaces.find(
						(workspace) => workspace.workspaceId === snapshot.workspaceId,
					)?.name ?? 'Remote workspace',
				state: snapshot?.state ?? 'accepted' as const,
				summary: snapshot?.summary,
				canCancel: snapshot === undefined || activeTaskStates.has(snapshot.state),
				needsInput: snapshot?.state === 'needsInput',
				error: snapshot?.failure,
			})),
			...workerRecords
				.filter((record) => !coordinatorTasks.some(({ intent }) => intent.taskId === record.taskId))
				.map((record) => ({
					taskId: record.taskId,
					title: record.title,
					peerName: 'Connected coordinator',
					workspaceName: workspaceNames.get(record.workspaceId) ?? 'Registered workspace',
					state: record.state,
					summary: record.summary,
					canCancel: activeTaskStates.has(record.state),
					needsInput: record.state === 'needsInput',
					error: record.failure,
				})),
		];
		const workerPlatformSupported = this.workerPlatform.supported;
		const workerOwnedHere = this.ownership.isOwner();
		const listenerError = !workerPlatformSupported
			? [{
				code: this.workerPlatform.listenerCode,
				message: this.workerPlatform.listenerMessage,
				action: 'Use a macOS arm64 device to host a Worker listener.',
			}]
			: listener.error === undefined ? [] : [{
				code: listener.error.code,
				message: listener.error.message,
				action: 'Check the Dev Tunnel build, login, and listener settings.',
			}];
		const agentPlatformError = workerPlatformSupported ? [] : [{
			code: 'AGENT_UNAVAILABLE',
			message: 'Worker Preview task execution requires macOS arm64. Coordinator features remain available.',
			action: 'Use a macOS arm64 device to host Worker tasks.',
		}];
		const ownershipError = workerOwnedHere ? [] : [{
			code: 'WORKER_OWNED_BY_ANOTHER_WINDOW',
			message: 'Another VS Code window owns Worker and Listener services for this extension storage.',
			action: 'Use this window as a Coordinator, or close the owner window and reload this window to acquire ownership.',
		}];
		const listenerUnsupported = !workerPlatformSupported
			|| !workerOwnedHere
			|| listener.error?.code === 'CLI_UNSUPPORTED';
		const tunnelReady = listener.tunnel.state === 'ready';
		return {
			device: {
				name: profile.name,
				platform: platformLabel(profile.platform),
				architecture: profile.architecture,
				vscodeVersion: profile.vscodeVersion,
				extensionVersion: profile.extensionVersion,
			},
			listener: {
				state: listenerUnsupported ? 'unavailable' : listener.state,
				gateway: listenerUnsupported
					? {
						state: 'unavailable',
						label: 'Unsupported',
						detail: !workerOwnedHere
							? 'Another VS Code window owns Worker and Listener services.'
							: listener.error?.message ?? this.workerPlatform.listenerMessage,
						action: !workerOwnedHere
							? 'This window remains Coordinator-only until ownership is released.'
							: 'Use macOS arm64 to host a Worker; Coordinator features remain available.',
					}
					: listener.state === 'running'
						? { state: 'ready', label: 'Ready', detail: 'Loopback gateway is accepting authenticated peers.' }
						: listener.state === 'error'
							? { state: 'error', label: 'Error', detail: 'Gateway startup did not complete.' }
							: { state: 'stopped', label: 'Stopped' },
				tunnel: listenerUnsupported
					? {
						state: 'unavailable',
						label: 'Unsupported',
						detail: !workerOwnedHere
							? 'Another VS Code window owns the Worker tunnel.'
							: listener.error?.message ?? this.workerPlatform.listenerMessage,
						action: !workerOwnedHere
							? 'Use the owner window to manage the Listener.'
							: 'Use macOS arm64 for Worker Preview listener hosting.',
					}
					: tunnelReady
						? { state: 'ready', label: 'Ready', detail: 'Exact-build Dev Tunnel is hosted.' }
						: listener.state === 'error'
						? {
							state: listener.error?.code === 'CLI_UNSUPPORTED' ? 'unavailable' : 'error',
							label: listener.error?.code === 'CLI_UNSUPPORTED' ? 'Unsupported' : 'Error',
							detail: listener.error?.message
								?? (listenerUnsupported
									? this.workerPlatform.listenerMessage
									: 'Dev Tunnel is unavailable.'),
							action: listener.error?.code === 'CLI_UNSUPPORTED'
								? 'Use macOS arm64 for Worker Preview listener hosting; Coordinator features remain available.'
								: undefined,
						}
						: { state: 'stopped', label: 'Stopped' },
				agentHost: runtimeProbe.available
					? { state: 'ready', label: 'Available', detail: 'Agent Host runtime is enabled.' }
					: {
						state: 'unavailable',
						label: runtimeProbe.featureEnabled ? 'Unavailable' : 'Disabled',
						detail: !workerOwnedHere
							? 'Another VS Code window owns Worker task execution; this window is Coordinator-only.'
							: !workerPlatformSupported
							? 'Worker Preview execution is unavailable. macOS arm64 is required; Coordinator features remain available.'
							: 'Enable the Agent Host feature after satisfying the AHP compatibility gate.',
						action: !workerOwnedHere
							? 'Use the owner window for Worker tasks.'
							: !workerPlatformSupported
							? 'Use macOS arm64 for Worker Preview execution.'
							: 'Configure copilotAgentMesh.experimental.agentHost.',
					},
				canStart: workerOwnedHere && !listenerUnsupported
					&& (listener.state === 'stopped' || listener.state === 'error'),
				canStop: listener.state === 'running'
					|| listener.state === 'starting'
					|| (listener.state === 'error' && listener.error?.code === 'LISTENER_STOP_FAILED'),
				canCopyConnectionUrl: listener.state === 'running' && tunnelReady,
			},
			workspaces: localWorkspaces.map((workspace) => ({
				workspaceId: workspace.workspaceId,
				name: workspace.name,
				capabilityTags: workspace.capabilityTags,
				enabled: workspace.enabled,
				busy: this.leases.isLeased(workspace.fileIdentity),
				activeTaskId: this.leases.owner(workspace.fileIdentity)?.taskId,
			})),
			peers: peerProfiles.map((peer) => {
				const connection = connections.get(peer.id);
				const worker = workersByPeer.get(peer.id);
				return {
					peerId: peer.id,
					name: worker?.deviceName ?? peer.workerDeviceId,
					state: toDashboardPeerState(connection?.state),
					latencyMs: connection?.latencyMs,
					lastSeenLabel: connection?.lastHeartbeatAt === undefined
						? undefined
						: 'Recently active',
					workspaceCount: worker?.workspaces.length ?? 0,
				};
			}),
			tasks,
			errors: [...listenerError, ...agentPlatformError, ...ownershipError],
		};
	}

	public async configureDeviceName(name: string): Promise<void> {
		await this.ownership.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		await this.vscodeApi.workspace.getConfiguration('copilotAgentMesh').update(
			'deviceName',
			name,
			this.vscodeApi.ConfigurationTarget.Global,
		);
		await this.device.rename(name);
		this.changed.fire();
	}

	public async registerCurrentWorkspace(): Promise<void> {
		await this.ownership.assertOwner();
		await this.workspaces.registerCurrent();
		this.changed.fire();
	}

	public async removeWorkspace(workspaceId: string): Promise<void> {
		await this.ownership.assertOwner();
		await this.workspaces.remove(workspaceId);
		this.changed.fire();
	}

	public async startListener(): Promise<void> {
		await this.listener.start();
		this.changed.fire();
	}

	public async stopListener(): Promise<void> {
		await this.listener.stop();
		this.changed.fire();
	}

	public createConnectionUrl(): Promise<string> {
		return this.listener.createConnectionUrl();
	}

	public async addPeer(connectionUrl: string): Promise<void> {
		await this.ownership.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		await this.peers.add(connectionUrl);
		this.changed.fire();
	}

	public async removePeer(peerId: string): Promise<void> {
		await this.ownership.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		await this.peers.remove(peerId);
		this.changed.fire();
	}

	public async runTask(request: {
		readonly peerId?: string;
		readonly workspaceId?: string;
		readonly instruction: string;
	}): Promise<void> {
		await this.ownership.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		const directoryController = deadlineSignal(5_000);
		let directory: MeshWorkerDirectorySnapshot;
		try {
			directory = await this.coordinator.listWorkers(directoryController.signal);
		} finally {
			directoryController.abort();
		}
		const selected = await selectDashboardTaskTarget(
			directory,
			request.peerId,
			request.workspaceId,
			(peerId) => this.peers.isEnabled(peerId),
			async (workers) => (await this.vscodeApi.window.showQuickPick(
				workers.map((worker) => ({
					label: worker.deviceName,
					description: worker.capabilities.join(', '),
					worker,
				})),
				{
					title: 'Select an online Worker',
					placeHolder: 'Choose the enabled Worker for this task',
					ignoreFocusOut: true,
				},
			))?.worker,
			async (workspaces) => (await this.vscodeApi.window.showQuickPick(
				workspaces.map((workspace) => ({
					label: workspace.name,
					description: workspace.tags.join(', '),
					workspace,
				})),
				{
					title: 'Select an enabled Worker workspace',
					placeHolder: 'Choose a non-busy workspace',
					ignoreFocusOut: true,
				},
			))?.workspace,
		);
		if (selected === undefined) {
			return;
		}
		const startController = deadlineSignal(15_000);
		try {
			await this.coordinator.startTask({
				peerId: selected.worker.peerId,
				workspaceId: selected.workspace.workspaceId,
				title: boundUtf8(request.instruction, 256),
				prompt: request.instruction,
				acceptanceCriteria: [],
			}, startController.signal);
			this.changed.fire();
		} finally {
			startController.abort();
		}
	}

	public async cancelTask(taskId: string): Promise<void> {
		await this.ownership.assertOwner();
		const controller = deadlineSignal(10_000);
		try {
			await this.coordinator.cancelOwnedTask({ taskId }, controller.signal);
			this.changed.fire();
		} finally {
			controller.abort();
		}
	}

	public async answerTaskInput(taskId: string, answer: string): Promise<void> {
		await this.ownership.assertOwner();
		const task = this.coordinator.listKnownTasks().find(({ intent }) => intent.taskId === taskId);
		const inputId = task?.snapshot?.pendingInput?.inputId;
		if (inputId === undefined) {
			throw new Error('The selected task is not waiting for input.');
		}
		const controller = deadlineSignal(10_000);
		try {
			await this.coordinator.answerOwnedTask({
				taskId,
				inputId,
				answerId: randomUUID(),
				answer,
			}, controller.signal);
			this.changed.fire();
		} finally {
			controller.abort();
		}
	}

	public dispose(): void {
		if (this.remoteRefreshTimer !== undefined) {
			clearTimeout(this.remoteRefreshTimer);
			this.remoteRefreshTimer = undefined;
		}
		for (const subscription of this.subscriptions.splice(0)) {
			subscription.dispose();
		}
	}

	private scheduleRemoteRefresh(): void {
		if (this.remoteRefreshTimer !== undefined) {
			clearTimeout(this.remoteRefreshTimer);
		}
		this.remoteRefreshTimer = setTimeout(() => {
			this.remoteRefreshTimer = undefined;
			void this.coordinator.refreshKnownTasks().finally(() => this.changed.fire());
		}, 100);
	}
}

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

function deadlineSignal(delayMs: number): AbortController {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), delayMs);
	controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
	return controller;
}

function toDashboardPeerState(state: string | undefined): PeerState {
	switch (state) {
		case 'connecting':
		case 'online':
		case 'busy':
		case 'offline':
		case 'authFailed':
		case 'incompatible':
			return state;
		case 'rePairRequired':
			return 'authFailed';
		default:
			return 'offline';
	}
}

function platformLabel(platform: NodeJS.Platform): string {
	return platform === 'darwin'
		? 'macOS'
		: platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform;
}

function boundUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
		return value;
	}
	let result = '';
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, 'utf8');
		if (bytes + size > maxBytes) {
			break;
		}
		result += character;
		bytes += size;
	}
	return result;
}
