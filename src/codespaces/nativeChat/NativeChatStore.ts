import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

import { PROTOCOL_LIMITS, utf8String } from '../../../shared/protocol/limits';
import { timestampSchema, uuidSchema } from '../../../shared/protocol/models';
import { workspaceIdentitySchema } from '../../../shared/protocol/nodes';

export type NativeChatTaskStatus =
	| 'starting' | 'running' | 'needsInput' | 'completed' | 'cancelled' | 'failed' | 'interrupted';

export interface NativeChatEntry {
	readonly sequence: number;
	readonly kind: 'output' | 'progress' | 'tool' | 'terminal' | 'input' | 'answer' | 'error';
	readonly text: string;
	readonly inputId?: string;
}

export interface NativeChatTurn {
	readonly taskId: string;
	readonly prompt: string;
	readonly acceptanceCriteria: readonly string[];
	readonly status: NativeChatTaskStatus;
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly entries: readonly NativeChatEntry[];
	readonly recovery?: { sessionUri: string; chatUri: string };
	readonly pendingInput?: { inputId: string; prompt: string };
	readonly truncated: boolean;
}

export interface NativeChatSession {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly title: string;
	readonly workspaceIdentity: string;
	readonly workspaceName: string;
	readonly workspaceUri: string;
	readonly sourceLabel: string;
	readonly generation: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly archived: boolean;
	readonly turns: readonly NativeChatTurn[];
}

export interface NativeChatTaskStart {
	readonly taskId: string;
	readonly title: string;
	readonly prompt: string;
	readonly acceptanceCriteria?: readonly string[];
	readonly workspaceIdentity: string;
	readonly workspaceName: string;
	readonly workspaceUri: string;
	readonly sourceLabel: string;
	readonly generation: string;
	readonly continuation?: { sessionUri: string; chatUri: string };
}

export interface NativeChatStoreOptions {
	readonly rootDirectory: string;
	readonly maxSessions?: number;
	readonly maxSessionBytes?: number;
	readonly maxEntriesPerTurn?: number;
	readonly maxTurnsPerSession?: number;
	readonly now?: () => Date;
	/** The narrow atomic-publication seam also permits failure testing with real files. */
	readonly atomicRename?: typeof rename;
}

export type NativeChatStoreErrorCode =
	| 'INVALID_INPUT' | 'NOT_INITIALIZED' | 'NOT_FOUND' | 'CONFLICT'
	| 'CAPACITY' | 'UNSAFE_STORAGE' | 'CORRUPT_STORAGE' | 'STORAGE_CHANGED' | 'STORAGE_LOCKED';

export class NativeChatStoreError extends Error {
	public constructor(public readonly code: NativeChatStoreErrorCode, message: string) {
		super(message);
		this.name = 'NativeChatStoreError';
	}
}

export const NATIVE_CHAT_TRUNCATION_TEXT =
	'Transcript truncated. Additional output was omitted to respect local storage limits.';
export const NATIVE_CHAT_ANSWER_TEXT = 'Input answered.';

const limits = {
	maxSessions: 100,
	maxSessionBytes: 2 * 1_024 * 1_024,
	maxEntriesPerTurn: 4_096,
	maxTurnsPerSession: 100,
} as const;
const statuses = [
	'starting', 'running', 'needsInput', 'completed', 'cancelled', 'failed', 'interrupted',
] as const;
const kinds = ['output', 'progress', 'tool', 'terminal', 'input', 'answer', 'error'] as const;
const statusSchema = z.enum(statuses);
const uriSchema = utf8String(8_192, 'opaque URI', 1).refine((value) => {
	if (!URL.canParse(value) || /[\u0000-\u0020\\]/u.test(value)) {
		return false;
	}
	const uri = new URL(value);
	return uri.username === '' && uri.password === '' && uri.search === '' && uri.hash === ''
		&& uri.pathname.length > 0;
}, 'Expected an absolute URI without credentials, query, or fragment.');
const recoverySchema = z.strictObject({ sessionUri: uriSchema, chatUri: uriSchema });
const promptSchema = utf8String(PROTOCOL_LIMITS.taskPromptBytes, 'task prompt', 1);
const inputPromptSchema = utf8String(PROTOCOL_LIMITS.taskAnswerBytes, 'input prompt', 1);
const criteriaSchema = z.array(
	utf8String(PROTOCOL_LIMITS.acceptanceCriterionBytes, 'acceptance criterion', 1),
).max(PROTOCOL_LIMITS.acceptanceCriteriaCount);
const startSchema = z.strictObject({
	taskId: uuidSchema,
	title: utf8String(PROTOCOL_LIMITS.taskTitleBytes, 'title', 1),
	prompt: promptSchema,
	acceptanceCriteria: criteriaSchema.default([]),
	workspaceIdentity: workspaceIdentitySchema,
	workspaceName: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace name', 1),
	workspaceUri: uriSchema,
	sourceLabel: utf8String(PROTOCOL_LIMITS.nameBytes, 'source label', 1),
	generation: uuidSchema,
	continuation: recoverySchema.optional(),
});
const entryInputSchema = z.strictObject({
	kind: z.enum(kinds),
	text: z.string(),
	inputId: uuidSchema.optional(),
}).refine(
	(entry) => (entry.kind === 'input' || entry.kind === 'answer') === (entry.inputId !== undefined),
	'Only input and answer entries require an input ID.',
);
const entrySchema = z.strictObject({
	sequence: z.number().int().positive().max(limits.maxEntriesPerTurn),
	kind: z.enum(kinds),
	text: z.string().max(limits.maxSessionBytes),
	inputId: uuidSchema.optional(),
});
const turnSchema = z.strictObject({
	taskId: uuidSchema,
	prompt: promptSchema,
	acceptanceCriteria: criteriaSchema,
	status: statusSchema,
	startedAt: timestampSchema,
	endedAt: timestampSchema.optional(),
	entries: z.array(entrySchema).max(limits.maxEntriesPerTurn),
	recovery: recoverySchema.optional(),
	pendingInput: z.strictObject({ inputId: uuidSchema, prompt: inputPromptSchema }).optional(),
	truncated: z.boolean(),
});
const recordSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: uuidSchema,
	title: startSchema.shape.title,
	workspaceIdentity: workspaceIdentitySchema,
	workspaceName: startSchema.shape.workspaceName,
	workspaceUri: uriSchema,
	sourceLabel: startSchema.shape.sourceLabel,
	generation: uuidSchema,
	createdAt: timestampSchema,
	updatedAt: timestampSchema,
	archived: z.boolean(),
	turns: z.array(turnSchema).min(1).max(limits.maxTurnsPerSession),
	// A continuation's title is not session metadata. Hash the whole normalized
	// start request so retries can still detect changed titles after a restart.
	requestHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).max(limits.maxTurnsPerSession),
});
type StoredSession = NativeChatSession & { readonly requestHashes: readonly string[] };
interface LoadedSession {
	readonly value: StoredSession;
	readonly contents: string;
	readonly snapshot: NativeChatSession;
}
interface WriteLock {
	readonly handle: FileHandle;
	readonly identity: BigIntStats;
}

