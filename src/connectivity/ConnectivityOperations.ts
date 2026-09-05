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
	private readonly parents: readonly AbortSignal[];
	private readonly abort = (): void => {
		this.controller.abort();
		this.cancellation.cancel();
	};

	public constructor(timeoutMs: number, ...parents: (AbortSignal | undefined)[]) {
		// vscode-jsonrpc 4.0.0 cannot dispose a source cancelled before its lazy token is created.
		void this.cancellation.token;
		this.parents = parents.filter((signal): signal is AbortSignal => signal !== undefined);
		for (const parent of this.parents) {
			parent.addEventListener('abort', this.abort, { once: true });
			if (parent.aborted) {
				this.abort();
			}
		}
		this.timer = setTimeout(() => {
			this.timedOut = true;
			this.abort();
		}, timeoutMs);
	}

	public assertActive(): void {
		const error = this.cancellationError;
		if (error !== undefined) { throw error; }
	}

	public get cancellationError(): ConnectivityError | undefined {
		return this.controller.signal.aborted ? new ConnectivityError(this.timedOut ? 'TIMEOUT' : 'CANCELLED') : undefined;
	}

	public dispose(): void {
		clearTimeout(this.timer);
		for (const parent of this.parents) {
			parent.removeEventListener('abort', this.abort);
		}
		this.cancellation.dispose();
	}
}
