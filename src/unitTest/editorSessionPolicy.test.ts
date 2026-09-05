import * as assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { SessionConfigSchema } from '@microsoft/agent-host-protocol' with { 'resolution-mode': 'import' };

import { AgentRuntimeError } from '../agentHost/AgentRuntime';
import {
	createAgentSessionIdentity,
	EditorSessionPolicy,
	EditorSessionPolicyError,
	matchesEditorSessionWorkspace,
} from '../agentHost/EditorSessionPolicy';

const workspace = pathToFileURL(join(tmpdir(), 'mesh policy # workspace')).href;
const otherWorkspace = pathToFileURL(join(tmpdir(), 'mesh other workspace')).href;
const identity = createAgentSessionIdentity('editor', 'copilotcli', 'logical-session');

function sessionSnapshot() {
	return {
		resource: identity.uri,
		fromSeq: 1,
		state: {
			provider: identity.provider,
			workingDirectories: [workspace],
			config: { values: { isolation: 'folder', model: 'auto' } },
		},
	};
}

function schema(readOnly = false): SessionConfigSchema {
	return {
		type: 'object',
		properties: {
			isolation: { type: 'string', title: 'Isolation', enum: ['folder', 'worktree'], readOnly },
		},
	};
}

test('Editor identities use the selected provider while standalone keeps its existing scheme', () => {
	assert.deepEqual(identity, { provider: 'copilotcli', uri: 'copilotcli:/logical-session' });
	assert.equal(createAgentSessionIdentity('editor', 'claude', 'other').uri, 'claude:/other');
	assert.equal(createAgentSessionIdentity('standalone', 'copilotcli', 'legacy').uri, 'ahp-session:/legacy');
	assert.equal(createAgentSessionIdentity(undefined, 'copilotcli', 'legacy').uri, 'ahp-session:/legacy');
	assert.equal(Object.isFrozen(identity), true);
	for (const provider of ['', '9provider', 'agent/name', 'copilot:other', 'agent name']) {
		assert.throws(
			() => createAgentSessionIdentity('editor', provider, 'id'),
			(error: unknown) => error instanceof AgentRuntimeError && error.code === 'AGENT_CONFIG_REQUIRED',
		);
	}
});

test('workspace matching uses the complete local URI and rejects missing or widened scopes', () => {
	assert.equal(matchesEditorSessionWorkspace([workspace], workspace), true);
	assert.equal(matchesEditorSessionWorkspace([`${workspace}/`], workspace), true);
	for (const directories of [
		undefined,
		[],
		[otherWorkspace],
		[`${workspace}/child`],
		[workspace, otherWorkspace],
		[workspace, workspace],
		[`${workspace}?other=1`],
		[`${workspace}#fragment`],
		['https://example.test/workspace'],
		['file://remote-host/workspace'],
		['file:///invalid%2Fdirectory'],
		[null],
	]) {
		assert.equal(matchesEditorSessionWorkspace(directories, workspace), false);
	}
	assert.equal(matchesEditorSessionWorkspace([workspace], 'not-a-uri'), false);
});

test('folder policy preserves other options and accepts a read-only folder result', () => {
	const policy = new EditorSessionPolicy(identity, workspace);
	const original = { isolation: 'worktree', model: 'selected', branch: 'existing' };
	assert.deepEqual(policy.constrainConfiguration(original), {
		isolation: 'folder', model: 'selected', branch: 'existing',
	});
	assert.equal(original.isolation, 'worktree');
	policy.assertResolvedConfiguration(schema(), { isolation: 'folder' });
	policy.assertResolvedConfiguration(schema(true), { isolation: 'folder' });
	assert.throws(() => policy.assertResolvedConfiguration(schema(), { isolation: 'worktree' }), AgentRuntimeError);
	assert.throws(() => policy.assertResolvedConfiguration(schema(), {}), AgentRuntimeError);
	assert.throws(
		() => policy.assertResolvedConfiguration({ type: 'object', properties: {} }, { isolation: 'folder' }),
		AgentRuntimeError,
	);
	const incompatible = schema();
	incompatible.properties.isolation = { type: 'string', title: 'Isolation', enum: ['worktree'] };
	assert.throws(() => policy.assertResolvedConfiguration(incompatible, { isolation: 'folder' }), AgentRuntimeError);
});

