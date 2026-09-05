import { deviceInfoSchema } from '../../shared/protocol';
import type { SecretStore } from '../gateway/SecretStore';
import type { PeerProfile, PeerProfileStore } from '../peer/PeerProfile';
import { WebSocketPeerSocketConnector } from '../peer/PeerSocketConnector';
import {
	PeerTransportError, WebSocketPeerTransport,
	type PeerSession, type PeerTransport, type WebSocketPeerTransportOptions,
} from '../peer/WebSocketPeerTransport';
import { assertDocumentFence, type DocumentFence } from '../storage/FencedDocumentStore';
import type { AccountSessionProvider } from './AccountSessionProvider';
import { ConnectivityError, type ConnectivityCode, type PeerEndpointBinding } from './ConnectivitySchemas';
import type { DiscoveredEndpoint } from './DevTunnelDiscoveryProvider';
import type { DevTunnelEndpointResolver } from './DevTunnelEndpointResolver';
import type { EndpointBindingStore } from './EndpointBindingStore';
import { rpcEndpoint } from './DevTunnelUris';

export class BoundPeerTransport implements PeerTransport {
	private readonly errors = new Map<string, ConnectivityCode>();

	public constructor(
		private readonly bindings: EndpointBindingStore,
		private readonly resolver: DevTunnelEndpointResolver,
		private readonly account: AccountSessionProvider,
		private readonly fence: DocumentFence,
		private readonly ready: () => boolean,
		private readonly transportOptions: WebSocketPeerTransportOptions = {},
	) {}

	public async prepare(profile: PeerProfile, endpoint: DiscoveredEndpoint): Promise<void> {
		const accountRef = this.account.current()?.accountRef;
		if (accountRef === undefined || profile.generation === undefined || !this.ready()) {
			throw new ConnectivityError('AUTH_REQUIRED');
		}
		await this.bindings.prepare({
			profileId: profile.id, profileGeneration: profile.generation,
			expectedWorkerDeviceId: profile.workerDeviceId, accountRef,
			locator: endpoint.locator, admission: endpoint.admission, expectedOrigin: endpoint.origin,
		});
	}

	public forget(profileId: string): void {
		this.errors.delete(profileId);
	}

	public lastError(profileId: string): ConnectivityCode | undefined {
		return this.errors.get(profileId);
	}

	public async connect(
		profile: PeerProfile, coordinatorDeviceId: string, secrets: SecretStore,
		profiles: PeerProfileStore, signal: AbortSignal,
	): Promise<PeerSession> {
		if (!this.ready()) {
			throw new PeerTransportError('CONNECTION_FAILED', 'Remote connectivity initialization is blocked.');
		}
		await assertDocumentFence(this.fence);
		const expected = this.bindings.get(profile.id);
		const pending = this.bindings.attempt(profile.id);
		if (expected === undefined && pending === undefined) {
			const legacySession = await new WebSocketPeerTransport(this.transportOptions)
				.connect(profile, coordinatorDeviceId, secrets, profiles, signal);
			try {
				await assertDocumentFence(this.fence);
				if (!this.ready() || signal.aborted) { throw new ConnectivityError('CANCELLED'); }
				return legacySession;
			} catch (error: unknown) {
				await legacySession.close();
				throw error;
			}
		}
		const accountRef = pending?.accountRef ?? expected!.accountRef;
		const accountRevision = this.account.revision();
		const generation = pending?.profileGeneration ?? expected!.profileGeneration;
		const locator = pending?.locator ?? expected!.locator;
		const admission = pending?.admission ?? expected!.admission;
		let session: PeerSession | undefined;
		let closed = false;
		let removeClosed: (() => void) | undefined;
		try {
			const assertCurrent = async (): Promise<void> => {
				await assertDocumentFence(this.fence);
				const current = await profiles.get(profile.id);
				if (signal.aborted || closed) {
					throw new ConnectivityError('CANCELLED');
				}
				if (current?.generation !== generation || current.cleanupPending
					|| current.workerDeviceId !== profile.workerDeviceId
					|| (expected !== undefined && expected.expectedWorkerDeviceId !== profile.workerDeviceId)
					|| (pending !== undefined && pending.expectedWorkerDeviceId !== profile.workerDeviceId)
					|| this.account.current()?.accountRef !== accountRef) {
					throw new ConnectivityError('BINDING_CHANGED');
				}
				if (this.account.revision() !== accountRevision) {
					throw new ConnectivityError('ACCOUNT_CHANGED');
				}
			};
			await assertCurrent();
			const origin = await this.resolver.resolve(locator, admission, signal);
			if (pending !== undefined && origin !== pending.expectedOrigin) {
				throw new ConnectivityError('BINDING_CHANGED');
			}
			const capability = admission === 'private-port-token' ? await this.resolver.connectCapability(locator, signal) : undefined;
			const connector = this.transportOptions.connector ?? (this.transportOptions.webSocketFactory === undefined
				? new WebSocketPeerSocketConnector(capability === undefined ? undefined : async () => capability)
				: { connect: async (endpoint: string) => this.transportOptions.webSocketFactory!(endpoint) });
			session = await new WebSocketPeerTransport({ ...this.transportOptions, connector }).connect(
				{ ...profile, rpcEndpoint: rpcEndpoint(origin) },
				coordinatorDeviceId, secrets, profiles, signal,
			);
			removeClosed = session.onClose(() => { closed = true; });
			const info = deviceInfoSchema.parse(await session.request('device.getInfo', {}));
			if (info.deviceId !== profile.workerDeviceId) {
				throw new PeerTransportError('AUTH_FAILED', 'The authenticated Mesh device identity did not match.');
			}
			await assertCurrent();
			const binding: PeerEndpointBinding = {
				profileId: profile.id, profileGeneration: generation,
				expectedWorkerDeviceId: profile.workerDeviceId, accountRef, locator, admission,
				verifiedOrigin: origin, verifiedAt: new Date().toISOString(),
			};
			await this.bindings.commit(binding, expected, assertCurrent);
			await assertCurrent();
			this.errors.delete(profile.id);
			return session;
		} catch (error: unknown) {
			await session?.close();
			if (error instanceof ConnectivityError) {
				this.errors.set(profile.id, error.code);
				throw new PeerTransportError(
					['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED', 'PRIVATE_ACCESS_REQUIRED'].includes(error.code)
						? 'AUTH_FAILED' : error.code === 'BINDING_CHANGED' ? 'REPAIR_REQUIRED' : 'CONNECTION_FAILED',
					error.message,
				);
			}
			if (error instanceof PeerTransportError) {
				this.errors.set(profile.id, error.reason === 'PROTOCOL_INCOMPATIBLE' ? 'PROTOCOL_INCOMPATIBLE'
					: error.reason === 'CONNECTION_FAILED' ? 'OFFLINE' : 'BINDING_CHANGED');
			}
			throw error;
		} finally {
			removeClosed?.();
		}
	}
}
