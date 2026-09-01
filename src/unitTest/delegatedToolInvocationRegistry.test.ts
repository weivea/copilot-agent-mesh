import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
	DelegatedExecutionContext,
	RoutedTaskStartParams,
	TaskSnapshot,
} from '../../shared/protocol';
import { LocalIpcRemoteTaskAdapter } from '../node/LocalIpcRemoteTaskAdapter';
import type { WindowNodeClient } from '../node/WindowNodeClient';
import { DelegatedToolInvocationRegistry } from '../tools/DelegatedToolInvocationRegistry';
import { MESH_TOOL_NAMES } from '../tools/toolManifest';

const context: DelegatedExecutionContext = {
	kind: 'delegatedChild',
	taskId: '00000000-0000-4000-8000-000000000001',
	capability: 'a'.repeat(43),
};

test('keeps an exact delegated Mesh invocation correlated until authoritative completion', () => {
	const registry = new DelegatedToolInvocationRegistry();
	const input = delegationInput(10);
	registry.observe(observation('scope-a', 'call-a', input));
	assert.equal(registry.size, 1);
	assert.deepEqual(registry.consume({ ...input }), context);
	assert.equal(registry.size, 1);
	assert.deepEqual(registry.consume(input), context);
	registry.forget('scope-a', 'call-a');
	assert.equal(registry.size, 0);
	assert.equal(registry.consume(input), undefined);
});

test('forged, ambiguous, referenced, stale, and removed correlations yield no principal', () => {
	let now = 1_000;
	const registry = new DelegatedToolInvocationRegistry({
		ttlMs: 10,
		entryLimit: 2,
		scopeEntryLimit: 2,
		now: () => now,
	});
	const input = delegationInput(20);
	registry.observe(observation('scope-a', 'call-a', input));
	assert.equal(registry.consume({ ...input, prompt: 'forged' }), undefined);
	assert.equal(registry.size, 1);

	registry.observe(observation('scope-b', 'call-b', input));
	assert.deepEqual(registry.consume(input), context);
	assert.deepEqual(registry.consume(input), context);
	assert.equal(registry.size, 2);
	registry.clear();

	registry.observe({
		...observation('scope-a', 'call-c', input),
		toolInput: { uri: 'ahp-content:/untrusted' },
	});
	assert.equal(registry.size, 0);
	registry.observe(observation('scope-a', 'call-d', input));
	now += 10;
	assert.equal(registry.consume(input), undefined);

	now += 1;
	registry.observe(observation('scope-a', 'call-e', input));
	registry.forget('scope-a', 'call-e');
	assert.equal(registry.consume(input), undefined);
	registry.observe(observation('scope-a', 'call-f', input));
	registry.clearScope('scope-a');
	assert.equal(registry.consume(input), undefined);
	registry.observe(observation('scope-a', 'call-g', input));
	registry.clear();
	assert.equal(registry.consume(input), undefined);
});

test('bounds observations and disables correlation after disposal', () => {
	const registry = new DelegatedToolInvocationRegistry({
		entryLimit: 2,
		scopeEntryLimit: 2,
	});
	registry.observe(observation('scope-a', 'call-a', delegationInput(30)));
	registry.observe(observation('scope-a', 'call-b', delegationInput(31)));
	registry.observe(observation('scope-a', 'call-c', delegationInput(32)));
	assert.equal(registry.size, 2);
	assert.equal(registry.consume(delegationInput(30)), undefined);
	assert.deepEqual(registry.consume(delegationInput(31)), context);
	registry.dispose();
	registry.observe(observation('scope-a', 'call-d', delegationInput(33)));
	assert.equal(registry.size, 0);
	assert.equal(registry.consume(delegationInput(33)), undefined);
});

