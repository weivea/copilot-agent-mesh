import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import type * as vscode from 'vscode';

import { NATIVE_CHAT_ENABLE_COMMAND, NATIVE_CHAT_STATUS_COMMAND } from '../codespaces/nativeChat/NativeChatApi';
import { createNativeChatService } from '../codespaces/nativeChat/NativeChatService';
import { NativeChatStore } from '../codespaces/nativeChat/NativeChatStore';
import { createAgentRuntimeEventQueue } from '../agentHost/AgentRuntime';

async function fixture(t: TestContext, options: { enabled?: boolean; remoteName?: string; missingApi?: boolean; registrationFailure?: string; permissionSaveFailure?: boolean; missingContribution?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'mesh-native-service-'));
	await mkdir(join(root, 'workspace'));
	const workspaceUri = pathToFileURL(join(root, 'workspace')).href;
	const workspaceId = randomUUID();
	const reports: unknown[] = [];
	const notifications: string[] = [];
	const presentationWarnings: string[] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const permissionCalls: unknown[] = [];
	let registrations = 0;
	let menuQueries = 0;
	let disposals = 0;
	class Emitter {
		readonly event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	}
	const api = {
		env: { remoteName: options.remoteName ?? 'codespaces', uiKind: 1 },
		UIKind: { Desktop: 1 },
		workspace: {
			isTrusted: true,
			workspaceFolders: [{ uri: { scheme: 'file', fsPath: join(root, 'workspace') } }],
			getConfiguration: () => ({ get: () => options.enabled ?? true }),
			onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
		},
		commands: {
			getCommands: async () => { menuQueries++; return []; },
			registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
				handlers.set(name, handler);
				return { dispose() { handlers.delete(name); } };
			},
			executeCommand: async (command: string, input: unknown) => {
				assert.equal(command, NATIVE_CHAT_ENABLE_COMMAND);
				permissionCalls.push(input);
				if (options.permissionSaveFailure) { throw new Error('The user runtime config has unsaved edits.'); }
				return { state: 'restartRequired', changed: true };
			},
		},
		chat: {
			registerChatSessionItemProvider: options.missingApi ? undefined : () => {
				registrations += 1;
				if (options.missingContribution) { return { dispose() { disposals++; } }; }
				throw new Error(options.registrationFailure ?? "Extension cannot use API proposal 'chatSessionsProvider'.");
			},
			registerChatSessionContentProvider: () => ({ dispose() {} }),
			createChatParticipant: () => ({ dispose() {} }),
		},
		EventEmitter: Emitter,
		ThemeIcon: class {},
		ChatRequestTurn2: class {},
		ChatResponseTurn2: class {},
		Uri: { file: (path: string) => ({ toString: () => pathToFileURL(path).href }) },
		window: {
			showErrorMessage: async (message: string) => { notifications.push(message); },
			showWarningMessage: async (message: string) => { presentationWarnings.push(message); },
		},
		l10n: { t: (message: string) => message },
	} as unknown as typeof vscode;
	const context = {
		globalStorageUri: { fsPath: join(root, 'data') }, extension: { packageJSON: { version: '0.5.7' } },
	} as vscode.ExtensionContext;
	const service = createNativeChatService(api, context, (error) => reports.push(error));
	t.after(async () => {
		try { await service.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
	});
	const status = await handlers.get(NATIVE_CHAT_STATUS_COMMAND)!();
	const nodeId = randomUUID();
	const nodeInstanceId = randomUUID();
	const observation = await service.observe({
		nodeId, nodeInstanceId, helperInstanceId: randomUUID(), nodeLabel: 'Target',
		workspaceResolver: { resolve: async () => ({
			workspaceId, displayName: 'Workspace', uri: workspaceUri,
			workspaceIdentity: `sha256:${createHash('sha256').update(workspaceUri).digest('base64url')}`,
		}) }, eventSink: { publish() {} },
	});
	return { status, observation, reports, notifications, registrations, root, permissionCalls, presentationWarnings,
		nodeId, nodeInstanceId, workspaceId,
		get menuQueries() { return menuQueries; }, get disposals() { return disposals; },
	};
}

test('native Chat opt-out does not create history or install an execution observer', async (t) => {
	const f = await fixture(t, { enabled: false });
	assert.deepEqual(f.status, { state: 'disabled' });
	assert.equal(f.observation, undefined);
	assert.equal(f.registrations, 0);
	assert.deepEqual(f.reports, []);
	assert.deepEqual(f.permissionCalls, []);
	assert.deepEqual(await readdir(f.root), ['workspace']);
});

