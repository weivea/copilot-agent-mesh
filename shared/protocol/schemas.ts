import { z } from 'zod';

import { safeParseJsonText, type RpcTextParseResult, rpcRequestSchema, rpcResponseSchema } from './envelopes';
import { PROTOCOL_LIMITS } from './limits';
import { rpcNotificationSchema } from './notifications';

export const rpcMessageSchema = z.union([
	rpcRequestSchema,
	rpcResponseSchema,
	rpcNotificationSchema,
]);

export function safeParseRpcMessageText(
	text: string,
	maxBytes: number = PROTOCOL_LIMITS.frameBytes,
): RpcTextParseResult {
	return safeParseJsonText(text, rpcMessageSchema, maxBytes);
}
