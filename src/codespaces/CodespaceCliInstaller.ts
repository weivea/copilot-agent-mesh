import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { get } from 'node:https';
import { isAbsolute, join, normalize, parse, resolve, sep } from 'node:path';
import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { CodespaceLibcDetectionError, CodespaceSystemLibc } from './CodespaceSystemLibc';

export type CodespaceCliQuality = 'stable' | 'insider';
export type CodespaceCliArchitecture = 'x64' | 'arm64';

export const CODESPACE_CLI_LICENSE_URL = 'https://code.visualstudio.com/license/server';
const UPDATE_ORIGIN = 'https://update.code.visualstudio.com';
const DOWNLOAD_ORIGIN = 'https://vscode.download.prss.microsoft.com';
const OWNER = 'copilot-agent-mesh.codespaces-cli';
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-insider)?$/;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';

export interface CodespaceCliInstallerLimits {
	readonly maxMetadataBytes: number;
	readonly maxArchiveBytes: number;
	readonly maxExecutableBytes: number;
	readonly maxDecompressedBytes: number;
	readonly maxManifestBytes: number;
	readonly maxRedirects: number;
	readonly requestTimeoutMs: number;
	readonly installTimeoutMs: number;
}

export const CODESPACE_CLI_INSTALLER_LIMITS: Readonly<CodespaceCliInstallerLimits> = Object.freeze({
	maxMetadataBytes: 64 * 1024,
	maxArchiveBytes: 64 * 1024 * 1024,
	maxExecutableBytes: 128 * 1024 * 1024,
	maxDecompressedBytes: 128 * 1024 * 1024 + 64 * 1024,
	maxManifestBytes: 8192,
	maxRedirects: 3,
	requestTimeoutMs: 120_000,
	installTimeoutMs: 300_000,
});

export interface CodespaceCliInstallerHttpResponse {
	/** The actual response URL. Adapters must not follow redirects or decompress HTTP bodies. */
	readonly url: string;
	readonly statusCode: number;
	readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
	readonly body: AsyncIterable<Uint8Array>;
	dispose(): void;
}

export interface CodespaceCliInstallerHttp {
	request(url: string, signal: AbortSignal): Promise<CodespaceCliInstallerHttpResponse>;
}

export interface CodespaceCliInstallerArchiveAdapter {
	/** Only decompression is replaceable; entry validation and all writes remain in the installer. */
	createGunzip(): Transform;
}

export interface CodespaceCliInstallerProcessAdapter {
	/** Read-only system libc detection; never downloads, authenticates, or starts an Agent Host. */
	glibcVersionRuntime(signal?: AbortSignal): string | undefined | Promise<string | undefined>;
}

export interface CodespaceCliInstallerFileSystem {
	lstat(path: string): Promise<Stats>;
	mkdir(path: string, options: { mode: number }): Promise<void>;
	open(path: string, flags: number, mode?: number): Promise<FileHandle>;
	realpath(path: string): Promise<string>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string, options: { recursive: true; force: true }): Promise<void>;
	unlink(path: string): Promise<void>;
	close(file: FileHandle): Promise<void>;
}

export interface CodespaceCliInstallerOptions {
	readonly storageRoot: string;
	readonly platform?: string;
	readonly architecture?: string;
	readonly quality?: CodespaceCliQuality;
	/** Exact editor release, normally vscode.version. There is deliberately no "latest" default. */
	readonly version?: string;
	readonly commit?: string;
	readonly signal?: AbortSignal;
	readonly http?: CodespaceCliInstallerHttp;
	readonly archive?: CodespaceCliInstallerArchiveAdapter;
	readonly process?: CodespaceCliInstallerProcessAdapter;
	/** Filesystem fault injection does not replace any ownership or integrity checks. */
	readonly fileSystem?: Partial<CodespaceCliInstallerFileSystem>;
	/** Tests or callers may lower, but never remove or increase, the hard limits. */
	readonly limits?: Partial<CodespaceCliInstallerLimits>;
}

export interface CodespaceCliInstallRequest {
	readonly version?: string;
	readonly commit?: string;
	readonly signal?: AbortSignal;
}

export interface InstalledCodespaceCli {
	readonly executablePath: string;
	readonly platform: 'linux';
	readonly architecture: CodespaceCliArchitecture;
	readonly quality: CodespaceCliQuality;
	readonly version: string;
	readonly commit: string;
	readonly url: string;
	/** Official release metadata's SHA-256 of the downloaded archive. */
	readonly sha256: string;
	/** SHA-256 of the extracted executable, checked again by every local status read. */
	readonly executableSha256: string;
}

interface Release {
	readonly platform: 'linux';
	readonly architecture: CodespaceCliArchitecture;
	readonly quality: CodespaceCliQuality;
	readonly version: string;
	readonly commit: string;
	readonly url: string;
	readonly sha256: string;
}

interface Manifest extends Release {
	readonly schema: 1;
	readonly owner: typeof OWNER;
	readonly directory: string;
	readonly archiveBytes: number;
	readonly executableBytes: number;
	readonly executableSha256: string;
}

export type InstallerErrorCode = 'UNSUPPORTED_ENVIRONMENT' | 'ENVIRONMENT_CHECK_FAILED' | 'INVALID_RELEASE' | 'UNSAFE_URL'
	| 'NETWORK_ERROR' | 'INTEGRITY_MISMATCH' | 'SIZE_LIMIT' | 'INVALID_ARCHIVE'
	| 'INVALID_INSTALLATION' | 'INCOMPATIBLE_INSTALLATION' | 'INSTALL_IN_PROGRESS' | 'INSTALL_FAILED' | 'CANCELLED' | 'TIMED_OUT';

