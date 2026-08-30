import { z } from 'zod';

import {
	ACTIVE_TASK_STATUSES,
	artifactMediaTypeSchema,
	collaborationListResultSchema,
	collaborationRunSnapshotSchema,
	collaborationStartParamsSchema,
	PROTOCOL_LIMITS,
	type CollaborationListResult,
	type CollaborationRunSnapshot,
	type CollaborationStartParams,
	type CollaborationValidationSummary,
	type TaskSnapshot,
	type TaskTarget,
} from '../../shared/protocol';
import {
	collaborationReducer,
	createCollaborationRun,
	deterministicCollaborationId,
	readyCollaborationTasks,
	type CollaborationRun,
} from '../domain/collaboration';
import { MeshDomainError } from '../domain/errors';
import type { Clock } from '../domain/ports';
import type { ArtifactStore } from '../tasks/ArtifactStore';
import type { FileCollaborationStore } from '../tasks/FileCollaborationStore';
import type {
	BrokerTaskService,
	BrokerTaskStartOutcome,
} from './BrokerTaskService';
import type { NodeRegistry } from './NodeRegistry';
import type { TaskRouteCatalog } from './TaskRouteCatalog';

const contractEnvelopeSchema = z.strictObject({
	schemaVersion: z.literal(1),
	label: z.string().min(1),
	mediaType: artifactMediaTypeSchema,
	content: z.json(),
});

const validationEnvelopeSchema = z.strictObject({
	schemaVersion: z.literal(1),
	status: z.enum(['passed', 'failed']),
	summary: z.string().min(1),
});

const contractMarkerStart = 'MESH_CONTRACT_ARTIFACT_V1_BEGIN';
const contractMarkerEnd = 'MESH_CONTRACT_ARTIFACT_V1_END';
const validationMarkerStart = 'MESH_VALIDATION_RESULT_V1_BEGIN';
const validationMarkerEnd = 'MESH_VALIDATION_RESULT_V1_END';
const activeTaskStates = new Set<string>(ACTIVE_TASK_STATUSES);
const retryableRouteErrors = new Set([
	'WORKSPACE_NOT_FOUND',
	'WORKSPACE_BUSY',
	'WORKER_DRAINING',
	'AGENT_UNAVAILABLE',
	'TASK_RECOVERY_UNAVAILABLE',
]);

export interface CollaborationCaller {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
}

export interface CollaborationServiceOptions {
	readonly enabled: () => boolean;
	readonly onDidChange?: () => void;
	readonly onBackgroundError?: (error: Error) => void;
}

export type CollaborationTaskService = Pick<
	BrokerTaskService,
	| 'startLocal'
	| 'prevalidateLocal'
	| 'reconcileStartFailure'
	| 'getLocal'
	| 'cancel'
>;

export type CollaborationNodeRegistry = Pick<NodeRegistry, 'list'>;
export type CollaborationTaskRoutes = Pick<
	TaskRouteCatalog,
	| 'assertLocalCompatible'
	| 'reserveLocalAttempt'
	| 'retainAmbiguous'
	| 'releaseAmbiguous'
	| 'markSnapshot'
>;

export class CollaborationService {
	private operationQueue: Promise<void> = Promise.resolve();
	private readonly observedSnapshots = new Map<string, TaskSnapshot>();
	private disposed = false;

	public constructor(
		private readonly deviceId: string,
		private readonly registry: CollaborationNodeRegistry,
		private readonly tasks: CollaborationTaskService,
		private readonly taskRoutes: CollaborationTaskRoutes,
		private readonly runs: FileCollaborationStore,
		private readonly artifacts: ArtifactStore,
		private readonly clock: Clock,
		private readonly options: CollaborationServiceOptions,
	) {}

	public initialize(): Promise<void> {
		return this.runExclusive(async () => {
			for (const run of await this.runs.list()) {
				await this.reconcileRun(run.runId);
			}
		});
	}

