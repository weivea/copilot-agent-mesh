import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runWindowsHarnessCommand } from './owned-processes.mjs';
import { prepareSentinel, sentinelExecutablePath } from './sentinel.mjs';

test('native Windows sentinel self-test resets the marker and observes later invocation', {
	skip: process.platform !== 'win32'
		|| !existsSync(resolve('dist', 'windows', `mesh-process-host-${process.arch}.exe`)),
}, async () => {
	const root = resolve('.vscode-test', `harness-sentinel-${randomUUID()}`);
	await mkdir(root, { recursive: true });
	try {
		const path = sentinelExecutablePath(root);
		const marker = join(root, 'devtunnel-invoked.json');
		assert.match(await prepareSentinel(path, marker), /^[a-f0-9]{64}$/u);
		assert.equal(existsSync(marker), false);
		const result = await runWindowsHarnessCommand(path, ['--version']);
		assert.equal(result.status, 97);
		assert.equal(JSON.parse(await readFile(marker, 'utf8')).invoked, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
