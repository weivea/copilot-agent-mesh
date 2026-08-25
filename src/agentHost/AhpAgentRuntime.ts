import { randomUUID } from 'node:crypto';

import type {
	ActionEnvelope,
	AgentInfo,
	ProtectedResourceMetadata,
	RootState,
	SessionConfigSchema,
	SessionState,
	Snapshot,
	StateAction,
	TerminalInfo,
} from '@microsoft/agent-host-protocol' with { 'resolution-mode': 'import' };

import { AhpEventMapper } from './AhpEventMapper';
import {
	AgentRuntimeError,
	AsyncEventQueue,
	type AgentRecoveryDescriptor,
	type AgentRuntime,
	type AgentRuntimeEvent,
	type AgentRuntimeProbe,
	type AgentTaskAnswer,
	type AgentTaskHandle,
	type AgentTaskRequest,
	type FirstTaskConfirmation,
	type ResolvedAgentTaskRequest,
	type WorkspaceResolver,
} from './AgentRuntime';
import type { AgentHostLauncherLike, LaunchedAgentHost } from './AgentHostLauncher';
import type { AuthBroker, ProtectedResource } from './AuthBroker';

const rootUri = 'ahp-root://';
const sessionReadyTimeoutMs = 60_000;
const cancellationTimeoutMs = 15_000;

interface AuthenticationInFlight {
	readonly reason: 'initial' | 'challenge' | 'tokenInvalid';
	readonly interactive: boolean;
	readonly promise: Promise<void>;
}

interface ConnectionGeneration {
	readonly connection: AhpConnection;
	readonly subscriptions: Map<string, AhpSubscription>;
	readonly abort: AbortController;
	valid: boolean;
}

export interface AhpSubscriptionEvent {
	readonly type: 'action' | 'authRequired';
	readonly params: unknown;
}

export interface AhpSubscription extends AsyncIterable<AhpSubscriptionEvent> {
	close(): Promise<void>;
}

export interface AhpInitializeResult {
	readonly protocolVersion: string;
	readonly serverSeq: number;
	readonly snapshots: readonly Snapshot[];
}

export interface AhpConnection {
	initialize(clientId: string): Promise<AhpInitializeResult>;
	reconnect(clientId: string, lastSeenServerSeq: number, subscriptions: readonly string[]): Promise<{
		readonly type: 'replay' | 'snapshot';
		readonly actions?: readonly ActionEnvelope[];
		readonly snapshots?: readonly Snapshot[];
		readonly missing?: readonly string[];
	}>;
	attachSubscription(uri: string): AhpSubscription;
	subscribe(uri: string, signal?: AbortSignal): Promise<{ readonly snapshot?: Snapshot; readonly subscription: AhpSubscription }>;
	authenticate(resource: string, token: string, scopes: readonly string[]): Promise<void>;
	resolveSessionConfig(provider: string, workingDirectory: string, config: Readonly<Record<string, unknown>>): Promise<{
		readonly schema: SessionConfigSchema;
		readonly values: Record<string, unknown>;
	}>;
	sessionConfigCompletions(
		provider: string,
		workingDirectory: string,
		config: Readonly<Record<string, unknown>>,
		property: string,
		query: string,
	): Promise<readonly { readonly value: string; readonly label: string }[]>;
	createSession(params: {
		readonly sessionUri: string;
		readonly provider: string;
		readonly workingDirectories: readonly string[];
		readonly config: Readonly<Record<string, unknown>>;
		readonly clientId: string;
	}): Promise<void>;
	listSessions(): Promise<readonly { readonly resource: string }[]>;
	dispatch(channel: string, action: unknown, clientSeq?: number): number;
	unsubscribe(uri: string): Promise<void>;
	disposeSession(uri: string): Promise<void>;
	shutdown(): Promise<void>;
}

export interface AhpConnectionFactory {
	connect(endpoint: URL, signal?: AbortSignal): Promise<AhpConnection>;
}

export interface SessionConfigurationResolver {
	resolve(request: {
		readonly schema: SessionConfigSchema;
		readonly values: Readonly<Record<string, unknown>>;
		readonly interactive: boolean;
		readonly completions: (
			property: string,
			currentValues: Readonly<Record<string, unknown>>,
			query: string,
			signal?: AbortSignal,
		) => Promise<readonly {
			readonly value: string;
			readonly label: string;
		}[]>;
	}): Promise<Readonly<Record<string, unknown>>>;
}

export interface AhpAgentRuntimeOptions {
	readonly enabled: () => boolean;
	readonly launcher: AgentHostLauncherLike;
	readonly connections: AhpConnectionFactory;
	readonly authBroker: AuthBroker;
	readonly confirmation: FirstTaskConfirmation;
	readonly workspaceResolver: WorkspaceResolver;
	readonly configResolver?: SessionConfigurationResolver;
	readonly cancellationTimeoutMs?: number;
}

export class AhpAgentRuntime implements AgentRuntime {
	private readonly tasks = new Set<AhpTask>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(private readonly options: AhpAgentRuntimeOptions) {}

	async probe(): Promise<AgentRuntimeProbe> {
		if (!this.options.enabled()) {
			return { available: false, featureEnabled: false, reason: 'AGENT_UNAVAILABLE' };
		}
		const result = await this.options.launcher.probe();
		return {
			available: result.available,
			featureEnabled: true,
			version: result.version,
			reason: result.available ? undefined : 'AGENT_UNAVAILABLE',
		};
	}

	async start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		if (this.disposed || !this.options.enabled()) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The production Agent Host runtime is disabled.');
		}
		validateRequest(request);
		const workspace = await this.options.workspaceResolver.resolve(request.workspaceId);
		this.throwIfDisposed();
		if (workspace === undefined) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The requested workspace is not registered on this device.');
		}
		validateWorkspace(request.workspaceId, workspace);
		const resolvedRequest: ResolvedAgentTaskRequest = { ...request, workspace };
		if (await this.options.confirmation.confirm(resolvedRequest) === 'deny') {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The local user denied this task.');
		}
		this.throwIfDisposed();

		const host = await this.options.launcher.launch();
		if (this.disposed) {
			const cleanup = await cleanupDetachedResources(host, undefined);
			const error = new AgentRuntimeError('AGENT_UNAVAILABLE', 'The production Agent Host runtime was disposed during startup.');
			throw cleanup === undefined ? error : combineRuntimeErrors(error, cleanup);
		}
		let connection: AhpConnection | undefined;
		let task: AhpTask | undefined;
		try {
			connection = await this.options.connections.connect(host.endpoint);
			this.throwIfDisposed();
			const createdTask = new AhpTask(
				resolvedRequest,
				host,
				connection,
				this.options.connections,
				this.options.authBroker,
				this.options.configResolver ?? new DefaultSessionConfigurationResolver(),
				this.options.cancellationTimeoutMs ?? cancellationTimeoutMs,
				() => this.tasks.delete(createdTask),
			);
			task = createdTask;
			this.tasks.add(createdTask);
			await createdTask.start();
			this.throwIfDisposed();
			return createdTask;
		} catch (error) {
			const primary = normalizeRuntimeError(error);
			let cleanupError: AgentRuntimeError | undefined;
			try {
				if (task !== undefined) {
					await task.dispose();
				} else {
					cleanupError = await cleanupDetachedResources(host, connection);
				}
			} catch (cleanup) {
				cleanupError = normalizeRuntimeError(cleanup);
			}
			throw cleanupError === undefined ? primary : combineRuntimeErrors(primary, cleanupError);
		}
	}

	dispose(): Promise<void> {
		if (this.disposePromise === undefined) {
			const operation = this.disposeResources();
			this.disposePromise = operation;
			void operation.catch(() => {
				if (this.disposePromise === operation) {
					this.disposePromise = undefined;
				}
			});
		}
		return this.disposePromise;
	}

	private async disposeResources(): Promise<void> {
		this.disposed = true;
		const failures: string[] = [];
		await collectCleanupFailures(
			[...this.tasks].map((task) => ({
				label: 'dispose active Agent Host task',
				run: () => task.dispose(),
			})),
			failures,
		);
		await collectCleanupFailures([
			{ label: 'dispose Agent Host launcher', run: () => this.options.launcher.dispose() },
		], failures);
		if (failures.length > 0) {
			throw cleanupFailure(failures);
		}
	}

	private throwIfDisposed(): void {
		if (this.disposed) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The production Agent Host runtime has been disposed.');
		}
	}
}

export class SdkAhpConnectionFactory implements AhpConnectionFactory {
	async connect(endpoint: URL, signal?: AbortSignal): Promise<AhpConnection> {
		if (typeof globalThis.WebSocket !== 'function') {
			throw new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'The VS Code Extension Host does not provide the WebSocket transport required by AHP.',
			);
		}
		const socket = await connectWebSocket(endpoint, 10_000, signal);
		const [{ AhpClient }, { WebSocketTransport }, protocol] = await Promise.all([
			import('@microsoft/agent-host-protocol/client'),
			import('@microsoft/agent-host-protocol/ws'),
			import('@microsoft/agent-host-protocol'),
		]);
		if (signal?.aborted === true) {
			socket.close();
			throw new RecoveryStoppedCause();
		}
		const client = new AhpClient(WebSocketTransport.fromSocket(socket), { requestTimeoutMs: 30_000 });
		client.connect();
		return new SdkAhpConnection(client, protocol.SUPPORTED_PROTOCOL_VERSIONS);
	}
}

