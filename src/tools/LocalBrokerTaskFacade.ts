import { createHash } from 'node:crypto';

import {
	MESH_ERROR_CODES,
	PROTOCOL_LIMITS,
	utf8String,
	uuidSchema,
	workspaceIdentitySchema,
	type NodeDirectoryResult,
	type DelegatedExecutionContext,
	type RoutedTaskStartParams,
	type TaskSnapshot,
	type TaskSnapshotAfterEventSeq,
} from '../../shared/protocol';
import {
	TASK_TOOL_ERROR_CODES,
	TASK_TOOL_LIMITS,
	type DelegationAcceptance,
	type DelegationIdentity,
	type DelegationIntentInput,
	type MeshDeviceToolSummary,
	type MeshDirectorySnapshot,
	type MeshRemoteDirectorySnapshot,
	type PersistedDelegationIntent,
	type TaskActionReceipt,
	type TaskToolErrorCode,
	type TaskToolReadResult,
	type TaskToolSnapshot,
} from '../../shared/toolProtocol';
import { LocalIpcRemoteError } from '../ipc';
import type { WindowNodeClient } from '../node/WindowNodeClient';
import {
	TaskToolFacadeError,
	type DelegationTargetDisplay,
	type TaskToolFacade,
	type TaskSnapshotSubscription,
} from './taskToolFacade';

type WindowNodeFacadeClient = Pick<
	WindowNodeClient,
	| 'deviceId'
	| 'nodeId'
	| 'nodeInstanceId'
	| 'label'
	| 'listNodes'
	| 'startTask'
	| 'getTask'
	| 'cancelTask'
	| 'answerTask'
> & {
	readonly startTaskFromDelegatedChild?: WindowNodeClient['startTaskFromDelegatedChild'];
	readonly onTaskSnapshot?: WindowNodeClient['onTaskSnapshot'];
	readonly onDidChange?: WindowNodeClient['onDidChange'];
	readonly snapshot?: () => { readonly registered: boolean };
};

export interface RemoteTaskRouteAdapter {
	listDevices(signal: AbortSignal): Promise<MeshRemoteDirectorySnapshot>;
	prevalidateStartTask?(
		input: RoutedTaskStartParams,
		route: { readonly peerId?: string },
	): Promise<void>;
	startTask(
		input: RoutedTaskStartParams,
		route: {
			readonly peerId?: string;
			readonly delegatedExecutionContext?: DelegatedExecutionContext;
		},
		outcome?: RemoteTaskStartOutcome,
	): Promise<TaskSnapshot>;
	getTask(
		taskId: string,
		afterEventSequence: number | undefined,
		signal: AbortSignal,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq | undefined>;
	cancelTask(taskId: string, signal: AbortSignal): Promise<TaskSnapshot | undefined>;
	answerTask(
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
		signal: AbortSignal,
	): Promise<TaskSnapshot | undefined>;
}

export interface RemoteTaskStartOutcome {
	taskStartRequestAttempted: boolean;
}

export interface LocalBrokerTaskFacadeOptions {
	readonly deviceName: string | (() => string);
	readonly remoteAdapter?: RemoteTaskRouteAdapter;
	readonly now?: () => Date;
	readonly sourceWorkspaceIdentity?: () => string;
}

export class LocalBrokerTaskFacade implements TaskToolFacade {
	public readonly sourceNodeId: string;
	private readonly deviceName: () => string;
	private readonly now: () => Date;
	private persistenceQueue = Promise.resolve();
	private readonly persistedDelegations = new Map<string, {
		readonly sourceWorkspaceIdentity?: string;
		readonly taskId: string;
	}>();

	public constructor(
		private readonly client: WindowNodeFacadeClient,
		private readonly options: LocalBrokerTaskFacadeOptions,
	) {
		uuidSchema.parse(client.deviceId);
		this.sourceNodeId = uuidSchema.parse(client.nodeId);
		uuidSchema.parse(client.nodeInstanceId);
		const readDeviceName = typeof options.deviceName === 'function'
			? options.deviceName
			: () => options.deviceName;
		this.deviceName = () => utf8String(
			PROTOCOL_LIMITS.nameBytes,
			'device name',
			1,
		).parse(readDeviceName());
		this.now = options.now ?? (() => new Date());
	}

