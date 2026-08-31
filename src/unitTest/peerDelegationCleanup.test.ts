import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { runPeerDelegationCleanupPhases } from '../e2e/PeerDelegationCleanup';
import {
	parsePeerDelegationEvidenceArtifact,
} from '../e2e/PeerDelegationEvidence';
import {
	PeerDelegationProcessTracker,
} from '../e2e/PeerDelegationProcessTracker';
import {
	parseProcessTable,
} from '../e2e/MultiWindowE2eSupport';

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
	test(
		`signal cleanup removes only owned fixtures for ${signal}`,
		{ skip: process.platform === 'win32' ? 'POSIX signal cleanup is a macOS/Linux harness boundary.' : false },
		async () => {
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
		},
	);
}

for (const scenario of ['lock-conflict', 'idle-conflict'] as const) {
	test(
		`persistent profile ${scenario} never kills a foreign profile process`,
		{ skip: process.platform === 'win32' ? 'POSIX process ownership is the supported real harness boundary.' : false },
		async () => {
			const fixture = await persistentProfileFixture(scenario);
			try {
				const result = await fixture.run();
				assert.notEqual(result.exitCode, 0);
				assert.equal(processAlive(fixture.foreignPid), true);
				await assert.rejects(access(fixture.terminationLog), { code: 'ENOENT' });
				assert.deepEqual(await peerRunDirectories(fixture.runtimeRoot), []);
				const artifact = parsePeerDelegationEvidenceArtifact(
					JSON.parse(await readFile(fixture.evidencePath, 'utf8')),
				);
				assert.equal(artifact.outcome, 'fail');
				assert.ok(artifact.failure);
				assert.equal(
					artifact.failure.code,
					scenario === 'lock-conflict' ? 'PROFILE_LOCKED' : 'PROFILE_IN_USE',
					result.stderr,
				);
				if (scenario === 'lock-conflict') {
					assert.equal(await readFile(fixture.lockOwnerPath, 'utf8'), 'foreign-winner\n');
				} else {
					await assert.rejects(access(fixture.lockRoot), { code: 'ENOENT' });
				}
			} finally {
				await fixture.dispose();
			}
		},
	);
}

for (const injection of ['schema', 'safety'] as const) {
	test(
		`invalid ${injection} evidence leaves a separately valid diagnostic artifact`,
		{ skip: process.platform === 'win32' ? 'POSIX process ownership is the supported real harness boundary.' : false },
		async () => {
			const fixture = await persistentProfileFixture('idle-conflict', injection);
			try {
				const result = await fixture.run();
				assert.notEqual(result.exitCode, 0);
				assert.equal(processAlive(fixture.foreignPid), true);
				await assert.rejects(access(fixture.terminationLog), { code: 'ENOENT' });
				assert.deepEqual(await peerRunDirectories(fixture.runtimeRoot), []);
				const artifact = parsePeerDelegationEvidenceArtifact(
					JSON.parse(await readFile(fixture.evidencePath, 'utf8')),
				);
				assert.ok('kind' in artifact);
				assert.equal(artifact.kind, 'diagnostic');
				assert.equal(artifact.outcome, 'fail');
				assert.equal(artifact.failure.code, 'PROFILE_IN_USE');
				assert.equal(artifact.validation.code, 'EVIDENCE_VALIDATION_FAILED');
			} finally {
				await fixture.dispose();
			}
		},
	);
}

test(
	'run-scoped marker captures a detached child after its parent exits before sampling',
	{ skip: process.platform === 'win32' ? 'POSIX process ownership is the supported real harness boundary.' : false },
	async () => {
		const parent = resolve('.vscode-test', 'peer-process-ownership');
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, 'immediate-detached-'));
		const readyPath = join(root, 'ready.json');
		const marker = join(root, 'control', 'agent-host');
		await mkdir(marker, { recursive: true });
		const fixture = spawn(
			process.execPath,
			[
				'-e',
				[
					'const { spawn } = require("node:child_process");',
					'const { renameSync, writeFileSync } = require("node:fs");',
					'const ready = process.argv[1];',
					'const marker = process.argv[2];',
					'const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)", "--", "--user-data-dir", marker], { detached: true, stdio: "ignore" });',
					'child.unref();',
					'writeFileSync(`${ready}.tmp`, `${JSON.stringify({ childPid: child.pid })}\\n`);',
					'renameSync(`${ready}.tmp`, ready);',
				].join(''),
				readyPath,
				marker,
			],
			{ shell: false, stdio: 'ignore' },
		);
		let detachedPid: number | undefined;
		try {
			detachedPid = (await waitForReady(readyPath)).childPid;
			await waitForExit(fixture, 2_000);
			const tracker = new PeerDelegationProcessTracker({
				rootPids: new Set(),
				markers: [marker],
				selfPid: process.pid,
			});
			const detached = await waitForTrackedProcess(tracker, detachedPid);
			assert.equal(detached.command.includes(marker), true);
			process.kill(detachedPid, 'SIGTERM');
			await waitForProcessExit(detachedPid, 2_000);
			assert.equal(processAlive(detachedPid), false);
		} finally {
			if (fixture.exitCode === null && fixture.signalCode === null) {
				fixture.kill('SIGTERM');
				await waitForExit(fixture, 2_000);
			}
			if (detachedPid !== undefined && processAlive(detachedPid)) {
				process.kill(detachedPid, 'SIGTERM');
				await waitForProcessExit(detachedPid, 2_000);
				if (processAlive(detachedPid)) {
					process.kill(detachedPid, 'SIGKILL');
				}
			}
			await rm(root, { recursive: true, force: true });
		}
	},
);

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