class SdkAhpConnection implements AhpConnection {
	constructor(
		private readonly client: import(
			'@microsoft/agent-host-protocol/client',
			{ with: { 'resolution-mode': 'import' } }
		).AhpClient,
		private readonly supportedVersions: readonly string[],
	) {}

	async initialize(clientId: string): Promise<AhpInitializeResult> {
		return this.client.initialize({
			clientId,
			protocolVersions: this.supportedVersions,
			initialSubscriptions: [rootUri],
			locale: 'en-US',
		});
	}

	async reconnect(clientId: string, lastSeenServerSeq: number, subscriptions: readonly string[]): Promise<{
		readonly type: 'replay' | 'snapshot';
		readonly actions?: readonly ActionEnvelope[];
		readonly snapshots?: readonly Snapshot[];
		readonly missing?: readonly string[];
	}> {
		return this.client.reconnect({ clientId, lastSeenServerSeq, subscriptions });
	}

	attachSubscription(uri: string): AhpSubscription {
		return adaptSubscription(this.client.attachSubscription(uri));
	}

	async subscribe(uri: string, signal?: AbortSignal): Promise<{
		readonly snapshot?: Snapshot;
		readonly subscription: AhpSubscription;
	}> {
		throwIfAborted(signal);
		const result = await this.client.subscribe(uri);
		if (signal?.aborted === true) {
			await result.subscription.close().catch(() => undefined);
			await this.client.unsubscribe(uri).catch(() => undefined);
			throw new RecoveryStoppedCause();
		}
		return { snapshot: result.result.snapshot, subscription: adaptSubscription(result.subscription) };
	}

	async authenticate(resource: string, token: string, scopes: readonly string[]): Promise<void> {
		await this.client.request('authenticate', {
			channel: rootUri,
			resource,
			token,
			scopes: [...scopes],
		});
	}

	async resolveSessionConfig(
		provider: string,
		workingDirectory: string,
		config: Readonly<Record<string, unknown>>,
	): Promise<{ readonly schema: SessionConfigSchema; readonly values: Record<string, unknown> }> {
		return this.client.request('resolveSessionConfig', {
			channel: rootUri,
			provider,
			workingDirectory,
			config: { ...config },
		});
	}

	async sessionConfigCompletions(
		provider: string,
		workingDirectory: string,
		config: Readonly<Record<string, unknown>>,
		property: string,
		query: string,
	): Promise<readonly { readonly value: string; readonly label: string }[]> {
		const result = await this.client.sessionConfigCompletions({
			provider,
			workingDirectory,
			config: { ...config },
			property,
			query,
		});
		return result.items;
	}

	async createSession(params: {
		readonly sessionUri: string;
		readonly provider: string;
		readonly workingDirectories: readonly string[];
		readonly config: Readonly<Record<string, unknown>>;
		readonly clientId: string;
	}): Promise<void> {
		await this.client.request('createSession', {
			channel: params.sessionUri,
			provider: params.provider,
			workingDirectories: [...params.workingDirectories],
			config: { ...params.config },
			activeClient: {
				clientId: params.clientId,
				displayName: 'Copilot Agent Mesh',
				tools: [],
			},
			progressToken: randomUUID(),
		});
	}

	async listSessions(): Promise<readonly { readonly resource: string }[]> {
		const result = await this.client.request('listSessions', { channel: rootUri, limit: 200 });
		return result.items.map(({ resource }) => ({ resource }));
	}

	dispatch(channel: string, action: unknown, clientSeq?: number): number {
		return this.client.dispatch(channel, action as StateAction, clientSeq).clientSeq;
	}

	async unsubscribe(uri: string): Promise<void> {
		await this.client.unsubscribe(uri);
	}

	async disposeSession(uri: string): Promise<void> {
		await this.client.request('disposeSession', { channel: uri });
	}

	async shutdown(): Promise<void> {
		await this.client.shutdown();
	}
}

class DefaultSessionConfigurationResolver implements SessionConfigurationResolver {
	async resolve(
		request: Parameters<SessionConfigurationResolver['resolve']>[0],
	): Promise<Readonly<Record<string, unknown>>> {
		const values: Record<string, unknown> = { ...request.values };
		for (const [id, property] of Object.entries(request.schema.properties)) {
			if (values[id] !== undefined) {
				continue;
			}
			if (property.default !== undefined) {
				values[id] = property.default;
			} else if (property.enum?.length === 1) {
				values[id] = property.enum[0];
			} else if (property.enumDynamic === true) {
				if (!request.interactive) {
					throw new AgentRuntimeError(
						'AGENT_CONFIG_REQUIRED',
						`Agent session configuration requires an interactive value for: ${id}.`,
					);
				}
				const options = await request.completions(id, values, '');
				if (options.length === 1) {
					values[id] = options[0]?.value;
				}
			}
		}
		const missing = request.schema.required?.filter((id) => values[id] === undefined) ?? [];
		if (missing.length > 0) {
			throw new AgentRuntimeError(
				'AGENT_CONFIG_REQUIRED',
				`Agent session configuration requires explicit values for: ${missing.join(', ')}.`,
			);
		}
		return values;
	}
}

class AhpTask implements AgentTaskHandle {
	readonly events = new AsyncEventQueue<AgentRuntimeEvent>();
	readonly taskId: string;
	private readonly mapper = new AhpEventMapper();
	private readonly clientId = `copilot-agent-mesh-${randomUUID()}`;
	private readonly sessionUri = `ahp-session:/${randomUUID()}`;
	private subscriptions = new Map<string, AhpSubscription>();
	private readonly staleConnections = new Set<AhpConnection>();
	private connection: AhpConnection;
	private chatUri: string | undefined;
	private turnId: string | undefined;
	private provider: AgentInfo | undefined;
	private sessionReady = false;
	private sessionDefaultChat: string | undefined;
	private sessionDefaultChatState: 'unknown' | 'available' | 'cleared' = 'unknown';
	private sessionDefaultChatRevision = 0;
	private sessionCreated = false;
	private lastSeenServerSeq = 0;
	private terminal = false;
	private disposed = false;
	private recovering = false;
	private readyResolve: (() => void) | undefined;
	private readyReject: ((error: Error) => void) | undefined;
	private defaultChatResolve: ((uri: string) => void) | undefined;
	private defaultChatReject: ((error: Error) => void) | undefined;
	private cancellationTimer: NodeJS.Timeout | undefined;
	private exitSubscription: { dispose(): void } | undefined;
	private disposePromise: Promise<void> | undefined;
	private readonly authenticationInFlight = new WeakMap<AhpConnection, Map<string, AuthenticationInFlight>>();
	private readonly pendingAuthNotifications = new Set<Promise<void>>();
	private readonly authenticationAbort = new AbortController();
	private terminalError: AgentRuntimeError | undefined;
	private rootTerminals: readonly TerminalInfo[] = [];
	private readonly terminalSubscriptionUpdates = new Map<AhpConnection, Promise<void>>();
	private readonly unacknowledgedDispatches = new Map<number, {
		readonly channel: string;
		readonly action: unknown;
		readonly requestId?: string;
	}>();
	private nextClientSeq = 1;
	private recoveryAbort: AbortController | undefined;
	private recoveryPromise: Promise<void> | undefined;
	private generation: ConnectionGeneration;
	private subscriptionCleanup: Map<string, {
		readonly subscription: AhpSubscription;
		closed: boolean;
		unsubscribed: boolean;
	}> | undefined;
	private terminalUpdatesSettled = false;
	private sessionDisposed = false;
	private connectionShutdown = false;
	private hostDisposed = false;
	private readonly shutdownConnections = new WeakSet<AhpConnection>();
	private readonly connectionShutdownOperations = new WeakMap<AhpConnection, Promise<void>>();
	private readonly deliveredResponsePartLengths = new Map<string, number>();
	private readonly deliveredResponsePartStates = new Set<string>();
	private readonly deliveredResponsePartOrdinals = new Map<string, number>();
	private readonly retainedRecoveryCandidates = new Set<RecoveryCandidateCleanup>();

	constructor(
		private readonly request: ResolvedAgentTaskRequest,
		private readonly host: LaunchedAgentHost,
		connection: AhpConnection,
		private readonly connectionFactory: AhpConnectionFactory,
		private readonly authBroker: AuthBroker,
		private readonly configResolver: SessionConfigurationResolver,
		private readonly cancelTimeoutMs: number,
		private readonly didDispose: () => void,
	) {
		this.taskId = request.taskId;
		this.connection = connection;
		this.generation = {
			connection,
			subscriptions: this.subscriptions,
			abort: new AbortController(),
			valid: true,
		};
	}

	get recovery(): AgentRecoveryDescriptor {
		return {
			clientId: this.clientId,
			sessionUri: this.sessionUri,
			chatUri: this.chatUri ?? '',
			lastSeenServerSeq: this.lastSeenServerSeq,
		};
	}

