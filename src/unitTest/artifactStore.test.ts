import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { PROTOCOL_LIMITS } from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import { AtomicFileStore } from '../storage/AtomicFileStore';
import { ArtifactStore } from '../tasks/ArtifactStore';
import {
	MemoryAtomicFileSystem,
	TestOwnership,
	uuid,
} from './collaborationTestSupport';

const RUN_ID = uuid(1);
const PRODUCER_TASK_ID = uuid(2);
const CONSUMER_TASK_ID = uuid(3);
const OTHER_TASK_ID = uuid(4);
const ARTIFACT_ID = uuid(5);
const AT = '2026-08-30T06:00:00.000Z';

test('Artifact Store persists immutable canonical JSON with exact task authorization', async () => {
	const memory = new MemoryAtomicFileSystem();
	const store = createStore(memory);
	const input = {
		artifactId: ARTIFACT_ID,
		runId: RUN_ID,
		producerTaskId: PRODUCER_TASK_ID,
		consumerTaskIds: [CONSUMER_TASK_ID],
		label: 'Backend API contract',
		mediaType: 'application/schema+json',
		content: {
			required: ['id'],
			properties: { id: { type: 'string' } },
			type: 'object',
		},
		createdAt: AT,
	};
	const first = await store.create(input);
	const retry = await store.create(input);
	assert.deepStrictEqual(retry, first);
	assert.match(first.sha256, /^[a-f0-9]{64}$/u);
	assert.ok(first.contentLength > 0);

	const recovered = createStore(memory);
	const authorized = await recovered.readForTask(
		ARTIFACT_ID,
		RUN_ID,
		CONSUMER_TASK_ID,
	);
	assert.deepStrictEqual(authorized.reference, first);
	assert.deepStrictEqual(authorized.content, input.content);
	await assert.rejects(
		recovered.readForTask(ARTIFACT_ID, RUN_ID, OTHER_TASK_ID),
		(error: unknown) =>
			error instanceof MeshDomainError && error.reason === 'ARTIFACT_FORBIDDEN',
	);
	await assert.rejects(
		store.create({ ...input, content: { type: 'array' } }),
		(error: unknown) =>
			error instanceof MeshDomainError && error.reason === 'ARTIFACT_INVALID',
	);
});

test('Artifact Store rejects media, size, secrets, paths, and per-run count overflow', async () => {
	const memory = new MemoryAtomicFileSystem();
	const store = createStore(memory);
	const base = {
		runId: RUN_ID,
		producerTaskId: PRODUCER_TASK_ID,
		consumerTaskIds: [CONSUMER_TASK_ID],
		label: 'Contract',
		mediaType: 'application/json',
		createdAt: AT,
	};
	for (const [index, change] of [
		[1, { mediaType: 'text/plain' }],
		[2, { content: { token: 'private-value' } }],
		[3, { content: { location: '/Users/person/private/file' } }],
		[4, { content: { value: 'x'.repeat(PROTOCOL_LIMITS.artifactContentBytes) } }],
	] as const) {
		await assert.rejects(
			store.create({
				...base,
				artifactId: uuid(index),
				content: { type: 'object' },
				...change,
			}),
			(error: unknown) =>
				error instanceof MeshDomainError
				&& ['ARTIFACT_INVALID', 'ARTIFACT_LIMIT_EXCEEDED'].includes(error.reason),
		);
	}

	for (let index = 0; index < PROTOCOL_LIMITS.collaborationArtifactCount; index += 1) {
		await store.create({
			...base,
			artifactId: uuid(100 + index),
			content: { index },
		});
	}
	await assert.rejects(
		store.create({
			...base,
			artifactId: uuid(999),
			content: { overflow: true },
		}),
		(error: unknown) =>
			error instanceof MeshDomainError
			&& error.reason === 'ARTIFACT_LIMIT_EXCEEDED',
	);
});

test('Artifact Store detects corruption and fences stale Broker generations', async () => {
	const memory = new MemoryAtomicFileSystem();
	const ownership = new TestOwnership();
	const files = new AtomicFileStore('memory', memory, { next: () => 'temporary-id' });
	const store = new ArtifactStore(files, {
		ownership,
		generation: ownership.generation,
	});
	await store.create({
		artifactId: ARTIFACT_ID,
		runId: RUN_ID,
		producerTaskId: PRODUCER_TASK_ID,
		consumerTaskIds: [CONSUMER_TASK_ID],
		label: 'Contract',
		mediaType: 'application/json',
		content: { type: 'object' },
		createdAt: AT,
	});
	const path = join('memory', 'artifacts', `${ARTIFACT_ID}.json`);
	const stored = memory.files.get(path);
	assert.ok(stored !== undefined, 'the artifact record must be persisted before corruption');
	const record = JSON.parse(stored);
	record.content = { type: 'array' };
	memory.files.set(path, `${JSON.stringify(record)}\n`);
	await assert.rejects(
		store.readForTask(ARTIFACT_ID, RUN_ID, CONSUMER_TASK_ID),
		(error: unknown) =>
			error instanceof MeshDomainError && error.reason === 'ARTIFACT_CORRUPT',
	);

	const fencingMemory = new MemoryAtomicFileSystem();
	const fencingOwnership = new TestOwnership();
	const fencingStore = new ArtifactStore(
		new AtomicFileStore('fencing', fencingMemory, { next: () => 'temporary-id' }),
		{ ownership: fencingOwnership, generation: fencingOwnership.generation },
	);
	fencingOwnership.generation = 'generation-2';
	await assert.rejects(
		fencingStore.create({
			artifactId: uuid(6),
			runId: RUN_ID,
			producerTaskId: PRODUCER_TASK_ID,
			consumerTaskIds: [CONSUMER_TASK_ID],
			label: 'Next contract',
			mediaType: 'application/json',
			content: { type: 'object' },
			createdAt: AT,
		}),
		(error: unknown) =>
			error instanceof MeshDomainError && error.reason === 'WORKER_DRAINING',
	);
});

function createStore(memory: MemoryAtomicFileSystem): ArtifactStore {
	return new ArtifactStore(
		new AtomicFileStore('memory', memory, { next: () => `temporary-${memory.files.size}` }),
	);
}
