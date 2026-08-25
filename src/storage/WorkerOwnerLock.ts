import { randomUUID } from 'node:crypto';
import {
	mkdir,
	open,
	readFile,
	rename,
	unlink,
	type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';

import { MeshDomainError } from '../domain/errors';

const lockFileName = 'worker-owner.lock';
const takeoverLockFileName = 'worker-owner.takeover';
const defaultTtlMs = 30_000;
const defaultHeartbeatMs = 5_000;

interface WorkerOwnerRecord {
	readonly schemaVersion: 1;
	readonly pid: number;
	readonly instanceId: string;
	readonly token: string;
	readonly generation: string;
	readonly acquiredAt: string;
	readonly heartbeatAt: string;
}

interface TakeoverRecord {
	readonly schemaVersion: 1;
	readonly pid: number;
	readonly instanceId: string;
	readonly token: string;
	readonly createdAt: string;
}

export interface WorkerOwnershipSnapshot {
	readonly owner: boolean;
	readonly instanceId: string;
	readonly holderPid?: number;
	readonly holderInstanceId?: string;
	readonly acquiredAt?: string;
	readonly heartbeatAt?: string;
}

export interface WorkerOwnership {
	isOwner(): boolean;
	snapshot(): WorkerOwnershipSnapshot;
	assertOwner(): Promise<void>;
}

export interface WorkerOwnerLockOptions {
	readonly pid?: number;
	readonly instanceId?: string;
	readonly token?: string;
	readonly now?: () => number;
	readonly ttlMs?: number;
	readonly heartbeatMs?: number;
	readonly pidAlive?: (pid: number) => boolean;
	readonly onTakeoverMutexAcquired?: () => Promise<void>;
}

export class WorkerOwnerLock implements WorkerOwnership {
	private readonly lossListeners = new Set<() => void>();
	private handle: FileHandle | undefined;
	private record: WorkerOwnerRecord | undefined;
	private holder: WorkerOwnerRecord | undefined;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private heartbeatOperation = Promise.resolve();
	private disposed = false;

	private constructor(
		private readonly path: string,
		private readonly takeoverPath: string,
		private readonly pid: number,
		private readonly instanceId: string,
		private readonly token: string,
		private readonly generation: string,
		private readonly now: () => number,
		private readonly ttlMs: number,
		private readonly heartbeatMs: number,
		private readonly pidAlive: (pid: number) => boolean,
		private readonly onTakeoverMutexAcquired?: () => Promise<void>,
	) {}

	public static async acquire(
		rootDirectory: string,
		options: WorkerOwnerLockOptions = {},
	): Promise<WorkerOwnerLock> {
		const lock = new WorkerOwnerLock(
			join(rootDirectory, lockFileName),
			join(rootDirectory, takeoverLockFileName),
			options.pid ?? process.pid,
			options.instanceId ?? randomUUID(),
			options.token ?? randomUUID(),
			randomUUID(),
			options.now ?? Date.now,
			options.ttlMs ?? defaultTtlMs,
			options.heartbeatMs ?? defaultHeartbeatMs,
			options.pidAlive ?? isPidAlive,
			options.onTakeoverMutexAcquired,
		);
		await mkdir(rootDirectory, { recursive: true });
		await lock.tryAcquire();
		return lock;
	}

	public isOwner(): boolean {
		return this.handle !== undefined && this.record !== undefined && !this.disposed;
	}

	public snapshot(): WorkerOwnershipSnapshot {
		const record = this.record ?? this.holder;
		return {
			owner: this.isOwner(),
			instanceId: this.instanceId,
			holderPid: record?.pid,
			holderInstanceId: record?.instanceId,
			acquiredAt: record?.acquiredAt,
			heartbeatAt: record?.heartbeatAt,
		};
	}

	public onDidLoseOwnership(listener: () => void): { dispose(): void } {
		this.lossListeners.add(listener);
		return { dispose: () => this.lossListeners.delete(listener) };
	}

	public async assertOwner(): Promise<void> {
		if (!this.isOwner() || !await this.queueRenew()) {
			throw new MeshDomainError(
				'WORKER_DRAINING',
				'Another VS Code window owns Worker and Listener services for this extension storage.',
				true,
			);
		}
	}

	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.heartbeatTimer !== undefined) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		await this.heartbeatOperation.catch(() => undefined);
		let disposalError: unknown;
		try {
			const current = await readRecord(this.path).catch(() => undefined);
			if (current?.token === this.token && current.instanceId === this.instanceId) {
				await unlink(this.path).catch((error: unknown) => {
					if (!hasCode(error, 'ENOENT')) {
						throw error;
					}
				});
			}
		} catch (error) {
			disposalError = error;
		} finally {
			await this.handle?.close().catch((error: unknown) => {
				disposalError ??= error;
			});
			this.handle = undefined;
			this.record = undefined;
			this.lossListeners.clear();
		}
		if (disposalError !== undefined) {
			throw disposalError;
		}
	}

	private async tryAcquire(): Promise<void> {
		const observed = await readRecord(this.path).catch(() => undefined);
		await this.tryAcquireWithMutex(observed);
	}

	private isLive(record: WorkerOwnerRecord): boolean {
		const heartbeat = Date.parse(record.heartbeatAt);
		return this.pidAlive(record.pid)
			|| (Number.isFinite(heartbeat) && this.now() - heartbeat <= this.ttlMs);
	}

	private startHeartbeat(): void {
		this.heartbeatTimer = setInterval(() => {
			void this.queueRenew().catch(() => this.loseOwnership());
		}, this.heartbeatMs);
		this.heartbeatTimer.unref();
	}

	private queueRenew(): Promise<boolean> {
		const result = this.heartbeatOperation.then(() => this.renew());
		this.heartbeatOperation = result.then(() => undefined, () => undefined);
		return result;
	}

	private async renew(): Promise<boolean> {
		const handle = this.handle;
		const record = this.record;
		if (handle === undefined || record === undefined || this.disposed) {
			return false;
		}
		const current = await readRecord(this.path).catch(() => undefined);
		if (
			current?.token !== this.token
			|| current.instanceId !== this.instanceId
			|| current.pid !== this.pid
		) {
			await this.loseOwnership();
			return false;
		}
		const updated: WorkerOwnerRecord = {
			...record,
			heartbeatAt: new Date(this.now()).toISOString(),
		};
		await writeRecord(handle, updated);
		this.record = updated;
		this.holder = updated;
		return true;
	}

	private async loseOwnership(): Promise<void> {
		if (!this.isOwner()) {
			return;
		}
		if (this.heartbeatTimer !== undefined) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		await this.handle?.close().catch(() => undefined);
		this.handle = undefined;
		this.record = undefined;
		for (const listener of this.lossListeners) {
			listener();
		}
	}

	private async createOwnerFile(): Promise<boolean> {
		let handle: FileHandle | undefined;
		try {
			handle = await open(this.path, 'wx+', 0o600);
			const at = new Date(this.now()).toISOString();
			const record: WorkerOwnerRecord = {
				schemaVersion: 1,
				pid: this.pid,
				instanceId: this.instanceId,
				token: this.token,
				generation: this.generation,
				acquiredAt: at,
				heartbeatAt: at,
			};
			await writeRecord(handle, record);
			this.handle = handle;
			this.record = record;
			this.holder = record;
			this.startHeartbeat();
			return true;
		} catch (error) {
			await handle?.close().catch(() => undefined);
			if (hasCode(error, 'EEXIST')) {
				return false;
			}
			throw error;
		}
	}

	private async tryAcquireWithMutex(observed: WorkerOwnerRecord | undefined): Promise<void> {
		let mutex: FileHandle | undefined;
		try {
			mutex = await open(this.takeoverPath, 'wx+', 0o600);
		} catch (error) {
			if (hasCode(error, 'EEXIST')) {
				this.holder = observed;
				return;
			}
			throw error;
		}
		const takeover: TakeoverRecord = {
			schemaVersion: 1,
			pid: this.pid,
			instanceId: this.instanceId,
			token: this.token,
			createdAt: new Date(this.now()).toISOString(),
		};
		let releaseMutex = false;
		try {
			await writeRecord(mutex, takeover);
			if (observed !== undefined && !this.isLive(observed)) {
				await this.onTakeoverMutexAcquired?.();
			}
			const current = await readRecord(this.path).catch(() => undefined);
			if (observed === undefined && current === undefined) {
				if (await this.createOwnerFile()) {
					releaseMutex = true;
				}
				return;
			}
			if (
				current === undefined
				|| observed === undefined
				|| current.token !== observed.token
				|| current.generation !== observed.generation
				|| this.isLive(current)
			) {
				this.holder = current;
				releaseMutex = true;
				return;
			}
			const stalePath = `${this.path}.stale-${this.token}`;
			await rename(this.path, stalePath);
			if (!await this.createOwnerFile()) {
				this.holder = await readRecord(this.path).catch(() => undefined);
				return;
			}
			releaseMutex = true;
			await unlink(stalePath).catch((error: unknown) => {
				if (!hasCode(error, 'ENOENT')) {
					throw error;
				}
			});
		} finally {
			await mutex.close().catch(() => undefined);
			if (releaseMutex) {
				await unlink(this.takeoverPath).catch((error: unknown) => {
					if (!hasCode(error, 'ENOENT')) {
						throw error;
					}
				});
			}
		}
	}
}