	async start(): Promise<void> {
		this.exitSubscription = this.host.onExit((error) => this.fail(error));
		const rootSubscription = this.connection.attachSubscription(rootUri);
		this.subscriptions.set(rootUri, rootSubscription);
		const initialized = await this.connection.initialize(this.clientId);
		this.throwIfTerminalError();
		this.lastSeenServerSeq = initialized.serverSeq;
		const rootSnapshot = initialized.snapshots.find(({ resource }) => resource === rootUri);
		if (rootSnapshot === undefined) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'AHP initialize did not return the root snapshot.');
		}
		const root = parseRootState(rootSnapshot);
		this.provider = selectProvider(root.agents, this.request.providerId);
		this.rootTerminals = root.terminals ?? [];
		this.startSubscription(rootUri, rootSubscription, this.generation);
		await this.authenticate(this.provider.protectedResources ?? [], 'initial', this.request.allowInteractiveAuthentication === true);
		this.throwIfTerminalError();
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		this.throwIfTerminalError();
		await this.drainAuthNotifications();
		this.throwIfTerminalError();

		const config = await this.resolveConfig();
		this.throwIfTerminalError();
		await this.withAuthenticationRetry(
			() => this.connection.createSession({
				sessionUri: this.sessionUri,
				provider: this.provider!.provider,
				workingDirectories: [this.request.workspace.uri],
				config,
				clientId: this.clientId,
			}),
			'challenge',
		);
		this.sessionCreated = true;
		this.throwIfTerminalError();

		await this.ensureStartupSubscription(this.sessionUri);
		await Promise.all([
			this.waitForReady(),
			this.waitForDefaultChat(),
		]);
		this.throwIfTerminalError();
		await this.waitForStartupRecovery();
		while (true) {
			const defaultChat = await this.ensureStartupChatSubscription();
			const subscribedGeneration = await this.waitForStartupRecovery();
			const defaultChatRevision = this.sessionDefaultChatRevision;
			await this.scheduleOwnedTerminals(this.rootTerminals, subscribedGeneration, true);
			const dispatchGeneration = await this.waitForStartupRecovery();
			this.throwIfTerminalError();
			if (
				dispatchGeneration !== subscribedGeneration
				|| !dispatchGeneration.valid
				|| this.sessionDefaultChatRevision !== defaultChatRevision
				|| this.sessionDefaultChatState !== 'available'
				|| this.sessionDefaultChat !== defaultChat
				|| dispatchGeneration.subscriptions.get(defaultChat) === undefined
			) {
				await this.releaseStartupSubscription(defaultChat, subscribedGeneration);
				if (dispatchGeneration !== subscribedGeneration) {
					await this.releaseStartupSubscription(defaultChat, dispatchGeneration);
				}
				continue;
			}
			this.turnId = randomUUID();
			this.chatUri = defaultChat;
			this.dispatchTracked(defaultChat, {
				type: 'chat/turnStarted',
				turnId: this.turnId,
				startedAt: new Date().toISOString(),
				message: {
					text: buildPrompt(this.request),
					origin: { kind: 'user' },
				},
			});
			break;
		}
		this.throwIfTerminalFailure();
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		this.throwIfTerminalFailure();
		this.events.push({ type: 'progress', message: 'Agent turn started.' });
		this.throwIfTerminalFailure();
	}

	async cancel(): Promise<void> {
		if (this.terminal || this.disposed || this.chatUri === undefined) {
			return;
		}
		this.assertWritable();
		this.events.push({ type: 'progress', message: 'Cancellation requested.' });
		this.dispatchTracked(this.chatUri, {
			type: 'chat/turnCancelled',
			turnId: this.currentTurnId(),
			duration: 0,
		});
		this.cancellationTimer = setTimeout(() => {
			this.fail(new AgentRuntimeError(
				'TASK_CANCELLATION_UNCONFIRMED',
				'The Agent Host did not confirm cancellation before the deadline.',
			));
		}, this.cancelTimeoutMs);
	}

	async answer(answer: AgentTaskAnswer): Promise<void> {
		if (this.terminal || this.disposed) {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The Agent Host task is no longer active.');
		}
		this.assertWritable();
		const dispatch = this.mapper.createAnswer(answer);
		if ('authentication' in dispatch) {
			await this.authenticate([dispatch.authentication], 'challenge', true);
			this.mapper.completeAuthentication(dispatch.requestId);
			return;
		}
		this.dispatchTracked(dispatch.channel, dispatch.action, dispatch.requestId);
	}

	dispose(): Promise<void> {
		if (this.disposePromise === undefined) {
			const operation = this.disposeResources();
			this.disposePromise = operation;
			void operation.catch(() => {
				if (this.disposePromise === operation) {
					this.disposePromise = undefined;
				}
			});
		}
		return this.disposePromise;
	}

	private async disposeResources(): Promise<void> {
		this.disposed = true;
		const recovery = this.recoveryPromise;
		this.recoveryAbort?.abort();
		this.authenticationAbort.abort();
		this.generation.valid = false;
		this.generation.abort.abort();
		const startupStopped = new AgentRuntimeError(
			'TASK_EXECUTION_FAILED',
			'The Agent Host task was disposed during startup.',
		);
		this.readyReject?.(startupStopped);
		this.defaultChatReject?.(startupStopped);
		if (this.cancellationTimer !== undefined) {
			clearTimeout(this.cancellationTimer);
		}
		this.exitSubscription?.dispose();
		this.events.close();
		if (recovery !== undefined) {
			await runCleanupPhase([{
				label: 'stop in-flight AHP recovery',
				run: () => recovery,
			}]);
		}
		await this.drainAuthNotificationsForDispose();
		await runCleanupPhase(
			[...this.retainedRecoveryCandidates].map((candidate) => ({
				label: 'dispose retained recovery candidate',
				run: () => candidate.dispose(),
			})),
		);
		if (!this.terminalUpdatesSettled) {
			const terminalUpdates = this.terminalSubscriptionUpdates.get(this.connection);
			if (terminalUpdates !== undefined) {
				await runCleanupPhase([{
					label: 'settle terminal subscription updates',
					run: () => terminalUpdates,
				}]);
			}
			this.terminalUpdatesSettled = true;
		}

		this.subscriptionCleanup ??= new Map([...this.subscriptions].map(([uri, subscription]) => [
			uri,
			{ subscription, closed: false, unsubscribed: this.shutdownConnections.has(this.connection) },
		]));
		await runCleanupPhase(
			[...this.subscriptionCleanup]
				.filter(([, state]) => !state.closed)
				.map(([uri, state]) => ({
						label: `close subscription ${safeCleanupResource(uri)}`,
						run: async () => {
							await state.subscription.close();
							state.closed = true;
						},
					})),
		);
		await runCleanupPhase(
			[...this.subscriptionCleanup]
				.filter(([, state]) => !state.unsubscribed)
				.map(([uri, state]) => ({
						label: `unsubscribe ${safeCleanupResource(uri)}`,
						run: async () => {
							await this.connection.unsubscribe(uri);
							state.unsubscribed = true;
						},
					})),
		);
		this.subscriptions.clear();

		if (!this.sessionDisposed && this.shutdownConnections.has(this.connection)) {
			this.sessionDisposed = true;
		}
		if (!this.sessionDisposed) {
			await runCleanupPhase([{
				label: 'dispose AHP session',
				run: async () => {
					await this.connection.disposeSession(this.sessionUri);
					this.sessionDisposed = true;
				},
			}]);
		}
		const detachedCleanup: CleanupOperation[] = [];
		if (!this.connectionShutdown && this.shutdownConnections.has(this.connection)) {
			this.connectionShutdown = true;
		}
		if (!this.connectionShutdown) {
			detachedCleanup.push({
				label: 'shutdown AHP connection',
				run: async () => {
					await this.shutdownConnection(this.connection);
					this.connectionShutdown = true;
				},
			});
		}
		detachedCleanup.push(
			...[...this.staleConnections].map((connection) => ({
				label: 'shutdown stale AHP connection',
				run: async () => {
					await this.shutdownConnection(connection);
				},
			})),
		);
		if (!this.hostDisposed) {
			detachedCleanup.push({
				label: 'dispose owned Agent Host',
				run: async () => {
					await this.host.dispose();
					this.hostDisposed = true;
				},
			});
		}
		await runCleanupPhase(detachedCleanup);
		this.didDispose();
	}

	private async resolveConfig(): Promise<Readonly<Record<string, unknown>>> {
		const provider = this.provider!;
		let config: Readonly<Record<string, unknown>> = {};
		for (let iteration = 0; iteration < 16; iteration += 1) {
			const resolved = await this.withAuthenticationRetry(
				() => this.connection.resolveSessionConfig(provider.provider, this.request.workspace.uri, config),
				'challenge',
			);
			const missing = resolved.schema.required?.filter((id) => resolved.values[id] === undefined) ?? [];
			if (missing.length === 0) {
				return resolved.values;
			}
			const next = await this.configResolver.resolve({
				schema: resolved.schema,
				values: resolved.values,
				interactive: this.request.allowInteractiveAuthentication === true,
				completions: async (property, currentValues, query, signal) => {
					throwIfAborted(signal);
					const completions = await this.connection.sessionConfigCompletions(
						provider.provider,
						this.request.workspace.uri,
						currentValues,
						property,
						query,
					);
					throwIfAborted(signal);
					return completions;
				},
			});
			if (stableJson(next) === stableJson(config)) {
				throw new AgentRuntimeError(
					'AGENT_CONFIG_REQUIRED',
					`Agent session configuration remains incomplete: ${missing.join(', ')}.`,
				);
			}
			config = next;
		}
		throw new AgentRuntimeError('AGENT_CONFIG_REQUIRED', 'Agent session configuration did not converge.');
	}

	private async withAuthenticationRetry<T>(
		operation: () => Promise<T>,
		reason: 'challenge' | 'tokenInvalid',
	): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			const resources = readAuthRequiredResources(error);
			if (resources === undefined) {
				throw error;
			}
			await this.authenticate(resources, reason, this.request.allowInteractiveAuthentication === true);
			return operation();
		}
	}

	private async authenticate(
		resources: readonly ProtectedResourceMetadata[] | readonly ProtectedResource[],
		reason: 'initial' | 'challenge' | 'tokenInvalid',
		interactive: boolean,
		connection = this.connection,
		signal: AbortSignal = this.authenticationAbort.signal,
	): Promise<void> {
		let connectionAuthentication = this.authenticationInFlight.get(connection);
		if (connectionAuthentication === undefined) {
			connectionAuthentication = new Map<string, AuthenticationInFlight>();
			this.authenticationInFlight.set(connection, connectionAuthentication);
		}
		await Promise.all(resources
			.filter(({ required }) => required !== false)
			.map((resource) => this.authenticateResource(
				resource,
				reason,
				interactive,
				connection,
				connectionAuthentication!,
				signal,
			)));
	}

	private authenticateResource(
		resource: ProtectedResource,
		reason: 'initial' | 'challenge' | 'tokenInvalid',
		interactive: boolean,
		connection: AhpConnection,
		connectionAuthentication: Map<string, AuthenticationInFlight>,
		signal?: AbortSignal,
	): Promise<void> {
		const existing = connectionAuthentication.get(resource.resource);
		if (existing !== undefined && authenticationCovers(existing, reason, interactive)) {
			return existing.promise;
		}
		const operation = (async () => {
			throwIfAborted(signal);
			if (existing !== undefined) {
				await existing.promise.catch(() => undefined);
				throwIfAborted(signal);
			}
			await this.authBroker.authenticate(
				{ resources: [resource], interactive, reason, signal },
				async (resourceUrl, token, scopes) => {
					throwIfAborted(signal);
					await connection.authenticate(resourceUrl, token, scopes);
					throwIfAborted(signal);
				},
			);
		})();
		const current = { reason, interactive, promise: operation };
		connectionAuthentication.set(resource.resource, current);
		const clear = () => {
			if (connectionAuthentication.get(resource.resource) === current) {
				connectionAuthentication.delete(resource.resource);
			}
		};
		void operation.then(clear, clear);
		return operation;
	}

	private dispatchTracked(channel: string, action: unknown, requestId?: string): void {
		const clientSeq = this.nextClientSeq;
		this.nextClientSeq += 1;
		this.unacknowledgedDispatches.set(clientSeq, { channel, action, requestId });
		try {
			this.connection.dispatch(channel, action, clientSeq);
		} catch (error) {
			this.handleSubscriptionLoss();
			throw normalizeRuntimeError(error);
		}
	}

	private acknowledgeDispatch(envelope: ActionEnvelope): void {
		if (envelope.origin?.clientId !== this.clientId) {
			return;
		}
		const pending = this.unacknowledgedDispatches.get(envelope.origin.clientSeq);
		if (pending === undefined) {
			return;
		}
		this.unacknowledgedDispatches.delete(envelope.origin.clientSeq);
		if (envelope.rejectionReason === undefined && pending.requestId !== undefined) {
			this.mapper.completeAnswer(pending.requestId);
		}
	}

	private resendUnacknowledged(connection: AhpConnection): void {
		for (const [clientSeq, pending] of this.unacknowledgedDispatches) {
			connection.dispatch(pending.channel, pending.action, clientSeq);
		}
	}

	private assertWritable(): void {
		if (this.recovering) {
			throw new AgentRuntimeError(
				'TASK_EXECUTION_FAILED',
				'The Agent Host task is reconnecting; retry the action after recovery completes.',
				true,
			);
		}
	}

	private async ensureStartupSubscription(uri: string): Promise<void> {
		while (true) {
			const generation = await this.waitForStartupRecovery();
			if (generation.subscriptions.has(uri)) {
				return;
			}

			let result: { readonly snapshot?: Snapshot; readonly subscription: AhpSubscription };
			try {
				result = await generation.connection.subscribe(uri, generation.abort.signal);
			} catch (error) {
				await Promise.resolve();
				if (!generation.valid || this.recoveryPromise !== undefined || this.recovering) {
					await this.waitForStartupRecovery();
					continue;
				}
				throw error;
			}
			if (!this.isCurrentGeneration(generation)) {
				await result.subscription.close().catch(() => undefined);
				await generation.connection.unsubscribe(uri).catch(() => undefined);
				continue;
			}
			if (result.snapshot !== undefined) {
				this.applySnapshot(result.snapshot);
			}
			this.throwIfTerminalError();
			if (!this.isCurrentGeneration(generation)) {
				await result.subscription.close().catch(() => undefined);
				await generation.connection.unsubscribe(uri).catch(() => undefined);
				continue;
			}
			generation.subscriptions.set(uri, result.subscription);
			this.startSubscription(uri, result.subscription, generation);
			return;
		}
	}

	private async ensureStartupChatSubscription(): Promise<string> {
		if (this.sessionDefaultChatState === 'cleared') {
			throw new AgentRuntimeError(
				'TASK_EXECUTION_FAILED',
				'The Agent Host Session cleared its default Chat before the turn could start.',
			);
		}
		const defaultChat = this.sessionDefaultChat;
		if (defaultChat === undefined) {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The recovered Agent Host Session has no default Chat.');
		}
		await this.ensureStartupSubscription(defaultChat);
		return defaultChat;
	}

	private async releaseStartupSubscription(uri: string, generation: ConnectionGeneration): Promise<void> {
		const subscription = generation.subscriptions.get(uri);
		if (subscription === undefined) {
			return;
		}
		generation.subscriptions.delete(uri);
		if (!generation.valid) {
			await subscription.close().catch(() => undefined);
			return;
		}
		await subscription.close();
		await generation.connection.unsubscribe(uri);
	}

	private async waitForStartupRecovery(): Promise<ConnectionGeneration> {
		const recovery = this.recoveryPromise;
		if (recovery !== undefined) {
			await recovery;
		}
		this.throwIfTerminalError();
		if (this.recovering) {
			await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
			return this.waitForStartupRecovery();
		}
		return this.generation;
	}

	private startSubscription(
		uri: string,
		subscription: AhpSubscription,
		generation: ConnectionGeneration,
	): void {
		void this.pumpSubscription(uri, subscription, generation);
	}

	private async pumpSubscription(
		uri: string,
		subscription: AhpSubscription,
		generation: ConnectionGeneration,
	): Promise<void> {
		try {
			for await (const event of subscription) {
				if (
					this.disposed
					|| !this.isCurrentGeneration(generation)
					|| generation.subscriptions.get(uri) !== subscription
				) {
					return;
				}
				if (event.type === 'action') {
					this.handleEnvelope(event.params as ActionEnvelope);
				} else {
					this.trackAuthNotification(event.params, generation);
				}
			}
			if (
				!this.disposed
				&& !this.terminal
				&& this.isCurrentGeneration(generation)
				&& generation.subscriptions.get(uri) === subscription
			) {
				this.handleSubscriptionLoss();
			}
		} catch {
			if (
				!this.disposed
				&& !this.terminal
				&& this.isCurrentGeneration(generation)
			) {
				this.handleSubscriptionLoss();
			}
		}
	}

	private isCurrentGeneration(generation: ConnectionGeneration): boolean {
		return generation.valid && generation === this.generation;
	}

	private handleSubscriptionLoss(): void {
		if (this.sessionCreated) {
			this.startRecovery();
			return;
		}
		this.fail(new AgentRuntimeError(
			'AGENT_UNAVAILABLE',
			'The Agent Host connection closed while the task was starting.',
		));
	}

	private handleEnvelope(envelope: ActionEnvelope, subscribeRootTerminals = true): void {
		this.lastSeenServerSeq = Math.max(this.lastSeenServerSeq, envelope.serverSeq);
		this.acknowledgeDispatch(envelope);
		const action = envelope.action;
		if (envelope.channel === rootUri) {
			if (action.type === 'root/agentsChanged') {
				const selected = action.agents.find(({ provider }) => provider === this.provider?.provider);
				if (selected === undefined) {
					this.fail(new AgentRuntimeError('AGENT_UNAVAILABLE', 'The selected Agent Host provider disappeared.'));
					return;
				}
				this.provider = selected;
			} else if (action.type === 'root/terminalsChanged') {
				this.rootTerminals = action.terminals;
				if (subscribeRootTerminals) {
					this.scheduleCurrentOwnedTerminals(action.terminals);
				}
			}
		}
		if (envelope.channel === this.sessionUri) {
			if (action.type === 'session/ready') {
				this.sessionReady = true;
				this.readyResolve?.();
			} else if (action.type === 'session/creationFailed') {
				const error = new AgentRuntimeError('TASK_EXECUTION_FAILED', safeMessage(action.error.message));
				this.readyReject?.(error);
				this.defaultChatReject?.(error);
				this.fail(error);
			} else if (action.type === 'session/defaultChatChanged') {
				this.updateSessionDefaultChat(action.defaultChat);
			}
		}
		this.trackDeliveredResponseAction(action);
		this.emitMappedEvents(this.mapper.map(envelope));
	}

	private trackDeliveredResponseAction(action: ActionEnvelope['action']): void {
		if ((action.type === 'chat/delta' || action.type === 'chat/reasoning') && typeof action.partId === 'string') {
			this.deliveredResponsePartLengths.set(
				action.partId,
				(this.deliveredResponsePartLengths.get(action.partId) ?? 0) + action.content.length,
			);
			return;
		}
		if (action.type === 'chat/responsePart') {
			this.trackDeliveredResponsePart(action.part);
			return;
		}
		if (action.type === 'chat/inputRequested') {
			this.deliveredResponsePartStates.add(`input:${action.request.id}`);
			return;
		}
		if ('toolCallId' in action && typeof action.toolCallId === 'string') {
			const status = action.type === 'chat/toolCallStart'
				? 'streaming'
				: action.type === 'chat/toolCallReady'
					? action.confirmed === undefined ? 'pending-confirmation' : 'running'
					: action.type === 'chat/toolCallAuthRequired'
						? 'auth-required'
						: action.type === 'chat/toolCallComplete'
							? action.requiresResultConfirmation === true ? 'pending-result-confirmation' : 'completed'
							: undefined;
			if (status !== undefined) {
				this.deliveredResponsePartStates.add(`tool:${action.toolCallId}:${status}`);
			}
		}
	}

	private trackDeliveredResponsePart(value: unknown): void {
		if (!isRecord(value)) {
			return;
		}
		if (
			(value.kind === 'markdown' || value.kind === 'reasoning')
			&& typeof value.id === 'string'
			&& typeof value.content === 'string'
		) {
			this.deliveredResponsePartLengths.set(value.id, value.content.length);
			return;
		}
		const identity = responsePartIdentity(value);
		if (identity !== undefined) {
			this.deliveredResponsePartStates.add(identity);
			return;
		}
		const ordinalIdentity = responsePartOrdinalIdentity(value);
		if (ordinalIdentity !== undefined) {
			this.deliveredResponsePartOrdinals.set(
				ordinalIdentity,
				(this.deliveredResponsePartOrdinals.get(ordinalIdentity) ?? 0) + 1,
			);
		}
	}

	private emitMappedEvents(events: readonly AgentRuntimeEvent[]): void {
		for (const event of events) {
			this.events.push(event);
			if (event.type === 'completed' || event.type === 'cancelled' || event.type === 'failed') {
				this.finishTerminal();
			}
		}
	}

	private applySnapshot(snapshot: Snapshot, subscribeRootTerminals = true): void {
		this.lastSeenServerSeq = Math.max(this.lastSeenServerSeq, snapshot.fromSeq);
		if (snapshot.resource === this.sessionUri) {
			const state = snapshot.state as SessionState;
			if (state.lifecycle === 'creationFailed') {
				throw new AgentRuntimeError(
					'TASK_EXECUTION_FAILED',
					safeMessage(state.creationError?.message ?? 'Agent session creation failed.'),
				);
			}
			if (state.lifecycle === 'ready') {
				this.sessionReady = true;
				this.readyResolve?.();
			}
			if (state.defaultChat !== undefined) {
				this.updateSessionDefaultChat(state.defaultChat);
			} else if (state.lifecycle === 'ready') {
				this.updateSessionDefaultChat(undefined);
			}
			return;
		}
		if (snapshot.resource === rootUri) {
			const root = parseRootState(snapshot);
			const selected = root.agents.find(({ provider }) => provider === this.provider?.provider);
			if (this.provider !== undefined && selected === undefined) {
				throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The selected Agent Host provider disappeared.');
			}
			this.provider = selected ?? this.provider;
			this.rootTerminals = root.terminals ?? [];
			if (subscribeRootTerminals) {
				this.scheduleCurrentOwnedTerminals(this.rootTerminals);
			}
			return;
		}
		if (snapshot.resource === this.chatUri) {
			this.applyChatSnapshot(snapshot.state, snapshot.resource);
		}
	}

	private applyChatSnapshot(value: unknown, chatUri: string): void {
		if (!isRecord(value)) {
			throw new AgentRuntimeError('TASK_RECOVERY_UNAVAILABLE', 'The recovered Chat snapshot was invalid.');
		}
		const activeTurn = isRecord(value.activeTurn) ? value.activeTurn : undefined;
		if (activeTurn !== undefined && activeTurn.id === this.turnId && Array.isArray(activeTurn.responseParts)) {
			this.restoreResponseParts(chatUri, activeTurn.responseParts);
			return;
		}
		if (!Array.isArray(value.turns)) {
			return;
		}
		const turn = value.turns.find((candidate) =>
			isRecord(candidate) && candidate.id === this.turnId,
		);
		if (!isRecord(turn)) {
			return;
		}
		if (Array.isArray(turn.responseParts)) {
			this.restoreResponseParts(chatUri, turn.responseParts);
		}
		if (turn.state === 'complete') {
			this.emitMappedEvents([{ type: 'completed' }]);
		} else if (turn.state === 'cancelled') {
			this.emitMappedEvents([{ type: 'cancelled' }]);
		} else if (turn.state === 'error') {
			const message = isRecord(turn.error) && typeof turn.error.message === 'string'
				? turn.error.message
				: 'The recovered Agent Host turn failed.';
			this.emitMappedEvents([{
				type: 'failed',
				error: new AgentRuntimeError('TASK_EXECUTION_FAILED', safeMessage(message)),
			}]);
		}
	}

	private restoreResponseParts(chatUri: string, parts: readonly unknown[]): void {
		const snapshotOrdinals = new Map<string, number>();
		for (let index = 0; index < parts.length; index += 1) {
			const part = parts[index];
			const ordinalIdentity = isRecord(part) ? responsePartOrdinalIdentity(part) : undefined;
			const ordinal = ordinalIdentity === undefined
				? undefined
				: (snapshotOrdinals.get(ordinalIdentity) ?? 0) + 1;
			if (ordinalIdentity !== undefined && ordinal !== undefined) {
				snapshotOrdinals.set(ordinalIdentity, ordinal);
			}
			this.restoreResponsePart(chatUri, part, index, ordinalIdentity, ordinal);
		}
	}

	private restoreResponsePart(
		chatUri: string,
		value: unknown,
		index: number,
		ordinalIdentity?: string,
		ordinal?: number,
	): void {
		if (!isRecord(value)) {
			return;
		}
		if (
			(value.kind === 'markdown' || value.kind === 'reasoning')
			&& typeof value.id === 'string'
			&& typeof value.content === 'string'
		) {
			const deliveredLength = this.deliveredResponsePartLengths.get(value.id) ?? 0;
			const content = deliveredLength <= value.content.length
				? value.content.slice(deliveredLength)
				: value.content;
			this.deliveredResponsePartLengths.set(value.id, value.content.length);
			if (content.length > 0) {
				this.emitMappedEvents([value.kind === 'markdown'
					? { type: 'output', text: content }
					: { type: 'progress', message: content }]);
			}
			return;
		}
		if (ordinalIdentity !== undefined && ordinal !== undefined) {
			if ((this.deliveredResponsePartOrdinals.get(ordinalIdentity) ?? 0) >= ordinal) {
				return;
			}
			this.deliveredResponsePartOrdinals.set(ordinalIdentity, ordinal);
		}
		const identity = responsePartIdentity(value)
			?? (ordinalIdentity === undefined ? `snapshot:${this.turnId ?? 'unknown'}:${index}` : undefined);
		if (identity === undefined) {
			this.emitMappedEvents(this.mapper.map(envelopeFromSnapshot(chatUri, {
				type: 'chat/responsePart',
				turnId: this.turnId,
				part: value,
			}, this.lastSeenServerSeq)));
			return;
		}
		if (this.deliveredResponsePartStates.has(identity)) {
			return;
		}
		this.deliveredResponsePartStates.add(identity);
		if (value.kind === 'inputRequest' && isRecord(value.request) && value.response === undefined) {
			this.handleEnvelope(envelopeFromSnapshot(chatUri, {
				type: 'chat/inputRequested',
				request: value.request,
			}, this.lastSeenServerSeq));
			return;
		}
		if (value.kind !== 'toolCall' || !isRecord(value.toolCall)) {
			this.emitMappedEvents(this.mapper.map(envelopeFromSnapshot(chatUri, {
				type: 'chat/responsePart',
				turnId: this.turnId,
				part: value,
			}, this.lastSeenServerSeq)));
			return;
		}
		const tool = value.toolCall;
		const common = {
			turnId: this.turnId,
			toolCallId: tool.toolCallId,
		};
		if (tool.status === 'pending-confirmation') {
			this.handleEnvelope(envelopeFromSnapshot(chatUri, {
				type: 'chat/toolCallReady',
				...common,
				invocationMessage: tool.invocationMessage,
				confirmationTitle: tool.confirmationTitle,
				options: tool.options,
			}, this.lastSeenServerSeq));
		} else if (tool.status === 'pending-result-confirmation') {
			this.handleEnvelope(envelopeFromSnapshot(chatUri, {
				type: 'chat/toolCallComplete',
				...common,
				result: {
					success: tool.success,
					pastTenseMessage: tool.pastTenseMessage,
					content: tool.content,
				},
				requiresResultConfirmation: true,
			}, this.lastSeenServerSeq));
		} else if (tool.status === 'auth-required') {
			this.handleEnvelope(envelopeFromSnapshot(chatUri, {
				type: 'chat/toolCallAuthRequired',
				...common,
				auth: tool.auth,
			}, this.lastSeenServerSeq));
		} else if (tool.status === 'completed') {
			this.handleEnvelope(envelopeFromSnapshot(chatUri, {
				type: 'chat/toolCallComplete',
				...common,
				result: {
					success: tool.success,
					pastTenseMessage: tool.pastTenseMessage,
					content: tool.content,
					structuredContent: tool.structuredContent,
					error: tool.error,
				},
				requiresResultConfirmation: false,
			}, this.lastSeenServerSeq));
		} else if (tool.status === 'streaming' || tool.status === 'running') {
			this.handleEnvelope(envelopeFromSnapshot(chatUri, {
				type: 'chat/toolCallStart',
				...common,
				toolName: tool.toolName,
				displayName: tool.displayName,
				intention: tool.intention,
				contributor: tool.contributor,
			}, this.lastSeenServerSeq));
		}
	}

	private waitForReady(): Promise<void> {
		if (this.sessionReady) {
			return Promise.resolve();
		}
		return withTimeout(new Promise<void>((resolvePromise, reject) => {
			this.readyResolve = resolvePromise;
			this.readyReject = reject;
		}), sessionReadyTimeoutMs, 'The Agent Host session did not become ready.');
	}

	private waitForDefaultChat(): Promise<string> {
		if (this.sessionDefaultChatState === 'available' && this.sessionDefaultChat !== undefined) {
			return Promise.resolve(this.sessionDefaultChat);
		}
		if (this.sessionDefaultChatState === 'cleared') {
			return Promise.reject(new AgentRuntimeError(
				'TASK_EXECUTION_FAILED',
				'The Agent Host Session has no default Chat.',
			));
		}
		return withTimeout(new Promise<string>((resolvePromise, reject) => {
			this.defaultChatResolve = resolvePromise;
			this.defaultChatReject = reject;
		}), sessionReadyTimeoutMs, 'The Agent Host session did not publish a default chat.');
	}

	private updateSessionDefaultChat(defaultChat: string | undefined): void {
		this.sessionDefaultChat = defaultChat;
		this.sessionDefaultChatState = defaultChat === undefined ? 'cleared' : 'available';
		this.sessionDefaultChatRevision += 1;
		if (defaultChat !== undefined) {
			this.defaultChatResolve?.(defaultChat);
		} else {
			this.defaultChatReject?.(new AgentRuntimeError(
				'TASK_EXECUTION_FAILED',
				'The Agent Host Session cleared its default Chat.',
			));
		}
	}

	private async subscribeOwnedTerminals(
		terminals: readonly TerminalInfo[],
		generation: ConnectionGeneration,
		startPumps: boolean,
		signal: AbortSignal = generation.abort.signal,
	): Promise<void> {
		const { connection, subscriptions } = generation;
		throwIfAborted(signal);
		const owned = terminals.filter(({ claim }) =>
			claim.kind === 'session' && claim.session === this.sessionUri,
		);
		const ownedResources = new Set(owned.map(({ resource }) => resource));
		for (const [uri, subscription] of subscriptions) {
			if (uri.startsWith('ahp-terminal:') && !ownedResources.has(uri)) {
				subscriptions.delete(uri);
				await subscription.close();
				throwIfAborted(signal);
				await connection.unsubscribe(uri);
				throwIfAborted(signal);
			}
		}
		for (const terminal of owned) {
			if (subscriptions.has(terminal.resource)) {
				continue;
			}
			const result = await connection.subscribe(terminal.resource, signal);
			if (
				this.disposed
				|| signal.aborted
				|| !generation.valid
				|| (startPumps && !this.isCurrentGeneration(generation))
			) {
				await result.subscription.close().catch(() => undefined);
				await connection.unsubscribe(terminal.resource).catch(() => undefined);
				continue;
			}
			if (result.snapshot !== undefined) {
				this.applySnapshot(result.snapshot, false);
			}
			subscriptions.set(terminal.resource, result.subscription);
			if (startPumps) {
				this.startSubscription(terminal.resource, result.subscription, generation);
			}
		}
	}

	private scheduleOwnedTerminals(
		terminals: readonly TerminalInfo[],
		generation: ConnectionGeneration,
		startPumps: boolean,
		signal?: AbortSignal,
	): Promise<void> {
		const { connection } = generation;
		const previous = this.terminalSubscriptionUpdates.get(connection) ?? Promise.resolve();
		const update = previous.then(() =>
			this.subscribeOwnedTerminals(terminals, generation, startPumps, signal),
		);
		const tracked = update.catch(() => undefined);
		this.terminalSubscriptionUpdates.set(connection, tracked);
		void tracked.then(() => {
			if (this.terminalSubscriptionUpdates.get(connection) === tracked) {
				this.terminalSubscriptionUpdates.delete(connection);
			}
		});
		return update;
	}

	private scheduleCurrentOwnedTerminals(terminals: readonly TerminalInfo[]): void {
		const generation = this.generation;
		void this.scheduleOwnedTerminals(terminals, generation, true)
			.catch((error: unknown) => this.handleTerminalSubscriptionFailure(error, generation));
	}

	private handleTerminalSubscriptionFailure(
		error: unknown,
		generation: ConnectionGeneration,
	): void {
		if (
			!this.disposed
			&& !this.terminal
			&& this.isCurrentGeneration(generation)
			&& !this.recovering
		) {
			this.fail(normalizeRuntimeError(error));
		}
	}

	private async handleAuthNotification(params: unknown, generation: ConnectionGeneration): Promise<void> {
		const resources = readResourcesFromNotification(params);
		if (resources.length === 0) {
			return;
		}
		try {
			await this.authenticate(
				resources,
				'tokenInvalid',
				this.request.allowInteractiveAuthentication === true,
				generation.connection,
				AbortSignal.any([this.authenticationAbort.signal, generation.abort.signal]),
			);
		} catch (error) {
			if (this.isCurrentGeneration(generation) && !this.recovering) {
				this.fail(normalizeRuntimeError(error));
			}
		}
	}

	private trackAuthNotification(params: unknown, generation: ConnectionGeneration): void {
		const operation = this.handleAuthNotification(params, generation);
		this.pendingAuthNotifications.add(operation);
		const clear = () => this.pendingAuthNotifications.delete(operation);
		void operation.then(clear, clear);
	}

	private async drainAuthNotifications(): Promise<void> {
		while (this.pendingAuthNotifications.size > 0) {
			await Promise.all([...this.pendingAuthNotifications]);
		}
	}

	private async drainAuthNotificationsForDispose(): Promise<void> {
		while (this.pendingAuthNotifications.size > 0) {
			await Promise.allSettled([...this.pendingAuthNotifications]);
		}
	}

	private shutdownConnection(connection: AhpConnection): Promise<void> {
		if (this.shutdownConnections.has(connection)) {
			return Promise.resolve();
		}
		const existing = this.connectionShutdownOperations.get(connection);
		if (existing !== undefined) {
			return existing;
		}
		const operation = connection.shutdown().then(() => {
			this.shutdownConnections.add(connection);
			this.staleConnections.delete(connection);
		});
		this.connectionShutdownOperations.set(connection, operation);
		void operation.finally(() => {
			if (this.connectionShutdownOperations.get(connection) === operation) {
				this.connectionShutdownOperations.delete(connection);
			}
		}).catch(() => undefined);
		return operation;
	}

	private startRecovery(): void {
		if (this.recoveryPromise !== undefined || this.disposed || this.terminal) {
			return;
		}
		const abort = new AbortController();
		this.recoveryAbort = abort;
		const operation = this.recover(abort.signal);
		this.recoveryPromise = operation;
		const clear = () => {
			if (this.recoveryPromise === operation) {
				this.recoveryPromise = undefined;
				this.recoveryAbort = undefined;
			}
		};
		void operation.then(clear, clear);
		void operation.catch(() => undefined);
	}

	private async recover(signal: AbortSignal): Promise<void> {
		this.recovering = true;
		this.events.push({ type: 'progress', message: 'Reconnecting to Agent Host.' });
		const previousConnection = this.connection;
		const previousGeneration = this.generation;
		previousGeneration.valid = false;
		previousGeneration.abort.abort();
		this.staleConnections.add(previousConnection);
		const previousShutdown = this.shutdownConnection(previousConnection);
		void previousShutdown.catch(() => undefined);
		let candidate: AhpConnection | undefined;
		let candidateGeneration: ConnectionGeneration | undefined;
		let candidateAbortShutdown: Promise<void> | undefined;
		let abortCandidate: (() => void) | undefined;
		const recoveredSubscriptions = new Map<string, AhpSubscription>();
		let recoveredTerminals: readonly TerminalInfo[] = this.rootTerminals;
		try {
			candidate = await this.awaitRecoveryStep(
				this.connectionFactory.connect(this.host.endpoint, signal),
				signal,
			);
			candidateGeneration = {
				connection: candidate,
				subscriptions: recoveredSubscriptions,
				abort: new AbortController(),
				valid: true,
			};
			abortCandidate = () => {
				candidateGeneration!.valid = false;
				candidateGeneration!.abort.abort();
				candidateAbortShutdown ??= candidate!.shutdown();
				void candidateAbortShutdown.catch(() => undefined);
			};
			signal.addEventListener('abort', abortCandidate, { once: true });
			this.throwIfRecoveryStopped(signal);
			for (const uri of this.subscriptions.keys()) {
				this.throwIfRecoveryStopped(signal);
				recoveredSubscriptions.set(uri, candidate.attachSubscription(uri));
			}
			const result = await this.awaitRecoveryStep(
				candidate.reconnect(
					this.clientId,
					this.lastSeenServerSeq,
					[...this.subscriptions.keys()],
				),
				signal,
			);
			if (result.type === 'replay') {
				for (const action of result.actions ?? []) {
					this.throwIfRecoveryStopped(signal);
					if (action.channel === rootUri && action.action.type === 'root/terminalsChanged') {
						recoveredTerminals = action.action.terminals;
					}
					this.handleEnvelope(action, false);
				}
				const missing = result.missing ?? [];
				if (
					missing.includes(rootUri)
					|| missing.includes(this.sessionUri)
					|| missing.includes(this.chatUri ?? '')
				) {
					throw new RecoveryUnavailableCause('The Agent Host no longer has the task session.');
				}
				for (const uri of missing) {
					const subscription = recoveredSubscriptions.get(uri);
					if (subscription !== undefined) {
						await this.awaitRecoveryStep(subscription.close(), signal);
					}
					recoveredSubscriptions.delete(uri);
				}
			} else {
				const snapshots = result.snapshots ?? [];
				const snapshotResources = new Set(snapshots.map(({ resource }) => resource));
				const required = [rootUri, this.sessionUri, this.chatUri].filter((uri): uri is string => uri !== undefined);
				if (required.some((uri) => !snapshotResources.has(uri))) {
					throw new RecoveryUnavailableCause('The Agent Host no longer has the task session or active chat.');
				}
				for (const [uri, subscription] of recoveredSubscriptions) {
					if (!snapshotResources.has(uri)) {
						await this.awaitRecoveryStep(subscription.close(), signal);
						recoveredSubscriptions.delete(uri);
					}
				}
				for (const snapshot of snapshots) {
					this.throwIfRecoveryStopped(signal);
					if (snapshot.resource === rootUri) {
						recoveredTerminals = parseRootState(snapshot).terminals ?? [];
					}
					this.applySnapshot(snapshot, false);
				}
			}
			const sessions = await this.awaitRecoveryStep(candidate.listSessions(), signal);
			if (!sessions.some(({ resource }) => resource === this.sessionUri)) {
				throw new RecoveryUnavailableCause('The Agent Host session is missing after reconnect.');
			}
			if (this.provider !== undefined) {
				await this.awaitRecoveryStep(
					this.authenticate(
						this.provider.protectedResources ?? [],
						'tokenInvalid',
						this.request.allowInteractiveAuthentication === true,
						candidate,
						AbortSignal.any([signal, this.authenticationAbort.signal]),
					),
					signal,
				);
			}
			await this.awaitRecoveryStep(
				this.scheduleOwnedTerminals(
					recoveredTerminals,
					candidateGeneration,
					false,
					signal,
				),
				signal,
			);
			this.throwIfRecoveryStopped(signal);
			this.resendUnacknowledged(candidate);
			this.throwIfRecoveryStopped(signal);
			try {
				await this.awaitRecoveryStep(previousShutdown, signal);
			} catch (error) {
				if (error instanceof RecoveryStoppedCause) {
					throw error;
				}
				this.staleConnections.add(previousConnection);
			}
			const previousTerminalUpdates = this.terminalSubscriptionUpdates.get(previousConnection);
			if (previousTerminalUpdates !== undefined) {
				await this.awaitRecoveryStep(previousTerminalUpdates, signal);
			}
			this.throwIfRecoveryStopped(signal);
			this.connection = candidate;
			this.subscriptions = recoveredSubscriptions;
			this.generation = candidateGeneration;
			this.recovering = false;
			for (const [uri, subscription] of recoveredSubscriptions) {
				this.startSubscription(uri, subscription, candidateGeneration);
			}
			this.events.push({ type: 'progress', message: 'Agent Host connection recovered.' });
		} catch (error) {
			const stopped = error instanceof RecoveryStoppedCause || signal.aborted || this.disposed || this.terminal;
			let failure = error instanceof RecoveryUnavailableCause
				? new AgentRuntimeError(
					'TASK_RECOVERY_UNAVAILABLE',
					'The Agent Host task could not be recovered because its Host or Session is unavailable.',
				)
				: normalizeRuntimeError(error);
			if (candidate !== undefined && candidate !== this.connection) {
				if (candidateGeneration !== undefined) {
					candidateGeneration.valid = false;
					candidateGeneration.abort.abort();
				}
				let retainedCandidate: RecoveryCandidateCleanup;
				retainedCandidate = new RecoveryCandidateCleanup(
					candidate,
					recoveredSubscriptions,
					candidateAbortShutdown,
					() => this.retainedRecoveryCandidates.delete(retainedCandidate),
				);
				this.retainedRecoveryCandidates.add(retainedCandidate);
				try {
					await retainedCandidate.dispose();
				} catch (cleanupError) {
					failure = combineRuntimeErrors(failure, normalizeRuntimeError(cleanupError));
					if (stopped) {
						throw failure;
					}
				}
			}
			if (!stopped) {
				this.fail(failure);
			}
		} finally {
			if (abortCandidate !== undefined) {
				signal.removeEventListener('abort', abortCandidate);
			}
			await previousShutdown.catch(() => undefined);
			await this.terminalSubscriptionUpdates.get(previousConnection)?.catch(() => undefined);
			this.recovering = false;
		}
	}

	private async awaitRecoveryStep<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
		const result = await operation;
		this.throwIfRecoveryStopped(signal);
		return result;
	}

	private throwIfRecoveryStopped(signal: AbortSignal): void {
		if (signal.aborted || this.disposed || this.terminal) {
			throw new RecoveryStoppedCause();
		}
	}

	private currentTurnId(): string {
		if (this.turnId === undefined) {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'No active Agent Host chat is available.');
		}
		return this.turnId;
	}

	private throwIfTerminalError(): void {
		if (this.terminalError !== undefined) {
			throw this.terminalError;
		}
		if (this.disposed || this.terminal) {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The Agent Host task stopped during startup.');
		}
	}

	private throwIfTerminalFailure(): void {
		if (this.terminalError !== undefined) {
			throw this.terminalError;
		}
		if (this.disposed) {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The Agent Host task stopped during startup.');
		}
	}

	private fail(error: AgentRuntimeError): void {
		if (this.terminal || this.disposed) {
			return;
		}
		this.terminalError = error;
		this.readyReject?.(error);
		this.defaultChatReject?.(error);
		this.events.push({ type: 'failed', error });
		this.finishTerminal();
	}

	private finishTerminal(): void {
		this.terminal = true;
		if (this.cancellationTimer !== undefined) {
			clearTimeout(this.cancellationTimer);
		}
		this.events.close();
	}
}

