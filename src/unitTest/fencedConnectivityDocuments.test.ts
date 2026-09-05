import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

import { FencedDocumentStore } from '../storage/FencedDocumentStore';
import { connectivityFixture } from './connectivityTestSupport';

const schema = z.strictObject({
	revision: z.number().int().nonnegative(),
	grants: z.array(z.string()),
});

test('a policy validation failure at the pre-rename checkpoint never persists a rejected grant', async (t) => {
	const f = connectivityFixture();
	t.after(() => f.account.dispose());
	const create = () => new FencedDocumentStore(f.files, 'peers/atomic-test.json', schema, { revision: 0, grants: [] }, f.fence);
	const store = create();
	await store.initialize();
	let claimLive = true;
	f.fs.syncFile = async () => { claimLive = false; };
	await assert.rejects(store.update((value) => ({ ...value, grants: ['peer'] }), async () => {
		if (!claimLive) { throw new Error('Claim lost before commit.'); }
	}));
	const restarted = create();
	await restarted.initialize();
	assert.deepEqual(restarted.snapshot().grants, []);
	assert.deepEqual(store.snapshot().grants, []);
});

test('a successfully committed grant is not retrospectively reported as rejected by a post-commit claim change', async (t) => {
	const f = connectivityFixture();
	t.after(() => f.account.dispose());
	const create = () => new FencedDocumentStore(f.files, 'peers/atomic-test.json', schema, { revision: 0, grants: [] }, f.fence);
	const store = create();
	await store.initialize();
	const rename = f.fs.rename.bind(f.fs);
	let claimLive = true;
	let validations = 0;
	f.fs.rename = async (from, to) => {
		await rename(from, to);
		claimLive = false;
	};
	const result = await store.update((value) => ({ ...value, grants: ['peer'] }), async () => {
		validations += 1;
		if (!claimLive) { throw new Error('Claim ended after commit.'); }
	});
	assert.equal(validations, 2);
	assert.deepEqual(result.grants, ['peer']);
	const restarted = create();
	await restarted.initialize();
	assert.deepEqual(restarted.snapshot(), result);
});
