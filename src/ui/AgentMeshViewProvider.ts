import { randomBytes, randomUUID } from 'crypto';

import * as vscode from 'vscode';

import {
	DashboardActionError,
	DashboardFacade,
	UnavailableDashboardFacade,
} from './DashboardFacade';
import {
	assertSafeDashboardOutboundMessage,
	DASHBOARD_MESSAGE_VERSION,
	DashboardInboundMessage,
	DashboardOutboundMessage,
	DashboardOutboundErrorCode,
	type DashboardAction,
	parseDashboardInboundMessage,
} from './DashboardMessages';
import { DashboardPresenter, type DashboardViewModel } from './DashboardPresenter';
import {
	CONNECTIVITY_ACTIONS,
	DISABLED_CONNECTIVITY_SNAPSHOT,
	REMOTE_POLICY_ACTIONS,
	DASHBOARD_MANAGEMENT_ACTIONS,
	type DashboardManagementAction,
} from '../../shared/protocol';
import { createDashboardHtml as renderDashboardHtml } from './DashboardHtml';
import { createDashboardActionHandle } from './DashboardActionHandle';
import { snapshotActionIssuer } from './SnapshotActionIssuer';

const promptActions = new Set<string>([...CONNECTIVITY_ACTIONS, ...REMOTE_POLICY_ACTIONS, ...DASHBOARD_MANAGEMENT_ACTIONS]
	.filter((action) => action !== 'disableConnectivity'));
const managementActions = new Set<string>(DASHBOARD_MANAGEMENT_ACTIONS);
const localNavigationActions = new Set<DashboardAction>(['refresh', 'openAdvancedSettings']);
const unavailableReadCodes = new Set([
	'LOCAL_BROKER_UNAVAILABLE', 'CONNECTIVITY_UNAVAILABLE', 'REMOTE_DIRECTORY_UNAVAILABLE',
	'DASHBOARD_TASKS_UNAVAILABLE', 'MANAGEMENT_UNAVAILABLE', 'PEER_POLICY_UNAVAILABLE',
	'PEER_CANDIDATES_UNAVAILABLE', 'REMOTE_POLICY_UNAVAILABLE',
]);
// Reserved display-only notices use the existing errors field; service snapshots cannot supply them.
const displayNoticeCodes = new Set(['DASHBOARD_REFRESHING', 'DASHBOARD_RECONNECTING', 'DASHBOARD_CONNECTING']);
export const DASHBOARD_REFRESH_GRACE_MS = 10_000;

interface ScopedDashboardAction {
	readonly action: DashboardAction;
	readonly brokerHandle: string;
	readonly requiredEnabled?: boolean;
}

interface ViewInstance {
	readonly id: string;
	readonly view: vscode.WebviewView;
	readonly subscriptions: vscode.Disposable[];
	disposed: boolean;
	readonly pendingActions: Set<DashboardAction>;
	requestedRevision: number;
	publishedRevision: number;
	publication: Promise<void> | undefined;
	readonly actions: Map<string, ScopedDashboardAction>;
	authoritative: boolean;
	// Validated Webview data only. It is never fed back into action scoping or the facade.
	lastKnownModel: DashboardViewModel | undefined;
	refreshDisplay: {
		model: DashboardViewModel;
		readonly hasLastKnown: boolean;
		timer: vscode.Disposable | undefined;
	} | undefined;
}

export const DASHBOARD_COMMANDS = {
	configureDevice: 'copilotAgentMesh.configureDevice',
	refresh: 'copilotAgentMesh.refreshDashboard',
} as const;

export const DASHBOARD_CONNECTIONS_CONTEXT = 'copilotAgentMesh.connectionsEnabled';

