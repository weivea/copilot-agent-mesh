import { z } from 'zod';

import { uuidSchema } from '../../shared/protocol';
import type { PairingRecordStore, PairingService } from '../gateway/PairingService';
import type { SecretStore } from '../gateway/SecretStore';
import type { PeerConnectionManager } from '../peer/PeerConnectionManager';
import type { PeerProfile, PeerProfileStore } from '../peer/PeerProfile';
import type { AtomicFileStore } from '../storage/AtomicFileStore';
import { assertDocumentFence, FencedDocumentStore, type DocumentFence } from '../storage/FencedDocumentStore';
import type { AccountDeviceIdentityStore } from './AccountDeviceIdentity';
import type { AccountSessionProvider } from './AccountSessionProvider';
import type { BoundPeerTransport } from './BoundPeerTransport';
import {
	accountDeviceIdentitySchema, ConnectivityError, type AccountBinding, type ConnectivityCode,
} from './ConnectivitySchemas';
import type { DiscoveredEndpoint } from './DevTunnelDiscoveryProvider';
import { rpcEndpoint } from './DevTunnelUris';
import type { EndpointBindingStore } from './EndpointBindingStore';

const entrySchema = accountDeviceIdentitySchema.extend({
	accountRef: uuidSchema,
	profileId: uuidSchema,
	profileGeneration: uuidSchema,
	incomingPeerId: uuidSchema,
	legacyIncomingPeerIds: z.array(uuidSchema).max(32),
	blocked: z.boolean(),
});
const documentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	revision: z.number().int().nonnegative(),
	entries: z.array(entrySchema).max(256).refine(
		(entries) => new Set(entries.map((entry) => `${entry.accountRef}:${entry.deviceId}`)).size === entries.length,
	),
});
type AccountPeerEntry = z.infer<typeof entrySchema>;

export class AccountPeerEnrollment {
	private readonly document: FencedDocumentStore<z.infer<typeof documentSchema>>;
	private initialized = false;
	private lifetime = new AbortController();
	private syncing: Promise<void> = Promise.resolve();

	public constructor(
		files: AtomicFileStore,
		private readonly fence: DocumentFence,
		private readonly deviceId: string,
		private readonly account: AccountSessionProvider,
		private readonly identity: AccountDeviceIdentityStore,
		private readonly pairing: PairingService,
		private readonly records: PairingRecordStore,
		private readonly profiles: PeerProfileStore,
		private readonly secrets: SecretStore,
		private readonly endpoints: EndpointBindingStore,
		private readonly transport: BoundPeerTransport,
		private readonly peers: PeerConnectionManager,
		private readonly options: {
			readonly enabled: () => boolean;
			readonly isRevoked: (peerId: string) => boolean;
			readonly report: (code: ConnectivityCode) => void;
		},
	) {
		this.document = new FencedDocumentStore(files, 'connectivity/account-peers.json', documentSchema, {
			schemaVersion: 1, revision: 0, entries: [],
		}, fence);
	}

	public async initialize(): Promise<void> {
		await this.document.initialize();
		this.initialized = true;
	}

	public permitsIncoming(peerId: string): boolean {
		const accountRef = this.account.current()?.accountRef;
		return this.initialized && this.options.enabled()
			&& this.document.snapshot().entries.some((entry) =>
				entry.accountRef === accountRef && !entry.blocked
				&& (entry.incomingPeerId === peerId || entry.legacyIncomingPeerIds.includes(peerId)));
	}

	public permitsOutgoing(profileId: string): boolean {
		const accountRef = this.account.current()?.accountRef;
		return this.initialized && this.options.enabled()
			&& this.document.snapshot().entries.some((entry) =>
				entry.accountRef === accountRef && entry.profileId === profileId && !entry.blocked
				&& !this.options.isRevoked(entry.incomingPeerId));
	}

	public async block(peerId: string): Promise<readonly string[]> {
		const entry = this.document.snapshot().entries.find((value) =>
			value.incomingPeerId === peerId || value.legacyIncomingPeerIds.includes(peerId));
		if (entry === undefined) { return [peerId]; }
		this.lifetime.abort();
		this.lifetime = new AbortController();
		await this.document.update((value) => ({
			...value, entries: value.entries.map((candidate) => candidate === entry
				|| (candidate.accountRef === entry.accountRef && candidate.deviceId === entry.deviceId)
				? { ...candidate, blocked: true } : candidate),
		}));
		return [entry.incomingPeerId, ...entry.legacyIncomingPeerIds];
	}

