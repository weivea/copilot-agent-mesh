import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	combineOperationAndCleanupError,
	confirmTaskCancellation,
	grantTemporaryWorkspaceTask,
	runtimeCanStart,
} from './diagnostic-support.mjs';

test('passive editor readiness permits starting without disabling the feature gate', () => {
	assert.equal(runtimeCanStart({ available: false, canStart: true, featureEnabled: true, source: 'editor' }), true);
	assert.equal(runtimeCanStart({ available: true, featureEnabled: true }), true);
	assert.equal(runtimeCanStart({ available: true, canStart: true, featureEnabled: false }), false);
	assert.equal(runtimeCanStart({ available: false, canStart: false, featureEnabled: true }), false);
});

test('diagnostic cancellation is followed by exact-task terminal confirmation', async () => {
	let time = 0;
	const actions = [];
	const statuses = ['cancelling', 'cancelled'];
	const result = await confirmTaskCancellation(async (_source, action, input, timeout) => {
		actions.push(action);
		assert.equal(input.taskId, 'owned-task');
		assert.ok(timeout > 0 && timeout <= 1_000);
		return action === 'task.cancel' ? {} : { snapshot: { taskId: 'owned-task', status: statuses.shift() } };
	}, {}, 'owned-task', { now: () => time, delay: async (ms) => { time += ms; }, timeoutMs: 1_000 });
	assert.equal(result, 'cancelled');
	assert.deepEqual(actions, ['task.cancel', 'task.get', 'task.get']);
});

test('failed cancellation still attempts reads and retains both primary and cleanup errors', async () => {
	let time = 0;
	let reads = 0;
	const original = new Error('original task failure');
	const cancellation = new Error('cancel request failed');
	let cleanup;
	try {
		await confirmTaskCancellation(async (_source, action) => {
			if (action === 'task.cancel') {
				throw cancellation;
			}
			reads++;
			return { snapshot: { taskId: 'owned-task', status: 'running' } };
		}, {}, 'owned-task', { now: () => time, delay: async (ms) => { time += ms; }, timeoutMs: 300 });
		assert.fail('Unconfirmed cancellation must fail.');
	} catch (error) {
		cleanup = error;
	}
	assert.ok(reads > 0 && reads <= 3);
	assert.ok(cleanup instanceof AggregateError);
	assert.equal(cleanup.errors[0], cancellation);
	const combined = combineOperationAndCleanupError(original, cleanup);
	assert.deepEqual(combined.errors, [original, cleanup]);
});

test('an unrelated terminal snapshot never confirms cancellation', async () => {
	let time = 0;
	await assert.rejects(confirmTaskCancellation(async () => ({
		snapshot: { taskId: 'foreign-task', status: 'completed' },
	}), {}, 'owned-task', {
		now: () => time, delay: async (ms) => { time += ms; }, timeoutMs: 200,
	}), /cancellation cleanup failed/u);
});

test('a failed cancel RPC is not silently discarded even when a terminal read succeeds', async () => {
	const failure = new Error('cancel transport failure');
	await assert.rejects(confirmTaskCancellation(async (_source, action) => {
		if (action === 'task.cancel') {
			throw failure;
		}
		return { snapshot: { taskId: 'owned-task', status: 'cancelled' } };
	}, {}, 'owned-task'), (error) => error instanceof AggregateError
		&& error.errors[0] === failure && error.terminalState === 'cancelled');
});

const source = { nodeId: 'source', nodeInstanceId: 'source-instance', workspaceBasename: 'repo-a' };
const target = { nodeId: 'target', nodeInstanceId: 'target-instance', workspaceBasename: 'repo-b' };
const candidate = {
	nodeId: target.nodeId, nodeInstanceId: target.nodeInstanceId, workspaceName: 'repo-b',
	windowLabel: 'Exact test target', self: false, allowlisted: false, acceptsIncoming: false,
};

test('explicit grants affect only the exact test target and restore default-deny reception', async () => {
	const mutations = [];
	const restore = await grantTemporaryWorkspaceTask(async (controller, action, params) => {
		if (action === 'snapshot') {
			return { policyCandidates: [{ ...candidate }, { ...candidate, nodeId: 'foreign', windowLabel: 'Other' }] };
		}
		mutations.push({ node: controller.nodeId, action, params });
		return {};
	}, source, target);
	await restore();
	assert.deepEqual(mutations.map(({ node, action, params }) => [
		node, action, params.enabled ?? params.allowed,
	]), [
		['target', 'peer.policy.accept', true],
		['source', 'peer.policy.allow', true],
		['source', 'peer.policy.allow', false],
		['target', 'peer.policy.accept', false],
	]);
	assert.equal(mutations[1].params.nodeId, target.nodeId);
	assert.equal(mutations[1].params.nodeInstanceId, target.nodeInstanceId);
});

test('a partial grant failure still rolls back receive and allowlist changes', async () => {
	const values = [];
	const original = new Error('allowlist failed');
	await assert.rejects(grantTemporaryWorkspaceTask(async (_controller, action, params) => {
		if (action === 'snapshot') {
			return { policyCandidates: [{ ...candidate }] };
		}
		values.push([action, params.enabled ?? params.allowed]);
		if (action === 'peer.policy.allow' && params.allowed) {
			throw original;
		}
		return {};
	}, source, target), (error) => error === original);
	assert.deepEqual(values.slice(-2), [['peer.policy.allow', false], ['peer.policy.accept', false]]);
});

test('grant restoration serializes shared-revision mutations but still attempts both cleanup steps', async () => {
	let active = false;
	const restored = [];
	const restore = await grantTemporaryWorkspaceTask(async (_controller, action, params) => {
		if (action === 'snapshot') { return { policyCandidates: [{ ...candidate }] }; }
		assert.equal(active, false, 'Concurrent policy mutations would invalidate the action revision.');
		active = true;
		await new Promise((resolve) => setImmediate(resolve));
		active = false;
		if (!(params.enabled ?? params.allowed)) { restored.push(action); }
		return {};
	}, source, target);
	await restore();
	assert.deepEqual(restored, ['peer.policy.allow', 'peer.policy.accept']);
});

test('policy grants cannot target a non-harness Workspace', async () => {
	let calls = 0;
	await assert.rejects(grantTemporaryWorkspaceTask(async () => { calls++; }, source, {
		...target, workspaceBasename: 'normal-project',
	}), /harness-created/u);
	assert.equal(calls, 0);
});