test('unsupported or missing native APIs leave the existing execution path unwrapped', async (t) => {
	for (const options of [{ remoteName: 'ssh-remote' }, { missingApi: true }]) {
		const f = await fixture(t, options);
		assert.deepEqual(f.status, { state: options.missingApi ? 'apiUnavailable' : 'unsupportedEnvironment' });
		assert.equal(f.observation, undefined);
		assert.equal(f.registrations, 0);
		assert.deepEqual(f.notifications, []);
		assert.deepEqual(f.permissionCalls, []);
		assert.deepEqual(await readdir(f.root), ['workspace']);
	}
});

test('a newly installed companion automatically persists desktop permission and reports the one-time restart', async (t) => {
	const f = await fixture(t);
	assert.deepEqual(f.status, { state: 'restartRequired' });
	assert.notEqual(f.observation, undefined);
	assert.equal(f.registrations, 1);
	assert.equal(f.reports.length, 0);
	assert.deepEqual(f.notifications, []);
	assert.equal(f.presentationWarnings.length, 1);
	assert.match(f.presentationWarnings[0], /saving this task history.*full VS Code restart/);
	assert.deepEqual(f.permissionCalls, [{ extensionVersion: '0.5.7' }]);
});

test('automatic permission failure is visible and leaves tool execution available for a manual retry', async (t) => {
	const f = await fixture(t, { permissionSaveFailure: true });
	assert.deepEqual(f.status, { state: 'permissionRequired' });
	assert.notEqual(f.observation, undefined);
	assert.equal(f.reports.length, 1);
	assert.equal(f.notifications.length, 1);
	assert.equal(f.permissionCalls.length, 1);
});

test('missing optional workbench menu commands must not unregister an accepted native provider', async (t) => {
	const f = await fixture(t, { missingContribution: true });
	assert.deepEqual(f.status, { state: 'enabled' });
	assert.notEqual(f.observation, undefined);
	assert.equal(f.registrations, 1);
	assert.equal(f.permissionCalls.length, 1);
	assert.equal(f.menuQueries, 0);
	assert.equal(f.disposals, 0);
	assert.deepEqual(f.presentationWarnings, []);
});

test('unexpected native UI initialization errors are reported instead of a success-shaped fallback', async (t) => {
	const f = await fixture(t, { registrationFailure: 'Unexpected native registration failure.' });
	assert.deepEqual(f.status, { state: 'initializationFailed' });
	assert.notEqual(f.observation, undefined);
	assert.equal(f.reports.length, 1);
	assert.equal(f.notifications.length, 1);
	assert.match(f.notifications[0], /history is unavailable/);
});

test('tasks accepted before the full restart retain readable history without requiring another model call', async (t) => {
	const f = await fixture(t);
	const observer = f.observation;
	assert.ok(observer);
	const taskId = randomUUID();
	const queue = createAgentRuntimeEventQueue();
	let starts = 0;
	const runtime = observer.runtime({
		probe: async () => ({ available: true, featureEnabled: true }),
		start: async () => {
			starts++;
			return {
				taskId, events: queue, recovery: {
					clientId: randomUUID(), sessionUri: `copilot:/${taskId}`, chatUri: `copilot:/${taskId}/chats/main`, lastSeenServerSeq: 1,
				},
				cancel: async () => undefined, answer: async () => undefined, dispose: async () => queue.close(),
			};
		},
		dispose: async () => queue.close(),
	});
	const executor = observer.attach({
		start: async () => { throw new Error('The fixture starts the observed runtime directly.'); },
		cancel: async () => undefined, answer: async () => undefined, dispose: () => runtime.dispose(),
	});
	try {
		const handle = await runtime.start({
			taskId, workspaceId: f.workspaceId, title: 'Pending restart task', prompt: 'Retain this actual response.',
		});
		const sink = observer.eventSink({ publish() {} });
		await queue.push({ type: 'output', text: 'The response completed while native Chat was unavailable.\n' });
		await queue.pushAndClose({ type: 'completed' });
		for await (const event of handle.events) {
			if (event.type === 'completed') {
				await sink.publish({
					nodeId: f.nodeId, nodeInstanceId: f.nodeInstanceId, taskId, at: new Date().toISOString(),
					event: { type: 'completed', summary: 'Completed.' },
				});
			}
		}
		const restored = new NativeChatStore({ rootDirectory: join(f.root, 'data', 'chat-history') });
		await restored.initialize();
		const turn = restored.get(taskId)!.turns[0];
		assert.equal(turn.status, 'completed');
		assert.equal(turn.entries.filter((entry) => entry.kind === 'output').map((entry) => entry.text).join(''),
			'The response completed while native Chat was unavailable.\n');
		assert.equal(starts, 1);
		assert.equal(f.presentationWarnings.length, 1);
	} finally { await executor.dispose(); }
});
