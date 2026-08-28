import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	downloadAndUnzipVSCode,
	resolveCliArgsFromVSCodeExecutablePath,
	runTests,
} from '@vscode/test-electron';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const vsixPath = resolve(process.argv[2] ?? join(repositoryRoot, 'artifacts/copilot-agent-mesh-0.2.0-preview.vsix'));
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
		reuseMachineInstall: Boolean(process.env.VSCODE_EXECUTABLE_PATH),
	});

	runCli(cli, [
		...cliPrefix,
		'--user-data-dir', userDataDirectory,
		'--extensions-dir', extensionsDirectory,
		'--install-extension', vsixPath,
		'--force',
	]);
	const listing = runCli(cli, [
		...cliPrefix,
		'--user-data-dir', userDataDirectory,
		'--extensions-dir', extensionsDirectory,
		'--list-extensions',
		'--show-versions',
	]);
	if (!listing.split(/\r?\n/u).includes('weivea.copilot-agent-mesh@0.2.0')) {
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
	rmSync(root, { recursive: true, force: true });
}

function runCli(command, args) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		shell: process.platform === 'win32',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.status !== 0) {
		throw new Error(`VS Code CLI failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
	}
	if (result.stdout) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr) {
		process.stderr.write(result.stderr);
	}
	return result.stdout;
}
