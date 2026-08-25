import { z } from 'zod';

import { GATEWAY_NOTIFICATIONS } from './constants';
import { PROTOCOL_LIMITS, utf8String } from './limits';
import {
	pendingInputSchema,
	taskFailureSchema,
	taskSnapshotSchema,
	taskStatusSchema,
	terminalTaskStatusSchema,
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

const taskCompletedParamsSchema = z.strictObject({
	...taskNotificationBase,
	snapshot: taskSnapshotSchema.safeExtend({
		state: terminalTaskStatusSchema,
	}),
	failure: taskFailureSchema.optional(),
}).superRefine((params, context) => {
	if (params.taskId !== params.snapshot.taskId) {
		context.addIssue({
			code: 'custom',
			path: ['taskId'],
			message: 'Completed notification taskId must match its snapshot',
		});
	}
	if (params.eventSeq !== params.snapshot.eventSeq) {
		context.addIssue({
			code: 'custom',
			path: ['eventSeq'],
			message: 'Completed notification eventSeq must match its snapshot',
		});
	}
	if (params.at !== params.snapshot.updatedAt) {
		context.addIssue({
			code: 'custom',
			path: ['at'],
			message: 'Completed notification timestamp must match its snapshot update',
		});
	}
	if (JSON.stringify(params.failure) !== JSON.stringify(params.snapshot.failure)) {
		context.addIssue({
			code: 'custom',
			path: ['failure'],
			message: 'Completed notification failure must match its snapshot',
		});
	}
});

const taskCompletedNotificationSchema = z.strictObject({
	jsonrpc: z.literal('2.0'),
	method: z.literal(GATEWAY_NOTIFICATIONS.taskCompleted),
	params: taskCompletedParamsSchema,
});

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
	taskCompletedNotificationSchema,
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
