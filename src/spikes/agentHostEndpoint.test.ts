import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	EndpointSelectionError,
	parseEndpointDocument,
	redactSecrets,
	requireGlobalWebSocket,
	sanitizeError,
	selectOwnedStandaloneEndpoint,
	waitForOwnedStandaloneEndpoint,
} from './agentHostEndpoint';
import {
	assertOwnedProcessControlSupported,
	OwnedCommandError,
	runOwnedCommand,
} from './ownedProcess';

const token = 'unit-test-secret-token';

test('parses the versioned endpoint JSON document', () => {
	const document = parseEndpointDocument(JSON.stringify(fixture()));

	assert.equal(document.endpoints.length, 1);
	assert.equal(document.endpoints[0]?.schemaVersion, 2);
	assert.equal(document.endpoints[0]?.endpoint.port, 57_234);
});

test('rejects malformed JSON and invalid endpoint fields', () => {
	assertSelectionCode(() => parseEndpointDocument('{'), 'INVALID_ENDPOINT_JSON');
	assertSelectionCode(
		() => parseEndpointDocument(JSON.stringify(fixture({ pid: '93590' }))),
		'INVALID_ENDPOINT_JSON',
	);
	assertSelectionCode(
		() => parseEndpointDocument(JSON.stringify(fixture({ schemaVersion: 3 }))),
		'INVALID_ENDPOINT_JSON',
	);
	assertSelectionCode(
		() => parseEndpointDocument(JSON.stringify(fixture({ endpoint: { type: 'tcp', host: '127.0.0.1', port: 0 } }))),
		'INVALID_ENDPOINT_JSON',
	);
});

test('selects only the new standalone endpoint owned by PID and token', () => {
	const baseline = fixture({ instanceId: 'baseline', pid: 1, connectionToken: 'old' }).endpoints[0];
	const unrelated = fixture({ instanceId: 'other', pid: 999 }).endpoints[0];
	const owned = fixture().endpoints[0];
	const selected = selectOwnedStandaloneEndpoint({
		baselineInstanceIds: new Set(['baseline']),
		document: parseEndpointDocument(JSON.stringify({
			userDataPath: '/owned',
			endpoints: [baseline, unrelated, owned],
		})),
		ownedPids: new Set([93_590]),
		expectedToken: token,
	});

	assert.equal(selected.instanceId, 'owned-instance');
	assert.equal(selected.pid, 93_590);
	assert.equal(selected.url.hostname, '127.0.0.1');
	assert.equal(selected.url.searchParams.get('tkn'), token);
});

test('fails when no owned endpoint matches', () => {
	assertSelectionCode(() => selectOwnedStandaloneEndpoint({
		baselineInstanceIds: new Set<string>(),
		document: parseEndpointDocument(JSON.stringify(fixture({ connectionToken: 'wrong' }))),
		ownedPids: new Set([93_590]),
		expectedToken: token,
	}), 'NO_OWNED_ENDPOINT');
});

test('fails instead of choosing the first of multiple owned endpoints', () => {
	const first = fixture().endpoints[0];
	const second = fixture({ instanceId: 'second-owned' }).endpoints[0];

	assertSelectionCode(() => selectOwnedStandaloneEndpoint({
		baselineInstanceIds: new Set<string>(),
		document: parseEndpointDocument(JSON.stringify({
			userDataPath: '/owned',
			endpoints: [first, second],
		})),
		ownedPids: new Set([93_590]),
		expectedToken: token,
	}), 'MULTIPLE_OWNED_ENDPOINTS');
});

test('rejects non-loopback and non-WebSocket-compatible endpoints', () => {
	assertSelectionCode(() => selectOwnedStandaloneEndpoint({
		baselineInstanceIds: new Set<string>(),
		document: parseEndpointDocument(JSON.stringify(fixture({
			endpoint: { type: 'tcp', host: '192.0.2.10', port: 57_234 },
		}))),
		ownedPids: new Set([93_590]),
		expectedToken: token,
	}), 'INVALID_ENDPOINT_JSON');
});

test('constructs a bracketed URL for an IPv6 loopback endpoint', () => {
	const selected = selectOwnedStandaloneEndpoint({
		baselineInstanceIds: new Set<string>(),
		document: parseEndpointDocument(JSON.stringify(fixture({
			endpoint: { type: 'tcp', host: '::1', port: 57_234 },
		}))),
		ownedPids: new Set([93_590]),
		expectedToken: token,
	});

	assert.equal(selected.url.href.startsWith('ws://[::1]:57234/'), true);
	assert.equal(selected.url.searchParams.get('tkn'), token);
});

