import { randomUUID } from 'node:crypto';

import type { TunnelRelayTunnelHost } from '@microsoft/dev-tunnels-connections';
import { TunnelAccessScopes, TunnelAccessControlEntryType, type Tunnel } from '@microsoft/dev-tunnels-contracts';
import { TunnelAccessTokenProperties, type TunnelManagementHttpClient } from '@microsoft/dev-tunnels-management';
import { z } from 'zod';
import { isAxiosError, type AxiosAdapter } from 'axios';

import { uuidSchema } from '../../shared/protocol';
import type { AccountSessionProvider } from '../connectivity/AccountSessionProvider';
import {
	ADVERTISEMENT_PREFIX, ConnectivityError, DISCOVERY_LABELS, PRIVATE_LABEL,
	tunnelResourceSchema, type EndpointLocator,
} from '../connectivity/ConnectivitySchemas';
import { ConnectivityOperation } from '../connectivity/ConnectivityOperations';
import { portCapability, validateCapability } from '../connectivity/DevTunnelEndpointResolver';
import { createTunnelManagementClient, type DevTunnelManagement, guardedTunnelHttpAdapter, normalizeConnectivityError } from '../connectivity/DevTunnelManagement';
import { portOrigin } from '../connectivity/DevTunnelUris';
import type { AtomicFileStore } from '../storage/AtomicFileStore';
import { assertDocumentFence, FencedDocumentStore, type DocumentFence } from '../storage/FencedDocumentStore';
import { MESH_READINESS_REQUEST, MESH_READINESS_RESPONSE } from './CliDevTunnelExposureAdapter';
import { probeDevTunnelHealth, probeDevTunnelWss } from './DevTunnelReadyProbe';
import type { RemoteExposure, RemoteExposureProvider, RemoteExposureStatus } from './RemoteExposureProvider';
import { SdkRelayStreamFactory } from './SdkRelayStreamFactory';
import { sdkHostRequestAdapter } from './SdkHostRequestAdapter';

const endpointIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9-]+$/u);
const ownedSchema = z.strictObject({
	resource: tunnelResourceSchema,
	accountRef: uuidSchema,
	advertisementId: uuidSchema,
	ownershipId: uuidSchema,
	localPort: z.number().int().min(1).max(65535),
	phase: z.enum(['creating', 'stopped', 'hosting', 'cleanupPending']),
	endpointId: endpointIdSchema.optional(),
});
const ledgerSchema = z.strictObject({
	schemaVersion: z.literal(1),
	revision: z.number().int().nonnegative(),
	owned: ownedSchema.optional(),
});
type OwnedSdkTunnel = z.infer<typeof ownedSchema>;

export type SdkTunnelHost = Pick<TunnelRelayTunnelHost,
	'connect' | 'dispose' | 'streamFactory' | 'forwardConnectionsToLocalPorts' | 'tunnel'
	| 'connectionStatusChanged' | 'refreshingTunnelAccessToken' | 'refreshingTunnel'
>;

export class SdkDevTunnelExposureProvider implements RemoteExposureProvider {
	public readonly providerId = 'sdk';
	private readonly ledger: FencedDocumentStore<z.infer<typeof ledgerSchema>>;
	private initialized = false;
	private disposed = false;
	private host: SdkTunnelHost | undefined;
	private hostClient: TunnelManagementHttpClient | undefined;
	private hostTunnel: Tunnel | undefined;
	private endpointId: string | undefined;
	private endpointRemoved = false;
	private lifetime = new AbortController();
	private timer: NodeJS.Timeout | undefined;
	private operation: Promise<void> = Promise.resolve();
	private status: RemoteExposureStatus = { state: 'stopped' };
	private readonly listeners = new Set<() => void>();
	private subscriptions: { dispose(): void }[] = [];

	public constructor(
		files: AtomicFileStore,
		private readonly fence: DocumentFence,
		private readonly management: DevTunnelManagement,
		private readonly account: AccountSessionProvider,
		private readonly options: {
			readonly enabled: () => boolean;
			readonly advertisementId: () => string | undefined;
			readonly hostFactory?: (client: TunnelManagementHttpClient) => SdkTunnelHost;
			readonly hostAdapter?: AxiosAdapter;
			readonly probe?: (origin: string, capability: string, signal: AbortSignal) => Promise<void>;
		},
	) {
		this.ledger = new FencedDocumentStore(files, 'connectivity/sdk-hosting.json', ledgerSchema, {
			schemaVersion: 1, revision: 0,
		}, fence);
	}

