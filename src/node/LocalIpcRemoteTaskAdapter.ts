import type {
	DelegatedExecutionContext,
	RoutedTaskStartParams,
	TaskSnapshot,
	TaskSnapshotAfterEventSeq,
} from '../../shared/protocol';
import type { MeshRemoteDirectorySnapshot } from '../../shared/toolProtocol';
import type { RemoteTaskRouteAdapter } from '../tools/LocalBrokerTaskFacade';
import type { WindowNodeClient } from './WindowNodeClient';

/**
 * Per-window remote task facade. Cancellation only stops waiting for the local
 * IPC response; the owner Broker remains responsible for the remote request.
 */
export class LocalIpcRemoteTaskAdapter implements RemoteTaskRouteAdapter {
	private readonly snapshots = new Map<string, TaskSnapshot | TaskSnapshotAfterEventSeq>();
	private readonly taskSubscription: { dispose(): void };

	public constructor(private readonly client: WindowNodeClient) {
		this.taskSubscription = typeof client.onTaskSnapshot === 'function'
			? client.onTaskSnapshot((snapshot) => {
				if (this.snapshots.has(snapshot.taskId)) {
					this.remember(snapshot);
				}
			})
			: { dispose: () => undefined };
	}

	public listDevices(signal: AbortSignal): Promise<MeshRemoteDirectorySnapshot> {
		throwIfAborted(signal);
		return raceAbort(this.client.listRemoteDevices(), signal);
	}

	public async startTask(
		input: RoutedTaskStartParams,
		route: {
			readonly peerId?: string;
			readonly delegatedExecutionContext?: DelegatedExecutionContext;
		},
	): Promise<TaskSnapshot> {
		if (route.peerId === undefined) {
			throw new TypeError('An explicit remote peer route is required.');
		}
		const snapshot = route.delegatedExecutionContext === undefined
			? await this.client.startRemoteTask(input, route.peerId)
			: await this.client.startRemoteTaskFromDelegatedChild(
				input,
				route.peerId,
				route.delegatedExecutionContext,
			);
		this.remember(snapshot);
		return snapshot;
	}

	public async getTask(
		taskId: string,
		afterEventSequence: number | undefined,
		signal: AbortSignal,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq | undefined> {
		throwIfAborted(signal);
		const snapshot = await raceAbort(
			this.client.getRemoteTask(taskId, afterEventSequence),
			signal,
		);
		if (snapshot !== undefined) {
			this.remember(snapshot);
		}
		return snapshot;
	}

	public async cancelTask(
		taskId: string,
		signal: AbortSignal,
	): Promise<TaskSnapshot | undefined> {
		throwIfAborted(signal);
		const snapshot = await raceAbort(this.client.cancelRemoteTask(taskId), signal);
		if (snapshot !== undefined) {
			this.remember(snapshot);
		}
		return snapshot;
	}

	public async answerTask(
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
		signal: AbortSignal,
	): Promise<TaskSnapshot | undefined> {
		throwIfAborted(signal);
		const snapshot = await raceAbort(
			this.client.answerRemoteTask(taskId, inputId, answerId, answer),
			signal,
		);
		if (snapshot !== undefined) {
			this.remember(snapshot);
		}
		return snapshot;
	}

	public listKnownTasks(): readonly (TaskSnapshot | TaskSnapshotAfterEventSeq)[] {
		return [...this.snapshots.values()].map((snapshot) => structuredClone(snapshot));
	}

	public dispose(): void {
		this.taskSubscription.dispose();
		this.snapshots.clear();
	}

	private remember(snapshot: TaskSnapshot | TaskSnapshotAfterEventSeq): void {
		const current = this.snapshots.get(snapshot.taskId);
		if (
			current !== undefined
			&& (
				snapshot.eventSeq < current.eventSeq
				|| (
					snapshot.eventSeq === current.eventSeq
					&& 'afterEventSeq' in snapshot
					&& !('afterEventSeq' in current)
				)
			)
		) {
			return;
		}
		this.snapshots.delete(snapshot.taskId);
		this.snapshots.set(snapshot.taskId, snapshot);
		while (this.snapshots.size > 500) {
			const terminal = [...this.snapshots].find(([, candidate]) =>
				['completed', 'failed', 'cancelled', 'timedOut'].includes(candidate.state)
			);
			const oldest = terminal?.[0] ?? this.snapshots.keys().next().value;
			if (oldest === undefined) {
				return;
			}
			this.snapshots.delete(oldest);
		}
	}
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => {
			signal.removeEventListener('abort', abort);
			reject(new DOMException('Local broker operation cancelled.', 'AbortError'));
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
		throw new DOMException('Local broker operation cancelled.', 'AbortError');
	}
}
