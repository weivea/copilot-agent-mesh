import { AhpAgentRuntime, type AhpAgentRuntimeOptions } from './AhpAgentRuntime';
import {
	AgentRuntimeError,
	type AgentHostSourceFailure,
	type AgentHostSourceFailureStage,
	type AgentHostSourceStatus,
	type AgentHostSourceStatusProvider,
	type AgentRuntime,
	type AgentRuntimeProbe,
	type AgentTaskHandle,
	type AgentTaskRequest,
} from './AgentRuntime';
import { RetainedOwnedAgentHostLauncher } from './RetainedOwnedAgentHostLauncher';

export interface CodespaceOwnedAgentRuntimeOptions extends AhpAgentRuntimeOptions {}

type OwnedSourceStatus = Extract<AgentHostSourceStatus, { readonly source: 'codespace-owned' }>;

/** A dedicated owned backend, never an editor discovery or fallback policy. */
export class CodespaceOwnedAgentRuntime implements AgentRuntime, AgentHostSourceStatusProvider {
	private readonly launcher: RetainedOwnedAgentHostLauncher;
	private readonly runtime: AhpAgentRuntime;
	private readonly failureSubscription: { dispose(): void };
	private readonly listeners = new Set<(status: AgentHostSourceStatus) => void>();
	private status: OwnedSourceStatus = { source: 'codespace-owned', degraded: false };
	private disposed = false;
	private disposal: Promise<void> | undefined;

	public constructor(private readonly options: CodespaceOwnedAgentRuntimeOptions) {
		this.launcher = options.launcher instanceof RetainedOwnedAgentHostLauncher
			? options.launcher
			: new RetainedOwnedAgentHostLauncher(options.launcher);
		this.runtime = new AhpAgentRuntime({ ...options, launcher: this.launcher });
		this.failureSubscription = this.launcher.onDidFail((error) => this.recordFailure(error, 'task'));
		if (this.launcher.failure !== undefined) {
			this.recordFailure(this.launcher.failure, 'task');
		}
	}

	public sourceStatus(): AgentHostSourceStatus {
		return this.status;
	}

	public onDidSourceStatusChange(listener: (status: AgentHostSourceStatus) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	public async probe(request?: Pick<AgentTaskRequest, 'requireEditor'>): Promise<AgentRuntimeProbe> {
		const featureEnabled = this.options.enabled();
		if (this.disposed || !featureEnabled || request?.requireEditor === true) {
			return { available: false, featureEnabled, source: 'codespace-owned', reason: 'AGENT_UNAVAILABLE' };
		}
		try {
			const probe = await this.runtime.probe();
			if (this.launcher.failure !== undefined) {
				this.recordFailure(this.launcher.failure, 'task');
			} else if (!this.disposed && !probe.available) {
				this.recordFailure(new AgentRuntimeError('AGENT_UNAVAILABLE', 'The native Codespace CLI is unavailable.'), 'discovery');
			} else if (!this.disposed && this.status.failure?.stage === 'discovery') {
				this.setStatus({ source: 'codespace-owned', degraded: false });
			}
			const failure = this.status.failure;
			return {
				...probe,
				source: 'codespace-owned',
				available: probe.available && failure === undefined && !this.disposed,
				...(failure === undefined ? {} : {
					reason: failure.code,
					canStart: probe.available && this.launcher.failure === undefined && !this.disposed,
				}),
			};
		} catch (error: unknown) {
			this.recordFailure(error, 'discovery');
			return { available: false, featureEnabled, source: 'codespace-owned', reason: 'AGENT_UNAVAILABLE' };
		}
	}

	public async prepareStart(request?: Pick<AgentTaskRequest, 'requireEditor'>): Promise<void> {
		try {
			this.assertActive();
			if (request?.requireEditor === true) { throw backendMismatch(); }
			await this.runtime.prepareStart();
			this.assertActive();
		} catch (error: unknown) {
			this.recordFailure(error, 'discovery');
			throw error;
		}
	}

	public async start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		try {
			this.assertActive();
			if (request.requireEditor === true || request.executionBackend !== 'codespace-owned') {
				throw backendMismatch();
			}
			if (request.continuation !== undefined && !this.launcher.hasLiveHost) {
				throw new AgentRuntimeError(
					'TASK_RECOVERY_UNAVAILABLE',
					'The retained Codespace-owned Host is unavailable. Continuation cannot start a replacement Host.',
				);
			}
			const task = await this.runtime.start(request);
			try {
				this.assertActive();
			} catch (error: unknown) {
				try {
					await this.dispose();
				} catch {
					throw new AgentRuntimeError(
						'AGENT_UNAVAILABLE',
						'The Codespace-owned generation stopped during startup and its owned cleanup requires retry.',
						false,
						undefined,
						true,
					);
				}
				throw error;
			}
			this.setStatus({ source: 'codespace-owned', degraded: false });
			return task;
		} catch (error: unknown) {
			this.recordFailure(error, 'task');
			throw error;
		}
	}

