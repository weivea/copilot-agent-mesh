import { createHash, randomUUID } from 'node:crypto';

import {
	deviceInfoSchema,
	taskSnapshotAfterEventSeqSchema,
	taskSnapshotSchema,
	workspaceListResultSchema,
	type TaskSnapshot,
	type TaskSnapshotAfterEventSeq,
} from '../../shared/protocol';
import { TASK_TOOL_ERROR_CODES } from '../../shared/toolProtocol';
import type {
	TaskToolErrorCode,
	DelegationAcceptance,
	DelegationIntentInput,
	MeshDirectorySnapshot,
	MeshWorkerDirectorySnapshot,
	PersistedDelegationIntent,
	TaskActionReceipt,
	TaskToolReadResult,
} from '../../shared/toolProtocol';
import type { StateStore } from '../domain/ports';
import { isUsablePeerProfile, type PeerProfileStore } from '../peer/PeerProfile';
import { PeerRpcError } from '../peer/WebSocketPeerTransport';
import { TaskToolFacadeError } from '../tools/taskToolFacade';
import type { LocalDesktopWorkspaceGuard } from './LocalDesktopWorkspaceGuard';
import { MeshDomainError } from '../domain/errors';
import type { WorkerOwnership } from '../storage/WorkerOwnerLock';

const delegationStateKey = 'copilotAgentMesh.delegationIntents';

interface StoredDelegationIntent {
	readonly schemaVersion: 1;
	readonly delegationRequestId: string;
	readonly taskId: string;
	readonly requestHash: string;
	readonly peerId: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly workerDeadline: string;
	readonly createdAt: string;
}

interface DelegationState {
	readonly schemaVersion: 1;
	readonly intents: readonly StoredDelegationIntent[];
}

export interface LegacyCoordinatorDelegationInput {
	readonly delegationRequestId?: string;
	readonly peerId: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly prompt: string;
	readonly acceptanceCriteria: readonly string[];
	readonly timeoutMinutes?: number;
}

type CoordinatorDelegationInput = DelegationIntentInput | LegacyCoordinatorDelegationInput;

export interface CoordinatorTaskView {
	readonly intent: StoredDelegationIntent;
	readonly snapshot?: TaskSnapshot | TaskSnapshotAfterEventSeq;
}

export interface CoordinatorPeerConnection {
	readonly profileId: string;
	snapshot(): { readonly state: string };
	request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface CoordinatorPeerManager {
	listConnections(): readonly CoordinatorPeerConnection[];
	isEnabled(profileId: string): boolean;
	get(profileId: string): CoordinatorPeerConnection | undefined;
}

export class TaskCoordinator {
	private mutation = Promise.resolve();
	private readonly taskCache = new Map<string, TaskSnapshot | TaskSnapshotAfterEventSeq>();
	private readonly intentPayloads = new Map<string, CoordinatorDelegationInput>();

	public constructor(
		private readonly peers: CoordinatorPeerManager,
		private readonly profiles: PeerProfileStore,
		private readonly state: StateStore,
		private readonly guard: LocalDesktopWorkspaceGuard,
		private readonly id: () => string = randomUUID,
		private readonly now: () => Date = () => new Date(),
		private readonly ownership?: WorkerOwnership,
	) {}

	public async listWorkers(
		signal: AbortSignal,
	): Promise<MeshDirectorySnapshot & MeshWorkerDirectorySnapshot> {
		this.guard.assertAllowed({ requireWorkspace: false });
		throwIfAborted(signal);
		const workers = await Promise.all(this.peers.listConnections().map(async (connection) => {
			if (
				!this.peers.isEnabled(connection.profileId)
				|| connection.snapshot().state !== 'online'
			) {
				return undefined;
			}
			try {
				const [deviceValue, workspaceValue] = await Promise.all([
					raceAbort(connection.request('device.getInfo', {}), signal),
					raceAbort(connection.request('workspace.list', {}), signal),
				]);
				const device = deviceInfoSchema.parse(deviceValue);
				const workspaceResult = workspaceListResultSchema.parse(workspaceValue);
				const capabilities = [...new Set(
					workspaceResult.workspaces
						.filter(({ enabled }) => enabled === true)
						.flatMap(({ capabilityTags }) => capabilityTags),
				)];
				const enabledWorkspaces = workspaceResult.workspaces.filter(
					({ enabled }) => enabled === true,
				);
				return {
					peerId: connection.profileId,
					deviceName: device.name,
					capabilities,
					workspaces: enabledWorkspaces.map((workspace) => ({
						workspaceId: workspace.workspaceId,
						name: workspace.name,
						tags: workspace.capabilityTags,
						busy: workspace.busy,
					})),
				};
			} catch (error) {
				if (signal.aborted) {
					throw error;
				}
				return undefined;
			}
		}));
		const directory = { devices: [], truncated: false } as unknown as
			MeshDirectorySnapshot & MeshWorkerDirectorySnapshot;
		// The legacy dashboard can still read workers without exposing v1 data to the strict v2 tool parser.
		Object.defineProperty(directory, 'workers', {
			value: workers.filter((worker) => worker !== undefined),
			enumerable: false,
		});
		return directory;
	}

