import { z } from 'zod';

import {
	PROTOCOL_LIMITS,
	timestampSchema,
	utf8String,
	workspaceIdentitySchema,
	type WorkspaceIdentity,
} from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import type { Clock } from '../domain/ports';
import {
	StorageCorruptionError,
	type AtomicFileStore,
} from '../storage/AtomicFileStore';
import type { WorkerOwnership } from '../storage/WorkerOwnerLock';
import { foldWindowName, validateWindowName } from './WindowName';

export const PEER_POLICY_PATH = 'peers/policy.json';
export const MAX_PEER_POLICY_ENTRIES = 256;
export const MAX_PEER_ALLOWLIST_TARGETS = 32;

export const peerPolicyEntrySchema = z.strictObject({
	windowName: utf8String(PROTOCOL_LIMITS.nameBytes, 'window name', 1),
	windowNameFold: utf8String(PROTOCOL_LIMITS.nameBytes, 'folded window name', 1),
	acceptsIncoming: z.boolean(),
	allowlist: z.array(workspaceIdentitySchema).max(MAX_PEER_ALLOWLIST_TARGETS)
		.refine((values) => new Set(values).size === values.length, 'Allowlist entries must be unique'),
	updatedAt: timestampSchema,
});

export const peerPolicyDocumentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	entries: z.record(workspaceIdentitySchema, peerPolicyEntrySchema)
		.refine(
			(entries) => Object.keys(entries).length <= MAX_PEER_POLICY_ENTRIES,
			`Peer policy entries cannot exceed ${MAX_PEER_POLICY_ENTRIES}`,
		),
}).superRefine((document, context) => {
	const owners = new Map<string, string>();
	for (const [identity, entry] of Object.entries(document.entries)) {
		try {
			validateWindowName(entry.windowName);
		} catch {
			context.addIssue({
				code: 'custom',
				path: ['entries', identity, 'windowName'],
				message: 'Stored window name is unsafe',
			});
		}
		const fold = foldWindowName(entry.windowName);
		if (entry.windowNameFold !== fold) {
			context.addIssue({
				code: 'custom',
				path: ['entries', identity, 'windowNameFold'],
				message: 'Stored window name fold does not match the window name',
			});
		}
		const owner = owners.get(fold);
		if (owner !== undefined && owner !== identity) {
			context.addIssue({
				code: 'custom',
				path: ['entries', identity, 'windowNameFold'],
				message: 'Stored window names must be device-wide unique',
			});
		} else {
			owners.set(fold, identity);
		}
	}
});

export type PeerPolicyEntry = z.infer<typeof peerPolicyEntrySchema>;
export type PeerPolicyDocument = z.infer<typeof peerPolicyDocumentSchema>;
export type PeerPolicyValue = Omit<PeerPolicyEntry, 'updatedAt' | 'windowNameFold'>;

export interface PeerPolicyStoreOptions {
	readonly ownership: WorkerOwnership;
	readonly generation: string;
	readonly clock: Clock;
}

export class PeerPolicyStore {
	private document: PeerPolicyDocument | undefined;
	private operationQueue: Promise<void> = Promise.resolve();

	public constructor(
		private readonly files: AtomicFileStore,
		private readonly options: PeerPolicyStoreOptions,
	) {}

	public initialize(): Promise<void> {
		return this.serialize(async () => {
			if (this.document !== undefined) {
				return;
			}
			const stored = await this.files.readJson(PEER_POLICY_PATH);
			if (stored === undefined) {
				this.document = { schemaVersion: 1, entries: {} };
				return;
			}
			const parsed = peerPolicyDocumentSchema.safeParse(stored);
			if (!parsed.success) {
				throw new StorageCorruptionError(
					PEER_POLICY_PATH,
					z.prettifyError(parsed.error),
				);
			}
			this.document = parsed.data;
		});
	}

	public get(workspaceIdentity: string): PeerPolicyEntry | undefined {
		const identity = workspaceIdentitySchema.parse(workspaceIdentity);
		return structuredClone(this.requireDocument().entries[identity]);
	}

	public snapshot(): PeerPolicyDocument {
		return structuredClone(this.requireDocument());
	}

	public set(
		workspaceIdentity: string,
		policy: PeerPolicyValue,
	): Promise<PeerPolicyEntry> {
		return this.update(workspaceIdentity, () => policy);
	}

	public update(
		workspaceIdentity: string,
		update: (current: PeerPolicyEntry | undefined) => PeerPolicyValue,
	): Promise<PeerPolicyEntry> {
		const identity = workspaceIdentitySchema.parse(workspaceIdentity);
		return this.mutate(identity, update);
	}

	private mutate(
		identity: WorkspaceIdentity,
		update: (current: PeerPolicyEntry | undefined) => PeerPolicyValue,
	): Promise<PeerPolicyEntry> {
		let result: PeerPolicyEntry | undefined;
		const operation = this.serialize(async () => {
			const current = this.requireDocument();
			if (
				current.entries[identity] === undefined
				&& Object.keys(current.entries).length >= MAX_PEER_POLICY_ENTRIES
			) {
				throw new MeshDomainError(
					'POLICY_FORBIDDEN',
					`Peer policy entries cannot exceed ${MAX_PEER_POLICY_ENTRIES}.`,
				);
			}
			const policy = update(structuredClone(current.entries[identity]));
			validateWindowName(policy.windowName);
			const windowNameFold = foldWindowName(policy.windowName);
			const conflict = Object.entries(current.entries).find(
				([candidateIdentity, candidate]) =>
					candidateIdentity !== identity
					&& candidate.windowNameFold === windowNameFold,
			);
			if (conflict !== undefined) {
				throw new MeshDomainError(
					'WINDOW_NAME_CONFLICT',
					'Another workspace already uses an equivalent window name.',
				);
			}
			const entry = peerPolicyEntrySchema.parse({
				...policy,
				windowNameFold,
				updatedAt: this.options.clock.now().toISOString(),
			});
			const next = peerPolicyDocumentSchema.parse({
				schemaVersion: 1,
				entries: {
					...current.entries,
					[identity]: entry,
				},
			});
			await this.assertFence('before');
			await this.files.writeJson(PEER_POLICY_PATH, next);
			await this.assertFence('during');
			this.document = next;
			result = entry;
		});
		return operation.then(() => structuredClone(result!));
	}

	private serialize(operation: () => Promise<void>): Promise<void> {
		const result = this.operationQueue.then(operation, operation);
		this.operationQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private requireDocument(): PeerPolicyDocument {
		if (this.document === undefined) {
			throw new Error('Peer policy store is not initialized.');
		}
		return this.document;
	}

	private async assertFence(when: 'before' | 'during'): Promise<void> {
		const { ownership, generation } = this.options;
		if (!ownership.isOwner() || ownership.currentGeneration() !== generation) {
			throw generationChangedError(when);
		}
		try {
			await ownership.assertOwner();
		} catch {
			throw generationChangedError(when);
		}
		if (ownership.currentGeneration() !== generation) {
			throw generationChangedError(when);
		}
	}
}

function generationChangedError(when: 'before' | 'during'): MeshDomainError {
	return new MeshDomainError(
		'WORKER_DRAINING',
		`Device Broker generation changed ${when} the peer policy write.`,
		true,
	);
}
