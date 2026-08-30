import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import {
	delegationGrantSchema,
	type NodeTaskStartParams,
} from '../../shared/protocol';
import type {
	AgentInputRequest,
	RegisteredLocalWorkspace,
} from '../agentHost/AgentRuntime';
import { canonicalRoutedTaskRequestHash } from '../domain/task';
import {
	assertDelegationGrantBinding,
	canAutoApproveToolConfirmation,
	createDelegationGrant,
} from '../node/DelegationGrant';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const NODE_ID = '00000000-0000-4000-8000-000000000002';
const INSTANCE_ID = '00000000-0000-4000-8000-000000000003';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000004';
const TASK_ID = '00000000-0000-4000-8000-000000000005';
const OWNER_ID = '00000000-0000-4000-8000-000000000006';
const WORKSPACE_IDENTITY = `sha256:${'a'.repeat(43)}`;

test('delegation grant schema is exact, immutable, and bound to routed semantics', () => {
	const params = taskParams();
	const workspace: RegisteredLocalWorkspace = {
		workspaceId: WORKSPACE_ID,
		workspaceIdentity: WORKSPACE_IDENTITY,
		displayName: 'Workspace',
		uri: pathToFileURL(process.cwd()).href,
	};
	const grant = assertDelegationGrantBinding(params, workspace);
	assert.deepEqual(grant.autoApprove, ['localTerminal', 'localFileWrite']);
	assert.deepEqual(grant.neverAutoApprove, [
		'networkAuth',
		'crossWorkspaceWrite',
		'secretAccess',
		'externalPublish',
	]);
	assert.equal(Object.isFrozen(grant), true);
	assert.equal(Object.isFrozen(grant.autoApprove), true);
	assert.throws(() => delegationGrantSchema.parse({ ...grant, extra: true }));
	assert.throws(() => delegationGrantSchema.parse({
		...grant,
		autoApprove: ['localFileWrite', 'localTerminal'],
	}));

	for (const delegationGrant of [
		{ ...grant, taskId: OWNER_ID },
		{ ...grant, targetNodeId: OWNER_ID },
		{ ...grant, targetNodeInstanceId: OWNER_ID },
		{ ...grant, workspaceIdentity: `sha256:${'b'.repeat(43)}` },
		{ ...grant, requestHash: 'f'.repeat(64) },
	]) {
		assert.throws(() => assertDelegationGrantBinding(
			{ ...params, delegationGrant },
			workspace,
		));
	}
	assert.throws(() => assertDelegationGrantBinding(params, {
		...workspace,
		workspaceIdentity: `sha256:${'b'.repeat(43)}`,
	}));
});

