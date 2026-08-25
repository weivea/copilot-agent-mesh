import { z } from 'zod';

import { GATEWAY_METHODS, MESH_PROTOCOL_VERSION } from './constants';
import { PROTOCOL_LIMITS, utf8ByteLength, utf8String } from './limits';
import {
	deviceInfoSchema,
	taskSnapshotAfterEventSeqSchema,
	taskSnapshotSchema,
	timestampSchema,
	uuidSchema,
	workspaceSummarySchema,
} from './models';
import {
	nodeDirectoryResultSchema,
	routedTaskStartParamsSchema,
} from './nodes';

const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);
const proofSchema = z.string().regex(/^[A-Za-z0-9_-]{43,512}$/);

export const helloParamsSchema = z.strictObject({
	protocolMin: z.number().int().min(1),
	protocolMax: z.number().int().min(1),
	deviceId: uuidSchema,
	nonce: nonceSchema,
});

export const helloResultSchema = z.strictObject({
	protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
	deviceId: uuidSchema,
	nonce: nonceSchema,
	proof: proofSchema,
});

export const authenticateParamsSchema = z.strictObject({
	peerId: uuidSchema,
	sessionId: uuidSchema,
	nonce: nonceSchema,
	proof: proofSchema,
});

export const authenticateResultSchema = z.strictObject({
	authenticated: z.literal(true),
	sessionId: uuidSchema,
});

export const enrollmentCommitParamsSchema = z.strictObject({
	enrollmentId: uuidSchema,
	commitProof: proofSchema,
});

export const enrollmentCommitResultSchema = z.strictObject({
	committed: z.literal(true),
	peerId: uuidSchema,
});

export const pingParamsSchema = z.strictObject({
	sentAt: timestampSchema,
});

export const pingResultSchema = z.strictObject({
	receivedAt: timestampSchema,
});

export const taskStartParamsSchema = z.strictObject({
	delegationRequestId: uuidSchema,
	taskId: uuidSchema,
	workspaceId: uuidSchema,
	title: utf8String(PROTOCOL_LIMITS.taskTitleBytes, 'task title', 1),
	prompt: utf8String(PROTOCOL_LIMITS.taskPromptBytes, 'task prompt', 1),
	acceptanceCriteria: z.array(
		utf8String(PROTOCOL_LIMITS.acceptanceCriterionBytes, 'acceptance criterion', 1),
	).max(PROTOCOL_LIMITS.acceptanceCriteriaCount),
	workerDeadline: timestampSchema,
});

export type TaskStartParams = z.infer<typeof taskStartParamsSchema>;

export const taskGetParamsSchema = z.strictObject({
	taskId: uuidSchema,
	afterEventSeq: z.number().int().nonnegative().optional(),
});

export const taskCancelParamsSchema = z.strictObject({
	taskId: uuidSchema,
});

export const taskAnswerParamsSchema = z.strictObject({
	taskId: uuidSchema,
	inputId: uuidSchema,
	answerId: uuidSchema,
	answer: utf8String(PROTOCOL_LIMITS.taskAnswerBytes, 'task answer', 1),
});

export const methodParamsSchemas = {
	[GATEWAY_METHODS.hello]: helloParamsSchema,
	[GATEWAY_METHODS.authenticate]: authenticateParamsSchema,
	[GATEWAY_METHODS.enrollmentCommit]: enrollmentCommitParamsSchema,
	[GATEWAY_METHODS.ping]: pingParamsSchema,
	[GATEWAY_METHODS.deviceGetInfo]: z.strictObject({}),
	[GATEWAY_METHODS.nodeList]: z.strictObject({}),
	[GATEWAY_METHODS.workspaceList]: z.strictObject({}),
	[GATEWAY_METHODS.taskStart]: routedTaskStartParamsSchema,
	[GATEWAY_METHODS.taskGet]: taskGetParamsSchema,
	[GATEWAY_METHODS.taskCancel]: taskCancelParamsSchema,
	[GATEWAY_METHODS.taskAnswer]: taskAnswerParamsSchema,
} as const;

export const workspaceListResultSchema = z.strictObject({
	workspaces: z.array(workspaceSummarySchema).max(PROTOCOL_LIMITS.workspaceListCount),
}).superRefine((result, context) => {
	const maximalEnvelope = {
		jsonrpc: '2.0',
		id: 'x'.repeat(PROTOCOL_LIMITS.identifierBytes),
		result,
	};
	if (
		utf8ByteLength(JSON.stringify(maximalEnvelope))
		>= PROTOCOL_LIMITS.frameBytes
	) {
		context.addIssue({
			code: 'custom',
			message: 'Serialized workspace.list response exceeds the JSON-RPC frame limit',
		});
	}
});

export const methodResultSchemas = {
	[GATEWAY_METHODS.hello]: helloResultSchema,
	[GATEWAY_METHODS.authenticate]: authenticateResultSchema,
	[GATEWAY_METHODS.enrollmentCommit]: enrollmentCommitResultSchema,
	[GATEWAY_METHODS.ping]: pingResultSchema,
	[GATEWAY_METHODS.deviceGetInfo]: deviceInfoSchema,
	[GATEWAY_METHODS.nodeList]: nodeDirectoryResultSchema,
	[GATEWAY_METHODS.workspaceList]: workspaceListResultSchema,
	[GATEWAY_METHODS.taskStart]: taskSnapshotSchema,
	[GATEWAY_METHODS.taskGet]: z.union([
		taskSnapshotSchema,
		taskSnapshotAfterEventSeqSchema,
	]),
	[GATEWAY_METHODS.taskCancel]: taskSnapshotSchema,
	[GATEWAY_METHODS.taskAnswer]: taskSnapshotSchema,
} as const;