// The in-process queue avoids local contention; the exclusive root lock covers
// every read/mutate/publication transaction, including session-count admission.
const rootQueues = new Map<string, Promise<void>>();
const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const writeLockFileName = 'native-chat-write.lock';
const writeLockWaitMs = 5_000;
const writeLockRetryMs = 25;

export function isNativeChatTerminalStatus(status: NativeChatTaskStatus): boolean {
	return status === 'completed' || status === 'cancelled' || status === 'failed' || status === 'interrupted';
}

/** Private, bounded history. Callers must redact execution text before passing it here. */
export class NativeChatStore {
	private readonly rootDirectory: string;
	private readonly queueKey: string;
	private readonly maxSessions: number;
	private readonly maxSessionBytes: number;
	private readonly maxEntriesPerTurn: number;
	private readonly maxTurnsPerSession: number;
	private readonly now: () => Date;
	private readonly atomicRename: typeof rename;
	private readonly listeners = new Set<(sessionId: string) => void>();
	private records = new Map<string, LoadedSession>();
	private taskSessions = new Map<string, string>();
	private initialized = false;
	private pending: Promise<void> = Promise.resolve();
	private rootIdentity: { dev: number; ino: number } | undefined;
	private writeLock: WriteLock | undefined;

	public constructor(options: NativeChatStoreOptions) {
		if (
			typeof options.rootDirectory !== 'string'
			|| !isAbsolute(options.rootDirectory)
			|| /[\u0000-\u001f]/u.test(options.rootDirectory)
			|| options.rootDirectory.split(/[\\/]/u).some((part) => part === '..')
		) {
			throw failure('INVALID_INPUT', 'Native Chat storage requires an absolute, non-traversing root.');
		}
		this.rootDirectory = resolve(options.rootDirectory);
		if (this.rootDirectory === parse(this.rootDirectory).root) {
			throw failure('UNSAFE_STORAGE', 'A filesystem root cannot be used for Native Chat history.');
		}
		this.queueKey = process.platform === 'win32' ? this.rootDirectory.toLowerCase() : this.rootDirectory;
		this.maxSessions = lowerLimit(options.maxSessions, limits.maxSessions, 'maxSessions');
		this.maxSessionBytes = lowerLimit(options.maxSessionBytes, limits.maxSessionBytes, 'maxSessionBytes');
		this.maxEntriesPerTurn = lowerLimit(options.maxEntriesPerTurn, limits.maxEntriesPerTurn, 'maxEntriesPerTurn');
		this.maxTurnsPerSession = lowerLimit(options.maxTurnsPerSession, limits.maxTurnsPerSession, 'maxTurnsPerSession');
		this.now = options.now ?? (() => new Date());
		this.atomicRename = options.atomicRename ?? rename;
	}

	public initialize(): Promise<void> {
		return this.enqueue(() => this.ensureInitialized(), false);
	}

	public list(): readonly NativeChatSession[] {
		this.requireInitialized();
		return Object.freeze([...this.records.values()].map((record) => record.snapshot).sort(
			(left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id),
		));
	}

	public get(sessionId: string): NativeChatSession | undefined {
		this.requireInitialized();
		return this.records.get(input(uuidSchema, sessionId))?.snapshot;
	}

	public sessionForTask(taskId: string): NativeChatSession | undefined {
		this.requireInitialized();
		const sessionId = this.taskSessions.get(input(uuidSchema, taskId));
		return sessionId === undefined ? undefined : this.records.get(sessionId)?.snapshot;
	}

