import * as assert from 'assert';

import * as vscode from 'vscode';

import {
	GATEWAY_METHODS,
	MESH_PROTOCOL_VERSION,
	TASK_STATUSES,
} from '../../shared/protocol';
import { TaskToolFacade } from '../tools/taskToolFacade';
import {
	MeshAnswerTaskTool,
	MeshCancelTaskTool,
	MeshDelegateTaskTool,
	MeshGetTaskTool,
	MeshListWorkersTool,
} from '../tools/taskTools';
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

	test('all production tools contain tokenizer failures without retrying the tokenizer', async () => {
		const taskId = '00000000-0000-4000-8000-000000000003';
		const facade = createTaskToolFacade();
		let tokenizerCalls = 0;
		const tokenizationOptions: vscode.LanguageModelToolTokenizationOptions = {
			tokenBudget: 100,
			countTokens: async () => {
				tokenizerCalls += 1;
				throw new Error('tokenizer unavailable with secret detail');
			},
		};
		const invocationBase = {
			toolInvocationToken: undefined,
			tokenizationOptions,
		};
		const cancellation = new vscode.CancellationTokenSource();
		try {
			const results = await Promise.all([
				new MeshListWorkersTool(facade).invoke({
					...invocationBase,
					input: {},
				}, cancellation.token),
				new MeshDelegateTaskTool(facade).invoke({
					...invocationBase,
					input: {
						peerId: '00000000-0000-4000-8000-000000000001',
						workspaceId: '00000000-0000-4000-8000-000000000002',
						title: 'Tokenizer containment',
						prompt: 'Verify the invocation catch boundary.',
					},
				}, cancellation.token),
				new MeshGetTaskTool(facade).invoke({
					...invocationBase,
					input: { taskId },
				}, cancellation.token),
				new MeshCancelTaskTool(facade).invoke({
					...invocationBase,
					input: { taskId },
				}, cancellation.token),
				new MeshAnswerTaskTool(facade).invoke({
					...invocationBase,
					input: {
						taskId,
						inputId: '00000000-0000-4000-8000-000000000005',
						answerId: '00000000-0000-4000-8000-000000000006',
						answer: 'Proceed.',
					},
				}, cancellation.token),
			]);

			assert.equal(tokenizerCalls, 5);
			for (const result of results) {
				const [part] = result.content;
				assert.ok(part instanceof vscode.LanguageModelTextPart);
				assert.deepStrictEqual(JSON.parse(part.value), {
					status: 'error',
					error: {
						code: 'INTERNAL_ERROR',
						message: 'The mesh operation failed without a safe diagnostic.',
						retryable: false,
					},
				});
				assert.doesNotMatch(part.value, /secret|tokenizer unavailable/);
			}
		} finally {
			cancellation.dispose();
		}
	});
});

function getExtension(): vscode.Extension<unknown> {
	const extension = vscode.extensions.getExtension('weivea.copilot-agent-mesh');
	assert.ok(extension, 'The Copilot Agent Mesh extension should be available.');
	return extension;
}

function createTaskToolFacade(): TaskToolFacade {
	const delegationRequestId = '00000000-0000-4000-8000-000000000004';
	const taskId = '00000000-0000-4000-8000-000000000003';
	return {
		listWorkers: async () => ({ workers: [] }),
		persistDelegationIntent: async () => ({
			delegationRequestId,
			taskId,
			recovered: false,
		}),
		waitForDelegationAcceptance: async () => ({ status: 'accepted' }),
		getTask: async ({ afterEventSequence }) => ({
			snapshot: {
				taskId,
				status: 'running',
				title: 'Tokenizer containment',
				updatedAt: '2026-08-25T00:00:00.000Z',
			},
			eventCursor: afterEventSequence ?? 0,
			events: [],
			truncated: false,
		}),
		cancelOwnedTask: async () => ({ taskId, status: 'cancelled' }),
		answerOwnedTask: async () => ({ taskId, status: 'running' }),
	};
}
