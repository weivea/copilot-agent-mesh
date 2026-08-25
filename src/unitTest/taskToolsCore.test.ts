import * as assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type {
	DelegationAcceptance,
	DelegationIntentInput,
	MeshWorkerDirectorySnapshot,
	PersistedDelegationIntent,
	TaskActionReceipt,
	TaskToolReadResult,
} from '../../shared/toolProtocol';
import { TaskToolFacade, TaskToolFacadeError } from '../tools/taskToolFacade';
import {
	fitToolResultToTokenBudget,
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

suite('TaskToolsCore', () => {
	test('lists only bounded opaque worker metadata', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);

		const result = await core.listWorkers({});

		assert.deepStrictEqual(result, {
			status: 'ok',
			workers: [{
				peerId: 'peer-1',
				deviceName: 'worker-one',
				capabilities: ['coding'],
				workspaces: [{
					workspaceId: 'workspace-1',
					name: 'app',
					tags: ['typescript'],
					busy: false,
				}],
			}],
			truncated: false,
		});
		assert.doesNotMatch(JSON.stringify(result), /\//);
	});

	test('preparation is pure and shows peer, workspace, and title only', () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);
		const input = delegationInput();

		const first = core.prepareDelegateInvocation(input);
		const second = core.prepareDelegateInvocation(input);

		assert.deepStrictEqual(first, second);
		assert.match(first.confirmationMessage, /Peer: peer-1/);
		assert.match(first.confirmationMessage, /Workspace: workspace-1/);
		assert.match(first.confirmationMessage, /Title: Fix scheduler/);
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
			delegationRequestId: 'request-1',
			taskId: 'task-1',
			recovered: false,
			pollTool: MESH_TOOL_NAMES.getTask,
			cancelTool: MESH_TOOL_NAMES.cancelTask,
		});
	});

	test('a cancelled acknowledgement wait retains intent and never requests remote cancellation', async () => {
		const facade = new RecordingFacade();
		facade.acceptance = new Promise(() => undefined);
		const cancellation = new ManualCancellation();
		const core = new TaskToolsCore(facade);
		const invocation = core.delegateTask(delegationInput(), cancellation);
		await Promise.resolve();
		await Promise.resolve();

		cancellation.cancel();
		const result = await invocation;

		assert.equal(result.status, 'cancelled');
		assert.equal(result.taskId, 'task-1');
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
		assert.equal(result.delegationRequestId, 'request-1');
		assert.equal(result.taskId, 'task-1');
		assert.equal(result.pollTool, MESH_TOOL_NAMES.getTask);
		assert.equal(result.cancelTool, MESH_TOOL_NAMES.cancelTask);
		assert.equal(facade.cancelCalls, 0);
	});

	test('a duplicate retry relies on durable Facade recovery and keeps the same IDs', async () => {
		const facade = new RecordingFacade();
		facade.persisted = {
			delegationRequestId: 'request-stable',
			taskId: 'task-stable',
			recovered: true,
		};
		const core = new TaskToolsCore(facade);

		const first = await core.delegateTask(delegationInput());
		const retry = await core.delegateTask(delegationInput());

		assert.equal(facade.persistCalls, 2);
		assert.equal(first.taskId, 'task-stable');
		assert.equal(retry.taskId, 'task-stable');
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
				sequence: index + 1,
				type: 'progress',
				at: '2026-08-25T00:00:00.000Z',
				summary: `event-${index}-${'y'.repeat(200)}`,
			})),
			eventGap: { expectedFrom: 1, availableFrom: 4 },
		};
		const core = new TaskToolsCore(facade, { outputByteLimit: 1_200 });

		const result = await core.getTask({ taskId: 'task-1', maxEvents: 10 });
		const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');

		assert.equal(result.status, 'ok');
		assert.equal(result.truncated, true);
		assert.deepStrictEqual(result.eventGap, { expectedFrom: 1, availableFrom: 4 });
		assert.ok(bytes <= 1_200);
		assert.ok((result.events as readonly unknown[]).length < 10);
	});

	test('cancel and answer use owner-scoped Facade methods', async () => {
		const facade = new RecordingFacade();
		const core = new TaskToolsCore(facade);

		const cancelled = await core.cancelTask({ taskId: 'task-1' });
		const answered = await core.answerTask({
			taskId: 'task-1',
			inputId: 'input-1',
			answerId: 'answer-1',
			answer: 'Proceed',
		});

		assert.deepStrictEqual(cancelled, {
			status: 'ok',
			taskId: 'task-1',
			taskStatus: 'cancelled',
		});
		assert.deepStrictEqual(answered, {
			status: 'ok',
			taskId: 'task-1',
			taskStatus: 'running',
		});
		assert.equal(facade.cancelCalls, 1);
		assert.equal(facade.answerCalls, 1);
	});

	test('accepts recovering and cancelling production task states', async () => {
		const facade = new RecordingFacade();
		facade.taskRead = {
			...facade.taskRead,
			snapshot: { ...facade.taskRead.snapshot, status: 'recovering' },
		};
		facade.cancelStatus = 'cancelling';
		const core = new TaskToolsCore(facade);

		const read = await core.getTask({ taskId: 'task-1' });
		const cancel = await core.cancelTask({ taskId: 'task-1' });

		assert.equal((read.snapshot as Record<string, unknown>).status, 'recovering');
		assert.equal(cancel.taskStatus, 'cancelling');
	});

	test('keeps durable IDs when acceptance fails after persistence', async () => {
		const facade = new RecordingFacade();
		facade.acceptance = Promise.reject(new TaskToolFacadeError('TUNNEL_UNAVAILABLE', true));
		const core = new TaskToolsCore(facade);

		const result = await core.delegateTask(delegationInput());

		assert.equal(result.status, 'error');
		assert.equal(result.delegationRequestId, 'request-1');
		assert.equal(result.taskId, 'task-1');
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
			taskId: 'task-1',
			inputId: 'input-1',
			answerId: 'answer-1',
			answer: '界'.repeat(11_000),
		});

		assert.equal(unknown.status, 'error');
		assert.equal(oversized.status, 'error');
		assert.equal(oversizedAnswer.status, 'error');
		assert.equal(facade.persistCalls, 0);
		assert.equal(facade.answerCalls, 0);
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

	test('rejects malformed Facade output instead of forwarding it', async () => {
		const facade = new RecordingFacade();
		const workerWithPath = {
			peerId: 'peer-1',
			deviceName: 'worker',
			capabilities: [],
			workspaces: [],
			localPath: '/private/path',
		};
		facade.workers = {
			workers: [workerWithPath],
		};
		const core = new TaskToolsCore(facade);

		const result = await core.listWorkers({});

		assert.equal(result.status, 'error');
		assert.equal((result.error as Record<string, unknown>).code, 'OUTPUT_INVALID');
		assert.doesNotMatch(JSON.stringify(result), /private|path/);
	});

	test('uses an exact tokenizer budget and truncates task events', async () => {
		const result = {
			status: 'ok',
			events: Array.from({ length: 8 }, (_, index) => ({ summary: `event-${index}-${'x'.repeat(80)}` })),
			truncated: false,
		};
		const countTokens = async (text: string): Promise<number> => text.length;

		const fitted = await fitToolResultToTokenBudget(result, 220, countTokens);

		assert.equal(fitted.status, 'ok');
		assert.equal(fitted.truncated, true);
		assert.ok((fitted.events as readonly unknown[]).length < result.events.length);
		assert.ok(await countTokens(JSON.stringify(fitted)) <= 220);
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
		peerId: 'peer-1',
		workspaceId: 'workspace-1',
		title: 'Fix scheduler',
		prompt: 'Implement the scheduler fix exactly as requested.',
		acceptanceCriteria: ['The focused tests pass.'],
		timeoutMinutes: 30,
	};
}

