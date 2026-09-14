import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { createGunzip, gzipSync } from 'node:zlib';
import { CodespaceSystemLibc } from '../codespaces/CodespaceSystemLibc';
import {
	CODESPACE_CLI_INSTALLER_LIMITS,
	CodespaceCliInstaller,
	CodespaceCliInstallerError,
	type CodespaceCliArchitecture,
	type CodespaceCliInstallerHttp,
	type CodespaceCliInstallerHttpResponse,
	type CodespaceCliInstallerFileSystem,
	type CodespaceCliInstallerOptions,
	type CodespaceCliQuality,
} from '../codespaces/CodespaceCliInstaller';

const VERSION = '1.136.2';
const COMMIT = '88e44fa0e00b08f7758b4f6d05632e4fd5e4df6f';
const NEXT_COMMIT = 'b'.repeat(40);
const UPDATE = 'https://update.code.visualstudio.com';
const CDN = 'https://vscode.download.prss.microsoft.com';

interface TarEntry {
	name: string;
	data?: Buffer;
	type?: string;
	mode?: number;
	size?: number;
	linkname?: string;
	prefix?: string;
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
	header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function checksum(header: Buffer): void {
	header.fill(32, 148, 156);
	const sum = header.reduce((previous, byte) => previous + byte, 0);
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

function tar(entries: readonly TarEntry[], end = Buffer.alloc(1024)): Buffer {
	const chunks: Buffer[] = [];
	for (const entry of entries) {
		const data = entry.data ?? Buffer.alloc(0);
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100, 'ascii');
		octal(header, 100, 8, entry.mode ?? 0o755);
		octal(header, 108, 8, 0);
		octal(header, 116, 8, 0);
		octal(header, 124, 12, entry.size ?? data.length);
		octal(header, 136, 12, 0);
		header.write(entry.type ?? '0', 156, 1, 'ascii');
		header.write(entry.linkname ?? '', 157, 100, 'ascii');
		header.write('ustar\0', 257, 6, 'ascii');
		header.write('00', 263, 2, 'ascii');
		header.write(entry.prefix ?? '', 345, 155, 'ascii');
		checksum(header);
		chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
	}
	return Buffer.concat([...chunks, end]);
}

function elf(architecture: CodespaceCliArchitecture = 'x64', label = 'fixture'): Buffer {
	const bytes = Buffer.alloc(256);
	bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
	bytes.writeUInt16LE(3, 16);
	bytes.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
	bytes.writeUInt32LE(1, 20);
	bytes.writeBigUInt64LE(64n, 32);
	bytes.writeUInt16LE(64, 52);
	bytes.writeUInt16LE(56, 54);
	bytes.writeUInt16LE(1, 56);
	bytes.writeUInt32LE(1, 64);
	bytes.writeUInt32LE(5, 68);
	bytes.writeBigUInt64LE(BigInt(bytes.length), 96);
	bytes.writeBigUInt64LE(BigInt(bytes.length), 104);
	bytes.writeBigUInt64LE(4096n, 112);
	bytes.write(label, 128);
	return bytes;
}

function sha256(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function release(options: {
	version?: string; commit?: string; quality?: CodespaceCliQuality;
	architecture?: CodespaceCliArchitecture; binary?: Buffer; archive?: Buffer;
} = {}) {
	const version = options.version ?? VERSION;
	const commit = options.commit ?? COMMIT;
	const quality = options.quality ?? 'stable';
	const architecture = options.architecture ?? 'x64';
	const binary = options.binary ?? elf(architecture);
	const archive = options.archive ?? gzipSync(tar([{ name: quality === 'stable' ? 'code' : 'code-insiders', data: binary }]));
	const metadataUrl = `${UPDATE}/api/versions/${version}/cli-linux-${architecture}/${quality}`;
	const downloadUrl = `${CDN}/dbazure/download/${quality}/${commit}/vscode_cli_linux_${architecture}_cli.tar.gz`;
	const metadata: Record<string, unknown> = {
		url: downloadUrl, name: version, productVersion: version, version: commit,
		sha256hash: sha256(archive), hash: '0'.repeat(40),
	};
	return { version, commit, quality, architecture, binary, archive, metadataUrl, downloadUrl, metadata };
}

type ReleaseFixture = ReturnType<typeof release>;

function response(
	url: string, bytes: Buffer, options: {
		statusCode?: number;
		headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
		chunkSize?: number;
	} = {},
): CodespaceCliInstallerHttpResponse & { disposed: boolean } {
	const chunkSize = options.chunkSize ?? 23;
	const chunks: Buffer[] = [];
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		chunks.push(bytes.subarray(offset, offset + chunkSize));
	}
	const body = Readable.from(chunks);
	return {
		url, statusCode: options.statusCode ?? 200,
		headers: options.headers ?? { 'content-length': String(bytes.length) }, body, disposed: false,
		dispose() { this.disposed = true; body.destroy(); },
	};
}

class MockHttp implements CodespaceCliInstallerHttp {
	public readonly calls: string[] = [];
	public handler: (url: string, signal: AbortSignal) => Promise<CodespaceCliInstallerHttpResponse>;

	public constructor(public readonly releases: readonly ReleaseFixture[]) {
		this.handler = async (url) => this.defaultResponse(url);
	}

	public defaultResponse(url: string): CodespaceCliInstallerHttpResponse {
		for (const value of this.releases) {
			if (url === value.metadataUrl) {
				return response(url, Buffer.from(JSON.stringify(value.metadata)));
			}
			if (url === value.downloadUrl) {
				return response(url, value.archive);
			}
		}
		throw new Error(`Unexpected mock URL: ${url}`);
	}

	public request(url: string, signal: AbortSignal): Promise<CodespaceCliInstallerHttpResponse> {
		this.calls.push(url);
		return this.handler(url, signal);
	}
}

async function fixture(
	t: TestContext, releases = [release()], overrides: Partial<CodespaceCliInstallerOptions> = {},
) {
	// All generated files stay in this checkout and are removed by this test's own cleanup.
	const base = resolve(`.codespace-cli-installer-test-${randomUUID()}`);
	await mkdir(base, { mode: 0o700 });
	t.after(async () => { await rm(base, { recursive: true, force: true }); });
	const root = join(base, 'private');
	const http = new MockHttp(releases);
	const options: CodespaceCliInstallerOptions = {
		storageRoot: root, platform: 'linux', architecture: 'x64', version: VERSION,
		process: { glibcVersionRuntime: () => '2.36' }, http, ...overrides,
	};
	return { base, root, http, options, installer: new CodespaceCliInstaller(options) };
}

function deferred<T>() {
	let accept!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => { accept = resolvePromise; });
	return { promise, resolve: accept };
}

async function noStaging(root: string): Promise<void> {
	const entries = await readdir(root).catch((error: unknown) => {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	});
	assert.deepEqual(entries.filter((entry) => entry.startsWith('.staging-') || entry === '.install.lock'), []);
}

