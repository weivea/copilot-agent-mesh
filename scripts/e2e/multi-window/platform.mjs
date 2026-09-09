import { spawnSync } from 'node:child_process';
import { access, lstat, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export function supportsWorker(platform = process.platform, architecture = process.arch) {
	return platform === 'darwin' && architecture === 'arm64'
		|| platform === 'win32' && ['x64', 'arm64'].includes(architecture);
}

export function assertVscodeExecutable(path) {
	if (process.platform === 'win32' && !/\.exe$/iu.test(path)) {
		throw new Error('MESH_VSCODE_EXECUTABLE must select Code.exe on Windows, not a short-lived CLI batch wrapper.');
	}
}

export function guiEnvironment(environment = process.env) {
	const result = { ...environment };
	// Command-scoped Git overrides must not leak into a long-lived editor or its providers.
	for (const name of Object.keys(result)) {
		if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE'
			|| /^GIT_CONFIG_(?:COUNT|KEY_[0-9]+|VALUE_[0-9]+|PARAMETERS)$/iu.test(name)) {
			delete result[name];
		}
	}
	return result;
}

export function pathKey(path, platform = process.platform) {
	const absolute = platform === 'win32' ? win32.resolve(path) : resolve(path);
	return platform === 'win32' || platform === 'darwin' ? absolute.toLowerCase() : absolute;
}

export function pathsOverlap(left, right, platform = process.platform) {
	const a = pathKey(left, platform);
	const b = pathKey(right, platform);
	const separator = platform === 'win32' ? '\\' : sep;
	return a === b || a.startsWith(`${b}${separator}`) || b.startsWith(`${a}${separator}`);
}

export function commandContainsPath(command, path, platform = process.platform) {
	if (platform !== 'win32') {
		return command.includes(path);
	}
	return command.replaceAll('/', '\\').toLowerCase().includes(pathKey(path, platform));
}

export function realProfileDirectories() {
	const home = homedir();
	return [
		join(home, 'Library', 'Application Support', 'Code'),
		join(home, 'Library', 'Application Support', 'Code - Insiders'),
		join(home, '.config', 'Code'),
		join(home, '.config', 'Code - Insiders'),
		join(home, '.vscode'),
		join(home, '.vscode-insiders'),
		...['Code', 'Code - Insiders'].map((name) =>
			join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), name)),
		...(process.env.VSCODE_PORTABLE ? [resolve(process.env.VSCODE_PORTABLE)] : []),
	];
}

export async function assertNoPathAliases(path) {
	let probe = resolve(path);
	while (true) {
		try {
			const info = await lstat(probe);
			if (
				info.isSymbolicLink()
				|| (info.isFile() && info.nlink !== 1)
				|| pathKey(await realpath(probe)) !== pathKey(probe)
			) {
				throw new Error('Harness paths must not contain symbolic links or junction aliases.');
			}
		} catch (error) {
			if (error?.code !== 'ENOENT') {
				throw error;
			}
		}
		const parent = dirname(probe);
		if (parent === probe) {
			return;
		}
		probe = parent;
	}
}

export function parseWindowsProcessTable(json) {
	const parsed = JSON.parse(json.replace(/^\uFEFF/u, ''));
	const entries = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
	if (entries.length > 65_536) {
		throw new Error('Windows process metadata exceeds the bounded inspection limit.');
	}
	return entries.map((entry) => {
		if (
			!Number.isSafeInteger(entry.ProcessId) || entry.ProcessId < 0
			|| !Number.isSafeInteger(entry.ParentProcessId) || entry.ParentProcessId < 0
			|| (entry.CommandLine !== null && typeof entry.CommandLine !== 'string')
		) {
			throw new Error('Windows process metadata was invalid.');
		}
		return {
			pid: entry.ProcessId,
			parentPid: entry.ParentProcessId,
			// Windows has no POSIX process groups. Never infer ownership from this field.
			processGroupId: 0,
			command: entry.CommandLine ?? '',
			executable: typeof entry.ExecutablePath === 'string' ? entry.ExecutablePath : '',
			creationTime: entry.CreationDate,
		};
	});
}

export function readProcessTable(parsePosix) {
	const windows = process.platform === 'win32';
	const result = windows
		? spawnSync(
			join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
			['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', [
				"$ErrorActionPreference='Stop';",
				'[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);',
				'Get-CimInstance Win32_Process -OperationTimeoutSec 5',
				'| Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath,CreationDate',
				'| ConvertTo-Json -Compress',
			].join(' ')],
			{ encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: false },
		)
		: spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], {
			encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, shell: false,
		});
	if (result.error || result.status !== 0) {
		// Never include command lines or command output in diagnostics.
		throw new Error('Unable to inspect bounded harness process metadata.');
	}
	return windows ? parseWindowsProcessTable(result.stdout) : parsePosix(result.stdout);
}

export function assertProfileIdle(entries, profile, selfPid = process.pid) {
	if (entries.some(({ pid, command }) =>
		pid !== selfPid && command.includes('--user-data-dir') && commandContainsPath(command, profile),
	)) {
		throw Object.assign(new Error('The dedicated E2E profile is already in use.'), { code: 'PROFILE_IN_USE' });
	}
}

