import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInThisContext } from 'node:vm';

import { AgentHostLauncher } from '../agentHost/AgentHostLauncher';
import { deriveEditorAgentHostUserDataDir, EditorAgentHostLocator } from '../agentHost/EditorAgentHostLocator';
import { OwnedCommandError, runOwnedCommand, terminateOwnedProcessGroup } from '../spikes/ownedProcess';
import { resolveWindowsCommand } from '../spikes/windowsCodeCli';
import { WindowsOwnedProcess, windowsProcessHostPath } from '../spikes/windowsProcessHost';

const windows = { skip: process.platform !== 'win32', timeout: 30_000 };
const repository = resolve(__dirname, '..', '..', '..');

test('Windows helper lookup supports bundled, compiled and direct TypeScript layouts without cwd', windows, () => {
	const bundled = windowsProcessHostPath(process.arch, join(repository, 'dist'));
	assert.equal(bundled, windowsProcessHostPath(process.arch, join(repository, 'out', 'src', 'spikes')));
	assert.equal(bundled, windowsProcessHostPath(process.arch, join(repository, 'src', 'spikes')));
	assert.throws(() => windowsProcessHostPath('ia32'), /x64 or ARM64/u);
	assert.throws(() => windowsProcessHostPath('x64', join(repository, 'missing', 'module')), /missing/u);
});

test('Windows helper assets declare their advertised x64 and ARM64 PE machine identities', async () => {
	for (const [architecture, machine] of [['x64', 0x8664], ['arm64', 0xaa64]] as const) {
		const binary = await readFile(join(repository, 'dist', 'windows', `mesh-process-host-${architecture}.exe`));
		assert.ok(binary.length >= 64);
		assert.equal(binary.readUInt16LE(0), 0x5a4d);
		const offset = binary.readUInt32LE(0x3c);
		assert.ok(offset >= 64 && offset <= binary.length - 6);
		assert.equal(binary.readUInt32LE(offset), 0x00004550);
		assert.equal(binary.readUInt16LE(offset + 4), machine, `${architecture} PE machine must match its VSIX asset name`);
	}
});

test('Windows renamed native sentinel records execution without launching a controller or recording arguments', windows, async () => {
	await withFixture(async (root) => {
		const sentinel = join(root, 'mesh-e2e-sentinel.exe');
		const marker = join(root, 'devtunnel-invoked.json');
		await copyFile(windowsProcessHostPath(), sentinel);
		for (const args of [['--version'], ['--auth-token=must-not-be-recorded', '参数 with spaces']]) {
			await assert.rejects(runOwnedCommand(sentinel, args, { timeoutMs: 5_000 }), /exited with 97/u);
			const evidence = JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown>;
			assert.deepEqual(Object.keys(evidence).sort(), ['invoked', 'pid']);
			assert.equal(evidence.invoked, true);
			assert.ok(typeof evidence.pid === 'number' && Number.isSafeInteger(evidence.pid) && evidence.pid > 0);
			assert.equal(alive(evidence.pid), false);
		}
		await rm(marker);
		await mkdir(marker);
		await assert.rejects(runOwnedCommand(sentinel, [], { timeoutMs: 5_000 }), /exited with 98/u);
	});
});

test('Windows source loading through the existing tsx API executes owned commands without cwd-dependent assets', windows, async () => {
	const { require: requireTypeScript } = await import('tsx/cjs/api');
	const source = requireTypeScript(
		join(repository, 'src', 'spikes', 'ownedProcess.ts'),
		pathToFileURL(join(repository, 'scripts', 'smoke-vsix.mjs')).href,
	) as typeof import('../spikes/ownedProcess');
	assert.equal(await source.runOwnedCommand(process.execPath, ['-e', 'process.stdout.write("source")'], {
		timeoutMs: 5_000,
	}), 'source');
});

test('Windows bundled runtime executes with the actual dist extension module directory', windows, async () => {
	const { build } = await import('esbuild');
	const filename = join(repository, 'dist', 'extension.js');
	const bundled = await build({
		entryPoints: [join(repository, 'src', 'spikes', 'ownedProcess.ts')],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		write: false,
	});
	const module = { exports: {} as typeof import('../spikes/ownedProcess') };
	const load = runInThisContext(
		`(function(require,module,exports,__dirname,__filename) {${bundled.outputFiles[0]!.text}\n})`,
		{ filename },
	);
	load(createRequire(filename), module, module.exports, dirname(filename), filename);
	assert.equal(await module.exports.runOwnedCommand(process.execPath, ['-e', 'process.stdout.write("bundled")'], {
		timeoutMs: 5_000,
	}), 'bundled');
});

