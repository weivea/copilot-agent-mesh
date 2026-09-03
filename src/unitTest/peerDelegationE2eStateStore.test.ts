import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StateStore } from '../domain/ports';
import { PeerDelegationE2eStateStore } from '../storage/PeerDelegationE2eStateStore';

const RUN_A = '00000000-0000-4000-8000-000000000001';
const RUN_B = '00000000-0000-4000-8000-000000000002';
const CATALOG_KEY = 'copilotAgentMesh.workspaceCatalog';
const ROUTES_KEY = 'copilotAgentMesh.taskRouteCatalog.v1';

test('same-run stores share fixed envelopes without reading production metadata', async () => {
	const persistentCatalog = { schemaVersion: 2, workspaces: Array.from({ length: 32 }) };
	const persistentRoutes = { schemaVersion: 1, routes: [{ taskId: 'production-task' }] };
	const state = new MemoryState({
		[CATALOG_KEY]: persistentCatalog,
		[ROUTES_KEY]: persistentRoutes,
	});
	const source = new PeerDelegationE2eStateStore(state, RUN_A);
	const target = new PeerDelegationE2eStateStore(state, RUN_A);

	assert.equal(source.get(CATALOG_KEY), undefined);
	assert.equal(target.get(ROUTES_KEY), undefined);
	await source.update(CATALOG_KEY, { schemaVersion: 2, workspaces: ['source'] });
	await target.update(ROUTES_KEY, { schemaVersion: 1, routes: ['target'] });

	assert.deepEqual(target.get(CATALOG_KEY), {
		schemaVersion: 2,
		workspaces: ['source'],
	});
	assert.deepEqual(source.get(ROUTES_KEY), {
		schemaVersion: 1,
		routes: ['target'],
	});
	assert.deepEqual(state.get(CATALOG_KEY), persistentCatalog);
	assert.deepEqual(state.get(ROUTES_KEY), persistentRoutes);
	assert.equal(scopedKeys(state).length, 2);
	assert.ok(scopedKeys(state).every((key) => !key.includes(RUN_A)));
});

test('a new run ignores old envelopes and overwrites the same fixed keys', async () => {
	const state = new MemoryState();
	const oldRun = new PeerDelegationE2eStateStore(state, RUN_A);
	await oldRun.update(CATALOG_KEY, { schemaVersion: 2, workspaces: ['old'] });
	await oldRun.update(ROUTES_KEY, { schemaVersion: 1, routes: ['old'] });
	const keysBefore = scopedKeys(state);

	const newRun = new PeerDelegationE2eStateStore(state, RUN_B);
	assert.equal(newRun.get(CATALOG_KEY), undefined);
	assert.equal(newRun.get(ROUTES_KEY), undefined);
	await newRun.update(CATALOG_KEY, { schemaVersion: 2, workspaces: ['new'] });
	await newRun.update(ROUTES_KEY, { schemaVersion: 1, routes: ['new'] });

	assert.deepEqual(scopedKeys(state), keysBefore);
	assert.deepEqual(newRun.get(CATALOG_KEY), {
		schemaVersion: 2,
		workspaces: ['new'],
	});
	assert.equal(oldRun.get(CATALOG_KEY), undefined);
});

test('malformed and mismatched envelopes fail closed', async () => {
	const state = new MemoryState();
	const run = new PeerDelegationE2eStateStore(state, RUN_A);
	await run.update(CATALOG_KEY, { schemaVersion: 2, workspaces: [] });
	const [key] = scopedKeys(state);
	const valid = state.get<Record<string, unknown>>(key)!;

	for (const invalid of [
		{ ...valid, schemaVersion: 2 },
		{ ...valid, scenario: 'production' },
		{ ...valid, logicalKey: ROUTES_KEY },
		{ ...valid, runNonce: RUN_B },
		{ ...valid, extra: true },
	]) {
		state.values.set(key, invalid);
		assert.equal(run.get(CATALOG_KEY), undefined);
	}
	assert.throws(
		() => new PeerDelegationE2eStateStore(state, 'not-a-nonce'),
		/UUID v4/u,
	);
});

class MemoryState implements StateStore {
	public readonly values = new Map<string, unknown>();

	public constructor(initial: Readonly<Record<string, unknown>> = {}) {
		for (const [key, value] of Object.entries(initial)) {
			this.values.set(key, structuredClone(value));
		}
	}

	public get<T>(key: string): T | undefined {
		return structuredClone(this.values.get(key)) as T | undefined;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, structuredClone(value));
	}
}

function scopedKeys(state: MemoryState): readonly string[] {
	return [...state.values.keys()]
		.filter((key) => key.startsWith('copilotAgentMesh.peerDelegationE2eState.v1.'))
		.sort();
}