class RecordingFacade implements TaskToolFacade {
	workers: MeshWorkerDirectorySnapshot = {
		workers: [{
			peerId: 'peer-1',
			deviceName: 'worker-one',
			capabilities: ['coding'],
			workspaces: [{
				workspaceId: 'workspace-1',
				name: 'app',
				tags: ['typescript'],
				busy: false,
			}],
		}],
	};
	persisted: PersistedDelegationIntent = {
		delegationRequestId: 'request-1',
		taskId: 'task-1',
		recovered: false,
	};
	acceptance: Promise<DelegationAcceptance> = Promise.resolve({ status: 'accepted' });
	taskRead: TaskToolReadResult = {
		snapshot: {
			taskId: 'task-1',
			status: 'running',
			title: 'Fix scheduler',
			updatedAt: '2026-08-25T00:00:00.000Z',
			phase: 'implementation',
		},
		eventCursor: 2,
		events: [{
			sequence: 2,
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
	callOrder: string[] = [];
	lastAcceptanceSignal?: AbortSignal;

	async listWorkers(_signal: AbortSignal): Promise<MeshWorkerDirectorySnapshot> {
		if (this.listError !== undefined) {
			throw this.listError;
		}
		return this.workers;
	}

	async persistDelegationIntent(_intent: DelegationIntentInput): Promise<PersistedDelegationIntent> {
		this.persistCalls += 1;
		this.callOrder.push('persist');
		return this.persisted;
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
		return { taskId: request.taskId, status: this.cancelStatus };
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
		return { taskId: request.taskId, status: 'running' };
	}
}

class ManualClock implements ToolClock {
	private now = 0;
	private readonly sleepers: Array<{ dueAt: number; resolve: () => void }> = [];

	sleep(delayMs: number): Promise<void> {
		return new Promise((resolve) => {
			this.sleepers.push({ dueAt: this.now + delayMs, resolve });
		});
	}

	advanceBy(delayMs: number): void {
		this.now += delayMs;
		const ready = this.sleepers.filter(({ dueAt }) => dueAt <= this.now);
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