	public start(
		caller: CollaborationCaller,
		input: CollaborationStartParams,
	): Promise<CollaborationRunSnapshot> {
		return this.runExclusive(async () => {
			if (!this.options.enabled()) {
				throw new MeshDomainError(
					'FEATURE_DISABLED',
					'Same-device multi-project collaboration Preview is disabled.',
				);
			}
			const parsed = collaborationStartParamsSchema.parse(input);
			const created = createCollaborationRun(
				caller.nodeId,
				parsed,
				this.clock.now().toISOString(),
			);
			const existing = await this.runs.findIdempotent(caller.nodeId, parsed);
			if (existing !== undefined) {
				await this.reconcileRun(existing.runId);
				return this.snapshot(await this.requireAccessible(caller, existing.runId));
			}
			this.assertParticipantTargets(caller, parsed.frontend, parsed.backend);
			const result = await this.runs.createIdempotent(caller.nodeId, parsed, created);
			await this.reconcileRun(result.run.runId);
			return this.snapshot(await this.requireAccessible(caller, result.run.runId));
		});
	}

	public get(
		caller: CollaborationCaller,
		runId: string,
	): Promise<CollaborationRunSnapshot> {
		return this.runExclusive(async () => {
			const run = await this.requireAccessible(caller, runId);
			await this.reconcileRun(run.runId);
			return this.snapshot(await this.requireAccessible(caller, run.runId));
		});
	}

	public list(caller: CollaborationCaller): Promise<CollaborationListResult> {
		return this.runExclusive(async () => {
			const accessible = (await this.runs.list())
				.filter((run) => this.canAccess(caller, run))
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
			const selected = accessible.slice(0, PROTOCOL_LIMITS.collaborationListCount);
			return collaborationListResultSchema.parse({
				runs: await Promise.all(selected.map((run) => this.snapshot(run))),
				truncated: selected.length < accessible.length,
				totalRuns: accessible.length,
			});
		});
	}

	public listAll(): Promise<CollaborationListResult> {
		return this.runExclusive(async () => {
			const records = [...await this.runs.list()]
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
			const selected = records.slice(0, PROTOCOL_LIMITS.collaborationListCount);
			return collaborationListResultSchema.parse({
				runs: await Promise.all(selected.map((run) => this.snapshot(run))),
				truncated: selected.length < records.length,
				totalRuns: records.length,
			});
		});
	}

