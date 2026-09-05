import { z } from 'zod';

import { uuidSchema, workspaceIdentitySchema } from '../../shared/protocol';
import type { AtomicFileStore } from '../storage/AtomicFileStore';
import { FencedDocumentStore, type DocumentFence } from '../storage/FencedDocumentStore';

export const remoteAllowedTargetSchema = z.strictObject({
	profileId: uuidSchema,
	profileGeneration: uuidSchema,
	workspaceIdentity: workspaceIdentitySchema,
});
export type RemoteAllowedTarget = z.infer<typeof remoteAllowedTargetSchema>;

const entrySchema = z.strictObject({
	workspaceIdentity: workspaceIdentitySchema,
	allowlist: z.array(remoteAllowedTargetSchema).max(32),
	incomingPeerIds: z.array(uuidSchema).max(32)
		.refine((values) => new Set(values).size === values.length),
});
const documentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	revision: z.number().int().nonnegative(),
	entries: z.array(entrySchema).max(256).refine(
		(entries) => new Set(entries.map((entry) => entry.workspaceIdentity)).size === entries.length,
	),
});

export class RemotePeerPolicyStore {
	private readonly document: FencedDocumentStore<z.infer<typeof documentSchema>>;

	public constructor(files: AtomicFileStore, fence: DocumentFence) {
		this.document = new FencedDocumentStore(files, 'peers/remote-policy.json', documentSchema, {
			schemaVersion: 1, revision: 0, entries: [],
		}, fence);
	}

	public initialize(): Promise<void> {
		return this.document.initialize();
	}

	public get(workspaceIdentity: string): z.infer<typeof entrySchema> {
		const identity = workspaceIdentitySchema.parse(workspaceIdentity);
		return this.document.snapshot().entries.find((entry) => entry.workspaceIdentity === identity)
			?? { workspaceIdentity: identity, allowlist: [], incomingPeerIds: [] };
	}

	public async update(
		workspaceIdentity: string,
		transform: (entry: z.infer<typeof entrySchema>) => z.infer<typeof entrySchema>,
		validate: () => Promise<void>,
	): Promise<void> {
		const identity = workspaceIdentitySchema.parse(workspaceIdentity);
		await this.document.update((document) => {
			const current = document.entries.find((entry) => entry.workspaceIdentity === identity)
				?? { workspaceIdentity: identity, allowlist: [], incomingPeerIds: [] };
			const entry = entrySchema.parse(transform(current));
			if (entry.workspaceIdentity !== identity) {
				throw new Error('Remote policy identity changed.');
			}
			return { ...document, entries: [
				...document.entries.filter((entry) => entry.workspaceIdentity !== identity), entry,
			] };
		}, validate);
	}
}