test('bounds each child scope before applying the global entry cap', () => {
	const registry = new DelegatedToolInvocationRegistry({
		entryLimit: 4,
		scopeEntryLimit: 2,
	});
	registry.observe(observation('scope-a', 'call-a', delegationInput(50)));
	registry.observe(observation('scope-b', 'call-b', delegationInput(51)));
	registry.observe(observation('scope-a', 'call-c', delegationInput(52)));
	registry.observe(observation('scope-a', 'call-d', delegationInput(53)));
	assert.equal(registry.size, 3);
	assert.equal(registry.consume(delegationInput(50)), undefined);
	assert.deepEqual(registry.consume(delegationInput(51)), context);
	assert.deepEqual(registry.consume(delegationInput(52)), context);
	assert.deepEqual(registry.consume(delegationInput(53)), context);
});

test('capacity pressure cannot evict a claimed child correlation', () => {
	const registry = new DelegatedToolInvocationRegistry({
		entryLimit: 2,
		scopeEntryLimit: 2,
	});
	const claimed = delegationInput(60);
	registry.observe(observation('scope-a', 'call-a', claimed));
	assert.deepEqual(registry.consume(claimed), context);
	registry.observe(observation('scope-a', 'call-b', delegationInput(61)));
	registry.observe(observation('scope-a', 'call-c', delegationInput(62)));
	assert.equal(registry.consume(delegationInput(61)), undefined);
	assert.deepEqual(registry.consume(delegationInput(62)), context);
	assert.deepEqual(registry.consume(claimed), context);

	registry.observe(observation('scope-b', 'call-d', delegationInput(63)));
	assert.deepEqual(registry.consume(delegationInput(62)), context);
	assert.deepEqual(registry.consume(claimed), context);
	assert.equal(registry.consume(delegationInput(63)), undefined);
	assert.equal(registry.size, 2);
});

test('claimed correlations survive their observation TTL until lifecycle cleanup', () => {
	let now = 1_000;
	const registry = new DelegatedToolInvocationRegistry({
		ttlMs: 10,
		now: () => now,
	});
	const input = delegationInput(64);
	registry.observe(observation('scope-a', 'call-a', input));
	assert.deepEqual(registry.consume(input), context);
	now += 10;
	assert.deepEqual(registry.consume(input), context);
	registry.forget('scope-a', 'call-a');
	assert.equal(registry.consume(input), undefined);
});

test('remote production adapter selects the delegated-child principal path', async () => {
	let ordinaryStarts = 0;
	let childStart: {
		readonly peerId: string;
		readonly context: DelegatedExecutionContext;
	} | undefined;
	const taskId = '00000000-0000-4000-8000-000000000040';
	const client = {
		startRemoteTask: async () => {
			ordinaryStarts += 1;
			return { taskId } as TaskSnapshot;
		},
		startRemoteTaskFromDelegatedChild: async (
			_input: RoutedTaskStartParams,
			peerId: string,
			childContext: DelegatedExecutionContext,
		) => {
			childStart = { peerId, context: childContext };
			return { taskId } as TaskSnapshot;
		},
	} as unknown as WindowNodeClient;
	const adapter = new LocalIpcRemoteTaskAdapter(client);
	await adapter.startTask({ taskId } as RoutedTaskStartParams, {
		peerId: '00000000-0000-4000-8000-000000000041',
		delegatedExecutionContext: context,
	});
	assert.equal(ordinaryStarts, 0);
	assert.deepEqual(childStart, {
		peerId: '00000000-0000-4000-8000-000000000041',
		context,
	});
});

function observation(
	scopeId: string,
	invocationId: string,
	input: ReturnType<typeof delegationInput>,
) {
	return {
		scopeId,
		invocationId,
		toolName: MESH_TOOL_NAMES.delegateTask,
		toolInput: JSON.stringify(input),
		context,
	};
}

function delegationInput(index: number) {
	const id = index.toString(16).padStart(12, '0');
	return {
		delegationRequestId: `00000000-0000-4000-8000-${id}`,
		deviceId: '00000000-0000-4000-8000-000000000002',
		nodeId: '00000000-0000-4000-8000-000000000003',
		nodeInstanceId: '00000000-0000-4000-8000-000000000004',
		workspaceId: '00000000-0000-4000-8000-000000000005',
		title: 'Correlated task',
		prompt: 'Perform the correlated task.',
		acceptanceCriteria: ['Done'],
		timeoutMinutes: 60,
	};
}