function adaptSubscription(
	subscription: import(
		'@microsoft/agent-host-protocol/client',
		{ with: { 'resolution-mode': 'import' } }
	).Subscription,
): AhpSubscription {
	return {
		close: () => subscription.close(),
		[Symbol.asyncIterator]: () => subscription[Symbol.asyncIterator]() as AsyncIterator<AhpSubscriptionEvent>,
	};
}

function validateRequest(request: AgentTaskRequest): void {
	if (request.prompt.trim().length === 0) {
		throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'An Agent Host task prompt is required.');
	}
	if (request.workspaceId.trim().length === 0) {
		throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'A registered workspace ID is required.');
	}
}

function validateWorkspace(workspaceId: string, workspace: ResolvedAgentTaskRequest['workspace']): void {
	let uri: URL;
	try {
		uri = new URL(workspace.uri);
	} catch {
		throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The registered workspace URI is invalid.');
	}
	if (workspace.workspaceId !== workspaceId || uri.protocol !== 'file:') {
		throw new AgentRuntimeError(
			'AGENT_UNAVAILABLE',
			'Agent Host tasks require a registered local file workspace.',
		);
	}
}

function parseRootState(snapshot: Snapshot): RootState {
	if (!isRecord(snapshot.state) || !Array.isArray(snapshot.state.agents)) {
		throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The AHP root snapshot did not contain providers.');
	}
	return snapshot.state as unknown as RootState;
}

