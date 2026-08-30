import { dirname } from 'node:path';

import type { AtomicFileSystem } from '../storage/AtomicFileStore';
import type {
	WorkerOwnership,
	WorkerOwnershipSnapshot,
} from '../storage/WorkerOwnerLock';

export class MemoryAtomicFileSystem implements AtomicFileSystem {
	public readonly files = new Map<string, string>();
	private readonly directories = new Set<string>();

	public async mkdir(path: string): Promise<boolean> {
		if (this.directories.has(path)) {
			return false;
		}
		this.directories.add(path);
		return true;
	}

	public async readFile(path: string): Promise<string> {
		const value = this.files.get(path);
		if (value === undefined) {
			throw fileError('ENOENT');
		}
		return value;
	}

	public async writeFile(path: string, contents: string): Promise<void> {
		this.files.set(path, contents);
	}

	public async syncFile(_path: string): Promise<void> {}

	public async rename(from: string, to: string): Promise<void> {
		const value = this.files.get(from);
		if (value === undefined) {
			throw fileError('ENOENT');
		}
		this.files.delete(from);
		this.files.set(to, value);
	}

	public async syncDirectory(_path: string): Promise<void> {}

	public async removeDirectory(path: string): Promise<void> {
		this.directories.delete(path);
	}

	public async unlink(path: string): Promise<void> {
		if (!this.files.delete(path)) {
			throw fileError('ENOENT');
		}
	}

	public async readdir(path: string): Promise<readonly string[]> {
		if (!this.directories.has(path)) {
			throw fileError('ENOENT');
		}
		return [...this.files.keys()]
			.filter((candidate) => dirname(candidate) === path)
			.map((candidate) => candidate.slice(path.length + 1));
	}
}

export class TestOwnership implements WorkerOwnership {
	public owner = true;

	public constructor(public generation = 'generation-1') {}

	public isOwner(): boolean {
		return this.owner;
	}

	public currentGeneration(): string | undefined {
		return this.owner ? this.generation : undefined;
	}

	public snapshot(): WorkerOwnershipSnapshot {
		return {
			owner: this.owner,
			instanceId: 'test-owner',
			...(this.owner ? { generation: this.generation } : {}),
		};
	}

	public async assertOwner(): Promise<void> {
		if (!this.owner) {
			throw new Error('not owner');
		}
	}
}

export function uuid(index: number): string {
	return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function fileError(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}
