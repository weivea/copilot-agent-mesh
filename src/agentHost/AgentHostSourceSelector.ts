import {
	AgentRuntimeError,
	type AgentHostSourceStatus,
	type AgentHostSourceStatusProvider,
	type AgentRuntimeApprovalCapabilityIssuer,
	type AgentRuntime,
	type AgentRuntimeProbe,
	type AgentTaskHandle,
	type AgentTaskRequest,
	type FirstTaskConfirmation,
	type WorkspaceResolver,
} from './AgentRuntime';
import type {
	AgentHostLauncherLike,
	AgentHostProbe,
	LaunchedAgentHost,
} from './AgentHostLauncher';
import {
	EditorAgentHostLocator,
	type LocatedEditorAgentHost,
} from './EditorAgentHostLocator';
import { UnixSocketWebSocketConnector } from './UnixSocketWebSocketConnector';

const borrowedEditorEndpoint = new URL('ws://editor-agent-host.invalid/');

export interface AgentHostSourceSelectorOptions {
	readonly preferEditor: () => boolean;
	readonly editor: AgentRuntime;
	readonly standalone: AgentRuntime;
	readonly confirmation: FirstTaskConfirmation;
	readonly workspaceResolver: WorkspaceResolver;
	readonly approvalCapabilities: AgentRuntimeApprovalCapabilityIssuer;
}

export class AgentHostSourceSelector implements AgentRuntime, AgentHostSourceStatusProvider {
	private readonly listeners = new Set<(status: AgentHostSourceStatus) => void>();
	private status: AgentHostSourceStatus = { source: 'standalone', degraded: false };
	private sourceSelected = false;
	private readonly inFlightStarts = new Set<{
		readonly controller: AbortController;
		readonly operation: Promise<AgentTaskHandle>;
	}>();
	private disposed = false;
	private disposal: Promise<void> | undefined;

	public constructor(private readonly options: AgentHostSourceSelectorOptions) {}

	public async probe(): Promise<AgentRuntimeProbe> {
		this.assertActive();
		if (!this.options.preferEditor()) {
			const probe = await this.options.standalone.probe();
			this.sourceSelected = true;
			this.setStatus({ source: 'standalone', degraded: false });
			return { ...probe, source: 'standalone', degradation: undefined };
		}
		if (this.sourceSelected) {
			const selected = this.status.source === 'editor'
				? await this.options.editor.probe()
				: await this.options.standalone.probe();
			return probeWithStatus(selected, this.status);
		}

		const editor = await this.options.editor.probe();
		if (editor.available) {
			this.setStatus({ source: 'editor', degraded: false });
			return probeWithStatus(editor, this.status);
		}
		const status = degradedStatus('EDITOR_DISCOVERY_FAILED');
		this.setStatus(status);
		const standalone = await this.options.standalone.probe();
		return probeWithStatus(standalone, status);
	}

