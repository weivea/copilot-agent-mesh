import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { AgentHostLauncher, type AgentHostLauncherLike } from '../agentHost/AgentHostLauncher';
import { ConfiguredCodespaceLauncher } from '../codespaces/ConfiguredCodespaceLauncher';

test('missing native runtime probes unavailable and fails explicitly without a fallback CLI', async () => {
	let created = 0;
	const launcher = new ConfiguredCodespaceLauncher(async () => undefined, resolve('test-runtime'), () => {
		created += 1;
		throw new Error('Must not create a fallback.');
	});
	assert.deepEqual(await launcher.probe(), { available: false });
	await assert.rejects(launcher.launch(), { code: 'AGENT_CONFIG_REQUIRED' });
	assert.equal(created, 0);
	await launcher.dispose();
});

test('configured native launcher is shared and executable replacement is fenced', async () => {
	let path = resolve('native-code');
	let created = 0;
	let launches = 0;
	let disposals = 0;
	const underlying: AgentHostLauncherLike = {
		probe: async () => ({ available: true, version: 'test' }),
		launch: async () => {
			launches += 1;
			return {
				endpoint: new URL('ws://127.0.0.1:1'), version: 'test', registryProtocolVersion: '1.0.0',
				onExit: () => ({ dispose() {} }), dispose: async () => {},
			};
		},
		dispose: async () => { disposals += 1; },
	};
	const launcher = new ConfiguredCodespaceLauncher(async () => path, resolve('private-root'), () => {
		created += 1;
		return underlying;
	});
	await launcher.probe();
	await launcher.launch();
	await launcher.launch();
	assert.equal(created, 1);
	assert.equal(launches, 2);
	path = resolve('different-code');
	await assert.rejects(launcher.launch(), { code: 'TASK_RECOVERY_UNAVAILABLE' });
	assert.equal(launches, 2);
	await launcher.dispose();
	assert.equal(disposals, 1);
	await assert.rejects(launcher.launch(), { code: 'AGENT_UNAVAILABLE' });
});

test('configuration and shutdown failures cannot silently start another process', async () => {
	const relative = new ConfiguredCodespaceLauncher(async () => 'relative-code', resolve('private-root'));
	await assert.rejects(relative.launch(), { code: 'AGENT_CONFIG_REQUIRED' });
	await relative.dispose();
	let finish!: (value: string) => void;
	let created = false;
	const launcher = new ConfiguredCodespaceLauncher(() => new Promise((resolvePath) => { finish = resolvePath; }),
		resolve('private-root'), () => { created = true; throw new Error('Not reached.'); });
	const probing = launcher.probe();
	await launcher.dispose();
	finish(resolve('native-code'));
	await assert.rejects(probing, { code: 'AGENT_UNAVAILABLE' });
	assert.equal(created, false);
});

test('native CLI discovery uses the explicit private cache without changing process-wide CLI state', async () => {
	const cache = resolve('private-cli-cache');
	const previous = process.env.VSCODE_CLI_DATA_DIR;
	let observed: string | undefined;
	const launcher = new AgentHostLauncher({
		storageRoot: resolve('private-host'), configuredCodeCli: resolve('native-code'), cliDataDirectory: cache,
	}, {
		assertProcessControlSupported() {},
		runCommand: async (_executable, args, options) => {
			assert.deepEqual(args, ['--version']);
			observed = options.environment?.VSCODE_CLI_DATA_DIR;
			return '1.136.2\nexample-commit\nx64\n';
		},
	});
	try {
		assert.equal((await launcher.probe()).available, true);
		assert.equal(observed, cache);
		assert.equal(process.env.VSCODE_CLI_DATA_DIR, previous);
		assert.throws(() => new AgentHostLauncher({
			storageRoot: resolve('private-host'), cliDataDirectory: 'relative-cache',
		}), /must be absolute/u);
	} finally { await launcher.dispose(); }
});
