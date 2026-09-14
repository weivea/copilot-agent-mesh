import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
	NATIVE_CHAT_ANSWER_TEXT,
	NATIVE_CHAT_TRUNCATION_TEXT,
	NativeChatStore,
	NativeChatStoreError,
	type NativeChatSession,
	type NativeChatStoreErrorCode,
	type NativeChatStoreOptions,
	type NativeChatTaskStart,
	type NativeChatTaskStatus,
} from '../codespaces/nativeChat/NativeChatStore';

const AT = '2026-09-11T08:00:00.000Z';
const GENERATION = uuid(900);
const OTHER_GENERATION = uuid(901);
const WORKSPACE = `sha256:${'a'.repeat(43)}`;
const RECOVERY = { sessionUri: `copilotcli:/${uuid(800)}`, chatUri: `ahp-chat:/${uuid(801)}` };
const WRITE_LOCK_FILE_NAME = 'native-chat-write.lock';

test('Native Chat reloads durable history without changing unfinished or terminal outcomes', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	await store.initialize();
	const first = await store.beginTask(start(1));
	await store.setRecovery(first.id, RECOVERY);
	await store.setStatus(first.id, 'running');
	for (const kind of ['output', 'progress', 'tool', 'terminal', 'error'] as const) {
		await store.append(first.id, { kind, text: `${kind}: [local file](src/main.ts)\nUnicode 🧪` });
	}
	await store.recordInput(first.id, uuid(20), 'Which public option should be used?');
	await store.recordAnswer(first.id, uuid(20));
	await store.setStatus(first.id, 'completed');
	await store.archive(first.id, true);
	await store.beginTask(start(2));
	await store.flush();

	const before = store.list();
	const reopened = createStore(rootDirectory);
	await reopened.initialize();
	assert.deepStrictEqual(reopened.list(), before);
	assert.equal(reopened.get(uuid(1))!.turns[0].status, 'completed');
	assert.equal(reopened.get(uuid(2))!.turns[0].status, 'starting');
	assert.equal(reopened.get(uuid(1))!.archived, true);
	assert.deepStrictEqual(reopened.sessionForTask(uuid(1)), reopened.get(uuid(1)));
	assert.equal(reopened.sessionForTask(uuid(99)), undefined);
	assert.equal(reopened.get(uuid(99)), undefined);
	assert.deepStrictEqual((await readdir(rootDirectory)).sort(), [`${uuid(1)}.json`, `${uuid(2)}.json`]);
});

test('Native Chat continuations append a new turn only to the exact completed live identity', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	await store.beginTask(start(1));
	await store.setRecovery(uuid(1), RECOVERY);
	await assert.rejects(store.beginTask(start(2, { continuation: RECOVERY })), code('CONFLICT'));
	await store.setStatus(uuid(1), 'completed');

	for (const change of [
		{ generation: OTHER_GENERATION },
		{ workspaceIdentity: `sha256:${'b'.repeat(43)}` },
		{ workspaceUri: 'file:///workspaces/other' },
		{ continuation: { ...RECOVERY, chatUri: 'ahp-chat:/different' } },
		{ continuation: { ...RECOVERY, sessionUri: 'copilotcli:/different' } },
	]) {
		await assert.rejects(store.beginTask(start(2, { continuation: RECOVERY, ...change })), code('CONFLICT'));
		assert.equal(store.list().length, 1);
		assert.equal(store.get(uuid(1))!.turns.length, 1);
	}

	const continued = await store.beginTask(start(2, {
		continuation: RECOVERY, title: 'Follow-up title', prompt: 'Inspect the previous findings.',
		sourceLabel: 'A different display label',
	}));
	assert.equal(continued.id, uuid(1));
	assert.equal(continued.title, start(1).title);
	assert.equal(continued.sourceLabel, start(1).sourceLabel);
	assert.equal(continued.turns.length, 2);
	assert.equal(continued.turns[0].status, 'completed');
	assert.equal(continued.turns[1].taskId, uuid(2));
	assert.equal(continued.turns[1].prompt, 'Inspect the previous findings.');
	assert.equal(continued.turns[1].status, 'starting');
	assert.deepStrictEqual(continued.turns[1].recovery, RECOVERY);
	assert.equal(store.sessionForTask(uuid(2))!.id, uuid(1));
	await store.setStatus(uuid(2), 'failed');
	await assert.rejects(store.beginTask(start(3, { continuation: RECOVERY })), code('CONFLICT'));

	const reopened = createStore(rootDirectory);
	await reopened.initialize();
	assert.deepStrictEqual(reopened.get(uuid(1)), store.get(uuid(1)));
});

test('Native Chat exact start retries remain idempotent, including continuation titles after reload', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	let writes = 0;
	store.onDidChange(() => { writes += 1; });
	const request = start(1);
	const first = await store.beginTask(request);
	assert.deepStrictEqual(await store.beginTask({ ...request, taskId: request.taskId.toUpperCase() }), first);
	assert.equal(writes, 1);
	for (const change of [
		{ title: 'Changed title' },
		{ prompt: 'Changed prompt' },
		{ acceptanceCriteria: ['A different criterion'] },
		{ workspaceIdentity: `sha256:${'b'.repeat(43)}` },
		{ workspaceName: 'Other name' },
		{ workspaceUri: 'file:///workspaces/other' },
		{ sourceLabel: 'Other source' },
		{ generation: OTHER_GENERATION },
		{ continuation: RECOVERY },
	]) {
		await assert.rejects(store.beginTask({ ...request, ...change }), code('CONFLICT'));
	}
	await store.setRecovery(uuid(1), RECOVERY);
	await store.setStatus(uuid(1), 'completed');
	assert.equal((await store.beginTask(request)).turns[0].status, 'completed');
	const followup = start(2, { title: 'Independent follow-up title', continuation: RECOVERY });
	await store.beginTask(followup);
	const reopened = createStore(rootDirectory);
	await reopened.initialize();
	assert.deepStrictEqual(await reopened.beginTask(followup), store.get(uuid(1)));
	await assert.rejects(reopened.beginTask({ ...followup, title: 'Different follow-up title' }), code('CONFLICT'));
	assert.equal(reopened.list().length, 1);
	assert.equal(reopened.get(uuid(1))!.turns.length, 2);
});

test('Native Chat accepts UUID v4/v5, validates opaque IDs, and rejects credential-bearing metadata', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	await store.initialize();
	const v5 = '01234567-89ab-5def-8123-456789abcdef';
	await store.beginTask(start(1, { taskId: v5.toUpperCase() }));
	assert.equal(store.get(v5)!.id, v5);
	const invalidStarts: unknown[] = [
		start(2, { taskId: '..\\outside' }),
		start(2, { taskId: 'not-a-uuid' }),
		start(2, { workspaceIdentity: 'private-path' }),
		start(2, { generation: 'a-generation-capability-is-not-a-generation-id' }),
		start(2, { workspaceUri: 'file:///workspaces/repo?token=secret' }),
		start(2, { workspaceUri: 'https://user:secret@example.test/repo' }),
		{ ...start(2), token: 'must-not-be-written' },
	];
	for (const request of invalidStarts) {
		await assert.rejects(store.beginTask(request as NativeChatTaskStart), code('INVALID_INPUT'));
	}
	await assert.rejects(store.setRecovery(v5, { ...RECOVERY, chatUri: 'ahp-chat:/chat?oauth=secret' }), code('INVALID_INPUT'));
	assert.throws(() => store.get('..\\outside'), code('INVALID_INPUT'));
	assert.throws(() => store.sessionForTask('../outside'), code('INVALID_INPUT'));
	await assert.rejects(store.archive('../outside', true), code('INVALID_INPUT'));
	await assert.rejects(store.append('../outside', { kind: 'output', text: 'unsafe' }), code('INVALID_INPUT'));
	assert.equal((await readdir(rootDirectory)).length, 1);
	assert.doesNotMatch(await readFile(join(rootDirectory, `${v5}.json`), 'utf8'), /must-not-be-written|oauth=secret/u);
});

