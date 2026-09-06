import { TERMINAL_TASK_STATUSES } from '../../shared/protocol';
import type { TaskToolSnapshot } from '../../shared/toolProtocol';
import type { ToolCancellation, ToolClock } from './DelegationWaiter';
import { TaskToolFacadeError, type TaskSnapshotSubscription } from './taskToolFacade';

export type TaskReadWaitMode = 'change' | 'outcome';
export type TaskReadWaitOutcome = 'changed' | 'outcome' | 'timeout' | 'cancelled';

export function isTaskOutcome(snapshot: TaskToolSnapshot): boolean {
	return snapshot.status === 'needsInput'
		|| TERMINAL_TASK_STATUSES.some((state) => state === snapshot.status);
}

/** A read-only subscription: stopping or timing out never cancels the task. */
export class TaskSnapshotWaiter {
	private latest: TaskToolSnapshot | undefined;
	private failure: unknown;
	private wake: (() => void) | undefined;
	private readonly subscription: TaskSnapshotSubscription;
	private readonly cancellationRegistration: { dispose(): void };
	private timer: ReturnType<ToolClock['createTimer']> | undefined;
	private disposed = false;
	private waiting = false;

	public constructor(private readonly options: {
		readonly taskId: string;
		readonly mode: TaskReadWaitMode;
		readonly seconds: number;
		readonly clock: ToolClock;
		readonly cancellation: ToolCancellation;
		readonly subscribe: (
			listener: (snapshot: TaskToolSnapshot) => void,
			onError: (error: unknown) => void,
		) => TaskSnapshotSubscription;
	}) {
		this.subscription = options.subscribe((snapshot) => {
			if (snapshot.taskId !== options.taskId) {
				this.failure = new TaskToolFacadeError('OUTPUT_INVALID');
			} else {
				this.latest = snapshot;
			}
			this.wake?.();
		}, (error) => {
			this.failure = error ?? new TaskToolFacadeError('INTERNAL_ERROR');
			this.wake?.();
		});
		try {
			this.cancellationRegistration = options.cancellation.onCancellationRequested(() => this.wake?.());
		} catch (error) {
			this.subscription.dispose();
			throw error;
		}
	}

	public async wait(initial: TaskToolSnapshot, cursorChanged = false): Promise<TaskReadWaitOutcome> {
		if (this.disposed || this.waiting) { throw new Error('This task wait is no longer available.'); }
		this.waiting = true;
		this.timer = this.options.clock.createTimer(this.options.seconds * 1_000);
		const timeout = this.timer.promise.then(() => 'timeout' as const);
		const baseline = JSON.stringify(initial);
		for (;;) {
			if (this.failure !== undefined) { throw this.failure; }
			if (this.options.cancellation.isCancellationRequested) { return 'cancelled'; }
			if (isTaskOutcome(initial)) { return 'outcome'; }
			if (this.latest !== undefined && isTaskOutcome(this.latest)) { return 'outcome'; }
			if (this.options.mode === 'change' && (cursorChanged
				|| (this.latest !== undefined && JSON.stringify(this.latest) !== baseline))) {
				return 'changed';
			}
			const changed = new Promise<'changed'>((resolve) => { this.wake = () => resolve('changed'); });
			if (await Promise.race([changed, timeout]) === 'timeout') { return 'timeout'; }
		}
	}

	public dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.timer?.dispose();
		this.cancellationRegistration.dispose();
		this.subscription.dispose();
		this.wake = undefined;
	}
}
