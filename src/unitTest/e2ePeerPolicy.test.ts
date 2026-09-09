import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectE2ePeerPolicyHandle } from '../composition/PeerDelegationE2eApi';
import type { DashboardPolicyCandidateSnapshot } from '../ui/DashboardFacade';

const candidate: DashboardPolicyCandidateSnapshot = {
	nodeId: 'target-node', nodeInstanceId: 'target-instance', actionHandle: 'a'.repeat(32),
	windowLabel: 'repo-b', workspaceName: 'repo-b', online: true, acceptsIncoming: false,
	busy: false, allowlisted: false, self: false, canToggle: true, claimState: 'claimed', gateState: 'notAllowed',
};
const target = { nodeId: 'target-node', nodeInstanceId: 'target-instance' };

test('E2E policy changes select an exact live node instance rather than a duplicate display name', () => {
	const duplicate = { ...candidate, nodeId: 'other-node', actionHandle: 'b'.repeat(32) };
	assert.equal(selectE2ePeerPolicyHandle([duplicate, candidate], 'repo-b', target), candidate.actionHandle);
	assert.throws(() => selectE2ePeerPolicyHandle([duplicate, candidate], 'repo-b'), /ambiguous/u);
});

test('E2E policy changes reject stale instances, self targets, unavailable handles and labels', () => {
	for (const value of [
		{ ...candidate, nodeInstanceId: 'stale-instance' },
		{ ...candidate, self: true },
		{ ...candidate, canToggle: false },
		{ ...candidate, actionHandle: undefined },
	]) {
		assert.throws(() => selectE2ePeerPolicyHandle([value], 'repo-b', target), /unavailable/u);
	}
	assert.throws(() => selectE2ePeerPolicyHandle([candidate], 'file:///private', target), /invalid/u);
});
