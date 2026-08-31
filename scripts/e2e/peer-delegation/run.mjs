import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const environmentVariable = 'MESH_PEER_DELEGATION_E2E';
if (process.env[environmentVariable] !== '1') {
	console.log(JSON.stringify({
		outcome: 'skipped',
		reason: `${environmentVariable}=1 is required`,
		launched: false,
	}));
	process.exit(0);
}
if (process.env.MESH_PEER_DELEGATION_E2E_TEST_MODE === '1') {
	throw new Error('Internal peer-delegation test mode cannot run through the release command.');
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
	throw new Error('The real peer-delegation E2E requires supported macOS arm64 Worker hardware.');
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const evidenceRoot = resolve(repositoryRoot, 'artifacts', 'peer-delegation-e2e');
for (const name of ['evidence.json', 'summary.md']) {
	rmSync(resolve(evidenceRoot, name), { force: true });
}
for (const script of ['compile-tests', 'compile']) {
	const result = spawnSync(npmCommand(), ['run', script], {
		cwd: repositoryRoot,
		env: process.env,
		shell: false,
		stdio: 'inherit',
	});
	if (result.error !== undefined) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`npm run ${script} failed with exit code ${result.status ?? 'unknown'}.`);
	}
}
await import('./enabled.mjs');

function npmCommand() {
	return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}