export class AgentMeshViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'copilotAgentMesh.dashboard';

	private readonly instances = new Map<string, ViewInstance>();
	private readonly presenter = new DashboardPresenter();
	private readonly extensionUri: vscode.Uri;
	private connectionPreference: boolean | undefined;
	private pendingConnectionPreference: { readonly instance: ViewInstance; readonly enabled: boolean } | undefined;
	private connectionContextUpdate: Promise<void> | undefined;

	public constructor(
		private readonly facade: DashboardFacade = new UnavailableDashboardFacade(),
		extensionUri?: vscode.Uri,
		private readonly setConnectionContext: (enabled: boolean) => Thenable<unknown> = (enabled) =>
			vscode.commands.executeCommand('setContext', DASHBOARD_CONNECTIONS_CONTEXT, enabled),
		private readonly scheduleDisplayNotice: (callback: () => void, delayMs: number) => vscode.Disposable =
			(callback, delayMs) => {
				const timer = setTimeout(callback, delayMs);
				return new vscode.Disposable(() => clearTimeout(timer));
			},
	) {
		this.extensionUri = extensionUri ?? getOwnExtensionUri();
	}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		for (const existing of this.instances.values()) {
			if (existing.view === webviewView) {
				this.disposeInstance(existing);
			}
		}
		const instance: ViewInstance = {
			id: randomUUID(),
			view: webviewView,
			subscriptions: [],
			disposed: false,
			pendingActions: new Set(),
			requestedRevision: 0,
			publishedRevision: 0,
			publication: undefined,
			actions: new Map(),
			authoritative: false,
			lastKnownModel: undefined,
			refreshDisplay: undefined,
		};
		this.instances.set(instance.id, instance);

		const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [mediaRoot],
		};
		webviewView.webview.html = createDashboardHtml(
			webviewView.webview,
			mediaRoot,
			instance.id,
			randomBytes(16).toString('base64'),
		);
		instance.subscriptions.push(
			webviewView.webview.onDidReceiveMessage((message: unknown) => {
				void this.receive(instance, message);
			}),
			webviewView.onDidDispose(() => this.disposeInstance(instance)),
			this.facade.onDidChange(() => {
				void this.publish(instance);
			}),
		);
	}

	public refresh(): void {
		for (const instance of this.instances.values()) {
			void this.publish(instance);
		}
	}

	public dispose(): void {
		for (const instance of [...this.instances.values()]) {
			this.disposeInstance(instance);
		}
	}

	private async receive(instance: ViewInstance, value: unknown): Promise<void> {
		if (instance.disposed) {
			return;
		}
		const message = parseDashboardInboundMessage(value);
		if (message === undefined || message.uiInstanceId !== instance.id) {
			await this.postError(instance, 'INVALID_MESSAGE', 'The dashboard rejected an invalid message.');
			return;
		}
		if (message.type === 'ready') {
			await this.publish(instance);
			return;
		}
		if (!instance.authoritative && !localNavigationActions.has(message.action)) {
			await this.postError(instance, 'STALE_ACTION', 'This Dashboard action is stale. Refresh and try again.');
			return;
		}
		if (instance.pendingActions.has(message.action)
			|| (promptActions.has(message.action)
				&& [...instance.pendingActions].some((action) => promptActions.has(action)))) {
			await this.postError(instance, 'ACTION_FAILED', 'This Dashboard action is already in progress. Task cancellation remains available.');
			return;
		}
		instance.pendingActions.add(message.action);
		try {
			await this.dispatch(instance, message);
		} catch (error: unknown) {
			if (error instanceof DashboardActionError) {
				await this.postError(instance, error.code, error.message);
			} else {
				await this.postError(
					instance,
					'ACTION_FAILED',
					'The dashboard action failed. Refresh for the latest service error and suggested action.',
				);
			}
		} finally {
			instance.pendingActions.delete(message.action);
			await this.publish(instance);
		}
	}

	private async dispatch(
		instance: ViewInstance,
		message: Extract<DashboardInboundMessage, { type: 'action' }>,
	): Promise<void> {
		if (isManagementAction(message.action)) {
			const binding = this.consumeAction(instance, message);
			if (this.facade.managementAction === undefined) {
				throw new DashboardActionError('POLICY_FORBIDDEN', 'Device and Workspace settings are unavailable.');
			}
			await this.facade.managementAction(message.action, binding.brokerHandle, message.enabled);
			return;
		}
		switch (message.action) {
			case 'openAdvancedSettings':
				await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:weivea.copilot-agent-mesh');
				return;
			case 'registerWorkspace':
				await this.facade.registerCurrentWorkspace();
				return;
			case 'configureDevice':
				await this.facade.configureDeviceName();
				return;
			case 'renameWindow':
				await this.facade.renameCurrentWindow();
				return;
			case 'startListener':
				await this.facade.startListener();
				return;
			case 'stopListener':
				await this.facade.stopListener();
				return;
			case 'copyConnectionUrl':
				await this.facade.copyConnectionUrl();
				return;
			case 'setAcceptIncoming': {
				const action = this.consumeAction(instance, message);
				await this.facade.setAcceptIncoming(action.brokerHandle, requireEnabled(message));
				return;
			}
			case 'setPeerAllowed': {
				const action = this.consumeAction(instance, message);
				const enabled = requireEnabled(message);
				if (action.requiredEnabled !== undefined && action.requiredEnabled !== enabled) {
					throw new DashboardActionError(
						'POLICY_FORBIDDEN',
						'An offline saved authorization can only be removed.',
					);
				}
				await this.facade.setPeerAllowed(action.brokerHandle, enabled);
				return;
			}
			case 'openTargetChat': {
				const action = this.consumeAction(instance, message);
				if (this.facade.openTargetChat === undefined) {
					throw new Error('Target Chat is unavailable.');
				}
				await this.facade.openTargetChat(action.brokerHandle);
				return;
			}
			case 'setRemoteAutoAccept':
			case 'setRemoteReceive':
			case 'setRemoteAllowed': {
				const action = this.consumeAction(instance, message);
				if (this.facade.remotePolicyAction === undefined) {
					throw new Error('Remote Workspace policy is unavailable.');
				}
				await this.facade.remotePolicyAction(message.action, action.brokerHandle, requireEnabled(message));
				return;
			}
			case 'cancelOutgoingTask': {
				const action = this.consumeAction(instance, message);
				await this.facade.cancelDashboardTask(action.brokerHandle, 'outgoing');
				return;
			}
			case 'cancelIncomingTask': {
				const action = this.consumeAction(instance, message);
				await this.facade.cancelDashboardTask(action.brokerHandle, 'incoming');
				return;
			}
			case 'configureConnectivity':
			case 'enableConnectivity':
			case 'disableConnectivity':
			case 'refreshDiscovery':
			case 'configureRemotePolicy':
			case 'refreshRemoteTargets':
			case 'retryConnectivityCleanup':
				await this.facade.connectivityAction(message.action);
				return;
			case 'pairDiscoveredPeer':
			case 'revokeIncomingPeer': {
				const action = this.consumeAction(instance, message);
				await this.facade.connectivityAction(message.action, action.brokerHandle);
				return;
			}
			case 'refresh':
				return;
		}
	}

	private async publish(instance: ViewInstance): Promise<void> {
		if (instance.disposed) {
			return;
		}
		const targetRevision = ++instance.requestedRevision;
		while (!instance.disposed && instance.publishedRevision < targetRevision) {
			if (instance.publication === undefined) {
				instance.publication = this.drainPublications(instance);
			}
			const publication = instance.publication;
			await publication;
			if (instance.publication === publication) {
				instance.publication = undefined;
			}
		}
	}

	private async drainPublications(instance: ViewInstance): Promise<void> {
		while (!instance.disposed && instance.publishedRevision < instance.requestedRevision) {
			const revision = instance.requestedRevision;
			try {
				await this.beginRefresh(instance);
				if (instance.disposed) { return; }
				const model = this.presenter.present(await this.facade.getSnapshot());
				if (instance.disposed) {
					return;
				}
				if (revision === instance.requestedRevision) {
					const display = instance.refreshDisplay!;
					const unavailable = model.errors.some((error) => unavailableReadCodes.has(error.code));
					const actions = new Map<string, ScopedDashboardAction>();
					const scopedModel = this.scopeActions(actions, model,
						instance.authoritative && !unavailable ? instance.actions : undefined);
					const message: DashboardOutboundMessage = {
						version: DASHBOARD_MESSAGE_VERSION,
						uiInstanceId: instance.id,
						type: 'dashboard.snapshot',
						model: scopedModel,
					};
					assertSafeDashboardOutboundMessage(message);
					if (scopedModel.errors.some((error) => displayNoticeCodes.has(error.code))) {
						throw new Error('Service snapshots cannot supply display freshness notices.');
					}
					if (unavailable) {
						instance.actions.clear();
						instance.authoritative = false;
						display.timer?.dispose();
						display.timer = undefined;
						display.model = reconnectingDisplayModel(instance.lastKnownModel, scopedModel);
						await this.postRefreshDisplay(instance, display);
					} else {
						this.clearRefreshDisplay(instance);
						instance.lastKnownModel = scopedModel;
						instance.authoritative = true;
						instance.actions.clear();
						for (const [handle, action] of actions) { instance.actions.set(handle, action); }
						await this.safePost(instance, message);
					}
				}
			} catch {
				if (!instance.disposed && revision === instance.requestedRevision) {
					instance.actions.clear();
					instance.authoritative = false;
					instance.lastKnownModel = undefined;
					this.clearRefreshDisplay(instance);
					await this.postError(
						instance,
						'UNSAFE_VIEW_MODEL',
						'The dashboard rejected an invalid service snapshot.',
					);
				}
			}
			instance.publishedRevision = revision;
		}
	}

	private async beginRefresh(instance: ViewInstance): Promise<void> {
		if (instance.refreshDisplay !== undefined) { return; }
		const display: NonNullable<ViewInstance['refreshDisplay']> = {
			model: instance.lastKnownModel ?? emptyDisplayModel(),
			hasLastKnown: instance.lastKnownModel !== undefined,
			timer: undefined,
		};
		instance.refreshDisplay = display;
		display.timer = this.scheduleDisplayNotice(() => {
			if (instance.disposed || instance.refreshDisplay !== display) { return; }
			display.timer?.dispose();
			display.timer = undefined;
			instance.actions.clear();
			instance.authoritative = false;
			void this.postRefreshDisplay(instance, display).catch(() => {
				if (!instance.disposed && instance.refreshDisplay === display) {
					instance.lastKnownModel = undefined;
					this.clearRefreshDisplay(instance);
					void this.postError(instance, 'UNSAFE_VIEW_MODEL', 'The dashboard rejected an invalid service snapshot.');
				}
			});
		}, DASHBOARD_REFRESH_GRACE_MS);
	}

	private async postRefreshDisplay(
		instance: ViewInstance,
		display: NonNullable<ViewInstance['refreshDisplay']>,
	): Promise<void> {
		if (instance.disposed || instance.refreshDisplay !== display) { return; }
		const code = display.hasLastKnown ? 'DASHBOARD_RECONNECTING' : 'DASHBOARD_CONNECTING';
		await this.safePost(instance, {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: instance.id,
			type: 'dashboard.snapshot',
			model: {
				...display.model,
				errors: [...display.model.errors, { code, message: code }],
			},
		});
	}

	private clearRefreshDisplay(instance: ViewInstance): void {
		instance.refreshDisplay?.timer?.dispose();
		instance.refreshDisplay = undefined;
	}

	private async postError(
		instance: ViewInstance,
		code: DashboardOutboundErrorCode,
		message: string,
	): Promise<void> {
		await this.safePost(instance, {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: instance.id,
			type: 'dashboard.error',
			code,
			message: vscode.l10n.t(message),
		});
	}

	private async safePost(instance: ViewInstance, message: DashboardOutboundMessage): Promise<void> {
		if (instance.disposed) {
			return;
		}
		const outbound: DashboardOutboundMessage = { ...message, pendingActions: [...instance.pendingActions] };
		assertSafeDashboardOutboundMessage(outbound);
		if (outbound.type === 'dashboard.snapshot') {
			const { connectivity, errors } = outbound.model;
			// Enable/Disable describes the saved preference, not live transport
			// health. An unread, cached or invalid snapshot cannot change it.
			if (!errors.some((error) => error.code === 'CONNECTIVITY_UNAVAILABLE'
				|| error.code === 'DASHBOARD_SERVICES_UNAVAILABLE'
				|| displayNoticeCodes.has(error.code))) {
				this.queueConnectionPreference(instance, connectivity.enabled);
			}
		}
		await instance.view.webview.postMessage(outbound);
	}

	private queueConnectionPreference(instance: ViewInstance, enabled: boolean): void {
		this.pendingConnectionPreference = { instance, enabled };
		if (this.connectionContextUpdate !== undefined) { return; }
		this.connectionContextUpdate = Promise.resolve().then(async () => {
			while (this.pendingConnectionPreference !== undefined) {
				const current = this.pendingConnectionPreference;
				this.pendingConnectionPreference = undefined;
				if (current.instance.disposed || current.enabled === this.connectionPreference) { continue; }
				try {
					await this.setConnectionContext(current.enabled);
					this.connectionPreference = current.enabled;
				} catch (error: unknown) {
					console.error('Unable to update the Dashboard saved connection preference.', error);
				}
			}
		}).finally(() => {
			this.connectionContextUpdate = undefined;
			const pending = this.pendingConnectionPreference;
			if (pending !== undefined) { this.queueConnectionPreference(pending.instance, pending.enabled); }
		});
	}

	private disposeInstance(instance: ViewInstance): void {
		if (instance.disposed) {
			return;
		}
		instance.disposed = true;
		instance.actions.clear();
		instance.authoritative = false;
		instance.lastKnownModel = undefined;
		this.clearRefreshDisplay(instance);
		this.instances.delete(instance.id);
		for (const subscription of instance.subscriptions.splice(0)) {
			subscription.dispose();
		}
	}

	private scopeActions(
		actions: Map<string, ScopedDashboardAction>,
		model: DashboardViewModel,
		previousActions?: ReadonlyMap<string, ScopedDashboardAction>,
	): DashboardViewModel {
		const issue = snapshotActionIssuer(previousActions, actions, (binding) => {
			const handle = createDashboardActionHandle((candidate) => actions.has(candidate));
			actions.set(handle, binding);
			return handle;
		});
		const scope = (
			action: DashboardAction,
			brokerHandle: string | undefined,
			options: {
				readonly requiredEnabled?: boolean;
			} = {},
		): string | undefined => {
			if (brokerHandle === undefined) {
				return undefined;
			}
			return issue({
				action,
				brokerHandle,
				...(options.requiredEnabled === undefined
					? {}
					: { requiredEnabled: options.requiredEnabled }),
			});
		};
		return {
			...model,
			thisWindow: {
				...model.thisWindow,
				acceptActionHandle: scope(
					'setAcceptIncoming',
					model.thisWindow.acceptActionHandle,
				),
			},
			connectivity: {
				...model.connectivity,
				candidates: model.connectivity.candidates.map((candidate) => ({
					...candidate,
					actionHandle: scope('pairDiscoveredPeer', candidate.actionHandle)!,
				})),
				incomingPeers: model.connectivity.incomingPeers.map((peer) => ({
					...peer,
					actionHandle: scope('revokeIncomingPeer', peer.actionHandle)!,
				})),
			},
			management: {
				...model.management,
				accountActionHandle: scope('switchAccount', model.management.accountActionHandle),
				devices: model.management.devices.map((device) => ({
					...device,
					revokeActionHandle: scope('revokeDevice', device.revokeActionHandle),
					deleteActionHandle: scope('deleteSavedDevice', device.deleteActionHandle),
					probeActionHandle: scope('probeDevice', device.probeActionHandle),
				})),
				workspaces: model.management.workspaces.map((workspace) => ({
					...workspace,
					receiveActionHandle: scope('setWorkspaceReceiving', workspace.receiveActionHandle),
					enableActionHandle: scope('setWorkspaceEnabled', workspace.enableActionHandle),
					removeActionHandle: scope('removeManagedWorkspace', workspace.removeActionHandle),
					incomingPeers: workspace.incomingPeers.map((peer) => ({
						...peer,
						allowActionHandle: scope('setIncomingDeviceGrant', peer.allowActionHandle),
						autoAcceptActionHandle: scope('setDeviceAutoAccept', peer.autoAcceptActionHandle),
					})),
				})),
				targets: model.management.targets.map((target) => ({
					...target,
					allSourcesActionHandle: scope('setWindowTargetAllowed', target.allSourcesActionHandle,
						target.online ? {} : { requiredEnabled: false }),
					sources: target.sources.map((source) => ({
						...source,
						actionHandle: scope('setTargetAllowed', source.actionHandle,
							target.online ? {} : { requiredEnabled: false }),
					})),
				})),
			},
			localNodes: model.localNodes.map((candidate) => ({
				...candidate,
				actionHandle: scope('setPeerAllowed', candidate.actionHandle),
			})),
			savedAuthorizations: model.savedAuthorizations.map((authorization) => ({
				...authorization,
				actionHandle: scope(
					'setPeerAllowed',
					authorization.actionHandle,
					{ requiredEnabled: false },
				)!,
			})),
			outgoingTasks: model.outgoingTasks.map((task) => ({
				...task,
				actionHandle: scope('cancelOutgoingTask', task.actionHandle),
			})),
			incomingTasks: model.incomingTasks.map((task) => ({
				...task,
				actionHandle: scope('cancelIncomingTask', task.actionHandle),
			})),
			deviceTree: model.deviceTree.map((device) => ({
				...device,
				nodes: device.nodes.map((node) => ({
					...node,
					workspaces: node.workspaces.map((workspace) => ({
						...workspace,
						delegateActionHandle: scope('openTargetChat', workspace.delegateActionHandle),
						allowActionHandle: scope(
							device.locality === 'local' ? 'setPeerAllowed' : 'setRemoteAllowed',
							workspace.allowActionHandle,
						),
						receiveActionHandle: scope(
							workspace.receiveAction ?? 'setAcceptIncoming',
							workspace.receiveActionHandle,
						),
						incomingPeers: workspace.incomingPeers.map((peer) => ({
							...peer,
							actionHandle: scope('setRemoteAutoAccept', peer.actionHandle)!,
						})),
					})),
				})),
			})),
		};
	}

	private consumeAction(
		instance: ViewInstance,
		message: Extract<DashboardInboundMessage, { type: 'action' }>,
	): ScopedDashboardAction {
		const handle = message.actionHandle;
		const action = handle === undefined ? undefined : instance.actions.get(handle);
		if (handle !== undefined) {
			instance.actions.delete(handle);
		}
		if (action === undefined || action.action !== message.action) {
			throw new DashboardActionError(
				'STALE_ACTION',
				'This Dashboard action is stale. Refresh and try again.',
			);
		}
		if (action.requiredEnabled !== undefined && action.requiredEnabled !== message.enabled) {
			throw new DashboardActionError('POLICY_FORBIDDEN', 'An offline saved authorization can only be removed.');
		}
		return action;
	}
}

