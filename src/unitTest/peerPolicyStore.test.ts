import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import { MeshDomainError } from '../domain/errors';
import { AtomicFileStore, StorageCorruptionError } from '../storage/AtomicFileStore';
import {
	MAX_PEER_ALLOWLIST_TARGETS,
	MAX_PEER_POLICY_ENTRIES,
	PEER_POLICY_PATH,
	PeerPolicyStore,
	type PeerPolicyDocument,
} from '../broker/PeerPolicyStore';
import {
	MemoryAtomicFileSystem,
	TestOwnership,
} from './artifactStoreTestSupport';

const ROOT = 'memory';
const POLICY_FILE = join(ROOT, PEER_POLICY_PATH);
const NOW = new Date('2026-08-30T10:00:00.000Z');

test('defaults to an empty policy document without writing state', async () => {
	const fixture = createFixture();
	await fixture.store.initialize();

	assert.deepEqual(fixture.store.snapshot(), { schemaVersion: 1, entries: {} });
	assert.equal(fixture.fileSystem.files.has(POLICY_FILE), false);
});

test('persists atomically and recovers the exact policy after restart', async () => {
	const operations: string[] = [];
	const fileSystem = new RecordingFileSystem(operations);
	const first = createFixture({ fileSystem });
	await first.store.initialize();
	const source = identity('source');
	const target = identity('target');

	await first.store.set(source, {
		windowName: 'frontend',
		acceptsIncoming: true,
		allowlist: [target],
	});

	assert.deepEqual(operations.slice(-4).map(normalizeOperation), [
		'write:tmp',
		'sync-file:tmp',
		'rename:tmp->policy',
		'sync-directory:peers',
	]);
	assert.equal([...fileSystem.files.keys()].some((path) => path.endsWith('.tmp')), false);

	const restarted = createFixture({ fileSystem });
	await restarted.store.initialize();
	assert.deepEqual(restarted.store.get(source), first.store.get(source));
});

test('fails explicitly for corrupt JSON, invalid schema, and unknown versions', async () => {
	for (const [name, contents] of [
		['corrupt JSON', '{'],
		['invalid schema', JSON.stringify({ schemaVersion: 1, entries: [] })],
		['unknown version', JSON.stringify({ schemaVersion: 2, entries: {} })],
	] as const) {
		await test(name, async () => {
			const fileSystem = new MemoryAtomicFileSystem();
			fileSystem.files.set(POLICY_FILE, contents);
			const { store } = createFixture({ fileSystem });
			await assert.rejects(
				store.initialize(),
				(error: unknown) => error instanceof StorageCorruptionError,
			);
		});
	}
});

test('enforces entry and allowlist bounds', async () => {
	const fileSystem = new MemoryAtomicFileSystem();
	fileSystem.files.set(POLICY_FILE, `${JSON.stringify(fullDocument())}\n`);
	const { store } = createFixture({ fileSystem });
	await store.initialize();

	await assert.rejects(
		store.set(identity('overflow'), defaultPolicy()),
		(error: unknown) =>
			error instanceof MeshDomainError
			&& error.reason === 'POLICY_FORBIDDEN',
	);
	await assert.rejects(
		store.set(identity('source'), {
			...defaultPolicy(),
			allowlist: Array.from(
				{ length: MAX_PEER_ALLOWLIST_TARGETS + 1 },
				(_, index) => identity(`target-${index}`),
			),
		}),
	);
});

test('rejects stale ownership before persistence with WORKER_DRAINING', async () => {
	const fixture = createFixture();
	await fixture.store.initialize();
	fixture.ownership.generation = 'generation-2';

	await assert.rejects(
		fixture.store.set(identity('source'), defaultPolicy()),
		(error: unknown) =>
			error instanceof MeshDomainError
			&& error.reason === 'WORKER_DRAINING',
	);
	assert.equal(fixture.fileSystem.files.has(POLICY_FILE), false);
});

