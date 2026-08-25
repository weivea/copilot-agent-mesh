import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
	multiWindowControlDirectory,
	multiWindowWorkspaceKey,
	parseMultiWindowRequest,
	parseProcessTable,
	selectOwnedProcesses,
} from '../e2e/MultiWindowE2eSupport';

const nonce = '00000000-0000-4000-8000-000000000001';
const windowId = '00000000-0000-4000-8000-000000000002';
const requestId = '00000000-0000-4000-8000-000000000003';

test('multi-window control paths are deterministic, basename-scoped, and traversal-safe', () => {
	const key = multiWindowWorkspaceKey('repo-a');
	assert.match(key, /^repo-a-[a-f0-9]{12}$/u);
	assert.equal(multiWindowWorkspaceKey('repo-a'), key);
	assert.notEqual(multiWindowWorkspaceKey('repo-b'), key);
	assert.equal(
		multiWindowControlDirectory(resolve('.e2e-control'), 'repo-a', windowId),
		resolve('.e2e-control', 'windows', key, windowId),
	);
	assert.throws(
		() => multiWindowControlDirectory('relative', 'repo-a', windowId),
		/must be absolute/u,
	);
	assert.throws(() => multiWindowWorkspaceKey('..'), /invalid/u);
	assert.throws(
		() => multiWindowControlDirectory(resolve('.e2e-control'), 'repo-a', 'not-a-uuid'),
		/UUID v4/u,
	);
});

test('multi-window controller accepts only the exact nonce and window envelope', () => {
	const workspaceKey = multiWindowWorkspaceKey('repo-a');
	const envelope = {
		schemaVersion: 1,
		id: requestId,
		action: 'controller.state',
		nonce,
		role: 'coordinator',
		workspaceKey,
		windowId,
		params: {},
	};
	assert.deepEqual(
		parseMultiWindowRequest(envelope, { nonce, workspaceKey, windowId }),
		envelope,
	);
	for (const invalid of [
		{ ...envelope, nonce: '00000000-0000-4000-8000-000000000004' },
		{ ...envelope, windowId: '00000000-0000-4000-8000-000000000004' },
		{ ...envelope, workspaceKey: multiWindowWorkspaceKey('repo-b') },
		{ ...envelope, role: 'worker' },
		{ ...envelope, extra: true },
		{ ...envelope, params: [] },
	]) {
		assert.throws(
			() => parseMultiWindowRequest(invalid, { nonce, workspaceKey, windowId }),
			/Invalid multi-window E2E request envelope/u,
		);
	}
});

test('owned process selection uses exact roots and markers, then only their descendants', () => {
	const entries = parseProcessTable([
		' 100 1 100 /Applications/Code --user-data-dir=/run/owned/user-data',
		' 101 100 100 Code Helper',
		' 102 101 100 code agent host --user-data-dir=/run/owned/agent',
		' 200 1 200 /Applications/Code --user-data-dir=/run/other/user-data',
		' 201 200 200 Code Helper',
		' malformed',
	].join('\n'));
	assert.deepEqual(
		selectOwnedProcesses(entries, {
			rootPids: new Set([100]),
			markers: ['/run/owned'],
			selfPid: 999,
		}).map(({ pid }) => pid),
		[102, 101, 100],
	);
	assert.deepEqual(
		selectOwnedProcesses(entries, {
			rootPids: new Set(),
			markers: ['/run/owned/agent'],
			selfPid: 999,
		}).map(({ pid }) => pid),
		[102],
	);
	assert.throws(
		() => selectOwnedProcesses(entries, {
			rootPids: new Set(),
			markers: [''],
			selfPid: 999,
		}),
		/non-empty/u,
	);
});