function reconnectingDisplayModel(
	lastKnown: DashboardViewModel | undefined,
	unavailable: DashboardViewModel,
): DashboardViewModel {
	const brokerUnavailable = unavailable.errors.some((error) => error.code === 'LOCAL_BROKER_UNAVAILABLE');
	const connectivityUnavailable = unavailable.errors.some((error) => error.code === 'CONNECTIVITY_UNAVAILABLE');
	const base = lastKnown ?? unavailable;
	return {
		...base,
		listener: unavailable.listener,
		broker: {
			...unavailable.broker,
			error: brokerUnavailable && unavailable.broker.error
				&& (unavailableReadCodes.has(unavailable.broker.error.code) || unavailable.broker.error.code === 'BROKER_UNAVAILABLE')
				? undefined : unavailable.broker.error,
		},
		thisWindow: { ...base.thisWindow, agentHost: unavailable.thisWindow.agentHost },
		connectivity: connectivityUnavailable && lastKnown ? lastKnown.connectivity : {
			...unavailable.connectivity,
			error: brokerUnavailable && connectivityUnavailable && unavailable.connectivity.error === 'DISCOVERY_UNAVAILABLE'
				? undefined : unavailable.connectivity.error,
		},
		errors: unavailable.errors.filter((error) => !brokerUnavailable || !unavailableReadCodes.has(error.code)),
	};
}