test('does not publish success or update memory when generation changes during persistence', async () => {
	const ownership = new TestOwnership();
	const fileSystem = new OwnershipChangingFileSystem(ownership);
	const fixture = createFixture({ ownership, fileSystem });
	await fixture.store.initialize();
	const source = identity('source');

	await assert.rejects(
		fixture.store.set(source, defaultPolicy()),
		(error: unknown) =>
			error instanceof MeshDomainError
			&& error.reason === 'WORKER_DRAINING',
	);
	assert.equal(fixture.store.get(source), undefined);
	assert.equal(fileSystem.files.has(POLICY_FILE), true);
});

test('serializes concurrent mutations without losing either entry', async () => {
	const fileSystem = new ConcurrentWriteTrackingFileSystem();
	const fixture = createFixture({ fileSystem });
	await fixture.store.initialize();

	await Promise.all([
		fixture.store.set(identity('source-a'), defaultPolicy('A')),
		fixture.store.set(identity('source-b'), defaultPolicy('B')),
	]);

	assert.equal(fileSystem.maximumConcurrentWrites, 1);
	assert.equal(Object.keys(fixture.store.snapshot().entries).length, 2);
});

function createFixture(options: {
	readonly ownership?: TestOwnership;
	readonly fileSystem?: MemoryAtomicFileSystem;
} = {}) {
	const ownership = options.ownership ?? new TestOwnership();
	const fileSystem = options.fileSystem ?? new MemoryAtomicFileSystem();
	let nextId = 0;
	const files = new AtomicFileStore(ROOT, fileSystem, {
		next: () => `tmp-${nextId += 1}`,
	});
	return {
		ownership,
		fileSystem,
		store: new PeerPolicyStore(files, {
			ownership,
			generation: ownership.generation,
			clock: { now: () => NOW },
		}),
	};
}

function defaultPolicy(windowName = 'window') {
	return {
		windowName,
		acceptsIncoming: false,
		allowlist: [] as string[],
	};
}

function identity(seed: string): string {
	return `sha256:${createHash('sha256').update(seed).digest('base64url')}`;
}

function fullDocument(): PeerPolicyDocument {
	const entries: PeerPolicyDocument['entries'] = {};
	for (let index = 0; index < MAX_PEER_POLICY_ENTRIES; index += 1) {
		entries[identity(`entry-${index}`)] = {
			windowName: `window-${index}`,
			windowNameFold: `window-${index}`,
			acceptsIncoming: false,
			allowlist: [],
			updatedAt: NOW.toISOString(),
		};
	}
	return { schemaVersion: 1, entries };
}

class RecordingFileSystem extends MemoryAtomicFileSystem {
	public constructor(private readonly operations: string[]) {
		super();
	}

	public override async writeFile(path: string, contents: string): Promise<void> {
		this.operations.push(`write:${path}`);
		await super.writeFile(path, contents);
	}

	public override async syncFile(path: string): Promise<void> {
		this.operations.push(`sync-file:${path}`);
	}

	public override async rename(from: string, to: string): Promise<void> {
		this.operations.push(`rename:${from}->${to}`);
		await super.rename(from, to);
	}

	public override async syncDirectory(path: string): Promise<void> {
		this.operations.push(`sync-directory:${path}`);
	}
}

class OwnershipChangingFileSystem extends MemoryAtomicFileSystem {
	public constructor(private readonly ownership: TestOwnership) {
		super();
	}

	public override async rename(from: string, to: string): Promise<void> {
		await super.rename(from, to);
		this.ownership.generation = 'generation-2';
	}
}

class ConcurrentWriteTrackingFileSystem extends MemoryAtomicFileSystem {
	public maximumConcurrentWrites = 0;
	private activeWrites = 0;

	public override async writeFile(path: string, contents: string): Promise<void> {
		this.activeWrites += 1;
		this.maximumConcurrentWrites = Math.max(this.maximumConcurrentWrites, this.activeWrites);
		await Promise.resolve();
		await super.writeFile(path, contents);
		this.activeWrites -= 1;
	}
}

function normalizeOperation(operation: string): string {
	if (operation.startsWith('write:')) {
		return 'write:tmp';
	}
	if (operation.startsWith('sync-file:')) {
		return 'sync-file:tmp';
	}
	if (operation.startsWith('rename:')) {
		return 'rename:tmp->policy';
	}
	return 'sync-directory:peers';
}