	public start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		this.assertActive();
		const controller = new AbortController();
		let tracked!: {
			readonly controller: AbortController;
			readonly operation: Promise<AgentTaskHandle>;
		};
		const operation = this.startTracked(request, controller.signal)
			.finally(() => this.inFlightStarts.delete(tracked));
		tracked = { controller, operation };
		this.inFlightStarts.add(tracked);
		return operation;
	}

	private async startTracked(
		request: AgentTaskRequest,
		signal: AbortSignal,
	): Promise<AgentTaskHandle> {
		const approvedRequest = await this.approve(request, signal);
		try {
			throwIfSelectorAborted(signal);
			return await this.startApproved(approvedRequest);
		} finally {
			this.options.approvalCapabilities.revoke(approvedRequest.approvalCapability);
		}
	}

	private async startApproved(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		if (!this.options.preferEditor()) {
			const handle = await this.options.standalone.start(request);
			this.sourceSelected = true;
			this.setStatus({ source: 'standalone', degraded: false });
			return handle;
		}

		try {
			const handle = await this.options.editor.start(request);
			this.assertActive();
			this.sourceSelected = true;
			this.setStatus({ source: 'editor', degraded: false });
			return handle;
		} catch (error: unknown) {
			this.assertActive();
			if (!isFallbackEligible(error)) {
				throw error;
			}
		}

		const status = degradedStatus('EDITOR_START_FAILED');
		this.sourceSelected = true;
		this.setStatus(status);
		try {
			const handle = await this.options.standalone.start(request);
			this.assertActive();
			return handle;
		} catch (error: unknown) {
			const failed = degradedStatus('STANDALONE_START_FAILED');
			this.setStatus(failed);
			throw normalizeFallbackFailure(error);
		}
	}

	private async approve(request: AgentTaskRequest, signal: AbortSignal): Promise<AgentTaskRequest> {
		throwIfSelectorAborted(signal);
		if (this.options.approvalCapabilities.accepts(request)) {
			return request;
		}
		const workspace = await abortableSelectorOperation(
			this.options.workspaceResolver.resolve(request.workspaceId),
			signal,
		);
		throwIfSelectorAborted(signal);
		if (workspace === undefined || workspace.workspaceId !== request.workspaceId) {
			throw new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'The requested workspace is not registered on this device.',
			);
		}
		const confirmation = await abortableSelectorOperation(
			this.options.confirmation.confirm({ ...request, workspace }),
			signal,
		);
		throwIfSelectorAborted(signal);
		if (confirmation !== 'once') {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The local user denied this task.');
		}
		return {
			...request,
			approvalCapability: this.options.approvalCapabilities.issue(request),
		};
	}

	public sourceStatus(): AgentHostSourceStatus {
		return this.status;
	}

	public onDidSourceStatusChange(listener: (status: AgentHostSourceStatus) => void): {
		dispose(): void;
	} {
		this.listeners.add(listener);
		return {
			dispose: () => this.listeners.delete(listener),
		};
	}

	public dispose(): Promise<void> {
		this.disposed = true;
		this.listeners.clear();
		this.disposal ??= this.disposeRuntimes().finally(() => {
			if (!this.disposed) {
				this.disposal = undefined;
			}
		});
		return this.disposal;
	}

	private async disposeRuntimes(): Promise<void> {
		for (const start of this.inFlightStarts) {
			start.controller.abort();
		}
		const results = await Promise.allSettled([
			...[...this.inFlightStarts].map(({ operation }) => operation.catch(() => undefined)),
			this.options.editor.dispose(),
			this.options.standalone.dispose(),
		]);
		if (results.some(({ status }) => status === 'rejected')) {
			throw new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'One or more Agent Host source runtimes could not be disposed.',
				false,
				undefined,
				true,
			);
		}
	}

	private assertActive(): void {
		if (this.disposed) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Agent Host source selector has been disposed.');
		}
	}

	private setStatus(status: AgentHostSourceStatus): void {
		if (JSON.stringify(status) === JSON.stringify(this.status)) {
			return;
		}
		this.status = status;
		for (const listener of this.listeners) {
			try {
				listener(status);
			} catch {
				// Source observers are advisory and cannot take ownership from a started task.
			}
		}
	}
}

export class EditorAgentHostLauncher implements AgentHostLauncherLike {
	private readonly inFlight = new Set<{
		readonly controller: AbortController;
		readonly operation: Promise<LaunchedAgentHost>;
	}>();
	private disposed = false;

	public constructor(
		private readonly locator: EditorAgentHostLocator,
		private readonly connector: UnixSocketWebSocketConnector,
	) {}

	public probe(): Promise<AgentHostProbe> {
		if (this.disposed) {
			return Promise.resolve({ available: false });
		}
		return this.locator.probe();
	}

	public launch(signal?: AbortSignal): Promise<LaunchedAgentHost> {
		if (this.disposed) {
			return Promise.reject(new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'The editor Agent Host source has been disposed.',
			));
		}
		if (signal?.aborted === true) {
			return Promise.reject(new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'The editor Agent Host source launch was cancelled.',
			));
		}
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener('abort', abort, { once: true });
		let tracked!: {
			readonly controller: AbortController;
			readonly operation: Promise<LaunchedAgentHost>;
		};
		const operation = this.locator.locate(controller.signal)
			.then((located) => new BorrowedEditorAgentHost(located, this.connector))
			.catch(() => {
				throw new AgentRuntimeError(
					'AGENT_UNAVAILABLE',
					'The editor Agent Host endpoint is unavailable.',
				);
			})
			.finally(() => {
				signal?.removeEventListener('abort', abort);
				this.inFlight.delete(tracked);
			});
		tracked = { controller, operation };
		this.inFlight.add(tracked);
		return operation;
	}

	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const operation of this.inFlight) {
			operation.controller.abort();
		}
		await Promise.allSettled([...this.inFlight].map(({ operation }) => operation));
	}
}

