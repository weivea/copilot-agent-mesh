import { z } from 'zod';

import { PROTOCOL_LIMITS, utf8ByteLength, utf8String } from './limits';
import {
	pendingInputSchema,
	taskFailureSchema,
	timestampSchema,
	uuidSchema,
} from './models';
import { taskTargetSchema } from './nodes';

export const COLLABORATION_ROLES = ['frontend', 'backend'] as const;
export const COLLABORATION_TASK_KINDS = ['implementation', 'validation'] as const;
export const COLLABORATION_STATUSES = [
	'pending',
	'running',
	'blocked',
	'needsInput',
	'completed',
	'failed',
	'cancelled',
] as const;
export const ARTIFACT_MEDIA_TYPES = [
	'application/json',
	'application/schema+json',
	'application/vnd.oai.openapi+json',
] as const;

export const collaborationRoleSchema = z.enum(COLLABORATION_ROLES);
export const collaborationTaskKindSchema = z.enum(COLLABORATION_TASK_KINDS);
export const collaborationStatusSchema = z.enum(COLLABORATION_STATUSES);
export const artifactMediaTypeSchema = z.enum(ARTIFACT_MEDIA_TYPES);

export const collaborationParticipantSchema = z.strictObject({
	role: collaborationRoleSchema,
	target: taskTargetSchema,
});

export const collaborationValidationSummarySchema = z.strictObject({
	taskId: uuidSchema,
	workspaceId: uuidSchema,
	role: collaborationRoleSchema,
	status: z.enum(['passed', 'failed']),
	summary: utf8String(PROTOCOL_LIMITS.errorMessageBytes, 'validation summary', 1),
});

export const collaborationArtifactReferenceSchema = z.strictObject({
	artifactId: uuidSchema,
	runId: uuidSchema,
	producerTaskId: uuidSchema,
	label: utf8String(PROTOCOL_LIMITS.artifactLabelBytes, 'artifact label', 1),
	mediaType: artifactMediaTypeSchema,
	contentLength: z.number().int().positive().max(PROTOCOL_LIMITS.artifactContentBytes),
	sha256: z.string().regex(/^[a-f0-9]{64}$/u),
	revision: z.literal(1),
	createdAt: timestampSchema,
});

const collaborationTaskRecordSchema = z.strictObject({
	taskId: uuidSchema,
	delegationRequestId: uuidSchema,
	kind: collaborationTaskKindSchema,
	role: collaborationRoleSchema,
	title: utf8String(PROTOCOL_LIMITS.taskTitleBytes, 'collaboration task title', 1),
	target: taskTargetSchema,
	dependsOn: z.array(uuidSchema).max(PROTOCOL_LIMITS.collaborationTaskCount),
	status: collaborationStatusSchema,
	workerDeadline: timestampSchema,
	artifactIds: z.array(uuidSchema).max(PROTOCOL_LIMITS.collaborationArtifactCount),
	pendingInput: pendingInputSchema.optional(),
	validation: collaborationValidationSummarySchema.optional(),
	failure: taskFailureSchema.optional(),
	block: z.strictObject({
		code: utf8String(128, 'collaboration block code', 1),
		message: utf8String(PROTOCOL_LIMITS.errorMessageBytes, 'collaboration block message', 1),
		retryable: z.boolean(),
	}).optional(),
}).superRefine((task, context) => {
	if ((task.status === 'needsInput') !== (task.pendingInput !== undefined)) {
		context.addIssue({
			code: 'custom',
			path: ['pendingInput'],
			message: 'Only needsInput collaboration tasks contain pending input',
		});
	}
	if ((task.status === 'failed') !== (task.failure !== undefined)) {
		context.addIssue({
			code: 'custom',
			path: ['failure'],
			message: 'Only failed collaboration tasks contain failure details',
		});
	}
	if ((task.status === 'blocked') !== (task.block !== undefined)) {
		context.addIssue({
			code: 'custom',
			path: ['block'],
			message: 'Only blocked collaboration tasks contain block details',
		});
	}
	if (
		(task.kind === 'validation' && task.status === 'completed' && task.validation === undefined)
		|| (task.kind !== 'validation' && task.validation !== undefined)
	) {
		context.addIssue({
			code: 'custom',
			path: ['validation'],
			message: 'Completed validation tasks must contain a validation summary',
		});
	}
});

