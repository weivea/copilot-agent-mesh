import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function runGo(args, options) {
	try {
		return execFileSync('go', args, { ...options, windowsHide: true });
	} catch {
		throw new Error('Building the bundled Windows process host requires Go 1.23+ (build-time only). No unsafe runtime fallback is available.');
	}
}

function validatePeMachine(path, architecture, expectedMachine) {
	const binary = readFileSync(path);
	const offset = binary.length >= 64 ? binary.readUInt32LE(0x3c) : -1;
	if (
		binary.length < 64
		|| binary.readUInt16LE(0) !== 0x5a4d
		|| offset < 64
		|| offset > binary.length - 6
		|| binary.readUInt32LE(offset) !== 0x00004550
		|| binary.readUInt16LE(offset + 4) !== expectedMachine
	) {
		throw new Error(`Windows helper PE validation failed for ${architecture}; expected machine 0x${expectedMachine.toString(16).toUpperCase()}.`);
	}
	console.log(`Validated Windows ${architecture} helper PE machine 0x${expectedMachine.toString(16).toUpperCase()}.`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'windows');
mkdirSync(output, { recursive: true });
mkdirSync(join(root, 'out'), { recursive: true });
const work = mkdtempSync(join(root, 'out', 'windows-process-build-'));
try {
	const buildEnvironment = { ...process.env, CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GOTMPDIR: work };
	const goroot = runGo(['env', 'GOROOT'], {
		env: buildEnvironment, encoding: 'utf8', windowsHide: true,
	}).trim();
	for (const [architecture, goarch, machine] of [['x64', 'amd64', 0x8664], ['arm64', 'arm64', 0xaa64]]) {
		const binary = join(output, `mesh-process-host-${architecture}.exe`);
		runGo([
			'build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=',
			'-o', binary, '.',
		], {
			cwd: join(root, 'native', 'windows-process-host'),
			env: { ...buildEnvironment, GOOS: 'windows', GOARCH: goarch },
			stdio: 'inherit',
			windowsHide: true,
		});
		validatePeMachine(binary, architecture, machine);
	}
	copyFileSync(join(goroot, 'LICENSE'), join(output, 'LICENSE-go.txt'));
} finally {
	rmSync(work, { recursive: true, force: true });
}
