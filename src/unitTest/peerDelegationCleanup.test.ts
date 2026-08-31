import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
	access,
	link,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { runPeerDelegationCleanupPhases } from '../e2e/PeerDelegationCleanup';
import {
	parsePeerDelegationTestDiagnosticEvidence,
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
				const releaseBefore = await readOptionalFile(releaseEvidencePath());
				const result = await fixture.run();
				assert.notEqual(result.exitCode, 0);
				assert.equal(processAlive(fixture.foreignPid), true);
				await assert.rejects(access(fixture.terminationLog), { code: 'ENOENT' });
				assert.deepEqual(await peerRunDirectories(fixture.runtimeRoot), []);
				const artifact = parsePeerDelegationTestDiagnosticEvidence(
					JSON.parse(await readFile(fixture.evidencePath, 'utf8')),
				);
				assert.equal(artifact.kind, 'test-diagnostic');
				assert.equal(artifact.testMode, true);
				assert.equal(artifact.outcome, 'fail');
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
				assert.deepEqual(await readOptionalFile(releaseEvidencePath()), releaseBefore);
				await assertReleaseValidatorRejects(fixture.evidencePath);
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
				const releaseBefore = await readOptionalFile(releaseEvidencePath());
				const result = await fixture.run();
				assert.notEqual(result.exitCode, 0);
				assert.equal(processAlive(fixture.foreignPid), true);
				await assert.rejects(access(fixture.terminationLog), { code: 'ENOENT' });
				assert.deepEqual(await peerRunDirectories(fixture.runtimeRoot), []);
				const artifact = parsePeerDelegationTestDiagnosticEvidence(
					JSON.parse(await readFile(fixture.evidencePath, 'utf8')),
				);
				assert.equal(artifact.kind, 'test-diagnostic');
				assert.equal(artifact.testMode, true);
				assert.equal(artifact.outcome, 'fail');
				assert.equal(artifact.failure.code, 'PROFILE_IN_USE');
				assert.equal(artifact.validation.code, 'EVIDENCE_VALIDATION_FAILED');
				assert.deepEqual(await readOptionalFile(releaseEvidencePath()), releaseBefore);
				await assertReleaseValidatorRejects(fixture.evidencePath);
			} finally {
				await fixture.dispose();
			}
		},
	);
}

test(
	'test mode records actual platform and dirty/unsupported simulation without release evidence',
	{ skip: process.platform === 'win32' ? 'POSIX process ownership is the supported real harness boundary.' : false },
	async () => {
		const fixture = await persistentProfileFixture(
			'lock-conflict',
			undefined,
			{
				os: 'linux',
				architecture: 'x64',
				dirtyTree: true,
			},
		);
		try {
			const releaseBefore = await readOptionalFile(releaseEvidencePath());
			const result = await fixture.run();
			assert.notEqual(result.exitCode, 0);
			const artifact = parsePeerDelegationTestDiagnosticEvidence(
				JSON.parse(await readFile(fixture.evidencePath, 'utf8')),
			);
			assert.deepEqual(artifact.platform, {
				os: process.platform,
				architecture: process.arch,
			});
			assert.deepEqual(artifact.simulation, {
				os: 'linux',
				architecture: 'x64',
				dirtyTree: true,
			});
			assert.deepEqual(await readOptionalFile(releaseEvidencePath()), releaseBefore);
			await assertReleaseValidatorRejects(fixture.evidencePath);
		} finally {
			await fixture.dispose();
		}
	},
);

test('release wrapper rejects test mode before touching stable evidence', async () => {
	await withStableEvidencePreserved(async () => {
		const child = spawn(
			process.execPath,
			[resolve('scripts/e2e/peer-delegation/run.mjs')],
			{
				cwd: resolve('.'),
				env: {
					...process.env,
					MESH_PEER_DELEGATION_E2E: '1',
					MESH_PEER_DELEGATION_E2E_TEST_MODE: '1',
				},
				shell: false,
				stdio: 'ignore',
			},
		);
		const exitCode = await new Promise<number | null>((resolveExit, reject) => {
			child.once('error', reject);
			child.once('exit', resolveExit);
		});
		assert.notEqual(exitCode, 0);
	});
});

