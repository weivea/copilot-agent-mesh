import type { NodeTaskEventParams } from '../../../shared/protocol';
import {
	AgentRuntimeError, type AgentRuntime, type AgentTaskRequest, type WorkspaceResolver,
} from '../../agentHost/AgentRuntime';
import type { WindowNodeExecutor } from '../../node/WindowNodeClient';
import type { WindowNodeTaskEventSink } from '../../node/WindowNodeTaskExecutor';
import { redactRegisteredSensitiveValues } from '../../security/SensitiveValueRedaction';
import { containsCredentialText } from '../../ui/DashboardRedaction';
import { isTerminalChatTurn, type NativeChatControls } from './NativeChatProvider';
import type { NativeChatStore } from './NativeChatStore';

interface LiveTask {
	readonly generation: string;
	readonly cancel: () => Promise<void>;
}

export class NativeChatControlRegistry implements NativeChatControls {
	private readonly tasks = new Map<string, LiveTask>();
	private readonly listeners = new Set<() => void>();

	public isLive(generation: string, taskId: string): boolean {
		return this.tasks.get(taskId)?.generation === generation;
	}

	public readonly onDidChange = (listener: () => void): { dispose(): void } => {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	};

	public add(taskId: string, task: LiveTask): void {
		if (this.tasks.has(taskId)) { throw new Error('The Mesh Chat task already has a live execution owner.'); }
		this.tasks.set(taskId, task);
		this.fire();
	}

	public remove(taskId: string): void {
		if (this.tasks.delete(taskId)) { this.fire(); }
	}

	public async cancel(generation: string, taskId: string): Promise<void> {
		await this.requireTask(generation, taskId).cancel();
	}

	private requireTask(generation: string, taskId: string): LiveTask {
		const task = this.tasks.get(taskId);
		if (task === undefined || task.generation !== generation) {
			throw new Error('The Mesh task execution generation is no longer live.');
		}
		return task;
	}

	private fire(): void {
		for (const listener of [...this.listeners]) { listener(); }
	}
}

export interface NativeChatExecutionOptions {
	readonly generation: string;
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly workspaceResolver: WorkspaceResolver;
	readonly store: NativeChatStore;
	readonly controls: NativeChatControlRegistry;
	reportError(error: unknown): void;
}

/** Observes the executor's one event consumer, never the UI's lifetime. */
export class NativeChatExecution {
	private executor: WindowNodeExecutor | undefined;
	private readonly starts = new Map<string, { cancelled: boolean }>();
	private readonly ownedTasks = new Set<string>();
	private readonly historyFailures = new Set<string>();
	private readonly publications = new Map<string, Promise<void>>();
	private readonly answerGates = new Map<string, Set<Promise<void>>>();
	private closed = false;

	public constructor(private readonly options: NativeChatExecutionOptions) {}

