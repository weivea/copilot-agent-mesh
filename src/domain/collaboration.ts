import { createHash } from 'node:crypto';

import {
	collaborationStartParamsSchema,
	persistedCollaborationRunSchema,
	type CollaborationArtifactReference,
	type CollaborationStartParams,
	type CollaborationStatus,
	type CollaborationValidationSummary,
	type PersistedCollaborationRun,
	type TaskFailure,
	type TaskTarget,
} from '../../shared/protocol';
import { MeshDomainError } from './errors';

export type CollaborationRun = PersistedCollaborationRun;

export type CollaborationDomainEvent =
	| { readonly type: 'taskDispatching'; readonly taskId: string; readonly at: string }
	| { readonly type: 'taskRunning'; readonly taskId: string; readonly at: string }
	| {
		readonly type: 'taskNeedsInput';
		readonly taskId: string;
		readonly at: string;
		readonly inputId: string;
		readonly prompt: string;
	}
	| { readonly type: 'taskCompleted'; readonly taskId: string; readonly at: string }
	| {
		readonly type: 'taskFailed';
		readonly taskId: string;
		readonly at: string;
		readonly failure: TaskFailure;
	}
	| { readonly type: 'taskCancelled'; readonly taskId: string; readonly at: string }
	| {
		readonly type: 'taskBlocked';
		readonly taskId: string;
		readonly at: string;
		readonly code: string;
		readonly message: string;
		readonly retryable: boolean;
	}
	| { readonly type: 'taskUnblocked'; readonly taskId: string; readonly at: string }
	| {
		readonly type: 'artifactAttached';
		readonly taskId: string;
		readonly at: string;
		readonly artifact: CollaborationArtifactReference;
	}
	| {
		readonly type: 'validationRecorded';
		readonly taskId: string;
		readonly at: string;
		readonly validation: CollaborationValidationSummary;
	}
	| { readonly type: 'cancelRequested'; readonly at: string };

export function canonicalCollaborationRequest(
	sourceNodeId: string,
	input: CollaborationStartParams,
): string {
	const parsed = collaborationStartParamsSchema.parse(input);
	const fields = [
		sourceNodeId,
		parsed.collaborationRequestId,
		parsed.title,
		parsed.goal,
		String(parsed.timeoutMinutes),
		...targetFields(parsed.frontend),
		...targetFields(parsed.backend),
	];
	return fields.map(lengthPrefix).join('');
}

export function canonicalCollaborationRequestHash(
	sourceNodeId: string,
	input: CollaborationStartParams,
): string {
	return createHash('sha256')
		.update(canonicalCollaborationRequest(sourceNodeId, input), 'utf8')
		.digest('hex');
}

