import { randomUUID } from 'node:crypto';
import {
	mkdir,
	link,
	open,
	readFile,
	rename,
	unlink,
	type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';

import { MeshDomainError } from '../domain/errors';
import type { StateStore } from '../domain/ports';

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
	readonly generation?: string;
	readonly holderPid?: number;
	readonly holderInstanceId?: string;
	readonly acquiredAt?: string;
	readonly heartbeatAt?: string;
	readonly takeoverBlocked?: boolean;
}

export interface WorkerOwnership {
	isOwner(): boolean;
	currentGeneration(): string | undefined;
	snapshot(): WorkerOwnershipSnapshot;
	assertOwner(): Promise<void>;
}

export interface BrokerOwnership extends WorkerOwnership {
	contend(): Promise<boolean>;
	onDidLoseOwnership(listener: () => void): { dispose(): void };
	dispose(): Promise<void>;
}

export type BrokerOwnershipSnapshot = WorkerOwnershipSnapshot;

export interface WorkerOwnerLockOptions {
	readonly pid?: number;
	readonly instanceId?: string;
	readonly token?: string;
	readonly now?: () => number;
	readonly ttlMs?: number;
	readonly heartbeatMs?: number;
	readonly pidAlive?: (pid: number) => boolean;
	readonly onTakeoverMutexAcquired?: () => Promise<void>;
	readonly onOwnerCandidateReady?: () => Promise<void>;
	readonly onTakeoverMutexReleaseClaimed?: () => Promise<void>;
	readonly onTakeoverMutexOpened?: () => Promise<void>;
}

export class WorkerOwnerLock implements BrokerOwnership {
	private readonly lossListeners = new Set<() => void>();
	private handle: FileHandle | undefined;
	private record: WorkerOwnerRecord | undefined;
	private holder: WorkerOwnerRecord | undefined;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private heartbeatOperation = Promise.resolve();
	private contendOperation = Promise.resolve(false);
	private disposeOperation: Promise<void> | undefined;
	private disposed = false;
	private disposeComplete = false;
	private lockReleased = false;
	private takeoverBlocked = false;