async function readRecord(path: string): Promise<WorkerOwnerRecord | undefined> {
	const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
	if (
		typeof value !== 'object'
		|| value === null
		|| !('schemaVersion' in value)
		|| value.schemaVersion !== 1
		|| !('pid' in value)
		|| !Number.isInteger(value.pid)
		|| !('instanceId' in value)
		|| typeof value.instanceId !== 'string'
		|| !('token' in value)
		|| typeof value.token !== 'string'
		|| (
			'generation' in value
			&& typeof value.generation !== 'string'
		)
		|| !('acquiredAt' in value)
		|| typeof value.acquiredAt !== 'string'
		|| !('heartbeatAt' in value)
		|| typeof value.heartbeatAt !== 'string'
	) {
		return undefined;
	}
	return {
		...(value as Omit<WorkerOwnerRecord, 'generation'>),
		generation: 'generation' in value ? value.generation as string : value.token,
	};
}

async function writeRecord(handle: FileHandle, record: WorkerOwnerRecord | TakeoverRecord): Promise<void> {
	const data = Buffer.from(JSON.stringify(record), 'utf8');
	await handle.write(data, 0, data.length, 0);
	await handle.truncate(data.length);
	await handle.sync();
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return hasCode(error, 'EPERM');
	}
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& error.code === code;
}
