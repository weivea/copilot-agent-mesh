import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { AgentRuntimeError } from '../agentHost/AgentRuntime';
import { DesktopCodespaceExecution, type CodespaceExecutionConnection } from '../codespaces/DesktopCodespaceExecution';
import { RemoteExecutionClient } from '../codespaces/RemoteExecutionClient';

test('a missing companion leaves an actionable runtime state without blocking the desktop Dashboard', async () => {
	const errors: Error[] = [];
	const client = new RemoteExecutionClient({
		identity: {
			version: 1, clientId: randomUUID(), nodeId: randomUUID(), nodeInstanceId: randomUUID(),
			nodeLabel: 'Codespace', authority: 'codespaces+test', expectedFolders: ['file:///workspace'],
			token: randomBytes(32).toString('base64url'),
		},
		extensionVersion: '0.5.0',
		invoke: async () => { throw new Error("command 'copilotAgentMesh.codespaces.connect' not found"); },
		workspaceResolver: { resolve: async () => undefined },
		eventSink: { publish() {} },
		onDisconnect: (error) => { errors.push(error); },
	});
	const execution = new DesktopCodespaceExecution(client, (error) => errors.push(error));
	try {
		await execution.initialize();
		assert.equal((await execution.runtime.probe()).available, false);
		assert.equal(execution.runtime.sourceStatus().source, 'codespace-owned');
		assert.ok(execution.runtime.failureDiagnostic());
		assert.deepEqual(await execution.listWorkspaces(), []);
		assert.ok(errors.length > 0);
		await assert.rejects(execution.runtime.start({
			taskId: randomUUID(), workspaceId: randomUUID(), title: 'Bypass', prompt: 'Not an authorized Node route.',
		}), { code: 'AGENT_UNAVAILABLE' });
	} finally { await execution.dispose(); }
});

test('unexpected initialization defects propagate instead of looking like an empty Codespace', async () => {
	const defect = new TypeError('Programming error.');
	const connection: CodespaceExecutionConnection = {
		connect: async () => { throw defect; },
		listWorkspaces: async () => [],
		resolveIdentity: async () => { throw new Error('Not used.'); },
		probe: async () => ({ available: false, featureEnabled: true }),
		start: async () => { throw new Error('Not used.'); },
		cancel: async () => {}, answer: async () => {}, dispose: async () => {},
	};
	const execution = new DesktopCodespaceExecution(connection, () => {});
	await assert.rejects(execution.initialize(), (error) => error === defect);
	await execution.dispose();
});

test('typed execution failures are visible and cannot become executable workspace claims', async () => {
	const connection: CodespaceExecutionConnection = {
		connect: async () => { throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'Companion version mismatch.'); },
		listWorkspaces: async () => { throw new Error('Must not claim unavailable workspaces.'); },
		resolveIdentity: async () => { throw new Error('Not used.'); },
		probe: async () => ({ available: false, featureEnabled: true }),
		start: async () => { throw new Error('Not used.'); },
		cancel: async () => {}, answer: async () => {}, dispose: async () => {},
	};
	const execution = new DesktopCodespaceExecution(connection, () => {});
	await execution.initialize();
	assert.deepEqual(await execution.listWorkspaces(), []);
	assert.equal(execution.runtime.failureDiagnostic()?.code, 'AGENT_UNAVAILABLE');
	assert.throws(() => execution.resolveIdentity('file:///workspace'), { code: 'AGENT_UNAVAILABLE' });
	await execution.dispose();
});
