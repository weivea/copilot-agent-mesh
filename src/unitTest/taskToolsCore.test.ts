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
import { sanitizeDelegationText } from '../tools/DelegationTextSanitizer';
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
const SOURCE_WORKSPACE_IDENTITY = `sha256:${'A'.repeat(43)}`;

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

	test('preparation is pure and shows the safe target scope without prompt or IDs', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);
		const input = delegationInput();

		const first = await core.prepareDelegateInvocation(input);
		const second = await core.prepareDelegateInvocation(input);

		assert.deepStrictEqual(first, second);
		assert.equal(first.invocationMessage, 'Delegating to “Window One”…');
		assert.equal(first.confirmationTitle, 'Delegate to “Window One”');
		assert.match(first.confirmationMessage, /Target window: Window One/);
		assert.match(first.confirmationMessage, /Workspace: app/);
		assert.match(first.confirmationMessage, /Task: Fix scheduler/);
		assert.match(first.confirmationMessage, /does not auto-approve operations/);
		assert.match(first.confirmationMessage, /at most 60 minutes/);
		assert.doesNotMatch(first.confirmationMessage, new RegExp(NODE_ID));
		assert.doesNotMatch(first.confirmationMessage, new RegExp(WORKSPACE_ID));
		assert.ok(!first.confirmationMessage.includes(input.prompt));
		assert.equal(facade.persistCalls, 0);
		assert.equal(facade.acceptanceWaits, 0);
	});

	test('returns the exact completed compact contract after an authoritative event', async () => {
		const facade = new RecordingFacade();
		const clock = new ManualClock();
		const core = new TaskToolsCore(facade, { clock });

		const result = await core.delegateTask(delegationInput());

		assert.deepStrictEqual(result, {
			s: 0,
			t: TASK_ID,
			d: DELEGATION_ID,
			r: { summary: 'Scheduler fixed.' },
		});
		assert.equal(clock.createdTimers, 1);
		assert.equal(clock.activeTimers, 0);
	});

	test('preserves safe multiline delegation text while removing sensitive spans', async () => {
		const raw = [
			'First safe line\r\nSecond safe line\twith details.',
			'Path /Users/private/project is omitted.',
			'Final safe line.',
		].join('\n');
		const sanitized = sanitizeDelegationText(raw, 2_048);

		assert.match(sanitized, /First safe line Second safe line with details\./u);
		assert.match(sanitized, /Final safe line\./u);
		assert.match(sanitized, /redacted sensitive details/u);
		assert.doesNotMatch(sanitized, /Users|private|project/u);
		assert.doesNotMatch(sanitized, /[\r\n\t]/u);

		for (const credential of [
			'token=abc\r\ndef',
			'token=abc\ndef',
			'token=abc\tdef',
			'token%3Dabc SECRETTAIL encoded prose',
			'api%5Fkey%3A%20hunter2 SECRETTAIL encoded prose',
			'token=abc%\r\nSECRETTAIL malformed-percent prose',
			'api_key: sk-100%pure\nSECRETTAIL malformed-percent prose',
			'to\u0001ken=SECRETVAL control-obfuscated prose',
			'to\u200bken=SECRETVAL zero-width-obfuscated prose',
			'to\u200cken=SECRETVAL zero-width-nonjoiner prose',
			'to\u200dken=SECRETVAL zero-width-joiner prose',
			'to\u2060ken=SECRETVAL word-joiner prose',
			'to\u00adken=SECRETVAL soft-hyphen prose',
			'api_key: sk-ABCDEF\r\nGHIJKL more text',
			'Authorization: Basic QWxhZGRpbjpvcGVu',
			'Authorization: Bearer first second third',
			'secret: "quoted multi word secret" plausible prose',
			"secret: 'single quoted secret' plausible prose",
			'secret: unquoted multi word secret and prose',
			'secret: value followed by plausible prose',
			'secret:\r\ncontinued secret tail and prose',
			'db_password: hunter2',
			'x_api_key: abcdefgh',
			'session_token : abcdef123456',
			'password: password: hunter2',
			'api_key: "" AKIAIOSFODNN7EXAMPLE',
			'secret = secret = topsecretvalue',
			'password:\u0001hunter2',
			'password: \u202ehunter2',
			'%zzpassword = hunter2 malformed-key-start prose',
			'pa%zzssword: hunter2 malformed-key-middle prose',
			'password%zz\t hunter2 malformed-key-end prose',
			'A%zzuthorization: token first second malformed-auth prose',
			'api_%zzkey = hunter2 malformed-api-key prose',
			'api%255Fkey%3A%20hunter2%zz mixed-valid-invalid prose',
		]) {
			const result = sanitizeDelegationText(`Safe before. ${credential} Safe after.`, 2_048);
			assert.equal(result, '[redacted sensitive details]', credential);
		}
		assert.equal(
			sanitizeDelegationText('Encoded credential-free status ready%20now.', 2_048),
			'Encoded credential-free status ready%20now.',
		);
		assert.equal(
			sanitizeDelegationText('Malformed credential-free progress is 100% complete.', 2_048),
			'[redacted sensitive details]',
		);
		assert.equal(
			sanitizeDelegationText('MIME text/plain is safe.', 2_048),
			'MIME text/plain is safe.',
		);
		assert.doesNotMatch(
			sanitizeDelegationText('Read etc/passwd only if needed.', 2_048),
			/etc\/passwd/u,
		);
	});

	test('fails closed on credential continuations through delegate and get paths', async () => {
		const credentialFields = [
			'token=abc\r\ndef unique-tail-1',
			'token=abc\ndef unique-tail-2',
			'token=abc\tdef unique-tail-3',
			'Authorization: Bearer first second unique-tail-4',
			'secret: "quoted multi word" unique-tail-5 plausible prose',
			'secret: unquoted multi word unique-tail-6 plausible prose',
			'password: password: hunter2 unique-tail-7',
			'api_key:\r\ncontinued unique-tail-8 plausible prose',
			'token%3Dabc unique-tail-9 encoded prose',
			'to\u0001ken=abc unique-tail-10 control-obfuscated prose',
			'token=abc%\r\nunique-tail-11 malformed-percent prose',
			'to\u200cken=abc unique-tail-12 format-obfuscated prose',
			'%zzpassword = hunter2 unique-tail-13 malformed-key-start prose',
			'pa%zzssword: hunter2 unique-tail-14 malformed-key-middle prose',
			'password%zz\t hunter2 unique-tail-15 malformed-key-end prose',
			'A%zzuthorization: token first second unique-tail-16 malformed-auth prose',
			'api_%zzkey = hunter2 unique-tail-17 malformed-api-key prose',
			'api%255Fkey%3A%20hunter2%zz unique-tail-18 mixed-valid-invalid prose',
			'pa%zzssword\r\nhunter2 unique-tail-19 continuation prose',
		];
		for (const field of credentialFields) {
			const facade = new RecordingFacade();
			facade.delegationSnapshot = {
				taskId: TASK_ID,
				status: 'completed',
				title: 'Fix scheduler',
				updatedAt: '2026-08-25T00:00:01.000Z',
				summary: field,
			};
			const delegated = await new TaskToolsCore(facade).delegateTask(delegationInput());
			assert.equal(
				(delegated.r as Record<string, unknown>).summary,
				'[redacted sensitive details]',
				field,
			);
			assert.equal(delegated.t, TASK_ID);
			assert.equal(delegated.d, DELEGATION_ID);

			facade.taskRead = {
				snapshot: {
					taskId: TASK_ID,
					status: 'completed',
					title: 'Fix scheduler',
					updatedAt: '2026-08-25T00:00:01.000Z',
					summary: field,
				},
				eventCursor: 1,
				events: [{
					sequence: 1,
					type: 'progress',
					at: '2026-08-25T00:00:00.000Z',
					summary: field,
				}],
				truncated: false,
			};
			const tracked = await new TaskToolsCore(facade).getTask({ taskId: TASK_ID });
			assert.equal(
				(tracked.snapshot as Record<string, unknown>).summary,
				'[redacted sensitive details]',
				field,
			);
			assert.equal(
				(tracked.events as Array<Record<string, unknown>>)[0]?.summary,
				'[redacted sensitive details]',
				field,
			);
			for (const fragment of field.split(/[:=\s"']+/u).filter((part) => part.startsWith('unique-tail'))) {
				assert.doesNotMatch(JSON.stringify({ delegated, tracked }), new RegExp(fragment, 'u'));
			}
		}

		const safe = 'First safe line\r\nSecond safe line\twith normal prose.';
		const safeFacade = new RecordingFacade();
		safeFacade.delegationSnapshot = {
			taskId: TASK_ID,
			status: 'completed',
			title: 'Fix scheduler',
			updatedAt: '2026-08-25T00:00:01.000Z',
			summary: safe,
		};
		const safeResult = await new TaskToolsCore(safeFacade).delegateTask(delegationInput());
		assert.equal(
			(safeResult.r as Record<string, unknown>).summary,
			'First safe line Second safe line with normal prose.',
		);
	});

	test('sanitizes multiline completed results, input questions, and tracked events by span', async () => {
		const facade = new RecordingFacade();
		facade.delegationSnapshot = {
			taskId: TASK_ID,
			status: 'completed',
			title: 'Fix scheduler',
			updatedAt: '2026-08-25T00:00:01.000Z',
			summary: 'Built scheduler.\r\nTests pass.\tReport: /Users/private/report.txt',
			artifacts: [{
				artifactId: ANSWER_ID,
				label: 'Safe report at /Users/private/report.txt',
				mediaType: 'text/plain token=ghp_abcdefghijklmnopqrstuvwxyz',
			}],
		};
		const completed = await new TaskToolsCore(facade).delegateTask(delegationInput());
		const completedText = JSON.stringify(completed);
		assert.match(completedText, /Built scheduler\. Tests pass\. Report:/u);
		assert.match(completedText, /Safe report at/u);
		assert.doesNotMatch(completedText, /Users|private|report\.txt|ghp_|abcdefghijklmnopqrstuvwxyz/u);

		facade.delegationSnapshot = {
			taskId: TASK_ID,
			status: 'needsInput',
			title: 'Fix scheduler',
			updatedAt: '2026-08-25T00:00:02.000Z',
			pendingInput: {
				inputId: INPUT_ID,
				prompt: 'Choose queue:\r\nA\tor B. Inspect /Users/private/config.json first.',
			},
		};
		const needsInput = await new TaskToolsCore(facade).delegateTask(delegationInput());
		assert.match(String(needsInput.q), /Choose queue: A or B\. Inspect/u);
		assert.doesNotMatch(String(needsInput.q), /Users|private|config\.json/u);

		facade.taskRead = {
			...facade.taskRead,
			events: [{
				sequence: 1,
				type: 'progress',
				at: '2026-08-25T00:00:00.000Z',
				summary: 'Compiled.\r\nTests\tpassed. bearer ghp_abcdefghijklmnopqrstuvwxyz',
			}],
		};
		const tracked = await new TaskToolsCore(facade).getTask({ taskId: TASK_ID });
		const event = (tracked.events as Array<Record<string, unknown>>)[0]!;
		assert.equal(event.summary, '[redacted sensitive details]');
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

	test('defaults timeoutMinutes to 60 and rejects every invalid budget explicitly', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);
		const { timeoutMinutes: _timeoutMinutes, ...withoutTimeout } = delegationInput();
		await core.delegateTask(withoutTimeout);
		assert.equal(facade.persistedIntents[0]?.timeoutMinutes, 60);

		for (const timeoutMinutes of [0, 61, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const result = await core.delegateTask({
				...delegationInput(),
				timeoutMinutes,
			});
			assert.equal(result.status, 'error');
			assert.equal((result.error as Record<string, unknown>).code, 'INVALID_INPUT');
		}
		assert.equal(facade.persistCalls, 1);
	});

	test('returns exact needsInput, failed, and peer-cancelled branch-only fields', async () => {
		const facade = new RecordingFacade();
		facade.delegationSnapshot = {
			taskId: TASK_ID,
			status: 'needsInput',
			title: 'Fix scheduler',
			updatedAt: '2026-08-25T00:00:01.000Z',
			pendingInput: { inputId: INPUT_ID, prompt: 'Which queue?' },
		};
		const needsInput = await new TaskToolsCore(facade).delegateTask(delegationInput());
		assert.deepStrictEqual(needsInput, {
			s: 1,
			t: TASK_ID,
			d: DELEGATION_ID,
			i: INPUT_ID,
			q: 'Which queue?',
		});

		facade.delegationSnapshot = {
			taskId: TASK_ID,
			status: 'failed',
			title: 'Fix scheduler',
			updatedAt: '2026-08-25T00:00:02.000Z',
			failure: { code: 'AGENT_UNAVAILABLE', message: 'Agent unavailable.', retryable: true },
		};
		const failed = await new TaskToolsCore(facade).delegateTask(delegationInput());
		assert.deepStrictEqual(failed, {
			s: 2,
			t: TASK_ID,
			d: DELEGATION_ID,
			e: 'AGENT_UNAVAILABLE',
		});

		facade.delegationSnapshot = {
			taskId: TASK_ID,
			status: 'cancelled',
			title: 'Fix scheduler',
			updatedAt: '2026-08-25T00:00:03.000Z',
		};
		const cancelled = await new TaskToolsCore(facade).delegateTask(delegationInput());
		assert.deepStrictEqual(cancelled, {
			s: 3,
			t: TASK_ID,
			d: DELEGATION_ID,
			e: 'CANCELLED',
			x: 'peer',
		});
	});

	test('token cancellation sends one cancel and waits for authoritative cancellation', async () => {
		const facade = new RecordingFacade();
		facade.delegationSnapshot = runningSnapshot();
		facade.taskRead = { ...facade.taskRead, snapshot: runningSnapshot() };
		const cancellation = new ManualCancellation();
		const clock = new ManualClock();
		const core = new TaskToolsCore(facade, { clock });
		const invocation = core.delegateTask(delegationInput(), cancellation);
		await settleMicrotasks();

		cancellation.cancel();
		cancellation.cancel();
		await settleMicrotasks();
		assert.equal(facade.cancelCalls, 1);
		facade.emitTask(cancelledSnapshot());
		const result = await invocation;

		assert.deepStrictEqual(result, {
			s: 3,
			t: TASK_ID,
			d: DELEGATION_ID,
			e: 'CANCELLED',
			x: 'token',
		});
		assert.equal(clock.activeTimers, 0);
		assert.equal(cancellation.listenerCount, 0);
	});

	test('budget expiry sends one cancel and waits for authoritative cancellation', async () => {
		const facade = new RecordingFacade();
		facade.delegationSnapshot = runningSnapshot();
		facade.taskRead = { ...facade.taskRead, snapshot: runningSnapshot() };
		const clock = new ManualClock();
		const core = new TaskToolsCore(facade, { clock });
		const invocation = core.delegateTask(delegationInput());
		await settleMicrotasks();

		clock.advanceBy(30 * 60_000);
		await settleMicrotasks();
		assert.equal(facade.cancelCalls, 1);
		facade.emitTask(cancelledSnapshot());
		const result = await invocation;

		assert.deepStrictEqual(result, {
			s: 3,
			t: TASK_ID,
			d: DELEGATION_ID,
			e: 'TIMEOUT',
			x: 'budget',
		});
		assert.equal(clock.activeTimers, 0);
	});

	test('completion that wins before cancellation is returned as completed', async () => {
		const facade = new RecordingFacade();
		facade.delegationSnapshot = runningSnapshot();
		facade.taskRead = { ...facade.taskRead, snapshot: runningSnapshot() };
		const cancellation = new ManualCancellation();
		const invocation = new TaskToolsCore(facade).delegateTask(delegationInput(), cancellation);
		await settleMicrotasks();
		facade.emitTask({
			...runningSnapshot(),
			status: 'completed',
			summary: 'Completion won.',
		});
		cancellation.cancel();
		const result = await invocation;

		assert.deepStrictEqual(result, {
			s: 0,
			t: TASK_ID,
			d: DELEGATION_ID,
			r: { summary: 'Completion won.' },
		});
		assert.equal(facade.cancelCalls, 0);
	});

	test('terminal completion wins when cancellation reports not cancellable', async () => {
		const facade = new RecordingFacade();
		facade.delegationSnapshot = runningSnapshot();
		facade.taskRead = { ...facade.taskRead, snapshot: runningSnapshot() };
		const cancellation = new ManualCancellation();
		const invocation = new TaskToolsCore(facade).delegateTask(
			delegationInput(),
			cancellation,
		);
		await settleMicrotasks();
		facade.cancelError = new TaskToolFacadeError('TASK_NOT_CANCELLABLE');
		facade.taskRead = {
			...facade.taskRead,
			snapshot: {
				...runningSnapshot(),
				status: 'completed',
				summary: 'Completion won before cancellation.',
			},
		};
		cancellation.cancel();

		assert.deepStrictEqual(await invocation, {
			s: 0,
			t: TASK_ID,
			d: DELEGATION_ID,
			r: { summary: 'Completion won before cancellation.' },
		});
	});

	test('pending cancellation survives an initial read failure after durable start', async () => {
		const facade = new RecordingFacade();
		facade.delegationSnapshot = runningSnapshot();
		facade.taskRead = { ...facade.taskRead, snapshot: runningSnapshot() };
		facade.getTaskErrors.push(new TaskToolFacadeError('TUNNEL_UNAVAILABLE', true));
		let resolvePersistence!: (value: PersistedDelegationIntent) => void;
		facade.persistence = new Promise((resolve) => {
			resolvePersistence = resolve;
		});
		const cancellation = new ManualCancellation();
		const invocation = new TaskToolsCore(facade).delegateTask(
			delegationInput(),
			cancellation,
		);
		cancellation.cancel();
		resolvePersistence(facade.persisted);
		await settleMicrotasks();

		assert.equal(facade.cancelCalls, 1);
		facade.emitTask(cancelledSnapshot());
		assert.deepStrictEqual(await invocation, {
			s: 3,
			t: TASK_ID,
			d: DELEGATION_ID,
			e: 'CANCELLED',
			x: 'token',
		});
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

	test('redacts every remote-derived task and event text field', async () => {
		const facade = new RecordingFacade();
		const sensitive = '/Users/private/project';
		facade.taskRead = {
			snapshot: {
				taskId: TASK_ID,
				status: 'completed',
				title: `Task ${sensitive}`,
				updatedAt: '2026-08-25T00:00:00.000Z',
				phase: `Phase ${sensitive}`,
				summary: `Summary ${sensitive}`,
				validation: { status: 'passed', summary: `Validated ${sensitive}` },
				artifacts: [{
					artifactId: ANSWER_ID,
					label: `Report ${sensitive}`,
					mediaType: `text/plain; source=${sensitive}`,
				}],
			},
			eventCursor: 1,
			events: [{
				sequence: 1,
				type: `progress-${sensitive}`,
				at: '2026-08-25T00:00:00.000Z',
				summary: `Output ${sensitive}`,
			}],
			truncated: false,
		};

		const result = await new TaskToolsCore(facade).getTask({ taskId: TASK_ID });
		assert.doesNotMatch(JSON.stringify(result), /Users|private|project/u);
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
		facade.persistence = Promise.reject(new TaskToolFacadeError('TUNNEL_UNAVAILABLE', true));
		const core = new TaskToolsCore(facade);

		const result = await core.delegateTask(delegationInput());

		assert.deepStrictEqual(result, {
			s: 2,
			t: TASK_ID,
			d: DELEGATION_ID,
			e: 'TUNNEL_UNAVAILABLE',
		});
	});

	test('keeps compact delegation identity under the minimum byte budget', async () => {
		const escaping = '"\\\\\r\n\t'.repeat(3_000);
		const facade = new RecordingFacade();
		facade.delegationSnapshot = {
			taskId: TASK_ID,
			status: 'completed',
			title: 'Fix scheduler',
			updatedAt: '2026-08-25T00:00:01.000Z',
			summary: escaping,
			validation: { status: 'passed', summary: escaping },
			artifacts: Array.from({ length: 32 }, (_, index) => ({
				artifactId: uuidFromIndex(index + 900),
				label: escaping.slice(0, 512),
				mediaType: `text/plain; ${escaping.slice(0, 128)}`,
			})),
		};
		const completed = await new TaskToolsCore(facade, {
			outputByteLimit: 1_024,
		}).delegateTask(delegationInput());
		assert.equal(completed.t, TASK_ID);
		assert.equal(completed.d, DELEGATION_ID);
		assert.ok(completed.s === 0 || completed.s === 2);
		if (completed.s === 2) {
			assert.deepStrictEqual(completed, {
				s: 2,
				t: TASK_ID,
				d: DELEGATION_ID,
				e: 'OUTPUT_TOO_LARGE',
			});
		}
		assert.ok(Buffer.byteLength(JSON.stringify(completed), 'utf8') <= 1_024);

		facade.delegationSnapshot = {
			taskId: TASK_ID,
			status: 'needsInput',
			title: 'Fix scheduler',
			updatedAt: '2026-08-25T00:00:02.000Z',
			pendingInput: { inputId: INPUT_ID, prompt: escaping },
		};
		const needsInput = await new TaskToolsCore(facade, {
			outputByteLimit: 1_024,
		}).delegateTask(delegationInput());
		assert.equal(needsInput.t, TASK_ID);
		assert.equal(needsInput.d, DELEGATION_ID);
		assert.ok(needsInput.s === 1 || needsInput.s === 2);
		assert.equal(needsInput.s === 1 ? needsInput.i : needsInput.e, (
			needsInput.s === 1 ? INPUT_ID : 'OUTPUT_TOO_LARGE'
		));
		assert.ok(Buffer.byteLength(JSON.stringify(needsInput), 'utf8') <= 1_024);

		facade.delegationSnapshot = {
			taskId: TASK_ID,
			status: 'failed',
			title: 'Fix scheduler',
			updatedAt: '2026-08-25T00:00:03.000Z',
			failure: {
				code: 'TASK_EXECUTION_FAILED',
				message: escaping.slice(0, 2_048),
				retryable: false,
			},
		};
		assert.deepStrictEqual(
			await new TaskToolsCore(facade, { outputByteLimit: 1_024 })
				.delegateTask(delegationInput()),
			{
				s: 2,
				t: TASK_ID,
				d: DELEGATION_ID,
				e: 'TASK_EXECUTION_FAILED',
			},
		);
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

	test('preserves completed delegation IDs at a compact token budget', async () => {
		const result = {
			s: 0,
			t: TASK_ID,
			d: DELEGATION_ID,
			r: { summary: 'Task completed with a deliberately long bounded summary.' },
		};
		const countCharacters = async (text: string): Promise<number> => text.length;

		const serialized = await serializeToolResultToTokenBudget(result, 200, countCharacters);
		const compact = JSON.parse(serialized) as Record<string, unknown>;
		const contracted = await serializeToolResultToTokenBudget(
			result,
			serialized.length - 1,
			countCharacters,
		);

		assert.ok(serialized.length <= 200);
		assert.equal(compact.s, 0);
		assert.equal(compact.t, TASK_ID);
		assert.equal(compact.d, DELEGATION_ID);
		assert.ok(typeof (compact.r as Record<string, unknown>).summary === 'string');
		const smaller = JSON.parse(contracted) as Record<string, unknown>;
		assert.equal(smaller.t, TASK_ID);
		assert.equal(smaller.d, DELEGATION_ID);
	});

	test('never drops delegation identity when a caller supplies an impossible token budget', async () => {
		const result = {
			s: 3,
			t: TASK_ID,
			d: DELEGATION_ID,
			e: 'TIMEOUT',
			x: 'budget',
		};
		const serialized = await serializeToolResultToTokenBudget(
			result,
			0,
			async (text) => text.length,
		);

		assert.deepStrictEqual(JSON.parse(serialized), result);
	});

	test('preserves conflict error semantics in a 200-character compact result', async () => {
		const facade = new RecordingFacade();
		facade.persistence = Promise.reject(new TaskToolFacadeError('IDEMPOTENCY_CONFLICT'));
		const result = await new TaskToolsCore(facade).delegateTask(delegationInput());
		const countCharacters = async (text: string): Promise<number> => text.length;

		const serialized = await serializeToolResultToTokenBudget(result, 200, countCharacters);
		const compact = JSON.parse(serialized) as Record<string, unknown>;

		assert.ok(serialized.length <= 200);
		assert.deepStrictEqual(compact, {
			s: 2,
			t: TASK_ID,
			d: DELEGATION_ID,
			e: 'IDEMPOTENCY_CONFLICT',
		});
	});

	test('preserves exact cancelled compact fields at a compact token budget', async () => {
		const result = {
			s: 3,
			t: TASK_ID,
			d: DELEGATION_ID,
			e: 'TIMEOUT',
			x: 'budget',
		};
		const countCharacters = async (text: string): Promise<number> => text.length;

		const serialized = await serializeToolResultToTokenBudget(result, 200, countCharacters);

		assert.deepStrictEqual(JSON.parse(serialized), {
			s: 3,
			t: TASK_ID,
			d: DELEGATION_ID,
			e: 'TIMEOUT',
			x: 'budget',
		});
		assert.ok(serialized.length <= 200);
	});

	test('contracts completed summaries without dropping task identity', async () => {
		const result = {
			s: 0,
			t: TASK_ID,
			d: DELEGATION_ID,
			r: { summary: 'x'.repeat(4_096) },
		};
		const countCharacters = async (text: string): Promise<number> => text.length;

		const serialized = await serializeToolResultToTokenBudget(result, 200, countCharacters);
		const parsed = JSON.parse(serialized) as Record<string, unknown>;

		assert.equal(parsed.t, TASK_ID);
		assert.equal(parsed.d, DELEGATION_ID);
		assert.ok(parsed.s === 0 || parsed.s === 2);
		assert.ok(serialized.length <= 200);
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
		facade.delegationSnapshot = runningSnapshot();
		facade.taskRead = { ...facade.taskRead, snapshot: runningSnapshot() };
		const cancellation = new ManualCancellation();
		const cancelled = core.delegateTask(delegationInput(), cancellation);
		await settleMicrotasks();
		cancellation.cancel();
		await settleMicrotasks();
		facade.emitTask(cancelledSnapshot());
		await cancelled;

		assert.equal(clock.activeTimers, 0);
		assert.equal(clock.createdTimers, clock.disposedTimers);
	});
});

suite('Mesh tool manifest contract', () => {
	test('exports eight manifest descriptors with runtime name parity', () => {
		const manifestNames = MESH_TOOL_MANIFEST_DESCRIPTORS.map(({ name }) => name);

		assert.equal(manifestNames.length, 5);
		assert.doesNotThrow(() => assertMeshToolNameParity(manifestNames, MESH_RUNTIME_TOOL_NAMES));
		for (const removed of [
			'mesh_start_collaboration',
			'mesh_get_collaboration',
			'mesh_cancel_collaboration',
		]) {
			assert.ok(!manifestNames.some((name) => name === removed));
		}
		for (const descriptor of MESH_TOOL_MANIFEST_DESCRIPTORS) {
			assert.equal(descriptor.inputSchema.additionalProperties, false);
		}
		const delegateDescriptor = MESH_TOOL_MANIFEST_DESCRIPTORS.find(
			({ name }) => name === MESH_TOOL_NAMES.delegateTask,
		);
		assert.ok(delegateDescriptor);
		assert.match(delegateDescriptor.modelDescription, /s=0 completed/);
		assert.match(delegateDescriptor.modelDescription, /IDEMPOTENCY_CONFLICT/);
		assert.match(delegateDescriptor.modelDescription, /normal-path mesh_get_task polling is unnecessary/);
		const delegateProperties = delegateDescriptor.inputSchema.properties as Record<string, unknown>;
		assert.ok(delegateProperties.delegationRequestId);
		assert.deepStrictEqual(delegateProperties.timeoutMinutes, {
			type: 'integer',
			minimum: 1,
			maximum: 60,
			default: 60,
		});
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
		assert.match(getDescriptor.modelDescription, /abnormal mesh_delegate_task interruption recovery/);
		assert.match(getDescriptor.modelDescription, /Do not poll/);
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

function runningSnapshot(): TaskToolSnapshot {
	return {
		taskId: TASK_ID,
		status: 'running',
		title: 'Fix scheduler',
		updatedAt: '2026-08-25T00:00:00.000Z',
	};
}

function cancelledSnapshot(): TaskToolSnapshot {
	return {
		taskId: TASK_ID,
		status: 'cancelled',
		title: 'Fix scheduler',
		updatedAt: '2026-08-25T00:00:02.000Z',
	};
}

async function settleMicrotasks(): Promise<void> {
	for (let index = 0; index < 12; index += 1) {
		await Promise.resolve();
	}
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
	delegationSnapshot: TaskToolSnapshot = {
		taskId: TASK_ID,
		status: 'completed',
		title: 'Fix scheduler',
		updatedAt: '2026-08-25T00:00:01.000Z',
		summary: 'Scheduler fixed.',
	};
	listError: unknown;
	readonly getTaskErrors: unknown[] = [];
	persistCalls = 0;
	acceptanceWaits = 0;
	cancelCalls = 0;
	answerCalls = 0;
	cancelStatus: TaskActionReceipt['status'] = 'cancelled';
	cancelError?: unknown;
	responseTaskId?: string;
	callOrder: string[] = [];
	lastAcceptanceSignal?: AbortSignal;
	persistedIntents: DelegationIntentInput[] = [];
	private readonly taskListeners = new Set<(snapshot: TaskToolSnapshot) => void>();

	identifyDelegation(intent: DelegationIntentInput) {
		return {
			delegationRequestId: intent.delegationRequestId ?? DELEGATION_ID,
			taskId: this.persisted.taskId,
			sourceWorkspaceIdentity: SOURCE_WORKSPACE_IDENTITY,
		};
	}

	async describeDelegationTarget() {
		return { windowName: 'Window One', workspaceName: 'app' };
	}

	subscribeToTask(
		_taskId: string,
		listener: (snapshot: TaskToolSnapshot) => void,
		_onError: (error: unknown) => void,
	) {
		this.taskListeners.add(listener);
		return { dispose: () => this.taskListeners.delete(listener) };
	}

	emitTask(snapshot: TaskToolSnapshot): void {
		for (const listener of [...this.taskListeners]) {
			listener(snapshot);
		}
	}

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
		const persisted = await (this.persistence ?? Promise.resolve({
			...this.persisted,
			delegationRequestId: intent.delegationRequestId ?? this.persisted.delegationRequestId,
		}));
		queueMicrotask(() => this.emitTask(this.delegationSnapshot));
		return persisted;
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
		const error = this.getTaskErrors.shift();
		if (error !== undefined) {
			throw error;
		}
		return this.taskRead;
	}

	async cancelOwnedTask(
		request: { readonly taskId: string },
		_signal: AbortSignal,
	): Promise<TaskActionReceipt> {
		this.cancelCalls += 1;
		if (this.cancelError !== undefined) {
			throw this.cancelError;
		}
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

	get listenerCount(): number {
		return this.listeners.size;
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
