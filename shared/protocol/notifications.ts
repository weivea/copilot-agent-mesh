import { z } from 'zod';

import { GATEWAY_NOTIFICATIONS } from './constants';
import { PROTOCOL_LIMITS, utf8String } from './limits';
import {
	pendingInputSchema,
	taskFailureSchema,
	taskSnapshotSchema,
	taskStatusSchema,
	timestampSchema,
	uuidSchema,
} from './models';

const taskNotificationBase = {
	taskId: uuidSchema,
	eventSeq: z.number().int().positive(),
	at: timestampSchema,
};

function notification<T extends z.ZodRawShape>(method: string, params: T) {
	return z.strictObject({
		jsonrpc: z.literal('2.0'),
		method: z.literal(method),
		params: z.strictObject({
			...taskNotificationBase,
			...params,
		}),
	});
}

export const rpcNotificationSchema = z.discriminatedUnion('method', [
	notification(GATEWAY_NOTIFICATIONS.taskStateChanged, {
		state: taskStatusSchema,
	}),
	notification(GATEWAY_NOTIFICATIONS.taskProgress, {
		summary: utf8String(PROTOCOL_LIMITS.outputEventBytes, 'progress summary', 1),
	}),
	notification(GATEWAY_NOTIFICATIONS.taskOutput, {
		output: utf8String(PROTOCOL_LIMITS.outputEventBytes, 'task output', 1),
		truncated: z.boolean(),
	}),
	notification(GATEWAY_NOTIFICATIONS.taskInputRequired, {
		input: pendingInputSchema,
	}),
	notification(GATEWAY_NOTIFICATIONS.taskCompleted, {
		snapshot: taskSnapshotSchema,
		failure: taskFailureSchema.optional(),
	}),
	z.strictObject({
		jsonrpc: z.literal('2.0'),
		method: z.literal(GATEWAY_NOTIFICATIONS.connectionDraining),
		params: z.strictObject({
			at: timestampSchema,
			reason: utf8String(PROTOCOL_LIMITS.errorMessageBytes, 'draining reason', 1),
		}),
	}),
]);

export type RpcNotification = z.infer<typeof rpcNotificationSchema>;