function trackedFileSystem() {
	const paths = new Map<FileHandle, string>();
	const files: CodespaceCliInstallerFileSystem = {
		lstat: (path) => lstat(path),
		mkdir: async (path, options) => { await mkdir(path, options); },
		open: async (path, flags, mode) => {
			const file = await open(path, flags, mode);
			paths.set(file, path);
			return file;
		},
		realpath: (path) => realpath(path),
		rename: (from, to) => rename(from, to),
		rm: (path, options) => rm(path, options),
		unlink: (path) => unlink(path),
		close: (file) => file.close(),
	};
	return { files, paths };
}

function ioFailure(code = 'EIO'): Error & { code: string } {
	return Object.assign(new Error('Injected filesystem failure.'), { code });
}

function flattenedErrors(error: unknown): unknown[] {
	return error instanceof AggregateError ? error.errors.flatMap(flattenedErrors) : [error];
}

function includesFailures(error: unknown, failures: readonly unknown[]): boolean {
	assert.ok(error instanceof AggregateError);
	const causes = flattenedErrors(error);
	for (const failure of failures) {
		assert.ok(causes.includes(failure), 'The original failure must remain in the aggregate.');
	}
	return true;
}

test('installer construction and missing status do not create storage or use the network', async (t) => {
	const f = await fixture(t);
	assert.equal(await f.installer.findInstalled(), undefined);
	assert.equal(await f.installer.status(), undefined);
	assert.deepEqual(f.http.calls, []);
	await assert.rejects(lstat(f.root), { code: 'ENOENT' });
});

test('explicit installation pins official metadata, publishes a private ELF, and never changes PATH or a wrapper', async (t) => {
	const value = release();
	const f = await fixture(t, [value]);
	const wrapper = join(f.base, 'code');
	await writeFile(wrapper, '#!/bin/sh\nexit 99\n');
	const pathBefore = process.env.PATH;
	const installed = await f.installer.install({ commit: COMMIT });
	assert.equal(isAbsolute(installed.executablePath), true);
	assert.equal(basename(installed.executablePath), 'code');
	assert.equal(installed.executablePath.startsWith(f.root), true);
	assert.equal(installed.version, VERSION);
	assert.equal(installed.commit, COMMIT);
	assert.equal(installed.platform, 'linux');
	assert.equal(installed.architecture, 'x64');
	assert.equal(installed.quality, 'stable');
	assert.equal(installed.sha256, sha256(value.archive));
	assert.equal(installed.executableSha256, sha256(value.binary));
	assert.equal(installed.url, value.downloadUrl);
	assert.deepEqual(await readFile(installed.executablePath), value.binary);
	assert.deepEqual(f.http.calls, [value.metadataUrl, value.downloadUrl]);
	assert.equal(Object.isFrozen(installed), true);
	assert.deepEqual(await f.installer.findInstalled(), installed);
	assert.deepEqual(await f.installer.status(), installed);
	assert.equal(f.http.calls.length, 2);
	assert.equal(await readFile(wrapper, 'utf8'), '#!/bin/sh\nexit 99\n');
	assert.equal(process.env.PATH, pathBefore);
	if (process.geteuid !== undefined) {
		assert.equal((await lstat(f.root)).mode & 0o777, 0o700);
		assert.equal((await lstat(installed.executablePath)).mode & 0o777, 0o700);
		assert.equal((await lstat(join(f.root, 'current-stable-x64.json'))).mode & 0o777, 0o600);
	}
	await noStaging(f.root);
});

test('Linux arm64 and explicitly chosen Insiders use their own pinned releases', async (t) => {
	for (const options of [
		{ architecture: 'arm64' as const },
		{ architecture: 'x64' as const, quality: 'insider' as const, version: '1.137.0-insider' },
	]) {
		await t.test(JSON.stringify(options), async (child) => {
			const value = release(options);
			const f = await fixture(child, [value], options);
			const installed = await f.installer.install();
			assert.equal(installed.architecture, value.architecture);
			assert.equal(installed.quality, value.quality);
			assert.equal(basename(installed.executablePath), 'code');
			assert.deepEqual(await readFile(installed.executablePath), value.binary);
			assert.deepEqual(await f.installer.status(), installed);
		});
	}
});

test('a checked existing release is reused without redownloading or replacing its executable', async (t) => {
	const value = release();
	const f = await fixture(t, [value]);
	const original = await f.installer.install();
	const again = await f.installer.install({ commit: COMMIT });
	assert.deepEqual(again, original);
	assert.deepEqual(f.http.calls, [value.metadataUrl, value.downloadUrl, value.metadataUrl]);
	assert.equal((await readdir(f.root)).filter((name) => name.startsWith('stable-x64-')).length, 1);
	await noStaging(f.root);
});

test('unsupported operating systems, architectures, and old glibc fail before storage or network I/O', async (t) => {
	const cases: Partial<CodespaceCliInstallerOptions>[] = [
		{ platform: 'win32' }, { platform: 'darwin' }, { architecture: 'ia32' }, { architecture: 'arm' },
		{ process: { glibcVersionRuntime: () => '2.17' } },
	];
	for (const [index, options] of cases.entries()) {
		await t.test(String(index), async (child) => {
			const f = await fixture(child, undefined, options);
			await assert.rejects(f.installer.install(), { code: 'UNSUPPORTED_ENVIRONMENT' });
			await assert.rejects(f.installer.status(), { code: 'UNSUPPORTED_ENVIRONMENT' });
			assert.deepEqual(f.http.calls, []);
			await assert.rejects(lstat(f.root), { code: 'ENOENT' });
		});
	}
});

test('unknown libc is diagnosed separately from unsupported libc and never downloads a runtime', async (t) => {
	for (const glibc of [undefined, 'musl', 'unknown']) {
		const f = await fixture(t, undefined, { process: { glibcVersionRuntime: async () => glibc } });
		await assert.rejects(f.installer.install(), { code: 'ENVIRONMENT_CHECK_FAILED' });
		await assert.rejects(f.installer.status(), { code: 'ENVIRONMENT_CHECK_FAILED' });
		assert.deepEqual(f.http.calls, []);
		await assert.rejects(lstat(f.root), { code: 'ENOENT' });
	}
});

test('system getconf results allow installation without a Node diagnostic report', async (t) => {
	let probes = 0;
	const probe = new CodespaceSystemLibc(async () => {
		probes += 1;
		return 'glibc 2.36\n';
	});
	const f = await fixture(t, undefined, { process: probe });
	assert.equal(await f.installer.status(), undefined);
	const installed = await f.installer.install();
	assert.equal(installed.version, VERSION);
	assert.equal((await f.installer.status())?.executablePath, installed.executablePath);
	assert.equal(probes, 1);
});

test('libc detection errors preserve owned cleanup failures instead of treating them as cancellation', async (t) => {
	const controller = new AbortController();
	const failure = new AggregateError([new Error('Pending owned cleanup.')], 'Libc probe cleanup failed.');
	const f = await fixture(t, undefined, {
		process: { glibcVersionRuntime: async () => { controller.abort(); throw failure; } },
	});
	await assert.rejects(f.installer.install({ signal: controller.signal }), (error) => error === failure);
	assert.deepEqual(f.http.calls, []);
});