export class CodespaceCliInstallerError extends Error {
	public constructor(public readonly code: InstallerErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = code === 'CANCELLED' ? 'AbortError' : 'CodespaceCliInstallerError';
	}
}

const installQueues = new Map<string, Promise<void>>();

/**
 * Provisioning is never implicit. The companion must obtain native VS Code download/license
 * consent before calling install(). This class neither prompts nor executes the downloaded CLI.
 */
export class CodespaceCliInstaller {
	private readonly storageRoot: string;
	private readonly platform: string;
	private readonly architecture: string;
	private readonly quality: CodespaceCliQuality;
	private readonly limits: CodespaceCliInstallerLimits;
	private readonly http: CodespaceCliInstallerHttp;
	private readonly archive: CodespaceCliInstallerArchiveAdapter;
	private readonly processAdapter: CodespaceCliInstallerProcessAdapter;
	private readonly files: CodespaceCliInstallerFileSystem;

	public constructor(private readonly options: CodespaceCliInstallerOptions) {
		if (!isAbsolute(options.storageRoot) || options.storageRoot.includes('\0')) {
			throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'Private CLI storage must be an absolute path.');
		}
		this.storageRoot = resolve(options.storageRoot);
		if (this.storageRoot === parse(this.storageRoot).root) {
			throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'The filesystem root is not private CLI storage.');
		}
		this.platform = options.platform ?? process.platform;
		this.architecture = options.architecture ?? process.arch;
		this.quality = options.quality ?? 'stable';
		this.limits = lowerLimits(options.limits);
		this.http = options.http ?? nativeHttp;
		this.archive = options.archive ?? { createGunzip: () => createGunzip({ chunkSize: 64 * 1024 }) };
		this.files = { ...nativeFileSystem, ...options.fileSystem };
		this.processAdapter = options.process ?? new CodespaceSystemLibc();
	}

	/** Read-only. Only an absent root/current manifest returns undefined; invalid caches and I/O failures reject. */
	public findInstalled(): Promise<InstalledCodespaceCli | undefined> {
		return this.readInstalled(this.options.signal);
	}

	public status(): Promise<InstalledCodespaceCli | undefined> {
		return this.findInstalled();
	}

	private async readInstalled(signal?: AbortSignal): Promise<InstalledCodespaceCli | undefined> {
		throwIfAborted(signal);
		await this.assertEnvironment(signal);
		if (!await this.checkRoot(false, signal)) {
			return undefined;
		}
		const bytes = await readSmallFile(this.files, this.currentPath(), this.limits.maxManifestBytes, signal);
		throwIfAborted(signal);
		if (bytes === undefined) {
			return undefined;
		}
		const manifest = this.parseManifest(bytes);
		const directory = join(this.storageRoot, manifest.directory);
		checkOwned(await requireManagedPath(() => this.files.lstat(directory)), true);
		throwIfAborted(signal);
		const executablePath = join(directory, 'code');
		checkOwned(await requireManagedPath(() => this.files.lstat(executablePath)), false, true);
		throwIfAborted(signal);
		const file = await requireManagedPath(() => this.files.open(executablePath, constants.O_RDONLY | NOFOLLOW | NONBLOCK));
		const installed = await withClosedFile(this.files, file, async () => {
			const executable = await inspectExecutable(file, manifest.architecture, this.limits, signal);
			if (executable.size !== manifest.executableBytes || executable.sha256 !== manifest.executableSha256) {
				throw new CodespaceCliInstallerError('INTEGRITY_MISMATCH', 'The managed CLI executable does not match its installation manifest.');
			}
			throwIfAborted(signal);
			return this.installed(manifest);
		});
		throwIfAborted(signal);
		return installed;
	}

	/** Explicit, consented operation only. The result makes no claim about Agent Host capabilities. */
	public async install(request: CodespaceCliInstallRequest = {}): Promise<InstalledCodespaceCli> {
		const signal = AbortSignal.any([this.options.signal, request.signal].filter((value): value is AbortSignal => value !== undefined));
		await this.assertEnvironment(signal);
		const version = request.version ?? this.options.version;
		const commit = request.commit ?? this.options.commit;
		assertVersion(version, this.quality);
		if (commit !== undefined && !COMMIT.test(commit)) {
			throw new CodespaceCliInstallerError('INVALID_RELEASE', 'A pinned CLI commit must be a full lowercase Git commit.');
		}
		const scope = abortScope([this.options.signal, request.signal], this.limits.installTimeoutMs);
		try {
			return await serialized(this.storageRoot, scope.signal, () => this.installRelease(version, commit, scope.signal));
		} finally {
			scope.dispose();
		}
	}

	private async assertEnvironment(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		if (this.platform !== 'linux' || (this.architecture !== 'x64' && this.architecture !== 'arm64')
			|| (this.quality !== 'stable' && this.quality !== 'insider')) {
			throw new CodespaceCliInstallerError(
				'UNSUPPORTED_ENVIRONMENT', 'The managed VS Code CLI requires Linux x64 or arm64 with glibc 2.28 or newer.',
			);
		}
		let glibc: string | undefined;
		try {
			glibc = await this.processAdapter.glibcVersionRuntime(signal);
		} catch (error: unknown) {
			if (error instanceof AggregateError) {
				throw error;
			}
			throwIfAborted(signal);
			if (!(error instanceof CodespaceLibcDetectionError)) {
				throw error;
			}
			throw new CodespaceCliInstallerError('ENVIRONMENT_CHECK_FAILED',
				'System glibc detection failed. Run getconf GNU_LIBC_VERSION in the Codespace terminal and check the companion Output.', { cause: error });
		}
		throwIfAborted(signal);
		const parts = typeof glibc === 'string' ? /^(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?$/u.exec(glibc) : null;
		if (parts === null) {
			throw new CodespaceCliInstallerError('ENVIRONMENT_CHECK_FAILED',
				'The system glibc version could not be determined. An unknown version is not proof of an unsupported container.');
		}
		if (Number(parts[1]) < 2 || (Number(parts[1]) === 2 && Number(parts[2]) < 28)) {
			throw new CodespaceCliInstallerError('UNSUPPORTED_ENVIRONMENT',
				`The Codespace reports glibc ${glibc}; the native VS Code CLI requires glibc 2.28 or newer.`);
		}
	}

	private currentPath(): string {
		return join(this.storageRoot, `current-${this.quality}-${this.architecture}.json`);
	}

	private async checkRoot(create: boolean, signal?: AbortSignal): Promise<boolean> {
		let directory = parse(this.storageRoot).root;
		let info: Stats | undefined;
		for (const part of this.storageRoot.slice(directory.length).split(sep)) {
			throwIfAborted(signal);
			directory = join(directory, part);
			if (create) {
				try {
					await this.files.mkdir(directory, { mode: 0o700 });
				} catch (error: unknown) {
					if (!hasCode(error, 'EEXIST')) {
						throw error;
					}
				}
			}
			try {
				info = await this.files.lstat(directory);
			} catch (error: unknown) {
				throwIfAborted(signal);
				if (!create && hasCode(error, 'ENOENT')) {
					return false;
				}
				throw error;
			}
			throwIfAborted(signal);
			if (!info.isDirectory() || info.isSymbolicLink()) {
				throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'Private CLI storage cannot contain a symbolic link.');
			}
		}
		checkOwned(info!, true);
		const canonical = await requireManagedPath(() => this.files.realpath(this.storageRoot));
		throwIfAborted(signal);
		if (!samePath(canonical, this.storageRoot)) {
			throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'Private CLI storage must have a canonical path.');
		}
		return true;
	}

	private async installRelease(version: string, commit: string | undefined, signal: AbortSignal): Promise<InstalledCodespaceCli> {
		throwIfAborted(signal);
		await this.checkRoot(true, signal);
		throwIfAborted(signal);
		const lockPath = join(this.storageRoot, '.install.lock');
		let lock: FileHandle;
		try {
			lock = await this.files.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
		} catch (error: unknown) {
			if (hasCode(error, 'EEXIST')) {
				throw new CodespaceCliInstallerError(
					'INSTALL_IN_PROGRESS', 'Another CLI installation owns this cache. A stale lock must be checked before removal.',
				);
			}
			throw error;
		}
		let lockIdentity: Stats | undefined;
		let staging: { path: string; identity?: Stats } | undefined;
		let published: { path: string; identity: Stats } | undefined;
		let activated = false;
		let archiveFile: FileHandle | undefined;
		let executableFile: FileHandle | undefined;
		let failure: { error: unknown } | undefined;
		try {
			lockIdentity = await lock.stat();
			await lock.writeFile(JSON.stringify({ owner: OWNER, token: randomUUID() }));
			const previous = await this.readInstalled(signal);
			const release = await this.readRelease(version, commit, signal);
			throwIfAborted(signal);
			if (previous?.commit === release.commit && previous.version === release.version
				&& previous.sha256 === release.sha256 && previous.url === release.url) {
				return previous;
			}
			const stagingPath = join(this.storageRoot, `.staging-${randomUUID()}`);
			await this.files.mkdir(stagingPath, { mode: 0o700 });
			staging = { path: stagingPath };
			staging.identity = await this.files.lstat(stagingPath);
			const archivePath = join(stagingPath, 'archive.tar.gz');
			archiveFile = await this.files.open(archivePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
			const archiveHash = createHash('sha256');
			const archiveBytes = await this.withResponse(release.url, signal, release, (response, responseSignal) =>
				consumeBody(response, this.limits.maxArchiveBytes, responseSignal, async (chunk) => {
					await archiveFile!.writeFile(chunk);
					archiveHash.update(chunk);
				}));
			if (archiveBytes === 0 || archiveHash.digest('hex') !== release.sha256) {
				throw new CodespaceCliInstallerError('INTEGRITY_MISMATCH', 'The official CLI archive SHA-256 did not match.');
			}
			throwIfAborted(signal);
			await archiveFile.sync();
			const payload = join(stagingPath, 'release');
			await this.files.mkdir(payload, { mode: 0o700 });
			executableFile = await this.files.open(join(payload, 'code'), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o700);
			await extractExecutable(
				archiveFile.createReadStream({ start: 0, end: archiveBytes - 1, autoClose: false }),
				executableFile, this.quality, this.archive, this.limits, signal,
			);
			await executableFile.chmod(0o700);
			await executableFile.sync();
			const executable = await inspectExecutable(executableFile, release.architecture, this.limits, signal);
			await withClosedFile(this.files, executableFile, async () => undefined);
			executableFile = undefined;
			await withClosedFile(this.files, archiveFile, async () => undefined);
			archiveFile = undefined;
			await this.files.unlink(archivePath);
			const directory = `${release.quality}-${release.architecture}-${release.commit}-${randomUUID()}`;
			const manifest: Manifest = {
				schema: 1, owner: OWNER, directory, ...release, archiveBytes,
				executableBytes: executable.size, executableSha256: executable.sha256,
			};
			const bytes = Buffer.from(JSON.stringify(manifest));
			if (bytes.length > this.limits.maxManifestBytes) {
				throw new CodespaceCliInstallerError('SIZE_LIMIT', 'The CLI installation manifest exceeds its limit.');
			}
			const next = join(stagingPath, 'current.json');
			const nextFile = await this.files.open(next, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
			await withClosedFile(this.files, nextFile, async () => {
				await nextFile.writeFile(bytes);
				await nextFile.sync();
			});
			throwIfAborted(signal);
			await assertIdentity(this.files, lockPath, lockIdentity);
			await assertIdentity(this.files, staging.path, staging.identity);
			if (!await this.checkRoot(false, signal)) {
				throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'Private CLI storage disappeared before publication.');
			}
			const destination = join(this.storageRoot, directory);
			const payloadIdentity = await this.files.lstat(payload);
			await this.files.rename(payload, destination);
			published = { path: destination, identity: payloadIdentity };
			throwIfAborted(signal);
			// The immutable executable is published before the atomic current-manifest switch.
			// Old directories stay intact: a running owned Host may still be using one.
			await this.files.rename(next, this.currentPath());
			activated = true;
			return this.installed(manifest);
		} catch (error: unknown) {
			failure = { error };
			throw error;
		} finally {
			const cleanupErrors: unknown[] = [];
			const cleanup = async (action: () => Promise<unknown>) => {
				try {
					await action();
				} catch (error: unknown) {
					cleanupErrors.push(error);
				}
			};
			if (executableFile !== undefined) {
				await cleanup(() => this.files.close(executableFile!));
			}
			if (archiveFile !== undefined) {
				await cleanup(() => this.files.close(archiveFile!));
			}
			if (published !== undefined && !activated) {
				await cleanup(() => removeOwnedDirectory(this.files, published!));
			}
			if (staging !== undefined) {
				await cleanup(() => removeOwnedDirectory(this.files, staging!));
			}
			await cleanup(() => this.files.close(lock));
			// Never delete a replacement lock, scan for staging directories, or steal a stale lock.
			await cleanup(async () => {
				await assertIdentity(this.files, lockPath, lockIdentity);
				await this.files.unlink(lockPath);
			});
			if (cleanupErrors.length > 0) {
				throw new AggregateError(
					[...(failure === undefined ? [] : [failure.error]), ...cleanupErrors],
					activated ? 'The CLI was published, but owned-resource cleanup failed.'
						: 'CLI installation or owned-resource cleanup failed.',
				);
			}
		}
	}

	private async readRelease(version: string, expectedCommit: string | undefined, signal: AbortSignal): Promise<Release> {
		// This route and its name/version/sha256hash fields are used by the upstream VS Code update service.
		const url = `${UPDATE_ORIGIN}/api/versions/${version}/cli-linux-${this.architecture}/${this.quality}`;
		const chunks: Buffer[] = [];
		await this.withResponse(url, signal, undefined, (response, responseSignal) =>
			consumeBody(response, this.limits.maxMetadataBytes, responseSignal, async (chunk) => {
				chunks.push(Buffer.from(chunk));
			}));
		let data: unknown;
		try {
			data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch {
			throw new CodespaceCliInstallerError('INVALID_RELEASE', 'The official CLI release metadata was not valid JSON.');
		}
		if (!isRecord(data) || data.name !== version || (data.productVersion !== undefined && data.productVersion !== version)
			|| typeof data.version !== 'string' || !COMMIT.test(data.version)
			|| (expectedCommit !== undefined && data.version !== expectedCommit)
			|| typeof data.sha256hash !== 'string' || !SHA256.test(data.sha256hash.toLowerCase())
			|| typeof data.url !== 'string') {
			throw new CodespaceCliInstallerError('INVALID_RELEASE', 'The pinned CLI release needs matching version, commit, URL, and SHA-256 metadata.');
		}
		const release: Release = {
			platform: 'linux', architecture: this.architecture as CodespaceCliArchitecture,
			quality: this.quality, version, commit: data.version, url: data.url, sha256: data.sha256hash.toLowerCase(),
		};
		validateDownloadUrl(release.url, release);
		return release;
	}

	private async withResponse<T>(
		initialUrl: string,
		signal: AbortSignal,
		release: Release | undefined,
		consume: (response: CodespaceCliInstallerHttpResponse, signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		let url = initialUrl;
		for (let redirects = 0; ; redirects += 1) {
			throwIfAborted(signal);
			if (release !== undefined) {
				validateDownloadUrl(url, release);
			}
			const scope = abortScope([signal], this.limits.requestTimeoutMs);
			let response: CodespaceCliInstallerHttpResponse | undefined;
			try {
				const pending = this.http.request(url, scope.signal).then((value) => {
					if (scope.signal.aborted) {
						value.dispose();
						throwIfAborted(scope.signal);
					}
					return value;
				});
				response = await abortable(pending, scope.signal);
				if (response.url !== url) {
					throw new CodespaceCliInstallerError('UNSAFE_URL', 'The CLI downloader must not follow redirects automatically.');
				}
				if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
					const location = header(response, 'location');
					if (release === undefined || location === undefined || redirects >= this.limits.maxRedirects) {
						throw new CodespaceCliInstallerError('UNSAFE_URL', 'The CLI update service returned an unsupported redirect.');
					}
					try {
						url = new URL(location, url).href;
					} catch {
						throw new CodespaceCliInstallerError('UNSAFE_URL', 'The CLI archive redirect URL is invalid.');
					}
					validateDownloadUrl(url, release);
					continue;
				}
				if (response.statusCode !== 200) {
					throw new CodespaceCliInstallerError('NETWORK_ERROR', 'The official service did not return the pinned CLI release.');
				}
				return await consume(response, scope.signal);
			} catch (error: unknown) {
				throwIfAborted(scope.signal);
				if (error instanceof CodespaceCliInstallerError) {
					throw error;
				}
				throw new CodespaceCliInstallerError('NETWORK_ERROR', 'The official CLI release request failed.');
			} finally {
				response?.dispose();
				scope.dispose();
			}
		}
	}

	private parseManifest(bytes: Buffer): Manifest {
		let value: unknown;
		try {
			value = JSON.parse(bytes.toString('utf8'));
		} catch {
			throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'The private CLI manifest is not valid JSON.');
		}
		if (isRecord(value) && value.owner === OWNER && Number.isInteger(value.schema) && value.schema !== 1) {
			throw new CodespaceCliInstallerError('INCOMPATIBLE_INSTALLATION', 'The private CLI manifest uses an unsupported format.');
		}
		if (!isRecord(value) || Object.keys(value).sort().join(',') !== [
			'architecture', 'archiveBytes', 'commit', 'directory', 'executableBytes', 'executableSha256',
			'owner', 'platform', 'quality', 'schema', 'sha256', 'url', 'version',
		].sort().join(',')
			|| value.schema !== 1 || value.owner !== OWNER || typeof value.platform !== 'string'
			|| (value.architecture !== 'x64' && value.architecture !== 'arm64')
			|| (value.quality !== 'stable' && value.quality !== 'insider')
			|| typeof value.commit !== 'string' || !COMMIT.test(value.commit)
			|| typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)
			|| typeof value.executableSha256 !== 'string' || !SHA256.test(value.executableSha256)
			|| typeof value.url !== 'string' || typeof value.directory !== 'string'
			|| !boundedInteger(value.archiveBytes, 1, this.limits.maxArchiveBytes)
			|| !boundedInteger(value.executableBytes, 64, this.limits.maxExecutableBytes)) {
			throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'The private CLI manifest is invalid.');
		}
		if (value.platform !== 'linux' || value.architecture !== this.architecture || value.quality !== this.quality) {
			throw new CodespaceCliInstallerError('INCOMPATIBLE_INSTALLATION', 'The private CLI manifest does not match the selected Linux architecture and quality.');
		}
		if (typeof value.version !== 'string' || !VERSION.test(value.version)
			|| value.version.endsWith('-insider') !== (this.quality === 'insider')) {
			throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'The private CLI manifest does not contain an exact release version.');
		}
		if (!new RegExp(`^${this.quality}-${this.architecture}-${value.commit}-${UUID}$`).test(value.directory)) {
			throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'The CLI manifest does not name an owned version directory.');
		}
		const manifest = value as unknown as Manifest;
		validateDownloadUrl(manifest.url, manifest);
		return manifest;
	}

	private installed(manifest: Manifest): InstalledCodespaceCli {
		return Object.freeze({
			executablePath: join(this.storageRoot, manifest.directory, 'code'),
			platform: manifest.platform, architecture: manifest.architecture, quality: manifest.quality,
			version: manifest.version, commit: manifest.commit, url: manifest.url,
			sha256: manifest.sha256, executableSha256: manifest.executableSha256,
		});
	}
}

