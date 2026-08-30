import type {
	TaskToolErrorCode,
	TaskToolSnapshot,
} from '../../shared/toolProtocol';

export interface ToolCancellation {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ToolClock {
	createTimer(delayMs: number): {
		readonly promise: Promise<void>;
		dispose(): void;
	};
}

export type DelegationCancellationReason = 'token' | 'budget' | 'peer';

export type DelegationOutcome =
	| {
		readonly kind: 'completed';
		readonly taskId: string;
		readonly result: Readonly<Record<string, unknown>>;
	}
	| {
		readonly kind: 'needsInput';
		readonly taskId: string;
		readonly inputId: string;
		readonly question: string;
	}
	| {
		readonly kind: 'failed';
		readonly taskId: string;
		readonly code: TaskToolErrorCode | string;
		readonly message: string;
	}
	| {
		readonly kind: 'cancelled';
		readonly taskId: string;
		readonly reason: DelegationCancellationReason;
		readonly code: 'CANCELLED' | 'TIMEOUT';
	};

export interface DelegationTaskSubscription {
	dispose(): void;
}

export interface DelegationWaiterOptions {
	readonly taskId: string;
	readonly timeoutMinutes: number;
	readonly cancellation: ToolCancellation;
	readonly clock: ToolClock;
	readonly subscribe: (
		listener: (snapshot: TaskToolSnapshot) => void,
		onError: (error: unknown) => void,
	) => DelegationTaskSubscription;
	readonly start: (onTaskAvailable: () => void) => Promise<TaskToolSnapshot>;
	readonly cancel: () => Promise<TaskToolSnapshot>;
	readonly sanitizeText: (value: string) => string;
}

export class DelegationWaiter {
	private disposed = false;
	private subscription: DelegationTaskSubscription | undefined;
	private cancellationRegistration: { dispose(): void } | undefined;
	private timer: ReturnType<ToolClock['createTimer']> | undefined;
	private settled = false;
	private startReconciled = false;
	private cancelReason: Exclude<DelegationCancellationReason, 'peer'> | undefined;
	private cancellationAccepted = false;
	private cancelOperation: Promise<void> | undefined;

	public constructor(private readonly options: DelegationWaiterOptions) {}

	public async wait(): Promise<DelegationOutcome> {
		let resolveOutcome!: (outcome: DelegationOutcome) => void;
		const outcome = new Promise<DelegationOutcome>((resolve) => {
			resolveOutcome = resolve;
		});
		const settle = (value: DelegationOutcome): void => {
			if (this.settled) {
				return;
			}
			this.settled = true;
			resolveOutcome(value);
		};

		try {
			try {
				this.subscription = this.options.subscribe(
					(snapshot) => {
						try {
							const value = this.toOutcome(snapshot);
							if (value !== undefined) {
								settle(value);
							}
						} catch {
							settle(this.failed('OUTPUT_INVALID', 'The authoritative task event was invalid.'));
						}
					},
					(error) => settle(this.failureFromUnknown(error)),
				);
				this.cancellationRegistration = this.options.cancellation.onCancellationRequested(
					() => this.requestCancellation('token', settle),
				);
				this.timer = this.options.clock.createTimer(this.options.timeoutMinutes * 60_000);
				void this.timer.promise.then(() => this.requestCancellation('budget', settle));

				if (this.options.cancellation.isCancellationRequested) {
					this.requestCancellation('token', settle);
				}

				void Promise.resolve()
					.then(() => this.options.start(() => {
						this.markTaskAvailable(settle);
					}))
					.then(
						(snapshot) => {
							this.markTaskAvailable(settle);
							const value = this.toOutcome(snapshot);
							if (value !== undefined) {
								settle(value);
								return;
							}
							if (this.cancelReason !== undefined) {
								this.beginCancellation(settle);
							}
						},
						(error: unknown) => {
							if (this.cancelOperation === undefined) {
								settle(this.failureFromUnknown(error));
							}
						},
					)
					.catch(() => settle(this.failed('INTERNAL_ERROR', 'The delegation start listener failed.')));
			} catch (error) {
				settle(this.failureFromUnknown(error));
			}

			return await outcome;
		} finally {
			this.dispose();
		}
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.timer?.dispose();
		this.timer = undefined;
		this.cancellationRegistration?.dispose();
		this.cancellationRegistration = undefined;
		this.subscription?.dispose();
		this.subscription = undefined;
	}

