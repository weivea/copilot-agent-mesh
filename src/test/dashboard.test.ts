import * as assert from 'assert';
import { readFile } from 'fs/promises';

import * as vscode from 'vscode';

import { timestampSchema } from '../../shared/protocol';
import {
	ProductionDashboardBindings,
	ProductionDashboardBindingsOptions,
} from '../composition/ProductionDashboardBindings';
import { AgentMeshViewProvider } from '../ui/AgentMeshViewProvider';
import {
	DashboardActionError,
	DashboardFacade,
	DashboardServiceBindings,
	DashboardSnapshot,
	DashboardTaskTarget,
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
		assert.ok(view.webview.html.includes('This Window'));
		assert.ok(view.webview.html.includes('Saved Authorizations'));
		provider.dispose();
	});

	test('uses textContent rather than innerHTML for remote strings', async () => {
		const extension = getExtension();
		const bundle = await readFile(vscode.Uri.joinPath(extension.extensionUri, 'media', 'dashboard.js').fsPath, 'utf8');

		assert.ok(bundle.includes('textContent'));
		assert.ok(!bundle.includes('innerHTML'));
		assert.ok(bundle.includes('Remove saved authorization'));
	});

	test('validates inbound messages and rejects extra or malformed data', () => {
		const valid = {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'cancelOutgoingTask',
			actionHandle: 'a'.repeat(32),
		};
		assert.deepStrictEqual(parseDashboardInboundMessage(valid), valid);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, actionHandle: '/private/task' }), undefined);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, secret: 'leak' }), undefined);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, actionHandle: undefined }), undefined);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, action: 'unknown' }), undefined);
		assert.strictEqual(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: 'b'.repeat(32),
		}), undefined);
		assert.ok(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: 'b'.repeat(32),
			enabled: true,
		}));
		assert.ok(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'renameWindow',
		}));
		assert.strictEqual(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'renameWindow',
			workspaceIdentity: 'sha256:foreign',
		}), undefined);
	});

	test('rejects secrets and path forms in otherwise valid outbound models', () => {
		const base = {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot' as const,
		};
		const safeModel = new DashboardPresenter().present(snapshot());
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({ ...base, model: safeModel }));
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
			'auth_token = private-value',
			'id_token: private-value',
			'oauthAccessToken = private-value',
			'credential = private-value',
			'Authorization : private-value',
			'tkn\t=\tprivate-value',
			'token: ghp_example',
			'token = gho_example',
			'token = ghu_example',
			'token = ghs_example',
			'token = ghr_example',
			'{"api key":"private-value"}',
			'{"private key" : "private-value"}',
			'{"client-secret":"private-value"}',
			'https://example.test/?credentials[password]=private-value',
			'https://example.test/?credentials%5Bpassword%5D=private-value',
			'https://example.test/?user[api_key][value]=private-value',
			'https://example.test/?x[password][y]=private-value',
			'https://example.test/?user%5Bapi%2Bkey%5D%5Bvalue%5D=private-value',
			'https://example.test/?x%5Bpassword%5D%5By%5D=private-value',
			'https://example.test/?api+key=private-value',
			'https://example.test/?nested=api%2Bkey%3Dprivate-value',
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
			'1vscode-remote://ssh-remote+host/home/alice',
			'1https://user:pass@example.test',
			'1://host/home/alice',
			'file:tmp',
			'1file:tmp',
			'https:user:pass@example.test',
			'1https:user:pass@example.test',
			'https:///etc',
			'https:////secret',
			'https://',
			'https://?query=value',
			'HTTPS%3A%2F%2F%2Fetc',
			'1HTTPS%3A%2F%2F%2Fetc',
			'https://%75ser:pass@example.test/',
			'https://x/%23opaque-secret',
			"https://'user:pass'@example.test/",
			'https://example.test/\u0000hidden',
			'https://example.test/%00hidden',
		]) {
			assert.throws(() => assertSafeDashboardOutboundMessage({
				...base,
				model: withTaskTitle(safeModel, unsafeText),
			}), `Expected rejection for ${JSON.stringify(unsafeText)}`);
		}
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			...base,
			model: withTaskTitle(safeModel, 'https://example.test'),
		}));
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			...base,
			model: withTaskTitle(safeModel, 'HTTPS://EXAMPLE.TEST'),
		}));
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			...base,
			model: withTaskTitle(safeModel, 'tokenCount = 12'),
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
			outgoingTasks: source.outgoingTasks?.map((task) => ({
				...task,
				title: 'Changed src/auth.ts',
			})),
			errors: [{ code: 'TASK_FAILED', message: '{"credential" : "private-value"}' }],
		});

		assert.strictEqual(model.listener.gateway.detail, '[redacted sensitive details]');
		assert.strictEqual(model.outgoingTasks[0].title, '[redacted sensitive details]');
		assert.strictEqual(model.errors[0].message, '[redacted sensitive details]');
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model,
		}));
	});

	test('moves offline policy into Saved Authorizations and restores one row after reopen', () => {
		const source = snapshot();
		const target = source.policyCandidates?.[0];
		assert.ok(target);
		const closed = new DashboardPresenter().present({
			...source,
			policyCandidates: [
				{
					...target,
					actionHandle: undefined,
					windowLabel: 'This Window',
					workspaceName: 'source-workspace',
					self: true,
					canToggle: false,
				},
				{
					...target,
					windowLabel: 'Closed Window',
					workspaceName: 'closed-workspace',
					online: false,
					acceptsIncoming: false,
					allowlisted: false,
					canToggle: false,
					gateState: 'offline',
				},
				{
					...target,
					actionHandle: 'd'.repeat(32),
					windowLabel: 'C:\\private\\closed-window',
					workspaceName: 'file:///private/workspace',
					online: false,
					allowlisted: true,
					canToggle: true,
					gateState: 'offline',
				},
			],
		});

		assert.deepStrictEqual(
			closed.localNodes.map(({ windowLabel }) => windowLabel),
			['This Window'],
		);
		assert.deepStrictEqual(closed.savedAuthorizations, [{
			actionHandle: 'd'.repeat(32),
			windowLabel: '[redacted sensitive details]',
			workspaceName: '[redacted sensitive details]',
		}]);
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model: closed,
		}));

		const reopened = new DashboardPresenter().present({
			...source,
			policyCandidates: [
				{
					...target,
					actionHandle: undefined,
					windowLabel: 'This Window',
					workspaceName: 'source-workspace',
					self: true,
					canToggle: false,
				},
				{
					...target,
					actionHandle: 'e'.repeat(32),
					windowLabel: 'Reopened Window',
					workspaceName: 'reopened-workspace',
				},
			],
		});
		assert.deepStrictEqual(
			reopened.localNodes.map(({ windowLabel }) => windowLabel),
			['This Window', 'Reopened Window'],
		);
		assert.equal(reopened.localNodes.every(({ online }) => online), true);
		assert.equal(
			reopened.localNodes.filter(({ workspaceName }) => workspaceName === 'reopened-workspace').length,
			1,
		);
		assert.deepStrictEqual(reopened.savedAuthorizations, []);
	});

	test('presents every Foundation task state and safely truncates valid UTF-8 summaries', () => {
		const source = snapshot();
		const presenter = new DashboardPresenter();
		const summary = '🙂'.repeat(4_096);
		const baseTask = source.outgoingTasks?.[0];
		assert.ok(baseTask);
		const states: DashboardSnapshot['tasks'][number]['state'][] = [
			'accepted',
			'startingAgent',
			'running',
			'needsInput',
			'recovering',
			'cancelling',
			'completed',
			'failed',
			'cancelled',
			'timedOut',
		];
		const model = presenter.present({
			...source,
			outgoingTasks: states.map((state, index) => ({
				...baseTask,
				actionHandle: [
					'completed',
					'failed',
					'cancelled',
					'timedOut',
				].includes(state) ? undefined : `${index}`.padStart(32, 'a'),
				state,
				title: summary,
				shortId: `${index}`.padStart(8, 'a'),
				canCancel: !['completed', 'failed', 'cancelled', 'timedOut'].includes(state),
			})),
		});

		assert.strictEqual(model.outgoingTasks.length, states.length);
		for (const task of model.outgoingTasks) {
			assert.strictEqual(Buffer.byteLength(task.title, 'utf8'), 2 * 1_024);
		}
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model,
		}));
	});

	test('strictly validates outbound model types and enums', () => {
		const model = new DashboardPresenter().present(snapshot());
		assert.throws(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model: {
				...model,
				listener: { ...model.listener, canStop: 'false' },
			},
		} as never));
		assert.throws(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model: { ...model, device: null },
		} as never));
	});

	test('keeps This Window disabled when Preview is off and rejects identity leakage', () => {
		const model = new DashboardPresenter().present({
			...snapshot(),
			thisWindow: {
				name: 'This Window',
				workspaceName: 'service-workspace',
				claimStatus: 'claimed',
				previewEnabled: false,
				canRename: false,
				acceptsIncoming: false,
				canSetAcceptIncoming: false,
				agentHost: {
					source: 'standalone',
					label: 'Standalone (degraded)',
					degraded: true,
					reason: 'EDITOR_DISCOVERY_FAILED',
				},
				detail: 'Enable Peer Delegation Preview to rename this window.',
			},
		});
		assert.strictEqual(model.thisWindow.canRename, false);
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model,
		}));
		assert.throws(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model: {
				...model,
				thisWindow: {
					...model.thisWindow,
					workspaceIdentity: 'sha256:abcdefghijklmnopqrstuvwxyz0123456789_______',
				},
			},
		} as never));
	});

	test('renders truthful Editor and degraded Standalone source states', () => {
		const source = snapshot();
		const presenter = new DashboardPresenter();
		const editor = presenter.present(source);
		assert.equal(editor.thisWindow.agentHost.label, 'Editor');
		assert.equal(editor.thisWindow.agentHost.degraded, false);
		const degraded = presenter.present({
			...source,
			thisWindow: {
				...source.thisWindow,
				agentHost: {
					source: 'standalone',
					label: 'Standalone (degraded)',
					degraded: true,
					reason: 'EDITOR_DISCOVERY_FAILED',
					detail: 'Editor discovery was unavailable.',
				},
			},
		});
		assert.equal(degraded.thisWindow.agentHost.label, 'Standalone (degraded)');
		assert.equal(degraded.thisWindow.agentHost.reason, 'EDITOR_DISCOVERY_FAILED');
	});

	test('canonicalizes every protocol-valid timestamp shape and safely marks malformed values', () => {
		const variants = [
			'2026-08-31T00:00:00+00:00',
			'2026-08-31T08:00:00+08:00',
			'2026-08-31T00:00:00.1Z',
			'2026-08-31T00:00:00.123Z',
			'2026-08-31T00:00:00.123456Z',
			'2026-08-31T00:00:00.123456789Z',
		];
		for (const value of variants) {
			assert.equal(timestampSchema.safeParse(value).success, true);
		}
		const extendedYearAfterNormalization = '9999-12-31T23:59:59-23:59';
		assert.equal(timestampSchema.safeParse(extendedYearAfterNormalization).success, true);
		const source = snapshot();
		const task = source.outgoingTasks?.[0];
		assert.ok(task);
		const model = new DashboardPresenter().present({
			...source,
			outgoingTasks: variants.slice(0, 3).map((startedAt) => ({ ...task, startedAt })),
			incomingTasks: [
				...variants.slice(3).map((startedAt) => ({ ...task, startedAt })),
				{ ...task, startedAt: extendedYearAfterNormalization },
				{ ...task, startedAt: 'malformed timestamp' },
			],
		});
		for (const projected of [...model.outgoingTasks, ...model.incomingTasks.slice(0, 3)]) {
			assert.match(projected.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
		}
		assert.equal(model.incomingTasks[3]?.startedAt, 'Unknown');
		assert.equal(model.incomingTasks[4]?.startedAt, 'Unknown');
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model,
		}));
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

		await first.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: replacedId, type: 'ready' });
		await first.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: firstId, type: 'ready' });
		await second.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: secondId, type: 'ready' });
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
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'stale-instance',
			type: 'action',
			action: 'startListener',
		});

		assert.deepStrictEqual(facade.calls, []);
		assert.strictEqual(view.webview.sent[0]?.type, 'dashboard.error');
		provider.dispose();
	});

	test('scopes one-time action handles to one UI instance and exact action', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const first = new TestWebviewView();
		const second = new TestWebviewView();
		provider.resolveWebviewView(first);
		provider.resolveWebviewView(second);
		const firstId = getUiInstanceId(first.webview.html);
		const secondId = getUiInstanceId(second.webview.html);
		await first.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: firstId, type: 'ready' });
		await second.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: secondId, type: 'ready' });
		const acceptHandle = getThisWindowActionHandle(first.webview.sent[0]);
		assert.ok(acceptHandle);
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setAcceptIncoming',
			actionHandle: acceptHandle,
			enabled: true,
		});
		assert.ok(facade.calls.includes(`setAcceptIncoming:${'c'.repeat(32)}:true`));
		const firstHandle = getCollectionActionHandle(
			first.webview.sent[first.webview.sent.length - 1],
			'localNodes',
		);
		assert.ok(firstHandle);

		await second.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: secondId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: firstHandle,
			enabled: true,
		});
		assert.equal(second.webview.sent.some(({ code }) => code === 'STALE_ACTION'), true);

		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: firstHandle,
			enabled: true,
		});
		assert.ok(facade.calls.includes(`setPeerAllowed:${'a'.repeat(32)}:true`));
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: firstHandle,
			enabled: false,
		});
		assert.equal(first.webview.sent.some(({ code }) => code === 'STALE_ACTION'), true);
		provider.dispose();
	});

	test('scopes Saved Authorization removal handles and fails closed across transitions', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const first = new TestWebviewView();
		const second = new TestWebviewView();
		provider.resolveWebviewView(first);
		provider.resolveWebviewView(second);
		const firstId = getUiInstanceId(first.webview.html);
		const secondId = getUiInstanceId(second.webview.html);
		await first.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: firstId, type: 'ready' });
		await second.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: secondId, type: 'ready' });
		const oldLocalHandle = getCollectionActionHandle(first.webview.sent[0], 'localNodes');
		assert.ok(oldLocalHandle);
		const current = facade.snapshotValue;
		facade.snapshotValue = {
			...current,
			policyCandidates: current.policyCandidates?.map((candidate) => ({
				...candidate,
				online: false,
				allowlisted: true,
				canToggle: true,
				gateState: 'offline',
			})),
		};

		facade.fireChanged();
		await waitFor(() => first.webview.sent.length >= 2 && second.webview.sent.length >= 2);
		let latest = first.webview.sent[first.webview.sent.length - 1];
		assert.equal(getCollectionLength(latest, 'localNodes'), 0);
		assert.equal(getCollectionLength(latest, 'savedAuthorizations'), 1);
		assert.equal(getCollectionActionHandle(latest, 'localNodes'), undefined);
		assert.ok(getCollectionActionHandle(latest, 'savedAuthorizations'));

		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: oldLocalHandle,
			enabled: false,
		});
		assert.equal(first.webview.sent.some(({ code }) => code === 'STALE_ACTION'), true);
		latest = first.webview.sent[first.webview.sent.length - 1];
		const firstSavedHandle = getCollectionActionHandle(latest, 'savedAuthorizations');
		assert.ok(firstSavedHandle);
		await second.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: secondId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: firstSavedHandle,
			enabled: false,
		});
		assert.equal(second.webview.sent.some(({ code }) => code === 'STALE_ACTION'), true);

		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: firstSavedHandle,
			enabled: true,
		});
		assert.equal(first.webview.sent.some(({ code }) => code === 'POLICY_FORBIDDEN'), true);
		assert.equal(facade.calls.some((call) => call.startsWith('setPeerAllowed:')), false);
		latest = first.webview.sent[first.webview.sent.length - 1];
		const removeHandle = getCollectionActionHandle(latest, 'savedAuthorizations');
		assert.ok(removeHandle);
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: removeHandle,
			enabled: false,
		});
		assert.ok(facade.calls.includes(`setPeerAllowed:${'a'.repeat(32)}:false`));
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: removeHandle,
			enabled: false,
		});
		assert.equal(first.webview.sent.filter(({ code }) => code === 'STALE_ACTION').length >= 2, true);

		facade.snapshotValue = {
			...current,
			policyCandidates: current.policyCandidates?.map((candidate) => ({
				...candidate,
				actionHandle: 'e'.repeat(32),
				windowLabel: 'Reopened Window',
			})),
		};
		facade.fireChanged();
		await waitFor(() => {
			const message = first.webview.sent[first.webview.sent.length - 1];
			return getCollectionLength(message, 'savedAuthorizations') === 0
				&& getCollectionLength(message, 'localNodes') === 1;
		});
		provider.dispose();
	});

	test('keeps active task UI handles stable across refresh and removes them at terminal state', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);
		await view.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'ready' });
		const handle = getCollectionActionHandle(view.webview.sent[0], 'outgoingTasks');
		assert.ok(handle);

		facade.fireChanged();
		await settle();
		const refreshedHandle = getCollectionActionHandle(
			view.webview.sent[view.webview.sent.length - 1],
			'outgoingTasks',
		);
		assert.equal(refreshedHandle, handle);

		const current = facade.snapshotValue;
		facade.snapshotValue = {
			...current,
			outgoingTasks: current.outgoingTasks?.map((task) => ({
				...task,
				state: 'completed',
				canCancel: false,
				actionHandle: undefined,
			})),
		};
		facade.fireChanged();
		await settle();
		assert.equal(getCollectionActionHandle(
			view.webview.sent[view.webview.sent.length - 1],
			'outgoingTasks',
		), undefined);
		await view.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId,
			type: 'action',
			action: 'cancelOutgoingTask',
			actionHandle: handle,
		});
		assert.equal(view.webview.sent.some(({ code }) => code === 'STALE_ACTION'), true);
		provider.dispose();
	});

	test('coalesces async publications so an old snapshot cannot overwrite a new one', async () => {
		const extension = getExtension();
		const facade = new DeferredDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);

		await view.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'ready' });
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

	test('reserves exact task cancellation before confirmation and releases a denial', async () => {
		const services = new RecordingServiceBindings();
		const order: string[] = [];
		services.cancellationOrder = order;
		const facade = new ServiceDashboardFacade(services, {
			confirm: async () => {
				order.push('confirm');
				return false;
			},
		});
		await facade.cancelDashboardTask('a'.repeat(32), 'incoming');
		assert.deepStrictEqual(order, ['prepare', 'confirm', 'release']);
	});

	test('collects a separate safe task title without placing instructions in the view model', async () => {
		const services = new RecordingServiceBindings();
		const values = ['Safe dashboard title', 'Sensitive prompt body'];
		const facade = new ServiceDashboardFacade(
			services,
			{ confirm: async () => true },
			{
				showInputBox: async (options) => {
					const value = values.shift();
					assert.equal(options.validateInput?.(value ?? ''), undefined);
					return value;
				},
			},
		);
		await facade.runTask({
			deviceId: 'device-1',
			nodeId: 'node-1',
			nodeInstanceId: 'instance-1',
			workspaceId: 'workspace-1',
		});

		assert.deepStrictEqual(services.lastTaskRequest, {
			target: {
				deviceId: 'device-1',
				nodeId: 'node-1',
				nodeInstanceId: 'instance-1',
				workspaceId: 'workspace-1',
			},
			title: 'Safe dashboard title',
			instruction: 'Sensitive prompt body',
		});
		const viewModel = await services.getSnapshot();
		assert.doesNotMatch(JSON.stringify(viewModel), /Sensitive prompt body/u);
	});

	test('collects the window name in the Extension Host without accepting an identity from Webview', async () => {
		const services = new RecordingServiceBindings();
		const facade = new ServiceDashboardFacade(
			services,
			{ confirm: async () => true },
			{
				showInputBox: async (options) => {
					assert.strictEqual(options.value, 'This Window');
					assert.strictEqual(options.validateInput?.('Renamed Window'), undefined);
					const whitespaceError = await options.validateInput?.(' Renamed Window ');
					const pathError = await options.validateInput?.('ｆｉｌｅ：／／／private');
					if (typeof whitespaceError !== 'string' || typeof pathError !== 'string') {
						throw new Error('Expected string window-name validation errors.');
					}
					assert.match(whitespaceError, /surrounding whitespace/u);
					assert.match(pathError, /path and URI/u);
					return 'Renamed Window';
				},
			},
		);

		await facade.renameCurrentWindow();

		assert.strictEqual(services.lastWindowName, 'Renamed Window');
	});

	test('surfaces safe explicit rename errors through the Dashboard message contract', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		facade.renameError = new DashboardActionError(
			'WINDOW_NAME_CONFLICT',
			'Another Workspace already uses an equivalent window name.',
		);
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);

		await view.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId,
			type: 'action',
			action: 'renameWindow',
		});

		assert.strictEqual(view.webview.sent[0]?.type, 'dashboard.error');
		assert.strictEqual(view.webview.sent[0]?.code, 'WINDOW_NAME_CONFLICT');
		assert.strictEqual(
			view.webview.sent[0]?.message,
			'Another Workspace already uses an equivalent window name.',
		);
		provider.dispose();
	});

	test('Production bindings derive the owned policy identity server-side and reject ambiguous selection', async () => {
		const mutations: unknown[] = [];
		const selected = createWindowRenameBindings({
			enabled: true,
			selection: {
				kind: 'selected',
				workspaceIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				workspaceId: 'workspace-1',
				workspaceName: 'service-workspace',
				claimStatus: 'claimed',
			},
			mutations,
		});
		const rename = await selected.prepareWindowRename();
		await rename.rename('Backend');
		assert.deepStrictEqual(mutations, [{
			workspaceIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			windowName: 'Backend',
		}]);
		selected.dispose();
		selected.dispose();

		const ambiguous = createWindowRenameBindings({
			enabled: true,
			selection: {
				kind: 'unavailable',
				workspaceName: 'Multiple Workspaces',
				claimStatus: 'ambiguous',
			},
			mutations,
		});
		await assert.rejects(
			ambiguous.prepareWindowRename(),
			(error: unknown) =>
				error instanceof DashboardActionError
				&& error.code === 'WORKSPACE_SELECTION_AMBIGUOUS',
		);
		assert.strictEqual(mutations.length, 1);
		ambiguous.dispose();
	});

	test('rejects rename when the active Workspace changes while the input is open', async () => {
		const mutations: unknown[] = [];
		let selection: WindowRenameSelection = {
			kind: 'selected',
			workspaceIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			workspaceId: 'workspace-a',
			workspaceName: 'Workspace A',
			claimStatus: 'claimed',
		};
		const bindings = createWindowRenameBindings({
			enabled: true,
			selection: () => selection,
			mutations,
		});
		const facade = new ServiceDashboardFacade(
			bindings,
			{ confirm: async () => true },
			{
				showInputBox: async () => {
					selection = {
						kind: 'selected',
						workspaceIdentity: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
						workspaceId: 'workspace-b',
						workspaceName: 'Workspace B',
						claimStatus: 'claimed',
					};
					return 'Renamed Window';
				},
			},
		);

		await assert.rejects(
			facade.renameCurrentWindow(),
			(error: unknown) =>
				error instanceof DashboardActionError
				&& error.code === 'WORKSPACE_SELECTION_AMBIGUOUS',
		);
		assert.deepStrictEqual(mutations, []);
		bindings.dispose();
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
			{ action: 'renameWindow' },
			{ action: 'startListener' },
			{ action: 'stopListener' },
			{ action: 'copyConnectionUrl' },
			{ action: 'refresh' },
		] as const;

		for (const action of actions) {
			await view.webview.receive({
				version: DASHBOARD_MESSAGE_VERSION,
				uiInstanceId,
				type: 'action',
				...action,
			});
		}

		assert.deepStrictEqual(facade.calls, [
			'configureDevice',
			'renameWindow',
			'startListener',
			'stopListener',
			'copyConnectionUrl',
		]);
		provider.dispose();
	});
});

