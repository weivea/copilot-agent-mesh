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
import { presentToolResult } from '../tools/ToolResultPresentation';
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
const ENCODED_CONTROL_CREDENTIAL_FIELDS = encodedControlCredentialFields();
const INSERTED_CODE_POINT_CREDENTIAL_FIELDS = insertedCodePointCredentialFields();
const QUOTED_CONTEXT_CREDENTIAL_FIELDS = [
	"don't reveal secret=hunter2 unique-tail-quote-1 prose",
	"the user's api_key: hunter2 unique-tail-quote-2 prose",
	'Unmatched "context then password=hunter2 unique-tail-quote-3 prose',
	'{"note": "secret=hunter2 unique-tail-quote-4 leaked in log"}',
	'don\'t leak {"password":"hunter2 unique-tail-quote-5"}',
	'user\'s config {"secret":"hunter2 unique-tail-quote-6"}',
	'password%22:%22hunter2 unique-tail-quote-7 encoded quote',
	'secret%2527%3A%2527hunter2 unique-tail-quote-8 nested encoded quote',
	'api key = hunter2 unique-tail-space-1 prose',
	'private key: hunter2 unique-tail-space-2 prose',
	'user[api key]=hunter2 unique-tail-space-3 prose',
	'credentials[ password ]: hunter2 unique-tail-space-4 prose',
];
const SAFE_INTERNATIONAL_PROSE = [
	'状态: 正常',
	'状態: 正常です',
	'Résumé: prêt',
	"L'équipe: prête",
	'密码: 已更新',
	'Международный пароль: обновлён',
	'国際化 password policy: 更新済み',
	'The password policy: updated',
	'password ポリシー: 更新済み',
	'国際化 password ポリシー: 更新済み',
	'token 一覧: 3件',
	'secret сканер: готов',
	'credential マネージャ: OK',
	'authorization 流れ: 完了',
	'the token — 期限: 30日',
	'Le « secret » : rien',
	`${'長'.repeat(512)}: 正常`,
];

function encodedControlCredentialFields(): string[] {
	const controls = [
		{ name: 'c0', value: '\u0001' },
		{ name: 'c1', value: '\u0080' },
		{ name: 'format', value: '\u200c' },
	];
	const positions = ['start', 'middle', 'end'] as const;
	const fields: string[] = [];
	let index = 0;
	for (const control of controls) {
		for (let rounds = 1; rounds <= 3; rounds += 1) {
			let encoded = control.value;
			for (let round = 0; round < rounds; round += 1) {
				encoded = encodeURIComponent(encoded);
			}
			for (const position of positions) {
				index += 1;
				const key = position === 'start'
					? `${encoded}token`
					: position === 'middle'
						? `to${encoded}ken`
						: `token${encoded}`;
				fields.push(
					`${key} = hunter2 unique-tail-control-${index} `
					+ `${control.name}-${rounds}-${position} prose`,
				);
			}
		}
	}
	return [
		...fields,
		'token%3D%01hunter2 unique-tail-control-boundary separator prose',
		'password%253A%2520%25C2%2580hunter2 unique-tail-control-password-boundary prose',
		'api_key%25253D%2525E2%252580%25258Chunter2 unique-tail-control-api-boundary prose',
		'Authorization%3A%20%E2%80%8Ctoken unique-tail-control-authorization prose',
		'to%01ken=\r\nhunter2 unique-tail-control-continuation prose',
		'to\u200b%01ken: hunter2 unique-tail-control-mixed prose',
	];
}

