import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as vscode from 'vscode';

import { VscodeAuthBroker } from '../agentHost/AuthBroker';
import { resolveCodespaceAuthenticationProvider } from '../codespaces/CodespaceRuntimeComposition';
import { AccountSessionProvider, DEV_TUNNEL_SCOPES, type DiscoveryAuthentication } from '../connectivity/AccountSessionProvider';
import { TestOwnership, uuid } from './artifactStoreTestSupport';

test('Codespaces Agent authentication can use a different account without changing the Dev Tunnel binding', async () => {
	const tunnelAccount = { id: 'fixture-tunnel-account', label: 'Tunnel account' };
	const copilotAccount = { id: 'fixture-copilot-account', label: 'Copilot account' };
	const calls: Array<{ provider: string; scopes: readonly string[]; account?: string }> = [];
	const authentication: DiscoveryAuthentication = {
		onDidChangeSessions: () => ({ dispose() {} }),
		getAccounts: async () => [tunnelAccount, copilotAccount],
		getSession: async (provider, scopes, options) => {
			calls.push({ provider, scopes: [...scopes], account: options.account?.id });
			const isTunnel = scopes.includes('read:org');
			return {
				id: isTunnel ? 'fixture-tunnel-session' : 'fixture-copilot-session',
				account: isTunnel ? tunnelAccount : copilotAccount,
				scopes: [...scopes],
				accessToken: isTunnel ? 'fixture-tunnel-token' : 'fixture-copilot-token',
			};
		},
	};
	const ownership = new TestOwnership();
	const tunnel = new AccountSessionProvider(authentication, { ownership, generation: ownership.generation });
	tunnel.setBinding({
		accountRef: uuid(850), accountId: tunnelAccount.id, providerId: 'github',
		scopes: [...DEV_TUNNEL_SCOPES.github],
	});
	const api = {
		workspace: { getConfiguration: () => ({ get: () => ({}) }) },
	} as unknown as typeof vscode;
	const agent = new VscodeAuthBroker(authentication, (resource) => resolveCodespaceAuthenticationProvider(api, resource));
	const credentials: Array<{ resource: string; token: string }> = [];
	try {
		assert.equal(await tunnel.authorization(new AbortController().signal), 'github fixture-tunnel-token');
		await agent.authenticate({
			resources: [{ resource: 'https://api.github.com', required: true }],
			interactive: true,
			reason: 'initial',
		}, async (resource, token) => { credentials.push({ resource, token }); });
		assert.deepEqual(credentials, [{ resource: 'https://api.github.com', token: 'fixture-copilot-token' }]);
		assert.equal(tunnel.current()?.accountId, tunnelAccount.id);
		assert.deepEqual(calls, [
			{ provider: 'github', scopes: [...DEV_TUNNEL_SCOPES.github], account: tunnelAccount.id },
			{ provider: 'github', scopes: ['read:user', 'user:email'], account: undefined },
		]);
		assert.equal(await tunnel.authorization(new AbortController().signal), 'github fixture-tunnel-token');
	} finally { tunnel.dispose(); }
});

test('Codespaces never infer an Agent provider from an unrelated Tunnel account or unknown resource', async () => {
	const api = {
		workspace: { getConfiguration: () => ({ get: () => ({}) }) },
	} as unknown as typeof vscode;
	assert.equal(await resolveCodespaceAuthenticationProvider(api, { resource: 'https://unknown.invalid' }), undefined);
	const explicitlyConfigured = {
		workspace: { getConfiguration: () => ({ get: () => ({
			'https://enterprise.invalid': { providerId: 'github-enterprise', scopes: ['read:user'] },
		}) }) },
	} as unknown as typeof vscode;
	assert.deepEqual(await resolveCodespaceAuthenticationProvider(explicitlyConfigured, { resource: 'https://enterprise.invalid' }),
		{ providerId: 'github-enterprise', scopes: ['read:user'] });
});
