import {
	AgentRuntimeError,
	type AgentHostSourceStatus,
	type AgentHostSourceStatusProvider,
	type AgentRuntime,
	type AgentRuntimeProbe,
} from '../agentHost/AgentRuntime';
import { MeshDomainError } from '../domain/errors';
import type { WindowNodeExecutor, WindowNodeWorkspaceSourceEntry } from '../node/WindowNodeClient';
import type { ResolvedFileIdentity } from '../workspaces/WorkspaceRegistry';

export interface CodespaceExecutionConnection extends WindowNodeExecutor {
	connect(): Promise<void>;
	listWorkspaces(): Promise<readonly WindowNodeWorkspaceSourceEntry[]>;
	resolveIdentity(uri: string): Promise<ResolvedFileIdentity>;
	probe(): Promise<AgentRuntimeProbe>;
}

export class DesktopCodespaceExecution implements WindowNodeExecutor {
	private failure: AgentRuntimeError | undefined;
	private readonly listeners = new Set<(status: AgentHostSourceStatus) => void>();
	public readonly runtime: AgentRuntime & AgentHostSourceStatusProvider & {
		failureDiagnostic(): { readonly code: string; readonly message: string } | undefined;
	};

	public constructor(
		private readonly connection: CodespaceExecutionConnection,
		private readonly reportError: (error: Error) => void,
	) {
		this.runtime = {
			probe: () => this.probe(),
			prepareStart: async () => {
				const probe = await this.probe();
				if (!probe.available && probe.canStart !== true) {
					throw this.failure ?? new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Codespaces runtime is unavailable.');
				}
			},
			start: async () => {
				throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'Codespaces tasks must use the authorized Window Node route.');
			},
			dispose: () => this.dispose(),
			sourceStatus: () => this.status(),
			onDidSourceStatusChange: (listener) => {
				this.listeners.add(listener);
				return { dispose: () => this.listeners.delete(listener) };
			},
			failureDiagnostic: () => this.failure === undefined
				? undefined : { code: this.failure.code, message: this.failure.message },
		};
	}

	public get generationClosed(): boolean {
		return this.connection.generationClosed === true;
	}

	public async initialize(): Promise<void> {
		try {
			await this.connection.connect();
		} catch (error: unknown) {
			if (!(error instanceof AgentRuntimeError) && !(error instanceof MeshDomainError)) {
				throw error;
			}
			this.unavailable(error);
		}
	}

	public listWorkspaces(): Promise<readonly WindowNodeWorkspaceSourceEntry[]> {
		// Unavailable setup is visible in the runtime status, never an executable claim.
		return this.failure === undefined ? this.connection.listWorkspaces() : Promise.resolve([]);
	}

	public resolveIdentity(uri: string): Promise<ResolvedFileIdentity> {
		this.assertAvailable();
		return this.connection.resolveIdentity(uri);
	}

	public start(...args: Parameters<WindowNodeExecutor['start']>): ReturnType<WindowNodeExecutor['start']> {
		this.assertAvailable();
		return this.connection.start(...args);
	}

	public answer(...args: Parameters<WindowNodeExecutor['answer']>): ReturnType<WindowNodeExecutor['answer']> {
		this.assertAvailable();
		return this.connection.answer(...args);
	}

	public cancel(...args: Parameters<WindowNodeExecutor['cancel']>): ReturnType<WindowNodeExecutor['cancel']> {
		this.assertAvailable();
		return this.connection.cancel(...args);
	}

	public async disposeTask(...args: Parameters<NonNullable<WindowNodeExecutor['disposeTask']>>): Promise<void> {
		this.assertAvailable();
		if (this.connection.disposeTask === undefined) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Codespaces companion cannot dispose the exact task.');
		}
		await this.connection.disposeTask(...args);
	}

	public async dispose(): Promise<void> {
		await this.connection.dispose();
		this.listeners.clear();
	}

	public unavailable(error: Error): void {
		this.failure = error instanceof AgentRuntimeError ? error : new AgentRuntimeError(
			'AGENT_UNAVAILABLE',
			'The Codespaces execution connection is unavailable. Prepare the runtime or reload this window.',
		);
		this.reportError(error);
		for (const listener of this.listeners) {
			listener(this.status());
		}
	}

	private async probe(): Promise<AgentRuntimeProbe> {
		if (this.failure !== undefined || this.generationClosed) {
			return {
				available: false, featureEnabled: true, source: 'codespace-owned',
				reason: this.failure?.code ?? 'AGENT_UNAVAILABLE',
			};
		}
		try {
			return { ...await this.connection.probe(), source: 'codespace-owned' };
		} catch (error: unknown) {
			if (!(error instanceof AgentRuntimeError) && !(error instanceof MeshDomainError)) {
				throw error;
			}
			this.unavailable(error);
			return {
				available: false, featureEnabled: true, source: 'codespace-owned', reason: 'AGENT_UNAVAILABLE',
			};
		}
	}

	private status(): AgentHostSourceStatus {
		return {
			source: 'codespace-owned',
			degraded: false,
			...(this.failure === undefined ? {} : {
				failure: { code: this.failure.code, stage: 'connection' as const, message: this.failure.message },
			}),
		};
	}

	private assertAvailable(): void {
		if (this.failure !== undefined) {
			throw this.failure;
		}
		if (this.generationClosed) {
			throw new AgentRuntimeError('TASK_RECOVERY_UNAVAILABLE', 'The Codespaces execution generation has ended.');
		}
	}
}
