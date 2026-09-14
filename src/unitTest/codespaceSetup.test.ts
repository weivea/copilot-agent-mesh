import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { registerCodespaceSetup } from '../codespaces/CodespaceSetup';
import { CODESPACES_PREPARE_RUNTIME_COMMAND, CODESPACES_SETUP_COMMAND } from '../codespaces/CodespaceEnvironment';
import type { StructuredLogger } from '../logging/StructuredLogger';
import { NATIVE_CHAT_ENABLE_COMMAND, NATIVE_CHAT_HELP_COMMAND, NATIVE_CHAT_STATUS_COMMAND } from '../codespaces/nativeChat/NativeChatApi';

function fixture(options: { cancel?: boolean; declineReload?: boolean; failInstall?: boolean; result?: unknown; nativeChatState?: string } = {}) {
	const calls: { command: string; args: readonly unknown[] }[] = [];
	const errors: unknown[] = [];
	const messages: string[] = [];
	let prompts = 0;
	let handler!: () => Promise<void>;
	const api = {
		env: { remoteName: 'codespaces', uiKind: 1 },
		UIKind: { Desktop: 1 },
		l10n: { t: (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/gu, (_match, index: string) => args[Number(index)]) },
		commands: {
			registerCommand: (command: string, callback: () => Promise<void>) => {
				assert.equal(command, CODESPACES_SETUP_COMMAND);
				handler = callback;
				return { dispose() {} };
			},
			executeCommand: async (command: string, ...args: unknown[]) => {
				calls.push({ command, args });
				if (command === 'workbench.extensions.installExtension' && options.failInstall) {
					throw new Error('Installation refused.');
				}
				if (command === NATIVE_CHAT_STATUS_COMMAND) { return { state: options.nativeChatState ?? 'enabled' }; }
				return command === CODESPACES_PREPARE_RUNTIME_COMMAND ? options.result ?? { ready: true } : undefined;
			},
		},
		Uri: { joinPath: (_uri: unknown, ...parts: string[]) => ({ path: parts.join('/') }) },
		workspace: { fs: { stat: async () => ({ type: 1 }) } },
		window: {
			showInformationMessage: async (message: string, detailOrChoice: unknown, ...choices: string[]) => {
				prompts += 1;
				messages.push(message);
				if (options.declineReload && detailOrChoice === 'Reload window') { return undefined; }
				return options.cancel ? undefined : typeof detailOrChoice === 'string' ? detailOrChoice : choices[0];
			},
			showErrorMessage: async (message: string) => { errors.push(message); },
		},
	} as unknown as typeof vscode;
	const context = { extensionUri: {}, extension: { packageJSON: { version: '0.5.0' } } } as unknown as vscode.ExtensionContext;
	const guard = new LocalDesktopWorkspaceGuard(() => ({
		remoteName: 'codespaces', uiKind: 'desktop', extensionKind: 'ui', isTrusted: true,
		workspaceFolders: [{ uriScheme: 'vscode-remote', uriAuthority: 'codespaces+test' }],
	}));
	const registration = registerCodespaceSetup(api, context, guard, {
		error: (_category: string, _message: string, error: unknown) => errors.push(error),
		log: (_level: string, _category: string, _message: string, fields: unknown) => errors.push(fields),
	} as unknown as StructuredLogger);
	return { registration, calls, errors, messages, run: () => handler(), get prompts() { return prompts; } };
}

test('registration performs no setup; an explicit accepted action installs only the bundled companion', async (t) => {
	const f = fixture();
	t.after(() => f.registration.dispose());
	assert.equal(f.prompts, 0);
	assert.equal(f.calls.length, 0);
	const first = f.run();
	assert.equal(f.run(), first);
	await first;
	assert.deepEqual(f.calls.map((call) => call.command), [
		'workbench.extensions.installExtension',
		CODESPACES_PREPARE_RUNTIME_COMMAND,
		NATIVE_CHAT_STATUS_COMMAND,
		'workbench.action.reloadWindow',
	]);
	assert.deepEqual(f.calls[0].args, [{ path: 'dist/codespaces-companion.vsix' }]);
	assert.deepEqual(f.calls[1].args, [{ extensionVersion: '0.5.0' }]);
});

test('setup saves native permission directly without asking for a launch flag or reloading only the window', async (t) => {
	const f = fixture({ nativeChatState: 'permissionRequired' });
	t.after(() => f.registration.dispose());
	await f.run();
	assert.ok(f.calls.some(({ command }) => command === NATIVE_CHAT_ENABLE_COMMAND));
	assert.ok(!f.calls.some(({ command }) => command === 'workbench.action.reloadWindow'));
	assert.equal(f.errors.length, 0);
});

