import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type * as vscode from 'vscode';

import { canonicalCodespaceStorageBase } from '../CodespaceStorage';
import {
	hasNativeChatApi, NATIVE_CHAT_EXTENSION_ID, NATIVE_CHAT_HELP_COMMAND, NATIVE_CHAT_OPEN_COMMAND, NATIVE_CHAT_STATUS_COMMAND,
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
	let disposed = false;
	let warned = false;
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
				reportError(error);
				return;
			}
			throw error;
		}
	};
	const ready = initialize().catch((error: unknown) => {
		state = 'initializationFailed';
		reportHistoryError(error);
	});
	const subscriptions = [
		api.commands.registerCommand(NATIVE_CHAT_OPEN_COMMAND, async (resource?: unknown) => {
			await ready;
			if (provider !== undefined) { await provider.openCommand(resource); }
			else { await api.commands.executeCommand(NATIVE_CHAT_HELP_COMMAND); }
		}),
		api.commands.registerCommand(NATIVE_CHAT_STATUS_COMMAND, async () => {
			await ready;
			return { state } satisfies NativeChatStatus;
		}),
		api.commands.registerCommand(NATIVE_CHAT_HELP_COMMAND, async () => {
			await ready;
			const copy = api.l10n.t('Copy launch command');
			const configure = api.l10n.t('Open runtime arguments');
			const choice = await api.window.showInformationMessage(
				api.l10n.t('Native Mesh Chat is a POC using proposed VS Code APIs ({0}).', state),
				{
					modal: true,
					detail: api.l10n.t('Use desktop VS Code 1.137 or newer. Fully quit VS Code, then start it with --enable-proposed-api weivea.copilot-agent-mesh-codespaces and reconnect to the Codespace. Alternatively, add this extension ID to the existing enable-proposed-api array in the desktop runtime arguments and restart. This command does not change your settings or start a task.'),
				},
				copy, configure,
			);
			if (choice === copy) {
				await api.env.clipboard.writeText(`code --enable-proposed-api ${NATIVE_CHAT_EXTENSION_ID}`);
			} else if (choice === configure) {
				await api.commands.executeCommand('workbench.action.configureRuntimeArguments');
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
	return {
		status: () => ({ state }),
		observe: async (execution) => {
			await ready;
			return store === undefined || provider === undefined || disposed ? undefined : new NativeChatExecution({
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
			provider?.dispose();
			await store?.flush();
		},
	};

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