	public async beginTask(request: NativeChatTaskStart): Promise<NativeChatSession> {
		const parsed = input(startSchema, request);
		const requestHash = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
		return this.enqueue(async () => {
			await this.reload();
			const existingId = this.taskSessions.get(parsed.taskId);
			if (existingId !== undefined) {
				const existing = this.records.get(existingId)!;
				const index = existing.value.turns.findIndex((turn) => turn.taskId === parsed.taskId);
				if (existing.value.requestHashes[index] !== requestHash) {
					throw failure('CONFLICT', 'The task ID already belongs to a different start request.');
				}
				return existing.snapshot;
			}

			let previous: LoadedSession | undefined;
			if (parsed.continuation !== undefined) {
				const matches = [...this.records.values()].filter(({ value }) =>
					value.generation === parsed.generation
					&& value.workspaceIdentity === parsed.workspaceIdentity
					&& value.workspaceUri === parsed.workspaceUri
					&& sameRecovery(value.turns.at(-1)!.recovery, parsed.continuation),
				);
				previous = matches.length === 1 ? matches[0] : undefined;
				if (previous === undefined || previous.value.turns.at(-1)!.status !== 'completed') {
					throw failure('CONFLICT', 'Continuation requires the exact completed session, workspace, and live generation.');
				}
				if (previous.value.turns.length >= this.maxTurnsPerSession) {
					throw failure('CAPACITY', 'The Native Chat session turn limit has been reached.');
				}
			} else if (this.records.size >= this.maxSessions) {
				throw failure('CAPACITY', 'The Native Chat session limit has been reached; history was not deleted.');
			}

			const at = this.timestamp(previous?.value.updatedAt);
			const turn: NativeChatTurn = {
				taskId: parsed.taskId,
				prompt: parsed.prompt,
				acceptanceCriteria: parsed.acceptanceCriteria,
				status: 'starting',
				startedAt: at,
				entries: [],
				recovery: parsed.continuation,
				truncated: false,
			};
			const next: StoredSession = previous === undefined ? {
				schemaVersion: 1,
				id: parsed.taskId,
				title: parsed.title,
				workspaceIdentity: parsed.workspaceIdentity,
				workspaceName: parsed.workspaceName,
				workspaceUri: parsed.workspaceUri,
				sourceLabel: parsed.sourceLabel,
				generation: parsed.generation,
				createdAt: at,
				updatedAt: at,
				archived: false,
				turns: [turn],
				requestHashes: [requestHash],
			} : {
				...previous.value,
				updatedAt: at,
				turns: [...previous.value.turns, turn],
				requestHashes: [...previous.value.requestHashes, requestHash],
			};
			await this.commit(next, previous?.contents);
			return this.records.get(next.id)!.snapshot;
		});
	}

	public async setRecovery(taskId: string, recovery: { sessionUri: string; chatUri: string }): Promise<void> {
		const id = input(uuidSchema, taskId);
		const parsed = input(recoverySchema, recovery);
		return this.enqueue(async () => {
			await this.reload();
			const { loaded, index } = await this.loadTask(id);
			const turn = loaded.value.turns[index];
			if (turn.recovery !== undefined) {
				if (!sameRecovery(turn.recovery, parsed)) {
					throw failure('CONFLICT', 'A task recovery identity cannot be rebound.');
				}
				return;
			}
			if (loaded.value.turns.some((item) =>
				item.recovery !== undefined && !sameRecovery(item.recovery, parsed),
			) || [...this.records.values()].some(({ value }) =>
				value.id !== loaded.value.id && value.generation === loaded.value.generation
				&& value.turns.some((item) => sameRecovery(item.recovery, parsed)),
			)) {
				throw failure('CONFLICT', 'The recovery identity already belongs to another session or chat.');
			}
			await this.commit(this.replaceTurn(loaded.value, index, { ...turn, recovery: parsed }), loaded.contents);
		});
	}

	public async append(taskId: string, entry: Omit<NativeChatEntry, 'sequence'>): Promise<void> {
		const parsed = input(entryInputSchema, entry);
		if (parsed.kind === 'input') {
			return this.recordInput(taskId, parsed.inputId!, parsed.text);
		}
		if (parsed.kind === 'answer') {
			return this.recordAnswer(taskId, parsed.inputId!);
		}
		if (parsed.kind === 'progress' && parsed.text === NATIVE_CHAT_TRUNCATION_TEXT) {
			throw failure('INVALID_INPUT', 'The truncation marker is reserved for the transcript store.');
		}
		return this.changeTurn(taskId, (record, index) => {
			const turn = record.turns[index];
			if (turn.truncated) {
				return undefined;
			}
			const criticalSlots = isNativeChatTerminalStatus(turn.status) ? 0 : turn.pendingInput === undefined ? 2 : 1;
			if (turn.entries.length + 2 + criticalSlots <= this.maxEntriesPerTurn
				&& Buffer.byteLength(parsed.text, 'utf8') <= this.maxSessionBytes) {
				const next = { ...turn, entries: [...turn.entries, { ...parsed, sequence: turn.entries.length + 1 }] };
				const candidate = this.replaceTurn(record, index, next);
				const inputHeadroom = record.turns.some((item) => !isNativeChatTerminalStatus(item.status))
					? Math.min(400 * 1_024, Math.floor(this.maxSessionBytes / 3)) : 0;
				if (this.requiredBytes(candidate) + inputHeadroom <= this.maxSessionBytes) {
					return next;
				}
			}
			return { ...turn, truncated: true, entries: [...turn.entries, truncationEntry(turn.entries.length + 1)] };
		});
	}

