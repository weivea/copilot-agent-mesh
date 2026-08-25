import * as assert from 'assert';
import { readFile } from 'fs/promises';

import * as vscode from 'vscode';

import { AgentMeshViewProvider } from '../ui/AgentMeshViewProvider';
import {
	DashboardFacade,
	DashboardServiceBindings,
	DashboardSnapshot,
	ServiceDashboardFacade,
} from '../ui/DashboardFacade';
import {
	assertSafeDashboardOutboundMessage,
	DASHBOARD_MESSAGE_VERSION,
	parseDashboardInboundMessage,
} from '../ui/DashboardMessages';
import { DashboardPresenter } from '../ui/DashboardPresenter';

suite('Dashboard', () => {
	test('configures a script-enabled webview with media-only resources and a strict CSP', () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();

		provider.resolveWebviewView(view);

		assert.strictEqual(view.webview.options.enableScripts, true);
		assert.deepStrictEqual(
			view.webview.options.localResourceRoots?.map((uri) => uri.fsPath),
			[vscode.Uri.joinPath(extension.extensionUri, 'media').fsPath],
		);
		assert.match(view.webview.html, /default-src 'none'/);
		assert.match(view.webview.html, /script-src 'nonce-[^']+'/);
		assert.ok(view.webview.html.includes(view.webview.cspSource));
		assert.ok(view.webview.html.includes('dashboard.js'));
		assert.ok(view.webview.html.includes('dashboard.css'));
		provider.dispose();
	});

	test('uses textContent rather than innerHTML for remote strings', async () => {
		const extension = getExtension();
		const bundle = await readFile(vscode.Uri.joinPath(extension.extensionUri, 'media', 'dashboard.js').fsPath, 'utf8');

		assert.ok(bundle.includes('textContent'));
		assert.ok(!bundle.includes('innerHTML'));
	});

	test('validates inbound messages and rejects extra or malformed data', () => {
		const valid = {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'cancelTask',
			targetId: 'task-1',
		};
		assert.deepStrictEqual(parseDashboardInboundMessage(valid), valid);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, targetId: '/private/task' }), undefined);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, secret: 'leak' }), undefined);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, targetId: undefined }), undefined);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, action: 'unknown' }), undefined);
	});

	test('rejects secrets and path forms in otherwise valid outbound models', () => {
		const base = {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot' as const,
		};
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({ ...base, model: snapshot() }));
		for (const unsafeText of [
			'/tmp',
			'Failed at /tmp',
			'path=/Users/person/private-project',
			'C:\\Users\\person\\private-project\\file.ts',
			'path=C:\\Users\\person\\private-project',
			'path=\\\\server\\share\\private',
			'file:///Users/person/private-project/file.ts',
			'src/auth.ts',
			'media/dashboard.css',
			'https://example.test/connect#secret=hidden',
			'#secret%3Dhidden',
			'#secret%253Dhidden',
			'#secret%25253Dhidden',
			'{"password":"hunter2"}',
			'{ "PaSsWoRd" : "hunter2" }',
			'{"access_token":"private-value"}',
			'client_secret = private-value',
			'apiKey: private-value',
			'api_key = private-value',
			'private-key: private-value',
			'refresh_token%253Dprivate-value',
			'credential = private-value',
			'Authorization : private-value',
			'tkn\t=\tprivate-value',
			'token: ghp_example',
			'malformed=%E0%A4%A',
			'https://x/#/Users/person/private-project',
			'https://x/?location=C%3A%5CUsers%5Cperson%5Cprivate',
			'https://x/?location=file%253A%252F%252F%252Ftmp%252Fprivate',
			'https://user:pass@example.test',
			'https://user%3Apass@example.test',
			'https://user%253Apass@example.test',
			'vscode-remote://ssh-remote+host/home/alice',
			'vscode://file/Users/alice',
			'vscode-remote%3A%2F%2Fssh-remote%2Bhost%2Fhome%2Falice',
			'VSCODE://file/Users/alice',
			'custom-scheme://host/home/alice',
		]) {
			assert.throws(() => assertSafeDashboardOutboundMessage({
				...base,
				model: withTaskSummary(snapshot(), unsafeText),
			}));
		}
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			...base,
			model: withTaskSummary(snapshot(), 'https://example.test'),
		}));
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			...base,
			model: withTaskSummary(snapshot(), 'HTTPS://EXAMPLE.TEST'),
		}));
	});

	test('redacts path-bearing remote summaries, details, and errors before validation', () => {
		const source = snapshot();
		const presenter = new DashboardPresenter();
		const model = presenter.present({
			...source,
			listener: {
				...source.listener,
				gateway: { ...source.listener.gateway, detail: 'Gateway failed at C:\\mesh\\gateway.json' },
			},
			tasks: source.tasks.map((task) => ({ ...task, summary: 'Changed src/auth.ts' })),
			errors: [{ code: 'TASK_FAILED', message: '{"credential" : "private-value"}' }],
		});

		assert.strictEqual(model.listener.gateway.detail, '[redacted sensitive details]');
		assert.strictEqual(model.tasks[0].summary, '[redacted sensitive details]');
		assert.strictEqual(model.errors[0].message, '[redacted sensitive details]');
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			version: 1,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model,
		}));
	});

	test('strictly validates outbound model types and enums', () => {
		const model = snapshot();
		assert.throws(() => assertSafeDashboardOutboundMessage({
			version: 1,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model: {
				...model,
				listener: { ...model.listener, canStop: 'false' },
			},
		} as never));
		assert.throws(() => assertSafeDashboardOutboundMessage({
			version: 1,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model: { ...model, device: null },
		} as never));
	});

	test('isolates repeated resolves of the same view and makes repeated disposal safe', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const first = new TestWebviewView();
		const second = new TestWebviewView();

		provider.resolveWebviewView(first);
		const replacedId = getUiInstanceId(first.webview.html);
		provider.resolveWebviewView(first);
		const firstId = getUiInstanceId(first.webview.html);
		provider.resolveWebviewView(second);
		const secondId = getUiInstanceId(second.webview.html);
		assert.notStrictEqual(replacedId, firstId);
		assert.notStrictEqual(firstId, secondId);

		await first.webview.receive({ version: 1, uiInstanceId: replacedId, type: 'ready' });
		await first.webview.receive({ version: 1, uiInstanceId: firstId, type: 'ready' });
		await second.webview.receive({ version: 1, uiInstanceId: secondId, type: 'ready' });
		assert.strictEqual(first.webview.sent.length, 2);
		assert.strictEqual(first.webview.sent[0]?.type, 'dashboard.error');
		assert.strictEqual(second.webview.sent.length, 1);

		first.dispose();
		first.dispose();
		facade.fireChanged();
		await settle();
		assert.strictEqual(first.webview.sent.length, 2);
		assert.strictEqual(second.webview.sent.length, 2);

		provider.dispose();
		provider.dispose();
	});

	test('rejects stale instance messages', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);

		await view.webview.receive({
			version: 1,
			uiInstanceId: 'stale-instance',
			type: 'action',
			action: 'startListener',
		});

		assert.deepStrictEqual(facade.calls, []);
		assert.strictEqual(view.webview.sent[0]?.type, 'dashboard.error');
		provider.dispose();
	});

	test('coalesces async publications so an old snapshot cannot overwrite a new one', async () => {
		const extension = getExtension();
		const facade = new DeferredDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);

		await view.webview.receive({ version: 1, uiInstanceId, type: 'ready' });
		await waitFor(() => facade.pendingCount === 1);
		facade.fireChanged();
		facade.resolveNext(withDeviceName(snapshot(), 'old-device'));
		await waitFor(() => facade.pendingCount === 1);
		facade.resolveNext(withDeviceName(snapshot(), 'new-device'));
		await waitFor(() => view.webview.sent.length === 1);

		const message = view.webview.sent[0];
		assert.strictEqual(message.type, 'dashboard.snapshot');
		assert.strictEqual(getSnapshotDeviceName(message), 'new-device');
		provider.dispose();
	});

	test('requires local confirmation before stopping the listener', async () => {
		const services = new RecordingServiceBindings();
		const denied = new ServiceDashboardFacade(services, {
			confirm: async () => false,
		});
		await denied.stopListener();
		assert.strictEqual(services.stopCalls, 0);

		const approved = new ServiceDashboardFacade(services, {
			confirm: async () => true,
		});
		await approved.stopListener();
		assert.strictEqual(services.stopCalls, 1);
	});

	test('dispatches all dashboard actions without sensitive values in messages', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);

		const actions = [
			{ action: 'configureDevice' },
			{ action: 'registerWorkspace' },
			{ action: 'removeWorkspace', targetId: 'workspace-1' },
			{ action: 'startListener' },
			{ action: 'stopListener' },
			{ action: 'copyConnectionUrl' },
			{ action: 'addPeer' },
			{ action: 'removePeer', targetId: 'peer-1' },
			{ action: 'runTask', peerId: 'peer-1', workspaceId: 'workspace-1' },
			{ action: 'cancelTask', targetId: 'task-1' },
			{ action: 'answerTaskInput', targetId: 'task-1' },
			{ action: 'refresh' },
		] as const;

		for (const action of actions) {
			await view.webview.receive({
				version: 1,
				uiInstanceId,
				type: 'action',
				...action,
			});
		}

		assert.deepStrictEqual(facade.calls, [
			'configureDevice',
			'registerWorkspace',
			'removeWorkspace:workspace-1',
			'startListener',
			'stopListener',
			'copyConnectionUrl',
			'addPeer',
			'removePeer:peer-1',
			'runTask:peer-1:workspace-1',
			'cancelTask:task-1',
			'answerTaskInput:task-1',
		]);
		provider.dispose();
	});
});

