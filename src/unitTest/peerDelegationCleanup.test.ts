import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { runPeerDelegationCleanupPhases } from '../e2e/PeerDelegationCleanup';

test('cleanup phases continue through every injected observation and release failure', async () => {
	const attempted: string[] = [];
	const failures = await runPeerDelegationCleanupPhases([
		failing('process-table', attempted),
		failing('timeout', attempted),
		failing('sentinel-read', attempted),
		failing('log-close', attempted),
		failing('lock-mismatch', attempted),
		{
			name: 'run-root-remove',
			run: async () => {
				attempted.push('run-root-remove');
			},
		},
	]);
	assert.deepEqual(attempted, [
		'process-table',
		'timeout',
		'sentinel-read',
		'log-close',
		'lock-mismatch',
		'run-root-remove',
	]);
	assert.deepEqual(failures.map(({ phase }) => phase), attempted.slice(0, 5));
});

for (const [signal, expectedExitCode] of [
	['SIGINT', 130],
	['SIGTERM', 143],
] as const) {
	test(`signal cleanup removes only owned fixtures for ${signal}`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'mesh-peer-signal-'));
		const fixture = spawn(
			process.execPath,
			[
				resolve('scripts/e2e/peer-delegation/signal-cleanup-fixture.mjs'),
				root,
			],
			{ cwd: resolve('.'), shell: false, stdio: 'ignore' },
		);
		let childPid: number | undefined;
		try {
			const ready = await waitForReady(join(root, 'ready.json'));
			childPid = ready.childPid;
			fixture.kill(signal);
			const exit = await new Promise<number | null>((resolveExit, reject) => {
				fixture.once('error', reject);
				fixture.once('exit', resolveExit);
			});
			assert.equal(exit, expectedExitCode);
			await assert.rejects(access(join(root, 'run')), { code: 'ENOENT' });
			await assert.rejects(access(join(root, 'lock')), { code: 'ENOENT' });
			assert.equal(processAlive(childPid), false);
		} finally {
			if (fixture.exitCode === null && fixture.signalCode === null) {
				fixture.kill('SIGTERM');
				await waitForExit(fixture, 2_000);
			}
			if (childPid !== undefined && processAlive(childPid)) {
				process.kill(childPid, 'SIGTERM');
				await waitForProcessExit(childPid, 2_000);
				if (processAlive(childPid)) {
					process.kill(childPid, 'SIGKILL');
				}
			}
			await rm(root, { recursive: true, force: true });
		}
	});
}

function failing(name: string, attempted: string[]) {
	return {
		name,
		run: async () => {
			attempted.push(name);
			throw new Error(`${name} failed`);
		},
	};
}

async function waitForReady(path: string): Promise<{ readonly childPid: number }> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const value = JSON.parse(await readFile(path, 'utf8')) as {
				readonly childPid?: unknown;
			};
			if (typeof value.childPid === 'number' && Number.isSafeInteger(value.childPid)) {
				return { childPid: value.childPid };
			}
		} catch {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		}
	}
	throw new Error('Timed out waiting for the signal cleanup fixture.');
}

async function waitForExit(
	child: ReturnType<typeof spawn>,
	timeoutMs: number,
): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await Promise.race([
		new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
		new Promise<void>((resolveDelay) => setTimeout(resolveDelay, timeoutMs)),
	]);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && processAlive(pid)) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return typeof error === 'object'
			&& error !== null
			&& 'code' in error
			&& error.code === 'EPERM';
	}
}
