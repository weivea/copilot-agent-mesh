import { z } from 'zod';

import { GATEWAY_METHODS } from './constants';
import { rpcErrorSchema } from './errors';
import { PROTOCOL_LIMITS, utf8ByteLength, utf8String } from './limits';
import { methodParamsSchemas } from './methods';

const rpcIdSchema = utf8String(PROTOCOL_LIMITS.identifierBytes, 'JSON-RPC id', 1);
export const SAFE_JSON_LIMITS = {
	maxDepth: 128,
	maxNodes: 65_536,
} as const;

export const safeJsonValueSchema: z.ZodType<unknown> = z.unknown().refine(
	(value) => isSafeJsonValue(value),
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
	request(GATEWAY_METHODS.nodeList),
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

	let parsed: z.ZodSafeParseResult<unknown>;
	try {
		parsed = schema.safeParse(decoded);
	} catch {
		return { success: false, reason: 'INVALID_MESSAGE' };
	}
	return parsed.success
		? { success: true, data: parsed.data }
		: { success: false, reason: 'INVALID_MESSAGE', error: parsed.error };
}

function isSafeJsonValue(root: unknown): boolean {
	const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
		{ value: root, depth: 0 },
	];
	const visited = new WeakSet<object>();
	let nodeCount = 0;

	try {
		while (pending.length > 0) {
			const current = pending.pop();
			if (current === undefined) {
				return false;
			}
			nodeCount += 1;
			if (
				current.depth > SAFE_JSON_LIMITS.maxDepth
				|| nodeCount > SAFE_JSON_LIMITS.maxNodes
			) {
				return false;
			}

			const value = current.value;
			if (
				value === null
				|| typeof value === 'string'
				|| typeof value === 'boolean'
			) {
				continue;
			}
			if (typeof value === 'number') {
				if (!Number.isFinite(value)) {
					return false;
				}
				continue;
			}
			if (typeof value !== 'object' || visited.has(value)) {
				return false;
			}

			visited.add(value);
			const entries: readonly unknown[] = Array.isArray(value)
				? value
				: objectValues(value);
			if (nodeCount + pending.length + entries.length > SAFE_JSON_LIMITS.maxNodes) {
				return false;
			}
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				pending.push({
					value: entries[index],
					depth: current.depth + 1,
				});
			}
		}
		return true;
	} catch {
		return false;
	}
}

function objectValues(value: object): readonly unknown[] {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError('JSON object must have a plain prototype.');
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
		throw new TypeError('JSON object contains a dangerous key.');
	}
	return keys.map((key) => record[key]);
}
