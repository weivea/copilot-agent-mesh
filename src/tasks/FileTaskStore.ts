import {
	persistedTaskRecordSchema,
	uuidSchema,
} from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import {
	getOwnedTask,
	matchIdempotentStart,
	type OwnedTaskStart,
	type TaskRecord,
} from '../domain/task';
import { systemClock, type Clock } from '../domain/ports';
import { taskReducer, type TaskDomainEvent } from '../domain/taskReducer';
import { compactTaskEventJournal } from '../domain/taskEvents';
import { AtomicFileStore, StorageCorruptionError } from '../storage/AtomicFileStore';

export class FileTaskStore {
	private mutationQueue: Promise<void> = Promise.resolve();

	public constructor(
		private readonly files: AtomicFileStore,
		private readonly clock: Clock = systemClock,
	) {}

	public create(record: TaskRecord): Promise<void> {
		return this.runExclusive(async () => {
			await this.createUnlocked(record);
		});
	}

	public createIdempotent(
		request: OwnedTaskStart,
		record: TaskRecord,
	): Promise<{ readonly record: TaskRecord; readonly created: boolean }> {
		return this.runExclusive(async () => {
			const existing = matchIdempotentStart(await this.listUnlocked(), request);
			if (existing !== undefined) {
				return { record: existing, created: false };
			}
			const created = await this.createUnlocked(record);
			return { record: created, created: true };
		});
	}

	private async createUnlocked(record: TaskRecord): Promise<TaskRecord> {
		const compacted = compactTaskEventJournal(record, this.clock.now().toISOString());
		const validated = persistedTaskRecordSchema.safeParse(compacted);
		if (!validated.success) {
			throw new TypeError(`Invalid task record: ${validated.error.message}`);
		}
		const existing = await this.getOwnedUnlocked(validated.data.peerId, validated.data.taskId);
		if (existing !== undefined) {
			throw new MeshDomainError('TASK_ID_CONFLICT', 'Task already exists.');
		}
		await this.files.writeJson(
			taskPath(validated.data.peerId, validated.data.taskId),
			validated.data,
		);
		return validated.data;
	}

	public findIdempotentStart(request: OwnedTaskStart): Promise<TaskRecord | undefined> {
		return this.runExclusive(async () =>
			matchIdempotentStart(await this.listUnlocked(), request),
		);
	}

	private async saveUnlocked(record: TaskRecord): Promise<TaskRecord> {
		const compacted = compactTaskEventJournal(record, this.clock.now().toISOString());
		const validated = persistedTaskRecordSchema.safeParse(compacted);
		if (!validated.success) {
			throw new TypeError(`Invalid task record: ${validated.error.message}`);
		}
		await this.files.writeJson(
			taskPath(validated.data.peerId, validated.data.taskId),
			validated.data,
		);
		return validated.data;
	}

	public transitionOwned(
		peerId: string,
		taskId: string,
		event: TaskDomainEvent,
	): Promise<TaskRecord> {
		return this.runExclusive(async () => {
			const current = getOwnedTask(await this.getOwnedUnlocked(peerId, taskId), peerId);
			return this.transitionUnlocked(current, event);
		});
	}

	public getOwned(peerId: string, taskId: string): Promise<TaskRecord | undefined> {
		return this.runExclusive(() => this.getOwnedUnlocked(peerId, taskId));
	}

	private async getOwnedUnlocked(
		peerId: string,
		taskId: string,
	): Promise<TaskRecord | undefined> {
		const parsedPeerId = uuidSchema.safeParse(peerId);
		const parsedId = uuidSchema.safeParse(taskId);
		if (!parsedPeerId.success || !parsedId.success) {
			return undefined;
		}
		const path = taskPath(parsedPeerId.data, parsedId.data);
		const value = await this.files.readJson(path);
		if (value === undefined) {
			return undefined;
		}
		const record = parseRecord(path, value);
		if (record.peerId !== parsedPeerId.data || record.taskId !== parsedId.data) {
			throw new StorageCorruptionError(path, 'record identity does not match its file name');
		}
		return this.compactOnRead(path, record);
	}

	public list(): Promise<readonly TaskRecord[]> {
		return this.runExclusive(() => this.listUnlocked());
	}

	private async listUnlocked(): Promise<readonly TaskRecord[]> {
		const names = await this.files.list('tasks');
		const records: TaskRecord[] = [];
		for (const name of [...names].sort()) {
			if (!name.endsWith('.json')) {
				continue;
			}
			const path = `tasks/${name}`;
			const identity = parseTaskFileName(path, name);
			const value = await this.files.readJson(path);
			if (value !== undefined) {
				const record = parseRecord(path, value);
				if (
					record.peerId !== identity.peerId
					|| record.taskId !== identity.taskId
				) {
					throw new StorageCorruptionError(
						path,
						'record identity does not match its file name',
					);
				}
				records.push(await this.compactOnRead(path, record));
			}
		}
		return records;
	}

	public listForRecovery(): Promise<readonly TaskRecord[]> {
		return this.runExclusive(async () =>
			(await this.listUnlocked()).filter((record) =>
				!['completed', 'failed', 'cancelled', 'timedOut'].includes(record.state),
			),
		);
	}

	private async transitionUnlocked(
		current: TaskRecord,
		event: TaskDomainEvent,
	): Promise<TaskRecord> {
		const updated = taskReducer(current, event);
		if (updated !== current) {
			return this.saveUnlocked(updated);
		}
		return updated;
	}

	private async compactOnRead(path: string, record: TaskRecord): Promise<TaskRecord> {
		const compacted = compactTaskEventJournal(record, this.clock.now().toISOString());
		if (compacted === record) {
			return record;
		}
		const validated = persistedTaskRecordSchema.safeParse(compacted);
		if (!validated.success) {
			throw new StorageCorruptionError(path, validated.error.message);
		}
		await this.files.writeJson(path, validated.data);
		return validated.data;
	}

	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationQueue.then(operation, operation);
		this.mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function taskPath(peerId: string, taskId: string): string {
	return `tasks/${peerId}--${taskId}.json`;
}

function parseTaskFileName(
	path: string,
	name: string,
): { readonly peerId: string; readonly taskId: string } {
	const stem = name.slice(0, -'.json'.length);
	const separator = stem.indexOf('--');
	if (separator <= 0 || separator !== stem.lastIndexOf('--')) {
		throw new StorageCorruptionError(path, 'task file name is not canonical');
	}
	const peerId = stem.slice(0, separator);
	const taskId = stem.slice(separator + 2);
	const parsedPeerId = uuidSchema.safeParse(peerId);
	const parsedTaskId = uuidSchema.safeParse(taskId);
	if (!parsedPeerId.success || !parsedTaskId.success) {
		throw new StorageCorruptionError(path, 'task file name contains an invalid identity');
	}
	if (name !== `${parsedPeerId.data}--${parsedTaskId.data}.json`) {
		throw new StorageCorruptionError(path, 'task file name is not canonical');
	}
	return {
		peerId: parsedPeerId.data,
		taskId: parsedTaskId.data,
	};
}

function parseRecord(path: string, value: unknown): TaskRecord {
	const parsed = persistedTaskRecordSchema.safeParse(value);
	if (!parsed.success) {
		throw new StorageCorruptionError(path, parsed.error.message);
	}
	return parsed.data;
}