	public cancel(
		caller: CollaborationCaller,
		runId: string,
	): Promise<CollaborationRunSnapshot> {
		return this.runExclusive(async () => {
			const run = await this.requireAccessible(caller, runId);
			if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
				throw new MeshDomainError(
					'COLLABORATION_NOT_CANCELLABLE',
					'The collaboration run is no longer cancellable.',
				);
			}
			const activeTaskIds = run.tasks
				.filter(({ status }) => status === 'running' || status === 'needsInput')
				.map(({ taskId }) => taskId);
			await this.runs.transition(run.runId, {
				type: 'cancelRequested',
				at: this.clock.now().toISOString(),
			});
			for (const taskId of activeTaskIds) {
				try {
					const snapshot = await this.tasks.cancel(this.deviceId, taskId);
					await this.applyTaskSnapshot(run.runId, snapshot);
				} catch (error: unknown) {
					if (meshReason(error) !== 'TASK_NOT_CANCELLABLE') {
						throw error;
					}
					const snapshot = await this.tasks.getLocal(taskId);
					await this.applyTaskSnapshot(run.runId, snapshot as TaskSnapshot);
				}
			}
			await this.reconcileRun(run.runId);
			return this.snapshot(await this.requireAccessible(caller, run.runId));
		});
	}

	public observeTaskSnapshot(snapshot: TaskSnapshot): void {
		if (this.disposed) {
			return;
		}
		this.observedSnapshots.set(snapshot.taskId, snapshot);
		this.kickReconciliation();
	}

	public topologyChanged(): void {
		if (!this.disposed) {
			this.kickReconciliation();
		}
	}

	public async dispose(): Promise<void> {
		if (this.disposed) {
			await this.operationQueue;
			return;
		}
		this.disposed = true;
		await this.operationQueue;
		this.observedSnapshots.clear();
	}

	private kickReconciliation(): void {
		void this.runExclusive(async () => {
			for (const run of await this.runs.list()) {
				await this.reconcileRun(run.runId);
			}
		}).catch((error: unknown) => {
			this.options.onBackgroundError?.(asError(error));
		});
	}

	private async reconcileRun(runId: string): Promise<void> {
		let run = await this.runs.get(runId);
		if (run === undefined || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
			return;
		}
		for (const task of run.tasks.filter(({ status }) =>
			status === 'running' || status === 'needsInput',
		)) {
			let snapshot = this.observedSnapshots.get(task.taskId);
			this.observedSnapshots.delete(task.taskId);
			if (snapshot === undefined) {
				try {
					snapshot = await this.tasks.getLocal(task.taskId) as TaskSnapshot;
				} catch (error: unknown) {
					if (meshReason(error) !== 'TASK_NOT_FOUND') {
						throw error;
					}
					run = await this.runs.transition(run.runId, {
						type: 'taskBlocked',
						taskId: task.taskId,
						at: this.clock.now().toISOString(),
						code: 'TASK_RECOVERY_UNAVAILABLE',
						message: 'The accepted Broker task was not found after ownership recovery.',
						retryable: true,
					});
				}
			}
			if (snapshot !== undefined) {
				run = await this.applyTaskSnapshot(run.runId, snapshot);
			}
		}
		if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
			return;
		}
		for (const task of readyCollaborationTasks(run)) {
			run = await this.dispatchTask(run, task.taskId);
			if (run.status === 'failed' || run.status === 'cancelled') {
				return;
			}
		}
	}

	private async dispatchTask(run: CollaborationRun, taskId: string): Promise<CollaborationRun> {
		let current = await this.runs.transition(run.runId, {
			type: 'taskDispatching',
			taskId,
			at: this.clock.now().toISOString(),
		});
		const task = current.tasks.find((candidate) => candidate.taskId === taskId);
		if (task === undefined) {
			throw new MeshDomainError('COLLABORATION_DAG_INVALID', 'Collaboration task not found.');
		}
		if (Date.parse(task.workerDeadline) <= this.clock.now().valueOf()) {
			return this.runs.transition(current.runId, {
				type: 'taskFailed',
				taskId,
				at: this.clock.now().toISOString(),
				failure: {
					code: 'TASK_EXECUTION_FAILED',
					message: 'The collaboration deadline expired before this task could start.',
					retryable: false,
				},
			});
		}
		try {
			const prompt = await this.buildPrompt(current, taskId);
			const input = {
				delegationRequestId: task.delegationRequestId,
				taskId: task.taskId,
				target: task.target,
				sourceNodeId: current.coordinator.nodeId,
				title: task.title,
				prompt,
				acceptanceCriteria: [...acceptanceCriteria(task.kind, task.role)],
				workerDeadline: task.workerDeadline,
			};
			this.taskRoutes.assertLocalCompatible(
				input,
				{ nodeId: current.coordinator.nodeId },
			);
			await this.tasks.prevalidateLocal(current.coordinator.nodeId, input);
			const reservation = await this.taskRoutes.reserveLocalAttempt(
				input,
				{ nodeId: current.coordinator.nodeId },
			);
			const outcome: BrokerTaskStartOutcome = { nodeRequestAttempted: false };
			let snapshot: TaskSnapshot;
			try {
				snapshot = await this.tasks.startLocal(
					current.coordinator.nodeId,
					input,
					outcome,
				);
				await this.taskRoutes.markSnapshot(snapshot);
				await this.taskRoutes.retainAmbiguous(reservation);
			} catch (error: unknown) {
				const reconciliation = await this.tasks.reconcileStartFailure(
					this.deviceId,
					task.taskId,
					outcome,
				);
				if (reconciliation.kind === 'notDispatched') {
					await this.taskRoutes.releaseAmbiguous(reservation, reconciliation);
				} else {
					await this.taskRoutes.retainAmbiguous(reservation);
					if (reconciliation.snapshot !== undefined) {
						await this.taskRoutes.markSnapshot(reconciliation.snapshot);
					}
				}
				throw error;
			}
			current = await this.applyTaskSnapshot(current.runId, snapshot);
			return current;
		} catch (error: unknown) {
			const reason = meshReason(error);
			if (reason !== undefined && retryableRouteErrors.has(reason)) {
				return this.runs.transition(current.runId, {
					type: 'taskBlocked',
					taskId,
					at: this.clock.now().toISOString(),
					code: reason,
					message: safeRouteMessage(reason),
					retryable: true,
				});
			}
			return this.runs.transition(current.runId, {
				type: 'taskFailed',
				taskId,
				at: this.clock.now().toISOString(),
				failure: {
					code: reason ?? 'TASK_EXECUTION_FAILED',
					message: 'The collaboration task could not be accepted.',
					retryable: false,
				},
			});
		} finally {
			this.changed();
		}
	}

	private async applyTaskSnapshot(
		runId: string,
		snapshot: TaskSnapshot,
	): Promise<CollaborationRun> {
		let run = await this.runs.get(runId);
		if (run === undefined) {
			throw new MeshDomainError('COLLABORATION_NOT_FOUND', 'Collaboration run not found.');
		}
		const task = run.tasks.find((candidate) => candidate.taskId === snapshot.taskId);
		if (task === undefined) {
			return run;
		}
		const at = snapshot.updatedAt;
		if (activeTaskStates.has(snapshot.state)) {
			if (snapshot.state === 'needsInput' && snapshot.pendingInput !== undefined) {
				run = await this.runs.transition(run.runId, {
					type: 'taskNeedsInput',
					taskId: task.taskId,
					at,
					inputId: snapshot.pendingInput.inputId,
					prompt: snapshot.pendingInput.prompt,
				});
			}
			this.changed();
			return run;
		}
		switch (snapshot.state) {
			case 'completed': {
				try {
					run = await this.completeTask(run, task.taskId, snapshot.summary ?? '', at);
				} catch (error: unknown) {
					const reason = meshReason(error);
					run = await this.runs.transition(run.runId, {
						type: 'taskFailed',
						taskId: task.taskId,
						at,
						failure: {
							code: reason ?? 'TASK_EXECUTION_FAILED',
							message: reason === 'VALIDATION_FAILED'
								? 'The workspace validation result was invalid.'
								: 'The backend contract artifact was invalid.',
							retryable: false,
						},
					});
				}
				break;
			}
			case 'failed':
			case 'timedOut':
				run = await this.runs.transition(run.runId, {
					type: 'taskFailed',
					taskId: task.taskId,
					at,
					failure: snapshot.failure ?? {
						code: 'TASK_EXECUTION_FAILED',
						message: 'The collaboration task failed without a safe diagnostic.',
						retryable: false,
					},
				});
				break;
			case 'cancelled':
				run = await this.runs.transition(run.runId, {
					type: 'taskCancelled',
					taskId: task.taskId,
					at,
				});
				break;
		}
		this.changed();
		return run;
	}

	private async completeTask(
		run: CollaborationRun,
		taskId: string,
		summary: string,
		at: string,
	): Promise<CollaborationRun> {
		const task = run.tasks.find((candidate) => candidate.taskId === taskId);
		if (task === undefined || task.status === 'completed') {
			return run;
		}
		if (task.kind === 'implementation' && task.role === 'backend') {
			const frontend = run.tasks.find((candidate) =>
				candidate.kind === 'implementation' && candidate.role === 'frontend',
			);
			if (frontend === undefined) {
				throw new MeshDomainError('COLLABORATION_DAG_INVALID', 'Frontend task not found.');
			}
			const contract = parseContract(summary);
			const artifact = await this.artifacts.create({
				artifactId: deterministicCollaborationId(
					run.collaborationRequestId,
					'backend-contract-artifact',
				),
				runId: run.runId,
				producerTaskId: task.taskId,
				consumerTaskIds: [frontend.taskId],
				label: contract.label,
				mediaType: contract.mediaType,
				content: contract.content,
				createdAt: at,
			});
			run = await this.runs.transition(run.runId, {
				type: 'artifactAttached',
				taskId: task.taskId,
				at,
				artifact,
			});
			run = await this.runs.transition(run.runId, {
				type: 'artifactAttached',
				taskId: frontend.taskId,
				at,
				artifact,
			});
		}
		if (task.kind === 'validation') {
			const result = parseValidation(summary);
			const validation: CollaborationValidationSummary = {
				taskId: task.taskId,
				workspaceId: task.target.workspaceId,
				role: task.role,
				status: result.status,
				summary: boundUtf8(result.summary, PROTOCOL_LIMITS.errorMessageBytes),
			};
			run = await this.runs.transition(run.runId, {
				type: 'validationRecorded',
				taskId: task.taskId,
				at,
				validation,
			});
			if (result.status === 'failed') {
				return this.runs.transition(run.runId, {
					type: 'taskFailed',
					taskId: task.taskId,
					at,
					failure: {
						code: 'VALIDATION_FAILED',
						message: validation.summary,
						retryable: false,
					},
				});
			}
		}
		return this.runs.transition(run.runId, {
			type: 'taskCompleted',
			taskId: task.taskId,
			at,
		});
	}

	private async buildPrompt(run: CollaborationRun, taskId: string): Promise<string> {
		const task = run.tasks.find((candidate) => candidate.taskId === taskId);
		if (task === undefined) {
			throw new MeshDomainError('COLLABORATION_DAG_INVALID', 'Collaboration task not found.');
		}
		if (task.kind === 'implementation' && task.role === 'backend') {
			return [
				'Same-device multi-project collaboration: backend contract and implementation task.',
				`Goal:\n${run.goal}`,
				'Work only in the assigned backend workspace. Implement the backend portion and run relevant existing checks.',
				'Do not include credentials, tokens, local absolute paths, logs, or transcripts in the contract.',
				'End the final response with exactly one validated JSON contract envelope between these markers:',
				contractMarkerStart,
				'{"schemaVersion":1,"label":"Backend API contract","mediaType":"application/schema+json","content":{"type":"object"}}',
				contractMarkerEnd,
				'The content field must be a bounded JSON object describing only the API contract needed by the frontend.',
			].join('\n\n');
		}
		if (task.kind === 'implementation' && task.role === 'frontend') {
			const artifactId = task.artifactIds[0];
			if (artifactId === undefined) {
				throw new MeshDomainError('ARTIFACT_NOT_FOUND', 'Frontend contract artifact is unavailable.');
			}
			const artifact = await this.artifacts.readForTask(artifactId, run.runId, task.taskId);
			return [
				'Same-device multi-project collaboration: frontend implementation task.',
				`Goal:\n${run.goal}`,
				`Use this exact read-only contract artifact: ${artifact.reference.artifactId}`,
				`Media type: ${artifact.reference.mediaType}`,
				`SHA-256: ${artifact.reference.sha256}`,
				`Contract JSON:\n${canonicalJson(artifact.content)}`,
				'Work only in the assigned frontend workspace. Implement the frontend portion against this contract and run relevant existing checks.',
			].join('\n\n');
		}
		return [
			`Same-device multi-project collaboration: ${task.role} validation task.`,
			`Goal:\n${run.goal}`,
			`Validate the completed ${task.role} implementation in the assigned workspace using existing project checks.`,
			'Do not modify another workspace and do not report a pass unless the checks actually pass.',
			'End the final response with exactly one JSON validation result between these markers:',
			validationMarkerStart,
			'{"schemaVersion":1,"status":"passed","summary":"Relevant project checks passed."}',
			validationMarkerEnd,
		].join('\n\n');
	}

	private assertParticipantTargets(
		caller: CollaborationCaller,
		frontend: TaskTarget,
		backend: TaskTarget,
	): void {
		if (
			frontend.deviceId !== this.deviceId
			|| backend.deviceId !== this.deviceId
			|| frontend.workspaceId === backend.workspaceId
		) {
			throw new MeshDomainError(
				'COLLABORATION_DAG_INVALID',
				'Collaboration requires two different claimed workspaces on this device.',
			);
		}
		const participants = [frontend, backend];
		if (!participants.some((target) =>
			target.nodeId === caller.nodeId && target.nodeInstanceId === caller.nodeInstanceId,
		)) {
			throw new MeshDomainError(
				'COLLABORATION_DAG_INVALID',
				'The authenticated Window Node must be a collaboration participant.',
			);
		}
		const directory = this.registry.list();
		for (const target of participants) {
			const node = directory.nodes.find((candidate) =>
				candidate.nodeId === target.nodeId
				&& candidate.nodeInstanceId === target.nodeInstanceId,
			);
			const workspace = node?.workspaces.find((candidate) =>
				candidate.workspaceId === target.workspaceId,
			);
			if (node === undefined || node.status === 'offline' || workspace === undefined) {
				throw new MeshDomainError('WORKSPACE_NOT_FOUND', 'Collaboration workspace not found.');
			}
			if (!workspace.enabled || workspace.claimStatus !== 'claimed') {
				throw new MeshDomainError('WORKSPACE_DISABLED', 'Collaboration workspace is not claimed.');
			}
			if (workspace.busy) {
				throw new MeshDomainError('WORKSPACE_BUSY', 'Collaboration workspace is busy.', true);
			}
		}
	}

	private async requireAccessible(
		caller: CollaborationCaller,
		runId: string,
	): Promise<CollaborationRun> {
		const run = await this.runs.get(runId);
		if (run === undefined || !this.canAccess(caller, run)) {
			throw new MeshDomainError('COLLABORATION_NOT_FOUND', 'Collaboration run not found.');
		}
		return run;
	}

	private canAccess(caller: CollaborationCaller, run: CollaborationRun): boolean {
		if (run.participants.some(({ target }) =>
			target.nodeId === caller.nodeId && target.nodeInstanceId === caller.nodeInstanceId,
		)) {
			return true;
		}
		const callerNode = this.registry.list().nodes.find((node) =>
			node.nodeId === caller.nodeId
			&& node.nodeInstanceId === caller.nodeInstanceId,
		);
		if (callerNode === undefined) {
			return false;
		}
		const participantWorkspaces = new Set(
			run.participants.map(({ target }) => target.workspaceId),
		);
		return callerNode.workspaces.some((workspace) =>
			workspace.claimStatus === 'claimed'
			&& participantWorkspaces.has(workspace.workspaceId),
		);
	}

	private async snapshot(run: CollaborationRun): Promise<CollaborationRunSnapshot> {
		const artifacts = await this.artifacts.listForRun(run.runId);
		return collaborationRunSnapshotSchema.parse({
			schemaVersion: 1,
			runId: run.runId,
			collaborationRequestId: run.collaborationRequestId,
			coordinator: run.coordinator,
			participants: run.participants,
			title: run.title,
			tasks: run.tasks.map(({ workerDeadline: _workerDeadline, ...task }) => task),
			status: run.status,
			artifacts,
			validations: run.tasks.flatMap(({ validation }) =>
				validation === undefined ? [] : [validation],
			),
			cancellationRequested: run.cancellationRequestedAt !== undefined,
			createdAt: run.createdAt,
			updatedAt: run.updatedAt,
		});
	}

	private changed(): void {
		this.options.onDidChange?.();
	}

	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		if (this.disposed) {
			return Promise.reject(new MeshDomainError(
				'WORKER_DRAINING',
				'The collaboration service is disposed.',
				true,
			));
		}
		const result = this.operationQueue.then(operation, operation);
		this.operationQueue = result.then(() => undefined, () => undefined);
		return result;
	}
}