	public async setStatus(taskId: string, status: NativeChatTaskStatus): Promise<void> {
		const parsed = input(statusSchema, status);
		return this.changeTurn(taskId, (record, index) => {
			const turn = record.turns[index];
			if (turn.status === parsed) {
				return undefined;
			}
			if (isNativeChatTerminalStatus(turn.status)
				|| parsed === 'starting'
				|| (parsed === 'needsInput' && turn.pendingInput === undefined)
				|| (parsed === 'running' && turn.pendingInput !== undefined)) {
				throw failure('CONFLICT', 'The requested task status would regress or discard authoritative input state.');
			}
			return isNativeChatTerminalStatus(parsed)
				? { ...turn, status: parsed, endedAt: this.timestamp(record.updatedAt), pendingInput: undefined }
				: { ...turn, status: parsed };
		});
	}

	public async recordInput(taskId: string, inputId: string, prompt: string): Promise<void> {
		const id = input(uuidSchema, inputId);
		const text = input(inputPromptSchema, prompt);
		return this.changeTurn(taskId, (record, index) => {
			const turn = record.turns[index];
			if (turn.pendingInput?.inputId === id && turn.pendingInput.prompt === text) {
				return undefined;
			}
			if (isNativeChatTerminalStatus(turn.status) || turn.pendingInput !== undefined
				|| turn.entries.some((entry) => entry.inputId === id)) {
				throw failure('CONFLICT', 'The input does not match an available, unanswered task input.');
			}
			if (turn.entries.length + 2 + (turn.truncated ? 0 : 1) > this.maxEntriesPerTurn) {
				throw failure('CAPACITY', 'There is no room to retain this input and its answer acknowledgement.');
			}
			return {
				...turn,
				status: 'needsInput',
				pendingInput: { inputId: id, prompt: text },
				entries: [...turn.entries, { sequence: turn.entries.length + 1, kind: 'input', text, inputId: id }],
			};
		});
	}

	public async recordAnswer(taskId: string, inputId: string): Promise<void> {
		const id = input(uuidSchema, inputId);
		return this.changeTurn(taskId, (record, index) => {
			const turn = record.turns[index];
			if (turn.pendingInput === undefined && turn.entries.some((entry) => entry.kind === 'answer' && entry.inputId === id)) {
				return undefined;
			}
			if (turn.pendingInput?.inputId !== id || isNativeChatTerminalStatus(turn.status)) {
				throw failure('CONFLICT', 'Only the exact pending input can be acknowledged.');
			}
			if (turn.entries.length + 1 + (turn.truncated ? 0 : 1) > this.maxEntriesPerTurn) {
				throw failure('CAPACITY', 'There is no room to retain an answer acknowledgement.');
			}
			return {
				...turn,
				status: 'running',
				pendingInput: undefined,
				entries: [...turn.entries, {
					sequence: turn.entries.length + 1, kind: 'answer', text: NATIVE_CHAT_ANSWER_TEXT, inputId: id,
				}],
			};
		});
	}

	public async archive(sessionId: string, archived: boolean): Promise<void> {
		const id = input(uuidSchema, sessionId);
		const value = input(z.boolean(), archived);
		return this.enqueue(async () => {
			await this.ensureInitialized();
			await this.checkRoot(false);
			const loaded = await this.readRecord(id);
			if (loaded === undefined) {
				throw failure('NOT_FOUND', 'The Native Chat session does not exist.');
			}
			if (loaded.value.archived !== value) {
				await this.commit({ ...loaded.value, archived: value, updatedAt: this.timestamp(loaded.value.updatedAt) }, loaded.contents);
			} else {
				this.remember(loaded);
			}
		});
	}

	public async interruptGeneration(generation: string): Promise<void> {
		const id = input(uuidSchema, generation);
		return this.enqueue(async () => {
			await this.reload();
			for (const loaded of this.records.values()) {
				if (loaded.value.generation !== id || loaded.value.turns.every((turn) => isNativeChatTerminalStatus(turn.status))) {
					continue;
				}
				const at = this.timestamp(loaded.value.updatedAt);
				await this.commit({
					...loaded.value,
					updatedAt: at,
					turns: loaded.value.turns.map((turn) => isNativeChatTerminalStatus(turn.status) ? turn : {
						...turn, status: 'interrupted', endedAt: at, pendingInput: undefined,
					}),
				}, loaded.contents);
			}
		});
	}

