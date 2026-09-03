import { createHash } from 'node:crypto';

import type {
	AgentRuntimeLifecycleObservation,
	AgentRuntimeLifecycleObserver,
} from '../agentHost/AgentRuntime';
import type {
	TaskToolInvocationObservation,
	TaskToolInvocationObserver,
} from '../tools/TaskToolInvocationObserver';
import type { ToolClock, ToolDeadlineTimer } from '../tools/taskToolsCore';

const maximumObservations = 512;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const stableCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;
const knownToolNames = new Set([
	'mesh_list_workers',
	'mesh_delegate_task',
	'mesh_get_task',
	'mesh_cancel_task',
	'mesh_answer_task',
]);

export interface SafePeerToolObservation {
	readonly sequence: number;
	readonly at: string;
	readonly toolName: string;
	readonly phase: TaskToolInvocationObservation['phase'];
	readonly delegationRequestId?: string;
	readonly taskId?: string;
	readonly inputId?: string;
	readonly compactStatus?: number;
	readonly errorCode?: string;
	readonly cancellationReason?: string;
	readonly resultFields?: readonly string[];
	readonly resultBytes?: number;
	readonly resultHash?: string;
}

export interface SafePeerAhpObservation {
	readonly sequence: number;
	readonly at: string;
	readonly taskId: string;
	readonly eventType: AgentRuntimeLifecycleObservation['eventType'];
	readonly source?: 'editor' | 'standalone';
	readonly sessionHash?: string;
	readonly endpointFingerprint?: string;
}

export interface PeerDelegationRecorderSnapshot {
	readonly tools: readonly SafePeerToolObservation[];
	readonly ahp: readonly SafePeerAhpObservation[];
	readonly truncated: boolean;
}

export class PeerDelegationE2eRecorder implements
	TaskToolInvocationObserver,
	AgentRuntimeLifecycleObserver {
	private sequence = 0;
	private readonly tools: SafePeerToolObservation[] = [];
	private readonly ahp: SafePeerAhpObservation[] = [];
	private truncated = false;

	public observe(observation: TaskToolInvocationObservation): void {
		try {
			if (!knownToolNames.has(observation.toolName)) {
				return;
			}
			const input = plainRecord(observation.input);
			const result = plainRecord(observation.result);
			const serializedResult = result === undefined
				? undefined
				: JSON.stringify(result);
			this.push(this.tools, {
				sequence: this.nextSequence(),
				at: new Date().toISOString(),
				toolName: observation.toolName,
				phase: observation.phase,
				...optionalUuid('delegationRequestId', input?.delegationRequestId ?? result?.d),
				...optionalUuid('taskId', input?.taskId ?? result?.t),
				...optionalUuid('inputId', input?.inputId ?? result?.i),
				...(typeof result?.s === 'number' && Number.isSafeInteger(result.s)
					? { compactStatus: result.s }
					: {}),
				...(typeof result?.e === 'string' && stableCodePattern.test(result.e)
					? { errorCode: result.e }
					: observation.errorCode !== undefined
						&& stableCodePattern.test(observation.errorCode)
						? { errorCode: observation.errorCode }
						: {}),
				...(typeof result?.x === 'string' && /^(?:budget|peer|token)$/u.test(result.x)
					? { cancellationReason: result.x }
					: {}),
				...(serializedResult === undefined ? {} : {
					resultFields: Object.keys(result ?? {}).sort(),
					resultBytes: Buffer.byteLength(serializedResult, 'utf8'),
					resultHash: digest('tool-result', serializedResult),
				}),
			});
		} catch {
			// E2E observation must never affect a production Tool invocation.
		}
	}

	public observeLifecycle(observation: AgentRuntimeLifecycleObservation): void {
		try {
			if (!uuidPattern.test(observation.taskId)) {
				return;
			}
			const observesSession = observation.eventType === 'session/hostObserved';
			if (
				observesSession
				&& (
					observation.sessionUri.length < 1
					|| observation.sessionUri.length > 2_048
				)
			) {
				return;
			}
			this.push(this.ahp, {
				sequence: this.nextSequence(),
				at: new Date().toISOString(),
				taskId: observation.taskId,
				eventType: observation.eventType,
				...(!observesSession
					? {}
					: {
						sessionHash: digest('agent-session', observation.sessionUri).slice(0, 16),
						source: observation.source,
						...(
							observation.endpointFingerprint === undefined
							|| !/^[a-f0-9]{16}$/u.test(observation.endpointFingerprint)
								? {}
								: { endpointFingerprint: observation.endpointFingerprint }
						),
					}),
			});
		} catch {
			// E2E observation must never affect the Agent runtime.
		}
	}

	public snapshot(): PeerDelegationRecorderSnapshot {
		return {
			tools: this.tools.map((observation) => ({ ...observation })),
			ahp: this.ahp.map((observation) => ({ ...observation })),
			truncated: this.truncated,
		};
	}

	private nextSequence(): number {
		this.sequence += 1;
		return this.sequence;
	}

	private push<T>(target: T[], value: T): void {
		target.push(value);
		if (target.length > maximumObservations) {
			target.shift();
			this.truncated = true;
		}
	}
}

