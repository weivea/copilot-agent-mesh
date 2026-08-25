import { randomBytes, randomUUID } from 'crypto';

import * as vscode from 'vscode';

import { DashboardFacade, UnavailableDashboardFacade } from './DashboardFacade';
import {
	assertSafeDashboardOutboundMessage,
	DASHBOARD_MESSAGE_VERSION,
	DashboardInboundMessage,
	DashboardOutboundMessage,
	parseDashboardInboundMessage,
} from './DashboardMessages';
import { DashboardPresenter } from './DashboardPresenter';

interface ViewInstance {
	readonly id: string;
	readonly view: vscode.WebviewView;
	readonly subscriptions: vscode.Disposable[];
	disposed: boolean;
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

		try {
			await this.dispatch(message);
			await this.publish(instance);
		} catch {
			await this.postError(
				instance,
				'ACTION_FAILED',
				'The dashboard action failed. Refresh for the latest service error and suggested action.',
			);
		}
	}

	private async dispatch(message: Extract<DashboardInboundMessage, { type: 'action' }>): Promise<void> {
		switch (message.action) {
			case 'configureDevice':
				await this.facade.configureDeviceName();
				return;
			case 'registerWorkspace':
				await this.facade.registerCurrentWorkspace();
				return;
			case 'removeWorkspace':
				await this.facade.removeWorkspace(requireTarget(message));
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
			case 'addPeer':
				await this.facade.addPeer();
				return;
			case 'removePeer':
				await this.facade.removePeer(requireTarget(message));
				return;
			case 'runTask':
				await this.facade.runTask(message.peerId, message.workspaceId);
				return;
			case 'cancelTask':
				await this.facade.cancelTask(requireTarget(message));
				return;
			case 'answerTaskInput':
				await this.facade.answerTaskInput(requireTarget(message));
				return;
			case 'refresh':
				return;
		}
	}

	private async publish(instance: ViewInstance): Promise<void> {
		if (instance.disposed) {
			return;
		}
		try {
			const model = this.presenter.present(await this.facade.getSnapshot());
			const message: DashboardOutboundMessage = {
				version: DASHBOARD_MESSAGE_VERSION,
				uiInstanceId: instance.id,
				type: 'dashboard.snapshot',
				model,
			};
			await this.safePost(instance, message);
		} catch {
			await this.postError(
				instance,
				'UNSAFE_VIEW_MODEL',
				'The dashboard rejected an invalid service snapshot.',
			);
		}
	}

	private async postError(
		instance: ViewInstance,
		code: 'INVALID_MESSAGE' | 'ACTION_FAILED' | 'UNSAFE_VIEW_MODEL',
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
		assertSafeDashboardOutboundMessage(message);
		await instance.view.webview.postMessage(message);
	}

	private disposeInstance(instance: ViewInstance): void {
		if (instance.disposed) {
			return;
		}
		instance.disposed = true;
		this.instances.delete(instance.id);
		for (const subscription of instance.subscriptions.splice(0)) {
			subscription.dispose();
		}
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
	<header><h1>Copilot Agent Mesh</h1><button data-action="refresh" title="Refresh">Refresh</button></header>
	<main>
		<section aria-labelledby="device-heading"><h2 id="device-heading">This Device</h2><div id="device" class="card loading">Loading...</div></section>
		<section aria-labelledby="listener-heading"><h2 id="listener-heading">Listener</h2><div id="listener" class="card loading">Loading...</div></section>
		<section aria-labelledby="workspaces-heading"><h2 id="workspaces-heading">Shared Workspaces</h2><div id="workspaces" class="stack loading">Loading...</div><button data-action="registerWorkspace">Add Current Workspace</button></section>
		<section aria-labelledby="peers-heading"><h2 id="peers-heading">Remote Devices</h2><div id="peers" class="stack loading">Loading...</div><button data-action="addPeer">Add Connection</button></section>
		<section aria-labelledby="tasks-heading"><h2 id="tasks-heading">Tasks</h2><div id="tasks" class="stack loading">Loading...</div><button data-action="runTask">Run Task</button></section>
		<section aria-labelledby="errors-heading"><h2 id="errors-heading">Errors</h2><div id="errors" class="stack"></div></section>
	</main>
	<div id="announcement" role="status" aria-live="polite"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function requireTarget(message: Extract<DashboardInboundMessage, { type: 'action' }>): string {
	if (message.targetId === undefined) {
		throw new Error(`Dashboard action ${message.action} requires a target.`);
	}
	return message.targetId;
}

function getOwnExtensionUri(): vscode.Uri {
	const extension = vscode.extensions.getExtension('weivea.copilot-agent-mesh');
	if (extension === undefined) {
		throw new Error('Unable to resolve the Copilot Agent Mesh extension URI.');
	}
	return extension.extensionUri;
}