	public runtime(runtime: AgentRuntime): AgentRuntime {
		return {
			probe: (request) => runtime.probe(request),
			prepareStart: async (request) => { await runtime.prepareStart?.(request); },
			start: async (request) => {
				if (this.closed) { throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Mesh Chat execution generation is closed.'); }
				const pending = { cancelled: false };
				this.starts.set(request.taskId, pending);
				try {
					await this.begin(request);
					if (pending.cancelled || this.closed) {
						throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The Mesh task was cancelled before runtime startup.');
					}
					const handle = await runtime.start(request);
					await this.record(request.taskId, async () => {
						await this.options.store.setRecovery(request.taskId, {
							sessionUri: handle.recovery.sessionUri, chatUri: handle.recovery.chatUri,
						});
						await this.options.store.setStatus(request.taskId, 'running');
					});
					const self = this;
					const redactor = new NativeTranscriptRedactor();
					return {
						taskId: handle.taskId,
						recovery: handle.recovery,
						events: (async function* () {
							try {
								for await (const event of handle.events) {
									while ((self.answerGates.get(request.taskId)?.size ?? 0) > 0) {
										await Promise.all(self.answerGates.get(request.taskId)!);
									}
									const output = event.type === 'output' ? redactor.write(event.text) : redactor.flush();
									if (output) {
										await self.record(request.taskId, () => self.options.store.append(
											request.taskId, { kind: 'output', text: output },
										));
									}
									yield event;
								}
							} finally {
								const output = redactor.flush();
								if (output) {
									await self.record(request.taskId, () => self.options.store.append(
										request.taskId, { kind: 'output', text: output },
									));
								}
							}
						})(),
						cancel: () => handle.cancel(),
						answer: (answer) => handle.answer(answer),
						dispose: () => handle.dispose(),
					};
				} finally {
					this.starts.delete(request.taskId);
				}
			},
			cancelStart: async (taskId) => {
				const pending = this.starts.get(taskId);
				if (pending !== undefined) { pending.cancelled = true; }
				await runtime.cancelStart?.(taskId);
			},
			dispose: () => runtime.dispose(),
		};
	}

	public eventSink(sink: WindowNodeTaskEventSink): WindowNodeTaskEventSink {
		return { publish: (event) => {
			const operation = Promise.resolve().then(async () => {
				await sink.publish(event);
				await this.recordEvent(event);
			});
			this.publications.set(event.taskId, operation);
			const clear = () => { if (this.publications.get(event.taskId) === operation) { this.publications.delete(event.taskId); } };
			void operation.then(clear, clear);
			return operation;
		} };
	}

	public readonly observeInputAnswer = async (taskId: string, inputId: string, answer: () => Promise<void>): Promise<void> => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const gates = this.answerGates.get(taskId) ?? new Set<Promise<void>>();
		gates.add(gate);
		this.answerGates.set(taskId, gates);
		try {
			await this.publications.get(taskId);
			await answer();
			await this.record(taskId, () => this.options.store.recordAnswer(taskId, inputId));
		} finally {
			gates.delete(gate);
			if (gates.size === 0) { this.answerGates.delete(taskId); }
			release();
		}
	};

	public attach(executor: WindowNodeExecutor): WindowNodeExecutor {
		if (this.executor !== undefined) { throw new Error('Mesh Chat execution already has an executor.'); }
		const wrapper: WindowNodeExecutor = {
			start: async (params) => {
				try { return await executor.start(params); } catch (error: unknown) {
					await this.record(params.taskId, async () => {
						const turn = this.options.store.sessionForTask(params.taskId)?.turns.at(-1);
						if (turn === undefined || isTerminalChatTurn(turn)) { return; }
						await this.options.store.append(params.taskId, {
							kind: 'error', text: 'Mesh task startup did not complete. See the source task and Codespaces output for diagnostics.',
						});
						await this.options.store.setStatus(params.taskId, 'failed');
					});
					this.options.controls.remove(params.taskId);
					throw error;
				}
			},
			cancel: (params) => executor.cancel(params),
			disposeTask: async (params) => { await executor.disposeTask?.(params); },
			answer: (params) => executor.answer(params),
			dispose: async () => {
				this.closed = true;
				for (const pending of this.starts.values()) { pending.cancelled = true; }
				try { await executor.dispose(); } finally {
					await this.record('generation', () => this.options.store.interruptGeneration(this.options.generation));
					for (const taskId of this.ownedTasks) { this.options.controls.remove(taskId); }
					this.ownedTasks.clear();
				}
			},
		};
		this.executor = wrapper;
		return wrapper;
	}