test('Windows commands preserve spaces, Unicode, quotes, empty and metacharacter arguments', windows, async () => {
	const args = ['', 'hello 世界', 'space directory\\', 'quote"inside', '\\\\"quoted\\"', '%PATH% & calc | x > y', 'C:\\a b\\目录\\'];
	const output = await runOwnedCommand(process.execPath, [
		'-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args,
	], { timeoutMs: 5_000 });
	assert.deepEqual(JSON.parse(output), args);
	await assert.rejects(
		runOwnedCommand(process.execPath, ['-e', 'process.exit(37)'], { timeoutMs: 5_000 }),
		/exited with 37/u,
	);
});

test('Windows timeout, cancellation and output bounds clean the owned job without exposing child output', windows, async () => {
	for (const action of ['timeout', 'cancel', 'output'] as const) {
		const controller = new AbortController();
		const command = runOwnedCommand(process.execPath, ['-e', action === 'output'
			? 'process.stdout.write("secret-token".repeat(50000));setInterval(()=>{},1000)'
			: 'setInterval(()=>{},1000)'], {
			timeoutMs: action === 'timeout' ? 150 : 5_000,
			maxOutputBytes: 1024,
			signal: controller.signal,
		});
		if (action === 'cancel') {
			setTimeout(() => controller.abort(), 100);
		}
		await assert.rejects(command, (error: unknown) => {
			assert.ok(error instanceof OwnedCommandError);
			assert.equal(error.cleanupRequired, false);
			assert.doesNotMatch(error.message, /secret-token/u);
			assert.match(error.message, action === 'timeout' ? /timed out/u : action === 'cancel' ? /cancelled/u : /output limit/u);
			return true;
		});
	}
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		runOwnedCommand(join(repository, 'missing.exe'), [], { timeoutMs: 100, signal: controller.signal }),
		/cancelled before starting/u,
	);
	await assert.rejects(terminateOwnedProcessGroup(123, 1), /Job Object controller/u);
	await assert.rejects(
		runOwnedCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(50000))'], {
			timeoutMs: 5_000, maxOutputBytes: 1024,
		}),
		/output limit/u,
	);
});

test('Windows exact Job Object ownership includes grandchildren and repeated disposal kills every owned member', windows, async () => {
	const child = new WindowsOwnedProcess(process.execPath, ['-e', treeSource(false)]);
	let helperClosed = false;
	child.once('close', () => { helperClosed = true; });
	child.stdout.resume();
	child.stderr.resume();
	const readSnapshot = () => child.ownedPidSnapshot;
	try {
		assert.equal(readSnapshot(), undefined);
		await child.started;
		assert.equal(readSnapshot(), undefined);
		const pids = await waitForPids(child, 3);
		assert.ok(pids.has(child.pid!));
		const snapshot = child.ownedPidSnapshot;
		assert.deepEqual(snapshot, pids);
		assert.ok(snapshot instanceof Set);
		snapshot.clear();
		assert.deepEqual(child.ownedPidSnapshot, pids);
		const returnedPids = await child.ownedPids();
		returnedPids.clear();
		assert.deepEqual(child.ownedPidSnapshot, pids);
		await Promise.all([child.dispose(), child.dispose()]);
		await child.dispose();
		assert.equal(helperClosed, true, 'disposal must await the helper process and its own pipes closing');
		assert.equal(child.cleanupConfirmed, true);
		assert.deepEqual(child.ownedPidSnapshot, new Set());
		for (const pid of pids) {
			assert.equal(alive(pid), false);
		}
		assert.deepEqual(await child.ownedPids(), new Set());
	} finally {
		await child.dispose();
	}
});