test('an exact version is mandatory and Insiders is never inferred from the editor version', async (t) => {
	for (const version of [undefined, 'latest', '1.136', '../latest', '1.137.0-insider', '1.136.2?x=1']) {
		await t.test(String(version), async (child) => {
			const f = await fixture(child, undefined, { version });
			await assert.rejects(f.installer.install(), { code: 'INVALID_RELEASE' });
			assert.deepEqual(f.http.calls, []);
			await assert.rejects(lstat(f.root), { code: 'ENOENT' });
		});
	}
	const f = await fixture(t);
	await assert.rejects(f.installer.install({ commit: 'short' }), { code: 'INVALID_RELEASE' });
	assert.deepEqual(f.http.calls, []);
	assert.throws(() => new CodespaceCliInstaller({ storageRoot: 'relative' }), { code: 'INVALID_INSTALLATION' });
	assert.throws(() => new CodespaceCliInstaller({ storageRoot: f.root, limits: { maxArchiveBytes: Infinity } }), { code: 'SIZE_LIMIT' });
});

test('missing SHA-256, mismatched pins, and malformed metadata fail closed', async (t) => {
	const changes: Record<string, unknown>[] = [
		{ sha256hash: undefined }, { sha256hash: 'sha1-only' }, { sha256hash: '0'.repeat(63) },
		{ name: '1.136.3' }, { productVersion: '1.136.3' }, { version: 'short' },
		{ version: NEXT_COMMIT }, { url: undefined },
	];
	for (const [index, change] of changes.entries()) {
		await t.test(String(index), async (child) => {
			const value = release();
			Object.assign(value.metadata, change);
			const f = await fixture(child, [value]);
			await assert.rejects(f.installer.install({ commit: COMMIT }), { code: 'INVALID_RELEASE' });
			assert.deepEqual(f.http.calls, [value.metadataUrl]);
			assert.equal(await f.installer.status(), undefined);
			await noStaging(f.root);
		});
	}
	const f = await fixture(t);
	f.http.handler = async (url) => response(url, Buffer.from('<html>not JSON</html>'));
	await assert.rejects(f.installer.install(), { code: 'INVALID_RELEASE' });
});

test('archive checksum is validated before any decompressor is invoked', async (t) => {
	const value = release();
	value.metadata.sha256hash = '0'.repeat(64);
	let decompressions = 0;
	const f = await fixture(t, [value], {
		archive: { createGunzip: () => { decompressions += 1; return createGunzip(); } },
	});
	await assert.rejects(f.installer.install(), { code: 'INTEGRITY_MISMATCH' });
	assert.equal(decompressions, 0);
	assert.equal(await f.installer.status(), undefined);
	assert.deepEqual(await readdir(f.root), []);
});

test('usable hexadecimal SHA-256 metadata is normalized before verification', async (t) => {
	const value = release();
	value.metadata.sha256hash = sha256(value.archive).toUpperCase();
	const f = await fixture(t, [value]);
	assert.equal((await f.installer.install()).sha256, sha256(value.archive));
	assert.equal((await f.installer.status())?.sha256, sha256(value.archive));
});

test('metadata URLs must bind the exact commit, architecture, quality, and official HTTPS origin', async (t) => {
	const value = release();
	const urls = [
		'https://attacker.invalid/cli.tar.gz',
		value.downloadUrl.replace('https:', 'http:'),
		value.downloadUrl.replace('microsoft.com', 'microsoft.com.attacker.invalid'),
		value.downloadUrl.replace('https://', 'https://account:secret@'),
		value.downloadUrl.replace('microsoft.com/', 'microsoft.com:444/'),
		value.downloadUrl.replace(COMMIT, NEXT_COMMIT),
		value.downloadUrl.replace('linux_x64', 'linux_arm64'),
		value.downloadUrl.replace('/stable/', '/insider/'),
		`${value.downloadUrl}?redirect=attacker`,
		`${value.downloadUrl}#fragment`,
		value.downloadUrl.replace('/vscode_cli_', '/ignored/../vscode_cli_'),
	];
	for (const [index, url] of urls.entries()) {
		await t.test(String(index), async (child) => {
			const current = release();
			current.metadata.url = url;
			const f = await fixture(child, [current]);
			await assert.rejects(f.installer.install(), { code: 'UNSAFE_URL' });
			assert.deepEqual(f.http.calls, [current.metadataUrl]);
			await noStaging(f.root);
		});
	}
});

test('the installer follows only a bounded official redirect for the exact archive', async (t) => {
	const value = release();
	const pinned = `${UPDATE}/commit:${COMMIT}/cli-linux-x64/stable`;
	value.metadata.url = pinned;
	const f = await fixture(t, [value]);
	let redirect: ReturnType<typeof response> | undefined;
	f.http.handler = async (url) => {
		if (url === pinned) {
			redirect = response(url, Buffer.alloc(0), { statusCode: 302, headers: { location: value.downloadUrl } });
			return redirect;
		}
		return f.http.defaultResponse(url);
	};
	const installed = await f.installer.install();
	assert.equal(installed.url, pinned);
	assert.deepEqual(f.http.calls, [value.metadataUrl, pinned, value.downloadUrl]);
	assert.equal(redirect?.disposed, true);
	assert.deepEqual(await f.installer.status(), installed);
});

test('invalid redirects and automatic downloader redirects are rejected without requesting the new origin', async (t) => {
	for (const where of ['metadata', 'archive', 'automatic', 'loop'] as const) {
		await t.test(where, async (child) => {
			const value = release();
			const f = await fixture(child, [value], { limits: { maxRedirects: 1 } });
			f.http.handler = async (url) => {
				if ((where === 'metadata' && url === value.metadataUrl) || url === value.downloadUrl) {
					if (where === 'automatic') {
						return response('https://attacker.invalid/cli.tar.gz', value.archive);
					}
					return response(url, Buffer.alloc(0), {
						statusCode: 307, headers: { location: where === 'loop' ? value.downloadUrl : 'https://attacker.invalid/cli.tar.gz' },
					});
				}
				return f.http.defaultResponse(url);
			};
			await assert.rejects(f.installer.install(), { code: 'UNSAFE_URL' });
			assert.equal(f.http.calls.some((url) => url.includes('attacker')), false);
			assert.ok(f.http.calls.length <= 3);
			await noStaging(f.root);
		});
	}
});

test('HTTP sizes are bounded with and without Content-Length and truncated/encoded bodies are rejected', async (t) => {
	for (const mode of ['metadata', 'archive-header', 'archive-stream', 'truncated', 'encoding', 'duplicate-header', 'status'] as const) {
		await t.test(mode, async (child) => {
			const value = release();
			const limits = mode === 'metadata' ? { maxMetadataBytes: 32 }
				: mode.startsWith('archive-') ? { maxArchiveBytes: 32 } : {};
			const f = await fixture(child, [value], { limits });
			f.http.handler = async (url) => {
				if (url === value.downloadUrl) {
					if (mode === 'archive-stream') {
						return response(url, value.archive, { headers: {} });
					}
					if (mode === 'truncated') {
						return response(url, value.archive, { headers: { 'content-length': String(value.archive.length + 1) } });
					}
					if (mode === 'encoding') {
						return response(url, value.archive, { headers: { 'content-encoding': 'gzip' } });
					}
					if (mode === 'duplicate-header') {
						return response(url, value.archive, { headers: { 'content-length': ['1', '2'] } });
					}
					if (mode === 'status') {
						return response(url, value.archive, { statusCode: 206 });
					}
				}
				return f.http.defaultResponse(url);
			};
			await assert.rejects(f.installer.install(), { code: mode === 'metadata' || mode.startsWith('archive-') ? 'SIZE_LIMIT' : 'NETWORK_ERROR' });
			assert.equal(await f.installer.status(), undefined);
			await noStaging(f.root);
		});
	}
});

