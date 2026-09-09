import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveGoLicensePath } from './go-license.mjs';

test('resolves the standard Go distribution license', async (t) => {
	const { goroot } = await createGoRoot(t, 'go');
	const license = join(goroot, 'LICENSE');
	await writeFile(license, 'Go license fixture');
	assert.equal(resolveGoLicensePath(goroot), license);
});

test('resolves the Homebrew license next to libexec', async (t) => {
	const { root, goroot } = await createGoRoot(t, 'libexec');
	const license = join(root, 'LICENSE');
	await writeFile(license, 'Go license fixture');
	assert.equal(resolveGoLicensePath(goroot), license);
});

test('prefers GOROOT/LICENSE when both supported locations exist', async (t) => {
	const { root, goroot } = await createGoRoot(t, 'libexec');
	await writeFile(join(root, 'LICENSE'), 'Package license fixture');
	const license = join(goroot, 'LICENSE');
	await writeFile(license, 'Go license fixture');
	assert.equal(resolveGoLicensePath(goroot), license);
});

for (const layout of ['go', 'libexec']) {
	test(`reports a missing license in the ${layout} layout`, async (t) => {
		const { goroot } = await createGoRoot(t, layout);
		assert.throws(() => resolveGoLicensePath(goroot), /Go toolchain license was not found/u);
	});
}

test('does not substitute an unrelated parent license outside the Homebrew layout', async (t) => {
	const { root, goroot } = await createGoRoot(t, 'go');
	await writeFile(join(root, 'LICENSE'), 'Unrelated license fixture');
	assert.throws(() => resolveGoLicensePath(goroot), /Go toolchain license was not found/u);
});

test('does not hide an invalid GOROOT license with the Homebrew fallback', async (t) => {
	const { root, goroot } = await createGoRoot(t, 'libexec');
	await mkdir(join(goroot, 'LICENSE'));
	await writeFile(join(root, 'LICENSE'), 'Go license fixture');
	assert.throws(() => resolveGoLicensePath(goroot), /Go license .* is not a regular file/u);
});

async function createGoRoot(t, layout) {
	const root = await mkdtemp(join(tmpdir(), 'mesh-go-license-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const goroot = join(root, layout);
	await mkdir(goroot);
	return { root, goroot };
}
