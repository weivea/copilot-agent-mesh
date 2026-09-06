import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { AccountDeviceIdentityStore, readAccountPublicKey } from '../connectivity/AccountDeviceIdentity';
import { InMemorySecretStore } from '../gateway/SecretStore';
import { uuid } from './artifactStoreTestSupport';
import { connectivityFixture, TEST_ACCOUNT } from './connectivityTestSupport';

test('account device identity survives restart without exposing its private key in public storage', async (t) => {
	const f = connectivityFixture();
	t.after(() => f.account.dispose());
	const secrets = new InMemorySecretStore();
	const identity = new AccountDeviceIdentityStore(f.files, f.fence, secrets, uuid(900));
	await identity.initialize();
	const first = await identity.load(TEST_ACCOUNT);
	const privateValue = await secrets.get(`mesh.accountIdentity.${TEST_ACCOUNT.accountRef}`);
	assert.ok(privateValue);
	assert.ok(![...f.fs.files.values()].join('').includes(privateValue));
	const restored = new AccountDeviceIdentityStore(f.files, f.fence, secrets, uuid(900));
	await restored.initialize();
	assert.deepEqual(await restored.load(TEST_ACCOUNT), first);
	await secrets.delete(`mesh.accountIdentity.${TEST_ACCOUNT.accountRef}`);
	await assert.rejects(restored.load(TEST_ACCOUNT), { code: 'BINDING_CHANGED' });
});

test('both devices derive the same directional Mesh credential, independent of local account references and Tunnel addresses', async (t) => {
	const a = connectivityFixture();
	const b = connectivityFixture();
	t.after(() => { a.account.dispose(); b.account.dispose(); });
	const left = new AccountDeviceIdentityStore(a.files, a.fence, new InMemorySecretStore(), uuid(901));
	const right = new AccountDeviceIdentityStore(b.files, b.fence, new InMemorySecretStore(), uuid(902));
	await left.initialize();
	await right.initialize();
	const otherBinding = { ...TEST_ACCOUNT, accountRef: uuid(903) };
	const leftPublic = await left.load(TEST_ACCOUNT);
	const rightPublic = await right.load(otherBinding);
	assert.deepEqual(left.derive(TEST_ACCOUNT, rightPublic, false), right.derive(otherBinding, leftPublic, true));
	assert.deepEqual(left.derive(TEST_ACCOUNT, rightPublic, true), right.derive(otherBinding, leftPublic, false));
	assert.notEqual(left.derive(TEST_ACCOUNT, rightPublic, true).root, left.derive(TEST_ACCOUNT, rightPublic, false).root);
	assert.notEqual(left.derive(TEST_ACCOUNT, rightPublic, false).root,
		left.derive({ ...TEST_ACCOUNT, accountId: 'a-different-account' }, rightPublic, false).root);
	assert.throws(() => left.derive(TEST_ACCOUNT, leftPublic, false), { code: 'BINDING_CHANGED' });
});

test('identity keys are scoped to the chosen account and reject unsupported public key formats', async (t) => {
	const f = connectivityFixture();
	t.after(() => f.account.dispose());
	const store = new AccountDeviceIdentityStore(f.files, f.fence, new InMemorySecretStore(), uuid(904));
	await store.initialize();
	const first = await store.load(TEST_ACCOUNT);
	const next = await store.load({ ...TEST_ACCOUNT, accountRef: uuid(905), accountId: 'second-account' });
	assert.notEqual(first.publicKey, next.publicKey);
	assert.equal(store.current(TEST_ACCOUNT.accountRef), undefined);
	const ed = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
	assert.throws(() => readAccountPublicKey(ed), { code: 'INVALID_ENDPOINT' });
	assert.throws(() => readAccountPublicKey('not-a-key'), { code: 'INVALID_ENDPOINT' });
});

test('a stale Broker owner cannot create or load an account identity', async (t) => {
	const f = connectivityFixture();
	t.after(() => f.account.dispose());
	const secrets = new InMemorySecretStore();
	const identity = new AccountDeviceIdentityStore(f.files, f.fence, secrets, uuid(906));
	await identity.initialize();
	f.ownership.owner = false;
	await assert.rejects(identity.load(TEST_ACCOUNT));
	assert.equal(await secrets.get(`mesh.accountIdentity.${TEST_ACCOUNT.accountRef}`), undefined);
});
