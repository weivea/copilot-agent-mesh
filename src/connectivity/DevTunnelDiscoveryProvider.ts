import { randomUUID } from 'node:crypto';
import { TunnelConstraints, type Tunnel } from '@microsoft/dev-tunnels-contracts';

import {
	ADVERTISEMENT_PREFIX,
	ACCOUNT_IDENTITY_PREFIX,
	accountDeviceIdentitySchema,
	ConnectivityError,
	DISCOVERY_LABELS,
	PRIVATE_LABEL,
	endpointLocatorSchema,
	type EndpointLocator,
	type PeerAdmission,
	type TunnelResource,
	type AccountDeviceIdentity,
	type ConnectivityDiagnosticsReporter,
} from './ConnectivitySchemas';
import { readAccountPublicKey } from './AccountDeviceIdentity';
import type { DevTunnelManagement } from './DevTunnelManagement';
import { portOrigin } from './DevTunnelUris';

export interface DiscoveredEndpoint {
	readonly locator: EndpointLocator;
	readonly admission: PeerAdmission;
	readonly origin: string;
	readonly hostHint: 'online' | 'offline' | 'unknown';
	readonly accountIdentity?: AccountDeviceIdentity;
}

const advertisementSchema = endpointLocatorSchema.omit({ provider: true, portNumber: true });

interface DiscoveryAdvertisement {
	readonly resource: TunnelResource;
	readonly advertisementId: string;
	readonly admission: PeerAdmission;
	readonly accountIdentity?: AccountDeviceIdentity;
}

export class DevTunnelDiscoveryProvider {
	public constructor(
		private readonly management: DevTunnelManagement,
		private readonly diagnostics?: ConnectivityDiagnosticsReporter,
	) {}

	public async list(signal: AbortSignal): Promise<{
		readonly endpoints: readonly DiscoveredEndpoint[];
		readonly truncated: boolean;
	}> {
		// Listing and detail reads share one management timeout, cancellation and concurrency slot.
		return this.management.run(async (client, cancellation) => {
			const tunnels = await client.listTunnels(undefined, undefined, {
				labels: [...DISCOVERY_LABELS],
				requireAllLabels: true,
				includePorts: true,
				limit: 10,
				followRedirects: false,
			}, cancellation);
			this.diagnostics?.('Tunnel discovery SDK result.', {
				tunnelCount: tunnels.length,
				tunnels: tunnels.slice(0, 10).map((tunnel) => ({
					tunnelMarker: tunnel.tunnelId?.slice(0, 12),
					clusterMarker: tunnel.clusterId?.slice(0, 8),
					missingLabels: DISCOVERY_LABELS.filter((label) => !tunnel.labels?.includes(label)),
					advertisementCount: tunnel.labels?.filter((label) => label.startsWith(ADVERTISEMENT_PREFIX)).length ?? 0,
					privateAdmission: tunnel.labels?.includes(PRIVATE_LABEL) ?? false,
					hasAccountIdentity: tunnel.description?.startsWith(ACCOUNT_IDENTITY_PREFIX) ?? false,
					portCount: tunnel.ports?.length ?? 0,
					httpPortCount: tunnel.ports?.filter((port) => port.protocol === 'http' || port.protocol === 'https').length ?? 0,
					hostHint: readHostHint(tunnel),
				})),
			});
			const endpoints: DiscoveredEndpoint[] = [];
			let portCount = tunnels.reduce((count, tunnel) => count + (tunnel.ports?.length ?? 0), 0);
			for (const summary of tunnels.slice(0, 10)) {
				if (signal.aborted || cancellation.isCancellationRequested) {
					throw new ConnectivityError('CANCELLED');
				}
				let tunnel = summary;
				if (!summary.ports?.length || summary.ports.some((port) => port.protocol === undefined
					|| ((port.protocol === 'http' || port.protocol === 'https') && !port.portForwardingUris?.length))) {
					const advertised = readAdvertisement(summary);
					if (advertised === undefined) { continue; }
					// Only an exact member of the caller-owned list may supply discovery details.
					const detail = await client.getTunnel(advertised.resource,
						{ includePorts: true, followRedirects: false }, cancellation);
					if (detail === null) { throw new ConnectivityError('OFFLINE'); }
					const current = readAdvertisement(detail);
					if (current === undefined
						|| current.resource.clusterId !== advertised.resource.clusterId
						|| current.resource.tunnelId !== advertised.resource.tunnelId
						|| current.advertisementId !== advertised.advertisementId
						|| current.admission !== advertised.admission
						|| current.accountIdentity?.deviceId !== advertised.accountIdentity?.deviceId
						|| current.accountIdentity?.publicKey !== advertised.accountIdentity?.publicKey) {
						throw new ConnectivityError('BINDING_CHANGED');
					}
					portCount += (detail.ports?.length ?? 0) - (summary.ports?.length ?? 0);
					tunnel = detail;
					this.diagnostics?.('Tunnel discovery detail resolved.', {
						tunnelMarker: detail.tunnelId?.slice(0, 12),
						clusterMarker: detail.clusterId?.slice(0, 8),
						portCount: detail.ports?.length ?? 0,
						hostHint: readHostHint(detail),
					});
				}
				endpoints.push(...this.project(tunnel));
			}
			const result = {
				endpoints: endpoints.slice(0, 10),
				// The released SDK discards pagination. Never infer deletion/completeness at the cap.
				truncated: tunnels.length >= 10 || portCount > 10,
			};
			this.diagnostics?.('Tunnel discovery projected endpoints.', {
				endpointCount: result.endpoints.length,
				truncated: result.truncated,
				endpoints: result.endpoints.map((endpoint) => ({
					advertisementMarker: endpoint.locator.advertisementId.slice(0, 8),
					deviceMarker: endpoint.accountIdentity?.deviceId.slice(0, 8),
					admission: endpoint.admission,
					hostHint: endpoint.hostHint,
				})),
			});
			return result;
		}, signal);
	}

