import type {
	BrokerOwnership,
	BrokerOwnershipSnapshot,
} from '../storage/BrokerOwnerLock';

const defaultContentionIntervalMs = 1_000;
const defaultRetryBaseDelayMs = 1_000;
const defaultRetryMaxDelayMs = 30_000;
const maxTimerDelayMs = 2_147_483_647;

export interface BrokerRuntime {
	start(): Promise<void> | void;
	dispose(): Promise<void> | void;
}

export type BrokerRuntimeFactory<Runtime extends BrokerRuntime> = (
	generation: string,
) => Promise<Runtime> | Runtime;

export type BrokerLifecycleState =
	| 'starting'
	| 'running'
	| 'contending'
	| 'takingOver'
	| 'stopping'
	| 'error'
	| 'disposed';

export type BrokerLifecycleErrorCode =
	| 'BROKER_CONTENTION_FAILED'
	| 'BROKER_OWNERSHIP_RELEASE_FAILED'
	| 'BROKER_OWNERSHIP_INVALID'
	| 'BROKER_RUNTIME_DISPOSE_FAILED'
	| 'BROKER_RUNTIME_START_FAILED';

export interface BrokerLifecycleStatusError {
	readonly code: BrokerLifecycleErrorCode;
	readonly message: string;
	readonly retryable: true;
}

export interface BrokerLifecycleOwnerSnapshot {
	readonly owner: boolean;
	readonly generation?: string;
	readonly holderWindowId?: string;
}

export interface BrokerLifecycleStatus {
	readonly state: BrokerLifecycleState;
	readonly generation?: string;
	readonly owner: boolean;
	readonly holderWindowId?: string;
	readonly ownership: BrokerLifecycleOwnerSnapshot;
	readonly error?: BrokerLifecycleStatusError;
}

export interface BrokerLifecycleScheduler {
	schedule(callback: () => void, delayMs: number): { dispose(): void };
}

