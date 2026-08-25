import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionConfigPropertySchema } from '@microsoft/agent-host-protocol' with { 'resolution-mode': 'import' };

import { AgentRuntimeError } from '../agentHost/AgentRuntime';
import {
	formatSessionConfigDefault,
	parseSessionConfigInput,
	validateSessionConfigValue,
} from '../agentHost/SessionConfigValue';

test('session config input preserves schema types', () => {
	assert.equal(parse('string', 'mesh'), 'mesh');
	assert.equal(parse('number', '12.5'), 12.5);
	assert.deepEqual(parse('array', '["one", "two"]', {
		items: schema('string'),
	}), ['one', 'two']);
	assert.deepEqual(parse('object', '{"enabled":true,"count":2}', {
		properties: {
			enabled: schema('boolean'),
			count: schema('number'),
		},
		required: ['enabled', 'count'],
	}), { enabled: true, count: 2 });
});

test('session config input rejects invalid and unsupported values with a stable error', () => {
	for (const [property, input] of [
		[schema('number'), '"12"'],
		[schema('array', { items: schema('number') }), '[1,"two"]'],
		[schema('object', {
			properties: { requiredValue: schema('string') },
			required: ['requiredValue'],
		}), '{}'],
		[{ ...schema('string'), type: 'integer' }, '1'],
	] as const) {
		assert.throws(
			() => parseSessionConfigInput('test', property as SessionConfigPropertySchema, input),
			(error: unknown) => error instanceof AgentRuntimeError && error.code === 'AGENT_CONFIG_REQUIRED',
		);
	}
});

test('session config enum and defaults are validated without stringifying typed values', () => {
	const property = schema('array', {
		default: ['mesh'],
		items: schema('string'),
	});
	assert.equal(formatSessionConfigDefault('agents', property), '["mesh"]');
	validateSessionConfigValue('mode', { ...schema('string'), enum: ['safe'] }, 'safe');
	assert.throws(
		() => validateSessionConfigValue('mode', { ...schema('string'), enum: ['safe'] }, 'unsafe'),
		AgentRuntimeError,
	);
});

function parse(
	type: SessionConfigPropertySchema['type'],
	input: string,
	extra: Partial<SessionConfigPropertySchema> = {},
): unknown {
	return parseSessionConfigInput('test', schema(type, extra), input);
}

function schema(
	type: SessionConfigPropertySchema['type'],
	extra: Partial<SessionConfigPropertySchema> = {},
): SessionConfigPropertySchema {
	return { type, title: 'Test', ...extra };
}