	public onDidChange(listener: (sessionId: string) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	/** Drain queued operations; individual mutation promises report their failures. */
	public flush(): Promise<void> {
		return this.pending;
	}

	private enqueue<T>(operation: () => Promise<T>, write = true): Promise<T> {
		const result = (rootQueues.get(this.queueKey) ?? Promise.resolve()).then(
			() => write ? this.withWriteLock(operation) : operation(),
		);
		const settled = result.then(() => undefined, () => undefined);
		this.pending = settled;
		rootQueues.set(this.queueKey, settled);
		void settled.then(() => {
			if (rootQueues.get(this.queueKey) === settled) {
				rootQueues.delete(this.queueKey);
			}
		});
		return result;
	}

	private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
		await this.checkRoot(!this.initialized);
		const lock = await this.acquireWriteLock();
		this.writeLock = lock;
		let finished = false;
		let operationError: unknown;
		try {
			await this.assertWriteLock();
			const result = await operation();
			finished = true;
			return result;
		} catch (error) {
			operationError = error;
			throw error;
		} finally {
			try {
				await this.releaseWriteLock(lock);
			} catch (error) {
				throw new AggregateError(
					finished ? [error] : [operationError, error],
					finished
						? 'The Native Chat transaction finished, but its write lock could not be safely released. Committed changes remain persisted.'
						: 'The Native Chat transaction and write-lock cleanup both failed.',
				);
			} finally {
				this.writeLock = undefined;
			}
		}
	}

	private async acquireWriteLock(): Promise<WriteLock> {
		const deadline = performance.now() + writeLockWaitMs;
		const path = join(this.rootDirectory, writeLockFileName);
		for (;;) {
			await this.checkRoot(false);
			let handle: FileHandle;
			try {
				handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
			} catch (error) {
				if (!hasCode(error, 'EEXIST')) {
					throw error;
				}
				await this.checkLockArtifact();
				const remaining = deadline - performance.now();
				if (remaining <= 0) {
					throw failure('STORAGE_LOCKED', 'Native Chat history is locked by another writer, possibly an abandoned one. The lock was not removed.');
				}
				// Age and PID liveness cannot safely prove ownership has ended.
				// Never steal a lock, even after a crashed process or a long pause.
				await delay(Math.min(writeLockRetryMs, remaining));
				continue;
			}
			try {
				return { handle, identity: await handle.stat({ bigint: true }) };
			} catch (error) {
				// Without an identity, cleanup cannot safely identify our file.
				try {
					await handle.close();
				} catch (closeError) {
					throw new AggregateError([error, closeError], 'Native Chat write-lock identity and handle cleanup both failed.');
				}
				throw error;
			}
		}
	}

	private async checkLockArtifact(): Promise<void> {
		let stat: Stats;
		try {
			stat = await lstat(join(this.rootDirectory, writeLockFileName));
		} catch (error) {
			if (hasCode(error, 'ENOENT')) {
				return;
			}
			throw error;
		}
		this.checkFile(stat);
		if (stat.size !== 0) {
			throw failure('UNSAFE_STORAGE', 'The Native Chat write lock must be an empty private regular file.');
		}
	}