function parseContract(summary: string): z.infer<typeof contractEnvelopeSchema> {
	let value: unknown;
	try {
		value = JSON.parse(extractMarker(summary, contractMarkerStart, contractMarkerEnd));
	} catch {
		throw new MeshDomainError(
			'ARTIFACT_INVALID',
			'The backend completed without valid contract JSON.',
		);
	}
	const parsed = contractEnvelopeSchema.safeParse(value);
	if (!parsed.success || parsed.data.content === null || Array.isArray(parsed.data.content)
		|| typeof parsed.data.content !== 'object') {
		throw new MeshDomainError(
			'ARTIFACT_INVALID',
			'The backend completed without a valid bounded contract artifact.',
		);
	}
	return parsed.data;
}

function parseValidation(summary: string): z.infer<typeof validationEnvelopeSchema> {
	let value: unknown;
	try {
		value = JSON.parse(extractMarker(summary, validationMarkerStart, validationMarkerEnd));
	} catch {
		throw new MeshDomainError(
			'VALIDATION_FAILED',
			'The validation task completed without valid result JSON.',
		);
	}
	const parsed = validationEnvelopeSchema.safeParse(value);
	if (!parsed.success) {
		throw new MeshDomainError(
			'VALIDATION_FAILED',
			'The validation task completed without a valid result.',
		);
	}
	return parsed.data;
}

