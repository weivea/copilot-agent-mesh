import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { parse } from 'jsonc-parser';

import {
	desktopRuntimeArgumentsPath, NativeChatPermissionError, persistNativeChatPermission, planNativeChatPermission, registerNativeChatPermissionSetup,
} from '../codespaces/nativeChat/NativeChatPermissionSetup';
import { NATIVE_CHAT_ENABLE_COMMAND, NATIVE_CHAT_EXTENSION_ID } from '../codespaces/nativeChat/NativeChatApi';
import type { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import type { StructuredLogger } from '../logging/StructuredLogger';

test('persistent permission merges only the companion ID and preserves comments, unrelated settings and other extensions', () => {
	const text = [
		'// Preserve this user comment.',
		'{',
		'  "disable-hardware-acceleration": true,',
		'  "enable-proposed-api": [',
		'    "example.existing", // Existing extension permission.',
		'  ],',
		'  "log-level": "warn",',
		'}',
	].join('\r\n');
	const plan = planNativeChatPermission(text);
	assert.deepEqual(parse(plan.contents), {
		'disable-hardware-acceleration': true,
		'enable-proposed-api': ['example.existing', NATIVE_CHAT_EXTENSION_ID],
		'log-level': 'warn',
	});
	assert.ok(plan.contents.includes('// Preserve this user comment.'));
	assert.ok(plan.contents.includes('// Existing extension permission.'));
	assert.ok(!/(?<!\r)\n/u.test(plan.contents));
	assert.deepEqual(planNativeChatPermission(plan.contents), { edits: [], contents: plan.contents });
});

test('persistent permission adds an exact allowlist to empty or existing JSONC objects', () => {
	for (const text of ['{}', '// User file\n{\n\t"disable-hardware-acceleration": false,\n}', '{"enable-proposed-api": []}']) {
		const plan = planNativeChatPermission(text);
		assert.deepEqual(parse(plan.contents)['enable-proposed-api'], [NATIVE_CHAT_EXTENSION_ID]);
		assert.ok(!plan.contents.includes('"*"'));
	}
});

test('an already saved permission is unchanged including case and formatting', () => {
	const text = `{"enable-proposed-api":["${NATIVE_CHAT_EXTENSION_ID.toUpperCase()}"]} // Keep format`;
	assert.deepEqual(planNativeChatPermission(text), { edits: [], contents: text });
});

test('invalid JSONC, wrong list types and duplicate permission keys fail without a fabricated replacement', () => {
	for (const text of [
		'', '// comment only', '[]', 'null', '{bad}', '{"enable-proposed-api": true}',
		'{"enable-proposed-api":"*"}', '{"enable-proposed-api":[false]}',
		'{"enable-proposed-api":[""]}', '{"enable-proposed-api":null}',
		'{"enable-proposed-api":[],"enable-proposed-api":["existing.id"]}',
		'{"enable-proposed-api":[],"enable\\u002dproposed-api":[]}',
	]) {
		assert.throws(() => planNativeChatPermission(text), { code: 'CONFIG_INVALID' }, text);
	}
	assert.throws(() => planNativeChatPermission(' '.repeat(256 * 1024 + 1)), { code: 'CONFIG_TOO_LARGE' });
});

test('runtime config location supports stable, insiders and portable desktop installs, never guessed unknown products', () => {
	const home = homedir();
	assert.equal(desktopRuntimeArgumentsPath('Visual Studio Code', home, undefined), join(home, '.vscode', 'argv.json'));
	assert.equal(desktopRuntimeArgumentsPath('Visual Studio Code - Insiders', home, undefined), join(home, '.vscode-insiders', 'argv.json'));
	assert.equal(desktopRuntimeArgumentsPath('Visual Studio Code', home, join(home, 'portable')), join(home, 'portable', 'argv.json'));
	assert.throws(() => desktopRuntimeArgumentsPath('Unknown editor', home, undefined), { code: 'UNSUPPORTED_HOST' });
	assert.throws(() => desktopRuntimeArgumentsPath('Visual Studio Code', home, 'relative'), { code: 'UNSUPPORTED_HOST' });
});

function editorFixture(options: {
	text?: string; dirty?: boolean; path?: string; scheme?: string; saveFailure?: boolean;
	editFailure?: boolean; changeDuringRead?: boolean; changeBeforeApply?: boolean; externalText?: string; bom?: boolean;
} = {}) {
	let text = options.text ?? '// Existing preferences\n{"enable-proposed-api":["existing.extension"]}';
	let disk = options.externalText ?? text;
	let version = 1;
	let dirty = options.dirty ?? false;
	let edits = 0;
	let saves = 0;
	let reads = 0;
	const commands: string[] = [];
	const uri = {
		scheme: options.scheme ?? 'file', authority: '', query: '', fragment: '',
		fsPath: options.path ?? desktopRuntimeArgumentsPath('Visual Studio Code', homedir(), process.env.VSCODE_PORTABLE),
	};
	const document = {
		uri, get version() { return version; }, get isDirty() { return dirty; }, isClosed: false,
		getText: () => text,
		positionAt: (offset: number) => offset,
		save: async () => {
			saves++;
			if (options.saveFailure) { return false; }
			disk = text;
			dirty = false;
			return true;
		},
	};
	class Range {
		constructor(readonly start: number, readonly end: number) {}
	}
	class Edit {
		readonly changes: { range: Range; contents: string }[] = [];
		replace(target: unknown, range: Range, contents: string) {
			assert.equal(target, uri);
			this.changes.push({ range, contents });
		}
	}
	const api = {
		env: { appName: 'Visual Studio Code' },
		Uri: { file: () => uri },
		commands: { executeCommand: async (command: string) => { commands.push(command); } },
		window: { activeTextEditor: { document } },
		Range, WorkspaceEdit: Edit,
		workspace: {
			fs: {
				readFile: async () => {
					reads++;
					if (options.changeDuringRead && reads === 2) { version++; text += ' '; }
					return Buffer.from(`${options.bom ? '\uFEFF' : ''}${disk}`, 'utf8');
				},
			},
			applyEdit: async (edit: Edit) => {
				edits++;
				if (options.changeBeforeApply) { text += ' // User edit'; version++; return false; }
				if (options.editFailure) { return false; }
				for (const change of [...edit.changes].sort((left, right) => right.range.start - left.range.start)) {
					text = text.slice(0, change.range.start) + change.contents + text.slice(change.range.end);
				}
				version++;
				dirty = true;
				return true;
			},
		},
	} as unknown as typeof vscode;
	return { api, commands, get text() { return text; }, get disk() { return disk; }, get saves() { return saves; }, get edits() { return edits; } };
}

test('desktop persistence uses the native config editor, saves once and is repeat-safe without a launch parameter', async () => {
	const f = editorFixture({ bom: true });
	assert.deepEqual(await persistNativeChatPermission(f.api), { state: 'restartRequired', changed: true });
	assert.equal(f.saves, 1);
	assert.equal(f.disk, f.text);
	assert.deepEqual(parse(f.disk)['enable-proposed-api'], ['existing.extension', NATIVE_CHAT_EXTENSION_ID]);
	assert.deepEqual(f.commands, ['workbench.action.configureRuntimeArguments']);
	assert.deepEqual(await persistNativeChatPermission(f.api), { state: 'restartRequired', changed: false });
	assert.equal(f.saves, 1);
});

test('desktop persistence never edits a repo argv file, remote file, dirty document or externally changed text', async () => {
	const cases = [
		{ options: { path: join(homedir(), 'project', 'argv.json') }, code: 'CONFIG_NOT_READY' },
		{ options: { scheme: 'vscode-remote' }, code: 'CONFIG_NOT_READY' },
		{ options: { dirty: true }, code: 'CONFIG_DIRTY' },
		{ options: { changeDuringRead: true }, code: 'CONFIG_CHANGED' },
		{ options: { externalText: '{"new-setting":true}' }, code: 'CONFIG_CHANGED' },
		{ options: { text: '{"broken":}' }, code: 'CONFIG_INVALID' },
	];
	for (const { options, code } of cases) {
		const f = editorFixture(options);
		const disk = f.disk;
		await assert.rejects(persistNativeChatPermission(f.api), { code });
		assert.equal(f.edits, 0);
		assert.equal(f.saves, 0);
		assert.equal(f.disk, disk);
	}
});

test('edit conflict and save failures surface errors and do not report enabled or revert user content', async () => {
	for (const options of [{ editFailure: true }, { changeBeforeApply: true }, { saveFailure: true }]) {
		const f = editorFixture(options);
		const original = f.disk;
		await assert.rejects(persistNativeChatPermission(f.api), (error: unknown) =>
			error instanceof NativeChatPermissionError
			&& error.code === (options.saveFailure ? 'SAVE_FAILED' : 'CONFIG_CHANGED'));
		assert.equal(f.disk, original);
		if (options.changeBeforeApply) { assert.ok(f.text.endsWith('// User edit')); }
	}
});

test('an already persisted permission does not open or save the config even when the editor has unrelated unsaved edits', async () => {
	const f = editorFixture({ text: `{"enable-proposed-api":["${NATIVE_CHAT_EXTENSION_ID}"]}`, dirty: true });
	assert.deepEqual(await persistNativeChatPermission(f.api), { state: 'restartRequired', changed: false });
	assert.deepEqual(f.commands, []);
	assert.equal(f.edits, 0);
	assert.equal(f.saves, 0);
});

test('desktop command is version-scoped, single-flight and does not restart or sign in', async () => {
	const f = editorFixture();
	let handler!: (input?: unknown) => Promise<unknown>;
	const messages: string[] = [];
	const errors: unknown[] = [];
	const api = {
		...f.api,
		env: { ...f.api.env, remoteName: 'codespaces', uiKind: 1 },
		UIKind: { Desktop: 1 },
		ExtensionKind: { UI: 1 },
		commands: {
			...f.api.commands,
			registerCommand: (name: string, callback: typeof handler) => {
				assert.equal(name, NATIVE_CHAT_ENABLE_COMMAND);
				handler = callback;
				return { dispose() {} };
			},
		},
		window: {
			...f.api.window,
			showInformationMessage: async (message: string) => { messages.push(message); },
			showErrorMessage: async (message: string) => { errors.push(message); },
		},
		l10n: { t: (message: string) => message },
	} as unknown as typeof vscode;
	const context = {
		extension: { extensionKind: 1, packageJSON: { version: '0.5.7' } },
	} as unknown as vscode.ExtensionContext;
	const guard = { assertAllowed() {} } as unknown as LocalDesktopWorkspaceGuard;
	const logger = { log() {}, error: (_area: string, _message: string, error: unknown) => errors.push(error) } as unknown as StructuredLogger;
	const command = registerNativeChatPermissionSetup(api, context, guard, logger);
	try {
		assert.deepEqual(f.commands, []);
		assert.throws(() => handler({ extensionVersion: '0.5.6' }), { code: 'VERSION_MISMATCH' });
		assert.throws(() => handler({ extensionVersion: '0.5.7', path: 'argv.json' }), { code: 'VERSION_MISMATCH' });
		const first = handler({ extensionVersion: '0.5.7' });
		assert.equal(handler({ extensionVersion: '0.5.7' }), first);
		assert.deepEqual(await first, { state: 'restartRequired', changed: true });
		assert.equal(messages.length, 1);
		assert.match(messages[0], /No command-line parameters/);
		await handler({ extensionVersion: '0.5.7' });
		assert.equal(messages.length, 1, 'Idempotent automatic setup must not keep notifying on every activation.');
		assert.deepEqual(f.commands, ['workbench.action.configureRuntimeArguments']);
		assert.deepEqual(errors, []);
	} finally { command.dispose(); }
	assert.throws(() => handler(), { code: 'UNSUPPORTED_HOST' });
});

test('revoked setup lifetime prevents saving without reverting the open native editor', async () => {
	const f = editorFixture();
	let assertions = 0;
	await assert.rejects(persistNativeChatPermission(f.api, () => {
		assertions++;
		if (assertions === 4) { throw new NativeChatPermissionError('UNSUPPORTED_HOST'); }
	}), { code: 'UNSUPPORTED_HOST' });
	assert.equal(f.saves, 0);
});
