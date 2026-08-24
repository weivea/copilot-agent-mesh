import * as vscode from 'vscode';

import { MESH_PROTOCOL_VERSION } from '../shared/protocol';
import { registerMeshSpikeEchoTool } from './tools/spikeEchoTool';
import { AgentMeshViewProvider } from './ui/AgentMeshViewProvider';

const configurationSection = 'copilotAgentMesh';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Copilot Agent Mesh');
	const dashboard = new AgentMeshViewProvider();

	const configureDevice = vscode.commands.registerCommand('copilotAgentMesh.configureDevice', async () => {
		const configuration = vscode.workspace.getConfiguration(configurationSection);
		const currentName = configuration.get<string>('deviceName', '');
		const deviceName = await vscode.window.showInputBox({
			title: 'Configure Copilot Agent Mesh Device',
			prompt: 'Choose a recognizable name for this device.',
			placeHolder: 'mac-ios',
			value: currentName,
			ignoreFocusOut: true,
			validateInput: (value) => value.trim().length > 0 ? undefined : 'A device name is required.',
		});

		if (deviceName === undefined) {
			return;
		}

		await configuration.update('deviceName', deviceName.trim(), vscode.ConfigurationTarget.Global);
		dashboard.refresh();
		output.appendLine(`Device name changed to "${deviceName.trim()}".`);
	});

	const refreshDashboard = vscode.commands.registerCommand(
		'copilotAgentMesh.refreshDashboard',
		() => dashboard.refresh(),
	);

	const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(`${configurationSection}.deviceName`)) {
			dashboard.refresh();
		}
	});

	context.subscriptions.push(
		output,
		registerMeshSpikeEchoTool(),
		vscode.window.registerWebviewViewProvider(AgentMeshViewProvider.viewType, dashboard),
		configureDevice,
		refreshDashboard,
		configurationListener,
		vscode.workspace.onDidChangeWorkspaceFolders(() => dashboard.refresh()),
	);

	output.appendLine(`Copilot Agent Mesh activated with protocol v${MESH_PROTOCOL_VERSION}.`);
}

export function deactivate(): void {}
