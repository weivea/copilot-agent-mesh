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
	readonly configResolver?: SessionConfigurationResolver;
	readonly cancellationTimeoutMs?: number;
}

export class AhpAgentRuntime implements AgentRuntime {
	private readonly tasks = new Set<AhpTask>();
	private disposed = false;

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
		if (await this.options.confirmation.confirm(request) === 'deny') {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The local user denied this task.');
		}

		const host = await this.options.launcher.launch();
		try {
			const connection = await this.options.connections.connect(host.endpoint);
			let task: AhpTask;
			task = new AhpTask(
				request,
				host,
				connection,
				this.options.connections,
				this.options.authBroker,
				this.options.configResolver ?? new DefaultSessionConfigurationResolver(),
				this.options.cancellationTimeoutMs ?? cancellationTimeoutMs,
				() => this.tasks.delete(task),
			);
			this.tasks.add(task);
			await task.start();
			return task;
		} catch (error) {
			await host.dispose().catch(() => undefined);
			throw normalizeRuntimeError(error);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		await Promise.all([...this.tasks].map((task) => task.dispose()));
		await this.options.launcher.dispose();
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
	private connection: AhpConnection;
	private chatUri: string | undefined;
	private turnId: string | undefined;
	private provider: AgentInfo | undefined;
	private sessionReady = false;
	private sessionDefaultChat: string | undefined;
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

	constructor(
		private readonly request: AgentTaskRequest,
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
		const initialized = await this.connection.initialize(this.clientId);
		this.lastSeenServerSeq = initialized.serverSeq;
		const rootSnapshot = initialized.snapshots.find(({ resource }) => resource === rootUri);
		if (rootSnapshot === undefined) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'AHP initialize did not return the root snapshot.');
		}
		const root = parseRootState(rootSnapshot);
		this.provider = selectProvider(root.agents, this.request.providerId);
		await this.authenticate(this.provider.protectedResources ?? [], 'initial', this.request.allowInteractiveAuthentication === true);
		this.addSubscription(rootUri, this.connection.attachSubscription(rootUri));

		const config = await this.resolveConfig();
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
		await this.subscribeOwnedTerminals(root.terminals ?? []);

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

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.cancellationTimer !== undefined) {
			clearTimeout(this.cancellationTimer);
		}
		this.exitSubscription?.dispose();
		await Promise.all([...this.subscriptions.keys()].map((uri) =>
			this.connection.unsubscribe(uri).catch(() => undefined),
		));
		await this.connection.disposeSession(this.sessionUri).catch(() => undefined);
		await this.connection.shutdown().catch(() => undefined);
		await this.host.dispose();
		this.events.close();
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
	): Promise<void> {
		await this.authBroker.authenticate(
			{ resources, interactive, reason },
			(resource, token, scopes) => this.connection.authenticate(resource, token, scopes),
		);
	}

	private addSubscription(uri: string, subscription: AhpSubscription): void {
		this.subscriptions.set(uri, subscription);
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
					void this.handleAuthNotification(event.params);
				}
			}
			if (!this.disposed && !this.terminal && this.subscriptions.get(uri) === subscription) {
				void this.recover();
			}
		} catch {
			if (!this.disposed && !this.terminal) {
				void this.recover();
			}
		}
	}

	private handleEnvelope(envelope: ActionEnvelope): void {
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
				void this.subscribeOwnedTerminals(action.terminals);
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

	private applySnapshot(snapshot: Snapshot): void {
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
			void this.subscribeOwnedTerminals(root.terminals ?? []);
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

	private async subscribeOwnedTerminals(terminals: readonly TerminalInfo[]): Promise<void> {
		const owned = terminals.filter(({ claim }) =>
			claim.kind === 'session' && claim.session === this.sessionUri,
		);
		for (const terminal of owned) {
			if (this.subscriptions.has(terminal.resource)) {
				continue;
			}
			const result = await this.connection.subscribe(terminal.resource);
			if (result.snapshot !== undefined) {
				this.applySnapshot(result.snapshot);
			}
			this.addSubscription(terminal.resource, result.subscription);
		}
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

	private async recover(): Promise<void> {
		if (this.recovering || this.disposed || this.terminal) {
			return;
		}
		this.recovering = true;
		this.events.push({ type: 'progress', message: 'Reconnecting to Agent Host.' });
		try {
			const connection = await this.connectionFactory.connect(this.host.endpoint);
			const recoveredSubscriptions = new Map<string, AhpSubscription>();
			for (const uri of this.subscriptions.keys()) {
				recoveredSubscriptions.set(uri, connection.attachSubscription(uri));
			}
			const result = await connection.reconnect(
				this.clientId,
				this.lastSeenServerSeq,
				[...this.subscriptions.keys()],
			);
			if (result.type === 'replay') {
				for (const action of result.actions ?? []) {
					this.handleEnvelope(action);
				}
				if ((result.missing ?? []).includes(this.sessionUri) || (result.missing ?? []).includes(this.chatUri ?? '')) {
					throw new Error('The Agent Host no longer has the task session.');
				}
			} else {
				for (const snapshot of result.snapshots ?? []) {
					this.applySnapshot(snapshot);
				}
			}
			const sessions = await connection.listSessions();
			if (!sessions.some(({ resource }) => resource === this.sessionUri)) {
				throw new Error('The Agent Host session is missing after reconnect.');
			}
			await this.connection.shutdown().catch(() => undefined);
			this.connection = connection;
			this.subscriptions.clear();
			for (const [uri, subscription] of recoveredSubscriptions) {
				this.addSubscription(uri, subscription);
			}
			if (this.provider !== undefined) {
				await this.authenticate(
					this.provider.protectedResources ?? [],
					'tokenInvalid',
					this.request.allowInteractiveAuthentication === true,
				);
			}
			this.events.push({ type: 'progress', message: 'Agent Host connection recovered.' });
		} catch {
			this.fail(new AgentRuntimeError(
				'TASK_RECOVERY_UNAVAILABLE',
				'The Agent Host task could not be recovered after the connection closed.',
			));
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

	private fail(error: AgentRuntimeError): void {
		if (this.terminal || this.disposed) {
			return;
		}
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
	if (!request.workspace.registered || !request.workspace.uri.startsWith('file:')) {
		throw new AgentRuntimeError(
			'AGENT_UNAVAILABLE',
			'Agent Host tasks require a registered local file workspace.',
		);
	}
	if (request.prompt.trim().length === 0) {
		throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'An Agent Host task prompt is required.');
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

function buildPrompt(request: AgentTaskRequest): string {
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