	public persistDelegationIntent(
		input: CoordinatorDelegationInput,
	): Promise<PersistedDelegationIntent> {
		this.guard.assertAllowed({ requireWorkspace: false });
		if ('deviceId' in input) {
			return Promise.reject(new TaskToolFacadeError('PROTOCOL_INCOMPATIBLE'));
		}
		const timeoutMinutes = input.timeoutMinutes ?? 60;
		if (
			!Number.isSafeInteger(timeoutMinutes)
			|| timeoutMinutes < 1
			|| timeoutMinutes > 60
		) {
			return Promise.reject(new TaskToolFacadeError('INVALID_INPUT'));
		}
		return this.mutate(async () => {
			await this.assertOwner();
			const requestHash = hashIntent(input);
			const state = this.read();
			const delegationRequestId = input.delegationRequestId ?? this.id();
			const existing = state.intents.find(
				(intent) => intent.delegationRequestId === delegationRequestId,
			);
			if (existing !== undefined) {
				if (existing.requestHash !== requestHash) {
					throw new TaskToolFacadeError('IDEMPOTENCY_CONFLICT');
				}
				this.intentPayloads.set(existing.taskId, {
					...input,
					acceptanceCriteria: [...input.acceptanceCriteria],
				});
				return {
					delegationRequestId: existing.delegationRequestId,
					taskId: existing.taskId,
					recovered: true,
				};
			}
			const now = this.now();
			const intent: StoredDelegationIntent = {
				schemaVersion: 1,
				delegationRequestId,
				taskId: this.id(),
				requestHash,
				peerId: input.peerId,
				workspaceId: input.workspaceId,
				title: input.title,
				workerDeadline: new Date(now.valueOf() + timeoutMinutes * 60_000).toISOString(),
				createdAt: now.toISOString(),
			};
			await this.state.update(delegationStateKey, {
				schemaVersion: 1,
				intents: [...state.intents, intent],
			});
			this.intentPayloads.set(intent.taskId, {
				...input,
				acceptanceCriteria: [...input.acceptanceCriteria],
			});
			return {
				delegationRequestId: intent.delegationRequestId,
				taskId: intent.taskId,
				recovered: false,
			};
		});
	}

	public async waitForDelegationAcceptance(
		request: Pick<PersistedDelegationIntent, 'delegationRequestId' | 'taskId'>,
		signal: AbortSignal,
	): Promise<DelegationAcceptance> {
		this.guard.assertAllowed({ requireWorkspace: false });
		await this.assertOwner();
		const intent = this.read().intents.find((candidate) =>
			candidate.delegationRequestId === request.delegationRequestId
			&& candidate.taskId === request.taskId,
		);
		if (intent === undefined) {
			throw new TaskToolFacadeError('DELEGATION_NOT_FOUND');
		}
		const payload = this.intentPayloads.get(intent.taskId);
		if (payload === undefined) {
			throw new TaskToolFacadeError('DELEGATION_NOT_FOUND', true);
		}
		while (true) {
			throwIfAborted(signal);
			const connection = this.requireConnection(intent.peerId);
			try {
				const value = await raceAbort(connection.request('task.start', {
					delegationRequestId: intent.delegationRequestId,
					taskId: intent.taskId,
					workspaceId: intent.workspaceId,
					title: intent.title,
					prompt: payload.prompt,
					acceptanceCriteria: [...payload.acceptanceCriteria],
					workerDeadline: intent.workerDeadline,
				}), signal);
				const snapshot = parseTaskSnapshot(value);
				if (snapshot.taskId !== intent.taskId) {
					throw new TaskToolFacadeError('OUTPUT_INVALID');
				}
				this.taskCache.set(snapshot.taskId, snapshot);
				return { status: 'accepted' };
			} catch (error) {
				if (error instanceof PeerRpcError) {
					throw toFacadeError(error);
				}
				if (signal.aborted || error instanceof TaskToolFacadeError) {
					throw error;
				}
				await abortableDelay(250, signal);
			}
		}
	}