	private constructor(
		private readonly path: string,
		private readonly takeoverPath: string,
		private readonly pid: number,
		private readonly instanceId: string,
		private readonly token: string,
		private readonly now: () => number,
		private readonly ttlMs: number,
		private readonly heartbeatMs: number,
		private readonly pidAlive: (pid: number) => boolean,
		private readonly onTakeoverMutexAcquired?: () => Promise<void>,
		private readonly onOwnerCandidateReady?: () => Promise<void>,
		private readonly onTakeoverMutexReleaseClaimed?: () => Promise<void>,
		private readonly onTakeoverMutexOpened?: () => Promise<void>,
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
			options.now ?? Date.now,
			options.ttlMs ?? defaultTtlMs,
			options.heartbeatMs ?? defaultHeartbeatMs,
			options.pidAlive ?? isPidAlive,
			options.onTakeoverMutexAcquired,
			options.onOwnerCandidateReady,
			options.onTakeoverMutexReleaseClaimed,
			options.onTakeoverMutexOpened,
		);
		await mkdir(rootDirectory, { recursive: true });
		try {
			await lock.tryAcquire();
		} catch (error) {
			try {
				await lock.dispose();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], 'Broker acquisition failed and cleanup is incomplete.');
			}
			throw error;
		}
		return lock;
	}

	public isOwner(): boolean {
		return this.handle !== undefined && this.record !== undefined && !this.disposed;
	}

	public currentGeneration(): string | undefined {
		return this.isOwner() ? this.record?.generation : undefined;
	}

	public snapshot(): WorkerOwnershipSnapshot {
		const record = this.record ?? this.holder;
		return {
			owner: this.isOwner(),
			instanceId: this.instanceId,
			generation: record?.generation,
			holderPid: record?.pid,
			holderInstanceId: record?.instanceId,
			acquiredAt: record?.acquiredAt,
			heartbeatAt: record?.heartbeatAt,
			...(this.takeoverBlocked ? { takeoverBlocked: true } : {}),
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
				'Another VS Code window owns the Device Broker for this extension storage.',
				true,
			);
		}
	}

	public contend(): Promise<boolean> {
		if (this.disposed) {
			return Promise.reject(new Error('Broker owner lock is disposed.'));
		}
		const operation = this.contendOperation.then(async () => {
			if (this.disposed) {
				throw new Error('Broker owner lock is disposed.');
			}
			if (!this.isOwner()) {
				const observed = await readRecordIfPresent(this.path);
				await this.tryAcquireWithMutex(observed);
			}
			return this.isOwner();
		});
		this.contendOperation = operation.then(
			(value) => value,
			() => false,
		);
		return operation;
	}

	public dispose(): Promise<void> {
		if (this.disposeOperation !== undefined) {
			return this.disposeOperation;
		}
		if (this.disposeComplete) {
			return Promise.resolve();
		}
		let disposal!: Promise<void>;
		disposal = this.disposeCore().then(() => {
			this.disposeComplete = true;
		}).finally(() => {
			if (!this.disposeComplete && this.disposeOperation === disposal) {
				this.disposeOperation = undefined;
			}
		});
		this.disposeOperation = disposal;
		return disposal;
	}

	private async disposeCore(): Promise<void> {
		this.disposed = true;
		if (this.heartbeatTimer !== undefined) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		await this.contendOperation;
		if (this.heartbeatTimer !== undefined) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		await this.heartbeatOperation;
		const failures: unknown[] = [];
		if (!this.lockReleased) {
			try {
				const current = await readRecordIfPresent(this.path);
				if (
					current?.token === this.token
					&& current.instanceId === this.instanceId
					&& current.generation === this.record?.generation
				) {
					await unlinkIfPresent(this.path);
				}
				this.lockReleased = true;
			} catch (error) {
				failures.push(error);
			}
		}
		if (this.lockReleased && this.handle !== undefined) {
			try {
				await this.handle.close();
				this.handle = undefined;
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		if (this.lockReleased && this.handle === undefined) {
			this.record = undefined;
			this.lossListeners.clear();
		}
		if (failures.length === 1) {
			throw failures[0];
		}
		if (failures.length > 1) {
			throw new AggregateError(failures, 'Broker owner lock cleanup failed.');
		}
	}

	private async tryAcquire(): Promise<void> {
		const observed = await readRecordIfPresent(this.path);
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
		const current = await readRecordIfPresent(this.path);
		if (
			current?.token !== this.token
			|| current.instanceId !== this.instanceId
			|| current.pid !== this.pid
			|| current.generation !== record.generation
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
		try {
			await this.handle?.close();
		} catch {
			process.emitWarning('The previous Device Broker owner file did not close cleanly.', {
				code: 'BROKER_OWNER_HANDLE_CLOSE_FAILED',
			});
		}
		this.handle = undefined;
		this.record = undefined;
		for (const listener of this.lossListeners) {
			try {
				listener();
			} catch {
				process.emitWarning('A Device Broker ownership loss listener failed.', {
					code: 'BROKER_OWNER_LOSS_LISTENER_FAILED',
				});
			}
		}
	}

	private async createOwnerFile(beforePublish?: () => Promise<boolean>): Promise<boolean> {
		if (this.disposed) {
			return false;
		}
		const candidatePath = `${this.path}.candidate-${this.token}`;
		let handle: FileHandle | undefined;
		let published = false;
		try {
			handle = await open(candidatePath, 'wx+', 0o600);
			const at = new Date(this.now()).toISOString();
			const record: WorkerOwnerRecord = {
				schemaVersion: 1,
				pid: this.pid,
				instanceId: this.instanceId,
				token: this.token,
				generation: randomUUID(),
				acquiredAt: at,
				heartbeatAt: at,
			};
			await writeRecord(handle, record);
			await this.onOwnerCandidateReady?.();
			if (this.disposed) {
				return false;
			}
			if (beforePublish !== undefined && !await beforePublish()) {
				return false;
			}
			try {
				await link(candidatePath, this.path);
			} catch (error) {
				if (hasCode(error, 'EEXIST')) {
					return false;
				}
				throw error;
			}
			if (this.disposed) {
				await unlinkIfPresent(this.path);
				return false;
			}
			published = true;
			this.handle = handle;
			this.record = record;
			this.holder = record;
			this.startHeartbeat();
			await unlinkIfPresent(candidatePath);
			return true;
		} finally {
			if (!published) {
				await handle?.close();
				await unlinkIfPresent(candidatePath);
			}
		}
	}

	private async tryAcquireWithMutex(observed: WorkerOwnerRecord | undefined): Promise<void> {
		this.takeoverBlocked = false;
		let mutex: FileHandle | undefined;
		try {
			mutex = await open(this.takeoverPath, 'wx+', 0o600);
		} catch (error) {
			if (hasCode(error, 'EEXIST')) {
				this.holder = observed;
				this.takeoverBlocked = true;
				await this.recoverOwnerlessTakeover();
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
		let mutexIdentity: FileIdentity | undefined;
		const failures: unknown[] = [];
		try {
			const mutexStats = await mutex.stat();
			mutexIdentity = { device: mutexStats.dev, inode: mutexStats.ino };
			await this.contendWithMutex(mutex, takeover, observed);
		} catch (error) {
			failures.push(error);
		}
		try {
			await mutex.close();
		} catch (error) {
			failures.push(error);
		}
		try {
			if (mutexIdentity === undefined) {
				await unlinkIfPresent(this.takeoverPath);
			} else {
				await releaseTakeoverMutex(
					this.takeoverPath,
					takeover,
					mutexIdentity,
					this.onTakeoverMutexReleaseClaimed,
				);
			}
		} catch (error) {
			failures.push(error);
		}
		if (failures.length === 1) {
			throw failures[0];
		}
		if (failures.length > 1) {
			throw new AggregateError(failures, 'Broker takeover operation failed.');
		}
	}

	private async recoverOwnerlessTakeover(): Promise<void> {
		const stale = await readTakeoverSnapshot(this.takeoverPath);
		if (stale?.record === undefined || !this.isRecoverableTakeover(stale.record)) {
			return;
		}
		const record = stale.record;
		try {
			await statFile(this.path);
			return;
		} catch (error) {
			if (!hasCode(error, 'ENOENT')) { throw error; }
		}
		const stillRecoverable = async (): Promise<boolean> => {
			const current = await readTakeoverSnapshot(this.takeoverPath);
			return sameTakeoverSnapshot(stale, current)
				&& this.isRecoverableTakeover(record);
		};
		// Publish without replacement before touching the orphan mutex: only one
		// recovering contender may clean it, and any existing owner blocks recovery.
		if (!await this.createOwnerFile(stillRecoverable)) {
			this.holder = await readRecordIfPresent(this.path);
			return;
		}
		let recovered = false;
		try {
			if (await stillRecoverable()) {
				recovered = await releaseTakeoverMutex(
					this.takeoverPath, record, stale.identity, this.onTakeoverMutexReleaseClaimed, false,
				);
			}
			if (recovered) {
				this.takeoverBlocked = false;
			}
		} finally {
			if (!recovered) {
				const current = await readRecordIfPresent(this.path);
				if (current?.token === this.token && current.generation === this.record?.generation) {
					await unlinkIfPresent(this.path);
				}
				await this.loseOwnership();
				this.holder = await readRecordIfPresent(this.path);
			}
		}
	}

	private isRecoverableTakeover(record: TakeoverRecord): boolean {
		const created = Date.parse(record.createdAt);
		return Number.isSafeInteger(record.pid) && record.pid > 0
			&& record.pid <= 0x7fff_ffff
			&& record.token.length > 0 && record.instanceId.length > 0
			&& Number.isFinite(created) && this.now() - created > this.ttlMs
			&& !this.pidAlive(record.pid);
	}

	private async contendWithMutex(
		mutex: FileHandle,
		takeover: TakeoverRecord,
		observed: WorkerOwnerRecord | undefined,
	): Promise<void> {
		await this.onTakeoverMutexOpened?.();
		await writeRecord(mutex, takeover);
		if (this.disposed) {
			return;
		}
		if (observed !== undefined && !this.isLive(observed)) {
			await this.onTakeoverMutexAcquired?.();
		}
		if (this.disposed) {
			return;
		}
		const current = await readRecordIfPresent(this.path);
		if (observed === undefined && current === undefined) {
			await this.createOwnerFile();
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
			return;
		}
		const stalePath = `${this.path}.stale-${this.token}`;
		await rename(this.path, stalePath);
		if (!await this.createOwnerFile()) {
			this.holder = await readRecordIfPresent(this.path);
			await unlinkIfPresent(stalePath);
			return;
		}
		await unlinkIfPresent(stalePath);
	}
}

export class FencedStateStore implements StateStore {
	private readonly generation: string | undefined;

	public constructor(
		private readonly state: StateStore,
		private readonly ownership: WorkerOwnership,
		generation = ownership.currentGeneration(),
	) {
		this.generation = generation;
	}

	public get<T>(key: string): T | undefined {
		return this.state.get<T>(key);
	}

	public async update(key: string, value: unknown): Promise<void> {
		const generation = this.generation;
		if (generation === undefined || this.ownership.currentGeneration() !== generation) {
			throw generationChangedError('before');
		}
		await this.ownership.assertOwner();
		if (this.ownership.currentGeneration() !== generation) {
			throw generationChangedError('before');
		}
		await this.state.update(key, value);
		await this.ownership.assertOwner();
		if (this.ownership.currentGeneration() !== generation) {
			throw generationChangedError('during');
		}
	}
}

async function readRecord(path: string): Promise<WorkerOwnerRecord | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, 'utf8')) as unknown;
	} catch (error) {
		if (error instanceof SyntaxError) {
			return undefined;
		}
		throw error;
	}
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

async function readRecordIfPresent(path: string): Promise<WorkerOwnerRecord | undefined> {
	try {
		return await readRecord(path);
	} catch (error) {
		if (hasCode(error, 'ENOENT')) {
			return undefined;
		}
		throw error;
	}
}

async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!hasCode(error, 'ENOENT')) {
			throw error;
		}
	}
}

