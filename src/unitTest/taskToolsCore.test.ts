import * as assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type {
	DelegationAcceptance,
	DelegationIntentInput,
	MeshDirectorySnapshot,
	PersistedDelegationIntent,
	TaskActionReceipt,
	TaskToolReadResult,
	TaskToolSnapshot,
} from '../../shared/toolProtocol';
import { TaskToolFacade, TaskToolFacadeError } from '../tools/taskToolFacade';
import {
	serializeToolResultToTokenBudget,
	TaskToolsCore,
	ToolCancellation,
	ToolClock,
} from '../tools/taskToolsCore';
import {
	assertMeshToolNameParity,
	getMeshColdActivationContract,
	MESH_RUNTIME_TOOL_NAMES,
	MESH_TOOL_MANIFEST_DESCRIPTORS,
	MESH_TOOL_NAMES,
} from '../tools/toolManifest';

const PEER_ID = '00000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';
const TASK_ID = '00000000-0000-4000-8000-000000000003';
const DELEGATION_ID = '00000000-0000-4000-8000-000000000004';
const INPUT_ID = '00000000-0000-4000-8000-000000000005';
const ANSWER_ID = '00000000-0000-4000-8000-000000000006';
const OTHER_TASK_ID = '00000000-0000-4000-8000-000000000007';
const DEVICE_ID = '00000000-0000-4000-8000-000000000008';
const NODE_ID = '00000000-0000-4000-8000-000000000009';
const NODE_INSTANCE_ID = '00000000-0000-4000-8000-00000000000a';
const SOURCE_NODE_ID = '00000000-0000-4000-8000-00000000000b';

