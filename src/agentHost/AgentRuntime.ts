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

export type AgentHostSource = 'editor' | 'standalone';

export type AgentHostDegradationReason =
	| 'EDITOR_DISCOVERY_FAILED'
	| 'EDITOR_START_FAILED'
	| 'STANDALONE_START_FAILED';

export type AgentHostSourceStatus =
	| {
		readonly source: 'editor';
		readonly degraded: false;
	}
	| {
		readonly source: 'standalone';
		readonly degraded: false;
	}
	| {
		readonly source: 'standalone';
		readonly degraded: true;
		readonly reason: AgentHostDegradationReason;
		readonly message: string;
	};

export interface AgentHostSourceStatusProvider {
	sourceStatus(): AgentHostSourceStatus;
	onDidSourceStatusChange(listener: (status: AgentHostSourceStatus) => void): {
		dispose(): void;
	};
}

export interface AgentRuntimeLifecycleObservation {
	readonly taskId: string;
	readonly eventType: 'chat/turnComplete' | 'chat/turnCancelled' | 'chat/error';
}

export interface AgentRuntimeLifecycleObserver {
	observeLifecycle(observation: AgentRuntimeLifecycleObservation): void;
}

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
	readonly workspaceIdentity?: string;
	readonly displayName: string;
	readonly uri: string;
}

export interface AgentTaskRequest {
	readonly taskId: string;
	readonly title: string;
	readonly prompt: string;
	readonly acceptanceCriteria?: readonly string[];
	readonly workspaceId: string;
	readonly sourceWindowName?: string;
	readonly approvalCapability?: AgentRuntimeApprovalCapability;
	readonly providerId?: string;
	readonly allowInteractiveAuthentication?: boolean;
	readonly delegatedExecutionContext?: DelegatedExecutionContext;
	readonly approvalContext?: {
		readonly peerId: string;
		readonly workspaceId: string;
		readonly requestHash: string;
	};
}

export interface AgentRuntimeApprovalCapability {
	readonly __agentRuntimeApprovalCapability: unique symbol;
}

export class AgentRuntimeApprovalCapabilityIssuer {
	private readonly issued = new WeakMap<object, string>();

	public issue(request: AgentTaskRequest): AgentRuntimeApprovalCapability {
		const capability = Object.freeze(Object.create(null)) as AgentRuntimeApprovalCapability;
		this.issued.set(capability, approvalFingerprint(request));
		return capability;
	}

	public accepts(request: AgentTaskRequest): boolean {
		return request.approvalCapability !== undefined
			&& this.issued.get(request.approvalCapability) === approvalFingerprint(request);
	}

	public revoke(capability: AgentRuntimeApprovalCapability | undefined): void {
		if (capability !== undefined) {
			this.issued.delete(capability);
		}
	}
}

export interface ResolvedAgentTaskRequest extends AgentTaskRequest {
	readonly workspace: RegisteredLocalWorkspace;
}

export interface WorkspaceResolver {
	resolve(workspaceId: string): Promise<RegisteredLocalWorkspace | undefined>;
}

export interface FirstTaskConfirmation {
	confirm(request: ResolvedAgentTaskRequest): Promise<'once' | 'deny'>;
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
	readonly confirmationEvidence?: {
		readonly phase: 'operation' | 'result';
		readonly toolName: string;
		readonly fileEdits?: readonly {
			readonly beforeUri?: string;
			readonly afterUri?: string;
		}[];
	};
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
	| { readonly type: 'outputTruncated'; readonly message: string }
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
	readonly source?: AgentHostSource;
	readonly degradation?: {
		readonly reason: AgentHostDegradationReason;
		readonly message: string;
	};
}

export type AsyncEventQueuePriority = 'coalescible' | 'droppable' | 'nondroppable';

export interface AsyncEventQueueOptions<T> {
	readonly maxItems?: number;
	readonly maxBytes?: number;
	readonly sizeOf?: (value: T) => number;
	readonly priority?: (value: T) => AsyncEventQueuePriority;
	readonly coalesce?: (queued: T, incoming: T) => T | undefined;
	readonly truncate?: (value: T, maxBytes: number) => T | undefined;
	readonly pressureEvent?: () => T;
}