	private requestCancellation(
		reason: Exclude<DelegationCancellationReason, 'peer'>,
		settle: (outcome: DelegationOutcome) => void,
	): void {
		if (this.settled || this.cancelReason !== undefined) {
			return;
		}
		this.cancelReason = reason;
		if (this.startReconciled) {
			this.beginCancellation(settle);
		}
	}

	private beginCancellation(settle: (outcome: DelegationOutcome) => void): void {
		if (this.settled || this.cancelOperation !== undefined) {
			return;
		}
		this.cancelOperation = Promise.resolve()
			.then(this.options.cancel)
			.then(
				(snapshot) => {
					this.cancellationAccepted = snapshot.status === 'cancelling'
						|| snapshot.status === 'cancelled'
						|| snapshot.status === 'failed'
						|| snapshot.status === 'timedOut';
					const outcome = this.toOutcome(snapshot);
					if (outcome !== undefined) {
						settle(outcome);
					}
				},
				(error: unknown) => settle(this.failureFromUnknown(error)),
			)
			.catch(() => settle(this.failed('INTERNAL_ERROR', 'The cancellation listener failed.')));
	}

	private markTaskAvailable(settle: (outcome: DelegationOutcome) => void): void {
		this.startReconciled = true;
		if (this.cancelReason !== undefined) {
			this.beginCancellation(settle);
		}
	}

	private toOutcome(snapshot: TaskToolSnapshot): DelegationOutcome | undefined {
		if (snapshot.taskId !== this.options.taskId) {
			return this.failed('OUTPUT_INVALID', 'The authoritative task event identified another task.');
		}
		switch (snapshot.status) {
			case 'completed':
				if (this.cancellationAccepted && this.cancelReason !== undefined) {
					return this.cancelled(this.cancelReason);
				}
				return {
					kind: 'completed',
					taskId: this.options.taskId,
					result: {
						summary: this.options.sanitizeText(snapshot.summary ?? 'Task completed.'),
						...(snapshot.validation === undefined
							? {}
							: {
								validation: {
									status: snapshot.validation.status,
									...(snapshot.validation.summary === undefined
										? {}
										: {
											summary: this.options.sanitizeText(
												snapshot.validation.summary,
											),
										}),
								},
							}),
						...(snapshot.artifacts === undefined
							? {}
							: {
								artifacts: snapshot.artifacts.map((artifact) => ({
									artifactId: artifact.artifactId,
									label: this.options.sanitizeText(artifact.label),
									...(artifact.mediaType === undefined
										? {}
										: { mediaType: this.options.sanitizeText(artifact.mediaType) }),
								})),
							}),
					},
				};
			case 'needsInput':
				if (this.cancelReason !== undefined) {
					return undefined;
				}
				if (snapshot.pendingInput === undefined) {
					return this.failed('OUTPUT_INVALID', 'The task requires input without a pending input identity.');
				}
				return {
					kind: 'needsInput',
					taskId: this.options.taskId,
					inputId: snapshot.pendingInput.inputId,
					question: this.options.sanitizeText(snapshot.pendingInput.prompt),
				};
			case 'failed':
			case 'timedOut':
				return this.failed(
					snapshot.failure?.code ?? (snapshot.status === 'timedOut' ? 'TIMEOUT' : 'TASK_EXECUTION_FAILED'),
					snapshot.failure?.message ?? 'The delegated task failed.',
				);
			case 'cancelled':
				return this.cancelled(
					this.cancelOperation === undefined
						? 'peer'
						: this.cancelReason ?? 'peer',
				);
			default:
				return undefined;
		}
	}

	private cancelled(
		reason: Exclude<DelegationCancellationReason, 'peer'> | 'peer',
	): DelegationOutcome {
		return {
			kind: 'cancelled',
			taskId: this.options.taskId,
			reason,
			code: reason === 'budget' ? 'TIMEOUT' : 'CANCELLED',
		};
	}

	private failureFromUnknown(error: unknown): DelegationOutcome {
		const candidate = error as {
			readonly code?: unknown;
			readonly message?: unknown;
		};
		return this.failed(
			typeof candidate?.code === 'string' ? candidate.code : 'INTERNAL_ERROR',
			typeof candidate?.message === 'string'
				? candidate.message
				: 'The delegated task could not be reconciled.',
		);
	}

	private failed(code: string, message: string): DelegationOutcome {
		let safeMessage = 'The delegated task failed.';
		try {
			safeMessage = this.options.sanitizeText(message);
		} catch {
			// A sanitizer failure must not escape the Tool outcome boundary.
		}
		return {
			kind: 'failed',
			taskId: this.options.taskId,
			code,
			message: safeMessage,
		};
	}
}
