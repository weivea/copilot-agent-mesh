import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import * as vscode from 'vscode';

import { DeviceService } from '../application/DeviceService';
import { ListenerService } from '../application/ListenerService';
import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { WorkerTaskService } from '../application/RemoteTaskRunner';
import { TaskCoordinator } from '../application/TaskCoordinator';
import { WorkspaceService } from '../application/WorkspaceService';
import { getWorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import type { AgentRuntime } from '../agentHost/AgentRuntime';
import { systemClock } from '../domain/ports';
import { GatewayRouter } from '../gateway/GatewayRouter';
import { GatewayServer } from '../gateway/GatewayServer';
import { PairingService } from '../gateway/PairingService';
import { StructuredLogger } from '../logging/StructuredLogger';
import { createTaskNotificationSink } from './TaskNotificationPublisher';
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import { WebSocketPeerTransport } from '../peer/WebSocketPeerTransport';
import {
	AtomicFileStore,
	NodeAtomicFileSystem,
} from '../storage/AtomicFileStore';
import { DeviceProfileStore } from '../storage/DeviceProfileStore';
import {
	VscodeDevTunnelStateStore,
	VscodeGlobalStateStore,
	VscodePairingRecordStore,
	VscodePeerProfileStore,
	VscodeSecretStore,
} from '../storage/VscodeStorageAdapters';
import { WorkerOwnerLock } from '../storage/WorkerOwnerLock';
import { FileTaskStore } from '../tasks/FileTaskStore';
import { WorkspaceLeaseManager } from '../tasks/WorkspaceLeaseManager';
import { registerMeshTaskTools } from '../tools/taskTools';
import { DevTunnelCliProvider } from '../tunnel/DevTunnelCliProvider';
import {
	AgentMeshViewProvider,
	DASHBOARD_COMMANDS,
} from '../ui/AgentMeshViewProvider';
import {
	ServiceDashboardFacade,
	type DashboardFacade,
} from '../ui/DashboardFacade';
import { NodeFileIdentityResolver } from '../workspaces/NodeFileIdentityResolver';
import { WorkspaceRegistry } from '../workspaces/WorkspaceRegistry';
import { ProductionDashboardBindings } from './ProductionDashboardBindings';
import {
	createVscodeAgentRuntime,
	VscodeLocalTaskApproval,
} from './VscodeAgentRuntime';
import {
	createTwoDeviceE2eApi,
	type TwoDeviceE2eApi,
} from './TwoDeviceE2eApi';
import {
	E2eCapability,
	type ExtensionRuntimeMode,
} from './E2eCapability';

export const APPLICATION_COMMANDS = {
	registerWorkspace: 'copilotAgentMesh.registerWorkspace',
	removeWorkspace: 'copilotAgentMesh.removeWorkspace',
	enableWorkspace: 'copilotAgentMesh.enableWorkspace',
	disableWorkspace: 'copilotAgentMesh.disableWorkspace',
	startListener: 'copilotAgentMesh.startListener',
	stopListener: 'copilotAgentMesh.stopListener',
	copyConnectionUrl: 'copilotAgentMesh.copyConnectionUrl',
	addPeer: 'copilotAgentMesh.addPeer',
	removePeer: 'copilotAgentMesh.removePeer',
	runTask: 'copilotAgentMesh.runTask',
	cancelTask: 'copilotAgentMesh.cancelTask',
	answerTask: 'copilotAgentMesh.answerTask',
} as const;

export interface AgentMeshExtensionApi {
	readonly agentRuntime: AgentRuntime;
	readonly coordinator: TaskCoordinator;
	readonly workerTasks: WorkerTaskService;
	readonly listener: ListenerService;
	readonly twoDeviceE2e?: TwoDeviceE2eApi;
}

export interface Application {
	readonly api: AgentMeshExtensionApi;
	dispose(): Promise<void>;
}

export async function createApplication(context: vscode.ExtensionContext): Promise<Application> {
	const output = vscode.window.createOutputChannel('Copilot Agent Mesh', { log: true });
	const logger = new StructuredLogger(output);
	const contributions: vscode.Disposable[] = [];
	const cleanup: Array<() => Promise<void> | void> = [];
	try {
		const state = new VscodeGlobalStateStore(context.globalState);
		const secrets = new VscodeSecretStore(context.secrets);
		const guard = new LocalDesktopWorkspaceGuard(() => ({
			remoteName: vscode.env.remoteName,
			isTrusted: vscode.workspace.isTrusted,
			workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => ({
				uriScheme: folder.uri.scheme,
			})),
		}));
		const ids = { next: randomUUID };
		const workerPlatform = getWorkerPlatformSupport();
		const configuration = vscode.workspace.getConfiguration('copilotAgentMesh');
		const e2eCapability = E2eCapability.create({
			mode: extensionRuntimeMode(context.extensionMode),
			environmentEnabled: process.env.MESH_TWO_DEVICE_E2E === '1',
			environmentNonce: process.env.MESH_TWO_DEVICE_E2E_NONCE,
			environmentRole: process.env.MESH_TWO_DEVICE_E2E_ROLE,
			profileNonce: configuration.get<string>('e2e.nonce'),
			profileRole: configuration.get<string>('e2e.role'),
		});
		const storageRoot = vscode.Uri.joinPath(context.globalStorageUri, 'mesh-state');
		await vscode.workspace.fs.createDirectory(storageRoot);
		const ownership = await WorkerOwnerLock.acquire(context.globalStorageUri.fsPath, {
			instanceId: randomUUID(),
		});
		cleanup.push(() => ownership.dispose());
		const extensionVersion = String(context.extension?.packageJSON.version ?? '0.0.0');
		const deviceStore = new DeviceProfileStore(state, ids, systemClock);
		const device = new DeviceService(deviceStore, {
			defaultName: configuration.get<string>('deviceName', '').trim() || hostname(),
			platform: supportedPlatform(process.platform),
			architecture: process.arch,
			vscodeVersion: vscode.version,
			extensionVersion,
		}, guard, ownership);
		let deviceProfile = ownership.isOwner()
			? await device.initialize()
			: device.initializeReadOnly();
		const configuredDeviceName = configuration.get<string>('deviceName', '').trim();
		if (
			configuredDeviceName.length > 0
			&& configuredDeviceName !== deviceProfile.name
		) {
			if (ownership.isOwner()) {
				deviceProfile = await device.rename(configuredDeviceName);
			}
		}

		const leases = new WorkspaceLeaseManager();
		const workspaceRegistry = new WorkspaceRegistry(
			state,
			ids,
			systemClock,
			new NodeFileIdentityResolver(),
			leases,
		);
		const workspaceService = new WorkspaceService(
			workspaceRegistry,
			guard,
			() => vscode.workspace.workspaceFolders ?? [],
			() => {
				const activeUri = vscode.window.activeTextEditor?.document.uri;
				return activeUri === undefined ? undefined : vscode.workspace.getWorkspaceFolder(activeUri);
			},
			async (folders) => (await vscode.window.showQuickPick(
				folders.map((folder) => ({
					label: folder.name,
					description: folder.uri.fsPath,
					folder,
				})),
				{
					title: 'Register Copilot Agent Mesh Workspace',
					placeHolder: 'Choose a local workspace to share',
					ignoreFocusOut: true,
				},
			))?.folder,
			() => vscode.workspace
				.getConfiguration('copilotAgentMesh')
				.get<readonly string[]>('workspace.capabilityTags', []),
			ownership,
		);
		const files = new AtomicFileStore(storageRoot.fsPath, new NodeAtomicFileSystem(), ids);
		const taskStore = new FileTaskStore(files, systemClock);

		const pairingRecords = new VscodePairingRecordStore(state);
		const peerProfiles = new VscodePeerProfileStore(state);
		const pairing = new PairingService(
			deviceProfile.deviceId,
			secrets,
			pairingRecords,
		);
		const peerManager = new PeerConnectionManager(
			deviceProfile.deviceId,
			peerProfiles,
			secrets,
			new WebSocketPeerTransport(),
			{ ownership },
		);
		cleanup.push(() => peerManager.dispose());

		const changeEvents = new vscode.EventEmitter<void>();
		cleanup.push(() => changeEvents.dispose());
		const approvals = new VscodeLocalTaskApproval(vscode, state, e2eCapability);
		const runtime = createVscodeAgentRuntime(
			vscode,
			context,
			workspaceRegistry,
			guard,
			approvals,
			workerPlatform,
			ownership,
		);
		cleanup.push(() => runtime.dispose());
		let listenerService: ListenerService | undefined;
		const workerTasks = new WorkerTaskService(
			deviceProfile.deviceId,
			runtime,
			workspaceRegistry,
			taskStore,
			leases,
			guard,
			approvals,
			{
				onDidChange: () => changeEvents.fire(),
				ownership,
				notificationSink: createTaskNotificationSink(
					(peerId, method, params) => listenerService?.publish(peerId, method, params),
				),
				e2eCapability,
			},
		);
		cleanup.push(() => workerTasks.dispose());
		if (ownership.isOwner()) {
			await workerTasks.initialize();
		}

		const router = new GatewayRouter(device, workspaceService, workerTasks);
		const tunnelPath = configuration.get<string>('devTunnelPath', '').trim();
		const tunnel = new DevTunnelCliProvider({
			executable: tunnelPath || undefined,
			reportStatusListenerError: (error) =>
				logger.error('listener', 'A Dev Tunnel status listener failed.', error),
			stateStore: new VscodeDevTunnelStateStore(state),
		});
		const configuredPort = (): number | undefined => {
			const value = vscode.workspace
				.getConfiguration('copilotAgentMesh')
				.get<number>('listener.port', 0);
			return value === 0 ? undefined : value;
		};
		const listener = new ListenerService(
			deviceProfile.deviceId,
			pairing,
			tunnel,
			() => new GatewayServer(pairing, router),
			state,
			guard,
			{ configuredPort, workerPlatform, ownership },
		);
		listenerService = listener;
		cleanup.push(() => listener.dispose());
		const ownershipLoss = ownership.onDidLoseOwnership(() => {
			void Promise.allSettled([
				workerTasks.dispose(),
				listener.dispose(),
				peerManager.dispose(),
			]).then((results) => {
				for (const result of results) {
					if (result.status === 'rejected') {
						logger.error(
							'ownership',
							'Worker ownership-loss cleanup did not complete.',
							result.reason,
						);
					}
				}
				changeEvents.fire();
			});
		});
		cleanup.push(() => ownershipLoss.dispose());

		const coordinator = new TaskCoordinator(
			peerManager,
			peerProfiles,
			state,
			guard,
			randomUUID,
			() => new Date(),
			ownership,
		);

		const bindings = new ProductionDashboardBindings(
			vscode,
			changeEvents,
			device,
			workspaceService,
			listener,
			peerManager,
			peerProfiles,
			coordinator,
			taskStore,
			leases,
			runtime,
			guard,
			workerPlatform,
			ownership,
		);
		cleanup.push(() => bindings.dispose());
		const dashboardFacade = new ServiceDashboardFacade(bindings);
		const dashboard = new AgentMeshViewProvider(dashboardFacade, context.extensionUri);
		cleanup.push(() => dashboard.dispose());
		const twoDeviceE2e = createTwoDeviceE2eApi(
			vscode,
			bindings,
			coordinator,
			listener,
			runtime,
			tunnel,
			workerTasks,
			e2eCapability,
		);
		if (ownership.isOwner()) {
			await peerManager.restore();
			await restoreListener(listener, configuration, logger);
			await coordinator.refreshKnownTasks().catch((error: unknown) => {
				logger.error('coordinator', 'Task status recovery did not complete.', error);
			});
		}

		contributions.push(
			registerMeshTaskTools(coordinator),
			vscode.window.registerWebviewViewProvider(AgentMeshViewProvider.viewType, dashboard),
			...registerCommands(
				context,
				dashboardFacade,
				dashboard,
				workspaceService,
				guard,
				logger,
			),
			vscode.workspace.onDidChangeWorkspaceFolders(() => changeEvents.fire()),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('copilotAgentMesh.deviceName')) {
					if (!ownership.isOwner()) {
						return;
					}
					const name = vscode.workspace
						.getConfiguration('copilotAgentMesh')
						.get<string>('deviceName', '')
						.trim();
					if (name.length > 0) {
						void device.rename(name).then(
							() => changeEvents.fire(),
							(error: unknown) => logger.error('device', 'Device name update failed.', error),
						);
					}
				}
			}),
		);
		context.subscriptions.push(...contributions);
		logger.log('info', 'application', 'Copilot Agent Mesh application started.', {
			protocolVersion: deviceProfile.protocolVersion,
			workerOwner: ownership.isOwner(),
		});

		let disposal: Promise<void> | undefined;
		const application: Application = {
			api: {
				agentRuntime: runtime,
				coordinator,
				workerTasks,
				listener,
				...(twoDeviceE2e === undefined ? {} : { twoDeviceE2e }),
			},
			dispose: () => {
				if (disposal === undefined) {
					disposal = disposeApplication(contributions, cleanup, logger);
				}
				return disposal;
			},
		};
		return application;
	} catch (error) {
		await disposeApplication(contributions, cleanup, logger).catch(() => undefined);
		throw error;
	}
}

