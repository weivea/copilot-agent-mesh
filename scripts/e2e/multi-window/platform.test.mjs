import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	assertNoPathAliases,
	assertProfileIdle,
	commandContainsPath,
	guiEnvironment,
	ipcEndpointAbsent,
	parseWindowsProcessTable,
	pathKey,
	pathsOverlap,
	resolveCodeCommand,
	resolveNpmCommand,
	supportsWorker,
} from './platform.mjs';

test('Worker matrix accepts Windows x64/ARM64 and retains macOS arm64 only', () => {
	for (const [platform, architecture, supported] of [
		['win32', 'x64', true], ['win32', 'arm64', true], ['win32', 'ia32', false],
		['darwin', 'arm64', true], ['darwin', 'x64', false], ['linux', 'x64', false],
	]) {
		assert.equal(supportsWorker(platform, architecture), supported);
	}
});

test('Windows profile comparisons normalize case and separators without prefix confusion', () => {
	assert.equal(pathKey('C:/Users/Example/Profile', 'win32'), 'c:\\users\\example\\profile');
	assert.equal(pathsOverlap('C:\\Users\\Example\\Profile', 'c:/users/example/PROFILE/User', 'win32'), true);
	assert.equal(pathsOverlap('C:\\Profile', 'C:\\Profile-other', 'win32'), false);
	assert.equal(commandContainsPath('"Code.exe" --user-data-dir="C:/Users/EXAMPLE/Profile"',
		'c:\\users\\example\\profile', 'win32'), true);
});

test('bounded Windows metadata parsing handles null commands and rejects malformed PIDs', () => {
	const entries = parseWindowsProcessTable(JSON.stringify([
		{ ProcessId: 10, ParentProcessId: 2, CommandLine: '"Code.exe" --user-data-dir=C:\\dedicated', ExecutablePath: 'C:\\Code.exe' },
		{ ProcessId: 0, ParentProcessId: 0, CommandLine: null, ExecutablePath: null },
	]));
	assert.equal(entries[0].processGroupId, 0);
	assert.equal(entries[0].parentPid, 2);
	assert.equal(entries[1].command, '');
	assert.throws(() => parseWindowsProcessTable('{"ProcessId":"10","ParentProcessId":2,"CommandLine":"x"}'));
	assert.throws(() => parseWindowsProcessTable('{"ProcessId":-1,"ParentProcessId":2,"CommandLine":"x"}'));
	assert.throws(() => parseWindowsProcessTable('not JSON'));
});

test('existing-profile inspection never grants process ownership or returns command details', () => {
	const profile = join(process.cwd(), 'dedicated profile');
	const command = `"Code" --user-data-dir="${profile}" --secret=do-not-print`;
	assert.throws(
		() => assertProfileIdle([{ pid: 123, command }], profile, 456),
		(error) => error.code === 'PROFILE_IN_USE' && !error.message.includes('do-not-print'),
	);
	assert.doesNotThrow(() => assertProfileIdle([{ pid: 456, command }], profile, 456));
	assert.doesNotThrow(() => assertProfileIdle([{ pid: 123, command: '"Code" --other' }], profile, 456));
});

test('native CLI execution preserves argument boundaries without a shell', async () => {
	const args = ['--user-data-dir', 'C:\\profiles\\with spaces & %PATH% !'];
	const command = await resolveCodeCommand(process.execPath, args);
	assert.equal(command.executable, process.execPath);
	assert.deepEqual(command.args, args);
	const npm = await resolveNpmCommand(['--version']);
	assert.equal(/\.(cmd|bat)$/iu.test(npm.executable), false);
});

test('GUI launches remove inherited Electron Node mode without mutating parent environment', () => {
	const environment = { ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', KEEP: 'yes' };
	assert.deepEqual(guiEnvironment(environment), { KEEP: 'yes' });
	assert.equal(environment.ELECTRON_RUN_AS_NODE, '1');
});

test('GUI providers do not inherit command-scoped Git configuration or its empty-value dependencies', () => {
	const environment = {
		GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
		GIT_CONFIG_PARAMETERS: 'command-local values', GIT_CONFIG_GLOBAL: 'C:\\user-config', KEEP: 'yes',
	};
	assert.deepEqual(guiEnvironment(environment), { GIT_CONFIG_GLOBAL: 'C:\\user-config', KEEP: 'yes' });
	assert.equal(environment.GIT_CONFIG_COUNT, '1');
	assert.equal(environment.GIT_CONFIG_VALUE_0, '');
});

test('profile mutation rejects directory junctions and hard-linked settings', async () => {
	const root = join(process.cwd(), '.vscode-test', `harness-path-${randomUUID()}`);
	const target = join(root, 'target');
	const alias = join(root, 'alias');
	await mkdir(target, { recursive: true });
	try {
		await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
		await assert.rejects(assertNoPathAliases(join(alias, 'User', 'settings.json')));
		const settings = join(target, 'settings.json');
		await writeFile(settings, '{}\n');
		await link(settings, join(root, 'settings-copy.json'));
		await assert.rejects(assertNoPathAliases(settings));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('Windows pipe cleanup observes a live endpoint rather than assuming removal', {
	skip: process.platform !== 'win32',
}, async () => {
	const endpoint = { platform: 'win32', address: `\\\\.\\pipe\\mesh-harness-test-${randomUUID()}` };
	const server = createServer((client) => client.destroy());
	try {
		await new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(endpoint.address, resolve);
		});
		assert.equal(await ipcEndpointAbsent(endpoint), false);
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
	assert.equal(await ipcEndpointAbsent(endpoint), true);
	await assert.rejects(ipcEndpointAbsent({ platform: 'win32', address: 'not-a-pipe' }));
});