test('Native Chat recovery identity cannot be rebound or ambiguously shared within a generation', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	await store.beginTask(start(1));
	await store.setRecovery(uuid(1), RECOVERY);
	const committed = store.get(uuid(1));
	await store.setRecovery(uuid(1), { ...RECOVERY });
	assert.deepStrictEqual(store.get(uuid(1)), committed);
	await assert.rejects(store.setRecovery(uuid(1), { ...RECOVERY, chatUri: 'ahp-chat:/other' }), code('CONFLICT'));
	await assert.rejects(store.setRecovery(uuid(1), { ...RECOVERY, sessionUri: 'copilotcli:/other' }), code('CONFLICT'));
	await store.beginTask(start(2));
	await assert.rejects(store.setRecovery(uuid(2), RECOVERY), code('CONFLICT'));
	await store.beginTask(start(3, { generation: OTHER_GENERATION }));
	await store.setRecovery(uuid(3), RECOVERY);
	assert.deepStrictEqual(store.get(uuid(1))!.turns[0].recovery, RECOVERY);
});

test('Native Chat concurrent appends are ordered immutable prefixes and listeners see committed files', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	const observed: NativeChatSession[] = [];
	const subscription = store.onDidChange((sessionId) => {
		const stored = JSON.parse(readFileSync(join(rootDirectory, `${sessionId}.json`), 'utf8'));
		const value = store.get(sessionId)!;
		assert.deepStrictEqual(stored.turns[0].entries, value.turns[0].entries);
		observed.push(value);
	});
	const initial = await store.beginTask(start(1));
	const writes = Array.from({ length: 40 }, (_, index) =>
		store.append(uuid(1), { kind: 'output', text: `Chunk ${index}\n` }),
	);
	await store.flush();
	await Promise.all(writes);
	const final = store.get(uuid(1))!;
	assert.deepStrictEqual(final.turns[0].entries.map((entry) => entry.sequence), Array.from({ length: 40 }, (_, i) => i + 1));
	assert.deepStrictEqual(final.turns[0].entries.map((entry) => entry.text), Array.from({ length: 40 }, (_, i) => `Chunk ${i}\n`));
	assert.equal(initial.turns[0].entries.length, 0);
	assert.equal(observed.length, 41);
	for (let index = 0; index < observed.length; index += 1) {
		assert.deepStrictEqual(observed[index].turns[0].entries, final.turns[0].entries.slice(0, index));
	}
	assert.ok(Object.isFrozen(store.list()));
	assert.ok(Object.isFrozen(final));
	assert.ok(Object.isFrozen(final.turns));
	assert.ok(Object.isFrozen(final.turns[0]));
	assert.ok(Object.isFrozen(final.turns[0].acceptanceCriteria));
	assert.ok(Object.isFrozen(final.turns[0].entries));
	assert.ok(Object.isFrozen(final.turns[0].entries[0]));
	assert.throws(() => { (final.turns[0].entries[0] as { text: string }).text = 'changed'; }, TypeError);
	subscription.dispose();
	subscription.dispose();
	await store.append(uuid(1), { kind: 'progress', text: 'After detach' });
	assert.equal(observed.length, 41);
});

test('Native Chat queues copy caller data instead of retaining mutable request objects', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	const acceptanceCriteria = ['Original criterion'];
	const request = { ...start(1), acceptanceCriteria };
	const beginning = store.beginTask(request);
	acceptanceCriteria[0] = 'Mutated criterion';
	request.prompt = 'Mutated prompt';
	const session = await beginning;
	assert.deepStrictEqual(session.turns[0].acceptanceCriteria, ['Original criterion']);
	assert.equal(session.turns[0].prompt, start(1).prompt);
	const recovery = { ...RECOVERY };
	const binding = store.setRecovery(uuid(1), recovery);
	recovery.chatUri = 'ahp-chat:/mutated';
	await binding;
	assert.deepStrictEqual(store.get(uuid(1))!.turns[0].recovery, RECOVERY);
	assert.ok(Object.isFrozen(store.get(uuid(1))!.turns[0].recovery));
});

test('Native Chat retains exact public pending inputs and only generic answer acknowledgements', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	await store.beginTask(start(1));
	await assert.rejects(store.setStatus(uuid(1), 'needsInput'), code('CONFLICT'));
	await store.recordInput(uuid(1), uuid(20), 'Choose a public option.');
	const pending = store.get(uuid(1))!.turns[0];
	assert.equal(pending.status, 'needsInput');
	assert.deepStrictEqual(pending.pendingInput, { inputId: uuid(20), prompt: 'Choose a public option.' });
	assert.ok(Object.isFrozen(pending.pendingInput));
	await store.recordInput(uuid(1), uuid(20), 'Choose a public option.');
	assert.equal(store.get(uuid(1))!.turns[0].entries.length, 1);
	await assert.rejects(store.recordInput(uuid(1), uuid(20), 'A changed prompt.'), code('CONFLICT'));
	await assert.rejects(store.recordInput(uuid(1), uuid(21), 'A different input.'), code('CONFLICT'));
	await assert.rejects(store.recordAnswer(uuid(1), uuid(21)), code('CONFLICT'));
	await assert.rejects(store.setStatus(uuid(1), 'running'), code('CONFLICT'));
	assert.deepStrictEqual(store.get(uuid(1))!.turns[0].pendingInput, pending.pendingInput);

	const reopened = createStore(rootDirectory);
	await reopened.initialize();
	assert.deepStrictEqual(reopened.get(uuid(1))!.turns[0].pendingInput, pending.pendingInput);
	await store.append(uuid(1), { kind: 'answer', inputId: uuid(20), text: 'secret-answer-that-must-not-be-stored' });
	await store.recordAnswer(uuid(1), uuid(20));
	const answered = store.get(uuid(1))!.turns[0];
	assert.equal(answered.status, 'running');
	assert.equal(answered.pendingInput, undefined);
	assert.deepStrictEqual(answered.entries.at(-1), {
		sequence: 2, kind: 'answer', inputId: uuid(20), text: NATIVE_CHAT_ANSWER_TEXT,
	});
	assert.equal(answered.entries.length, 2);
	assert.doesNotMatch(await readFile(join(rootDirectory, `${uuid(1)}.json`), 'utf8'), /secret-answer-that-must-not-be-stored/u);
	await assert.rejects(store.recordInput(uuid(1), uuid(20), 'Choose a public option.'), code('CONFLICT'));
	await store.append(uuid(1), { kind: 'input', inputId: uuid(21), text: 'Another public option.' });
	await assert.rejects(store.recordAnswer(uuid(1), uuid(20)), code('CONFLICT'));
	assert.equal(store.get(uuid(1))!.turns[0].pendingInput!.inputId, uuid(21));
	await store.setStatus(uuid(1), 'cancelled');
	assert.equal(store.get(uuid(1))!.turns[0].pendingInput, undefined);
	await assert.rejects(store.recordAnswer(uuid(1), uuid(21)), code('CONFLICT'));
	await assert.rejects(store.recordInput(uuid(1), uuid(22), 'Too late.'), code('CONFLICT'));
});