test('Windows root exit cleans surviving descendants even when they inherit stdout/stderr', windows, async () => {
	const output = await runOwnedCommand(process.execPath, ['-e', treeSource(true)], { timeoutMs: 5_000 });
	const pids = JSON.parse(output.trim()) as number[];
	assert.equal(pids.length, 3);
	for (const pid of pids) {
		assert.equal(alive(pid), false);
	}
	const failing = new WindowsOwnedProcess(process.execPath, [
		'-e', treeSource(true).replace('process.exit(0)', 'process.exit(7)'),
	]);
	let failureOutput = '';
	failing.stdout.on('data', (chunk: Buffer) => { failureOutput += chunk.toString('utf8'); });
	failing.stderr.resume();
	try {
		assert.equal(await failing.completion, 7);
		for (const pid of JSON.parse(failureOutput) as number[]) {
			assert.equal(alive(pid), false);
		}
	} finally {
		await failing.dispose();
	}
});

test('Windows failed native startup is clean and never surfaces arguments', windows, async () => {
	const child = new WindowsOwnedProcess(join(repository, 'missing.exe'), ['secret-token']);
	let helperClosed = false;
	child.once('close', () => { helperClosed = true; });
	child.stdout.resume();
	child.stderr.resume();
	await assert.rejects(child.started, /helper_operation_failed/u);
	await child.dispose();
	assert.equal(helperClosed, true);
	assert.equal(child.cleanupConfirmed, true);
	const missingHelper = new WindowsOwnedProcess(process.execPath, [], { helperPath: join(repository, 'missing-helper.exe') });
	let missingHelperClosed = false;
	missingHelper.once('close', () => { missingHelperClosed = true; });
	await assert.rejects(missingHelper.started, /helper_spawn_failed/u);
	await missingHelper.dispose();
	assert.equal(missingHelperClosed, true);
	assert.equal(missingHelper.cleanupConfirmed, true);
});

test('Windows child stdout and stderr cannot spoof the controller cleanup protocol', windows, async () => {
	const stdout = JSON.stringify({ type: 'exit', code: 0, cleanupConfirmed: true }) + '\n';
	const stderr = JSON.stringify({ type: 'error', code: 'launch_failed', cleanupConfirmed: true }) + '\n';
	const child = new WindowsOwnedProcess(process.execPath, ['-e', `
		process.stdout.write(${JSON.stringify(stdout)});
		process.stderr.write(${JSON.stringify(stderr)});
		setInterval(()=>{},1000);
	`]);
	let actualStdout = '';
	let actualStderr = '';
	child.stdout.on('data', (chunk: Buffer) => { actualStdout += chunk.toString('utf8'); });
	child.stderr.on('data', (chunk: Buffer) => { actualStderr += chunk.toString('utf8'); });
	try {
		await child.started;
		await waitUntil(() => actualStdout === stdout && actualStderr === stderr);
		assert.equal(child.cleanupConfirmed, false);
		assert.equal(child.exitCode, null);
		assert.ok((await child.ownedPids()).has(child.pid!));
	} finally {
		await child.dispose();
	}
	assert.equal(alive(child.pid!), false);
});