	public async disconnectDevice(peerId: string): Promise<void> {
		const entry = this.document.snapshot().entries.find((value) =>
			value.incomingPeerId === peerId || value.legacyIncomingPeerIds.includes(peerId));
		if (entry !== undefined) { await this.peers.disconnect(entry.profileId); }
	}

	public incomingForProfile(profileId: string): string | undefined {
		return this.initialized ? this.document.snapshot().entries.find((entry) => entry.profileId === profileId)?.incomingPeerId : undefined;
	}

	/** Input is exclusively the management SDK's caller-owned list, not discovery hints sent over RPC. */
	public synchronize(endpoints: readonly DiscoveredEndpoint[]): Promise<void> {
		const signal = this.lifetime.signal;
		const account = this.account.current();
		const revision = this.account.revision();
		const operation = this.syncing.then(() => this.synchronizeCore(endpoints, signal, account, revision));
		this.syncing = operation.catch(() => undefined);
		return operation;
	}

	public async suspend(): Promise<void> {
		this.lifetime.abort();
		await this.disconnectAll();
		await this.syncing;
		await this.disconnectAll();
		this.lifetime = new AbortController();
	}

	public async disconnectAll(): Promise<void> {
		const results = await Promise.allSettled(this.peers.listConnections().map((connection) => this.peers.disconnect(connection.profileId)));
		if (results.some((result) => result.status === 'rejected')) { throw new ConnectivityError('CLEANUP_FAILED'); }
	}

	private async synchronizeCore(
		endpoints: readonly DiscoveredEndpoint[], signal: AbortSignal, account: AccountBinding | undefined, revision: number,
	): Promise<void> {
		if (account === undefined || !this.options.enabled() || signal.aborted) { return; }
		const validate = async (): Promise<void> => {
			await assertDocumentFence(this.fence);
			if (signal.aborted || !this.options.enabled()) { throw new ConnectivityError('CANCELLED'); }
			if (this.account.current()?.accountRef !== account.accountRef || this.account.revision() !== revision) {
				throw new ConnectivityError('ACCOUNT_CHANGED');
			}
		};
		await validate();
		const groups = new Map<string, DiscoveredEndpoint[]>();
		for (const endpoint of endpoints) {
			const identity = endpoint.accountIdentity;
			if (identity === undefined || identity.deviceId === this.deviceId || endpoint.admission !== 'private-port-token') { continue; }
			groups.set(identity.deviceId, [...groups.get(identity.deviceId) ?? [], endpoint]);
		}
		for (const [deviceId, candidates] of groups) {
			await validate();
			const existing = this.document.snapshot().entries.find((entry) =>
				entry.accountRef === account.accountRef && entry.deviceId === deviceId);
			if (existing?.blocked || (existing !== undefined && this.options.isRevoked(existing.incomingPeerId))) {
				await this.peers.disconnect(existing.profileId);
				continue;
			}
			if (new Set(candidates.map((candidate) => candidate.accountIdentity!.publicKey)).size !== 1
				|| (existing !== undefined && candidates[0].accountIdentity!.publicKey !== existing.publicKey)) {
				if (existing !== undefined) { await this.peers.disconnect(existing.profileId); }
				this.options.report('BINDING_CHANGED');
				continue;
			}
			const online = candidates.filter((candidate) => candidate.hostHint === 'online');
			const previous = existing === undefined ? undefined : this.endpoints.get(existing.profileId);
			const endpoint = online.find((candidate) => JSON.stringify(candidate.locator) === JSON.stringify(previous?.locator))
				?? (online.length === 1 ? online[0] : undefined);
			if (endpoint === undefined) { continue; }
			let profileId: string | undefined;
			try {
				const entry = existing ?? await this.pin(account, endpoint, validate);
				profileId = entry.profileId;
				const validatePeer = async () => {
					await validate();
					if (!this.permitsOutgoing(entry.profileId)) { throw new ConnectivityError('POLICY_DENIED'); }
				};
				await validatePeer();
				const incoming = this.identity.derive(account, endpoint.accountIdentity!, true);
				await this.pairing.registerAccountPeer(
					incoming.peerId, deviceId, incoming.root, incoming.transcriptHash,
				);
				await validatePeer();
				const profile = await this.ensureProfile(account, entry, endpoint);
				await validatePeer();
				const connection = this.peers.get(profile.id);
				if (connection?.snapshot().state === 'online'
					&& JSON.stringify(this.endpoints.get(profile.id)?.locator) === JSON.stringify(endpoint.locator)) { continue; }
				await this.peers.disconnect(profile.id);
				await this.transport.prepare(profile, endpoint);
				await validatePeer();
				await this.peers.connect(profile.id);
				await validatePeer();
			} catch (error: unknown) {
				if (profileId !== undefined && (signal.aborted || !this.permitsOutgoing(profileId)
					|| this.account.revision() !== revision)) {
					await this.peers.disconnect(profileId);
				}
				if (signal.aborted) { return; }
				this.options.report(error instanceof ConnectivityError ? error.code : 'OFFLINE');
			}
		}
	}

