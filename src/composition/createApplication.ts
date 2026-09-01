import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

import * as vscode from 'vscode';

import {
	AgentRuntimeApprovalCapabilityIssuer,
	type AgentRuntime,
} from '../agentHost/AgentRuntime';
import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { getWorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import {
	BrokerLifecycle,
	type BrokerLifecycleStatus,
	type BrokerTaskService,
} from '../broker';
import { StructuredLogger } from '../logging/StructuredLogger';
import {
	LocalIpcRemoteTaskAdapter,
	WindowNodeClient,
	WindowNodeTaskExecutor,
	type WindowNodeClientSnapshot,
} from '../node';
import { deriveLocalIpcEndpoint } from '../ipc';
import {
	PeerDelegationE2eRecorder,
	PeerDelegationE2eToolClock,
} from '../e2e/PeerDelegationE2eRecorder';
import { BrokerOwnerLock } from '../storage/BrokerOwnerLock';
import {
	DeviceProfileStore,
	type DeviceEnvironment,
	type DeviceProfile,
} from '../storage/DeviceProfileStore';
import {
	VscodeGlobalStateStore,
	VscodeSecretStore,
} from '../storage/VscodeStorageAdapters';
import { PeerDelegationE2eStateStore } from '../storage/PeerDelegationE2eStateStore';
import {
	writeMultiWindowStartupDiagnostic,
	type MultiWindowStartupDiagnosticCode,
} from '../e2e/MultiWindowE2eSupport';
import { DelegatedToolInvocationRegistry } from '../tools/DelegatedToolInvocationRegistry';
import { LocalBrokerTaskFacade } from '../tools/LocalBrokerTaskFacade';
import { registerMeshTaskTools } from '../tools/taskTools';
import {
	AgentMeshViewProvider,
	DASHBOARD_COMMANDS,
} from '../ui/AgentMeshViewProvider';
import {
	ServiceDashboardFacade,
	type DashboardFacade,
	type DashboardTaskTarget,
} from '../ui/DashboardFacade';
import { ProductionBrokerRuntime } from './ProductionBrokerRuntime';
import { ProductionDashboardBindings } from './ProductionDashboardBindings';
import {
	createLocalBrokerIdentity,
	waitForBrokerKey,
	waitForDeviceProfile,
} from './SharedBrokerIdentity';
import {
	createVscodeAgentRuntime,
	VscodeLocalTaskApproval,
	VscodeWindowNodeTaskConfirmation,
} from './VscodeAgentRuntime';
import {
	createTwoDeviceE2eApi,
	type TwoDeviceE2eApi,
} from './TwoDeviceE2eApi';
import { createPeerDelegationE2eApi } from './PeerDelegationE2eApi';
import {
	E2eCapability,
	isE2eCapabilityEnabled,
	type ExtensionRuntimeMode,
} from './E2eCapability';
import {
	activationRollbackFailure,
	addApplicationCleanup,
	createApplicationCleanupState,
	disposeApplicationResources,
	type ApplicationCleanupStep,
} from './ApplicationCleanup';

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
} as const;

export interface AgentMeshExtensionApi {
	readonly agentRuntime: AgentRuntime;
	readonly node: WindowNodeClient;
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly brokerLifecycle: BrokerLifecycle<ProductionBrokerRuntime>;
	readonly nodeState: () => WindowNodeClientSnapshot;
	readonly brokerState: () => BrokerLifecycleStatus;
	readonly coordinator?: ProductionBrokerRuntime['coordinator'];
	readonly workerTasks?: BrokerTaskService;
	readonly listener?: ProductionBrokerRuntime['listener'];
	readonly twoDeviceE2e?: TwoDeviceE2eApi;
	readonly multiWindowE2e?: TwoDeviceE2eApi;
	readonly peerDelegationE2e?: TwoDeviceE2eApi;
}

export interface Application {
	readonly api: AgentMeshExtensionApi;
	dispose(): Promise<void>;
}