	public async listWorkers(signal: AbortSignal): Promise<MeshDirectorySnapshot> {
		try {
			const [local, remote] = await Promise.all([
				raceAbort(this.client.listNodes(), signal),
				this.options.remoteAdapter?.listDevices(signal) ?? Promise.resolve({
					devices: [],
					truncated: false,
					totalDevices: 0,
				}),
			]);
			this.assertLocalDirectory(local);
			if (remote.devices.some((device) =>
				device.locality !== 'remote' || device.deviceId === this.client.deviceId,
			)) {
				throw new TaskToolFacadeError('OUTPUT_INVALID');
			}

			return {
				devices: [
					{
						deviceId: this.client.deviceId,
						deviceName: this.deviceName(),
						locality: 'local',
						status: 'online',
						nodesTruncated: local.truncated,
						totalNodes: local.totalNodes,
						nodes: local.nodes.map((node) => ({
							nodeId: node.nodeId,
							nodeInstanceId: node.nodeInstanceId,
							label: node.label,
							status: node.status,
							capabilities: [...node.capabilities],
							workspaces: node.workspaces.map((workspace) => ({
								workspaceId: workspace.workspaceId,
								name: workspace.name,
								tags: [...workspace.capabilityTags],
								busy: workspace.busy,
								claimStatus: workspace.claimStatus,
							})),
						})),
					},
					...remote.devices,
				],
				truncated: local.truncated
					|| remote.truncated
					|| remote.devices.some(({ nodesTruncated }) => nodesTruncated),
			};
		} catch (error: unknown) {
			throw toFacadeError(error);
		}
	}

	public identifyDelegation(intent: DelegationIntentInput): DelegationIdentity {
		if (intent.delegationRequestId === undefined) {
			throw new TaskToolFacadeError('INVALID_INPUT');
		}
		const sourceWorkspaceIdentity = workspaceIdentitySchema.parse(
			intent.sourceWorkspaceIdentity
				?? this.options.sourceWorkspaceIdentity?.()
				?? fallbackSourceWorkspaceIdentity(this.sourceNodeId),
		);
		const delegationRequestId = uuidSchema.parse(intent.delegationRequestId);
		const hasAuthenticatedSource = intent.sourceWorkspaceIdentity !== undefined
			|| this.options.sourceWorkspaceIdentity !== undefined;
		return {
			delegationRequestId,
			sourceWorkspaceIdentity,
			taskId: deterministicTaskId(
				delegationRequestId,
				hasAuthenticatedSource ? sourceWorkspaceIdentity : undefined,
			),
		};
	}

	public persistedTaskIdForDelegationRequest(delegationRequestId: string): string {
		const requestId = uuidSchema.parse(delegationRequestId);
		const binding = this.persistedDelegations.get(requestId);
		if (binding === undefined) {
			throw new TaskToolFacadeError('DELEGATION_NOT_FOUND');
		}
		if (deterministicTaskId(requestId, binding.sourceWorkspaceIdentity) !== binding.taskId) {
			throw new TaskToolFacadeError('OUTPUT_INVALID');
		}
		return binding.taskId;
	}

	public async describeDelegationTarget(
		intent: DelegationIntentInput,
		signal: AbortSignal,
	): Promise<DelegationTargetDisplay> {
		const directory = await this.listWorkers(signal);
		const device = directory.devices.find(({ deviceId }) => deviceId === intent.deviceId);
		const node = device?.nodes.find(({ nodeId, nodeInstanceId }) =>
			nodeId === intent.nodeId && nodeInstanceId === intent.nodeInstanceId,
		);
		if (
			node?.status === 'offline'
			|| (
				node === undefined
				&& device?.nodes.some(({ nodeId }) => nodeId === intent.nodeId)
			)
		) {
			throw new TaskToolFacadeError('PEER_OFFLINE', true);
		}
		const workspace = node?.workspaces.find(({ workspaceId }) =>
			workspaceId === intent.workspaceId,
		);
		if (node === undefined || workspace === undefined) {
			throw new TaskToolFacadeError('WORKSPACE_NOT_FOUND');
		}
		return {
			windowName: node.label,
			workspaceName: workspace.name,
		};
	}

