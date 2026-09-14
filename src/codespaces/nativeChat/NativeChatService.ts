import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type * as vscode from 'vscode';

import { canonicalCodespaceStorageBase } from '../CodespaceStorage';
import {
	hasNativeChatApi, NATIVE_CHAT_ENABLE_COMMAND, NATIVE_CHAT_HELP_COMMAND, NATIVE_CHAT_OPEN_COMMAND, NATIVE_CHAT_STATUS_COMMAND,
	nativeChatEnableResultSchema,
	type NativeChatStatus,
} from './NativeChatApi';
import { NativeChatControlRegistry, NativeChatExecution } from './NativeChatExecution';
import { NativeChatProvider } from './NativeChatProvider';
import { NativeChatStore } from './NativeChatStore';
import type { RemoteExecutionExecutorContext } from '../RemoteExecutionServer';

export interface NativeChatService {
	status(): NativeChatStatus;
	observe(context: RemoteExecutionExecutorContext): Promise<NativeChatExecution | undefined>;
	dispose(): Promise<void>;
}

export function createNativeChatService(
	api: typeof vscode,
	context: vscode.ExtensionContext,
	reportError: (error: unknown) => void,
): NativeChatService {
	let state: NativeChatStatus['state'] = 'disabled';
	let provider: NativeChatProvider | undefined;
	let store: NativeChatStore | undefined;
	let storeReady = false;
	let disposed = false;
	let warned = false;
	let presentationWarned = false;
	let workspaceUris: ReadonlySet<string> = new Set();
	let workspaceRevision = 0;
	const controls = new NativeChatControlRegistry();
	const reportHistoryError = (error: unknown) => {
		reportError(error);
		if (!warned && !disposed) {
			warned = true;
			void api.window.showErrorMessage(api.l10n.t(
				'Native Mesh Chat or history is unavailable. Mesh task execution is separate; use the source task for its result. See Output: Copilot Agent Mesh - Codespaces.',
			));
		}
	};
	const initialize = async () => {
		if (api.env.remoteName !== 'codespaces' || api.env.uiKind !== api.UIKind.Desktop || !api.workspace.isTrusted) {
			state = 'unsupportedEnvironment';
			return;
		}
		if (!api.workspace.getConfiguration('copilotAgentMesh').get<boolean>('codespaces.nativeChat.enabled', true)) { return; }
		if (!hasNativeChatApi(api)) { state = 'apiUnavailable'; return; }
		const base = await canonicalCodespaceStorageBase(context.globalStorageUri.fsPath);
		store = new NativeChatStore({ rootDirectory: join(base, 'chat-history') });
		await store.initialize();
		storeReady = true;
		await updateWorkspaces();
		if (disposed) { return; }
		try {
			provider = new NativeChatProvider(api, store, {
				controls,
				workspaceUris: () => workspaceUris,
				autoOpen: () => api.workspace.getConfiguration('copilotAgentMesh').get<boolean>('codespaces.nativeChat.autoOpen', true),
				confirmCancellation: async (title) => {
					const action = api.l10n.t('Cancel task');
					return await api.window.showWarningMessage(
						api.l10n.t('Cancel Mesh task "{0}"?', title), { modal: true }, action,
					) === action;
				},
				reportError: reportHistoryError,
				reportActionError: reportError,
			});
			state = 'enabled';
		} catch (error: unknown) {
			if (error instanceof Error && /proposal/i.test(error.message)
				&& /chatSessionsProvider|chatParticipantPrivate/.test(error.message)) {
				state = 'permissionRequired';
				return;
			}
			throw error;
		}
	};
	const ready = initialize().catch((error: unknown) => {
		state = 'initializationFailed';
		reportHistoryError(error);
	});
	let automaticSetup: Promise<void> = Promise.resolve();
	const subscriptions = [
		api.commands.registerCommand(NATIVE_CHAT_OPEN_COMMAND, async (resource?: unknown) => {
			await ready;
			if (provider !== undefined) { await provider.openCommand(resource); }
			else { await api.commands.executeCommand(NATIVE_CHAT_HELP_COMMAND); }
		}),
		api.commands.registerCommand(NATIVE_CHAT_STATUS_COMMAND, async () => {
			await ready;
			await automaticSetup;
			return { state } satisfies NativeChatStatus;
		}),
		api.commands.registerCommand(NATIVE_CHAT_HELP_COMMAND, async () => {
			await ready;
			await automaticSetup;
			if (state === 'permissionRequired') {
				await enablePermission();
			} else if (state === 'restartRequired') {
				void api.window.showInformationMessage(api.l10n.t(
					'Native Codespaces Chat permission is saved. Fully quit all VS Code windows and reopen once. No command-line parameters are needed.',
				));
			} else if (state === 'enabled') {
				void api.window.showInformationMessage(api.l10n.t('Native Codespaces Chat is enabled. No command-line parameters are needed.'));
			} else {
				void api.window.showInformationMessage(api.l10n.t(
					'Native Chat is unavailable ({0}). Use desktop VS Code 1.137 or newer with nativeChat.enabled turned on; see the Codespaces Output for errors.',
					state,
				));
			}
		}),
		api.workspace.onDidChangeWorkspaceFolders(() => {
			if (store === undefined || disposed) { return; }
			workspaceRevision += 1;
			workspaceUris = new Set();
			provider?.refresh();
			void ready.then(updateWorkspaces).catch(reportHistoryError);
		}),
	];
	automaticSetup = ready.then(async () => {
		if (!disposed && (state === 'permissionRequired' || state === 'enabled')) { await enablePermission(); }
	}).catch((error: unknown) => {
		reportError(error);
		if (!disposed) {
			void api.window.showErrorMessage(api.l10n.t(
				'Automatic native Chat setup did not complete. Run Enable Native Codespaces Chat to retry; see Output: Copilot Agent Mesh.',
			));
		}
	});
	return {
		status: () => ({ state }),
		observe: async (execution) => {
			await ready;
			if (store === undefined || !storeReady || disposed) { return undefined; }
			if (provider === undefined && !presentationWarned) {
				presentationWarned = true;
				void api.window.showWarningMessage(api.l10n.t(
					state === 'permissionRequired' || state === 'restartRequired'
						? 'Mesh is saving this task history, but native Chat is waiting for a full VS Code restart. Fully quit all VS Code windows and reopen; no launch parameters are needed.'
						: 'Mesh is saving this task history, but native Chat is unavailable. See Output: Copilot Agent Mesh - Codespaces.',
				));
			}
			return new NativeChatExecution({
				generation: execution.helperInstanceId,
				nodeId: execution.nodeId,
				nodeInstanceId: execution.nodeInstanceId,
				workspaceResolver: execution.workspaceResolver,
				store,
				controls,
				reportError: reportHistoryError,
			});
		},
		dispose: async () => {
			disposed = true;
			for (const subscription of subscriptions) { subscription.dispose(); }
			await ready;
			await automaticSetup;
			provider?.dispose();
			await store?.flush();
		},
	};

	async function enablePermission(): Promise<void> {
		const alreadyEnabled = state === 'enabled';
		const result = nativeChatEnableResultSchema.parse(await api.commands.executeCommand(NATIVE_CHAT_ENABLE_COMMAND, {
			extensionVersion: String(context.extension.packageJSON.version),
		}));
		if (!disposed && !alreadyEnabled) {
			state = result.state;
			if (!result.changed) {
				void api.window.showInformationMessage(api.l10n.t(
					'Native Codespaces Chat permission is saved. Fully quit all VS Code windows and reopen once. No command-line parameters are needed.',
				));
			}
		}
	}

	async function updateWorkspaces(): Promise<void> {
		const revision = ++workspaceRevision;
		const folders = api.workspace.workspaceFolders ?? [];
		const uris = await Promise.all(folders.map(async (folder) => {
			if (folder.uri.scheme !== 'file') { throw new Error('Native Mesh Chat requires Codespace filesystem folders.'); }
			return api.Uri.file(await realpath(folder.uri.fsPath)).toString();
		}));
		if (!disposed && revision === workspaceRevision) {
			workspaceUris = new Set(uris);
			provider?.refresh();
		}
	}
}
