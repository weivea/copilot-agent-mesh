import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCodeCliVersion } from '../agentHost/CodeCliVersion';
import { AgentHostLauncher, discoverCodeCli } from '../agentHost/AgentHostLauncher';
import { CodespaceOwnedAgentRuntime } from '../agentHost/CodespaceOwnedAgentRuntime';
import { OwnedCommandError } from '../spikes/ownedProcess';

const commit = '88e44fa0e00b08f7758b4f6d05632e4fd5e4df6f';

test('native CLI banners and desktop CLI triples report the same version without inventing an architecture', () => {
	for (const [name, version] of [
		['code', '1.136.2'],
		['code-insiders', '1.137.0-insider'],
		['code-oss', '1.136.2'],
		['code-exploration', '1.137.0'],
	]) {
		for (const newline of ['', '\n', '\r\n']) {
			const parsed = parseCodeCliVersion(`${name} ${version} (commit ${commit})${newline}`);
			assert.deepEqual(parsed, { version, commit });
			assert.equal(Object.hasOwn(parsed!, 'architecture'), false);
		}
	}
	for (const newline of ['\n', '\r\n']) {
		assert.deepEqual(parseCodeCliVersion(['1.136.2', commit, 'arm64', ''].join(newline)),
			{ version: '1.136.2', commit, architecture: 'arm64' });
	}
});

test('CLI version parsing does not accept arbitrary stdout or incomplete native releases', () => {
	for (const output of [
		'', 'code', '1.136.2', 'code dev (commit unknown)', `code 1.136.2 (commit short)`,
		`unexpected 1.136.2 (commit ${commit})`,
		`code 1.136.2 (commit ${commit})\nextra output`,
		`code 1.136.2 (commit ${commit}) extra`,
		`1.136.2\n${commit}`, `1.136.2\n${commit}\nx64\nextra`,
		'error\ncould not start\nretry later', `1.136.2\n${commit}\n/private/path`,
	]) {
		assert.equal(parseCodeCliVersion(output), undefined, output);
	}
});

test('native CLI discovery accepts the actual one-line format before starting any Host', async () => {
	const observed: string[][] = [];
	const native = await discoverCodeCli('native-code-fixture', undefined, async (_executable, args) => {
		observed.push([...args]);
		return `code 1.136.2 (commit ${commit})\n`;
	});
	assert.deepEqual(native, { executable: 'native-code-fixture', version: '1.136.2', commit });
	assert.deepEqual(observed, [['--version']]);
});

test('native version discovery cannot hide cancellation or owned cleanup failures', async () => {
	const controller = new AbortController();
	await assert.rejects(discoverCodeCli('native-code-fixture', controller.signal, async () => {
		controller.abort();
		return `code 1.136.2 (commit ${commit})\n`;
	}), { code: 'AGENT_UNAVAILABLE' });
	const cleanup = new OwnedCommandError('Fixture cleanup failure.', 123, true);
	await assert.rejects(discoverCodeCli('native-code-fixture', undefined, async () => { throw cleanup; }),
		(error) => error === cleanup);
});

test('Codespaces execution readiness uses the real launcher parser instead of a successful fake probe', async () => {
	const observed: string[][] = [];
	let authentications = 0;
	let hostConnections = 0;
	const launcher = new AgentHostLauncher({
		storageRoot: 'not-created-by-probe', configuredCodeCli: 'native-code-fixture',
	}, {
		assertProcessControlSupported() {},
		runCommand: async (_executable, args) => {
			observed.push([...args]);
			assert.deepEqual(args, ['--version']);
			return `code 1.136.2 (commit ${commit})\n`;
		},
	});
	const runtime = new CodespaceOwnedAgentRuntime({
		enabled: () => true,
		launcher,
		workspaceResolver: { resolve: async () => undefined },
		confirmation: { confirm: async () => 'deny' },
		authBroker: { authenticate: async () => { authentications += 1; } },
		connections: { connect: async () => {
			hostConnections += 1;
			throw new Error('Readiness must not start a Host.');
		} },
	});
	try {
		assert.deepEqual(await runtime.probe(), {
			available: true, featureEnabled: true, version: '1.136.2', source: 'codespace-owned', reason: undefined,
		});
		assert.deepEqual(runtime.sourceStatus(), { source: 'codespace-owned', degraded: false });
		assert.deepEqual(observed, [['--version']]);
		assert.equal(authentications, 0);
		assert.equal(hostConnections, 0);
	} finally { await runtime.dispose(); }
});
