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
import { CONNECTIVITY_ACTIONS } from '../../shared/protocol';

const connectivityActions = new Set<string>(CONNECTIVITY_ACTIONS);

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
}

export const DASHBOARD_COMMANDS = {
	configureDevice: 'copilotAgentMesh.configureDevice',
	refresh: 'copilotAgentMesh.refreshDashboard',
} as const;

export class AgentMeshViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'copilotAgentMesh.dashboard';

	private readonly instances = new Map<string, ViewInstance>();
	private readonly presenter = new DashboardPresenter();
	private readonly extensionUri: vscode.Uri;

	public constructor(
		private readonly facade: DashboardFacade = new UnavailableDashboardFacade(),
		extensionUri?: vscode.Uri,
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
		if (instance.pendingActions.has(message.action)
			|| (connectivityActions.has(message.action)
				&& [...instance.pendingActions].some((action) => connectivityActions.has(action)))) {
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
		switch (message.action) {
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
			case 'refreshDiscovery':
			case 'configureRemotePolicy':
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
				const model = this.presenter.present(await this.facade.getSnapshot());
				if (instance.disposed) {
					return;
				}
				if (revision === instance.requestedRevision) {
					const scopedModel = this.scopeActions(instance, model);
					const message: DashboardOutboundMessage = {
						version: DASHBOARD_MESSAGE_VERSION,
						uiInstanceId: instance.id,
						type: 'dashboard.snapshot',
						model: scopedModel,
					};
					await this.safePost(instance, message);
				}
			} catch {
				if (revision === instance.requestedRevision) {
					instance.actions.clear();
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
			message,
		});
	}

	private async safePost(instance: ViewInstance, message: DashboardOutboundMessage): Promise<void> {
		if (instance.disposed) {
			return;
		}
		const outbound: DashboardOutboundMessage = { ...message, pendingActions: [...instance.pendingActions] };
		assertSafeDashboardOutboundMessage(outbound);
		await instance.view.webview.postMessage(outbound);
	}

	private disposeInstance(instance: ViewInstance): void {
		if (instance.disposed) {
			return;
		}
		instance.disposed = true;
		instance.actions.clear();
		this.instances.delete(instance.id);
		for (const subscription of instance.subscriptions.splice(0)) {
			subscription.dispose();
		}
	}

	private scopeActions(instance: ViewInstance, model: DashboardViewModel): DashboardViewModel {
		const stableTaskAliases = new Map<string, string>();
		for (const [uiHandle, action] of instance.actions) {
			if (
				action.action === 'cancelOutgoingTask'
				|| action.action === 'cancelIncomingTask'
			) {
				stableTaskAliases.set(`${action.action}:${action.brokerHandle}`, uiHandle);
			}
		}
		instance.actions.clear();
		const scope = (
			action: DashboardAction,
			brokerHandle: string | undefined,
			options: {
				readonly stable?: boolean;
				readonly requiredEnabled?: boolean;
			} = {},
		): string | undefined => {
			if (brokerHandle === undefined) {
				return undefined;
			}
			let handle = options.stable
				? stableTaskAliases.get(`${action}:${brokerHandle}`)
				: undefined;
			if (handle === undefined) {
				do {
					handle = randomBytes(24).toString('base64url');
				} while (instance.actions.has(handle));
			}
			instance.actions.set(handle, {
				action,
				brokerHandle,
				...(options.requiredEnabled === undefined
					? {}
					: { requiredEnabled: options.requiredEnabled }),
			});
			return handle;
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
				actionHandle: scope('cancelOutgoingTask', task.actionHandle, { stable: true }),
			})),
			incomingTasks: model.incomingTasks.map((task) => ({
				...task,
				actionHandle: scope('cancelIncomingTask', task.actionHandle, { stable: true }),
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
		return action;
	}
}

export function createDashboardHtml(
	webview: vscode.Webview,
	mediaRoot: vscode.Uri,
	uiInstanceId: string,
	nonce: string,
): string {
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'dashboard.js'));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'dashboard.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styleUri}">
	<title>Copilot Agent Mesh</title>
</head>
<body data-ui-instance-id="${uiInstanceId}">
	<header><h1>Copilot Agent Mesh</h1><button data-action="refresh" title="Refresh local status without account discovery">Refresh</button></header>
	<p id="operationStatus" class="detail"></p>
	<main>
		<section aria-labelledby="device-heading"><h2 id="device-heading">This Device</h2><div id="device" class="card loading">Loading...</div></section>
		<section aria-labelledby="this-window-heading"><h2 id="this-window-heading">This Window</h2><div id="thisWindow" class="card loading">Loading...</div></section>
		<section aria-labelledby="accept-heading"><h2 id="accept-heading">Accept Incoming Tasks</h2><div id="acceptIncoming" class="card loading">Loading...</div></section>
		<section aria-labelledby="listener-heading"><h2 id="listener-heading">Listener</h2><div id="listener" class="card loading">Loading...</div></section>
		<section class="connectivity" aria-labelledby="connectivity-heading">
			<h2 id="connectivity-heading">Cross-device</h2>
			<p class="detail">Microsoft Dev Tunnels account discovery is off by default. Rendering or refreshing this Dashboard reads local status only; it does not sign in, discover devices, or start hosting.</p>
			<div id="connectivity" class="card loading">Loading...</div>
			<h3 id="candidates-heading">Discovery candidates — not workers</h3>
			<p class="detail">Discovery is not pairing or permission to run tasks. Pair explicitly, configure directional Workspace grants, and enable the target receive gate before using Mesh Tools. Host hints do not establish worker readiness.</p>
			<div id="discoveryCandidates" class="stack loading" aria-labelledby="candidates-heading">Loading...</div>
			<h3 id="incoming-peers-heading">Incoming peers on this device</h3>
			<p class="detail">Revoke a peer here to withdraw this device's incoming admission. Source Workspace grants are managed separately in remote policy.</p>
			<div id="incomingPeers" class="stack loading" aria-labelledby="incoming-peers-heading">Loading...</div>
		</section>
		<section aria-labelledby="nodes-heading"><h2 id="nodes-heading">Local Window Nodes</h2><p class="detail">A checked box authorizes only this Workspace to delegate to that target. The target must also accept incoming tasks and have one claimed Workspace before it appears to Mesh Tools.</p><div id="localNodes" class="stack loading">Loading...</div></section>
		<section aria-labelledby="saved-authorizations-heading"><h2 id="saved-authorizations-heading">Saved Authorizations</h2><p class="detail">Offline Workspaces are not live Window Nodes. Remove a saved authorization here, or reopen that Workspace to manage it under Local Window Nodes.</p><div id="savedAuthorizations" class="stack loading">Loading...</div></section>
		<section aria-labelledby="outgoing-heading"><h2 id="outgoing-heading">Outgoing Tasks</h2><div id="outgoingTasks" class="stack loading">Loading...</div></section>
		<section aria-labelledby="incoming-heading"><h2 id="incoming-heading">Incoming Tasks</h2><div id="incomingTasks" class="stack loading">Loading...</div></section>
		<section aria-labelledby="errors-heading"><h2 id="errors-heading">Errors</h2><div id="errors" class="stack"></div></section>
	</main>
	<div id="announcement" role="status" aria-live="polite"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