	private async begin(request: AgentTaskRequest): Promise<void> {
		const executor = this.executor;
		if (executor === undefined) { throw new Error('Mesh Chat execution must be attached before starting.'); }
		this.ownedTasks.add(request.taskId);
		this.options.controls.add(request.taskId, {
			generation: this.options.generation,
			cancel: () => executor.cancel({
				nodeId: this.options.nodeId, nodeInstanceId: this.options.nodeInstanceId, taskId: request.taskId,
			}),
		});
		await this.record(request.taskId, async () => {
			const workspace = await this.options.workspaceResolver.resolve(request.workspaceId);
			if (workspace?.workspaceIdentity === undefined) { throw new Error('A verified workspace identity is required for Mesh Chat history.'); }
			await this.options.store.beginTask({
				taskId: request.taskId,
				title: nativeTranscriptText(request.title),
				prompt: nativeTranscriptText(request.prompt),
				acceptanceCriteria: request.acceptanceCriteria?.map(nativeTranscriptText),
				sourceLabel: nativeTranscriptText(request.sourceWindowName ?? 'Mesh source'),
				workspaceIdentity: workspace.workspaceIdentity,
				workspaceName: nativeTranscriptText(workspace.displayName),
				workspaceUri: workspace.uri,
				generation: this.options.generation,
				...(request.continuation === undefined ? {} : { continuation: request.continuation }),
			});
		});
	}

	private async recordEvent(params: NodeTaskEventParams): Promise<void> {
		if (!this.ownedTasks.has(params.taskId)) { return; }
		const event = params.event;
		await this.record(params.taskId, async () => {
			switch (event.type) {
				case 'output': return;
				case 'inputRequired':
					await this.options.store.recordInput(params.taskId, event.inputId, nativeTranscriptText(event.prompt));
					return;
				case 'completed':
				case 'cancelled':
					await this.options.store.setStatus(params.taskId, event.type);
					return;
				case 'failed':
					await this.options.store.append(params.taskId, { kind: 'error', text: nativeTranscriptText(event.failure.message) });
					await this.options.store.setStatus(params.taskId, 'failed');
					return;
				default:
					await this.options.store.append(params.taskId, {
						kind: event.type === 'outputTruncated' ? 'progress' : event.type,
						text: nativeTranscriptText(event.summary),
					});
			}
		});
		if (event.type === 'completed' || event.type === 'cancelled' || event.type === 'failed') {
			this.options.controls.remove(params.taskId);
		}
	}

	private async record(taskId: string, operation: () => Promise<unknown>): Promise<void> {
		if (this.historyFailures.has(taskId)) { return; }
		try { await operation(); } catch (error: unknown) {
			// A presentation/storage failure is surfaced, not turned into a second
			// execution or a false failure of an already acknowledged Mesh event.
			this.historyFailures.add(taskId);
			this.options.reportError(new Error('Native Mesh Chat history could not be saved. The Mesh task channel remains authoritative.', { cause: error }));
		}
	}
}

export function nativeTranscriptText(value: string): string {
	const redacted = redactRegisteredSensitiveValues(value);
	return containsCredentialText(redacted) ? '[Sensitive or oversized transcript text omitted.]'
		: redacted.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

/** Keep the last line until the next line arrives so split credentials are never persisted chunk by chunk. */
export class NativeTranscriptRedactor {
	private pending = '';
	private suppressLine = false;
	private skipBlankLines = false;

	public write(text: string): string {
		if (this.suppressLine) {
			while (this.suppressLine) {
				const newline = text.indexOf('\n');
				if (newline < 0) {
					if (text.trim()) { this.skipBlankLines = false; }
					return '';
				}
				const line = text.slice(0, newline);
				text = text.slice(newline + 1);
				if (!this.skipBlankLines || line.trim()) { this.suppressLine = false; }
			}
		}
		this.pending += text;
		const safe = nativeTranscriptText(this.pending);
		if (safe !== this.pending) {
			this.skipBlankLines = /[:=]\s*$/u.test(this.pending);
			this.suppressLine = !this.pending.endsWith('\n') || this.skipBlankLines;
			this.pending = '';
			return safe;
		}
		const last = this.pending.lastIndexOf('\n');
		const previous = last <= 0 ? -1 : this.pending.lastIndexOf('\n', last - 1);
		if (previous < 0) { return ''; }
		const ready = this.pending.slice(0, previous + 1);
		this.pending = this.pending.slice(previous + 1);
		return ready;
	}

	public flush(): string {
		const result = nativeTranscriptText(this.pending);
		this.pending = '';
		return result;
	}
}
