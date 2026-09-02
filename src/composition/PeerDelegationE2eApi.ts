import { createHash, randomUUID } from 'node:crypto';

import type * as vscode from 'vscode';

import {
	AHP_PROTOCOL_OFFER,
	SdkAhpConnectionFactory,
	isUsableTerminalSessionStatus,
	listSessionsBounded,
	type AhpConnection,
} from '../agentHost/AhpAgentRuntime';
import type {
	AgentHostSourceStatusProvider,
	AgentRuntime,
} from '../agentHost/AgentRuntime';
import type { LaunchedAgentHost } from '../agentHost/AgentHostLauncher';
import { EditorAgentHostLauncher } from '../agentHost/AgentHostSourceSelector';
import { EditorAgentHostLocator } from '../agentHost/EditorAgentHostLocator';
import {
	UnixSocketWebSocketConnector,
} from '../agentHost/UnixSocketWebSocketConnector';
import type { BrokerLifecycle } from '../broker/BrokerLifecycle';
import type { WindowNodeClient } from '../node/WindowNodeClient';
import type { LocalIpcRemoteTaskAdapter } from '../node/LocalIpcRemoteTaskAdapter';
import type { LocalIpcEndpoint } from '../ipc';

const editorCatalogRetryTimeoutMs = 10_000;
const editorCatalogRetryDelayMs = 100;
import {
	parseDelegateTaskInput,
	TaskToolsCore,
	type DelegateTaskInput,
} from '../tools/taskToolsCore';
import type { LocalBrokerTaskFacade } from '../tools/LocalBrokerTaskFacade';
import { TaskToolFacadeError } from '../tools/taskToolFacade';
import {
	MESH_RUNTIME_TOOL_NAMES,
	MESH_TOOL_NAMES,
} from '../tools/toolManifest';
import {
	projectPeerTaskEvents,
	type PeerDelegationE2eRecorder,
	type PeerDelegationE2eToolClock,
} from '../e2e/PeerDelegationE2eRecorder';
import type { ProductionDashboardBindings } from './ProductionDashboardBindings';
import type { ProductionBrokerRuntime } from './ProductionBrokerRuntime';
import {
	createTwoDeviceE2eApi,
	type TwoDeviceE2eApi,
} from './TwoDeviceE2eApi';
import type { E2eCapability } from './E2eCapability';

