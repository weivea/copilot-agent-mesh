import { randomUUID } from 'node:crypto';
import { TunnelConstraints, type Tunnel } from '@microsoft/dev-tunnels-contracts';

import {
	ADVERTISEMENT_PREFIX,
	ACCOUNT_IDENTITY_PREFIX,
	accountDeviceIdentitySchema,
	ConnectivityError,
	isTransientDiscoveryError,
	DISCOVERY_LABELS,
	PRIVATE_LABEL,
	endpointLocatorSchema,
	type EndpointLocator,
	type PeerAdmission,
	type TunnelResource,
	type AccountDeviceIdentity,
	type ConnectivityDiagnosticsReporter,
	type ConnectivityCode,
} from './ConnectivitySchemas';
import { readAccountPublicKey } from './AccountDeviceIdentity';
import type { DevTunnelManagement } from './DevTunnelManagement';
import { normalizeConnectivityError } from './DevTunnelManagement';
import { ConnectivityOperation } from './ConnectivityOperations';
import { portOrigin } from './DevTunnelUris';

export interface DiscoveredEndpoint {
	readonly locator: EndpointLocator;
	readonly admission: PeerAdmission;
	readonly origin: string;
	readonly hostHint: 'online' | 'offline' | 'unknown';
	readonly accountIdentity?: AccountDeviceIdentity;
}

const advertisementSchema = endpointLocatorSchema.omit({ provider: true, portNumber: true });

export interface DiscoveryAdvertisement {
	readonly resource: TunnelResource;
	readonly advertisementId: string;
	readonly admission: PeerAdmission;
	readonly accountIdentity?: AccountDeviceIdentity;
}

export interface DiscoveryListResult {
	readonly endpoints: readonly DiscoveredEndpoint[];
	readonly advertisements: readonly DiscoveryAdvertisement[];
	readonly truncated: boolean;
	readonly failedCandidateCount: number;
	readonly deferredCandidateCount: number;
	readonly error?: ConnectivityCode;
	readonly retryAfterMs?: number;
}

export const DISCOVERY_BUDGETS = { listMs: 10_000, detailMs: 5_000, roundMs: 20_000 } as const;

export class DevTunnelDiscoveryProvider {
	private readonly retries = new Map<string, { failures: number; retryAt: number; code: ConnectivityCode }>();

	public constructor(
		private readonly management: DevTunnelManagement,
		private readonly diagnostics?: ConnectivityDiagnosticsReporter,
		private readonly options: {
			readonly listTimeoutMs?: number;
			readonly detailTimeoutMs?: number;
			readonly roundTimeoutMs?: number;
			readonly now?: () => number;
			readonly needsDetail?: (advertisement: DiscoveryAdvertisement) => boolean;
		} = {},
	) {}

	public invalidate(): void { this.retries.clear(); }

