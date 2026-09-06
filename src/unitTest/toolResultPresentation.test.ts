import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compactPresentedDelegation, presentToolResult } from '../tools/ToolResultPresentation';
import { serializeToolResultToTokenBudget } from '../tools/taskToolsCore';
import { uuid } from './artifactStoreTestSupport';

test('default presentation names the task state separately from the caller cancellation outcome', () => {
	const result = presentToolResult({ s: 3, t: uuid(1), d: uuid(2), e: 'TIMEOUT', x: 'budget', taskState: 'completed' });
	assert.equal(result.outcome, 'cancelled');
	assert.equal(result.taskState, 'completed');
	assert.deepEqual(result.nextAction, { tool: 'none' });
	assert.deepEqual(compactPresentedDelegation(result), {
		s: 3, t: uuid(1), d: uuid(2), e: 'TIMEOUT', x: 'budget', taskState: 'completed',
	});
});

test('submitted tasks are never presented as completed and unknown startup failures stay unknown', () => {
	const accepted = presentToolResult({ s: 4, t: uuid(1), d: uuid(2), taskState: 'startingAgent' });
	assert.equal(accepted.outcome, 'accepted');
	assert.equal(accepted.taskState, 'startingAgent');
	assert.deepEqual(accepted.nextAction, { tool: 'meshGetTask', taskId: uuid(1), waitFor: 'outcome' });
	const failed = presentToolResult({ s: 2, t: uuid(1), d: uuid(2), e: 'TUNNEL_UNAVAILABLE' });
	assert.equal(failed.taskState, 'unknown');
	assert.deepEqual(failed.nextAction, { tool: 'meshGetTask', taskId: uuid(1), waitFor: 'snapshot' });
});

test('readable output contracts to the compact fallback without discarding identity or authoritative state', async () => {
	const readable = presentToolResult({ s: 2, t: uuid(1), d: uuid(2), e: 'TASK_EXECUTION_FAILED', taskState: 'failed' });
	const roomy = await serializeToolResultToTokenBudget(readable, 2_000, async (text) => text.length);
	assert.equal(JSON.parse(roomy).taskId, uuid(1));
	const compact = await serializeToolResultToTokenBudget(readable, 190, async (text) => text.length);
	assert.equal(JSON.parse(compact).t, uuid(1));
	assert.equal(JSON.parse(compact).taskState, 'failed');
	assert.equal(JSON.parse(compact).e, 'TASK_EXECUTION_FAILED');
});