function insertedCodePointCredentialFields(): string[] {
	const sensitiveKeys = [
		'api_key',
		'authorization',
		'credential',
		'password',
		'private_key',
		'secret',
		'tkn',
		'token',
	];
	const insertions = [
		{ name: 'c0', value: '\u0001' },
		{ name: 'cf', value: '\u200c' },
		{ name: 'mn-combining', value: '\u0300' },
		{ name: 'me-combining', value: '\u0488' },
		{ name: 'private-use', value: '\ue000' },
		{ name: 'surrogate', value: '\ud800' },
		{ name: 'variation-emoji', value: '\ufe0f' },
		{ name: 'variation-17', value: '\ufe00' },
		{ name: 'variation-supplement', value: '\u{e0100}' },
		{ name: 'mongolian-variation', value: '\u180b' },
		{ name: 'khmer-inherent', value: '\u17b4' },
		{ name: 'hangul-filler', value: '\u3164' },
		{ name: 'choseong-filler', value: '\u115f' },
		{ name: 'jungseong-filler', value: '\u1160' },
		{ name: 'braille-blank', value: '\u2800' },
		{ name: 'emoji', value: '\u{1f600}' },
	];
	const separators = ['=', ':', ' = ', ':\r\n'];
	const fields: string[] = [];
	let index = 0;
	for (const key of sensitiveKeys) {
		for (let position = 0; position <= key.length; position += 1) {
			for (const insertion of insertions) {
				for (let encodingRounds = 0; encodingRounds <= 3; encodingRounds += 1) {
					index += 1;
					const inserted = encodeInsertedCodePoint(insertion.value, encodingRounds);
					const obfuscatedKey = key.slice(0, position) + inserted + key.slice(position);
					const separator = separators[index % separators.length];
					fields.push(
						`${obfuscatedKey}${separator}hunter2 unique-tail-property-${index} `
						+ `${insertion.name}-${encodingRounds}-${position} prose`,
					);
				}
			}
		}
	}
	return [
		...fields,
		`password${'\u0300'.repeat(512)}=hunter2 unique-tail-property-long-raw prose`,
		`authorization${encodeURIComponent('\u3164').repeat(512)}:hunter2 `
			+ 'unique-tail-property-long-encoded prose',
	];
}

function encodeInsertedCodePoint(value: string, rounds: number): string {
	if (rounds === 0) {
		return value;
	}
	let encoded = value === '\ud800' ? '%ED%A0%80' : encodeURIComponent(value);
	for (let round = 1; round < rounds; round += 1) {
		encoded = encodeURIComponent(encoded);
	}
	return encoded;
}

