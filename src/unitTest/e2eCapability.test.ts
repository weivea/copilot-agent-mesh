import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as vscode from 'vscode';

import {
	E2eCapability,
	isE2eCapabilityEnabled,
} from '../composition/E2eCapability';
import { createTwoDeviceE2eApi } from '../composition/TwoDeviceE2eApi';
import {
	VscodeLocalTaskApproval,
	VscodeWindowNodeTaskConfirmation,
} from '../composition/VscodeAgentRuntime';

const nonce = '00000000-0000-4000-8000-000000000001';

test('production mode rejects the E2E capability even with matching environment and profile values', async () => {
	const capability = E2eCapability.create({
		mode: 'production',
		environmentEnabled: true,
		environmentNonce: nonce,
		environmentRole: 'worker',
		profileNonce: nonce,
		profileRole: 'worker',
	});
	assert.equal(isE2eCapabilityEnabled(capability), false);
	assert.equal(Object.isFrozen(capability), true);
	assert.equal(isE2eCapabilityEnabled(E2eCapability.prototype), false);
	assert.throws(() => capability.assertRequest(nonce, 'worker'), /rejected/u);
	assert.equal(
		createTwoDeviceE2eApi(
			{
				vscodeApi: undefined as never,
				bindings: undefined as never,
				node: undefined as never,
				localTasks: undefined as never,
				remoteTasks: undefined as never,
				runtime: undefined as never,
				lifecycle: undefined as never,
				ownerRuntime: () => undefined,
				capability,
			},
		),
		undefined,
	);

	let prompts = 0;
	const vscodeApi = {
		window: {
			showWarningMessage: async () => {
				prompts += 1;
				return 'Run Once';
			},
		},
	} as unknown as typeof vscode;
	const approval = new VscodeLocalTaskApproval(vscodeApi, new MemoryState(), capability);
	assert.equal(await approval.confirm({
		taskId: '00000000-0000-4000-8000-000000000002',
		title: 'Production approval',
		prompt: 'Do not bypass this prompt.',
		workspaceId: '00000000-0000-4000-8000-000000000003',
		workspace: {
			workspaceId: '00000000-0000-4000-8000-000000000003',
			displayName: 'Workspace',
			uri: 'file:///workspace',
		},
	}), 'once');
	assert.equal(prompts, 1);
});

test('development mode rejects wrong nonce or role and authorizes only the matching harness request', async () => {
	const wrongNonce = E2eCapability.create({
		mode: 'development',
		environmentEnabled: true,
		environmentNonce: nonce,
		environmentRole: 'worker',
		profileNonce: '00000000-0000-4000-8000-000000000004',
		profileRole: 'worker',
	});
	const wrongRole = E2eCapability.create({
		mode: 'development',
		environmentEnabled: true,
		environmentNonce: nonce,
		environmentRole: 'worker',
		profileNonce: nonce,
		profileRole: 'coordinator',
	});
	assert.equal(isE2eCapabilityEnabled(wrongNonce), false);
	assert.equal(isE2eCapabilityEnabled(wrongRole), false);

	const capability = E2eCapability.create({
		mode: 'development',
		environmentEnabled: true,
		environmentNonce: nonce,
		environmentRole: 'worker',
		profileNonce: nonce,
		profileRole: 'worker',
	});
	assert.equal(isE2eCapabilityEnabled(capability), true);
	capability.assertRequest(nonce, 'worker');
	assert.throws(
		() => capability.assertRequest('00000000-0000-4000-8000-000000000004', 'worker'),
		/rejected/u,
	);
	assert.throws(() => capability.assertRequest(nonce, 'coordinator'), /rejected/u);

	const api = createTwoDeviceE2eApi(
		{
			vscodeApi: undefined as never,
			bindings: undefined as never,
			node: undefined as never,
			localTasks: undefined as never,
			remoteTasks: undefined as never,
			runtime: undefined as never,
			lifecycle: undefined as never,
			ownerRuntime: () => undefined,
			capability,
		},
	);
	assert.ok(api);
	api.authorize({ nonce, role: 'worker' });
	assert.throws(
		() => api.authorize({ nonce, role: 'coordinator' }),
		/rejected/u,
	);
	await assert.rejects(
		api.execute(
			{ nonce: '00000000-0000-4000-8000-000000000004', role: 'worker' },
			'snapshot',
		),
		/rejected/u,
	);

	let prompts = 0;
	const confirmation = new VscodeWindowNodeTaskConfirmation({
		window: {
			showWarningMessage: async () => {
				prompts += 1;
				return 'Run Once';
			},
		},
	} as unknown as typeof vscode, capability);
	assert.equal(await confirmation.confirm({
		sourceWindowLabel: 'repo-a',
		targetWindowLabel: 'repo-b',
		workspaceDisplayName: 'repo-b',
		taskTitle: 'Gated real task',
		prompt: 'Use the production runtime.',
	}), 'once');
	assert.equal(prompts, 0);
});

class MemoryState {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}
