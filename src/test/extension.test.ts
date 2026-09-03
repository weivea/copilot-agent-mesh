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
	MESH_RUNTIME_TOOL_NAMES,
	MESH_TOOL_NAMES,
} from '../tools/toolManifest';
import { DelegatedToolInvocationRegistry } from '../tools/DelegatedToolInvocationRegistry';
import { TaskToolFacadeError } from '../tools/taskToolFacade';
import type { AgentMeshExtensionApi } from '../composition/createApplication';
import { createPeerDelegationE2eApi } from '../composition/PeerDelegationE2eApi';
import { E2eCapability } from '../composition/E2eCapability';
import {
	PeerDelegationE2eRecorder,
	PeerDelegationE2eToolClock,
} from '../e2e/PeerDelegationE2eRecorder';

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

	test('delegate preparation reports a safe offline observation before rethrowing', async () => {
		const facade = createTaskToolFacade();
		facade.describeDelegationTarget = async () => {
			throw new TaskToolFacadeError('PEER_OFFLINE', true);
		};
		const observations: Array<{
			phase: string;
			errorCode?: string;
			preparationSequence?: number;
		}> = [];
		const tool = new MeshDelegateTaskTool(facade, {}, {
			observe: (observation) => observations.push({
				phase: observation.phase,
				...(observation.errorCode === undefined ? {} : { errorCode: observation.errorCode }),
				...(observation.preparationSequence === undefined
					? {}
					: { preparationSequence: observation.preparationSequence }),
			}),
		});
		const cancellation = new vscode.CancellationTokenSource();
		try {
			await assert.rejects(
				() => tool.prepareInvocation({
					input: {
						delegationRequestId: '00000000-0000-4000-8000-000000000004',
						deviceId: '00000000-0000-4000-8000-000000000001',
						nodeId: '00000000-0000-4000-8000-000000000007',
						nodeInstanceId: '00000000-0000-4000-8000-000000000008',
						workspaceId: '00000000-0000-4000-8000-000000000002',
						title: 'Offline preparation',
						prompt: 'Verify safe preparation failure observation.',
					},
				}, cancellation.token),
				(error: unknown) =>
					error instanceof TaskToolFacadeError
					&& error.code === 'PEER_OFFLINE',
			);
			assert.deepStrictEqual(observations, [
				{ phase: 'prepareStarted', preparationSequence: 1 },
				{
					phase: 'prepareFailed',
					errorCode: 'PEER_OFFLINE',
					preparationSequence: 1,
				},
			]);
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
		const invocationObservations: Array<{
			phase: string;
			invocationSequence?: number;
		}> = [];
		const tool = new MeshDelegateTaskTool(facade, {
			delegatedToolInvocations,
		}, {
			observe: (observation) => invocationObservations.push({
				phase: observation.phase,
				...(observation.invocationSequence === undefined
					? {}
					: { invocationSequence: observation.invocationSequence }),
			}),
		});
		try {
			const result = await tool.invoke({
				input,
				toolInvocationToken: undefined,
			}, cancellation.token);
			await tool.invoke({
				input,
				toolInvocationToken: undefined,
			}, cancellation.token);
			assert.deepStrictEqual(receivedContext, executionContext);
			const [part] = result.content;
			assert.ok(part instanceof vscode.LanguageModelTextPart);
			assert.strictEqual(JSON.parse(part.value).e, 'DELEGATION_RECURSION');
			assert.deepStrictEqual(invocationObservations, [
				{ phase: 'invokeStarted', invocationSequence: 1 },
				{ phase: 'invokeCompleted', invocationSequence: 1 },
				{ phase: 'invokeStarted', invocationSequence: 2 },
				{ phase: 'invokeCompleted', invocationSequence: 2 },
			]);
		} finally {
			cancellation.dispose();
			delegatedToolInvocations.dispose();
		}
	});

	test('manual API freeze linearizes with the actual delegate Tool ingress gate', async () => {
		const nonce = '00000000-0000-4000-8000-0000000000a1';
		const delegationRequestId = '00000000-0000-4000-8000-0000000000a2';
		const taskId = '00000000-0000-4000-8000-0000000000a3';
		const inputId = '00000000-0000-4000-8000-0000000000a4';
		const recorder = new PeerDelegationE2eRecorder();
		const capability = E2eCapability.create({
			mode: 'test',
			environmentEnabled: true,
			environmentNonce: nonce,
			environmentRole: 'coordinator',
			profileNonce: nonce,
			profileRole: 'coordinator',
		});
		const api = createPeerDelegationE2eApi({
			vscodeApi: vscode,
			bindings: Object.create(null),
			node: Object.create(null),
			localTasks: Object.create(null),
			remoteTasks: Object.create(null),
			runtime: Object.create(null),
			lifecycle: Object.create(null),
			ownerRuntime: () => undefined,
			capability,
			recorder,
			toolClock: new PeerDelegationE2eToolClock(500),
		});
		assert.ok(api);
		let releasePersistence!: () => void;
		const persistenceBarrier = new Promise<void>((resolve) => {
			releasePersistence = resolve;
		});
		let persistenceStarted!: () => void;
		const persistenceStart = new Promise<void>((resolve) => {
			persistenceStarted = resolve;
		});
		let persistCalls = 0;
		let leaseReleased = false;
		const facade: TaskToolFacade = {
			identifyDelegation: () => ({
				delegationRequestId,
				taskId,
				sourceWorkspaceIdentity: `sha256:${'a'.repeat(43)}`,
			}),
			listWorkers: async () => ({ devices: [], truncated: false }),
			subscribeToTask: () => ({ dispose: () => undefined }),
			persistDelegationIntent: async () => {
				persistCalls += 1;
				persistenceStarted();
				await persistenceBarrier;
				return { delegationRequestId, taskId, recovered: false };
			},
			waitForDelegationAcceptance: async () => ({ status: 'accepted' }),
			getTask: async () => ({
				snapshot: {
					taskId,
					status: leaseReleased ? 'cancelled' : 'needsInput',
					title: 'Freeze barrier',
					updatedAt: '2026-09-03T00:00:00.000Z',
					...(leaseReleased ? {} : {
						pendingInput: {
							inputId,
							prompt: 'Continue?',
						},
					}),
				},
				eventCursor: 0,
				events: [],
				truncated: false,
			}),
			cancelOwnedTask: async () => {
				leaseReleased = true;
				return { taskId, status: 'cancelled' };
			},
			answerOwnedTask: async () => ({ taskId, status: 'needsInput' }),
		};
		const tool = new MeshDelegateTaskTool(facade, {}, recorder, recorder);
		const cancellation = new vscode.CancellationTokenSource();
		const input = {
			delegationRequestId,
			deviceId: '00000000-0000-4000-8000-0000000000a5',
			nodeId: '00000000-0000-4000-8000-0000000000a6',
			nodeInstanceId: '00000000-0000-4000-8000-0000000000a7',
			workspaceId: '00000000-0000-4000-8000-0000000000a8',
			title: 'Freeze barrier',
			prompt: 'Return one acknowledgement.',
		};
		try {
			const invocation = tool.invoke({
				input,
				toolInvocationToken: undefined,
			}, cancellation.token);
			await persistenceStart;
			await api.execute(
				{ nonce, role: 'coordinator' },
				'peer.manual.freeze',
			);
			releasePersistence();
			const result = await invocation;
			const [part] = result.content;
			assert.ok(part instanceof vscode.LanguageModelTextPart);
			assert.strictEqual(JSON.parse(part.value).s, 1);
			assert.deepStrictEqual(
				recorder.snapshot().delegateInvocations.map(({ phase }) => phase),
				['invokeStarted', 'taskAvailable', 'invokeCompleted'],
			);
			await new MeshCancelTaskTool(facade).invoke({
				input: { taskId },
				toolInvocationToken: undefined,
			}, cancellation.token);
			assert.strictEqual(leaseReleased, true);
			await assert.rejects(
				() => tool.invoke({
					input,
					toolInvocationToken: undefined,
				}, cancellation.token),
				/invocation ingress is closed/u,
			);
			assert.strictEqual(persistCalls, 1);
		} finally {
			cancellation.dispose();
		}
	});

	test('delegate evidence capacity rejects the 513th needs-input invocation before persistence', async () => {
		const recorder = new PeerDelegationE2eRecorder();
		for (let index = 1; index <= 512; index += 1) {
			const suffix = index.toString(16).padStart(12, '0');
			const invocationId = `10000000-0000-4000-8000-${suffix}`;
			const taskId = `20000000-0000-4000-8000-${suffix}`;
			recorder.reserveDelegateInvocation(invocationId);
			recorder.observe({
				toolName: MESH_TOOL_NAMES.delegateTask,
				phase: 'invokeStarted',
				input: { delegationRequestId: `30000000-0000-4000-8000-${suffix}` },
				invocationId,
			});
			recorder.observe({
				toolName: MESH_TOOL_NAMES.delegateTask,
				phase: 'taskAvailable',
				input: { delegationRequestId: `30000000-0000-4000-8000-${suffix}` },
				result: { t: taskId },
				invocationId,
			});
			recorder.observe({
				toolName: MESH_TOOL_NAMES.delegateTask,
				phase: 'invokeCompleted',
				input: { delegationRequestId: `30000000-0000-4000-8000-${suffix}` },
				result: { s: 1, t: taskId },
				invocationId,
			});
		}
		let persisted = false;
		const facade = createTaskToolFacade();
		facade.persistDelegationIntent = async () => {
			persisted = true;
			throw new Error('The 513th invocation must not persist.');
		};
		const tool = new MeshDelegateTaskTool(facade, {}, recorder, recorder);
		const cancellation = new vscode.CancellationTokenSource();
		try {
			await assert.rejects(
				() => tool.invoke({
					input: {
						delegationRequestId: '40000000-0000-4000-8000-000000000001',
						deviceId: '40000000-0000-4000-8000-000000000002',
						nodeId: '40000000-0000-4000-8000-000000000003',
						nodeInstanceId: '40000000-0000-4000-8000-000000000004',
						workspaceId: '40000000-0000-4000-8000-000000000005',
						title: 'Capacity boundary',
						prompt: 'Do not start.',
					},
					toolInvocationToken: undefined,
				}, cancellation.token),
				/evidence capacity is exhausted/u,
			);
			assert.strictEqual(persisted, false);
			const snapshot = recorder.snapshot();
			assert.strictEqual(snapshot.delegateInvocationsTruncated, false);
			assert.strictEqual(
				snapshot.delegateInvocations.filter(({ phase }) => phase === 'taskAvailable').length,
				512,
			);
			assert.strictEqual(new Set(
				snapshot.delegateInvocations
					.filter(({ phase }) => phase === 'taskAvailable')
					.map(({ taskId }) => taskId),
			).size, 512);
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