const taskTerminalStates = new Set(['completed', 'failed', 'cancelled', 'timedOut']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const safeWindowLabel = /^[\p{L}\p{N} ._()-]{1,128}$/u;

export interface PeerDelegationE2eApiOptions {
	readonly vscodeApi: typeof vscode;
	readonly bindings: ProductionDashboardBindings;
	readonly node: WindowNodeClient;
	readonly localTasks: LocalBrokerTaskFacade;
	readonly remoteTasks: LocalIpcRemoteTaskAdapter;
	readonly runtime: AgentRuntime & AgentHostSourceStatusProvider;
	readonly lifecycle: BrokerLifecycle<ProductionBrokerRuntime>;
	readonly ownerRuntime: () => ProductionBrokerRuntime | undefined;
	readonly capability: E2eCapability;
	readonly localIpcEndpoint?: LocalIpcEndpoint;
	readonly recorder: PeerDelegationE2eRecorder;
	readonly toolClock: PeerDelegationE2eToolClock;
	readonly editorProxyRoot?: string;
	readonly editorProxyNodeExecutable?: string;
}

export function createPeerDelegationE2eApi(
	options: PeerDelegationE2eApiOptions,
): TwoDeviceE2eApi | undefined {
	const base = createTwoDeviceE2eApi(options);
	if (base === undefined) {
		return undefined;
	}
	return {
		authorize: base.authorize,
		execute: async (request, action, params = {}) => {
			base.authorize(request);
			switch (action) {
				case 'peer.dashboard.snapshot':
					return options.bindings.getSnapshot();
				case 'peer.window.rename':
					return renameCurrentWindow(options, requiredString(params, 'name'));
				case 'peer.policy.accept':
					return setAcceptIncoming(options, requiredBoolean(params, 'enabled'));
				case 'peer.policy.allow':
					return setPeerAllowed(
						options,
						requiredString(params, 'windowLabel'),
						requiredBoolean(params, 'allowed'),
					);
				case 'peer.claim.fingerprint':
					return claimFingerprint(options.node);
				case 'peer.tool.invoke':
					return invokeTool(
						options.vscodeApi,
						requiredToolName(params, 'toolName'),
						requiredRecord(params, 'input'),
					);
				case 'peer.core.invoke':
					return invokeCoreTool(
						options,
						requiredToolName(params, 'toolName'),
						requiredRecord(params, 'input'),
					);
				case 'peer.direct.start.error':
					return directStartError(options, requiredRecord(params, 'input'));
				case 'peer.core.cancel.after.events':
					return invokeCoreDelegateAndCancelAfterEvents(options, requiredRecord(params, 'input'));
				case 'peer.observations':
					return options.recorder.snapshot();
				case 'peer.budget.arm':
					options.toolClock.armNextBudgetTimer();
					return { armed: true };
				case 'peer.task.evidence':
					return taskEvidence(options, requiredUuid(params, 'taskId'));
				case 'peer.runtime.status':
					return {
						status: options.runtime.sourceStatus(),
						probe: await options.runtime.probe(),
					};
				case 'peer.session.catalog':
					return editorSessionCatalog(options);
				case 'peer.resources':
					return resourceMetrics(options);
				default:
					return base.execute(request, action, params);
			}

			function invokeCoreTool(
				options: PeerDelegationE2eApiOptions,
				toolName: string,
				input: Record<string, unknown>,
			): Promise<Record<string, unknown>> {
				const core = new TaskToolsCore(options.localTasks, { clock: options.toolClock });
				switch (toolName) {
					case MESH_TOOL_NAMES.listWorkers:
						return core.listWorkers(input);
					case MESH_TOOL_NAMES.delegateTask:
						return core.delegateTask(input);
					case MESH_TOOL_NAMES.getTask:
						return core.getTask(input);
					case MESH_TOOL_NAMES.cancelTask:
						return core.cancelTask(input);
					case MESH_TOOL_NAMES.answerTask:
						return core.answerTask(input);
					default:
						throw new Error('The requested core Tool is unsupported.');
				}
			}

			async function directStartError(
				options: PeerDelegationE2eApiOptions,
				rawInput: Record<string, unknown>,
			): Promise<{ readonly rejected: true; readonly code: string }> {
				const parsed = parseDelegateTaskInput(rawInput);
				try {
					await options.localTasks.persistDelegationIntent({
						...parsed,
						delegationRequestId: parsed.delegationRequestId ?? randomUUID(),
						acceptanceCriteria: parsed.acceptanceCriteria ?? [],
					});
				} catch (error: unknown) {
					if (error instanceof TaskToolFacadeError) {
						return { rejected: true, code: error.code };
					}
					throw error;
				}
				throw new Error('The direct peer authorization probe unexpectedly started a task.');
			}
		},
	};
}

async function renameCurrentWindow(
	options: PeerDelegationE2eApiOptions,
	name: string,
): Promise<{ readonly renamed: true }> {
	if (!safeWindowLabel.test(name)) {
		throw new TypeError('The E2E window label is invalid.');
	}
	const rename = await options.bindings.prepareWindowRename();
	await rename.rename(name);
	return { renamed: true };
}

async function setAcceptIncoming(
	options: PeerDelegationE2eApiOptions,
	enabled: boolean,
): Promise<{ readonly acceptsIncoming: boolean }> {
	const snapshot = await options.bindings.getSnapshot();
	const handle = snapshot.thisWindow?.acceptActionHandle;
	if (handle === undefined) {
		throw new Error('The receive-policy action is unavailable.');
	}
	await options.bindings.setAcceptIncoming(handle, enabled);
	return { acceptsIncoming: enabled };
}

async function setPeerAllowed(
	options: PeerDelegationE2eApiOptions,
	windowLabel: string,
	allowed: boolean,
): Promise<{ readonly allowed: boolean }> {
	if (!safeWindowLabel.test(windowLabel)) {
		throw new TypeError('The target E2E window label is invalid.');
	}
	const snapshot = await options.bindings.getSnapshot();
	const candidates = snapshot.policyCandidates?.filter(
		(candidate) => !candidate.self && candidate.windowLabel === windowLabel,
	) ?? [];
	if (candidates.length !== 1 || candidates[0]?.actionHandle === undefined) {
		throw new Error('The peer-policy candidate is unavailable or ambiguous.');
	}
	await options.bindings.setPeerAllowed(candidates[0].actionHandle, allowed);
	return { allowed };
}

function claimFingerprint(node: WindowNodeClient): {
	readonly claimHash: string;
	readonly selected: true;
} {
	const selection = node.selectPeerPolicyWorkspace();
	if (selection.kind !== 'selected') {
		throw new Error('The current Window Node does not have one selected Workspace claim.');
	}
	return {
		claimHash: fingerprint('workspace-claim', selection.workspaceIdentity),
		selected: true,
	};
}

async function invokeTool(
	vscodeApi: typeof vscode,
	toolName: string,
	input: Record<string, unknown>,
	token?: vscode.CancellationToken,
): Promise<Record<string, unknown>> {
	if (!vscodeApi.lm.tools.some(({ name }) => name === toolName)) {
		throw new Error('The requested Mesh Tool is not registered.');
	}
	const cancellation = token === undefined
		? new vscodeApi.CancellationTokenSource()
		: undefined;
	try {
		const result = await vscodeApi.lm.invokeTool(
			toolName,
			{ input, toolInvocationToken: undefined },
			token ?? cancellation!.token,
		);
		if (
			result.content.length !== 1
			|| !(result.content[0] instanceof vscodeApi.LanguageModelTextPart)
		) {
			throw new Error('The Mesh Tool returned an invalid result shape.');
		}
		const parsed: unknown = JSON.parse(result.content[0].value);
		if (!isPlainRecord(parsed)) {
			throw new Error('The Mesh Tool result was not a JSON object.');
		}
		return parsed;
	} finally {
		cancellation?.dispose();
	}
}

async function invokeCoreDelegateAndCancelAfterEvents(
	options: PeerDelegationE2eApiOptions,
	rawInput: Record<string, unknown>,
): Promise<{
	readonly taskId: string;
	readonly cancellationTokenTriggered: boolean;
	readonly compactStatus?: number;
	readonly cancellationReason?: string;
	readonly observedEventTypes: readonly string[];
}> {
	const parsed = parseDelegateTaskInput(rawInput);
	if (parsed.delegationRequestId === undefined) {
		throw new TypeError('Cancellation E2E requires an explicit delegationRequestId.');
	}
	const input: DelegateTaskInput = {
		...parsed,
		delegationRequestId: parsed.delegationRequestId,
	};
	const identity = options.localTasks.identifyDelegation({
		...input,
		acceptanceCriteria: input.acceptanceCriteria ?? [],
	});
	const cancellation = new options.vscodeApi.CancellationTokenSource();
	const invocation = new TaskToolsCore(
		options.localTasks,
		{ clock: options.toolClock },
	).delegateTask(input, cancellation.token);
	let observedEventTypes: readonly string[] = [];
	let observationFailure: unknown;
	try {
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			const evidence = await taskEvidence(options, identity.taskId, false);
			observedEventTypes = evidence.eventTypes;
			if (
				observedEventTypes.includes('agentStarted')
				|| taskTerminalStates.has(evidence.state)
			) {
				break;
			}
			await delay(50);
		}
	} catch (error: unknown) {
		observationFailure = error;
	}
	cancellation.cancel();
	let result: Awaited<typeof invocation> | undefined;
	let invocationFailure: unknown;
	try {
		result = await invocation;
	} catch (error: unknown) {
		invocationFailure = error;
	}
	let terminal: Awaited<ReturnType<typeof taskEvidence>> | undefined;
	let terminalFailure: unknown;
	try {
		terminal = await waitForTaskEvidenceTerminal(options, identity.taskId, 60_000);
	} catch (error: unknown) {
		terminalFailure = error;
	}
	cancellation.dispose();
	const failures = [observationFailure, invocationFailure, terminalFailure]
		.filter((failure) => failure !== undefined);
	if (failures.length !== 0) {
		throw failures.length === 1
			? failures[0]
			: new AggregateError(failures, 'Cancellation E2E failed while releasing its task.');
	}
	return {
		taskId: identity.taskId,
		cancellationTokenTriggered: true,
		...(typeof result?.s !== 'number'
			? {}
			: { compactStatus: result.s }),
		...(typeof result?.x !== 'string'
			? {}
			: { cancellationReason: result.x }),
		observedEventTypes: terminal!.eventTypes,
	};
}

