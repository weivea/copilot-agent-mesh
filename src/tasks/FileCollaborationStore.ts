import {
	persistedCollaborationRunSchema,
	uuidSchema,
	type CollaborationStartParams,
} from '../../shared/protocol';
import {
	canonicalCollaborationRequestHash,
	collaborationReducer,
	deterministicCollaborationId,
	type CollaborationDomainEvent,
	type CollaborationRun,
} from '../domain/collaboration';
import { MeshDomainError } from '../domain/errors';
import { AtomicFileStore, StorageCorruptionError } from '../storage/AtomicFileStore';
import type { WorkerOwnership } from '../storage/WorkerOwnerLock';

export interface FileCollaborationStoreOptions {
	readonly ownership?: WorkerOwnership;
	readonly generation?: string;
}

export class FileCollaborationStore {
	private mutationQueue: Promise<void> = Promise.resolve();
	private readonly ownership: WorkerOwnership | undefined;
	private readonly generation: string | undefined;

	public constructor(
		private readonly files: AtomicFileStore,
		options: FileCollaborationStoreOptions = {},
	) {
		this.ownership = options.ownership;
		this.generation = options.generation ?? options.ownership?.currentGeneration();
		if (this.ownership !== undefined && this.generation === undefined) {
			throw new Error('An ownership-fenced collaboration store requires a Broker generation.');
		}
	}

	public createIdempotent(
		sourceNodeId: string,
		input: CollaborationStartParams,
		run: CollaborationRun,
	): Promise<{ readonly run: CollaborationRun; readonly created: boolean }> {
		return this.runExclusive(async () => {
			const match = await this.findIdempotentUnlocked(sourceNodeId, input);
			if (match !== undefined) {
				return { run: match, created: false };
			}
			const created = await this.saveNewUnlocked(run);
			return { run: created, created: true };
		});
	}

	public findIdempotent(
		sourceNodeId: string,
		input: CollaborationStartParams,
	): Promise<CollaborationRun | undefined> {
		return this.runExclusive(() => this.findIdempotentUnlocked(sourceNodeId, input));
	}

	public get(runId: string): Promise<CollaborationRun | undefined> {
		return this.runExclusive(() => this.getUnlocked(runId));
	}

	public list(): Promise<readonly CollaborationRun[]> {
		return this.runExclusive(() => this.listUnlocked());
	}

	public transition(
		runId: string,
		event: CollaborationDomainEvent,
	): Promise<CollaborationRun> {
		return this.runExclusive(async () => {
			const current = await this.requireUnlocked(runId);
			const updated = collaborationReducer(current, event);
			return updated === current ? current : this.saveUnlocked(updated);
		});
	}

	private async saveNewUnlocked(run: CollaborationRun): Promise<CollaborationRun> {
		const validated = parseRun(runPath(run.runId), run);
		if (await this.getUnlocked(validated.runId) !== undefined) {
			throw new MeshDomainError(
				'COLLABORATION_ID_CONFLICT',
				'Collaboration run already exists.',
			);
		}
		return this.writeUnlocked(validated);
	}

	private async saveUnlocked(run: CollaborationRun): Promise<CollaborationRun> {
		return this.writeUnlocked(parseRun(runPath(run.runId), run));
	}

	private async writeUnlocked(run: CollaborationRun): Promise<CollaborationRun> {
		await this.assertWritable('before');
		await this.files.writeJson(runPath(run.runId), run);
		await this.assertWritable('during');
		return run;
	}

	private async getUnlocked(runId: string): Promise<CollaborationRun | undefined> {
		const parsedId = uuidSchema.safeParse(runId);
		if (!parsedId.success) {
			return undefined;
		}
		const path = runPath(parsedId.data);
		const value = await this.files.readJson(path);
		if (value === undefined) {
			return undefined;
		}
		const run = parseRun(path, value);
		if (run.runId !== parsedId.data) {
			throw new StorageCorruptionError(path, 'run identity does not match its file name');
		}
		return run;
	}

	private async requireUnlocked(runId: string): Promise<CollaborationRun> {
		const run = await this.getUnlocked(runId);
		if (run === undefined) {
			throw new MeshDomainError('COLLABORATION_NOT_FOUND', 'Collaboration run not found.');
		}
		return run;
	}

	private async listUnlocked(): Promise<readonly CollaborationRun[]> {
		const names = await this.files.list('collaborations');
		const runs: CollaborationRun[] = [];
		for (const name of [...names].sort()) {
			if (!name.endsWith('.json')) {
				continue;
			}
			const path = `collaborations/${name}`;
			const id = name.slice(0, -'.json'.length);
			const parsedId = uuidSchema.safeParse(id);
			if (!parsedId.success || name !== `${parsedId.data}.json`) {
				throw new StorageCorruptionError(path, 'collaboration file name is not canonical');
			}
			const value = await this.files.readJson(path);
			if (value !== undefined) {
				const run = parseRun(path, value);
				if (run.runId !== parsedId.data) {
					throw new StorageCorruptionError(path, 'run identity does not match its file name');
				}
				runs.push(run);
			}
		}
		return runs;
	}

	private async findIdempotentUnlocked(
		sourceNodeId: string,
		input: CollaborationStartParams,
	): Promise<CollaborationRun | undefined> {
		const runId = deterministicCollaborationId(input.collaborationRequestId);
		const match = (await this.listUnlocked()).find((candidate) =>
			candidate.runId === runId
			|| candidate.collaborationRequestId === input.collaborationRequestId,
		);
		if (match === undefined) {
			return undefined;
		}
		if (
			match.runId !== runId
			|| match.collaborationRequestId !== input.collaborationRequestId
			|| match.requestHash !== canonicalCollaborationRequestHash(sourceNodeId, input)
		) {
			throw new MeshDomainError(
				'COLLABORATION_ID_CONFLICT',
				'The collaboration identity belongs to a different request.',
			);
		}
		return match;
	}

	private async assertWritable(phase: 'before' | 'during'): Promise<void> {
		const ownership = this.ownership;
		if (ownership === undefined) {
			return;
		}
		if (
			this.generation === undefined
			|| !ownership.isOwner()
			|| ownership.currentGeneration() !== this.generation
		) {
			throw new MeshDomainError(
				'WORKER_DRAINING',
				`Device Broker generation changed ${phase} the collaboration write.`,
				true,
			);
		}
		await ownership.assertOwner();
		if (ownership.currentGeneration() !== this.generation) {
			throw new MeshDomainError(
				'WORKER_DRAINING',
				`Device Broker generation changed ${phase} the collaboration write.`,
				true,
			);
		}
	}

	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationQueue.then(operation, operation);
		this.mutationQueue = result.then(() => undefined, () => undefined);
		return result;
	}
}

function runPath(runId: string): string {
	return `collaborations/${runId}.json`;
}

function parseRun(path: string, value: unknown): CollaborationRun {
	const parsed = persistedCollaborationRunSchema.safeParse(value);
	if (!parsed.success) {
		throw new StorageCorruptionError(path, parsed.error.message);
	}
	return parsed.data;
}
