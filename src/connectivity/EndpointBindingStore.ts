import { z } from 'zod';

import type { AtomicFileStore } from '../storage/AtomicFileStore';
import { FencedDocumentStore, type DocumentFence } from '../storage/FencedDocumentStore';
import { ConnectivityError, endpointBindingSchema, type PeerEndpointBinding } from './ConnectivitySchemas';
import { validateForwardingOrigin } from './DevTunnelUris';

const attemptSchema = endpointBindingSchema.omit({ verifiedOrigin: true, verifiedAt: true }).extend({
	expectedOrigin: z.string().url().max(512),
});
export type EndpointBindingAttempt = z.infer<typeof attemptSchema>;

const documentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	revision: z.number().int().nonnegative(),
	entries: z.array(endpointBindingSchema).max(256).refine(
		(entries) => new Set(entries.map((entry) => entry.profileId)).size === entries.length,
		'Endpoint profile IDs must be unique.',
	),
	attempts: z.array(attemptSchema).max(256).default([]).refine(
		(entries) => new Set(entries.map((entry) => entry.profileId)).size === entries.length,
	),
});

export class EndpointBindingStore {
	private readonly document: FencedDocumentStore<z.infer<typeof documentSchema>>;

	public constructor(files: AtomicFileStore, fence: DocumentFence) {
		this.document = new FencedDocumentStore(files, 'connectivity/endpoints.json', documentSchema, {
			schemaVersion: 1, revision: 0, entries: [], attempts: [],
		}, fence);
	}

	public async initialize(): Promise<void> {
		await this.document.initialize();
		for (const binding of this.document.snapshot().entries) { validateForwardingOrigin(binding.verifiedOrigin, binding.locator.portNumber); }
		for (const attempt of this.document.snapshot().attempts) { validateForwardingOrigin(attempt.expectedOrigin, attempt.locator.portNumber); }
	}

	public get(profileId: string): PeerEndpointBinding | undefined {
		return this.document.snapshot().entries.find((entry) => entry.profileId === profileId);
	}

	public list(): readonly PeerEndpointBinding[] {
		return this.document.snapshot().entries;
	}

	public references(): readonly { profileId: string; profileGeneration: string }[] {
		const document = this.document.snapshot();
		return [...document.entries, ...document.attempts].map(({ profileId, profileGeneration }) => ({ profileId, profileGeneration }));
	}

	public attempt(profileId: string): EndpointBindingAttempt | undefined {
		return this.document.snapshot().attempts.find((entry) => entry.profileId === profileId);
	}

	public async prepare(attempt: EndpointBindingAttempt): Promise<void> {
		await this.document.update((current) => ({
			...current, attempts: [...current.attempts.filter((entry) => entry.profileId !== attempt.profileId), attemptSchema.parse(attempt)],
		}));
	}

	public async commit(
		binding: PeerEndpointBinding,
		expected: PeerEndpointBinding | undefined,
		validate: () => Promise<void>,
	): Promise<void> {
		await this.document.update((current) => {
			const actual = current.entries.find((entry) => entry.profileId === binding.profileId);
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				throw new ConnectivityError('BINDING_CHANGED');
			}
			return { ...current, attempts: current.attempts.filter((entry) => entry.profileId !== binding.profileId), entries: [
				...current.entries.filter((entry) => entry.profileId !== binding.profileId),
				endpointBindingSchema.parse(binding),
			] };
		}, validate);
	}

	public async remove(profileId: string, generation: string): Promise<void> {
		await this.document.update((current) => ({
			...current,
			entries: current.entries.filter((entry) =>
				entry.profileId !== profileId || entry.profileGeneration !== generation),
			attempts: current.attempts.filter((entry) =>
				entry.profileId !== profileId || entry.profileGeneration !== generation),
		}));
	}
}