suite('TaskToolsCore', () => {
	test('lists only bounded opaque Device -> Node -> Workspace metadata', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);

		const result = await core.listWorkers({});

		assert.deepStrictEqual(result, {
			status: 'ok',
			devices: [{
				deviceId: DEVICE_ID,
				peerId: PEER_ID,
				deviceName: 'worker-one',
				locality: 'remote',
				status: 'online',
				nodes: [{
					nodeId: NODE_ID,
					nodeInstanceId: NODE_INSTANCE_ID,
					label: 'Window One',
					status: 'online',
					capabilities: ['coding'],
					workspaces: [{
						workspaceId: WORKSPACE_ID,
						name: 'app',
						tags: ['typescript'],
						busy: false,
						claimStatus: 'claimed',
					}],
				}],
			}],
			truncated: false,
		});
		assert.doesNotMatch(JSON.stringify(result), /\//);
	});

	test('preparation is pure and shows full source, target, title, and prompt', () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);
		const input = delegationInput();

		const first = core.prepareDelegateInvocation(input);
		const second = core.prepareDelegateInvocation(input);

		assert.deepStrictEqual(first, second);
		assert.match(first.confirmationMessage, new RegExp(`Source: This Window \\(${SOURCE_NODE_ID}\\)`));
		assert.match(first.confirmationMessage, new RegExp(`Target node: ${NODE_ID} \\(${NODE_INSTANCE_ID}\\)`));
		assert.match(first.confirmationMessage, new RegExp(`Workspace: ${WORKSPACE_ID}`));
		assert.match(first.confirmationMessage, /Title: Fix scheduler/);
		assert.ok(first.confirmationMessage.includes(input.prompt));
		assert.equal(facade.persistCalls, 0);
		assert.equal(facade.acceptanceWaits, 0);
	});

	test('persists before waiting and returns pending after acceptance', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);

		const result = await core.delegateTask(delegationInput());

		assert.deepStrictEqual(facade.callOrder, ['persist', 'wait']);
		assert.deepStrictEqual(result, {
			status: 'pending',
			delegationRequestId: DELEGATION_ID,
			taskId: TASK_ID,
			recovered: false,
			pollTool: MESH_TOOL_NAMES.getTask,
			cancelTool: MESH_TOOL_NAMES.cancelTask,
		});
	});

	test('generates a fresh delegation identity when the caller omits one', async () => {
		const facade = new RecordingFacade();
		const generatedIds = [
			'00000000-0000-4000-8000-000000000008',
			'00000000-0000-4000-8000-000000000009',
		];
		const core = new TaskToolsCore(facade, { id: () => generatedIds.shift()! });
		const { delegationRequestId: _delegationRequestId, ...freshInput } = delegationInput();

		await core.delegateTask(freshInput);
		await core.delegateTask(freshInput);

		assert.deepStrictEqual(
			facade.persistedIntents.map(({ delegationRequestId }) => delegationRequestId),
			[
				'00000000-0000-4000-8000-000000000008',
				'00000000-0000-4000-8000-000000000009',
			],
		);
	});

	test('a cancelled acknowledgement wait retains intent and never requests remote cancellation', async () => {
		const facade = new RecordingFacade();
		facade.acceptance = new Promise(() => undefined);
		const cancellation = new ManualCancellation();
		const core = new TaskToolsCore(facade);
		const invocation = core.delegateTask(delegationInput(), cancellation);
		for (let index = 0; index < 10 && facade.acceptanceWaits === 0; index += 1) {
			await Promise.resolve();
		}

		cancellation.cancel();
		const result = await invocation;

		assert.equal(result.status, 'cancelled');
		assert.equal(result.taskId, TASK_ID);
		assert.equal(result.pollTool, MESH_TOOL_NAMES.getTask);
		assert.equal(facade.persistCalls, 1);
		assert.equal(facade.cancelCalls, 0);
		assert.equal(facade.lastAcceptanceSignal?.aborted, true);
	});

	test('an acknowledgement timeout retains IDs for poll and cancel', async () => {
		const facade = new RecordingFacade();
		facade.acceptance = new Promise(() => undefined);
		const clock = new ManualClock();
		const core = new TaskToolsCore(facade, { clock });
		const invocation = core.delegateTask(delegationInput());
		await Promise.resolve();
		await Promise.resolve();

		clock.advanceBy(15_000);
		const result = await invocation;

		assert.equal(result.status, 'timeout');
		assert.equal(result.delegationRequestId, DELEGATION_ID);
		assert.equal(result.taskId, TASK_ID);
		assert.equal(result.pollTool, MESH_TOOL_NAMES.getTask);
		assert.equal(result.cancelTool, MESH_TOOL_NAMES.cancelTask);
		assert.equal(facade.cancelCalls, 0);
	});

	test('bounds an unresolved durable persistence wait at the overall delegate deadline', async () => {
		const facade = new RecordingFacade();
		facade.persistence = new Promise(() => undefined);
		const clock = new ManualClock();
		const core = new TaskToolsCore(facade, { clock, id: () => DELEGATION_ID });
		const { delegationRequestId: _delegationRequestId, ...freshInput } = delegationInput();
		const invocation = core.delegateTask(freshInput);
		await Promise.resolve();
		await Promise.resolve();

		clock.advanceBy(15_000);
		const result = await invocation;

		assert.deepStrictEqual(result, {
			status: 'pending',
			phase: 'persisting',
			delegationRequestId: DELEGATION_ID,
			waitStatus: 'timeout',
			reconciliationPending: true,
			retrySameIntent: true,
			retryTool: MESH_TOOL_NAMES.delegateTask,
		});
		assert.equal(facade.acceptanceWaits, 0);
		assert.equal(facade.persistedIntents[0]?.delegationRequestId, DELEGATION_ID);
		assert.equal(clock.activeTimers, 0);
	});

	test('cancels only the caller wait while durable persistence continues', async () => {
		const facade = new RecordingFacade();
		facade.persistence = new Promise(() => undefined);
		const clock = new ManualClock();
		const cancellation = new ManualCancellation();
		const core = new TaskToolsCore(facade, { clock });
		const invocation = core.delegateTask(delegationInput(), cancellation);
		await Promise.resolve();
		await Promise.resolve();

		cancellation.cancel();
		const result = await invocation;

		assert.equal(result.status, 'pending');
		assert.equal(result.phase, 'persisting');
		assert.equal(result.waitStatus, 'cancelled');
		assert.equal(result.reconciliationPending, true);
		assert.equal(facade.acceptanceWaits, 0);
		assert.equal(clock.activeTimers, 0);
	});

	test('recovers the same durable IDs when persistence resolves after caller timeout', async () => {
		const facade = new RecordingFacade();
		const persistence = new Deferred<PersistedDelegationIntent>();
		facade.persistence = persistence.promise;
		const clock = new ManualClock();
		const core = new TaskToolsCore(facade, { clock });
		const firstInvocation = core.delegateTask(delegationInput());
		await Promise.resolve();
		await Promise.resolve();
		clock.advanceBy(15_000);
		const first = await firstInvocation;

		persistence.resolve({
			delegationRequestId: DELEGATION_ID,
			taskId: TASK_ID,
			recovered: true,
		});
		await Promise.resolve();
		await Promise.resolve();
		const retry = await core.delegateTask(delegationInput());

		assert.equal(first.status, 'pending');
		assert.equal(retry.status, 'pending');
		assert.equal(retry.delegationRequestId, DELEGATION_ID);
		assert.equal(retry.taskId, TASK_ID);
		assert.equal(retry.recovered, true);
		assert.equal(facade.persistCalls, 2);
		assert.equal(facade.acceptanceWaits, 1);
	});

	test('an explicit ACK retry relies on durable Facade recovery and keeps the same IDs', async () => {
		const facade = new RecordingFacade();
		facade.persisted = {
			delegationRequestId: DELEGATION_ID,
			taskId: TASK_ID,
			recovered: true,
		};
		const core = new TaskToolsCore(facade);

		const first = await core.delegateTask(delegationInput());
		const retry = await core.delegateTask(delegationInput());

		assert.equal(facade.persistCalls, 2);
		assert.equal(first.taskId, TASK_ID);
		assert.equal(retry.taskId, TASK_ID);
		assert.equal(retry.recovered, true);
	});

	test('gets a bounded snapshot with event-gap and truncation metadata', async () => {
		const facade = new RecordingFacade();
		facade.taskRead = {
			...facade.taskRead,
			snapshot: {
				...facade.taskRead.snapshot,
				summary: 'x'.repeat(8_000),
			},
			events: Array.from({ length: 10 }, (_, index) => ({
				sequence: index + 4,
				type: 'progress',
				at: '2026-08-25T00:00:00.000Z',
				summary: `event-${index}-${'y'.repeat(200)}`,
			})),
			eventCursor: 13,
			eventGap: { expectedFrom: 1, availableFrom: 4 },
			truncated: true,
		};
		const core = new TaskToolsCore(facade, { outputByteLimit: 1_200 });

		const result = await core.getTask({
			taskId: TASK_ID,
			afterEventSequence: 0,
			maxEvents: 10,
		});
		const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');

		assert.equal(result.status, 'ok');
		assert.equal(result.truncated, true);
		assert.ok(bytes <= 1_200);
		const events = result.events as Array<Record<string, unknown>>;
		assert.ok(events.length < 10);
		assert.equal((result.eventGap as Record<string, unknown>).expectedFrom, 1);
		assert.equal(
			(result.eventGap as Record<string, unknown>).availableFrom,
			events[0]?.sequence ?? 14,
		);
	});

	test('rejects inconsistent task event ordering, cursors, and gaps', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);
		const baseEvent = {
			type: 'progress',
			at: '2026-08-25T00:00:00.000Z',
			summary: 'Progress.',
		};
		const cases: readonly TaskToolReadResult[] = [
			{
				...facade.taskRead,
				eventCursor: 6,
				events: [
					{ ...baseEvent, sequence: 6 },
					{ ...baseEvent, sequence: 6 },
				],
			},
			{
				...facade.taskRead,
				eventCursor: 7,
				events: [
					{ ...baseEvent, sequence: 6 },
					{ ...baseEvent, sequence: 8 },
				],
				truncated: true,
			},
			{
				...facade.taskRead,
				eventCursor: 8,
				events: [{ ...baseEvent, sequence: 8 }],
				truncated: true,
			},
			{
				...facade.taskRead,
				eventCursor: 7,
				events: [{ ...baseEvent, sequence: 6 }],
				truncated: true,
			},
			{
				...facade.taskRead,
				eventCursor: 6,
				events: [],
				truncated: true,
			},
			{
				...facade.taskRead,
				eventCursor: 5,
				events: [{ ...baseEvent, sequence: 6 }],
			},
			{
				...facade.taskRead,
				eventCursor: 4,
				events: [],
			},
			{
				...facade.taskRead,
				eventCursor: 7,
				events: [{ ...baseEvent, sequence: 7 }],
				eventGap: { expectedFrom: 7, availableFrom: 7 },
			},
			{
				...facade.taskRead,
				eventCursor: 8,
				events: [{ ...baseEvent, sequence: 8 }],
				eventGap: { expectedFrom: 5, availableFrom: 8 },
			},
			{
				...facade.taskRead,
				eventCursor: 8,
				events: [{ ...baseEvent, sequence: 8 }],
				eventGap: { expectedFrom: 6, availableFrom: 8 },
				truncated: false,
			},
		];

		for (const taskRead of cases) {
			facade.taskRead = taskRead;
			const result = await core.getTask({
				taskId: TASK_ID,
				afterEventSequence: 5,
				maxEvents: 10,
			});
			assert.equal(result.status, 'error');
			assert.equal((result.error as Record<string, unknown>).code, 'OUTPUT_INVALID');
		}
	});

	test('keeps an empty truncated event window at the requested cursor with an explicit gap', async () => {
		const facade = new RecordingFacade();
		facade.taskRead = {
			...facade.taskRead,
			eventCursor: 5,
			events: [],
			eventGap: { expectedFrom: 6, availableFrom: 9 },
			truncated: true,
		};
		const result = await new TaskToolsCore(facade).getTask({
			taskId: TASK_ID,
			afterEventSequence: 5,
		});

		assert.equal(result.status, 'ok');
		assert.equal(result.eventCursor, 5);
		assert.deepStrictEqual(result.eventGap, { expectedFrom: 6, availableFrom: 9 });
	});

	test('progressively bounds maximum pending input while preserving the answer contract', async () => {
		const facade = new RecordingFacade();
		facade.taskRead = {
			snapshot: {
				taskId: TASK_ID,
				status: 'needsInput',
				title: 'Fix scheduler',
				updatedAt: '2026-08-25T00:00:00.000Z',
				validation: {
					status: 'failed',
					summary: 'v'.repeat(16 * 1024),
				},
				pendingInput: {
					inputId: INPUT_ID,
					prompt: 'p'.repeat(16 * 1024),
					choices: Array.from({ length: 32 }, (_, index) => `${index}-${'c'.repeat(4_090)}`),
				},
			},
			eventCursor: 0,
			events: [],
			truncated: false,
		};
		const core = new TaskToolsCore(facade, { outputByteLimit: 1_024 });

		const result = await core.getTask({ taskId: TASK_ID });
		const snapshot = result.snapshot as Record<string, unknown>;
		const pendingInput = snapshot.pendingInput as Record<string, unknown>;
		const validation = snapshot.validation as Record<string, unknown>;

		assert.equal(result.status, 'ok');
		assert.equal(result.truncated, true);
		assert.equal(snapshot.taskId, TASK_ID);
		assert.equal(pendingInput.inputId, INPUT_ID);
		assert.equal(result.answerTool, MESH_TOOL_NAMES.answerTask);
		assert.equal(validation.status, 'failed');
		assert.ok(typeof pendingInput.prompt === 'string' && pendingInput.prompt.length > 0);
		assert.ok(
			pendingInput.choices === undefined
			|| (pendingInput.choices as readonly unknown[]).length < 32,
		);
		assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 1_024);
	});

	test('preserves maximum-length task and input IDs at the minimum output budget', async () => {
		const facade = new RecordingFacade();
		const taskId = TASK_ID;
		const inputId = INPUT_ID;
		facade.taskRead = {
			snapshot: {
				taskId,
				status: 'needsInput',
				title: 'n'.repeat(256),
				updatedAt: '2026-08-25T00:00:00.000Z',
				phase: 'p'.repeat(256),
				summary: 's'.repeat(16 * 1024),
				validation: {
					status: 'failed',
					summary: 'v'.repeat(16 * 1024),
				},
				artifacts: Array.from({ length: 32 }, (_, index) => ({
					artifactId: uuidFromIndex(index + 100),
					label: 'a'.repeat(512),
				})),
				pendingInput: {
					inputId,
					prompt: 'q'.repeat(16 * 1024),
					choices: Array.from({ length: 32 }, () => 'c'.repeat(4 * 1024)),
				},
			},
			eventCursor: 0,
			events: [],
			truncated: false,
		};
		const core = new TaskToolsCore(facade, { outputByteLimit: 1_024 });

		const result = await core.getTask({ taskId });
		const snapshot = result.snapshot as Record<string, unknown>;
		const pendingInput = snapshot.pendingInput as Record<string, unknown>;

		assert.equal(result.status, 'ok');
		assert.equal(result.truncated, true);
		assert.equal(snapshot.taskId, taskId);
		assert.equal(pendingInput.inputId, inputId);
		assert.equal(result.answerTool, MESH_TOOL_NAMES.answerTask);
		assert.ok(typeof pendingInput.prompt === 'string' && pendingInput.prompt.length > 0);
		assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 1_024);
	});

	test('cancel and answer use owner-scoped Facade methods', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);

		const cancelled = await core.cancelTask({ taskId: TASK_ID });
		const answered = await core.answerTask({
			taskId: TASK_ID,
			inputId: INPUT_ID,
			answerId: ANSWER_ID,
			answer: 'Proceed',
		});

		assert.deepStrictEqual(cancelled, {
			status: 'ok',
			taskId: TASK_ID,
			taskStatus: 'cancelled',
		});
		assert.deepStrictEqual(answered, {
			status: 'ok',
			taskId: TASK_ID,
			taskStatus: 'running',
		});
		assert.equal(facade.cancelCalls, 1);
		assert.equal(facade.answerCalls, 1);
	});

	test('rejects get, cancel, and answer responses for a different task', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);
		facade.taskRead = {
			...facade.taskRead,
			snapshot: { ...facade.taskRead.snapshot, taskId: OTHER_TASK_ID },
		};
		facade.responseTaskId = OTHER_TASK_ID;

		const read = await core.getTask({ taskId: TASK_ID });
		const cancel = await core.cancelTask({ taskId: TASK_ID });
		const answer = await core.answerTask({
			taskId: TASK_ID,
			inputId: INPUT_ID,
			answerId: ANSWER_ID,
			answer: 'Proceed',
		});

		for (const result of [read, cancel, answer]) {
			assert.equal(result.status, 'error');
			assert.equal((result.error as Record<string, unknown>).code, 'OUTPUT_INVALID');
		}
	});

	test('accepts recovering and cancelling production task states', async () => {
		const facade = new RecordingFacade();
		facade.taskRead = {
			...facade.taskRead,
			snapshot: {
				...facade.taskRead.snapshot,
				status: 'recovering',
				pendingInput: {
					inputId: INPUT_ID,
					prompt: 'Recovery is waiting for a previously requested choice.',
				},
			},
		};
		facade.cancelStatus = 'cancelling';
		const core = new TaskToolsCore(facade);

		const read = await core.getTask({ taskId: TASK_ID });
		const cancel = await core.cancelTask({ taskId: TASK_ID });

		assert.equal((read.snapshot as Record<string, unknown>).status, 'recovering');
		assert.equal(
			((read.snapshot as Record<string, unknown>).pendingInput as Record<string, unknown>).inputId,
			INPUT_ID,
		);
		assert.equal(read.answerTool, undefined);
		assert.equal(cancel.taskStatus, 'cancelling');
	});

	test('rejects snapshots whose pending input contradicts task status', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);
		const terminalFailure = {
			code: 'TASK_EXECUTION_FAILED',
			message: 'The task did not finish.',
			retryable: false,
		};
		facade.taskRead = {
			...facade.taskRead,
			snapshot: {
				...facade.taskRead.snapshot,
				status: 'needsInput',
			},
		};
		const missing = await core.getTask({ taskId: TASK_ID });

		assert.equal(missing.status, 'error');
		assert.equal((missing.error as Record<string, unknown>).code, 'OUTPUT_INVALID');

		for (const status of [
			'accepted',
			'startingAgent',
			'running',
			'cancelling',
			'completed',
			'failed',
			'cancelled',
			'timedOut',
		] as const) {
			facade.taskRead = {
				...facade.taskRead,
				snapshot: {
					...facade.taskRead.snapshot,
					status,
					pendingInput: {
						inputId: INPUT_ID,
						prompt: 'Contradictory input.',
					},
					...((status === 'failed' || status === 'timedOut')
						? { failure: terminalFailure }
						: {}),
				},
			};
			const contradictory = await core.getTask({ taskId: TASK_ID });
			assert.equal(contradictory.status, 'error', status);
			assert.equal(
				(contradictory.error as Record<string, unknown>).code,
				'OUTPUT_INVALID',
				status,
			);
			assert.equal(contradictory.answerTool, undefined, status);
		}
	});

	test('keeps durable IDs when acceptance fails after persistence', async () => {
		const facade = new RecordingFacade();
		facade.acceptance = Promise.reject(new TaskToolFacadeError('TUNNEL_UNAVAILABLE', true));
		const core = new TaskToolsCore(facade);

		const result = await core.delegateTask(delegationInput());

		assert.equal(result.status, 'error');
		assert.equal(result.delegationRequestId, DELEGATION_ID);
		assert.equal(result.taskId, TASK_ID);
		assert.equal(result.pollTool, MESH_TOOL_NAMES.getTask);
		assert.equal(result.cancelTool, MESH_TOOL_NAMES.cancelTask);
		assert.equal((result.error as Record<string, unknown>).code, 'TUNNEL_UNAVAILABLE');
	});

	test('rejects unknown properties and UTF-8 byte oversize before side effects', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);

		const unknown = await core.delegateTask({ ...delegationInput(), branch: 'not-allowed' });
		const oversized = await core.delegateTask({
			...delegationInput(),
			title: 'é'.repeat(129),
		});
		const oversizedAnswer = await core.answerTask({
			taskId: TASK_ID,
			inputId: INPUT_ID,
			answerId: ANSWER_ID,
			answer: '界'.repeat(11_000),
		});

		assert.equal(unknown.status, 'error');
		assert.equal(oversized.status, 'error');
		assert.equal(oversizedAnswer.status, 'error');
		assert.equal(facade.persistCalls, 0);
		assert.equal(facade.answerCalls, 0);
	});

	test('requires every explicit target ID and never falls back from peer or workspace', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);
		const complete = delegationInput();
		const invalidInputs: unknown[] = [
			{
				peerId: PEER_ID,
				workspaceId: WORKSPACE_ID,
				title: complete.title,
				prompt: complete.prompt,
			},
			...(['deviceId', 'nodeId', 'nodeInstanceId', 'workspaceId'] as const).map((key) => {
				const copy = { ...complete } as Record<string, unknown>;
				delete copy[key];
				return copy;
			}),
		];

		for (const input of invalidInputs) {
			const result = await core.delegateTask(input);
			assert.equal(result.status, 'error');
			assert.equal((result.error as Record<string, unknown>).code, 'INVALID_INPUT');
		}
		assert.equal(facade.persistCalls, 0);
	});

	test('rejects non-canonical and control-character identifiers', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);
		const uppercase = await core.getTask({
			taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(),
		});
		const controlled = await core.delegateTask({
			...delegationInput(),
			peerId: `${PEER_ID}\n`,
		});

		assert.equal(uppercase.status, 'error');
		assert.equal(controlled.status, 'error');
		assert.equal(facade.persistCalls, 0);
	});

	test('maps stable and unknown failures to safe text without leaking details', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);
		facade.listError = new TaskToolFacadeError('RATE_LIMITED', true);

		const stable = await core.listWorkers({});
		facade.listError = new Error('secret token at /Users/private/workspace');
		const unknown = await core.listWorkers({});
		const serialized = JSON.stringify(unknown);

		assert.equal((stable.error as Record<string, unknown>).code, 'RATE_LIMITED');
		assert.equal((stable.error as Record<string, unknown>).retryable, true);
		assert.equal((unknown.error as Record<string, unknown>).code, 'INTERNAL_ERROR');
		assert.doesNotMatch(serialized, /secret|token|Users|workspace/);
	});

	test('requires Foundation failure details only for failed and timedOut snapshots', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);
		const failure = {
			code: 'TASK_EXECUTION_FAILED',
			message: 'The remote coding agent exited unexpectedly.',
			retryable: true,
		};

		for (const status of ['failed', 'timedOut'] as const) {
			facade.taskRead = {
				...facade.taskRead,
				snapshot: { ...facade.taskRead.snapshot, status, failure },
			};
			const result = await core.getTask({ taskId: TASK_ID });
			assert.deepStrictEqual((result.snapshot as Record<string, unknown>).failure, failure);
		}

		const invalidSnapshots: readonly TaskToolSnapshot[] = [
			{ ...facade.taskRead.snapshot, status: 'running', failure },
			{ ...facade.taskRead.snapshot, status: 'failed', failure: undefined },
			{ ...facade.taskRead.snapshot, status: 'timedOut', failure: undefined },
			{ ...facade.taskRead.snapshot, status: 'failed', failure: { ...failure, code: 'E'.repeat(129) } },
			{ ...facade.taskRead.snapshot, status: 'failed', failure: { ...failure, message: 'x'.repeat(2_049) } },
		];
		for (const snapshot of invalidSnapshots) {
			facade.taskRead = { ...facade.taskRead, snapshot };
			const result = await core.getTask({ taskId: TASK_ID });
			assert.equal(result.status, 'error');
			assert.equal((result.error as Record<string, unknown>).code, 'OUTPUT_INVALID');
		}
	});

	test('preserves task failure code and retryability during byte and token contraction', async () => {
		const facade = new RecordingFacade();
		const failure = {
			code: 'E'.repeat(128),
			message: '🙂'.repeat(512),
			retryable: true,
		};
		facade.taskRead = {
			...facade.taskRead,
			snapshot: {
				...facade.taskRead.snapshot,
				status: 'failed',
				summary: 's'.repeat(16 * 1024),
				failure,
			},
		};
		const result = await new TaskToolsCore(facade, { outputByteLimit: 1_024 }).getTask({ taskId: TASK_ID });
		const byteFailure = ((result.snapshot as Record<string, unknown>).failure as Record<string, unknown>);
		const serialized = await serializeToolResultToTokenBudget(
			result,
			400,
			async (text) => text.length,
		);
		const tokenFailure = (((JSON.parse(serialized) as Record<string, unknown>).snapshot as Record<string, unknown>)
			.failure as Record<string, unknown>);

		assert.equal(byteFailure.code, failure.code);
		assert.equal(byteFailure.retryable, true);
		assert.equal(tokenFailure.code, failure.code);
		assert.equal(tokenFailure.retryable, true);
		assert.deepStrictEqual(result.events, []);
		assert.equal(result.eventCursor, 0);
		assert.deepStrictEqual(result.eventGap, { expectedFrom: 1, availableFrom: 2 });
		const tokenResult = JSON.parse(serialized) as Record<string, unknown>;
		assert.deepStrictEqual(tokenResult.events, []);
		assert.equal(tokenResult.eventCursor, 0);
		assert.deepStrictEqual(tokenResult.eventGap, { expectedFrom: 1, availableFrom: 2 });
		assert.equal(
			Buffer.from(String(byteFailure.message), 'utf8').toString('utf8'),
			byteFailure.message,
		);
		assert.equal(
			Buffer.from(String(tokenFailure.message), 'utf8').toString('utf8'),
			tokenFailure.message,
		);
	});

	test('rejects malformed Facade output instead of forwarding it', async () => {
		const facade = new RecordingFacade();
		const deviceWithPath = {
			deviceId: DEVICE_ID,
			peerId: PEER_ID,
			deviceName: 'worker',
			locality: 'remote' as const,
			status: 'online' as const,
			nodes: [],
			nodesTruncated: false,
			totalNodes: 0,
			localPath: '/private/path',
		};
		facade.workers = {
			devices: [deviceWithPath],
			truncated: false,
		};
		const core = new TaskToolsCore(facade);

		const result = await core.listWorkers({});

		assert.equal(result.status, 'error');
		assert.equal((result.error as Record<string, unknown>).code, 'OUTPUT_INVALID');
		assert.doesNotMatch(JSON.stringify(result), /private|path/);
	});

	test('bounds and token-contracts nested device hierarchy without flattening it', async () => {
		const facade = new RecordingFacade();
		facade.workers = {
			devices: [{
				...facade.workers.devices[0]!,
				nodes: [{
					...facade.workers.devices[0]!.nodes[0]!,
					workspaces: Array.from({ length: 20 }, (_, index) => ({
						workspaceId: uuidFromIndex(index + 500),
						name: `workspace-${index}-${'n'.repeat(100)}`,
						tags: Array.from({ length: 20 }, () => 't'.repeat(100)),
						busy: false,
						claimStatus: 'claimed' as const,
					})),
				}],
			}],
			truncated: false,
		};
		const result = await new TaskToolsCore(facade, {
			outputByteLimit: 1_024,
		}).listWorkers({});
		const devices = result.devices as Array<Record<string, unknown>>;

		assert.equal(result.status, 'ok');
		assert.equal(result.truncated, true);
		assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 1_024);
		assert.equal(devices[0]?.deviceId, DEVICE_ID);
		assert.ok(Array.isArray(devices[0]?.nodes));

		const serialized = await serializeToolResultToTokenBudget(
			result,
			500,
			async (text) => text.length,
		);
		const contracted = JSON.parse(serialized) as Record<string, unknown>;
		assert.equal(contracted.truncated, true);
		assert.ok(Array.isArray(contracted.devices));
		assert.ok(serialized.length <= 500);
	});

	test('uses an exact tokenizer budget and truncates task events', async () => {
		const result = {
			status: 'ok',
			events: Array.from({ length: 8 }, (_, index) => ({
				sequence: index + 1,
				summary: `event-${index}-${'x'.repeat(80)}`,
			})),
			eventCursor: 8,
			truncated: false,
		};
		const countTokens = async (text: string): Promise<number> => text.length;

		const serialized = await serializeToolResultToTokenBudget(result, 220, countTokens);
		const fitted = JSON.parse(serialized) as Record<string, unknown>;

		assert.equal(fitted.status, 'ok');
		assert.equal(fitted.truncated, true);
		assert.ok((fitted.events as readonly unknown[]).length < result.events.length);
		assert.equal((fitted.eventGap as Record<string, unknown>).expectedFrom, 1);
		const fittedEvents = fitted.events as Array<Record<string, unknown>>;
		assert.equal(
			fitted.eventCursor,
			fittedEvents.at(-1)?.sequence
				?? ((fitted.eventGap as Record<string, number>).expectedFrom - 1),
		);
		assert.equal(
			(fitted.eventGap as Record<string, unknown>).availableFrom,
			fittedEvents[0]?.sequence ?? result.events.length + 1,
		);
		assert.ok(await countTokens(serialized) <= 220);
	});

	test('returns no over-budget fallback for zero, one, and exact-boundary budgets', async () => {
		const result = { status: 'ok', taskId: TASK_ID };
		const expected = JSON.stringify(result);
		const countTokens = async (text: string): Promise<number> => text.length;

		const zero = await serializeToolResultToTokenBudget(result, 0, countTokens);
		const one = await serializeToolResultToTokenBudget(result, 1, countTokens);
		const boundary = await serializeToolResultToTokenBudget(result, expected.length, countTokens);

		assert.equal(zero, '');
		assert.equal(one, '');
		assert.equal(boundary, expected);
		assert.ok(await countTokens(zero) <= 0);
		assert.ok(await countTokens(one) <= 1);
		assert.equal(await countTokens(boundary), expected.length);
	});

	test('preserves delegation IDs and retry semantics at a 100-character budget', async () => {
		const result = {
			status: 'pending',
			delegationRequestId: DELEGATION_ID,
			taskId: TASK_ID,
			recovered: true,
			pollTool: MESH_TOOL_NAMES.getTask,
			cancelTool: MESH_TOOL_NAMES.cancelTask,
		};
		const countCharacters = async (text: string): Promise<number> => text.length;

		const serialized = await serializeToolResultToTokenBudget(result, 100, countCharacters);
		const compact = JSON.parse(serialized) as Record<string, unknown>;
		const tooSmall = await serializeToolResultToTokenBudget(
			result,
			serialized.length - 1,
			countCharacters,
		);

		assert.ok(serialized.length <= 100);
		assert.deepStrictEqual(compact, {
			s: 0,
			t: TASK_ID,
			d: DELEGATION_ID,
		});
		assert.equal(tooSmall, '');
	});

	test('preserves conflict error semantics in a 200-character compact result', async () => {
		const facade = new RecordingFacade();
		facade.acceptance = Promise.reject(new TaskToolFacadeError('TASK_ID_CONFLICT'));
		const result = await new TaskToolsCore(facade).delegateTask(delegationInput());
		const countCharacters = async (text: string): Promise<number> => text.length;

		const serialized = await serializeToolResultToTokenBudget(result, 200, countCharacters);
		const compact = JSON.parse(serialized) as Record<string, unknown>;

		assert.ok(serialized.length <= 200);
		assert.deepStrictEqual(compact, {
			s: 2,
			t: TASK_ID,
			d: DELEGATION_ID,
			e: 'TASK_ID_CONFLICT',
			r: 0,
		});
	});

	test('distinguishes reconciliation waits from accepted pending at 100 characters', async () => {
		const result = {
			status: 'timeout',
			delegationRequestId: DELEGATION_ID,
			taskId: TASK_ID,
			recovered: false,
			pollTool: MESH_TOOL_NAMES.getTask,
			cancelTool: MESH_TOOL_NAMES.cancelTask,
			error: {
				code: 'TIMEOUT',
				message: 'The caller wait ended.',
				retryable: true,
			},
		};
		const countCharacters = async (text: string): Promise<number> => text.length;

		const serialized = await serializeToolResultToTokenBudget(result, 100, countCharacters);

		assert.deepStrictEqual(JSON.parse(serialized), {
			s: 1,
			t: TASK_ID,
			d: DELEGATION_ID,
			r: 1,
		});
		assert.ok(serialized.length <= 100);
	});

	test('preserves pre-ID persistence reconciliation at a 100-character budget', async () => {
		const facade = new RecordingFacade();
		facade.persistence = new Promise(() => undefined);
		const clock = new ManualClock();
		const invocation = new TaskToolsCore(facade, { clock }).delegateTask(delegationInput());
		await Promise.resolve();
		await Promise.resolve();
		clock.advanceBy(15_000);
		const result = await invocation;
		const countCharacters = async (text: string): Promise<number> => text.length;

		const serialized = await serializeToolResultToTokenBudget(result, 100, countCharacters);

		assert.deepStrictEqual(JSON.parse(serialized), { s: 3, d: DELEGATION_ID, r: 1 });
		assert.ok(serialized.length <= 100);
	});

	test('preserves the minimal needsInput contract at a 300-character token budget', async () => {
		const facade = new RecordingFacade();
		const taskId = TASK_ID;
		const inputId = INPUT_ID;
		facade.taskRead = {
			snapshot: {
				taskId,
				status: 'needsInput',
				title: 'n'.repeat(256),
				updatedAt: '2026-08-25T00:00:00.000Z',
				phase: 'p'.repeat(256),
				validation: { status: 'failed', summary: 'v'.repeat(16 * 1024) },
				pendingInput: {
					inputId,
					prompt: 'q'.repeat(16 * 1024),
					choices: Array.from({ length: 32 }, () => 'c'.repeat(4 * 1024)),
				},
			},
			eventCursor: 0,
			events: [],
			truncated: false,
		};
		const coreResult = await new TaskToolsCore(facade).getTask({ taskId });
		const countCharacters = async (text: string): Promise<number> => text.length;

		const atThreeHundred = await serializeToolResultToTokenBudget(
			coreResult,
			300,
			countCharacters,
		);
		const parsed = JSON.parse(atThreeHundred) as Record<string, unknown>;
		const snapshot = parsed.snapshot as Record<string, unknown>;
		const pendingInput = snapshot.pendingInput as Record<string, unknown>;
		const exactBoundary = await serializeToolResultToTokenBudget(
			coreResult,
			atThreeHundred.length,
			countCharacters,
		);
		const belowBoundary = await serializeToolResultToTokenBudget(
			coreResult,
			atThreeHundred.length - 1,
			countCharacters,
		);

		assert.ok(atThreeHundred.length <= 300);
		assert.equal(parsed.status, 'ok');
		assert.equal(snapshot.taskId, taskId);
		assert.equal(snapshot.status, 'needsInput');
		assert.equal(pendingInput.inputId, inputId);
		assert.equal(pendingInput.prompt, 'q');
		assert.equal(parsed.answerTool, MESH_TOOL_NAMES.answerTask);
		assert.equal(parsed.truncated, true);
		assert.deepStrictEqual(parsed.events, []);
		assert.equal(parsed.eventCursor, 0);
		assert.equal(exactBoundary, atThreeHundred);
		assert.ok(belowBoundary.length <= atThreeHundred.length - 1);
	});

	test('disposes deadline timers after success, failure, cancellation, and concurrent calls', async () => {
		const clock = new ManualClock();
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade, { clock });

		await Promise.all(Array.from({ length: 20 }, () => core.listWorkers({})));
		facade.listError = new TaskToolFacadeError('RATE_LIMITED', true);
		await core.listWorkers({});
		facade.listError = undefined;
		facade.acceptance = new Promise(() => undefined);
		const cancellation = new ManualCancellation();
		const cancelled = core.delegateTask(delegationInput(), cancellation);
		await Promise.resolve();
		await Promise.resolve();
		cancellation.cancel();
		await cancelled;

		assert.equal(clock.activeTimers, 0);
		assert.equal(clock.createdTimers, clock.disposedTimers);
	});
});

