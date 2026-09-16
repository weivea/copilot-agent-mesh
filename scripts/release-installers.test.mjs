import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareReleaseInstallers, writeReleaseInstallers } from './release-installers.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
const readme = (await readFile(join(repository, 'README.md'), 'utf8')).replaceAll('\r\n', '\n');
const powershellBootstrap = readme.match(/\*\*Windows[\s\S]*?```powershell\n([\s\S]*?)\n```/u)[1];
const bashBootstrap = readme.match(/\*\*macOS[\s\S]*?```bash\n([\s\S]*?)\n```/u)[1];
const installerNames = ['install.ps1', 'install.sh'];
const initialVersion = '0.5.1';
const version = '0.6.17';
const asset = `${manifest.name}-${version}-preview.vsix`;
const releaseUrl = `https://github.com/weivea/copilot-agent-mesh/releases/download/v${version}`;
const vsixContent = Buffer.from('Isolated installer test fixture, not a real extension.');
const checksum = `${createHash('sha256').update(vsixContent).digest('hex')}  ${asset}\n`;

test('preparing a new release changes only the two managed version lines', async (t) => {
	const fixture = await createFixture(t);
	const installers = await prepareReleaseInstallers(fixture.root, version);
	for (const installer of installers) {
		const original = await readFile(join(fixture.root, 'scripts', installer.name), 'utf8');
		assert.equal(installer.content, original.replace(initialVersion, version));
		assert.ok(original.includes(initialVersion), 'Preparation must not update the checked-in scripts before packaging succeeds.');
	}
});

test('writes matching versioned installers and checksums for both VSIX assets', async (t) => {
	const fixture = await createFixture(t);
	const installers = await prepareReleaseInstallers(fixture.root, version);
	const metadata = { ...manifest, version };
	await writeReleaseInstallers(fixture.root, metadata, installers);
	for (const installer of installers) {
		assert.equal(await readFile(join(fixture.root, 'scripts', installer.name), 'utf8'), installer.content);
		assert.equal(await readFile(join(fixture.root, 'artifacts', installer.name), 'utf8'), installer.content);
	}
	assert.equal(await readFile(join(fixture.root, 'artifacts', `${asset}.sha256`), 'utf8'), checksum);
	const companionAsset = `${manifest.name}-codespaces-${version}-preview.vsix`;
	assert.equal(await readFile(join(fixture.root, 'artifacts', `${companionAsset}.sha256`), 'utf8'),
		checksum.replace(asset, companionAsset));
	assert.deepEqual(await prepareReleaseInstallers(fixture.root, version), installers);
});

for (const invalidVersion of ['1.2.3-preview', '01.2.3', "1.2.3'; exit 0", '../1.2.3']) {
	test(`rejects an unsupported or unsafe release version: ${invalidVersion}`, async (t) => {
		const fixture = await createFixture(t);
		await assert.rejects(prepareReleaseInstallers(fixture.root, invalidVersion), /numeric major\.minor\.patch/u);
	});
}

for (const name of installerNames) {
	for (const markerState of ['missing', 'duplicate']) {
		test(`rejects a ${markerState} version marker in ${name}`, async (t) => {
			const fixture = await createFixture(t);
			const path = join(fixture.root, 'scripts', name);
			const source = await readFile(path, 'utf8');
			const marker = source.split('\n').find((line) =>
				line.startsWith('$ExtensionVersion =') || line.startsWith('EXTENSION_VERSION='));
			await writeFile(path, markerState === 'missing' ? source.replace(marker, '') : `${source}\n${marker}\n`);
			await assert.rejects(prepareReleaseInstallers(fixture.root, version), /exactly one managed extension version/u);
		});
	}
}

test('normalizes Windows checkout line endings in release scripts', async (t) => {
	const fixture = await createFixture(t);
	const path = join(fixture.root, 'scripts', 'install.sh');
	await writeFile(path, (await readFile(path, 'utf8')).replaceAll('\n', '\r\n'));
	const installers = await prepareReleaseInstallers(fixture.root, version);
	assert.ok(installers.every((installer) => !installer.content.includes('\r')));
});

test('missing VSIX assets do not advance the source installer versions', async (t) => {
	const fixture = await createFixture(t);
	await rm(join(fixture.root, 'artifacts', asset));
	const installers = await prepareReleaseInstallers(fixture.root, version);
	await assert.rejects(writeReleaseInstallers(fixture.root, { ...manifest, version }, installers), /ENOENT/u);
	for (const name of installerNames) {
		assert.ok((await readFile(join(fixture.root, 'scripts', name), 'utf8')).includes(initialVersion));
	}
});