export function deterministicCollaborationId(
	collaborationRequestId: string,
	purpose = 'run',
): string {
	const bytes = createHash('sha256')
		.update('copilot-agent-mesh/collaboration/v1\0', 'utf8')
		.update(collaborationRequestId, 'utf8')
		.update('\0', 'utf8')
		.update(purpose, 'utf8')
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createCollaborationRun(
	sourceNodeId: string,
	input: CollaborationStartParams,
	at: string,
): CollaborationRun {
	const parsed = collaborationStartParamsSchema.parse(input);
	if (
		parsed.frontend.deviceId !== parsed.backend.deviceId
		|| parsed.frontend.workspaceId === parsed.backend.workspaceId
	) {
		throw new MeshDomainError(
			'COLLABORATION_DAG_INVALID',
			'Same-device collaboration requires two different workspaces on one device.',
		);
	}
	const coordinator = participantForSource(sourceNodeId, parsed.frontend, parsed.backend);
	const runId = deterministicCollaborationId(parsed.collaborationRequestId);
	const backendTaskId = deterministicCollaborationId(parsed.collaborationRequestId, 'backend-implementation-task');
	const frontendTaskId = deterministicCollaborationId(parsed.collaborationRequestId, 'frontend-implementation-task');
	const backendValidationTaskId = deterministicCollaborationId(parsed.collaborationRequestId, 'backend-validation-task');
	const frontendValidationTaskId = deterministicCollaborationId(parsed.collaborationRequestId, 'frontend-validation-task');
	const deadline = new Date(
		Date.parse(at) + parsed.timeoutMinutes * 60_000,
	).toISOString();
	return persistedCollaborationRunSchema.parse({
		schemaVersion: 1,
		runId,
		collaborationRequestId: parsed.collaborationRequestId,
		requestHash: canonicalCollaborationRequestHash(sourceNodeId, parsed),
		coordinator,
		participants: [
			{ role: 'frontend', target: parsed.frontend },
			{ role: 'backend', target: parsed.backend },
		],
		title: parsed.title,
		goal: parsed.goal,
		tasks: [
			createTask(
				parsed.collaborationRequestId,
				backendTaskId,
				'backend',
				'implementation',
				'Backend contract and implementation',
				parsed.backend,
				[],
				deadline,
			),
			createTask(
				parsed.collaborationRequestId,
				frontendTaskId,
				'frontend',
				'implementation',
				'Frontend implementation',
				parsed.frontend,
				[backendTaskId],
				deadline,
			),
			createTask(
				parsed.collaborationRequestId,
				backendValidationTaskId,
				'backend',
				'validation',
				'Backend validation',
				parsed.backend,
				[frontendTaskId],
				deadline,
			),
			createTask(
				parsed.collaborationRequestId,
				frontendValidationTaskId,
				'frontend',
				'validation',
				'Frontend validation',
				parsed.frontend,
				[frontendTaskId],
				deadline,
			),
		],
		status: 'pending',
		artifactIds: [],
		createdAt: at,
		updatedAt: at,
	});
}

export function collaborationReducer(
	run: CollaborationRun,
	event: CollaborationDomainEvent,
): CollaborationRun {
	if (isTerminal(run.status)) {
		return run;
	}
	let tasks = [...run.tasks];
	let artifactIds = [...run.artifactIds];
	let cancellationRequestedAt = run.cancellationRequestedAt;
	switch (event.type) {
		case 'taskDispatching':
			tasks = updateTask(tasks, event.taskId, (task) => {
				if (task.status === 'running' || task.status === 'needsInput') {
					return task;
				}
				if (task.status !== 'pending' && !(task.status === 'blocked' && task.block?.retryable)) {
					throw invalidTransition(task.status, event.type);
				}
				return {
					...task,
					status: 'running',
					block: undefined,
					pendingInput: undefined,
				};
			});
			break;
		case 'taskRunning':
			tasks = updateTask(tasks, event.taskId, (task) => {
				if (task.status === 'running') {
					return task;
				}
				if (task.status !== 'needsInput') {
					throw invalidTransition(task.status, event.type);
				}
				return {
					...task,
					status: 'running',
					pendingInput: undefined,
				};
			});
			break;
		case 'taskNeedsInput':
			tasks = updateTask(tasks, event.taskId, (task) => {
				if (task.status !== 'running' && task.status !== 'needsInput') {
					throw invalidTransition(task.status, event.type);
				}
				return {
					...task,
					status: 'needsInput',
					pendingInput: { inputId: event.inputId, prompt: event.prompt },
				};
			});
			break;
		case 'taskCompleted':
			tasks = updateTask(tasks, event.taskId, (task) => {
				if (task.status === 'completed') {
					return task;
				}
				if (task.status !== 'running' && task.status !== 'needsInput') {
					throw invalidTransition(task.status, event.type);
				}
				if (task.kind === 'validation' && task.validation === undefined) {
					throw new MeshDomainError(
						'VALIDATION_FAILED',
						'A validation task cannot complete without a verified validation result.',
					);
				}
				return {
					...task,
					status: 'completed',
					pendingInput: undefined,
					failure: undefined,
					block: undefined,
				};
			});
			break;
		case 'taskFailed':
			tasks = updateTask(tasks, event.taskId, (task) => {
				if (task.status === 'failed') {
					return task;
				}
				if (!['pending', 'running', 'blocked', 'needsInput'].includes(task.status)) {
					throw invalidTransition(task.status, event.type);
				}
				return {
					...task,
					status: 'failed',
					pendingInput: undefined,
					block: undefined,
					failure: event.failure,
				};
			});
			tasks = blockDependants(tasks, event.taskId);
			break;
		case 'taskCancelled':
			tasks = updateTask(tasks, event.taskId, (task) => {
				if (task.status === 'cancelled') {
					return task;
				}
				if (!['pending', 'running', 'blocked', 'needsInput'].includes(task.status)) {
					throw invalidTransition(task.status, event.type);
				}
				return {
					...task,
					status: 'cancelled',
					pendingInput: undefined,
					failure: undefined,
					block: undefined,
				};
			});
			tasks = blockDependants(tasks, event.taskId);
			break;
		case 'taskBlocked':
			tasks = updateTask(tasks, event.taskId, (task) => {
				if (task.status === 'blocked' && task.block?.code === event.code) {
					return task;
				}
				if (!['pending', 'running', 'blocked', 'needsInput'].includes(task.status)) {
					throw invalidTransition(task.status, event.type);
				}
				return {
					...task,
					status: 'blocked',
					block: {
						code: event.code,
						message: event.message,
						retryable: event.retryable,
					},
					pendingInput: undefined,
				};
			});
			break;
		case 'taskUnblocked':
			tasks = updateTask(tasks, event.taskId, (task) => {
				if (task.status !== 'blocked' || task.block?.retryable !== true) {
					throw invalidTransition(task.status, event.type);
				}
				return { ...task, status: 'pending', block: undefined };
			});
			break;
		case 'artifactAttached':
			tasks = updateTask(tasks, event.taskId, (task) => ({
				...task,
				artifactIds: task.artifactIds.includes(event.artifact.artifactId)
					? task.artifactIds
					: [...task.artifactIds, event.artifact.artifactId],
			}));
			if (!artifactIds.includes(event.artifact.artifactId)) {
				artifactIds.push(event.artifact.artifactId);
			}
			break;
		case 'validationRecorded':
			tasks = updateTask(tasks, event.taskId, (task) => {
				if (
					task.kind !== 'validation'
					|| task.target.workspaceId !== event.validation.workspaceId
					|| task.role !== event.validation.role
				) {
					throw new MeshDomainError(
						'VALIDATION_FAILED',
						'The validation result does not match its collaboration task.',
					);
				}
				return { ...task, validation: event.validation };
			});
			break;
		case 'cancelRequested':
			cancellationRequestedAt ??= event.at;
			tasks = tasks.map((task) =>
				task.status === 'pending' || task.status === 'blocked'
					? {
						...task,
						status: 'cancelled' as const,
						block: undefined,
						pendingInput: undefined,
					}
					: task,
			);
			break;
	}
	return persistedCollaborationRunSchema.parse({
		...run,
		tasks,
		artifactIds,
		cancellationRequestedAt,
		status: deriveRunStatus(tasks, cancellationRequestedAt !== undefined),
		updatedAt: event.at,
	});
}

export function readyCollaborationTasks(run: CollaborationRun): readonly CollaborationRun['tasks'][number][] {
	if (run.cancellationRequestedAt !== undefined || isTerminal(run.status)) {
		return [];
	}
	const byId = new Map(run.tasks.map((task) => [task.taskId, task]));
	return run.tasks.filter((task) =>
		(task.status === 'pending' || (task.status === 'blocked' && task.block?.retryable === true))
		&& task.dependsOn.every((taskId) => byId.get(taskId)?.status === 'completed'),
	);
}

function createTask(
	requestId: string,
	taskId: string,
	role: 'frontend' | 'backend',
	kind: 'implementation' | 'validation',
	title: string,
	target: TaskTarget,
	dependsOn: readonly string[],
	workerDeadline: string,
): CollaborationRun['tasks'][number] {
	return {
		taskId,
		delegationRequestId: deterministicCollaborationId(
			requestId,
			`${role}-${kind}-delegation`,
		),
		kind,
		role,
		title,
		target,
		dependsOn: [...dependsOn],
		status: 'pending',
		workerDeadline,
		artifactIds: [],
	};
}

function participantForSource(
	sourceNodeId: string,
	frontend: TaskTarget,
	backend: TaskTarget,
): TaskTarget {
	const matches = [frontend, backend].filter(({ nodeId }) => nodeId === sourceNodeId);
	if (matches.length === 0) {
		throw new MeshDomainError(
			'COLLABORATION_DAG_INVALID',
			'The collaboration coordinator must be one of its participant Window Nodes.',
		);
	}
	return matches[0];
}

function updateTask(
	tasks: CollaborationRun['tasks'],
	taskId: string,
	update: (task: CollaborationRun['tasks'][number]) => CollaborationRun['tasks'][number],
): CollaborationRun['tasks'] {
	let found = false;
	const updated = tasks.map((task) => {
		if (task.taskId !== taskId) {
			return task;
		}
		found = true;
		return update(task);
	});
	if (!found) {
		throw new MeshDomainError('COLLABORATION_DAG_INVALID', 'Collaboration task not found.');
	}
	return updated;
}

function blockDependants(
	tasks: CollaborationRun['tasks'],
	failedTaskId: string,
): CollaborationRun['tasks'] {
	const blocked = new Set([failedTaskId]);
	let changed = true;
	let result = [...tasks];
	while (changed) {
		changed = false;
		result = result.map((task) => {
			if (
				(task.status === 'pending' || task.status === 'blocked')
				&& task.dependsOn.some((dependency) => blocked.has(dependency))
			) {
				blocked.add(task.taskId);
				if (task.status !== 'blocked' || task.block?.code !== 'DEPENDENCY_FAILED') {
					changed = true;
				}
				return {
					...task,
					status: 'blocked',
					block: {
						code: 'DEPENDENCY_FAILED',
						message: 'A required collaboration dependency did not complete.',
						retryable: false,
					},
				};
			}
			return task;
		});
	}
	return result;
}

function deriveRunStatus(
	tasks: CollaborationRun['tasks'],
	cancellationRequested: boolean,
): CollaborationStatus {
	if (cancellationRequested && tasks.every(({ status }) =>
		status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'blocked',
	)) {
		return 'cancelled';
	}
	if (tasks.some(({ status }) => status === 'failed')) {
		return 'failed';
	}
	if (tasks.every(({ status }) => status === 'completed')) {
		return 'completed';
	}
	if (tasks.some(({ status }) => status === 'needsInput')) {
		return 'needsInput';
	}
	if (tasks.some(({ status }) => status === 'running')) {
		return 'running';
	}
	if (tasks.some(({ status, block }) => status === 'blocked' && block?.retryable === false)) {
		return 'failed';
	}
	if (tasks.some(({ status }) => status === 'blocked')) {
		return 'blocked';
	}
	return 'pending';
}

function targetFields(target: TaskTarget): readonly string[] {
	return [
		target.deviceId,
		target.nodeId,
		target.nodeInstanceId,
		target.workspaceId,
	];
}

function lengthPrefix(value: string): string {
	return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

function invalidTransition(status: string, event: string): MeshDomainError {
	return new MeshDomainError(
		'COLLABORATION_DAG_INVALID',
		`Collaboration event "${event}" is invalid for task state "${status}".`,
	);
}

function isTerminal(status: CollaborationStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'cancelled';
}