test('persisted native permission asks for a full restart and never resaves or starts a task', async (t) => {
	const f = fixture({ nativeChatState: 'restartRequired' });
	t.after(() => f.registration.dispose());
	await f.run();
	assert.match(f.messages.at(-1)!, /Fully quit all VS Code windows/);
	assert.match(f.messages.at(-1)!, /No command-line parameters/);
	assert.ok(!f.calls.some(({ command }) => command === NATIVE_CHAT_ENABLE_COMMAND || command === 'workbench.action.reloadWindow'));
});

test('setup respects a native Chat opt-out instead of granting permission automatically', async (t) => {
	const f = fixture({ nativeChatState: 'disabled' });
	t.after(() => f.registration.dispose());
	await f.run();
	assert.ok(!f.calls.some(({ command }) => command === NATIVE_CHAT_ENABLE_COMMAND));
	assert.ok(f.calls.some(({ command }) => command === NATIVE_CHAT_HELP_COMMAND));
});

test('setup reports the exact preparation failure without blaming native or Tunnel accounts', async (t) => {
	for (const code of ['ENVIRONMENT_CHECK_FAILED', 'UNSUPPORTED_ENVIRONMENT', 'NETWORK_ERROR']) {
		const f = fixture({ result: { ready: false, error: { code } } });
		t.after(() => f.registration.dispose());
		await assert.rejects(f.run(), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /preparing the native Codespaces runtime/u);
			assert.ok(error.message.includes(`[${code}]`));
			assert.doesNotMatch(error.message, /same account|switch account/iu);
			if (code === 'ENVIRONMENT_CHECK_FAILED') {
				assert.match(error.message, /getconf GNU_LIBC_VERSION/u);
				assert.match(error.message, /does not mean glibc is too old/u);
			}
			return true;
		});

		test('updating an active companion asks for reload instead of reporting a failed install or claiming readiness', async (t) => {
			for (const declineReload of [false, true]) {
				const f = fixture({ declineReload, result: { ready: false, error: { code: 'PROTOCOL_INCOMPATIBLE' } } });
				t.after(() => f.registration.dispose());
				await f.run();
				assert.equal(f.errors.length, 0);
				assert.match(f.messages.at(-1)!, /old version is still active/u);
				assert.match(f.messages.at(-1)!, /run Prepare Codespaces Runtime again/u);
				assert.ok(!f.messages.some((message) => message.includes('runtime is ready')));
				assert.equal(f.calls.filter((call) => call.command === 'workbench.action.reloadWindow').length, declineReload ? 0 : 1);
				assert.equal(f.calls.filter((call) => call.command === CODESPACES_PREPARE_RUNTIME_COMMAND).length, 1);
			}
		});
		assert.ok(!f.calls.some((call) => call.command === 'workbench.action.reloadWindow'));
	}
});

test('setup diagnostics do not copy arbitrary remote messages into user notifications', async (t) => {
	const f = fixture({ result: { ready: false, error: { code: 'UNKNOWN_SECRET_DETAIL', message: 'private-token-marker' } } });
	t.after(() => f.registration.dispose());
	await assert.rejects(f.run(), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /SETUP_FAILED/u);
		assert.doesNotMatch(error.message, /private-token-marker|UNKNOWN_SECRET_DETAIL/u);
		return true;
	});
});

test('cancelling setup never downloads, installs, authorizes or reloads', async (t) => {
	const f = fixture({ cancel: true });
	t.after(() => f.registration.dispose());
	await f.run();
	assert.equal(f.prompts, 1);
	assert.deepEqual(f.calls, []);
});

test('setup surfaces failed installation and malformed companion receipts instead of reporting ready', async (t) => {
	for (const options of [{ failInstall: true }, { result: { ready: true, unexpected: true } }]) {
		const f = fixture(options);
		t.after(() => f.registration.dispose());
		await assert.rejects(f.run(), { code: 'AGENT_UNAVAILABLE' });
		assert.ok(f.errors.length >= 2);
		assert.ok(!f.calls.some((call) => call.command === 'workbench.action.reloadWindow'));
	}
	const declined = fixture({ result: { ready: false } });
	t.after(() => declined.registration.dispose());
	await declined.run();
	assert.ok(!declined.calls.some((call) => call.command === 'workbench.action.reloadWindow'));
});