for (const failure of ['', 'package', 'verify']) {
	test(`package entry point ${failure ? `preserves installers on ${failure} failure` : 'derives filenames and installer versions from package.json'}`, async (t) => {
		const fixture = await createFixture(t);
		await mkdir(join(fixture.root, 'companion'));
		await mkdir(join(fixture.root, 'node_modules', '@vscode', 'vsce'), { recursive: true });
		await writeFile(join(fixture.root, 'package.json'), JSON.stringify({ ...manifest, version }));
		await writeFile(join(fixture.root, 'companion', 'package.json'), JSON.stringify({ ...manifest, version }));
		for (const name of ['package-vsix.mjs', 'release-installers.mjs']) {
			await copyFile(join(repository, 'scripts', name), join(fixture.root, 'scripts', name));
		}
		await writeFile(join(fixture.root, 'scripts', 'verify-vsix.mjs'), `
			import assert from 'node:assert/strict';
			assert.equal(process.argv[2], ${JSON.stringify(join(fixture.root, 'artifacts', asset))});
			if (process.env.MESH_TEST_FAIL === 'verify') throw new Error('Mock verification failure');
		`);
		await writeFile(join(fixture.root, 'node_modules', '@vscode', 'vsce', 'package.json'),
			JSON.stringify({ type: 'module', exports: './index.js' }));
		await writeFile(join(fixture.root, 'node_modules', '@vscode', 'vsce', 'index.js'), `
			import assert from 'node:assert/strict';
			import { writeFile } from 'node:fs/promises';
			export async function createVSIX(options) {
				assert.deepEqual(options, {
					cwd: ${JSON.stringify(fixture.root)},
					packagePath: ${JSON.stringify(join(fixture.root, 'artifacts', asset))},
					dependencies: false,
					preRelease: true,
				});
				if (process.env.MESH_TEST_FAIL === 'package') throw new Error('Mock packaging failure');
				await writeFile(options.packagePath, 'Packaged main VSIX fixture');
			}
		`);
		const result = spawnSync(process.execPath, [join(fixture.root, 'scripts', 'package-vsix.mjs')], {
			env: { ...process.env, MESH_TEST_FAIL: failure },
			encoding: 'utf8',
			timeout: 30_000,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status === 0, !failure, result.stderr);
		for (const name of installerNames) {
			const source = await readFile(join(fixture.root, 'scripts', name), 'utf8');
			assert.ok(source.includes(failure ? initialVersion : version));
		}
	});
}

const runtimes = [
	{ name: 'macOS bash', shell: 'bash', script: 'install.sh' },
	...(process.platform === 'win32'
		? [
			{ name: 'Windows PowerShell', shell: 'powershell.exe', script: 'install.ps1' },
			{ name: 'PowerShell 7', shell: 'pwsh.exe', script: 'install.ps1' },
		]
		: []),
];
const scenarios = [
	{ name: 'installs the exact version using a CLI path with spaces', failure: '', installed: true },
	{ name: 'discovers the CLI on PATH', failure: 'path', installed: true },
	{ name: 'installs through the exact README bootstrap command', failure: 'bootstrap', installed: true },
	{ name: 'does not execute a failed or partial bootstrap download', failure: 'bootstrap-download', error: /Download failed/u },
	{ name: 'stops before downloading when the CLI is missing', failure: 'cli', error: /CLI was not found/u },
	{ name: 'stops on a missing checksum asset', failure: 'checksum-download', error: /Download failed/u },
	{ name: 'stops on a partial VSIX download', failure: 'download', error: /Download failed/u },
	{ name: 'rejects malformed checksum data', failure: 'malformed-checksum', error: /checksum file is invalid/u },
	{ name: 'rejects a checksum naming another asset', failure: 'wrong-asset', error: /checksum/i },
	{ name: 'rejects a corrupted VSIX', failure: 'mismatch', error: /SHA-256 checksum does not match/u },
	{ name: 'reports a failed installation', failure: 'install', error: /installation failed/u, installed: true },
	{ name: 'reports a failed installed-version query', failure: 'list', error: /verify the installed extension/u, installed: true },
	{ name: 'rejects a successful CLI exit without the requested installed version', failure: 'missing-version', error: /did not report/u, installed: true },
];

for (const runtime of runtimes) {
	const probe = spawnSync(runtime.shell, runtime.script === 'install.sh' ? ['--version'] : ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'], {
		encoding: 'utf8',
		timeout: 30_000,
	});
	for (const scenario of scenarios) {
		test(`${runtime.name}: ${scenario.name}`, { skip: probe.error?.code === 'ENOENT' ? `${runtime.shell} is not installed` : false }, async (t) => {
			assert.equal(probe.status, 0, probe.stderr);
			const fixture = await createFixture(t);
			const installers = await prepareReleaseInstallers(fixture.root, version);
			for (const installer of installers) {
				await writeFile(join(fixture.root, 'scripts', installer.name), installer.content);
			}
			const result = runInstaller(runtime, scenario.failure, fixture);
			assert.equal(result.error, undefined, result.error?.message);
			const output = `${result.stdout}\n${result.stderr}`;
			assert.equal(result.status === 0, !scenario.error, output);
			if (scenario.error) {
				assert.match(output, scenario.error);
				assert.doesNotMatch(output, /Installed weivea\.copilot-agent-mesh@/u);
				assert.doesNotMatch(output, /UNEXPECTED BOOTSTRAP EXECUTION/u);
			} else {
				assert.match(output, new RegExp(`Installed weivea\\.copilot-agent-mesh@${version.replaceAll('.', '\\.')}`, 'u'));
			}
			const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
			const installs = calls.filter((call) => call.tool === 'code' && call.args[0] === '--install-extension');
			assert.equal(installs.length, scenario.installed ? 1 : 0, output);
			if (installs.length) {
				assert.equal(installs[0].existsAtInstall, true);
				assert.equal(installs[0].args[2], '--force');
				assert.ok(installs[0].args[1].endsWith(asset));
			}
			const downloads = calls.filter((call) => call.tool === 'download');
			assert.deepEqual(downloads.map((call) => call.url),
				['cli', 'bootstrap-download'].includes(scenario.failure) ? [] : scenario.failure === 'checksum-download'
					? [`${releaseUrl}/${asset}.sha256`]
					: [`${releaseUrl}/${asset}.sha256`, `${releaseUrl}/${asset}`]);
			assert.deepEqual(await readdir(fixture.temporary), [], 'The installer must remove only its temporary download directory on every exit.');
		});
	}
}

