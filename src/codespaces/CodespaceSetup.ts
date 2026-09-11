import type * as vscode from 'vscode';

import type { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import type { StructuredLogger } from '../logging/StructuredLogger';
import {
	CODESPACES_PREPARE_RUNTIME_COMMAND,
	CODESPACES_SETUP_COMMAND,
} from './CodespaceEnvironment';
import { AgentRuntimeError } from '../agentHost/AgentRuntime';
import {
	codespacePreparedSchema,
	CodespacePreparationError,
} from './CodespaceSetupProtocol';

export function registerCodespaceSetup(
	api: typeof vscode,
	context: vscode.ExtensionContext,
	guard: LocalDesktopWorkspaceGuard,
	logger: StructuredLogger,
): vscode.Disposable {
	let operation: Promise<void> | undefined;
	return api.commands.registerCommand(CODESPACES_SETUP_COMMAND, () => {
		if (operation !== undefined) {
			return operation;
		}
		operation = prepare().finally(() => { operation = undefined; });
		return operation;
	});

	async function prepare(): Promise<void> {
		guard.assertAllowed();
		if (api.env.remoteName !== 'codespaces' || api.env.uiKind !== api.UIKind.Desktop) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'Open a Codespace in desktop VS Code first.');
		}
		const install = api.l10n.t('Install and prepare');
		const choice = await api.window.showInformationMessage(
			api.l10n.t('Install the matching Mesh companion in this Codespace?'),
			{
				modal: true,
				detail: api.l10n.t('The companion runs authorized tasks in this Codespace. Native CLI download and license acceptance are a separate confirmation. No task is started.'),
			},
			install,
		);
		if (choice !== install) {
			return;
		}
		let stage = api.l10n.t('reading the bundled companion');
		try {
			const vsix = api.Uri.joinPath(context.extensionUri, 'dist', 'codespaces-companion.vsix');
			await api.workspace.fs.stat(vsix);
			stage = api.l10n.t('installing the Codespaces companion');
			await api.commands.executeCommand('workbench.extensions.installExtension', vsix);
			stage = api.l10n.t('preparing the native Codespaces runtime');
			const prepared = codespacePreparedSchema.parse(await api.commands.executeCommand(
				CODESPACES_PREPARE_RUNTIME_COMMAND,
				{ extensionVersion: String(context.extension.packageJSON.version) },
			));
			if (!prepared.ready) {
				if (prepared.error?.code === 'PROTOCOL_INCOMPATIBLE') {
					const reload = api.l10n.t('Reload window');
					if (await api.window.showInformationMessage(
						api.l10n.t('The matching companion is installed but the old version is still active. Reload this window, then run Prepare Codespaces Runtime again.'),
						reload,
					) === reload) {
						await api.commands.executeCommand('workbench.action.reloadWindow');
					}
					return;
				}
				if (prepared.error !== undefined) {
					throw new CodespacePreparationError(prepared.error.code);
				}
				return;
			}
			const reload = api.l10n.t('Reload window');
			if (await api.window.showInformationMessage(
				api.l10n.t('Codespaces runtime is ready. Reload this window to connect Mesh.'),
				reload,
			) === reload) {
				await api.commands.executeCommand('workbench.action.reloadWindow');
			}
		} catch (error: unknown) {
			logger.error('codespaces', 'Codespaces setup failed.', error);
			const code = error instanceof CodespacePreparationError ? error.code : 'SETUP_FAILED';
			const detail = error instanceof CodespacePreparationError ? api.l10n.t(error.message)
				: api.l10n.t('See Output: Copilot Agent Mesh. If the companion was just installed, reload this window and retry setup.');
			const message = api.l10n.t('Codespaces setup failed while {0} [{1}]. {2}', stage, code, detail);
			logger.log('error', 'codespaces', 'Codespaces setup stage failed.', { stage, code });
			await api.window.showErrorMessage(message);
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', message);
		}
	}
}