suite('Mesh tool manifest contract', () => {
	test('exports five manifest descriptors with runtime name parity', () => {
		const manifestNames = MESH_TOOL_MANIFEST_DESCRIPTORS.map(({ name }) => name);

		assert.equal(manifestNames.length, 5);
		assert.doesNotThrow(() => assertMeshToolNameParity(manifestNames, MESH_RUNTIME_TOOL_NAMES));
		for (const descriptor of MESH_TOOL_MANIFEST_DESCRIPTORS) {
			assert.equal(descriptor.inputSchema.additionalProperties, false);
		}
		const delegateDescriptor = MESH_TOOL_MANIFEST_DESCRIPTORS.find(
			({ name }) => name === MESH_TOOL_NAMES.delegateTask,
		);
		assert.ok(delegateDescriptor);
		assert.match(delegateDescriptor.modelDescription, /s state/);
		assert.match(delegateDescriptor.modelDescription, /retry the exact same intent/);
		const delegateProperties = delegateDescriptor.inputSchema.properties as Record<string, unknown>;
		assert.ok(delegateProperties.delegationRequestId);
		for (const target of ['deviceId', 'nodeId', 'nodeInstanceId', 'workspaceId']) {
			assert.ok(delegateProperties[target]);
		}
		const delegateRequired = delegateDescriptor.inputSchema.required;
		assert.ok(!Array.isArray(delegateRequired)
			|| !delegateRequired.includes('delegationRequestId'));
		assert.ok(Array.isArray(delegateRequired));
		for (const target of ['deviceId', 'nodeId', 'nodeInstanceId', 'workspaceId']) {
			assert.ok(delegateRequired.includes(target));
		}
		assert.ok(!delegateRequired.includes('peerId'));
		const getDescriptor = MESH_TOOL_MANIFEST_DESCRIPTORS.find(
			({ name }) => name === MESH_TOOL_NAMES.getTask,
		);
		assert.ok(getDescriptor);
		assert.match(getDescriptor.modelDescription, /only needsInput snapshots expose mesh_answer_task/);
		assert.match(getDescriptor.modelDescription, /Failed and timedOut snapshots include safe failure/);
		assert.match(getDescriptor.modelDescription, /eventGap identifies every omitted leading event/);
	});

	test('exports the cold implicit activation contract for every tool', () => {
		const contract = getMeshColdActivationContract();

		assert.deepStrictEqual(
			contract.implicitActivationEvents,
			contract.toolNames.map((name) => `onLanguageModelTool:${name}`),
		);
	});
});