const nativeFileSystem: CodespaceCliInstallerFileSystem = {
	lstat: (path) => lstat(path),
	mkdir: async (path, options) => { await mkdir(path, options); },
	open: (path, flags, mode) => open(path, flags, mode),
	realpath: (path) => realpath(path),
	rename: (from, to) => rename(from, to),
	rm: (path, options) => rm(path, options),
	unlink: (path) => unlink(path),
	close: (file) => file.close(),
};

const nativeHttp: CodespaceCliInstallerHttp = {
	request: (url, signal) => new Promise((accept, reject) => {
		const request = get(url, {
			signal, rejectUnauthorized: true, minVersion: 'TLSv1.2', maxHeaderSize: 16 * 1024,
			headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'Copilot-Agent-Mesh-Codespaces-Installer' },
		}, (response) => accept({
			url, statusCode: response.statusCode ?? 0, headers: response.headers,
			body: response, dispose: () => { response.destroy(); },
		}));
		request.once('error', reject);
	}),
};

function validateDownloadUrl(input: string, release: Release): void {
	let url: URL;
	try {
		if (input.length > 2048) {
			throw new Error();
		}
		url = new URL(input);
	} catch {
		throw new CodespaceCliInstallerError('UNSAFE_URL', 'The official CLI download URL is invalid.');
	}
	const cdn = `${DOWNLOAD_ORIGIN}/dbazure/download/${release.quality}/${release.commit}/vscode_cli_linux_${release.architecture}_cli.tar.gz`;
	const redirect = `${UPDATE_ORIGIN}/commit:${release.commit}/cli-linux-${release.architecture}/${release.quality}`;
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
		|| url.port !== '' || url.href !== input || (input !== cdn && input !== redirect)) {
		throw new CodespaceCliInstallerError('UNSAFE_URL', 'The CLI URL must identify the exact release on an approved official HTTPS origin.');
	}
}

