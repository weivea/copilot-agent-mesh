import * as assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { suite, test } from 'node:test';

import WebSocket, { type RawData } from 'ws';

import { GatewayRouter, type TaskStartParams } from '../gateway/GatewayRouter';
import { GatewayServer } from '../gateway/GatewayServer';
import {
	decodeFixedBase64Url,
	derivePeerRoot,
	encodeBase64Url,
	enrollmentProof,
	enrollmentTranscriptHash,
	hmac,
	NONCE_BYTES,
	randomBase64Url,
	reconnectProof,
	type EnrollmentTranscript,
	type ReconnectTranscript,
} from '../gateway/PairingCrypto';
import {
	InMemoryPairingRecordStore,
	PairingService,
	type CreatedInvitation,
	type PairingRecordStore,
	type PeerRecord,
	type PendingPeerRecord,
} from '../gateway/PairingService';
import {
	InMemorySecretStore,
	type SecretStore,
} from '../gateway/SecretStore';
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import {
	InMemoryPeerProfileStore,
	type PeerProfileStore,
} from '../peer/PeerProfile';
import { WebSocketPeerTransport } from '../peer/WebSocketPeerTransport';
import {
	GATEWAY_METHODS,
	PROTOCOL_LIMITS,
	methodParamsSchemas,
	methodResultSchemas,
	utf8ByteLength,
} from '../../shared/protocol';

