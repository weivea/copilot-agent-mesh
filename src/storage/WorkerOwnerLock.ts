import { randomUUID } from 'node:crypto';
import {
	mkdir,
	open,
	readFile,
	rename,
	stat,
	unlink,
	type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';

import { MeshDomainError } from '../domain/errors';

const lockFileName = 'worker-owner.lock';
const defaultTtlMs = 30_000;
const defaultHeartbeatMs = 5_000;

interface WorkerOwnerRecord {
	readonly schemaVersion: 1;
	readonly pid: number;
	readonly instanceId: string;
	readonly token: string;
	readonly acquiredAt: string;
	readonly heartbeatAt: string;
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
		private readonly pid: number,
		private readonly instanceId: string,
		private readonly token: string,
		private readonly now: () => number,
		private readonly ttlMs: number,
		private readonly heartbeatMs: number,
		private readonly pidAlive: (pid: number) => boolean,
	) {}

	public static async acquire(
		rootDirectory: string,
		options: WorkerOwnerLockOptions = {},
	): Promise<WorkerOwnerLock> {
		const lock = new WorkerOwnerLock(
			join(rootDirectory, lockFileName),
			options.pid ?? process.pid,
			options.instanceId ?? randomUUID(),
			options.token ?? randomUUID(),
			options.now ?? Date.now,
			options.ttlMs ?? defaultTtlMs,
			options.heartbeatMs ?? defaultHeartbeatMs,
			options.pidAlive ?? isPidAlive,
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
		for (let attempt = 0; attempt < 4; attempt += 1) {
			let createdHandle: FileHandle | undefined;
			try {
				createdHandle = await open(this.path, 'wx+', 0o600);
				const at = new Date(this.now()).toISOString();
				const record: WorkerOwnerRecord = {
					schemaVersion: 1,
					pid: this.pid,
					instanceId: this.instanceId,
					token: this.token,
					acquiredAt: at,
					heartbeatAt: at,
				};
				await writeRecord(createdHandle, record);
				this.handle = createdHandle;
				this.record = record;
				this.holder = record;
				this.startHeartbeat();
				return;
			} catch (error) {
				await createdHandle?.close().catch(() => undefined);
				if (!hasCode(error, 'EEXIST')) {
					throw error;
				}
			}

			const observed = await readRecord(this.path).catch(() => undefined);
			if (observed !== undefined && this.isLive(observed)) {
				this.holder = observed;
				return;
			}
			if (observed === undefined && await this.isRecentlyModified()) {
				return;
			}
			const stalePath = `${this.path}.stale-${this.token}`;
			try {
				await rename(this.path, stalePath);
			} catch (error) {
				if (hasCode(error, 'ENOENT')) {
					continue;
				}
				throw error;
			}
			await unlink(stalePath).catch((error: unknown) => {
				if (!hasCode(error, 'ENOENT')) {
					throw error;
				}
			});
		}
		this.holder = await readRecord(this.path).catch(() => undefined);
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

	private async isRecentlyModified(): Promise<boolean> {
		try {
			const metadata = await stat(this.path);
			return this.now() - metadata.mtimeMs <= this.ttlMs;
		} catch (error) {
			if (hasCode(error, 'ENOENT')) {
				return false;
			}
			throw error;
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
		|| !('acquiredAt' in value)
		|| typeof value.acquiredAt !== 'string'
		|| !('heartbeatAt' in value)
		|| typeof value.heartbeatAt !== 'string'
	) {
		return undefined;
	}
	return value as WorkerOwnerRecord;
}

async function writeRecord(handle: FileHandle, record: WorkerOwnerRecord): Promise<void> {
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