	private async pin(
		account: AccountBinding, endpoint: DiscoveredEndpoint, validate: () => Promise<void>,
	): Promise<AccountPeerEntry> {
		const identity = endpoint.accountIdentity!;
		const incoming = this.identity.derive(account, identity, true);
		const outgoing = this.identity.derive(account, identity, false);
		const prior = (await this.profiles.list()).filter((profile) =>
			profile.workerDeviceId === identity.deviceId && !profile.cleanupPending
			&& profile.peerId !== undefined && profile.credentialKeyRef !== undefined
			&& this.endpoints.get(profile.id)?.accountRef === account.accountRef);
		if (prior.length > 1) { throw new ConnectivityError('BINDING_CHANGED'); }
		if (prior[0] !== undefined && prior[0].generation === undefined) {
			const updated = { ...prior[0], generation: prior[0].id };
			if (!await this.profiles.replace?.(updated, prior[0])) { throw new ConnectivityError('BINDING_CHANGED'); }
			prior[0] = updated;
		}
		const legacyIncomingPeerIds = (await this.records.listPeers()).filter((record) =>
			record.coordinatorDeviceId === identity.deviceId && record.peerId !== incoming.peerId
			&& !record.cleanupPending && !this.options.isRevoked(record.peerId)).map((record) => record.peerId);
		// Revocation follows the device, including an older invitation-based enrollment.
		const revoked = (await this.records.listPeers()).some((record) =>
			record.coordinatorDeviceId === identity.deviceId && this.options.isRevoked(record.peerId));
		const entry: AccountPeerEntry = {
			...identity, accountRef: account.accountRef,
			profileId: prior[0]?.id ?? outgoing.peerId,
			profileGeneration: prior[0]?.generation ?? prior[0]?.id ?? outgoing.peerId,
			incomingPeerId: incoming.peerId, legacyIncomingPeerIds, blocked: revoked,
		};
		await this.document.update((current) => ({ ...current, entries: [...current.entries, entry] }), validate);
		if (revoked) { throw new ConnectivityError('POLICY_DENIED'); }
		return entry;
	}

	private async ensureProfile(
		account: AccountBinding, entry: AccountPeerEntry, endpoint: DiscoveredEndpoint,
	): Promise<PeerProfile> {
		const existing = await this.profiles.get(entry.profileId);
		if (existing !== undefined) {
			if (existing.cleanupPending || existing.workerDeviceId !== entry.deviceId
				|| existing.generation !== entry.profileGeneration || existing.credentialKeyRef === undefined
				|| await this.secrets.get(existing.credentialKeyRef) === undefined) {
				throw new ConnectivityError('BINDING_CHANGED');
			}
			return existing;
		}
		const credential = this.identity.derive(account, endpoint.accountIdentity!, false);
		if (entry.profileId !== credential.peerId) { throw new ConnectivityError('BINDING_CHANGED'); }
		const credentialKeyRef = `mesh.remotePeer.${entry.profileId}`;
		await this.secrets.store(credentialKeyRef, credential.root);
		const profile: PeerProfile = {
			id: entry.profileId, generation: entry.profileGeneration, workerDeviceId: entry.deviceId,
			rpcEndpoint: rpcEndpoint(endpoint.origin), peerId: credential.peerId, credentialKeyRef,
		};
		if (this.profiles.storeIfAbsent === undefined || !await this.profiles.storeIfAbsent(profile)) {
			throw new ConnectivityError('BINDING_CHANGED');
		}
		return profile;
	}
}