test(
	'unsupported actual platform rejects before touching stable evidence',
	{
		skip: process.platform === 'darwin' && process.arch === 'arm64'
			? 'This runner is the supported release platform.'
			: false,
	},
	async () => {
		await withStableEvidencePreserved(async () => {
			const child = spawn(
				process.execPath,
				[resolve('scripts/e2e/peer-delegation/run.mjs')],
				{
					cwd: resolve('.'),
					env: {
						...process.env,
						MESH_PEER_DELEGATION_E2E: '1',
					},
					shell: false,
					stdio: 'ignore',
				},
			);
			const exitCode = await new Promise<number | null>((resolveExit, reject) => {
				child.once('error', reject);
				child.once('exit', resolveExit);
			});
			assert.notEqual(exitCode, 0);
		});
	},
);

test('release snapshot validator rejects dirty trees and commit drift', () => {
	const helperUrl = pathToFileURL(
		resolve('scripts/e2e/peer-delegation/evidence-path.mjs'),
	).href;
	const result = spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'--eval',
			`
				import { assertCleanCommittedReleaseSnapshot as check } from ${JSON.stringify(helperUrl)};
				const head = '0123456789012345678901234567890123456789';
				const cases = [
					[{ expectedCommit: head, headBefore: head, headAfter: head, statusBefore: ' M file', statusAfter: '' }, 'WORKTREE_DIRTY'],
					[{ expectedCommit: head, headBefore: head, headAfter: '1123456789012345678901234567890123456789', statusBefore: '', statusAfter: '' }, 'EVIDENCE_COMMIT_MISMATCH'],
				];
				for (const [input, expectedCode] of cases) {
					let actualCode;
					try { check(input); } catch (error) { actualCode = error.code; }
					if (actualCode !== expectedCode) {
						throw new Error('Unexpected release snapshot result: ' + String(actualCode));
					}
				}
				check({ expectedCommit: head, headBefore: head, headAfter: head, statusBefore: '', statusAfter: '' });
			`,
		],
		{ cwd: resolve('.'), encoding: 'utf8', shell: false },
	);
	assert.equal(result.status, 0, result.stderr);
});

test(
	'release-mode case alias cannot replace stable release evidence',
	{ skip: process.platform !== 'darwin' ? 'macOS case-alias boundary.' : false },
	async () => {
		const stableRoot = resolve('artifacts', 'peer-delegation-e2e');
		const aliasRoot = resolve('ARTIFACTS', 'PEER-DELEGATION-E2E');
		await mkdir(stableRoot, { recursive: true });
		const [stableStat, aliasStat] = await Promise.all([
			access(stableRoot).then(() => stat(stableRoot)),
			access(aliasRoot).then(() => stat(aliasRoot)).catch(() => undefined),
		]);
		if (
			aliasStat === undefined
			|| stableStat.dev !== aliasStat.dev
			|| stableStat.ino !== aliasStat.ino
		) {
			return;
		}
		await withStableEvidencePreserved(async () => {
			const result = await runReleasePreflightWithEvidenceRoot(aliasRoot);
			assert.notEqual(result.exitCode, 0);
			assert.match(result.stderr, /case alias|aliases the stable release directory/u);
		});
	},
);

