import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { suite, test } from 'node:test';

import {
	ChildProcessExecutionError,
	ChildProcessRunner,
	redactProcessText,
} from '../tunnel/ChildProcessRunner';

suite('ChildProcessRunner', () => {
	test('rejects executables outside the allowlist', async () => {
		const runner = new ChildProcessRunner();

		await assert.rejects(
			runner.run(process.execPath, ['--version']),
			(error: unknown) => hasCode(error, 'EXECUTABLE_NOT_ALLOWED'),
		);
	});

	test('fails closed when owned process-tree termination is unavailable', async () => {
		const runner = new ChildProcessRunner({
			allowedExecutableBasenames: [basename(process.execPath)],
			platform: 'win32',
		});

		await assert.rejects(
			runner.run(process.execPath, ['--version']),
			(error: unknown) => hasCode(error, 'PROCESS_TREE_UNSUPPORTED'),
		);
	});

	test('captures bounded successful output without a shell', async () => {
		const runner = createNodeRunner();
		const result = await runner.run(process.execPath, [
			'-e',
			'process.stdout.write("ok"); process.stderr.write("diagnostic");',
		]);

		assert.equal(result.exitCode, 0);
		assert.equal(result.stdout, 'ok');
		assert.equal(result.stderr, 'diagnostic');
	});

	test('terminates a process when the timeout expires', async () => {
		const runner = createNodeRunner();

		await assert.rejects(
			runner.run(process.execPath, ['-e', 'setTimeout(() => undefined, 10_000);'], { timeoutMs: 20 }),
			(error: unknown) => hasCode(error, 'PROCESS_TIMEOUT'),
		);
	});

	test('bounds timeout when a descendant inherits the output pipes', {
		skip: process.platform === 'win32',
	}, async () => {
		const runner = createNodeRunner();
		const startedAt = Date.now();
		const script = [
			"const { spawn } = require('node:child_process');",
			"spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000);'],",
			"  { stdio: ['ignore', 'inherit', 'inherit'] });",
			'setInterval(() => undefined, 1000);',
		].join('\n');

		await assert.rejects(
			runner.run(process.execPath, ['-e', script], { timeoutMs: 20 }),
			(error: unknown) => hasCode(error, 'PROCESS_TIMEOUT'),
		);
		assert.ok(Date.now() - startedAt < 1_000);
	});

	test('force-kills a ready owned group when a descendant ignores SIGTERM', {
		skip: process.platform === 'win32',
	}, async () => {
		const signals: NodeJS.Signals[] = [];
		const controller = new AbortController();
		const readyRoot = await mkdtemp(join(tmpdir(), 'cam-process-ready-'));
		const readyFile = join(readyRoot, 'ready');
		const runner = createNodeRunner((pid, signal) => {
			process.kill(-pid, signal);
			signals.push(signal);
		});

		try {
			const execution = runner.run(
				process.execPath,
				['-e', launcherWithReadyIgnoringDescendant(undefined, readyFile)],
				{ signal: controller.signal, timeoutMs: 2_000 },
			);
			await waitForFile(readyFile, 1_000);
			controller.abort();

			await assert.rejects(
				execution,
				(error: unknown) => hasCode(error, 'PROCESS_ABORTED'),
			);
			assert.deepStrictEqual(signals, ['SIGTERM', 'SIGKILL']);
		} finally {
			controller.abort();
			await rm(readyRoot, { recursive: true, force: true });
		}
	});

	test('cleans the owned group after a successful launcher exit', {
		skip: process.platform === 'win32',
	}, async () => {
		const signals: NodeJS.Signals[] = [];
		let processGroupId: number | undefined;
		const runner = createNodeRunner((pid, signal) => {
			processGroupId = pid;
			process.kill(-pid, signal);
			signals.push(signal);
		});

		const result = await runner.run(
			process.execPath,
			['-e', launcherWithReadyIgnoringDescendant(0, undefined, true)],
		);

		assert.equal(result.exitCode, 0);
		assert.deepStrictEqual(signals, ['SIGTERM', 'SIGKILL']);
		assert.ok(processGroupId);
		assertProcessGroupGone(processGroupId);
	});

	test('cleans the owned group after a nonzero launcher exit', {
		skip: process.platform === 'win32',
	}, async () => {
		const signals: NodeJS.Signals[] = [];
		let processGroupId: number | undefined;
		const runner = createNodeRunner((pid, signal) => {
			processGroupId = pid;
			process.kill(-pid, signal);
			signals.push(signal);
		});

		await assert.rejects(
			runner.run(
				process.execPath,
				['-e', launcherWithReadyIgnoringDescendant(7, undefined, true)],
			),
			(error: unknown) => hasCode(error, 'PROCESS_EXIT_NONZERO'),
		);
		assert.deepStrictEqual(signals, ['SIGTERM', 'SIGKILL']);
		assert.ok(processGroupId);
		assertProcessGroupGone(processGroupId);
	});

	test('keeps polling after a transient process-group permission error', async () => {
		let probes = 0;
		const runner = new ChildProcessRunner({
			allowedExecutableBasenames: [basename(process.execPath)],
			isProcessTreeAlive: () => {
				probes += 1;
				if (probes === 1) {
					throw Object.assign(new Error('Transient process-group state.'), { code: 'EPERM' });
				}
				return false;
			},
			terminateProcessTree: () => undefined,
			terminationConfirmationMs: 100,
			terminationGraceMs: 1,
			terminationPollMs: 5,
		});

		const result = await runner.run(process.execPath, ['-e', 'process.exit(0);']);

		assert.equal(result.exitCode, 0);
		assert.equal(probes, 2);
	});

	test('does not SIGKILL after the owned group disappears during grace', async () => {
		const signals: NodeJS.Signals[] = [];
		let probes = 0;
		const runner = new ChildProcessRunner({
			allowedExecutableBasenames: [basename(process.execPath)],
			isProcessTreeAlive: () => {
				probes += 1;
				return probes === 1;
			},
			terminateProcessTree: (_pid, signal) => signals.push(signal),
			terminationConfirmationMs: 100,
			terminationGraceMs: 50,
			terminationPollMs: 1,
		});

		const result = await runner.run(process.execPath, ['-e', 'process.exit(0);']);

		assert.equal(result.exitCode, 0);
		assert.deepStrictEqual(signals, ['SIGTERM']);
		assert.equal(probes, 2);
	});

	test('does not sleep beyond the process-tree confirmation deadline', async () => {
		const runner = new ChildProcessRunner({
			allowedExecutableBasenames: [basename(process.execPath)],
			isProcessTreeAlive: () => true,
			terminateProcessTree: () => undefined,
			terminationConfirmationMs: 20,
			terminationGraceMs: 1,
			terminationPollMs: 500,
		});
		const startedAt = Date.now();

		await assert.rejects(
			runner.run(process.execPath, ['-e', 'process.exit(0);']),
			(error: unknown) => hasCode(error, 'PROCESS_TREE_TERMINATION_FAILED'),
		);
		assert.ok(Date.now() - startedAt < 200);
	});

	test('terminates a process when aborted', async () => {
		const runner = createNodeRunner();
		const controller = new AbortController();
		const execution = runner.run(
			process.execPath,
			['-e', 'setTimeout(() => undefined, 10_000);'],
			{ signal: controller.signal },
		);

		controller.abort();
		await assert.rejects(execution, (error: unknown) => hasCode(error, 'PROCESS_ABORTED'));
	});

	test('does not start a process for an already-aborted request', async () => {
		const runner = createNodeRunner();
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(
			runner.run(process.execPath, ['-e', 'process.exit(9);'], { signal: controller.signal }),
			(error: unknown) => hasCode(error, 'PROCESS_ABORTED'),
		);
	});

	test('terminates a process that exceeds the combined output limit', async () => {
		const runner = createNodeRunner();

		await assert.rejects(
			runner.run(
				process.execPath,
				['-e', 'process.stdout.write("x".repeat(4096));'],
				{ maxOutputBytes: 128 },
			),
			(error: unknown) => hasCode(error, 'PROCESS_OUTPUT_LIMIT'),
		);
	});

	test('does not include child output in nonzero-exit errors', async () => {
		const runner = createNodeRunner();
		const secret = 'sensitive-token-value';

		await assert.rejects(
			runner.run(process.execPath, ['-e', `process.stderr.write("${secret}"); process.exit(3);`]),
			(error: unknown) => {
				assert.ok(error instanceof ChildProcessExecutionError);
				assert.equal(error.code, 'PROCESS_EXIT_NONZERO');
				assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
				return true;
			},
		);
	});

	test('redacts URL fragments, tokens, authorization, and JSON secrets', () => {
		const redacted = redactProcessText(
			'https://example.test/connect#secret=value?x=1 '
			+ 'https://example.test/?tkn=abc '
			+ '--token=equals-secret '
			+ '--access-token command-secret '
			+ '{"connectionToken":"json-secret"}\n'
			+ 'Authorization: Basic dXNlcjpwYXNz',
		);

		assert.doesNotMatch(
			redacted,
			/value|abc|equals-secret|command-secret|json-secret|dXNlcjpwYXNz/u,
		);
		assert.match(redacted, /<redacted>/u);
	});
});