function extractMarker(summary: string, start: string, end: string): string {
	const startIndex = summary.lastIndexOf(start);
	const endIndex = summary.indexOf(end, startIndex + start.length);
	if (
		startIndex < 0
		|| endIndex < 0
		|| summary.slice(endIndex + end.length).trim().length > 0
	) {
		throw new MeshDomainError(
			'ARTIFACT_INVALID',
			'The structured collaboration result marker is missing or malformed.',
		);
	}
	return summary.slice(startIndex + start.length, endIndex).trim();
}

function acceptanceCriteria(
	kind: 'implementation' | 'validation',
	role: 'frontend' | 'backend',
): readonly string[] {
	return kind === 'validation'
		? [
			`Run the existing ${role} project validation.`,
			'Return the exact structured validation marker.',
		]
		: role === 'backend'
			? [
				'Implement the backend portion in the assigned workspace.',
				'Return a valid bounded structured API contract artifact.',
			]
			: [
				'Consume the exact authorized API contract artifact.',
				'Implement the frontend portion in the assigned workspace.',
			];
}

function meshReason(error: unknown): string | undefined {
	if (error instanceof MeshDomainError) {
		return error.reason;
	}
	if (
		typeof error === 'object'
		&& error !== null
		&& 'data' in error
		&& typeof error.data === 'object'
		&& error.data !== null
		&& 'reason' in error.data
		&& typeof error.data.reason === 'string'
	) {
		return error.data.reason;
	}
	return undefined;
}

function safeRouteMessage(reason: string): string {
	switch (reason) {
		case 'WORKSPACE_BUSY':
			return 'The target workspace currently has another writer.';
		case 'WORKSPACE_NOT_FOUND':
			return 'The target Window Node or workspace is currently unavailable.';
		case 'WORKER_DRAINING':
			return 'The target Window Node is draining.';
		default:
			return 'The target task route is temporarily unavailable.';
	}
}

function boundUtf8(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maximumBytes) {
		return value;
	}
	let output = '';
	for (const character of value) {
		if (Buffer.byteLength(output + character, 'utf8') > maximumBytes) {
			break;
		}
		output += character;
	}
	return output;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
