import {
	ACTIVE_TASK_STATUSES,
	TERMINAL_TASK_STATUSES,
	type RecoveryDescriptor,
	type TaskStatus,
} from '../../shared/protocol';
import { InvalidTaskTransitionError, MeshDomainError } from './errors';
import type { TaskRecord } from './task';
import { compactTaskEventJournal } from './taskEvents';

export type TaskDomainEvent =
	| { readonly type: 'agentStartRequested'; readonly at: string }
	| { readonly type: 'agentStarted'; readonly at: string; readonly recoveryDescriptor?: RecoveryDescriptor }
	| { readonly type: 'inputRequired'; readonly at: string; readonly inputId: string; readonly prompt: string }
	| { readonly type: 'inputAnswered'; readonly at: string; readonly inputId: string; readonly answerId: string }
	| { readonly type: 'recoveryStarted'; readonly at: string }
	| { readonly type: 'cancelRequested'; readonly at: string; readonly cancellationDeadline: string }
	| { readonly type: 'cancelConfirmed'; readonly at: string; readonly summary?: string }
	| { readonly type: 'completed'; readonly at: string; readonly summary: string }
	| { readonly type: 'failed'; readonly at: string; readonly code: string; readonly message: string; readonly retryable: boolean }
	| { readonly type: 'timedOut'; readonly at: string; readonly message: string };

const terminalStatuses = new Set<TaskStatus>(TERMINAL_TASK_STATUSES);
const activeStatuses = new Set<TaskStatus>(ACTIVE_TASK_STATUSES);

export function taskReducer(record: TaskRecord, event: TaskDomainEvent): TaskRecord {
	if (terminalStatuses.has(record.state)) {
		return record;
	}

	switch (event.type) {
		case 'agentStartRequested':
			return transition(
				requireState(record, event, ['accepted']),
				event,
				{ state: 'startingAgent' },
			);
		case 'agentStarted':
			return transition(
				requireState(record, event, ['startingAgent', 'recovering']),
				event,
				{
					state: record.state === 'recovering' && record.pendingInput !== undefined
						? 'needsInput'
						: 'running',
					recoveryDescriptor: event.recoveryDescriptor ?? record.recoveryDescriptor,
				},
			);
		case 'inputRequired':
			return transition(
				requireState(record, event, ['running']),
				event,
				{ state: 'needsInput', pendingInput: { inputId: event.inputId, prompt: event.prompt } },
			);
		case 'inputAnswered': {
			if (record.answeredInputs[event.inputId] === event.answerId) {
				return record;
			}
			if (record.pendingInput?.inputId !== event.inputId) {
				throw new MeshDomainError('INPUT_NOT_PENDING', 'The requested input is not pending.');
			}
			const answeredInputs = {
				...record.answeredInputs,
				[event.inputId]: event.answerId,
			};
			return transition(
				requireState(record, event, ['needsInput']),
				event,
				{ state: 'running', pendingInput: undefined, answeredInputs },
			);
		}
		case 'recoveryStarted':
			return transition(
				requireState(record, event, ['running', 'needsInput']),
				event,
				{ state: 'recovering' },
			);
		case 'cancelRequested':
			if (record.state === 'cancelling') {
				return record;
			}
			return transition(record, event, {
				state: 'cancelling',
				cancellationDeadline: event.cancellationDeadline,
				pendingInput: undefined,
			});
		case 'cancelConfirmed':
			return transition(
				requireState(record, event, ['cancelling']),
				event,
				{ state: 'cancelled', summary: event.summary },
			);
		case 'completed':
			return transition(
				requireState(record, event, ['running', 'needsInput']),
				event,
				{ state: 'completed', pendingInput: undefined, summary: event.summary },
			);
		case 'failed':
			assertActive(record, event);
			return transition(record, event, {
				state: 'failed',
				cancellationDeadline: undefined,
				pendingInput: undefined,
				summary: undefined,
				failure: {
					code: event.code,
					message: event.message,
					retryable: event.retryable,
				},
			});
		case 'timedOut':
			assertActive(record, event);
			return transition(record, event, {
				state: 'timedOut',
				cancellationDeadline: undefined,
				pendingInput: undefined,
				summary: undefined,
				failure: {
					code: 'TASK_TIMED_OUT',
					message: event.message,
					retryable: true,
				},
			});
	}
}

function requireState(
	record: TaskRecord,
	event: TaskDomainEvent,
	allowed: readonly TaskStatus[],
): TaskRecord {
	if (!allowed.includes(record.state)) {
		throw new InvalidTaskTransitionError(record.state, event.type);
	}
	return record;
}

function assertActive(record: TaskRecord, event: TaskDomainEvent): void {
	if (!activeStatuses.has(record.state)) {
		throw new InvalidTaskTransitionError(record.state, event.type);
	}
}

function transition(
	record: TaskRecord,
	event: TaskDomainEvent,
	changes: Partial<TaskRecord> = {},
): TaskRecord {
	return compactTaskEventJournal({
		...record,
		...changes,
		updatedAt: event.at,
		eventSeq: record.eventSeq + 1,
		events: [
			...record.events,
			{
				eventSeq: record.eventSeq + 1,
				at: event.at,
				type: event.type,
			},
		],
	}, event.at);
}
