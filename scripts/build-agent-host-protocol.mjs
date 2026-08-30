#!/usr/bin/env node
// Builds the pinned `microsoft/agent-host-protocol` submodule into the
// `@microsoft/agent-host-protocol` package this extension links against.
//
// The upstream TypeScript client is not fully checked in: `clients/typescript/src/types`
// is generated from the canonical protocol sources under the upstream repository root.
// This script therefore runs upstream code generation and then compiles the client.

import { spawnSync } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const submoduleRoot = join(repositoryRoot, 'third_party', 'agent-host-protocol');
const clientRoot = join(submoduleRoot, 'clients', 'typescript');
const generatedTypes = join(clientRoot, 'src', 'types');
const distributionRoot = join(clientRoot, 'dist');
const entryPoint = join(distributionRoot, 'types', 'index.js');
const require = createRequire(import.meta.url);

const expectedCommit = 'f19dd8b3942d029744a3bdd31d830f9428e8ea47';
const expectedClientVersion = '0.9.0';
const expectedProtocolVersion = '1.0.0';

await main();

async function main() {
	await assertSubmoduleCheckedOut();
	const pinnedCommit = readPinnedCommit();
	if (pinnedCommit !== expectedCommit) {
		throw new Error(
			`Unexpected agent-host-protocol submodule commit ${pinnedCommit}; `
			+ `expected ${expectedCommit}.`,
		);
	}
	await rm(generatedTypes, { recursive: true, force: true });
	await rm(distributionRoot, { recursive: true, force: true });
	generateClientSources();
	compileClient();
	await assertBuiltClient();
	report('built', pinnedCommit);
}

async function assertSubmoduleCheckedOut() {
	try {
		await access(join(clientRoot, 'package.json'));
	} catch {
		throw new Error(
			'The agent-host-protocol submodule is not checked out. '
			+ 'Run: git submodule update --init --recursive',
		);
	}
}

function readPinnedCommit() {
	const result = spawnSync('git', ['-C', submoduleRoot, 'rev-parse', 'HEAD'], {
		encoding: 'utf8',
		shell: false,
	});
	if (result.status !== 0) {
		throw new Error('Unable to read the agent-host-protocol submodule commit.');
	}
	const status = spawnSync(
		'git',
		['-C', submoduleRoot, 'status', '--porcelain', '--untracked-files=normal'],
		{ encoding: 'utf8', shell: false },
	);
	if (status.status !== 0) {
		throw new Error('Unable to verify the agent-host-protocol submodule worktree.');
	}
	if (status.stdout.trim().length > 0) {
		throw new Error('The agent-host-protocol submodule has uncommitted source changes.');
	}
	return result.stdout.trim();
}

function generateClientSources() {
	run(
		process.execPath,
		[require.resolve('tsx/cli'), join(submoduleRoot, 'scripts', 'generate.ts'), '--typescript'],
		submoduleRoot,
		'Upstream agent-host-protocol TypeScript generation failed.',
	);
}

function compileClient() {
	run(
		process.execPath,
		[require.resolve('typescript/bin/tsc'), '-p', join(clientRoot, 'tsconfig.json')],
		clientRoot,
		'Compiling the agent-host-protocol TypeScript client failed.',
	);
}

function run(command, args, cwd, failureMessage) {
	const result = spawnSync(command, args, {
		cwd,
		shell: false,
		stdio: 'inherit',
		env: { ...process.env, NODE_OPTIONS: '' },
	});
	if (result.error !== undefined) {
		throw new Error(`${failureMessage} ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`${failureMessage} Exit code ${result.status ?? 'unknown'}.`);
	}
}

async function assertBuiltClient() {
	const supported = await readSupportedVersions();
	if (!supported.includes(expectedProtocolVersion)) {
		throw new Error(
			`The built agent-host-protocol client does not support AHP ${expectedProtocolVersion}; `
			+ `it advertises [${supported.join(', ')}].`,
		);
	}
	const declared = JSON.parse(await readFile(join(clientRoot, 'package.json'), 'utf8'));
	if (declared.version !== expectedClientVersion) {
		throw new Error(
			`Unexpected agent-host-protocol client version ${String(declared.version)}; `
			+ `expected ${expectedClientVersion}.`,
		);
	}
}

async function readSupportedVersions() {
	const module = await import(`${pathToFileURL(entryPoint).href}?t=${Date.now()}`);
	const supported = module.SUPPORTED_PROTOCOL_VERSIONS;
	if (!Array.isArray(supported) || supported.some((value) => typeof value !== 'string')) {
		throw new Error('The agent-host-protocol client did not export SUPPORTED_PROTOCOL_VERSIONS.');
	}
	return supported;
}

function report(action, commit) {
	console.log(JSON.stringify({
		package: '@microsoft/agent-host-protocol',
		action,
		commit,
		clientVersion: expectedClientVersion,
		protocolVersion: expectedProtocolVersion,
	}));
}
