import { z } from 'zod';

import { uuidSchema } from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import type { AtomicFileStore } from '../storage/AtomicFileStore';
import { FencedDocumentStore, type DocumentFence } from '../storage/FencedDocumentStore';
import type { PairingRecordStore } from './PairingService';
import type { SecretStore } from './SecretStore';
import { ConnectivityError } from '../connectivity/ConnectivitySchemas';

const entrySchema = z.strictObject({
	peerId: uuidSchema,
	keyRefs: z.array(z.string().regex(/^mesh\.(?:peer|invitation)\.[A-Za-z0-9._~-]{1,128}$/u)).max(4),
	taskCancellationPending: z.boolean(),
	cleanupPending: z.boolean(),
});
const documentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	revision: z.number().int().nonnegative(),
	entries: z.array(entrySchema).max(1024).refine(
		(entries) => new Set(entries.map((entry) => entry.peerId)).size === entries.length,
	),
});

export class PeerRevocationService {
	private readonly document: FencedDocumentStore<z.infer<typeof documentSchema>>;
	private initialized = false;
	private readonly denyRequested = new Set<string>();

	public constructor(
		files: AtomicFileStore, private readonly fence: DocumentFence,
		private readonly records: PairingRecordStore,
		private readonly secrets: SecretStore,
		private readonly closePeer: (peerId: string) => void,
		private readonly cancelPeerTasks: (peerId: string) => Promise<void>,
		private readonly changed: () => void,
	) {
		this.document = new FencedDocumentStore(files, 'peers/revocations.json', documentSchema, {
			schemaVersion: 1, revision: 0, entries: [],
		}, fence);
	}

	public async initialize(): Promise<void> {
		await this.document.initialize();
		this.initialized = true;
	}

	public assertAllowed(peerId: string): void {
		if (!this.initialized || !this.fence.ownership.isOwner()
			|| this.fence.ownership.currentGeneration() !== this.fence.generation
			|| this.denyRequested.has(peerId)
			|| this.document.snapshot().entries.some((entry) => entry.peerId === peerId)) {
			throw new MeshDomainError('AUTH_FAILED', 'This Mesh peer is revoked or remote authentication is blocked.');
		}
	}

	public snapshot() {
		return this.document.snapshot().entries;
	}

	/** Called under PairingService's record mutation lock, including restart cleanup. */
	public async revoke(peerId: string): Promise<void> {
		uuidSchema.parse(peerId);
		if (!this.document.snapshot().entries.some((entry) => entry.peerId === peerId)) {
			const active = await this.records.getPeer(peerId);
			const pending = (await this.records.listPending()).find((entry) => entry.peerId === peerId);
			const invitation = pending === undefined ? undefined : await this.records.getInvitation(pending.invitationId);
			if (active === undefined && pending === undefined) {
				throw new MeshDomainError('AUTH_FAILED', 'The incoming Mesh peer is unknown.');
			}
			const keyRefs = [...new Set([
				active?.rootKeyRef, active?.invitationSecretKeyRef, pending?.rootKeyRef, invitation?.secretKeyRef,
			].filter((value): value is string => value !== undefined))];
			this.denyRequested.add(peerId);
			await this.document.update((current) => ({
				...current,
				entries: [...current.entries, { peerId, keyRefs, taskCancellationPending: true, cleanupPending: true }],
			}));
		}
		this.closePeer(peerId);
		this.changed();
		await this.cleanup(peerId);
	}

	public async retryCleanup(): Promise<void> {
		const failures: unknown[] = [];
		for (const entry of this.document.snapshot().entries) {
			this.closePeer(entry.peerId);
			if (entry.cleanupPending || entry.taskCancellationPending) {
				try {
					await this.cleanup(entry.peerId);
				} catch (error: unknown) {
					failures.push(error);
				}
			}
		}
		if (failures.length > 0) {
			throw new ConnectivityError('CLEANUP_FAILED');
		}
	}

	private async cleanup(peerId: string): Promise<void> {
		let entry = this.document.snapshot().entries.find((value) => value.peerId === peerId)!;
		let failed = false;
		if (entry.taskCancellationPending) {
			try {
				await this.cancelPeerTasks(peerId);
				await this.update(peerId, { taskCancellationPending: false });
			} catch {
				failed = true;
			}
		}
		for (const keyRef of entry.keyRefs) {
			try {
				await this.secrets.delete(keyRef);
				entry = this.document.snapshot().entries.find((value) => value.peerId === peerId)!;
				await this.update(peerId, { keyRefs: entry.keyRefs.filter((value) => value !== keyRef) });
			} catch {
				failed = true;
			}
		}
		entry = this.document.snapshot().entries.find((value) => value.peerId === peerId)!;
		if (!failed && entry.keyRefs.length === 0) {
			try {
				for (const pending of await this.records.listPending()) {
					if (pending.peerId === peerId) {
						await this.records.deleteInvitation(pending.invitationId);
						await this.records.deletePending(pending.enrollmentId);
					}
				}
				const active = await this.records.getPeer(peerId);
				if (active?.cleanupPending && !await this.records.completePeerCleanup(peerId, active.enrollmentId)) {
					throw new ConnectivityError('CLEANUP_FAILED');
				}
				await this.update(peerId, { cleanupPending: false });
			} catch {
				failed = true;
			}
		}
		this.changed();
		if (failed) {
			throw new ConnectivityError('CLEANUP_FAILED');
		}
	}

	private async update(peerId: string, patch: Partial<z.infer<typeof entrySchema>>): Promise<void> {
		await this.document.update((current) => ({
			...current, entries: current.entries.map((entry) => entry.peerId === peerId ? { ...entry, ...patch } : entry),
		}));
	}
}
