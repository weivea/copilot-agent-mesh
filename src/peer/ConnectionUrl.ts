import { decodeFixedBase64Url, SECRET_BYTES } from '../gateway/PairingCrypto';
import { MESH_PROTOCOL_VERSION } from '../../shared/protocol';

export interface ParsedConnectionUrl {
	readonly rpcEndpoint: string;
	readonly workerDeviceId: string;
	readonly invitationId: string;
	readonly secret: string;
}

export class ConnectionUrlError extends Error {
	public constructor(message = 'The connection URL is invalid.') {
		super(message);
		this.name = 'ConnectionUrlError';
	}
}

export function parseConnectionUrl(input: string): ParsedConnectionUrl {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new ConnectionUrlError();
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'wss:')
		|| url.hostname.length === 0
		|| url.username.length !== 0
		|| url.password.length !== 0
		|| url.pathname !== '/agent-mesh/connect') {
		throw new ConnectionUrlError();
	}
	const queryKeys = [...url.searchParams.keys()];
	if (queryKeys.length !== 3
		|| url.searchParams.getAll('v').length !== 1
		|| url.searchParams.getAll('device').length !== 1
		|| url.searchParams.getAll('invite').length !== 1
		|| url.searchParams.get('v') !== String(MESH_PROTOCOL_VERSION)) {
		throw new ConnectionUrlError();
	}
	const workerDeviceId = identifier(url.searchParams.get('device'));
	const invitationId = identifier(url.searchParams.get('invite'));
	const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
	if ([...fragment.keys()].length !== 1 || fragment.getAll('secret').length !== 1) {
		throw new ConnectionUrlError();
	}
	const secret = fragment.get('secret');
	try {
		decodeFixedBase64Url(secret, SECRET_BYTES, 'secret');
	} catch {
		throw new ConnectionUrlError();
	}
	url.protocol = 'wss:';
	url.pathname = '/agent-mesh/rpc';
	url.search = '';
	url.hash = '';
	return {
		rpcEndpoint: url.toString(),
		workerDeviceId,
		invitationId,
		secret: secret!,
	};
}

function identifier(value: string | null): string {
	if (value === null
		|| value.length < 1
		|| value.length > 128
		|| !/^[A-Za-z0-9._~-]+$/u.test(value)) {
		throw new ConnectionUrlError();
	}
	return value;
}