async function waitForTaskEvidenceTerminal(
	options: PeerDelegationE2eApiOptions,
	taskId: string,
	timeoutMs: number,
): Promise<Awaited<ReturnType<typeof taskEvidence>>> {
	const deadline = Date.now() + timeoutMs;
	let latest: Awaited<ReturnType<typeof taskEvidence>> | undefined;
	do {
		latest = await taskEvidence(options, taskId);
		if (taskTerminalStates.has(latest.state)) {
			return latest;
		}
		await delay(50);
	} while (Date.now() < deadline);
	throw new Error(`The cancellation task did not become terminal; last state was ${latest?.state ?? 'unknown'}.`);
}


async function taskEvidence(
	options: PeerDelegationE2eApiOptions,
	taskId: string,
	required = true,
): Promise<{
	readonly taskId: string;
	readonly state: string;
	readonly eventTypes: readonly string[];
	readonly eventSequences: readonly number[];
	readonly eventJournalTruncated: boolean;
	readonly outputCount: number;
	readonly outputBytes: number;
	readonly outputHash?: string;
	readonly leaseReleased: boolean;
}> {
	const owner = requireOwner(options);
	const record = (await owner.tasks.list()).find((candidate) => candidate.taskId === taskId);
	if (record === undefined) {
		if (required) {
			throw new Error('The requested E2E task was not found.');
		}
		return {
			taskId,
			state: 'not-found',
			eventTypes: [],
			eventSequences: [],
			eventJournalTruncated: false,
			outputCount: 0,
			outputBytes: 0,
			leaseReleased: true,
		};
	}
	const output = record.events
		.filter(({ type, summary }) => type === 'output' && summary !== undefined)
		.map(({ summary }) => summary!);
	const projectedEvents = projectPeerTaskEvents(record.events);
	return {
		taskId: record.taskId,
		state: record.state,
		eventTypes: projectedEvents.events.map(({ type }) => type),
		eventSequences: projectedEvents.events.map(({ eventSeq }) => eventSeq),
		eventJournalTruncated: record.eventsTruncated || projectedEvents.truncated,
		outputCount: output.length,
		outputBytes: output.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0),
		...(output.length === 0 ? {} : { outputHash: fingerprint('task-output', output.join('\0')) }),
		leaseReleased: !owner.leases.isLeased(record.workspaceLeaseKey),
	};
}

