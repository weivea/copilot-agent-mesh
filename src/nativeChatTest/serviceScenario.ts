import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type * as vscode from 'vscode';

import type { NodeTaskEventParams } from '../../shared/protocol';
import { createAgentRuntimeEventQueue, type AgentRuntime, type WorkspaceResolver } from '../agentHost/AgentRuntime';
import { NATIVE_CHAT_ENABLE_COMMAND, NATIVE_CHAT_OPEN_COMMAND, NATIVE_CHAT_STATUS_COMMAND, NATIVE_CHAT_TYPE } from '../codespaces/nativeChat/NativeChatApi';
import { persistNativeChatPermission } from '../codespaces/nativeChat/NativeChatPermissionSetup';
import { createNativeChatService } from '../codespaces/nativeChat/NativeChatService';
import { NativeChatStore } from '../codespaces/nativeChat/NativeChatStore';
import { canonicalRoutedTaskRequestHash } from '../domain/task';
import { createDelegationGrant } from '../node/DelegationGrant';
import { WindowNodeTaskExecutor } from '../node/WindowNodeTaskExecutor';
import type { WindowNodeExecutor } from '../node/WindowNodeClient';

const taskId = '40000000-0000-4000-8000-000000000001';
const workspaceId = '40000000-0000-4000-8000-000000000002';
const title = 'Production native service regression';
const text = 'SERVICE_PIPELINE_RENDERED\n\n服务启动、任务执行、实时展示和历史记录必须保持一致。\n\n';