async function persistentProfileFixture(
	scenario: 'lock-conflict' | 'idle-conflict',
	injection?: 'schema' | 'safety',
) {
	const parent = resolve('.vscode-test', 'peer-process-ownership');
	await mkdir(parent, { recursive: true });
	const root = await mkdtemp(join(parent, `${scenario}-`));
	const runtimeRoot = join(root, 'runtime');
	const profileRoot = join(root, 'profile');
	const userData = join(profileRoot, 'user-data');
	const evidenceRoot = join(root, 'evidence');
	const evidencePath = join(evidenceRoot, 'evidence.json');
	const lockRoot = join(profileRoot, '.copilot-agent-mesh-peer-e2e-lock');
	const lockOwnerPath = join(lockRoot, 'owner');
	const terminationLog = join(root, 'terminations.log');
	await Promise.all([
		mkdir(runtimeRoot, { recursive: true }),
		mkdir(userData, { recursive: true }),
		mkdir(evidenceRoot, { recursive: true }),
	]);
	if (scenario === 'lock-conflict') {
		await mkdir(lockRoot);
		await writeFile(lockOwnerPath, 'foreign-winner\n', {
			encoding: 'utf8',
			mode: 0o600,
		});
	}
	const foreign = spawn(
		process.execPath,
		[
			'-e',
			'setInterval(() => undefined, 1000)',
			'--',
			'--user-data-dir',
			userData,
		],
		{ shell: false, stdio: 'ignore' },
	);
	if (foreign.pid === undefined) {
		throw new Error('The foreign persistent-profile fixture PID is unavailable.');
	}
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	return {
		foreignPid: foreign.pid,
		runtimeRoot,
		evidencePath,
		lockRoot,
		lockOwnerPath,
		terminationLog,
		run: () => runHarnessGuard({
			runtimeRoot,
			profileRoot,
			evidenceRoot,
			terminationLog,
			injection,
		}),
		dispose: async () => {
			if (processAlive(foreign.pid!)) {
				process.kill(foreign.pid!, 'SIGTERM');
				await waitForProcessExit(foreign.pid!, 2_000);
				if (processAlive(foreign.pid!)) {
					process.kill(foreign.pid!, 'SIGKILL');
				}
			}
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function runHarnessGuard(options: {
	readonly runtimeRoot: string;
	readonly profileRoot: string;
	readonly evidenceRoot: string;
	readonly terminationLog: string;
	readonly injection?: 'schema' | 'safety';
}): Promise<{ readonly exitCode: number | null; readonly stderr: string }> {
	const child = spawn(
		process.execPath,
		[resolve('scripts/e2e/peer-delegation/enabled.mjs')],
		{
			cwd: resolve('.'),
			env: {
				...process.env,
				MESH_PEER_DELEGATION_E2E: '1',
				MESH_PEER_DELEGATION_E2E_MANUAL_UI: '0',
				MESH_PEER_DELEGATION_E2E_TEST_MODE: '1',
				MESH_PEER_DELEGATION_E2E_RUNTIME_DIR: options.runtimeRoot,
				MESH_PEER_DELEGATION_E2E_PROFILE_DIR: options.profileRoot,
				MESH_PEER_DELEGATION_E2E_EVIDENCE_DIR: options.evidenceRoot,
				MESH_PEER_DELEGATION_E2E_TEST_TERMINATION_LOG: options.terminationLog,
				...(options.injection === undefined
					? {}
					: { MESH_PEER_DELEGATION_E2E_TEST_INVALID_EVIDENCE: options.injection }),
			},
			shell: false,
			stdio: ['ignore', 'ignore', 'pipe'],
		},
	);
	let stderr = '';
	child.stderr?.on('data', (chunk: Buffer) => {
		if (stderr.length < 16_384) {
			stderr += chunk.toString('utf8');
		}
	});
	const exitCode = await new Promise<number | null>((resolveExit, reject) => {
		child.once('error', reject);
		child.once('exit', resolveExit);
	});
	return { exitCode, stderr };
}

async function peerRunDirectories(runtimeRoot: string): Promise<readonly string[]> {
	return (await readdir(runtimeRoot))
		.filter((name) => name.startsWith('peer-'))
		.sort();
}

async function waitForTrackedProcess(
	tracker: PeerDelegationProcessTracker,
	pid: number,
) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const tracked = tracker.select(readSystemProcessTable())
			.find((entry) => entry.pid === pid);
		if (tracked !== undefined) {
			return tracked;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	throw new Error(`Timed out waiting to track exact process ${pid}.`);
}

function readSystemProcessTable() {
	const result = spawnSync(
		'ps',
		['-axo', 'pid=,ppid=,pgid=,command='],
		{ encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
	);
	if (result.status !== 0) {
		throw new Error('Unable to inspect the detached process fixture.');
	}
	return parseProcessTable(result.stdout);
}