	public async list(signal: AbortSignal): Promise<DiscoveryListResult> {
		const accountSignal = this.management.cancellationSignal;
		const round = new ConnectivityOperation(this.options.roundTimeoutMs ?? DISCOVERY_BUDGETS.roundMs, signal, accountSignal);
		const operationId = randomUUID();
		const startedAt = Date.now();
		let failedCandidateCount = 0;
		let deferredCandidateCount = 0;
		let error: ConnectivityCode | undefined;
		let retryAfterMs: number | undefined;
		try {
			const tunnels = await this.management.run((client, cancellation) => client.listTunnels(undefined, undefined, {
				labels: [...DISCOVERY_LABELS],
				requireAllLabels: true,
				includePorts: true,
				limit: 10,
				followRedirects: false,
			}, cancellation), round.controller.signal, {
				phase: 'discovery.list', operationId, timeoutMs: this.options.listTimeoutMs ?? DISCOVERY_BUDGETS.listMs,
			});
			round.assertActive();
			this.diagnostics?.('Tunnel discovery SDK result.', {
				tunnelCount: tunnels.length,
				tunnels: tunnels.slice(0, 10).map((tunnel) => ({
					tunnelMarker: tunnel.tunnelId?.slice(0, 12),
					clusterMarker: tunnel.clusterId?.slice(0, 8),
					missingLabels: DISCOVERY_LABELS.filter((label) => !tunnel.labels?.includes(label)),
					advertisementCount: tunnel.labels?.filter((label) => label.startsWith(ADVERTISEMENT_PREFIX)).length ?? 0,
					privateAdmission: tunnel.labels?.includes(PRIVATE_LABEL) ?? false,
					hasAccountIdentity: tunnel.description?.startsWith(ACCOUNT_IDENTITY_PREFIX) ?? false,
					portCount: tunnel.ports?.length ?? 0,
					httpPortCount: tunnel.ports?.filter((port) => port.protocol === 'http' || port.protocol === 'https').length ?? 0,
					hostHint: readHostHint(tunnel),
				})),
			});
			const endpoints: DiscoveredEndpoint[] = [];
			// Validate every summary before deferring any work; a partial result is not a validation bypass.
			const candidates = tunnels.slice(0, 10).flatMap((summary) => {
				const advertisement = readAdvertisement(summary);
				if (advertisement === undefined) { return []; }
				const incomplete = !summary.ports?.length || summary.ports.some((port) => port.protocol === undefined
					|| ((port.protocol === 'http' || port.protocol === 'https') && !port.portForwardingUris?.length));
				return [{ summary, advertisement, incomplete, projected: incomplete ? [] : this.project(summary) }];
			});
			const keys = new Set(candidates.map((candidate) => JSON.stringify(candidate.advertisement)));
			for (const key of this.retries.keys()) {
				if (!keys.has(key)) { this.retries.delete(key); }
			}
			let portCount = tunnels.reduce((count, tunnel) => count + (tunnel.ports?.length ?? 0), 0);
			for (const { summary, advertisement, incomplete, projected } of candidates) {
				if (signal.aborted || accountSignal.aborted) { throw new ConnectivityError('CANCELLED'); }
				const key = JSON.stringify(advertisement);
				if (!incomplete) {
					this.retries.delete(key);
					endpoints.push(...projected);
					continue;
				}
				if (readHostHint(summary) === 'offline' && this.options.needsDetail?.(advertisement) !== true) {
					this.retries.delete(key);
					deferredCandidateCount += 1;
					continue;
				}
				const previous = this.retries.get(key);
				const now = this.options.now?.() ?? Date.now();
				if (previous !== undefined && now < previous.retryAt) {
					deferredCandidateCount += 1;
					error ??= previous.code;
					continue;
				}
				if (round.cancellationError?.code === 'TIMEOUT') {
					deferredCandidateCount += 1;
					error ??= 'TIMEOUT';
					continue;
				}
				try {
					// A fresh exact detail read cannot inherit the list's nearly exhausted deadline.
					const detail = await this.management.run((client, cancellation) =>
						client.getTunnel(advertisement.resource, { includePorts: true, followRedirects: false }, cancellation),
					round.controller.signal, {
						phase: 'discovery.detail', operationId, timeoutMs: this.options.detailTimeoutMs ?? DISCOVERY_BUDGETS.detailMs,
					});
					if (detail === null) { throw new ConnectivityError('OFFLINE'); }
					const current = readAdvertisement(detail);
					if (current === undefined
						|| JSON.stringify(current) !== JSON.stringify(advertisement)) {
						throw new ConnectivityError('BINDING_CHANGED');
					}
					portCount += (detail.ports?.length ?? 0) - (summary.ports?.length ?? 0);
					const resolved = this.project(detail);
					if (resolved.length === 0) { throw new ConnectivityError('OFFLINE'); }
					endpoints.push(...resolved);
					this.retries.delete(key);
					this.diagnostics?.('Tunnel discovery detail resolved.', {
						operationId,
						tunnelMarker: detail.tunnelId?.slice(0, 12),
						clusterMarker: detail.clusterId?.slice(0, 8),
						portCount: detail.ports?.length ?? 0,
						hostHint: readHostHint(detail),
					});
				} catch (cause: unknown) {
					if (signal.aborted || accountSignal.aborted) { throw new ConnectivityError('CANCELLED'); }
					const normalized = normalizeConnectivityError(cause, round.cancellationError);
					if (!isTransientDiscoveryError(normalized.code)) { throw normalized; }
					failedCandidateCount += 1;
					error ??= normalized.code;
					const failures = Math.min((previous?.failures ?? 0) + 1, 5);
					const delayMs = Math.max(normalized.retryAfterMs ?? 0, Math.min(300_000, 30_000 * 2 ** (failures - 1)));
					this.retries.set(key, { failures, retryAt: (this.options.now?.() ?? Date.now()) + delayMs, code: normalized.code });
					if (normalized.code === 'RATE_LIMITED') { retryAfterMs = Math.max(retryAfterMs ?? 0, normalized.retryAfterMs ?? 60_000); }
					this.diagnostics?.('Tunnel discovery candidate deferred after failure.', {
						operationId, tunnelMarker: advertisement.resource.tunnelId.slice(0, 12),
						code: normalized.code, retryAfterMs: delayMs,
					});
				}
			}
			if (signal.aborted || accountSignal.aborted) { throw new ConnectivityError('CANCELLED'); }
			const result = {
				endpoints: endpoints.slice(0, 10),
				advertisements: candidates.map((candidate) => candidate.advertisement),
				// The released SDK discards pagination. Never infer deletion/completeness at the cap.
				truncated: tunnels.length >= 10 || portCount > 10,
				failedCandidateCount, deferredCandidateCount,
				...(error === undefined ? {} : { error }),
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			};
			this.diagnostics?.('Tunnel discovery projected endpoints.', {
				endpointCount: result.endpoints.length,
				truncated: result.truncated,
				endpoints: result.endpoints.map((endpoint) => ({
					advertisementMarker: endpoint.locator.advertisementId.slice(0, 8),
					deviceMarker: endpoint.accountIdentity?.deviceId.slice(0, 8),
					admission: endpoint.admission,
					hostHint: endpoint.hostHint,
				})),
			});
			return result;
		} catch (cause: unknown) {
			error = normalizeConnectivityError(cause).code;
			throw cause;
		} finally {
			const elapsedMs = Date.now() - startedAt;
			if (elapsedMs >= 2000 || error !== undefined || round.cancellationError !== undefined) {
				this.diagnostics?.('Discovery round timing.', {
					operationId, elapsedMs, budgetMs: this.options.roundTimeoutMs ?? DISCOVERY_BUDGETS.roundMs,
					timerDelayMs: round.deadlineDelayMs, failedCandidateCount, deferredCandidateCount,
					...(error === undefined ? {} : { code: error }),
				});
			}
			round.dispose();
		}
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
		const advertised = readAdvertisement(tunnel);
		if (advertised === undefined) { return []; }
		const hostHint = readHostHint(tunnel);
		return (tunnel.ports ?? []).filter((port) => port.protocol === 'http' || port.protocol === 'https')
			.map((port) => {
				const parsed = endpointLocatorSchema.safeParse({
					provider: 'dev-tunnels',
					...advertised.resource,
					portNumber: port.portNumber,
					advertisementId: advertised.advertisementId,
				});
				if (!parsed.success) {
					throw new ConnectivityError('INVALID_ENDPOINT');
				}
				return {
					locator: parsed.data,
					admission: advertised.admission,
					origin: portOrigin(port, parsed.data),
					hostHint,
					...(advertised.accountIdentity === undefined ? {} : { accountIdentity: advertised.accountIdentity }),
				};
			});
	}
}