interface QueuedEvent<T> {
	readonly value: T;
	readonly bytes: number;
}

export class AsyncEventQueueCapacityError extends Error {
	constructor(readonly maxBytes: number) {
		super(`AsyncEventQueue event exceeds the ${maxBytes}-byte limit.`);
		this.name = 'AsyncEventQueueCapacityError';
	}
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
	private readonly values: Array<QueuedEvent<T>> = [];
	private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
	private readonly capacityWaiters: Array<() => void> = [];
	private readonly maxItems: number;
	private readonly maxBytes: number;
	private readonly sizeOf: (value: T) => number;
	private readonly priority: (value: T) => AsyncEventQueuePriority;
	private bufferedByteCount = 0;
	private pendingByteCount = 0;
	private pendingItemCount = 0;
	private pressureReported = false;
	private sealed = false;
	private closed = false;

	constructor(private readonly options: AsyncEventQueueOptions<T> = {}) {
		this.maxItems = positiveInteger(options.maxItems ?? 256, 'maxItems');
		this.maxBytes = positiveInteger(options.maxBytes ?? 1024 * 1024, 'maxBytes');
		this.sizeOf = options.sizeOf ?? defaultEventSize;
		this.priority = options.priority ?? (() => 'nondroppable');
	}

	get bufferedItems(): number {
		return this.values.length;
	}

	get bufferedBytes(): number {
		return this.bufferedByteCount;
	}

	push(value: T): Promise<boolean> {
		return this.pushInternal(value, false);
	}

	async pushAndClose(value: T): Promise<boolean> {
		if (this.closed || this.sealed) {
			return false;
		}
		this.sealed = true;
		this.notifyCapacity();
		await Promise.resolve();
		try {
			const accepted = await this.pushInternal(value, true);
			this.close();
			return accepted;
		} catch (error: unknown) {
			this.close();
			throw error;
		}
	}