class RecordingDashboardFacade implements DashboardFacade {
	private readonly changed = new vscode.EventEmitter<void>();
	public readonly calls: string[] = [];
	public readonly onDidChange = this.changed.event;
	public snapshotValue = snapshot();
	public renameError?: DashboardActionError;

	public getSnapshot(): Promise<DashboardSnapshot> {
		return Promise.resolve(this.snapshotValue);
	}

	public fireChanged(): void {
		this.changed.fire();
	}

	public async configureDeviceName(): Promise<void> {
		this.calls.push('configureDevice');
	}

	public async renameCurrentWindow(): Promise<void> {
		if (this.renameError !== undefined) {
			throw this.renameError;
		}
		this.calls.push('renameWindow');
	}

	public async setAcceptIncoming(actionHandle: string, enabled: boolean): Promise<void> {
		this.calls.push(`setAcceptIncoming:${actionHandle}:${enabled}`);
	}

	public async setPeerAllowed(actionHandle: string, allowed: boolean): Promise<void> {
		this.calls.push(`setPeerAllowed:${actionHandle}:${allowed}`);
	}

	public async cancelDashboardTask(actionHandle: string, direction: 'incoming' | 'outgoing'): Promise<void> {
		this.calls.push(`cancelDashboardTask:${direction}:${actionHandle}`);
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

	public async runTask(target?: DashboardTaskTarget): Promise<void> {
		this.calls.push(target === undefined
			? 'runTask'
			: `runTask:${target.deviceId}:${target.nodeId}:${target.nodeInstanceId}:${target.workspaceId}:${target.peerId ?? ''}`);
	}

	public async cancelTask(taskId: string): Promise<void> {
		this.calls.push(`cancelTask:${taskId}`);
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
	public cancellationOrder?: string[];
	public lastWindowName?: string;
	public lastTaskRequest?: {
		readonly target?: DashboardTaskTarget;
		readonly title: string;
		readonly instruction: string;
	};
	public getSnapshot(): Promise<DashboardSnapshot> {
		return Promise.resolve(snapshot());
	}

	public async configureDeviceName(_name: string): Promise<void> {}
	public async prepareWindowRename() {
		return {
			currentName: 'This Window',
			rename: async (name: string) => {
				this.lastWindowName = name;
			},
		};
	}
	public async setAcceptIncoming(_actionHandle: string, _enabled: boolean): Promise<void> {}
	public async setPeerAllowed(_actionHandle: string, _allowed: boolean): Promise<void> {}
	public async prepareDashboardTaskCancellation(
		_actionHandle: string,
		_direction: 'incoming' | 'outgoing',
	) {
		this.cancellationOrder?.push('prepare');
		return {
			cancel: async () => {
				this.cancellationOrder?.push('cancel');
			},
			release: async () => {
				this.cancellationOrder?.push('release');
			},
		};
	}
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

	public async runTask(request: {
		readonly target?: DashboardTaskTarget;
		readonly title: string;
		readonly instruction: string;
	}): Promise<void> {
		this.lastTaskRequest = request;
	}

	public async cancelTask(_taskId: string): Promise<void> {}
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
			deviceId: 'device-1',
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
		broker: {
			state: 'running',
			role: 'owner',
			takeover: 'stable',
			holder: 'thisWindow',
		},
		thisWindow: {
			name: 'This Window',
			workspaceName: 'service-workspace',
			claimStatus: 'claimed',
			previewEnabled: true,
			canRename: true,
			acceptsIncoming: false,
			canSetAcceptIncoming: true,
			acceptActionHandle: 'c'.repeat(32),
			agentHost: {
				source: 'editor',
				label: 'Editor',
				degraded: false,
			},
		},
		policyCandidates: [{
			actionHandle: 'a'.repeat(32),
			windowLabel: 'Remote Window',
			workspaceName: 'remote-workspace',
			online: true,
			acceptsIncoming: true,
			busy: false,
			allowlisted: true,
			self: false,
			canToggle: true,
			claimState: 'claimed',
			gateState: 'allowed',
		}],
		outgoingTasks: [{
			actionHandle: 'b'.repeat(32),
			counterpartLabel: 'Remote Window',
			workspaceName: 'remote-workspace',
			title: 'Implement authentication',
			state: 'running',
			startedAt: '2026-08-31T00:00:00.000Z',
			shortId: '1234abcd',
			canCancel: true,
		}],
		incomingTasks: [],
		localNodes: [{
			nodeId: 'node-1',
			nodeInstanceId: 'instance-1',
			label: 'This Window',
			status: 'online',
			thisWindow: true,
			workspaces: [{
				workspaceId: 'workspace-1',
				name: 'service-workspace',
				capabilityTags: ['typescript'],
				enabled: true,
				busy: false,
				claimStatus: 'claimed',
			}],
		}],
		remoteDevices: [{
			deviceId: 'device-2',
			peerId: 'peer-1',
			name: 'remote-device',
			state: 'online',
			nodes: [{
				nodeId: 'node-2',
				nodeInstanceId: 'instance-2',
				label: 'Remote Window',
				status: 'online',
				thisWindow: false,
				workspaces: [{
					workspaceId: 'workspace-2',
					name: 'remote-workspace',
					capabilityTags: [],
					enabled: true,
					busy: false,
					claimStatus: 'claimed',
				}],
			}],
		}],
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

function withTaskTitle(
	value: ReturnType<DashboardPresenter['present']>,
	title: string,
): ReturnType<DashboardPresenter['present']> {
	return {
		...value,
		outgoingTasks: value.outgoingTasks.map((task) => ({ ...task, title })),
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

function getCollectionActionHandle(
	message: Record<string, unknown>,
	collection: 'localNodes' | 'savedAuthorizations' | 'outgoingTasks' | 'incomingTasks',
): string | undefined {
	const model = message.model;
	if (typeof model !== 'object' || model === null || Array.isArray(model)) {
		return undefined;
	}

	const items = (model as Record<string, unknown>)[collection];
	if (!Array.isArray(items)) {
		return undefined;
	}
	const first = items[0];
	if (typeof first !== 'object' || first === null || Array.isArray(first)) {
		return undefined;
	}
	const handle = (first as Record<string, unknown>).actionHandle;
	return typeof handle === 'string' ? handle : undefined;
}

function getCollectionLength(
	message: Record<string, unknown>,
	collection: 'localNodes' | 'savedAuthorizations' | 'outgoingTasks' | 'incomingTasks',
): number | undefined {
	const model = message.model;
	if (typeof model !== 'object' || model === null || Array.isArray(model)) {
		return undefined;
	}
	const items = (model as Record<string, unknown>)[collection];
	return Array.isArray(items) ? items.length : undefined;
}

function getThisWindowActionHandle(message: Record<string, unknown>): string | undefined {
	const model = message.model;
	if (typeof model !== 'object' || model === null || Array.isArray(model)) {
		return undefined;
	}
	const thisWindow = (model as Record<string, unknown>).thisWindow;
	if (typeof thisWindow !== 'object' || thisWindow === null || Array.isArray(thisWindow)) {
		return undefined;
	}
	const handle = (thisWindow as Record<string, unknown>).acceptActionHandle;
	return typeof handle === 'string' ? handle : undefined;
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

type WindowRenameSelection =
	| {
		readonly kind: 'selected';
		readonly workspaceIdentity: string;
		readonly workspaceId: string;
		readonly workspaceName: string;
		readonly claimStatus: 'claimed';
	}
	| {
		readonly kind: 'unavailable';
		readonly workspaceName: string;
		readonly claimStatus: 'ambiguous';
	};

function createWindowRenameBindings(options: {
	readonly enabled: boolean;
	readonly selection: WindowRenameSelection | (() => WindowRenameSelection);
	readonly mutations: unknown[];
}): ProductionDashboardBindings {
	const disposable = { dispose: () => undefined };
	return new ProductionDashboardBindings({
		vscodeApi: {
			window: { activeTextEditor: undefined },
			workspace: {
				getConfiguration: () => ({
					get: () => options.enabled,
				}),
				getWorkspaceFolder: () => undefined,
			},
		},
		changed: {
			event: () => disposable,
			fire: () => undefined,
		},
		node: {
			nodeId: 'node-1',
			onDidChange: () => disposable,
			selectPeerPolicyWorkspace: () =>
				typeof options.selection === 'function' ? options.selection() : options.selection,
			getPeerPolicy: async (workspaceIdentity: string) => ({
				workspaceIdentity,
				windowName: 'This Window',
				acceptsIncoming: false,
				allowlist: [],
			}),
			setPeerPolicy: async (mutation: unknown) => {
				options.mutations.push(mutation);
				return mutation;
			},
		},
		guard: { assertAllowed: () => undefined },
		lifecycle: { onDidChange: () => disposable },
	} as unknown as ProductionDashboardBindingsOptions);
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
