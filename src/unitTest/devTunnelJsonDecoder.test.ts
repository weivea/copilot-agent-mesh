import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { suite, test } from 'node:test';

import {
	computeSanitizedFixtureHash,
	DEVTUNNEL_HOSTED_FIXTURE_SHA256,
	decodeDevTunnelAccessListForAdoptionJson,
	decodeDevTunnelAccessListJson,
	decodeDevTunnelShowJson as decodeDevTunnelShowForBuild,
	DevTunnelDecodeError,
	LEGACY_UNSUPPORTED_DEVTUNNEL_BUILD,
	isExactDevTunnelNotFound,
	SUPPORTED_DEVTUNNEL_BUILD,
} from '../tunnel/DevTunnelJsonDecoder';

const expectedTunnelId = 'fixture-tunnel';
const expectedPort = 43123;
const fixturePath = join(
	process.cwd(),
	'docs',
	'spikes',
	'fixtures',
	'devtunnel-show-1.0.2006-no-host.sanitized.json',
);
const hostedFixturePath = join(
	process.cwd(),
	'docs',
	'mvp',
	'fixtures',
	'devtunnel-show-1.0.2030-hosted.sanitized.json',
);

suite('DevTunnelJsonDecoder', () => {
	test('decodes one validated HTTPS forwarding origin', () => {
		const result = decodeDevTunnelShowJson(JSON.stringify(createHostedFixture()), {
			expectedTunnelId,
			expectedPort,
		});

		assert.deepStrictEqual(result, {
			tunnelId: expectedTunnelId,
			port: expectedPort,
			portExists: true,
			protocol: 'http',
			forwardingOrigin: 'https://fixture-43123.asse.devtunnels.ms',
		});
	});

	test('locks the sanitized real hosted fixture to the exact build decoder', () => {
		const fixture = readFileSync(hostedFixturePath, 'utf8');

		assert.equal(computeSanitizedFixtureHash(fixture), DEVTUNNEL_HOSTED_FIXTURE_SHA256);
		assert.deepStrictEqual(
			decodeDevTunnelShowForBuild(SUPPORTED_DEVTUNNEL_BUILD, fixture, {
				expectedTunnelId: 'came2efixt.jpe1',
				expectedPort: 43123,
				requireForwardingUri: true,
			}),
			{
				tunnelId: 'came2efixt.jpe1',
				port: 43123,
				portExists: true,
				protocol: 'http',
				forwardingOrigin: 'https://fixture-43123.jpe1.devtunnels.ms',
			},
		);
	});

	test('rejects the legacy fixture before shape decoding', () => {
		const fixture = readFileSync(fixturePath, 'utf8');

		assert.equal(
			computeSanitizedFixtureHash(fixture),
			'244e17f9195cc8b8c38da88b996eab1ace0655bf3642d951c4827fd65a166f73',
		);
		assert.throws(
			() => decodeDevTunnelShowForBuild(
				LEGACY_UNSUPPORTED_DEVTUNNEL_BUILD,
				fixture,
				{ expectedTunnelId, expectedPort },
			),
			(error: unknown) => hasCode(error, 'UNSUPPORTED_BUILD'),
		);
	});

	function decodeDevTunnelShowJson(
		raw: string,
		options: { readonly expectedTunnelId: string; readonly expectedPort: number },
	) {
		return decodeDevTunnelShowForBuild(SUPPORTED_DEVTUNNEL_BUILD, raw, {
			...options,
			requireForwardingUri: true,
		});
	}

	test('rejects non-JSON prefixes instead of parsing ordinary stdout', () => {
		const raw = `Welcome to dev tunnels!\n${JSON.stringify(createHostedFixture())}`;

		assert.throws(
			() => decodeDevTunnelShowJson(raw, { expectedTunnelId, expectedPort }),
			(error: unknown) => hasCode(error, 'INVALID_JSON'),
		);
	});

	test('rejects unknown fields', () => {
		const fixture = createHostedFixture();
		(fixture.tunnel as Record<string, unknown>).unexpected = true;

		assert.throws(
			() => decodeDevTunnelShowJson(JSON.stringify(fixture), { expectedTunnelId, expectedPort }),
			(error: unknown) => hasCode(error, 'UNKNOWN_SHAPE'),
		);
	});

	test('rejects version drift in a non-target port', () => {
		const fixture = createHostedFixture();
		(fixture.tunnel.ports as Array<Record<string, unknown>>).push({
			portNumber: 43124,
			protocol: 'http',
			portForwardingUris: ['https://fixture-43124.asse.devtunnels.ms/'],
			unexpected: true,
		});

		assert.throws(
			() => decodeDevTunnelShowJson(JSON.stringify(fixture), { expectedTunnelId, expectedPort }),
			(error: unknown) => hasCode(error, 'UNKNOWN_SHAPE'),
		);
	});

	test('rejects any additional valid tunnel port', () => {
		const fixture = createHostedFixture();
		(fixture.tunnel.ports as Array<Record<string, unknown>>).push({
			portNumber: 43124,
			protocol: 'http',
			portUri: 'https://fixture-43124.asse.devtunnels.ms/',
		});

		assert.throws(
			() => decodeDevTunnelShowJson(JSON.stringify(fixture), { expectedTunnelId, expectedPort }),
			(error: unknown) => hasCode(error, 'PORT_NOT_FOUND'),
		);
	});

	test('does not treat a different existing port as a missing requested port', () => {
		const fixture = createHostedFixture();
		(fixture.tunnel.ports as Array<Record<string, unknown>>)[0].portNumber = 43124;

		assert.throws(
			() => decodeDevTunnelShowForBuild(SUPPORTED_DEVTUNNEL_BUILD, JSON.stringify(fixture), {
				allowMissingPort: true,
				expectedTunnelId,
				expectedPort,
				requireForwardingUri: false,
			}),
			(error: unknown) => hasCode(error, 'PORT_NOT_FOUND'),
		);
	});

	test('rejects tunnel-wide and inline port access drift', () => {
		const tunnelAccess = createHostedFixture();
		(tunnelAccess.tunnel as Record<string, unknown>).accessControl = [{
			type: 'Anonymous',
			subjects: [],
			scopes: ['connect'],
		}];
		assert.throws(
			() => decodeDevTunnelShowJson(JSON.stringify(tunnelAccess), {
				expectedTunnelId,
				expectedPort,
			}),
			(error: unknown) => hasCode(error, 'ACCESS_INVALID'),
		);

		const portAccess = createHostedFixture();
		(portAccess.tunnel.ports[0] as Record<string, unknown>).accessControl = [{
			type: 'Anonymous',
			subjects: [],
			scopes: ['connect'],
		}];
		assert.throws(
			() => decodeDevTunnelShowJson(JSON.stringify(portAccess), {
				expectedTunnelId,
				expectedPort,
			}),
			(error: unknown) => hasCode(error, 'ACCESS_INVALID'),
		);
	});

	test('rejects an invalid non-target port shape', () => {
		const fixture = createHostedFixture();
		(fixture.tunnel.ports as Array<Record<string, unknown>>).unshift({});

		assert.throws(
			() => decodeDevTunnelShowJson(JSON.stringify(fixture), { expectedTunnelId, expectedPort }),
			(error: unknown) => hasCode(error, 'UNKNOWN_SHAPE'),
		);
	});

	test('rejects a missing target port', () => {
		assert.throws(
			() => decodeDevTunnelShowJson(JSON.stringify(createHostedFixture()), {
				expectedTunnelId,
				expectedPort: 43124,
			}),
			(error: unknown) => hasCode(error, 'PORT_NOT_FOUND'),
		);
	});

	test('rejects the wrong port protocol', () => {
		const fixture = createHostedFixture();
		fixture.tunnel.ports[0].protocol = 'https';

		assert.throws(
			() => decodeDevTunnelShowJson(JSON.stringify(fixture), { expectedTunnelId, expectedPort }),
			(error: unknown) => hasCode(error, 'PORT_PROTOCOL_MISMATCH'),
		);
	});

	test('rejects the cross-version portForwardingUris field', () => {
		const fixture = createHostedFixture();
		(fixture.tunnel.ports[0] as Record<string, unknown>).portForwardingUris = [
			'https://fixture-43123.asse.devtunnels.ms/',
		];

		assert.throws(
			() => decodeDevTunnelShowJson(JSON.stringify(fixture), { expectedTunnelId, expectedPort }),
			(error: unknown) => hasCode(error, 'UNKNOWN_SHAPE'),
		);
	});

	for (const invalidUri of [
		'http://fixture-43123.asse.devtunnels.ms/',
		'https://user:password@fixture-43123.asse.devtunnels.ms/',
		'https://@fixture-43123.asse.devtunnels.ms/',
		'https://fixture-43123.example.com/',
		'https://fixture-43123.asse.devtunnels.ms/?',
		'https://fixture-43123.asse.devtunnels.ms/#',
		'https://fixture-43123.asse.devtunnels.ms/?tkn=secret',
	]) {
		test(`rejects invalid forwarding URI ${invalidUri}`, () => {
			const fixture = createHostedFixture();
			fixture.tunnel.ports[0].portUri = invalidUri;

			assert.throws(
				() => decodeDevTunnelShowJson(JSON.stringify(fixture), { expectedTunnelId, expectedPort }),
				(error: unknown) => hasCode(error, 'FORWARDING_URI_INVALID'),
			);
		});
	}

	test('requires one exact provider-owned ACE before deletion', () => {
		const expiration = '2026-08-27T01:45:25.005839Z';
		const entry = {
			type: 'Anonymous',
			subjects: [],
			scopes: ['connect'],
			expiration,
		};

		assert.doesNotThrow(() => decodeDevTunnelAccessListJson(
			SUPPORTED_DEVTUNNEL_BUILD,
			JSON.stringify({ accessControlEntries: [entry] }),
			{ expectedExpiration: expiration, expectedIndex: 0 },
		));
		assert.throws(
			() => decodeDevTunnelAccessListJson(
				SUPPORTED_DEVTUNNEL_BUILD,
				JSON.stringify({ accessControlEntries: [entry, entry] }),
				{ expectedExpiration: expiration, expectedIndex: 0 },
			),
			(error: unknown) => hasCode(error, 'ACCESS_INVALID'),
		);
		assert.throws(
			() => decodeDevTunnelAccessListJson(
				SUPPORTED_DEVTUNNEL_BUILD,
				JSON.stringify({ accessControlEntries: [entry] }),
				{ expectedExpiration: '2026-08-27T02:45:25.005839Z', expectedIndex: 0 },
			),
			(error: unknown) => hasCode(error, 'ACCESS_INVALID'),
		);
	});

	test('adopts only an empty list or one future owned access entry', () => {
		const now = new Date('2026-08-25T01:00:00.000Z');
		const entry = {
			type: 'Anonymous',
			subjects: [],
			scopes: ['connect'],
			expiration: '2026-08-27T01:00:00.000Z',
		};
		assert.equal(
			decodeDevTunnelAccessListForAdoptionJson(
				SUPPORTED_DEVTUNNEL_BUILD,
				JSON.stringify({ accessControlEntries: [] }),
				now,
			),
			undefined,
		);
		assert.deepStrictEqual(
			decodeDevTunnelAccessListForAdoptionJson(
				SUPPORTED_DEVTUNNEL_BUILD,
				JSON.stringify({ accessControlEntries: [entry] }),
				now,
			),
			{ expiresAt: entry.expiration, index: 0 },
		);
		assert.throws(
			() => decodeDevTunnelAccessListForAdoptionJson(
				SUPPORTED_DEVTUNNEL_BUILD,
				JSON.stringify({ accessControlEntries: [entry, entry] }),
				now,
			),
			(error: unknown) => hasCode(error, 'ACCESS_INVALID'),
		);
	});

	test('recognizes only the exact build-specific not-found response', () => {
		const exact = {
			exitCode: 2,
			stdout: '',
			stderr: 'Tunnel not found in jpe1: came2etest\n',
		};
		assert.equal(isExactDevTunnelNotFound(
			SUPPORTED_DEVTUNNEL_BUILD,
			exact,
			'came2etest.jpe1',
		), true);
		assert.equal(isExactDevTunnelNotFound(
			SUPPORTED_DEVTUNNEL_BUILD,
			{ ...exact, stderr: 'network unavailable\n' },
			'came2etest.jpe1',
		), false);
		assert.equal(isExactDevTunnelNotFound(
			LEGACY_UNSUPPORTED_DEVTUNNEL_BUILD,
			exact,
			'came2etest.jpe1',
		), false);
	});
});

function createHostedFixture() {
	return {
		tunnel: {
			tunnelId: expectedTunnelId,
			hostConnections: 1,
			clientConnections: 0,
			labels: ['copilot-agent-mesh-p0'],
			tunnelExpiration: '<redacted>',
			description: '<redacted>',
			currentUploadRate: '<redacted>',
			currentDownloadRate: '<redacted>',
			ports: [{
				portNumber: expectedPort,
				protocol: 'http',
				portUri: 'https://fixture-43123.asse.devtunnels.ms/',
			}],
			accessControl: [],
		},
	};
}

function hasCode(error: unknown, code: DevTunnelDecodeError['code']): boolean {
	assert.ok(error instanceof DevTunnelDecodeError);
	assert.equal(error.code, code);
	return true;
}
