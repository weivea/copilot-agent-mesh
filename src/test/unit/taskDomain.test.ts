import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	ACTIVE_TASK_STATUSES,
	PROTOCOL_LIMITS,
	persistedTaskRecordSchema,
	rpcSuccessResponseSchema,
	taskSnapshotSchema,
	taskSnapshotAfterEventSeqSchema,
	utf8ByteLength,
} from '../../../shared/protocol';
import { InvalidTaskTransitionError, MeshDomainError } from '../../domain/errors';
import {
	canonicalTaskRequestHash,
	createAcceptedTask,
	getOwnedTask,
	matchIdempotentStart,
	type TaskRecord,
} from '../../domain/task';
import { taskReducer } from '../../domain/taskReducer';
import {
	compactTaskEventJournal,
	taskEventJournalBytes,
} from '../../domain/taskEvents';
import { WorkspaceLeaseManager } from '../../tasks/WorkspaceLeaseManager';
import { AT, DEADLINE, IDS, LATER, taskRequest } from './fixtures';

describe('task domain', () => {
	test('runs the complete success, input, and recovery transitions', () => {
		let record = createAcceptedTask(taskRequest(), AT);
		record = taskReducer(record, { type: 'agentStartRequested', at: LATER });
		assert.strictEqual(record.state, 'startingAgent');
		record = taskReducer(record, { type: 'agentStarted', at: LATER });
		assert.strictEqual(record.state, 'running');
		record = taskReducer(record, {
			type: 'inputRequired',
			at: LATER,
			inputId: IDS.input,
			prompt: 'Proceed?',
		});

		assert.strictEqual(record.state, 'needsInput');
		record = taskReducer(record, {
			type: 'inputAnswered',
			at: LATER,
			inputId: IDS.input,
			answerId: IDS.answer,
		});
		assert.strictEqual(record.state, 'running');
		record = taskReducer(record, { type: 'recoveryStarted', at: LATER });
		assert.strictEqual(record.state, 'recovering');
		record = taskReducer(record, { type: 'agentStarted', at: LATER });
		record = taskReducer(record, { type: 'completed', at: LATER, summary: 'Done' });
		assert.strictEqual(record.state, 'completed');
		assert.strictEqual(record.eventSeq, 7);
	});

	test('preserves the recovery descriptor across a second crash', () => {
		const descriptor = {
			adapter: 'ahp',
			sessionId: 'session-1',
			conversationId: 'conversation-1',
		};
		let record: TaskRecord = {
			...createAcceptedTask(taskRequest(), AT),
			state: 'startingAgent' as const,
		};
		record = taskReducer(record, {
			type: 'agentStarted',
			at: LATER,
			recoveryDescriptor: descriptor,
		});

		record = taskReducer(record, { type: 'recoveryStarted', at: LATER });
		record = taskReducer(record, { type: 'agentStarted', at: LATER });
		assert.deepStrictEqual(record.recoveryDescriptor, descriptor);
		record = taskReducer(record, { type: 'recoveryStarted', at: LATER });
		assert.strictEqual(record.state, 'recovering');
		assert.deepStrictEqual(record.recoveryDescriptor, descriptor);
	});

	test('restores pending input after recovery and still accepts its answer', () => {
		let record: TaskRecord = {
			...createAcceptedTask(taskRequest(), AT),
			state: 'running',
		};
		record = taskReducer(record, {
			type: 'inputRequired',
			at: LATER,
			inputId: IDS.input,
			prompt: 'Choose an option.',
		});
		record = taskReducer(record, { type: 'recoveryStarted', at: LATER });
		record = taskReducer(record, { type: 'agentStarted', at: LATER });
		assert.strictEqual(record.state, 'needsInput');
		assert.strictEqual(record.pendingInput?.inputId, IDS.input);
		record = taskReducer(record, {
			type: 'inputAnswered',
			at: LATER,
			inputId: IDS.input,
			answerId: IDS.answer,
		});
		assert.strictEqual(record.state, 'running');
		assert.strictEqual(record.pendingInput, undefined);
	});

	test('trims event journals by bytes, age, and oversized-event gaps', () => {
		const largeSummary = 'x'.repeat(PROTOCOL_LIMITS.outputEventBytes);
		const events = Array.from({ length: 80 }, (_, index) => ({
			eventSeq: index + 1,
			at: AT,
			type: 'task.output',
			summary: largeSummary,
		}));
		const compacted = compactTaskEventJournal({
			...createAcceptedTask(taskRequest(), AT),
			eventSeq: events.length,
			events,
		}, LATER);
		assert.ok(taskEventJournalBytes(compacted) <= PROTOCOL_LIMITS.frameBytes);
		assert.strictEqual(compacted.eventsTruncated, true);
		assert.strictEqual(
			compacted.earliestAvailableEventSeq,
			compacted.events[0].eventSeq,
		);
		assert.strictEqual(compacted.events.at(-1)?.eventSeq, events.length);

		const aged = compactTaskEventJournal({
			...createAcceptedTask(taskRequest(), AT),
			eventSeq: 2,
			events: [
				{
					eventSeq: 1,
					at: '2026-08-24T00:59:59.000Z',
					type: 'old',
				},
				{
					eventSeq: 2,
					at: LATER,
					type: 'new',
				},
			],
		}, LATER);
		assert.deepStrictEqual(aged.events.map((event) => event.eventSeq), [2]);
		assert.strictEqual(aged.earliestAvailableEventSeq, 2);

		const oversized = compactTaskEventJournal({
			...createAcceptedTask(taskRequest(), AT),
			eventSeq: 1,
			events: [{
				eventSeq: 1,
				at: LATER,
				type: 'oversized',
				summary: 'x'.repeat(PROTOCOL_LIMITS.frameBytes),
			}],
		}, LATER);
		assert.deepStrictEqual(oversized.events, []);
		assert.strictEqual(oversized.eventsTruncated, true);
		assert.strictEqual(oversized.earliestAvailableEventSeq, 2);
	});

	test('keeps a maximal task snapshot response below the wire frame limit', () => {
		const events = Array.from({ length: 80 }, (_, index) => ({
			eventSeq: index + 1,
			at: AT,
			type: 'task.output',
			summary: 'x'.repeat(PROTOCOL_LIMITS.outputEventBytes),
		}));
		const compacted = compactTaskEventJournal({
			...createAcceptedTask(taskRequest(), AT),
			state: 'needsInput',
			eventSeq: events.length,
			events,
			pendingInput: {
				inputId: IDS.input,
				prompt: '🙂'.repeat(PROTOCOL_LIMITS.taskAnswerBytes / 4),
			},
		}, LATER);
		const {
			answeredInputs: _answeredInputs,
			recoveryDescriptor: _recoveryDescriptor,
			workspaceLeaseKey: _workspaceLeaseKey,
			...wireRecord
		} = compacted;
		const snapshot = {
			...wireRecord,
			deviceId: IDS.device,
			title: '\0'.repeat(PROTOCOL_LIMITS.taskTitleBytes),
			state: 'needsInput',
			pendingInput: {
				inputId: IDS.input,
				prompt: '\0'.repeat(PROTOCOL_LIMITS.taskAnswerBytes),
			},
		};
		assert.strictEqual(taskSnapshotSchema.safeParse(snapshot).success, true);
		assert.strictEqual(taskSnapshotSchema.safeParse({
			...snapshot,
			workspaceLeaseKey: '/must/not/reach/wire',
		}).success, false);
		const response = {
			jsonrpc: '2.0',
			id: 'x'.repeat(PROTOCOL_LIMITS.identifierBytes),
			result: snapshot,
		};
		assert.strictEqual(rpcSuccessResponseSchema.safeParse(response).success, true);
		assert.ok(
			utf8ByteLength(JSON.stringify(response)) < PROTOCOL_LIMITS.frameBytes,
		);
		assert.ok(
			taskEventJournalBytes(compacted) <= PROTOCOL_LIMITS.taskEventJournalBytes,
		);
	});

	test('validates full and afterEventSeq journal sequence invariants separately', () => {
		const record = {
			...createAcceptedTask(taskRequest(), AT),
			eventSeq: 3,
			eventsTruncated: true,
			earliestAvailableEventSeq: 2,
			events: [
				{ eventSeq: 2, at: AT, type: 'two' },
				{ eventSeq: 3, at: AT, type: 'three' },
			],
		};
		const {
			answeredInputs: _answeredInputs,
			recoveryDescriptor: _recoveryDescriptor,
			workspaceLeaseKey: _workspaceLeaseKey,
			...wireRecord
		} = record;
		const snapshot = { ...wireRecord, deviceId: IDS.device };
		assert.strictEqual(taskSnapshotSchema.safeParse(snapshot).success, true);
		assert.strictEqual(taskSnapshotSchema.safeParse({
			...snapshot,
			events: [{ eventSeq: 3, at: AT, type: 'three' }],
		}).success, false);
		assert.strictEqual(taskSnapshotSchema.safeParse({
			...snapshot,
			eventsTruncated: true,
			earliestAvailableEventSeq: 1,
			events: [
				{ eventSeq: 1, at: AT, type: 'one' },
				{ eventSeq: 2, at: AT, type: 'two' },
				{ eventSeq: 3, at: AT, type: 'three' },
			],
		}).success, false);
		assert.strictEqual(taskSnapshotAfterEventSeqSchema.safeParse({
			...snapshot,
			afterEventSeq: 2,
			eventsTruncated: false,
			events: [{ eventSeq: 3, at: AT, type: 'three' }],
		}).success, true);
		assert.strictEqual(taskSnapshotAfterEventSeqSchema.safeParse({
			...snapshot,
			afterEventSeq: 0,
			eventsTruncated: false,
		}).success, false);
	});

	test('allows every active state to fail or time out', () => {
		for (const state of ACTIVE_TASK_STATUSES) {
			const record = {
				...createAcceptedTask(taskRequest(), AT),
				state,
				...(state === 'cancelling' ? { cancellationDeadline: DEADLINE } : {}),
			};
			const failed = taskReducer(record, {
				type: 'failed',
				at: LATER,
				code: 'TEST_FAILURE',
				message: 'Failed',
				retryable: false,
			});
			const timedOut = taskReducer(record, {
				type: 'timedOut',
				at: LATER,
				message: 'Timed out',
			});
			assert.strictEqual(failed.state, 'failed');
			assert.strictEqual(timedOut.state, 'timedOut');
			assert.strictEqual(persistedTaskRecordSchema.safeParse(failed).success, true);
			assert.strictEqual(persistedTaskRecordSchema.safeParse(timedOut).success, true);
		}
	});

	test('clears pending input whenever needsInput becomes non-answerable', () => {
		const waiting: TaskRecord = {
			...createAcceptedTask(taskRequest(), AT),
			state: 'needsInput',
			pendingInput: { inputId: IDS.input, prompt: 'Pending' },
		};
		const outcomes = [
			taskReducer(waiting, {
				type: 'cancelRequested',
				at: LATER,
				cancellationDeadline: DEADLINE,
			}),
			taskReducer(waiting, {
				type: 'failed',
				at: LATER,
				code: 'FAILED',
				message: 'Failed',
				retryable: false,
			}),
			taskReducer(waiting, {
				type: 'timedOut',
				at: LATER,
				message: 'Timed out',
			}),
			taskReducer(waiting, {
				type: 'completed',
				at: LATER,
				summary: 'Completed without an answer',
			}),
		];
		for (const outcome of outcomes) {
			assert.strictEqual(outcome.pendingInput, undefined);
		}
	});

	test('keeps terminal records immutable', () => {
		const completed = taskReducer(
			{ ...createAcceptedTask(taskRequest(), AT), state: 'running' },
			{ type: 'completed', at: LATER, summary: 'Done' },
		);
		assert.strictEqual(
			taskReducer(completed, {
				type: 'failed',
				at: LATER,
				code: 'LATE_FAILURE',
				message: 'Late',
				retryable: false,
			}),
			completed,
		);
	});

	test('makes duplicate cancel and answer events idempotent', () => {
		const running = { ...createAcceptedTask(taskRequest(), AT), state: 'running' as const };
		const cancelling = taskReducer(running, {
			type: 'cancelRequested',
			at: LATER,
			cancellationDeadline: DEADLINE,
		});

		assert.strictEqual(taskReducer(cancelling, {
			type: 'cancelRequested',
			at: LATER,
			cancellationDeadline: DEADLINE,
		}), cancelling);

		const waiting = taskReducer(running, {
			type: 'inputRequired',
			at: LATER,
			inputId: IDS.input,
			prompt: 'Proceed?',
		});
		const answered = taskReducer(waiting, {
			type: 'inputAnswered',
			at: LATER,
			inputId: IDS.input,
			answerId: IDS.answer,
		});
		assert.strictEqual(taskReducer(answered, {
			type: 'inputAnswered',
			at: LATER,
			inputId: IDS.input,
			answerId: IDS.answer,
		}), answered);
	});

	test('accepts cancellation from every active state and confirms only from cancelling', () => {
		for (const state of ACTIVE_TASK_STATUSES) {
			const record = { ...createAcceptedTask(taskRequest(), AT), state };
			const cancelling = taskReducer(record, {
				type: 'cancelRequested',
				at: LATER,
				cancellationDeadline: DEADLINE,
			});
			assert.strictEqual(cancelling.state, 'cancelling');
		}
		const cancelling = {
			...createAcceptedTask(taskRequest(), AT),
			state: 'cancelling' as const,
			cancellationDeadline: DEADLINE,
		};
		const cancelled = taskReducer(cancelling, {
			type: 'cancelConfirmed',
			at: LATER,
			summary: 'Cancelled',
		});
		assert.strictEqual(cancelled.state, 'cancelled');
	});

	test('resolves cancel/completion races without a false completion', () => {
		const cancelling = taskReducer(
			{ ...createAcceptedTask(taskRequest(), AT), state: 'running' },
			{ type: 'cancelRequested', at: LATER, cancellationDeadline: DEADLINE },
		);
		assert.throws(
			() => taskReducer(cancelling, { type: 'completed', at: LATER, summary: 'Late' }),
			InvalidTaskTransitionError,
		);
		const failed = taskReducer(cancelling, {
			type: 'failed',
			at: LATER,
			code: 'TASK_CANCELLATION_UNCONFIRMED',
			message: 'Cancellation was not confirmed.',
			retryable: true,
		});
		assert.strictEqual(failed.state, 'failed');
	});

	test('does not normalize prompt text in canonical hashes', () => {
		const plain = canonicalTaskRequestHash(taskRequest({ prompt: 'line\n' }));
		const spaced = canonicalTaskRequestHash(taskRequest({ prompt: 'line \n' }));
		const normalizedNewline = canonicalTaskRequestHash(taskRequest({ prompt: 'line\r\n' }));
		assert.notStrictEqual(plain, spaced);
		assert.notStrictEqual(plain, normalizedNewline);
		assert.strictEqual(plain, canonicalTaskRequestHash(taskRequest({ prompt: 'line\n' })));
	});

	test('normalizes UUID case consistently for hashes, records, and ownership', () => {
		const upperPeer = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
		const upperTask = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
		const upperDelegation = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
		const upperWorkspace = 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD';
		const upper = taskRequest({
			peerId: upperPeer,
			taskId: upperTask,
			delegationRequestId: upperDelegation,
			workspaceId: upperWorkspace,
		});
		const lower = {
			...upper,
			peerId: upperPeer.toLowerCase(),
			taskId: upperTask.toLowerCase(),
			delegationRequestId: upperDelegation.toLowerCase(),
			workspaceId: upperWorkspace.toLowerCase(),
		};
		assert.strictEqual(canonicalTaskRequestHash(upper), canonicalTaskRequestHash(lower));
		const record = createAcceptedTask(upper, AT);
		assert.strictEqual(record.peerId, lower.peerId);
		assert.strictEqual(record.taskId, lower.taskId);
		assert.strictEqual(matchIdempotentStart([record], lower), record);
		assert.strictEqual(getOwnedTask(record, upperPeer), record);
	});

	test('enforces peer-scoped idempotency and conflict detection', () => {
		const record = createAcceptedTask(taskRequest(), AT);
		assert.strictEqual(matchIdempotentStart([record], taskRequest()), record);
		assert.throws(
			() => matchIdempotentStart([record], taskRequest({ prompt: 'different' })),
			(error) => error instanceof MeshDomainError && error.reason === 'TASK_ID_CONFLICT',
		);
		assert.strictEqual(
			matchIdempotentStart([record], taskRequest({
				peerId: IDS.otherPeer,
				taskId: IDS.otherTask,
			})),
			undefined,
		);
	});

	test('hides task ownership from other peers', () => {
		const record = createAcceptedTask(taskRequest(), AT);
		assert.strictEqual(getOwnedTask(record, IDS.peer), record);
		assert.throws(
			() => getOwnedTask(record, IDS.otherPeer),
			(error) => (
				error instanceof MeshDomainError
				&& error.reason === 'TASK_NOT_FOUND'
				&& error.message === 'Task not found.'
			),
		);
	});

	test('enforces and restores one lease per workspace', () => {
		const leases = new WorkspaceLeaseManager();
		const leaseKey = IDS.workspaceLeaseKey;
		assert.throws(
			() => leases.acquire('', IDS.peer, IDS.task),
			TypeError,
		);
		const upperPeer = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
		const upperTask = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
		leases.acquire('canonical-file-identity', upperPeer, upperTask);
		assert.deepStrictEqual(leases.owner('canonical-file-identity'), {
			peerId: upperPeer.toLowerCase(),
			taskId: upperTask.toLowerCase(),
		});
		leases.release(
			'canonical-file-identity',
			upperPeer.toLowerCase(),
			upperTask.toLowerCase(),
		);
		leases.acquire(leaseKey, IDS.peer, IDS.task);
		leases.acquire(leaseKey, IDS.peer, IDS.task);
		assert.throws(
			() => leases.acquire(leaseKey, IDS.peer, IDS.otherTask),
			(error) => error instanceof MeshDomainError && error.reason === 'WORKSPACE_BUSY',
		);
		leases.release(leaseKey, IDS.peer, IDS.otherTask);
		assert.deepStrictEqual(leases.owner(leaseKey), {
			peerId: IDS.peer,
			taskId: IDS.task,
		});
		leases.release(leaseKey, IDS.otherPeer, IDS.task);
		assert.strictEqual(leases.isLeased(leaseKey), true);
		assert.throws(
			() => leases.acquire(leaseKey, IDS.otherPeer, IDS.task),
			(error) => error instanceof MeshDomainError && error.reason === 'WORKSPACE_BUSY',
		);
		leases.restoreFromTaskRecords([
			{ ...createAcceptedTask(taskRequest(), AT), state: 'running' },
			{
				...createAcceptedTask(taskRequest({
					taskId: IDS.otherTask,
					delegationRequestId: IDS.otherTask,
					workspaceId: IDS.otherWorkspace,
				}), AT),
				state: 'completed',
			},
		]);
		assert.deepStrictEqual(leases.owner(leaseKey), {
			peerId: IDS.peer,
			taskId: IDS.task,
		});
		assert.strictEqual(leases.owner(IDS.otherWorkspace), undefined);
		assert.throws(() => leases.restoreFromTaskRecords([
			{ ...createAcceptedTask(taskRequest(), AT), state: 'running' },
			{
				...createAcceptedTask(taskRequest({
					peerId: IDS.otherPeer,
					delegationRequestId: IDS.otherTask,
				}), AT),
				state: 'recovering',
			},
		]));
		assert.deepStrictEqual(leases.owner(leaseKey), {
			peerId: IDS.peer,
			taskId: IDS.task,
		});
		const terminal = {
			...createAcceptedTask(taskRequest(), AT),
			state: 'failed' as const,
		};
		leases.acquire(leaseKey, IDS.peer, IDS.task);
		leases.releaseForPersistedTerminal(terminal);
		assert.strictEqual(leases.isLeased(leaseKey), false);
	});
});