for (const fileName of ['evidence.json', 'summary.md'] as const) {
	for (const aliasKind of ['symlink', 'hardlink'] as const) {
		test(
		`release-mode ${fileName} ${aliasKind} cannot replace an external artifact`,
		{ skip: process.platform === 'win32' ? 'POSIX link fixture.' : false },
		async () => {
			await withStableArtifactSentinels(async () => {
				const parent = resolve('.vscode-test', 'peer-process-ownership');
				await mkdir(parent, { recursive: true });
				const root = await mkdtemp(join(parent, `${aliasKind}-alias-`));
				const evidenceRoot = join(root, 'evidence');
				await mkdir(evidenceRoot);
				const aliasedFile = join(evidenceRoot, fileName);
				const target = fileName === 'evidence.json'
					? releaseEvidencePath()
					: releaseSummaryPath();
				try {
					if (aliasKind === 'symlink') {
						await symlink(target, aliasedFile);
					} else {
						await link(target, aliasedFile);
					}
					const result = await runReleasePreflightWithEvidenceRoot(evidenceRoot);
					assert.notEqual(result.exitCode, 0);
					assert.match(
						result.stderr,
						/evidence file is aliased or unsafe/u,
					);
					await access(aliasedFile);
				} finally {
					await rm(root, { recursive: true, force: true });
				}
			});
		},
		);
	}
}

