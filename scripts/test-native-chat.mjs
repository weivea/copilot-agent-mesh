import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, 'out'), { recursive: true });
const temporary = await mkdtemp(join(root, 'out', 'native-chat-test-'));
const profile = join(temporary, 'user-data');
const extension = join(temporary, 'extensions', 'native-chat-fixture');
const harness = join(temporary, 'test-harness');
const workspace = join(temporary, 'workspace');
const home = join(temporary, 'home');
const manifest = JSON.parse(await readFile(join(root, 'companion', 'package.json'), 'utf8'));
const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH
	?? await downloadAndUnzipVSCode('1.137.0');
try {
	await mkdir(extension, { recursive: true });
	await mkdir(harness);
	await writeFile(join(harness, 'package.json'), JSON.stringify({
		name: 'mesh-native-chat-test-runner', publisher: 'weivea', version: '0.0.0',
		engines: { vscode: '^1.137.0' }, main: './extension.cjs',
	}));
	await writeFile(join(harness, 'extension.cjs'), 'exports.activate = () => undefined;\n');
	await writeFile(join(harness, 'runner.cjs'), [
		"const vscode = require('vscode');",
		`exports.run = async () => { await vscode.extensions.getExtension(${JSON.stringify(`${manifest.publisher}.${manifest.name}`)}).activate(); await vscode.commands.executeCommand('copilotAgentMesh.test.nativeChat.run'); };`,
	].join('\n'));
	await mkdir(workspace);
	await mkdir(join(home, '.vscode'), { recursive: true });
	await writeFile(join(home, '.vscode', 'argv.json'), [
		'// Preserve the user runtime configuration.',
		'{',
		'  "disable-hardware-acceleration": true,',
		'  "enable-proposed-api": ["example.existing"]',
		'}',
	].join('\n'));
	await mkdir(join(profile, 'User'), { recursive: true });
	await writeFile(join(profile, 'User', 'settings.json'), JSON.stringify({
		'workbench.startupEditor': 'none',
		'workbench.enableExperiments': false,
		'telemetry.telemetryLevel': 'off',
		'chat.disableAIFeatures': false,
	}));
	await writeFile(join(extension, 'package.json'), JSON.stringify({
		...manifest,
		main: './extension.js',
		activationEvents: ['onStartupFinished'],
		contributes: {
			...manifest.contributes,
			chatSessions: manifest.contributes.chatSessions.map((session) => ({ ...session, when: '!isWeb' })),
		},
	}));
	await build({
		entryPoints: [join(root, 'src', 'nativeChatTest', 'index.ts')],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		outfile: join(extension, 'extension.js'),
		external: ['vscode'],
		alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
		logLevel: 'warning',
	});
	for (const phase of ['configure', 'live', 'restored', 'service', 'service-restored']) {
		const port = await freePort();
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: harness,
			extensionTestsPath: join(harness, 'runner.cjs'),
			extensionTestsEnv: {
				HOME: home,
				USERPROFILE: home,
				VSCODE_PORTABLE: '',
				CAM_NATIVE_CHAT_TEST_ROOT: temporary,
				CAM_NATIVE_CHAT_TEST_PHASE: phase,
				CAM_NATIVE_CHAT_TEST_PORT: String(port),
			},
			launchArgs: [
				workspace,
				`--user-data-dir=${profile}`,
				`--extensions-dir=${join(temporary, 'extensions')}`,
				`--remote-debugging-port=${port}`,
				'--skip-welcome',
				'--skip-release-notes',
				'--disable-workspace-trust',
			],
		});
	}
	const live = JSON.parse(await readFile(join(temporary, 'live.json'), 'utf8'));
	const configure = JSON.parse(await readFile(join(temporary, 'configure.json'), 'utf8'));
	const restored = JSON.parse(await readFile(join(temporary, 'restored.json'), 'utf8'));
	const service = JSON.parse(await readFile(join(temporary, 'service.json'), 'utf8'));
	const serviceRestored = JSON.parse(await readFile(join(temporary, 'service-restored.json'), 'utf8'));
	assert.equal(live.passed, true);
	assert.equal(configure.passed, true);
	assert.equal(restored.passed, true);
	assert.equal(service.passed, true);
	assert.equal(serviceRestored.passed, true);
	await mkdir(join(root, 'artifacts'), { recursive: true });
	const evidence = join(root, 'artifacts', `codespaces-native-chat-${manifest.version}.json`);
	await writeFile(evidence, JSON.stringify({
		scope: 'Real desktop persistent permission setup without a proposed-API launch flag, then native Chat rendering and history restart with synthetic tasks. Temporary home/profile only; no Codespace connection, authentication or model call.',
		version: manifest.version,
		configure, live, restored, service, serviceRestored,
	}, null, 2));
	console.log(`Native Chat UI and restart-history checks passed: ${evidence}`);
} finally {
	await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function freePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return address.port;
}