	private async assertWriteLock(): Promise<void> {
		if (this.writeLock === undefined) {
			throw failure('STORAGE_LOCKED', 'A Native Chat mutation requires exclusive storage ownership.');
		}
		await this.checkRoot(false);
		await this.checkLockArtifact();
		const current = await lstat(join(this.rootDirectory, writeLockFileName), { bigint: true });
		if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, this.writeLock.identity)) {
			throw failure('STORAGE_CHANGED', 'The Native Chat write lock was replaced; another writer owns that path.');
		}
	}

	private async releaseWriteLock(lock: WriteLock): Promise<void> {
		const errors: unknown[] = [];
		try {
			await this.assertWriteLock();
			// Keep the original inode open until after unlink, preventing inode
			// reuse from making a replacement look like our lock during cleanup.
			await unlink(join(this.rootDirectory, writeLockFileName));
		} catch (error) {
			errors.push(error);
		}
		try {
			await lock.handle.close();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) {
			throw errors[0];
		}
		if (errors.length > 1) {
			throw new AggregateError(errors, 'Native Chat write-lock release and handle cleanup both failed.');
		}
	}

	private requireInitialized(): void {
		if (!this.initialized) {
			throw failure('NOT_INITIALIZED', 'Native Chat history has not been initialized.');
		}
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.reload();
		}
	}

	private async reload(): Promise<void> {
		await this.checkRoot(!this.initialized);
		const names: string[] = [];
		const directory = await opendir(this.rootDirectory, { bufferSize: 32 });
		for await (const entry of directory) {
			names.push(entry.name);
			if (names.length > this.maxSessions * 3 + 8) {
				throw failure('CAPACITY', 'The Native Chat directory scan limit has been exceeded.');
			}
		}
		const records = new Map<string, LoadedSession>();
		const tasks = new Map<string, string>();
		const recoveries = new Map<string, string>();
		for (const name of names) {
			if (name === writeLockFileName) {
				// Readers need no lock. A crashed writer's lock must not hide
				// already committed history, and is never reclaimed by a scan.
				await this.checkLockArtifact();
				continue;
			}
			const parts = name.split('.');
			const id = uuidSchema.safeParse(parts[0]);
			const isRecord = parts.length === 2 && parts[1] === 'json';
			const nonce = parts.length === 4 ? uuidSchema.safeParse(parts[2]) : undefined;
			const isTemporary = parts.length === 4 && parts[1] === 'json' && parts[3] === 'tmp'
				&& nonce?.success === true && nonce.data === parts[2];
			if (!id.success || id.data !== parts[0] || (!isRecord && !isTemporary)) {
				throw failure('UNSAFE_STORAGE', 'The Native Chat history directory contains an unmanaged entry.');
			}
			if (isTemporary) {
				// Interrupted writes are not committed history. Never remove another
				// instance's staging file, including when it vanishes during a scan.
				try {
					this.checkFile(await lstat(join(this.rootDirectory, name)));
				} catch (error) {
					if (!hasCode(error, 'ENOENT')) {
						throw error;
					}
				}
				continue;
			}
			if (records.size >= this.maxSessions) {
				throw failure('CAPACITY', 'The Native Chat session limit has been exceeded.');
			}
			const loaded = await this.readRecord(id.data);
			if (loaded === undefined) {
				throw failure('STORAGE_CHANGED', 'A Native Chat session disappeared during initialization.');
			}
			for (const turn of loaded.value.turns) {
				if (tasks.has(turn.taskId)) {
					throw failure('CORRUPT_STORAGE', 'A task ID occurs in more than one stored session.');
				}
				tasks.set(turn.taskId, loaded.value.id);
				if (turn.recovery !== undefined) {
					const key = JSON.stringify([loaded.value.generation, turn.recovery]);
					const owner = recoveries.get(key);
					if (owner !== undefined && owner !== loaded.value.id) {
						throw failure('CORRUPT_STORAGE', 'A recovery identity occurs in more than one stored session.');
					}
					recoveries.set(key, loaded.value.id);
				}
			}
			records.set(loaded.value.id, loaded);
		}
		this.records = records;
		this.taskSessions = tasks;
		this.initialized = true;
	}

	private async loadTask(taskId: string): Promise<{ loaded: LoadedSession; index: number }> {
		await this.ensureInitialized();
		if (!this.taskSessions.has(taskId)) {
			await this.reload();
		}
		const sessionId = this.taskSessions.get(taskId);
		const loaded = sessionId === undefined ? undefined : await this.readRecord(sessionId);
		const index = loaded?.value.turns.findIndex((turn) => turn.taskId === taskId) ?? -1;
		if (loaded === undefined || index < 0) {
			throw failure('NOT_FOUND', 'The Native Chat task does not exist.');
		}
		return { loaded, index };
	}

	private changeTurn(
		taskId: string,
		change: (record: StoredSession, index: number) => NativeChatTurn | undefined,
	): Promise<void> {
		const id = input(uuidSchema, taskId);
		return this.enqueue(async () => {
			await this.ensureInitialized();
			await this.checkRoot(false);
			const { loaded, index } = await this.loadTask(id);
			const next = change(loaded.value, index);
			if (next === undefined) {
				this.remember(loaded);
				return;
			}
			await this.commit(this.replaceTurn(loaded.value, index, next), loaded.contents);
		});
	}

	private replaceTurn(record: StoredSession, index: number, turn: NativeChatTurn): StoredSession {
		return {
			...record,
			updatedAt: this.timestamp(record.updatedAt),
			turns: record.turns.map((previous, candidate) => candidate === index ? turn : previous),
		};
	}

	private timestamp(previous?: string): string {
		const time = this.now().getTime();
		if (!Number.isFinite(time)) {
			throw failure('INVALID_INPUT', 'The Native Chat clock returned an invalid date.');
		}
		return input(timestampSchema, new Date(Math.max(time, previous === undefined ? time : Date.parse(previous))).toISOString());
	}

	/** Reserve a visible marker and terminal metadata without rewriting an emitted prefix. */
	private requiredBytes(record: StoredSession): number {
		const reserved: StoredSession = {
			...record,
			turns: record.turns.map((turn) => ({
				...turn,
				...(!isNativeChatTerminalStatus(turn.status) ? {
					status: 'interrupted' as const, endedAt: '9999-12-31T23:59:59.999Z',
				} : {}),
				entries: turn.truncated ? turn.entries : [...turn.entries, truncationEntry(turn.entries.length + 1)],
			})),
		};
		return Buffer.byteLength(serialize(reserved), 'utf8');
	}

	private assertFits(record: StoredSession): void {
		if (record.turns.length > this.maxTurnsPerSession
			|| record.turns.some((turn) => turn.entries.length + (turn.truncated ? 0 : 1) > this.maxEntriesPerTurn)
			|| this.requiredBytes(record) > this.maxSessionBytes) {
			throw failure('CAPACITY', 'The transcript cannot retain the requested metadata within its storage limits.');
		}
	}

	private async checkRoot(create: boolean): Promise<void> {
		const paths: string[] = [];
		for (let current = this.rootDirectory; current !== dirname(current); current = dirname(current)) {
			paths.push(current);
		}
		for (const path of paths.reverse()) {
			let stat: Stats;
			try {
				stat = await lstat(path);
			} catch (error) {
				if (!create || !hasCode(error, 'ENOENT')) {
					throw error;
				}
				try {
					await mkdir(path, { mode: 0o700 });
				} catch (mkdirError) {
					if (!hasCode(mkdirError, 'EEXIST')) {
						throw mkdirError;
					}
				}
				stat = await lstat(path);
			}
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw failure('UNSAFE_STORAGE', 'Native Chat history cannot traverse symlinks or non-directory roots.');
			}
			if (path === this.rootDirectory) {
				checkPrivateMode(stat, 0o700);
				if (this.rootIdentity !== undefined && !sameFile(stat, this.rootIdentity)) {
					throw failure('STORAGE_CHANGED', 'The Native Chat storage root was replaced.');
				}
				this.rootIdentity = { dev: stat.dev, ino: stat.ino };
			}
		}
	}

	private checkFile(stat: Stats): void {
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
			throw failure('UNSAFE_STORAGE', 'Native Chat history entries must be private regular files, not links.');
		}
		checkPrivateMode(stat, 0o600);
		if (stat.size > this.maxSessionBytes) {
			throw failure('CAPACITY', 'A Native Chat history file exceeds the byte limit.');
		}
	}

	private filePath(id: string): string {
		const validated = input(uuidSchema, id);
		return join(this.rootDirectory, `${validated}.json`);
	}

	private async readContents(id: string): Promise<string | undefined> {
		const path = this.filePath(id);
		let before: Stats;
		try {
			before = await lstat(path);
		} catch (error) {
			if (hasCode(error, 'ENOENT')) {
				return undefined;
			}
			throw error;
		}
		this.checkFile(before);
		const handle = await open(path, constants.O_RDONLY | noFollow);
		try {
			const stat = await handle.stat();
			this.checkFile(stat);
			const afterOpen = await lstat(path);
			this.checkFile(afterOpen);
			if (!sameFile(stat, before) || !sameFile(stat, afterOpen)) {
				throw failure('STORAGE_CHANGED', 'A Native Chat history file changed while opening it.');
			}
			const bytes = Buffer.alloc(stat.size + 1);
			let total = 0;
			while (total < bytes.length) {
				const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
				if (bytesRead === 0) {
					break;
				}
				total += bytesRead;
			}
			const after = await handle.stat();
			if (total !== stat.size || after.size !== stat.size
				|| after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
				throw failure('STORAGE_CHANGED', 'A Native Chat history file changed during a bounded read.');
			}
			try {
				return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total));
			} catch {
				throw failure('CORRUPT_STORAGE', 'A Native Chat history file is not valid UTF-8.');
			}
		} finally {
			await handle.close();
		}
	}

	private async readRecord(id: string): Promise<LoadedSession | undefined> {
		const contents = await this.readContents(id);
		if (contents === undefined) {
			return undefined;
		}
		let json: unknown;
		try {
			json = JSON.parse(contents);
		} catch {
			throw failure('CORRUPT_STORAGE', 'A Native Chat history file contains invalid JSON.');
		}
		const parsed = recordSchema.safeParse(json);
		if (!parsed.success) {
			throw failure('CORRUPT_STORAGE', 'A Native Chat history file has an unsupported schema or invalid data.');
		}
		const value: StoredSession = parsed.data;
		validateHistory(value, id);
		this.assertFits(value);
		return { value, contents, snapshot: snapshot(value) };
	}

	private async commit(value: StoredSession, previous: string | undefined): Promise<void> {
		this.assertFits(value);
		validateHistory(value, value.id);
		const contents = serialize(value);
		await this.assertWriteLock();
		const target = this.filePath(value.id);
		const temporary = `${target}.${randomUUID()}.tmp`;
		let created = false;
		let published = false;
		try {
			await this.assertUnchanged(value.id, previous);
			const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
			created = true;
			try {
				await handle.writeFile(contents, 'utf8');
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.assertWriteLock();
			await this.assertUnchanged(value.id, previous);
			await this.atomicRename(temporary, target);
			published = true;
			await this.syncDirectory();
		} catch (error) {
			if (published) {
				try {
					await this.rollback(value.id, contents, previous);
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], 'Native Chat directory sync and atomic rollback both failed.');
				}
			}
			throw error;
		} finally {
			if (created) {
				try {
					await unlink(temporary);
				} catch (error) {
					if (!hasCode(error, 'ENOENT')) {
						throw error;
					}
				}
			}
		}
		this.remember({ value, contents, snapshot: snapshot(value) });
		for (const listener of [...this.listeners]) {
			try {
				listener(value.id);
			} catch {
				// Observer failures must not turn a successfully committed write into
				// a reported storage failure or prevent other viewers being notified.
				process.emitWarning('A Native Chat transcript change listener failed.', 'NativeChatStoreListenerWarning');
			}
		}
	}

	private async rollback(id: string, published: string, previous: string | undefined): Promise<void> {
		await this.assertWriteLock();
		await this.assertUnchanged(id, published);
		const target = this.filePath(id);
		if (previous === undefined) {
			await unlink(target);
		} else {
			const temporary = `${target}.${randomUUID()}.tmp`;
			const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
			try {
				try {
					await handle.writeFile(previous, 'utf8');
					await handle.sync();
				} finally {
					await handle.close();
				}
				await this.atomicRename(temporary, target);
			} finally {
				try {
					await unlink(temporary);
				} catch (error) {
					if (!hasCode(error, 'ENOENT')) {
						throw error;
					}
				}
			}
		}
		await this.syncDirectory();
	}

	private async assertUnchanged(id: string, expected: string | undefined): Promise<void> {
		if (await this.readContents(id) !== expected) {
			throw failure('STORAGE_CHANGED', 'Another writer changed this Native Chat session; it was not overwritten.');
		}
	}

	private async syncDirectory(): Promise<void> {
		if (process.platform !== 'win32') {
			const handle = await open(this.rootDirectory, constants.O_RDONLY | noFollow);
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
	}

	private remember(record: LoadedSession): void {
		this.records.set(record.value.id, record);
		for (const turn of record.value.turns) {
			this.taskSessions.set(turn.taskId, record.value.id);
		}
	}
}