	public async getTask(
		request: {
			readonly taskId: string;
			readonly afterEventSequence?: number;
			readonly maxEvents: number;
		},
		signal: AbortSignal,
	): Promise<TaskToolReadResult> {
		this.guard.assertAllowed({ requireWorkspace: false });
		const intent = this.requireIntentForTask(request.taskId);
		const connection = this.requireConnection(intent.peerId);
		const value = await rpcRequest(connection.request('task.get', {
			taskId: request.taskId,
			...(request.afterEventSequence === undefined
				? {}
				: { afterEventSeq: request.afterEventSequence }),
		}), signal);
		const remote = parseTaskSnapshot(value);
		this.taskCache.set(remote.taskId, remote);
		return toToolReadResult(remote, request.afterEventSequence, request.maxEvents);
	}

	public async cancelOwnedTask(
		request: { readonly taskId: string },
		signal: AbortSignal,
	): Promise<TaskActionReceipt> {
		this.guard.assertAllowed({ requireWorkspace: false });
		await this.assertOwner();
		const intent = this.requireIntentForTask(request.taskId);
		const value = await rpcRequest(
			this.requireConnection(intent.peerId).request('task.cancel', { taskId: request.taskId }),
			signal,
		);
		const snapshot = parseTaskSnapshot(value);
		this.taskCache.set(snapshot.taskId, snapshot);
		return { taskId: snapshot.taskId, status: snapshot.state };
	}

	public async answerOwnedTask(
		request: {
			readonly taskId: string;
			readonly inputId: string;
			readonly answerId: string;
			readonly answer: string;
		},
		signal: AbortSignal,
	): Promise<TaskActionReceipt> {
		this.guard.assertAllowed({ requireWorkspace: false });
		await this.assertOwner();
		const intent = this.requireIntentForTask(request.taskId);
		const value = await rpcRequest(this.requireConnection(intent.peerId).request('task.answer', {
			taskId: request.taskId,
			inputId: request.inputId,
			answerId: request.answerId,
			answer: request.answer,
		}), signal);
		const snapshot = parseTaskSnapshot(value);
		this.taskCache.set(snapshot.taskId, snapshot);
		return { taskId: snapshot.taskId, status: snapshot.state };
	}

	public async startTask(
		input: CoordinatorDelegationInput,
		signal: AbortSignal,
	): Promise<PersistedDelegationIntent> {
		await this.assertOwner();
		const persisted = await this.persistDelegationIntent(input);
		await this.waitForDelegationAcceptance(persisted, signal);
		return persisted;
	}

	public listKnownTasks(): readonly CoordinatorTaskView[] {
		return this.read().intents.map((intent) => ({
			intent,
			snapshot: this.taskCache.get(intent.taskId),
		}));
	}

	public async refreshKnownTasks(): Promise<void> {
		await Promise.allSettled(this.read().intents.map(async (intent) => {
			const connection = this.peers.get(intent.peerId);
			if (connection?.snapshot().state !== 'online') {
				return;
			}
			const value = await connection.request('task.get', { taskId: intent.taskId });
			this.taskCache.set(intent.taskId, parseTaskSnapshot(value));
		}));
	}

	public async profileNames(): Promise<ReadonlyMap<string, string>> {
		const profiles = await this.profiles.list();
		return new Map(profiles
			.filter(isUsablePeerProfile)
			.map((profile) => [profile.id, profile.workerDeviceId]));
	}

	private read(): DelegationState {
		const value = this.state.get<DelegationState>(delegationStateKey);
		if (value === undefined) {
			return { schemaVersion: 1, intents: [] };
		}
		if (value.schemaVersion !== 1 || !Array.isArray(value.intents)) {
			throw new TypeError('Invalid persisted delegation intents.');
		}
		return structuredClone(value);
	}