	public async publish(
		resource: TunnelResource,
		portNumber: number,
		ownershipLabel: string,
		advertisementId: string,
		signal: AbortSignal,
		persistAdvertisement: (id: string) => Promise<void>,
	): Promise<string> {
		return this.management.run(async (client, cancellation) => {
			// A successful GET can be a shared resource. Only the caller-owned list proves D1 account alignment.
			const owned = await client.listTunnels(resource.clusterId, undefined, {
				labels: [ownershipLabel], requireAllLabels: true, limit: 10, includePorts: true,
				followRedirects: false,
			}, cancellation);
			if (!owned.some((tunnel) => tunnel.clusterId === resource.clusterId && tunnel.tunnelId === resource.tunnelId)) {
				throw new ConnectivityError('ACCOUNT_CHANGED');
			}
			const tunnel = await client.getTunnel(resource, { includePorts: true, followRedirects: false }, cancellation);
			if (tunnel === null || !tunnel.labels?.includes(ownershipLabel)
				|| !tunnel.ports?.some((port) => port.portNumber === portNumber)) {
				throw new ConnectivityError('BINDING_CHANGED');
			}
			const advertised = tunnel.labels.some((label) => label.startsWith(ADVERTISEMENT_PREFIX));
			const actualAdvertisement = advertised ? advertisementId : randomUUID();
			// A recreated CLI resource may reuse its alias. A fresh advertisement prevents silent rebinding.
			if (actualAdvertisement !== advertisementId) {
				await persistAdvertisement(actualAdvertisement);
			}
			const labels = [...new Set([
				...tunnel.labels.filter((label) => !label.startsWith(ADVERTISEMENT_PREFIX)),
				...DISCOVERY_LABELS,
				`${ADVERTISEMENT_PREFIX}${actualAdvertisement}`,
			])];
			assertLabels(labels);
			// Preserve non-Mesh fields; no caller tokens or Workspace metadata enter this document.
			await client.updateTunnel({ ...tunnel, labels }, { followRedirects: false }, cancellation);
			return actualAdvertisement;
		}, signal);
	}

	public project(tunnel: Tunnel): readonly DiscoveredEndpoint[] {
		const advertised = readAdvertisement(tunnel);
		if (advertised === undefined) { return []; }
		const hostHint = readHostHint(tunnel);
		return (tunnel.ports ?? []).filter((port) => port.protocol === 'http' || port.protocol === 'https')
			.map((port) => {
				const parsed = endpointLocatorSchema.safeParse({
					provider: 'dev-tunnels',
					...advertised.resource,
					portNumber: port.portNumber,
					advertisementId: advertised.advertisementId,
				});
				if (!parsed.success) {
					throw new ConnectivityError('INVALID_ENDPOINT');
				}
				return {
					locator: parsed.data,
					admission: advertised.admission,
					origin: portOrigin(port, parsed.data),
					hostHint,
					...(advertised.accountIdentity === undefined ? {} : { accountIdentity: advertised.accountIdentity }),
				};
			});
	}
}

function readAdvertisement(tunnel: Tunnel): DiscoveryAdvertisement | undefined {
	if (!DISCOVERY_LABELS.every((label) => tunnel.labels?.includes(label))) { return undefined; }
	assertLabels(tunnel.labels!);
	const markers = tunnel.labels!.filter((label) => label.startsWith(ADVERTISEMENT_PREFIX));
	if (markers.length !== 1) { throw new ConnectivityError('INVALID_ENDPOINT'); }
	const parsed = advertisementSchema.safeParse({
		clusterId: tunnel.clusterId, tunnelId: tunnel.tunnelId,
		advertisementId: markers[0].slice(ADVERTISEMENT_PREFIX.length),
	});
	if (!parsed.success) { throw new ConnectivityError('INVALID_ENDPOINT'); }
	const accountIdentity = readAdvertisedIdentity(tunnel);
	return {
		resource: { clusterId: parsed.data.clusterId, tunnelId: parsed.data.tunnelId },
		advertisementId: parsed.data.advertisementId,
		admission: tunnel.labels!.includes(PRIVATE_LABEL) ? 'private-port-token' : 'legacy-mesh-auth',
		...(accountIdentity === undefined ? {} : { accountIdentity }),
	};
}

function readHostHint(tunnel: Tunnel): DiscoveredEndpoint['hostHint'] {
	const hostCount = tunnel.status?.hostConnectionCount;
	const count = typeof hostCount === 'number' ? hostCount : hostCount?.current;
	return typeof count !== 'number' || !Number.isFinite(count) || count < 0
		? 'unknown' : count > 0 ? 'online' : 'offline';
}

function readAdvertisedIdentity(tunnel: Tunnel): AccountDeviceIdentity | undefined {
	if (!tunnel.description?.startsWith(ACCOUNT_IDENTITY_PREFIX)) { return undefined; }
	if (!tunnel.labels?.includes(PRIVATE_LABEL) || tunnel.description.length > 512) {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
	try {
		const identity = accountDeviceIdentitySchema.parse(JSON.parse(tunnel.description.slice(ACCOUNT_IDENTITY_PREFIX.length)));
		readAccountPublicKey(identity.publicKey);
		return identity;
	} catch {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
}

export function assertLabels(labels: readonly string[]): void {
	if (labels.length > TunnelConstraints.maxLabels || labels.some((label) =>
		typeof label !== 'string' || label.length < 1 || label.length > TunnelConstraints.labelMaxLength
		|| /[\p{C}]/u.test(label))) {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
}
