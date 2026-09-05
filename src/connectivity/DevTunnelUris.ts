import { TunnelConstraints, type TunnelPort } from '@microsoft/dev-tunnels-contracts';

import { ConnectivityError, type EndpointLocator } from './ConnectivitySchemas';

export function validateManagementUri(input: string): URL {
	const uri = parseUri(input);
	const suffix = '.rel.tunnels.api.visualstudio.com';
	const cluster = uri.hostname.slice(0, -suffix.length);
	if (uri.protocol !== 'https:' || !uri.hostname.endsWith(suffix)
		|| (cluster !== 'global' && !TunnelConstraints.clusterIdRegex.test(cluster))
		|| uri.port !== '' || uri.username !== '' || uri.password !== '' || uri.hash !== '') {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
	return uri;
}

export function validateForwardingOrigin(input: string, portNumber?: number): string {
	const uri = parseUri(input);
	const labels = uri.hostname.split('.');
	if (!['https:', 'wss:'].includes(uri.protocol)
		|| !uri.hostname.endsWith('.devtunnels.ms')
		|| labels.length < 3 || labels.length > 4
		|| (labels.length === 4 && !TunnelConstraints.clusterIdRegex.test(labels[1]))
		|| !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(labels[0])
		|| (portNumber !== undefined && !labels[0].endsWith(`-${portNumber}`))
		|| uri.port !== '' || uri.username !== '' || uri.password !== ''
		|| uri.search !== '' || uri.hash !== '' || uri.pathname !== '/') {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
	uri.protocol = 'https:';
	return uri.origin;
}

export function portOrigin(port: TunnelPort, locator: EndpointLocator): string {
	if (port.portNumber !== locator.portNumber
		|| (port.tunnelId !== undefined && port.tunnelId !== locator.tunnelId)
		|| (port.clusterId !== undefined && port.clusterId !== locator.clusterId)
		|| !['http', 'https'].includes(port.protocol ?? '')
		|| !port.portForwardingUris?.length) {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
	const origins = port.portForwardingUris.map((uri) => validateForwardingOrigin(uri, locator.portNumber));
	return origins.find((origin) => new URL(origin).hostname.split('.')[0] === `${locator.tunnelId}-${locator.portNumber}`)
		?? origins[0];
}

export function rpcEndpoint(origin: string): string {
	return `${validateForwardingOrigin(origin).replace(/^https:/u, 'wss:')}/agent-mesh/rpc`;
}

function parseUri(input: string): URL {
	try {
		if (input.length > 512 || /[\s\\]/u.test(input)) {
			throw new Error('Invalid URI.');
		}
		return new URL(input);
	} catch {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
}