test('Windows parent death closes the private control pipe and kills the exact child job', windows, async () => {
	const modulePath = join(repository, 'out', 'src', 'spikes', 'windowsProcessHost.js');
	const owner = spawn(process.execPath, ['-e', `
		const { WindowsOwnedProcess } = require(${JSON.stringify(modulePath)});
		const child = new WindowsOwnedProcess(process.execPath, ['-e', ${JSON.stringify(treeSource(false))}]);
		child.stdout.resume(); child.stderr.resume();
		child.started.then(async () => {
			let pids;
			do { pids = [...await child.ownedPids()]; await new Promise(r=>setTimeout(r,10)); } while(pids.length < 3);
			process.stdout.write(JSON.stringify(pids)+'\\n');
		});
	`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
	let pids: number[] = [];
	try {
		const output = await firstLine(owner.stdout!);
		pids = JSON.parse(output) as number[];
		const closed = once(owner, 'exit');
		owner.kill();
		await closed;
		await waitUntil(() => pids.every((pid) => !alive(pid)));
	} finally {
		if (owner.exitCode === null && owner.signalCode === null) {
			owner.kill();
		}
		owner.stdout?.destroy();
		owner.stderr?.destroy();
	}
});

test('Windows helper rejects truncated and oversized control frames without starting a child', windows, async () => {
	for (const input of ['{"type":"start"', 'x'.repeat(1024 * 1024 + 1)]) {
		const helper = spawn(windowsProcessHostPath(), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		helper.stdin.on('error', () => {});
		helper.stdout.resume();
		helper.stderr.resume();
		const closed = once(helper, 'close');
		helper.stdin.end(input);
		const [code] = await closed;
		assert.equal(code, 1);
	}
});

test('Windows VS Code cmd resolution is literal, version-layout aware, and rejects shell injection', windows, async () => {
	await withFixture(async (root) => {
		const cli = join(root, '版本 build', 'resources', 'app', 'out', 'cli.js');
		await mkdir(join(root, 'bin'), { recursive: true });
		await mkdir(resolve(cli, '..'), { recursive: true });
		await writeFile(cli, '');
		await copyFile(process.execPath, join(root, 'Code.exe'));
		const batch = join(root, 'bin', 'code.cmd');
		await writeFile(batch, '@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\版本 build\\resources\\app\\out\\cli.js" %*\r\n');
		const command = await resolveWindowsCommand(batch, ['--version']);
		assert.equal(command.executable, join(root, 'Code.exe'));
		assert.deepEqual(command.args, [cli, '--version']);
		assert.equal(command.environment?.ELECTRON_RUN_AS_NODE, '1');
		await writeFile(batch, '@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\版本 build\\resources\\app\\out\\cli.js" %* & echo injected\r\n');
		await assert.rejects(resolveWindowsCommand(batch, []), /unsupported layout/u);
		const other = join(root, 'other.cmd');
		await writeFile(other, '@echo off');
		await assert.rejects(resolveWindowsCommand(other, []), /batch commands are not supported/u);
	});
});

test('Windows launcher retains explicit native cleanup resources for retry rather than a PID fallback', windows, async () => {
	let attempts = 0;
	const resource = { dispose: async () => {
		if (++attempts === 1) {
			throw new Error('retry');
		}
	} };
	const launcher = new AgentHostLauncher({ storageRoot: 'unused', configuredCodeCli: 'test' }, {
		runCommand: async () => { throw new OwnedCommandError('cleanup failed', 1, true, resource); },
		terminate: async () => { assert.fail('PID cleanup must not be used on Windows'); },
	});
	assert.deepEqual(await launcher.probe(), { available: false });
	await assert.rejects(launcher.dispose(), /remain tracked/u);
	await launcher.dispose();
	assert.equal(attempts, 2);
});

test('Windows standalone launcher discovers an endpoint published by an owned descendant and disposes its profile', windows, async () => {
		await withFixture(async (root) => {
			const installation = join(root, 'VS Code 中文');
			await mkdir(installation);
			const executable = await fakeCodeInstallation(installation, true);
			const storage = join(root, 'storage');
			const launcher = new AgentHostLauncher({ configuredCodeCli: executable, storageRoot: storage, startupTimeoutMs: 5_000 });
			try {
				const host = await launcher.launch();
				assert.equal(host.endpoint.hostname, '127.0.0.1');
				assert.equal(host.registryProtocolVersion, '1.0.0');
				await host.dispose();
				await host.dispose();
				assert.deepEqual(await readdir(storage), []);
			} finally {
				await launcher.dispose();
			}
			assert.deepEqual(await launcher.probe(), { available: false });
		});
	});

test('Windows standalone disposal cancels an in-flight native launch and removes owned descendants and files', windows, async () => {
		await withFixture(async (root) => {
			const executable = await fakeCodeInstallation(root, false);
			const storage = join(root, 'storage');
			const launcher = new AgentHostLauncher({ configuredCodeCli: executable, storageRoot: storage });
			const operation = launcher.launch();
			void operation.catch(() => {});
			let pids: number[] = [];
			try {
				await waitUntil(async () => {
					try {
						const files = await readdir(storage, { recursive: true });
						const marker = files.find((path) => path.endsWith('owned-pids.json'));
						if (marker === undefined) {
							return false;
						}
						pids = JSON.parse(await readFile(join(storage, marker), 'utf8')) as number[];
						return pids.length === 2;
					} catch {
						return false;
					}
				});
				await launcher.dispose();
				await assert.rejects(operation);
				for (const pid of pids) {
					assert.equal(alive(pid), false);
				}
				assert.deepEqual(await readdir(storage), []);
			} finally {
				await launcher.dispose();
			}
		});
	});

test('Windows editor locator accepts local named pipes and retains unconfirmed native command cleanup', windows, async () => {
		const directory = 'C:\\用户 空间\\Code';
		const endpoint = {
			schemaVersion: 2, type: 'editor', pid: 1, instanceId: 'owned-editor',
			protocolVersion: '0.9.0', connectionToken: 'do-not-print',
			endpoint: { type: 'socket', path: '\\\\.\\pipe\\mesh-编辑器' },
		};
		let attempts = 0;
		let fail = false;
		const locator = new EditorAgentHostLocator({
			configuredCodeCli: 'code', configuredUserDataDir: directory,
			platform: { platform: 'win32', architecture: 'x64' },
		}, {
			canonicalize: async (path) => path,
			isProcessAlive: () => true,
			runCommand: async (_executable, args) => {
				if (fail) {
					throw new OwnedCommandError('unconfirmed', 1, true, { dispose: async () => {
						if (++attempts === 1) {
							throw new Error('retry');
						}
					} });
				}
				return args[0] === '--version' ? '1.136.2\ncommit\nx64\n'
					: JSON.stringify({ userDataPath: directory, endpoints: [endpoint] });
			},
		});
		const located = await locator.locate();
		assert.equal(located.registryProtocolVersion, '0.9.0');
		located.dispose();
		fail = true;
		await assert.rejects(locator.locate(), { cleanupRequired: true });
		await assert.rejects(locator.dispose(), { cleanupRequired: true });
		await locator.dispose();
		assert.equal(attempts, 2);
		assert.deepEqual(deriveEditorAgentHostUserDataDir({
			platform: 'win32', architecture: 'arm64', homeDirectory: 'C:\\用户',
			productName: 'Visual Studio Code', environment: { VSCODE_PORTABLE: 'D:\\Portable 编辑器\\data' },
		}), { path: 'D:\\Portable 编辑器\\data\\user-data', validatedWorkerHost: true });
});

test('Windows native output draining, Unicode working directory and environment remain exact', windows, async () => {
	await withFixture(async (root) => {
		const cwd = join(root, '工作 directory');
		await mkdir(cwd);
		const output = await runOwnedCommand(process.execPath, ['-e', `
			process.stderr.write('diagnostic');
			process.stdout.write(JSON.stringify({cwd:process.cwd(),value:process.env.MESH_TEST_VALUE,payload:'x'.repeat(128*1024)}));
		`], {
			timeoutMs: 5_000, cwd, environment: { ...process.env, MESH_TEST_VALUE: 'value 世界' },
		});
		assert.deepEqual(JSON.parse(output), { cwd, value: 'value 世界', payload: 'x'.repeat(128 * 1024) });
		await assert.rejects(runOwnedCommand(process.execPath, ['-e', 'process.stderr.write("private".repeat(50000))'], {
			timeoutMs: 5_000, maxOutputBytes: 1024,
		}), /output limit/u);
	});
});

test('Windows root-exit versus disposal races never lose confirmed cleanup', windows, async () => {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const child = new WindowsOwnedProcess(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),10)']);
		child.stdout.resume();
		child.stderr.resume();
		await child.started;
		await new Promise((resolve) => setTimeout(resolve, attempt * 5));
		await child.dispose();
		await child.dispose();
		assert.equal(child.cleanupConfirmed, true);
		assert.equal(alive(child.pid!), false);
	}
});

test('Windows timeout and cancellation terminate ready native grandchildren with inherited pipes', windows, async () => {
	await withFixture(async (root) => {
		for (const mode of ['timeout', 'cancel'] as const) {
			const marker = join(root, `${mode}-owned-pids.json`);
			const controller = new AbortController();
			const operation = runOwnedCommand(process.execPath, ['-e', treeSource(false, marker)], {
				timeoutMs: 4_000, signal: controller.signal,
			});
			void operation.catch(() => {});
			let pids: number[] = [];
			try {
				await waitUntil(async () => {
					try {
						pids = JSON.parse(await readFile(marker, 'utf8')) as number[];
						return pids.length === 3;
					} catch {
						return false;
					}
				});
				if (mode === 'cancel') {
					controller.abort();
				}
				await assert.rejects(operation, (error: unknown) => error instanceof OwnedCommandError
					&& !error.cleanupRequired
					&& (mode === 'cancel' ? /cancelled/u : /timed out/u).test(error.message));
				for (const pid of pids) {
					assert.equal(alive(pid), false);
				}
			} finally {
				controller.abort();
				await operation.catch(async (error: unknown) => {
					if (error instanceof OwnedCommandError && error.ownedCleanup !== undefined) {
						await error.ownedCleanup.dispose();
					}
				});
			}
		}
	});
});

function treeSource(exitRoot: boolean, marker?: string): string {
	const grandchild = 'setInterval(()=>{},1000)';
	const descendant = `
		const { spawn } = require('node:child_process');
		const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:['ignore',process.stdout,process.stderr]});
		process.send([process.pid,grandchild.pid]);setInterval(()=>{},1000);
	`;
	return `
		const { spawn } = require('node:child_process');
		const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:['ignore',process.stdout,process.stderr,'ipc']});
		child.once('message', pids => {
			${marker === undefined ? '' : `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,...pids]));`}
			${exitRoot ? 'process.stdout.write(JSON.stringify([process.pid,...pids]),()=>process.exit(0));' : 'setInterval(()=>{},1000);'}
		});
	`;
}