class RecordingDashboardFacade implements DashboardFacade {
	private readonly changed = new vscode.EventEmitter<void>();
	public readonly calls: string[] = [];
	public readonly onDidChange = this.changed.event;

	public getSnapshot(): Promise<DashboardSnapshot> {
		return Promise.resolve(snapshot());
	}

	public fireChanged(): void {
		this.changed.fire();
	}

	public async configureDeviceName(): Promise<void> {
		this.calls.push('configureDevice');
	}

	public async registerCurrentWorkspace(): Promise<void> {
		this.calls.push('registerWorkspace');
	}

	public async removeWorkspace(workspaceId: string): Promise<void> {
		this.calls.push(`removeWorkspace:${workspaceId}`);
	}

	public async startListener(): Promise<void> {
		this.calls.push('startListener');
	}

	public async stopListener(): Promise<void> {
		this.calls.push('stopListener');
	}

	public async copyConnectionUrl(): Promise<void> {
		this.calls.push('copyConnectionUrl');
	}

	public async addPeer(): Promise<void> {
		this.calls.push('addPeer');
	}

	public async removePeer(peerId: string): Promise<void> {
		this.calls.push(`removePeer:${peerId}`);
	}

	public async runTask(peerId?: string, workspaceId?: string): Promise<void> {
		this.calls.push(`runTask:${peerId ?? ''}:${workspaceId ?? ''}`);
	}