test('strict tar parsing rejects traversal, links, devices, extensions, extra files, duplicates, and non-executables', async (t) => {
	const binary = elf();
	const cases: { name: string; entries: TarEntry[]; code?: string }[] = [
		{ name: 'parent traversal', entries: [{ name: '../code', data: binary }] },
		{ name: 'absolute', entries: [{ name: '/code', data: binary }] },
		{ name: 'windows absolute', entries: [{ name: 'C:\\code', data: binary }] },
		{ name: 'nested traversal', entries: [{ name: 'sub/../code', data: binary }] },
		{ name: 'symlink', entries: [{ name: 'code', type: '2', linkname: 'elsewhere' }] },
		{ name: 'hardlink', entries: [{ name: 'code', type: '1', linkname: 'elsewhere' }] },
		{ name: 'character device', entries: [{ name: 'code', type: '3' }] },
		{ name: 'block device', entries: [{ name: 'code', type: '4' }] },
		{ name: 'FIFO', entries: [{ name: 'code', type: '6' }] },
		{ name: 'PAX', entries: [{ name: 'code', type: 'x' }] },
		{ name: 'global PAX', entries: [{ name: 'code', type: 'g' }] },
		{ name: 'GNU long path', entries: [{ name: 'code', type: 'L' }] },
		{ name: 'prefix', entries: [{ name: 'code', prefix: '..', data: binary }] },
		{ name: 'unexpected file', entries: [{ name: 'README', data: binary }] },
		{ name: 'duplicate', entries: [{ name: 'code', data: binary }, { name: './code', data: binary }] },
		{ name: 'extra file', entries: [{ name: 'code', data: binary }, { name: 'other', data: binary }] },
		{ name: 'directory', entries: [{ name: 'bin', type: '5' }, { name: 'code', data: binary }] },
		{ name: 'duplicate root', entries: [{ name: './', type: '5' }, { name: '.', type: '5' }, { name: 'code', data: binary }] },
		{ name: 'no executable bit', entries: [{ name: 'code', mode: 0o644, data: binary }] },
		{ name: 'setuid', entries: [{ name: 'code', mode: 0o4755, data: binary }] },
		{ name: 'oversized entry', entries: [{ name: 'code', size: CODESPACE_CLI_INSTALLER_LIMITS.maxExecutableBytes + 1 }], code: 'SIZE_LIMIT' },
	];
	for (const current of cases) {
		await t.test(current.name, async (child) => {
			const value = release({ archive: gzipSync(tar(current.entries)) });
			const f = await fixture(child, [value]);
			await assert.rejects(f.installer.install(), { code: current.code ?? 'INVALID_ARCHIVE' });
			assert.equal(await f.installer.findInstalled(), undefined);
			assert.deepEqual(await readdir(f.root), []);
		});
	}
});

test('standard GNU tar headers and a single optional root-directory entry are accepted', async (t) => {
	const binary = elf();
	const bytes = tar([{ name: './', type: '5' }, { name: './code', data: binary }]);
	bytes.write('ustar ', 257, 6, 'ascii');
	bytes.write(' \0', 263, 2, 'ascii');
	checksum(bytes.subarray(0, 512));
	const value = release({ archive: gzipSync(bytes), binary });
	const f = await fixture(t, [value], { archive: { createGunzip: () => createGunzip({ chunkSize: 64 }) } });
	const installed = await f.installer.install();
	assert.deepEqual(await readFile(installed.executablePath), binary);
});

test('tar checksums, padding, terminators, declared lengths, and gzip integrity are enforced', async (t) => {
	const good = tar([{ name: 'code', data: elf() }]);
	const badChecksum = Buffer.from(good);
	badChecksum[0] ^= 1;
	const badPadding = Buffer.from(good);
	badPadding[512 + elf().length] = 1;
	const badNumber = Buffer.from(good);
	badNumber[124] = 0x80;
	checksum(badNumber.subarray(0, 512));
	const corruptGzip = gzipSync(good);
	corruptGzip[corruptGzip.length - 8] ^= 1;
	const cases = [
		{ name: 'checksum', archive: gzipSync(badChecksum) },
		{ name: 'padding', archive: gzipSync(badPadding) },
		{ name: 'base256 number', archive: gzipSync(badNumber) },
		{ name: 'short trailer', archive: gzipSync(good.subarray(0, good.length - 512)) },
		{ name: 'missing trailer', archive: gzipSync(good.subarray(0, good.length - 1024)) },
		{ name: 'trailing entry', archive: gzipSync(Buffer.concat([good, good])) },
		{ name: 'unaligned trailer', archive: gzipSync(Buffer.concat([good, Buffer.alloc(1)])) },
		{ name: 'truncated data', archive: gzipSync(tar([{ name: 'code', size: 4096, data: elf() }])) },
		{ name: 'gzip checksum', archive: corruptGzip },
		{ name: 'not gzip', archive: Buffer.from('not an archive') },
	];
	for (const current of cases) {
		await t.test(current.name, async (child) => {
			const f = await fixture(child, [release({ archive: current.archive })]);
			await assert.rejects(f.installer.install(), { code: 'INVALID_ARCHIVE' });
			await noStaging(f.root);
		});
	}
});

test('decompressed and executable sizes remain bounded even for a tiny compressed payload', async (t) => {
	for (const limits of [{ maxExecutableBytes: 128 }, { maxDecompressedBytes: 1024 }, { maxManifestBytes: 64 }]) {
		await t.test(JSON.stringify(limits), async (child) => {
			const f = await fixture(child, undefined, { limits });
			await assert.rejects(f.installer.install(), { code: 'SIZE_LIMIT' });
			assert.deepEqual(await readdir(f.root), []);
		});
	}
});

test('native ELF class, byte order, machine, and executable structure must match the selected Linux architecture', async (t) => {
	const binaries = [
		Buffer.from('#!/bin/sh\n'.padEnd(256, ' ')),
		elf('arm64'),
		elf(),
		elf(),
		elf(),
		elf(),
	];
	binaries[2][4] = 1;
	binaries[3][5] = 2;
	binaries[4].writeUInt16LE(1, 16);
	binaries[5].writeBigUInt64LE(99999n, 32);
	for (const [index, binary] of binaries.entries()) {
		await t.test(String(index), async (child) => {
			const f = await fixture(child, [release({ binary })]);
			await assert.rejects(f.installer.install(), { code: 'INVALID_ARCHIVE' });
			assert.deepEqual(await readdir(f.root), []);
		});
	}
});

