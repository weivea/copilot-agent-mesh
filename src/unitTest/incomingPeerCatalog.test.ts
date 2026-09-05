import assert from 'node:assert/strict';
import { test } from 'node:test';

import { incomingPeerCatalog } from '../connectivity/IncomingPeerCatalog';
import type { PeerRecord } from '../gateway/PairingService';
import { uuid } from './artifactStoreTestSupport';

function peer(index: number): PeerRecord {
	return {
		peerId: uuid(index), coordinatorDeviceId: uuid(1), rootKeyRef: `mesh.peer.${uuid(index)}`,
		enrollmentId: uuid(10000 + index), transcriptHash: 'A'.repeat(43), createdAt: index,
	};
}

test('revoked history cannot crowd a new active peer out of the bounded revocation view', () => {
	const peers = Array.from({ length: 300 }, (_, index) => peer(index + 1));
	const revoked = peers.slice(0, 299).map((entry) => ({ peerId: entry.peerId, cleanupPending: false, taskCancellationPending: false }));
	const catalog = incomingPeerCatalog(peers, [], revoked);
	assert.equal(catalog[0].peerId, peers[299].peerId);
	assert.equal(catalog[0].state, 'active');
	assert.equal(catalog.length, 300);
	assert.equal(catalog.slice(0, 256).some((entry) => entry.peerId === peers[299].peerId), true);
});

test('the native catalog retains every exact peer and prefers active records over duplicate pending enrollment', () => {
	const peers = Array.from({ length: 300 }, (_, index) => peer(index + 1));
	const first = peers[0];
	const catalog = incomingPeerCatalog(peers, [{
		...first, invitationId: uuid(900), expiresAt: 1234,
	}], []);
	assert.equal(catalog.length, 300);
	assert.equal(catalog.find((entry) => entry.peerId === first.peerId)?.state, 'active');
	assert.equal(new Set(catalog.map((entry) => entry.peerId)).size, 300);
	assert.equal(catalog[0].peerId, peers[299].peerId);
});
