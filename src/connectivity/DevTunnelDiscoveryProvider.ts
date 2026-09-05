import { randomUUID } from 'node:crypto';
import { TunnelConstraints, type Tunnel } from '@microsoft/dev-tunnels-contracts';

import {
	ADVERTISEMENT_PREFIX,
	ConnectivityError,
	DISCOVERY_LABELS,
	PRIVATE_LABEL,
	endpointLocatorSchema,
	type EndpointLocator,
	type PeerAdmission,
	type TunnelResource,
} from './ConnectivitySchemas';
import type { DevTunnelManagement } from './DevTunnelManagement';
import { portOrigin } from './DevTunnelUris';

export interface DiscoveredEndpoint {
	readonly locator: EndpointLocator;
	readonly admission: PeerAdmission;
	readonly origin: string;
	readonly hostHint: 'online' | 'offline' | 'unknown';
}

export class DevTunnelDiscoveryProvider {
	public constructor(private readonly management: DevTunnelManagement) {}

	public async list(signal: AbortSignal): Promise<{
		readonly endpoints: readonly DiscoveredEndpoint[];
		readonly truncated: boolean;
	}> {
		const tunnels = await this.management.run((client, cancellation) =>
			client.listTunnels(undefined, undefined, {
				labels: [...DISCOVERY_LABELS],
				requireAllLabels: true,
				includePorts: true,
				limit: 10,
				followRedirects: false,
			}, cancellation), signal);
		return {
			endpoints: tunnels.slice(0, 10).flatMap((tunnel) => this.project(tunnel)).slice(0, 10),
			// The released SDK discards pagination. Never infer deletion/completeness at the cap.
			truncated: tunnels.length >= 10 || tunnels.reduce((count, tunnel) => count + (tunnel.ports?.length ?? 0), 0) > 10,
		};
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
		if (!DISCOVERY_LABELS.every((label) => tunnel.labels?.includes(label))) {
			return [];
		}
		assertLabels(tunnel.labels!);
		const markers = tunnel.labels!.filter((label) => label.startsWith(ADVERTISEMENT_PREFIX));
		if (markers.length !== 1) {
			throw new ConnectivityError('INVALID_ENDPOINT');
		}
		const hostCount = tunnel.status?.hostConnectionCount;
		const count = typeof hostCount === 'number' ? hostCount : hostCount?.current;
		const hostHint = typeof count !== 'number' || !Number.isFinite(count) || count < 0
			? 'unknown' : count > 0 ? 'online' : 'offline';
		return (tunnel.ports ?? []).filter((port) => port.protocol === 'http' || port.protocol === 'https')
			.map((port) => {
				const parsed = endpointLocatorSchema.safeParse({
					provider: 'dev-tunnels',
					clusterId: tunnel.clusterId,
					tunnelId: tunnel.tunnelId,
					portNumber: port.portNumber,
					advertisementId: markers[0].slice(ADVERTISEMENT_PREFIX.length),
				});
				if (!parsed.success) {
					throw new ConnectivityError('INVALID_ENDPOINT');
				}
				return {
					locator: parsed.data,
					admission: tunnel.labels!.includes(PRIVATE_LABEL) ? 'private-port-token' : 'legacy-mesh-auth',
					origin: portOrigin(port, parsed.data),
					hostHint,
				};
			});
	}
}

export function assertLabels(labels: readonly string[]): void {
	if (labels.length > TunnelConstraints.maxLabels || labels.some((label) =>
		typeof label !== 'string' || label.length < 1 || label.length > TunnelConstraints.labelMaxLength
		|| /[\p{C}]/u.test(label))) {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
}