function selectProvider(agents: readonly AgentInfo[], requested?: string): AgentInfo {
	const selected = requested === undefined
		? agents[0]
		: agents.find(({ provider }) => provider === requested);
	if (selected === undefined) {
		throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'No matching Agent Host provider is available.');
	}
	return selected;
}

function buildPrompt(request: ResolvedAgentTaskRequest): string {
	if (request.acceptanceCriteria === undefined || request.acceptanceCriteria.length === 0) {
		return request.prompt;
	}
	return `${request.prompt}\n\nAcceptance criteria:\n${request.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`;
}

function readAuthRequiredResources(error: unknown): readonly ProtectedResource[] | undefined {
	if (!isRecord(error) || error.code !== -32007 || !isRecord(error.data) || !Array.isArray(error.data.resources)) {
		return undefined;
	}
	return error.data.resources.flatMap((value) => isProtectedResource(value) ? [value] : []);
}

function readResourcesFromNotification(value: unknown): readonly ProtectedResource[] {
	if (!isRecord(value)) {
		return [];
	}
	if (isProtectedResource(value.resource)) {
		return [value.resource];
	}
	return Array.isArray(value.resources)
		? value.resources.flatMap((resource) => isProtectedResource(resource) ? [resource] : [])
		: [];
}

function isProtectedResource(value: unknown): value is ProtectedResource {
	return isRecord(value)
		&& typeof value.resource === 'string'
		&& value.resource.startsWith('https://');
}

