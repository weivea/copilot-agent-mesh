import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import WebSocket from 'ws';

import { DevTunnelProviderError } from './DevTunnelProvider';

export const DEVTUNNEL_SKIP_ANTIPHISHING_HEADER = 'X-Tunnel-Skip-AntiPhishing-Page';

export interface ReadyProbeOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly tunnelAccessToken?: string;
}

export async function probeLoopbackHealth(
	port: number,
	path: string,
	options: ReadyProbeOptions = {},
): Promise<void> {
	const origin = new URL(`http://127.0.0.1:${port}`);
	await probeHttp204(resolveSameOriginPath(origin, path), false, options);
}

export async function probeDevTunnelHealth(
	forwardingOrigin: string,
	path: string,
	options: ReadyProbeOptions = {},
): Promise<void> {
	const origin = new URL(forwardingOrigin);
	await probeHttp204(resolveSameOriginPath(origin, path), true, options);
}

export function probeDevTunnelWss(
	forwardingOrigin: string,
	path: string,
	requestMessage: string,
	expectedResponse: string,
	options: ReadyProbeOptions = {},
): Promise<void> {
	const origin = new URL(forwardingOrigin);
	const url = resolveSameOriginPath(origin, path);
	url.protocol = 'wss:';
	const timeoutMs = options.timeoutMs ?? 10_000;
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, {
			followRedirects: false,
			handshakeTimeout: timeoutMs,
			headers: {
				Accept: 'application/json',
				[DEVTUNNEL_SKIP_ANTIPHISHING_HEADER]: 'true',
				...(options.tunnelAccessToken === undefined ? {} : {
					'X-Tunnel-Authorization': `tunnel ${options.tunnelAccessToken}`,
				}),
			},
			rejectUnauthorized: true,
		});
		let settled = false;
		const timer = setTimeout(() => fail('The Dev Tunnel WSS probe timed out.'), timeoutMs);
		const abort = (): void => fail('The Dev Tunnel WSS probe was cancelled.');
		const cleanup = (): void => {
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', abort);
			socket.removeAllListeners();
		};
		const fail = (message: string): void => {
			if (settled) {
				return;
			}

			settled = true;
			cleanup();
			socket.terminate();
			reject(new DevTunnelProviderError('WSS_PROBE_FAILED', message, true));
		};

		options.signal?.addEventListener('abort', abort, { once: true });
		if (options.signal?.aborted === true) {
			abort();
			return;
		}
		socket.once('open', () => socket.send(requestMessage));
		socket.once('message', (data, isBinary) => {
			if (isBinary || data.toString('utf8') !== expectedResponse) {
				fail('The Dev Tunnel WSS probe returned an unexpected response.');
				return;
			}
			settled = true;
			cleanup();
			socket.close(1000);
			resolve();
		});
		socket.once('unexpected-response', () => fail(
			'The Dev Tunnel WSS probe received a non-upgrade HTTP response.',
		));
		socket.once('error', () => fail('The Dev Tunnel WSS transport failed.'));
		socket.once('close', () => {
			if (!settled) {
				fail('The Dev Tunnel WSS transport closed before the probe completed.');
			}
		});
	});
}

function resolveSameOriginPath(origin: URL, path: string): URL {
	const resolved = new URL(path, origin);
	if (resolved.origin !== origin.origin) {
		throw new DevTunnelProviderError(
			'HTTPS_HEALTH_FAILED',
			'The Dev Tunnel readiness path escaped the expected origin.',
			false,
		);
	}
	return resolved;
}

function probeHttp204(
	url: URL,
	publicTunnel: boolean,
	options: ReadyProbeOptions,
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	return new Promise((resolve, reject) => {
		const request = (publicTunnel ? httpsRequest : httpRequest)(url, {
			headers: {
				Accept: 'application/json',
				...(publicTunnel ? { [DEVTUNNEL_SKIP_ANTIPHISHING_HEADER]: 'true' } : {}),
				...(publicTunnel && options.tunnelAccessToken !== undefined ? {
					'X-Tunnel-Authorization': `tunnel ${options.tunnelAccessToken}`,
				} : {}),
			},
			method: 'GET',
			rejectUnauthorized: true,
			signal: options.signal,
		}, (response) => {
			response.resume();
			if (response.statusCode !== 204) {
				reject(new DevTunnelProviderError(
					publicTunnel ? 'HTTPS_HEALTH_FAILED' : 'PORT_CONFLICT',
					publicTunnel
						? 'Dev Tunnel /healthz did not return the exact 204 status.'
						: 'The persisted loopback port is not serving the expected /healthz endpoint; explicit migration is required.',
					publicTunnel,
				));
				return;
			}
			resolve();
		});
		request.setTimeout(timeoutMs, () => {
			request.destroy(new Error('Health probe timed out.'));
		});
		request.once('error', () => reject(new DevTunnelProviderError(
			publicTunnel ? 'HTTPS_HEALTH_FAILED' : 'PORT_CONFLICT',
			publicTunnel
				? 'Dev Tunnel /healthz could not be reached with system CA validation.'
				: 'The persisted loopback port is unavailable; explicit migration is required.',
			publicTunnel,
		)));
		request.end();
	});
}
