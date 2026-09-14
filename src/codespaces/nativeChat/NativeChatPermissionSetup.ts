import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { applyEdits, modify, parseTree, type Edit, type ParseError } from 'jsonc-parser';
import type * as vscode from 'vscode';

import type { LocalDesktopWorkspaceGuard } from '../../application/LocalDesktopWorkspaceGuard';
import type { StructuredLogger } from '../../logging/StructuredLogger';
import {
	NATIVE_CHAT_ENABLE_COMMAND, NATIVE_CHAT_EXTENSION_ID, nativeChatEnableRequestSchema,
	type NativeChatEnableResult,
} from './NativeChatApi';

const permissionKey = 'enable-proposed-api';
const maximumConfigBytes = 256 * 1024;

export const NATIVE_CHAT_PERMISSION_ERRORS = {
	UNSUPPORTED_HOST: 'Native Codespaces Chat setup requires the desktop Mesh extension in a trusted Codespace window.',
	CONFIG_NOT_READY: 'VS Code did not open its desktop runtime configuration. Retry Enable Native Codespaces Chat.',
	CONFIG_DIRTY: 'Save or discard your existing edits to the VS Code runtime configuration, then retry Enable Native Codespaces Chat.',
	CONFIG_INVALID: 'The VS Code runtime configuration contains invalid JSONC or an invalid or duplicate proposed-API list. Correct it before retrying.',
	CONFIG_CHANGED: 'The VS Code runtime configuration changed during setup. Review it and retry; no concurrent edits were reverted.',
	SAVE_FAILED: 'VS Code could not save the native Chat permission. Review the open runtime configuration and retry.',
	CONFIG_TOO_LARGE: 'The VS Code runtime configuration exceeds the supported size for automatic native Chat setup.',
	VERSION_MISMATCH: 'Update both Mesh extensions to the same version and reload this window before enabling native Chat.',
} as const;

export class NativeChatPermissionError extends Error {
	public constructor(public readonly code: keyof typeof NATIVE_CHAT_PERMISSION_ERRORS) {
		super(NATIVE_CHAT_PERMISSION_ERRORS[code]);
	}
}

export function planNativeChatPermission(text: string): { readonly edits: readonly Edit[]; readonly contents: string } {
	if (Buffer.byteLength(text, 'utf8') > maximumConfigBytes) { throw new NativeChatPermissionError('CONFIG_TOO_LARGE'); }
	const errors: ParseError[] = [];
	const root = parseTree(text, errors, { allowTrailingComma: true });
	if (errors.length || root?.type !== 'object') { throw new NativeChatPermissionError('CONFIG_INVALID'); }
	const properties = (root.children ?? []).filter((property) => property.children?.[0]?.value === permissionKey);
	if (properties.length > 1) { throw new NativeChatPermissionError('CONFIG_INVALID'); }
	const current = properties[0]?.children?.[1];
	if (current !== undefined) {
		if (current.type !== 'array' || current.children?.some((item) =>
			item.type !== 'string' || typeof item.value !== 'string' || item.value.trim().length === 0)) {
			throw new NativeChatPermissionError('CONFIG_INVALID');
		}
		if (current.children?.some((item) => String(item.value).toLowerCase() === NATIVE_CHAT_EXTENSION_ID)) {
			return { edits: [], contents: text };
		}
	}
	const indentation = /(?:^|\r?\n)([ \t]+)"/u.exec(text)?.[1] ?? '\t';
	const edits = modify(
		text,
		current === undefined ? [permissionKey] : [permissionKey, -1],
		current === undefined ? [NATIVE_CHAT_EXTENSION_ID] : NATIVE_CHAT_EXTENSION_ID,
		{ formattingOptions: {
			insertSpaces: !indentation.includes('\t'),
			tabSize: indentation.includes('\t') ? 4 : indentation.length,
			eol: text.includes('\r\n') ? '\r\n' : '\n',
		} },
	);
	const contents = applyEdits(text, edits);
	if (Buffer.byteLength(contents, 'utf8') > maximumConfigBytes) { throw new NativeChatPermissionError('CONFIG_TOO_LARGE'); }
	return { edits, contents };
}

export function desktopRuntimeArgumentsPath(
	appName: string,
	home: string,
	portable: string | undefined,
): string {
	if (portable) {
		if (!isAbsolute(portable)) { throw new NativeChatPermissionError('UNSUPPORTED_HOST'); }
		return join(portable, 'argv.json');
	}
	const folder = appName === 'Visual Studio Code' ? '.vscode'
		: appName === 'Visual Studio Code - Insiders' ? '.vscode-insiders' : undefined;
	if (folder === undefined || !isAbsolute(home)) { throw new NativeChatPermissionError('UNSUPPORTED_HOST'); }
	return join(home, folder, 'argv.json');
}

