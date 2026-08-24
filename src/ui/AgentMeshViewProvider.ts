import { randomBytes } from 'crypto';

import * as vscode from 'vscode';

import { MESH_PROTOCOL_VERSION } from '../../shared/protocol';

export class AgentMeshViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'copilotAgentMesh.dashboard';

	private view: vscode.WebviewView | undefined;

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: false,
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		webviewView.onDidDispose(() => {
			if (this.view === webviewView) {
				this.view = undefined;
			}
		});
	}

	public refresh(): void {
		if (this.view !== undefined) {
			this.view.webview.html = this.getHtml(this.view.webview);
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString('base64');
		const configuredName = vscode.workspace
			.getConfiguration('copilotAgentMesh')
			.get<string>('deviceName', '')
			.trim();
		const deviceName = configuredName.length > 0 ? configuredName : 'Not configured';

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta
		http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src 'nonce-${nonce}';"
	>
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${nonce}">
		body {
			padding: 0 14px 24px;
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}

		h2 {
			margin: 22px 0 8px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.08em;
			text-transform: uppercase;
		}

		.card {
			padding: 10px 12px;
			border: 1px solid var(--vscode-widget-border);
			border-radius: 4px;
			background: var(--vscode-editorWidget-background);
		}

		dl {
			display: grid;
			grid-template-columns: max-content 1fr;
			gap: 6px 12px;
			margin: 0;
		}

		dt {
			color: var(--vscode-descriptionForeground);
		}

		dd {
			min-width: 0;
			margin: 0;
			overflow-wrap: anywhere;
		}

		.empty {
			margin: 0;
			color: var(--vscode-descriptionForeground);
		}

		.status {
			display: inline-flex;
			align-items: center;
			gap: 6px;
		}

		.status::before {
			width: 7px;
			height: 7px;
			border-radius: 50%;
			background: var(--vscode-disabledForeground);
			content: "";
		}
	</style>
</head>
<body>
	<h2>This Device</h2>
	<section class="card">
		<dl>
			<dt>Name</dt>
			<dd>${escapeHtml(deviceName)}</dd>
			<dt>Platform</dt>
			<dd>${escapeHtml(getPlatformLabel())}</dd>
			<dt>Listener</dt>
			<dd><span class="status">Not started</span></dd>
			<dt>Protocol</dt>
			<dd>v${MESH_PROTOCOL_VERSION}</dd>
		</dl>
	</section>

	<h2>Shared Workspaces</h2>
	<section class="card">
		<p class="empty">No workspaces registered yet.</p>
	</section>

	<h2>Remote Devices</h2>
	<section class="card">
		<p class="empty">No peer connections configured yet.</p>
	</section>

	<h2>Tasks</h2>
	<section class="card">
		<p class="empty">No delegated tasks yet.</p>
	</section>
</body>
</html>`;
	}
}

function getPlatformLabel(): string {
	const platformNames: Partial<Record<NodeJS.Platform, string>> = {
		darwin: 'macOS',
		linux: 'Linux',
		win32: 'Windows',
	};

	return `${platformNames[process.platform] ?? process.platform} ${process.arch}`;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		const entities: Record<string, string> = {
			'&': '&amp;',
			'<': '&lt;',
			'>': '&gt;',
			'"': '&quot;',
			"'": '&#39;',
		};

		return entities[character];
	});
}
