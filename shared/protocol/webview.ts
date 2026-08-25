import { z } from 'zod';

import { PROTOCOL_LIMITS, utf8String } from './limits';
import { deviceInfoSchema, taskSnapshotSchema, uuidSchema, workspaceSummarySchema } from './models';

export const webviewInboundMessageSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('dashboard.refresh'),
	}),
	z.strictObject({
		type: z.literal('device.rename'),
		name: utf8String(PROTOCOL_LIMITS.nameBytes, 'device name', 1),
	}),
	z.strictObject({
		type: z.literal('workspace.setEnabled'),
		workspaceId: uuidSchema,
		enabled: z.boolean(),
	}),
	z.strictObject({
		type: z.literal('task.cancel'),
		taskId: uuidSchema,
	}),
	z.strictObject({
		type: z.literal('task.answer'),
		taskId: uuidSchema,
		inputId: uuidSchema,
		answerId: uuidSchema,
		answer: utf8String(PROTOCOL_LIMITS.taskAnswerBytes, 'task answer', 1),
	}),
]);

export const webviewOutboundMessageSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('dashboard.state'),
		device: deviceInfoSchema,
		workspaces: z.array(workspaceSummarySchema),
		tasks: z.array(taskSnapshotSchema),
	}),
	z.strictObject({
		type: z.literal('dashboard.error'),
		code: utf8String(128, 'dashboard error code', 1),
		message: utf8String(PROTOCOL_LIMITS.errorMessageBytes, 'dashboard error message', 1),
	}),
]);

export type WebviewInboundMessage = z.infer<typeof webviewInboundMessageSchema>;
export type WebviewOutboundMessage = z.infer<typeof webviewOutboundMessageSchema>;
