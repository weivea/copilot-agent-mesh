import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
	artifactMediaTypeSchema,
	collaborationArtifactReferenceSchema,
	PROTOCOL_LIMITS,
	uuidSchema,
	type CollaborationArtifactReference,
} from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import type { JsonValue } from '../ipc';
import { AtomicFileStore, StorageCorruptionError } from '../storage/AtomicFileStore';
import type { WorkerOwnership } from '../storage/WorkerOwnerLock';

const artifactRecordSchema = collaborationArtifactReferenceSchema.extend({
	schemaVersion: z.literal(1),
	consumerTaskIds: z.array(uuidSchema).min(1).max(PROTOCOL_LIMITS.collaborationTaskCount),
	content: z.json(),
});

type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

export interface ArtifactStoreOptions {
	readonly ownership?: WorkerOwnership;
	readonly generation?: string;
}

export interface ArtifactCreateInput {
	readonly artifactId: string;
	readonly runId: string;
	readonly producerTaskId: string;
	readonly consumerTaskIds: readonly string[];
	readonly label: string;
	readonly mediaType: string;
	readonly content: JsonValue;
	readonly createdAt: string;
}

export interface AuthorizedArtifact {
	readonly reference: CollaborationArtifactReference;
	readonly content: JsonValue;
}

export class ArtifactStore {
	private mutationQueue: Promise<void> = Promise.resolve();
	private readonly ownership: WorkerOwnership | undefined;
	private readonly generation: string | undefined;

	public constructor(
		private readonly files: AtomicFileStore,
		options: ArtifactStoreOptions = {},
	) {
		this.ownership = options.ownership;
		this.generation = options.generation ?? options.ownership?.currentGeneration();
		if (this.ownership !== undefined && this.generation === undefined) {
			throw new Error('An ownership-fenced Artifact Store requires a Broker generation.');
		}
	}

	public create(input: ArtifactCreateInput): Promise<CollaborationArtifactReference> {
		return this.runExclusive(async () => {
			const record = createRecord(input);
			const existing = await this.readRecordUnlocked(record.artifactId);
			if (existing !== undefined) {
				if (canonicalJson(existing) !== canonicalJson(record)) {
					throw new MeshDomainError(
						'ARTIFACT_INVALID',
						'Immutable artifact identity conflicts with existing content.',
					);
				}
				return toReference(existing);
			}
			const records = await this.listRecordsUnlocked();
			if (
				records.filter(({ runId }) => runId === record.runId).length
					>= PROTOCOL_LIMITS.collaborationArtifactCount
				|| records.reduce((bytes, candidate) => bytes + candidate.contentLength, 0)
					+ record.contentLength > PROTOCOL_LIMITS.artifactStoreBytes
			) {
				throw new MeshDomainError(
					'ARTIFACT_LIMIT_EXCEEDED',
					'The Artifact Store count or byte limit was exceeded.',
				);
			}
			await this.assertWritable('before');
			await this.files.writeJson(artifactPath(record.artifactId), record);
			await this.assertWritable('during');
			return toReference(record);
		});
	}

	public readForTask(
		artifactId: string,
		runId: string,
		consumerTaskId: string,
	): Promise<AuthorizedArtifact> {
		return this.runExclusive(async () => {
			const artifact = await this.requireRecordUnlocked(artifactId);
			const parsedRunId = uuidSchema.parse(runId);
			const parsedTaskId = uuidSchema.parse(consumerTaskId);
			if (artifact.runId !== parsedRunId || !artifact.consumerTaskIds.includes(parsedTaskId)) {
				throw new MeshDomainError(
					'ARTIFACT_FORBIDDEN',
					'The artifact is not authorized for this collaboration task.',
				);
			}
			return {
				reference: toReference(artifact),
				content: structuredClone(artifact.content) as JsonValue,
			};
		});
	}

	public listForRun(runId: string): Promise<readonly CollaborationArtifactReference[]> {
		return this.runExclusive(async () => {
			const parsedRunId = uuidSchema.parse(runId);
			return (await this.listRecordsUnlocked())
				.filter((record) => record.runId === parsedRunId)
				.map(toReference);
		});
	}

	private async requireRecordUnlocked(artifactId: string): Promise<ArtifactRecord> {
		const record = await this.readRecordUnlocked(artifactId);
		if (record === undefined) {
			throw new MeshDomainError('ARTIFACT_NOT_FOUND', 'Artifact not found.');
		}
		return record;
	}

	private async readRecordUnlocked(artifactId: string): Promise<ArtifactRecord | undefined> {
		const parsedId = uuidSchema.safeParse(artifactId);
		if (!parsedId.success) {
			return undefined;
		}
		const path = artifactPath(parsedId.data);
		try {
			const value = await this.files.readJson(path);
			if (value === undefined) {
				return undefined;
			}
			const record = parseRecord(path, value);
			if (record.artifactId !== parsedId.data) {
				throw new StorageCorruptionError(path, 'artifact identity does not match its file name');
			}
			assertIntegrity(record);
			return record;
		} catch (error: unknown) {
			if (error instanceof MeshDomainError) {
				throw error;
			}
			if (error instanceof StorageCorruptionError) {
				throw new MeshDomainError('ARTIFACT_CORRUPT', 'Stored artifact metadata is corrupt.');
			}
			throw error;
		}
	}

