import * as assert from 'node:assert/strict';
import { basename } from 'node:path';
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

	test('force-kills the owned group when a descendant ignores SIGTERM', {
		skip: process.platform === 'win32',
	}, async () => {
		const signals: NodeJS.Signals[] = [];
		const runner = createNodeRunner((pid, signal) => {
			signals.push(signal);
			process.kill(-pid, signal);
		});
		const script = [
			"const { spawn } = require('node:child_process');",
			"spawn(process.execPath, ['-e',",
			"  \"process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);\"",
			"], { stdio: 'ignore' });",
			'setInterval(() => undefined, 1000);',
		].join('\n');

		await assert.rejects(
			runner.run(process.execPath, ['-e', script], { timeoutMs: 20 }),
			(error: unknown) => hasCode(error, 'PROCESS_TIMEOUT'),
		);
		assert.deepStrictEqual(signals, ['SIGTERM', 'SIGKILL']);
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
