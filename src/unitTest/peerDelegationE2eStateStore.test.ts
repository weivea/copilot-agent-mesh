import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { StateStore } from '../domain/ports';
import { PeerDelegationE2eBindingRegistry } from '../e2e/PeerDelegationE2eBindingRegistry';
import { PeerDelegationE2eStateStore } from '../storage/PeerDelegationE2eStateStore';
import { deterministicTaskId } from '../tools/LocalBrokerTaskFacade';
import { TaskToolFacadeError } from '../tools/taskToolFacade';

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

test('binding registry survives recreation, retires terminal tasks, and fences stale runs', async (t) => {
	const root = await temporaryRegistryRoot(t);
	const oldRegistry = new PeerDelegationE2eBindingRegistry(root, RUN_A);
	const requestId = indexedUuid(1);
	const sourceScope = `sha256:${'A'.repeat(43)}`;
	const taskId = deterministicTaskId(requestId, sourceScope);
	const oldBinding = {
		delegationRequestId: requestId,
		sourceWorkspaceIdentity: sourceScope,
		taskId,
	};
	const oldReservation = await oldRegistry.reserve(oldBinding);
	await oldRegistry.finalizeReservation(oldBinding, oldReservation);

	const recreated = new PeerDelegationE2eBindingRegistry(
		root,
		RUN_A,
	);
	assert.equal(await recreated.resolve(requestId, sourceScope), taskId);
	assert.equal(await recreated.size(), 1);
	const newRun = new PeerDelegationE2eBindingRegistry(
		root,
		RUN_B,
	);
	await assert.rejects(
		newRun.resolve(requestId, sourceScope),
		(error: unknown) =>
			error instanceof TaskToolFacadeError
			&& error.code === 'DELEGATION_NOT_FOUND',
	);
	assert.equal(await newRun.size(), 0);
	const newRunRequestId = indexedUuid(2);
	await newRun.reserve({
		delegationRequestId: newRunRequestId,
		sourceWorkspaceIdentity: sourceScope,
		taskId: deterministicTaskId(newRunRequestId, sourceScope),
	});
	await oldRegistry.reserve({
		delegationRequestId: indexedUuid(3),
		sourceWorkspaceIdentity: sourceScope,
		taskId: deterministicTaskId(indexedUuid(3), sourceScope),
	});
	assert.equal(await newRun.size(), 1);
	assert.equal(await recreated.size(), 2);

	await recreated.retire(taskId);
	assert.equal(await recreated.size(), 1);
	await assert.rejects(
		recreated.resolve(requestId, sourceScope),
		(error: unknown) =>
			error instanceof TaskToolFacadeError
			&& error.code === 'DELEGATION_NOT_FOUND',
	);
});

test('binding registry serializes concurrent writers across recreated instances', async (t) => {
	const root = await temporaryRegistryRoot(t);
	const first = new PeerDelegationE2eBindingRegistry(root, RUN_A);
	const second = new PeerDelegationE2eBindingRegistry(root, RUN_A);
	await Promise.all([1, 2].map(async (index) => {
		const requestId = indexedUuid(index);
		await (index === 1 ? first : second).reserve({
			delegationRequestId: requestId,
			taskId: deterministicTaskId(requestId),
		});
	}));
	assert.equal(await first.size(), 2);
	assert.equal(await second.size(), 2);
});

test('pre-dispatch rollback cannot remove a binding adopted by a concurrent retry', async (t) => {
	const root = await temporaryRegistryRoot(t);
	const first = new PeerDelegationE2eBindingRegistry(root, RUN_A);
	const second = new PeerDelegationE2eBindingRegistry(root, RUN_A);
	const requestId = indexedUuid(1);
	const binding = {
		delegationRequestId: requestId,
		taskId: deterministicTaskId(requestId),
	};
	const firstReservation = await first.reserve(binding);
	const secondReservation = await second.reserve(binding);
	await first.retireReservation(binding, firstReservation);
	assert.equal(await first.size(), 1);
	await second.finalizeReservation(binding, secondReservation);
	await assert.rejects(
		first.resolve(requestId, `sha256:${'A'.repeat(43)}`),
		(error: unknown) =>
			error instanceof TaskToolFacadeError
			&& error.code === 'DELEGATION_NOT_FOUND',
	);
});

test('terminal retirement waits for an in-flight reservation to settle', async (t) => {
	const registry = new PeerDelegationE2eBindingRegistry(
		await temporaryRegistryRoot(t),
		RUN_A,
	);
	const requestId = indexedUuid(1);
	const sourceWorkspaceIdentity = `sha256:${'A'.repeat(43)}`;
	const binding = {
		delegationRequestId: requestId,
		sourceWorkspaceIdentity,
		taskId: deterministicTaskId(requestId, sourceWorkspaceIdentity),
	};
	const first = await registry.reserve(binding);
	await registry.finalizeReservation(binding, first);
	const retry = await registry.reserve(binding);
	await registry.retire(binding.taskId);
	assert.equal(await registry.size(), 1);
	await registry.finalizeReservation(binding, retry);
	assert.equal(await registry.size(), 0);
});