async function waitForPids(child: WindowsOwnedProcess, count: number): Promise<Set<number>> {
	let pids = new Set<number>();
	await waitUntil(async () => {
		pids = await child.ownedPids();
		return pids.size >= count;
	});
	return pids;
}

async function waitUntil(condition: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 8_000;
	while (!await condition()) {
		assert.ok(Date.now() < deadline, 'Native process condition timed out');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
		return false;
	}
}

async function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
	let output = '';
	for await (const chunk of stream) {
		output += String(chunk);
		assert.ok(output.length < 4096);
		if (output.includes('\n')) {
			return output.split('\n')[0]!;
		}
	}
	throw new Error('Owner closed before reporting its owned processes');
}

async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(repository, 'out', 'windows-process-'));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function fakeCodeInstallation(root: string, publish: boolean): Promise<string> {
	const cli = join(root, 'resources', 'app', 'out', 'cli.js');
	await mkdir(resolve(cli, '..'), { recursive: true });
	await mkdir(join(root, 'bin'), { recursive: true });
	await copyFile(process.execPath, join(root, 'Code.exe'));
	const batch = join(root, 'bin', 'code.cmd');
	await writeFile(batch, '"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*\r\n');
	await writeFile(cli, `
			const fs = require('node:fs'), path = require('node:path'), {spawn} = require('node:child_process');
			const args = process.argv.slice(2);
			const value = name => args[args.indexOf(name)+1];
			if (args[0] === '--version') {
				console.log('1.136.2\\nfixture-commit\\nx64');
			} else if (args[1] === 'endpoints') {
				const userDataPath = value('--user-data-dir');
				let endpoints=[];
				try { endpoints=JSON.parse(fs.readFileSync(path.join(userDataPath,'fixture-endpoint.json'),'utf8')); } catch {}
				console.log(JSON.stringify({userDataPath,endpoints}));
			} else if (args[1] === 'host') {
				const userDataPath = value('--user-data-dir');
				const connectionToken=fs.readFileSync(value('--connection-token-file'),'utf8');
				const childSource = ${JSON.stringify(`
					const fs=require('node:fs'),path=require('node:path');
					const [userDataPath,tokenFile,publish]=process.argv.slice(1);
					if(publish==='yes') fs.writeFileSync(path.join(userDataPath,'fixture-endpoint.json'),JSON.stringify([{
						schemaVersion:2,type:'standalone',pid:process.pid,instanceId:'fixture-owned',protocolVersion:'1.0.0',
						connectionToken:fs.readFileSync(tokenFile,'utf8'),endpoint:{type:'tcp',host:'127.0.0.1',port:12345}
					}]));
					setInterval(()=>{},1000);
				`)};
				const child=spawn(process.execPath,['-e',childSource,userDataPath,value('--connection-token-file'),${JSON.stringify(publish ? 'yes' : 'no')}],{stdio:['ignore',process.stdout,process.stderr]});
				fs.writeFileSync(path.join(value('--server-data-dir'),'owned-pids.json'),JSON.stringify([process.pid,child.pid]));
				setInterval(()=>{},1000);
			} else { process.exit(3); }
	`);
	return batch;
}