function emptyDisplayModel(): DashboardViewModel {
	const component = { state: 'unavailable' as const, label: 'Unavailable' };
	// Only the connecting notice is rendered. No preference or rows have been read for this view.
	return {
		device: {
			name: 'Unavailable', platform: 'Unavailable', architecture: 'Unavailable', workerSupported: false,
			vscodeVersion: 'Unavailable', extensionVersion: 'Unavailable',
		},
		listener: {
			state: 'unavailable', gateway: component, tunnel: component, agentHost: component,
			canStart: false, canStop: false, canCopyConnectionUrl: false,
		},
		broker: { state: 'starting', role: 'contender', takeover: 'waiting', holder: 'none' },
		thisWindow: {
			name: 'Unavailable', workspaceName: 'Unavailable', claimStatus: 'unclaimed', previewEnabled: false,
			canRename: false, acceptsIncoming: false, canSetAcceptIncoming: false,
			agentHost: { source: 'unavailable', label: 'Unavailable', degraded: false },
		},
		connectivity: DISABLED_CONNECTIVITY_SNAPSHOT,
		management: { available: false, truncated: false, devices: [], workspaces: [], targets: [] },
		deviceTree: [], localNodes: [], savedAuthorizations: [], outgoingTasks: [], incomingTasks: [], errors: [],
	};
}

export function createDashboardHtml(
	webview: vscode.Webview,
	mediaRoot: vscode.Uri,
	uiInstanceId: string,
	nonce: string,
): string {
	return renderDashboardHtml(webview, mediaRoot, uiInstanceId, nonce, vscode.env.language);
}

function isManagementAction(action: DashboardAction): action is DashboardManagementAction {
	return managementActions.has(action);
}

function getOwnExtensionUri(): vscode.Uri {
	const extension = vscode.extensions.getExtension('weivea.copilot-agent-mesh');
	if (extension === undefined) {
		throw new Error('Unable to resolve the Copilot Agent Mesh extension URI.');
	}
	return extension.extensionUri;
}

function requireEnabled(
	message: Extract<DashboardInboundMessage, { type: 'action' }>,
): boolean {
	if (typeof message.enabled !== 'boolean') {
		throw new Error(`Dashboard action ${message.action} requires a boolean state.`);
	}
	return message.enabled;
}