	public async initialize(): Promise<void> {
		await this.ledger.initialize();
		this.initialized = true;
	}

	public async probe(): Promise<{ supported: boolean; reason?: string }> {
		await this.assertEnabled();
		const operation = new ConnectivityOperation(10_000);
		try {
			await this.account.authorization(operation.controller.signal);
			return { supported: true };
		} finally { operation.dispose(); }
	}

	public start(request: { readonly localPort: number; readonly deviceId: string }): Promise<RemoteExposure> {
		return this.serialize(() => this.startCore(request.localPort));
	}

	public cancel(): void { this.lifetime.abort(); }

	public stop(): Promise<void> {
		this.cancel();
		return this.serialize(() => this.stopCore());
	}

	public async dispose(): Promise<void> {
		await this.stop();
		this.disposed = true;
		this.listeners.clear();
	}

	public getStatus(): RemoteExposureStatus { return structuredClone(this.status); }
	public onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	public ownedResource(): OwnedSdkTunnel | undefined {
		return this.initialized ? this.ledger.snapshot().owned : undefined;
	}

	public retryCleanup(): Promise<void> {
		this.cancel();
		return this.serialize(async () => {
			const owned = this.ledger.snapshot().owned;
			if (owned !== undefined) {
				const tunnel = await this.refreshHostTunnel(owned, new AbortController().signal);
				if (this.host !== undefined && this.host.tunnel !== null) {
					this.host.tunnel.accessTokens = { [TunnelAccessScopes.Host]: tunnel.accessTokens![TunnelAccessScopes.Host] };
					if (this.hostTunnel !== undefined) { this.hostTunnel.accessTokens = this.host.tunnel.accessTokens; }
				} else if (owned.phase === 'hosting' || owned.phase === 'cleanupPending') {
					const count = tunnel.status?.hostConnectionCount;
					if ((typeof count === 'number' ? count : count?.current) !== 0) {
						throw new ConnectivityError('CLEANUP_FAILED');
					}
					if (owned.endpointId !== undefined) {
						await this.management.run((client, token) => client.deleteTunnelEndpoints(
							owned.resource, owned.endpointId!, { followRedirects: false }, token,
						));
					}
					await this.ledger.update((current) => ({
						...current, owned: { ...owned, phase: 'stopped', endpointId: undefined },
					}));
				}
			}
			await this.stopCore();
		});
	}

	/** An explicit, exact-resource cleanup action; never delete by name, prefix, or labels. */
	public async deleteOwnedResource(): Promise<void> {
		await this.stop();
		await this.serialize(async () => {
			const owned = this.ledger.snapshot().owned;
			if (owned === undefined) { return; }
			await this.assertAccount(owned);
			await this.management.run(async (client, cancellation) => {
				const read = async () => {
					try {
						return await client.getTunnel(owned.resource, { includePorts: true, followRedirects: false }, cancellation);
					} catch (error: unknown) {
						if (isAxiosError(error) && error.response?.status === 404) { return null; }
						throw error;
					}
				};
				const tunnel = await read();
				if (tunnel !== null) {
					assertOwnedPrivate(tunnel, owned);
					await client.deleteTunnel(owned.resource, { followRedirects: false }, cancellation);
					if (await read() !== null) {
						throw new ConnectivityError('CLEANUP_FAILED');
					}
				}
			});
			await this.ledger.update((current) => ({ schemaVersion: 1, revision: current.revision }));
		});
	}

	public renew(): Promise<void> {
		return this.serialize(async () => {
			try {
				const owned = this.ledger.snapshot().owned;
				if (owned === undefined || this.host === undefined || this.lifetime.signal.aborted) {
					throw new ConnectivityError('OFFLINE');
				}
				await this.assertEnabled();
				const tunnel = await this.refreshHostTunnel(owned);
				const token = tunnel.accessTokens![TunnelAccessScopes.Host];
				if (this.host.tunnel !== null) {
					this.host.tunnel.accessTokens = { [TunnelAccessScopes.Host]: token };
					if (this.hostTunnel !== undefined) { this.hostTunnel.accessTokens = this.host.tunnel.accessTokens; }
				}
				this.scheduleRenewal(token);
			} catch (error: unknown) {
				await this.failClosed(error);
				throw normalizeConnectivityError(error);
			}
		});
	}

