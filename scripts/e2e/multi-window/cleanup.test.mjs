import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ipcEndpointAbsent, releaseOwnedProfileLock, waitForIpcEndpointAbsent } from './platform.mjs';

test('IPC cleanup tolerates delayed disappearance instead of accepting an immediate live pipe', async () => {
	let time = 0;
	let probes = 0;
	assert.equal(await waitForIpcEndpointAbsent({ platform: 'win32', address: 'test-only' }, {
		now: () => time,
		delay: async (ms) => { time += ms; },
		probe: async () => ++probes === 3,
		timeoutMs: 500,
	}), true);
	assert.equal(probes, 3);
	assert.equal(time, 200);
});

test('IPC cleanup is bounded and retains the final observation failure', async () => {
	let time = 0;
	const failure = new Error('pipe access could not be verified');
	await assert.rejects(waitForIpcEndpointAbsent({}, {
		now: () => time,
		delay: async (ms) => { time += ms; },
		probe: async () => { throw failure; },
		timeoutMs: 250,
	}), (error) => error.cause === failure && /cleanup deadline/u.test(error.message));
	assert.equal(time, 250);
	await assert.rejects(waitForIpcEndpointAbsent({}, { timeoutMs: 0 }));
});

test('a real Windows pipe can disappear after the first cleanup observation', {
	skip: process.platform !== 'win32',
}, async () => {
	const endpoint = { platform: 'win32', address: `\\\\.\\pipe\\mesh-delayed-cleanup-${randomUUID()}` };
	const server = createServer((client) => client.destroy());
	let firstLive = false;
	let closing;
	try {
		await new Promise((resolveListen, reject) => {
			server.once('error', reject);
			server.listen(endpoint.address, resolveListen);
		});
		await waitForIpcEndpointAbsent(endpoint, {
			timeoutMs: 2_000,
			probe: async (...args) => {
				const absent = await ipcEndpointAbsent(...args);
				if (!absent && !firstLive) {
					firstLive = true;
					closing = new Promise((resolveClose, reject) => setTimeout(() =>
						server.close((error) => error ? reject(error) : resolveClose()), 25));
				}
				return absent;
			},
		});
		assert.equal(firstLive, true);
		await closing;
	} finally {
		if (server.listening && closing === undefined) {
			await new Promise((resolveClose) => server.close(resolveClose));
		}
		await closing;
	}
});

async function lockFixture(operation) {
	const root = resolve('.vscode-test', `profile-lock-cleanup-${randomUUID()}`);
	const lockDirectory = join(root, '.copilot-agent-mesh-e2e-lock');
	const ownerPath = join(lockDirectory, 'owner');
	const expectedRunId = randomUUID();
	await mkdir(lockDirectory, { recursive: true });
	await writeFile(ownerPath, `${expectedRunId}\n`);
	try {
		await operation({ root, lockDirectory, ownerPath, expectedRunId });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('the exact stale harness lock can be released after quiescence is proven', async () => {
	await lockFixture(async (fixture) => {
		let checked = false;
		assert.equal(await releaseOwnedProfileLock({
			...fixture,
			assertQuiescent: async () => { checked = true; },
		}), true);
		assert.equal(checked, true);
		await assert.rejects(access(fixture.lockDirectory), { code: 'ENOENT' });
	});
});

test('live or unconfirmed IPC prevents lock recovery without changing its owner', async () => {
	await lockFixture(async (fixture) => {
		await assert.rejects(releaseOwnedProfileLock({
			...fixture,
			assertQuiescent: async () => { throw new Error('owned pipe remains live'); },
		}), /pipe remains live/u);
		assert.equal((await readFile(fixture.ownerPath, 'utf8')).trim(), fixture.expectedRunId);
	});
});

test('a foreign or concurrently changed lock is never released', async () => {
	await lockFixture(async (fixture) => {
		await assert.rejects(releaseOwnedProfileLock({
			...fixture,
			expectedRunId: randomUUID(),
			assertQuiescent: async () => assert.fail('Foreign lock must reject before inspection.'),
		}), /ownership changed/u);
		const newOwner = randomUUID();
		await assert.rejects(releaseOwnedProfileLock({
			...fixture,
			assertQuiescent: async () => writeFile(fixture.ownerPath, `${newOwner}\n`),
		}), /ownership changed/u);
		assert.equal((await readFile(fixture.ownerPath, 'utf8')).trim(), newOwner);
	});
});

test('lock recovery retains unexpected files and rejects junction aliases', async () => {
	await lockFixture(async (fixture) => {
		const extra = join(fixture.lockDirectory, 'keep.txt');
		await writeFile(extra, 'must remain');
		await assert.rejects(releaseOwnedProfileLock({
			...fixture, assertQuiescent: async () => {},
		}), /unexpected files/u);
		assert.equal(await readFile(extra, 'utf8'), 'must remain');
		const parent = join(fixture.root, 'alias-parent');
		await symlink(fixture.root, parent, process.platform === 'win32' ? 'junction' : 'dir');
		await assert.rejects(releaseOwnedProfileLock({
			...fixture,
			lockDirectory: join(parent, '.copilot-agent-mesh-e2e-lock'),
			assertQuiescent: async () => {},
		}), /aliases/u);
	});
});

test('cleanup phases wait for process/IPC release, preserve topology lookup and collect failed-runtime diagnostics', async () => {
	const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
	const cleanup = source.slice(source.indexOf('async function performCleanup'), source.indexOf('async function prepareRun'));
	assert.ok(cleanup.indexOf("name: 'owned-processes'") < cleanup.indexOf("name: 'wait-local-ipc'"));
	assert.ok(cleanup.indexOf("name: 'wait-local-ipc'") < cleanup.indexOf("name: 'release-profile-lock'"));
	assert.ok(cleanup.indexOf("name: 'release-profile-lock'") < cleanup.indexOf("name: 'remove-run-root'"));
	assert.match(cleanup, /runCleanupPhases/u);
	assert.match(cleanup, /failures: failures\.map/u);
	assert.match(source, /'directory\.dashboard'/u);
	const diagnostic = source.slice(source.indexOf('async function runDiagnosticTask'), source.indexOf('async function runProductionTask'));
	assert.ok(diagnostic.indexOf("'runtime.diagnostics'") < diagnostic.indexOf("assert.equal(latest.snapshot.status, 'completed'"));
	assert.match(diagnostic, /diagnosticsUnavailable: true/u);
});