export interface BrokerLifecycleOptions {
	readonly contentionIntervalMs?: number;
	readonly retryBaseDelayMs?: number;
	readonly retryMaxDelayMs?: number;
	readonly scheduler?: BrokerLifecycleScheduler;
	readonly setTimer?: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof setTimeout>;
	readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class BrokerLifecycle<Runtime extends BrokerRuntime = BrokerRuntime> {
	private readonly contentionIntervalMs: number;
	private readonly retryBaseDelayMs: number;
	private readonly retryMaxDelayMs: number;
	private readonly scheduler: BrokerLifecycleScheduler;
	private readonly statusListeners = new Set<() => void>();

	private disposeOperation: Promise<void> | undefined;
	private disposeRequested = false;
	private lossSubscription: { dispose(): void } | undefined;
	private operationTail: Promise<void> = Promise.resolve();
	private retryAttempt = 0;
	private runtime: Runtime | undefined;
	private runtimeGeneration: string | undefined;
	private startOperation: Promise<void> | undefined;
	private timer: { dispose(): void } | undefined;
	private statusValue: BrokerLifecycleStatus;

	public constructor(
		private readonly ownership: BrokerOwnership,
		private readonly runtimeFactory: BrokerRuntimeFactory<Runtime>,
		options: BrokerLifecycleOptions = {},
	) {
		this.contentionIntervalMs = options.contentionIntervalMs
			?? defaultContentionIntervalMs;
		this.retryBaseDelayMs = options.retryBaseDelayMs
			?? defaultRetryBaseDelayMs;
		this.retryMaxDelayMs = options.retryMaxDelayMs
			?? defaultRetryMaxDelayMs;
		const clearTimer = options.clearTimer ?? clearTimeout;
		const setTimer = options.setTimer ?? setTimeout;
		this.scheduler = options.scheduler ?? {
			schedule(callback, delayMs) {
				const timer = setTimer(callback, delayMs);
				unrefTimer(timer);
				return { dispose: () => clearTimer(timer) };
			},
		};
		validateDelay('contentionIntervalMs', this.contentionIntervalMs);
		validateDelay('retryBaseDelayMs', this.retryBaseDelayMs);
		validateDelay('retryMaxDelayMs', this.retryMaxDelayMs);
		if (this.retryBaseDelayMs > this.retryMaxDelayMs) {
			throw new RangeError('retryBaseDelayMs must not exceed retryMaxDelayMs.');
		}
		this.statusValue = this.createStatus('contending');
	}

	public get status(): BrokerLifecycleStatus {
		return this.statusValue;
	}

	public getStatus(): BrokerLifecycleStatus {
		return this.statusValue;
	}

	public snapshot(): BrokerLifecycleStatus {
		return this.statusValue;
	}

	public onDidChange(listener: () => void): { dispose(): void } {
		this.statusListeners.add(listener);
		return { dispose: () => this.statusListeners.delete(listener) };
	}

	public start(): Promise<void> {
		if (this.disposeRequested) {
			return Promise.reject(new Error('Broker lifecycle is disposed.'));
		}
		if (this.startOperation !== undefined) {
			return this.startOperation;
		}
		this.startOperation = this.enqueue(() => this.startCore());
		return this.startOperation;
	}

	public dispose(): Promise<void> {
		if (this.disposeOperation !== undefined) {
			return this.disposeOperation;
		}
		this.disposeRequested = true;
		const timerFailure = this.cancelTimer();
		let operation!: Promise<void>;
		operation = this.enqueue(() => this.disposeCore(timerFailure)).finally(() => {
			if (
				this.statusValue.state !== 'disposed'
				&& this.disposeOperation === operation
			) {
				this.disposeOperation = undefined;
			}
		});
		this.disposeOperation = operation;
		return operation;
	}

	private async startCore(): Promise<void> {
		if (this.disposeRequested) {
			return;
		}
		this.lossSubscription = this.ownership.onDidLoseOwnership(() => {
			if (!this.disposeRequested) {
				void this.enqueue(() => this.handleOwnershipLoss());
			}
		});
		if (!this.ownership.isOwner()) {
			this.transition('contending');
			this.schedule(this.contentionIntervalMs);
			return;
		}
		const generation = this.ownership.currentGeneration();
		if (generation === undefined) {
			const error = new Error('The Device Broker owner has no generation.');
			this.fail(
				'BROKER_OWNERSHIP_INVALID',
				'Device Broker ownership could not be validated.',
			);
			this.scheduleRetry();
			throw error;
		}
		try {
			if (!await this.startRuntime(generation)) {
				this.transition('contending');
				this.schedule(this.contentionIntervalMs);
			}
		} catch (error) {
			this.fail(
				'BROKER_RUNTIME_START_FAILED',
				'The Device Broker runtime failed to start.',
			);
			this.scheduleRetry();
			throw error;
		}
	}

	private async startRuntime(generation: string): Promise<boolean> {
		if (!this.isCurrentOwner(generation) || this.disposeRequested) {
			return false;
		}
		this.transition('starting');
		const runtime = await this.runtimeFactory(generation);
		this.runtime = runtime;
		this.runtimeGeneration = generation;
		if (!this.isCurrentOwner(generation) || this.disposeRequested) {
			await this.stopRuntime();
			return false;
		}
		try {
			await runtime.start();
		} catch (startError) {
			try {
				await this.stopRuntime();
			} catch (disposeError) {
				throw new AggregateError(
					[startError, disposeError],
					'The Device Broker runtime failed to start and clean up.',
				);
			}
			throw startError;
		}
		if (!this.isCurrentOwner(generation) || this.disposeRequested) {
			await this.stopRuntime();
			return false;
		}
		this.retryAttempt = 0;
		this.transition('running');
		return true;
	}

	private async handleOwnershipLoss(): Promise<void> {
		if (this.disposeRequested) {
			return;
		}
		if (this.runtime !== undefined) {
			this.transition('stopping');
			try {
				await this.stopRuntime();
			} catch {
				this.fail(
					'BROKER_RUNTIME_DISPOSE_FAILED',
					'The previous Device Broker runtime did not stop cleanly.',
				);
				this.scheduleRetry();
				return;
			}
		}
		this.retryAttempt = 0;
		this.transition('contending');
		this.schedule(this.contentionIntervalMs);
	}

	private async runScheduledContention(): Promise<void> {
		if (this.disposeRequested) {
			return;
		}
		let phase: 'contending' | 'starting' | 'stopping' = 'stopping';
		try {
			if (
				this.runtime !== undefined
				&& !this.isCurrentOwner(this.runtimeGeneration)
			) {
				this.transition('stopping');
				await this.stopRuntime();
			}
			if (
				this.runtime !== undefined
				&& this.isCurrentOwner(this.runtimeGeneration)
			) {
				this.retryAttempt = 0;
				this.transition('running');
				return;
			}
			phase = 'contending';
			this.transition('contending');
			if (!await this.ownership.contend()) {
				this.retryAttempt = 0;
				this.transition('contending');
				this.schedule(this.contentionIntervalMs);
				return;
			}
			const generation = this.ownership.currentGeneration();
			if (generation === undefined || !this.ownership.isOwner()) {
				this.fail(
					'BROKER_OWNERSHIP_INVALID',
					'Device Broker ownership could not be validated.',
				);
				this.scheduleRetry();
				return;
			}
			phase = 'starting';
			this.transition('takingOver');
			if (!await this.startRuntime(generation)) {
				this.transition('contending');
				this.schedule(this.contentionIntervalMs);
			}
		} catch {
			const failure = phase === 'contending'
				? {
					code: 'BROKER_CONTENTION_FAILED' as const,
					message: 'Device Broker ownership contention failed.',
				}
				: phase === 'starting'
					? {
						code: 'BROKER_RUNTIME_START_FAILED' as const,
						message: 'The Device Broker runtime failed to start.',
					}
					: {
						code: 'BROKER_RUNTIME_DISPOSE_FAILED' as const,
						message: 'The previous Device Broker runtime did not stop cleanly.',
					};
			this.fail(failure.code, failure.message);
			this.scheduleRetry();
		}
	}

	private async stopRuntime(): Promise<void> {
		const runtime = this.runtime;
		if (runtime === undefined) {
			this.runtimeGeneration = undefined;
			return;
		}
		await runtime.dispose();
		if (this.runtime === runtime) {
			this.runtime = undefined;
			this.runtimeGeneration = undefined;
		}
	}

	private async disposeCore(timerFailure: unknown): Promise<void> {
		const failures: unknown[] = [];
		if (timerFailure !== undefined) {
			failures.push(timerFailure);
		}
		this.transition('stopping');
		if (this.runtime !== undefined) {
			try {
				await this.stopRuntime();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			this.fail(
				'BROKER_RUNTIME_DISPOSE_FAILED',
				'The Device Broker runtime did not stop cleanly; disposal can be retried.',
			);
			throw new AggregateError(failures, 'Device Broker runtime cleanup failed.');
		}

		try {
			this.lossSubscription?.dispose();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length === 0) {
			this.lossSubscription = undefined;
		}
		if (failures.length > 0) {
			this.fail(
				'BROKER_OWNERSHIP_RELEASE_FAILED',
				'The Device Broker ownership listener could not be released; disposal can be retried.',
			);
			throw new AggregateError(failures, 'Device Broker ownership listener cleanup failed.');
		}

		try {
			await this.ownership.dispose();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) {
			this.fail(
				'BROKER_OWNERSHIP_RELEASE_FAILED',
				'Device Broker ownership could not be released; disposal can be retried.',
			);
			throw new AggregateError(failures, 'Device Broker ownership cleanup failed.');
		}

		this.transition('disposed');
		this.statusListeners.clear();
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private isCurrentOwner(generation: string | undefined): boolean {
		return generation !== undefined
			&& this.ownership.isOwner()
			&& this.ownership.currentGeneration() === generation;
	}

	private schedule(delayMs: number): void {
		if (this.disposeRequested || this.timer !== undefined) {
			return;
		}
		const timer = this.scheduler.schedule(() => {
			if (this.timer !== timer) {
				return;
			}
			this.timer = undefined;
			void this.enqueue(() => this.runScheduledContention());
		}, Math.min(delayMs, maxTimerDelayMs));
		this.timer = timer;
	}

	private scheduleRetry(): void {
		this.retryAttempt = Math.min(this.retryAttempt + 1, 31);
		const delay = this.retryBaseDelayMs * (2 ** (this.retryAttempt - 1));
		this.schedule(Math.min(delay, this.retryMaxDelayMs));
	}

	private cancelTimer(): unknown {
		const timer = this.timer;
		this.timer = undefined;
		if (timer === undefined) {
			return undefined;
		}
		try {
			timer.dispose();
			return undefined;
		} catch (error) {
			return error;
		}
	}

	private fail(code: BrokerLifecycleErrorCode, message: string): void {
		this.transition('error', { code, message, retryable: true });
	}

	private transition(
		state: BrokerLifecycleState,
		error?: BrokerLifecycleStatusError,
	): void {
		this.statusValue = this.createStatus(state, error);
		for (const listener of this.statusListeners) {
			try {
				listener();
			} catch {
				process.emitWarning('A Device Broker lifecycle status listener failed.', {
					code: 'BROKER_LIFECYCLE_LISTENER_FAILED',
				});
			}
		}
	}

	private createStatus(
		state: BrokerLifecycleState,
		error?: BrokerLifecycleStatusError,
	): BrokerLifecycleStatus {
		const snapshot = publicOwnerSnapshot(this.ownership.snapshot());
		const generation = this.runtimeGeneration ?? snapshot.generation;
		return {
			state,
			generation,
			owner: snapshot.owner,
			holderWindowId: snapshot.holderWindowId,
			ownership: snapshot,
			error,
		};
	}
}

function publicOwnerSnapshot(
	snapshot: BrokerOwnershipSnapshot,
): BrokerLifecycleOwnerSnapshot {
	return {
		owner: snapshot.owner,
		generation: snapshot.generation,
		holderWindowId: snapshot.holderInstanceId,
	};
}

function validateDelay(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0 || value > maxTimerDelayMs) {
		throw new RangeError(`${name} must be a positive timer-safe integer.`);
	}
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	if (typeof timer === 'object' && 'unref' in timer) {
		timer.unref();
	}
}