test('manifest validation, executable integrity, and hard-link ownership checks are entirely local', async (t) => {
	const f = await fixture(t);
	const installed = await f.installer.install();
	const manifestPath = join(f.root, 'current-stable-x64.json');
	const original = await readFile(manifestPath, 'utf8');
	const changes: { change: Record<string, unknown>; code: string }[] = [
		{ change: { owner: 'some-other-installer' }, code: 'INVALID_INSTALLATION' },
		{ change: { schema: 2 }, code: 'INCOMPATIBLE_INSTALLATION' },
		{ change: { version: 'latest' }, code: 'INVALID_INSTALLATION' },
		{ change: { architecture: 'arm64' }, code: 'INCOMPATIBLE_INSTALLATION' },
		{ change: { commit: NEXT_COMMIT }, code: 'INVALID_INSTALLATION' },
		{ change: { directory: '../outside' }, code: 'INVALID_INSTALLATION' },
		{ change: { executableSha256: '0'.repeat(64) }, code: 'INTEGRITY_MISMATCH' },
		{ change: { sha256: 'short' }, code: 'INVALID_INSTALLATION' },
		{ change: { url: 'https://attacker.invalid/code' }, code: 'UNSAFE_URL' },
		{ change: { executableBytes: 1 }, code: 'INVALID_INSTALLATION' },
		{ change: { archiveBytes: CODESPACE_CLI_INSTALLER_LIMITS.maxArchiveBytes + 1 }, code: 'INVALID_INSTALLATION' },
		{ change: { executablePath: '/usr/bin/code' }, code: 'INVALID_INSTALLATION' },
	];
	for (const { change, code } of changes) {
		await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(original), ...change }));
		await assert.rejects(f.installer.status(), { code }, JSON.stringify(change));
	}
	await writeFile(manifestPath, Buffer.alloc(CODESPACE_CLI_INSTALLER_LIMITS.maxManifestBytes + 1, 32));
	await assert.rejects(f.installer.status(), { code: 'SIZE_LIMIT' });
	await writeFile(manifestPath, '{invalid JSON containing untrusted details');
	await assert.rejects(f.installer.status(), (error: unknown) => {
		assert.ok(error instanceof CodespaceCliInstallerError);
		assert.equal(error.code, 'INVALID_INSTALLATION');
		assert.equal(error.message.includes('untrusted'), false);
		return true;
	});
	await writeFile(manifestPath, original);
	const binary = await readFile(installed.executablePath);
	const changed = Buffer.from(binary);
	changed[200] ^= 1;
	await writeFile(installed.executablePath, changed);
	await assert.rejects(f.installer.status(), { code: 'INTEGRITY_MISMATCH' });
	changed[4] = 1;
	await writeFile(installed.executablePath, changed);
	await assert.rejects(f.installer.status(), { code: 'INVALID_ARCHIVE' });
	await writeFile(installed.executablePath, binary);
	const alias = join(f.base, 'hard-link');
	await link(installed.executablePath, alias);
	await assert.rejects(f.installer.status(), { code: 'INVALID_INSTALLATION' });
	await unlink(alias);
	assert.deepEqual(await f.installer.status(), installed);
	assert.equal(f.http.calls.length, 2);
});

test('private directory and executable permissions are required on POSIX', { skip: process.geteuid === undefined }, async (t) => {
	const f = await fixture(t);
	const installed = await f.installer.install();
	try {
		await chmod(installed.executablePath, 0o600);
		await assert.rejects(f.installer.status(), { code: 'INVALID_INSTALLATION' });
		await chmod(installed.executablePath, 0o700);
		await chmod(f.root, 0o755);
		await assert.rejects(f.installer.status(), { code: 'INVALID_INSTALLATION' });
		await assert.rejects(f.installer.install(), { code: 'INVALID_INSTALLATION' });
		assert.equal(f.http.calls.length, 2);
	} finally {
		await chmod(f.root, 0o700);
		await chmod(installed.executablePath, 0o700);
	}
});

test('a symbolic link in the storage path is rejected without touching its target', async (t) => {
	const f = await fixture(t);
	const outside = join(f.base, 'outside');
	await mkdir(outside, { mode: 0o700 });
	await symlink(outside, f.root, 'junction');
	const nested = new CodespaceCliInstaller({ ...f.options, storageRoot: join(f.root, 'nested') });
	await assert.rejects(nested.install(), { code: 'INVALID_INSTALLATION' });
	await assert.rejects(nested.status(), { code: 'INVALID_INSTALLATION' });
	assert.deepEqual(await readdir(outside), []);
	assert.deepEqual(f.http.calls, []);
});

test('filesystem symlinks cannot replace a managed version directory', async (t) => {
	const f = await fixture(t);
	const installed = await f.installer.install();
	const manifest = JSON.parse(await readFile(join(f.root, 'current-stable-x64.json'), 'utf8')) as { directory: string };
	const directory = join(f.root, manifest.directory);
	const outside = join(f.base, 'outside');
	await mkdir(outside, { mode: 0o700 });
	await writeFile(join(outside, 'code'), await readFile(installed.executablePath), { mode: 0o700 });
	await rm(directory, { recursive: true });
	await symlink(outside, directory, 'junction');
	await assert.rejects(f.installer.status(), { code: 'INVALID_INSTALLATION' });
	assert.equal(f.http.calls.length, 2);
	assert.deepEqual(await readdir(outside), ['code']);
});

test('a pre-existing cross-process lock is never stolen or removed', async (t) => {
	const f = await fixture(t);
	await mkdir(f.root, { mode: 0o700 });
	const lock = join(f.root, '.install.lock');
	await writeFile(lock, 'owned elsewhere', { mode: 0o600 });
	await assert.rejects(f.installer.install(), { code: 'INSTALL_IN_PROGRESS' });
	assert.equal(await readFile(lock, 'utf8'), 'owned elsewhere');
	assert.deepEqual(f.http.calls, []);
});