test('native Session snapshots use the envelope identity without a duplicate state resource', () => {
	const policy = new EditorSessionPolicy(identity, workspace);
	const snapshot = sessionSnapshot();
	assert.equal(Object.hasOwn(snapshot.state, 'resource'), false);
	policy.acceptSnapshot(snapshot);
	policy.assertCurrentState();
	policy.acceptSnapshot({ ...snapshot, state: { ...snapshot.state, resource: identity.uri } });
	policy.assertCurrentState();
});

test('Session policy checks envelope identity, provider, config and workspace without exposing values', () => {
	const snapshot = sessionSnapshot();
	for (const invalid of [
		undefined,
		{},
		snapshot.state,
		{ ...snapshot, resource: undefined },
		{ ...snapshot, resource: 'ahp-session:/logical-session' },
		{ ...snapshot, state: undefined },
		{ ...snapshot, state: { ...snapshot.state, resource: 'copilotcli:/another-session' } },
		{ state: { ...snapshot.state, resource: identity.uri } },
		{
			...snapshot,
			resource: 'copilotcli:/another-session',
			state: { ...snapshot.state, resource: identity.uri },
		},
		{ ...snapshot, state: { ...snapshot.state, provider: 'claude' } },
		{ ...snapshot, state: { ...snapshot.state, workingDirectories: [otherWorkspace] } },
		{ ...snapshot, state: { ...snapshot.state, workingDirectories: undefined } },
		{ ...snapshot, state: { ...snapshot.state, config: undefined } },
		{ ...snapshot, state: { ...snapshot.state, config: { values: { isolation: 'worktree' } } } },
	]) {
		const policy = new EditorSessionPolicy(identity, workspace);
		assert.throws(() => policy.acceptSnapshot(invalid), (error: unknown) => {
			assert.ok(error instanceof EditorSessionPolicyError);
			assert.equal(error.message.includes(workspace), false);
			assert.equal(error.message.includes(otherWorkspace), false);
			assert.equal(error.message.includes(identity.uri), false);
			return true;
		});
	}
});

test('Session config replacement cannot silently drop folder isolation', async () => {
	const { ActionType } = await import('@microsoft/agent-host-protocol');
	const policy = new EditorSessionPolicy(identity, workspace);
	policy.acceptSnapshot(sessionSnapshot());
	policy.acceptAction({ type: ActionType.SessionConfigChanged, config: { model: 'another' } });
	policy.assertCurrentState();
	assert.throws(
		() => policy.acceptAction({ type: ActionType.SessionConfigChanged, config: { model: 'another' }, replace: true }),
		EditorSessionPolicyError,
	);
	policy.acceptAction({ type: ActionType.SessionConfigChanged, config: { isolation: 'folder' }, replace: true });
	policy.assertCurrentState();
});

test('Session directory updates keep harmless membership no-ops but reject scope changes', async () => {
	const { ActionType } = await import('@microsoft/agent-host-protocol');
	const policy = new EditorSessionPolicy(identity, workspace);
	policy.acceptSnapshot(sessionSnapshot());
	policy.acceptAction({ type: ActionType.SessionWorkingDirectorySet, directory: workspace });
	policy.acceptAction({ type: ActionType.SessionWorkingDirectoryRemoved, directory: otherWorkspace });
	policy.acceptAction({
		type: ActionType.SessionWorkingDirectoryReplaced, directory: otherWorkspace, replacement: workspace,
	});
	policy.assertCurrentState();
	assert.throws(
		() => policy.acceptAction({ type: ActionType.SessionWorkingDirectorySet, directory: otherWorkspace }),
		EditorSessionPolicyError,
	);
	assert.throws(
		() => policy.acceptAction({ type: ActionType.SessionWorkingDirectoryRemoved, directory: workspace }),
		EditorSessionPolicyError,
	);
	assert.throws(
		() => policy.acceptAction({
			type: ActionType.SessionWorkingDirectoryReplaced, directory: workspace, replacement: otherWorkspace,
		}),
		EditorSessionPolicyError,
	);
});
