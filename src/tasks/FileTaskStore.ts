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
import { taskReducer, type TaskDomainEvent } from '../domain/taskReducer';
import { AtomicFileStore, StorageCorruptionError } from '../storage/AtomicFileStore';

export class FileTaskStore {
	private mutationQueue: Promise<void> = Promise.resolve();

	public constructor(private readonly files: AtomicFileStore) {}

	public create(record: TaskRecord): Promise<void> {
		return this.runExclusive(() => this.createUnlocked(record));
	}

	public createIdempotent(
		request: OwnedTaskStart,
		record: TaskRecord,
	): Promise<{ readonly record: TaskRecord; readonly created: boolean }> {
		return this.runExclusive(async () => {
			const existing = matchIdempotentStart(await this.list(), request);
			if (existing !== undefined) {
				return { record: existing, created: false };
			}
			await this.createUnlocked(record);
			return { record, created: true };
		});
	}

	private async createUnlocked(record: TaskRecord): Promise<void> {
		const validated = persistedTaskRecordSchema.safeParse(record);
		if (!validated.success) {
			throw new TypeError(`Invalid task record: ${validated.error.message}`);
		}
		const existing = await this.getOwned(record.peerId, record.taskId);
		if (existing !== undefined) {
			throw new MeshDomainError('TASK_ID_CONFLICT', 'Task already exists.');
		}
		await this.files.writeJson(taskPath(record.peerId, record.taskId), validated.data);
	}

	public async findIdempotentStart(request: OwnedTaskStart): Promise<TaskRecord | undefined> {
		return matchIdempotentStart(await this.list(), request);
	}

	private async saveUnlocked(record: TaskRecord): Promise<void> {
		const validated = persistedTaskRecordSchema.safeParse(record);
		if (!validated.success) {
			throw new TypeError(`Invalid task record: ${validated.error.message}`);
		}
		await this.files.writeJson(taskPath(record.peerId, record.taskId), validated.data);
	}

	public transitionOwned(
		peerId: string,
		taskId: string,
		event: TaskDomainEvent,
	): Promise<TaskRecord> {
		return this.runExclusive(async () => {
			const current = getOwnedTask(await this.getOwned(peerId, taskId), peerId);
			return this.transitionUnlocked(current, event);
		});
	}

	public async getOwned(peerId: string, taskId: string): Promise<TaskRecord | undefined> {
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
		return record;
	}

	public async list(): Promise<readonly TaskRecord[]> {
		const names = await this.files.list('tasks');
		const records: TaskRecord[] = [];
		for (const name of [...names].sort()) {
			if (!name.endsWith('.json')) {
				continue;
			}
			const path = `tasks/${name}`;
			const value = await this.files.readJson(path);
			if (value !== undefined) {
				records.push(parseRecord(path, value));
			}
		}
		return records;
	}

	public async listForRecovery(): Promise<readonly TaskRecord[]> {
		return (await this.list()).filter((record) =>
			!['completed', 'failed', 'cancelled', 'timedOut'].includes(record.state),
		);
	}

	private async transitionUnlocked(
		current: TaskRecord,
		event: TaskDomainEvent,
	): Promise<TaskRecord> {
		const updated = taskReducer(current, event);
		if (updated !== current) {
			await this.saveUnlocked(updated);
		}
		return updated;
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

function parseRecord(path: string, value: unknown): TaskRecord {
	const parsed = persistedTaskRecordSchema.safeParse(value);
	if (!parsed.success) {
		throw new StorageCorruptionError(path, parsed.error.message);
	}
	return parsed.data;
}
