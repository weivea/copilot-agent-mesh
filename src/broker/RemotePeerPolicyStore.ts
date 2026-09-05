import { z } from 'zod';

import { uuidSchema, workspaceIdentitySchema } from '../../shared/protocol';
import type { AtomicFileStore } from '../storage/AtomicFileStore';
import { FencedDocumentStore, type DocumentFence } from '../storage/FencedDocumentStore';
import { MeshDomainError } from '../domain/errors';

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
	autoAcceptPeerIds: z.array(uuidSchema).max(32).default([])
		.refine((values) => new Set(values).size === values.length),
}).refine((entry) => entry.autoAcceptPeerIds.every((id) => entry.incomingPeerIds.includes(id)),
	'Auto-accept requires an incoming peer grant.');
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
			?? { workspaceIdentity: identity, allowlist: [], incomingPeerIds: [], autoAcceptPeerIds: [] };
	}

	public revision(): number { return this.document.snapshot().revision; }

	public async update(
		workspaceIdentity: string,
		transform: (entry: z.infer<typeof entrySchema>) => z.infer<typeof entrySchema>,
		validate: () => Promise<void>,
		expectedRevision?: number,
	): Promise<void> {
		await this.updateMany([workspaceIdentity], transform, validate, expectedRevision);
	}

	public async updateMany(
		workspaceIdentities: readonly string[],
		transform: (entry: z.infer<typeof entrySchema>) => z.infer<typeof entrySchema>,
		validate: () => Promise<void>,
		expectedRevision?: number,
	): Promise<void> {
		const identities = z.array(workspaceIdentitySchema).min(1).max(32).parse(workspaceIdentities);
		if (new Set(identities).size !== identities.length) {
			throw new MeshDomainError('POLICY_FORBIDDEN', 'Source Workspace identities must be unique.');
		}
		await this.document.update((document) => {
			if (expectedRevision !== undefined && document.revision !== expectedRevision) {
				throw new MeshDomainError('POLICY_FORBIDDEN', 'The remote policy changed. Refresh before editing it.');
			}
			const entries = identities.map((identity) => {
				const current = document.entries.find((entry) => entry.workspaceIdentity === identity)
					?? { workspaceIdentity: identity, allowlist: [], incomingPeerIds: [], autoAcceptPeerIds: [] };
				const entry = entrySchema.parse(transform(current));
				if (entry.workspaceIdentity !== identity) { throw new Error('Remote policy identity changed.'); }
				return entry;
			});
			return { ...document, entries: [
				...document.entries.filter((entry) => !identities.includes(entry.workspaceIdentity)), ...entries,
			] };
		}, validate);
	}

	public async removePeer(peerId: string): Promise<void> {
		const id = uuidSchema.parse(peerId);
		await this.document.update((document) => ({
			...document,
			entries: document.entries.map((entry) => ({
				...entry,
				incomingPeerIds: entry.incomingPeerIds.filter((peer) => peer !== id),
				autoAcceptPeerIds: entry.autoAcceptPeerIds.filter((peer) => peer !== id),
			})),
		}));
	}
}