	private async pushInternal(value: T, allowSealed: boolean): Promise<boolean> {
		if (this.ingressClosed(allowSealed)) {
			return false;
		}
		const priority = this.priority(value);
		const coalesced = priority === 'coalescible' ? this.tryCoalesce(value) : undefined;
		if (coalesced !== undefined) {
			return coalesced;
		}

		let bytes = this.measure(value);
		let outputTruncated = false;
		if (bytes > this.maxBytes && this.options.truncate !== undefined) {
			const truncated = this.options.truncate(value, this.maxBytes);
			if (truncated !== undefined) {
				value = truncated;
				bytes = this.measure(value);
				outputTruncated = priority === 'droppable';
			}
		}
		if (bytes > this.maxBytes) {
			if (priority === 'droppable' || priority === 'coalescible') {
				if (priority === 'droppable') {
					await this.reportPressure(allowSealed);
				}
				return false;
			}
			throw new AsyncEventQueueCapacityError(this.maxBytes);
		}

		if (priority === 'droppable') {
			if (outputTruncated) {
				await this.reportPressure(allowSealed);
			}
			if (!this.hasCapacity(bytes)) {
				while (!this.hasCapacity(bytes) && this.removeOldestDiscardable(false) !== undefined) {
					// Progress is replaceable and can be discarded without losing output.
				}
			}
			if (!this.hasCapacity(bytes)) {
				await this.reportPressure(allowSealed);
				if (this.ingressClosed(allowSealed)) {
					return false;
				}
				const availableBytes = this.maxBytes - this.bufferedByteCount;
				const truncated = this.values.length < this.maxItems && this.options.truncate !== undefined
					? this.options.truncate(value, availableBytes)
					: undefined;
				if (truncated === undefined) {
					return false;
				}
				value = truncated;
				bytes = this.measure(value);
				if (!this.hasCapacity(bytes)) {
					return false;
				}
			}
			this.enqueue(value, bytes);
			return true;
		}

		if (priority === 'coalescible') {
			if (!this.hasCapacity(bytes)) {
				this.removeOldestDiscardable(false);
			}
			if (!this.hasCapacity(bytes)) {
				return false;
			}
			this.enqueue(value, bytes);
			return true;
		}

		let discardedOutput = false;
		while (!this.hasCapacity(bytes)) {
			const removed = this.removeOldestDiscardable(true);
			if (removed === undefined) {
				break;
			}
			discardedOutput ||= removed === 'droppable';
		}
		if (discardedOutput) {
			await this.reportPressure(allowSealed);
		}
		if (!this.hasCapacity(bytes)) {
			this.reservePending(bytes);
			try {
				while (!this.ingressClosed(allowSealed) && !this.hasCapacity(bytes)) {
					await this.waitForCapacity();
				}
			} finally {
				this.releasePending(bytes);
			}
		}
		if (this.ingressClosed(allowSealed)) {
			return false;
		}
		this.enqueue(value, bytes);
		return true;
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.sealed = true;
		this.closed = true;
		for (const waiter of this.waiting.splice(0)) {
			waiter({ done: true, value: undefined });
		}
		for (const waiter of this.capacityWaiters.splice(0)) {
			waiter();
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: async () => {
				const queued = this.values.shift();
				if (queued !== undefined) {
					this.bufferedByteCount -= queued.bytes;
					this.notifyCapacity();
					if (
						this.values.length <= Math.floor(this.maxItems / 2)
						&& this.bufferedByteCount <= Math.floor(this.maxBytes / 2)
					) {
						this.pressureReported = false;
					}
					return { done: false, value: queued.value };
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

	private tryCoalesce(value: T): boolean | undefined {
		const queued = this.values.at(-1);
		if (queued === undefined || this.options.coalesce === undefined) {
			return undefined;
		}
		const replacement = this.options.coalesce(queued.value, value);
		if (replacement === undefined) {
			return undefined;
		}
		const bytes = this.measure(replacement);
		if (bytes > this.maxBytes || this.bufferedByteCount - queued.bytes + bytes > this.maxBytes) {
			return undefined;
		}
		this.values[this.values.length - 1] = { value: replacement, bytes };
		this.bufferedByteCount += bytes - queued.bytes;
		return true;
	}

	private enqueue(value: T, bytes: number): void {
		const waiter = this.waiting.shift();
		if (waiter !== undefined) {
			waiter({ done: false, value });
			return;
		}
		this.values.push({ value, bytes });
		this.bufferedByteCount += bytes;
	}

	private hasCapacity(bytes: number): boolean {
		return this.values.length < this.maxItems
			&& this.bufferedByteCount + bytes <= this.maxBytes;
	}

	private removeOldestDiscardable(includeOutput: boolean): AsyncEventQueuePriority | undefined {
		const index = this.values.findIndex(({ value }) => {
			const priority = this.priority(value);
			return priority === 'coalescible' || (includeOutput && priority === 'droppable');
		});
		if (index < 0) {
			return undefined;
		}
		const [removed] = this.values.splice(index, 1);
		if (removed === undefined) {
			return undefined;
		}
		this.bufferedByteCount -= removed.bytes;
		this.notifyCapacity();
		return this.priority(removed.value);
	}

	private async reportPressure(allowSealed: boolean): Promise<void> {
		if (
			this.pressureReported
			|| this.options.pressureEvent === undefined
			|| this.ingressClosed(allowSealed)
		) {
			return;
		}
		this.pressureReported = true;
		const event = this.options.pressureEvent();
		const bytes = this.measure(event);
		if (bytes > this.maxBytes) {
			throw new AsyncEventQueueCapacityError(this.maxBytes);
		}
		while (!this.hasCapacity(bytes)) {
			if (this.removeOldestDiscardable(true) !== undefined) {
				continue;
			}
			await this.waitForCapacity();
			if (this.ingressClosed(allowSealed)) {
				return;
			}
		}
		this.enqueue(event, bytes);
	}

	private waitForCapacity(): Promise<void> {
		return new Promise((resolve) => this.capacityWaiters.push(resolve));
	}

	private notifyCapacity(): void {
		for (const waiter of this.capacityWaiters.splice(0)) {
			waiter();
		}
	}

	private ingressClosed(allowSealed: boolean): boolean {
		return this.closed || (this.sealed && !allowSealed);
	}

	private reservePending(bytes: number): void {
		if (
			this.pendingItemCount + 1 > this.maxItems
			|| this.pendingByteCount + bytes > this.maxBytes
		) {
			throw new AsyncEventQueueCapacityError(this.maxBytes);
		}
		this.pendingItemCount += 1;
		this.pendingByteCount += bytes;
	}

	private releasePending(bytes: number): void {
		this.pendingItemCount -= 1;
		this.pendingByteCount -= bytes;
	}

	private measure(value: T): number {
		const bytes = this.sizeOf(value);
		if (!Number.isSafeInteger(bytes) || bytes < 0) {
			throw new TypeError('AsyncEventQueue sizeOf must return a non-negative safe integer.');
		}
		return bytes;
	}
}

export function createAgentRuntimeEventQueue(
	limits: { readonly maxItems?: number; readonly maxBytes?: number } = {},
): AsyncEventQueue<AgentRuntimeEvent> {
	return new AsyncEventQueue<AgentRuntimeEvent>({
		maxItems: limits.maxItems ?? 256,
		maxBytes: limits.maxBytes ?? 512 * 1024,
		sizeOf: agentRuntimeEventSize,
		priority: (event) => event.type === 'progress'
			? 'coalescible'
			: event.type === 'output'
				? 'droppable'
				: 'nondroppable',
		coalesce: (queued, incoming) =>
			queued.type === 'progress' && incoming.type === 'progress' ? incoming : undefined,
		truncate: truncateRuntimeEvent,
		pressureEvent: () => ({
			type: 'outputTruncated',
			message: 'Agent output was truncated while the consumer was catching up.',
		}),
	});
}

function truncateRuntimeEvent(event: AgentRuntimeEvent, maxBytes: number): AgentRuntimeEvent | undefined {
	switch (event.type) {
		case 'output':
			return fitRuntimeText(event.text, maxBytes, (text) => ({ type: 'output', text }));
		case 'progress':
			return fitRuntimeText(event.message, maxBytes, (message) => ({ type: 'progress', message }));
		case 'outputTruncated':
			return fitRuntimeText(event.message, maxBytes, (message) => ({ type: 'outputTruncated', message }));
		case 'terminal':
			return fitRuntimeText(event.summary, maxBytes, (summary) => ({ type: 'terminal', summary }));
		case 'failed':
			return fitRuntimeText(event.error.message, maxBytes, (message) => ({
				type: 'failed',
				error: new AgentRuntimeError(
					event.error.code,
					message,
					event.error.retryable,
					undefined,
					event.error.cleanupFailed,
				),
			}));
		default:
			return undefined;
	}
}

function fitRuntimeText(
	text: string,
	maxBytes: number,
	create: (text: string) => AgentRuntimeEvent,
): AgentRuntimeEvent | undefined {
	let low = 0;
	let high = text.length;
	let best: AgentRuntimeEvent | undefined;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = create(text.slice(0, middle));
		if (agentRuntimeEventSize(candidate) <= maxBytes) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function agentRuntimeEventSize(event: AgentRuntimeEvent): number {
	if (event.type === 'failed') {
		return defaultEventSize({
			type: event.type,
			error: {
				name: event.error.name,
				code: event.error.code,
				message: event.error.message,
				retryable: event.error.retryable,
				cleanupFailed: event.error.cleanupFailed,
			},
		});
	}
	return defaultEventSize(event);
}

function defaultEventSize(value: unknown): number {
	const serialized = JSON.stringify(value);
	return Buffer.byteLength(serialized === undefined ? String(value) : serialized, 'utf8');
}

function approvalFingerprint(request: AgentTaskRequest): string {
	return JSON.stringify({
		taskId: request.taskId,
		title: request.title,
		prompt: request.prompt,
		acceptanceCriteria: request.acceptanceCriteria === undefined
			? undefined
			: [...request.acceptanceCriteria],
		workspaceId: request.workspaceId,
		sourceWindowName: request.sourceWindowName,
		providerId: request.providerId,
		allowInteractiveAuthentication: request.allowInteractiveAuthentication,
		delegatedExecutionContext: request.delegatedExecutionContext,
		approvalContext: request.approvalContext,
	});
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`AsyncEventQueue ${name} must be a positive safe integer.`);
	}
	return value;
}
import type { DelegatedExecutionContext } from '../../shared/protocol';