export async function resolveCodeCommand(executable, args, environment = process.env) {
	if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(executable)) {
		return { executable, args, env: environment };
	}
	const modulePath = resolve(dirname(fileURLToPath(import.meta.url)),
		'..', '..', '..', 'src', 'spikes', 'windowsCodeCli.ts');
	const { require: tsxRequire } = await import('tsx/cjs/api');
	const { resolveWindowsCommand } = tsxRequire(modulePath, import.meta.url);
	const command = await resolveWindowsCommand(executable, args, environment);
	return { executable: command.executable, args: command.args, env: command.environment };
}

export async function resolveNpmCommand(args) {
	const npmCli = process.env.npm_execpath;
	if (npmCli && /npm-cli\.js$/iu.test(npmCli)) {
		await access(npmCli);
		return { executable: process.execPath, args: [npmCli, ...args] };
	}
	if (process.platform !== 'win32') {
		return { executable: 'npm', args };
	}
	const adjacentCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
	await access(adjacentCli);
	return { executable: process.execPath, args: [adjacentCli, ...args] };
}

export async function ipcEndpointAbsent(endpoint, options = {}) {
	if (endpoint === undefined) {
		return true;
	}
	if (endpoint.platform !== 'win32') {
		try {
			await lstat(endpoint.address);
			return false;
		} catch (error) {
			if (error?.code === 'ENOENT') {
				return true;
			}
			throw error;
		}
	}
	if (typeof endpoint.address !== 'string' || !endpoint.address.startsWith('\\\\.\\pipe\\')) {
		throw new Error('The observed Windows IPC endpoint is not a named pipe.');
	}
	return new Promise((resolveAbsent, reject) => {
		const client = createConnection(endpoint.address);
		let settled = false;
		const timer = setTimeout(() => finish(undefined, new Error('Named-pipe cleanup inspection timed out.')),
			options.timeoutMs ?? 1_000);
		function finish(absent, error) {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			client.destroy();
			if (error) {
				reject(error);
			} else {
				resolveAbsent(absent);
			}
		}
		client.once('connect', () => finish(false));
		client.once('error', (error) => {
			if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
				finish(true);
			} else {
				finish(undefined, new Error('Named-pipe cleanup could not be confirmed.'));
			}
		});
	});
}

export async function waitForIpcEndpointAbsent(endpoint, options = {}) {
	const timeoutMs = options.timeoutMs ?? 5_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
		throw new Error('IPC cleanup timeout must be an integer from 1 to 30000 milliseconds.');
	}
	const now = options.now ?? Date.now;
	const delay = options.delay ?? ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)));
	const probe = options.probe ?? ipcEndpointAbsent;
	const deadline = now() + timeoutMs;
	let lastFailure;
	while (now() < deadline) {
		try {
			if (await probe(endpoint, { timeoutMs: Math.min(1_000, Math.max(1, deadline - now())) })) {
				return true;
			}
		} catch (error) {
			lastFailure = error;
		}
		await delay(Math.min(100, Math.max(0, deadline - now())));
	}
	throw new Error('The owned IPC endpoint did not disappear before the cleanup deadline.', { cause: lastFailure });
}

export async function releaseOwnedProfileLock({ lockDirectory, expectedRunId, assertQuiescent }) {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(expectedRunId)
		|| typeof assertQuiescent !== 'function' || !isAbsolute(lockDirectory)
		|| basename(lockDirectory) !== '.copilot-agent-mesh-e2e-lock') {
		throw new Error('Exact run ownership and a quiescence check are required to release a profile lock.');
	}
	await assertNoPathAliases(lockDirectory);
	const ownerPath = join(lockDirectory, 'owner');
	await assertNoPathAliases(ownerPath);
	const directoryBefore = await lstat(lockDirectory);
	const ownerBefore = await lstat(ownerPath);
	const assertOwner = async () => {
		if ((await readFile(ownerPath, 'utf8')).trim() !== expectedRunId) {
			throw new Error('The persistent multi-window E2E profile lock ownership changed.');
		}
	};
	if (!directoryBefore.isDirectory() || !ownerBefore.isFile() || ownerBefore.nlink !== 1) {
		throw new Error('The exact profile lock is not an ordinary owned directory and owner file.');
	}
	await assertOwner();
	await assertQuiescent();
	await assertNoPathAliases(lockDirectory);
	await assertNoPathAliases(ownerPath);
	const [directoryAfter, ownerAfter, names] = await Promise.all([
		lstat(lockDirectory), lstat(ownerPath), readdir(lockDirectory),
	]);
	if (directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino
		|| ownerBefore.dev !== ownerAfter.dev || ownerBefore.ino !== ownerAfter.ino
		|| names.length !== 1 || names[0] !== 'owner') {
		throw new Error('The profile lock changed or contains unexpected files; it was retained.');
	}
	await assertOwner();
	await unlink(ownerPath);
	await rmdir(lockDirectory);
	return true;
}
