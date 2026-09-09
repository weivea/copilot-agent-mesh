import { access, open, readFile, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

export interface ResolvedCommand {
	readonly executable: string;
	readonly args: readonly string[];
	readonly environment?: NodeJS.ProcessEnv;
}

export async function resolveWindowsCommand(
	executable: string,
	args: readonly string[],
	environment: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedCommand> {
	if (process.platform !== 'win32') {
		return { executable, args, environment };
	}
	const path = await findExecutable(executable, environment);
	if (/\.(cmd|bat)$/iu.test(path)) {
		if (!/^code(?:-insiders)?\.cmd$/iu.test(basename(path))) {
			throw new Error('Windows batch commands are not supported by the owned process controller. Configure a VS Code CLI executable or code.cmd installation path.');
		}
		return resolveCodeInstallation(dirname(dirname(path)), args, environment, path);
	}
	// Desktop Code.exe is Electron, not the native standalone CLI executable.
	if (/^code(?: - insiders)?\.exe$/iu.test(basename(path))) {
		return resolveCodeInstallation(dirname(path), args, environment);
	}
	if (extname(path).toLowerCase() !== '.exe' && extname(path).toLowerCase() !== '.com') {
		throw new Error('The Windows command must resolve to a native executable or an installed VS Code CLI.');
	}
	return { executable: path, args, environment };
}

export function windowsCodeCliCandidates(environment: NodeJS.ProcessEnv = process.env): string[] {
	const candidates: string[] = [];
	// In the extension host execPath identifies the running installation, also
	// covering portable installs without relying on PATH or user configuration.
	if (/^code(?: - insiders)?\.exe$/iu.test(basename(process.execPath))) {
		candidates.push(process.execPath);
	}
	for (const base of [
		environment.LOCALAPPDATA === undefined ? undefined : join(environment.LOCALAPPDATA, 'Programs'),
		environment.ProgramFiles,
		environment['ProgramFiles(x86)'],
	]) {
		if (base !== undefined) {
			candidates.push(join(base, 'Microsoft VS Code', 'bin', 'code.cmd'));
			candidates.push(join(base, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'));
		}
	}
	candidates.push('code', 'code-insiders');
	return candidates;
}

async function resolveCodeInstallation(
	root: string,
	args: readonly string[],
	environment: NodeJS.ProcessEnv,
	batchPath?: string,
): Promise<ResolvedCommand> {
	// Read only the official literal invocation; never execute or interpolate
	// batch syntax. Recent VS Code installs put resources in a version directory.
	const launchers = batchPath === undefined
		? [join(root, 'bin', 'code.cmd'), join(root, 'bin', 'code-insiders.cmd')]
		: [batchPath];
	for (const launcher of launchers) {
		let source: string;
		try {
			source = await readFile(launcher, 'utf8');
		} catch {
			continue;
		}
		const match = /^"%~dp0([^"\r\n%]+\.exe)"\s+"%~dp0([^"\r\n%]+[\\/]resources[\\/]app[\\/]out[\\/]cli\.js)"\s+%\*\s*$/imu.exec(source);
		if (match === null) {
			throw new Error('The configured VS Code batch launcher has an unsupported layout; no shell fallback is permitted.');
		}
		const binary = resolve(dirname(launcher), match[1]!);
		const cli = resolve(dirname(launcher), match[2]!);
		if (!inside(root, binary) || !inside(root, cli)) {
			throw new Error('The configured VS Code launcher points outside its installation.');
		}
		await Promise.all([access(binary), access(cli)]);
		return electronCommand(binary, cli, args, environment);
	}
	for (const name of ['Code.exe', 'Code - Insiders.exe']) {
		const binary = join(root, name);
		const cli = join(root, 'resources', 'app', 'out', 'cli.js');
		try {
			await Promise.all([access(binary), access(cli)]);
			return electronCommand(binary, cli, args, environment);
		} catch {
			continue;
		}
	}
	if (batchPath === undefined) {
		for (const name of ['Code.exe', 'Code - Insiders.exe']) {
			const executable = join(root, name);
			if (await isConsoleExecutable(executable)) {
				return { executable, args, environment };
			}
		}
	}
	throw new Error('The configured VS Code installation is missing its executable or CLI entry point.');
}

async function isConsoleExecutable(path: string): Promise<boolean> {
	let file;
	try {
		file = await open(path, 'r');
		const dos = Buffer.alloc(64);
		if ((await file.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) {
			return false;
		}
		const offset = dos.readUInt32LE(60);
		if (offset > 1024 * 1024) {
			return false;
		}
		const pe = Buffer.alloc(96);
		if ((await file.read(pe, 0, pe.length, offset)).bytesRead !== pe.length || pe.readUInt32LE(0) !== 0x4550) {
			return false;
		}
		// Console-subsystem native CLIs may legitimately ship without Electron
		// resources. Never treat a broken GUI installation as a CLI and open a window.
		return (pe.readUInt16LE(24) === 0x10b || pe.readUInt16LE(24) === 0x20b) && pe.readUInt16LE(92) === 3;
	} catch {
		return false;
	} finally {
		await file?.close();
	}
}

function electronCommand(binary: string, cli: string, args: readonly string[], environment: NodeJS.ProcessEnv): ResolvedCommand {
	const childEnvironment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(environment)) {
		if (key.toUpperCase() !== 'VSCODE_DEV' && key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE') {
			childEnvironment[key] = value;
		}
	}
	return {
		executable: binary,
		args: [cli, ...args],
		environment: { ...childEnvironment, ELECTRON_RUN_AS_NODE: '1' },
	};
}

function inside(root: string, path: string): boolean {
	const remainder = relative(root, path);
	return remainder !== '..' && !remainder.startsWith('..\\') && !isAbsolute(remainder);
}

async function findExecutable(executable: string, environment: NodeJS.ProcessEnv): Promise<string> {
	if (executable.length === 0 || /[\u0000-\u001f]/u.test(executable)) {
		throw new Error('The Windows command path is invalid.');
	}
	const extensions = extname(executable) === '' ? ['.exe', '.com', '.cmd'] : [''];
	const roots = isAbsolute(executable) || /[\\/]/u.test(executable)
		? [resolve(executable)]
		: (environment.PATH ?? environment.Path ?? '').split(delimiter)
			.filter((entry) => entry.length > 0)
			.map((entry) => join(entry.replace(/^"|"$/gu, ''), executable));
	for (const root of roots) {
		for (const extension of extensions) {
			try {
				return await realpath(root + extension);
			} catch {
				continue;
			}
		}
	}
	throw new Error('The Windows command was not found. Install VS Code or configure its installed CLI path.');
}