function authenticationCovers(
	existing: AuthenticationInFlight,
	reason: AuthenticationInFlight['reason'],
	interactive: boolean,
): boolean {
	const rank = { initial: 0, challenge: 1, tokenInvalid: 2 } as const;
	return rank[existing.reason] >= rank[reason]
		&& (existing.interactive || !interactive);
}

class RecoveryUnavailableCause extends Error {}
class RecoveryStoppedCause extends Error {}

interface CleanupOperation {
	readonly label: string;
	readonly run: () => Promise<void>;
}

async function cleanupDetachedResources(
	host: LaunchedAgentHost,
	connection: AhpConnection | undefined,
): Promise<AgentRuntimeError | undefined> {
	const failures: string[] = [];
	if (connection !== undefined) {
		await collectCleanupFailures([
			{ label: 'shutdown detached AHP connection', run: () => connection.shutdown() },
		], failures);
	}
	await collectCleanupFailures([
		{ label: 'dispose detached owned Agent Host', run: () => host.dispose() },
	], failures);
	return failures.length === 0 ? undefined : cleanupFailure(failures);
}

class RecoveryCandidateCleanup {
	private readonly subscriptions: Map<string, {
		readonly subscription: AhpSubscription;
		closed: boolean;
	}>;
	private shutdownComplete = false;
	private disposal: Promise<void> | undefined;
	private disposed = false;

