import { z } from 'zod';

import { GATEWAY_METHODS } from './constants';
import { rpcErrorSchema } from './errors';
import { PROTOCOL_LIMITS, utf8ByteLength, utf8String } from './limits';
import { methodParamsSchemas } from './methods';

const rpcIdSchema = utf8String(PROTOCOL_LIMITS.identifierBytes, 'JSON-RPC id', 1);
export const safeJsonValueSchema: z.ZodType<unknown> = z.unknown().refine(
	(value) => isSafeJsonValue(value, new WeakSet()),
	'Value must be JSON-compatible and contain no dangerous object keys',
);

function request(method: keyof typeof methodParamsSchemas) {
	return z.strictObject({
		jsonrpc: z.literal('2.0'),
		id: rpcIdSchema,
		method: z.literal(method),
		params: methodParamsSchemas[method],
	});
}

export const rpcRequestSchema = z.discriminatedUnion('method', [
	request(GATEWAY_METHODS.hello),
	request(GATEWAY_METHODS.authenticate),
	request(GATEWAY_METHODS.enrollmentCommit),
	request(GATEWAY_METHODS.ping),
	request(GATEWAY_METHODS.deviceGetInfo),
	request(GATEWAY_METHODS.workspaceList),
	request(GATEWAY_METHODS.taskStart),
	request(GATEWAY_METHODS.taskGet),
	request(GATEWAY_METHODS.taskCancel),
	request(GATEWAY_METHODS.taskAnswer),
]);

export const rpcSuccessResponseSchema = z.strictObject({
	jsonrpc: z.literal('2.0'),
	id: rpcIdSchema,
	result: safeJsonValueSchema,
});

export const rpcErrorResponseSchema = z.strictObject({
	jsonrpc: z.literal('2.0'),
	id: rpcIdSchema.nullable(),
	error: rpcErrorSchema,
});

export const rpcResponseSchema = z.union([
	rpcSuccessResponseSchema,
	rpcErrorResponseSchema,
]);

export type RpcRequest = z.infer<typeof rpcRequestSchema>;
export type RpcResponse = z.infer<typeof rpcResponseSchema>;

export type RpcTextParseResult =
	| { readonly success: true; readonly data: unknown }
	| { readonly success: false; readonly reason: 'FRAME_TOO_LARGE' | 'INVALID_JSON' | 'INVALID_MESSAGE'; readonly error?: z.ZodError };

export function safeParseJsonText(
	text: string,
	schema: z.ZodType,
	maxBytes: number = PROTOCOL_LIMITS.frameBytes,
): RpcTextParseResult {
	if (utf8ByteLength(text) > maxBytes) {
		return { success: false, reason: 'FRAME_TOO_LARGE' };
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch {
		return { success: false, reason: 'INVALID_JSON' };
	}

	const parsed = schema.safeParse(decoded);
	return parsed.success
		? { success: true, data: parsed.data }
		: { success: false, reason: 'INVALID_MESSAGE', error: parsed.error };
}

function isSafeJsonValue(value: unknown, visited: WeakSet<object>): boolean {
	if (
		value === null
		|| typeof value === 'string'
		|| typeof value === 'boolean'
	) {
		return true;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value);
	}
	if (typeof value !== 'object' || visited.has(value)) {
		return false;
	}

	visited.add(value);
	if (Array.isArray(value)) {
		return value.every((entry) => isSafeJsonValue(entry, visited));
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return false;
	}
	return Object.keys(value).every((key) =>
		!['__proto__', 'prototype', 'constructor'].includes(key)
		&& isSafeJsonValue((value as Record<string, unknown>)[key], visited),
	);
}
