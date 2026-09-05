import { z } from 'zod';

import { MeshDomainError } from '../domain/errors';
import type { WorkerOwnership } from './WorkerOwnerLock';
import { StorageCorruptionError, type AtomicFileStore } from './AtomicFileStore';

export interface DocumentFence {
	readonly ownership: WorkerOwnership;
	readonly generation: string;
}

export async function assertDocumentFence(fence: DocumentFence): Promise<void> {
	if (!fence.ownership.isOwner() || fence.ownership.currentGeneration() !== fence.generation) {
		throw new MeshDomainError('WORKER_DRAINING', 'The Device Broker generation changed.', true);
	}
	await fence.ownership.assertOwner();
	if (fence.ownership.currentGeneration() !== fence.generation) {
		throw new MeshDomainError('WORKER_DRAINING', 'The Device Broker generation changed.', true);
	}
}

/** A bounded atomic document; authorization decisions only use a successfully loaded revision. */
export class FencedDocumentStore<T extends { revision: number }> {
	private document: T | undefined;
	private queue: Promise<void> = Promise.resolve();

	public constructor(
		private readonly files: AtomicFileStore,
		private readonly path: string,
		private readonly schema: z.ZodType<T>,
		private readonly initial: T,
		private readonly fence: DocumentFence,
		private readonly maxBytes = 256 * 1024,
	) {}

	public async initialize(): Promise<void> {
		await this.serialize(async () => {
			if (this.document !== undefined) {
				return;
			}
			const stored = await this.files.readJson(this.path);
			const parsed = this.schema.safeParse(stored ?? this.initial);
			if (!parsed.success || Buffer.byteLength(JSON.stringify(stored ?? this.initial)) > this.maxBytes) {
				throw new StorageCorruptionError(this.path, 'Invalid or oversized document.');
			}
			await assertDocumentFence(this.fence);
			this.document = parsed.data;
		});
	}

	public snapshot(): T {
		if (this.document === undefined) {
			throw new Error('The remote state document is not initialized.');
		}
		return structuredClone(this.document);
	}

	public update(transform: (current: T) => T, validate?: () => Promise<void>): Promise<T> {
		return this.serialize(async () => {
			const current = this.snapshot();
			const next = this.schema.parse({ ...transform(current), revision: current.revision + 1 });
			if (Buffer.byteLength(JSON.stringify(next)) > this.maxBytes) {
				throw new MeshDomainError('POLICY_FORBIDDEN', 'The remote state document is full.');
			}
			await assertDocumentFence(this.fence);
			await validate?.();
			await this.files.writeJson(this.path, next, async () => {
				await assertDocumentFence(this.fence);
				await validate?.();
				await assertDocumentFence(this.fence);
			});
			// The rename is the commit point. Later claim changes must not turn a committed
			// authorization into an apparently rejected write that reappears after restart.
			await assertDocumentFence(this.fence);
			this.document = next;
			return structuredClone(next);
		});
	}

	private serialize<R>(operation: () => Promise<R>): Promise<R> {
		const result = this.queue.then(operation, operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}
}
