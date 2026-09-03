import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import NodeWebSocket from 'ws';

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
	AsyncEventQueueCapacityError,
	createAgentRuntimeEventQueue,
	type AgentRecoveryDescriptor,
	type AgentRuntimeApprovalCapabilityIssuer,
	type AgentRuntime,
	type AgentRuntimeEvent,
	type AgentRuntimeLifecycleObservation,
	type AgentRuntimeProbe,
	type AgentRuntimeLifecycleObserver,
	type AgentTaskAnswer,
	type AgentTaskHandle,
	type AgentTaskRequest,
	type FirstTaskConfirmation,
	type ResolvedAgentTaskRequest,
	type WorkspaceResolver,
} from './AgentRuntime';
import type { DelegatedToolInvocationRegistry } from '../tools/DelegatedToolInvocationRegistry';
import { sanitizeDelegationText } from '../tools/DelegationTextSanitizer';
import { redactRegisteredSensitiveValues } from '../security/SensitiveValueRedaction';
import { UnixSocketWebSocketError } from './UnixSocketWebSocketConnector';
import type { AgentHostLauncherLike, LaunchedAgentHost } from './AgentHostLauncher';
import type { AuthBroker, ProtectedResource } from './AuthBroker';

const rootUri = 'ahp-root://';
const offeredProtocolVersion = '1.0.0';
export const AHP_PROTOCOL_OFFER: readonly ['1.0.0'] = Object.freeze(['1.0.0']);
const sessionDefaultChatTimeoutMs = 60_000;
const cancellationTimeoutMs = 15_000;
const actionAcknowledgementTimeoutMs = 10_000;
const terminalSessionMaterializationTimeoutMs = 10_000;
const subscriptionPumpSettleTimeoutMs = 5_000;
const connectionGracefulShutdownMs = 1_000;
const connectionForcedShutdownMs = 5_000;
const sessionCatalogPageLimit = 200;
const sessionCatalogMaxPages = 50;
const sessionCatalogMaxEntries = sessionCatalogPageLimit * sessionCatalogMaxPages;
const sessionCatalogCursorMaxLength = 4_096;
const sessionStatusIdle = 1;
const sessionStatusError = 1 << 1;
const sessionStatusInProgress = 1 << 3;
const sessionStatusArchived = 1 << 6;
const sessionTitleBytes = 256;
export const DELEGATED_AGENT_CLIENT_TOOLS: readonly never[] = Object.freeze([]);

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

export interface AhpSessionSummary {
	readonly resource: string;
	readonly status?: number;
}

export interface AhpSessionPage {
	readonly items: readonly AhpSessionSummary[];
	readonly nextCursor?: string;
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
	listSessions(limit?: number, cursor?: string): Promise<AhpSessionPage>;
	dispatch(channel: string, action: unknown, clientSeq?: number): number;
	unsubscribe(uri: string): Promise<void>;
	disposeSession(uri: string): Promise<void>;
	shutdown(): Promise<void>;
}

export interface AhpConnectionFactory {
	connect(host: LaunchedAgentHost, signal?: AbortSignal): Promise<AhpConnection>;
}

export interface SessionConfigurationResolver {
	resolve(request: {
		readonly schema: SessionConfigSchema;
		readonly values: Readonly<Record<string, unknown>>;
		readonly interactive: boolean;
		readonly signal?: AbortSignal;
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
	readonly approvalCapabilities?: AgentRuntimeApprovalCapabilityIssuer;
	readonly workspaceResolver: WorkspaceResolver;
	readonly configResolver?: SessionConfigurationResolver;
	readonly cancellationTimeoutMs?: number;
	readonly terminalSessionMaterializationTimeoutMs?: number;
	readonly subscriptionPumpSettleTimeoutMs?: number;
	readonly delegatedToolInvocations?: DelegatedToolInvocationRegistry;
	readonly lifecycleObserver?: AgentRuntimeLifecycleObserver;
}

export class AhpAgentRuntime implements AgentRuntime {
	private readonly tasks = new Set<AhpTask>();
	private readonly failedStartCleanups = new Set<{ dispose(): Promise<void> }>();
	private readonly inFlightStarts = new Set<{
		readonly controller: AbortController;
		readonly operation: Promise<AgentTaskHandle>;
	}>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;
	private failedStartCleanupRetry: Promise<void> | undefined;
	private startQueueTail: Promise<void> = Promise.resolve();

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

	start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		const controller = new AbortController();
		const predecessor = this.startQueueTail;
		let releaseTurn!: () => void;
		const turn = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		this.startQueueTail = predecessor.then(() => turn, () => turn);
		let tracked!: {
			readonly controller: AbortController;
			readonly operation: Promise<AgentTaskHandle>;
		};
		const operation = this.startQueued(
			request,
			controller.signal,
			predecessor,
			releaseTurn,
		)
			.finally(() => this.inFlightStarts.delete(tracked));
		tracked = { controller, operation };
		this.inFlightStarts.add(tracked);
		return operation;
	}

	public async prepareStart(): Promise<void> {
		if (this.disposed || !this.options.enabled()) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The production Agent Host runtime is disabled.');
		}
		await this.startQueueTail;
		this.throwIfDisposed();
		await this.retryFailedStartCleanup();
		this.throwIfDisposed();
	}

	private async startQueued(
		request: AgentTaskRequest,
		signal: AbortSignal,
		predecessor: Promise<void>,
		releaseTurn: () => void,
	): Promise<AgentTaskHandle> {
		await predecessor.catch(() => undefined);
		try {
			return await this.startTracked(request, signal);
		} finally {
			releaseTurn();
		}
	}

