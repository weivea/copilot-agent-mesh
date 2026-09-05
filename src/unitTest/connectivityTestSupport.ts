import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import { AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';

import { AccountSessionProvider, DEV_TUNNEL_SCOPES, type DiscoveryAuthentication } from '../connectivity/AccountSessionProvider';
import { DISCOVERY_LABELS, ADVERTISEMENT_PREFIX, type AccountBinding, type EndpointLocator } from '../connectivity/ConnectivitySchemas';
import { AtomicFileStore } from '../storage/AtomicFileStore';
import { MemoryAtomicFileSystem, TestOwnership, uuid } from './artifactStoreTestSupport';
import { LocalIpcClient, LocalIpcServer, type LocalIpcSession } from '../ipc';
import type { StateStore } from '../domain/ports';

export const TEST_ACCOUNT: AccountBinding = {
	accountRef: uuid(701), accountId: 'approved-test-account', providerId: 'github', scopes: [...DEV_TUNNEL_SCOPES.github],
};
export const TEST_LOCATOR: EndpointLocator = {
	provider: 'dev-tunnels', clusterId: 'use2', tunnelId: 'mesh-test', portNumber: 43121, advertisementId: uuid(702),
};

export class TestAuthentication implements DiscoveryAuthentication {
	public session: vscode.AuthenticationSession | undefined = {
		id: 'session-test', account: { id: TEST_ACCOUNT.accountId, label: 'Test account' },
		scopes: TEST_ACCOUNT.scopes, accessToken: 'synthetic-test-oauth-value',
	};
	public readonly requests: vscode.AuthenticationGetSessionOptions[] = [];
	public accounts: readonly vscode.AuthenticationSessionAccountInformation[] | undefined;
	public readonly listeners = new Set<(event: vscode.AuthenticationSessionsChangeEvent) => unknown>();
	public wait: Promise<void> | undefined;
	public readonly onDidChangeSessions: vscode.Event<vscode.AuthenticationSessionsChangeEvent> = (listener) => {
		this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) };
	};
	public async getSession(_provider: string, _scopes: readonly string[], options: vscode.AuthenticationGetSessionOptions) {
		this.requests.push(options);
		await this.wait;
		return this.session;
	}
	public async getAccounts() {
		await this.wait;
		return this.accounts ?? (this.session === undefined ? [] : [this.session.account]);
	}
	public changed(provider = 'github'): void {
		for (const listener of this.listeners) { listener({ provider: { id: provider, label: 'Test provider' } }); }
	}
}

export function connectivityFixture() {
	const fs = new MemoryAtomicFileSystem();
	const ownership = new TestOwnership();
	const fence = { ownership, generation: ownership.generation };
	const files = new AtomicFileStore('connectivity-test', fs, { next: randomUUID });
	const authentication = new TestAuthentication();
	const account = new AccountSessionProvider(authentication, fence);
	account.initialize();
	account.setBinding(TEST_ACCOUNT);
	return { fs, ownership, fence, files, authentication, account };
}

export function sdkResponse(config: InternalAxiosRequestConfig, data: unknown, status = 200) {
	return { config, data, status, statusText: status === 200 ? 'OK' : 'Error', headers: new AxiosHeaders() };
}

export function advertisedTunnel() {
	return {
		clusterId: TEST_LOCATOR.clusterId, tunnelId: TEST_LOCATOR.tunnelId,
		labels: [...DISCOVERY_LABELS, `${ADVERTISEMENT_PREFIX}${TEST_LOCATOR.advertisementId}`],
		status: {},
		ports: [{
			portNumber: TEST_LOCATOR.portNumber, protocol: 'http',
			portForwardingUris: [`https://mesh-test-${TEST_LOCATOR.portNumber}.use2.devtunnels.ms`],
		}],
	};
}

export function syntheticCapability(port = TEST_LOCATOR.portNumber, scope = 'connect', expires = Date.now() + 3_600_000): string {
	return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({
		exp: Math.floor(expires / 1000), tunnelPorts: port, scp: scope, tunnelId: TEST_LOCATOR.tunnelId, clusterId: TEST_LOCATOR.clusterId,
	})).toString('base64url')}.synthetic-signature`;
}

export class ConnectivityMemoryState implements StateStore {
	public readonly values = new Map<string, unknown>();
	public get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
	public async update(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
}

export async function localSession(clientId: string) {
	const identity = { userIdentity: randomUUID(), deviceId: randomUUID() };
	const key = Buffer.alloc(32, 19);
	let accepted!: (session: LocalIpcSession) => void;
	const session = new Promise<LocalIpcSession>((resolve) => { accepted = resolve; });
	const server = new LocalIpcServer({ identity, brokerKey: key, onSession: accepted });
	const client = new LocalIpcClient({ identity, brokerKey: key, clientId });
	await server.listen();
	await client.connect();
	return {
		session: await session,
		dispose: async () => { client.dispose(); await server.dispose(); },
	};
}