test('polls through zero matches and returns the later owned endpoint', async () => {
	let calls = 0;
	const selected = await waitForOwnedStandaloneEndpoint({
		baselineInstanceIds: new Set<string>(),
		discover: async () => {
			calls += 1;
			return parseEndpointDocument(JSON.stringify(calls === 1
				? { userDataPath: '/owned', endpoints: [] }
				: fixture()));
		},
		ownedPids: () => new Set([93_590]),
		expectedToken: token,
		timeoutMs: 100,
		pollIntervalMs: 1,
		now: () => calls,
		sleep: async () => {},
	});

	assert.equal(calls, 2);
	assert.equal(selected.instanceId, 'owned-instance');
});

test('times out deterministically when endpoint discovery stays empty', async () => {
	let clock = 0;
	await assert.rejects(
		waitForOwnedStandaloneEndpoint({
			baselineInstanceIds: new Set<string>(),
			discover: async () => parseEndpointDocument(JSON.stringify({ userDataPath: '/owned', endpoints: [] })),
			ownedPids: () => new Set([93_590]),
			expectedToken: token,
			timeoutMs: 10,
			pollIntervalMs: 5,
			now: () => clock,
			sleep: async (milliseconds) => {
				clock += milliseconds;
			},
		}),
		(error: unknown) => error instanceof EndpointSelectionError
			&& error.code === 'NO_OWNED_ENDPOINT'
			&& error.message.includes('Timed out after 10ms'),
	);
});

test('redacts tokens in literals, JSON, URLs, and authorization headers', () => {
	const input = [
		`literal=${token}`,
		`{"connectionToken":"${token}"}`,
		`ws://127.0.0.1:1234?tkn=${token}&x=1`,
		`Authorization: Bearer ${token}`,
	].join('\n');
	const output = redactSecrets(input, [token]);

	assert.equal(output.includes(token), false);
	assert.equal(output.match(/<redacted>/gu)?.length, 4);
});

test('records the global WebSocket transport boundary', () => {
	assert.equal(typeof globalThis.WebSocket, 'function');
	assert.doesNotThrow(() => requireGlobalWebSocket());
});

test('fails closed on Windows without a Job Object controller', () => {
	assert.throws(
		() => assertOwnedProcessControlSupported('win32'),
		/Job Object based process controller/u,
	);
});

test('sanitizes errors without retaining a secret-bearing cause', () => {
	const unsafe = new Error(`request failed for ${token}`, {
		cause: new Error(`nested ${token}`),
	});
	const safe = sanitizeError(unsafe, [token]);

	assert.equal(safe.message.includes(token), false);
	assert.equal(safe.cause, undefined);
});

test('kills an inherited-pipe descendant that ignores SIGTERM within a bound', {
	skip: process.platform === 'win32',
}, async () => {
	const descendant = [
		"process.on('SIGTERM', () => {});",
		'setInterval(() => {}, 1000);',
	].join('');
	const launcher = [
		"const { spawn } = require('node:child_process');",
		`spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', process.stdout, process.stderr] });`,
		'setInterval(() => {}, 1000);',
	].join('');
	const startedAt = Date.now();
	let commandError: OwnedCommandError | undefined;

	try {
		await runOwnedCommand(process.execPath, ['-e', launcher], {
			timeoutMs: 100,
			terminationGraceMs: 100,
		});
		assert.fail('The inherited-pipe command should time out.');
	} catch (error) {
		assert.ok(error instanceof OwnedCommandError);
		commandError = error;
	}

	assert.ok(Date.now() - startedAt < 1_500);
	assert.ok(commandError.processGroupId);
	assert.throws(
		() => process.kill(-commandError.processGroupId!, 0),
		(error: unknown) => error instanceof Error
			&& 'code' in error
			&& error.code === 'ESRCH',
	);
});

function fixture(overrides: Record<string, unknown> = {}): {
	userDataPath: string;
	endpoints: Array<Record<string, unknown>>;
} {
	return {
		userDataPath: '/owned',
		endpoints: [{
			schemaVersion: 2,
			type: 'standalone',
			pid: 93_590,
			instanceId: 'owned-instance',
			protocolVersion: '0.1.0',
			connectionToken: token,
			endpoint: {
				type: 'tcp',
				host: '127.0.0.1',
				port: 57_234,
			},
			quality: 'stable',
			...overrides,
		}],
	};
}

function assertSelectionCode(callback: () => unknown, expectedCode: string): void {
	assert.throws(
		callback,
		(error: unknown) => error instanceof EndpointSelectionError && error.code === expectedCode,
	);
}