	public async cancelStart(taskId: string): Promise<void> {
		try {
			await this.runtime.cancelStart(taskId);
		} catch (error: unknown) {
			this.recordFailure(error, 'task');
			throw error;
		}
	}

	public dispose(): Promise<void> {
		if (this.disposal === undefined) {
			this.disposed = true;
			const operation = this.runtime.dispose().then(() => {
				this.failureSubscription.dispose();
				this.listeners.clear();
			}).catch((error: unknown) => {
				this.recordFailure(error, 'task');
				this.disposal = undefined;
				throw error;
			});
			this.disposal = operation;
			this.recordFailure(new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Codespace-owned Agent runtime is disposed.'), 'task');
		}
		return this.disposal;
	}

	private assertActive(): void {
		if (this.disposed || !this.options.enabled()) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Codespace-owned Agent runtime is disabled or disposed.');
		}
		if (this.launcher.failure !== undefined) {
			throw new AgentRuntimeError(
				'TASK_RECOVERY_UNAVAILABLE',
				'The Codespace-owned Agent Host generation was lost. Automatic replacement is disabled.',
			);
		}
	}

	private recordFailure(error: unknown, stage: AgentHostSourceFailureStage): void {
		this.setStatus({ source: 'codespace-owned', degraded: false, failure: safeOwnedFailure(error, stage) });
	}

	private setStatus(status: OwnedSourceStatus): void {
		this.status = status;
		for (const listener of this.listeners) {
			try {
				listener(status);
			} catch {
				process.emitWarning('A Codespaces runtime status observer failed.', { code: 'MESH_CODESPACES_OBSERVER_FAILED' });
			}
		}
	}
}

function backendMismatch(): AgentRuntimeError {
	return new AgentRuntimeError(
		'AGENT_UNAVAILABLE',
		'Codespace tasks require the target-selected codespace-owned backend; editor execution is not available here.',
	);
}

function safeOwnedFailure(error: unknown, stage: AgentHostSourceFailureStage): AgentHostSourceFailure {
	const code = error instanceof AgentRuntimeError ? error.code : 'AGENT_UNAVAILABLE';
	switch (code) {
		case 'AGENT_AUTH_REQUIRED':
			return { code, stage: 'initialize', message: 'Native VS Code authentication is required for Codespace-owned Agent execution.' };
		case 'AGENT_AUTH_FAILED':
			return { code, stage: 'initialize', message: 'Codespace-owned Agent authentication failed.' };
		case 'AGENT_CONFIG_REQUIRED':
			return { code, stage: 'session', message: 'The Codespace-owned Agent provider must support folder-scoped Session configuration.' };
		case 'TASK_RECOVERY_UNAVAILABLE':
			return { code, stage: 'task', message: 'The Codespace-owned Agent runtime cannot safely resume the retained execution.' };
		case 'TASK_CANCELLATION_UNCONFIRMED':
			return { code, stage: 'task', message: 'The Codespace-owned Agent Host has not confirmed that the task stopped.' };
		case 'TASK_EXECUTION_FAILED':
			return { code, stage: 'task', message: 'Codespace-owned Agent task execution failed.' };
		default:
			return { code: 'AGENT_UNAVAILABLE', stage, message: 'The Codespace-owned Agent runtime is unavailable. Check its native CLI setup and execution generation.' };
	}
}
