import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import type * as vscode from 'vscode';

import { NATIVE_CHAT_STATUS_COMMAND } from '../codespaces/nativeChat/NativeChatApi';
import { createNativeChatService } from '../codespaces/nativeChat/NativeChatService';

async function fixture(t: TestContext, options: { enabled?: boolean; remoteName?: string; missingApi?: boolean; registrationFailure?: string } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'mesh-native-service-'));
	await mkdir(join(root, 'workspace'));
	const reports: unknown[] = [];
	const notifications: string[] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	let registrations = 0;
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
			registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
				handlers.set(name, handler);
				return { dispose() { handlers.delete(name); } };
			},
		},
		chat: {
			registerChatSessionItemProvider: options.missingApi ? undefined : () => {
				registrations += 1;
				throw new Error(options.registrationFailure ?? "Extension cannot use API proposal 'chatSessionsProvider'.");
			},
			registerChatSessionContentProvider() {},
		},
		EventEmitter: Emitter,
		ChatRequestTurn2: class {},
		ChatResponseTurn2: class {},
		Uri: { file: (path: string) => ({ toString: () => pathToFileURL(path).href }) },
		window: { showErrorMessage: async (message: string) => { notifications.push(message); } },
		l10n: { t: (message: string) => message },
	} as unknown as typeof vscode;
	const context = { globalStorageUri: { fsPath: join(root, 'data') } } as vscode.ExtensionContext;
	const service = createNativeChatService(api, context, (error) => reports.push(error));
	t.after(async () => {
		try { await service.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
	});
	const status = await handlers.get(NATIVE_CHAT_STATUS_COMMAND)!();
	const observation = await service.observe({
		nodeId: randomUUID(), nodeInstanceId: randomUUID(), helperInstanceId: randomUUID(), nodeLabel: 'Target',
		workspaceResolver: { resolve: async () => undefined }, eventSink: { publish() {} },
	});
	return { status, observation, reports, notifications, registrations, root };
}

test('native Chat opt-out does not create history or install an execution observer', async (t) => {
	const f = await fixture(t, { enabled: false });
	assert.deepEqual(f.status, { state: 'disabled' });
	assert.equal(f.observation, undefined);
	assert.equal(f.registrations, 0);
	assert.deepEqual(f.reports, []);
	assert.deepEqual(await readdir(f.root), ['workspace']);
});

test('unsupported or missing native APIs leave the existing execution path unwrapped', async (t) => {
	for (const options of [{ remoteName: 'ssh-remote' }, { missingApi: true }]) {
		const f = await fixture(t, options);
		assert.deepEqual(f.status, { state: options.missingApi ? 'apiUnavailable' : 'unsupportedEnvironment' });
		assert.equal(f.observation, undefined);
		assert.equal(f.registrations, 0);
		assert.deepEqual(f.notifications, []);
		assert.deepEqual(await readdir(f.root), ['workspace']);
	}
});

test('missing proposal permission is an explicit native UI state, not a failed Agent execution', async (t) => {
	const f = await fixture(t);
	assert.deepEqual(f.status, { state: 'permissionRequired' });
	assert.equal(f.observation, undefined);
	assert.equal(f.registrations, 1);
	assert.equal(f.reports.length, 1);
	assert.deepEqual(f.notifications, []);
});

test('unexpected native UI initialization errors are reported instead of a success-shaped fallback', async (t) => {
	const f = await fixture(t, { registrationFailure: 'Unexpected native registration failure.' });
	assert.deepEqual(f.status, { state: 'initializationFailed' });
	assert.equal(f.observation, undefined);
	assert.equal(f.reports.length, 1);
	assert.equal(f.notifications.length, 1);
	assert.match(f.notifications[0], /history is unavailable/);
});
