import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import {
	MESH_SPIKE_ECHO_TOOL_NAME,
	prepareSpikeInvocation,
	SpikeEchoCoordinator,
	SpikeEchoInput,
} from './spikeEchoCore';

export class MeshSpikeEchoTool implements vscode.LanguageModelTool<SpikeEchoInput> {
	constructor(private readonly coordinator = new SpikeEchoCoordinator({ newId: randomUUID })) {}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<SpikeEchoInput>,
		_token: vscode.CancellationToken,
	): vscode.PreparedToolInvocation {
		const preparation = prepareSpikeInvocation(options.input);
		return {
			invocationMessage: preparation.invocationMessage,
			confirmationMessages: {
				title: preparation.confirmationTitle,
				message: preparation.confirmationMessage,
			},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<SpikeEchoInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const result = await this.coordinator.invoke(options.input, token);
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(JSON.stringify(result)),
		]);
	}
}

export function registerMeshSpikeEchoTool(): vscode.Disposable {
	return vscode.lm.registerTool(MESH_SPIKE_ECHO_TOOL_NAME, new MeshSpikeEchoTool());
}
