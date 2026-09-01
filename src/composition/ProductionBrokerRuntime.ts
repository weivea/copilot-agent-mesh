import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import type * as vscode from 'vscode';

import { DeviceService } from '../application/DeviceService';
import { ListenerService } from '../application/ListenerService';
import type { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { TaskCoordinator } from '../application/TaskCoordinator';
import type { WorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import {
	BrokerTaskService,
	DeviceBroker,
	NodeRegistry,
	PeerPolicyService,
	PeerPolicyStore,
	TaskRouteCatalog,
	type BrokerRuntime,
	type NodeTaskBinding,
} from '../broker';
import { systemClock, type StateStore } from '../domain/ports';
import { GatewayRouter } from '../gateway/GatewayRouter';
import { GatewayServer } from '../gateway/GatewayServer';
import { PairingService } from '../gateway/PairingService';
import type { LocalIpcIdentity } from '../ipc';
import type { StructuredLogger } from '../logging/StructuredLogger';
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import { WebSocketPeerTransport } from '../peer/WebSocketPeerTransport';
import {
	AtomicFileStore,
	NodeAtomicFileSystem,
} from '../storage/AtomicFileStore';
import type { BrokerOwnership } from '../storage/BrokerOwnerLock';
import { FencedStateStore } from '../storage/BrokerOwnerLock';
import {
	ArtifactStore,
} from '../tasks/ArtifactStore';
import {
	DeviceProfileStore,
	type DeviceProfile,
} from '../storage/DeviceProfileStore';
import {
	VscodeDevTunnelStateStore,
	VscodePairingRecordStore,
	VscodePeerProfileStore,
	type VscodeSecretStore,
} from '../storage/VscodeStorageAdapters';
import { FileTaskStore } from '../tasks/FileTaskStore';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { LazyVscodeDevTunnelProvider } from './LazyVscodeDevTunnelProvider';
import { createTaskNotificationSink } from './TaskNotificationPublisher';
import { ProductionRemoteTaskAdapter } from './ProductionRemoteTaskAdapter';
import { ensureOwnedBrokerKey } from './SharedBrokerIdentity';

export interface ProductionBrokerRuntimeOptions {
	readonly vscodeApi: typeof vscode;
	readonly context: vscode.ExtensionContext;
	readonly rawState: StateStore;
	readonly secrets: VscodeSecretStore;
	readonly ownership: BrokerOwnership;
	readonly generation: string;
	readonly identityFor: (deviceId: string) => LocalIpcIdentity;
	readonly guard: LocalDesktopWorkspaceGuard;
	readonly workerPlatform: WorkerPlatformSupport;
	readonly logger: StructuredLogger;
	readonly onDidChange: () => void;
	readonly onDisposed?: (runtime: ProductionBrokerRuntime) => void;
}

export class ProductionBrokerRuntime implements BrokerRuntime {
	public readonly device: DeviceService;
	public readonly profile: DeviceProfile;
	public readonly leases: WorkspaceLeaseManager;
	public readonly registry: NodeRegistry;
	public readonly peerPolicies: PeerPolicyService;
	public readonly tasks: FileTaskStore;
	public readonly artifacts: ArtifactStore;
	public readonly brokerTasks: BrokerTaskService;
	public readonly broker: DeviceBroker;
	public readonly peerProfiles: VscodePeerProfileStore;
	public readonly peers: PeerConnectionManager;
	public readonly coordinator: TaskCoordinator;
	public readonly remoteTasks: ProductionRemoteTaskAdapter;
	public readonly listener: ListenerService;
	public readonly tunnel: LazyVscodeDevTunnelProvider;

	private started = false;
	private disposed = false;
	private disposeRequested = false;
	private disposal: Promise<void> | undefined;
	private listenerDisposed = false;
	private peersDisposed = false;
	private brokerDisposed = false;
	private disposedNotificationSent = false;
	private changeNotificationSent = false;
	private readonly subscriptions = new Set<{ dispose(): void }>();

	private constructor(
		private readonly options: ProductionBrokerRuntimeOptions,
		components: {
			readonly device: DeviceService;
			readonly profile: DeviceProfile;
			readonly leases: WorkspaceLeaseManager;
			readonly registry: NodeRegistry;
			readonly peerPolicies: PeerPolicyService;
			readonly tasks: FileTaskStore;
			readonly artifacts: ArtifactStore;
			readonly brokerTasks: BrokerTaskService;
			readonly broker: DeviceBroker;
			readonly peerProfiles: VscodePeerProfileStore;
			readonly peers: PeerConnectionManager;
			readonly coordinator: TaskCoordinator;
			readonly remoteTasks: ProductionRemoteTaskAdapter;
			readonly listener: ListenerService;
			readonly tunnel: LazyVscodeDevTunnelProvider;
		},
	) {
		this.device = components.device;
		this.profile = components.profile;
		this.leases = components.leases;
		this.registry = components.registry;
		this.peerPolicies = components.peerPolicies;
		this.tasks = components.tasks;
		this.artifacts = components.artifacts;
		this.brokerTasks = components.brokerTasks;
		this.broker = components.broker;
		this.peerProfiles = components.peerProfiles;
		this.peers = components.peers;
		this.coordinator = components.coordinator;
		this.remoteTasks = components.remoteTasks;
		this.listener = components.listener;
		this.tunnel = components.tunnel;
		for (const subscription of [
			this.listener.onDidChange(this.options.onDidChange),
			{
				dispose: this.peers.onDidChange(() => {
					this.options.onDidChange();
					void this.broker.reconcileRemoteTasks().catch((error: unknown) => {
						this.options.logger.error(
							'task',
							'Retained remote task reconciliation failed safely.',
							error,
						);
					});
				}),
			},
			{
				dispose: this.peers.onNotification((profileId, method, params) => {
					this.options.onDidChange();
					void this.broker.reconcileRemoteTaskNotification(
						profileId,
						method,
						params,
					).catch((error: unknown) => {
						this.options.logger.error(
							'task',
							'Remote task notification reconciliation failed safely.',
							error,
						);
					});
				}),
			},
		]) {
			this.subscriptions.add(subscription);
		}
	}

	public static async create(
		options: ProductionBrokerRuntimeOptions,
	): Promise<ProductionBrokerRuntime> {
		await assertGeneration(options);
		const fencedState = new FencedStateStore(
			options.rawState,
			options.ownership,
			options.generation,
		);
		const brokerKey = await ensureOwnedBrokerKey(
			options.secrets,
			options.ownership,
			options.generation,
		);
		const configuration = options.vscodeApi.workspace.getConfiguration('copilotAgentMesh');
		const extensionVersion = String(options.context.extension?.packageJSON.version ?? '0.0.0');
		const ids = { next: randomUUID };
		const profileStore = new DeviceProfileStore(fencedState, ids, systemClock);
		const device = new DeviceService(profileStore, {
			defaultName: configuration.get<string>('deviceName', '').trim() || hostname(),
			platform: supportedPlatform(process.platform),
			architecture: process.arch,
			vscodeVersion: options.vscodeApi.version,
			extensionVersion,
		}, options.guard, options.ownership);
		let profile = await device.initialize();
		const configuredName = configuration.get<string>('deviceName', '').trim();
		if (configuredName.length > 0 && configuredName !== profile.name) {
			profile = await device.rename(configuredName);
		}

		const leases = new WorkspaceLeaseManager();
		const storageRoot = options.vscodeApi.Uri.joinPath(
			options.context.globalStorageUri,
			'mesh-state',
		);
		await options.vscodeApi.workspace.fs.createDirectory(storageRoot);
		await assertGeneration(options);
		await removeLegacyCollaborationState(storageRoot.fsPath);
		await assertGeneration(options);
		const files = new AtomicFileStore(
			storageRoot.fsPath,
			new NodeAtomicFileSystem(),
			ids,
		);
		const tasks = new FileTaskStore(files, systemClock, {
			ownership: options.ownership,
			generation: options.generation,
		});
		const artifacts = new ArtifactStore(files, {
			ownership: options.ownership,
			generation: options.generation,
		});
		const peerPolicyStore = new PeerPolicyStore(files, {
			ownership: options.ownership,
			generation: options.generation,
			clock: systemClock,
		});
		await peerPolicyStore.initialize();
		let brokerTasks: BrokerTaskService | undefined;
		let broker: DeviceBroker | undefined;
		const registry = new NodeRegistry({
			deviceId: profile.deviceId,
			state: fencedState,
			ids,
			clock: systemClock,
			workspaceLeases: leases,
			onNodeTasksLost: (bindings: readonly NodeTaskBinding[]) => {
				void brokerTasks?.handleNodeTasksLost(bindings).catch((error: unknown) => {
					options.logger.error(
						'broker',
						'Lost Window Node tasks could not be finalized.',
						error,
					);
				});
			},
		});
		const peerPolicies = new PeerPolicyService(peerPolicyStore, registry, {
			enabled: () => options.vscodeApi.workspace
				.getConfiguration('copilotAgentMesh')
				.get<boolean>('experimental.peerDelegation', false),
			onDidChange: options.onDidChange,
		});
		registry.setPeerRouteAuthorizer(peerPolicies);
		const taskRoutes = new TaskRouteCatalog(fencedState);
		let listener: ListenerService | undefined;
		brokerTasks = new BrokerTaskService(
			profile.deviceId,
			registry,
			tasks,
			systemClock,
			{
				onDidChange: options.onDidChange,
				onTaskSnapshot: async (snapshot, sourceNodeId) => {
					if (taskRoutes.get(snapshot.taskId) !== undefined) {
						await taskRoutes.markSnapshot(snapshot);
					}
					broker?.publishTaskSnapshot(snapshot, sourceNodeId);
				},
				onBackgroundError: (error) => options.logger.error(
					'broker',
					'A Broker task lifecycle background operation failed.',
					error,
				),
				notificationSink: createTaskNotificationSink(
					(peerId, method, params) => listener?.publish(peerId, method, params),
				),
			},
		);
		const pairingRecords = new VscodePairingRecordStore(fencedState);
		const peerProfiles = new VscodePeerProfileStore(fencedState);
		const pairing = new PairingService(
			profile.deviceId,
			options.secrets,
			pairingRecords,
		);
		const peers = new PeerConnectionManager(
			profile.deviceId,
			peerProfiles,
			options.secrets,
			new WebSocketPeerTransport(),
			{ ownership: options.ownership },
		);
		const coordinator = new TaskCoordinator(
			peers,
			peerProfiles,
			fencedState,
			options.guard,
			randomUUID,
			() => new Date(),
			options.ownership,
		);
		const remoteTasks = new ProductionRemoteTaskAdapter(
			peers,
			peerProfiles,
			fencedState,
		);
		broker = new DeviceBroker({
			identity: options.identityFor(profile.deviceId),
			brokerKey,
			ownership: options.ownership,
			registry,
			peerPolicies,
			taskService: brokerTasks,
			remoteTaskService: remoteTasks,
			taskRoutes,
			onError: (error) => options.logger.error(
				'local-ipc',
				'The local Device Broker reported a transport failure.',
				error,
			),
		});
		const tunnelPath = configuration.get<string>('devTunnelPath', '').trim();
		const tunnel = new LazyVscodeDevTunnelProvider({
			executable: tunnelPath || undefined,
			reportStatusListenerError: (error: unknown) =>
				options.logger.error('listener', 'A Dev Tunnel status listener failed.', error),
			stateStore: new VscodeDevTunnelStateStore(fencedState),
		});
		const router = new GatewayRouter(device, broker);
		const configuredPort = (): number | undefined => {
			const value = options.vscodeApi.workspace
				.getConfiguration('copilotAgentMesh')
				.get<number>('listener.port', 0);
			return value === 0 ? undefined : value;
		};
		listener = new ListenerService(
			profile.deviceId,
			pairing,
			tunnel,
			() => new GatewayServer(pairing, router),
			fencedState,
			options.guard,
			{
				configuredPort,
				workerPlatform: options.workerPlatform,
				ownership: options.ownership,
			},
		);
		return new ProductionBrokerRuntime(options, {
			device,
			profile,
			leases,
			registry,
			peerPolicies,
			tasks,
			artifacts,
			brokerTasks,
			broker,
			peerProfiles,
			peers,
			coordinator,
			remoteTasks,
			listener,
			tunnel,
		});
	}

	public async start(): Promise<void> {
		if (this.disposeRequested || this.disposed) {
			throw new Error('The production Device Broker runtime is disposed.');
		}
		if (this.started) {
			return;
		}
		await assertGeneration(this.options);
		await this.registry.initialize();
		await this.brokerTasks.initialize();
		for (const record of await this.tasks.list()) {
			if (this.broker.taskRoutes.get(record.taskId) !== undefined) {
				await this.broker.taskRoutes.markState(
					record.taskId,
					record.state,
					record.updatedAt,
				);
			}
		}
		await this.broker.start();
		await this.peers.restore();
		await this.restoreListener();
		await this.coordinator.refreshKnownTasks().catch((error: unknown) => {
			this.options.logger.error(
				'coordinator',
				'Remote task status recovery did not complete.',
				error,
			);
		});
		await assertGeneration(this.options);
		this.started = true;
		this.options.onDidChange();
	}

	public dispose(): Promise<void> {
		if (this.disposal !== undefined) {
			return this.disposal;
		}
		this.disposeRequested = true;
		let disposal!: Promise<void>;
		disposal = this.disposeOnce().finally(() => {
			if (!this.disposed && this.disposal === disposal) {
				this.disposal = undefined;
			}
		});
		this.disposal = disposal;
		return disposal;
	}

	private async restoreListener(): Promise<void> {
		const configuration = this.options.vscodeApi.workspace.getConfiguration('copilotAgentMesh');
		try {
			await this.listener.restore();
			if (
				this.listener.snapshot().state === 'stopped'
				&& configuration.get<boolean>('listener.autoStart', false)
			) {
				await this.listener.start();
			}
		} catch (error: unknown) {
			this.options.logger.error(
				'listener',
				'Listener restoration failed safely; local Window Nodes remain available.',
				error,
			);
		}
	}

	private async disposeOnce(): Promise<void> {
		this.started = false;
		const failures: unknown[] = [];
		for (const resource of [
			{
				pending: () => !this.listenerDisposed,
				dispose: () => this.listener.dispose(),
				complete: () => {
					this.listenerDisposed = true;
				},
			},
			{
				pending: () => !this.peersDisposed,
				dispose: () => this.peers.dispose(),
				complete: () => {
					this.peersDisposed = true;
				},
			},
			{
				pending: () => !this.brokerDisposed,
				dispose: () => this.broker.dispose(),
				complete: () => {
					this.brokerDisposed = true;
				},
			},
		]) {
			if (!resource.pending()) {
				continue;
			}
			try {
				await resource.dispose();
				resource.complete();
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		for (const subscription of [...this.subscriptions]) {
			try {
				subscription.dispose();
				this.subscriptions.delete(subscription);
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		if (failures.length === 0 && !this.disposedNotificationSent) {
			try {
				this.options.onDisposed?.(this);
				this.disposedNotificationSent = true;
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		if (
			this.listenerDisposed
			&& this.peersDisposed
			&& this.brokerDisposed
			&& this.subscriptions.size === 0
			&& !this.changeNotificationSent
		) {
			try {
				this.options.onDidChange();
				this.changeNotificationSent = true;
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				'The production Device Broker runtime did not release every owned service.',
			);
		}
		this.disposed = true;
	}
}

async function assertGeneration(options: ProductionBrokerRuntimeOptions): Promise<void> {
	if (
		!options.ownership.isOwner()
		|| options.ownership.currentGeneration() !== options.generation
	) {
		throw new Error('The Device Broker generation is no longer current.');
	}
	await options.ownership.assertOwner();
	if (options.ownership.currentGeneration() !== options.generation) {
		throw new Error('The Device Broker generation is no longer current.');
	}
}

export async function removeLegacyCollaborationState(storageRoot: string): Promise<void> {
	await rm(join(storageRoot, 'collaborations'), { recursive: true, force: true });
}

function supportedPlatform(platform: NodeJS.Platform): 'win32' | 'darwin' | 'linux' {
	if (platform === 'win32' || platform === 'darwin' || platform === 'linux') {
		return platform;
	}
	throw new Error(`Copilot Agent Mesh does not support platform ${platform}.`);
}