	private async startCore(localPort: number): Promise<RemoteExposure> {
		await this.assertEnabled();
		if (this.status.state === 'ready') {
			if (this.status.tunnel.localPort !== localPort) { throw new ConnectivityError('MIGRATION_REQUIRED'); }
			return this.status.tunnel;
		}
		if (this.host !== undefined) { throw new ConnectivityError('CLEANUP_FAILED'); }
		this.lifetime = new AbortController();
		const operation = new ConnectivityOperation(30_000, this.lifetime.signal);
		const cancel = (): void => this.cancel();
		operation.controller.signal.addEventListener('abort', cancel, { once: true });
		this.setStatus({ state: 'starting' });
		try {
			let owned = this.ledger.snapshot().owned;
			let tunnel: Tunnel;
			if (owned === undefined) {
				const accountRef = this.account.current()?.accountRef;
				const advertisementId = this.options.advertisementId();
				if (accountRef === undefined || advertisementId === undefined) { throw new ConnectivityError('AUTH_REQUIRED'); }
				const recommendations = await this.management.run(
					(client, token) => client.getClusterRecommendations(undefined, undefined, token),
					operation.controller.signal,
				);
				owned = ownedSchema.parse({
					resource: {
						clusterId: recommendations.recommendedClusterId,
						tunnelId: `cam-${randomUUID().replaceAll('-', '')}`,
					},
					accountRef, advertisementId, ownershipId: randomUUID(), localPort, phase: 'creating',
				});
				// Persist the exact chosen ID before the create request, including ambiguous timeout recovery.
				await this.ledger.update((current) => ({ ...current, owned }));
				const labels = [...DISCOVERY_LABELS, PRIVATE_LABEL,
					`${ADVERTISEMENT_PREFIX}${owned.advertisementId}`, ownershipLabel(owned)];
				tunnel = await this.management.run((client, token) => client.createTunnel({
					...owned!.resource, labels, customExpiration: 3600,
					accessControl: { entries: [] },
					ports: [{ portNumber: localPort, protocol: 'http', accessControl: { entries: [] } }],
				}, { includePorts: true, tokenScopes: [TunnelAccessScopes.Host], followRedirects: false }, token), operation.controller.signal);
			} else {
				await this.assertAccount(owned);
				if (owned.localPort !== localPort || owned.advertisementId !== this.options.advertisementId()) {
					throw new ConnectivityError('MIGRATION_REQUIRED');
				}
				tunnel = await this.refreshHostTunnel(owned, operation.controller.signal);
				const count = tunnel.status?.hostConnectionCount;
				const hosts = typeof count === 'number' ? count : count?.current;
				if (hosts !== 0) { throw new ConnectivityError('CLEANUP_FAILED'); }
			}
			assertOwnedPrivate(tunnel, owned);
			const hostCapability = tunnel.accessTokens?.[TunnelAccessScopes.Host];
			validateCapability(hostCapability);
			await this.assertAccount(owned);
			operation.assertActive();
			if (owned.endpointId !== undefined) {
				const previous = owned;
				await this.management.run((client, token) => client.deleteTunnelEndpoints(
					previous.resource, previous.endpointId!, { accessToken: hostCapability, followRedirects: false }, token,
				), operation.controller.signal);
				owned = { ...owned, phase: 'stopped', endpointId: undefined };
				await this.ledger.update((current) => ({ ...current, owned }));
			}
			const currentOwned = owned;
			this.hostTunnel = { ...tunnel, accessTokens: { [TunnelAccessScopes.Host]: hostCapability } };
			this.endpointId = undefined;
			this.endpointRemoved = false;
			this.hostClient = createTunnelManagementClient(undefined, sdkHostRequestAdapter(
				this.options.hostAdapter ?? guardedTunnelHttpAdapter,
				this.lifetime.signal,
				(uri) => this.endpointId !== undefined
					&& uri.pathname === `/tunnels/${currentOwned.resource.tunnelId}/endpoints/${this.endpointId}`,
			));
			const updateEndpoint = this.hostClient.updateTunnelEndpoint.bind(this.hostClient);
			const deleteEndpoint = this.hostClient.deleteTunnelEndpoints.bind(this.hostClient);
			this.hostClient.deleteTunnelEndpoints = async (reference, id, options, cancellation) => {
				if (reference.tunnelId !== currentOwned.resource.tunnelId || reference.clusterId !== currentOwned.resource.clusterId
					|| id !== this.endpointId) { throw new ConnectivityError('BINDING_CHANGED'); }
				const result = await deleteEndpoint(reference, id, options, cancellation);
				this.endpointRemoved = true;
				return result;
			};
			this.hostClient.updateTunnelEndpoint = async (reference, endpoint, options, cancellation) => {
				operation.assertActive();
				await this.assertAccount(currentOwned);
				if (reference.tunnelId !== currentOwned.resource.tunnelId || reference.clusterId !== currentOwned.resource.clusterId) {
					throw new ConnectivityError('BINDING_CHANGED');
				}
				this.endpointId = endpointIdSchema.parse(endpoint.id);
				await this.ledger.update((current) => ({
					...current, owned: { ...currentOwned, phase: 'hosting', endpointId: this.endpointId },
				}));
				operation.assertActive();
				const result = await updateEndpoint(reference, endpoint, options, cancellation);
				await this.assertAccount(currentOwned);
				return result;
			};
			await this.ledger.update((current) => ({ ...current, owned: { ...currentOwned, phase: 'hosting' } }));
			const host = this.options.hostFactory?.(this.hostClient)
				?? new (await import('@microsoft/dev-tunnels-connections')).TunnelRelayTunnelHost(this.hostClient, () => undefined);
			this.host = host;
			host.forwardConnectionsToLocalPorts = true;
			host.streamFactory = new SdkRelayStreamFactory(this.lifetime.signal);
			this.subscriptions = [
				host.refreshingTunnelAccessToken((event) => {
					event.tunnelAccessToken = this.refreshHostTunnel(currentOwned)
						.then((updated) => updated.accessTokens![TunnelAccessScopes.Host]);
				}),
				host.refreshingTunnel((event) => {
					event.tunnelPromise = this.refreshHostTunnel(currentOwned);
				}),
				host.connectionStatusChanged((event) => {
					if (event.status === 'disconnected' && this.status.state === 'ready') {
						this.cancel();
						void this.serialize(() => this.failClosed(new ConnectivityError('OFFLINE')));
					}
				}),
			];
			await host.connect(this.hostTunnel,
				{ enableRetry: false, enableReconnect: false, keepAliveIntervalInSeconds: 20 }, operation.cancellation.token);
			await this.assertAccount(currentOwned);
			operation.assertActive();
			const locator: EndpointLocator = {
				provider: 'dev-tunnels', ...currentOwned.resource,
				portNumber: localPort, advertisementId: currentOwned.advertisementId,
			};
			const port = await this.management.run((client, token) => client.getTunnelPort(currentOwned.resource, localPort, {
				tokenScopes: [TunnelAccessScopes.Connect], followRedirects: false,
			}, token), operation.controller.signal);
			const capability = portCapability(port, locator);
			const origin = portOrigin(port!, locator);
			await (this.options.probe ?? privateReadyProbe)(origin, capability, operation.controller.signal);
			operation.assertActive();
			await this.assertAccount(currentOwned);
			const exposure: RemoteExposure = {
				provider: 'sdk', admission: 'private-port-token', localPort, forwardingOrigin: origin,
				resource: currentOwned.resource, locator, ownershipLabel: ownershipLabel(currentOwned),
			};
			this.setStatus({ state: 'ready', tunnel: exposure });
			this.scheduleRenewal(hostCapability);
			return exposure;
		} catch (error: unknown) {
			const failure = operation.cancellationError ?? normalizeConnectivityError(error);
			await this.failClosed(failure);
			throw failure;
		} finally {
			operation.controller.signal.removeEventListener('abort', cancel);
			operation.dispose();
		}
	}