async function restoreListener(
	listener: ListenerService,
	configuration: vscode.WorkspaceConfiguration,
	logger: StructuredLogger,
): Promise<void> {
	try {
		await listener.restore();
		if (
			listener.snapshot().state === 'stopped'
			&& configuration.get<boolean>('listener.autoStart', false)
		) {
			await listener.start();
		}
	} catch (error) {
		logger.error('listener', 'Listener restoration failed safely.', error);
	}
}

function registerCommands(
	_context: vscode.ExtensionContext,
	facade: DashboardFacade,
	dashboard: AgentMeshViewProvider,
	workspaces: WorkspaceService,
	guard: LocalDesktopWorkspaceGuard,
	logger: StructuredLogger,
): vscode.Disposable[] {
	const register = (
		id: string,
		requireWorkspace: boolean,
		handler: (...args: unknown[]) => Promise<void> | void,
	): vscode.Disposable => vscode.commands.registerCommand(id, async (...args: unknown[]) => {
		try {
			guard.assertAllowed({ requireWorkspace });
			await handler(...args);
		} catch (error) {
			logger.error('command', `Command ${id} failed.`, error);
			const message = error instanceof Error ? error.message : 'The command failed.';
			await vscode.window.showErrorMessage(message);
		}
	});
	const selectTarget = async (
		kind: 'workspace' | 'peer' | 'task',
	): Promise<string | undefined> => {
		const snapshot = await facade.getSnapshot();
		const values = kind === 'workspace'
			? snapshot.workspaces.map((item) => ({ label: item.name, id: item.workspaceId }))
			: kind === 'peer'
				? snapshot.peers.map((item) => ({ label: item.name, id: item.peerId }))
				: snapshot.tasks.map((item) => ({ label: item.title, id: item.taskId }));
		return (await vscode.window.showQuickPick(values, {
			title: `Select ${kind}`,
			ignoreFocusOut: true,
		}))?.id;
	};
	return [
		register(DASHBOARD_COMMANDS.configureDevice, false, () => facade.configureDeviceName()),
		register(DASHBOARD_COMMANDS.refresh, false, () => dashboard.refresh()),
		register(APPLICATION_COMMANDS.registerWorkspace, true, () => facade.registerCurrentWorkspace()),
		register(APPLICATION_COMMANDS.removeWorkspace, true, async (value) => {
			const id = opaqueId(value) ?? await selectTarget('workspace');
			if (id !== undefined) {
				await facade.removeWorkspace(id);
			}
		}),
		register(APPLICATION_COMMANDS.enableWorkspace, true, async (value) => {
			const id = opaqueId(value) ?? await selectTarget('workspace');
			if (id !== undefined) {
				await workspaces.setEnabled(id, true);
				dashboard.refresh();
			}
		}),
		register(APPLICATION_COMMANDS.disableWorkspace, true, async (value) => {
			const id = opaqueId(value) ?? await selectTarget('workspace');
			if (id !== undefined) {
				await workspaces.setEnabled(id, false);
				dashboard.refresh();
			}
		}),
		register(APPLICATION_COMMANDS.startListener, false, () => facade.startListener()),
		register(APPLICATION_COMMANDS.stopListener, false, () => facade.stopListener()),
		register(APPLICATION_COMMANDS.copyConnectionUrl, false, () => facade.copyConnectionUrl()),
		register(APPLICATION_COMMANDS.addPeer, false, () => facade.addPeer()),
		register(APPLICATION_COMMANDS.removePeer, false, async (value) => {
			const id = opaqueId(value) ?? await selectTarget('peer');
			if (id !== undefined) {
				await facade.removePeer(id);
			}
		}),
		register(APPLICATION_COMMANDS.runTask, false, (peerId, workspaceId) =>
			facade.runTask(opaqueId(peerId), opaqueId(workspaceId))),
		register(APPLICATION_COMMANDS.cancelTask, false, async (value) => {
			const id = opaqueId(value) ?? await selectTarget('task');
			if (id !== undefined) {
				await facade.cancelTask(id);
			}
		}),
		register(APPLICATION_COMMANDS.answerTask, false, async (value) => {
			const id = opaqueId(value) ?? await selectTarget('task');
			if (id !== undefined) {
				await facade.answerTaskInput(id);
			}
		}),
	];
}

