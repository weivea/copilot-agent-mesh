import * as assert from 'assert';

import * as vscode from 'vscode';

import {
	GATEWAY_METHODS,
	MESH_PROTOCOL_VERSION,
	TASK_STATUSES,
} from '../../shared/protocol';
import {
	MESH_SPIKE_ECHO_TOOL_NAME,
	SpikeEchoCoordinator,
} from '../tools/spikeEchoCore';
import { MeshSpikeEchoTool } from '../tools/spikeEchoTool';

suite('Copilot Agent Mesh', () => {
	test('cold host has an implicit activation path for the contributed tool', async () => {
		const extension = getExtension();
		const manifestTools = extension.packageJSON.contributes.languageModelTools as Array<{ name: string }>;

		assert.strictEqual(extension.isActive, false);
		assert.strictEqual(extension.packageJSON.activationEvents.length, 0);
		assert.deepStrictEqual(manifestTools.map(({ name }) => name), [MESH_SPIKE_ECHO_TOOL_NAME]);

		const cancellation = new vscode.CancellationTokenSource();
		try {
			const invocation = vscode.lm.invokeTool(MESH_SPIKE_ECHO_TOOL_NAME, {
				input: {
					message: 'cold activation probe',
					delaySeconds: 5,
					confirmationBudgetSeconds: 5,
				},
				toolInvocationToken: undefined,
			}, cancellation.token);
			setTimeout(() => cancellation.cancel(), 0);
			await invocation;
		} catch (error) {
			assert.match(String(error), /cancel/i);
		} finally {
			cancellation.dispose();
		}

		assert.strictEqual(extension.isActive, true);
		assert.ok(vscode.lm.tools.some(({ name }) => name === MESH_SPIKE_ECHO_TOOL_NAME));
	});

	test('contributes the dashboard and setup commands', () => {
		const extension = getExtension();
		const manifest = extension.packageJSON;
		const commands = manifest.contributes.commands as Array<{ command: string }>;
		const views = manifest.contributes.views.copilotAgentMesh as Array<{ id: string }>;

		assert.ok(commands.some(({ command }) => command === 'copilotAgentMesh.configureDevice'));
		assert.ok(commands.some(({ command }) => command === 'copilotAgentMesh.refreshDashboard'));
		assert.ok(views.some(({ id }) => id === 'copilotAgentMesh.dashboard'));
		assert.deepStrictEqual(manifest.extensionKind, ['ui']);
	});

	test('prepares confirmation copy and returns compact structured text', async () => {
		let idsAllocated = 0;
		let tasksStarted = 0;
		const coordinator = new SpikeEchoCoordinator({
			clock: {
				sleep: (delayMs) => delayMs === 5_000
					? Promise.resolve()
					: new Promise(() => undefined),
			},
			newId: () => `id-${++idsAllocated}`,
			onTaskStarted: () => tasksStarted += 1,
		});
		const tool = new MeshSpikeEchoTool(coordinator);
		const cancellation = new vscode.CancellationTokenSource();
		const input = {
			message: 'structured result probe',
			delaySeconds: 5 as const,
			confirmationBudgetSeconds: 15 as const,
			delegationRequestId: 'text-result-request',
		};

		const prepared = tool.prepareInvocation({ input }, cancellation.token);
		assert.match(String(prepared.confirmationMessages?.message), /no workspace files are accessed/);
		assert.equal(idsAllocated, 0);
		assert.equal(tasksStarted, 0);

		const result = await tool.invoke({
			input,
			toolInvocationToken: undefined,
		}, cancellation.token);
		cancellation.dispose();
		assert.equal(idsAllocated, 1);
		assert.equal(tasksStarted, 1);
		const [part] = result.content;
		assert.ok(part instanceof vscode.LanguageModelTextPart);
		assert.deepStrictEqual(JSON.parse(part.value), {
			status: 'pending',
			delegationRequestId: 'text-result-request',
			taskId: 'id-1',
			pollTool: 'mesh_get_task',
			cancelTool: 'mesh_cancel_task',
			echo: 'structured result probe',
			delaySeconds: 5,
		});
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

	test('provides the global WebSocket required by the pinned AHP transport', () => {
		assert.strictEqual(typeof globalThis.WebSocket, 'function');
	});
});

function getExtension(): vscode.Extension<unknown> {
	const extension = vscode.extensions.getExtension('weivea.copilot-agent-mesh');
	assert.ok(extension, 'The Copilot Agent Mesh extension should be available.');
	return extension;
}
