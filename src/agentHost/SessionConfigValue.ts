import type { SessionConfigPropertySchema } from '@microsoft/agent-host-protocol' with { 'resolution-mode': 'import' };

import { AgentRuntimeError } from './AgentRuntime';

export function parseSessionConfigInput(
	propertyId: string,
	property: SessionConfigPropertySchema,
	input: string,
): unknown {
	let value: unknown;
	try {
		switch (property.type) {
			case 'string':
				value = input;
				break;
			case 'number':
			case 'array':
			case 'object':
				value = JSON.parse(input);
				break;
			case 'boolean':
				throw configError(propertyId, 'must be selected as a boolean value');
			default:
				throw configError(propertyId, 'uses an unsupported schema type');
		}
	} catch (error) {
		if (error instanceof AgentRuntimeError) {
			throw error;
		}
		throw configError(propertyId, `is not valid ${property.type} JSON`);
	}
	validateSessionConfigValue(propertyId, property, value);
	return value;
}

export function validateSessionConfigValue(
	propertyId: string,
	property: SessionConfigPropertySchema,
	value: unknown,
): void {
	switch (property.type) {
		case 'string':
			if (typeof value !== 'string') {
				throw configError(propertyId, 'must be a string');
			}
			break;
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				throw configError(propertyId, 'must be a finite number');
			}
			break;
		case 'boolean':
			if (typeof value !== 'boolean') {
				throw configError(propertyId, 'must be a boolean');
			}
			break;
		case 'array':
			if (!Array.isArray(value)) {
				throw configError(propertyId, 'must be an array');
			}
			if (property.items !== undefined) {
				for (const [index, item] of value.entries()) {
					validateSessionConfigValue(`${propertyId}[${index}]`, property.items, item);
				}
			}
			break;
		case 'object':
			if (!isRecord(value)) {
				throw configError(propertyId, 'must be an object');
			}
			for (const required of property.required ?? []) {
				if (value[required] === undefined) {
					throw configError(`${propertyId}.${required}`, 'is required');
				}
			}
			for (const [key, child] of Object.entries(value)) {
				const childSchema = property.properties?.[key] ?? property.additionalProperties;
				if (childSchema !== undefined) {
					validateSessionConfigValue(`${propertyId}.${key}`, childSchema, child);
				}
			}
			break;
		default:
			throw configError(propertyId, 'uses an unsupported schema type');
	}
	if (property.enum !== undefined && !property.enum.some((candidate) => Object.is(candidate, value))) {
		throw configError(propertyId, 'is not one of the allowed values');
	}
}

export function formatSessionConfigDefault(
	propertyId: string,
	property: SessionConfigPropertySchema,
): string | undefined {
	if (property.default === undefined) {
		return undefined;
	}
	validateSessionConfigValue(propertyId, property, property.default);
	return property.type === 'string'
		? property.default as string
		: JSON.stringify(property.default);
}

function configError(propertyId: string, detail: string): AgentRuntimeError {
	return new AgentRuntimeError(
		'AGENT_CONFIG_REQUIRED',
		`Agent configuration property "${propertyId}" ${detail}.`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