test('Native Chat authoritative terminal states are idempotent and never regress or guess completion', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	for (const [index, terminal] of (['completed', 'cancelled', 'failed', 'interrupted'] as const).entries()) {
		const task = start(index + 1);
		await store.beginTask(task);
		await store.append(task.taskId, { kind: 'terminal', text: 'A shell command finished.' });
		assert.equal(store.get(task.taskId)!.turns[0].status, 'starting');
		await store.setStatus(task.taskId, 'running');
		await assert.rejects(store.setStatus(task.taskId, 'starting'), code('CONFLICT'));
		await store.recordInput(task.taskId, uuid(20 + index), 'Question.');
		await store.setStatus(task.taskId, terminal);
		const ended = store.get(task.taskId)!;
		assert.equal(ended.turns[0].pendingInput, undefined);
		assert.equal(ended.turns[0].endedAt, AT);
		await store.setStatus(task.taskId, terminal);
		assert.deepStrictEqual(store.get(task.taskId), ended);
		for (const status of ['starting', 'running', 'needsInput', 'completed', 'cancelled', 'failed', 'interrupted'] as const) {
			if (status !== terminal) {
				await assert.rejects(store.setStatus(task.taskId, status), code('CONFLICT'));
			}
		}
	}
});

test('Native Chat archive persistence does not cancel active execution', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	await store.beginTask(start(1));
	await store.setStatus(uuid(1), 'running');
	await store.archive(uuid(1), true);
	assert.equal(store.get(uuid(1))!.turns[0].status, 'running');
	const reopened = createStore(rootDirectory);
	await reopened.initialize();
	assert.equal(reopened.get(uuid(1))!.archived, true);
	assert.equal(reopened.get(uuid(1))!.turns[0].status, 'running');
	await reopened.archive(uuid(1), false);
	const again = createStore(rootDirectory);
	await again.initialize();
	assert.equal(again.get(uuid(1))!.archived, false);
	await assert.rejects(again.archive(uuid(99), true), code('NOT_FOUND'));
});

test('Native Chat interrupts only unfinished turns belonging to the specified generation', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	for (const [index, status] of (['starting', 'running', 'needsInput', 'completed', 'cancelled', 'failed'] as const).entries()) {
		const id = uuid(index + 1);
		await store.beginTask(start(index + 1));
		if (status === 'needsInput') {
			await store.recordInput(id, uuid(30), 'Public question.');
		} else {
			await store.setStatus(id, status);
		}
	}
	await store.beginTask(start(7, { generation: OTHER_GENERATION }));
	await store.setStatus(uuid(7), 'running');
	const terminalBefore = [4, 5, 6].map((id) => store.get(uuid(id)));
	await store.interruptGeneration(GENERATION);
	for (const id of [1, 2, 3]) {
		const turn = store.get(uuid(id))!.turns[0];
		assert.equal(turn.status, 'interrupted');
		assert.equal(turn.endedAt, AT);
		assert.equal(turn.pendingInput, undefined);
	}
	assert.deepStrictEqual([4, 5, 6].map((id) => store.get(uuid(id))), terminalBefore);
	assert.equal(store.get(uuid(7))!.turns[0].status, 'running');
	let notifications = 0;
	store.onDidChange(() => { notifications += 1; });
	await store.interruptGeneration(GENERATION);
	assert.equal(notifications, 0);
	const reopened = createStore(rootDirectory);
	await reopened.initialize();
	assert.deepStrictEqual(reopened.list(), store.list());
	assert.equal(reopened.get(uuid(7))!.turns[0].status, 'running');
});

test('Native Chat count truncation preserves prefixes and reserves critical input and terminal state', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory, { maxEntriesPerTurn: 4 });
	await store.beginTask(start(1));
	await store.append(uuid(1), { kind: 'output', text: 'Retained first output.' });
	const prefix = store.get(uuid(1))!.turns[0].entries;
	await store.append(uuid(1), { kind: 'tool', text: 'Output that does not fit.' });
	const truncated = store.get(uuid(1))!.turns[0];
	assert.deepStrictEqual(truncated.entries.slice(0, prefix.length), prefix);
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.entries.at(-1)!.text, NATIVE_CHAT_TRUNCATION_TEXT);
	await store.append(uuid(1), { kind: 'output', text: 'More omitted output.' });
	assert.deepStrictEqual(store.get(uuid(1))!.turns[0], truncated);
	await store.recordInput(uuid(1), uuid(20), 'Choose an option.');
	await store.recordAnswer(uuid(1), uuid(20));
	await assert.rejects(store.recordInput(uuid(1), uuid(21), 'This cannot fit.'), code('CAPACITY'));
	await store.setStatus(uuid(1), 'completed');
	const final = store.get(uuid(1))!.turns[0];
	assert.equal(final.entries.length, 4);
	assert.equal(final.entries.filter((entry) => entry.text === NATIVE_CHAT_TRUNCATION_TEXT).length, 1);
	assert.equal(final.entries.at(-1)!.text, NATIVE_CHAT_ANSWER_TEXT);
	assert.equal(final.status, 'completed');
	assert.equal(final.pendingInput, undefined);
	const reopened = createStore(rootDirectory, { maxEntriesPerTurn: 4 });
	await reopened.initialize();
	assert.deepStrictEqual(reopened.get(uuid(1)), store.get(uuid(1)));
});

test('Native Chat byte truncation is truthful for Unicode and JSON escaping without dropping metadata', async (t) => {
	const { rootDirectory } = await directory(t);
	const maxSessionBytes = 4_096;
	const store = createStore(rootDirectory, { maxSessionBytes });
	await store.beginTask(start(1));
	for (let index = 0; index < 20 && !store.get(uuid(1))!.turns[0].truncated; index += 1) {
		const prefix = store.get(uuid(1))!.turns[0].entries;
		await store.append(uuid(1), { kind: 'output', text: `${index}: ${'🧪"\\\n'.repeat(50)}` });
		assert.deepStrictEqual(store.get(uuid(1))!.turns[0].entries.slice(0, prefix.length), prefix);
		assert.ok((await lstat(join(rootDirectory, `${uuid(1)}.json`))).size <= maxSessionBytes);
	}
	assert.equal(store.get(uuid(1))!.turns[0].truncated, true);
	await store.recordInput(uuid(1), uuid(20), 'A'.repeat(200));
	await store.recordAnswer(uuid(1), uuid(20));
	await store.setStatus(uuid(1), 'failed');
	const final = store.get(uuid(1))!.turns[0];
	assert.equal(final.prompt, start(1).prompt);
	assert.deepStrictEqual(final.acceptanceCriteria, start(1).acceptanceCriteria);
	assert.equal(final.status, 'failed');
	assert.equal(final.entries.filter((entry) => entry.text === NATIVE_CHAT_TRUNCATION_TEXT).length, 1);
	assert.ok((await lstat(join(rootDirectory, `${uuid(1)}.json`))).size <= maxSessionBytes);
	const reopened = createStore(rootDirectory, { maxSessionBytes });
	await reopened.initialize();
	assert.deepStrictEqual(reopened.get(uuid(1)), store.get(uuid(1)));
});

