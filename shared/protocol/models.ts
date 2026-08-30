import { z } from 'zod';

import {
	ACTIVE_TASK_STATUSES,
	MESH_PROTOCOL_VERSION,
	TASK_STATUSES,
	TERMINAL_TASK_STATUSES,
} from './constants';
import { PROTOCOL_LIMITS, utf8ByteLength, utf8String } from './limits';

export const uuidSchema = z.string().uuid().transform((value) => value.toLowerCase());
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
export type TaskFailure = z.infer<typeof taskFailureSchema>;

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

const persistedTaskRecordCommonFields = {
	taskId: uuidSchema,
	delegationRequestId: uuidSchema,
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
	peerId: uuidSchema,
	workspaceId: uuidSchema,
	workspaceLeaseKey: utf8String(1_024, 'workspace lease key', 1),
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
};

export const persistedTaskRoutingTargetSchema = z.strictObject({
	deviceId: uuidSchema,
	workspaceId: uuidSchema,
	nodeId: uuidSchema.optional(),
	nodeInstanceId: uuidSchema.optional(),
}).superRefine((target, context) => {
	if ((target.nodeId === undefined) !== (target.nodeInstanceId === undefined)) {
		context.addIssue({
			code: 'custom',
			path: ['nodeId'],
			message: 'Live task routing requires both nodeId and nodeInstanceId',
		});
	}
});

export const persistedTaskRecordV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	...persistedTaskRecordCommonFields,
});

export const persistedTaskRecordV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	...persistedTaskRecordCommonFields,
	target: persistedTaskRoutingTargetSchema,
	sourceNodeId: uuidSchema.optional(),
});

export const persistedTaskRecordSchema = z.discriminatedUnion('schemaVersion', [
	persistedTaskRecordV1Schema,
	persistedTaskRecordV2Schema,
])
	.superRefine(validateTaskState)
	.superRefine(validateFullJournal)
	.superRefine((record, context) => {
		if (
			record.schemaVersion === 2
			&& record.workspaceId !== record.target.workspaceId
		) {
			context.addIssue({
				code: 'custom',
				path: ['target', 'workspaceId'],
				message: 'The persisted task target must match workspaceId',
			});
		}
	});

function validateTaskState(
	record: {
		readonly state: z.infer<typeof taskStatusSchema>;
		readonly cancellationDeadline?: string;
		readonly pendingInput?: z.infer<typeof pendingInputSchema>;
		readonly summary?: string;
		readonly failure?: z.infer<typeof taskFailureSchema>;
	},
	context: z.RefinementCtx,
): void {
	if (record.state === 'needsInput' && record.pendingInput === undefined) {
		context.addIssue({
			code: 'custom',
			path: ['pendingInput'],
			message: 'needsInput tasks must include pending input',
		});
	}
	if (
		record.pendingInput !== undefined
		&& record.state !== 'needsInput'
		&& record.state !== 'recovering'
	) {
		context.addIssue({
			code: 'custom',
			path: ['pendingInput'],
			message: 'Only needsInput or recovering tasks may retain pending input',
		});
	}
	const cancellationState = record.state === 'cancelling' || record.state === 'cancelled';
	if (cancellationState !== (record.cancellationDeadline !== undefined)) {
		context.addIssue({
			code: 'custom',
			path: ['cancellationDeadline'],
			message: 'Only cancelling or cancelled tasks must include a cancellation deadline',
		});
	}
	const failureState = record.state === 'failed' || record.state === 'timedOut';
	if (failureState !== (record.failure !== undefined)) {
		context.addIssue({
			code: 'custom',
			path: ['failure'],
			message: 'Only failed or timedOut tasks must include failure details',
		});
	}
	if (record.state === 'completed' && record.summary === undefined) {
		context.addIssue({
			code: 'custom',
			path: ['summary'],
			message: 'Completed tasks must include a summary',
		});
	}
	if (
		record.summary !== undefined
		&& record.state !== 'completed'
		&& record.state !== 'cancelled'
	) {
		context.addIssue({
			code: 'custom',
			path: ['summary'],
			message: 'Only completed or cancelled tasks may include a terminal summary',
		});
	}
}

function validateFullJournal(
	record: {
		readonly eventSeq: number;
		readonly events: readonly z.infer<typeof taskEventRecordSchema>[];
		readonly earliestAvailableEventSeq?: number;
		readonly eventsTruncated: boolean;
	},
	context: z.RefinementCtx,
): void {
	const expectedFirstSequence = record.eventsTruncated
		? record.earliestAvailableEventSeq
		: 1;
	const actualFirstSequence = record.events[0]?.eventSeq ?? record.eventSeq + 1;
	if (expectedFirstSequence !== actualFirstSequence) {
		context.addIssue({
			code: 'custom',
			path: ['earliestAvailableEventSeq'],
			message: 'Event gap metadata does not match the retained journal',
		});
	}
	if (!record.eventsTruncated && record.earliestAvailableEventSeq !== undefined) {
		context.addIssue({
			code: 'custom',
			path: ['earliestAvailableEventSeq'],
			message: 'Untruncated event journals cannot declare a gap',
		});
	}
	if (record.eventsTruncated && (record.earliestAvailableEventSeq ?? 0) <= 1) {
		context.addIssue({
			code: 'custom',
			path: ['earliestAvailableEventSeq'],
			message: 'Truncated event journals must begin after the first event sequence',
		});
	}
	for (let index = 0; index < record.events.length; index += 1) {
		const expectedSequence = actualFirstSequence + index;
		if (record.events[index].eventSeq !== expectedSequence) {
			context.addIssue({
				code: 'custom',
				path: ['events', index, 'eventSeq'],
				message: 'Retained event sequences must form a contiguous suffix',
			});
		}
	}
	if (
		record.events.length > 0
		&& record.events[record.events.length - 1].eventSeq !== record.eventSeq
	) {
		context.addIssue({
			code: 'custom',
			path: ['eventSeq'],
			message: 'Event sequence must match the newest retained event',
		});
	}
	if (
		utf8ByteLength(JSON.stringify(record.events))
		> PROTOCOL_LIMITS.taskEventJournalBytes
	) {
		context.addIssue({
			code: 'custom',
			path: ['events'],
			message: 'Serialized event journal exceeds its reserved response budget',
		});
	}
}