export async function createApplication(context: vscode.ExtensionContext): Promise<Application> {
	const output = vscode.window.createOutputChannel('Copilot Agent Mesh', { log: true });
	const logger = new StructuredLogger(output);
	const contributions: vscode.Disposable[] = [];
	const cleanup: ApplicationCleanupStep[] = [];
	const cleanupState = createApplicationCleanupState<vscode.Disposable>();
	try {
		const persistentState = new VscodeGlobalStateStore(context.globalState);
		const secrets = new VscodeSecretStore(context.secrets);
		const guard = new LocalDesktopWorkspaceGuard(() => ({
			remoteName: vscode.env.remoteName,
			isTrusted: vscode.workspace.isTrusted,
			workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => ({
				uriScheme: folder.uri.scheme,
			})),
		}));
		const delegatedToolInvocations = new DelegatedToolInvocationRegistry();
		addApplicationCleanup(cleanup, () => delegatedToolInvocations.dispose());
		guard.assertAllowed({ requireWorkspace: false });
		const workerPlatform = getWorkerPlatformSupport();
		const configuration = vscode.workspace.getConfiguration('copilotAgentMesh');
		const twoDeviceE2eRequested = process.env.MESH_TWO_DEVICE_E2E === '1';
		const multiWindowE2eRequested = process.env.MESH_MULTI_WINDOW_E2E === '1';
		const peerDelegationE2eRequested = process.env.MESH_PEER_DELEGATION_E2E === '1';
		const requestedE2eScenario = selectE2eScenario({
			twoDevice: twoDeviceE2eRequested,
			multiWindow: multiWindowE2eRequested,
			peerDelegation: peerDelegationE2eRequested,
		});
		const runtimeMode = extensionRuntimeMode(context.extensionMode);
		const e2eCapability = E2eCapability.create({
			mode: runtimeMode,
			environmentEnabled: requestedE2eScenario !== undefined,
			environmentNonce: requestedE2eScenario === 'peerDelegation'
				? process.env.MESH_PEER_DELEGATION_E2E_NONCE
				: requestedE2eScenario === 'multiWindow'
					? process.env.MESH_MULTI_WINDOW_E2E_NONCE
					: process.env.MESH_TWO_DEVICE_E2E_NONCE,
			environmentRole: requestedE2eScenario === 'peerDelegation'
				|| requestedE2eScenario === 'multiWindow'
				? 'coordinator'
				: process.env.MESH_TWO_DEVICE_E2E_ROLE,
			profileNonce: configuration.get<string>('e2e.nonce'),
			profileRole: configuration.get<string>('e2e.role'),
		});
		const peerDelegationRun = runtimeMode === 'development'
			&& requestedE2eScenario === 'peerDelegation'
			&& isE2eCapabilityEnabled(e2eCapability)
			? peerDelegationRunContext(process.env.MESH_PEER_DELEGATION_E2E_NONCE)
			: undefined;
		const rawState = peerDelegationRun === undefined
			? persistentState
			: new PeerDelegationE2eStateStore(persistentState, peerDelegationRun.nonce);
		const brokerStorageUri = peerDelegationRun === undefined
			? context.globalStorageUri
			: vscode.Uri.file(join(peerDelegationRun.controlRoot, 'broker'));
		const peerDelegationRecorder = peerDelegationRun !== undefined
			? new PeerDelegationE2eRecorder()
			: undefined;
		const peerDelegationToolClock = peerDelegationRecorder === undefined
			? undefined
			: new PeerDelegationE2eToolClock(peerDelegationBudgetMs());
		const environment: DeviceEnvironment = {
			defaultName: configuration.get<string>('deviceName', '').trim() || hostname(),
			platform: supportedPlatform(process.platform),
			architecture: process.arch,
			vscodeVersion: vscode.version,
			extensionVersion: String(context.extension?.packageJSON.version ?? '0.0.0'),
		};
		const windowInstanceId = randomUUID();
		const nodeId = randomUUID();
		const nodeInstanceId = randomUUID();
		const reportPeerStartup = peerDelegationRun === undefined
			? undefined
			: peerDelegationStartupReporter(peerDelegationRun.controlRoot, nodeInstanceId);
		const ownership = await BrokerOwnerLock.acquire(brokerStorageUri.fsPath, {
			instanceId: windowInstanceId,
		});
		const ownershipCleanup = addApplicationCleanup(cleanup, () => ownership.dispose(), true);
		const changeEvents = new vscode.EventEmitter<void>();
		let profile: DeviceProfile | undefined;
		let currentOwnerRuntime: ProductionBrokerRuntime | undefined;
		let lifecycle!: BrokerLifecycle<ProductionBrokerRuntime>;
		lifecycle = new BrokerLifecycle(
			ownership,
			async (generation) => {
				delegatedToolInvocations.clear();
				const ownerRuntime = await ProductionBrokerRuntime.create({
					vscodeApi: vscode,
					context,
					storageRootUri: brokerStorageUri,
					rawState,
					secrets,
					ownership,
					generation,
					identityFor: (deviceId) =>
						createLocalBrokerIdentity(brokerStorageUri, deviceId),
					guard,
					workerPlatform,
					logger,
					onDidChange: () => changeEvents.fire(),
					onDisposed: (disposed) => {
						delegatedToolInvocations.clear();
						if (currentOwnerRuntime === disposed) {
							currentOwnerRuntime = undefined;
						}
					},
				});
				currentOwnerRuntime = ownerRuntime;
				profile = ownerRuntime.profile;
				changeEvents.fire();
				return ownerRuntime;
			},
		);
		ownershipCleanup.dispose = () => lifecycle.dispose();
		await lifecycle.start().catch((error: unknown) => {
			logger.error(
				'broker',
				'Initial Broker ownership startup failed; bounded lifecycle retry remains active.',
				error,
			);
			void reportPeerStartup?.('BROKER_RUNTIME_START_FAILED');
		});

		const [sharedProfile, brokerKey] = await Promise.all([
			waitForDeviceProfile(rawState, environment),
			waitForBrokerKey(secrets),
		]);
		profile = sharedProfile;
		const nodeLabel = windowNodeLabel(nodeId);
		const runtimeApproval = new VscodeLocalTaskApproval(vscode, rawState, e2eCapability);
		const runtimeApprovalCapabilities = new AgentRuntimeApprovalCapabilityIssuer();
		const nodeConfirmation = new VscodeWindowNodeTaskConfirmation(vscode, e2eCapability);
		let runtime!: ReturnType<typeof createVscodeAgentRuntime>;
		let sourceStatusSubscription: { dispose(): void } | undefined;
		const nodeIdentity = createLocalBrokerIdentity(
			brokerStorageUri,
			sharedProfile.deviceId,
		);
		let nodeStartupComplete = false;
		const node = new WindowNodeClient({
			nodeId,
			nodeInstanceId,
			label: nodeLabel,
			capabilities: ['agentRuntime', 'tasks'],
			identity: nodeIdentity,
			brokerKey,
			executor: ({ workspaceResolver, eventSink }) => {
				sourceStatusSubscription?.dispose();
				runtime = createVscodeAgentRuntime(
					vscode,
					context,
					workspaceResolver,
					guard,
					runtimeApproval,
					workerPlatform,
					delegatedToolInvocations,
					runtimeApprovalCapabilities,
					peerDelegationRecorder,
					peerDelegationRun === undefined
						? undefined
						: join(peerDelegationRun.controlRoot, 'agent-host'),
					peerDelegationRun === undefined
						? undefined
						: join(peerDelegationRun.controlRoot, 'editor-proxy'),
					peerDelegationRun?.nodeExecutable,
				);
				sourceStatusSubscription = runtime.onDidSourceStatusChange(() => changeEvents.fire());
				return new WindowNodeTaskExecutor({
					nodeId,
					nodeInstanceId,
					nodeLabel,
					runtime,
					workspaceResolver,
					confirmationHost: nodeConfirmation,
					approvalCapabilities: runtimeApprovalCapabilities,
					eventSink,
					ids: { next: randomUUID },
					clock: { now: () => new Date() },
				});
			},
			workspaceSource: () => {
				guard.assertAllowed({ requireWorkspace: false });
				const capabilityTags = vscode.workspace
					.getConfiguration('copilotAgentMesh')
					.get<readonly string[]>('workspace.capabilityTags', []);
				return (vscode.workspace.workspaceFolders ?? [])
					.filter((folder) => folder.uri.scheme === 'file')
					.map((folder) => ({
						localUri: folder.uri.toString(),
						name: boundUtf8(folder.name, 256),
						capabilityTags: capabilityTags
							.map((tag) => boundUtf8(tag.trim(), 64))
							.filter((tag) => tag.length > 0),
					}));
			},
			onError: (error) => {
				logger.error(
					'window-node',
					'The Window Node is reconnecting to the local Device Broker.',
					error,
				);
				if (!nodeStartupComplete) {
					void reportPeerStartup?.(peerStartupCode(error));
				}
			},
		});
		addApplicationCleanup(cleanup, () => node.dispose(), true);
		addApplicationCleanup(cleanup, () => changeEvents.dispose());
		addApplicationCleanup(cleanup, () => sourceStatusSubscription?.dispose());
		await node.start();
		nodeStartupComplete = true;
		const remoteTasks = new LocalIpcRemoteTaskAdapter(node);
		addApplicationCleanup(cleanup, () => remoteTasks.dispose());
		const localTasks = new LocalBrokerTaskFacade(node, {
			deviceName: () =>
				currentOwnerRuntime?.device.current().name
				?? profile?.name
				?? sharedProfile.name,
			remoteAdapter: remoteTasks,
			sourceWorkspaceIdentity: () => node.delegationSourceScopeIdentity(),
		});
		const bindings = new ProductionDashboardBindings({
			vscodeApi: vscode,
			changed: changeEvents,
			profile: () => {
				const ownerProfile = currentOwnerRuntime?.device.current();
				if (ownerProfile !== undefined) {
					profile = ownerProfile;
				} else {
					const persisted = new DeviceProfileStore(
						rawState,
						{ next: randomUUID },
						{ now: () => new Date() },
					).get();
					profile = persisted ?? profile;
				}
				if (profile === undefined) {
					throw new Error('The shared Device profile is unavailable.');
				}
				return profile;
			},
			node,
			localTasks,
			remoteTasks,
			runtime: () => runtime,
			guard,
			workerPlatform,
			lifecycle,
			ownerRuntime: () => currentOwnerRuntime,
		});
		addApplicationCleanup(cleanup, () => bindings.dispose());
		const dashboardFacade = new ServiceDashboardFacade(bindings);
		const dashboard = new AgentMeshViewProvider(dashboardFacade, context.extensionUri);
		addApplicationCleanup(cleanup, () => dashboard.dispose());
		const gatedE2e = createTwoDeviceE2eApi({
			vscodeApi: vscode,
			bindings,
			node,
			localTasks,
			remoteTasks,
			runtime,
			lifecycle,
			ownerRuntime: () => currentOwnerRuntime,
			capability: e2eCapability,
			localIpcEndpoint: deriveLocalIpcEndpoint(nodeIdentity),
		});
		const twoDeviceE2e = requestedE2eScenario === 'twoDevice'
			? gatedE2e
			: undefined;
		const multiWindowE2e = requestedE2eScenario === 'multiWindow'
			? gatedE2e
			: undefined;
		const peerDelegationE2e = requestedE2eScenario === 'peerDelegation'
			&& peerDelegationRun !== undefined
			&& peerDelegationRecorder !== undefined
			&& peerDelegationToolClock !== undefined
			? createPeerDelegationE2eApi({
				vscodeApi: vscode,
				bindings,
				node,
				localTasks,
				remoteTasks,
				runtime,
				lifecycle,
				ownerRuntime: () => currentOwnerRuntime,
				capability: e2eCapability,
				localIpcEndpoint: deriveLocalIpcEndpoint(nodeIdentity),
				recorder: peerDelegationRecorder,
				toolClock: peerDelegationToolClock,
				editorProxyRoot: join(peerDelegationRun.controlRoot, 'editor-proxy'),
				editorProxyNodeExecutable: peerDelegationRun.nodeExecutable,
			})
			: undefined;
		let meshTools: vscode.Disposable | undefined;
		const syncMeshTools = (): void => {
			const enabled = vscode.workspace.getConfiguration('copilotAgentMesh')
				.get<boolean>('experimental.peerDelegation', false);
			if (enabled && meshTools === undefined) {
				meshTools = peerDelegationRecorder === undefined
					? registerMeshTaskTools(localTasks, { delegatedToolInvocations })
					: registerMeshTaskTools(localTasks, {
						delegatedToolInvocations,
						clock: peerDelegationToolClock,
						observer: peerDelegationRecorder,
					});
			} else if (!enabled && meshTools !== undefined) {
				meshTools.dispose();
				meshTools = undefined;
			}
		};
		syncMeshTools();
		contributions.push(
			{ dispose: () => meshTools?.dispose() },
			vscode.window.registerWebviewViewProvider(AgentMeshViewProvider.viewType, dashboard),
			...registerCommands(
				dashboardFacade,
				dashboard,
				bindings,
				guard,
				logger,
			),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				void node.refreshWorkspaces().then(
					() => changeEvents.fire(),
					(error: unknown) => logger.error(
						'window-node',
						'Window workspace claims will refresh after Broker reconnection.',
						error,
					),
				);
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('copilotAgentMesh.experimental.peerDelegation')
				) {
					syncMeshTools();
					changeEvents.fire();
				}
				if (
					event.affectsConfiguration('copilotAgentMesh.workspace.capabilityTags')
				) {
					void node.refreshWorkspaces().catch((error: unknown) => {
						logger.error(
							'window-node',
							'Window workspace capabilities could not be refreshed.',
							error,
						);
					});
				}
			}),
		);
		context.subscriptions.push(...contributions);
		logger.log('info', 'application', 'Copilot Agent Mesh multi-window application started.', {
			protocolVersion: sharedProfile.protocolVersion,
			brokerRole: lifecycle.snapshot().owner ? 'owner' : 'contender',
			nodeId,
			nodeInstanceId,
		});

		let disposal: Promise<void> | undefined;
		const api: AgentMeshExtensionApi = {
			get agentRuntime() {
				return runtime;
			},
			node,
			nodeId,
			nodeInstanceId,
			brokerLifecycle: lifecycle,
			nodeState: () => node.snapshot(),
			brokerState: () => lifecycle.snapshot(),
			get coordinator() {
				return currentOwnerRuntime?.coordinator;
			},
			get workerTasks() {
				return currentOwnerRuntime?.brokerTasks;
			},
			get listener() {
				return currentOwnerRuntime?.listener;
			},
			...(twoDeviceE2e === undefined ? {} : { twoDeviceE2e }),
			...(multiWindowE2e === undefined ? {} : { multiWindowE2e }),
			...(peerDelegationE2e === undefined ? {} : { peerDelegationE2e }),
		};
		return {
			api,
			dispose: () => {
				if (cleanupState.complete) {
					return Promise.resolve();
				}
				if (disposal === undefined) {
					let attempt!: Promise<void>;
					attempt = disposeApplicationResources(
						contributions,
						cleanup,
						logger,
						cleanupState,
					).finally(() => {
						if (!cleanupState.complete && disposal === attempt) {
							disposal = undefined;
						}
					});
					disposal = attempt;
				}
				return disposal;
			},
		};
	} catch (error: unknown) {
		try {
			await disposeApplicationResources(contributions, cleanup, logger, cleanupState);
		} catch (cleanupError: unknown) {
			throw activationRollbackFailure(error, cleanupError);
		}
		throw error;
	}
}

