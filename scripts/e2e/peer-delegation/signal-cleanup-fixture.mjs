import { spawn } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(process.argv[2] ?? '');
if (root.length === 0 || root === resolve('/')) {
	throw new Error('A dedicated fixture root is required.');
}
const require = createRequire(import.meta.url);
const {
	runPeerDelegationCleanupPhases,
} = require(resolve('out/src/e2e/PeerDelegationCleanup.js'));
const runRoot = join(root, 'run');
const lockRoot = join(root, 'lock');
await Promise.all([
	mkdir(join(runRoot, 'control', 'broker', 'mesh-state', 'tasks'), { recursive: true }),
	mkdir(lockRoot, { recursive: true }),
]);
await writeFile(
	join(runRoot, 'control', 'broker', 'mesh-state', 'tasks', 'owned.json'),
	'{}\n',
	{ encoding: 'utf8', mode: 0o600 },
);
const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
	shell: false,
	stdio: 'ignore',
});
if (child.pid === undefined) {
	throw new Error('The cleanup fixture child PID is unavailable.');
}
const readyPath = join(root, 'ready.json');
const readyTemporaryPath = `${readyPath}.${process.pid}.tmp`;
await writeFile(readyTemporaryPath, `${JSON.stringify({
	fixturePid: process.pid,
	childPid: child.pid,
})}\n`, { encoding: 'utf8', mode: 0o600 });
await rename(readyTemporaryPath, readyPath);

let cleaning = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		if (cleaning) {
			return;
		}
		cleaning = true;
		void cleanup(signal);
	});
}

async function cleanup(signal) {
	const failures = await runPeerDelegationCleanupPhases([
		{
			name: 'owned child',
			run: async () => {
				child.kill('SIGTERM');
				await new Promise((resolveExit) => child.once('exit', resolveExit));
			},
		},
		{
			name: 'profile lock',
			run: () => rm(lockRoot, { recursive: true, force: true }),
		},
		{
			name: 'run root',
			run: () => rm(runRoot, { recursive: true, force: true }),
		},
	]);
	process.exit(failures.length === 0 ? (signal === 'SIGINT' ? 130 : 143) : 1);
}

await new Promise(() => undefined);