	constructor(
		private readonly connection: AhpConnection,
		subscriptions: ReadonlyMap<string, AhpSubscription>,
		private initialShutdown: Promise<void> | undefined,
		private readonly didDispose: () => void,
	) {
		this.subscriptions = new Map([...subscriptions].map(([uri, subscription]) => [
			uri,
			{ subscription, closed: false },
		]));
	}

	dispose(): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		this.disposal ??= this.disposeOwned().finally(() => {
			if (!this.disposed) {
				this.disposal = undefined;
			}
		});
		return this.disposal;
	}

	private async disposeOwned(): Promise<void> {
		await runCleanupPhase(
			[...this.subscriptions]
				.filter(([, state]) => !state.closed)
				.map(([uri, state]) => ({
					label: `close recovery subscription ${safeCleanupResource(uri)}`,
					run: async () => {
						await state.subscription.close();
						state.closed = true;
					},
				})),
		);
		if (!this.shutdownComplete) {
			const shutdown = this.initialShutdown ?? this.connection.shutdown();
			try {
				await shutdown;
				this.shutdownComplete = true;
			} catch (error) {
				this.initialShutdown = undefined;
				throw error;
			}
		}
		this.disposed = true;
		this.didDispose();
	}
}

async function collectCleanupFailures(
	operations: readonly CleanupOperation[],
	failures: string[],
): Promise<void> {
	const results = await Promise.allSettled(operations.map(({ run }) => run()));
	for (let index = 0; index < results.length; index += 1) {
		if (results[index]?.status === 'rejected') {
			failures.push(operations[index]!.label);
		}
	}
}