	public subscribeToTask(
		taskId: string,
		listener: (snapshot: TaskToolSnapshot) => void,
		onError: (error: unknown) => void,
	): TaskSnapshotSubscription {
		const parsedTaskId = uuidSchema.parse(taskId);
		let disposed = false;
		let registered = this.client.snapshot?.().registered ?? true;
		let reconciliation = Promise.resolve();
		const reportError = (error: unknown): void => {
			try {
				onError(error);
			} catch {
				// Notification callbacks must not escape into the Window Node transport.
			}
		};
		const snapshotRegistration = this.client.onTaskSnapshot?.((snapshot) => {
			if (!disposed && snapshot.taskId === parsedTaskId) {
				try {
					listener(toToolReadResult(snapshot, undefined, 1).snapshot);
				} catch (error: unknown) {
					reportError(error);
				}
			}
		}) ?? { dispose: () => undefined };
		const stateRegistration = this.client.onDidChange?.(() => {
			const nextRegistered = this.client.snapshot?.().registered ?? true;
			const reconnected = !registered && nextRegistered;
			registered = nextRegistered;
			if (!reconnected || disposed) {
				return;
			}
			reconciliation = reconciliation.then(async () => {
				if (disposed) {
					return;
				}
				try {
					const snapshot = await this.client.getTask(parsedTaskId);
					if (!disposed) {
						listener(toToolReadResult(snapshot, undefined, 1).snapshot);
					}
				} catch (error: unknown) {
					const facadeError = toFacadeError(error);
					if (
						!disposed
						&& (
							!(facadeError instanceof TaskToolFacadeError)
							|| facadeError.code !== 'TUNNEL_UNAVAILABLE'
						)
					) {
						reportError(facadeError);
					}
				}
			});
		}) ?? { dispose: () => undefined };
		return {
			dispose: () => {
				if (disposed) {
					return;
				}
				disposed = true;
				stateRegistration.dispose();
				snapshotRegistration.dispose();
			},
		};
	}

