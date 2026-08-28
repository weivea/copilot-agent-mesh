import type {
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

	public constructor(private readonly client: WindowNodeClient) {}

	public listDevices(signal: AbortSignal): Promise<MeshRemoteDirectorySnapshot> {
		throwIfAborted(signal);
		return raceAbort(this.client.listRemoteDevices(), signal);
	}

	public async startTask(
		input: RoutedTaskStartParams,
		route: { readonly peerId?: string },
	): Promise<TaskSnapshot> {
		if (route.peerId === undefined) {
			throw new TypeError('An explicit remote peer route is required.');
		}
		const snapshot = await this.client.startRemoteTask(input, route.peerId);
		this.snapshots.set(snapshot.taskId, snapshot);
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
			this.snapshots.set(snapshot.taskId, snapshot);
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
			this.snapshots.set(snapshot.taskId, snapshot);
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
			this.snapshots.set(snapshot.taskId, snapshot);
		}
		return snapshot;
	}

	public listKnownTasks(): readonly (TaskSnapshot | TaskSnapshotAfterEventSeq)[] {
		return [...this.snapshots.values()].map((snapshot) => structuredClone(snapshot));
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