function registerCommands(
	facade: DashboardFacade,
	dashboard: AgentMeshViewProvider,
	bindings: ProductionDashboardBindings,
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
		} catch (error: unknown) {
			logger.error('command', `Command ${id} failed.`, error);
			await vscode.window.showErrorMessage(
				error instanceof Error ? error.message : 'The command failed.',
			);
		}
	});
	const selectTarget = async (
		kind: 'workspace' | 'peer',
	): Promise<string | undefined> => {
		const snapshot = await facade.getSnapshot();
		const values = kind === 'workspace'
			? snapshot.workspaces.map((item) => ({ label: item.name, id: item.workspaceId }))
			: snapshot.peers.map((item) => ({ label: item.name, id: item.peerId }));
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
				await bindings.setWorkspaceEnabled(id, true);
				dashboard.refresh();
			}
		}),
		register(APPLICATION_COMMANDS.disableWorkspace, true, async (value) => {
			const id = opaqueId(value) ?? await selectTarget('workspace');
			if (id !== undefined) {
				await bindings.setWorkspaceEnabled(id, false);
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
		register(APPLICATION_COMMANDS.runTask, false, (value) =>
			facade.runTask(dashboardTarget(value))),
		register(APPLICATION_COMMANDS.cancelTask, false, async (value) => {
			const id = opaqueId(value);
			if (id !== undefined) {
				await facade.cancelTask(id);
				return;
			}
			const snapshot = await facade.getSnapshot();
			const candidates = [
				...(snapshot.outgoingTasks ?? []).flatMap((task) =>
					task.actionHandle === undefined ? [] : [{
						label: task.title,
						description: `Outgoing · ${task.counterpartLabel}`,
						actionHandle: task.actionHandle,
						direction: 'outgoing' as const,
					}]
				),
				...(snapshot.incomingTasks ?? []).flatMap((task) =>
					task.actionHandle === undefined ? [] : [{
						label: task.title,
						description: `Incoming · ${task.counterpartLabel}`,
						actionHandle: task.actionHandle,
						direction: 'incoming' as const,
					}]
				),
			];
			const selected = await vscode.window.showQuickPick(candidates, {
				title: 'Select task',
				ignoreFocusOut: true,
			});
			if (selected !== undefined) {
				await facade.cancelDashboardTask(selected.actionHandle, selected.direction);
			}
		}),
	];
}

function opaqueId(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (
		typeof value === 'object'
		&& value !== null
		&& 'id' in value
		&& typeof value.id === 'string'
	) {
		return value.id;
	}
	return undefined;
}

function dashboardTarget(value: unknown): DashboardTaskTarget | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record.deviceId !== 'string'
		|| typeof record.nodeId !== 'string'
		|| typeof record.nodeInstanceId !== 'string'
		|| typeof record.workspaceId !== 'string'
		|| (record.peerId !== undefined && typeof record.peerId !== 'string')
	) {
		return undefined;
	}
	return {
		deviceId: record.deviceId,
		nodeId: record.nodeId,
		nodeInstanceId: record.nodeInstanceId,
		workspaceId: record.workspaceId,
		...(record.peerId === undefined ? {} : { peerId: record.peerId }),
	};
}