test('terminal retirement reclaims a reservation abandoned by a dead process', async (t) => {
	const root = await temporaryRegistryRoot(t);
	const requestId = indexedUuid(1);
	const sourceWorkspaceIdentity = `sha256:${'A'.repeat(43)}`;
	const modulePath = require.resolve('../e2e/PeerDelegationE2eBindingRegistry');
	const taskModulePath = require.resolve('../tools/LocalBrokerTaskFacade');
	const child = spawnSync(process.execPath, [
		'-e',
		`const { PeerDelegationE2eBindingRegistry } = require(process.argv[1]);
		const { deterministicTaskId } = require(process.argv[2]);
		const registry = new PeerDelegationE2eBindingRegistry(process.argv[3], process.argv[4]);
		const requestId = process.argv[5];
		const scope = process.argv[6];
		registry.reserve({
			delegationRequestId: requestId,
			sourceWorkspaceIdentity: scope,
			taskId: deterministicTaskId(requestId, scope),
		}).then(() => undefined, () => process.exitCode = 1);`,
		modulePath,
		taskModulePath,
		root,
		RUN_A,
		requestId,
		sourceWorkspaceIdentity,
	], { encoding: 'utf8' });
	assert.equal(child.status, 0, child.stderr);

	const registry = new PeerDelegationE2eBindingRegistry(root, RUN_A);
	const taskId = deterministicTaskId(requestId, sourceWorkspaceIdentity);
	assert.equal(await registry.size(), 1);
	await registry.retire(taskId);
	assert.equal(await registry.size(), 0);
});

test('binding registry recovers a lock abandoned by a dead extension host', async (t) => {
	const root = await temporaryRegistryRoot(t);
	const registry = new PeerDelegationE2eBindingRegistry(root, RUN_A);
	await registry.reserve({
		delegationRequestId: indexedUuid(1),
		taskId: deterministicTaskId(indexedUuid(1)),
	});
	const [registryRoot] = await readdir(join(root, 'manual-delegation-bindings-v1'));
	assert.ok(registryRoot);
	const lock = join(root, 'manual-delegation-bindings-v1', registryRoot, '.lock');
	await mkdir(lock);
	const deadOwner = spawnSync(process.execPath, ['-e', ''], {
		stdio: 'ignore',
	});
	assert.ok(deadOwner.pid !== undefined);
	await writeFile(
		join(lock, 'owner.json'),
		`${JSON.stringify({
			pid: deadOwner.pid,
			token: '00000000-0000-4000-8000-000000000099',
		})}\n`,
	);

	const recreated = new PeerDelegationE2eBindingRegistry(root, RUN_A);
	assert.deepEqual(
		await Promise.all([registry.size(), recreated.size()]),
		[1, 1],
	);
});

test('binding registry serializes the capacity boundary across instances', async (t) => {
	const root = await temporaryRegistryRoot(t);
	const first = new PeerDelegationE2eBindingRegistry(root, RUN_A);
	const second = new PeerDelegationE2eBindingRegistry(root, RUN_A);
	for (let index = 1; index <= 511; index += 1) {
		const requestId = indexedUuid(index);
		await first.reserve({
			delegationRequestId: requestId,
			taskId: deterministicTaskId(requestId),
		});
	}
	const attempts = await Promise.allSettled([512, 513].map(async (index) => {
		const requestId = indexedUuid(index);
		return (index === 512 ? first : second).reserve({
			delegationRequestId: requestId,
			taskId: deterministicTaskId(requestId),
		});
	}));
	assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
	assert.equal(attempts.filter(
		(result) =>
			result.status === 'rejected'
			&& result.reason instanceof TaskToolFacadeError
			&& result.reason.code === 'RATE_LIMITED',
	).length, 1);
	assert.equal(await first.size(), 512);
});

test('binding registry enforces capacity before accepting another task identity', async (t) => {
	const registry = new PeerDelegationE2eBindingRegistry(
		await temporaryRegistryRoot(t),
		RUN_A,
	);
	for (let index = 1; index <= 512; index += 1) {
		const requestId = indexedUuid(index);
		await registry.reserve({
			delegationRequestId: requestId,
			taskId: deterministicTaskId(requestId),
		});
	}
	await assert.rejects(
		registry.reserve({
			delegationRequestId: indexedUuid(513),
			taskId: deterministicTaskId(indexedUuid(513)),
		}),
		(error: unknown) =>
			error instanceof TaskToolFacadeError
			&& error.code === 'RATE_LIMITED',
	);
	assert.equal(await registry.size(), 512);
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

function indexedUuid(index: number): string {
	return `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

async function temporaryRegistryRoot(t: { after(cleanup: () => Promise<void>): void }): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'mesh-e2e-bindings-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
