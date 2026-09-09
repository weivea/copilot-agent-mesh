import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { disposeHarnessProcesses, HarnessProcesses, runWindowsHarnessCommand } from './owned-processes.mjs';

const helper = resolve('dist', 'windows', `mesh-process-host-${process.arch}.exe`);
const nativeSkip = process.platform !== 'win32'
	? 'Windows Job Object harness adapter.'
	: !existsSync(helper) ? 'Packaged native helper has not been built yet.' : false;

test('cancelled harness cannot launch a process after cleanup starts', async () => {
	const processes = new HarnessProcesses();
	await processes.disposeWindows({ stopLaunching: true });
	await assert.rejects(processes.launch(process.execPath, ['--version']), /cancelled/u);
});

test('unconfirmed command cleanup retains a retryable owner and the original failure', async () => {
	const original = new Error('command timed out');
	const cleanup = new Error('native cleanup temporarily unavailable');
	let attempts = 0;
	const processes = {
		disposeWindows: async () => {
			if (++attempts === 1) {
				throw cleanup;
			}
		},
	};
	let failure;
	try {
		await disposeHarnessProcesses(processes, original);
		assert.fail('Unconfirmed cleanup must reject.');
	} catch (error) {
		failure = error;
	}
	assert.deepEqual(failure.errors, [original, cleanup]);
	assert.equal(failure.cleanupRequired, true);
	assert.equal(Object.keys(failure).includes('ownedCleanup'), false);
	await failure.ownedCleanup.dispose();
	assert.equal(attempts, 2);
});

test('Windows harness adapter owns only kernel-confirmed job membership and releases it', {
	skip: nativeSkip,
}, async () => {
	const processes = new HarnessProcesses();
	try {
		const child = await processes.launch(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
		assert.equal(Number.isSafeInteger(child.pid), true);
		const owned = await processes.ownedWindowsProcesses(() => { throw new Error('POSIX metadata must not be used.'); });
		assert.equal(owned.some(({ pid }) => pid === child.pid), true);
		assert.equal(owned.some(({ pid }) => pid === process.pid), false);
	} finally {
		await processes.disposeWindows({ stopLaunching: true });
	}
	assert.deepEqual(await processes.ownedWindowsProcesses(() => []), []);
});

test('Windows CLI adapter preserves quoted paths and nonzero exit status without cmd.exe', {
	skip: nativeSkip,
}, async () => {
	const argument = join(process.cwd(), 'spaces & %PATH% ! "literal"');
	const result = await runWindowsHarnessCommand(process.execPath, [
		'-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exitCode=2;', argument,
	], { maxOutputBytes: 1_024 });
	assert.equal(result.status, 2);
	assert.deepEqual(JSON.parse(result.stdout), [argument]);
});

test('Windows command deadline releases its job before rejection', {
	skip: nativeSkip,
}, async () => {
	await assert.rejects(runWindowsHarnessCommand(process.execPath, [
		'-e', 'setInterval(() => {}, 1000)',
	], { timeoutMs: 30, maxOutputBytes: 1_024 }), /timed out/u);
});