export function projectPeerTaskEvents<
	T extends { readonly eventSeq: number; readonly type: string },
>(
	events: readonly T[],
	limit = 256,
): { readonly events: readonly T[]; readonly truncated: boolean } {
	if (!Number.isSafeInteger(limit) || limit < 16 || limit > 256) {
		throw new RangeError('Peer task evidence event limit must be between 16 and 256.');
	}
	if (events.length <= limit) {
		return { events, truncated: false };
	}
	const collapsed = events.filter((event, index) =>
		index === 0 || event.type !== events[index - 1]!.type);
	if (collapsed.length <= limit) {
		return { events: collapsed, truncated: true };
	}
	const selected = new Set<number>([0, collapsed.length - 1]);
	for (const type of [
		'agentStarted',
		'output',
		'inputRequired',
		'inputAnswered',
		'cancelRequested',
		'cancelConfirmed',
		'completed',
		'failed',
		'timedOut',
	]) {
		const index = collapsed.findIndex((event) => event.type === type);
		if (index >= 0) {
			selected.add(index);
		}
	}
	let left = 0;
	let right = collapsed.length - 1;
	while (selected.size < limit && left <= right) {
		selected.add(left);
		left += 1;
		if (selected.size < limit) {
			selected.add(right);
			right -= 1;
		}
	}
	return {
		events: [...selected]
			.sort((first, second) => first - second)
			.map((index) => collapsed[index]!),
		truncated: true,
	};
}

export interface PeerDelegationToolClockSnapshot {
	readonly budgetOverrideMs: number;
	readonly timersCreated: number;
	readonly timersDisposed: number;
	readonly activeTimers: number;
	readonly budgetTimersCreated: number;
	readonly armedBudgetTimers: number;
}

export class PeerDelegationE2eToolClock implements ToolClock {
	private timersCreated = 0;
	private timersDisposed = 0;
	private activeTimers = 0;
	private budgetTimersCreated = 0;
	private armedBudgetTimers = 0;

	public constructor(private readonly budgetOverrideMs: number) {
		if (
			!Number.isSafeInteger(budgetOverrideMs)
			|| budgetOverrideMs < 500
			|| budgetOverrideMs > 30_000
		) {
			throw new RangeError('The peer-delegation E2E budget must be between 500 and 30000 ms.');
		}
	}

	public armNextBudgetTimer(): void {
		if (this.armedBudgetTimers !== 0) {
			throw new Error('A peer-delegation E2E budget timer is already armed.');
		}
		this.armedBudgetTimers = 1;
	}

	public createTimer(delayMs: number): ToolDeadlineTimer {
		const budgetTimer = delayMs >= 60_000 && this.armedBudgetTimers > 0;
		if (budgetTimer) {
			this.armedBudgetTimers -= 1;
		}
		const effectiveDelay = budgetTimer
			? Math.min(delayMs, this.budgetOverrideMs)
			: delayMs;
		this.timersCreated += 1;
		this.activeTimers += 1;
		if (budgetTimer) {
			this.budgetTimersCreated += 1;
		}
		let handle: NodeJS.Timeout | undefined;
		let active = true;
		const promise = new Promise<void>((resolve) => {
			handle = setTimeout(() => {
				if (!active) {
					return;
				}
				active = false;
				this.activeTimers -= 1;
				resolve();
			}, effectiveDelay);
		});
		return {
			promise,
			dispose: () => {
				if (!active) {
					return;
				}
				active = false;
				this.activeTimers -= 1;
				this.timersDisposed += 1;
				if (handle !== undefined) {
					clearTimeout(handle);
					handle = undefined;
				}
			},
		};
	}

	public snapshot(): PeerDelegationToolClockSnapshot {
		return {
			budgetOverrideMs: this.budgetOverrideMs,
			timersCreated: this.timersCreated,
			timersDisposed: this.timersDisposed,
			activeTimers: this.activeTimers,
			budgetTimersCreated: this.budgetTimersCreated,
			armedBudgetTimers: this.armedBudgetTimers,
		};
	}
}

function optionalUuid<Key extends 'delegationRequestId' | 'taskId' | 'inputId'>(
	key: Key,
	value: unknown,
): Partial<Record<Key, string>> {
	return typeof value === 'string' && uuidPattern.test(value)
		? { [key]: value } as Record<Key, string>
		: {};
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function digest(domain: string, value: string): string {
	return createHash('sha256')
		.update(`copilot-agent-mesh/${domain}/v1\0`, 'utf8')
		.update(value, 'utf8')
		.digest('hex');
}