function header(response: CodespaceCliInstallerHttpResponse, name: string): string | undefined {
	const matches = Object.entries(response.headers).filter(([key, value]) => key.toLowerCase() === name && value !== undefined);
	if (matches.length === 0) {
		return undefined;
	}
	const value = matches[0][1];
	if (matches.length !== 1 || typeof value !== 'string' || value.length > 4096) {
		throw new CodespaceCliInstallerError('NETWORK_ERROR', 'The official CLI response has ambiguous headers.');
	}
	return value;
}

async function consumeBody(
	response: CodespaceCliInstallerHttpResponse, maximum: number, signal: AbortSignal,
	consume: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
	const encoding = header(response, 'content-encoding');
	const length = header(response, 'content-length');
	if ((encoding !== undefined && encoding !== 'identity') || (length !== undefined && !/^(0|[1-9]\d*)$/.test(length))) {
		throw new CodespaceCliInstallerError('NETWORK_ERROR', 'The CLI response encoding or length is invalid.');
	}
	const expected = length === undefined ? undefined : Number(length);
	if (expected !== undefined && (!Number.isSafeInteger(expected) || expected > maximum)) {
		throw new CodespaceCliInstallerError('SIZE_LIMIT', 'The CLI response exceeds its download limit.');
	}
	let bytes = 0;
	const iterator = response.body[Symbol.asyncIterator]();
	try {
		for (;;) {
			const next = await abortable(Promise.resolve(iterator.next()), signal);
			if (next.done) {
				break;
			}
			if (!(next.value instanceof Uint8Array)) {
				throw new CodespaceCliInstallerError('NETWORK_ERROR', 'The CLI downloader returned a non-binary body.');
			}
			bytes += next.value.byteLength;
			if (bytes > maximum) {
				throw new CodespaceCliInstallerError('SIZE_LIMIT', 'The CLI response exceeds its streamed download limit.');
			}
			throwIfAborted(signal);
			await consume(next.value);
		}
		throwIfAborted(signal);
		if (expected !== undefined && bytes !== expected) {
			throw new CodespaceCliInstallerError('NETWORK_ERROR', 'The CLI response was incomplete.');
		}
		return bytes;
	} finally {
		// An injected body may ignore abort; do not let an uncooperative iterator block cancellation.
		void iterator.return?.().catch(() => undefined);
	}
}

