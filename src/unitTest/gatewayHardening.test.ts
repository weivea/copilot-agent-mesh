import * as assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	InMemoryPairingRecordStore,
	PairingService,
} from '../gateway/PairingService';
import { InMemorySecretStore } from '../gateway/SecretStore';

suite('Gateway hardening', () => {
	test('serializes invitation creation at the configured limit', async () => {
		const secrets = new InMemorySecretStore();
		const records = new InMemoryPairingRecordStore();
		const pairing = new PairingService('worker', secrets, records, {
			maxInvitations: 5,
		});

		const results = await Promise.allSettled(
			Array.from({ length: 6 }, () => pairing.createInvitation('https://worker.example')),
		);

		assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 5);
		assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
		assert.equal((await records.listInvitations()).length, 5);
	});

	test('prunes expired pending enrollment credentials', async () => {
		let now = 100;
		const secrets = new InMemorySecretStore();
		const records = new InMemoryPairingRecordStore();
		const pairing = new PairingService('worker', secrets, records, {
			now: () => now,
		});
		await secrets.store('expired-root', 'credential');
		await records.storePending({
			enrollmentId: 'expired-enrollment',
			peerId: 'expired-peer',
			coordinatorDeviceId: 'coordinator',
			invitationId: 'expired-invitation',
			transcriptHash: 'unused',
			rootKeyRef: 'expired-root',
			expiresAt: 200,
		});

		now = 201;
		await pairing.createInvitation('https://worker.example');

		assert.equal(await records.getPending('expired-enrollment'), undefined);
		assert.equal(await secrets.get('expired-root'), undefined);
	});
});