	private requireIntentForTask(taskId: string): StoredDelegationIntent {
		const intent = this.read().intents.find((candidate) => candidate.taskId === taskId);
		if (intent === undefined) {
			throw new TaskToolFacadeError('TASK_NOT_FOUND');
		}
		return intent;
	}

	private requireConnection(profileId: string) {
		const connection = this.peers.get(profileId);
		if (
			!this.peers.isEnabled(profileId)
			|| connection === undefined
			|| connection.snapshot().state !== 'online'
		) {
			throw new TaskToolFacadeError('TUNNEL_UNAVAILABLE', true);
		}
		return connection;
	}

	private mutate<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutation.then(operation, operation);
		this.mutation = result.then(() => undefined, () => undefined);
		return result;
	}

	private async assertOwner(): Promise<void> {
		try {
			await this.ownership?.assertOwner();
		} catch (error) {
			if (error instanceof MeshDomainError && error.reason === 'WORKER_DRAINING') {
				throw new TaskToolFacadeError('WORKER_DRAINING', true);
			}
			throw error;
		}
	}
}

function hashIntent(input: CoordinatorDelegationInput): string {
	const fields = [
		input.peerId ?? '',
		input.workspaceId,
		input.title,
		input.prompt,
		String(input.acceptanceCriteria.length),
		...input.acceptanceCriteria,
		String(input.timeoutMinutes ?? 60),
	];
	return createHash('sha256')
		.update(fields.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join(''), 'utf8')
		.digest('hex');
}

function parseTaskSnapshot(value: unknown): TaskSnapshot | TaskSnapshotAfterEventSeq {
	const sliced = taskSnapshotAfterEventSeqSchema.safeParse(value);
	if (sliced.success) {
		return sliced.data;
	}
	const complete = taskSnapshotSchema.safeParse(value);
	if (complete.success) {
		return complete.data;
	}
	throw new TaskToolFacadeError('OUTPUT_INVALID');
}

function toToolReadResult(
	remote: TaskSnapshot | TaskSnapshotAfterEventSeq,
	requestedAfter: number | undefined,
	maxEvents: number,
): TaskToolReadResult {
	const after = requestedAfter ?? 0;
	const availableFrom = remote.events[0]?.eventSeq
		?? remote.earliestAvailableEventSeq
		?? remote.eventSeq + 1;
	const selected = remote.events.slice(0, maxEvents);
	const gap = availableFrom > after + 1
		? { expectedFrom: after + 1, availableFrom }
		: undefined;
	return {
		snapshot: {
			taskId: remote.taskId,
			status: remote.state,
			title: remote.title,
			updatedAt: remote.updatedAt,
			summary: remote.summary,
			pendingInput: remote.pendingInput,
			failure: remote.failure,
		},
		eventCursor: selected.at(-1)?.eventSeq ?? after,
		events: selected.map((event) => ({
			sequence: event.eventSeq,
			type: event.type,
			at: event.at,
			summary: event.summary ?? event.type,
		})),
		eventGap: gap,
		truncated: gap !== undefined
			|| remote.eventsTruncated
			|| selected.length < remote.events.length,
	};
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener('abort', abort);
			reject(new DOMException('Operation cancelled.', 'AbortError'));
		};
		signal.addEventListener('abort', abort, { once: true });
		void operation.then(
			(value) => {
				signal.removeEventListener('abort', abort);
				if (!signal.aborted) {
					resolve(value);
				}
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort);
				if (!signal.aborted) {
					reject(error);
				}
			},
		);
	});
}

async function rpcRequest<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	try {
		return await raceAbort(operation, signal);
	} catch (error) {
		if (error instanceof PeerRpcError) {
			throw toFacadeError(error);
		}
		throw error;
	}
}

function toFacadeError(error: PeerRpcError): TaskToolFacadeError {
	const code = (TASK_TOOL_ERROR_CODES as readonly string[]).includes(error.reason)
		? error.reason as TaskToolErrorCode
		: 'INTERNAL_ERROR';
	return new TaskToolFacadeError(code, error.retryable);
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort);
			resolve();
		}, delayMs);
		const abort = () => {
			clearTimeout(timer);
			reject(new DOMException('Operation cancelled.', 'AbortError'));
		};
		signal.addEventListener('abort', abort, { once: true });
	});
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new DOMException('Operation cancelled.', 'AbortError');
	}
}
