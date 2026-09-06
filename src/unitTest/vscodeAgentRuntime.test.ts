import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';

import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { getWorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import { createVscodeAgentRuntime } from '../composition/VscodeAgentRuntime';
import { TestAuthentication } from './connectivityTestSupport';

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

function runtimeFixture(previousSetting: boolean | undefined, registered = true, supported = true) {
	const root = join(tmpdir(), `mesh-runtime-gate-${randomUUID()}`);
	const reads: string[] = [];
	const authentication = new TestAuthentication();
	const api = {
		workspace: {
			getConfiguration: () => ({
				get: (key: string, fallback?: unknown) => {
					reads.push(key);
					if (key === 'experimental.agentHost') { return previousSetting; }
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
	);
	return { runtime, root, reads, authentication, get approvals() { return approvals; } };
}