test(
	'release-mode ancestor symlink cannot create or replace stable release evidence',
	{ skip: process.platform === 'win32' ? 'POSIX symlink fixture.' : false },
	async () => {
		await withStableArtifactSentinels(async () => {
			const parent = resolve('.vscode-test', 'peer-process-ownership');
			await mkdir(parent, { recursive: true });
			const root = await mkdtemp(join(parent, 'ancestor-alias-'));
			const externalRoot = join(root, 'external');
			const externalEvidenceRoot = join(externalRoot, 'peer-delegation-e2e');
			const artifactsAlias = join(root, 'artifacts-alias');
			await mkdir(externalEvidenceRoot, { recursive: true });
			const externalEvidence = join(externalEvidenceRoot, 'evidence.json');
			const externalSummary = join(externalEvidenceRoot, 'summary.md');
			await writeFile(externalEvidence, 'external evidence sentinel\n');
			await writeFile(externalSummary, 'external summary sentinel\n');
			await symlink(externalRoot, artifactsAlias);
			try {
				const result = await runReleasePreflightWithEvidenceRoot(
					join(artifactsAlias, 'peer-delegation-e2e'),
				);
				assert.notEqual(result.exitCode, 0);
				assert.match(result.stderr, /must not contain symbolic links/u);
				assert.equal(await readFile(externalEvidence, 'utf8'), 'external evidence sentinel\n');
				assert.equal(await readFile(externalSummary, 'utf8'), 'external summary sentinel\n');
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	},
);

test(
	'release-mode evidence-root symlink cannot modify its external target',
	{ skip: process.platform === 'win32' ? 'POSIX symlink fixture.' : false },
	async () => {
		await withStableEvidencePreserved(async () => {
			const parent = resolve('.vscode-test', 'peer-process-ownership');
			await mkdir(parent, { recursive: true });
			const root = await mkdtemp(join(parent, 'root-alias-'));
			const target = join(root, 'external-target');
			const alias = join(root, 'evidence-alias');
			await mkdir(target);
			const targetEvidence = join(target, 'evidence.json');
			const targetSummary = join(target, 'summary.md');
			await writeFile(targetEvidence, 'external evidence sentinel\n');
			await writeFile(targetSummary, 'external summary sentinel\n');
			await symlink(target, alias);
			try {
				const result = await runReleasePreflightWithEvidenceRoot(alias);
				assert.notEqual(result.exitCode, 0);
				assert.match(result.stderr, /must not contain symbolic links/u);
				assert.equal(await readFile(targetEvidence, 'utf8'), 'external evidence sentinel\n');
				assert.equal(await readFile(targetSummary, 'utf8'), 'external summary sentinel\n');
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	},
);

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
	simulation?: {
		readonly os: string;
		readonly architecture: string;
		readonly dirtyTree: boolean;
	},
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
			simulation,
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
	readonly simulation?: {
		readonly os: string;
		readonly architecture: string;
		readonly dirtyTree: boolean;
	};
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
				...(options.simulation === undefined ? {} : {
					MESH_PEER_DELEGATION_E2E_TEST_PLATFORM: options.simulation.os,
					MESH_PEER_DELEGATION_E2E_TEST_ARCHITECTURE: options.simulation.architecture,
					MESH_PEER_DELEGATION_E2E_TEST_DIRTY_TREE:
						options.simulation.dirtyTree ? '1' : '0',
				}),
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

async function assertReleaseValidatorRejects(path: string): Promise<void> {
	for (const flags of [[], ['--require-pass']]) {
		const result = spawnSync(
			process.execPath,
			[
				resolve('scripts/e2e/peer-delegation/validate.mjs'),
				path,
				...flags,
			],
			{ cwd: resolve('.'), encoding: 'utf8', shell: false },
		);
		assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
	}
}

async function runReleasePreflightWithEvidenceRoot(
	evidenceRoot: string,
): Promise<{ readonly exitCode: number | null; readonly stderr: string }> {
	const helperUrl = pathToFileURL(
		resolve('scripts/e2e/peer-delegation/evidence-path.mjs'),
	).href;
	const child = spawn(
		process.execPath,
		[
			'--input-type=module',
			'--eval',
			`
				import { resolvePeerDelegationEvidenceDestination as preflight } from ${JSON.stringify(helperUrl)};
				await preflight({
					repositoryRoot: ${JSON.stringify(resolve('.'))},
					configuredRoot: ${JSON.stringify(evidenceRoot)},
				});
			`,
		],
		{
			cwd: resolve('.'),
			env: process.env,
			shell: false,
			stdio: ['ignore', 'ignore', 'pipe'],
		},
	);
	let stderr = '';
	child.stderr?.setEncoding('utf8');
	child.stderr?.on('data', (chunk: string) => {
		stderr += chunk;
	});
	return new Promise((resolveExit, reject) => {
		child.once('error', reject);
		child.once('exit', (exitCode) => resolveExit({ exitCode, stderr }));
	});
}

function releaseEvidencePath(): string {
	return resolve('artifacts', 'peer-delegation-e2e', 'evidence.json');
}

function releaseSummaryPath(): string {
	return resolve('artifacts', 'peer-delegation-e2e', 'summary.md');
}

async function withStableEvidencePreserved(run: () => Promise<void>): Promise<void> {
	const snapshots = await Promise.all(
		[releaseEvidencePath(), releaseSummaryPath()].map(async (path) => ({
			path,
			content: await readOptionalFile(path),
		})),
	);
	try {
		await run();
		for (const snapshot of snapshots) {
			assert.deepEqual(await readOptionalFile(snapshot.path), snapshot.content);
		}
	} finally {
		for (const snapshot of snapshots) {
			if (snapshot.content === undefined) {
				await rm(snapshot.path, { force: true });
			} else {
				await mkdir(resolve(snapshot.path, '..'), { recursive: true });
				await writeFile(snapshot.path, snapshot.content, { mode: 0o600 });
			}
		}
	}
}

async function withStableArtifactSentinels(run: () => Promise<void>): Promise<void> {
	const paths = [releaseEvidencePath(), releaseSummaryPath()];
	const snapshots = await Promise.all(paths.map(async (path) => ({
		path,
		content: await readOptionalFile(path),
	})));
	const sentinels = new Map([
		[releaseEvidencePath(), Buffer.from('stable release evidence sentinel\n', 'utf8')],
		[releaseSummaryPath(), Buffer.from('stable release summary sentinel\n', 'utf8')],
	]);
	try {
		await mkdir(resolve(releaseEvidencePath(), '..'), { recursive: true });
		for (const [path, content] of sentinels) {
			await writeFile(path, content, { mode: 0o600 });
		}
		await run();
		for (const [path, content] of sentinels) {
			assert.deepEqual(await readFile(path), content);
		}
	} finally {
		for (const snapshot of snapshots) {
			if (snapshot.content === undefined) {
				await rm(snapshot.path, { force: true });
			} else {
				await writeFile(snapshot.path, snapshot.content, { mode: 0o600 });
			}
		}
	}
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
	try {
		return await readFile(path);
	} catch (error: unknown) {
		if (
			typeof error === 'object'
			&& error !== null
			&& 'code' in error
			&& error.code === 'ENOENT'
		) {
			return undefined;
		}
		throw error;
	}
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