function createNodeRunner(
	terminateProcessTree?: (pid: number, signal: NodeJS.Signals) => void,
): ChildProcessRunner {
	return new ChildProcessRunner({
		allowedExecutableBasenames: [basename(process.execPath)],
		defaultTimeoutMs: 2_000,
		isProcessTreeAlive: process.platform === 'win32'
			? (pid) => isProcessAlive(pid)
			: undefined,
		terminateProcessTree: terminateProcessTree ?? (
			process.platform === 'win32'
				? (pid, signal) => process.kill(pid, signal)
				: undefined
		),
		terminationGraceMs: 50,
	});
}

function hasCode(error: unknown, code: ChildProcessExecutionError['code']): boolean {
	assert.ok(error instanceof ChildProcessExecutionError);
	assert.equal(error.code, code);
	return true;
}

function launcherWithReadyIgnoringDescendant(
	exitCode?: number,
	readyFile?: string,
	inheritOutput = false,
): string {
	const descendant = [
		"process.on('SIGTERM', () => undefined);",
		"process.send?.('ready');",
		'setInterval(() => undefined, 1000);',
	].join('');
	return [
		"const { spawn } = require('node:child_process');",
		`const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],`,
		inheritOutput
			? "  { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });"
			: "  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
		"child.once('message', () => {",
		readyFile === undefined
			? ''
			: `  require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
		exitCode === undefined
			? '  setInterval(() => undefined, 1000);'
			: `  process.exit(${exitCode});`,
		'});',
	].join('');
}

function assertProcessGroupGone(processGroupId: number): void {
	assert.throws(
		() => process.kill(-processGroupId, 0),
		(error: unknown) => error instanceof Error
			&& 'code' in error
			&& error.code === 'ESRCH',
	);
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		try {
			await readFile(path);
			return;
		} catch (error: unknown) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
				throw error;
			}
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for readiness file after ${timeoutMs}ms.`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
			return false;
		}
		throw error;
	}
}