function windowNodeLabel(nodeId: string): string {
	const workspaceName = vscode.workspace.name?.trim();
	const base = workspaceName === undefined || workspaceName.length === 0
		? 'VS Code'
		: workspaceName;
	return boundUtf8(`${base} Window ${nodeId.slice(0, 8)}`, 256);
}

function boundUtf8(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maximumBytes) {
		return value;
	}
	let result = '';
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, 'utf8');
		if (bytes + size > maximumBytes) {
			break;
		}
		result += character;
		bytes += size;
	}
	return result;
}

function supportedPlatform(platform: NodeJS.Platform): 'win32' | 'darwin' | 'linux' {
	if (platform === 'win32' || platform === 'darwin' || platform === 'linux') {
		return platform;
	}
	throw new Error(`Copilot Agent Mesh does not support platform ${platform}.`);
}

type E2eScenario = 'twoDevice' | 'multiWindow' | 'peerDelegation';

function selectE2eScenario(requested: Readonly<Record<E2eScenario, boolean>>): E2eScenario | undefined {
	const selected = (Object.entries(requested) as Array<[E2eScenario, boolean]>)
		.filter(([, enabled]) => enabled)
		.map(([scenario]) => scenario);
	return selected.length === 1 ? selected[0] : undefined;
}

function peerDelegationBudgetMs(): number {
	const raw = process.env.MESH_PEER_DELEGATION_E2E_BUDGET_MS ?? '10000';
	if (!/^[0-9]{3,5}$/u.test(raw)) {
		throw new Error('MESH_PEER_DELEGATION_E2E_BUDGET_MS must be an integer from 500 to 30000.');
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 500 || value > 30_000) {
		throw new Error('MESH_PEER_DELEGATION_E2E_BUDGET_MS must be an integer from 500 to 30000.');
	}
	return value;
}