	public persistDelegationIntent(
		intent: DelegationIntentInput,
		context?: DelegatedExecutionContext,
	): Promise<PersistedDelegationIntent> {
		const result = this.persistenceQueue.then(
			() => this.persistDelegationIntentCore(intent, context),
			() => this.persistDelegationIntentCore(intent, context),
		);
		this.persistenceQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async persistDelegationIntentCore(
		intent: DelegationIntentInput,
		context?: DelegatedExecutionContext,
	): Promise<PersistedDelegationIntent> {
		if (intent.delegationRequestId === undefined) {
			throw new TaskToolFacadeError('INVALID_INPUT');
		}
		try {
			const identity = this.identifyDelegation(intent);
			const { delegationRequestId, taskId, sourceWorkspaceIdentity } = identity;
			const persistedSourceScope = (
				intent.sourceWorkspaceIdentity !== undefined
				|| this.options.sourceWorkspaceIdentity !== undefined
			)
				? sourceWorkspaceIdentity
				: undefined;
			const existingBinding = this.persistedDelegations.get(delegationRequestId);
			if (
				existingBinding !== undefined
				&& (
					existingBinding.taskId !== taskId
					|| existingBinding.sourceWorkspaceIdentity !== persistedSourceScope
				)
			) {
				throw new TaskToolFacadeError('IDEMPOTENCY_CONFLICT');
			}
			const target = {
				deviceId: uuidSchema.parse(intent.deviceId),
				nodeId: uuidSchema.parse(intent.nodeId),
				nodeInstanceId: uuidSchema.parse(intent.nodeInstanceId),
				workspaceId: uuidSchema.parse(intent.workspaceId),
			};
			this.persistedDelegations.set(delegationRequestId, {
				...(persistedSourceScope === undefined
					? {}
					: { sourceWorkspaceIdentity: persistedSourceScope }),
				taskId,
			});
			let existing: TaskSnapshot | TaskSnapshotAfterEventSeq | undefined;
			let remote: RemoteTaskRouteAdapter | undefined;
			let remotePeerId: string | undefined;
			if (target.deviceId === this.client.deviceId) {
				if (intent.peerId !== undefined) {
					throw new TaskToolFacadeError('INVALID_INPUT');
				}
				existing = await this.readExistingLocalTask(taskId);
			} else {
				remote = this.options.remoteAdapter;
				if (remote === undefined) {
					throw new TaskToolFacadeError('TUNNEL_UNAVAILABLE', true);
				}
				if (intent.peerId === undefined) {
					throw new TaskToolFacadeError('INVALID_INPUT');
				}
				remotePeerId = uuidSchema.parse(intent.peerId);
				existing = await remote.getTask(taskId, undefined, new AbortController().signal);
			}
			const input: RoutedTaskStartParams = {
				delegationRequestId,
				taskId,
				target,
				sourceNodeId: this.sourceNodeId,
				sourceWorkspaceIdentity,
				title: intent.title,
				prompt: intent.prompt,
				acceptanceCriteria: [...intent.acceptanceCriteria],
				timeoutMinutes: intent.timeoutMinutes
					?? TASK_TOOL_LIMITS.defaultTimeoutMinutes,
				workerDeadline: workerDeadline(
					intent.timeoutMinutes,
					existing,
					this.now(),
				),
			};
			let snapshot: TaskSnapshot;
			if (remote === undefined) {
				if (context === undefined) {
					snapshot = await this.client.startTask(input);
				} else {
					const childStart = this.client.startTaskFromDelegatedChild?.bind(this.client);
					if (childStart === undefined) {
						throw new TaskToolFacadeError('OUTPUT_INVALID');
					}
					snapshot = await childStart(input, context);
				}
			} else {
				snapshot = await remote.startTask(input, {
					peerId: remotePeerId,
					...(context === undefined ? {} : { delegatedExecutionContext: context }),
				});
			}
			if (snapshot.taskId !== taskId) {
				throw new TaskToolFacadeError('OUTPUT_INVALID');
			}
			return { delegationRequestId, taskId, recovered: existing !== undefined };
		} catch (error: unknown) {
			throw toFacadeError(error);
		}
	}

	public async waitForDelegationAcceptance(
		request: Pick<PersistedDelegationIntent, 'delegationRequestId' | 'taskId'>,
		signal: AbortSignal,
	): Promise<DelegationAcceptance> {
		try {
			throwIfAborted(signal);
			const sourceWorkspaceIdentity = workspaceIdentitySchema.parse(
				this.options.sourceWorkspaceIdentity?.()
					?? fallbackSourceWorkspaceIdentity(this.sourceNodeId),
			);
			if (
				deterministicTaskId(
					request.delegationRequestId,
					this.options.sourceWorkspaceIdentity === undefined
						? undefined
						: sourceWorkspaceIdentity,
				)
				!== request.taskId
			) {
				throw new TaskToolFacadeError('DELEGATION_NOT_FOUND');
			}
			const persisted = await this.readRoutedTask(request.taskId, undefined, signal);
			if (persisted.taskId !== request.taskId) {
				throw new TaskToolFacadeError('OUTPUT_INVALID');
			}
			return { status: 'accepted' };
		} catch (error: unknown) {
			if (meshReason(error) === 'TASK_NOT_FOUND') {
				throw new TaskToolFacadeError('DELEGATION_NOT_FOUND');
			}
			throw toFacadeError(error);
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
		try {
			const snapshot = await this.readRoutedTask(
				request.taskId,
				request.afterEventSequence,
				signal,
			);
			return toToolReadResult(
				snapshot,
				request.afterEventSequence,
				request.maxEvents,
			);
		} catch (error: unknown) {
			throw toFacadeError(error);
		}
	}

	public async cancelOwnedTask(
		request: { readonly taskId: string },
		signal: AbortSignal,
	): Promise<TaskActionReceipt> {
		try {
			const snapshot = await raceAbort(this.client.cancelTask(request.taskId), signal);
			return { taskId: snapshot.taskId, status: snapshot.state };
		} catch (error: unknown) {
			throw toFacadeError(error);
		}
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
		try {
			const snapshot = await raceAbort(this.client.answerTask(
				request.taskId,
				request.inputId,
				request.answerId,
				request.answer,
			), signal);
			return { taskId: snapshot.taskId, status: snapshot.state };
		} catch (error: unknown) {
			throw toFacadeError(error);
		}
	}

	private assertLocalDirectory(directory: NodeDirectoryResult): void {
		if (directory.deviceId !== this.client.deviceId) {
			throw new TaskToolFacadeError('OUTPUT_INVALID');
		}
	}

	private async readExistingLocalTask(taskId: string): Promise<TaskSnapshot | undefined> {
		try {
			return await this.client.getTask(taskId) as TaskSnapshot;
		} catch (error: unknown) {
			if (meshReason(error) === 'TASK_NOT_FOUND') {
				return undefined;
			}
			throw error;
		}
	}

	private async readRoutedTask(
		taskId: string,
		afterEventSequence: number | undefined,
		signal: AbortSignal,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq> {
		return raceAbort(this.client.getTask(taskId, afterEventSequence), signal);
	}
}

export function deterministicTaskId(
	delegationRequestId: string,
	sourceWorkspaceIdentity?: string,
): string {
	const requestId = uuidSchema.parse(delegationRequestId);
	const bytes = createHash('sha256')
		.update(sourceWorkspaceIdentity === undefined
			? 'copilot-agent-mesh/task-tool/v2\0'
			: 'copilot-agent-mesh/task-tool/v3\0', 'utf8')
		.update(sourceWorkspaceIdentity === undefined
			? ''
			: workspaceIdentitySchema.parse(sourceWorkspaceIdentity), 'utf8')
		.update('\0', 'utf8')
		.update(requestId, 'utf8')
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function workerDeadline(
	timeoutMinutes: number | undefined,
	existing: TaskSnapshot | TaskSnapshotAfterEventSeq | undefined,
	now: Date,
): string {
	const minutes = timeoutMinutes !== undefined
		&& Number.isSafeInteger(timeoutMinutes)
		&& timeoutMinutes >= 1
		&& timeoutMinutes <= TASK_TOOL_LIMITS.maxTimeoutMinutes
		? timeoutMinutes
		: timeoutMinutes === undefined
			? TASK_TOOL_LIMITS.defaultTimeoutMinutes
			: undefined;
	if (minutes === undefined) {
		throw new TaskToolFacadeError('INVALID_INPUT');
	}
	if (existing === undefined) {
		return new Date(now.valueOf() + minutes * 60_000).toISOString();
	}
	const existingMinutes = Math.ceil(
		(Date.parse(existing.workerDeadline) - Date.parse(existing.createdAt)) / 60_000,
	);
	if (existingMinutes === minutes) {
		return existing.workerDeadline;
	}
	return new Date(
		Date.parse(existing.workerDeadline) + (minutes - existingMinutes) * 60_000,
	).toISOString();
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
			...(remote.summary === undefined ? {} : { summary: remote.summary }),
			...(remote.pendingInput === undefined ? {} : { pendingInput: remote.pendingInput }),
			...(remote.failure === undefined ? {} : { failure: remote.failure }),
		},
		eventCursor: selected.at(-1)?.eventSeq ?? after,
		events: selected.map((event) => ({
			sequence: event.eventSeq,
			type: event.type,
			at: event.at,
			summary: event.summary ?? event.type,
		})),
		...(gap === undefined ? {} : { eventGap: gap }),
		truncated: gap !== undefined
			|| remote.eventsTruncated
			|| selected.length < remote.events.length,
	};
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => {
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

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new DOMException('Operation cancelled.', 'AbortError');
	}
}

function meshReason(error: unknown): string | undefined {
	if (!(error instanceof LocalIpcRemoteError) || !isRecord(error.data)) {
		return undefined;
	}
	const reason = error.data.reason;
	return typeof reason === 'string'
		&& reason in MESH_ERROR_CODES
		&& MESH_ERROR_CODES[reason as keyof typeof MESH_ERROR_CODES] === error.code
		? reason
		: undefined;
}

function toFacadeError(error: unknown): Error {
	if (error instanceof TaskToolFacadeError || isAbortError(error)) {
		return error;
	}
	const reason = meshReason(error);
	if (
		reason !== undefined
		&& (TASK_TOOL_ERROR_CODES as readonly string[]).includes(reason)
	) {
		const retryable = error instanceof LocalIpcRemoteError
			&& isRecord(error.data)
			&& error.data.retryable === true;
		return new TaskToolFacadeError(reason as TaskToolErrorCode, retryable);
	}
	return new TaskToolFacadeError('INTERNAL_ERROR');
}

function isAbortError(error: unknown): error is Error {
	return error instanceof Error && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fallbackSourceWorkspaceIdentity(sourceNodeId: string): string {
	return `sha256:${createHash('sha256')
		.update('copilot-agent-mesh/test-source-workspace\0', 'utf8')
		.update(sourceNodeId, 'utf8')
		.digest('base64url')}`;
}