async function editorSessionCatalog(
	options: PeerDelegationE2eApiOptions,
): Promise<{
	readonly available: boolean;
	readonly source: 'editor';
	readonly protocolVersion?: string;
	readonly sessionCount?: number;
	readonly sessionHashes?: readonly string[];
	readonly errorCode?: 'EDITOR_CATALOG_UNAVAILABLE' | 'EDITOR_CATALOG_CLEANUP_FAILED';
}> {
	const configuration = options.vscodeApi.workspace.getConfiguration('copilotAgentMesh');
	const launcher = new EditorAgentHostLauncher(
		new EditorAgentHostLocator({
			configuredCodeCli: configuration.get<string>('codePath') || undefined,
			configuredUserDataDir: configuration.get<unknown>('agentHost.userDataDir'),
			platform: { productName: options.vscodeApi.env.appName },
		}),
		new UnixSocketWebSocketConnector({
			...(options.editorProxyRoot === undefined
				? {}
				: { proxyRoot: options.editorProxyRoot }),
			...(options.editorProxyNodeExecutable === undefined
				? {}
				: {
					proxyNodeExecutable: options.editorProxyNodeExecutable,
					connectionMode: 'proxyOnly',
				}),
		}),
	);
	let host: LaunchedAgentHost | undefined;
	let connection: AhpConnection | undefined;
	let result:
		| {
			readonly available: true;
			readonly source: 'editor';
			readonly protocolVersion: string;
			readonly sessionCount: number;
			readonly sessionHashes: readonly string[];
		}
		| {
			readonly available: false;
			readonly source: 'editor';
			readonly errorCode: 'EDITOR_CATALOG_UNAVAILABLE';
			readonly errorStage: 'launch' | 'connect' | 'initialize' | 'list';
			readonly errorKind: 'protocol' | 'timeout' | 'transport' | 'closed' | 'other';
			readonly rpcCode?: number;
		};
	let stage: 'launch' | 'connect' | 'initialize' | 'list' = 'launch';
	try {
		host = await launcher.launch();
		stage = 'connect';
		connection = await new SdkAhpConnectionFactory().connect(host);
		stage = 'initialize';
		const initialized = await connection.initialize(`mesh-peer-e2e-${randomUUID()}`);
		if (!AHP_PROTOCOL_OFFER.includes(initialized.protocolVersion as '1.0.0')) {
			throw new Error('The editor Agent Host selected an incompatible protocol.');
		}
		stage = 'list';
		const deadline = Date.now() + editorCatalogRetryTimeoutMs;
		let sessions;
		while (true) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new Error('The editor Agent Host Session catalog remained unavailable.');
			}
			const attemptTimeout = new AbortController();
			const timer = setTimeout(() => attemptTimeout.abort(), remaining);
			try {
				sessions = await listSessionsBounded(connection, attemptTimeout.signal);
				break;
			} catch (error: unknown) {
				if (Date.now() >= deadline) {
					throw error;
				}
				await new Promise<void>((resolve) => {
					setTimeout(resolve, Math.min(editorCatalogRetryDelayMs, deadline - Date.now()));
				});
			} finally {
				clearTimeout(timer);
			}
		}
		result = {
			available: true,
			source: 'editor',
			protocolVersion: initialized.protocolVersion,
			sessionCount: sessions.length,
			sessionHashes: sessions
				.filter(({ status }) => status !== undefined && isUsableTerminalSessionStatus(status))
				.map(({ resource }) => fingerprint('agent-session', resource))
				.sort(),
		};
	} catch (error: unknown) {
		const errorName = error instanceof Error ? error.name : '';
		const rpcCode = typeof error === 'object'
			&& error !== null
			&& 'code' in error
			&& typeof error.code === 'number'
			&& Number.isSafeInteger(error.code)
			? error.code
			: undefined;
		result = {
			available: false,
			source: 'editor',
			errorCode: 'EDITOR_CATALOG_UNAVAILABLE',
			errorStage: stage,
			errorKind: errorName.includes('Protocol')
				? 'protocol'
				: errorName.includes('Timeout')
					? 'timeout'
					: errorName.includes('Transport')
						? 'transport'
						: errorName.includes('Closed')
							? 'closed'
							: 'other',
			...(rpcCode === undefined ? {} : { rpcCode }),
		};
	}
	const cleanup = await Promise.allSettled([
		connection?.shutdown(),
		host?.dispose(),
		launcher.dispose(),
	].filter((operation): operation is Promise<void> => operation !== undefined));
	if (cleanup.some(({ status }) => status === 'rejected')) {
		return {
			available: false,
			source: 'editor',
			errorCode: 'EDITOR_CATALOG_CLEANUP_FAILED',
		};
	}
	return result;
}