async function disposeApplication(
	contributions: readonly vscode.Disposable[],
	cleanup: readonly (() => Promise<void> | void)[],
	logger: StructuredLogger,
): Promise<void> {
	for (const contribution of [...contributions].reverse()) {
		contribution.dispose();
	}
	const failures: unknown[] = [];
	for (const dispose of [...cleanup].reverse()) {
		try {
			await dispose();
		} catch (error) {
			failures.push(error);
			logger.error('shutdown', 'Application resource cleanup failed.', error);
		}
	}
	logger.log('info', 'application', 'Copilot Agent Mesh application stopped.');
	logger.dispose();
	if (failures.length > 0) {
		throw new AggregateError(failures, 'Copilot Agent Mesh did not cleanly release every resource.');
	}
}

function opaqueId(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string') {
		return value.id;
	}
	return undefined;
}

function supportedPlatform(platform: NodeJS.Platform): 'win32' | 'darwin' | 'linux' {
	if (platform === 'win32' || platform === 'darwin' || platform === 'linux') {
		return platform;
	}

	throw new Error(`Copilot Agent Mesh does not support platform ${platform}.`);
}

function extensionRuntimeMode(mode: vscode.ExtensionMode): ExtensionRuntimeMode {
	switch (mode) {
		case vscode.ExtensionMode.Development:
			return 'development';
		case vscode.ExtensionMode.Test:
			return 'test';
		default:
			return 'production';
	}
}