async function createFixture(t) {
	const root = await mkdtemp(join(tmpdir(), 'mesh installer test '));
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
	const bin = join(root, 'mock bin');
	const temporary = join(root, 'temporary downloads');
	const log = join(root, 'calls.jsonl');
	for (const directory of [bin, temporary, join(root, 'scripts'), join(root, 'artifacts')]) {
		await mkdir(directory, { recursive: true });
	}
	for (const installer of await prepareReleaseInstallers(repository, initialVersion)) {
		await writeFile(join(root, 'scripts', installer.name), installer.content);
	}
	await writeFile(join(root, 'bootstrap.sh'), `${bashBootstrap}\n`);
	await writeFile(log, '');
	await writeFile(join(root, 'asset.vsix'), vsixContent);
	await writeFile(join(root, 'asset.sha256'), checksum);
	for (const name of [manifest.name, `${manifest.name}-codespaces`]) {
		await writeFile(join(root, 'artifacts', `${name}-${version}-preview.vsix`), vsixContent);
	}
	const mock = join(root, 'mock.cjs');
	await writeFile(mock, `
		const fs = require('node:fs');
		const path = require('node:path');
		const crypto = require('node:crypto');
		const [tool, ...args] = process.argv.slice(2);
		const root = process.env.MESH_TEST_ROOT;
		const failure = process.env.MESH_TEST_FAIL;
		const record = (value) => fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(value) + '\\n');
		if (tool === 'uname') {
			console.log('Darwin');
		} else if (tool === 'curl') {
			const url = args.at(-1);
			if (url.endsWith('/scripts/install.sh')) {
				if (failure === 'bootstrap-download') {
					console.log("echo 'UNEXPECTED BOOTSTRAP EXECUTION'");
					console.error('Download failed');
					process.exit(22);
				}
				process.stdout.write(fs.readFileSync(path.join(root, 'scripts', 'install.sh')));
				process.exit(0);
			}
			const out = args[args.indexOf('--output') + 1];
			record({ tool: 'download', url });
			const isChecksum = url.endsWith('.sha256');
			if ((failure === 'download' && !isChecksum) || (failure === 'checksum-download' && isChecksum)) {
				fs.writeFileSync(out, 'partial download');
				console.error('Download failed');
				process.exit(22);
			}
			let content = fs.readFileSync(path.join(root, isChecksum ? 'asset.sha256' : 'asset.vsix'));
			if (isChecksum && failure === 'malformed-checksum') content = 'invalid';
			if (isChecksum && failure === 'wrong-asset') content = content.toString().replace('${asset}', 'other.vsix');
			if (!isChecksum && failure === 'mismatch') content = 'corrupted download';
			fs.writeFileSync(out, content);
		} else if (tool === 'shasum') {
			console.log(crypto.createHash('sha256').update(fs.readFileSync(args.at(-1))).digest('hex') + '  ' + args.at(-1));
		} else if (tool === 'code') {
			record({ tool, args, existsAtInstall: args[0] === '--install-extension' && fs.existsSync(args[1]) });
			if (args[0] === '--install-extension' && failure === 'install') process.exit(17);
			if (args[0] === '--list-extensions') {
				if (failure === 'list') process.exit(18);
				console.log(failure === 'missing-version' ? 'other.extension@1.0.0' : 'weivea.copilot-agent-mesh@${version}');
			}
		} else {
			throw new Error('Unexpected mock command: ' + tool);
		}
	`);
	for (const tool of ['uname', 'curl', 'shasum', 'code', 'mock code']) {
		await writeFile(join(bin, tool), `#!/bin/bash\nexec "${shellPath(process.execPath)}" "${shellPath(mock)}" "${tool === 'mock code' ? 'code' : tool}" "$@"\n`, { mode: 0o755 });
	}
	for (const name of ['code.cmd', 'mock code.cmd']) {
		await writeFile(join(bin, name), `@echo off\r\n"${process.execPath}" "${mock}" code %*\r\n`);
	}
	await writeFile(join(root, 'run.ps1'), `
		$ErrorActionPreference = 'Stop'
		function Invoke-WebRequest {
			[CmdletBinding()]
			param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec)
			if ($Uri.EndsWith('/scripts/install.ps1')) {
				if ($env:MESH_TEST_FAIL -eq 'bootstrap-download') { throw 'Download failed' }
				return [pscustomobject]@{ Content = [IO.File]::ReadAllText((Join-Path $env:MESH_TEST_ROOT 'scripts\\install.ps1')) }
			}
			& '${process.execPath.replaceAll("'", "''")}' '${mock.replaceAll("'", "''")}' curl --output $OutFile $Uri
			if ($LASTEXITCODE -ne 0) { throw 'Download failed' }
		}
		$arguments = @{}
		if ($env:MESH_TEST_FAIL -ne 'path') {
			$arguments.CodePath = $env:MESH_TEST_CODE
		}
		if ($env:MESH_TEST_FAIL -like 'bootstrap*') {
			${powershellBootstrap}
		} else {
			& (Join-Path $env:MESH_TEST_ROOT 'scripts\\install.ps1') @arguments
		}
	`);
	return { root, bin, temporary, log };
}

