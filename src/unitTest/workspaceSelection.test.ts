import assert from 'node:assert/strict';
import test from 'node:test';

import { planWorkspaceSelection } from '../agentHost/WorkspaceSelection';

const same = (left: string, right: string) => left === right;

test('workspace selection prefers the active editor workspace', () => {
	assert.deepEqual(
		planWorkspaceSelection(['first', 'active'], 'active', same),
		{ kind: 'selected', workspace: 'active' },
	);
});

test('workspace selection requires a prompt for ambiguous multi-root context', () => {
	assert.deepEqual(
		planWorkspaceSelection(['first', 'second'], undefined, same),
		{ kind: 'prompt', workspaces: ['first', 'second'] },
	);
});

test('workspace selection chooses the sole workspace and rejects an empty set', () => {
	assert.deepEqual(
		planWorkspaceSelection(['only'], undefined, same),
		{ kind: 'selected', workspace: 'only' },
	);
	assert.deepEqual(planWorkspaceSelection([], undefined, same), { kind: 'unavailable' });
});