	private async refreshHostTunnel(owned: OwnedSdkTunnel, signal = this.lifetime.signal): Promise<Tunnel> {
		await this.assertAccount(owned);
		const tunnel = await this.management.run((client, token) => client.getTunnel(owned.resource, {
			includePorts: true, tokenScopes: [TunnelAccessScopes.Host], followRedirects: false,
		}, token), signal);
		if (tunnel === null) { throw new ConnectivityError('BINDING_CHANGED'); }
		assertOwnedPrivate(tunnel, owned);
		validateCapability(tunnel.accessTokens?.[TunnelAccessScopes.Host]);
		await this.assertAccount(owned);
		return tunnel;
	}

	private async stopCore(): Promise<void> {
		this.cancel();
		if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
		for (const subscription of this.subscriptions.splice(0)) { subscription.dispose(); }
		const ownedHost = this.host !== undefined || this.hostTunnel !== undefined;
		try {
			await this.host?.dispose();
			if (this.endpointId !== undefined && !this.endpointRemoved && this.hostClient !== undefined && this.hostTunnel !== undefined) {
				await this.hostClient.deleteTunnelEndpoints(this.hostTunnel, this.endpointId, { followRedirects: false });
			}
			this.host = undefined;
			this.hostTunnel = undefined;
			this.endpointId = undefined;
			await this.hostClient?.dispose();
			this.hostClient = undefined;
			if (ownedHost && this.initialized && this.ledger.snapshot().owned !== undefined
				&& this.fence.ownership.isOwner() && this.fence.ownership.currentGeneration() === this.fence.generation) {
				await this.ledger.update((current) => ({
					...current, owned: { ...current.owned!, phase: 'stopped', endpointId: undefined },
				}));
			}
			this.setStatus({ state: 'stopped' });
		} catch {
			this.setStatus({ state: 'cleanup-failed', message: 'The private SDK host requires exact-resource cleanup retry.' });
			throw new ConnectivityError('CLEANUP_FAILED');
		}
	}

