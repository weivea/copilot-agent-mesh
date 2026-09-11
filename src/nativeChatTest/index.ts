import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { z } from 'zod';

import { NATIVE_CHAT_CANCEL_COMMAND, NATIVE_CHAT_EXTENSION_ID } from '../codespaces/nativeChat/NativeChatApi';
import { NativeChatControlRegistry } from '../codespaces/nativeChat/NativeChatExecution';
import { NativeChatProvider } from '../codespaces/nativeChat/NativeChatProvider';
import { NativeChatStore, type NativeChatTaskStart } from '../codespaces/nativeChat/NativeChatStore';

const firstTask = '30000000-0000-4000-8000-000000000001';
const nextTask = '30000000-0000-4000-8000-000000000002';
const cancelledTask = '30000000-0000-4000-8000-000000000005';
const generation = '30000000-0000-4000-8000-000000000003';
const recovery = { sessionUri: 'copilot:/30000000-0000-4000-8000-000000000004', chatUri: 'copilot:/30000000-0000-4000-8000-000000000004/chats/main' };
const marker = 'NATIVE_MESH_STREAM_RENDERED_5739';
const nextMarker = 'NATIVE_MESH_CONTINUATION_RENDERED_8743';
let context: vscode.ExtensionContext | undefined;

export function activate(value: vscode.ExtensionContext): void { context = value; }

export async function run(): Promise<void> {
	const root = z.string().min(1).parse(process.env.CAM_NATIVE_CHAT_TEST_ROOT);
	const phase = z.enum(['live', 'restored']).parse(process.env.CAM_NATIVE_CHAT_TEST_PHASE);
	const port = z.coerce.number().int().min(1).max(65535).parse(process.env.CAM_NATIVE_CHAT_TEST_PORT);
	await vscode.extensions.getExtension(NATIVE_CHAT_EXTENSION_ID)!.activate();
	assert.ok(context);
	const workspace = vscode.workspace.workspaceFolders?.[0];
	assert.ok(workspace);
	const store = new NativeChatStore({ rootDirectory: join(root, 'history') });
	await store.initialize();
	const errors: unknown[] = [];
	const actionErrors: unknown[] = [];
	const controls = new NativeChatControlRegistry();
	let autoOpen = false;
	let confirmCancellation = false;
	let cancellations = 0;
	const provider = new NativeChatProvider(vscode, store, {
		controls,
		workspaceUris: () => new Set([workspace.uri.toString()]),
		autoOpen: () => autoOpen,
		confirmCancellation: async () => confirmCancellation,
		reportError: (error) => { errors.push(error); },
		reportActionError: (error) => { actionErrors.push(error); },
	});
	const input: NativeChatTaskStart = {
		taskId: firstTask,
		title: 'Native Mesh Chat integration POC',
		prompt: 'Show the actual external task in native Chat without a model call.',
		workspaceIdentity: `sha256:${createHash('sha256').update(workspace.uri.toString()).digest('base64url')}`,
		workspaceName: workspace.name,
		workspaceUri: workspace.uri.toString(),
		sourceLabel: 'Synthetic source window',
		generation,
	};
	const cdp = await connectCdp(port);
	try {
		if (phase === 'live') {
			controls.add(firstTask, {
				generation, cancel: async () => { cancellations += 1; },
			});
			await store.beginTask(input);
			await store.setRecovery(firstTask, recovery);
			await store.setStatus(firstTask, 'running');
			assert.equal(provider.diagnostics.sessions, 1);
			await provider.open(firstTask);
			await eventually(() => provider.diagnostics.contentRequests > 0 && provider.diagnostics.activeViews > 0);
			await store.append(firstTask, { kind: 'progress', text: 'Native Mesh tool progress is visible.' });
			await store.append(firstTask, { kind: 'output', text: `${marker}\n\n` });
			await rendered(cdp, marker);
			await vscode.commands.executeCommand('agentSessions.showAgentSessionsSidebar');
			await sessionListed(cdp, input.title);
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			assert.equal(cancellations, 0, 'Closing native Chat must not cancel the actual Mesh task.');
			assert.ok(controls.isLive(generation, firstTask));
			await store.append(firstTask, { kind: 'output', text: 'Output received while the view was closed.\n' });
			await store.setStatus(firstTask, 'completed');
			controls.remove(firstTask);
			await provider.open(firstTask);
			await rendered(cdp, marker);
			controls.add(nextTask, {
				generation, cancel: async () => { cancellations += 1; },
			});
			autoOpen = true;
			await store.beginTask({
				...input, taskId: nextTask, prompt: 'Continue the same retained Mesh session.', continuation: recovery,
			});
			await store.setRecovery(nextTask, recovery);
			await store.setStatus(nextTask, 'running');
			await store.append(nextTask, { kind: 'output', text: `${nextMarker}\n` });
			await rendered(cdp, nextMarker);
			await sessionListed(cdp, input.title);
			await eventually(() => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
				.filter((tab) => tab.label === input.title).length === 1);
			await store.setStatus(nextTask, 'completed');
			controls.remove(nextTask);
			assert.equal(store.list().length, 1);
			assert.equal(store.get(firstTask)?.turns.length, 2);
			assert.equal(provider.diagnostics.sessions, 1);
			assert.equal(cancellations, 0);
			controls.add(cancelledTask, {
				generation, cancel: async () => {
					cancellations += 1;
					await store.setStatus(cancelledTask, 'cancelled');
					controls.remove(cancelledTask);
				},
			});
			await store.beginTask({ ...input, taskId: cancelledTask, title: 'Native cancellation control POC' });
			await store.setStatus(cancelledTask, 'running');
			await provider.open(cancelledTask);
			const resource = provider.resource({ id: cancelledTask }).toString();
			await vscode.commands.executeCommand(NATIVE_CHAT_CANCEL_COMMAND, resource, cancelledTask);
			assert.equal(cancellations, 0, 'Declining confirmation must not cancel execution.');
			confirmCancellation = true;
			await vscode.commands.executeCommand(NATIVE_CHAT_CANCEL_COMMAND, resource, cancelledTask);
			assert.equal(cancellations, 1);
			assert.equal(store.get(cancelledTask)?.turns.at(-1)?.status, 'cancelled');
			await assert.rejects(
				Promise.resolve(vscode.commands.executeCommand(NATIVE_CHAT_CANCEL_COMMAND, resource, cancelledTask)),
				/no longer active/,
			);
			assert.equal(actionErrors.length, 1);
			await provider.open(firstTask);
		} else {
			const saved = JSON.parse(await readFile(join(root, 'live.json'), 'utf8'));
			assert.equal(saved.passed, true);
			assert.equal(store.list().length, 2);
			assert.equal(store.get(firstTask)?.turns.length, 2);
			assert.equal(provider.diagnostics.sessions, 2);
			await provider.open(firstTask);
			await rendered(cdp, marker);
			await rendered(cdp, nextMarker);
			await vscode.commands.executeCommand('agentSessions.showAgentSessionsSidebar');
			await sessionListed(cdp, input.title);
			assert.equal(provider.diagnostics.activeViews, 0);
			assert.equal(store.get(cancelledTask)?.turns.at(-1)?.status, 'cancelled');
		}
		assert.deepEqual(errors, []);
		await store.flush();
		await writeFile(join(root, `${phase}.json`), JSON.stringify({
			passed: true, vscodeVersion: vscode.version, at: new Date().toISOString(),
			phase, ...provider.diagnostics,
			turns: store.get(firstTask)?.turns.length,
			cancellations, modelCalls: 0, cancellationConfirmation: 'injected decision; VS Code extension tests refuse modal prompts',
		}));
	} finally {
		provider.dispose();
		cdp.dispose();
	}
}