function resourceMetrics(options: PeerDelegationE2eApiOptions): {
	readonly listener: { readonly startAttempts: number };
	readonly tunnel: {
		readonly loadAttempts: number;
		readonly probeAttempts: number;
		readonly ensureHostedAttempts: number;
	};
	readonly toolTimers: ReturnType<PeerDelegationE2eToolClock['snapshot']>;
} {
	const owner = options.ownerRuntime();
	return {
		listener: owner?.listener.lifecycleMetrics() ?? { startAttempts: 0 },
		tunnel: owner?.tunnel.lifecycleMetrics() ?? {
			loadAttempts: 0,
			probeAttempts: 0,
			ensureHostedAttempts: 0,
		},
		toolTimers: options.toolClock.snapshot(),
	};
}

function requireOwner(options: PeerDelegationE2eApiOptions): ProductionBrokerRuntime {
	const owner = options.ownerRuntime();
	if (owner === undefined || options.lifecycle.snapshot().state !== 'running') {
		throw new Error('The peer-delegation E2E action requires the current Broker owner.');
	}
	return owner;
}

function requiredToolName(params: Record<string, unknown>, key: string): string {
	const value = requiredString(params, key);
	if (!MESH_RUNTIME_TOOL_NAMES.includes(value as (typeof MESH_RUNTIME_TOOL_NAMES)[number])) {
		throw new TypeError('The requested Tool is not a Mesh Tool.');
	}
	return value;
}

function requiredUuid(params: Record<string, unknown>, key: string): string {
	const value = requiredString(params, key);
	if (!uuidPattern.test(value)) {
		throw new TypeError(`${key} must be a canonical UUID.`);
	}
	return value;
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value;
}

function requiredBoolean(params: Record<string, unknown>, key: string): boolean {
	const value = params[key];
	if (typeof value !== 'boolean') {
		throw new TypeError(`${key} must be a boolean.`);
	}
	return value;
}

function requiredRecord(
	params: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	const value = params[key];
	if (!isPlainRecord(value)) {
		throw new TypeError(`${key} must be an object.`);
	}
	return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fingerprint(domain: string, value: string): string {
	return createHash('sha256')
		.update(`copilot-agent-mesh/${domain}/v1\0`, 'utf8')
		.update(value, 'utf8')
		.digest('hex')
		.slice(0, 16);
}

function delay(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}