function generationChangedError(when: 'before' | 'during'): MeshDomainError {
	return new MeshDomainError(
		'WORKER_DRAINING',
		`Device Broker generation changed ${when} the shared-state write.`,
		true,
	);
}

async function writeRecord(handle: FileHandle, record: WorkerOwnerRecord | TakeoverRecord): Promise<void> {
	const data = Buffer.from(JSON.stringify(record), 'utf8');
	let offset = 0;
	while (offset < data.length) {
		const { bytesWritten } = await handle.write(
			data,
			offset,
			data.length - offset,
			offset,
		);
		if (bytesWritten <= 0) {
			throw new Error('Atomic owner lock write made no progress.');
		}
		offset += bytesWritten;
	}
	await handle.truncate(data.length);
	await handle.sync();
}

async function releaseTakeoverMutex(
	path: string,
	expected: TakeoverRecord,
	expectedIdentity: FileIdentity,
	onClaimed?: () => Promise<void>,
	allowIncompleteRecord = true,
): Promise<boolean> {
	const claimedPath = `${path}.release-${randomUUID()}`;
	try {
		await rename(path, claimedPath);
	} catch (error) {
		if (hasCode(error, 'ENOENT')) {
			return false;
		}
		throw error;
	}
	await onClaimed?.();
	const claimedStats = await statFile(claimedPath);
	const claimed = await readTakeoverRecord(claimedPath);
	const sameInode = claimedStats.device === expectedIdentity.device
		&& claimedStats.inode === expectedIdentity.inode;
	const matchingToken = claimed?.token === expected.token
		&& claimed.instanceId === expected.instanceId
		&& claimed.pid === expected.pid
		&& claimed.createdAt === expected.createdAt;
	if (sameInode && ((allowIncompleteRecord && claimed === undefined) || matchingToken)) {
		await unlinkIfPresent(claimedPath);
		return true;
	}
	try {
		await link(claimedPath, path);
		await unlink(claimedPath);
	} catch (error) {
		if (!hasCode(error, 'EEXIST')) {
			throw error;
		}
	}
	return false;
}