test('Native Chat oversized single outputs are omitted once and a one-entry limit remains bounded', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory, { maxEntriesPerTurn: 1 });
	await store.beginTask(start(1));
	await store.append(uuid(1), { kind: 'output', text: 'x'.repeat(2 * 1_024 * 1_024 + 1) });
	await store.append(uuid(1), { kind: 'error', text: 'An additional omitted diagnostic.' });
	assert.deepStrictEqual(store.get(uuid(1))!.turns[0].entries, [
		{ sequence: 1, kind: 'progress', text: NATIVE_CHAT_TRUNCATION_TEXT },
	]);
	await store.setStatus(uuid(1), 'failed');
	assert.equal(store.get(uuid(1))!.turns[0].status, 'failed');
	assert.equal(store.get(uuid(1))!.turns[0].truncated, true);
});

test('Native Chat session and turn capacities fail explicitly without evicting archived history', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory, { maxSessions: 2, maxTurnsPerSession: 2 });
	await store.beginTask(start(1));
	await store.setRecovery(uuid(1), RECOVERY);
	await store.setStatus(uuid(1), 'completed');
	await store.beginTask(start(2, { continuation: RECOVERY }));
	await store.setStatus(uuid(2), 'completed');
	await assert.rejects(store.beginTask(start(3, { continuation: RECOVERY })), code('CAPACITY'));
	await store.beginTask(start(4));
	await store.archive(uuid(4), true);
	const before = store.list();
	await assert.rejects(store.beginTask(start(5)), code('CAPACITY'));
	assert.deepStrictEqual(store.list(), before);
	const smaller = createStore(rootDirectory, { maxSessions: 1 });
	await assert.rejects(smaller.initialize(), code('CAPACITY'));
	assert.throws(() => smaller.list(), code('NOT_INITIALIZED'));
	assert.equal((await readdir(rootDirectory)).length, 2);
});

test('Native Chat refuses oversized identity/input metadata instead of silently truncating it', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory, { maxSessionBytes: 2_048 });
	await assert.rejects(store.beginTask(start(1, { prompt: 'A'.repeat(2_048) })), code('CAPACITY'));
	assert.deepStrictEqual(store.list(), []);
	assert.deepStrictEqual(await readdir(rootDirectory), []);
	await store.beginTask(start(1));
	const before = await readFile(join(rootDirectory, `${uuid(1)}.json`), 'utf8');
	await assert.rejects(store.recordInput(uuid(1), uuid(20), 'A'.repeat(2_048)), code('CAPACITY'));
	assert.equal(await readFile(join(rootDirectory, `${uuid(1)}.json`), 'utf8'), before);
	assert.equal(store.get(uuid(1))!.turns[0].status, 'starting');
	await store.setStatus(uuid(1), 'interrupted');
});

test('Native Chat options are lower-only and roots must be absolute non-traversing directories', async (t) => {
	const { directory: scratch, rootDirectory } = await directory(t);
	for (const options of [
		{ maxSessions: 101 }, { maxSessions: 0 }, { maxSessions: 1.5 },
		{ maxSessionBytes: 2 * 1_024 * 1_024 + 1 }, { maxSessionBytes: Number.NaN },
		{ maxEntriesPerTurn: 4_097 }, { maxEntriesPerTurn: -1 }, { maxTurnsPerSession: 101 },
	]) {
		assert.throws(() => createStore(rootDirectory, options), code('INVALID_INPUT'));
	}
	assert.throws(() => createStore('relative-history'), code('INVALID_INPUT'));
	assert.throws(() => createStore(`${scratch}\\..\\history`), code('INVALID_INPUT'));
	assert.throws(() => createStore(parse(rootDirectory).root), code('UNSAFE_STORAGE'));
	await writeFile(rootDirectory, 'not a directory', { mode: 0o600 });
	await assert.rejects(createStore(rootDirectory).initialize(), code('UNSAFE_STORAGE'));
});

test('Native Chat rejects corrupt JSON, unknown versions, invalid identities and inconsistent event state', async (t) => {
	const corruptions: readonly [string, (record: any) => unknown][] = [
		['unknown schema', (record) => ({ ...record, schemaVersion: 2 })],
		['invalid session ID', (record) => ({ ...record, id: '../outside' })],
		['filename mismatch', (record) => ({ ...record, id: uuid(2) })],
		['invalid workspace hash', (record) => ({ ...record, workspaceIdentity: 'sha256:wrong' })],
		['unknown credential field', (record) => ({ ...record, token: 'secret' })],
		['missing request identity', ({ requestHashes: _hashes, ...record }) => record],
		['invalid turn ID', (record) => ({ ...record, turns: [{ ...record.turns[0], taskId: 'not-a-uuid' }] })],
		['terminal without endedAt', (record) => ({ ...record, turns: [{ ...record.turns[0], status: 'completed' }] })],
		['false truncation flag', (record) => ({ ...record, turns: [{ ...record.turns[0], truncated: true }] })],
		['input without journal', (record) => ({
			...record, turns: [{ ...record.turns[0], status: 'needsInput', pendingInput: { inputId: uuid(20), prompt: 'Question.' } }],
		})],
		['non-contiguous sequence', (record) => ({
			...record, turns: [{ ...record.turns[0], entries: [{ sequence: 2, kind: 'output', text: 'Wrong sequence.' }] }],
		})],
		['unsafe saved answer', (record) => ({
			...record, turns: [{
				...record.turns[0], entries: [
					{ sequence: 1, kind: 'input', text: 'Question.', inputId: uuid(20) },
					{ sequence: 2, kind: 'answer', text: 'An arbitrary secret answer.', inputId: uuid(20) },
				],
			}],
		})],
		['discarded pending input', (record) => ({
			...record, turns: [{
				...record.turns[0], entries: [{ sequence: 1, kind: 'input', text: 'Question.', inputId: uuid(20) }],
			}],
		})],
		['non-monotonic timestamps', (record) => ({ ...record, updatedAt: '2020-01-01T00:00:00.000Z' })],
	];
	for (const [name, corrupt] of corruptions) {
		await t.test(name, async (child) => {
			const { rootDirectory } = await directory(child);
			await createStore(rootDirectory).beginTask(start(1));
			const path = join(rootDirectory, `${uuid(1)}.json`);
			const original = JSON.parse(await readFile(path, 'utf8'));
			const contents = `${JSON.stringify(corrupt(original))}\n`;
			await writeFile(path, contents);
			const reopened = createStore(rootDirectory);
			await assert.rejects(reopened.initialize(), code('CORRUPT_STORAGE'));
			assert.throws(() => reopened.list(), code('NOT_INITIALIZED'));
			assert.equal(await readFile(path, 'utf8'), contents);
		});
	}
	for (const contents of ['{ incomplete JSON', Buffer.from([0xff, 0xfe])]) {
		await t.test(typeof contents === 'string' ? 'malformed JSON' : 'invalid UTF-8', async (child) => {
			const { rootDirectory } = await directory(child);
			await mkdir(rootDirectory, { mode: 0o700 });
			await writeFile(join(rootDirectory, `${uuid(1)}.json`), contents, { mode: 0o600 });
			await assert.rejects(createStore(rootDirectory).initialize(), code('CORRUPT_STORAGE'));
		});
	}
});