async function inspectExecutable(
	file: FileHandle, architecture: CodespaceCliArchitecture, limits: CodespaceCliInstallerLimits, signal?: AbortSignal,
): Promise<{ size: number; sha256: string }> {
	const before = await file.stat();
	checkOwned(before, false, true);
	if (!boundedInteger(before.size, 64, limits.maxExecutableBytes)) {
		throw new CodespaceCliInstallerError('SIZE_LIMIT', 'The native CLI executable exceeds its size limit.');
	}
	const hash = createHash('sha256');
	const buffer = Buffer.alloc(64 * 1024);
	const elfHeader = Buffer.alloc(64);
	let headerSize = 0;
	let offset = 0;
	for (;;) {
		throwIfAborted(signal);
		const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset + 1), offset);
		if (bytesRead === 0) {
			break;
		}
		if (headerSize < elfHeader.length) {
			const count = Math.min(elfHeader.length - headerSize, bytesRead);
			buffer.copy(elfHeader, headerSize, 0, count);
			headerSize += count;
			if (headerSize === elfHeader.length) {
				validateElf(elfHeader, architecture, before.size);
			}
		}
		offset += bytesRead;
		if (offset > before.size) {
			throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'The native CLI changed during integrity validation.');
		}
		hash.update(buffer.subarray(0, bytesRead));
	}
	const after = await file.stat();
	if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
		throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'The native CLI changed during integrity validation.');
	}
	return { size: offset, sha256: hash.digest('hex') };
}

