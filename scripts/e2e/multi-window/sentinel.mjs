import { createHash } from 'node:crypto';
import { chmod, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWindowsHarnessCommand } from './owned-processes.mjs';

export function sentinelExecutablePath(runRoot) {
	return join(runRoot, process.platform === 'win32' ? 'mesh-e2e-sentinel.exe' : 'devtunnel-sentinel');
}

export async function prepareSentinel(path, invocationPath) {
	if (process.platform === 'win32') {
		const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
		await copyFile(join(root, 'dist', 'windows', `mesh-process-host-${process.arch}.exe`), path);
		const result = await runWindowsHarnessCommand(path, ['--version'], {
			timeoutMs: 5_000, maxOutputBytes: 1_024,
		});
		const probe = JSON.parse(await readFile(invocationPath, 'utf8').catch(() => 'null'));
		if (result.status !== 97 || probe?.invoked !== true || !Number.isSafeInteger(probe.pid)) {
			throw new Error('The packaged native helper does not provide the required Windows E2E sentinel mode.');
		}
		// The self-test proves the trap can execute on this machine. Only subsequent
		// invocations belong to the observed harness scenario.
		await rm(invocationPath);
	} else {
		const script = [
			'#!/usr/bin/env node',
			`require('node:fs').writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ invoked: true, pid: process.pid }));`,
			'process.exitCode = 97;',
			'',
		].join('\n');
		await writeFile(path, script, { encoding: 'utf8', mode: 0o700, flag: 'wx' });
		await chmod(path, 0o700);
	}
	return createHash('sha256').update(await readFile(path)).digest('hex');
}
