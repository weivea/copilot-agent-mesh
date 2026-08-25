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
	subscribe(uri: string): Promise<{ readonly snapshot?: Snapshot; readonly subscription: AhpSubscription }>;
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
	): Promise<readonly { readonly value: string; readonly label: string }[]>;
	createSession(params: {
		readonly sessionUri: string;
		readonly provider: string;
		readonly workingDirectories: readonly string[];
		readonly config: Readonly<Record<string, unknown>>;
		readonly clientId: string;
	}): Promise<void>;
	listSessions(): Promise<readonly { readonly resource: string }[]>;
	dispatch(channel: string, action: unknown): void;
	unsubscribe(uri: string): Promise<void>;
	disposeSession(uri: string): Promise<void>;
	shutdown(): Promise<void>;
}

export interface AhpConnectionFactory {
	connect(endpoint: URL): Promise<AhpConnection>;
}

export interface SessionConfigurationResolver {
	resolve(request: {
		readonly schema: SessionConfigSchema;
		readonly values: Readonly<Record<string, unknown>>;
		readonly completions: (
			property: string,
			currentValues: Readonly<Record<string, unknown>>,
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
		if (workspace === undefined) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The requested workspace is not registered on this device.');
		}
		validateWorkspace(request.workspaceId, workspace);
		const resolvedRequest: ResolvedAgentTaskRequest = { ...request, workspace };
		if (await this.options.confirmation.confirm(resolvedRequest) === 'deny') {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The local user denied this task.');
		}

		const host = await this.options.launcher.launch();
		let connection: AhpConnection | undefined;
		let task: AhpTask | undefined;
		try {
			connection = await this.options.connections.connect(host.endpoint);
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
		this.disposePromise ??= this.disposeResources();
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
}

export class SdkAhpConnectionFactory implements AhpConnectionFactory {
	async connect(endpoint: URL): Promise<AhpConnection> {
		if (typeof globalThis.WebSocket !== 'function') {
			throw new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'The VS Code Extension Host does not provide the WebSocket transport required by AHP.',
			);
		}
		const socket = await connectWebSocket(endpoint, 10_000);
		const [{ AhpClient }, { WebSocketTransport }, protocol] = await Promise.all([
			import('@microsoft/agent-host-protocol/client'),
			import('@microsoft/agent-host-protocol/ws'),
			import('@microsoft/agent-host-protocol'),
		]);
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

	async subscribe(uri: string): Promise<{ readonly snapshot?: Snapshot; readonly subscription: AhpSubscription }> {
		const result = await this.client.subscribe(uri);
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
	): Promise<readonly { readonly value: string; readonly label: string }[]> {
		const result = await this.client.sessionConfigCompletions({
			provider,
			workingDirectory,
			config: { ...config },
			property,
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

	dispatch(channel: string, action: unknown): void {
		this.client.dispatch(channel, action as StateAction);
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
				const options = await request.completions(id, values);
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
	private readonly subscriptions = new Map<string, AhpSubscription>();
	private readonly staleConnections = new Set<AhpConnection>();
	private connection: AhpConnection;
	private chatUri: string | undefined;
	private turnId: string | undefined;
	private provider: AgentInfo | undefined;
	private sessionReady = false;
	private sessionDefaultChat: string | undefined;
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
	private readonly authenticationInFlight = new WeakMap<AhpConnection, Map<string, Promise<void>>>();
	private readonly pendingAuthNotifications = new Set<Promise<void>>();
	private terminalError: AgentRuntimeError | undefined;
	private rootTerminals: readonly TerminalInfo[] = [];
	private terminalSubscriptionUpdate = Promise.resolve();

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
		this.lastSeenServerSeq = initialized.serverSeq;
		const rootSnapshot = initialized.snapshots.find(({ resource }) => resource === rootUri);
		if (rootSnapshot === undefined) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'AHP initialize did not return the root snapshot.');
		}
		const root = parseRootState(rootSnapshot);
		this.provider = selectProvider(root.agents, this.request.providerId);
		this.rootTerminals = root.terminals ?? [];
		this.startSubscription(rootUri, rootSubscription);
		await this.authenticate(this.provider.protectedResources ?? [], 'initial', this.request.allowInteractiveAuthentication === true);
		await Promise.resolve();
		await this.drainAuthNotifications();
		if (this.terminalError !== undefined) {
			throw this.terminalError;
		}

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

		const sessionSubscription = await this.connection.subscribe(this.sessionUri);
		if (sessionSubscription.snapshot !== undefined) {
			this.applySnapshot(sessionSubscription.snapshot);
		}
		this.addSubscription(this.sessionUri, sessionSubscription.subscription);
		const [_, defaultChat] = await Promise.all([
			this.waitForReady(),
			this.waitForDefaultChat(),
		]);
		this.chatUri = defaultChat;

		const chatSubscription = await this.connection.subscribe(defaultChat);
		if (chatSubscription.snapshot !== undefined) {
			this.applySnapshot(chatSubscription.snapshot);
		}
		this.addSubscription(defaultChat, chatSubscription.subscription);
		await this.scheduleOwnedTerminals(this.rootTerminals, this.connection, this.subscriptions, true);

		this.turnId = randomUUID();
		this.connection.dispatch(defaultChat, {
			type: 'chat/turnStarted',
			turnId: this.turnId,
			startedAt: new Date().toISOString(),
			message: {
				text: buildPrompt(this.request),
				origin: { kind: 'user' },
			},
		});
		this.events.push({ type: 'progress', message: 'Agent turn started.' });
	}

	async cancel(): Promise<void> {
		if (this.terminal || this.disposed || this.chatUri === undefined) {
			return;
		}
		this.events.push({ type: 'progress', message: 'Cancellation requested.' });
		this.connection.dispatch(this.chatUri, {
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
		const dispatch = this.mapper.createAnswer(answer);
		if ('authentication' in dispatch) {
			await this.authenticate([dispatch.authentication], 'challenge', true);
			this.mapper.completeAuthentication(dispatch.requestId);
			return;
		}
		this.connection.dispatch(dispatch.channel, dispatch.action);
	}

	dispose(): Promise<void> {
		this.disposePromise ??= this.disposeResources();
		return this.disposePromise;
	}

	private async disposeResources(): Promise<void> {
		this.disposed = true;
		if (this.cancellationTimer !== undefined) {
			clearTimeout(this.cancellationTimer);
		}
		this.exitSubscription?.dispose();
		const failures: string[] = [];
		try {
			await collectCleanupFailures(
				[...this.subscriptions].map(([uri, subscription]) => ({
					label: `close subscription ${safeCleanupResource(uri)}`,
					run: () => subscription.close(),
				})),
				failures,
			);
			await collectCleanupFailures(
				[...this.subscriptions.keys()].map((uri) => ({
					label: `unsubscribe ${safeCleanupResource(uri)}`,
					run: () => this.connection.unsubscribe(uri),
				})),
				failures,
			);
			this.subscriptions.clear();
			await collectCleanupFailures([
				{ label: 'dispose AHP session', run: () => this.connection.disposeSession(this.sessionUri) },
			], failures);
			await collectCleanupFailures([
				{ label: 'shutdown AHP connection', run: () => this.connection.shutdown() },
			], failures);
			await collectCleanupFailures(
				[...this.staleConnections].map((connection) => ({
					label: 'shutdown stale AHP connection',
					run: async () => {
						await connection.shutdown();
						this.staleConnections.delete(connection);
					},
				})),
				failures,
			);
			await collectCleanupFailures([
				{ label: 'dispose owned Agent Host', run: () => this.host.dispose() },
			], failures);
		} finally {
			this.events.close();
			this.didDispose();
		}
		if (failures.length > 0) {
			throw cleanupFailure(failures);
		}
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
				completions: (property, currentValues) => this.connection.sessionConfigCompletions(
					provider.provider,
					this.request.workspace.uri,
					currentValues,
					property,
				),
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
	): Promise<void> {
		let connectionAuthentication = this.authenticationInFlight.get(connection);
		if (connectionAuthentication === undefined) {
			connectionAuthentication = new Map<string, Promise<void>>();
			this.authenticationInFlight.set(connection, connectionAuthentication);
		}
		const pending = new Set<Promise<void>>();
		const fresh = new Map<string, ProtectedResource>();
		for (const resource of resources.filter(({ required }) => required !== false)) {
			const existing = connectionAuthentication.get(resource.resource);
			if (existing === undefined) {
				fresh.set(resource.resource, resource);
			} else {
				pending.add(existing);
			}
		}
		let operation: Promise<void> | undefined;
		if (fresh.size > 0) {
			operation = this.authBroker.authenticate(
				{ resources: [...fresh.values()], interactive, reason },
				(resource, token, scopes) => connection.authenticate(resource, token, scopes),
			);
			for (const resource of fresh.keys()) {
				connectionAuthentication.set(resource, operation);
			}
			pending.add(operation);
		}
		try {
			await Promise.all(pending);
		} finally {
			if (operation !== undefined) {
				for (const resource of fresh.keys()) {
					if (connectionAuthentication.get(resource) === operation) {
						connectionAuthentication.delete(resource);
					}
				}
			}
		}
	}

	private addSubscription(uri: string, subscription: AhpSubscription): void {
		this.subscriptions.set(uri, subscription);
		this.startSubscription(uri, subscription);
	}

	private startSubscription(uri: string, subscription: AhpSubscription): void {
		void this.pumpSubscription(uri, subscription);
	}

	private async pumpSubscription(uri: string, subscription: AhpSubscription): Promise<void> {
		try {
			for await (const event of subscription) {
				if (this.disposed || this.subscriptions.get(uri) !== subscription) {
					return;
				}
				if (event.type === 'action') {
					this.handleEnvelope(event.params as ActionEnvelope);
				} else {
					this.trackAuthNotification(event.params);
				}
			}
			if (!this.disposed && !this.terminal && this.subscriptions.get(uri) === subscription) {
				this.handleSubscriptionLoss();
			}
		} catch {
			if (!this.disposed && !this.terminal) {
				this.handleSubscriptionLoss();
			}
		}
	}

	private handleSubscriptionLoss(): void {
		if (this.sessionCreated) {
			void this.recover();
			return;
		}
		this.fail(new AgentRuntimeError(
			'AGENT_UNAVAILABLE',
			'The Agent Host connection closed while the task was starting.',
		));
	}

	private handleEnvelope(envelope: ActionEnvelope, subscribeRootTerminals = true): void {
		this.lastSeenServerSeq = Math.max(this.lastSeenServerSeq, envelope.serverSeq);
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
					void this.scheduleOwnedTerminals(
						action.terminals,
						this.connection,
						this.subscriptions,
						true,
					).catch((error: unknown) => this.fail(normalizeRuntimeError(error)));
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
			} else if (action.type === 'session/defaultChatChanged' && action.defaultChat !== undefined) {
				this.sessionDefaultChat = action.defaultChat;
				this.defaultChatResolve?.(action.defaultChat);
			}
		}
		this.emitMappedEvents(this.mapper.map(envelope));
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
				this.sessionDefaultChat = state.defaultChat;
				this.defaultChatResolve?.(state.defaultChat);
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
				void this.scheduleOwnedTerminals(
					this.rootTerminals,
					this.connection,
					this.subscriptions,
					true,
				).catch((error: unknown) => this.fail(normalizeRuntimeError(error)));
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
			for (const part of activeTurn.responseParts) {
				this.restorePendingResponsePart(chatUri, part);
			}
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

	private restorePendingResponsePart(chatUri: string, value: unknown): void {
		if (!isRecord(value)) {
			return;
		}
		if (value.kind === 'inputRequest' && isRecord(value.request) && value.response === undefined) {
			this.handleEnvelope(envelopeFromSnapshot(chatUri, {
				type: 'chat/inputRequested',
				request: value.request,
			}, this.lastSeenServerSeq));
			return;
		}
		if (value.kind !== 'toolCall' || !isRecord(value.toolCall)) {
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
		if (this.sessionDefaultChat !== undefined) {
			return Promise.resolve(this.sessionDefaultChat);
		}
		return withTimeout(new Promise<string>((resolvePromise, reject) => {
			this.defaultChatResolve = resolvePromise;
			this.defaultChatReject = reject;
		}), sessionReadyTimeoutMs, 'The Agent Host session did not publish a default chat.');
	}

	private async subscribeOwnedTerminals(
		terminals: readonly TerminalInfo[],
		connection: AhpConnection,
		subscriptions: Map<string, AhpSubscription>,
		startPumps: boolean,
	): Promise<void> {
		const owned = terminals.filter(({ claim }) =>
			claim.kind === 'session' && claim.session === this.sessionUri,
		);
		const ownedResources = new Set(owned.map(({ resource }) => resource));
		for (const [uri, subscription] of subscriptions) {
			if (uri.startsWith('ahp-terminal:') && !ownedResources.has(uri)) {
				subscriptions.delete(uri);
				await subscription.close();
				await connection.unsubscribe(uri);
			}
		}
		for (const terminal of owned) {
			if (subscriptions.has(terminal.resource)) {
				continue;
			}
			const result = await connection.subscribe(terminal.resource);
			if (result.snapshot !== undefined) {
				this.applySnapshot(result.snapshot, false);
			}
			subscriptions.set(terminal.resource, result.subscription);
			if (startPumps) {
				this.startSubscription(terminal.resource, result.subscription);
			}
		}
	}

	private scheduleOwnedTerminals(
		terminals: readonly TerminalInfo[],
		connection: AhpConnection,
		subscriptions: Map<string, AhpSubscription>,
		startPumps: boolean,
	): Promise<void> {
		const update = this.terminalSubscriptionUpdate.then(() =>
			this.subscribeOwnedTerminals(terminals, connection, subscriptions, startPumps),
		);
		this.terminalSubscriptionUpdate = update.catch(() => undefined);
		return update;
	}

	private async handleAuthNotification(params: unknown): Promise<void> {
		const resources = readResourcesFromNotification(params);
		if (resources.length === 0) {
			return;
		}
		try {
			await this.authenticate(
				resources,
				'tokenInvalid',
				this.request.allowInteractiveAuthentication === true,
			);
		} catch (error) {
			this.fail(normalizeRuntimeError(error));
		}
	}

	private trackAuthNotification(params: unknown): void {
		const operation = this.handleAuthNotification(params);
		this.pendingAuthNotifications.add(operation);
		void operation.finally(() => this.pendingAuthNotifications.delete(operation));
	}

	private async drainAuthNotifications(): Promise<void> {
		while (this.pendingAuthNotifications.size > 0) {
			await Promise.all([...this.pendingAuthNotifications]);
		}
	}

	private async recover(): Promise<void> {
		if (this.recovering || this.disposed || this.terminal) {
			return;
		}
		this.recovering = true;
		this.events.push({ type: 'progress', message: 'Reconnecting to Agent Host.' });
		let candidate: AhpConnection | undefined;
		const recoveredSubscriptions = new Map<string, AhpSubscription>();
		let recoveredTerminals: readonly TerminalInfo[] | undefined;
		try {
			candidate = await this.connectionFactory.connect(this.host.endpoint);
			for (const uri of this.subscriptions.keys()) {
				recoveredSubscriptions.set(uri, candidate.attachSubscription(uri));
			}
			const result = await candidate.reconnect(
				this.clientId,
				this.lastSeenServerSeq,
				[...this.subscriptions.keys()],
			);
			if (result.type === 'replay') {
				for (const action of result.actions ?? []) {
					if (action.channel === rootUri && action.action.type === 'root/terminalsChanged') {
						recoveredTerminals = action.action.terminals;
					}
					this.handleEnvelope(action, false);
				}
				const missing = result.missing ?? [];
				if (missing.includes(this.sessionUri) || missing.includes(this.chatUri ?? '')) {
					throw new RecoveryUnavailableCause('The Agent Host no longer has the task session.');
				}
				for (const uri of missing) {
					await recoveredSubscriptions.get(uri)?.close();
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
						await subscription.close();
						recoveredSubscriptions.delete(uri);
					}
				}
				for (const snapshot of snapshots) {
					if (snapshot.resource === rootUri) {
						recoveredTerminals = parseRootState(snapshot).terminals ?? [];
					}
					this.applySnapshot(snapshot, false);
				}
			}
			const sessions = await candidate.listSessions();
			if (!sessions.some(({ resource }) => resource === this.sessionUri)) {
				throw new RecoveryUnavailableCause('The Agent Host session is missing after reconnect.');
			}
			if (this.provider !== undefined) {
				await this.authenticate(
					this.provider.protectedResources ?? [],
					'tokenInvalid',
					this.request.allowInteractiveAuthentication === true,
					candidate,
				);
			}
			if (recoveredTerminals !== undefined) {
				await this.scheduleOwnedTerminals(
					recoveredTerminals,
					candidate,
					recoveredSubscriptions,
					false,
				);
			}
			const previousConnection = this.connection;
			this.connection = candidate;
			this.subscriptions.clear();
			for (const [uri, subscription] of recoveredSubscriptions) {
				this.addSubscription(uri, subscription);
			}
			try {
				await previousConnection.shutdown();
			} catch {
				this.staleConnections.add(previousConnection);
			}
			this.events.push({ type: 'progress', message: 'Agent Host connection recovered.' });
		} catch (error) {
			let failure = error instanceof RecoveryUnavailableCause
				? new AgentRuntimeError(
					'TASK_RECOVERY_UNAVAILABLE',
					'The Agent Host task could not be recovered because its Host or Session is unavailable.',
				)
				: normalizeRuntimeError(error);
			if (candidate !== undefined && candidate !== this.connection) {
				const cleanup = await cleanupRecoveryCandidate(candidate, recoveredSubscriptions);
				if (cleanup !== undefined) {
					failure = combineRuntimeErrors(failure, cleanup);
				}
			}
			this.fail(failure);
		} finally {
			this.recovering = false;
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

class RecoveryUnavailableCause extends Error {}

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

async function cleanupRecoveryCandidate(
	connection: AhpConnection,
	subscriptions: ReadonlyMap<string, AhpSubscription>,
): Promise<AgentRuntimeError | undefined> {
	const failures: string[] = [];
	await collectCleanupFailures(
		[...subscriptions].map(([uri, subscription]) => ({
			label: `close recovery subscription ${safeCleanupResource(uri)}`,
			run: () => subscription.close(),
		})),
		failures,
	);
	await collectCleanupFailures([
		{ label: 'shutdown recovery AHP connection', run: () => connection.shutdown() },
	], failures);
	return failures.length === 0 ? undefined : cleanupFailure(failures);
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

function connectWebSocket(endpoint: URL, timeoutMs: number): Promise<WebSocket> {
	return new Promise((resolveSocket, reject) => {
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
		socket.addEventListener('open', handleOpen);
		socket.addEventListener('error', handleError);
		socket.addEventListener('close', handleClose);
	});
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
