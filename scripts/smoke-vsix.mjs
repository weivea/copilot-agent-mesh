import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	downloadAndUnzipVSCode,
	resolveCliArgsFromVSCodeExecutablePath,
	runTests,
} from '@vscode/test-electron';
import { require as tsxRequire } from 'tsx/cjs/api';

const { runOwnedCommand, OwnedCommandError } = tsxRequire('../src/spikes/ownedProcess.ts', import.meta.url);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const extensionIdentity = `${manifest.publisher}.${manifest.name}@${manifest.version}`;
const vsixPath = resolve(process.argv[2] ?? join(repositoryRoot, 'artifacts', `${manifest.name}-${manifest.version}-preview.vsix`));
const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
const root = mkdtempSync(join(temporaryRoot, 'cam-vsix-'));
const userDataDirectory = join(root, 'user-data');
const extensionsDirectory = join(root, 'extensions');
const harnessDirectory = join(root, 'harness');
const takeoverState = process.env.MESH_SMOKE_TAKEOVER_STATE ?? '';
assert.ok(['', 'orphan', 'live', 'malformed'].includes(takeoverState), 'Unknown smoke takeover fixture.');

try {
	mkdirSync(userDataDirectory, { recursive: true });
	mkdirSync(extensionsDirectory, { recursive: true });
	mkdirSync(harnessDirectory, { recursive: true });
	writeFileSync(join(harnessDirectory, 'package.json'), JSON.stringify({
		name: 'mesh-preview-smoke-harness',
		displayName: 'Mesh Preview Smoke Harness',
		publisher: 'weivea',
		version: '0.0.0',
		engines: manifest.engines,
		main: './extension.cjs',
	}, null, 2));
	writeFileSync(join(harnessDirectory, 'extension.cjs'), 'exports.activate = () => undefined;\n');

	const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH
		? resolve(process.env.VSCODE_EXECUTABLE_PATH)
		: await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
	const [cli, ...cliPrefix] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
		reuseMachineInstall: true,
	});

	await runCli(cli, [
		...cliPrefix,
		'--user-data-dir', userDataDirectory,
		'--extensions-dir', extensionsDirectory,
		'--install-extension', vsixPath,
		'--force',
	]);
	const companionVsix = process.env.MESH_SMOKE_COMPANION_VSIX;
	if (companionVsix !== undefined) {
		await runCli(cli, [
			...cliPrefix,
			'--user-data-dir', userDataDirectory,
			'--extensions-dir', extensionsDirectory,
			'--install-extension', resolve(companionVsix),
			'--force',
		]);
	}
	const listing = await runCli(cli, [
		...cliPrefix,
		'--user-data-dir', userDataDirectory,
		'--extensions-dir', extensionsDirectory,
		'--list-extensions',
		'--show-versions',
	]);
	if (!listing.split(/\r?\n/u).includes(extensionIdentity)) {
		throw new Error(`Installed extension was not present in the isolated profile:\n${listing}`);
	}

	const testOptions = {
		vscodeExecutablePath,
		reuseMachineInstall: Boolean(process.env.VSCODE_EXECUTABLE_PATH),
		extensionDevelopmentPath: harnessDirectory,
		extensionTestsPath: join(scriptDirectory, 'activation-smoke-runner.cjs'),
		extensionTestsEnv: {
			...process.env,
			MESH_SMOKE_EXTENSIONS_DIR: extensionsDirectory,
			MESH_SMOKE_EXTENSION_VERSION: manifest.version,
			MESH_SMOKE_COMPANION_VERSION: companionVsix === undefined ? '' : manifest.version,
			MESH_SMOKE_TAKEOVER_STATE: '',
		},
		launchArgs: [
			repositoryRoot,
			'--user-data-dir', userDataDirectory,
			'--extensions-dir', extensionsDirectory,
			'--disable-workspace-trust',
			'--skip-welcome',
			'--skip-release-notes',
		],
	};
	if (takeoverState !== '') {
		// Seed ordinary persisted identity through the installed extension itself.
		await runTests(testOptions);
		const storage = join(userDataDirectory, 'User', 'globalStorage', 'weivea.copilot-agent-mesh');
		mkdirSync(storage, { recursive: true });
		assert.throws(() => readFileSync(join(storage, 'worker-owner.lock')), { code: 'ENOENT' });
		assert.throws(() => readFileSync(join(storage, 'worker-owner.takeover')), { code: 'ENOENT' });
		const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 5_000 });
		assert.equal(child.status, 0);
		assert.ok(child.pid > 0);
		const fixture = takeoverState === 'malformed' ? '{' : JSON.stringify({
			schemaVersion: 1,
			pid: takeoverState === 'live' ? process.pid : child.pid,
			instanceId: randomUUID(),
			token: randomUUID(),
			createdAt: new Date(Date.now() - 60_000).toISOString(),
		});
		const mutex = join(storage, 'worker-owner.takeover');
		writeFileSync(mutex, fixture, { flag: 'wx', mode: 0o600 });
		await runTests({
			...testOptions,
			extensionTestsEnv: {
				...testOptions.extensionTestsEnv,
				MESH_SMOKE_TAKEOVER_STATE: takeoverState,
				MESH_SMOKE_STORAGE_ROOT: storage,
				MESH_SMOKE_TAKEOVER_CONTENT: fixture,
			},
		});
		if (takeoverState === 'orphan') {
			assert.throws(() => readFileSync(mutex), { code: 'ENOENT' });
		} else {
			assert.equal(readFileSync(mutex, 'utf8'), fixture, 'A protected lock must remain unchanged.');
		}
		assert.throws(() => readFileSync(join(storage, 'worker-owner.lock')), { code: 'ENOENT' });
	} else {
		await runTests(testOptions);
	}
} catch (error) {
	for (const entry of readdirSync(userDataDirectory, { recursive: true })) {
		if (typeof entry === 'string' && entry.endsWith(`${join('weivea.copilot-agent-mesh', 'Copilot Agent Mesh.log')}`)) {
			console.error(readFileSync(join(userDataDirectory, entry), 'utf8').split(/\r?\n/u)
				.filter((line) => line.includes('"category":"startup"') || line.includes('"category":"window-node"'))
				.slice(-8).join('\n'));
		}
	}
	throw error;
} finally {
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function runCli(command, args) {
	try {
		const output = await runOwnedCommand(command, args, { timeoutMs: 120_000, maxOutputBytes: 8 * 1024 * 1024 });
		if (output) {
			process.stdout.write(output);
		}
		return output;
	} catch (error) {
		if (error instanceof OwnedCommandError && error.cleanupRequired && error.ownedCleanup !== undefined) {
			try {
				await error.ownedCleanup.dispose();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], 'VS Code CLI failed and native process cleanup remains unconfirmed.');
			}
		}
		throw error;
	}
}
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