function validateElf(headerBytes: Buffer, architecture: CodespaceCliArchitecture, size: number): void {
	if (headerBytes.length < 64 || !headerBytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
		|| headerBytes[4] !== 2 || headerBytes[5] !== 1 || headerBytes[6] !== 1
		|| ![2, 3].includes(headerBytes.readUInt16LE(16))
		|| headerBytes.readUInt16LE(18) !== (architecture === 'x64' ? 62 : 183)
		|| headerBytes.readUInt32LE(20) !== 1 || headerBytes.readUInt16LE(52) !== 64
		|| headerBytes.readUInt16LE(54) !== 56 || headerBytes.readUInt16LE(56) === 0
		|| headerBytes.readBigUInt64LE(32) < 64n
		|| headerBytes.readBigUInt64LE(32) + BigInt(headerBytes.readUInt16LE(56)) * 56n > BigInt(size)) {
		throw new CodespaceCliInstallerError('INVALID_ARCHIVE', 'The CLI must be a native ELF64 executable for the selected Linux architecture.');
	}
}

async function extractExecutable(
	source: Readable, file: FileHandle, quality: CodespaceCliQuality, archive: CodespaceCliInstallerArchiveAdapter,
	limits: CodespaceCliInstallerLimits, signal: AbortSignal,
): Promise<void> {
	let inflated: Transform | undefined;
	let finished: Promise<void> | undefined;
	try {
		inflated = archive.createGunzip();
		finished = pipeline(source, inflated, { signal });
		void finished.catch(() => undefined);
		const reader = new TarReader(inflated, limits.maxDecompressedBytes, signal);
		const expectedName = quality === 'stable' ? 'code' : 'code-insiders';
		let found = false;
		let rootDirectory = false;
		for (;;) {
			const block = await reader.read(512);
			if (isZero(block)) {
				if (!isZero(await reader.read(512)) || !found) {
					throw invalidArchive();
				}
				await reader.finish();
				await finished;
				return;
			}
			let checksum = 0;
			for (let index = 0; index < block.length; index += 1) {
				checksum += index >= 148 && index < 156 ? 32 : block[index];
			}
			if (tarNumber(block.subarray(148, 156)) !== checksum
				|| !['ustar\0', 'ustar '].includes(block.toString('ascii', 257, 263))
				|| !['00', ' \0'].includes(block.toString('ascii', 263, 265))) {
				throw invalidArchive();
			}
			const name = tarString(block.subarray(0, 100));
			const type = block[156];
			const size = tarNumber(block.subarray(124, 136));
			const mode = tarNumber(block.subarray(100, 108));
			tarNumber(block.subarray(108, 116));
			tarNumber(block.subarray(116, 124));
			tarNumber(block.subarray(136, 148));
			if (tarString(block.subarray(157, 257)) !== '' || tarString(block.subarray(345, 500)) !== ''
				|| (mode & 0o7000) !== 0 || mode > 0o7777) {
				throw invalidArchive();
			}
			if (type === 53 && (name === '.' || name === './') && size === 0 && !rootDirectory) {
				rootDirectory = true;
				continue;
			}
			if ((type !== 0 && type !== 48) || (name !== expectedName && name !== `./${expectedName}`)
				|| found || (mode & 0o100) === 0) {
				throw invalidArchive();
			}
			if (!boundedInteger(size, 64, limits.maxExecutableBytes)) {
				throw new CodespaceCliInstallerError('SIZE_LIMIT', 'The CLI archive entry exceeds its executable size limit.');
			}
			found = true;
			await reader.consume(size, (chunk) => file.writeFile(chunk));
			if (!isZero(await reader.read((512 - size % 512) % 512))) {
				throw invalidArchive();
			}
		}
	} catch (error: unknown) {
		throwIfAborted(signal);
		if (error instanceof CodespaceCliInstallerError) {
			throw error;
		}
		throw invalidArchive();
	} finally {
		source.destroy();
		inflated?.destroy();
		await finished?.catch(() => undefined);
	}
}