function validateHistory(record: StoredSession, id: string): void {
	const invalid = (): never => { throw failure('CORRUPT_STORAGE', 'Native Chat transcript identity or event state is inconsistent.'); };
	if (record.id !== id || record.turns[0].taskId !== id
		|| record.requestHashes.length !== record.turns.length
		|| record.createdAt !== record.turns[0].startedAt
		|| Date.parse(record.createdAt) > Date.parse(record.updatedAt)) {
		invalid();
	}
	const taskIds = new Set<string>();
	for (const [index, turn] of record.turns.entries()) {
		const terminal = isNativeChatTerminalStatus(turn.status);
		const previous = record.turns[index - 1];
		if (taskIds.has(turn.taskId) || terminal !== (turn.endedAt !== undefined)
			|| (turn.status === 'needsInput') !== (turn.pendingInput !== undefined)
			|| Date.parse(turn.startedAt) > Date.parse(turn.endedAt ?? record.updatedAt)
			|| Date.parse(turn.endedAt ?? turn.startedAt) > Date.parse(record.updatedAt)
			|| (previous !== undefined && (previous.status !== 'completed'
				|| !sameRecovery(previous.recovery, turn.recovery)
				|| Date.parse(turn.startedAt) < Date.parse(previous.endedAt!)))) {
			invalid();
		}
		taskIds.add(turn.taskId);
		const inputs = new Map<string, string>();
		const answers = new Set<string>();
		let unanswered: string | undefined;
		let markers = 0;
		for (const [entryIndex, entry] of turn.entries.entries()) {
			if (entry.sequence !== entryIndex + 1
				|| ((entry.kind === 'input' || entry.kind === 'answer') !== (entry.inputId !== undefined))) {
				invalid();
			}
			if (entry.kind === 'input') {
				if (unanswered !== undefined || inputs.has(entry.inputId!) || !inputPromptSchema.safeParse(entry.text).success) {
					invalid();
				}
				inputs.set(entry.inputId!, entry.text);
				unanswered = entry.inputId;
			} else if (entry.kind === 'answer') {
				if (unanswered !== entry.inputId || !inputs.has(entry.inputId!)
					|| answers.has(entry.inputId!) || entry.text !== NATIVE_CHAT_ANSWER_TEXT) {
					invalid();
				}
				answers.add(entry.inputId!);
				unanswered = undefined;
			} else if (entry.kind === 'progress' && entry.text === NATIVE_CHAT_TRUNCATION_TEXT) {
				markers += 1;
			}
		}
		if (markers !== (turn.truncated ? 1 : 0) || (!terminal && unanswered !== turn.pendingInput?.inputId)
			|| (turn.pendingInput !== undefined && (inputs.get(turn.pendingInput.inputId) !== turn.pendingInput.prompt
				|| answers.has(turn.pendingInput.inputId)))) {
			invalid();
		}
	}
}

