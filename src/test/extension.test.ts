import * as assert from 'assert';

import * as vscode from 'vscode';

import {
	GATEWAY_METHODS,
	MESH_PROTOCOL_VERSION,
	TASK_STATUSES,
} from '../../shared/protocol';

suite('Copilot Agent Mesh', () => {
	test('contributes the dashboard and setup commands', () => {
		const extension = getExtension();
		const manifest = extension.packageJSON;
		const commands = manifest.contributes.commands as Array<{ command: string }>;
		const views = manifest.contributes.views.copilotAgentMesh as Array<{ id: string }>;

		assert.ok(commands.some(({ command }) => command === 'copilotAgentMesh.configureDevice'));
		assert.ok(commands.some(({ command }) => command === 'copilotAgentMesh.refreshDashboard'));
		assert.ok(views.some(({ id }) => id === 'copilotAgentMesh.dashboard'));
	});

	test('activates successfully', async () => {
		const extension = getExtension();

		await extension.activate();

		assert.strictEqual(extension.isActive, true);
	});

	test('defines the initial gateway protocol surface', () => {
		assert.strictEqual(MESH_PROTOCOL_VERSION, 1);
		assert.strictEqual(GATEWAY_METHODS.taskStart, 'task.start');
		assert.ok(TASK_STATUSES.includes('needsInput'));
	});
});

function getExtension(): vscode.Extension<unknown> {
	const extension = vscode.extensions.getExtension('weivea.copilot-agent-mesh');
	assert.ok(extension, 'The Copilot Agent Mesh extension should be available.');
	return extension;
}
