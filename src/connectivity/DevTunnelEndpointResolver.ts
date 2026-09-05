import { TunnelAccessScopes, type TunnelPort } from '@microsoft/dev-tunnels-contracts';
import { TunnelAccessTokenProperties } from '@microsoft/dev-tunnels-management';

import {
	ADVERTISEMENT_PREFIX, ConnectivityError, DISCOVERY_LABELS, PRIVATE_LABEL,
	type EndpointLocator, type PeerAdmission,
} from './ConnectivitySchemas';
import type { DevTunnelManagement } from './DevTunnelManagement';
import { portOrigin } from './DevTunnelUris';

export class DevTunnelEndpointResolver {
	public constructor(private readonly management: DevTunnelManagement) {}

	public async resolve(locator: EndpointLocator, admission: PeerAdmission, signal: AbortSignal): Promise<string> {
		return this.management.run(async (client, cancellation) => {
			const tunnel = await client.getTunnel({
				clusterId: locator.clusterId, tunnelId: locator.tunnelId,
			}, { includePorts: true, followRedirects: false }, cancellation);
			if (tunnel === null) {
				throw new ConnectivityError('OFFLINE');
			}
			if (tunnel.clusterId !== locator.clusterId || tunnel.tunnelId !== locator.tunnelId
				|| !DISCOVERY_LABELS.every((label) => tunnel.labels?.includes(label))
				|| tunnel.labels?.filter((label) => label.startsWith(ADVERTISEMENT_PREFIX)).length !== 1
				|| !tunnel.labels.includes(`${ADVERTISEMENT_PREFIX}${locator.advertisementId}`)
				|| tunnel.labels.includes(PRIVATE_LABEL) !== (admission === 'private-port-token')) {
				throw new ConnectivityError('BINDING_CHANGED');
			}
			const port = tunnel.ports?.find((value) => value.portNumber === locator.portNumber);
			if (port === undefined) {
				throw new ConnectivityError('OFFLINE');
			}
			return portOrigin(port, locator);
		}, signal);
	}

	public async connectCapability(locator: EndpointLocator, signal: AbortSignal): Promise<string> {
		const port = await this.management.run((client, cancellation) =>
			client.getTunnelPort({ clusterId: locator.clusterId, tunnelId: locator.tunnelId }, locator.portNumber, {
				tokenScopes: [TunnelAccessScopes.Connect], followRedirects: false,
			}, cancellation), signal);
		return portCapability(port, locator);
	}
}

export function portCapability(port: TunnelPort | null, locator: EndpointLocator): string {
	if (port === null || port.portNumber !== locator.portNumber
		|| (port.tunnelId !== undefined && port.tunnelId !== locator.tunnelId)
		|| (port.clusterId !== undefined && port.clusterId !== locator.clusterId)) {
		throw new ConnectivityError('PRIVATE_ACCESS_REQUIRED');
	}
	const token = port.accessTokens?.[TunnelAccessScopes.Connect];
	validateCapability(token);
	return token;
}

export function validateCapability(token: unknown): asserts token is string {
	if (typeof token !== 'string' || token.length === 0 || token.length > 16_384 || /[\s]/u.test(token)) {
		throw new ConnectivityError('PRIVATE_ACCESS_REQUIRED');
	}
	// Claims other than expiration are service diagnostics, not an application authorization API.
	// Exact scope/port comes from the authenticated getTunnelPort request; the service verifies the token.
	const expiry = TunnelAccessTokenProperties.tryParse(token)?.expiration?.getTime();
	if (expiry === undefined || !Number.isFinite(expiry) || expiry < Date.now() + 60_000) {
		throw new ConnectivityError('PRIVATE_ACCESS_REQUIRED');
	}
}