class BorrowedEditorAgentHost implements LaunchedAgentHost {
	readonly endpoint = borrowedEditorEndpoint;
	readonly source = 'editor' as const;
	readonly preserveTerminalSession = true;
	readonly version: string;
	readonly registryProtocolVersion: string;

	public constructor(
		private readonly located: LocatedEditorAgentHost,
		private readonly connector: UnixSocketWebSocketConnector,
	) {
		this.version = located.version;
		this.registryProtocolVersion = located.registryProtocolVersion;
	}

	public openWebSocket(signal?: AbortSignal): ReturnType<LocatedEditorAgentHost['connect']> {
		return this.located.connect(this.connector, signal);
	}

	public onExit(): { dispose(): void } {
		return { dispose: () => undefined };
	}

	public async dispose(): Promise<void> {
		// The selector borrows the user's editor host and owns only its AHP connection.
		this.located.dispose();
	}
}

function degradedStatus(
	reason: Extract<AgentHostSourceStatus, { degraded: true }>['reason'],
): Extract<AgentHostSourceStatus, { degraded: true }> {
	const message = reason === 'EDITOR_DISCOVERY_FAILED'
		? 'Editor Agent Host discovery failed; standalone mode is in use.'
		: reason === 'EDITOR_START_FAILED'
			? 'Editor Agent Host startup failed; standalone mode is in use.'
			: 'Both editor and standalone Agent Host sources failed.';
	return {
		source: 'standalone',
		degraded: true,
		reason,
		message,
	};
}

function isFallbackEligible(error: unknown): boolean {
	return error instanceof AgentRuntimeError && error.code === 'AGENT_UNAVAILABLE';
}

function normalizeFallbackFailure(error: unknown): AgentRuntimeError {
	if (!(error instanceof AgentRuntimeError)) {
		return new AgentRuntimeError(
			'AGENT_UNAVAILABLE',
			'The editor Agent Host was unavailable and the standalone fallback failed.',
		);
	}
	const messages: Record<AgentRuntimeError['code'], string> = {
		AGENT_UNAVAILABLE: 'The editor Agent Host was unavailable and the standalone fallback failed.',
		AGENT_AUTH_REQUIRED: 'The standalone Agent Host fallback requires authentication.',
		AGENT_AUTH_FAILED: 'The standalone Agent Host fallback could not authenticate.',
		AGENT_CONFIG_REQUIRED: 'The standalone Agent Host fallback requires Session configuration.',
		TASK_EXECUTION_FAILED: 'The standalone Agent Host fallback could not start the task.',
		TASK_RECOVERY_UNAVAILABLE: 'The standalone Agent Host fallback could not recover the task.',
		TASK_CANCELLATION_UNCONFIRMED: 'The standalone Agent Host fallback could not confirm cancellation.',
	};
	return new AgentRuntimeError(
		error.code,
		messages[error.code],
		error.retryable,
		undefined,
		error.cleanupFailed,
	);
}

function probeWithStatus(
	probe: AgentRuntimeProbe,
	status: AgentHostSourceStatus,
): AgentRuntimeProbe {
	return {
		...probe,
		source: status.source,
		degradation: status.degraded
			? {
				reason: status.reason,
				message: status.message,
			}
			: undefined,
	};
}

function throwIfSelectorAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new AgentRuntimeError(
			'AGENT_UNAVAILABLE',
			'The Agent Host source selection was cancelled during shutdown.',
		);
	}
}

function abortableSelectorOperation<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	throwIfSelectorAborted(signal);
	return new Promise<T>((resolve, reject) => {
		const handleAbort = () => {
			signal.removeEventListener('abort', handleAbort);
			reject(new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'The Agent Host source selection was cancelled during shutdown.',
			));
		};
		signal.addEventListener('abort', handleAbort, { once: true });
		void operation.then(
			(value) => {
				signal.removeEventListener('abort', handleAbort);
				if (!signal.aborted) {
					resolve(value);
				}
			},
			(error: unknown) => {
				signal.removeEventListener('abort', handleAbort);
				if (!signal.aborted) {
					reject(error);
				}
			},
		);
	});
}