function snapshot(record: StoredSession): NativeChatSession {
	const { requestHashes: _requestHashes, ...session } = record;
	return Object.freeze({
		...session,
		turns: Object.freeze(record.turns.map((turn) => Object.freeze({
			...turn,
			acceptanceCriteria: Object.freeze([...turn.acceptanceCriteria]),
			entries: Object.freeze(turn.entries.map((entry) => Object.freeze({ ...entry }))),
			recovery: turn.recovery === undefined ? undefined : Object.freeze({ ...turn.recovery }),
			pendingInput: turn.pendingInput === undefined ? undefined : Object.freeze({ ...turn.pendingInput }),
		}))),
	});
}

function serialize(record: StoredSession): string {
	return `${JSON.stringify(record)}\n`;
}

function truncationEntry(sequence: number): NativeChatEntry {
	return { sequence, kind: 'progress', text: NATIVE_CHAT_TRUNCATION_TEXT };
}

function sameRecovery(left: NativeChatTurn['recovery'], right: NativeChatTurn['recovery']): boolean {
	return left !== undefined && right !== undefined && left.sessionUri === right.sessionUri && left.chatUri === right.chatUri;
}

function lowerLimit(value: number | undefined, maximum: number, name: string): number {
	if (value === undefined) {
		return maximum;
	}
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw failure('INVALID_INPUT', `${name} must be a positive integer no greater than ${maximum}.`);
	}
	return value;
}

function input<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw failure('INVALID_INPUT', 'Invalid Native Chat transcript input.');
	}
	return result.data;
}

function checkPrivateMode(stat: Stats, mode: number): void {
	if (process.platform !== 'win32'
		&& ((stat.mode & 0o7777) !== mode || (process.getuid !== undefined && stat.uid !== process.getuid()))) {
		throw failure('UNSAFE_STORAGE', 'Native Chat history requires owner-only storage permissions.');
	}
}

function sameFile(
	left: { dev: number | bigint; ino: number | bigint },
	right: { dev: number | bigint; ino: number | bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function failure(code: NativeChatStoreErrorCode, message: string): NativeChatStoreError {
	return new NativeChatStoreError(code, message);
}