export const persistedCollaborationRunSchema = z.strictObject({
	schemaVersion: z.literal(1),
	runId: uuidSchema,
	collaborationRequestId: uuidSchema,
	requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
	coordinator: taskTargetSchema,
	participants: z.array(collaborationParticipantSchema).length(2),
	title: utf8String(PROTOCOL_LIMITS.taskTitleBytes, 'collaboration title', 1),
	goal: utf8String(PROTOCOL_LIMITS.collaborationGoalBytes, 'collaboration goal', 1),
	tasks: z.array(collaborationTaskRecordSchema)
		.min(2)
		.max(PROTOCOL_LIMITS.collaborationTaskCount),
	status: collaborationStatusSchema,
	artifactIds: z.array(uuidSchema).max(PROTOCOL_LIMITS.collaborationArtifactCount),
	cancellationRequestedAt: timestampSchema.optional(),
	createdAt: timestampSchema,
	updatedAt: timestampSchema,
}).superRefine(validateRun);

const collaborationTaskSnapshotSchema = collaborationTaskRecordSchema.omit({
	workerDeadline: true,
});

export const collaborationRunSnapshotSchema = z.strictObject({
	schemaVersion: z.literal(1),
	runId: uuidSchema,
	collaborationRequestId: uuidSchema,
	coordinator: taskTargetSchema,
	participants: z.array(collaborationParticipantSchema).length(2),
	title: utf8String(PROTOCOL_LIMITS.taskTitleBytes, 'collaboration title', 1),
	tasks: z.array(collaborationTaskSnapshotSchema)
		.min(2)
		.max(PROTOCOL_LIMITS.collaborationTaskCount),
	status: collaborationStatusSchema,
	artifacts: z.array(collaborationArtifactReferenceSchema)
		.max(PROTOCOL_LIMITS.collaborationArtifactCount),
	validations: z.array(collaborationValidationSummarySchema)
		.max(PROTOCOL_LIMITS.collaborationTaskCount),
	cancellationRequested: z.boolean(),
	createdAt: timestampSchema,
	updatedAt: timestampSchema,
});

export const collaborationStartParamsSchema = z.strictObject({
	collaborationRequestId: uuidSchema,
	title: utf8String(PROTOCOL_LIMITS.taskTitleBytes, 'collaboration title', 1),
	goal: utf8String(PROTOCOL_LIMITS.collaborationGoalBytes, 'collaboration goal', 1),
	frontend: taskTargetSchema,
	backend: taskTargetSchema,
	timeoutMinutes: z.number().int().min(1).max(1_440).default(60),
});

export const collaborationRunParamsSchema = z.strictObject({
	runId: uuidSchema,
});

export const COLLABORATION_LOCAL_METHODS = {
	start: 'broker.collaboration.start',
	get: 'broker.collaboration.get',
	list: 'broker.collaboration.list',
	cancel: 'broker.collaboration.cancel',
} as const;

export const localCollaborationMethodParamsSchemas = {
	[COLLABORATION_LOCAL_METHODS.start]: collaborationStartParamsSchema,
	[COLLABORATION_LOCAL_METHODS.get]: collaborationRunParamsSchema,
	[COLLABORATION_LOCAL_METHODS.list]: z.strictObject({}),
	[COLLABORATION_LOCAL_METHODS.cancel]: collaborationRunParamsSchema,
} as const;

export const collaborationListResultSchema = z.strictObject({
	runs: z.array(collaborationRunSnapshotSchema).max(PROTOCOL_LIMITS.collaborationListCount),
	truncated: z.boolean(),
	totalRuns: z.number().int().nonnegative(),
}).superRefine((result, context) => {
	if (
		result.totalRuns < result.runs.length
		|| result.truncated !== (result.totalRuns > result.runs.length)
	) {
		context.addIssue({
			code: 'custom',
			path: ['totalRuns'],
			message: 'Collaboration truncation metadata is inconsistent',
		});
	}
	if (utf8ByteLength(JSON.stringify(result)) >= PROTOCOL_LIMITS.frameBytes) {
		context.addIssue({
			code: 'custom',
			message: 'Serialized collaboration list exceeds the local IPC frame limit',
		});
	}
});

