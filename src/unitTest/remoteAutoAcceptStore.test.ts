import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RemotePeerPolicyStore } from '../broker/RemotePeerPolicyStore';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';
import { connectivityFixture } from './connectivityTestSupport';
import { uuid } from './artifactStoreTestSupport';

test('existing policy documents load with no automatically accepted peers and still reject ungranted approvals', async (t) => {
	const f = connectivityFixture();
	t.after(() => f.account.dispose());
	const identity = createOpaqueWorkspaceIdentity('old-remote-policy');
	await f.files.writeJson('peers/remote-policy.json', {
		schemaVersion: 1, revision: 2,
		entries: [{ workspaceIdentity: identity, allowlist: [], incomingPeerIds: [uuid(1)] }],
	});
	const store = new RemotePeerPolicyStore(f.files, f.fence);
	await store.initialize();
	assert.deepEqual(store.get(identity).autoAcceptPeerIds, []);
	await assert.rejects(store.update(identity, (entry) => ({
		...entry, autoAcceptPeerIds: [uuid(2)],
	}), async () => undefined));
	assert.deepEqual(store.get(identity).autoAcceptPeerIds, []);
});

test('multi-root allowlist changes are atomic when any source is at its policy limit', async (t) => {
	const f = connectivityFixture();
	t.after(() => f.account.dispose());
	const first = createOpaqueWorkspaceIdentity('first-source');
	const second = createOpaqueWorkspaceIdentity('second-source');
	const store = new RemotePeerPolicyStore(f.files, f.fence);
	await store.initialize();
	await store.update(second, (entry) => ({
		...entry,
		allowlist: Array.from({ length: 32 }, (_, index) => ({
			profileId: uuid(index + 1), profileGeneration: uuid(index + 1),
			workspaceIdentity: createOpaqueWorkspaceIdentity(`target-${index}`),
		})),
	}), async () => undefined);
	const target = { profileId: uuid(99), profileGeneration: uuid(99), workspaceIdentity: createOpaqueWorkspaceIdentity('new') };
	const revision = store.revision();
	await assert.rejects(store.updateMany([first, second], (entry) => ({
		...entry, allowlist: [...entry.allowlist, target],
	}), async () => undefined, revision));
	assert.deepEqual(store.get(first).allowlist, []);
	assert.equal(store.get(second).allowlist.length, 32);
	assert.equal(store.revision(), revision);
});

test('owner loss during the final asynchronous policy validation cannot persist automatic acceptance', async (t) => {
	const f = connectivityFixture();
	t.after(() => f.account.dispose());
	const identity = createOpaqueWorkspaceIdentity('owner-fenced-target');
	const store = new RemotePeerPolicyStore(f.files, f.fence);
	await store.initialize();
	await store.update(identity, (entry) => ({ ...entry, incomingPeerIds: [uuid(1)] }), async () => undefined);
	let validations = 0;
	await assert.rejects(store.update(identity, (entry) => ({ ...entry, autoAcceptPeerIds: [uuid(1)] }), async () => {
		if (++validations === 2) { f.ownership.owner = false; }
	}), { reason: 'WORKER_DRAINING' });
	f.ownership.owner = true;
	const restarted = new RemotePeerPolicyStore(f.files, f.fence);
	await restarted.initialize();
	assert.deepEqual(restarted.get(identity).autoAcceptPeerIds, []);
});
