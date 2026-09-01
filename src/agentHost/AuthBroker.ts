import type * as vscode from 'vscode';

import { AgentRuntimeError } from './AgentRuntime';

export interface ProtectedResource {
	readonly resource: string;
	readonly resource_name?: string;
	readonly authorization_servers?: readonly string[];
	readonly scopes_supported?: readonly string[];
	readonly required?: boolean;
}

export interface AuthenticationRequest {
	readonly resources: readonly ProtectedResource[];
	readonly interactive: boolean;
	readonly reason: 'initial' | 'challenge' | 'tokenInvalid';
	readonly signal?: AbortSignal;
}

export interface AuthenticationMapping {
	readonly providerId: string;
	readonly scopes: readonly string[];
}

export interface AuthBroker {
	authenticate(
		request: AuthenticationRequest,
		pushToken: (resource: string, token: string, scopes: readonly string[]) => Promise<void>,
	): Promise<void>;
}

export interface AuthenticationApi {
	getSession(
		providerId: string,
		scopes: readonly string[],
		options?: vscode.AuthenticationGetSessionOptions,
	): Thenable<vscode.AuthenticationSession | undefined>;
}

export type AuthenticationProviderResolver = (
	resource: ProtectedResource,
) => Promise<AuthenticationMapping | undefined> | AuthenticationMapping | undefined;

export class VscodeAuthBroker implements AuthBroker {
	constructor(
		private readonly authentication: AuthenticationApi,
		private readonly resolveProvider: AuthenticationProviderResolver,
	) {}

	async authenticate(
		request: AuthenticationRequest,
		pushToken: (resource: string, token: string, scopes: readonly string[]) => Promise<void>,
	): Promise<void> {
		for (const resource of request.resources.filter(({ required }) => required !== false)) {
			throwIfAborted(request.signal);
			const mapping = await abortableAuthentication(
				Promise.resolve(this.resolveProvider(resource)),
				request.signal,
			);
			throwIfAborted(request.signal);
			if (mapping === undefined || mapping.providerId.length === 0) {
				throw authRequired(resource, 'No VS Code authentication provider is configured for this protected resource.');
			}

			const scopes = [...mapping.scopes];
			const presentation = {
				detail: `Copilot Agent Mesh needs access to ${resource.resource_name ?? resource.resource}.`,
			};
			let session = request.interactive && request.reason !== 'initial'
				? await abortableAuthentication(this.authentication.getSession(mapping.providerId, scopes, {
					forceNewSession: presentation,
				}), request.signal)
				: await abortableAuthentication(
					this.authentication.getSession(mapping.providerId, scopes, { silent: true }),
					request.signal,
				);
			throwIfAborted(request.signal);
			if (session === undefined && request.interactive && request.reason === 'initial') {
				session = await abortableAuthentication(this.authentication.getSession(mapping.providerId, scopes, {
					createIfNone: presentation,
				}), request.signal);
				throwIfAborted(request.signal);
			}
			if (session === undefined || session.accessToken.length === 0) {
				throw authRequired(
					resource,
					request.interactive
						? 'Authentication was not completed.'
						: 'Authentication requires an explicit user action.',
				);
			}

			try {
				await pushToken(resource.resource, session.accessToken, scopes);
			} catch {
				throw new AgentRuntimeError(
					'AGENT_AUTH_FAILED',
					`The Agent Host rejected authentication for ${safeResourceName(resource)}.`,
				);
			}
			throwIfAborted(request.signal);
		}
	}
}

export class EditorExistingIdentityAuthBroker implements AuthBroker {
	public async authenticate(
		request: AuthenticationRequest,
		_pushToken: (resource: string, token: string, scopes: readonly string[]) => Promise<void>,
	): Promise<void> {
		throwIfAborted(request.signal);
		if (
			request.reason === 'initial'
			|| request.resources.every(({ required }) => required === false)
		) {
			return;
		}
		throw new AgentRuntimeError(
			'AGENT_AUTH_REQUIRED',
			'Authenticate the Agent Host in the selected editor profile before retrying.',
		);
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) {
		throw new DOMException('Authentication was aborted.', 'AbortError');
	}
}

function abortableAuthentication<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	if (signal === undefined) {
		return Promise.resolve(operation);
	}
	return new Promise<T>((resolve, reject) => {
		const handleAbort = () => {
			signal.removeEventListener('abort', handleAbort);
			reject(new DOMException('Authentication was aborted.', 'AbortError'));
		};
		signal.addEventListener('abort', handleAbort, { once: true });
		void Promise.resolve(operation).then(
			(value) => {
				signal.removeEventListener('abort', handleAbort);
				if (!signal.aborted) {
					resolve(value);
				}
			},
			(error: unknown) => {
				signal.removeEventListener('abort', handleAbort);
				if (!signal.aborted) {
					reject(error);
				}
			},
		);
	});
}

export class UnavailableAuthBroker implements AuthBroker {
	async authenticate(request: AuthenticationRequest): Promise<void> {
		const required = request.resources.find(({ required }) => required !== false);
		if (required !== undefined) {
			throw authRequired(required, 'Authentication requires an explicit user action in VS Code.');
		}
	}
}

function authRequired(resource: ProtectedResource, detail: string): AgentRuntimeError {
	return new AgentRuntimeError(
		'AGENT_AUTH_REQUIRED',
		`${detail} Resource: ${safeResourceName(resource)}.`,
	);
}

function safeResourceName(resource: ProtectedResource): string {
	if (resource.resource_name?.trim()) {
		return resource.resource_name.trim();
	}
	try {
		return new URL(resource.resource).origin;
	} catch {
		return 'protected resource';
	}
}