function readAdvertisement(tunnel: Tunnel): DiscoveryAdvertisement | undefined {
	if (!DISCOVERY_LABELS.every((label) => tunnel.labels?.includes(label))) { return undefined; }
	assertLabels(tunnel.labels!);
	const markers = tunnel.labels!.filter((label) => label.startsWith(ADVERTISEMENT_PREFIX));
	if (markers.length !== 1) { throw new ConnectivityError('INVALID_ENDPOINT'); }
	const parsed = advertisementSchema.safeParse({
		clusterId: tunnel.clusterId, tunnelId: tunnel.tunnelId,
		advertisementId: markers[0].slice(ADVERTISEMENT_PREFIX.length),
	});
	if (!parsed.success) { throw new ConnectivityError('INVALID_ENDPOINT'); }
	const accountIdentity = readAdvertisedIdentity(tunnel);
	return {
		resource: { clusterId: parsed.data.clusterId, tunnelId: parsed.data.tunnelId },
		advertisementId: parsed.data.advertisementId,
		admission: tunnel.labels!.includes(PRIVATE_LABEL) ? 'private-port-token' : 'legacy-mesh-auth',
		...(accountIdentity === undefined ? {} : { accountIdentity }),
	};
}

function readHostHint(tunnel: Tunnel): DiscoveredEndpoint['hostHint'] {
	const hostCount = tunnel.status?.hostConnectionCount;
	const count = typeof hostCount === 'number' ? hostCount : hostCount?.current;
	return typeof count !== 'number' || !Number.isFinite(count) || count < 0
		? 'unknown' : count > 0 ? 'online' : 'offline';
}

function readAdvertisedIdentity(tunnel: Tunnel): AccountDeviceIdentity | undefined {
	if (!tunnel.description?.startsWith(ACCOUNT_IDENTITY_PREFIX)) { return undefined; }
	if (!tunnel.labels?.includes(PRIVATE_LABEL) || tunnel.description.length > 512) {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
	try {
		const identity = accountDeviceIdentitySchema.parse(JSON.parse(tunnel.description.slice(ACCOUNT_IDENTITY_PREFIX.length)));
		readAccountPublicKey(identity.publicKey);
		return identity;
	} catch {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
}

export function assertLabels(labels: readonly string[]): void {
	if (labels.length > TunnelConstraints.maxLabels || labels.some((label) =>
		typeof label !== 'string' || label.length < 1 || label.length > TunnelConstraints.labelMaxLength
		|| /[\p{C}]/u.test(label))) {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
}