function delegationInput(): DelegationIntentInput {
	return {
		delegationRequestId: DELEGATION_ID,
		deviceId: DEVICE_ID,
		nodeId: NODE_ID,
		nodeInstanceId: NODE_INSTANCE_ID,
		peerId: PEER_ID,
		workspaceId: WORKSPACE_ID,
		title: 'Fix scheduler',
		prompt: 'Implement the scheduler fix exactly as requested.',
		acceptanceCriteria: ['The focused tests pass.'],
		timeoutMinutes: 30,
	};
}

function uuidFromIndex(index: number): string {
	return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

class RecordingFacade implements TaskToolFacade {
	readonly sourceNodeId = SOURCE_NODE_ID;
	workers: MeshDirectorySnapshot = {
		devices: [{
			deviceId: DEVICE_ID,
			deviceName: 'worker-one',
			locality: 'remote',
			status: 'online',
			peerId: PEER_ID,
			nodesTruncated: false,
			totalNodes: 1,
			nodes: [{
				nodeId: NODE_ID,
				nodeInstanceId: NODE_INSTANCE_ID,
				label: 'Window One',
				status: 'online',
				capabilities: ['coding'],
				workspaces: [{
					workspaceId: WORKSPACE_ID,
					name: 'app',
					tags: ['typescript'],
					busy: false,
					claimStatus: 'claimed',
				}],
			}],
		}],
		truncated: false,
	};
	persisted: PersistedDelegationIntent = {
		delegationRequestId: DELEGATION_ID,
		taskId: TASK_ID,
		recovered: false,
	};
	persistence?: Promise<PersistedDelegationIntent>;
	acceptance: Promise<DelegationAcceptance> = Promise.resolve({ status: 'accepted' });
	taskRead: TaskToolReadResult = {
		snapshot: {
			taskId: TASK_ID,
			status: 'running',
			title: 'Fix scheduler',
			updatedAt: '2026-08-25T00:00:00.000Z',
			phase: 'implementation',
		},
		eventCursor: 1,
		events: [{
			sequence: 1,
			type: 'progress',
			at: '2026-08-25T00:00:00.000Z',
			summary: 'Implementing.',
		}],
		truncated: false,
	};
	listError: unknown;
	persistCalls = 0;
	acceptanceWaits = 0;
	cancelCalls = 0;
	answerCalls = 0;
	cancelStatus: TaskActionReceipt['status'] = 'cancelled';
	responseTaskId?: string;
	callOrder: string[] = [];
	lastAcceptanceSignal?: AbortSignal;
	persistedIntents: DelegationIntentInput[] = [];

	async listWorkers(_signal: AbortSignal): Promise<MeshDirectorySnapshot> {
		if (this.listError !== undefined) {
			throw this.listError;
		}
		return this.workers;
	}

	async persistDelegationIntent(intent: DelegationIntentInput): Promise<PersistedDelegationIntent> {
		this.persistCalls += 1;
		this.callOrder.push('persist');
		this.persistedIntents.push(intent);
		return this.persistence ?? {
			...this.persisted,
			delegationRequestId: intent.delegationRequestId ?? this.persisted.delegationRequestId,
		};
	}

	async waitForDelegationAcceptance(
		_request: Pick<PersistedDelegationIntent, 'delegationRequestId' | 'taskId'>,
		signal: AbortSignal,
	): Promise<DelegationAcceptance> {
		this.acceptanceWaits += 1;
		this.callOrder.push('wait');
		this.lastAcceptanceSignal = signal;
		return this.acceptance;
	}

	async getTask(
		_request: { readonly taskId: string; readonly afterEventSequence?: number; readonly maxEvents: number },
		_signal: AbortSignal,
	): Promise<TaskToolReadResult> {
		return this.taskRead;
	}

	async cancelOwnedTask(
		request: { readonly taskId: string },
		_signal: AbortSignal,
	): Promise<TaskActionReceipt> {
		this.cancelCalls += 1;
		return { taskId: this.responseTaskId ?? request.taskId, status: this.cancelStatus };
	}

	async answerOwnedTask(
		request: {
			readonly taskId: string;
			readonly inputId: string;
			readonly answerId: string;
			readonly answer: string;
		},
		_signal: AbortSignal,
	): Promise<TaskActionReceipt> {
		this.answerCalls += 1;
		return { taskId: this.responseTaskId ?? request.taskId, status: 'running' };
	}
}

class ManualClock implements ToolClock {
	private now = 0;
	private readonly sleepers: Array<{ dueAt: number; resolve: () => void; disposed: boolean }> = [];
	activeTimers = 0;
	createdTimers = 0;
	disposedTimers = 0;

	createTimer(delayMs: number): { readonly promise: Promise<void>; dispose(): void } {
		let resolveTimer: (() => void) | undefined;
		const sleeper = {
			dueAt: this.now + delayMs,
			resolve: () => resolveTimer?.(),
			disposed: false,
		};
		const promise = new Promise<void>((resolve) => {
			resolveTimer = resolve;
		});
		this.sleepers.push(sleeper);
		this.activeTimers += 1;
		this.createdTimers += 1;
		return {
			promise,
			dispose: () => {
				if (!sleeper.disposed) {
					sleeper.disposed = true;
					this.activeTimers -= 1;
					this.disposedTimers += 1;
				}
				resolveTimer = undefined;
			},
		};
	}

	advanceBy(delayMs: number): void {
		this.now += delayMs;
		const ready = this.sleepers.filter(({ dueAt, disposed }) => !disposed && dueAt <= this.now);
		for (const sleeper of ready) {
			this.sleepers.splice(this.sleepers.indexOf(sleeper), 1);
			sleeper.resolve();
		}
	}
}

class ManualCancellation implements ToolCancellation {
	isCancellationRequested = false;
	private readonly listeners = new Set<() => void>();

	onCancellationRequested(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	cancel(): void {
		this.isCancellationRequested = true;
		for (const listener of this.listeners) {
			listener();
		}
	}
}

class Deferred<T> {
	readonly promise: Promise<T>;
	private resolvePromise: ((value: T) => void) | undefined;

	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: T): void {
		this.resolvePromise?.(value);
		this.resolvePromise = undefined;
	}
}