test('Native Chat rejects duplicate task and recovery identities across independent files', async (t) => {
	for (const duplicateRecovery of [false, true]) {
		await t.test(duplicateRecovery ? 'recovery identities' : 'task identities', async (child) => {
			const { rootDirectory } = await directory(child);
			const store = createStore(rootDirectory);
			await store.beginTask(start(1));
			await store.setRecovery(uuid(1), RECOVERY);
			await store.setStatus(uuid(1), 'completed');
			await store.beginTask(start(2, { continuation: RECOVERY }));
			await store.beginTask(start(3));
			const path = join(rootDirectory, `${uuid(3)}.json`);
			const other = JSON.parse(await readFile(path, 'utf8'));
			if (duplicateRecovery) {
				other.turns[0].recovery = RECOVERY;
			} else {
				other.turns[0].status = 'completed';
				other.turns[0].endedAt = AT;
				other.turns[0].recovery = { sessionUri: 'copilotcli:/other', chatUri: 'ahp-chat:/other' };
				other.turns.push({
					...other.turns[0], taskId: uuid(2), status: 'starting', endedAt: undefined,
				});
				other.requestHashes.push(other.requestHashes[0]);
			}
			await writeFile(path, JSON.stringify(other));
			await assert.rejects(createStore(rootDirectory).initialize(), code('CORRUPT_STORAGE'));
		});
	}
});

test('Native Chat bounds scans and reads and rejects unmanaged entry paths', async (t) => {
	for (const name of ['catalog.json', `${uuid(1)}.json.extra`, '01234567-89AB-4DEF-8123-456789ABCDEF.json']) {
		await t.test(name, async (child) => {
			const { rootDirectory } = await directory(child);
			await mkdir(rootDirectory, { mode: 0o700 });
			await writeFile(join(rootDirectory, name), '{}', { mode: 0o600 });
			await assert.rejects(createStore(rootDirectory).initialize(), code('UNSAFE_STORAGE'));
		});
	}
	await t.test('non-file entry', async (child) => {
		const { rootDirectory } = await directory(child);
		await mkdir(join(rootDirectory, `${uuid(1)}.json`), { recursive: true, mode: 0o700 });
		await assert.rejects(createStore(rootDirectory).initialize(), code('UNSAFE_STORAGE'));
	});
	await t.test('scan limit', async (child) => {
		const { rootDirectory } = await directory(child);
		await mkdir(rootDirectory, { mode: 0o700 });
		for (let index = 0; index < 12; index += 1) {
			await writeFile(join(rootDirectory, `${uuid(1)}.json.${uuid(100 + index)}.tmp`), '{', { mode: 0o600 });
		}
		await assert.rejects(createStore(rootDirectory, { maxSessions: 1 }).initialize(), code('CAPACITY'));
		assert.equal((await readdir(rootDirectory)).length, 12);
	});
	await t.test('oversized file is rejected before JSON parsing', async (child) => {
		const { rootDirectory } = await directory(child);
		await mkdir(rootDirectory, { mode: 0o700 });
		await writeFile(join(rootDirectory, `${uuid(1)}.json`), Buffer.alloc(2 * 1_024 * 1_024 + 1), { mode: 0o600 });
		await assert.rejects(createStore(rootDirectory).initialize(), code('CAPACITY'));
	});
});

test('Native Chat ignores bounded uncommitted staging files without deleting another writer data', async (t) => {
	const { rootDirectory } = await directory(t);
	await createStore(rootDirectory).beginTask(start(1));
	const name = `${uuid(1)}.json.${uuid(100)}.tmp`;
	await writeFile(join(rootDirectory, name), '{ incomplete staging data', { mode: 0o600 });
	const reopened = createStore(rootDirectory);
	await reopened.initialize();
	assert.equal(reopened.list().length, 1);
	await reopened.beginTask(start(2));
	assert.equal(await readFile(join(rootDirectory, name), 'utf8'), '{ incomplete staging data');
	assert.equal((await readdir(rootDirectory)).length, 3);
});

test('Native Chat rejects symlink roots and symlink ancestors', async (t) => {
	const { directory: scratch, rootDirectory } = await directory(t);
	const real = join(scratch, 'real');
	await mkdir(real, { mode: 0o700 });
	if (!await createSymlink(t, real, rootDirectory, 'dir')) {
		return;
	}
	await assert.rejects(createStore(rootDirectory).initialize(), code('UNSAFE_STORAGE'));
	await assert.rejects(createStore(join(rootDirectory, 'nested')).initialize(), code('UNSAFE_STORAGE'));
	assert.deepStrictEqual(await readdir(real), []);
});

test('Native Chat rejects symlink transcript and staging files instead of following or replacing them', async (t) => {
	const { directory: scratch, rootDirectory } = await directory(t);
	const outside = join(scratch, 'outside.json');
	await writeFile(outside, 'outside contents', { mode: 0o600 });
	await mkdir(rootDirectory, { mode: 0o700 });
	const path = join(rootDirectory, `${uuid(1)}.json`);
	if (!await createSymlink(t, outside, path, 'file')) {
		return;
	}
	await assert.rejects(createStore(rootDirectory).initialize(), code('UNSAFE_STORAGE'));
	assert.equal(await readFile(outside, 'utf8'), 'outside contents');
	await rm(path);
	const store = createStore(rootDirectory);
	await store.beginTask(start(1));
	await rm(path);
	await symlink(outside, path, 'file');
	await assert.rejects(store.append(uuid(1), { kind: 'output', text: 'Must not follow.' }), code('UNSAFE_STORAGE'));
	assert.equal(await readFile(outside, 'utf8'), 'outside contents');
	await rm(path);
	await symlink(outside, join(rootDirectory, `${uuid(1)}.json.${uuid(100)}.tmp`), 'file');
	await assert.rejects(createStore(rootDirectory).initialize(), code('UNSAFE_STORAGE'));
});

test('Native Chat uses owner-only POSIX modes and rejects unsafe existing modes', {
	skip: process.platform === 'win32',
}, async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	await store.beginTask(start(1));
	const path = join(rootDirectory, `${uuid(1)}.json`);
	assert.equal((await lstat(rootDirectory)).mode & 0o7777, 0o700);
	assert.equal((await lstat(path)).mode & 0o7777, 0o600);
	await chmod(path, 0o644);
	await assert.rejects(createStore(rootDirectory).initialize(), code('UNSAFE_STORAGE'));
	assert.equal((await lstat(path)).mode & 0o7777, 0o644);
	await chmod(path, 0o600);
	await chmod(rootDirectory, 0o755);
	await assert.rejects(createStore(rootDirectory).initialize(), code('UNSAFE_STORAGE'));
	assert.equal((await lstat(rootDirectory)).mode & 0o7777, 0o755);
});

test('Native Chat separate instances preserve independent sessions and refresh records before mutations', async (t) => {
	const { rootDirectory } = await directory(t);
	const first = createStore(rootDirectory);
	const second = createStore(rootDirectory);
	await Promise.all([first.initialize(), second.initialize()]);
	await Promise.all([first.beginTask(start(1)), second.beginTask(start(2))]);
	await Promise.all([
		first.append(uuid(1), { kind: 'output', text: 'First instance.' }),
		second.append(uuid(1), { kind: 'output', text: 'Second instance.' }),
	]);
	await first.archive(uuid(1), true);
	await second.setStatus(uuid(1), 'completed');
	const reopened = createStore(rootDirectory);
	await reopened.initialize();
	assert.equal(reopened.list().length, 2);
	assert.equal(reopened.get(uuid(1))!.archived, true);
	assert.equal(reopened.get(uuid(1))!.turns[0].status, 'completed');
	assert.deepStrictEqual(reopened.get(uuid(1))!.turns[0].entries.map((entry) => entry.text), [
		'First instance.', 'Second instance.',
	]);
	assert.equal(reopened.get(uuid(2))!.turns[0].status, 'starting');
});

