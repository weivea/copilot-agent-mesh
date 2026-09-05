import type { PeerRecord, PendingPeerRecord } from '../gateway/PairingService';

export interface IncomingPeerEntry {
	readonly peerId: string;
	readonly state: 'active' | 'pending' | 'revoked';
	readonly cleanupPending: boolean;
}

export function incomingPeerCatalog(
	peers: readonly PeerRecord[],
	pending: readonly PendingPeerRecord[],
	revocations: readonly { readonly peerId: string; readonly cleanupPending: boolean; readonly taskCancellationPending: boolean }[],
): readonly IncomingPeerEntry[] {
	const revoked = new Map(revocations.map((entry) => [entry.peerId, entry]));
	const entries = new Map<string, IncomingPeerEntry & { order: number }>();
	for (const peer of pending) {
		entries.set(peer.peerId, { peerId: peer.peerId, state: 'pending', cleanupPending: false, order: peer.expiresAt });
	}
	for (const peer of peers) {
		entries.set(peer.peerId, { peerId: peer.peerId, state: 'active', cleanupPending: false, order: peer.createdAt });
	}
	for (const [id, entry] of entries) {
		const tombstone = revoked.get(id);
		if (tombstone !== undefined) {
			entries.set(id, { ...entry, state: 'revoked', cleanupPending: tombstone.cleanupPending || tombstone.taskCancellationPending });
		}
	}
	const priority = (entry: IncomingPeerEntry) => entry.state === 'active' ? 0
		: entry.state === 'pending' ? 1 : entry.cleanupPending ? 2 : 3;
	return [...entries.values()]
		.sort((left, right) => priority(left) - priority(right) || right.order - left.order || left.peerId.localeCompare(right.peerId))
		.map(({ order: _order, ...entry }) => entry);
}
