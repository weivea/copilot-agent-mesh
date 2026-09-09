import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

try {
	mkdirSync(userDataDirectory, { recursive: true });
	mkdirSync(extensionsDirectory, { recursive: true });
	mkdirSync(harnessDirectory, { recursive: true });
	writeFileSync(join(harnessDirectory, 'package.json'), JSON.stringify({
		name: 'mesh-preview-smoke-harness',
		displayName: 'Mesh Preview Smoke Harness',
		publisher: 'weivea',
		version: '0.0.0',
		engines: { vscode: '^1.103.0' },
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

	await runTests({
		vscodeExecutablePath,
		reuseMachineInstall: Boolean(process.env.VSCODE_EXECUTABLE_PATH),
		extensionDevelopmentPath: harnessDirectory,
		extensionTestsPath: join(scriptDirectory, 'activation-smoke-runner.cjs'),
		extensionTestsEnv: {
			...process.env,
			MESH_SMOKE_EXTENSIONS_DIR: extensionsDirectory,
			MESH_SMOKE_EXTENSION_VERSION: manifest.version,
		},
		launchArgs: [
			repositoryRoot,
			'--user-data-dir', userDataDirectory,
			'--extensions-dir', extensionsDirectory,
			'--disable-workspace-trust',
			'--skip-welcome',
			'--skip-release-notes',
		],
	});
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
