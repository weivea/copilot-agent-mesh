import {
	open,
	mkdir,
	readFile,
	readdir,
	rename,
	rmdir,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';

import type { IdGenerator } from '../domain/ports';

export interface AtomicFileSystem {
	mkdir(path: string): Promise<boolean>;
	readFile(path: string): Promise<string>;
	writeFile(path: string, contents: string): Promise<void>;
	syncFile(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	syncDirectory(path: string): Promise<void>;
	removeDirectory(path: string): Promise<void>;
	unlink(path: string): Promise<void>;
	readdir(path: string): Promise<readonly string[]>;
}

export class NodeAtomicFileSystem implements AtomicFileSystem {
	public async mkdir(path: string): Promise<boolean> {
		try {
			await mkdir(path);
			return true;
		} catch (error) {
			if (isAlreadyExists(error)) {
				return false;
			}
			throw error;
		}
	}

	public readFile(path: string): Promise<string> {
		return readFile(path, 'utf8');
	}

	public async writeFile(path: string, contents: string): Promise<void> {
		await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
	}

	public async syncFile(path: string): Promise<void> {
		const handle = await open(path, 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	public rename(from: string, to: string): Promise<void> {
		return rename(from, to);
	}

	public async syncDirectory(path: string): Promise<void> {
		if (process.platform === 'win32') {
			return;
		}
		const handle = await open(path, 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	public unlink(path: string): Promise<void> {
		return unlink(path);
	}

	public async removeDirectory(path: string): Promise<void> {
		await rmdir(path);
	}

	public readdir(path: string): Promise<readonly string[]> {
		return readdir(path);
	}
}

export class StorageCorruptionError extends Error {
	public constructor(path: string, detail: string) {
		super(`Stored data at "${path}" is invalid: ${detail}`);
		this.name = 'StorageCorruptionError';
	}
}

export class AtomicFileStore {
	private writeQueue: Promise<void> = Promise.resolve();
	private readonly pendingDirectorySyncs = new Map<string, string>();

	public constructor(
		private readonly rootDirectory: string,
		private readonly fileSystem: AtomicFileSystem,
		private readonly ids: IdGenerator,
	) {}

	public async readJson(relativePath: string): Promise<unknown | undefined> {
		const target = this.resolve(relativePath);
		let contents: string;
		try {
			contents = await this.fileSystem.readFile(target);
		} catch (error) {
			if (isFileNotFound(error)) {
				return undefined;
			}
			throw error;
		}

		try {
			return JSON.parse(contents);
		} catch (error) {
			const detail = error instanceof Error ? error.message : 'invalid JSON';
			throw new StorageCorruptionError(relativePath, detail);
		}
	}

	public writeJson(relativePath: string, value: unknown): Promise<void> {
		const operation = this.writeQueue.then(
			() => this.writeJsonExclusive(relativePath, value),
			() => this.writeJsonExclusive(relativePath, value),
		);
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	public async list(relativeDirectory: string): Promise<readonly string[]> {
		const directory = this.resolve(relativeDirectory);
		try {
			return await this.fileSystem.readdir(directory);
		} catch (error) {
			if (isFileNotFound(error)) {
				return [];
			}
			throw error;
		}
	}

	private async writeJsonExclusive(relativePath: string, value: unknown): Promise<void> {
		const target = this.resolve(relativePath);
		const directory = dirname(target);
		const id = this.ids.next();
		if (!/^[A-Za-z0-9-]+$/.test(id)) {
			throw new TypeError('Atomic file temporary ID contains unsafe characters.');
		}
		const temporary = `${target}.${id}.tmp`;
		const contents = `${JSON.stringify(value)}\n`;

		await this.ensureOwnedDirectory(relativePath);
		try {
			await this.fileSystem.writeFile(temporary, contents);
			await this.fileSystem.syncFile(temporary);
			await this.fileSystem.rename(temporary, target);
			await this.fileSystem.syncDirectory(directory);
		} catch (error) {
			try {
				await this.fileSystem.unlink(temporary);
			} catch (cleanupError) {
				if (!isFileNotFound(cleanupError)) {
					throw new AggregateError(
						[error, cleanupError],
						`Atomic write and temporary-file cleanup both failed for "${relativePath}".`,
					);
				}
			}
			throw error;
		}
	}

	private resolve(relativePath: string): string {
		if (relativePath.length === 0 || isAbsolute(relativePath)) {
			throw new TypeError('Storage paths must be non-empty relative paths.');
		}
		const normalized = normalize(relativePath);
		if (
			normalized === '..'
			|| normalized.startsWith(`..${sep}`)
			|| normalized.includes(`${sep}..${sep}`)
		) {
			throw new TypeError('Storage paths cannot escape the storage root.');
		}
		return join(this.rootDirectory, normalized);
	}

	private async ensureOwnedDirectory(relativePath: string): Promise<void> {
		const relativeDirectory = dirname(normalize(relativePath));
		if (relativeDirectory === '.') {
			return;
		}
		let current = this.rootDirectory;
		for (const segment of relativeDirectory.split(sep)) {
			const parent = current;
			current = join(current, segment);
			const created = await this.fileSystem.mkdir(current);
			if (created || this.pendingDirectorySyncs.has(current)) {
				this.pendingDirectorySyncs.set(current, parent);
				try {
					await this.fileSystem.syncDirectory(parent);
					this.pendingDirectorySyncs.delete(current);
				} catch (error) {
					if (created) {
						try {
							await this.fileSystem.removeDirectory(current);
							this.pendingDirectorySyncs.delete(current);
						} catch (rollbackError) {
							throw new AggregateError(
								[error, rollbackError],
								`Directory sync and rollback both failed for "${current}".`,
							);
						}
					}
					throw error;
				}
			}
		}
	}
}

function isFileNotFound(error: unknown): boolean {
	return (
		typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& error.code === 'ENOENT'
	);
}

function isAlreadyExists(error: unknown): boolean {
	return (
		typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& error.code === 'EEXIST'
	);
}