export async function runNativeServiceScenario(
	api: typeof vscode,
	context: vscode.ExtensionContext,
	root: string,
	phase: 'service' | 'service-restored',
	rendered: (text: string) => Promise<void>,
	listed: (title: string) => Promise<void>,
): Promise<void> {
	const errors: unknown[] = [];
	let menuQueries = 0;
	let syntheticStarts = 0;
	const permission = api.commands.registerCommand(NATIVE_CHAT_ENABLE_COMMAND, () => persistNativeChatPermission(api));
	// Only the remote environment tag and the unreliable command enumeration are
	// simulated. Provider registration, storage, editor and renderer are native.
	const targetApi: typeof vscode = {
		...api,
		env: { ...api.env, remoteName: 'codespaces' },
		commands: { ...api.commands, getCommands: async () => { menuQueries++; return []; } },
	};
	const service = createNativeChatService(targetApi, context, (error) => errors.push(error));
	let executor: WindowNodeExecutor | undefined;
	let stage = 'initializing service';
	try {
		const folder = api.workspace.workspaceFolders?.[0];
		assert.ok(folder);
		const uri = api.Uri.file(await realpath(folder.uri.fsPath)).toString();
		const workspaceIdentity = `sha256:${createHash('sha256').update(uri).digest('base64url')}`;
		const workspaceResolver: WorkspaceResolver = { resolve: async () => ({
			workspaceId, workspaceIdentity, displayName: folder.name, uri,
		}) };
		const nodeId = randomUUID();
		const nodeInstanceId = randomUUID();
		const events: NodeTaskEventParams[] = [];
		const eventSink = { publish: (event: NodeTaskEventParams) => { events.push(event); } };
		const observer = await service.observe({
			nodeId, nodeInstanceId, helperInstanceId: randomUUID(), nodeLabel: 'Native service target',
			workspaceResolver, eventSink,
		});
		assert.deepEqual(await api.commands.executeCommand(NATIVE_CHAT_STATUS_COMMAND), { state: 'enabled' },
			'A filtered command list must not disable a working native provider.');
		assert.ok(observer);
		assert.equal(menuQueries, 0);
		if (phase === 'service') {
			stage = 'starting real executor';
			const queue = createAgentRuntimeEventQueue();
			const runtime: AgentRuntime = {
				probe: async () => ({ available: true, featureEnabled: true }),
				start: async (request) => {
					syntheticStarts++;
					return {
						taskId: request.taskId,
						events: queue,
						recovery: {
							clientId: randomUUID(), sessionUri: `copilot:/${taskId}`, chatUri: `copilot:/${taskId}/chats/main`,
							lastSeenServerSeq: 1,
						},
						cancel: async () => { await queue.pushAndClose({ type: 'cancelled' }); },
						answer: async () => { throw new Error('This fixture does not request input.'); },
						dispose: async () => { queue.close(); },
					};
				},
				dispose: async () => { queue.close(); },
			};
			executor = observer.attach(new WindowNodeTaskExecutor({
				nodeId, nodeInstanceId, nodeLabel: 'Native service target', workspaceResolver,
				executionBackend: 'codespace-owned', runtime: observer.runtime(runtime),
				eventSink: observer.eventSink(eventSink), observeInputAnswer: observer.observeInputAnswer,
				confirmationHost: { confirm: async () => 'once' }, ids: randomUUID, clock: () => new Date(),
			}));
			const params = {
				delegationRequestId: randomUUID(), taskId,
				target: { deviceId: randomUUID(), nodeId, nodeInstanceId, workspaceId },
				sourceNodeId: randomUUID(), title, prompt: 'Display this authorized synthetic task using the production native service.',
				acceptanceCriteria: [], workerDeadline: new Date(Date.now() + 60_000).toISOString(),
				authenticatedOwnerId: randomUUID(), sourceLabel: 'Synthetic desktop source',
				executionBackend: 'codespace-owned' as const,
			};
			await executor.start({
				...params,
				delegatedExecutionContext: { kind: 'delegatedChild', taskId, capability: 'd'.repeat(43) },
				delegationGrant: createDelegationGrant({
					taskId, targetNodeId: nodeId, targetNodeInstanceId: nodeInstanceId, workspaceIdentity,
					requestHash: canonicalRoutedTaskRequestHash({
						delegationRequestId: params.delegationRequestId, taskId, target: params.target,
						sourceNodeId: params.sourceNodeId, title, prompt: params.prompt, acceptanceCriteria: [],
						workerDeadline: params.workerDeadline, peerId: params.authenticatedOwnerId, workspaceLeaseKey: workspaceIdentity,
					}),
				}),
			});
			for (const character of text) { await queue.push({ type: 'output', text: character }); }
			stage = 'rendering live output';
			await rendered('SERVICE_PIPELINE_RENDERED');
			stage = 'listing native session';
			await api.commands.executeCommand('agentSessions.showAgentSessionsSidebar');
			await listed(title);
			assert.ok(!events.some((event) => event.event.type === 'completed'), 'The response must be visible while the task is still running.');
			await queue.pushAndClose({ type: 'completed' });
			stage = 'rendering completion';
			await rendered('Mesh task completed');
			await executor.dispose();
			executor = undefined;
		} else {
			stage = 'opening saved service session';
			await api.commands.executeCommand(NATIVE_CHAT_OPEN_COMMAND, api.Uri.from({
				scheme: NATIVE_CHAT_TYPE, path: `/${taskId}`,
			}).toString());
			await rendered('SERVICE_PIPELINE_RENDERED');
			await api.commands.executeCommand('agentSessions.showAgentSessionsSidebar');
			await listed(title);
		}
		const store = new NativeChatStore({ rootDirectory: join(context.globalStorageUri.fsPath, 'chat-history') });
		await store.initialize();
		const session = store.get(taskId);
		assert.equal(session?.turns[0].status, 'completed');
		assert.equal(session.turns[0].entries.filter((entry) => entry.kind === 'output').map((entry) => entry.text).join(''), text);
		assert.deepEqual(errors, []);
		await writeFile(join(root, `${phase}.json`), JSON.stringify({
			passed: true, phase, vscodeVersion: api.version, at: new Date().toISOString(),
			productionService: true, productionExecutor: true, menuQueries, syntheticStarts, modelCalls: 0,
			sessions: store.list().length, simulatedRemoteName: true,
		}));
	} catch (error: unknown) {
		console.error(`Native service scenario failed while ${stage}:`, error, errors);
		throw error;
	} finally {
		await executor?.dispose();
		await service.dispose();
		permission.dispose();
	}
}