function runInstaller(runtime, failure, fixture) {
	const isBash = runtime.script === 'install.sh';
	const code = join(fixture.bin, failure === 'cli' ? 'missing-cli' : isBash ? 'mock code' : 'mock code.cmd');
	const env = {
		...process.env,
		PATH: `${fixture.bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
		MESH_TEST_ROOT: fixture.root,
		MESH_TEST_BIN: shellPath(fixture.bin),
		MESH_TEST_FAIL: failure,
		MESH_TEST_CODE: code,
		TMP: fixture.temporary,
		TEMP: fixture.temporary,
		TMPDIR: shellPath(fixture.temporary),
	};
	// Native PowerShell 5.1 cannot load modules inherited from a PowerShell 7 host.
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === 'PSMODULEPATH') {
			delete env[key];
		}
	}
	const args = isBash
		? ['-c', 'export PATH="$MESH_TEST_BIN:$PATH"; script="$1"; shift; source "$script"', 'installer-test',
			shellPath(failure.startsWith('bootstrap') ? join(fixture.root, 'bootstrap.sh') : join(fixture.root, 'scripts', runtime.script)),
			...(failure === 'path' || failure.startsWith('bootstrap') ? [] : [shellPath(code)])]
		: ['-NoProfile', '-NonInteractive', '-File', join(fixture.root, 'run.ps1')];
	return spawnSync(runtime.shell, args, { env, encoding: 'utf8', timeout: 30_000 });
}

function shellPath(path) {
	const normalized = path.replaceAll('\\', '/');
	return process.platform === 'win32'
		? normalized.replace(/^([a-z]):/iu, (_, drive) => `/${drive.toLowerCase()}`)
		: normalized;
}