suite('Gateway pairing component', { concurrency: 1 }, () => {
	test('matches the production v2 enrollment, reconnect and numeric ping wire contract', async () => {
		const fixture = await createFixture();
		const first = await RawClient.open(fixture.endpoint);
		let second: RawClient | undefined;
		try {
			const enrollment = await pairAndCommit(first, await fixture.invitation(), 'wire-coordinator');
			const sentAt = Date.now();
			const pong = await contractRequest(first, 'mesh.ping', { sentAt });
			assert.equal((pong as { sentAt: number }).sentAt, sentAt);
			await assert.rejects(first.request('mesh.ping', { sentAt, unknown: true }));
			await assert.rejects(first.request('mesh.ping', { sentAt: new Date().toISOString() }));
			await first.close();
			second = await RawClient.open(fixture.endpoint);
			await reconnect(second, enrollment.peerId, enrollment.rootKey, 'wire-coordinator');
			await contractRequest(second, 'mesh.ping', { sentAt });
		} finally {
			await first.close();
			await second?.close();
			await fixture.dispose();
		}
	});

	test('serves an exact private health check and rejects other HTTP routes', async () => {
		const fixture = await createFixture();
		try {
			const health = await get(fixture.port, '/healthz');
			assert.equal(health.status, 204);
			assert.equal(health.body.byteLength, 0);
			const rejected = await get(fixture.port, '/anything');
			assert.equal(rejected.status, 404);
			assert.equal(rejected.body.byteLength, 0);
			assert.deepStrictEqual(fixture.address, { host: '127.0.0.1', port: fixture.port });
		} finally {
			await fixture.dispose();
		}
	});

	test('releases unauthenticated capacity after malformed upgrades', async () => {
		const fixture = await createFixture();
		try {
			for (let index = 0; index < 6; index += 1) {
				await malformedUpgrade(fixture.port);
			}
			const client = await RawClient.open(fixture.endpoint);
			await client.close();
		} finally {
			await fixture.dispose();
		}
	});

	test('dispose waits for an in-flight start and releases the selected port', async () => {
		const fixture = createGatewayDependencies();
		const gateway = new GatewayServer(fixture.pairing, fixture.router);
		const start = gateway.start();
		const dispose = gateway.dispose();
		const address = await start;
		await dispose;

		const probe = createHttpServer();
		try {
			await new Promise<void>((resolve, reject) => {
				probe.once('error', reject);
				probe.listen(address.port, '127.0.0.1', resolve);
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				probe.close((error) => error === undefined ? resolve() : reject(error));
			});
		}
	});

	test('pairs successfully, routes with peer ownership, and removes invitation secret', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const manager = fixture.manager();
		try {
			const connection = await manager.add(invitation.url);
			assert.equal(connection.snapshot().state, 'online');
			const result = await connection.request('device.getInfo', {});
			assert.deepStrictEqual(result, { deviceId: 'worker-device' });
			assert.equal(fixture.devicePeers.length, 1);
			assert.deepStrictEqual(
				await connection.request('task.get', { taskId: 'task-1', afterEventSeq: 2 }),
				{ peerId: fixture.devicePeers[0], taskId: 'task-1' },
			);
			await assert.rejects(connection.request('task.cancel', {
				taskId: 'task-1',
				peerId: 'attacker-controlled',
			}));
			const profile = await connection.profile();
			assert.ok(profile?.peerId);
			assert.ok(profile?.credentialKeyRef);
			assert.equal(profile?.pairingSecretKeyRef, undefined);
			assert.equal(profile?.invitationId, undefined);
			assert.equal(await fixture.records.getInvitation(invitation.invitationId), undefined);
			assert.doesNotMatch(JSON.stringify(profile), /secret=/u);
		} finally {
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('sends a schema-valid 640 KiB task snapshot and keeps the connection usable', async () => {
		const snapshot = largeTaskSnapshot();
		assert.equal(
			methodResultSchemas[GATEWAY_METHODS.taskGet].safeParse(snapshot).success,
			true,
		);
		const responseBytes = utf8ByteLength(JSON.stringify({
			jsonrpc: '2.0',
			id: '1',
			result: snapshot,
		}));
		assert.ok(responseBytes > 630 * 1024);
		assert.ok(responseBytes < PROTOCOL_LIMITS.frameBytes);

		const fixture = await createFixture({ taskGetResult: snapshot });
		const client = await RawClient.open(fixture.endpoint);
		try {
			await pairAndCommit(client, await fixture.invitation(), 'large-snapshot-coordinator');
			const received = await client.request('task.get', {
				taskId: snapshot.taskId,
			}) as typeof snapshot;
			assert.equal(received.events.length, snapshot.events.length);
			assert.equal(received.events.at(-1)?.summary, snapshot.events.at(-1)?.summary);
			assert.deepStrictEqual(
				await client.request('device.getInfo', {}),
				{ deviceId: 'worker-device' },
			);
			assert.equal(client.readyState, WebSocket.OPEN);
		} finally {
			await client.close();
			await fixture.dispose();
		}
	});

	test('closes deterministically when an outbound frame exceeds the protocol limit', async () => {
		const fixture = await createFixture({
			taskGetResult: { payload: 'x'.repeat(PROTOCOL_LIMITS.frameBytes) },
		});
		const client = await RawClient.open(fixture.endpoint);
		try {
			await pairAndCommit(client, await fixture.invitation(), 'oversized-frame-coordinator');
			const closed = client.closed();
			client.sendWithoutWaiting('task.get', { taskId: 'oversized-task' });
			assert.equal(await closed, 1009);
		} finally {
			await client.close();
			await fixture.dispose();
		}
	});

	test('rejects a valid-length wrong pairing secret without exposing it', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const url = new URL(invitation.url);
		const wrongSecret = randomBase64Url(32);
		url.hash = new URLSearchParams({ secret: wrongSecret }).toString();
		const manager = fixture.manager();
		try {
			await assert.rejects(
				manager.add(url.toString()),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.doesNotMatch(error.message, new RegExp(wrongSecret, 'u'));
					return true;
				},
			);
		} finally {
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('rejects nonce replay across sockets', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const nonce = randomBase64Url(NONCE_BYTES);
		const first = await RawClient.open(fixture.endpoint);
		const second = await RawClient.open(fixture.endpoint);
		try {
			const params = {
				protocolMin: 2,
				protocolMax: 2,
				coordinatorDeviceId: 'coordinator-device',
				clientNonce: nonce,
				invitationId: invitation.invitationId,
			};
			await first.request('mesh.hello', params);
			await assert.rejects(
				second.request('mesh.hello', params),
				(error: unknown) => rpcReason(error) === 'AUTH_FAILED',
			);
		} finally {
			await first.close();
			await second.close();
			await fixture.dispose();
		}
	});

	test('allows only one concurrent enrollment to consume an invitation', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const secret = secretFrom(invitation);
		const first = await RawClient.open(fixture.endpoint);
		const second = await RawClient.open(fixture.endpoint);
		try {
			const firstEnrollment = await beginEnrollment(first, invitation.invitationId, secret, 'first');
			const secondEnrollment = await beginEnrollment(second, invitation.invitationId, secret, 'second');
			await commitEnrollment(first, firstEnrollment);
			await assert.rejects(
				commitEnrollment(second, secondEnrollment),
				(error: unknown) => rpcReason(error) === 'AUTH_FAILED',
			);
		} finally {
			await first.close();
			await second.close();
			await fixture.dispose();
		}
	});

	test('recovers with the derived key when final commit acknowledgement is lost', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const secret = secretFrom(invitation);
		const client = await RawClient.open(fixture.endpoint);
		try {
			const enrollment = await beginEnrollment(
				client,
				invitation.invitationId,
				secret,
				'coordinator-device',
			);
			client.sendWithoutWaiting('mesh.enrollmentCommit', {
				sessionId: enrollment.transcript.sessionId,
				enrollmentId: enrollment.enrollmentId,
				peerId: enrollment.peerId,
				proof: encodeBase64Url(hmac(
					enrollment.rootKey,
					'mesh/enrollment-commit/v1',
					enrollment.enrollmentId,
					enrollment.transcriptHash,
				)),
			});

			await waitFor(async () => (
				await fixture.records.getPeer(enrollment.peerId)
			) !== undefined, 1_000);
			client.terminate();

			const reconnected = await RawClient.open(fixture.endpoint);
			try {
				await reconnect(
					reconnected,
					enrollment.peerId,
					enrollment.rootKey,
					'coordinator-device',
				);
				const info = await reconnected.request('device.getInfo', {});
				assert.deepStrictEqual(info, { deviceId: 'worker-device' });
			} finally {
				await reconnected.close();
			}
		} finally {
			client.terminate();
			await fixture.dispose();
		}
	});

	test('makes duplicate commits idempotent without deleting the active root', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const client = await RawClient.open(fixture.endpoint);
		try {
			const enrollment = await beginEnrollment(
				client,
				invitation.invitationId,
				secretFrom(invitation),
				'duplicate-commit-coordinator',
			);
			const params = {
				sessionId: enrollment.transcript.sessionId,
				enrollmentId: enrollment.enrollmentId,
				peerId: enrollment.peerId,
				proof: encodeBase64Url(hmac(
					enrollment.rootKey,
					'mesh/enrollment-commit/v1',
					enrollment.enrollmentId,
					enrollment.transcriptHash,
				)),
			};
			const [first, second] = await Promise.all([
				client.request('mesh.enrollmentCommit', params),
				client.request('mesh.enrollmentCommit', params),
			]);
			assert.deepStrictEqual(first, { committed: true, peerId: enrollment.peerId });
			assert.deepStrictEqual(second, { committed: true, peerId: enrollment.peerId });
			assert.ok(await fixture.secrets.get(`mesh.peer.${enrollment.peerId}`));
			assert.equal(
				(await fixture.records.getPeer(enrollment.peerId))?.rootKeyRef,
				`mesh.peer.${enrollment.peerId}`,
			);
		} finally {
			await client.close();
			await fixture.dispose();
		}
	});

	test('persists active cleanup state until an idempotent commit removes the invitation secret', async () => {
		const secrets = new FailOnceInvitationDeleteSecretStore();
		const fixture = await createFixture({ secrets });
		const invitation = await fixture.invitation();
		const client = await RawClient.open(fixture.endpoint);
		try {
			const enrollment = await beginEnrollment(
				client,
				invitation.invitationId,
				secretFrom(invitation),
				'cleanup-retry-coordinator',
			);
			const params = {
				sessionId: enrollment.transcript.sessionId,
				enrollmentId: enrollment.enrollmentId,
				peerId: enrollment.peerId,
				proof: encodeBase64Url(hmac(
					enrollment.rootKey,
					'mesh/enrollment-commit/v1',
					enrollment.enrollmentId,
					enrollment.transcriptHash,
				)),
			};
			await assert.rejects(client.request('mesh.enrollmentCommit', params));
			const pendingCleanup = await fixture.records.getPeer(enrollment.peerId);
			assert.equal(pendingCleanup?.cleanupPending, true);
			assert.equal(
				pendingCleanup?.invitationSecretKeyRef,
				`mesh.invitation.${invitation.invitationId}`,
			);
			assert.ok(await secrets.get(`mesh.invitation.${invitation.invitationId}`));

			assert.deepStrictEqual(
				await client.request('mesh.enrollmentCommit', {
					enrollmentId: enrollment.enrollmentId,
					peerId: enrollment.peerId,
					proof: params.proof,
				}),
				{ committed: true, peerId: enrollment.peerId },
			);
			const completed = await fixture.records.getPeer(enrollment.peerId);
			assert.equal(completed?.cleanupPending, undefined);
			assert.equal(completed?.invitationSecretKeyRef, undefined);
			assert.equal(
				await secrets.get(`mesh.invitation.${invitation.invitationId}`),
				undefined,
			);
		} finally {
			await client.close();
			await fixture.dispose();
		}
	});

	test('serializes expiry pruning with an in-flight commit and retains its active root', async () => {
		let now = 1_000;
		const records = new BlockingCommitRecordStore();
		const fixture = await createFixture({
			now: () => now,
			pendingTtlMs: 10,
			records,
		});
		const invitation = await fixture.invitation();
		const commitClient = await RawClient.open(fixture.endpoint);
		const pruneClient = await RawClient.open(fixture.endpoint);
		try {
			const enrollment = await beginEnrollment(
				commitClient,
				invitation.invitationId,
				secretFrom(invitation),
				'prune-race-coordinator',
			);
			now = 1_005;
			const commit = commitEnrollment(commitClient, enrollment);
			await records.commitStarted;
			now = 1_011;
			const prune = pruneClient.request('mesh.hello', {
				protocolMin: 2,
				protocolMax: 2,
				coordinatorDeviceId: 'prune-trigger',
				clientNonce: randomBase64Url(NONCE_BYTES),
				invitationId: 'missing-invitation',
			});
			await delay(10);
			records.releaseCommit();
			await commit;
			await assert.rejects(prune, (error: unknown) => rpcReason(error) === 'AUTH_FAILED');
			assert.ok(await fixture.secrets.get(`mesh.peer.${enrollment.peerId}`));
			assert.equal(
				(await fixture.records.getPeer(enrollment.peerId))?.rootKeyRef,
				`mesh.peer.${enrollment.peerId}`,
			);
		} finally {
			records.releaseCommit();
			await commitClient.close();
			await pruneClient.close();
			await fixture.dispose();
		}
	});

	test('rolls back a new add when enrollment commit is terminally rejected', async () => {
		const fixture = await createFixture({ rejectCommit: true });
		const profiles = new InMemoryPeerProfileStore();
		const manager = new PeerConnectionManager(
			'terminal-commit-coordinator',
			profiles,
			fixture.secrets,
			new WebSocketPeerTransport({
				requestTimeoutMs: 500,
				webSocketFactory: (url) => new WebSocket(url.replace(/^wss:/u, 'ws:')),
			}),
			{ id: () => 'terminal-commit-profile' },
		);
		try {
			const invitation = await fixture.invitation();
			await assert.rejects(
				manager.add(invitation.url),
				(error: unknown) => (
					error instanceof Error && error.message === 'Enrollment invitation was already consumed.'
				),
			);
			assert.deepStrictEqual(await profiles.list(), []);
			assert.equal(manager.get('terminal-commit-profile'), undefined);
			assert.equal(
				await fixture.secrets.get('mesh.remoteInvitation.terminal-commit-profile'),
				undefined,
			);
			assert.equal(
				await fixture.secrets.get('mesh.remotePeer.terminal-commit-profile'),
				undefined,
			);
			assert.equal(
				await fixture.secrets.get('mesh.remoteCommit.terminal-commit-profile'),
				undefined,
			);
		} finally {
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('retains the candidate root and retries until a delayed commit is confirmed', async () => {
		const fixture = await createFixture({ commitDelayMs: 80 });
		const profiles = new InMemoryPeerProfileStore();
		const transport = new WebSocketPeerTransport({
			requestTimeoutMs: 20,
			heartbeatIntervalMs: 25,
			webSocketFactory: (url) => new WebSocket(url.replace(/^wss:/u, 'ws:'), {
				perMessageDeflate: false,
			}),
		});
		const manager = new PeerConnectionManager(
			'delayed-coordinator',
			profiles,
			fixture.secrets,
			transport,
			{
				id: () => 'delayed-profile',
				random: () => 0.5,
				reconnectBaseMs: 10,
				reconnectMaxMs: 20,
				stableOnlineMs: 40,
			},
		);
		try {
			const invitation = await fixture.invitation();
			await assert.rejects(
				manager.add(invitation.url),
				(error: unknown) => error instanceof Error,
			);
			const candidate = await profiles.get('delayed-profile');
			assert.ok(candidate?.peerId);
			assert.ok(candidate?.credentialKeyRef);
			assert.ok(candidate?.pairingSecretKeyRef);
			assert.ok(
				await fixture.secrets.get(candidate.credentialKeyRef),
				'candidate root must not be removed after the first AUTH_FAILED',
			);
			await waitFor(
				() => manager.get('delayed-profile')?.snapshot().state === 'online',
				1_000,
			);
			const completed = await profiles.get('delayed-profile');
			assert.ok(completed?.credentialKeyRef);
			assert.equal(completed?.invitationId, undefined);
			assert.equal(completed?.pairingSecretKeyRef, undefined);
			assert.ok(await fixture.secrets.get(completed.credentialKeyRef));
		} finally {
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('re-sends a persisted commit that was never delivered', async () => {
		const fixture = await createFixture();
		const profiles = new InMemoryPeerProfileStore();
		const transport = new WebSocketPeerTransport({
			requestTimeoutMs: 20,
			heartbeatIntervalMs: 25,
			webSocketFactory: dropFirstRpcMethod('mesh.enrollmentCommit'),
		});
		const manager = new PeerConnectionManager(
			'undelivered-coordinator',
			profiles,
			fixture.secrets,
			transport,
			{
				id: () => 'undelivered-profile',
				random: () => 0.5,
				reconnectBaseMs: 10,
				reconnectMaxMs: 20,
				stableOnlineMs: 40,
			},
		);
		try {
			const invitation = await fixture.invitation();
			await assert.rejects(manager.add(invitation.url));
			const candidate = await profiles.get('undelivered-profile');
			assert.ok(candidate?.pendingEnrollmentId);
			assert.ok(candidate?.pendingCommitProofKeyRef);
			assert.ok(await fixture.secrets.get(candidate.pendingCommitProofKeyRef));

			await waitFor(
				() => manager.get('undelivered-profile')?.snapshot().state === 'online',
				1_000,
			);
			const completed = await profiles.get('undelivered-profile');
			assert.equal(completed?.pendingEnrollmentId, undefined);
			assert.equal(completed?.pendingCommitProofKeyRef, undefined);
			assert.ok(completed?.credentialKeyRef);
		} finally {
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('reconciles a candidate profile write that persisted before reporting failure', async () => {
		const fixture = await createFixture();
		const storedProfiles = new InMemoryPeerProfileStore();
		const profiles = new WriteThenThrowCandidateProfileStore(storedProfiles);
		const manager = new PeerConnectionManager(
			'profile-reconcile-coordinator',
			profiles,
			fixture.secrets,
			new WebSocketPeerTransport({
				requestTimeoutMs: 20,
				heartbeatIntervalMs: 25,
				webSocketFactory: dropFirstRpcMethod('mesh.enrollmentCommit'),
			}),
			{
				id: () => 'profile-reconcile',
				random: () => 0.5,
				reconnectBaseMs: 10,
				reconnectMaxMs: 20,
			},
		);
		try {
			const invitation = await fixture.invitation();
			await assert.rejects(manager.add(invitation.url));
			const candidate = await storedProfiles.get('profile-reconcile');
			assert.ok(candidate?.pendingEnrollmentId);
			assert.ok(candidate.credentialKeyRef);
			assert.ok(await fixture.secrets.get(candidate.credentialKeyRef));
			await waitFor(
				() => manager.get('profile-reconcile')?.snapshot().state === 'online',
				1_000,
			);
		} finally {
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('deletes candidate keys only after confirming the profile write did not persist', async () => {
		const fixture = await createFixture();
		const storedProfiles = new InMemoryPeerProfileStore();
		const profiles = new RejectCandidateProfileStore(storedProfiles);
		const manager = new PeerConnectionManager(
			'profile-reject-coordinator',
			profiles,
			fixture.secrets,
			new WebSocketPeerTransport({
				requestTimeoutMs: 500,
				webSocketFactory: (url) => new WebSocket(url.replace(/^wss:/u, 'ws:')),
			}),
			{
				id: () => 'profile-reject',
				random: () => 1,
				reconnectBaseMs: 60_000,
				reconnectMaxMs: 60_000,
			},
		);
		try {
			const invitation = await fixture.invitation();
			await assert.rejects(
				manager.add(invitation.url),
				(error: unknown) => error instanceof Error,
			);
			const previous = await storedProfiles.get('profile-reject');
			assert.equal(previous?.pendingEnrollmentId, undefined);
			assert.equal(
				await fixture.secrets.get('mesh.remotePeer.profile-reject'),
				undefined,
			);
			assert.equal(
				await fixture.secrets.get('mesh.remoteCommit.profile-reject'),
				undefined,
			);
		} finally {
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('lets the worker authoritatively expire pending commits despite coordinator clock skew', async () => {
		const fixture = await createFixture();
		const profiles = new InMemoryPeerProfileStore();
		const transport = new WebSocketPeerTransport({
			requestTimeoutMs: 20,
			heartbeatIntervalMs: 25,
			now: () => Date.now() + 24 * 60 * 60_000,
			webSocketFactory: dropFirstRpcMethod('mesh.enrollmentCommit'),
		});
		const manager = new PeerConnectionManager(
			'skewed-clock-coordinator',
			profiles,
			fixture.secrets,
			transport,
			{
				id: () => 'skewed-clock-profile',
				random: () => 0.5,
				reconnectBaseMs: 10,
				reconnectMaxMs: 20,
			},
		);
		try {
			const invitation = await fixture.invitation();
			await assert.rejects(manager.add(invitation.url));
			await waitFor(
				() => manager.get('skewed-clock-profile')?.snapshot().state === 'online',
				1_000,
			);
		} finally {
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('does not rewrite a durable profile during ordinary authenticated reconnect', async () => {
		const fixture = await createFixture();
		const profiles = new InMemoryPeerProfileStore();
		const transport = new WebSocketPeerTransport({
			requestTimeoutMs: 500,
			heartbeatIntervalMs: 25,
			webSocketFactory: (url) => new WebSocket(url.replace(/^wss:/u, 'ws:')),
		});
		const manager = new PeerConnectionManager(
			'read-only-profile-coordinator',
			profiles,
			fixture.secrets,
			transport,
			{ id: () => 'read-only-profile' },
		);
		let session: Awaited<ReturnType<WebSocketPeerTransport['connect']>> | undefined;
		try {
			const invitation = await fixture.invitation();
			await manager.add(invitation.url);
			await manager.disconnect('read-only-profile');
			const profile = await profiles.get('read-only-profile');
			assert.ok(profile);
			const readOnlyProfiles: PeerProfileStore = {
				get: (id) => profiles.get(id),
				list: () => profiles.list(),
				store: async () => {
					throw new Error('An ordinary reconnect must not rewrite the profile.');
				},
				delete: (id) => profiles.delete(id),
			};
			session = await transport.connect(
				profile,
				'read-only-profile-coordinator',
				fixture.secrets,
				readOnlyProfiles,
				new AbortController().signal,
			);
			assert.equal(session.profile.id, 'read-only-profile');
		} finally {
			await session?.close();
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('surfaces re-pairing after pending enrollment expires without deleting the candidate root', async () => {
		const fixture = await createFixture({ pendingTtlMs: 25 });
		const profiles = new InMemoryPeerProfileStore();
		const transport = new WebSocketPeerTransport({
			requestTimeoutMs: 10,
			heartbeatIntervalMs: 25,
			webSocketFactory: dropFirstRpcMethod('mesh.enrollmentCommit'),
		});
		const manager = new PeerConnectionManager(
			'expired-coordinator',
			profiles,
			fixture.secrets,
			transport,
			{
				id: () => 'expired-profile',
				random: () => 1,
				reconnectBaseMs: 40,
				reconnectMaxMs: 40,
				stableOnlineMs: 40,
			},
		);
		try {
			const invitation = await fixture.invitation();
			await assert.rejects(manager.add(invitation.url));
			await waitFor(
				() => manager.get('expired-profile')?.snapshot().state === 'rePairRequired',
				1_000,
			);
			const candidate = await profiles.get('expired-profile');
			assert.ok(candidate?.credentialKeyRef);
			assert.ok(await fixture.secrets.get(candidate.credentialKeyRef));
			assert.ok(candidate.pendingCommitProofKeyRef);
			assert.ok(await fixture.secrets.get(candidate.pendingCommitProofKeyRef));
		} finally {
			await manager.dispose();
			await fixture.dispose();
		}
	});

	test('rejects incompatible protocol, binary frames, batches, and oversized frames', async () => {
		const fixture = await createFixture();
		try {
			const protocol = await RawClient.open(fixture.endpoint);
			const protocolClose = protocol.closed();
			await assert.rejects(
				protocol.request('mesh.hello', {
					protocolMin: 1,
					protocolMax: 1,
					coordinatorDeviceId: 'coordinator-device',
					clientNonce: randomBase64Url(NONCE_BYTES),
					invitationId: 'unused',
				}),
				(error: unknown) => rpcReason(error) === 'PROTOCOL_INCOMPATIBLE',
			);
			assert.equal(await protocolClose, 1002);

			const binary = await RawClient.open(fixture.endpoint);
			const binaryClose = binary.closed();
			binary.sendBinary(Buffer.from('{}'));
			assert.equal(await binaryClose, 1003);

			const batch = await RawClient.open(fixture.endpoint);
			try {
				const response = await batch.sendRawAndReceive('[]');
				assert.equal((response.error as { code: number }).code, -32600);
			} finally {
				await batch.close();
			}

			const oversized = await RawClient.open(fixture.endpoint);
			const oversizedClose = oversized.closed();
			oversized.sendRaw(JSON.stringify({
				jsonrpc: '2.0',
				id: 'large',
				method: 'mesh.hello',
				params: { padding: 'x'.repeat(65 * 1024) },
			}));
			assert.equal(await oversizedClose, 1009);
		} finally {
			await fixture.dispose();
		}
	});

	test('keeps pong-capable peers alive and terminates a peer that does not pong', async () => {
		const fixture = await createFixture({
			heartbeatIntervalMs: 15,
			heartbeatTimeoutMs: 45,
		});
		const firstInvitation = await fixture.invitation();
		const healthy = await RawClient.open(fixture.endpoint);
		try {
			await pairAndCommit(healthy, firstInvitation, 'healthy-coordinator');
			await delay(90);
			assert.equal(healthy.readyState, WebSocket.OPEN);

			const secondInvitation = await fixture.invitation();
			const silent = await RawClient.open(fixture.endpoint, false);
			try {
				await pairAndCommit(silent, secondInvitation, 'silent-coordinator');
				const close = silent.closed();
				assert.notEqual(await close, 1000);
			} finally {
				silent.terminate();
			}
		} finally {
			await healthy.close();
			await fixture.dispose();
		}
	});

	test('automatically reconnects after gateway restart and disposes all resources', async () => {
		const fixture = await createFixture();
		const invitation = await fixture.invitation();
		const manager = fixture.manager({
			reconnectBaseMs: 10,
			reconnectMaxMs: 20,
			stableOnlineMs: 40,
		});
		let restarted: GatewayServer | undefined;
		try {
			const connection = await manager.add(invitation.url);
			assert.equal(connection.snapshot().state, 'online');
			await fixture.gateway.dispose();
			await waitFor(
				() => connection.snapshot().state === 'offline',
				1_000,
			);
			restarted = fixture.newGateway();
			await restarted.start(fixture.port);
			await waitFor(
				() => connection.snapshot().state === 'online',
				2_000,
			);
			assert.deepStrictEqual(
				await connection.request('workspace.list', {}),
				[{ workspaceId: 'workspace-1' }],
			);
			await manager.dispose();
			assert.equal(connection.snapshot().state, 'offline');
			await restarted.dispose();
			restarted = undefined;
			await assert.rejects(connectSocket(fixture.endpoint));
		} finally {
			await manager.dispose();
			await restarted?.dispose();
			await fixture.dispose();
		}
	});
});

interface FixtureOptions {
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatTimeoutMs?: number;
	readonly commitDelayMs?: number;
	readonly pendingTtlMs?: number;
	readonly rejectCommit?: boolean;
	readonly records?: PairingRecordStore;
	readonly secrets?: SecretStore;
	readonly now?: () => number;
	readonly taskGetResult?: unknown;
}

async function createFixture(options: FixtureOptions = {}) {
	const dependencies = createGatewayDependencies(options);
	const {
		secrets,
		records,
		pairing,
		devicePeers,
		taskPeers,
		router,
	} = dependencies;
	const gatewayOptions = {
		handshakeTimeoutMs: 500,
		heartbeatIntervalMs: options.heartbeatIntervalMs ?? 100,
		heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 300,
	};
	const newGateway = (): GatewayServer => new GatewayServer(pairing, router, gatewayOptions);
	const gateway = newGateway();
	const address = await gateway.start();
	const endpoint = `ws://127.0.0.1:${address.port}/agent-mesh/rpc`;
	const managers = new Set<PeerConnectionManager>();
	const manager = (managerOptions: {
		reconnectBaseMs?: number;
		reconnectMaxMs?: number;
		stableOnlineMs?: number;
	} = {}): PeerConnectionManager => {
		const profiles = new InMemoryPeerProfileStore();
		const transport = new WebSocketPeerTransport({
			requestTimeoutMs: 500,
			heartbeatIntervalMs: 25,
			webSocketFactory: (url) => new WebSocket(url.replace(/^wss:/u, 'ws:'), {
				perMessageDeflate: false,
			}),
		});
		const result = new PeerConnectionManager(
			'coordinator-device',
			profiles,
			secrets,
			transport,
			{ random: () => 0.5, ...managerOptions },
		);
		managers.add(result);
		return result;
	};
	return {
		address,
		port: address.port,
		endpoint,
		gateway,
		newGateway,
		records,
		secrets,
		devicePeers,
		taskPeers,
		manager,
		invitation: () => pairing.createInvitation(`https://127.0.0.1:${address.port}`),
		dispose: async () => {
			await Promise.all([...managers].map((value) => value.dispose()));
			await gateway.dispose();
		},
	};
}

function createGatewayDependencies(options: FixtureOptions = {}) {
	const secrets = options.secrets ?? new InMemorySecretStore();
	const records = options.records
		?? (options.rejectCommit === true
			? new RejectingCommitRecordStore()
			: options.commitDelayMs === undefined
				? new InMemoryPairingRecordStore()
				: new DelayedPendingRecordStore(options.commitDelayMs));
	const pairing = new PairingService('worker-device', secrets, records, {
		pendingTtlMs: options.pendingTtlMs,
		now: options.now,
	});
	const devicePeers: string[] = [];
	const taskPeers: string[] = [];
	const router = new GatewayRouter(
		{
			getInfo: async (peerId) => {
				devicePeers.push(peerId);
				return { deviceId: 'worker-device' };
			},
		},
		{ list: async () => [{ workspaceId: 'workspace-1' }] },
		{
			start: async (peerId: string, params: TaskStartParams) => {
				taskPeers.push(peerId);
				return params;
			},
			get: async (peerId, taskId) => options.taskGetResult ?? { peerId, taskId },
			cancel: async (peerId, taskId) => ({ peerId, taskId }),
			answer: async (peerId, taskId) => ({ peerId, taskId }),
		},
	);
	return {
		records,
		secrets,
		pairing,
		router,
		devicePeers,
		taskPeers,
	};
}

function largeTaskSnapshot() {
	const at = '2026-08-25T09:00:00.000Z';
	const events = Array.from({ length: 40 }, (_, index) => ({
		eventSeq: index + 1,
		at,
		type: 'output',
		summary: 'x'.repeat(index === 39 ? 12_000 : PROTOCOL_LIMITS.outputEventBytes),
	}));
	return {
		schemaVersion: 1 as const,
		taskId: '11111111-1111-4111-8111-111111111111',
		delegationRequestId: '22222222-2222-4222-8222-222222222222',
		requestHash: 'a'.repeat(64),
		peerId: '33333333-3333-4333-8333-333333333333',
		workspaceId: '44444444-4444-4444-8444-444444444444',
		title: 'Large journal task',
		state: 'completed' as const,
		createdAt: at,
		updatedAt: at,
		eventSeq: events.length,
		workerDeadline: '2026-08-25T10:00:00.000Z',
		summary: 'Completed',
		events,
		eventsTruncated: false,
		deviceId: '55555555-5555-4555-8555-555555555555',
	};
}

class DelayedPendingRecordStore extends InMemoryPairingRecordStore {
	public constructor(private readonly delayMs: number) {
		super();
	}

	public override async getPending(
		id: string,
	): Promise<Awaited<ReturnType<InMemoryPairingRecordStore['getPending']>>> {
		await delay(this.delayMs);
		return super.getPending(id);
	}
}

class RejectingCommitRecordStore extends InMemoryPairingRecordStore {
	public override async commitPeer(): Promise<boolean> {
		return false;
	}
}

class BlockingCommitRecordStore extends InMemoryPairingRecordStore {
	private markCommitStarted!: () => void;
	private unblockCommit!: () => void;
	private released = false;
	public readonly commitStarted = new Promise<void>((resolve) => {
		this.markCommitStarted = resolve;
	});
	private readonly commitGate = new Promise<void>((resolve) => {
		this.unblockCommit = resolve;
	});

	public releaseCommit(): void {
		if (!this.released) {
			this.released = true;
			this.unblockCommit();
		}
	}

	public override async commitPeer(
		record: PeerRecord,
		pending: PendingPeerRecord,
	): Promise<boolean> {
		this.markCommitStarted();
		await this.commitGate;
		return super.commitPeer(record, pending);
	}
}

class FailOnceInvitationDeleteSecretStore extends InMemorySecretStore {
	private failed = false;

	public override async delete(key: string): Promise<void> {
		if (!this.failed && key.startsWith('mesh.invitation.')) {
			this.failed = true;
			throw new Error('Injected invitation secret deletion failure.');
		}
		await super.delete(key);
	}
}

class WriteThenThrowCandidateProfileStore implements PeerProfileStore {
	private failed = false;

	public constructor(private readonly delegate: InMemoryPeerProfileStore) {}

	public get(id: string) {
		return this.delegate.get(id);
	}
	public list() {
		return this.delegate.list();
	}
	public delete(id: string) {
		return this.delegate.delete(id);
	}
	public async store(profile: Parameters<PeerProfileStore['store']>[0]): Promise<void> {
		await this.delegate.store(profile);
		if (!this.failed && profile.pendingEnrollmentId !== undefined) {
			this.failed = true;
			throw new Error('Candidate write result was unknown.');
		}
	}
}

class RejectCandidateProfileStore implements PeerProfileStore {
	public constructor(private readonly delegate: InMemoryPeerProfileStore) {}

	public get(id: string) {
		return this.delegate.get(id);
	}
	public list() {
		return this.delegate.list();
	}
	public delete(id: string) {
		return this.delegate.delete(id);
	}
	public async store(profile: Parameters<PeerProfileStore['store']>[0]): Promise<void> {
		if (profile.pendingEnrollmentId !== undefined) {
			throw new Error('Candidate write failed.');
		}
		await this.delegate.store(profile);
	}
}

function malformedUpgrade(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connectTcp(port, '127.0.0.1');
		socket.once('error', reject);
		socket.once('close', () => resolve());
		socket.once('data', () => socket.destroy());
		socket.once('connect', () => {
			socket.write(
				'GET /agent-mesh/rpc HTTP/1.1\r\n'
				+ 'Host: 127.0.0.1\r\n'
				+ 'Connection: Upgrade\r\n'
				+ 'Upgrade: websocket\r\n'
				+ 'Sec-WebSocket-Version: 13\r\n'
				+ 'Sec-WebSocket-Key: invalid\r\n\r\n',
			);
		});
	});
}

function dropFirstRpcMethod(method: string): (url: string) => WebSocket {
	let dropped = false;
	return (url) => {
		const socket = new WebSocket(url.replace(/^wss:/u, 'ws:'), {
			perMessageDeflate: false,
		});
		const send = socket.send;
		socket.send = ((data: WebSocket.Data, ...args: unknown[]) => {
			let request: { method?: unknown } | undefined;
			try {
				request = JSON.parse(String(data)) as { method?: unknown };
			} catch {
				// The real transport handles invalid JSON; this hook only identifies one request.
			}
			if (!dropped && request?.method === method) {
				dropped = true;
				const lastArgument = args.at(-1);
				const callback = typeof lastArgument === 'function'
					? lastArgument as (error?: Error) => void
					: undefined;
				queueMicrotask(() => callback?.());
				return;
			}
			Reflect.apply(send, socket, [data, ...args]);
		}) as WebSocket['send'];
		return socket;
	};
}

interface Enrollment {
	readonly transcript: EnrollmentTranscript;
	readonly transcriptHash: Buffer;
	readonly rootKey: Buffer;
	readonly enrollmentId: string;
	readonly peerId: string;
}

async function beginEnrollment(
	client: RawClient,
	invitationId: string,
	secret: Buffer,
	coordinatorDeviceId: string,
): Promise<Enrollment> {
	const clientNonce = randomBase64Url(NONCE_BYTES);
	const hello = await contractRequest(client, 'mesh.hello', {
		protocolMin: 2,
		protocolMax: 2,
		coordinatorDeviceId,
		clientNonce,
		invitationId,
	}) as Record<string, string | number>;
	const transcript: EnrollmentTranscript = {
		version: 2,
		invitationId,
		workerDeviceId: String(hello.workerDeviceId),
		coordinatorDeviceId,
		sessionId: String(hello.sessionId),
		clientNonce,
		serverNonce: String(hello.serverNonce),
	};
	assert.deepStrictEqual(
		decodeFixedBase64Url(hello.serverProof, 32, 'server proof'),
		enrollmentProof(secret, 'mesh/server-proof/v1', transcript),
	);
	const authenticated = await contractRequest(client, 'mesh.authenticate', {
		sessionId: transcript.sessionId,
		proof: encodeBase64Url(enrollmentProof(secret, 'mesh/client-proof/v1', transcript)),
	}) as Record<string, string>;
	return {
		transcript,
		transcriptHash: enrollmentTranscriptHash(transcript),
		rootKey: derivePeerRoot(secret, transcript),
		enrollmentId: authenticated.enrollmentId,
		peerId: authenticated.peerId,
	};
}

async function pairAndCommit(
	client: RawClient,
	invitation: CreatedInvitation,
	coordinatorDeviceId: string,
): Promise<Enrollment> {
	const enrollment = await beginEnrollment(
		client,
		invitation.invitationId,
		secretFrom(invitation),
		coordinatorDeviceId,
	);
	await commitEnrollment(client, enrollment);
	return enrollment;
}

async function commitEnrollment(client: RawClient, enrollment: Enrollment): Promise<void> {
	await contractRequest(client, 'mesh.enrollmentCommit', {
		sessionId: enrollment.transcript.sessionId,
		enrollmentId: enrollment.enrollmentId,
		peerId: enrollment.peerId,
		proof: encodeBase64Url(hmac(
			enrollment.rootKey,
			'mesh/enrollment-commit/v1',
			enrollment.enrollmentId,
			enrollment.transcriptHash,
		)),
	});
}

async function reconnect(
	client: RawClient,
	peerId: string,
	rootKey: Buffer,
	coordinatorDeviceId: string,
): Promise<void> {
	const clientNonce = randomBase64Url(NONCE_BYTES);
	const hello = await contractRequest(client, 'mesh.hello', {
		protocolMin: 2,
		protocolMax: 2,
		coordinatorDeviceId,
		clientNonce,
		peerId,
	}) as Record<string, string | number>;
	const transcript: ReconnectTranscript = {
		version: 2,
		peerId,
		workerDeviceId: String(hello.workerDeviceId),
		coordinatorDeviceId,
		sessionId: String(hello.sessionId),
		clientNonce,
		serverNonce: String(hello.serverNonce),
	};
	assert.deepStrictEqual(
		decodeFixedBase64Url(hello.serverProof, 32, 'server proof'),
		reconnectProof(rootKey, 'mesh/reconnect-server-proof/v1', transcript),
	);
	await contractRequest(client, 'mesh.authenticate', {
		sessionId: transcript.sessionId,
		proof: encodeBase64Url(reconnectProof(
			rootKey,
			'mesh/reconnect-client-proof/v1',
			transcript,
		)),
	});
}

async function contractRequest(
	client: RawClient,
	method: 'mesh.hello' | 'mesh.authenticate' | 'mesh.enrollmentCommit' | 'mesh.ping',
	params: Record<string, unknown>,
): Promise<unknown> {
	methodParamsSchemas[method].parse(params);
	const result = await client.request(method, params);
	methodResultSchemas[method].parse(result);
	return result;
}

class RawClient {
	private nextId = 0;
	private readonly responses: Array<(value: Record<string, unknown>) => void> = [];
	private readonly closeWaiters: Array<(code: number) => void> = [];
	private lastCloseCode: number | undefined;

	private constructor(private readonly socket: WebSocket) {
		socket.on('message', (data, isBinary) => {
			if (isBinary) {
				return;
			}
			const response = JSON.parse(rawBuffer(data).toString('utf8')) as Record<string, unknown>;
			this.responses.shift()?.(response);
		});
		socket.on('close', (code) => {
			this.lastCloseCode = code;
			for (const waiter of this.closeWaiters.splice(0)) {
				waiter(code);
			}
		});
	}

	public static async open(endpoint: string, autoPong = true): Promise<RawClient> {
		const socket = new WebSocket(endpoint, { autoPong, perMessageDeflate: false });
		await new Promise<void>((resolve, reject) => {
			socket.once('open', () => resolve());
			socket.once('error', reject);
		});
		return new RawClient(socket);
	}

	public get readyState(): number {
		return this.socket.readyState;
	}

	public request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = String(++this.nextId);
		return new Promise((resolve, reject) => {
			this.responses.push((response) => {
				if (response.error !== undefined) {
					const error = response.error as { message: string; data?: { reason?: string } };
					reject(Object.assign(new Error(error.message), { reason: error.data?.reason }));
				} else {
					resolve(response.result);
				}
			});
			this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		});
	}

	public sendWithoutWaiting(method: string, params: Record<string, unknown>): void {
		this.socket.send(JSON.stringify({
			jsonrpc: '2.0',
			id: String(++this.nextId),
			method,
			params,
		}));
	}

	public sendRaw(value: string): void {
		this.socket.send(value);
	}

	public sendBinary(value: Buffer): void {
		this.socket.send(value, { binary: true });
	}

	public sendRawAndReceive(value: string): Promise<Record<string, unknown>> {
		return new Promise((resolve) => {
			this.responses.push(resolve);
			this.socket.send(value);
		});
	}

	public closed(): Promise<number> {
		if (this.lastCloseCode !== undefined) {
			return Promise.resolve(this.lastCloseCode);
		}
		return new Promise((resolve) => this.closeWaiters.push(resolve));
	}

	public terminate(): void {
		this.socket.terminate();
	}

	public async close(): Promise<void> {
		if (this.socket.readyState === WebSocket.CLOSED) {
			return;
		}
		const closed = this.closed();
		this.socket.close();
		await closed;
	}
}

function secretFrom(invitation: CreatedInvitation): Buffer {
	return decodeFixedBase64Url(
		new URL(invitation.url).hash.slice('#secret='.length),
		32,
		'secret',
	);
}

function rpcReason(error: unknown): string | undefined {
	return error instanceof Error && 'reason' in error
		? String(error.reason)
		: undefined;
}

function rawBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data);
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data);
	}
	throw new Error('Unsupported WebSocket data.');
}

function get(port: number, path: string): Promise<{ status: number; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest({
			host: '127.0.0.1',
			port,
			path,
			method: 'GET',
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({
				status: response.statusCode ?? 0,
				body: Buffer.concat(chunks),
			}));
		});
		request.once('error', reject);
		request.end();
	});
}

function connectSocket(endpoint: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(endpoint);
		socket.once('open', () => {
			socket.close();
			resolve();
		});
		socket.once('error', reject);
	});
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!await predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for component state.');
		}
		await delay(5);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