export type PersistedTaskRecord = z.infer<typeof persistedTaskRecordSchema>;
export type PersistedTaskRecordV1 = z.infer<typeof persistedTaskRecordV1Schema>;
export type PersistedTaskRecordV2 = z.infer<typeof persistedTaskRecordV2Schema>;
export type PersistedTaskRoutingTarget = z.infer<typeof persistedTaskRoutingTargetSchema>;

const {
	recoveryDescriptor: _recoveryDescriptorSchema,
	answeredInputs: _answeredInputsSchema,
	workspaceLeaseKey: _workspaceLeaseKeySchema,
	...taskSnapshotCommonFields
} = persistedTaskRecordCommonFields;

const taskSnapshotObjectSchema = z.strictObject({
	schemaVersion: z.union([z.literal(1), z.literal(2)]),
	...taskSnapshotCommonFields,
	deviceId: uuidSchema,
});

function validateWireJournalBudget(
	snapshot: { readonly events: readonly z.infer<typeof taskEventRecordSchema>[] },
	context: z.RefinementCtx,
): void {
	if (
		utf8ByteLength(JSON.stringify(snapshot.events))
		> PROTOCOL_LIMITS.taskEventJournalBytes
	) {
		context.addIssue({
			code: 'custom',
			path: ['events'],
			message: 'Wire event journal exceeds the reserved task response budget',
		});
	}
}

function validateWireEnvelopeBudget(
	snapshot: object,
	context: z.RefinementCtx,
): void {
	const maximalEnvelope = {
		jsonrpc: '2.0',
		id: 'x'.repeat(PROTOCOL_LIMITS.identifierBytes),
		result: snapshot,
	};
	if (utf8ByteLength(JSON.stringify(maximalEnvelope)) >= PROTOCOL_LIMITS.frameBytes) {
		context.addIssue({
			code: 'custom',
			message: 'Serialized task response exceeds the JSON-RPC frame limit',
		});
	}
}

export const taskSnapshotSchema = taskSnapshotObjectSchema
	.superRefine(validateTaskState)
	.superRefine(validateFullJournal)
	.superRefine(validateWireJournalBudget)
	.superRefine(validateWireEnvelopeBudget);

export const taskSnapshotAfterEventSeqSchema = taskSnapshotObjectSchema
	.extend({
		afterEventSeq: z.number().int().nonnegative(),
	})
	.superRefine(validateTaskState)
	.superRefine((snapshot, context) => {
		if (snapshot.afterEventSeq > snapshot.eventSeq) {
			context.addIssue({
				code: 'custom',
				path: ['afterEventSeq'],
				message: 'afterEventSeq cannot exceed the task event sequence',
			});
			return;
		}
		const earliest = snapshot.earliestAvailableEventSeq ?? 1;
		const gap = snapshot.afterEventSeq + 1 < earliest;
		if (snapshot.eventsTruncated !== gap) {
			context.addIssue({
				code: 'custom',
				path: ['eventsTruncated'],
				message: 'Slice truncation must indicate whether afterEventSeq precedes retained events',
			});
		}
		if (snapshot.earliestAvailableEventSeq !== undefined && earliest > snapshot.eventSeq + 1) {
			context.addIssue({
				code: 'custom',
				path: ['earliestAvailableEventSeq'],
				message: 'Earliest retained sequence cannot exceed the next event sequence',
			});
		}
		const expectedFirst = Math.max(snapshot.afterEventSeq + 1, earliest);
		const actualFirst = snapshot.events[0]?.eventSeq ?? snapshot.eventSeq + 1;
		if (actualFirst !== expectedFirst) {
			context.addIssue({
				code: 'custom',
				path: ['events', 0, 'eventSeq'],
				message: 'Sliced events must begin at the first available sequence after afterEventSeq',
			});
		}
		for (let index = 0; index < snapshot.events.length; index += 1) {
			if (snapshot.events[index].eventSeq !== actualFirst + index) {
				context.addIssue({
					code: 'custom',
					path: ['events', index, 'eventSeq'],
					message: 'Sliced event sequences must be contiguous',
				});
			}
		}
		if (
			snapshot.events.length > 0
			&& snapshot.events[snapshot.events.length - 1].eventSeq !== snapshot.eventSeq
		) {
			context.addIssue({
				code: 'custom',
				path: ['eventSeq'],
				message: 'Sliced events must end at the current task event sequence',
			});
		}
	})
	.superRefine((snapshot, context) => {
		validateWireJournalBudget(snapshot, context);
	})
	.superRefine(validateWireEnvelopeBudget);

export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export type TaskSnapshotAfterEventSeq = z.infer<typeof taskSnapshotAfterEventSeqSchema>;