function peerDelegationRunContext(nonce: string | undefined): {
	readonly nonce: string;
	readonly controlRoot: string;
	readonly nodeExecutable: string;
} {
	if (nonce === undefined) {
		throw new Error('The peer-delegation E2E nonce is unavailable after capability validation.');
	}
	const controlRoot = process.env.MESH_PEER_DELEGATION_E2E_CONTROL_DIR;
	if (controlRoot === undefined || !isAbsolute(controlRoot)) {
		throw new Error('The peer-delegation E2E control directory must be absolute.');
	}
	const nodeExecutable = process.env.MESH_PEER_DELEGATION_E2E_NODE_EXECUTABLE;
	if (nodeExecutable === undefined || !isAbsolute(nodeExecutable)) {
		throw new Error('The peer-delegation E2E Node executable must be absolute.');
	}
	return { nonce, controlRoot, nodeExecutable };
}

function peerDelegationStartupReporter(
	controlRoot: string,
	windowId: string,
): ((code: MultiWindowStartupDiagnosticCode) => Promise<void>) | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (folders?.length !== 1 || folders[0].uri.scheme !== 'file') {
		return undefined;
	}
	const workspaceBasename = basename(folders[0].uri.fsPath);
	return async (code) => {
		try {
			await writeMultiWindowStartupDiagnostic({
				controlRoot,
				workspaceBasename,
				windowId,
				code,
			});
		} catch {
			process.emitWarning(
				'The peer-delegation E2E startup diagnostic could not be recorded.',
				{ code: 'MESH_PEER_DELEGATION_E2E_DIAGNOSTIC_FAILED' },
			);
		}
	};
}

function peerStartupCode(error: Error): MultiWindowStartupDiagnosticCode {
	if ('code' in error && (error.code === 'WORKSPACE_BUSY' || error.code === 'WORKSPACE_NOT_FOUND')) {
		return error.code;
	}
	return 'WINDOW_NODE_CONNECT_FAILED';
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
