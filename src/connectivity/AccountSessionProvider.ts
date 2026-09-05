import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';

import { assertDocumentFence, type DocumentFence } from '../storage/FencedDocumentStore';
import { accountBindingSchema, ConnectivityError, type AccountBinding } from './ConnectivitySchemas';
import { abortable } from './ConnectivityOperations';

export const DEV_TUNNEL_SCOPES = {
	github: ['read:org', 'user:email'],
	microsoft: ['46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2/.default'],
} as const;

export interface DiscoveryAuthentication {
	getAccounts(providerId: string): PromiseLike<readonly vscode.AuthenticationSessionAccountInformation[]>;
	getSession(
		providerId: string, scopes: readonly string[], options: vscode.AuthenticationGetSessionOptions,
	): PromiseLike<vscode.AuthenticationSession | undefined>;
	readonly onDidChangeSessions: vscode.Event<vscode.AuthenticationSessionsChangeEvent>;
}

export class AccountSessionProvider {
	private binding: AccountBinding | undefined;
	private epoch = 0;
	private disposed = false;
	private readonly changed = new Set<() => void>();
	private subscription: vscode.Disposable | undefined;

	public constructor(
		private readonly authentication: DiscoveryAuthentication,
		private readonly fence: DocumentFence,
	) {}

	public initialize(): void {
		if (this.subscription !== undefined) { return; }
		this.subscription = this.authentication.onDidChangeSessions((event) => {
			if (event.provider.id === this.binding?.providerId) {
				this.invalidate();
			}
		});
	}

	public setBinding(binding: AccountBinding | undefined): void {
		this.binding = binding === undefined ? undefined : accountBindingSchema.parse(binding);
		this.invalidate();
	}

	public current(): AccountBinding | undefined {
		return this.binding === undefined ? undefined : structuredClone(this.binding);
	}

	public revision(): number { return this.epoch; }

	public onDidChange(listener: () => void): { dispose(): void } {
		this.changed.add(listener);
		return { dispose: () => this.changed.delete(listener) };
	}

	/** Only called from the explicit native account-authorization action, never restoration. */
	public async select(
		providerId: AccountBinding['providerId'],
		account?: vscode.AuthenticationSessionAccountInformation,
	): Promise<AccountBinding> {
		this.initialize();
		await this.assertCurrent();
		const epoch = this.epoch;
		const scopes = [...DEV_TUNNEL_SCOPES[providerId]];
		const detail = 'Allow Mesh to use this account only with Microsoft Dev Tunnels. This does not pair devices or authorize tasks.';
		const session = await nativeAuthentication(this.authentication.getSession(providerId, scopes, account === undefined
			? { forceNewSession: { detail } } : { account, createIfNone: { detail } }));
		await this.assertCurrent();
		if (session === undefined) {
			throw new ConnectivityError('AUTH_REQUIRED');
		}
		if (account !== undefined && session.account.id !== account.id) {
			throw new ConnectivityError('ACCOUNT_CHANGED');
		}
		// The authentication event from this explicit login may invalidate a previous binding.
		if (this.epoch !== epoch && this.binding?.providerId !== providerId) {
			throw new ConnectivityError('ACCOUNT_CHANGED');
		}
		assertScopes(session.scopes, scopes);
		return accountBindingSchema.parse({
			accountRef: this.binding?.providerId === providerId && this.binding.accountId === session.account.id
				? this.binding.accountRef : randomUUID(),
			providerId,
			accountId: session.account.id,
			scopes,
		});
	}

	public async authorization(signal: AbortSignal): Promise<string> {
		const binding = this.binding;
		const epoch = this.epoch;
		if (binding === undefined) {
			throw new ConnectivityError('AUTH_REQUIRED');
		}
		await this.assertCurrent(signal);
		assertScopes(binding.scopes, DEV_TUNNEL_SCOPES[binding.providerId]);
		const accounts = await nativeAuthentication(this.authentication.getAccounts(binding.providerId), signal);
		await this.assertCurrent(signal);
		if (epoch !== this.epoch || this.binding?.accountRef !== binding.accountRef) {
			throw new ConnectivityError('ACCOUNT_CHANGED');
		}
		const matchingAccounts = accounts.filter((account) => account.id === binding.accountId);
		if (matchingAccounts.length !== 1) {
			throw new ConnectivityError(accounts.length === 0 ? 'AUTH_REQUIRED' : 'ACCOUNT_CHANGED');
		}
		// The provider may filter by its native account label; identity is still checked by ID.
		const session = await nativeAuthentication(this.authentication.getSession(binding.providerId, [...binding.scopes], {
			silent: true,
			account: matchingAccounts[0],
		}), signal);
		await this.assertCurrent(signal);
		if (epoch !== this.epoch || this.binding?.accountRef !== binding.accountRef) {
			throw new ConnectivityError('ACCOUNT_CHANGED');
		}
		if (session === undefined) {
			throw new ConnectivityError('AUTH_REQUIRED');
		}
		if (session.account.id !== binding.accountId) {
			throw new ConnectivityError('ACCOUNT_CHANGED');
		}
		assertScopes(session.scopes, binding.scopes);
		if (session.accessToken.length === 0 || /[\r\n]/u.test(session.accessToken)) {
			throw new ConnectivityError('AUTH_REQUIRED');
		}
		return `${binding.providerId === 'github' ? 'github' : 'Bearer'} ${session.accessToken}`;
	}

	public dispose(): void {
		this.disposed = true;
		this.subscription?.dispose();
		this.binding = undefined;
		this.invalidate();
		this.changed.clear();
	}

	private invalidate(): void {
		this.epoch += 1;
		for (const listener of this.changed) {
			listener();
		}
	}

	private async assertCurrent(signal?: AbortSignal): Promise<void> {
		if (this.disposed || signal?.aborted) {
			throw new ConnectivityError('CANCELLED');
		}
		await assertDocumentFence(this.fence);
	}
}

async function nativeAuthentication<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
	try {
		return signal === undefined ? await operation : await abortable(operation, signal);
	} catch (error: unknown) {
		if (error instanceof ConnectivityError) { throw error; }
		const cancelled = error instanceof Error && (
			['Canceled', 'CancellationError', 'AbortError'].includes(error.name)
			|| error.message === 'User did not consent to login.'
		);
		throw new ConnectivityError(cancelled ? 'CANCELLED' : 'AUTH_REQUIRED');
	}
}

function assertScopes(actual: readonly string[], expected: readonly string[]): void {
	if (actual.length !== expected.length
		|| [...actual].sort().some((scope, index) => scope !== [...expected].sort()[index])) {
		throw new ConnectivityError('SCOPES_CHANGED');
	}
}
