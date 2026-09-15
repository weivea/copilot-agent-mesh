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
	accountDeviceIdentitySchema, ConnectivityError, isTransientDiscoveryError, type AccountBinding, type ConnectivityCode,
} from './ConnectivitySchemas';
import type { DiscoveredEndpoint, DiscoveryAdvertisement } from './DevTunnelDiscoveryProvider';
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
	private readonly peerFailures = new Map<string, ConnectivityCode>();

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
			readonly isDeviceDenied?: (deviceId: string) => boolean;
			readonly report: (code: ConnectivityCode) => void;
			readonly changed?: () => void;
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
				&& this.options.isDeviceDenied?.(entry.deviceId) !== true
				&& (entry.incomingPeerId === peerId || entry.legacyIncomingPeerIds.includes(peerId)));
	}

	public permitsOutgoing(profileId: string): boolean {
		const accountRef = this.account.current()?.accountRef;
		return this.initialized && this.options.enabled()
			&& this.document.snapshot().entries.some((entry) =>
				entry.accountRef === accountRef && entry.profileId === profileId && !entry.blocked
				&& this.options.isDeviceDenied?.(entry.deviceId) !== true
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
		this.clearFailure(entry.deviceId);
		return [entry.incomingPeerId, ...entry.legacyIncomingPeerIds];
	}

	public async disconnectDevice(peerId: string): Promise<void> {
		const entry = this.document.snapshot().entries.find((value) =>
			value.incomingPeerId === peerId || value.legacyIncomingPeerIds.includes(peerId));
		if (entry !== undefined) { await this.peers.disconnect(entry.profileId); }
	}

	public async blockDevice(deviceId: string): Promise<void> {
		this.lifetime.abort();
		this.lifetime = new AbortController();
		await this.document.update((value) => ({
			...value, entries: value.entries.map((entry) => entry.deviceId === deviceId ? { ...entry, blocked: true } : entry),
		}));
		await this.syncing;
		this.clearFailure(deviceId);
	}

	public incomingForProfile(profileId: string): string | undefined {
		return this.initialized ? this.document.snapshot().entries.find((entry) => entry.profileId === profileId)?.incomingPeerId : undefined;
	}

	public entries(): readonly AccountPeerEntry[] {
		return this.initialized ? this.document.snapshot().entries : [];
	}

	public failures(): readonly { deviceId: string; code: ConnectivityCode }[] {
		return [...this.peerFailures].map(([deviceId, code]) => ({ deviceId, code }));
	}

	public clearRecoveredFailures(): void {
		for (const [deviceId, code] of this.peerFailures) {
			if (!isTransientDiscoveryError(code)) { continue; }
			const entry = this.entries().find((candidate) =>
				candidate.deviceId === deviceId && candidate.accountRef === this.account.current()?.accountRef);
			if (entry === undefined || !this.permitsOutgoing(entry.profileId)) { continue; }
			const peer = this.peers.get(entry.profileId);
			const authentication = peer?.authenticatedBinding();
			if (peer?.snapshot().state === 'online' && authentication?.deviceId === deviceId
				&& authentication.profileGeneration === entry.profileGeneration
				&& this.endpoints.get(entry.profileId)?.profileGeneration === entry.profileGeneration) {
				this.clearFailure(deviceId);
			}
		}
	}

	/** Input is exclusively the management SDK's caller-owned list, not discovery hints sent over RPC. */
	public synchronize(endpoints: readonly DiscoveredEndpoint[], advertisements: readonly DiscoveryAdvertisement[] = []): Promise<void> {
		const signal = this.lifetime.signal;
		const account = this.account.current();
		const revision = this.account.revision();
		const operation = this.syncing.then(() => this.synchronizeCore(endpoints, advertisements, signal, account, revision));
		this.syncing = operation.catch(() => undefined);
		return operation;
	}

	public async suspend(): Promise<void> {
		this.lifetime.abort();
		await this.disconnectAll();
		await this.syncing;
		await this.disconnectAll();
		this.lifetime = new AbortController();
		if (this.peerFailures.size > 0) {
			this.peerFailures.clear();
			this.options.changed?.();
		}
	}

	public async disconnectAll(): Promise<void> {
		const results = await Promise.allSettled(this.peers.listConnections().map((connection) => this.peers.disconnect(connection.profileId)));
		if (results.some((result) => result.status === 'rejected')) { throw new ConnectivityError('CLEANUP_FAILED'); }
	}

	private async synchronizeCore(
		endpoints: readonly DiscoveredEndpoint[], advertisements: readonly DiscoveryAdvertisement[],
		signal: AbortSignal, account: AccountBinding | undefined, revision: number,
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
		const groups = new Map<string, { candidates: DiscoveredEndpoint[]; publicKeys: Set<string> }>();
		for (const endpoint of [...advertisements, ...endpoints]) {
			const identity = endpoint.accountIdentity;
			if (identity === undefined || identity.deviceId === this.deviceId || endpoint.admission !== 'private-port-token') { continue; }
			const group = groups.get(identity.deviceId) ?? { candidates: [], publicKeys: new Set<string>() };
			group.publicKeys.add(identity.publicKey);
			if ('locator' in endpoint) { group.candidates.push(endpoint); }
			groups.set(identity.deviceId, group);
		}
		for (const [deviceId, { candidates, publicKeys }] of groups) {
			await validate();
			const existing = this.document.snapshot().entries.find((entry) =>
				entry.accountRef === account.accountRef && entry.deviceId === deviceId);
			if (this.options.isDeviceDenied?.(deviceId) || existing?.blocked || (existing !== undefined && this.options.isRevoked(existing.incomingPeerId))) {
				if (existing !== undefined) { await this.peers.disconnect(existing.profileId); }
				this.clearFailure(deviceId);
				continue;
			}
			if (publicKeys.size !== 1 || (existing !== undefined && !publicKeys.has(existing.publicKey))) {
				if (existing !== undefined) { await this.peers.disconnect(existing.profileId); }
				this.recordFailure(deviceId, 'BINDING_CHANGED');
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
					&& JSON.stringify(this.endpoints.get(profile.id)?.locator) === JSON.stringify(endpoint.locator)) {
					this.clearFailure(deviceId);
					continue;
				}
				await this.peers.disconnect(profile.id);
				await this.transport.prepare(profile, endpoint);
				await validatePeer();
				await this.peers.connect(profile.id);
				await validatePeer();
				this.clearFailure(deviceId);
			} catch (error: unknown) {
				if (profileId !== undefined && (signal.aborted || !this.permitsOutgoing(profileId)
					|| this.account.revision() !== revision)) {
					await this.peers.disconnect(profileId);
				}
				if (signal.aborted) { return; }
				this.recordFailure(deviceId, error instanceof ConnectivityError ? error.code
					: (profileId === undefined ? undefined : this.transport.lastError(profileId)) ?? 'OFFLINE');
			}
		}
	}

	private recordFailure(deviceId: string, code: ConnectivityCode): void {
		if (this.peerFailures.get(deviceId) === code) { return; }
		if (this.peerFailures.size >= 256 && !this.peerFailures.has(deviceId)) {
			const oldest = this.peerFailures.keys().next().value;
			if (oldest !== undefined) { this.peerFailures.delete(oldest); }
		}
		this.peerFailures.set(deviceId, code);
		this.options.report(code);
		this.options.changed?.();
	}

	private clearFailure(deviceId: string): void {
		if (this.peerFailures.delete(deviceId)) { this.options.changed?.(); }
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
