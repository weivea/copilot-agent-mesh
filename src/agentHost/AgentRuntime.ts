export const AGENT_RUNTIME_ERROR_CODES = [
	'AGENT_UNAVAILABLE',
	'AGENT_AUTH_REQUIRED',
	'AGENT_AUTH_FAILED',
	'AGENT_CONFIG_REQUIRED',
	'TASK_EXECUTION_FAILED',
	'TASK_RECOVERY_UNAVAILABLE',
	'TASK_CANCELLATION_UNCONFIRMED',
] as const;

export type AgentRuntimeErrorCode = typeof AGENT_RUNTIME_ERROR_CODES[number];

export class AgentRuntimeError extends Error {
	constructor(
		readonly code: AgentRuntimeErrorCode,
		message: string,
		readonly retryable = false,
		cause?: unknown,
		readonly cleanupFailed = false,
	) {
		super(message, { cause });
		this.name = 'AgentRuntimeError';
	}
}

export interface RegisteredLocalWorkspace {
	readonly workspaceId: string;
	readonly displayName: string;
	readonly uri: string;
}

export interface AgentTaskRequest {
	readonly taskId: string;
	readonly title: string;
	readonly prompt: string;
	readonly acceptanceCriteria?: readonly string[];
	readonly workspaceId: string;
	readonly providerId?: string;
	readonly allowInteractiveAuthentication?: boolean;
}

export interface ResolvedAgentTaskRequest extends AgentTaskRequest {
	readonly workspace: RegisteredLocalWorkspace;
}

export interface WorkspaceResolver {
	resolve(workspaceId: string): Promise<RegisteredLocalWorkspace | undefined>;
}

export interface FirstTaskConfirmation {
	confirm(request: ResolvedAgentTaskRequest): Promise<'once' | 'always' | 'deny'>;
}

export type AgentInputKind = 'chatInput' | 'toolConfirmation' | 'toolAuthentication';

export interface AgentInputOption {
	readonly id: string;
	readonly label: string;
	readonly approve?: boolean;
}

export interface AgentInputRequest {
	readonly requestId: string;
	readonly kind: AgentInputKind;
	readonly prompt: string;
	readonly url?: string;
	readonly options?: readonly AgentInputOption[];
	readonly fields?: readonly {
		readonly id: string;
		readonly prompt: string;
		readonly required: boolean;
		readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'singleSelect' | 'multiSelect';
		readonly options?: readonly AgentInputOption[];
		readonly allowFreeformInput?: boolean;
		readonly min?: number;
		readonly max?: number;
		readonly defaultValue?: string | number | boolean;
	}[];
}

export type AgentInputValue =
	| string
	| number
	| boolean
	| readonly string[]
	| {
		readonly selected?: string | readonly string[];
		readonly freeformValues: readonly string[];
	};

export interface AgentTaskAnswer {
	readonly requestId: string;
	readonly outcome: 'accept' | 'decline' | 'cancel';
	readonly selectedOptionId?: string;
	readonly values?: Readonly<Record<string, AgentInputValue>>;
	readonly reason?: string;
}

export type AgentRuntimeEvent =
	| { readonly type: 'progress'; readonly message: string }
	| { readonly type: 'output'; readonly text: string }
	| { readonly type: 'tool'; readonly name: string; readonly status: string; readonly summary?: string }
	| { readonly type: 'terminal'; readonly summary: string }
	| { readonly type: 'inputRequired'; readonly request: AgentInputRequest }
	| { readonly type: 'completed' }
	| { readonly type: 'cancelled' }
	| { readonly type: 'failed'; readonly error: AgentRuntimeError };

export interface AgentRecoveryDescriptor {
	readonly clientId: string;
	readonly sessionUri: string;
	readonly chatUri: string;
	readonly lastSeenServerSeq: number;
}

export interface AgentTaskHandle {
	readonly taskId: string;
	readonly events: AsyncIterable<AgentRuntimeEvent>;
	readonly recovery: AgentRecoveryDescriptor;
	cancel(): Promise<void>;
	answer(answer: AgentTaskAnswer): Promise<void>;
	dispose(): Promise<void>;
}

export interface AgentRuntime {
	probe(): Promise<AgentRuntimeProbe>;
	start(request: AgentTaskRequest): Promise<AgentTaskHandle>;
	dispose(): Promise<void>;
}

export class AgentRuntimeLifecycle {
	private runtime: AgentRuntime | undefined;
	private disposal: Promise<void> | undefined;

	track(runtime: AgentRuntime): void {
		if (this.runtime !== undefined || this.disposal !== undefined) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'An Agent runtime lifecycle is already active.');
		}
		this.runtime = runtime;
	}

	dispose(): Promise<void> {
		if (this.disposal !== undefined) {
			return this.disposal;
		}
		const runtime = this.runtime;
		const operation = runtime?.dispose() ?? Promise.resolve();
		const disposal = operation.then(
			() => {
				if (this.runtime === runtime) {
					this.runtime = undefined;
				}
			},
			(error: unknown) => {
				if (this.disposal === disposal) {
					this.disposal = undefined;
				}
				throw error;
			},
		);
		this.disposal = disposal;
		return disposal;
	}
}

export interface AgentRuntimeProbe {
	readonly available: boolean;
	readonly featureEnabled: boolean;
	readonly version?: string;
	readonly reason?: AgentRuntimeErrorCode;
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
	private readonly values: T[] = [];
	private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
	private closed = false;

	push(value: T): void {
		if (this.closed) {
			return;
		}
		const waiter = this.waiting.shift();
		if (waiter !== undefined) {
			waiter({ done: false, value });
		} else {
			this.values.push(value);
		}
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const waiter of this.waiting.splice(0)) {
			waiter({ done: true, value: undefined });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: async () => {
				const value = this.values.shift();
				if (value !== undefined) {
					return { done: false, value };
				}
				if (this.closed) {
					return { done: true, value: undefined };
				}
				return new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
			},
			return: async () => {
				this.close();
				return { done: true, value: undefined };
			},
		};
	}
}
