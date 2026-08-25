import { z } from 'zod';

import {
	ACTIVE_TASK_STATUSES,
	MESH_PROTOCOL_VERSION,
	TASK_STATUSES,
	TERMINAL_TASK_STATUSES,
} from './constants';
import { PROTOCOL_LIMITS, utf8String } from './limits';

export const uuidSchema = z.string().uuid();
export const timestampSchema = z.string().datetime({ offset: true });
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const activeTaskStatusSchema = z.enum(ACTIVE_TASK_STATUSES);
export const terminalTaskStatusSchema = z.enum(TERMINAL_TASK_STATUSES);

export const deviceInfoSchema = z.strictObject({
	deviceId: uuidSchema,
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'device name', 1),
	platform: z.enum(['win32', 'darwin', 'linux']),
	architecture: utf8String(32, 'architecture', 1),
	vscodeVersion: utf8String(64, 'VS Code version', 1),
	extensionVersion: utf8String(64, 'extension version', 1),
	protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
});

export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

export const workspaceSummarySchema = z.strictObject({
	workspaceId: uuidSchema,
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace name', 1),
	capabilityTags: z.array(utf8String(64, 'capability tag', 1)).max(32),
	enabled: z.boolean(),
	busy: z.boolean(),
});

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const taskFailureSchema = z.strictObject({
	code: utf8String(128, 'task failure code', 1),
	message: utf8String(PROTOCOL_LIMITS.errorMessageBytes, 'task failure message', 1),
	retryable: z.boolean(),
});

export const pendingInputSchema = z.strictObject({
	inputId: uuidSchema,
	prompt: utf8String(PROTOCOL_LIMITS.taskAnswerBytes, 'input prompt', 1),
});

export const taskEventRecordSchema = z.strictObject({
	eventSeq: z.number().int().positive(),
	at: timestampSchema,
	type: utf8String(64, 'event type', 1),
	summary: utf8String(PROTOCOL_LIMITS.outputEventBytes, 'event summary').optional(),
});

export const recoveryDescriptorSchema = z.strictObject({
	adapter: utf8String(64, 'recovery adapter', 1),
	sessionId: utf8String(PROTOCOL_LIMITS.identifierBytes, 'recovery session ID', 1),
	conversationId: utf8String(PROTOCOL_LIMITS.identifierBytes, 'recovery conversation ID', 1).optional(),
});

export type RecoveryDescriptor = z.infer<typeof recoveryDescriptorSchema>;

export const persistedTaskRecordSchema = z.strictObject({
	schemaVersion: z.literal(1),
	taskId: uuidSchema,
	delegationRequestId: uuidSchema,
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
	peerId: uuidSchema,
	workspaceId: uuidSchema,
	title: utf8String(PROTOCOL_LIMITS.taskTitleBytes, 'task title', 1),
	state: taskStatusSchema,
	createdAt: timestampSchema,
	updatedAt: timestampSchema,
	eventSeq: z.number().int().nonnegative(),
	workerDeadline: timestampSchema,
	cancellationDeadline: timestampSchema.optional(),
	pendingInput: pendingInputSchema.optional(),
	answeredInputs: z.record(uuidSchema, uuidSchema),
	recoveryDescriptor: recoveryDescriptorSchema.optional(),
	summary: utf8String(PROTOCOL_LIMITS.terminalSummaryBytes, 'terminal summary').optional(),
	failure: taskFailureSchema.optional(),
	events: z.array(taskEventRecordSchema),
	earliestAvailableEventSeq: z.number().int().positive().optional(),
	eventsTruncated: z.boolean(),
});

export type PersistedTaskRecord = z.infer<typeof persistedTaskRecordSchema>;

export const taskSnapshotSchema = persistedTaskRecordSchema
	.omit({
		recoveryDescriptor: true,
		answeredInputs: true,
	})
	.extend({
		deviceId: uuidSchema,
	});

export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
