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
	MeshListTasksTool,
} from '../tools/taskTools';
import {
	MESH_RUNTIME_TOOL_NAMES,
	MESH_TOOL_NAMES,
} from '../tools/toolManifest';
import { DelegatedToolInvocationRegistry } from '../tools/DelegatedToolInvocationRegistry';
import { TaskToolFacadeError } from '../tools/taskToolFacade';
import type { AgentMeshExtensionApi } from '../composition/createApplication';

suite('Copilot Agent Mesh', () => {
	test('cold host keeps contributed Tools unavailable while Preview is off', async () => {
		const extension = getExtension();
		const manifestTools = extension.packageJSON.contributes.languageModelTools as Array<{ name: string }>;

		assert.strictEqual(extension.isActive, false);
		assert.deepStrictEqual(
			extension.packageJSON.activationEvents,
			['onStartupFinished'],
		);
		assert.deepStrictEqual(manifestTools.map(({ name }) => name), MESH_RUNTIME_TOOL_NAMES);
		for (const removed of [
			'mesh_start_collaboration',
			'mesh_get_collaboration',
			'mesh_cancel_collaboration',
		]) {
			assert.ok(!manifestTools.some(({ name }) => name === removed));
			assert.ok(!vscode.lm.tools.some((tool) => tool.name === removed));
		}

		const cancellation = new vscode.CancellationTokenSource();
		try {
			const invocation = vscode.lm.invokeTool(MESH_TOOL_NAMES.listWorkers, {
				input: {},
				toolInvocationToken: undefined,
			}, cancellation.token);
			setTimeout(() => cancellation.cancel(), 0);
			await invocation;
		} catch (error) {
			assert.match(String(error), /does not have an implementation registered/i);
		} finally {
			cancellation.dispose();
		}

		assert.strictEqual(extension.isActive, true);
		assert.ok(MESH_RUNTIME_TOOL_NAMES.every(
			(name) => vscode.lm.tools.some((tool) => tool.name === name),
		));

		const configuration = vscode.workspace.getConfiguration('copilotAgentMesh');
		try {
			await configuration.update(
				'experimental.peerDelegation',
				true,
				vscode.ConfigurationTarget.Global,
			);
			await waitForToolRegistration(MESH_TOOL_NAMES.listWorkers);
		} finally {
			await configuration.update(
				'experimental.peerDelegation',
				false,
				vscode.ConfigurationTarget.Global,
			);
		}
	});

	test('contributes the dashboard and setup commands', () => {
		const extension = getExtension();
		const manifest = extension.packageJSON;
		const commands = manifest.contributes.commands as Array<{ command: string }>;
		const views = manifest.contributes.views.copilotAgentMesh as Array<{ id: string }>;

		assert.ok(commands.some(({ command }) => command === 'copilotAgentMesh.configureDevice'));
		assert.ok(commands.some(({ command }) => command === 'copilotAgentMesh.refreshDashboard'));
		assert.ok(commands.some(({ command }) => command === 'copilotAgentMesh.runTask'));
		assert.ok(commands.some(({ command }) => command === 'copilotAgentMesh.startListener'));
		assert.ok(commands.some(({ command }) => command === 'copilotAgentMesh.registerWorkspace'));
		assert.ok(!commands.some(({ command }) => /Collaboration|answerTask/u.test(command)));
		assert.ok(views.some(({ id }) => id === 'copilotAgentMesh.dashboard'));
		assert.deepStrictEqual(manifest.extensionKind, ['ui']);
	});

	test('keeps the real Agent Host runtime disabled by default', () => {
		const manifest = getExtension().packageJSON;
		const properties = manifest.contributes.configuration.properties as Record<string, { default?: unknown }>;

		assert.strictEqual(properties['copilotAgentMesh.experimental.agentHost']?.default, false);
		assert.strictEqual(properties['copilotAgentMesh.experimental.peerDelegation']?.default, false);
		assert.strictEqual(properties['copilotAgentMesh.agentHost.userDataDir']?.default, '');
		assert.strictEqual(
			(properties['copilotAgentMesh.agentHost.userDataDir'] as { scope?: unknown } | undefined)?.scope,
			'machine',
		);
		assert.strictEqual(properties['copilotAgentMesh.experimental.sameDeviceCollaboration'], undefined);
	});

	test('activates successfully', async () => {
		const extension = getExtension();

		await extension.activate();

		assert.strictEqual(extension.isActive, true);
	});

	test('exposes the production Window Node and Broker lifecycle state', async () => {
		const extension = getExtension();
		const api = await extension.activate() as AgentMeshExtensionApi;
		assert.match(api.nodeId, /^[0-9a-f-]{36}$/u);
		assert.match(api.nodeInstanceId, /^[0-9a-f-]{36}$/u);
		assert.strictEqual(api.nodeState().state, 'online');
		assert.strictEqual(api.nodeState().registered, true);
		assert.strictEqual(api.brokerState().state, 'running');
		assert.strictEqual(api.brokerState().owner, true);
		assert.strictEqual(api.peerDelegationE2e, undefined);
		assert.deepEqual((await api.node.listNodes()).nodes, []);
		const dashboard = await api.node.listDashboardNodes();
		const thisWindow = dashboard.nodes.find((node) =>
			node.nodeId === api.nodeId
			&& node.nodeInstanceId === api.nodeInstanceId,
		);
		assert.ok(thisWindow);
		assert.strictEqual(thisWindow.workspaces.length, api.nodeState().workspaceCount);
		assert.ok(!JSON.stringify(dashboard).includes('sha256:'));
	});

	test('defines the initial gateway protocol surface', () => {
		assert.strictEqual(MESH_PROTOCOL_VERSION, 2);
		assert.strictEqual(GATEWAY_METHODS.taskStart, 'task.start');
		assert.ok(TASK_STATUSES.includes('needsInput'));
	});

	test('provides the global WebSocket required by the pinned AHP transport', () => {
		assert.strictEqual(typeof globalThis.WebSocket, 'function');
	});

	test('public submit uses readable outcomes and get/wait adds no extra confirmation', async () => {
		const taskId = '00000000-0000-4000-8000-000000000003';
		const delegationRequestId = '00000000-0000-4000-8000-000000000004';
		const facade = Object.assign(createTaskToolFacade(), {
			resolveTargetHandle: async () => ({
				deviceId: '00000000-0000-4000-8000-000000000001',
				nodeId: '00000000-0000-4000-8000-000000000007',
				nodeInstanceId: '00000000-0000-4000-8000-000000000008',
				workspaceId: '00000000-0000-4000-8000-000000000002',
			}),
			identifyDelegation: () => ({
				taskId, delegationRequestId, sourceWorkspaceIdentity: `sha256:${'a'.repeat(43)}`,
			}),
			describeDelegationTarget: async () => ({ windowName: 'Target window', workspaceName: 'Target Workspace' }),
			subscribeToTask: () => ({ dispose: () => undefined }),
		});
		const cancellation = new vscode.CancellationTokenSource();
		try {
			const input = {
				targetHandle: 'h'.repeat(32), delegationRequestId, mode: 'submit' as const,
				title: 'Submit a task', prompt: 'Use the test facade only.',
			};
			const tool = new MeshDelegateTaskTool(facade);
			const preparation = await tool.prepareInvocation({ input }, cancellation.token);
			assert.match(String(preparation.confirmationMessages?.message), /stopping Chat does not cancel/u);
			const result = await tool.invoke({ input, toolInvocationToken: undefined }, cancellation.token);
			const part = result.content[0];
			assert.ok(part instanceof vscode.LanguageModelTextPart);
			const parsed = JSON.parse(part.value);
			assert.equal(parsed.outcome, 'accepted');
			assert.equal(parsed.taskId, taskId);
			assert.equal(parsed.taskState, 'running');
			assert.equal(parsed.s, undefined);
			assert.equal(parsed.nextAction.tool, 'meshGetTask');
			const wait = new MeshGetTaskTool(facade).prepareInvocation({ input: { taskId, waitFor: 'outcome' } });
			assert.equal(wait.confirmationMessages, undefined);
			assert.match(String(wait.invocationMessage), /leaves the task running/u);
		} finally { cancellation.dispose(); }
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
				new MeshListTasksTool(facade).invoke({
					...invocationBase,
					input: {},
				}, cancellation.token),
				new MeshDelegateTaskTool(facade).invoke({
					...invocationBase,
					input: {
						deviceId: '00000000-0000-4000-8000-000000000001',
						nodeId: '00000000-0000-4000-8000-000000000007',
						nodeInstanceId: '00000000-0000-4000-8000-000000000008',
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

			assert.equal(tokenizerCalls, 6);
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

	test('registered delegate tool carries an exact child correlation into its facade', async () => {
		const delegatedToolInvocations = new DelegatedToolInvocationRegistry();
		const executionContext = {
			kind: 'delegatedChild' as const,
			taskId: '00000000-0000-4000-8000-000000000090',
			capability: 'e'.repeat(43),
		};
		const input = {
			delegationRequestId: '00000000-0000-4000-8000-000000000091',
			deviceId: '00000000-0000-4000-8000-000000000092',
			nodeId: '00000000-0000-4000-8000-000000000093',
			nodeInstanceId: '00000000-0000-4000-8000-000000000094',
			workspaceId: '00000000-0000-4000-8000-000000000095',
			title: 'Blocked child delegation',
			prompt: 'Attempt a nested task.',
			acceptanceCriteria: ['Rejected'],
		};
		delegatedToolInvocations.observe({
			scopeId: 'ahp-session:/extension-child',
			invocationId: 'turn-1\u0000tool-1',
			toolName: MESH_TOOL_NAMES.delegateTask,
			toolInput: JSON.stringify(input),
			context: executionContext,
		});
		let receivedContext: unknown;
		const facade: TaskToolFacade = {
			identifyDelegation: () => ({
				delegationRequestId: input.delegationRequestId,
				taskId: '00000000-0000-4000-8000-000000000096',
				sourceWorkspaceIdentity: `sha256:${'f'.repeat(43)}`,
			}),
			listWorkers: async () => ({ devices: [], truncated: false }),
			subscribeToTask: () => ({ dispose: () => undefined }),
			persistDelegationIntent: async (_intent, context) => {
				receivedContext = context;
				throw new TaskToolFacadeError('DELEGATION_RECURSION');
			},
			waitForDelegationAcceptance: async () => ({ status: 'accepted' }),
			getTask: async () => {
				throw new TaskToolFacadeError('TASK_NOT_FOUND');
			},
			cancelOwnedTask: async () => {
				throw new TaskToolFacadeError('TASK_NOT_CANCELLABLE');
			},
			answerOwnedTask: async () => {
				throw new TaskToolFacadeError('INPUT_NOT_PENDING');
			},
		};
		const cancellation = new vscode.CancellationTokenSource();
		try {
			const result = await new MeshDelegateTaskTool(facade, {
				delegatedToolInvocations,
			}).invoke({
				input,
				toolInvocationToken: undefined,
			}, cancellation.token);
			assert.deepStrictEqual(receivedContext, executionContext);
			const [part] = result.content;
			assert.ok(part instanceof vscode.LanguageModelTextPart);
			const parsed = JSON.parse(part.value);
			assert.strictEqual(parsed.error.code, 'DELEGATION_RECURSION');
			assert.strictEqual(parsed.outcome, 'failed');
			assert.strictEqual(parsed.taskState, 'unknown');
		} finally {
			cancellation.dispose();
			delegatedToolInvocations.dispose();
		}
	});
});

function getExtension(): vscode.Extension<unknown> {
	const extension = vscode.extensions.getExtension('weivea.copilot-agent-mesh');
	assert.ok(extension, 'The Copilot Agent Mesh extension should be available.');
	return extension;
}

async function waitForToolRegistration(name: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const cancellation = new vscode.CancellationTokenSource();
		try {
			await vscode.lm.invokeTool(name, {
				input: {},
				toolInvocationToken: undefined,
			}, cancellation.token);
			return;
		} catch (error: unknown) {
			if (!/does not have an implementation registered/i.test(String(error))) {
				throw error;
			}
		} finally {
			cancellation.dispose();
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`Tool ${name} did not register after enabling Peer Delegation Preview.`);
}

function createTaskToolFacade(): TaskToolFacade {
	const delegationRequestId = '00000000-0000-4000-8000-000000000004';
	const taskId = '00000000-0000-4000-8000-000000000003';
	return {
		listWorkers: async () => ({ devices: [], truncated: false }),
		listTasks: async () => ({ tasks: [], truncated: false, totalTasks: 0 }),
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