test('pre-cancelled installation performs no network or storage writes', async (t) => {
	const f = await fixture(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(f.installer.install({ signal: controller.signal }), { name: 'AbortError', code: 'CANCELLED' });
	assert.deepEqual(f.http.calls, []);
	await assert.rejects(lstat(f.root), { code: 'ENOENT' });
});

test('request timeout also cancels an injected downloader that never responds', async (t) => {
	const f = await fixture(t, undefined, { limits: { requestTimeoutMs: 30, installTimeoutMs: 1000 } });
	f.http.handler = async () => new Promise(() => {});
	await assert.rejects(f.installer.install(), { code: 'TIMED_OUT' });
	assert.equal(await f.installer.status(), undefined);
	await noStaging(f.root);
});

test('cancellation disposes a stalled body and leaves the previous installation unchanged', async (t) => {
	const first = release();
	const next = release({ version: '1.136.3', commit: NEXT_COMMIT, binary: elf('x64', 'next') });
	const f = await fixture(t, [first, next]);
	const installed = await f.installer.install();
	const before = await readFile(join(f.root, 'current-stable-x64.json'));
	const downloading = deferred<void>();
	let disposed = false;
	f.http.handler = async (url) => {
		if (url === next.downloadUrl) {
			return {
				url, statusCode: 200, headers: {},
				body: (async function* () {
					yield next.archive.subarray(0, 16);
					downloading.resolve();
					await new Promise(() => {});
				})(),
				dispose: () => { disposed = true; },
			};
		}
		return f.http.defaultResponse(url);
	};
	const controller = new AbortController();
	const updating = f.installer.install({ version: next.version, commit: next.commit, signal: controller.signal });
	const rejected = assert.rejects(updating, { code: 'CANCELLED' });
	await downloading.promise;
	controller.abort();
	await rejected;
	assert.equal(disposed, true);
	assert.deepEqual(await readFile(join(f.root, 'current-stable-x64.json')), before);
	assert.deepEqual(await f.installer.status(), installed);
	assert.deepEqual(await readFile(installed.executablePath), first.binary);
	await noStaging(f.root);
});

test('cancellation during extraction removes only its own staged files', async (t) => {
	const controller = new AbortController();
	const f = await fixture(t, undefined, {
		archive: { createGunzip: () => { queueMicrotask(() => controller.abort()); return createGunzip(); } },
	});
	const unrelated = join(f.base, 'unrelated');
	await writeFile(unrelated, 'retain');
	await mkdir(f.root, { mode: 0o700 });
	const otherStaging = join(f.root, '.staging-not-owned-by-this-call');
	await mkdir(otherStaging, { mode: 0o700 });
	await writeFile(join(otherStaging, 'retain'), 'older staging');
	await assert.rejects(f.installer.install({ signal: controller.signal }), { code: 'CANCELLED' });
	assert.deepEqual(await readdir(f.root), ['.staging-not-owned-by-this-call']);
	assert.equal(await readFile(unrelated, 'utf8'), 'retain');
	assert.equal(await readFile(join(otherStaging, 'retain'), 'utf8'), 'older staging');
});

test('failed replacement preserves the current manifest and previous executable', async (t) => {
	const first = release();
	const next = release({ version: '1.136.3', commit: NEXT_COMMIT });
	next.metadata.sha256hash = '0'.repeat(64);
	const f = await fixture(t, [first, next]);
	const installed = await f.installer.install();
	const before = await readFile(join(f.root, 'current-stable-x64.json'));
	await assert.rejects(f.installer.install({ version: next.version, commit: next.commit }), { code: 'INTEGRITY_MISMATCH' });
	assert.deepEqual(await readFile(join(f.root, 'current-stable-x64.json')), before);
	assert.deepEqual(await f.installer.status(), installed);
	assert.deepEqual(await readFile(installed.executablePath), first.binary);
	await noStaging(f.root);
});

test('updates publish a new immutable directory atomically while retaining the running executable', async (t) => {
	const first = release();
	const next = release({ version: '1.136.3', commit: NEXT_COMMIT, binary: elf('x64', 'new version') });
	const f = await fixture(t, [first, next]);
	const original = await f.installer.install();
	const downloading = deferred<void>();
	const proceed = deferred<void>();
	f.http.handler = async (url) => {
		const result = f.http.defaultResponse(url);
		if (url !== next.downloadUrl) {
			return result;
		}
		return {
			...result,
			body: (async function* () {
				downloading.resolve();
				await proceed.promise;
				yield* result.body;
			})(),
		};
	};
	const updating = f.installer.install({ version: next.version, commit: next.commit });
	await downloading.promise;
	const calls = f.http.calls.length;
	assert.deepEqual(await f.installer.status(), original);
	assert.equal(f.http.calls.length, calls);
	proceed.resolve();
	const installed = await updating;
	assert.notEqual(installed.executablePath, original.executablePath);
	assert.equal(installed.version, next.version);
	assert.deepEqual(await f.installer.status(), installed);
	assert.deepEqual(await readFile(original.executablePath), first.binary);
	assert.deepEqual(await readFile(installed.executablePath), next.binary);
	await noStaging(f.root);
});

test('installs across instances are serialized even when a queued install is cancelled', async (t) => {
	const first = release();
	const next = release({ version: '1.136.3', commit: NEXT_COMMIT });
	const f = await fixture(t, [first, next]);
	const downloading = deferred<void>();
	const proceed = deferred<void>();
	f.http.handler = async (url) => {
		const result = f.http.defaultResponse(url);
		if (url !== first.downloadUrl) {
			return result;
		}
		return {
			...result,
			body: (async function* () {
				downloading.resolve();
				await proceed.promise;
				yield* result.body;
			})(),
		};
	};
	const firstInstall = f.installer.install();
	await downloading.promise;
	const other = new CodespaceCliInstaller(f.options);
	const controller = new AbortController();
	const cancelledInstall = other.install({ version: next.version, signal: controller.signal });
	const rejected = assert.rejects(cancelledInstall, { code: 'CANCELLED' });
	controller.abort();
	await rejected;
	const thirdInstall = other.install({ version: next.version });
	await Promise.resolve();
	assert.deepEqual(f.http.calls, [first.metadataUrl, first.downloadUrl]);
	proceed.resolve();
	const [original, updated] = await Promise.all([firstInstall, thirdInstall]);
	assert.notEqual(original.executablePath, updated.executablePath);
	assert.deepEqual(await f.installer.status(), updated);
	assert.deepEqual(f.http.calls, [first.metadataUrl, first.downloadUrl, next.metadataUrl, next.downloadUrl]);
	await noStaging(f.root);
});

test('only missing storage or a missing current manifest is an absent installation', async (t) => {
	const f = await fixture(t);
	await mkdir(f.root, { mode: 0o700 });
	let opens = 0;
	const installer = new CodespaceCliInstaller({
		...f.options,
		fileSystem: { open: async () => { opens += 1; throw ioFailure(); } },
	});
	assert.equal(await installer.findInstalled(), undefined);
	assert.equal(await installer.status(), undefined);
	assert.equal(opens, 0);
	assert.deepEqual(await readdir(f.root), []);
	assert.deepEqual(f.http.calls, []);
});

test('root I/O and canonicalization failures are never interpreted as an absent cache', async (t) => {
	for (const operation of ['lstat', 'realpath'] as const) {
		for (const code of ['EACCES', 'EIO']) {
			await t.test(`${operation} ${code}`, async (child) => {
				const f = await fixture(child);
				await mkdir(f.root, { mode: 0o700 });
				const failure = ioFailure(code);
				const installer = new CodespaceCliInstaller({
					...f.options,
					fileSystem: {
						lstat: async (path) => {
							if (path === f.root && operation === 'lstat') { throw failure; }
							return lstat(path);
						},
						realpath: async (path) => {
							if (path === f.root && operation === 'realpath') { throw failure; }
							return realpath(path);
						},
					},
				});
				await assert.rejects(installer.status(), (error: unknown) => error === failure);
				await assert.rejects(installer.install(), (error: unknown) => error === failure);
				assert.deepEqual(f.http.calls, []);
				assert.deepEqual(await readdir(f.root), []);
			});
		}
	}
	await t.test('root disappears after its initial validation', async (child) => {
		const f = await fixture(child);
		await mkdir(f.root, { mode: 0o700 });
		const installer = new CodespaceCliInstaller({
			...f.options, fileSystem: { realpath: async () => { throw ioFailure('ENOENT'); } },
		});
		await assert.rejects(installer.status(), { code: 'INVALID_INSTALLATION' });
		assert.deepEqual(f.http.calls, []);
	});
	await t.test('root is a regular file', async (child) => {
		const f = await fixture(child);
		await writeFile(f.root, 'not a cache', { mode: 0o600 });
		await assert.rejects(f.installer.status(), { code: 'INVALID_INSTALLATION' });
		assert.equal(await readFile(f.root, 'utf8'), 'not a cache');
	});
});

test('present manifests with missing, replaced, or unreadable managed paths fail explicitly', async (t) => {
	for (const scenario of ['manifest-open', 'manifest-directory', 'version-directory', 'executable', 'manifest-stat'] as const) {
		await t.test(scenario, async (child) => {
			const f = await fixture(child);
			const installed = await f.installer.install();
			const manifestPath = join(f.root, 'current-stable-x64.json');
			const failure = ioFailure('EACCES');
			const tracked = trackedFileSystem();
			const files = { ...tracked.files };
			if (scenario === 'manifest-open') {
				files.open = async (path, flags, mode) => {
					if (path === manifestPath) { throw ioFailure('ENOENT'); }
					return tracked.files.open(path, flags, mode);
				};
			} else if (scenario === 'manifest-directory') {
				await unlink(manifestPath);
				await mkdir(manifestPath, { mode: 0o700 });
			} else if (scenario === 'version-directory') {
				const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { directory: string };
				await rm(join(f.root, manifest.directory), { recursive: true });
			} else if (scenario === 'executable') {
				await unlink(installed.executablePath);
			} else {
				files.lstat = async (path) => {
					if (path === manifestPath) { throw failure; }
					return lstat(path);
				};
			}
			const installer = new CodespaceCliInstaller({ ...f.options, fileSystem: files });
			if (scenario === 'manifest-stat') {
				await assert.rejects(installer.status(), (error: unknown) => error === failure);
			} else {
				await assert.rejects(installer.status(), { code: 'INVALID_INSTALLATION' });
			}
			assert.equal(f.http.calls.length, 2);
		});
	}
});

test('status propagates manifest read errors and aggregates them with file-close failures', async (t) => {
	for (const failClose of [false, true]) {
		await t.test(`close failure: ${failClose}`, async (child) => {
			const f = await fixture(child);
			await f.installer.install();
			const tracked = trackedFileSystem();
			const readFailure = ioFailure();
			const closeFailure = ioFailure();
			let closes = 0;
			const installer = new CodespaceCliInstaller({
				...f.options,
				fileSystem: {
					...tracked.files,
					open: async (path, flags, mode) => {
						const file = await tracked.files.open(path, flags, mode);
						if (basename(path) === 'current-stable-x64.json') {
							file.read = async () => { throw readFailure; };
						}
						return file;
					},
					close: async (file) => {
						await file.close();
						closes += 1;
						if (failClose) { throw closeFailure; }
					},
				},
			});
			await assert.rejects(installer.status(), (error: unknown) => failClose
				? includesFailures(error, [readFailure, closeFailure]) : error === readFailure);
			assert.equal(closes, 1);
			assert.equal(f.http.calls.length, 2);
		});
	}
});

test('an invalid existing cache is rejected before an explicit install requests any release', async (t) => {
	const f = await fixture(t);
	const installed = await f.installer.install();
	const before = await readFile(join(f.root, 'current-stable-x64.json'));
	const binary = await readFile(installed.executablePath);
	binary[200] ^= 1;
	await writeFile(installed.executablePath, binary);
	await assert.rejects(f.installer.install(), { code: 'INTEGRITY_MISMATCH' });
	assert.equal(f.http.calls.length, 2);
	assert.deepEqual(await readFile(join(f.root, 'current-stable-x64.json')), before);
	await noStaging(f.root);
});

test('status propagates lifetime cancellation before I/O, during reads, and during file closure', async (t) => {
	for (const phase of ['before', 'root', 'manifest', 'hash', 'close'] as const) {
		await t.test(phase, async (child) => {
			const f = await fixture(child);
			const installed = phase === 'before' ? undefined : await f.installer.install();
			const controller = new AbortController();
			const tracked = trackedFileSystem();
			const installer = new CodespaceCliInstaller({
				...f.options, signal: controller.signal,
				fileSystem: {
					...tracked.files,
					lstat: async (path) => {
						const info = await lstat(path);
						if ((phase === 'root' && path === f.root)
							|| (phase === 'manifest' && basename(path) === 'current-stable-x64.json')) {
							controller.abort();
						}
						return info;
					},
					open: async (path, flags, mode) => {
						const file = await tracked.files.open(path, flags, mode);
						if (phase === 'hash' && path === installed?.executablePath) {
							file.read = async () => { controller.abort(); throw new CodespaceCliInstallerError('CANCELLED', 'Cancelled.'); };
						}
						return file;
					},
					close: async (file) => {
						await file.close();
						if (phase === 'close' && tracked.paths.get(file) === installed?.executablePath) {
							controller.abort();
						}
					},
				},
			});
			if (phase === 'before') { controller.abort(); }
			await assert.rejects(installer.status(), { name: 'AbortError', code: 'CANCELLED' });
			assert.equal(f.http.calls.length, phase === 'before' ? 0 : 2);
		});
	}
});

test('post-publication cleanup aggregates every failure without deleting either installed executable', async (t) => {
	const first = release();
	const next = release({ version: '1.136.3', commit: NEXT_COMMIT, binary: elf('x64', 'updated') });
	const f = await fixture(t, [first, next]);
	const original = await f.installer.install();
	const tracked = trackedFileSystem();
	const removalFailure = ioFailure();
	const closeFailure = ioFailure();
	const unlinkFailure = ioFailure();
	const installer = new CodespaceCliInstaller({
		...f.options,
		fileSystem: {
			...tracked.files,
			rm: async (path, options) => {
				if (basename(path).startsWith('.staging-')) { throw removalFailure; }
				await rm(path, options);
			},
			close: async (file) => {
				await file.close();
				if (basename(tracked.paths.get(file)!) === '.install.lock') { throw closeFailure; }
			},
			unlink: async (path) => {
				if (basename(path) === '.install.lock') { throw unlinkFailure; }
				await unlink(path);
			},
		},
	});
	await assert.rejects(installer.install({ version: next.version }), (error: unknown) =>
		includesFailures(error, [removalFailure, closeFailure, unlinkFailure]));
	const updated = await f.installer.status();
	assert.ok(updated);
	assert.equal(updated.version, next.version);
	assert.notEqual(updated.executablePath, original.executablePath);
	assert.deepEqual(await readFile(updated.executablePath), next.binary);
	assert.deepEqual(await readFile(original.executablePath), first.binary);
	assert.ok((await readdir(f.root)).some((name) => name.startsWith('.staging-')));
	await assert.rejects(f.installer.install(), { code: 'INSTALL_IN_PROGRESS' });
});

test('cancellation and integrity failure remain visible alongside every cleanup failure', async (t) => {
	for (const cause of ['cancel', 'integrity'] as const) {
		await t.test(cause, async (child) => {
			const first = release();
			const next = release({ version: '1.136.3', commit: NEXT_COMMIT });
			if (cause === 'integrity') { next.metadata.sha256hash = '0'.repeat(64); }
			const f = await fixture(child, [first, next]);
			const original = await f.installer.install();
			const before = await readFile(join(f.root, 'current-stable-x64.json'));
			const controller = new AbortController();
			const downloading = deferred<void>();
			if (cause === 'cancel') {
				f.http.handler = async (url) => url !== next.downloadUrl ? f.http.defaultResponse(url) : {
					url, statusCode: 200, headers: {},
					body: (async function* () {
						yield next.archive.subarray(0, 16);
						downloading.resolve();
						await new Promise(() => {});
					})(),
					dispose() {},
				};
			}
			const tracked = trackedFileSystem();
			const closeFailure = ioFailure();
			const removalFailure = ioFailure();
			const unlinkFailure = ioFailure();
			const installer = new CodespaceCliInstaller({
				...f.options,
				fileSystem: {
					...tracked.files,
					close: async (file) => {
						await file.close();
						if (basename(tracked.paths.get(file)!) === 'archive.tar.gz') { throw closeFailure; }
					},
					rm: async () => { throw removalFailure; },
					unlink: async (path) => {
						if (basename(path) === '.install.lock') { throw unlinkFailure; }
						await unlink(path);
					},
				},
			});
			const installing = installer.install({ version: next.version, signal: controller.signal });
			const rejected = assert.rejects(installing, (error: unknown) => {
				includesFailures(error, [closeFailure, removalFailure, unlinkFailure]);
				assert.ok(error instanceof AggregateError);
				assert.ok(error.errors[0] instanceof CodespaceCliInstallerError);
				assert.equal(error.errors[0].code, cause === 'cancel' ? 'CANCELLED' : 'INTEGRITY_MISMATCH');
				return true;
			});
			if (cause === 'cancel') {
				await downloading.promise;
				controller.abort();
			}
			await rejected;
			assert.deepEqual(await readFile(join(f.root, 'current-stable-x64.json')), before);
			assert.deepEqual(await f.installer.status(), original);
			assert.deepEqual(await readFile(original.executablePath), first.binary);
		});
	}
});

test('a replaced lock fails cleanup visibly and is never unlinked after a successful publication', async (t) => {
	const f = await fixture(t);
	const tracked = trackedFileSystem();
	const lockPath = join(f.root, '.install.lock');
	const installer = new CodespaceCliInstaller({
		...f.options,
		fileSystem: {
			...tracked.files,
			close: async (file) => {
				await file.close();
				if (tracked.paths.get(file) === lockPath) {
					await rename(lockPath, join(f.base, 'previous-lock'));
					await writeFile(lockPath, 'replacement owner', { mode: 0o600 });
				}
			},
		},
	});
	await assert.rejects(installer.install(), (error: unknown) => {
		assert.ok(error instanceof AggregateError);
		assert.equal(error.errors.length, 1);
		assert.ok(error.errors[0] instanceof CodespaceCliInstallerError);
		assert.equal(error.errors[0].code, 'INVALID_INSTALLATION');
		return true;
	});
	assert.equal(await readFile(lockPath, 'utf8'), 'replacement owner');
	assert.ok(await f.installer.status());
});

test('unverifiable lock or staging ownership reports both the I/O failure and retained-resource failure', async (t) => {
	for (const resource of ['lock', 'staging'] as const) {
		await t.test(resource, async (child) => {
			const f = await fixture(child);
			const tracked = trackedFileSystem();
			const failure = ioFailure();
			const installer = new CodespaceCliInstaller({
				...f.options,
				fileSystem: {
					...tracked.files,
					open: async (path, flags, mode) => {
						const file = await tracked.files.open(path, flags, mode);
						if (resource === 'lock' && basename(path) === '.install.lock') {
							file.stat = async () => { throw failure; };
						}
						return file;
					},
					lstat: async (path) => {
						if (resource === 'staging' && basename(path).startsWith('.staging-')) { throw failure; }
						return lstat(path);
					},
				},
			});
			await assert.rejects(installer.install(), (error: unknown) => {
				includesFailures(error, [failure]);
				assert.ok(error instanceof AggregateError);
				assert.ok(error.errors.some((item: unknown) => item instanceof CodespaceCliInstallerError && item.code === 'INVALID_INSTALLATION'));
				return true;
			});
			const entries = await readdir(f.root);
			assert.ok(resource === 'lock' ? entries.includes('.install.lock') : entries.some((entry) => entry.startsWith('.staging-')));
			assert.equal(await f.installer.status(), undefined);
		});
	}
});

test('manifest write and close failures preserve the old manifest and both original causes', async (t) => {
	const first = release();
	const next = release({ version: '1.136.3', commit: NEXT_COMMIT });
	const f = await fixture(t, [first, next]);
	const original = await f.installer.install();
	const before = await readFile(join(f.root, 'current-stable-x64.json'));
	const tracked = trackedFileSystem();
	const writeFailure = ioFailure();
	const closeFailure = ioFailure();
	const installer = new CodespaceCliInstaller({
		...f.options,
		fileSystem: {
			...tracked.files,
			open: async (path, flags, mode) => {
				const file = await tracked.files.open(path, flags, mode);
				if (basename(path) === 'current.json') { file.writeFile = async () => { throw writeFailure; }; }
				return file;
			},
			close: async (file) => {
				await file.close();
				if (basename(tracked.paths.get(file)!) === 'current.json') { throw closeFailure; }
			},
		},
	});
	await assert.rejects(installer.install({ version: next.version }), (error: unknown) =>
		includesFailures(error, [writeFailure, closeFailure]));
	assert.deepEqual(await readFile(join(f.root, 'current-stable-x64.json')), before);
	assert.deepEqual(await f.installer.status(), original);
	await noStaging(f.root);
});

test('failed manifest publication rolls back only the unpublished version and reports failed rollback', async (t) => {
	for (const failRemoval of [false, true]) {
		await t.test(`rollback failure: ${failRemoval}`, async (child) => {
			const first = release();
			const next = release({ version: '1.136.3', commit: NEXT_COMMIT });
			const f = await fixture(child, [first, next]);
			const original = await f.installer.install();
			const before = await readFile(join(f.root, 'current-stable-x64.json'));
			const renameFailure = ioFailure();
			const removalFailure = ioFailure();
			const installer = new CodespaceCliInstaller({
				...f.options,
				fileSystem: {
					rename: async (from, to) => {
						if (basename(to) === 'current-stable-x64.json') { throw renameFailure; }
						await rename(from, to);
					},
					rm: async (path, options) => {
						if (failRemoval && basename(path).startsWith(`stable-x64-${NEXT_COMMIT}-`)) { throw removalFailure; }
						await rm(path, options);
					},
				},
			});
			await assert.rejects(installer.install({ version: next.version }), (error: unknown) =>
				failRemoval ? includesFailures(error, [renameFailure, removalFailure]) : error === renameFailure);
			assert.deepEqual(await readFile(join(f.root, 'current-stable-x64.json')), before);
			assert.deepEqual(await f.installer.status(), original);
			assert.deepEqual(await readFile(original.executablePath), first.binary);
			const versions = (await readdir(f.root)).filter((entry) => entry.startsWith('stable-x64-'));
			assert.equal(versions.length, failRemoval ? 2 : 1);
			await noStaging(f.root);
		});
	}
});