async function runCleanupPhase(operations: readonly CleanupOperation[]): Promise<void> {
	const failures: string[] = [];
	await collectCleanupFailures(operations, failures);
	if (failures.length > 0) {
		throw cleanupFailure(failures);
	}
}

function cleanupFailure(failures: readonly string[]): AgentRuntimeError {
	const unique = [...new Set(failures)];
	return new AgentRuntimeError(
		'TASK_EXECUTION_FAILED',
		`Agent Host resource cleanup failed: ${unique.join(', ')}.`,
		false,
		new AggregateError(
			unique.map((label) => new Error(`Cleanup failed: ${label}.`)),
			'One or more Agent Host resources could not be released.',
		),
		true,
	);
}

function combineRuntimeErrors(primary: AgentRuntimeError, cleanup: AgentRuntimeError): AgentRuntimeError {
	return new AgentRuntimeError(
		primary.code,
		`${primary.message} Resource cleanup also failed.`,
		primary.retryable,
		new AggregateError([
			new AgentRuntimeError(primary.code, primary.message, primary.retryable),
			new AgentRuntimeError(cleanup.code, cleanup.message, cleanup.retryable, cleanup.cause),
		], 'The Agent Host operation and its resource cleanup both failed.'),
		true,
	);
}

function safeCleanupResource(uri: string): string {
	if (uri === rootUri) {
		return 'root';
	}
	const scheme = uri.match(/^ahp-([a-z]+):/u)?.[1];
	return scheme === undefined ? 'resource' : scheme;
}

function responsePartIdentity(part: Readonly<Record<string, unknown>>): string | undefined {
	if (part.kind === 'toolCall' && isRecord(part.toolCall) && typeof part.toolCall.toolCallId === 'string') {
		return `tool:${part.toolCall.toolCallId}:${String(part.toolCall.status)}`;
	}
	if (part.kind === 'inputRequest' && isRecord(part.request) && typeof part.request.id === 'string') {
		return `input:${part.request.id}`;
	}
	return undefined;
}

function responsePartOrdinalIdentity(part: Readonly<Record<string, unknown>>): string | undefined {
	if (part.kind === 'systemNotification') {
		return `system:${JSON.stringify(part.content)}`;
	}
	if (part.kind === 'contentRef') {
		return `content-ref:${JSON.stringify(part)}`;
	}
	return undefined;
}

function normalizeRuntimeError(error: unknown): AgentRuntimeError {
	if (error instanceof AgentRuntimeError) {
		return error;
	}
	return new AgentRuntimeError('TASK_EXECUTION_FAILED', safeMessage(
		error instanceof Error ? error.message : String(error),
	));
}

function safeMessage(message: string): string {
	return message
		.replace(/([?&](?:tkn|token)=)[^&\s"']+/giu, '$1<redacted>')
		.replace(/("(?:connectionToken|token)"\s*:\s*")[^"]*(")/giu, '$1<redacted>$2')
		.slice(0, 2_048);
}

function envelopeFromSnapshot(
	channel: string,
	action: Record<string, unknown>,
	serverSeq: number,
): ActionEnvelope {
	return {
		channel,
		action,
		serverSeq,
		origin: undefined,
	} as unknown as ActionEnvelope;
}

function stableJson(value: Readonly<Record<string, unknown>>): string {
	const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
	return JSON.stringify(Object.fromEntries(entries));
}

function connectWebSocket(endpoint: URL, timeoutMs: number, signal?: AbortSignal): Promise<WebSocket> {
	return new Promise((resolveSocket, reject) => {
		if (signal?.aborted === true) {
			reject(new RecoveryStoppedCause());
			return;
		}
		const socket = new globalThis.WebSocket(endpoint);
		const timer = setTimeout(() => {
			cleanup();
			socket.close();
			reject(new AgentRuntimeError('AGENT_UNAVAILABLE', 'Timed out connecting to the Agent Host.'));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			socket.removeEventListener('open', handleOpen);
			socket.removeEventListener('error', handleError);
			socket.removeEventListener('close', handleClose);
			signal?.removeEventListener('abort', handleAbort);
		};
		const handleOpen = () => {
			cleanup();
			resolveSocket(socket);
		};
		const handleError = () => {
			cleanup();
			reject(new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Agent Host WebSocket failed to open.'));
		};
		const handleClose = () => {
			cleanup();
			reject(new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Agent Host WebSocket closed before opening.'));
		};
		const handleAbort = () => {
			cleanup();
			socket.close();
			reject(new RecoveryStoppedCause());
		};
		socket.addEventListener('open', handleOpen);
		socket.addEventListener('error', handleError);
		socket.addEventListener('close', handleClose);
		signal?.addEventListener('abort', handleAbort, { once: true });
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) {
		throw new RecoveryStoppedCause();
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new AgentRuntimeError('TASK_EXECUTION_FAILED', message)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
