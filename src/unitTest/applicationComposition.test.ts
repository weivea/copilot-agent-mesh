import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { StructuredLogger } from '../logging/StructuredLogger';
import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import { TaskCoordinator } from '../application/TaskCoordinator';
import { InMemorySecretStore } from '../gateway/SecretStore';
import { PeerConnectionManager } from '../peer/PeerConnectionManager';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import {
	VscodeGlobalStateStore,
	VscodeSecretStore,
} from '../storage/VscodeStorageAdapters';
import {
	MESH_RUNTIME_TOOL_NAMES,
	verifyMeshToolManifestDescriptors,
} from '../tools/toolManifest';

test('extension entry point delegates activation and awaited deactivation to composition', () => {
	const source = readSource('src/extension.ts');
	assert.match(source, /createApplication\(context\)/);
	assert.match(source, /await current\?\.dispose\(\)/);
	assert.doesNotMatch(source, /registerCommand|registerTool|GatewayServer|AgentRuntime/);
});

test('composition uses global metadata, SecretStorage, and globalStorageUri without sync keys', () => {
	const source = readSource('src/composition/createApplication.ts');
	const runtime = readSource('src/composition/ProductionBrokerRuntime.ts');
	const allProductionSource = [
		source,
		runtime,
		readSource('src/storage/VscodeStorageAdapters.ts'),
	].join('\n');
	assert.match(source, /context\.globalState/);
	assert.match(source, /context\.secrets/);
	assert.match(source, /context\.globalStorageUri/);
	assert.match(
		source,
		/runtimeMode === 'development'\s*&& requestedE2eScenario === 'peerDelegation'\s*&& isE2eCapabilityEnabled\(e2eCapability\)\s*\?\s*peerDelegationRunContext/u,
	);
	assert.match(
		source,
		/new PeerDelegationE2eStateStore\(persistentState, peerDelegationRun\.nonce\)/u,
	);
	assert.match(
		source,
		/vscode\.Uri\.file\(join\(peerDelegationRun\.controlRoot, 'broker'\)\)/u,
	);
	assert.match(runtime, /options\.storageRootUri,\s*'mesh-state'/u);
	assert.doesNotMatch(source, /new PeerDelegationE2eStateStore\([^,]+,\s*process\.env/u);
	assert.doesNotMatch(allProductionSource, /setKeysForSync/);
});

test('production manifest contributes only the five registered task tools', () => {
	const manifest = JSON.parse(readSource('package.json')) as {
		readonly contributes: {
			readonly languageModelTools: readonly { readonly name: string }[];
		};
	};
	assert.equal(verifyMeshToolManifestDescriptors(manifest).integrated, true);
	assert.deepStrictEqual(
		manifest.contributes.languageModelTools.map(({ name }) => name),
		MESH_RUNTIME_TOOL_NAMES,
	);
	assert.ok(!readSource('src/composition/createApplication.ts').includes('mesh_spike_echo'));
});

test('delegation persistence keeps the raw prompt out of global metadata', async () => {
	const metadata = new Map<string, unknown>();
	const state = new VscodeGlobalStateStore({
		keys: () => [...metadata.keys()],
		get: <T>(key: string, fallback?: T): T | undefined =>
			(metadata.has(key) ? metadata.get(key) : fallback) as T | undefined,
		update: async (key: string, value: unknown) => {
			metadata.set(key, value);
		},
	});
	const profiles = new InMemoryPeerProfileStore();
	const ids = [
		'00000000-0000-4000-8000-000000000002',
		'00000000-0000-4000-8000-000000000005',
	];
	const peers = new PeerConnectionManager(
		'00000000-0000-4000-8000-000000000001',
		profiles,
		new InMemorySecretStore(),
		{ connect: async () => Promise.reject(new Error('not used')) },
	);
	const coordinator = new TaskCoordinator(
		peers,
		profiles,
		state,
		new LocalDesktopWorkspaceGuard(() => ({
			remoteName: undefined,
			isTrusted: true,
			workspaceFolders: [{ uriScheme: 'file' }],
		})),
		() => ids.shift()!,
		() => new Date('2026-08-25T00:00:00.000Z'),
	);
	await coordinator.persistDelegationIntent({
		peerId: '00000000-0000-4000-8000-000000000003',
		workspaceId: '00000000-0000-4000-8000-000000000004',
		title: 'Safe title',
		prompt: 'sensitive raw prompt',
		acceptanceCriteria: ['private criterion'],
	});
	const serialized = JSON.stringify(metadata.get('copilotAgentMesh.delegationIntents'));
	assert.doesNotMatch(serialized, /sensitive raw prompt|private criterion/);
	await peers.dispose();
});

test('VS Code adapters keep metadata and secrets on separate stores', async () => {
	const metadata = new Map<string, unknown>();
	const secretValues = new Map<string, string>();
	let secretWrites = 0;
	const state = new VscodeGlobalStateStore({
		keys: () => [...metadata.keys()],
		get: <T>(key: string, fallback?: T): T | undefined =>
			(metadata.has(key) ? metadata.get(key) : fallback) as T | undefined,
		update: async (key: string, value: unknown) => {
			metadata.set(key, value);
		},
	});
	const secrets = new VscodeSecretStore({
		keys: async () => [...secretValues.keys()],
		get: async (key: string) => secretValues.get(key),
		store: async (key: string, value: string) => {
			secretWrites += 1;
			secretValues.set(key, value);
		},
		delete: async (key: string) => {
			secretValues.delete(key);
		},
		onDidChange: () => ({ dispose: () => undefined }),
	});

	await state.update('copilotAgentMesh.deviceProfile', { deviceId: 'opaque' });
	await secrets.store('mesh.invitation.secret', 'sensitive');
	assert.deepStrictEqual(state.get('copilotAgentMesh.deviceProfile'), { deviceId: 'opaque' });
	assert.equal(metadata.has('mesh.invitation.secret'), false);
	assert.equal(await secrets.get('mesh.invitation.secret'), 'sensitive');
	assert.equal(secretWrites, 1);
});

test('structured logger redacts URL fragments, credentials, tokens, and local paths', () => {
	const lines: string[] = [];
	const logger = new StructuredLogger({
		name: 'test',
		append: () => undefined,
		appendLine: (line) => lines.push(line),
		replace: () => undefined,
		clear: () => undefined,
		show: () => undefined,
		hide: () => undefined,
		dispose: () => undefined,
	});
	logger.log(
		'error',
		'test',
		'authorization=Bearer-secret at https://example.test/connect?tkn=abc#secret and /Users/person/repo',
		{ proof: 'proof-secret', safe: 'visible' },
	);
	const output = lines.join('\n');
	assert.doesNotMatch(output, /Bearer-secret|abc|#secret|proof-secret|\/Users\/person\/repo/);
	assert.match(output, /\[redacted\]/);
	assert.match(output, /visible/);
});

function readSource(path: string): string {
	return readFileSync(resolve(__dirname, `../../../${path}`), 'utf8');
}