	private async startTracked(
		request: AgentTaskRequest,
		signal: AbortSignal,
	): Promise<AgentTaskHandle> {
		if (this.disposed || !this.options.enabled()) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The production Agent Host runtime is disabled.');
		}
		await this.retryFailedStartCleanup();
		this.throwIfDisposed();
		validateRequest(request);
		const workspace = await this.options.workspaceResolver.resolve(request.workspaceId);
		this.throwIfDisposed();
		if (workspace === undefined) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The requested workspace is not registered on this device.');
		}
		validateWorkspace(request.workspaceId, workspace);
		const resolvedRequest: ResolvedAgentTaskRequest = { ...request, workspace };
		if (
			this.options.approvalCapabilities?.accepts(request) !== true
			&& await this.options.confirmation.confirm(resolvedRequest) !== 'once'
		) {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The local user denied this task.');
		}
		this.throwIfDisposed();

		const host = await this.options.launcher.launch(signal);
		if (this.disposed) {
			const cleanupOwner = new DetachedAgentHostCleanup(host, undefined);
			let cleanup: AgentRuntimeError | undefined;
			try {
				await cleanupOwner.dispose();
			} catch (error) {
				this.failedStartCleanups.add(cleanupOwner);
				cleanup = normalizeRuntimeError(error);
			}
			const error = new AgentRuntimeError('AGENT_UNAVAILABLE', 'The production Agent Host runtime was disposed during startup.');
			throw cleanup === undefined ? error : combineRuntimeErrors(error, cleanup);
		}
		let connection: AhpConnection | undefined;
		let task: AhpTask | undefined;
		try {
			try {
				connection = await this.options.connections.connect(host, signal);
			} catch (error) {
				throw new AgentRuntimeError(
					'AGENT_UNAVAILABLE',
					'The Agent Host connection could not be established.',
					false,
					error instanceof UnixSocketWebSocketError ? error : undefined,
				);
			}
			this.throwIfDisposed();
			const createdTask = new AhpTask(
				resolvedRequest,
				host,
				connection,
				this.options.connections,
				this.options.authBroker,
				this.options.configResolver ?? new DefaultSessionConfigurationResolver(),
				this.options.cancellationTimeoutMs ?? cancellationTimeoutMs,
				this.options.terminalSessionMaterializationTimeoutMs ?? terminalSessionMaterializationTimeoutMs,
				this.options.subscriptionPumpSettleTimeoutMs ?? subscriptionPumpSettleTimeoutMs,
				this.options.delegatedToolInvocations,
				this.options.lifecycleObserver,
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
			const cleanupOwner = task ?? new DetachedAgentHostCleanup(host, connection);
			try {
				await cleanupOwner.dispose();
			} catch (cleanup) {
				this.failedStartCleanups.add(cleanupOwner);
				cleanupError = normalizeRuntimeError(cleanup);
			}
			throw cleanupError === undefined ? primary : combineRuntimeErrors(primary, cleanupError);
		}
	}

	private retryFailedStartCleanup(): Promise<void> {
		if (this.failedStartCleanupRetry !== undefined) {
			return this.failedStartCleanupRetry;
		}
		if (this.failedStartCleanups.size === 0) {
			return Promise.resolve();
		}
		let operation!: Promise<void>;
		operation = this.retryFailedStartCleanupOwners().finally(() => {
			if (this.failedStartCleanupRetry === operation) {
				this.failedStartCleanupRetry = undefined;
			}
		});
		this.failedStartCleanupRetry = operation;
		return operation;
	}

	private async retryFailedStartCleanupOwners(): Promise<void> {
		const failures: string[] = [];
		await collectCleanupFailures(
			[...this.failedStartCleanups].map((owner) => ({
				label: 'retry failed Agent Host start cleanup',
				run: async () => {
					await owner.dispose();
					this.failedStartCleanups.delete(owner);
				},
			})),
			failures,
		);
		if (failures.length > 0) {
			throw cleanupFailure(failures);
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
		for (const start of this.inFlightStarts) {
			start.controller.abort();
		}
		if (this.inFlightStarts.size > 0) {
			await Promise.all(
				[...this.tasks].map((task) => task.dispose().catch(() => undefined)),
			);
		}
		await Promise.all(
			[...this.inFlightStarts].map(({ operation }) => operation.catch(() => undefined)),
		);
		const failures: string[] = [];
		const cleanupOwners = new Set([
			...this.tasks,
			...this.failedStartCleanups,
		]);
		await collectCleanupFailures(
			[...cleanupOwners].map((owner) => ({
				label: 'dispose active Agent Host task',
				run: async () => {
					await owner.dispose();
					this.failedStartCleanups.delete(owner);
				},
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
	async connect(host: LaunchedAgentHost, signal?: AbortSignal): Promise<AhpConnection> {
		const socket = host.openWebSocket === undefined
			? await connectWebSocket(host.endpoint, 10_000, signal)
			: await host.openWebSocket(signal);
		const [{ AhpClient }, { WebSocketTransport }] = await Promise.all([
			import('@microsoft/agent-host-protocol/client'),
			import('@microsoft/agent-host-protocol/ws'),
		]);
		if (signal?.aborted === true) {
			socket.terminate();
			throw new RecoveryStoppedCause();
		}
		const client = new AhpClient(
			WebSocketTransport.fromSocket(socket as unknown as globalThis.WebSocket),
			{ requestTimeoutMs: 30_000 },
		);
		client.connect();
		return new SdkAhpConnection(client, AHP_PROTOCOL_OFFER, () => socket.terminate());
	}
}

class SdkAhpConnection implements AhpConnection {
	constructor(
		private readonly client: import(
			'@microsoft/agent-host-protocol/client',
			{ with: { 'resolution-mode': 'import' } }
		).AhpClient,
		private readonly supportedVersions: readonly string[],
		private readonly forceClose: () => void,
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
			await unsubscribeThenClose(
				this,
				uri,
				adaptSubscription(result.subscription),
			).catch(() => undefined);
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
				tools: [...DELEGATED_AGENT_CLIENT_TOOLS],
			},
			progressToken: randomUUID(),
		});
	}

	async listSessions(limit?: number, cursor?: string): Promise<AhpSessionPage> {
		if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) {
			throw new TypeError('The Agent Host Session list limit is invalid.');
		}
		const result = await this.client.request('listSessions', {
			channel: rootUri,
			...(limit === undefined ? {} : { limit }),
			...(cursor === undefined ? {} : { cursor }),
		});
		return {
			items: result.items.map(({ resource, status }) => ({ resource, status })),
			...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
		};
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
		const operation = this.client.shutdown();
		let forceTimer: NodeJS.Timeout | undefined;
		const forcedCloseFailure = new Promise<never>((_resolve, reject) => {
			forceTimer = setTimeout(() => {
				try {
					this.forceClose();
				} catch (error: unknown) {
					reject(error);
				}
			}, connectionGracefulShutdownMs);
		});
		try {
			await withTimeout(
				Promise.race([operation, forcedCloseFailure]),
				connectionForcedShutdownMs,
				'The Agent Host connection did not shut down after its socket was closed.',
			);
		} finally {
			if (forceTimer !== undefined) {
				clearTimeout(forceTimer);
			}
		}
	}
}

class DefaultSessionConfigurationResolver implements SessionConfigurationResolver {
	async resolve(
		request: Parameters<SessionConfigurationResolver['resolve']>[0],
	): Promise<Readonly<Record<string, unknown>>> {
		throwIfAborted(request.signal);
		const values: Record<string, unknown> = { ...request.values };
		for (const [id, property] of Object.entries(request.schema.properties)) {
			throwIfAborted(request.signal);
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
				const options = await request.completions(id, values, '', request.signal);
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
	readonly events = createAgentRuntimeEventQueue();
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
	private sessionDefaultChat: string | undefined;
	private sessionDefaultChatState: 'unknown' | 'available' | 'cleared' = 'unknown';
	private sessionDefaultChatRevision = 0;
	private sessionCreated = false;
	private hostSessionObserved = false;
	private lastSeenServerSeq = 0;
	private terminal = false;
	private authoritativeTurnTerminal = false;
	private terminalSessionArchived = false;
	private terminalSessionClientLeft = false;
	private terminalClientDetachedObserved = false;
	private terminalHistoryPreparations = 0;
	private sessionMaterialized = false;
	private readonly sessionMaterializedPromise: Promise<void>;
	private readonly resolveSessionMaterialized: () => void;
	private disposed = false;
	private recovering = false;
	private recoveryCandidate: AhpConnection | undefined;
	private recoveryRequestedAfterHandoff = false;
	private defaultChatResolve: ((uri: string) => void) | undefined;
	private defaultChatReject: ((error: Error) => void) | undefined;
	private cancellationTimer: NodeJS.Timeout | undefined;
	private exitSubscription: { dispose(): void } | undefined;
	private disposePromise: Promise<void> | undefined;
	private readonly authenticationInFlight = new WeakMap<AhpConnection, Map<string, AuthenticationInFlight>>();
	private readonly pendingAuthNotifications = new Set<Promise<void>>();
	private readonly authenticationAbort = new AbortController();
	private readonly terminalPreparationAbort = new AbortController();
	private terminalError: AgentRuntimeError | undefined;
	private terminalHistoryPreparationFailure: AgentRuntimeError | undefined;
	private rootTerminals: readonly TerminalInfo[] = [];
	private readonly terminalSubscriptionUpdates = new Map<AhpConnection, Promise<void>>();
	private readonly intentionalSubscriptionDepartures = new WeakMap<AhpConnection, Set<string>>();
	private readonly unacknowledgedDispatches = new Map<number, {
		readonly channel: string;
		readonly action: unknown;
		readonly requestId?: string;
		readonly resolveAcknowledgement?: () => void;
		readonly rejectAcknowledgement?: (error: AgentRuntimeError) => void;
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
	private subscriptionPumpSettleFailed = false;
	private readonly shutdownConnections = new WeakSet<AhpConnection>();
	private readonly terminalSessionDepartingConnections = new WeakSet<AhpConnection>();
	private readonly terminalSessionUnsubscribedConnections = new WeakSet<AhpConnection>();
	private readonly connectionShutdownOperations = new WeakMap<AhpConnection, Promise<void>>();
	private readonly deliveredResponsePartLengths = new Map<string, number>();
	private readonly deliveredResponsePartStates = new Set<string>();
	private readonly deliveredResponsePartOrdinals = new Map<string, number>();
	private readonly retainedRecoveryCandidates = new Set<RecoveryCandidateCleanup>();
	private readonly subscriptionPumps = new Set<Promise<void>>();
	private delegatedCorrelationEnabled = true;

	constructor(
		private readonly request: ResolvedAgentTaskRequest,
		private readonly host: LaunchedAgentHost,
		connection: AhpConnection,
		private readonly connectionFactory: AhpConnectionFactory,
		private readonly authBroker: AuthBroker,
		private readonly configResolver: SessionConfigurationResolver,
		private readonly cancelTimeoutMs: number,
		private readonly terminalMaterializationTimeoutMs: number,
		private readonly pumpSettleTimeoutMs: number,
		private readonly delegatedToolInvocations: DelegatedToolInvocationRegistry | undefined,
		private readonly lifecycleObserver: AgentRuntimeLifecycleObserver | undefined,
		private readonly didDispose: () => void,
	) {
		let resolveSessionMaterialized!: () => void;
		this.sessionMaterializedPromise = new Promise<void>((resolve) => {
			resolveSessionMaterialized = resolve;
		});
		this.resolveSessionMaterialized = resolveSessionMaterialized;
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
		let initialized: AhpInitializeResult;
		try {
			initialized = await this.connection.initialize(this.clientId);
		} catch {
			throw new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'The Agent Host protocol could not be initialized.',
			);
		}
		this.throwIfTerminalError();
		if (initialized.protocolVersion !== offeredProtocolVersion) {
			throw new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'The Agent Host selected an incompatible protocol version.',
			);
		}
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
		if (this.request.sourceWindowName !== undefined) {
			await this.dispatchAcknowledged(this.sessionUri, {
				type: 'session/titleChanged',
				title: buildMeshSessionTitle(this.request.sourceWindowName, this.request.title),
			});
		}
		// AHP 1.0 providers may create a provisional Session whose lifecycle stays
		// `creating` until its first turn materializes it. The default Chat is the
		// readiness boundary for that first dispatch; waiting for `session/ready`
		// here would deadlock with such providers.
		await this.waitForDefaultChat();
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
		await this.events.push({ type: 'progress', message: 'Agent turn started.' });
		this.throwIfTerminalFailure();
	}

	async cancel(): Promise<void> {
		if (this.terminal || this.disposed || this.chatUri === undefined) {
			return;
		}
		this.assertWritable();
		this.clearDelegatedToolInvocations();
		await this.events.push({ type: 'progress', message: 'Cancellation requested.' });
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
		if (this.authoritativeTurnTerminal && this.host.preserveTerminalSession === true) {
			this.observeLifecycleEvent('session/clientDetachStarted');
		}
		this.clearDelegatedToolInvocations();
		const recovery = this.recoveryPromise;
		this.recoveryAbort?.abort();
		this.authenticationAbort.abort();
		this.terminalPreparationAbort.abort();
		this.generation.valid = false;
		this.generation.abort.abort();
		const startupStopped = new AgentRuntimeError(
			'TASK_EXECUTION_FAILED',
			'The Agent Host task was disposed during startup.',
		);
		this.defaultChatReject?.(startupStopped);
		this.clearCancellationTimer();
		this.exitSubscription?.dispose();
		for (const pending of this.unacknowledgedDispatches.values()) {
			pending.rejectAcknowledgement?.(startupStopped);
		}
		this.unacknowledgedDispatches.clear();
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
			{
				subscription,
				closed: false,
				unsubscribed: this.shutdownConnections.has(this.connection)
					|| (
						uri === this.sessionUri
						&& this.terminalSessionUnsubscribedConnections.has(this.connection)
					),
			},
		]));
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
		if (this.authoritativeTurnTerminal && this.host.preserveTerminalSession === true) {
			this.observeLifecycleEvent('session/channelsUnsubscribed');
		}
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
		if (this.authoritativeTurnTerminal && this.host.preserveTerminalSession === true) {
			this.observeLifecycleEvent('session/subscriptionIteratorsClosed');
		}
		let pumpSettleFailure: AgentRuntimeError | undefined;
		try {
			await runCleanupPhase([{
				label: 'settle AHP subscription pumps',
				run: () => withTimeout(
					Promise.all([...this.subscriptionPumps]).then(() => undefined),
					this.pumpSettleTimeoutMs,
					'Timed out settling Agent Host subscription pumps.',
				),
			}]);
		} catch (error) {
			pumpSettleFailure = normalizeRuntimeError(error);
			this.subscriptionPumpSettleFailed = true;
		}
		if (
			pumpSettleFailure === undefined
			&& !this.subscriptionPumpSettleFailed
			&& this.authoritativeTurnTerminal
			&& this.host.preserveTerminalSession === true
		) {
			this.observeLifecycleEvent('session/subscriptionPumpsSettled');
		}
		this.subscriptions.clear();
		if (this.authoritativeTurnTerminal && this.host.preserveTerminalSession === true) {
			this.observeLifecycleEvent('session/subscriptionsClosed');
		}

		if (!this.sessionDisposed && this.shutdownConnections.has(this.connection)) {
			this.sessionDisposed = true;
		}
		if (!this.sessionCreated) {
			this.sessionDisposed = true;
		}
		if (
			!this.sessionDisposed
			&& !(this.authoritativeTurnTerminal && this.host.preserveTerminalSession === true)
		) {
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
		if (pumpSettleFailure !== undefined) {
			this.subscriptionPumps.clear();
			throw pumpSettleFailure;
		}
		const historyFailure = this.terminalHistoryPreparationFailure;
		if (historyFailure !== undefined) {
			this.terminalHistoryPreparationFailure = undefined;
			throw new AgentRuntimeError(
				historyFailure.code,
				'The authoritative Agent Host terminal was published, but its Session history could not be retained.',
				historyFailure.retryable,
				historyFailure,
				true,
			);
		}
		if (
			!this.subscriptionPumpSettleFailed
			&& this.authoritativeTurnTerminal
			&& this.host.preserveTerminalSession === true
		) {
			this.observeLifecycleEvent('session/connectionClosed');
		}
		if (
			!this.terminalClientDetachedObserved
			&& !this.subscriptionPumpSettleFailed
			&& this.authoritativeTurnTerminal
			&& this.host.preserveTerminalSession === true
		) {
			this.terminalClientDetachedObserved = true;
			this.observeLifecycleEvent('session/clientDetached');
		}
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
			const signal = this.generation.abort.signal;
			const next = await abortableConfigurationResolution(
				this.configResolver.resolve({
					schema: resolved.schema,
					values: resolved.values,
					interactive: this.request.allowInteractiveAuthentication === true,
					signal,
					completions: async (property, currentValues, query, completionSignal) => {
						throwIfAborted(completionSignal);
						const completions = await this.connection.sessionConfigCompletions(
							provider.provider,
							this.request.workspace.uri,
							currentValues,
							property,
							query,
						);
						throwIfAborted(completionSignal);
						return completions;
					},
				}),
				signal,
			);
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

	private dispatchTracked(
		channel: string,
		action: unknown,
		requestId?: string,
		acknowledgement?: {
			readonly resolve: () => void;
			readonly reject: (error: AgentRuntimeError) => void;
		},
		connection = this.connection,
	): void {
		const clientSeq = this.nextClientSeq;
		this.nextClientSeq += 1;
		const wireAction = JSON.parse(JSON.stringify(action)) as unknown;
		this.unacknowledgedDispatches.set(clientSeq, {
			channel,
			action: wireAction,
			requestId,
			resolveAcknowledgement: acknowledgement?.resolve,
			rejectAcknowledgement: acknowledgement?.reject,
		});
		try {
			connection.dispatch(channel, wireAction, clientSeq);
		} catch (error) {
			this.unacknowledgedDispatches.delete(clientSeq);
			if (connection === this.connection) {
				this.handleSubscriptionLoss();
			}
			throw normalizeRuntimeError(error);
		}
	}

	private dispatchAcknowledged(
		channel: string,
		action: unknown,
		timeoutMessage = 'The Agent Host did not acknowledge the delegated Session title.',
		connection = this.connection,
	): Promise<void> {
		let resolveAcknowledgement!: () => void;
		let rejectAcknowledgement!: (error: AgentRuntimeError) => void;
		const acknowledgement = new Promise<void>((resolve, reject) => {
			resolveAcknowledgement = resolve;
			rejectAcknowledgement = reject;
		});
		this.dispatchTracked(channel, action, undefined, {
			resolve: resolveAcknowledgement,
			reject: rejectAcknowledgement,
		}, connection);
		return withTimeout(
			acknowledgement,
			actionAcknowledgementTimeoutMs,
			timeoutMessage,
		);
	}

	private acknowledgeDispatch(envelope: ActionEnvelope): void {
		if (envelope.origin?.clientId !== this.clientId) {
			return;
		}
		const pending = this.unacknowledgedDispatches.get(envelope.origin.clientSeq);
		if (pending === undefined) {
			return;
		}
		if (
			envelope.channel !== pending.channel
			|| !isDeepStrictEqual(envelope.action, pending.action)
		) {
			return;
		}
		this.unacknowledgedDispatches.delete(envelope.origin.clientSeq);
		if (envelope.rejectionReason !== undefined) {
			pending.rejectAcknowledgement?.(new AgentRuntimeError(
				'TASK_EXECUTION_FAILED',
				'The Agent Host rejected a delegated Session action.',
			));
			return;
		}
		pending.resolveAcknowledgement?.();
		if (pending.requestId !== undefined) {
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
				await unsubscribeThenClose(
					generation.connection,
					uri,
					result.subscription,
				).catch(() => undefined);
				continue;
			}
			if (result.snapshot !== undefined) {
				if (result.snapshot.resource !== uri) {
					const failures: string[] = [];
					try {
						await unsubscribeThenClose(generation.connection, uri, result.subscription);
					} catch {
						failures.push('unsubscribe and close mismatched Agent Host resource');
					}
					const mismatch = new AgentRuntimeError(
						'TASK_EXECUTION_FAILED',
						'The Agent Host subscription returned a mismatched resource.',
					);
					throw failures.length === 0
						? mismatch
						: combineRuntimeErrors(mismatch, cleanupFailure(failures));
				}
				await this.applySnapshot(result.snapshot);
			}
			this.throwIfTerminalError();
			if (!this.isCurrentGeneration(generation)) {
				await unsubscribeThenClose(
					generation.connection,
					uri,
					result.subscription,
				).catch(() => undefined);
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
		await this.departSubscription(generation, uri, subscription);
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
		const pump = this.pumpSubscription(uri, subscription, generation);
		this.subscriptionPumps.add(pump);
		void pump.then(
			() => this.subscriptionPumps.delete(pump),
			() => this.subscriptionPumps.delete(pump),
		);
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
					await this.handleEnvelope(event.params as ActionEnvelope);
				} else {
					this.trackAuthNotification(event.params, generation);
				}
			}
			if (
				!this.disposed
				&& !this.terminal
				&& this.isCurrentGeneration(generation)
				&& generation.subscriptions.get(uri) === subscription
				&& !this.isSubscriptionDeparting(generation.connection, uri)
				&& !(
					uri === this.sessionUri
					&& (
						this.terminalSessionDepartingConnections.has(generation.connection)
						|| this.terminalSessionUnsubscribedConnections.has(generation.connection)
					)
				)
			) {
				this.handleSubscriptionLoss();
			}
		} catch (error) {
			if (
				!this.disposed
				&& !this.terminal
				&& this.isCurrentGeneration(generation)
				&& !this.isSubscriptionDeparting(generation.connection, uri)
			) {
				if (error instanceof AsyncEventQueueCapacityError) {
					this.fail(new AgentRuntimeError(
						'TASK_EXECUTION_FAILED',
						'The Agent Host emitted a control event larger than the runtime safety limit.',
					));
				} else {
					this.handleSubscriptionLoss();
				}
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

	private async handleEnvelope(
		envelope: ActionEnvelope,
		subscribeRootTerminals = true,
		terminalCatalogConnection = this.connection,
		terminalSessionSubscription?: AhpSubscription,
	): Promise<void> {
		this.lastSeenServerSeq = Math.max(this.lastSeenServerSeq, envelope.serverSeq);
		this.acknowledgeDispatch(envelope);
		const action = envelope.action;
		this.trackDelegatedToolInvocation(envelope);
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
			if (action.type === 'session/creationFailed') {
				const error = new AgentRuntimeError('TASK_EXECUTION_FAILED', safeMessage(action.error.message));
				this.defaultChatReject?.(error);
				this.fail(error);
			} else {
				this.observeHostSession(envelope.channel);
				if (action.type === 'session/ready') {
					this.markSessionMaterialized();
				}
				if (action.type === 'session/defaultChatChanged') {
					this.updateSessionDefaultChat(action.defaultChat);
				}
			}
		}
		const authoritativeTurnTerminal = (
			envelope.channel === this.chatUri
			&& (
				action.type === 'chat/turnComplete'
				|| action.type === 'chat/turnCancelled'
				|| action.type === 'chat/error'
			)
			&& action.turnId === this.turnId
		);
		if (
			envelope.channel === this.chatUri
			&& (
				action.type === 'chat/turnComplete'
				|| action.type === 'chat/turnCancelled'
				|| action.type === 'chat/error'
			)
			&& !authoritativeTurnTerminal
		) {
			return;
		}
		this.trackDeliveredResponseAction(action);
		if (authoritativeTurnTerminal) {
			try {
				this.lifecycleObserver?.observeLifecycle({
					taskId: this.taskId,
					eventType: action.type,
				});
			} catch {
				// Optional lifecycle observation must not affect Agent execution.
			}
			await this.publishAuthoritativeTerminal(
				this.mapper.map(envelope),
				action.type,
				terminalCatalogConnection,
				terminalSessionSubscription,
			);
			return;
		}
		await this.emitMappedEvents(
			this.mapper.map(envelope),
			false,
		);
	}

	private async publishAuthoritativeTerminal(
		events: readonly AgentRuntimeEvent[],
		type: 'chat/turnComplete' | 'chat/turnCancelled' | 'chat/error',
		connection: AhpConnection,
		sessionSubscription?: AhpSubscription,
	): Promise<void> {
		this.clearCancellationTimer();
		this.terminalHistoryPreparations += 1;
		try {
			let retained = false;
			try {
				await this.prepareTerminalSessionHistory(connection, sessionSubscription);
				retained = true;
			} catch (error) {
				if (this.disposed) {
					return;
				}
				if (type === 'chat/turnComplete') {
					this.fail(normalizeRuntimeError(error));
					return;
				}
				this.terminalHistoryPreparationFailure = normalizeRuntimeError(error);
			}
			await this.emitMappedEvents(events, retained);
		} finally {
			this.terminalHistoryPreparations -= 1;
		}
	}

	private async prepareTerminalSessionHistory(
		connection = this.connection,
		sessionSubscription?: AhpSubscription,
	): Promise<void> {
		if (this.host.preserveTerminalSession !== true) {
			this.authoritativeTurnTerminal = true;
			return;
		}
		if (!this.sessionMaterialized) {
			await withAbortableTimeout(
				(scanSignal) => abortableConfigurationResolution(
					this.sessionMaterializedPromise,
					scanSignal,
				),
				this.terminalMaterializationTimeoutMs,
				'The editor Agent Host did not materialize the terminal Session.',
				this.terminalPreparationAbort.signal,
			);
		}
		let binding = await this.rebindTerminalSessionAfterRecovery(
			connection,
			sessionSubscription,
		);
		if (!this.terminalSessionArchived) {
			await this.dispatchTerminalSessionAction(
				{
					type: 'session/isArchivedChanged',
					isArchived: true,
				},
				'The Agent Host did not acknowledge marking the completed delegated Session as done.',
				'The Agent Host closed the Session before acknowledging its done state.',
				'The Agent Host requested authentication while marking the delegated Session as done.',
				binding.connection,
				this.terminalPreparationAbort.signal,
				binding.sessionSubscription,
			);
			this.terminalSessionArchived = true;
			this.observeLifecycleEvent('session/archived');
		}
		if (!this.terminalSessionClientLeft) {
			binding = await this.rebindTerminalSessionAfterRecovery(
				binding.connection,
				binding.sessionSubscription,
			);
			try {
				await this.detachTerminalSessionClient(
					binding.connection,
					this.terminalPreparationAbort.signal,
					binding.sessionSubscription,
				);
			} catch (error: unknown) {
				const rebound = await this.rebindTerminalSessionAfterRecovery(
					binding.connection,
					binding.sessionSubscription,
				);
				if (rebound.connection === binding.connection) {
					throw error;
				}
				binding = rebound;
				await this.detachTerminalSessionClient(
					binding.connection,
					this.terminalPreparationAbort.signal,
					binding.sessionSubscription,
				);
			}
		}
		this.authoritativeTurnTerminal = true;
	}

	private async rebindTerminalSessionAfterRecovery(
		connection: AhpConnection,
		sessionSubscription?: AhpSubscription,
	): Promise<{
		readonly connection: AhpConnection;
		readonly sessionSubscription?: AhpSubscription;
	}> {
		while (true) {
			if (!this.recovering) {
				return connection === this.connection
					? { connection, sessionSubscription }
					: {
						connection: this.connection,
						sessionSubscription: undefined,
					};
			}
			if (connection === this.recoveryCandidate) {
				// Recovery replay uses the candidate before it becomes the current connection.
				return { connection, sessionSubscription };
			}
			const recovery = this.recoveryPromise;
			if (recovery === undefined) {
				throw new AgentRuntimeError(
					'TASK_RECOVERY_UNAVAILABLE',
					'The Agent Host task connection became unavailable before Session history was retained.',
				);
			}
			await abortableConfigurationResolution(
				recovery,
				this.terminalPreparationAbort.signal,
			);
			if (this.terminal) {
				throw this.terminalError ?? new AgentRuntimeError(
					'TASK_RECOVERY_UNAVAILABLE',
					'The Agent Host task connection could not be recovered before Session history was retained.',
				);
			}
		}
	}

	private async detachTerminalSessionClient(
		connection: AhpConnection,
		signal: AbortSignal,
		sessionSubscription?: AhpSubscription,
	): Promise<void> {
		if (this.terminalSessionUnsubscribedConnections.has(connection)) {
			return;
		}
		this.terminalSessionDepartingConnections.add(connection);
		try {
			await this.dispatchTerminalClientRemoval(
				connection,
				signal,
				sessionSubscription,
			);
		} catch (error: unknown) {
			this.terminalSessionDepartingConnections.delete(connection);
			throw error;
		}
		let unsubscribe: Promise<void>;
		try {
			unsubscribe = connection.unsubscribe(this.sessionUri);
		} catch (error: unknown) {
			this.terminalSessionDepartingConnections.delete(connection);
			throw error;
		}
		const trackedUnsubscribe = unsubscribe.then(
			() => {
				this.terminalSessionUnsubscribedConnections.add(connection);
				this.terminalSessionDepartingConnections.delete(connection);
				this.terminalSessionClientLeft = true;
			},
			(error: unknown) => {
				this.terminalSessionDepartingConnections.delete(connection);
				throw error;
			},
		);
		await abortableConfigurationResolution(trackedUnsubscribe, signal);
	}

	private async dispatchTerminalClientRemoval(
		connection: AhpConnection,
		signal: AbortSignal,
		sessionSubscription?: AhpSubscription,
	): Promise<void> {
		await this.dispatchTerminalSessionAction(
			{
				type: 'session/activeClientRemoved',
				clientId: this.clientId,
			},
			'The Agent Host did not acknowledge the delegated active-client removal.',
			'The Agent Host closed the Session before acknowledging active-client removal.',
			'The Agent Host requested authentication while removing the delegated active client.',
			connection,
			signal,
			sessionSubscription,
		);
		this.observeLifecycleEvent('session/activeClientRemoved');
	}

	private async dispatchTerminalSessionAction(
		action: unknown,
		timeoutMessage: string,
		closedMessage: string,
		authenticationMessage: string,
		connection: AhpConnection,
		signal: AbortSignal,
		sessionSubscription?: AhpSubscription,
	): Promise<void> {
		let acknowledged = false;
		const acknowledgement = this.dispatchAcknowledged(
			this.sessionUri,
			action,
			timeoutMessage,
			connection,
		);
		void acknowledgement.then(
			() => {
				acknowledged = true;
			},
			() => undefined,
		);
		if (sessionSubscription === undefined) {
			await abortableConfigurationResolution(acknowledgement, signal);
			return;
		}
		const iterator = sessionSubscription[Symbol.asyncIterator]();
		while (!acknowledged) {
			const event = await Promise.race([
				abortableConfigurationResolution(iterator.next(), signal),
				acknowledgement.then<never>(
					() => new Promise<never>(() => undefined),
					(error: unknown) => Promise.reject(error),
				),
			]);
			if (event.done) {
				throw new AgentRuntimeError(
					'TASK_EXECUTION_FAILED',
					closedMessage,
				);
			}
			if (event.value.type === 'action') {
				await this.handleEnvelope(event.value.params as ActionEnvelope, false, connection);
			} else {
				throw new AgentRuntimeError(
					'TASK_EXECUTION_FAILED',
					authenticationMessage,
				);
			}
			await Promise.resolve();
		}
		await acknowledgement;
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

	private async emitMappedEvents(
		events: readonly AgentRuntimeEvent[],
		authoritativeTurnTerminal = false,
	): Promise<void> {
		for (const event of events) {
			const terminal = event.type === 'completed' || event.type === 'cancelled' || event.type === 'failed';
			if (this.terminal) {
				return;
			}
			if (terminal) {
				this.terminal = true;
				this.authoritativeTurnTerminal = authoritativeTurnTerminal;
				await this.events.pushAndClose(event);
				this.finishTerminal();
				return;
			}
			await this.events.push(event);
		}
	}

	private observeHostSession(sessionUri: string): void {
		if (this.hostSessionObserved) {
			return;
		}
		this.hostSessionObserved = true;
		try {
			this.lifecycleObserver?.observeLifecycle({
				taskId: this.taskId,
				eventType: 'session/hostObserved',
				sessionUri,
				source: this.host.source ?? 'standalone',
				...(this.host.endpointFingerprint === undefined
					? {}
					: { endpointFingerprint: this.host.endpointFingerprint }),
			});
		} catch {
			// Optional lifecycle observation must not affect Agent execution.
		}
	}

	private observeLifecycleEvent(
		eventType: Exclude<AgentRuntimeLifecycleObservation['eventType'], 'session/hostObserved'>,
	): void {
		try {
			this.lifecycleObserver?.observeLifecycle({
				taskId: this.taskId,
				eventType,
			});
		} catch {
			// Optional lifecycle observation must not affect Agent execution or cleanup.
		}
	}

	private markSessionMaterialized(): void {
		if (this.sessionMaterialized) {
			return;
		}
		this.sessionMaterialized = true;
		this.resolveSessionMaterialized();
		this.observeLifecycleEvent('session/materialized');
	}

	private async applySnapshot(
		snapshot: Snapshot,
		subscribeRootTerminals = true,
		terminalCatalogConnection = this.connection,
		terminalSessionSubscription?: AhpSubscription,
	): Promise<void> {
		this.lastSeenServerSeq = Math.max(this.lastSeenServerSeq, snapshot.fromSeq);
		if (snapshot.resource === this.sessionUri) {
			const state = snapshot.state as SessionState;
			const lifecycle = String(state.lifecycle);
			if (lifecycle === 'failed' || lifecycle === 'creationFailed') {
				throw new AgentRuntimeError(
					'TASK_EXECUTION_FAILED',
					safeMessage(state.creationError?.message ?? 'Agent session creation failed.'),
				);
			}
			if (lifecycle === 'ready') {
				this.markSessionMaterialized();
			}
			this.observeHostSession(snapshot.resource);
			if (state.defaultChat !== undefined) {
				this.updateSessionDefaultChat(state.defaultChat);
			} else if (lifecycle === 'ready') {
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
			await this.applyChatSnapshot(
				snapshot.state,
				snapshot.resource,
				terminalCatalogConnection,
				terminalSessionSubscription,
			);
		}
	}

	private async applyChatSnapshot(
		value: unknown,
		chatUri: string,
		terminalCatalogConnection: AhpConnection,
		terminalSessionSubscription?: AhpSubscription,
	): Promise<void> {
		if (!isRecord(value)) {
			throw new AgentRuntimeError('TASK_RECOVERY_UNAVAILABLE', 'The recovered Chat snapshot was invalid.');
		}
		const activeTurn = isRecord(value.activeTurn) ? value.activeTurn : undefined;
		if (activeTurn !== undefined && activeTurn.id === this.turnId && Array.isArray(activeTurn.responseParts)) {
			await this.restoreResponseParts(chatUri, activeTurn.responseParts);
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
			await this.restoreResponseParts(chatUri, turn.responseParts);
		}
		if (turn.state === 'complete') {
			await this.publishAuthoritativeTerminal(
				[{ type: 'completed' }],
				'chat/turnComplete',
				terminalCatalogConnection,
				terminalSessionSubscription,
			);
		} else if (turn.state === 'cancelled') {
			await this.publishAuthoritativeTerminal(
				[{ type: 'cancelled' }],
				'chat/turnCancelled',
				terminalCatalogConnection,
				terminalSessionSubscription,
			);
		} else if (turn.state === 'error') {
			await this.publishAuthoritativeTerminal(
				[{
					type: 'failed',
					error: new AgentRuntimeError(
						'TASK_EXECUTION_FAILED',
						safeMessage(recoveredTurnErrorMessage(turn)),
					),
				}],
				'chat/error',
				terminalCatalogConnection,
				terminalSessionSubscription,
			);
		}
	}

	private async restoreResponseParts(chatUri: string, parts: readonly unknown[]): Promise<void> {
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
			await this.restoreResponsePart(chatUri, part, index, ordinalIdentity, ordinal);
		}
	}

	private async restoreResponsePart(
		chatUri: string,
		value: unknown,
		index: number,
		ordinalIdentity?: string,
		ordinal?: number,
	): Promise<void> {
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
				await this.emitMappedEvents([value.kind === 'markdown'
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
			await this.emitMappedEvents(this.mapper.map(envelopeFromSnapshot(chatUri, {
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
			await this.handleEnvelope(envelopeFromSnapshot(chatUri, {
				type: 'chat/inputRequested',
				request: value.request,
			}, this.lastSeenServerSeq));
			return;
		}
		if (value.kind !== 'toolCall' || !isRecord(value.toolCall)) {
			await this.emitMappedEvents(this.mapper.map(envelopeFromSnapshot(chatUri, {
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
			if (
				typeof this.turnId === 'string'
				&& typeof tool.toolCallId === 'string'
				&& typeof tool.toolName === 'string'
			) {
				this.mapper.rememberTool(chatUri, this.turnId, tool.toolCallId, tool.toolName);
			}
			await this.handleEnvelope(envelopeFromSnapshot(chatUri, {
				type: 'chat/toolCallReady',
				...common,
				invocationMessage: tool.invocationMessage,
				confirmationTitle: tool.confirmationTitle,
				options: tool.options,
				edits: tool.edits,
				toolInput: tool.toolInput,
				riskAssessment: tool.riskAssessment,
			}, this.lastSeenServerSeq));
		} else if (tool.status === 'pending-result-confirmation') {
			await this.handleEnvelope(envelopeFromSnapshot(chatUri, {
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
			await this.handleEnvelope(envelopeFromSnapshot(chatUri, {
				type: 'chat/toolCallAuthRequired',
				...common,
				auth: tool.auth,
			}, this.lastSeenServerSeq));
		} else if (tool.status === 'completed') {
			await this.handleEnvelope(envelopeFromSnapshot(chatUri, {
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
			await this.handleEnvelope(envelopeFromSnapshot(chatUri, {
				type: 'chat/toolCallStart',
				...common,
				toolName: tool.toolName,
				displayName: tool.displayName,
				intention: tool.intention,
				contributor: tool.contributor,
			}, this.lastSeenServerSeq));
		}
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
		}), sessionDefaultChatTimeoutMs, 'The Agent Host session did not publish a default chat.');
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
				await this.departSubscription(generation, uri, subscription);
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
				await unsubscribeThenClose(
					connection,
					terminal.resource,
					result.subscription,
				).catch(() => undefined);
				continue;
			}
			if (result.snapshot !== undefined) {
				await this.applySnapshot(result.snapshot, false);
			}
			subscriptions.set(terminal.resource, result.subscription);
			if (startPumps) {
				this.startSubscription(terminal.resource, result.subscription, generation);
			}
		}
	}

	private async departSubscription(
		generation: ConnectionGeneration,
		uri: string,
		subscription: AhpSubscription,
	): Promise<void> {
		let departing = this.intentionalSubscriptionDepartures.get(generation.connection);
		if (departing === undefined) {
			departing = new Set<string>();
			this.intentionalSubscriptionDepartures.set(generation.connection, departing);
		}
		departing.add(uri);
		try {
			await unsubscribeThenClose(generation.connection, uri, subscription);
			generation.subscriptions.delete(uri);
		} finally {
			departing.delete(uri);
		}
	}

	private isSubscriptionDeparting(connection: AhpConnection, uri: string): boolean {
		return this.intentionalSubscriptionDepartures.get(connection)?.has(uri) === true;
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
		if (this.disposed || this.terminal) {
			return;
		}
		if (this.recoveryPromise !== undefined) {
			if (!this.recovering) {
				this.recoveryRequestedAfterHandoff = true;
			}
			return;
		}
		this.delegatedCorrelationEnabled = false;
		this.clearDelegatedToolInvocations();
		const abort = new AbortController();
		this.recoveryAbort = abort;
		const operation = this.recover(abort.signal);
		this.recoveryPromise = operation;
		const clear = () => {
			if (this.recoveryPromise === operation) {
				this.recoveryPromise = undefined;
				this.recoveryAbort = undefined;
				if (this.recoveryRequestedAfterHandoff) {
					this.recoveryRequestedAfterHandoff = false;
					this.startRecovery();
				}
			}
		};
		void operation.then(clear, clear);
		void operation.catch(() => undefined);
	}

	private async recover(signal: AbortSignal): Promise<void> {
		this.recovering = true;
		await this.events.push({ type: 'progress', message: 'Reconnecting to Agent Host.' });
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
		const recoverySubscriptionUris = [...this.subscriptions.keys()].filter((uri) =>
			!(
				uri === this.sessionUri
				&& (
					this.terminalSessionDepartingConnections.has(previousConnection)
					|| this.terminalSessionUnsubscribedConnections.has(previousConnection)
				)
			));
		const requiredRecoveryResources = new Set(recoverySubscriptionUris);
		try {
			candidate = await this.awaitRecoveryStep(
				this.connectionFactory.connect(this.host, signal),
				signal,
			);
			this.recoveryCandidate = candidate;
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
			for (const uri of recoverySubscriptionUris) {
				this.throwIfRecoveryStopped(signal);
				recoveredSubscriptions.set(uri, candidate.attachSubscription(uri));
			}
			const result = await this.awaitRecoveryStep(
				candidate.reconnect(
					this.clientId,
					this.lastSeenServerSeq,
					recoverySubscriptionUris,
				),
				signal,
			);
			if (result.type === 'replay') {
				if ((result.actions ?? []).some((action) =>
					action.channel === this.sessionUri && action.action.type === 'session/ready')) {
					this.markSessionMaterialized();
				}
				for (const action of result.actions ?? []) {
					this.throwIfRecoveryStopped(signal);
					if (action.channel === rootUri && action.action.type === 'root/terminalsChanged') {
						recoveredTerminals = action.action.terminals;
					}
					await this.handleEnvelope(
						action,
						false,
						candidate,
						recoveredSubscriptions.get(this.sessionUri),
					);
				}
				const missing = result.missing ?? [];
				if (missing.some((uri) => requiredRecoveryResources.has(uri))) {
					throw new RecoveryUnavailableCause('The Agent Host no longer has the task session.');
				}
				for (const uri of missing) {
					const subscription = recoveredSubscriptions.get(uri);
					if (subscription !== undefined) {
						await this.awaitRecoveryStep(
							unsubscribeThenClose(candidate, uri, subscription),
							signal,
						);
					}
					recoveredSubscriptions.delete(uri);
				}
			} else {
				const snapshots = result.snapshots ?? [];
				if (snapshots.some((snapshot) =>
					snapshot.resource === this.sessionUri
					&& String((snapshot.state as SessionState).lifecycle) === 'ready')) {
					this.markSessionMaterialized();
				}
				const snapshotResources = new Set(snapshots.map(({ resource }) => resource));
				if (recoverySubscriptionUris.some((uri) => !snapshotResources.has(uri))) {
					throw new RecoveryUnavailableCause('The Agent Host no longer has the task session or active chat.');
				}
				for (const [uri, subscription] of recoveredSubscriptions) {
					if (!snapshotResources.has(uri)) {
						await this.awaitRecoveryStep(
							unsubscribeThenClose(candidate, uri, subscription),
							signal,
						);
						recoveredSubscriptions.delete(uri);
					}
				}
				for (const snapshot of snapshots) {
					this.throwIfRecoveryStopped(signal);
					if (snapshot.resource === rootUri) {
						recoveredTerminals = parseRootState(snapshot).terminals ?? [];
					}
					await this.applySnapshot(
						snapshot,
						false,
						candidate,
						recoveredSubscriptions.get(this.sessionUri),
					);
				}
			}
			const session = await findSessionInCatalog(candidate, this.sessionUri, signal);
			this.throwIfRecoveryStopped(signal);
			if (session === undefined && this.terminalHistoryPreparations === 0) {
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
			this.recoveryCandidate = undefined;
			this.recovering = false;
			this.delegatedCorrelationEnabled = true;
			for (const [uri, subscription] of recoveredSubscriptions) {
				this.startSubscription(uri, subscription, candidateGeneration);
			}
			await this.events.push({ type: 'progress', message: 'Agent Host connection recovered.' });
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
			if (this.recoveryCandidate === candidate) {
				this.recoveryCandidate = undefined;
			}
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
		this.clearDelegatedToolInvocations();
		this.defaultChatReject?.(error);
		this.terminal = true;
		void this.events.pushAndClose({ type: 'failed', error }).then(() => this.finishTerminal());
	}

	private finishTerminal(): void {
		this.terminal = true;
		this.clearDelegatedToolInvocations();
		this.clearCancellationTimer();
		this.events.close();
	}

	private clearCancellationTimer(): void {
		if (this.cancellationTimer === undefined) {
			return;
		}
		clearTimeout(this.cancellationTimer);
		this.cancellationTimer = undefined;
	}

	private trackDelegatedToolInvocation(envelope: ActionEnvelope): void {
		const context = this.request.delegatedExecutionContext;
		if (
			context === undefined
			|| this.delegatedToolInvocations === undefined
			|| !this.delegatedCorrelationEnabled
			|| envelope.channel !== this.chatUri
		) {
			return;
		}
		if (
			(
				envelope.action.type === 'chat/turnComplete'
				|| envelope.action.type === 'chat/turnCancelled'
				|| envelope.action.type === 'chat/error'
			)
			&& envelope.action.turnId === this.turnId
		) {
			this.clearDelegatedToolInvocations();
			return;
		}
		if (
			!('toolCallId' in envelope.action)
			|| typeof envelope.action.toolCallId !== 'string'
			|| !('turnId' in envelope.action)
			|| typeof envelope.action.turnId !== 'string'
		) {
			return;
		}
		const invocationId = `${envelope.action.turnId}\0${envelope.action.toolCallId}`;
		if (envelope.action.type === 'chat/toolCallReady') {
			const toolName = this.mapper.toolName(
				envelope.channel,
				envelope.action.turnId,
				envelope.action.toolCallId,
			);
			if (toolName !== undefined) {
				this.delegatedToolInvocations.observe({
					scopeId: this.sessionUri,
					invocationId,
					toolName,
					toolInput: envelope.action.toolInput,
					context,
				});
			}
		} else if (envelope.action.type === 'chat/toolCallComplete') {
			this.delegatedToolInvocations.forget(this.sessionUri, invocationId);
		}
	}

	private clearDelegatedToolInvocations(): void {
		this.delegatedToolInvocations?.clearScope(this.sessionUri);
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
	if (request.sourceWindowName !== undefined && request.sourceWindowName.trim().length === 0) {
		throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'A delegated task source window name cannot be empty.');
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

export function buildMeshSessionTitle(sourceWindowName: string, taskTitle: string): string {
	const source = sanitizeDelegationText(sourceWindowName, 80);
	const summary = sanitizeDelegationText(taskTitle, 160);
	return sanitizeDelegationText(`Mesh · ${source} → ${summary}`, sessionTitleBytes);
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
class SessionCatalogPaginationError extends AgentRuntimeError {
	constructor(message: string) {
		super('TASK_EXECUTION_FAILED', message, true);
	}
}

interface CleanupOperation {
	readonly label: string;
	readonly run: () => Promise<void>;
}

class DetachedAgentHostCleanup {
	private connectionShutdown: boolean;
	private hostDisposed = false;
	private disposal: Promise<void> | undefined;

	constructor(
		private readonly host: LaunchedAgentHost,
		private readonly connection: AhpConnection | undefined,
	) {
		this.connectionShutdown = connection === undefined;
	}

	dispose(): Promise<void> {
		if (this.connectionShutdown && this.hostDisposed) {
			return Promise.resolve();
		}
		this.disposal ??= this.disposeOwned().finally(() => {
			if (!this.connectionShutdown || !this.hostDisposed) {
				this.disposal = undefined;
			}
		});
		return this.disposal;
	}

	private async disposeOwned(): Promise<void> {
		const failures: string[] = [];
		const connection = this.connection;
		await collectCleanupFailures([
			...(
				this.connectionShutdown || connection === undefined
					? []
					: [{
						label: 'shutdown detached AHP connection',
						run: async () => {
							await connection.shutdown();
							this.connectionShutdown = true;
						},
					}]
			),
			...(this.hostDisposed
				? []
				: [{
					label: 'dispose detached owned Agent Host',
					run: async () => {
						await this.host.dispose();
						this.hostDisposed = true;
					},
				}]),
		], failures);
		if (failures.length > 0) {
			throw cleanupFailure(failures);
		}
	}
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
		if (this.initialShutdown !== undefined && !this.shutdownComplete) {
			try {
				await this.initialShutdown;
				this.shutdownComplete = true;
			} catch (error) {
				this.initialShutdown = undefined;
				throw error;
			}
		}
		await runCleanupPhase(
			[...this.subscriptions]
				.filter(([, state]) => !state.closed)
				.map(([uri, state]) => ({
					label: `${this.shutdownComplete ? 'close' : 'unsubscribe and close'} recovery subscription ${safeCleanupResource(uri)}`,
					run: async () => {
						if (this.shutdownComplete) {
							await state.subscription.close();
						} else {
							await unsubscribeThenClose(this.connection, uri, state.subscription);
						}
						state.closed = true;
					},
				})),
		);
		if (!this.shutdownComplete) {
			const shutdown = this.connection.shutdown();
			try {
				await shutdown;
				this.shutdownComplete = true;
			} catch (error) {
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

async function unsubscribeThenClose(
	connection: Pick<AhpConnection, 'unsubscribe'>,
	uri: string,
	subscription: AhpSubscription,
): Promise<void> {
	await connection.unsubscribe(uri);
	await subscription.close();
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

function recoveredTurnErrorMessage(turn: Record<string, unknown>): string {
	if (Array.isArray(turn.responseParts)) {
		for (let index = turn.responseParts.length - 1; index >= 0; index -= 1) {
			const part = turn.responseParts[index];
			if (
				isRecord(part)
				&& part.kind === 'error'
				&& isRecord(part.error)
				&& typeof part.error.message === 'string'
			) {
				return part.error.message;
			}
		}
	}
	if (isRecord(turn.error) && typeof turn.error.message === 'string') {
		return turn.error.message;
	}
	return 'The recovered Agent Host turn failed.';
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
	return redactRegisteredSensitiveValues(message)
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

function connectWebSocket(endpoint: URL, timeoutMs: number, signal?: AbortSignal): Promise<NodeWebSocket> {
	return new Promise((resolveSocket, reject) => {
		if (signal?.aborted === true) {
			reject(new RecoveryStoppedCause());
			return;
		}
		const socket = new NodeWebSocket(endpoint);
		const timer = setTimeout(() => {
			cleanup();
			socket.terminate();
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
			socket.terminate();
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

function abortableConfigurationResolution<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	throwIfAborted(signal);
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener('abort', abort);
			reject(new RecoveryStoppedCause());
		};
		signal.addEventListener('abort', abort, { once: true });
		void operation.then(
			(value) => {
				signal.removeEventListener('abort', abort);
				if (!signal.aborted) {
					resolve(value);
				}
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort);
				if (!signal.aborted) {
					reject(error);
				}
			},
		);
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

async function withAbortableTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	message: string,
	parentSignal: AbortSignal,
): Promise<T> {
	const timeout = new AbortController();
	const timeoutError = new AgentRuntimeError('TASK_EXECUTION_FAILED', message, true);
	const signal = AbortSignal.any([parentSignal, timeout.signal]);
	const timer = setTimeout(() => timeout.abort(), timeoutMs);
	try {
		return await operation(signal);
	} catch (error) {
		if (timeout.signal.aborted && !parentSignal.aborted) {
			throw timeoutError;
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

async function findSessionInCatalog(
	connection: AhpConnection,
	resource: string,
	signal?: AbortSignal,
): Promise<AhpSessionSummary | undefined> {
	let match: AhpSessionSummary | undefined;
	await scanSessionCatalog(connection, (session) => {
		if (session.resource !== resource) {
			return false;
		}
		match = session;
		return true;
	}, signal);
	return match;
}

export async function listSessionsBounded(
	connection: AhpConnection,
	signal?: AbortSignal,
): Promise<readonly AhpSessionSummary[]> {
	const sessions: AhpSessionSummary[] = [];
	await scanSessionCatalog(connection, (session) => {
		sessions.push(session);
		return false;
	}, signal);
	return sessions;
}

async function scanSessionCatalog(
	connection: AhpConnection,
	visit: (session: AhpSessionSummary) => boolean,
	signal?: AbortSignal,
): Promise<void> {
	let cursor: string | undefined;
	let omitLimit = false;
	let entryCount = 0;
	const seenCursors = new Set<string>();
	for (let pageNumber = 0; pageNumber < sessionCatalogMaxPages; pageNumber += 1) {
		throwIfAborted(signal);
		let page: AhpSessionPage;
		try {
			const request = connection.listSessions(omitLimit ? undefined : sessionCatalogPageLimit, cursor);
			page = signal === undefined
				? await request
				: await abortableConfigurationResolution(request, signal);
		} catch (error: unknown) {
			if (!omitLimit && isRpcInternalError(error)) {
				omitLimit = true;
				pageNumber -= 1;
				continue;
			}
			throw error;
		}
		for (const session of page.items) {
			entryCount += 1;
			if (entryCount > sessionCatalogMaxEntries) {
				throw new SessionCatalogPaginationError(
					'The Agent Host Session catalog exceeded the bounded entry limit.',
				);
			}
			if (visit(session)) {
				return;
			}
		}
		if (page.nextCursor === undefined) {
			return;
		}
		if (
			typeof page.nextCursor !== 'string'
			|| page.nextCursor.length < 1
			|| page.nextCursor.length > sessionCatalogCursorMaxLength
			|| seenCursors.has(page.nextCursor)
		) {
			throw new SessionCatalogPaginationError(
				'The Agent Host returned an invalid Session catalog cursor.',
			);
		}

		seenCursors.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	throw new SessionCatalogPaginationError(
		'The Agent Host Session catalog exceeded the bounded pagination limit.',
	);
}

function isRpcInternalError(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& error.code === -32603;
}

export function isUsableTerminalSessionStatus(status: number): boolean {
	const terminal = (status & (sessionStatusIdle | sessionStatusError)) !== 0;
	return terminal
		&& (status & sessionStatusInProgress) === 0
		&& (status & sessionStatusArchived) !== 0;
}

function sleep(timeoutMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
