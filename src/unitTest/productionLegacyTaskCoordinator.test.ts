import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { ProductionLegacyTaskCoordinator } from '../composition/ProductionLegacyTaskCoordinator';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import { ConnectivityMemoryState } from './connectivityTestSupport';
import { uuid } from './artifactStoreTestSupport';

test('native coordinator intents and dispatch cannot bypass saved-device admission denial', async () => {
	let denied = false;
	let requests = 0;
	const state = new ConnectivityMemoryState();
	const connection = {
		profileId: uuid(1), snapshot: () => ({ state: 'online' }),
		request: async () => { requests += 1; throw new Error('No remote task should be dispatched.'); },
	};
	const coordinator = new ProductionLegacyTaskCoordinator([
		{ get: () => connection, listConnections: () => [connection], isEnabled: () => true },
		new InMemoryPeerProfileStore(), state,
		new LocalDesktopWorkspaceGuard(() => ({ isTrusted: true, remoteName: undefined, workspaceFolders: [{ uriScheme: 'file' }] })),
		randomUUID, () => new Date(),
	], () => { if (denied) { throw new Error('Saved device denied.'); } });
	const input = {
		peerId: uuid(1), workspaceId: uuid(2), title: 'Native task', prompt: 'Do not execute',
		acceptanceCriteria: [],
	};
	const intent = await coordinator.persistDelegationIntent(input);
	denied = true;
	await assert.rejects(coordinator.waitForDelegationAcceptance(intent, new AbortController().signal));
	await assert.rejects(coordinator.persistDelegationIntent(input), /Saved device denied/u);
	assert.equal(requests, 0);
	assert.equal(coordinator.listKnownTasks().length, 1, 'The uncertain original intent remains in history.');

	let release!: () => void;
	let entered!: () => void;
	const reached = new Promise<void>((resolve) => { entered = resolve; });
	const paused = new Promise<void>((resolve) => { release = resolve; });
	denied = false;
	const barrier = coordinator.withAdmissionBarrier(async () => { entered(); await paused; denied = true; });
	await reached;
	const blocked = assert.rejects(coordinator.persistDelegationIntent(input), /Saved device denied/u);
	release();
	await Promise.all([barrier, blocked]);
	assert.equal(coordinator.listKnownTasks().length, 1);
});