export type CollaborationRole = z.infer<typeof collaborationRoleSchema>;
export type CollaborationStatus = z.infer<typeof collaborationStatusSchema>;
export type CollaborationTaskKind = z.infer<typeof collaborationTaskKindSchema>;
export type CollaborationParticipant = z.infer<typeof collaborationParticipantSchema>;
export type CollaborationValidationSummary = z.infer<typeof collaborationValidationSummarySchema>;
export type CollaborationArtifactReference = z.infer<typeof collaborationArtifactReferenceSchema>;
export type PersistedCollaborationRun = z.infer<typeof persistedCollaborationRunSchema>;
export type CollaborationTaskRecord = PersistedCollaborationRun['tasks'][number];
export type CollaborationRunSnapshot = z.infer<typeof collaborationRunSnapshotSchema>;
export type CollaborationStartParams = z.infer<typeof collaborationStartParamsSchema>;
export type CollaborationListResult = z.infer<typeof collaborationListResultSchema>;

function validateRun(
	run: Omit<PersistedCollaborationRun, never>,
	context: z.RefinementCtx,
): void {
	const roles = run.participants.map(({ role }) => role);
	if (new Set(roles).size !== 2 || !roles.includes('frontend') || !roles.includes('backend')) {
		context.addIssue({
			code: 'custom',
			path: ['participants'],
			message: 'Collaboration runs require exactly one frontend and one backend participant',
		});
	}
	if (new Set(run.participants.map(({ target }) => target.workspaceId)).size !== 2) {
		context.addIssue({
			code: 'custom',
			path: ['participants'],
			message: 'Collaboration participants must use different workspaces',
		});
	}
	if (!run.participants.some(({ target }) =>
		target.deviceId === run.coordinator.deviceId
		&& target.nodeId === run.coordinator.nodeId
		&& target.nodeInstanceId === run.coordinator.nodeInstanceId
		&& target.workspaceId === run.coordinator.workspaceId,
	)) {
		context.addIssue({
			code: 'custom',
			path: ['coordinator'],
			message: 'The coordinator must be one of the collaboration participants',
		});
	}
	const tasks = new Map(run.tasks.map((task) => [task.taskId, task]));
	if (tasks.size !== run.tasks.length) {
		context.addIssue({
			code: 'custom',
			path: ['tasks'],
			message: 'Collaboration task IDs must be unique',
		});
		return;
	}
	for (const [index, task] of run.tasks.entries()) {
		if (new Set(task.dependsOn).size !== task.dependsOn.length || task.dependsOn.includes(task.taskId)) {
			context.addIssue({
				code: 'custom',
				path: ['tasks', index, 'dependsOn'],
				message: 'Collaboration dependencies must be unique and cannot reference the task itself',
			});
		}
		for (const dependency of task.dependsOn) {
			if (!tasks.has(dependency)) {
				context.addIssue({
					code: 'custom',
					path: ['tasks', index, 'dependsOn'],
					message: 'Collaboration dependencies must reference tasks in the same run',
				});
			}
		}
		const participant = run.participants.find(({ role }) => role === task.role);
		if (
			participant === undefined
			|| participant.target.deviceId !== task.target.deviceId
			|| participant.target.nodeId !== task.target.nodeId
			|| participant.target.nodeInstanceId !== task.target.nodeInstanceId
			|| participant.target.workspaceId !== task.target.workspaceId
		) {
			context.addIssue({
				code: 'custom',
				path: ['tasks', index, 'target'],
				message: 'Every collaboration task must target its role participant',
			});
		}
	}
	for (const task of run.tasks) {
		if (hasCycle(task.taskId, tasks, new Set(), new Set())) {
			context.addIssue({
				code: 'custom',
				path: ['tasks'],
				message: 'Collaboration dependencies must form an acyclic graph',
			});
			break;
		}
	}
}

function hasCycle(
	taskId: string,
	tasks: ReadonlyMap<string, CollaborationTaskRecord>,
	visiting: Set<string>,
	visited: Set<string>,
): boolean {
	if (visiting.has(taskId)) {
		return true;
	}
	if (visited.has(taskId)) {
		return false;
	}
	visiting.add(taskId);
	for (const dependency of tasks.get(taskId)?.dependsOn ?? []) {
		if (hasCycle(dependency, tasks, visiting, visited)) {
			return true;
		}
	}
	visiting.delete(taskId);
	visited.add(taskId);
	return false;
}