test('Native Chat concurrent instance admission does not exceed the session count limit', async (t) => {
	const { rootDirectory } = await directory(t);
	const first = createStore(rootDirectory, { maxSessions: 1 });
	const second = createStore(rootDirectory, { maxSessions: 1 });
	await Promise.all([first.initialize(), second.initialize()]);
	const results = await Promise.allSettled([first.beginTask(start(1)), second.beginTask(start(2))]);
	assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
	const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
	assert.ok(code('CAPACITY')(rejected.reason));
	assert.equal((await readdir(rootDirectory)).length, 1);
});

test('Native Chat excludes other processes for complete mutation and admission transactions', { timeout: 30_000 }, async (t) => {
	const { directory: scratch } = await directory(t);
	await t.test('archive waits for output publication and neither acknowledged change is lost', async (child) => {
		const rootDirectory = join(scratch, 'archive-history');
		const original = await createStore(rootDirectory).beginTask(start(1));
		const writer = storeProcess(child, {
			rootDirectory, operation: 'append', taskId: uuid(1), count: 8, holdPublication: true,
		});
		const archiver = storeProcess(child, {
			rootDirectory, operation: 'archive', sessionId: uuid(1), archived: true,
		});
		await Promise.all([writer.waitFor('ready'), archiver.waitFor('ready')]);
		writer.send('run');
		await writer.waitFor('staged');
		archiver.send('run');
		await archiver.waitFor('contended');
		assert.equal(archiver.has('publishing'), false);
		assert.equal(archiver.has('done'), false);
		assert.equal((await lstat(join(rootDirectory, WRITE_LOCK_FILE_NAME))).size, 0);
		if (process.platform !== 'win32') {
			assert.equal((await lstat(join(rootDirectory, WRITE_LOCK_FILE_NAME))).mode & 0o7777, 0o600);
		}
		const reader = createStore(rootDirectory);
		await reader.initialize();
		assert.deepStrictEqual(reader.get(uuid(1)), original);
		writer.send('release');
		for (const result of await Promise.all([writer.waitFor('done'), archiver.waitFor('done')])) {
			assert.equal(result.ok, true, result.message);
		}
		assert.equal((await writer.exited).code, 0);
		assert.equal((await archiver.exited).code, 0);
		const reopened = createStore(rootDirectory);
		await reopened.initialize();
		const session = reopened.get(uuid(1))!;
		assert.equal(session.archived, true);
		assert.deepStrictEqual(session.turns[0].entries.map((entry) => entry.text),
			Array.from({ length: 8 }, (_, index) => `Acknowledged output ${index}.`));
		assert.deepStrictEqual(session.turns[0].entries.map((entry) => entry.sequence),
			Array.from({ length: 8 }, (_, index) => index + 1));
		assert.deepStrictEqual(await readdir(rootDirectory), [`${uuid(1)}.json`]);
	});

	await t.test('two initially empty processes cannot both admit the last session slot', async (child) => {
		const rootDirectory = join(scratch, 'admission-history');
		const first = storeProcess(child, {
			rootDirectory, maxSessions: 1, operation: 'begin', request: start(1), holdPublication: true,
		});
		const second = storeProcess(child, {
			rootDirectory, maxSessions: 1, operation: 'begin', request: start(2),
		});
		await Promise.all([first.waitFor('ready'), second.waitFor('ready')]);
		first.send('run');
		await first.waitFor('staged');
		second.send('run');
		await second.waitFor('contended');
		assert.equal(second.has('publishing'), false);
		first.send('release');
		assert.equal((await first.waitFor('done')).ok, true);
		const refused = await second.waitFor('done');
		assert.equal(refused.ok, false);
		assert.equal(refused.code, 'CAPACITY');
		assert.equal(second.has('publishing'), false);
		await Promise.all([first.exited, second.exited]);
		const reopened = createStore(rootDirectory, { maxSessions: 1 });
		await reopened.initialize();
		assert.deepStrictEqual(reopened.list().map((session) => session.id), [uuid(1)]);
		assert.deepStrictEqual(await readdir(rootDirectory), [`${uuid(1)}.json`]);
	});

	await t.test('a crashed writer leaves readable history and bounded explicit write refusal, not lock theft', async (child) => {
		const rootDirectory = join(scratch, 'crash-history');
		const original = await createStore(rootDirectory).beginTask(start(1));
		const writer = storeProcess(child, {
			rootDirectory, operation: 'append', taskId: uuid(1), count: 1, holdPublication: true,
		});
		await writer.waitFor('ready');
		writer.send('run');
		await writer.waitFor('staged');
		writer.send('crash');
		assert.equal((await writer.exited).code, 23);
		const lockPath = join(rootDirectory, WRITE_LOCK_FILE_NAME);
		const lockIdentity = await lstat(lockPath, { bigint: true });
		await utimes(lockPath, new Date('2000-01-01T00:00:00.000Z'), new Date('2000-01-01T00:00:00.000Z'));
		const names = (await readdir(rootDirectory)).sort();
		assert.equal(names.length, 3);
		assert.ok(names.includes(WRITE_LOCK_FILE_NAME));
		assert.ok(names.some((name) => name.endsWith('.tmp')));
		const contents = await Promise.all(names.map((name) => readFile(join(rootDirectory, name))));
		const reopened = createStore(rootDirectory);
		await reopened.initialize();
		assert.deepStrictEqual(reopened.get(uuid(1)), original);
		let notifications = 0;
		reopened.onDidChange(() => { notifications += 1; });
		await assert.rejects(reopened.archive(uuid(1), true), code('STORAGE_LOCKED'));
		await reopened.flush();
		assert.equal(notifications, 0);
		assert.deepStrictEqual(reopened.get(uuid(1)), original);
		assert.deepStrictEqual((await readdir(rootDirectory)).sort(), names);
		assert.deepStrictEqual(await Promise.all(names.map((name) => readFile(join(rootDirectory, name)))), contents);
		assert.equal((await lstat(lockPath, { bigint: true })).ino, lockIdentity.ino);
		const anotherReader = createStore(rootDirectory);
		await anotherReader.initialize();
		assert.deepStrictEqual(anotherReader.get(uuid(1)), original);
	});
});

test('Native Chat validates the managed lock artifact instead of following links or accepting arbitrary data', async (t) => {
	await t.test('nonempty lock', async (child) => {
		const { rootDirectory } = await directory(child);
		await createStore(rootDirectory).beginTask(start(1));
		const lockPath = join(rootDirectory, WRITE_LOCK_FILE_NAME);
		await writeFile(lockPath, 'not an empty write lock', { mode: 0o600 });
		await assert.rejects(createStore(rootDirectory).initialize(), code('UNSAFE_STORAGE'));
		await assert.rejects(createStore(rootDirectory).archive(uuid(1), true), code('UNSAFE_STORAGE'));
		assert.equal(await readFile(lockPath, 'utf8'), 'not an empty write lock');
	});
	await t.test('symlink lock', async (child) => {
		const { directory: scratch, rootDirectory } = await directory(child);
		await createStore(rootDirectory).beginTask(start(1));
		const outside = join(scratch, 'outside-lock');
		await writeFile(outside, '', { mode: 0o600 });
		const lockPath = join(rootDirectory, WRITE_LOCK_FILE_NAME);
		if (!await createSymlink(child, outside, lockPath, 'file')) {
			return;
		}
		await assert.rejects(createStore(rootDirectory).initialize(), code('UNSAFE_STORAGE'));
		await assert.rejects(createStore(rootDirectory).archive(uuid(1), true), code('UNSAFE_STORAGE'));
		assert.equal(await readFile(outside, 'utf8'), '');
		assert.equal((await lstat(lockPath)).isSymbolicLink(), true);
	});
	await t.test('unsafe POSIX lock permissions', { skip: process.platform === 'win32' }, async (child) => {
		const { rootDirectory } = await directory(child);
		await createStore(rootDirectory).beginTask(start(1));
		const lockPath = join(rootDirectory, WRITE_LOCK_FILE_NAME);
		await writeFile(lockPath, '', { mode: 0o644 });
		await assert.rejects(createStore(rootDirectory).initialize(), code('UNSAFE_STORAGE'));
		await assert.rejects(createStore(rootDirectory).archive(uuid(1), true), code('UNSAFE_STORAGE'));
		assert.equal((await lstat(lockPath)).mode & 0o7777, 0o644);
	});
});

