import { basename } from 'node:path';

import {
	ChildProcessExecutionError,
	ChildProcessRunner,
} from '../tunnel/ChildProcessRunner';
import { LEGACY_UNSUPPORTED_DEVTUNNEL_BUILD } from '../tunnel/DevTunnelJsonDecoder';

const e2eFlag = 'MESH_DEVTUNNEL_E2E';

async function main(): Promise<void> {
	if (process.env[e2eFlag] !== '1') {
		throw new Error(`${e2eFlag}=1 is required for the opt-in Dev Tunnel probe.`);
	}

	const executable = process.env.MESH_DEVTUNNEL_PATH ?? 'devtunnel';
	const runner = new ChildProcessRunner();
	const version = await runner.run(executable, ['--version'], {
		timeoutMs: 15_000,
		maxOutputBytes: 32 * 1024,
	});
	const expectedLine = `Tunnel CLI version: ${LEGACY_UNSUPPORTED_DEVTUNNEL_BUILD}`;
	if (!version.stdout.split(/\r?\n/u).includes(expectedLine)) {
		throw new Error('CLI_UNSUPPORTED: the Dev Tunnel build does not match the observed decoder revision.');
	}

	await runner.run(executable, ['user', 'show'], {
		timeoutMs: 15_000,
		maxOutputBytes: 32 * 1024,
	});

	console.log(JSON.stringify({
		status: 'blocked',
		code: 'CLI_UNSUPPORTED',
		executable: basename(executable),
		build: LEGACY_UNSUPPORTED_DEVTUNNEL_BUILD,
		reason: 'This build emits non-JSON text for create --json and has not passed hosted URI, health, or WSS validation.',
	}));
	process.exitCode = 2;
}

main().catch((error: unknown) => {
	const code = error instanceof ChildProcessExecutionError ? error.code : 'SPIKE_FAILED';
	console.error(JSON.stringify({
		status: 'failed',
		code,
		message: error instanceof Error ? error.message : 'Unknown Dev Tunnel spike failure.',
	}));
	process.exitCode = 1;
});