suite('TaskToolsCore', () => {
	test('submit waits for durable acceptance and no longer links later Chat cancellation to the task', async () => {
		const facade = new RecordingFacade();
		facade.delegationSnapshot = runningSnapshot();
		let accept!: (value: PersistedDelegationIntent) => void;
		facade.persistence = new Promise((resolve) => { accept = resolve; });
		const clock = new ManualClock();
		const cancellation = new ManualCancellation();
		const pending = new TaskToolsCore(facade, { clock }).delegateTask({
			...delegationInput(), mode: 'submit',
		}, cancellation);
		let completed = false;
		void pending.then(() => { completed = true; });
		await settleMicrotasks();
		assert.equal(completed, false);
		assert.equal(facade.persistCalls, 1);
		accept(facade.persisted);
		const result = await pending;
		assert.equal(result.s, 4);
		assert.equal(result.taskState, 'running');
		assert.equal(Object.hasOwn(facade.persistedIntents[0], 'mode'), false);
		assert.equal(clock.activeTimers, 0);
		assert.equal(facade.taskListenerCount, 0);
		cancellation.cancel();
		await settleMicrotasks();
		assert.equal(facade.cancelCalls, 0);
	});

	test('cancelling a pending submission still waits for authoritative task cancellation', async () => {
		const facade = new RecordingFacade();
		facade.delegationSnapshot = runningSnapshot();
		facade.cancelStatus = 'cancelling';
		const cancellation = new ManualCancellation();
		const pending = new TaskToolsCore(facade).delegateTask({ ...delegationInput(), mode: 'submit' }, cancellation);
		cancellation.cancel();
		await settleMicrotasks();
		assert.equal(facade.cancelCalls, 1);
		facade.emitTask(cancelledSnapshot());
		assert.equal((await pending).s, 3);
		assert.equal(facade.taskListenerCount, 0);
	});

	test('answers a current input and resumes an event-driven wait by task ID without re-delegating', async () => {
		const facade = new RecordingFacade();
		const clock = new ManualClock();
		const core = new TaskToolsCore(facade, { clock });
		facade.taskRead = { ...facade.taskRead, snapshot: {
			...runningSnapshot(), status: 'needsInput', pendingInput: { inputId: INPUT_ID, prompt: 'Which test suite?' },
		} };
		const input = { taskId: TASK_ID, inputId: INPUT_ID, answerId: ANSWER_ID, answer: 'Run the focused suite.' };
		const preparation = await core.prepareAnswerInvocation(input);
		assert.match(preparation.confirmationMessage, /Fix scheduler/);
		assert.match(preparation.confirmationMessage, /Which test suite/);
		assert.match(preparation.confirmationMessage, /Run the focused suite/);
		const receipt = presentToolResult(await core.answerTask(input));
		assert.deepEqual(receipt.nextAction, { tool: 'meshGetTask', taskId: TASK_ID, waitFor: 'outcome' });
		facade.taskRead = { ...facade.taskRead, snapshot: runningSnapshot() };
		const wait = core.getTask({ taskId: TASK_ID, waitFor: 'outcome' });
		await settleMicrotasks();
		assert.equal(facade.taskListenerCount, 1);
		facade.taskRead = { ...facade.taskRead, snapshot: { ...runningSnapshot(), status: 'completed', summary: 'Done.' } };
		facade.emitTask(facade.taskRead.snapshot);
		const result = await wait;
		assert.equal(result.waitOutcome, 'outcome');
		assert.equal((result.snapshot as TaskToolSnapshot).status, 'completed');
		assert.equal(facade.persistCalls, 0);
		assert.equal(facade.cancelCalls, 0);
		assert.equal(facade.taskListenerCount, 0);
		assert.equal(clock.activeTimers, 0);
	});

	test('read-only wait timeout and cancellation leave the task running with an explicit last-read snapshot', async () => {
		for (const stop of ['timeout', 'cancelled']) {
			const facade = new RecordingFacade();
			const clock = new ManualClock();
			const cancellation = new ManualCancellation();
			const pending = new TaskToolsCore(facade, { clock }).getTask({
				taskId: TASK_ID, waitFor: 'outcome', waitSeconds: 1,
			}, cancellation);
			await settleMicrotasks();
			if (stop === 'timeout') { clock.advanceBy(1_000); } else { cancellation.cancel(); }
			const result = await pending;
			assert.equal(result.waitOutcome, stop);
			assert.equal(result.snapshotIsLastRead, true);
			assert.equal((result.snapshot as TaskToolSnapshot).status, 'running');
			assert.equal(facade.cancelCalls, 0);
			assert.equal(facade.persistCalls, 0);
			assert.equal(facade.taskListenerCount, 0);
			assert.equal(clock.activeTimers, 0);
		}
	});

	test('scoped listing isolates local discovery and explicitly returns partial results after a remote failure', async () => {
		const facade = new RecordingFacade();
		const calls: string[] = [];
		const { peerId: _peerId, ...device } = facade.workers.devices[0];
		const scoped = Object.assign(facade, {
			listWorkers: async (_signal: AbortSignal, options?: { scope?: string }) => {
				calls.push(options?.scope ?? 'all');
				if (options?.scope === 'remote') { throw new TaskToolFacadeError('TUNNEL_UNAVAILABLE', true); }
				return { devices: [{ ...device, locality: 'local' as const }], truncated: false };
			},
		});
		const core = new TaskToolsCore(scoped);
		assert.equal((await core.listWorkers({ scope: 'local' })).status, 'ok');
		assert.deepEqual(calls, ['local']);
		const result = await core.listWorkers({ scope: 'all' });
		assert.equal(result.status, 'partial');
		assert.equal((result.devices as unknown[]).length, 1);
		assert.deepEqual(result.issues, [{
			scope: 'remote',
			error: { code: 'TUNNEL_UNAVAILABLE', message: 'The worker connection is unavailable.', retryable: true },
		}]);
	});

	test('read-only waits subscribe before the initial read and do not lose a fast terminal notification', async () => {
			const facade = new RecordingFacade();
			let first = true;
			let release!: (read: TaskToolReadResult) => void;
			const initial = facade.taskRead;
			facade.getTask = async () => {
				if (first) {
					first = false;
					return new Promise<TaskToolReadResult>((resolve) => { release = resolve; });
				}
				return facade.taskRead;
			};
			const pending = new TaskToolsCore(facade).getTask({ taskId: TASK_ID, waitFor: 'outcome' });
			await settleMicrotasks();
			facade.taskRead = { ...initial, snapshot: { ...runningSnapshot(), status: 'completed', summary: 'Finished.' } };
			facade.emitTask(facade.taskRead.snapshot);
			release(initial);
			const result = await pending;
			assert.equal((result.snapshot as TaskToolSnapshot).status, 'completed');
			assert.equal(result.waitOutcome, 'outcome');
			assert.equal(facade.taskListenerCount, 0);
			assert.equal(facade.cancelCalls, 0);
	});

	test('read-only waits reject another task event and invalid wait budgets without cancelling a task', async () => {
			const facade = new RecordingFacade();
			const core = new TaskToolsCore(facade);
			for (const input of [
				{ taskId: TASK_ID, waitSeconds: 10 },
				{ taskId: TASK_ID, waitFor: 'outcome', waitSeconds: 0 },
				{ taskId: TASK_ID, waitFor: 'outcome', waitSeconds: 3_601 },
				{ taskId: TASK_ID, waitFor: 'forever' },
			]) {
				assert.equal((await core.getTask(input)).status, 'error');
			}
			const pending = core.getTask({ taskId: TASK_ID, waitFor: 'outcome' });
			await settleMicrotasks();
			facade.emitTask({ ...runningSnapshot(), taskId: OTHER_TASK_ID });
			assert.equal((await pending).status, 'error');
			assert.equal(facade.taskListenerCount, 0);
			assert.equal(facade.cancelCalls, 0);
	});

	test('a question answered by another operator before the final read is not reported as a current outcome', async () => {
			const facade = new RecordingFacade();
			const pending = new TaskToolsCore(facade).getTask({ taskId: TASK_ID, waitFor: 'outcome' });
			await settleMicrotasks();
			facade.emitTask({
				...runningSnapshot(), status: 'needsInput',
				pendingInput: { inputId: INPUT_ID, prompt: 'Already handled by another operator.' },
			});
			const result = await pending;
			assert.equal(result.waitOutcome, 'changed');
			assert.equal((result.snapshot as TaskToolSnapshot).status, 'running');
			assert.equal(facade.cancelCalls, 0);
	});

	test('target-handle input resolves an exact route and rejects ambiguous or forged selection fields', async () => {
		const facade = new RecordingFacade();
		facade.delegationSnapshot = runningSnapshot();
		const targetHandle = 'h'.repeat(32);
		const target = { deviceId: DEVICE_ID, nodeId: NODE_ID, nodeInstanceId: NODE_INSTANCE_ID, workspaceId: WORKSPACE_ID, peerId: PEER_ID };
		const scoped = Object.assign(facade, {
			resolveTargetHandle: async (handle: string) => {
				assert.equal(handle, targetHandle);
				return target;
			},
		});
		const input = { targetHandle, title: 'Fix scheduler', prompt: 'Fix it.', delegationRequestId: DELEGATION_ID, mode: 'submit' };
		const core = new TaskToolsCore(scoped);
		assert.equal((await core.delegateTask(input)).s, 4);
		assert.equal(facade.persistedIntents[0].targetHandle, targetHandle);
		assert.equal(facade.persistedIntents[0].nodeInstanceId, NODE_INSTANCE_ID);
		for (const invalid of [
			{ ...input, nodeId: NODE_ID },
			{ ...input, sourceNodeId: SOURCE_NODE_ID },
			{ ...input, targetHandle: DELEGATION_ID },
			{ ...input, mode: 'broadcast' },
		]) {
			assert.equal((await core.delegateTask(invalid)).status, 'error');
		}
		assert.equal(facade.persistCalls, 1);
	});

	test('owned task recovery is bounded, keeps last-known ambiguity and maintains its pagination cursor', async () => {
		const facade = new RecordingFacade();
		let calls = 0;
		const tasks = Array.from({ length: 5 }, (_, index) => ({
			taskId: uuidFromIndex(index + 100),
			delegationRequestId: uuidFromIndex(index + 200),
			title: `Task ${index} ${'details '.repeat(20)}`,
			lastKnownState: 'ambiguous' as const,
			createdAt: '2026-09-01T00:00:00.000Z',
			target: { deviceId: DEVICE_ID, nodeId: NODE_ID, nodeInstanceId: NODE_INSTANCE_ID, workspaceId: WORKSPACE_ID },
			locality: 'remote' as const,
		}));
		const owned = Object.assign(facade, {
			listTasks: async () => { calls += 1; return { tasks, truncated: false, totalTasks: tasks.length }; },
		});
		const core = new TaskToolsCore(owned, { outputByteLimit: 1_024 });
		const result = await core.listTasks({ limit: 5 });
		const returned = result.tasks as typeof tasks;
		assert.ok(returned.length > 0 && returned.length < tasks.length);
		assert.equal(result.stateSource, 'lastKnown');
		assert.equal(returned[0].lastKnownState, 'ambiguous');
		assert.equal(result.nextBeforeTaskId, returned.at(-1)?.taskId);
		assert.equal(result.truncated, true);
		assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1_024);
		for (const invalid of [{ nodeId: NODE_ID }, { limit: 101 }, { includeTerminal: 'yes' }]) {
			assert.equal((await core.listTasks(invalid)).status, 'error');
		}
		assert.equal(calls, 1);
		assert.equal(facade.persistCalls, 0);
		assert.equal(facade.cancelCalls, 0);
	});

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
		assert.match(first.confirmationMessage, /non-control-plane structured file changes proven to stay inside/);
		assert.match(first.confirmationMessage, /Terminal commands.*still require confirmation/);
		assert.match(first.confirmationMessage, /execution\/instruction-control files/);
		assert.match(first.confirmationMessage, /at most 30 minutes/);
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
			...ENCODED_CONTROL_CREDENTIAL_FIELDS,
			...INSERTED_CODE_POINT_CREDENTIAL_FIELDS,
			...QUOTED_CONTEXT_CREDENTIAL_FIELDS,
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
		for (const prose of SAFE_INTERNATIONAL_PROSE) {
			assert.equal(sanitizeDelegationText(prose, 2_048), prose);
		}
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
			...ENCODED_CONTROL_CREDENTIAL_FIELDS,
			...INSERTED_CODE_POINT_CREDENTIAL_FIELDS,
			...QUOTED_CONTEXT_CREDENTIAL_FIELDS,
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
		for (const prose of SAFE_INTERNATIONAL_PROSE) {
			safeFacade.delegationSnapshot = {
				...safeFacade.delegationSnapshot,
				summary: prose,
			};
			const delegated = await new TaskToolsCore(safeFacade).delegateTask(delegationInput());
			assert.equal((delegated.r as Record<string, unknown>).summary, prose);

			safeFacade.taskRead = {
				...safeFacade.taskRead,
				snapshot: {
					...safeFacade.taskRead.snapshot,
					summary: prose,
				},
				events: [{
					...safeFacade.taskRead.events[0],
					summary: prose,
				}],
			};
			const tracked = await new TaskToolsCore(safeFacade).getTask({ taskId: TASK_ID });
			assert.equal((tracked.snapshot as Record<string, unknown>).summary, prose);
			assert.equal(
				(tracked.events as Array<Record<string, unknown>>)[0]?.summary,
				prose,
			);
		}
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
			taskState: 'failed',
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
				taskState: 'failed',
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
	test('exports six strict manifest descriptors with runtime name parity and legacy target compatibility', () => {
		const manifestNames = MESH_TOOL_MANIFEST_DESCRIPTORS.map(({ name }) => name);

		assert.equal(manifestNames.length, 6);
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
		assert.match(delegateDescriptor.modelDescription, /identical target/);
		assert.match(delegateDescriptor.modelDescription, /mesh_get_task with waitFor=outcome/);
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
		assert.deepEqual(delegateRequired, ['title', 'prompt']);
		assert.ok(delegateProperties.targetHandle);
		assert.ok(Array.isArray(delegateDescriptor.inputSchema.oneOf));
		assert.ok(!delegateRequired.includes('peerId'));
		const getDescriptor = MESH_TOOL_MANIFEST_DESCRIPTORS.find(
			({ name }) => name === MESH_TOOL_NAMES.getTask,
		);
		assert.ok(getDescriptor);
		assert.match(getDescriptor.modelDescription, /reattach after submission/);
		assert.match(getDescriptor.modelDescription, /Event-driven waits avoid polling/);
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
	get taskListenerCount(): number { return this.taskListeners.size; }

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