class TarReader {
	private readonly iterator: AsyncIterator<Uint8Array>;
	private chunk: Uint8Array = Buffer.alloc(0);
	private offset = 0;
	private total = 0;

	public constructor(source: AsyncIterable<Uint8Array>, private readonly maximum: number, private readonly signal: AbortSignal) {
		this.iterator = source[Symbol.asyncIterator]();
	}

	public async read(length: number): Promise<Buffer> {
		const bytes = Buffer.alloc(length);
		let offset = 0;
		await this.consume(length, async (chunk) => {
			bytes.set(chunk, offset);
			offset += chunk.length;
		});
		return bytes;
	}

	public async consume(length: number, use: (chunk: Uint8Array) => Promise<void>): Promise<void> {
		while (length > 0) {
			if (!await this.available()) {
				throw invalidArchive();
			}
			const count = Math.min(length, this.chunk.length - this.offset);
			await use(this.chunk.subarray(this.offset, this.offset + count));
			this.offset += count;
			length -= count;
		}
	}

	public async finish(): Promise<void> {
		let padding = 0;
		while (await this.available()) {
			const chunk = this.chunk.subarray(this.offset);
			padding += chunk.length;
			if (padding > 64 * 1024 || !isZero(chunk)) {
				throw invalidArchive();
			}
			this.offset = this.chunk.length;
		}
		if (this.total % 512 !== 0) {
			throw invalidArchive();
		}
	}

	private async available(): Promise<boolean> {
		throwIfAborted(this.signal);
		while (this.offset === this.chunk.length) {
			const next = await abortable(Promise.resolve(this.iterator.next()), this.signal);
			if (next.done) {
				return false;
			}
			if (!(next.value instanceof Uint8Array)) {
				throw invalidArchive();
			}
			this.total += next.value.length;
			if (this.total > this.maximum) {
				throw new CodespaceCliInstallerError('SIZE_LIMIT', 'The CLI archive exceeds its decompressed size limit.');
			}
			this.chunk = next.value;
			this.offset = 0;
		}
		return true;
	}
}

function tarString(bytes: Buffer): string {
	const end = bytes.indexOf(0);
	const text = bytes.subarray(0, end < 0 ? bytes.length : end);
	if ([...text].some((byte) => byte < 32 || byte > 126) || (end >= 0 && !isZero(bytes.subarray(end)))) {
		throw invalidArchive();
	}
	return text.toString('ascii');
}

function tarNumber(bytes: Buffer): number {
	if ([...bytes].some((byte) => byte !== 0 && byte !== 32 && (byte < 48 || byte > 55))) {
		throw invalidArchive();
	}
	const text = bytes.toString('ascii').replace(/[\0 ]+$/g, '').replace(/^ +/g, '');
	if (!/^[0-7]+$/.test(text)) {
		throw invalidArchive();
	}
	const value = Number.parseInt(text, 8);
	if (!Number.isSafeInteger(value)) {
		throw invalidArchive();
	}
	return value;
}

function invalidArchive(): CodespaceCliInstallerError {
	return new CodespaceCliInstallerError('INVALID_ARCHIVE', 'The CLI archive must contain only the expected regular native executable and safe tar headers.');
}

function isZero(bytes: Uint8Array): boolean {
	return bytes.every((byte) => byte === 0);
}

function checkOwned(info: Stats, directory: boolean, executable = false): void {
	const uid = process.geteuid?.();
	if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
		|| (uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0 || (info.mode & 0o7000) !== 0
			|| ((directory || executable) && (info.mode & 0o100) === 0)))) {
		throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'CLI storage must be private, owned, and free of links or special files.');
	}
}

