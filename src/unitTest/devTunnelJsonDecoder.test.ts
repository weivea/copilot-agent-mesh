import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { suite, test } from 'node:test';

import {
	computeSanitizedFixtureHash,
	decodeDevTunnelShowJson,
	DevTunnelDecodeError,
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

suite('DevTunnelJsonDecoder', () => {
	test('decodes one validated HTTPS forwarding origin', () => {
		const result = decodeDevTunnelShowJson(JSON.stringify(createHostedFixture()), {
			expectedTunnelId,
			expectedPort,
		});

		assert.deepStrictEqual(result, {
			tunnelId: expectedTunnelId,
			port: expectedPort,
			protocol: 'http',
			forwardingOrigin: 'https://fixture-43123.asse.devtunnels.ms',
		});
	});

	test('rejects the observed no-host fixture because it has no forwarding URI', () => {
		const fixture = readFileSync(fixturePath, 'utf8');

		assert.equal(
			computeSanitizedFixtureHash(fixture),
			'244e17f9195cc8b8c38da88b996eab1ace0655bf3642d951c4827fd65a166f73',
		);
		assert.throws(
			() => decodeDevTunnelShowJson(fixture, { expectedTunnelId, expectedPort }),
			(error: unknown) => hasCode(error, 'FORWARDING_URI_MISSING'),
		);
	});

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

	test('rejects multiple forwarding URIs', () => {
		const fixture = createHostedFixture();
		fixture.tunnel.ports[0].portForwardingUris.push(
			'https://fixture-43123-duplicate.asse.devtunnels.ms/',
		);

		assert.throws(
			() => decodeDevTunnelShowJson(JSON.stringify(fixture), { expectedTunnelId, expectedPort }),
			(error: unknown) => hasCode(error, 'FORWARDING_URI_AMBIGUOUS'),
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
			fixture.tunnel.ports[0].portForwardingUris = [invalidUri];

			assert.throws(
				() => decodeDevTunnelShowJson(JSON.stringify(fixture), { expectedTunnelId, expectedPort }),
				(error: unknown) => hasCode(error, 'FORWARDING_URI_INVALID'),
			);
		});
	}
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
				portForwardingUris: ['https://fixture-43123.asse.devtunnels.ms/'],
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