test('only structured write_file edits canonicalized inside the exact workspace auto-approve', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'mesh-grant-'));
	const workspacePath = join(root, 'repo');
	const siblingPath = join(root, 'repo2');
	const outsidePath = join(root, 'outside');
	await Promise.all([
		mkdir(workspacePath),
		mkdir(siblingPath),
		mkdir(outsidePath),
	]);
	await mkdir(join(workspacePath, 'src'));
	await symlink(outsidePath, join(workspacePath, 'escape'));
	t.after(() => rm(root, { recursive: true, force: true }));

	const params = taskParams();
	const grant = params.delegationGrant;
	const workspace: RegisteredLocalWorkspace = {
		workspaceId: WORKSPACE_ID,
		workspaceIdentity: WORKSPACE_IDENTITY,
		displayName: 'Workspace',
		uri: pathToFileURL(workspacePath).href,
	};
	const inside = pathToFileURL(join(workspacePath, 'src', 'new.ts')).href;
	const outside = pathToFileURL(join(outsidePath, 'new.ts')).href;
	const sibling = pathToFileURL(join(siblingPath, 'new.ts')).href;
	const symlinkEscape = pathToFileURL(join(workspacePath, 'escape', 'new.ts')).href;

	assert.equal(await decide(grant, workspace, fileRequest([{ afterUri: inside }])), true);
	await writeFile(join(workspacePath, 'src', 'new.ts'), 'existing');
	assert.equal(await decide(grant, workspace, fileRequest([
		{ beforeUri: inside, afterUri: inside },
	])), true);

	const denied: AgentInputRequest[] = [
		fileRequest([{ afterUri: outside }]),
		fileRequest([{ afterUri: sibling }]),
		fileRequest([{ afterUri: symlinkEscape }]),
		fileRequest([{ afterUri: pathToFileURL(join(workspacePath, '.env')).href }]),
		fileRequest([{ afterUri: pathToFileURL(join(workspacePath, '.ssh', 'config')).href }]),
		fileRequest([{ afterUri: 'src/new.ts' }]),
		fileRequest([{ afterUri: 'file:///tmp/%2e%2e/escape' }]),
		fileRequest([{ afterUri: 'file:///tmp/a%2Fb' }]),
		fileRequest([{ afterUri: pathToFileURL(join(workspacePath, 'missing', 'file.txt')).href }]),
		fileRequest([{ afterUri: 'file://server/share/file.txt' }]),
		fileRequest([{ afterUri: 'file:///C:/repo/file.txt' }]),
		fileRequest([{ afterUri: inside }, { afterUri: outside }]),
		fileRequest([{ afterUri: inside }], 'unknown_file_tool'),
		{
			...fileRequest([{ afterUri: inside }]),
			confirmationEvidence: {
				...fileRequest([{ afterUri: inside }]).confirmationEvidence,
				untrusted: true,
			},
		} as AgentInputRequest,
		{
			requestId: 'terminal',
			kind: 'toolConfirmation',
			prompt: 'Run command?',
			confirmationEvidence: {
				phase: 'operation',
				toolName: 'bash',
			},
		},
		{
			requestId: 'result',
			kind: 'toolConfirmation',
			prompt: 'Approve result?',
			confirmationEvidence: {
				phase: 'result',
				toolName: 'write_file',
				fileEdits: [{ afterUri: inside }],
			},
		},
		{
			requestId: 'auth',
			kind: 'toolAuthentication',
			prompt: 'Authenticate?',
		},
		{
			requestId: 'chat',
			kind: 'chatInput',
			prompt: 'Continue?',
		},
	];
	for (const request of denied) {
		assert.equal(await decide(grant, workspace, request), false, request.requestId);
	}
	assert.equal(await decide(grant, {
		...workspace,
		workspaceIdentity: `sha256:${'b'.repeat(43)}`,
	}, fileRequest([{ afterUri: inside }])), false);
	assert.equal(await canAutoApproveToolConfirmation(
		grant,
		OWNER_ID,
		workspace,
		fileRequest([{ afterUri: inside }]),
	), false);
});

function taskParams(): NodeTaskStartParams {
	const routed = {
		delegationRequestId: '00000000-0000-4000-8000-000000000007',
		taskId: TASK_ID,
		target: {
			deviceId: DEVICE_ID,
			nodeId: NODE_ID,
			nodeInstanceId: INSTANCE_ID,
			workspaceId: WORKSPACE_ID,
		},
		sourceNodeId: OWNER_ID,
		sourceWorkspaceIdentity: `sha256:${'c'.repeat(43)}`,
		title: 'Task',
		prompt: 'Prompt',
		acceptanceCriteria: ['Done'],
		timeoutMinutes: 60,
		workerDeadline: '2030-01-01T00:00:00.000Z',
	};
	const requestHash = canonicalRoutedTaskRequestHash({
		...routed,
		peerId: OWNER_ID,
		workspaceLeaseKey: WORKSPACE_IDENTITY,
	});
	return {
		...routed,
		authenticatedOwnerId: OWNER_ID,
		sourceLabel: 'Source',
		delegationGrant: createDelegationGrant({
			taskId: TASK_ID,
			targetNodeId: NODE_ID,
			targetNodeInstanceId: INSTANCE_ID,
			workspaceIdentity: WORKSPACE_IDENTITY,
			requestHash,
		}),
	};
}

function fileRequest(
	fileEdits: NonNullable<AgentInputRequest['confirmationEvidence']>['fileEdits'],
	toolName = 'write_file',
): AgentInputRequest {
	return {
		requestId: `${toolName}:${fileEdits?.length ?? 0}`,
		kind: 'toolConfirmation',
		prompt: 'Write file?',
		confirmationEvidence: {
			phase: 'operation',
			toolName,
			fileEdits,
		},
	};
}

function decide(
	grant: NodeTaskStartParams['delegationGrant'],
	workspace: RegisteredLocalWorkspace,
	request: AgentInputRequest,
): Promise<boolean> {
	return canAutoApproveToolConfirmation(grant, TASK_ID, workspace, request);
}