test('Native Chat failed publication never removes a replacement lock or another writer staging file', async (t) => {
	const { rootDirectory } = await directory(t);
	const lockPath = join(rootDirectory, WRITE_LOCK_FILE_NAME);
	const otherTemporary = join(rootDirectory, `${uuid(2)}.json.${uuid(100)}.tmp`);
	const expected = new Error('injected publication failure after lock replacement');
	let replaceLock = false;
	const store = createStore(rootDirectory, {
		atomicRename: async (from, to) => {
			if (replaceLock) {
				await rm(lockPath);
				await writeFile(lockPath, '', { mode: 0o600 });
				await writeFile(otherTemporary, 'another writer staging data', { mode: 0o600 });
				throw expected;
			}
			await rename(from, to);
		},
	});
	await store.beginTask(start(1));
	const previous = store.get(uuid(1));
	const previousFile = await readFile(join(rootDirectory, `${uuid(1)}.json`), 'utf8');
	let notifications = 0;
	store.onDidChange(() => { notifications += 1; });
	replaceLock = true;
	await assert.rejects(store.append(uuid(1), { kind: 'output', text: 'Uncommitted output.' }),
		(error: unknown) => error instanceof AggregateError && error.errors.includes(expected)
			&& error.errors.some(code('STORAGE_CHANGED')));
	assert.equal(store.get(uuid(1)), previous);
	assert.equal(await readFile(join(rootDirectory, `${uuid(1)}.json`), 'utf8'), previousFile);
	assert.equal(notifications, 0);
	assert.equal((await lstat(lockPath)).size, 0);
	assert.equal(await readFile(otherTemporary, 'utf8'), 'another writer staging data');
	assert.equal((await readdir(rootDirectory)).length, 3);
});

test('Native Chat failed atomic publication preserves the previous record and emits no success', async (t) => {
	const { rootDirectory } = await directory(t);
	const expected = new Error('injected atomic rename failure');
	let fail = false;
	const store = createStore(rootDirectory, {
		atomicRename: async (from, to) => {
			if (fail) {
				throw expected;
			}
			await rename(from, to);
		},
	});
	let notifications = 0;
	store.onDidChange(() => { notifications += 1; });
	await store.beginTask(start(1));
	await store.append(uuid(1), { kind: 'output', text: 'Committed output.' });
	const previous = store.get(uuid(1));
	const path = join(rootDirectory, `${uuid(1)}.json`);
	const previousFile = await readFile(path, 'utf8');
	fail = true;
	await assert.rejects(store.append(uuid(1), { kind: 'output', text: 'Uncommitted output.' }), (error) => error === expected);
	await assert.rejects(store.setStatus(uuid(1), 'completed'), (error) => error === expected);
	await store.flush();
	assert.equal(store.get(uuid(1)), previous);
	assert.equal(await readFile(path, 'utf8'), previousFile);
	assert.equal(notifications, 2);
	assert.deepStrictEqual(await readdir(rootDirectory), [`${uuid(1)}.json`]);
	const reopened = createStore(rootDirectory);
	await reopened.initialize();
	assert.deepStrictEqual(reopened.get(uuid(1)), previous);
	fail = false;
	await store.append(uuid(1), { kind: 'output', text: 'Retry after failure.' });
	assert.equal(notifications, 3);
	assert.deepStrictEqual(store.get(uuid(1))!.turns[0].entries.map((entry) => entry.text), [
		'Committed output.', 'Retry after failure.',
	]);
});

test('Native Chat failed initial atomic publication leaves no fabricated record and can be retried', async (t) => {
	const { rootDirectory } = await directory(t);
	let fail = true;
	const store = createStore(rootDirectory, {
		atomicRename: async (from, to) => {
			if (fail) {
				throw new Error('injected initial publication failure');
			}
			await rename(from, to);
		},
	});
	let notifications = 0;
	store.onDidChange(() => { notifications += 1; });
	await assert.rejects(store.beginTask(start(1)), /injected initial publication failure/u);
	assert.deepStrictEqual(store.list(), []);
	assert.deepStrictEqual(await readdir(rootDirectory), []);
	assert.equal(notifications, 0);
	fail = false;
	await store.beginTask(start(1));
	assert.equal(store.list().length, 1);
	assert.equal(notifications, 1);
});

test('Native Chat post-publication directory-sync failure restores the prior committed data', async (t) => {
	const { rootDirectory } = await directory(t);
	const store = createStore(rootDirectory);
	await store.beginTask(start(1));
	const previous = store.get(uuid(1));
	const path = join(rootDirectory, `${uuid(1)}.json`);
	const previousFile = await readFile(path, 'utf8');
	let notifications = 0;
	store.onDidChange(() => { notifications += 1; });
	let syncs = 0;
	t.mock.method(store as unknown as { syncDirectory(): Promise<void> }, 'syncDirectory', async () => {
		syncs += 1;
		if (syncs === 1) {
			throw new Error('injected directory sync failure');
		}
	});
	await assert.rejects(store.setStatus(uuid(1), 'failed'), /injected directory sync failure/u);
	assert.equal(syncs, 2);
	assert.equal(store.get(uuid(1)), previous);
	assert.equal(await readFile(path, 'utf8'), previousFile);
	assert.equal(notifications, 0);
	assert.deepStrictEqual(await readdir(rootDirectory), [`${uuid(1)}.json`]);
});

test('Native Chat an invalid clock or unknown task fails without creating a replacement record', async (t) => {
	const { rootDirectory } = await directory(t);
	await assert.rejects(createStore(rootDirectory, { now: () => new Date('invalid') }).beginTask(start(1)), code('INVALID_INPUT'));
	const store = createStore(rootDirectory);
	await store.initialize();
	await assert.rejects(store.setStatus(uuid(99), 'completed'), code('NOT_FOUND'));
	await assert.rejects(store.recordAnswer(uuid(99), uuid(20)), code('NOT_FOUND'));
	await assert.rejects(store.setStatus(uuid(99), 'invented' as NativeChatTaskStatus), code('INVALID_INPUT'));
	assert.deepStrictEqual(store.list(), []);
	assert.deepStrictEqual(await readdir(rootDirectory), []);
});

function createStore(rootDirectory: string, options: Omit<NativeChatStoreOptions, 'rootDirectory'> = {}): NativeChatStore {
	return new NativeChatStore({ rootDirectory, now: () => new Date(AT), ...options });
}

function start(id: number, changes: Partial<NativeChatTaskStart> = {}): NativeChatTaskStart {
	return {
		taskId: uuid(id),
		title: 'Inspect the workspace',
		prompt: 'Inspect the workspace without changing files.',
		acceptanceCriteria: ['Report the findings.'],
		workspaceIdentity: WORKSPACE,
		workspaceName: 'repo',
		workspaceUri: 'file:///workspaces/repo',
		sourceLabel: 'Source window',
		generation: GENERATION,
		...changes,
	};
}