	public async cancelTask(taskId: string): Promise<void> {
		this.calls.push(`cancelTask:${taskId}`);
	}

	public async answerTaskInput(taskId: string): Promise<void> {
		this.calls.push(`answerTaskInput:${taskId}`);
	}
}

class DeferredDashboardFacade extends RecordingDashboardFacade {
	private readonly pending: Array<(value: DashboardSnapshot) => void> = [];

	public override getSnapshot(): Promise<DashboardSnapshot> {
		return new Promise((resolve) => this.pending.push(resolve));
	}

	public get pendingCount(): number {
		return this.pending.length;
	}

	public resolveNext(value: DashboardSnapshot): void {
		const resolve = this.pending.shift();
		assert.ok(resolve);
		resolve(value);
	}
}

class RecordingServiceBindings implements DashboardServiceBindings {
	private readonly changed = new vscode.EventEmitter<void>();
	public readonly onDidChange = this.changed.event;
	public stopCalls = 0;

	public getSnapshot(): Promise<DashboardSnapshot> {
		return Promise.resolve(snapshot());
	}

	public async configureDeviceName(_name: string): Promise<void> {}
	public async registerCurrentWorkspace(): Promise<void> {}
	public async removeWorkspace(_workspaceId: string): Promise<void> {}
	public async startListener(): Promise<void> {}

