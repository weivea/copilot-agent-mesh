import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CodespaceLibcDetectionError, CodespaceSystemLibc } from '../codespaces/CodespaceSystemLibc';
import { OwnedCommandError } from '../spikes/ownedProcess';

test('system libc detection uses a fixed bounded command and caches only validated results', async (t) => {
	let reports = 0;
	if (process.report !== undefined) {
		t.mock.method(process.report, 'getReport', () => { reports += 1; return {}; });
	}
	let calls = 0;
	const signal = new AbortController().signal;
	const probe = new CodespaceSystemLibc(async (executable, args, options) => {
		calls += 1;
		assert.equal(executable, '/usr/bin/getconf');
		assert.deepEqual(args, ['GNU_LIBC_VERSION']);
		assert.equal(options.timeoutMs, 3_000);
		assert.equal(options.maxOutputBytes, 1_024);
		assert.equal(options.signal, signal);
		return 'glibc 2.36\n';
	});
	assert.equal(calls, 0);
	assert.equal(await probe.glibcVersionRuntime(signal), '2.36');
	assert.equal(await probe.glibcVersionRuntime(signal), '2.36');
	assert.equal(calls, 1);
	assert.equal(reports, 0, 'A missing or restricted Node report cannot misclassify the container.');
});

test('unknown or malformed libc output remains an explicit detection failure and can be retried', async () => {
	for (const output of ['', 'musl libc 1.2.5', 'glibc unknown', 'glibc 2.36\nunexpected output', '2.36']) {
		let calls = 0;
		const probe = new CodespaceSystemLibc(async () => ++calls === 1 ? output : 'glibc 2.39');
		await assert.rejects(probe.glibcVersionRuntime(), CodespaceLibcDetectionError);
		assert.equal(await probe.glibcVersionRuntime(), '2.39');
		assert.equal(calls, 2);
	}
});

test('libc probing propagates cancellation without accepting or caching output', async () => {
	const controller = new AbortController();
	let calls = 0;
	const probe = new CodespaceSystemLibc(async (_executable, _args, { signal }) => {
		calls += 1;
		assert.equal(signal, controller.signal);
		controller.abort();
		return 'glibc 2.36';
	});
	await assert.rejects(probe.glibcVersionRuntime(controller.signal), { name: 'AbortError' });
	await assert.rejects(probe.glibcVersionRuntime(controller.signal), { name: 'AbortError' });
	assert.equal(calls, 1);
});

test('a failed libc command is sanitized and its exact owned cleanup is awaited', async () => {
	let cleaned = 0;
	const failure = new OwnedCommandError('Unexpected subprocess diagnostic.', undefined, true, {
		dispose: async () => { cleaned += 1; },
	});
	const probe = new CodespaceSystemLibc(async () => { throw failure; });
	await assert.rejects(probe.glibcVersionRuntime(), (error: unknown) => {
		assert.ok(error instanceof CodespaceLibcDetectionError);
		assert.doesNotMatch(error.message, /Unexpected subprocess/u);
		assert.equal(error.cause, failure);
		return true;
	});
	assert.equal(cleaned, 1);
});

test('libc probe cleanup failures remain visible even if the caller cancelled', async () => {
	const controller = new AbortController();
	const cleanup = new Error('Owned cleanup failed.');
	const probe = new CodespaceSystemLibc(async () => {
		controller.abort();
		throw new OwnedCommandError('Cancelled.', 123, true);
	}, async (pid) => {
		assert.equal(pid, 123);
		throw cleanup;
	});
	await assert.rejects(probe.glibcVersionRuntime(controller.signal), (error: unknown) => {
		assert.ok(error instanceof AggregateError);
		assert.ok(error.errors.includes(cleanup));
		return true;
	});
});

test('system libc detection works on a real supported Linux host', { skip: process.platform !== 'linux' }, async () => {
	assert.match(await new CodespaceSystemLibc().glibcVersionRuntime(), /^\d+\.\d+(?:\.\d+)?$/u);
});