interface FileIdentity {
	readonly device: number;
	readonly inode: number;
}

interface TakeoverSnapshot {
	readonly identity: FileIdentity;
	readonly record: TakeoverRecord | undefined;
}

async function readTakeoverSnapshot(path: string): Promise<TakeoverSnapshot | undefined> {
	let handle: FileHandle;
	try {
		handle = await open(path, 'r');
	} catch (error) {
		if (hasCode(error, 'ENOENT')) { return undefined; }
		throw error;
	}
	try {
		const stats = await handle.stat();
		const identity = { device: stats.dev, inode: stats.ino };
		if (!stats.isFile() || stats.size > 16 * 1_024) {
			return { identity, record: undefined };
		}
		return { identity, record: parseTakeoverRecord(await handle.readFile('utf8')) };
	} finally {
		await handle.close();
	}
}

function sameTakeoverSnapshot(expected: TakeoverSnapshot, current: TakeoverSnapshot | undefined): boolean {
	return current?.record !== undefined && expected.record !== undefined
		&& current.identity.device === expected.identity.device
		&& current.identity.inode === expected.identity.inode
		&& current.record.pid === expected.record.pid
		&& current.record.instanceId === expected.record.instanceId
		&& current.record.token === expected.record.token
		&& current.record.createdAt === expected.record.createdAt;
}

async function statFile(path: string): Promise<FileIdentity> {
	const handle = await open(path, 'r');
	try {
		const stats = await handle.stat();
		return { device: stats.dev, inode: stats.ino };
	} finally {
		await handle.close();
	}
}

async function readTakeoverRecord(path: string): Promise<TakeoverRecord | undefined> {
	return parseTakeoverRecord(await readFile(path, 'utf8'));
}

function parseTakeoverRecord(text: string): TakeoverRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch (error) {
		if (error instanceof SyntaxError) {
			return undefined;
		}
		throw error;
	}
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
		|| !('createdAt' in value)
		|| typeof value.createdAt !== 'string'
	) {
		return undefined;
	}
	return value as TakeoverRecord;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !hasCode(error, 'ESRCH');
	}
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& error.code === code;
}

export {
	FencedStateStore as BrokerFencedStateStore,
	WorkerOwnerLock as BrokerOwnerLock,
};
export type BrokerOwnerLockOptions = WorkerOwnerLockOptions;