function uuid(value: number): string {
	return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function code(expected: NativeChatStoreErrorCode): (error: unknown) => boolean {
	return (error) => error instanceof NativeChatStoreError && error.code === expected;
}

async function directory(t: TestContext): Promise<{ directory: string; rootDirectory: string }> {
	const scratch = join(process.cwd(), `.native-chat-store-test-${randomUUID()}`);
	await mkdir(scratch, { mode: 0o700 });
	t.after(() => rm(scratch, { recursive: true, force: true }));
	return { directory: scratch, rootDirectory: join(scratch, 'history') };
}

async function createSymlink(t: TestContext, target: string, path: string, type: 'dir' | 'file'): Promise<boolean> {
	try {
		await symlink(target, path, type === 'dir' && process.platform === 'win32' ? 'junction' : type);
		return true;
	} catch (error) {
		if (process.platform === 'win32' && typeof error === 'object' && error !== null
			&& 'code' in error && error.code === 'EPERM') {
			t.skip('Windows file symlink creation requires Developer Mode or the symlink privilege.');
			return false;
		}
		throw error;
	}
}

type StoreProcessOptions = {
	readonly rootDirectory: string;
	readonly maxSessions?: number;
	readonly holdPublication?: boolean;
} & (
	| { readonly operation: 'begin'; readonly request: NativeChatTaskStart }
	| { readonly operation: 'append'; readonly taskId: string; readonly count: number }
	| { readonly operation: 'archive'; readonly sessionId: string; readonly archived: boolean }
);
interface StoreProcessEvent {
	readonly event: 'ready' | 'started' | 'contended' | 'publishing' | 'staged' | 'done';
	readonly ok?: boolean;
	readonly code?: string;
	readonly message?: string;
}

function storeProcess(t: TestContext, options: StoreProcessOptions) {
	const storeModule = require.resolve('../codespaces/nativeChat/NativeChatStore');
	const child = spawn(process.execPath, [
		...(storeModule.endsWith('.ts') ? ['--import', 'tsx'] : []),
		'-e', storeProcessProgram, storeModule, JSON.stringify(options),
	], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
	const events: StoreProcessEvent[] = [];
	const waiters = new Set<{
		event: StoreProcessEvent['event'];
		resolve: (value: StoreProcessEvent) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	let output = '';
	let closed = false;
	let processError: Error | undefined;
	const failed = (detail: string): Error => new Error(`${detail}\n${output}`);
	const rejectWaiters = (error: Error): void => {
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		waiters.clear();
	};
	for (const stream of [child.stdout, child.stderr]) {
		stream?.setEncoding('utf8');
		stream?.on('data', (chunk: string) => { output = `${output}${chunk}`.slice(-8_192); });
	}
	child.on('message', (message: unknown) => {
		if (!isStoreProcessEvent(message)) {
			processError = failed('Invalid Native Chat child-process test message.');
			rejectWaiters(processError);
			return;
		}
		events.push(message);
		for (const waiter of waiters) {
			if (waiter.event === message.event) {
				clearTimeout(waiter.timer);
				waiters.delete(waiter);
				waiter.resolve(message);
			}
		}
		if (message.event === 'done') {
			rejectWaiters(failed(`Native Chat child finished before the expected checkpoint: ${JSON.stringify(message)}`));
		}
	});
	child.on('error', (error) => {
		processError = error;
		rejectWaiters(error);
	});
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once('close', (exitCode, signal) => {
			closed = true;
			rejectWaiters(failed(`Native Chat child exited with code ${exitCode}, signal ${signal}.`));
			resolve({ code: exitCode, signal });
		});
	});
	t.after(async () => {
		if (!closed) {
			child.kill();
			await exited;
		}
	});
	return {
		exited,
		has: (event: StoreProcessEvent['event']) => events.some((message) => message.event === event),
		send: (message: 'run' | 'release' | 'crash') => {
			child.send(message, (error) => {
				if (error !== null) {
					processError = error;
					rejectWaiters(error);
				}
			});
		},
		waitFor: (event: StoreProcessEvent['event']): Promise<StoreProcessEvent> => {
			const seen = events.find((message) => message.event === event);
			if (seen !== undefined) {
				return Promise.resolve(seen);
			}
			if (processError !== undefined || closed || events.some((message) => message.event === 'done')) {
				return Promise.reject(processError ?? failed(`Native Chat child stopped before ${event}.`));
			}
			return new Promise((resolve, reject) => {
				const waiter = {
					event, resolve, reject,
					timer: setTimeout(() => {
						waiters.delete(waiter);
						reject(failed(`Timed out waiting for Native Chat child checkpoint ${event}.`));
					}, 10_000),
				};
				waiters.add(waiter);
			});
		},
	};
}

function isStoreProcessEvent(value: unknown): value is StoreProcessEvent {
	return typeof value === 'object' && value !== null && 'event' in value && typeof value.event === 'string'
		&& ['ready', 'started', 'contended', 'publishing', 'staged', 'done'].includes(value.event)
		&& (!('ok' in value) || typeof value.ok === 'boolean')
		&& (!('code' in value) || typeof value.code === 'string')
		&& (!('message' in value) || typeof value.message === 'string');
}

// Inline so both source (tsx) and compiled node:test runs use the same two-file
// fixture. The checkpoints pause exactly between the final check and rename.
const storeProcessProgram = `
const fileSystem = require('node:fs/promises');
const { once } = require('node:events');
const { join } = require('node:path');
const options = JSON.parse(process.argv[2]);
const send = (message) => new Promise((resolve, reject) => {
	process.send(message, (error) => error ? reject(error) : resolve());
});
const originalOpen = fileSystem.open;
let contended = false;
fileSystem.open = async (...args) => {
	try {
		return await originalOpen(...args);
	} catch (error) {
		if (!contended && error.code === 'EEXIST'
			&& args[0] === join(options.rootDirectory, '${WRITE_LOCK_FILE_NAME}')) {
			contended = true;
			await send({ event: 'contended' });
		}
		throw error;
	}
};
const { NativeChatStore } = require(process.argv[1]);
let firstPublication = true;
const store = new NativeChatStore({
	rootDirectory: options.rootDirectory,
	maxSessions: options.maxSessions,
	now: () => new Date('${AT}'),
	atomicRename: async (from, to) => {
		if (firstPublication) {
			firstPublication = false;
			await send({ event: 'publishing' });
			if (options.holdPublication) {
				const released = once(process, 'message');
				await send({ event: 'staged' });
				const [message] = await released;
				if (message === 'crash') {
					process.exit(23);
				}
			}
		}
		await fileSystem.rename(from, to);
	},
});
(async () => {
	try {
		await store.initialize();
		const run = once(process, 'message');
		await send({ event: 'ready' });
		await run;
		await send({ event: 'started' });
		if (options.operation === 'begin') {
			await store.beginTask(options.request);
		} else if (options.operation === 'archive') {
			await store.archive(options.sessionId, options.archived);
		} else {
			for (let index = 0; index < options.count; index += 1) {
				await store.append(options.taskId, { kind: 'output', text: 'Acknowledged output ' + index + '.' });
			}
		}
		await store.flush();
		await send({ event: 'done', ok: true });
	} catch (error) {
		await send({
			event: 'done', ok: false, message: String(error.message),
			...(typeof error.code === 'string' ? { code: error.code } : {}),
		});
	} finally {
		process.disconnect();
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
	if (process.connected) {
		process.disconnect();
	}
});
`;