interface CdpClient { call(method: string, params?: object): Promise<unknown>; dispose(): void }

async function connectCdp(port: number): Promise<CdpClient> {
	const targets = z.array(z.object({
		type: z.string(), url: z.string(), webSocketDebuggerUrl: z.string().optional(),
	})).parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
	const page = targets.find((target) => target.type === 'page' && /workbench/.test(target.url));
	assert.ok(page?.webSocketDebuggerUrl, 'An actual VS Code workbench renderer must be available.');
	const socket = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve(), { once: true });
		socket.addEventListener('error', () => reject(new Error('Native Chat test CDP connection failed.')), { once: true });
	});
	let nextId = 0;
	const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	socket.addEventListener('message', (event) => {
		if (typeof event.data !== 'string') { return; }
		const message = z.object({
			id: z.number().optional(), result: z.unknown().optional(),
			error: z.object({ message: z.string() }).optional(),
		}).parse(JSON.parse(event.data));
		if (message.id === undefined) { return; }
		const request = pending.get(message.id);
		pending.delete(message.id);
		if (request !== undefined) { clearTimeout(request.timer); }
		if (message.error !== undefined) { request?.reject(new Error(message.error.message)); }
		else { request?.resolve(message.result); }
	});
	return {
		call: (method, params) => new Promise((resolve, reject) => {
			const id = ++nextId;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Native Chat test CDP request timed out: ${method}`));
			}, 5_000);
			pending.set(id, { resolve, reject, timer });
			socket.send(JSON.stringify({ id, method, params }));
		}),
		dispose: () => {
			for (const request of pending.values()) {
				clearTimeout(request.timer);
				request.reject(new Error('Native Chat test CDP connection closed.'));
			}
			pending.clear();
			socket.close();
		},
	};
}

async function rendered(cdp: CdpClient, text: string): Promise<void> {
	let body = '';
	try {
		await eventually(async () => {
			const result = z.object({ result: z.object({ value: z.string() }) }).parse(await cdp.call('Runtime.evaluate', {
				expression: 'document.body.innerText', returnByValue: true,
			}));
			body = result.result.value;
			return body.includes(text);
		});
	} catch (error: unknown) {
		throw new Error(`Native Chat did not render ${text}. Workbench text: ${body.slice(-7000)}`, { cause: error });
	}
}

async function sessionListed(cdp: CdpClient, title: string): Promise<void> {
	await eventually(async () => {
		const result = z.object({ result: z.object({ value: z.number() }) }).parse(await cdp.call('Runtime.evaluate', {
			expression: `Array.from(document.querySelectorAll('[role="treeitem"],[role="listitem"]')).filter(e => e.innerText.includes(${JSON.stringify(title)})).length`,
			returnByValue: true,
		}));
		return result.result.value === 1;
	});
}

async function eventually(condition: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await condition()) { return; }
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('The native Chat UI condition was not observed within 15 seconds.');
}