	private async failClosed(error: unknown): Promise<void> {
		try { await this.stopCore(); } catch { return; }
		const normalized = normalizeConnectivityError(error);
		this.setStatus({ state: 'circuit-open', code: normalized.code, message: normalized.message });
	}

	private scheduleRenewal(token: string): void {
		if (this.timer !== undefined) { clearTimeout(this.timer); }
		const expiration = TunnelAccessTokenProperties.tryParse(token)?.expiration?.getTime();
		if (expiration === undefined) { throw new ConnectivityError('PRIVATE_ACCESS_REQUIRED'); }
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.renew().catch(() => { /* renew already records failure and closes the private host */ });
		}, Math.max(1000, Math.min(expiration - Date.now() - 300_000, 60 * 60_000)));
		this.timer.unref();
	}

	private async assertAccount(owned: OwnedSdkTunnel): Promise<void> {
		await assertDocumentFence(this.fence);
		if (this.account.current()?.accountRef !== owned.accountRef) {
			throw new ConnectivityError('ACCOUNT_CHANGED');
		}
	}
	private async assertEnabled(): Promise<void> {
		await assertDocumentFence(this.fence);
		if (this.disposed || !this.initialized || !this.options.enabled()) {
			throw new ConnectivityError('DISABLED');
		}
	}
	private setStatus(status: RemoteExposureStatus): void {
		this.status = status;
		for (const listener of this.listeners) { listener(); }
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operation.then(operation, operation);
		this.operation = result.then(() => undefined, () => undefined);
		return result;
	}
}

function ownershipLabel(owned: OwnedSdkTunnel): string { return `mesh-owned-${owned.ownershipId}`; }

export function assertOwnedPrivate(tunnel: Tunnel, owned: OwnedSdkTunnel): void {
	if (tunnel.clusterId !== owned.resource.clusterId || tunnel.tunnelId !== owned.resource.tunnelId
		|| ![...DISCOVERY_LABELS, PRIVATE_LABEL, ownershipLabel(owned), `${ADVERTISEMENT_PREFIX}${owned.advertisementId}`]
			.every((label) => tunnel.labels?.includes(label))
		|| tunnel.ports?.length !== 1 || tunnel.ports[0].portNumber !== owned.localPort
		|| tunnel.ports[0].protocol !== 'http') {
		throw new ConnectivityError('BINDING_CHANGED');
	}
	if ([...(tunnel.accessControl?.entries ?? []), ...(tunnel.ports[0].accessControl?.entries ?? [])]
		.some((entry) => entry.type === TunnelAccessControlEntryType.Anonymous)) {
		throw new ConnectivityError('PRIVATE_ACCESS_REQUIRED');
	}
}

async function privateReadyProbe(origin: string, capability: string, signal: AbortSignal): Promise<void> {
	const options = { signal, timeoutMs: 8000, tunnelAccessToken: capability };
	await probeDevTunnelHealth(origin, '/healthz', options);
	await probeDevTunnelWss(origin, '/agent-mesh/rpc', MESH_READINESS_REQUEST, MESH_READINESS_RESPONSE, options);
}
