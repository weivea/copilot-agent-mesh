import * as assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	encodeBase64Url,
	enrollmentProof,
	NONCE_BYTES,
	randomBase64Url,
	type EnrollmentTranscript,
} from '../gateway/PairingCrypto';
import {
	InMemoryPairingRecordStore,
	PairingService,
} from '../gateway/PairingService';
import {
	InMemorySecretStore,
	type SecretStore,
} from '../gateway/SecretStore';

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

	test('prunes persisted active-peer invitation cleanup state', async () => {
		const secrets = new InMemorySecretStore();
		const records = new InMemoryPairingRecordStore();
		await secrets.store('cleanup-secret', encodeBase64Url(Buffer.alloc(32, 1)));
		await records.storeInvitation({
			invitationId: 'cleanup-invitation',
			expiresAt: 1_000,
			secretKeyRef: 'cleanup-secret',
		});
		const pending = {
			enrollmentId: 'cleanup-enrollment',
			peerId: 'cleanup-peer',
			coordinatorDeviceId: 'coordinator',
			invitationId: 'cleanup-invitation',
			transcriptHash: encodeBase64Url(Buffer.alloc(32, 2)),
			rootKeyRef: 'cleanup-root',
			expiresAt: 1_000,
		};
		await records.storePending(pending);
		await records.commitPeer({
			peerId: pending.peerId,
			coordinatorDeviceId: pending.coordinatorDeviceId,
			rootKeyRef: pending.rootKeyRef,
			enrollmentId: pending.enrollmentId,
			transcriptHash: pending.transcriptHash,
			createdAt: 100,
			invitationSecretKeyRef: 'cleanup-secret',
			cleanupPending: true,
		}, pending);
		const pairing = new PairingService('worker', secrets, records);

		await pairing.createInvitation('https://worker.example');

		assert.equal(await secrets.get('cleanup-secret'), undefined);
		assert.equal((await records.getPeer('cleanup-peer'))?.cleanupPending, undefined);
	});

	test('rejects an async hello after its connection is disposed', async () => {
		const storedSecrets = new InMemorySecretStore();
		let releaseGet!: () => void;
		let markGetStarted!: () => void;
		const getStarted = new Promise<void>((resolve) => {
			markGetStarted = resolve;
		});
		const getGate = new Promise<void>((resolve) => {
			releaseGet = resolve;
		});
		const secrets: SecretStore = {
			store: (key, value) => storedSecrets.store(key, value),
			delete: (key) => storedSecrets.delete(key),
			get: async (key) => {
				markGetStarted();
				await getGate;
				return storedSecrets.get(key);
			},
		};
		const records = new InMemoryPairingRecordStore();
		const ids = ['invitation', 'session'];
		const pairing = new PairingService('worker', secrets, records, {
			id: () => ids.shift() ?? 'unexpected',
		});
		const invitation = await pairing.createInvitation('https://worker.example');
		pairing.registerConnection('closing-connection');
		const hello = pairing.hello('closing-connection', {
			protocolMin: 1,
			protocolMax: 1,
			coordinatorDeviceId: 'coordinator',
			clientNonce: randomBase64Url(NONCE_BYTES),
			invitationId: invitation.invitationId,
		});
		await getStarted;
		pairing.disposeConnection('closing-connection');
		releaseGet();

		await assert.rejects(hello, /connection is closed/u);
		await assert.rejects(
			pairing.authenticate('closing-connection', 'session', randomBase64Url(32)),
			/session is invalid/u,
		);
	});

	test('actively expires handshake sessions without relying on another request to prune', async () => {
		const now = 100;
		const secrets = new InMemorySecretStore();
		const records = new InMemoryPairingRecordStore();
		const ids = ['invitation', 'session'];
		const pairing = new PairingService('worker', secrets, records, {
			handshakeTtlMs: 10,
			now: () => now,
			id: () => ids.shift() ?? 'unexpected',
		});
		const invitation = await pairing.createInvitation('https://worker.example');
		pairing.registerConnection('ttl-connection');
		const secret = new URL(invitation.url).hash.slice('#secret='.length);
		const clientNonce = randomBase64Url(NONCE_BYTES);
		const hello = await pairing.hello('ttl-connection', {
			protocolMin: 1,
			protocolMax: 1,
			coordinatorDeviceId: 'coordinator',
			clientNonce,
			invitationId: invitation.invitationId,
		});
		const transcript: EnrollmentTranscript = {
			version: 1,
			invitationId: invitation.invitationId,
			workerDeviceId: 'worker',
			coordinatorDeviceId: 'coordinator',
			sessionId: String(hello.sessionId),
			clientNonce,
			serverNonce: String(hello.serverNonce),
		};
		await new Promise((resolve) => setTimeout(resolve, 20));

		await assert.rejects(
			pairing.authenticate(
				'ttl-connection',
				transcript.sessionId,
				encodeBase64Url(enrollmentProof(
					Buffer.from(secret, 'base64url'),
					'mesh/client-proof/v1',
					transcript,
				)),
			),
			/session is invalid/u,
		);
	});
});
