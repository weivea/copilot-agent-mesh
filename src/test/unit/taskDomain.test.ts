import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ACTIVE_TASK_STATUSES } from '../../../shared/protocol';
import { InvalidTaskTransitionError, MeshDomainError } from '../../domain/errors';
import {
	canonicalTaskRequestHash,
	createAcceptedTask,
	getOwnedTask,
	matchIdempotentStart,
} from '../../domain/task';
import { taskReducer } from '../../domain/taskReducer';
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

	test('allows every active state to fail or time out', () => {
		for (const state of ACTIVE_TASK_STATUSES) {
			const record = { ...createAcceptedTask(taskRequest(), AT), state };
			assert.strictEqual(taskReducer(record, {
				type: 'failed',
				at: LATER,
				code: 'TEST_FAILURE',
				message: 'Failed',
				retryable: false,
			}).state, 'failed');
			assert.strictEqual(taskReducer(record, {
				type: 'timedOut',
				at: LATER,
				message: 'Timed out',
			}).state, 'timedOut');
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
		leases.acquire(IDS.workspace, IDS.task);
		leases.acquire(IDS.workspace, IDS.task);
		assert.throws(
			() => leases.acquire(IDS.workspace, IDS.otherTask),
			(error) => error instanceof MeshDomainError && error.reason === 'WORKSPACE_BUSY',
		);
		leases.release(IDS.workspace, IDS.otherTask);
		assert.strictEqual(leases.owner(IDS.workspace), IDS.task);
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
		assert.strictEqual(leases.owner(IDS.workspace), IDS.task);
		assert.strictEqual(leases.owner(IDS.otherWorkspace), undefined);
		assert.throws(() => leases.restoreFromTaskRecords([
			{ ...createAcceptedTask(taskRequest(), AT), state: 'running' },
			{
				...createAcceptedTask(taskRequest({
					taskId: IDS.otherTask,
					delegationRequestId: IDS.otherTask,
				}), AT),
				state: 'recovering',
			},
		]));
		const terminal = {
			...createAcceptedTask(taskRequest(), AT),
			state: 'failed' as const,
		};
		leases.acquire(IDS.workspace, IDS.task);
		leases.releaseForPersistedTerminal(terminal);
		assert.strictEqual(leases.isLeased(IDS.workspace), false);
	});
});
