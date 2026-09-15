import { CancellationTokenSource } from 'vscode-jsonrpc';

import { ConnectivityError } from './ConnectivitySchemas';

export function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(new ConnectivityError('CANCELLED'));
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener('abort', abort, { once: true });
		Promise.resolve(operation).then(resolve, reject).finally(() => {
			signal.removeEventListener('abort', abort);
		}).catch(() => undefined);
	});
}

export class ConnectivityOperation {
	public readonly controller = new AbortController();
	public readonly cancellation = new CancellationTokenSource();
	private readonly timer: NodeJS.Timeout;
	private timedOut = false;
	private readonly deadline: number;
	private timerDelay = 0;
	private readonly parents: readonly AbortSignal[];
	private readonly abort = (): void => {
		this.controller.abort();
		this.cancellation.cancel();
	};

	public constructor(timeoutMs: number, ...parents: (AbortSignal | undefined)[]) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
			throw new RangeError('Invalid connectivity deadline.');
		}
		this.deadline = Date.now() + timeoutMs;
		// vscode-jsonrpc 4.0.0 cannot dispose a source cancelled before its lazy token is created.
		void this.cancellation.token;
		this.parents = parents.filter((signal): signal is AbortSignal => signal !== undefined);
		for (const parent of this.parents) {
			parent.addEventListener('abort', this.abort, { once: true });
			if (parent.aborted) {
				this.abort();
			}
		}
		this.timer = setTimeout(() => this.expire(), timeoutMs);
	}

	public assertActive(): void {
		if (Date.now() >= this.deadline) { this.expire(); }
		const error = this.cancellationError;
		if (error !== undefined) { throw error; }
	}

	public get deadlineDelayMs(): number { return this.timerDelay; }

	public get cancellationError(): ConnectivityError | undefined {
		if (Date.now() >= this.deadline) { this.expire(); }
		return this.controller.signal.aborted ? new ConnectivityError(this.timedOut ? 'TIMEOUT' : 'CANCELLED') : undefined;
	}

	public dispose(): void {
		clearTimeout(this.timer);
		for (const parent of this.parents) {
			parent.removeEventListener('abort', this.abort);
		}
		this.cancellation.dispose();
	}

	private expire(): void {
		if (this.controller.signal.aborted) { return; }
		this.timedOut = true;
		this.timerDelay = Math.max(0, Date.now() - this.deadline);
		this.abort();
	}
}