	public async stopListener(): Promise<void> {
		this.stopCalls += 1;
	}

	public createConnectionUrl(): Promise<string> {
		return Promise.resolve('https://example.test/connect#secret=secret');
	}

	public async addPeer(_connectionUrl: string): Promise<void> {}
	public async removePeer(_peerId: string): Promise<void> {}

	public async runTask(_request: {
		readonly peerId?: string;
		readonly workspaceId?: string;
		readonly instruction: string;
	}): Promise<void> {}

	public async cancelTask(_taskId: string): Promise<void> {}
	public async answerTaskInput(_taskId: string, _answer: string): Promise<void> {}
}

class TestWebview implements vscode.Webview {
	public options: vscode.WebviewOptions = {};
	public html = '';
	public readonly cspSource = 'vscode-webview-resource:';
	public readonly sent: Array<Record<string, unknown>> = [];
	private readonly messages = new vscode.EventEmitter<unknown>();

	public readonly onDidReceiveMessage = this.messages.event;

	public asWebviewUri(localResource: vscode.Uri): vscode.Uri {
		return vscode.Uri.parse(`vscode-webview-resource:${localResource.path}`);
	}

	public async postMessage(message: Record<string, unknown>): Promise<boolean> {
		this.sent.push(message);
		return true;
	}

	public async receive(message: unknown): Promise<void> {
		this.messages.fire(message);
		await settle();
	}
}

class TestWebviewView implements vscode.WebviewView {
	public readonly viewType = AgentMeshViewProvider.viewType;
	public readonly webview = new TestWebview();
	public visible = true;
	public title?: string;
	public description?: string;
	public badge?: vscode.ViewBadge;
	private readonly visibility = new vscode.EventEmitter<void>();
	private readonly disposal = new vscode.EventEmitter<void>();

	public readonly onDidChangeVisibility = this.visibility.event;
	public readonly onDidDispose = this.disposal.event;

	public show(_preserveFocus?: boolean): void {}

	public dispose(): void {
		this.disposal.fire();
	}
}

function snapshot(): DashboardSnapshot {
	return {
		device: {
			name: 'test-device',
			platform: 'test-platform',
			architecture: 'test-architecture',
			vscodeVersion: '1.0.0',
			extensionVersion: '1.0.0',
		},
		listener: {
			state: 'running',
			gateway: { state: 'ready', label: 'Ready' },
			tunnel: { state: 'ready', label: 'Ready' },
			agentHost: { state: 'ready', label: 'Ready' },
			canStart: false,
			canStop: true,
			canCopyConnectionUrl: true,
		},
		workspaces: [],
		peers: [],
		tasks: [{
			taskId: 'task-1',
			title: 'Implement authentication',
			peerName: 'remote-device',
			workspaceName: 'service-workspace',
			state: 'running',
			phase: 'Editing',
			summary: 'Task is running.',
			canCancel: true,
			needsInput: false,
		}],
		errors: [],
	};
}

function withTaskSummary(value: DashboardSnapshot, summary: string): DashboardSnapshot {
	return {
		...value,
		tasks: value.tasks.map((task) => ({ ...task, summary })),
	};
}

function withDeviceName(value: DashboardSnapshot, name: string): DashboardSnapshot {
	return {
		...value,
		device: { ...value.device, name },
	};
}

function getSnapshotDeviceName(message: Record<string, unknown>): unknown {
	const model = message.model;
	if (typeof model !== 'object' || model === null || Array.isArray(model)) {
		return undefined;
	}
	const device = (model as Record<string, unknown>).device;
	if (typeof device !== 'object' || device === null || Array.isArray(device)) {
		return undefined;
	}
	return (device as Record<string, unknown>).name;
}

function getExtension(): vscode.Extension<unknown> {
	const extension = vscode.extensions.getExtension('weivea.copilot-agent-mesh');
	assert.ok(extension);
	return extension;
}

function getUiInstanceId(html: string): string {
	const match = /data-ui-instance-id="([^"]+)"/.exec(html);
	assert.ok(match);
	return match[1];
}

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) {
			return;
		}
		await settle();
	}
	assert.fail('Timed out waiting for dashboard test condition.');
}