async function readSmallFile(
	files: CodespaceCliInstallerFileSystem, path: string, maximum: number, signal?: AbortSignal,
): Promise<Buffer | undefined> {
	throwIfAborted(signal);
	let info: Stats;
	try {
		info = await files.lstat(path);
	} catch (error: unknown) {
		throwIfAborted(signal);
		if (hasCode(error, 'ENOENT')) {
			return undefined;
		}
		throw error;
	}
	throwIfAborted(signal);
	checkOwned(info, false);
	const file = await requireManagedPath(() => files.open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK));
	return withClosedFile(files, file, async () => {
		throwIfAborted(signal);
		const info = await file.stat();
		checkOwned(info, false);
		if (!boundedInteger(info.size, 1, maximum)) {
			throw new CodespaceCliInstallerError('SIZE_LIMIT', 'The CLI manifest exceeds its size limit.');
		}
		const buffer = Buffer.alloc(maximum + 1);
		let size = 0;
		for (;;) {
			throwIfAborted(signal);
			const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
			throwIfAborted(signal);
			size += bytesRead;
			if (size > maximum) {
				throw new CodespaceCliInstallerError('SIZE_LIMIT', 'The CLI manifest exceeds its size limit.');
			}
			if (bytesRead === 0) {
				break;
			}
		}
		if (size !== info.size) {
			throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'The CLI manifest changed while it was read.');
		}
		return buffer.subarray(0, size);
	});
}

async function assertIdentity(files: CodespaceCliInstallerFileSystem, path: string, expected: Stats | undefined): Promise<void> {
	if (expected === undefined) {
		throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'An owned CLI path could not be identified and cannot be safely removed.');
	}
	const actual = await files.lstat(path);
	if (actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino
		|| actual.isDirectory() !== expected.isDirectory() || actual.isFile() !== expected.isFile()) {
		throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'An owned CLI installation path was replaced.');
	}
}

async function removeOwnedDirectory(files: CodespaceCliInstallerFileSystem, owned: { path: string; identity?: Stats }): Promise<void> {
	await assertIdentity(files, owned.path, owned.identity);
	await files.rm(owned.path, { recursive: true, force: true });
}

async function requireManagedPath<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error: unknown) {
		if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR') || hasCode(error, 'ELOOP')) {
			throw new CodespaceCliInstallerError('INVALID_INSTALLATION', 'A required managed CLI path is missing, unsafe, or changed during validation.');
		}
		throw error;
	}
}

async function withClosedFile<T>(
	files: CodespaceCliInstallerFileSystem, file: FileHandle, operation: () => Promise<T>,
): Promise<T> {
	let failure: { error: unknown } | undefined;
	try {
		return await operation();
	} catch (error: unknown) {
		failure = { error };
		throw error;
	} finally {
		try {
			await files.close(file);
		} catch (error: unknown) {
			throw new AggregateError(
				[...(failure === undefined ? [] : [failure.error]), error],
				'Native CLI file cleanup failed.',
			);
		}
	}
}

function samePath(left: string, right: string): boolean {
	return process.platform === 'win32' ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
		: normalize(left) === normalize(right);
}

function assertVersion(version: unknown, quality: CodespaceCliQuality): asserts version is string {
	if (typeof version !== 'string' || !VERSION.test(version) || version.endsWith('-insider') !== (quality === 'insider')) {
		throw new CodespaceCliInstallerError('INVALID_RELEASE', 'Supply an exact VS Code version; Insiders requires explicit insider quality.');
	}
}

function lowerLimits(limits: Partial<CodespaceCliInstallerLimits> | undefined): CodespaceCliInstallerLimits {
	const result = { ...CODESPACE_CLI_INSTALLER_LIMITS };
	for (const key of Object.keys(limits ?? {}) as (keyof CodespaceCliInstallerLimits)[]) {
		const value = limits![key];
		if (!(key in result) || !boundedInteger(value, key === 'maxRedirects' ? 0 : 1, result[key])) {
			throw new CodespaceCliInstallerError('SIZE_LIMIT', 'CLI installer limits must be bounded positive integers no larger than their defaults.');
		}
		result[key] = value;
	}
	return result;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason instanceof CodespaceCliInstallerError ? signal.reason
			: new CodespaceCliInstallerError('CANCELLED', 'CLI installation was cancelled.');
	}
}

function abortScope(signals: readonly (AbortSignal | undefined)[], timeoutMs: number): {
	signal: AbortSignal; dispose(): void;
} {
	const controller = new AbortController();
	const listeners: (() => void)[] = [];
	for (const signal of signals) {
		if (signal !== undefined) {
			const abort = () => controller.abort(signal.reason);
			signal.addEventListener('abort', abort, { once: true });
			listeners.push(() => signal.removeEventListener('abort', abort));
			if (signal.aborted) {
				abort();
			}
		}
	}
	const timer = setTimeout(() => controller.abort(
		new CodespaceCliInstallerError('TIMED_OUT', 'The CLI installation exceeded its time limit.'),
	), timeoutMs);
	return { signal: controller.signal, dispose: () => { clearTimeout(timer); listeners.forEach((remove) => remove()); } };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((accept, reject) => {
		const abort = () => {
			signal.removeEventListener('abort', abort);
			try {
				throwIfAborted(signal);
			} catch (error: unknown) {
				reject(error);
			}
		};
		signal.addEventListener('abort', abort, { once: true });
		void operation.then(
			(value) => { signal.removeEventListener('abort', abort); accept(value); },
			(error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
		);
		if (signal.aborted) {
			abort();
		}
	});
}

async function serialized<T>(root: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
	const key = process.platform === 'win32' ? root.toLowerCase() : root;
	const previous = installQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const held = new Promise<void>((accept) => { release = accept; });
	const tail = previous.then(() => held);
	installQueues.set(key, tail);
	void tail.then(() => { if (installQueues.get(key) === tail) { installQueues.delete(key); } });
	try {
		await abortable(previous, signal);
		throwIfAborted(signal);
		return await action();
	} finally {
		release();
	}
}