export async function persistNativeChatPermission(
	api: typeof vscode,
	assertAllowed: () => void = () => undefined,
): Promise<NativeChatEnableResult> {
	assertAllowed();
	const expected = desktopRuntimeArgumentsPath(api.env.appName, homedir(), process.env.VSCODE_PORTABLE);
	const existing = await api.workspace.fs.readFile(api.Uri.file(expected));
	assertAllowed();
	if (planNativeChatPermission(decode(existing)).edits.length === 0) {
		return { state: 'restartRequired', changed: false };
	}
	await api.commands.executeCommand('workbench.action.configureRuntimeArguments');
	const opened = api.window.activeTextEditor?.document;
	if (opened === undefined || opened.uri.scheme !== 'file' || opened.uri.authority !== ''
		|| opened.uri.query !== '' || opened.uri.fragment !== '' || basename(opened.uri.fsPath) !== 'argv.json'
		|| !samePath(opened.uri.fsPath, expected)) {
		throw new NativeChatPermissionError('CONFIG_NOT_READY');
	}
	const document = opened;
	const version = document.version;
	const original = document.getText();
	assertCurrent();
	const stored = await api.workspace.fs.readFile(document.uri);
	assertCurrent();
	if (decode(stored) !== original) { throw new NativeChatPermissionError('CONFIG_CHANGED'); }
	const plan = planNativeChatPermission(original);
	if (plan.edits.length === 0) { return { state: 'restartRequired', changed: false }; }
	const edit = new api.WorkspaceEdit();
	for (const change of plan.edits) {
		edit.replace(document.uri, new api.Range(document.positionAt(change.offset), document.positionAt(change.offset + change.length)), change.content);
	}
	assertCurrent();
	if (!await api.workspace.applyEdit(edit)) { throw new NativeChatPermissionError('CONFIG_CHANGED'); }
	assertAllowed();
	if (document.isClosed || document.getText() !== plan.contents) { throw new NativeChatPermissionError('CONFIG_CHANGED'); }
	if (!await document.save()) { throw new NativeChatPermissionError('SAVE_FAILED'); }
	const saved = await api.workspace.fs.readFile(document.uri);
	if (document.isDirty || document.getText() !== plan.contents || decode(saved) !== plan.contents) {
		throw new NativeChatPermissionError('CONFIG_CHANGED');
	}
	return { state: 'restartRequired', changed: true };

	function assertCurrent(): void {
		assertAllowed();
		if (document.isDirty) { throw new NativeChatPermissionError('CONFIG_DIRTY'); }
		if (document.isClosed || document.version !== version || document.getText() !== original) {
			throw new NativeChatPermissionError('CONFIG_CHANGED');
		}
	}
}

export function registerNativeChatPermissionSetup(
	api: typeof vscode,
	context: vscode.ExtensionContext,
	guard: LocalDesktopWorkspaceGuard,
	logger: StructuredLogger,
): vscode.Disposable {
	let operation: Promise<NativeChatEnableResult> | undefined;
	let stopping = false;
	const assertAllowed = () => {
		guard.assertAllowed();
		if (stopping || api.env.remoteName !== 'codespaces' || api.env.uiKind !== api.UIKind.Desktop
			|| context.extension.extensionKind !== api.ExtensionKind.UI) {
			throw new NativeChatPermissionError('UNSUPPORTED_HOST');
		}
	};
	const command = api.commands.registerCommand(NATIVE_CHAT_ENABLE_COMMAND, (input?: unknown) => {
		assertAllowed();
		if (input !== undefined) {
			const request = nativeChatEnableRequestSchema.safeParse(input);
			if (!request.success || request.data.extensionVersion !== String(context.extension.packageJSON.version)) {
				throw new NativeChatPermissionError('VERSION_MISMATCH');
			}
		}
		if (operation !== undefined) { return operation; }
		operation = enable(input === undefined).finally(() => { operation = undefined; });
		return operation;
	});
	return { dispose: () => { stopping = true; command.dispose(); } };

	async function enable(manual: boolean): Promise<NativeChatEnableResult> {
		try {
			const result = await persistNativeChatPermission(api, assertAllowed);
			logger.log('info', 'codespaces', 'Native Chat permission is saved for normal desktop startup.', { changed: result.changed });
			if (result.changed || manual) {
				void api.window.showInformationMessage(api.l10n.t(
					'Native Codespaces Chat permission is saved. Fully quit all VS Code windows and reopen once. No command-line parameters are needed.',
				));
			}
			return result;
		} catch (error: unknown) {
			logger.error('codespaces', 'Saving native Chat permission failed.', error);
			const message = error instanceof NativeChatPermissionError ? api.l10n.t(error.message)
				: api.l10n.t('Native Chat permission could not be saved. See Output: Copilot Agent Mesh.');
			void api.window.showErrorMessage(message);
			throw error instanceof NativeChatPermissionError ? error : new NativeChatPermissionError('SAVE_FAILED');
		}
	}
}

function samePath(left: string, right: string): boolean {
	return process.platform === 'win32' ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
		: normalize(left) === normalize(right);
}

function decode(contents: Uint8Array): string {
	return Buffer.from(contents).toString('utf8').replace(/^\uFEFF/u, '');
}
