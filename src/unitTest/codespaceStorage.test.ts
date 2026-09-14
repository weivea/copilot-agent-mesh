import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalCodespaceStorageBase } from '../codespaces/CodespaceStorage';

test('trusted VS Code storage aliases resolve before private runtime directories are appended', async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'mesh-codespaces-storage-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const actual = join(root, 'mounted-server-data');
	const alias = join(root, 'vscode-server');
	await mkdir(actual);
	await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
	const relative = ['User', 'globalStorage', 'mesh-companion'];
	const path = await canonicalCodespaceStorageBase(join(alias, ...relative));
	assert.equal(path, join(actual, ...relative));
	assert.equal(existsSync(path), false);
	assert.equal(existsSync(join(path, 'native-cli')), false);
	await assert.rejects(canonicalCodespaceStorageBase('relative-storage'), /absolute/u);
});