	private async listRecordsUnlocked(): Promise<readonly ArtifactRecord[]> {
		const names = await this.files.list('artifacts');
		const records: ArtifactRecord[] = [];
		for (const name of [...names].sort()) {
			if (!name.endsWith('.json')) {
				continue;
			}
			const path = `artifacts/${name}`;
			const id = name.slice(0, -'.json'.length);
			const parsedId = uuidSchema.safeParse(id);
			if (!parsedId.success || name !== `${parsedId.data}.json`) {
				throw new MeshDomainError('ARTIFACT_CORRUPT', 'Artifact file name is corrupt.');
			}
			const record = await this.readRecordUnlocked(parsedId.data);
			if (record !== undefined) {
				records.push(record);
			}
		}
		return records;
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
				`Device Broker generation changed ${phase} the artifact write.`,
				true,
			);
		}
		await ownership.assertOwner();
		if (ownership.currentGeneration() !== this.generation) {
			throw new MeshDomainError(
				'WORKER_DRAINING',
				`Device Broker generation changed ${phase} the artifact write.`,
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

function createRecord(input: ArtifactCreateInput): ArtifactRecord {
	const content = validateArtifactContent(input.content);
	const canonicalContent = canonicalJson(content);
	const contentLength = Buffer.byteLength(canonicalContent, 'utf8');
	if (contentLength === 0 || contentLength > PROTOCOL_LIMITS.artifactContentBytes) {
		throw new MeshDomainError(
			'ARTIFACT_LIMIT_EXCEEDED',
			'Artifact content exceeds the JSON byte limit.',
		);
	}
	const parsed = artifactRecordSchema.safeParse({
		schemaVersion: 1,
		artifactId: input.artifactId,
		runId: input.runId,
		producerTaskId: input.producerTaskId,
		consumerTaskIds: [...new Set(input.consumerTaskIds)],
		label: input.label,
		mediaType: input.mediaType,
		contentLength,
		sha256: createHash('sha256').update(canonicalContent, 'utf8').digest('hex'),
		revision: 1,
		content,
		createdAt: input.createdAt,
	});
	if (!parsed.success) {
		throw new MeshDomainError('ARTIFACT_INVALID', 'Artifact metadata is invalid.');
	}
	return parsed.data;
}

function parseRecord(path: string, value: unknown): ArtifactRecord {
	const parsed = artifactRecordSchema.safeParse(value);
	if (!parsed.success) {
		throw new StorageCorruptionError(path, parsed.error.message);
	}
	return parsed.data;
}

function assertIntegrity(record: ArtifactRecord): void {
	const canonicalContent = canonicalJson(record.content);
	const contentLength = Buffer.byteLength(canonicalContent, 'utf8');
	const hash = createHash('sha256').update(canonicalContent, 'utf8').digest('hex');
	if (record.contentLength !== contentLength || record.sha256 !== hash) {
		throw new MeshDomainError(
			'ARTIFACT_CORRUPT',
			'Stored artifact content does not match its immutable hash.',
		);
	}
	validateArtifactContent(record.content as JsonValue);
}

function validateArtifactContent(value: JsonValue): JsonValue {
	let nodes = 0;
	const visit = (candidate: JsonValue, depth: number): void => {
		nodes += 1;
		if (nodes > 4_096 || depth > 16) {
			throw new MeshDomainError('ARTIFACT_INVALID', 'Artifact JSON is too deeply nested or complex.');
		}
		if (typeof candidate === 'string') {
			if (
				Buffer.byteLength(candidate, 'utf8') > 8 * 1_024
				|| containsForbiddenArtifactText(candidate)
			) {
				throw new MeshDomainError(
					'ARTIFACT_INVALID',
					'Artifact JSON contains forbidden or oversized text.',
				);
			}
			return;
		}
		if (typeof candidate === 'number' && !Number.isFinite(candidate)) {
			throw new MeshDomainError('ARTIFACT_INVALID', 'Artifact JSON numbers must be finite.');
		}
		if (Array.isArray(candidate)) {
			candidate.forEach((entry) => visit(entry, depth + 1));
			return;
		}
		if (candidate !== null && typeof candidate === 'object') {
			for (const [key, entry] of Object.entries(candidate)) {
				if (
					Buffer.byteLength(key, 'utf8') > 128
					|| /(secret|token|credential|password|authorization|cookie|localpath|filepath|filesystem|transcript|rawlog|rawoutput|rawprompt)/iu.test(key)
				) {
					throw new MeshDomainError(
						'ARTIFACT_INVALID',
						'Artifact JSON contains a forbidden field.',
					);
				}
				visit(entry, depth + 1);
			}
		}
	};
	if (value === null || Array.isArray(value) || typeof value !== 'object') {
		throw new MeshDomainError('ARTIFACT_INVALID', 'Artifact content must be a JSON object.');
	}
	visit(value, 0);
	return structuredClone(value);
}

function containsForbiddenArtifactText(value: string): boolean {
	return (
		/(?:^|[\s"'(])\/(?:Users|home|private|tmp|var|etc|opt)\//u.test(value)
		|| /(?:^|[\s"'(])[A-Za-z]:[\\/]/u.test(value)
		|| /file:\/\//iu.test(value)
		|| /\b(?:bearer\s+[A-Za-z0-9._~-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/iu.test(value)
		|| /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)
		|| /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/u.test(value)
	);
}

function toReference(record: ArtifactRecord): CollaborationArtifactReference {
	return {
		artifactId: record.artifactId,
		runId: record.runId,
		producerTaskId: record.producerTaskId,
		label: record.label,
		mediaType: record.mediaType,
		contentLength: record.contentLength,
		sha256: record.sha256,
		revision: record.revision,
		createdAt: record.createdAt,
	};
}

function artifactPath(artifactId: string): string {
	return `artifacts/${artifactId}.json`;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}
