import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';

import { AgentRuntimeError, type AgentTaskRequest } from '../agentHost/AgentRuntime';
import { AgentHostSourceSelector } from '../agentHost/AgentHostSourceSelector';
import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { getWorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import { createVscodeAgentRuntime } from '../composition/VscodeAgentRuntime';
import { TestAuthentication } from './connectivityTestSupport';

test('a fresh configuration prefers the editor without requiring a peer-delegation opt-in', async (t) => {
	const f = runtimeFixture(undefined);
	t.after(() => f.runtime.dispose());
	const probe = await f.runtime.probe();
	assert.equal(probe.source, 'editor');
	assert.equal(probe.canStart, true);
	assert.equal(f.approvals, 0);
	assert.equal(f.authentication.requests.length, 0);
	assert.equal(existsSync(f.root), false);
});

test('the production editor runtime is on demand without reading the removed feature setting', async () => {
	for (const previousSetting of [undefined, false, true]) {
		const f = runtimeFixture(previousSetting);
		try {
			const probe = await f.runtime.probe({ requireEditor: true });
			assert.equal(probe.featureEnabled, true);
			assert.equal(probe.available, false);
			assert.equal(probe.canStart, true);
			assert.equal(probe.source, 'editor');
			assert.equal(f.reads.includes('experimental.agentHost'), false);
			assert.equal(f.approvals, 0);
			assert.equal(f.authentication.requests.length, 0);
			assert.equal(existsSync(f.root), false);
		} finally { await f.runtime.dispose(); }
	}
});

test('removing the runtime switch does not bypass task confirmation or registered Workspace resolution', async () => {
	for (const registered of [true, false]) {
		const f = runtimeFixture(false, registered);
		try {
			await assert.rejects(f.runtime.start({
				taskId: randomUUID(), workspaceId: 'workspace', title: 'Denied task',
				prompt: 'This task must not execute.', requireEditor: true,
			}), { code: registered ? 'TASK_EXECUTION_FAILED' : 'AGENT_UNAVAILABLE' });
			assert.equal(f.approvals, registered ? 1 : 0);
			assert.equal(f.authentication.requests.length, 0);
			assert.equal(existsSync(f.root), false);
		} finally { await f.runtime.dispose(); }
	}
});

test('removing the runtime switch preserves the Worker platform boundary', async (t) => {
	const f = runtimeFixture(false, true, false);
	t.after(() => f.runtime.dispose());
	assert.equal((await f.runtime.probe({ requireEditor: true })).featureEnabled, false);
	await assert.rejects(f.runtime.start({
		taskId: randomUUID(), workspaceId: 'workspace', title: 'Unsupported host',
		prompt: 'This task must not execute.', requireEditor: true,
	}), { code: 'AGENT_UNAVAILABLE' });
	assert.equal(f.approvals, 0);
	assert.equal(existsSync(f.root), false);
});

test('isolated editor-only diagnostics cannot select standalone even when local peer preference is off', async (t) => {
	const f = runtimeFixture(undefined, true, true, true);
	t.after(() => f.runtime.dispose());
	const probe = await f.runtime.probe();
	assert.equal(probe.source, 'editor');
	assert.equal(probe.canStart, true);
	const requests: AgentTaskRequest[] = [];
	t.mock.method(AgentHostSourceSelector.prototype, 'start', async (request: AgentTaskRequest) => {
		requests.push(request);
		throw new Error('No execution in this adapter test.');
	});
	await assert.rejects(f.runtime.start({
		taskId: randomUUID(), workspaceId: 'workspace', title: 'Editor-only denied task',
		prompt: 'This task must not execute.',
	}), /No execution/u);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].requireEditor, true);
	assert.equal(f.approvals, 0);
	assert.equal(f.authentication.requests.length, 0);
	assert.equal(existsSync(f.root), false);
});

test('failure diagnostics are isolated to the gated runtime and remove task text', async (t) => {
	t.mock.method(AgentHostSourceSelector.prototype, 'start', async (request: AgentTaskRequest) => {
		throw new AgentRuntimeError('TASK_EXECUTION_FAILED', `Provider rejected ${request.title}: ${request.prompt}`);
	});
	for (const editorOnly of [false, true]) {
		const f = runtimeFixture(undefined, true, true, editorOnly);
		try {
			await assert.rejects(f.runtime.start({
				taskId: randomUUID(), workspaceId: 'workspace', title: 'PRIVATE_TITLE_MARKER',
				prompt: 'PRIVATE_PROMPT_MARKER',
			}));
			if (editorOnly) {
				assert.match(f.runtime.failureDiagnostic()?.message ?? '', /Provider rejected/u);
				assert.doesNotMatch(JSON.stringify(f.runtime.failureDiagnostic()), /PRIVATE_/u);
			} else {
				assert.equal(f.runtime.failureDiagnostic(), undefined);
			}
		} finally { await f.runtime.dispose(); }
	}
});

function runtimeFixture(previousSetting: boolean | undefined, registered = true, supported = true, editorOnly = false) {
	const root = join(tmpdir(), `mesh-runtime-gate-${randomUUID()}`);
	const reads: string[] = [];
	const authentication = new TestAuthentication();
	const api = {
		workspace: {
			getConfiguration: () => ({
				get: (key: string, fallback?: unknown) => {
					reads.push(key);
					if (key === 'experimental.agentHost') { return previousSetting; }
					if (key === 'experimental.peerDelegation' && editorOnly) { return false; }
					if (key === 'agentHost.userDataDir') { return root; }
					if (key === 'codePath') { return join(root, 'unavailable-code'); }
					return fallback;
				},
			}),
		},
		Uri: { joinPath: (uri: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(uri.fsPath, ...parts) }) },
		env: { appName: 'Visual Studio Code' },
		authentication,
	} as unknown as typeof vscode;
	let approvals = 0;
	const runtime = createVscodeAgentRuntime(
		api,
		{ globalStorageUri: { fsPath: root } } as vscode.ExtensionContext,
		{
			resolve: async (workspaceId) => registered
				? { workspaceId, displayName: 'Workspace', uri: 'file:///mesh-runtime-gate-workspace' }
				: undefined,
		},
		new LocalDesktopWorkspaceGuard(() => ({
			remoteName: undefined, isTrusted: true, workspaceFolders: [{ uriScheme: 'file' }],
		})),
		{ confirm: async () => { approvals += 1; return 'deny'; } },
		getWorkerPlatformSupport(supported ? 'darwin' : 'linux', supported ? 'arm64' : 'x64'),
		undefined, undefined, undefined, undefined, undefined, undefined, 0, editorOnly,
	);
	return { runtime, root, reads, authentication, get approvals() { return approvals; } };
}
