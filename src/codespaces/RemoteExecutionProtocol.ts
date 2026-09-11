import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

import {
	MESH_ERROR_CODES,
	PROTOCOL_LIMITS,
	nodeTaskAnswerParamsSchema,
	nodeTaskCancelParamsSchema,
	nodeTaskEventParamsSchema,
	nodeTaskStartedResultSchema,
	nodeTaskStartParamsSchema,
	utf8String,
	uuidSchema,
	workspaceIdentitySchema,
	type MeshErrorReason,
} from '../../shared/protocol';
import {
	AGENT_RUNTIME_ERROR_CODES,
	AgentRuntimeError,
	type AgentRuntimeErrorCode,
} from '../agentHost/AgentRuntime';
import { MeshDomainError } from '../domain/errors';

export const REMOTE_EXECUTION_PROTOCOL_VERSION = 1;
export const REMOTE_EXECUTION_CLIENT_EXTENSION_ID = 'weivea.copilot-agent-mesh';
export const REMOTE_EXECUTION_HELPER_EXTENSION_ID = 'weivea.copilot-agent-mesh-codespaces';
export const REMOTE_EXECUTION_COMMANDS = {
	connect: 'copilotAgentMesh.codespaces.connect',
	call: 'copilotAgentMesh.codespaces.call',
	disconnect: 'copilotAgentMesh.codespaces.disconnect',
} as const;

const safeErrorMessage = 'The Codespaces execution request could not be completed.';
const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const durationSchema = z.number().int().min(1).max(2_147_483_647);
const extensionVersionSchema = utf8String(128, 'extension version', 1).refine(
	(value) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value),
);
const capabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u).refine(
	(value) => Buffer.from(value, 'base64url').length === 32
		&& Buffer.from(value, 'base64url').toString('base64url') === value,
);

export const remoteFileUriSchema = utf8String(8_192, 'workspace file URI', 1).refine((value) => {
	if (!URL.canParse(value) || /[\u0000-\u0020\\]/u.test(value) || /%(?:00|0a|0d|2f|5c)/iu.test(value)) {
		return false;
	}
	const uri = new URL(value);
	return uri.protocol === 'file:' && uri.host === '' && uri.pathname.startsWith('/')
		&& uri.username === '' && uri.password === '' && uri.port === ''
		&& uri.search === '' && uri.hash === '' && uri.href === value;
});

export const remoteExecutionIdentitySchema = z.strictObject({
	version: z.literal(REMOTE_EXECUTION_PROTOCOL_VERSION),
	clientId: uuidSchema,
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
	nodeLabel: utf8String(PROTOCOL_LIMITS.nameBytes, 'node label', 1),
	authority: utf8String(1_024, 'Codespace authority', 1).refine(
		(value) => /^codespaces\+[^/\s\\?#:@]+$/u.test(value),
	),
	expectedFolders: z.array(remoteFileUriSchema).min(1).max(PROTOCOL_LIMITS.workspaceListCount)
		.refine((values) => new Set(values).size === values.length),
	token: capabilitySchema,
});
export type RemoteExecutionIdentity = z.infer<typeof remoteExecutionIdentitySchema>;

export const remoteExecutionConnectSchema = remoteExecutionIdentitySchema.extend({
	extensionId: z.literal(REMOTE_EXECUTION_CLIENT_EXTENSION_ID),
	extensionVersion: extensionVersionSchema,
});
export type RemoteExecutionConnect = z.infer<typeof remoteExecutionConnectSchema>;

export const remoteWorkspaceDescriptorSchema = z.strictObject({
	sourceUri: remoteFileUriSchema,
	canonicalUri: remoteFileUriSchema,
	fileIdentity: utf8String(1_024, 'remote file identity', 1),
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace name', 1),
	capabilityTags: z.array(utf8String(64, 'capability tag', 1)).max(32),
});
export interface RemoteWorkspaceDescriptor {
	readonly sourceUri: string;
	readonly canonicalUri: string;
	readonly fileIdentity: string;
	readonly name: string;
	readonly capabilityTags: readonly string[];
}
export const remoteWorkspacesSchema = z.array(remoteWorkspaceDescriptorSchema)
	.min(1).max(PROTOCOL_LIMITS.workspaceListCount).superRefine((workspaces, context) => {
		for (const key of ['sourceUri', 'canonicalUri', 'fileIdentity'] as const) {
			if (new Set(workspaces.map((workspace) => workspace[key])).size !== workspaces.length) {
				context.addIssue({ code: 'custom', message: 'Workspace roots must be unambiguous.' });
			}
		}
	});

export const remoteExecutionConnectedSchema = z.strictObject({
	version: z.literal(REMOTE_EXECUTION_PROTOCOL_VERSION),
	extensionId: z.literal(REMOTE_EXECUTION_HELPER_EXTENSION_ID),
	extensionVersion: extensionVersionSchema,
	clientId: uuidSchema,
	nodeId: uuidSchema,
	nodeInstanceId: uuidSchema,
	helperInstanceId: uuidSchema,
	authority: remoteExecutionIdentitySchema.shape.authority,
	workspaces: remoteWorkspacesSchema,
	leaseMs: durationSchema,
	pollWaitMs: durationSchema,
});
export type RemoteExecutionConnected = z.infer<typeof remoteExecutionConnectedSchema>;

export const remoteExecutionAuthorizationSchema = z.strictObject({
	version: z.literal(REMOTE_EXECUTION_PROTOCOL_VERSION),
	clientId: uuidSchema,
	helperInstanceId: uuidSchema,
	token: capabilitySchema,
});
export type RemoteExecutionAuthorization = z.infer<typeof remoteExecutionAuthorizationSchema>;
export const remoteExecutionDisconnectSchema = remoteExecutionAuthorizationSchema;

export const remoteBoundWorkspaceSchema = z.strictObject({
	workspaceId: uuidSchema,
	workspaceIdentity: workspaceIdentitySchema,
	displayName: utf8String(PROTOCOL_LIMITS.nameBytes, 'workspace display name', 1),
	uri: remoteFileUriSchema,
});
export type RemoteBoundWorkspace = z.infer<typeof remoteBoundWorkspaceSchema>;

export const remoteExecutionOperationSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('describe') }),
	z.strictObject({ kind: z.literal('resolve'), uri: remoteFileUriSchema }),
	z.strictObject({ kind: z.literal('probe') }),
	z.strictObject({
		kind: z.literal('start'),
		params: nodeTaskStartParamsSchema,
		workspace: remoteBoundWorkspaceSchema,
	}),
	z.strictObject({ kind: z.literal('answer'), params: nodeTaskAnswerParamsSchema }),
	z.strictObject({ kind: z.literal('cancel'), params: nodeTaskCancelParamsSchema }),
	z.strictObject({ kind: z.literal('disposeTask'), params: nodeTaskCancelParamsSchema }),
	z.strictObject({
		kind: z.literal('events'),
		acknowledgedSeq: sequenceSchema,
		waitMs: durationSchema,
	}),
	z.strictObject({ kind: z.literal('heartbeat') }),
]);
export type RemoteExecutionOperation = z.infer<typeof remoteExecutionOperationSchema>;
export const remoteExecutionCallSchema = remoteExecutionAuthorizationSchema.extend({
	requestId: uuidSchema,
	operation: remoteExecutionOperationSchema,
});
export type RemoteExecutionCall = z.infer<typeof remoteExecutionCallSchema>;

export const remoteExecutionEventSchema = z.strictObject({
	seq: sequenceSchema.refine((value) => value > 0),
	event: nodeTaskEventParamsSchema,
});
export type RemoteExecutionEvent = z.infer<typeof remoteExecutionEventSchema>;
export const remoteExecutionEventsSchema = z.strictObject({
	acknowledgedSeq: sequenceSchema,
	events: z.array(remoteExecutionEventSchema).max(256),
});
export type RemoteExecutionEvents = z.infer<typeof remoteExecutionEventsSchema>;

export const remoteExecutionProbeSchema = z.strictObject({
	available: z.boolean(),
	featureEnabled: z.boolean(),
	canStart: z.boolean().optional(),
	version: utf8String(128, 'runtime version', 1).optional(),
	reason: z.enum(AGENT_RUNTIME_ERROR_CODES).optional(),
	source: z.literal('codespace-owned').optional(),
	degradation: z.strictObject({
		reason: z.enum(['EDITOR_DISCOVERY_FAILED', 'EDITOR_START_FAILED', 'STANDALONE_START_FAILED']),
		message: z.literal(safeErrorMessage),
	}).optional(),
});
export const remoteExecutionResultSchemas = {
	describe: z.strictObject({ workspaces: remoteWorkspacesSchema }),
	resolve: z.strictObject({
		canonicalUri: remoteFileUriSchema,
		identity: remoteWorkspaceDescriptorSchema.shape.fileIdentity,
	}),
	probe: remoteExecutionProbeSchema,
	start: nodeTaskStartedResultSchema,
	answer: z.null(),
	cancel: z.null(),
	disposeTask: z.null(),
	events: remoteExecutionEventsSchema,
	heartbeat: z.strictObject({ helperInstanceId: uuidSchema }),
} as const;
export type RemoteExecutionResult = z.infer<
	typeof remoteExecutionResultSchemas[keyof typeof remoteExecutionResultSchemas]
>;

const meshReasons = Object.keys(MESH_ERROR_CODES) as [MeshErrorReason, ...MeshErrorReason[]];
export const remoteExecutionErrorSchema = z.strictObject({
	code: z.union([z.enum(meshReasons), z.enum(AGENT_RUNTIME_ERROR_CODES)]),
	message: z.literal(safeErrorMessage),
	retryable: z.boolean(),
	cleanupComplete: z.literal(true).optional(),
}).refine((error) => error.cleanupComplete !== true
	|| error.code === 'TASK_EXECUTION_FAILED' || error.code === 'TASK_CANCELLATION_UNCONFIRMED',
);
export type RemoteExecutionError = z.infer<typeof remoteExecutionErrorSchema>;
export type RemoteExecutionEnvelope<T> =
	| { readonly ok: true; readonly result: T }
	| { readonly ok: false; readonly error: RemoteExecutionError };

export function remoteExecutionEnvelopeSchema<T>(result: z.ZodType<T>) {
	return z.discriminatedUnion('ok', [
		z.strictObject({ ok: z.literal(true), result }),
		z.strictObject({ ok: z.literal(false), error: remoteExecutionErrorSchema }),
	]);
}

export function remoteExecutionFailure(
	error: unknown,
	cleanupComplete?: true,
): { readonly ok: false; readonly error: RemoteExecutionError } {
	const code = error instanceof MeshDomainError && Object.hasOwn(MESH_ERROR_CODES, error.reason)
		? error.reason
		: error instanceof AgentRuntimeError && (AGENT_RUNTIME_ERROR_CODES as readonly string[]).includes(error.code)
			? error.code : 'TASK_EXECUTION_FAILED';
	return {
		ok: false,
		error: {
			code,
			message: safeErrorMessage,
			retryable: (error instanceof MeshDomainError || error instanceof AgentRuntimeError) && error.retryable === true,
			...(cleanupComplete === undefined ? {} : { cleanupComplete }),
		},
	};
}

export function remoteExecutionException(error: RemoteExecutionError): Error {
	return (AGENT_RUNTIME_ERROR_CODES as readonly string[]).includes(error.code)
		? new AgentRuntimeError(error.code as AgentRuntimeErrorCode, safeErrorMessage, error.retryable)
		: new MeshDomainError(error.code as MeshErrorReason, safeErrorMessage, error.retryable);
}

export function bridgeError(code: MeshErrorReason | AgentRuntimeErrorCode, retryable = false): Error {
	return remoteExecutionException({ code, message: safeErrorMessage, retryable });
}

export interface RemoteExecutionTimer {
	dispose(): void;
}
export interface RemoteExecutionTiming {
	now(): number;
	schedule(callback: () => void, delayMs: number): RemoteExecutionTimer;
}
export function remoteExecutionTiming(input: Partial<RemoteExecutionTiming> = {}): RemoteExecutionTiming {
	return {
		now: input.now ?? (() => performance.now()),
		schedule: input.schedule ?? ((callback, delayMs) => {
			const timer = setTimeout(callback, delayMs);
			return { dispose: () => clearTimeout(timer) };
		}),
	};
}

export interface RemoteExecutionBudgets {
	readonly connectTimeoutMs: number;
	readonly callTimeoutMs: number;
	readonly startTimeoutMs: number;
	readonly cleanupTimeoutMs: number;
	readonly leaseMs: number;
	readonly heartbeatIntervalMs: number;
	readonly pollWaitMs: number;
	readonly idlePollDelayMs: number;
	readonly eventBackpressureTimeoutMs: number;
	readonly eventAcknowledgementTimeoutMs: number;
	readonly maxConnectBytes: number;
	readonly maxRequestBytes: number;
	readonly maxResponseBytes: number;
	readonly maxInFlight: number;
	readonly maxControlInFlight: number;
	readonly maxStateOperations: number;
	readonly maxRequests: number;
	readonly maxTasks: number;
	readonly maxGenerations: number;
	readonly maxQueuedEvents: number;
	readonly maxQueuedEventBytes: number;
	readonly maxPendingEvents: number;
	readonly maxPendingEventBytes: number;
	readonly maxEventBatchCount: number;
	readonly maxEventBatchBytes: number;
}

export function remoteExecutionBudgets(input: Partial<RemoteExecutionBudgets> = {}): RemoteExecutionBudgets {
	const defaults: RemoteExecutionBudgets = {
		connectTimeoutMs: 5_000,
		callTimeoutMs: 15_000,
		startTimeoutMs: 180_000,
		cleanupTimeoutMs: 15_000,
		leaseMs: 30_000,
		heartbeatIntervalMs: 5_000,
		pollWaitMs: 10_000,
		idlePollDelayMs: 10,
		eventBackpressureTimeoutMs: 20_000,
		eventAcknowledgementTimeoutMs: 30_000,
		maxConnectBytes: 65_536,
		maxRequestBytes: PROTOCOL_LIMITS.frameBytes,
		maxResponseBytes: PROTOCOL_LIMITS.frameBytes,
		maxInFlight: 16,
		maxControlInFlight: 4,
		maxStateOperations: 4,
		maxRequests: 2_048,
		maxTasks: 256,
		maxGenerations: 64,
		maxQueuedEvents: 512,
		maxQueuedEventBytes: 2 * PROTOCOL_LIMITS.frameBytes,
		maxPendingEvents: 32,
		maxPendingEventBytes: PROTOCOL_LIMITS.frameBytes,
		maxEventBatchCount: 64,
		maxEventBatchBytes: 256 * 1_024,
	};
	const result = { ...defaults, ...input };
	for (const key of Object.keys(result) as Array<keyof RemoteExecutionBudgets>) {
		const value = result[key];
		const maximum = key.endsWith('Ms') ? 2_147_483_647
			: key.endsWith('Bytes') ? 16 * PROTOCOL_LIMITS.frameBytes : 8_192;
		if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
			throw new RangeError(`Invalid remote execution budget: ${key}.`);
		}
	}
	if (result.maxRequestBytes > PROTOCOL_LIMITS.frameBytes
		|| result.maxResponseBytes > PROTOCOL_LIMITS.frameBytes
		|| result.maxConnectBytes > PROTOCOL_LIMITS.unauthenticatedFrameBytes
		|| result.maxEventBatchCount > 256
		|| result.maxEventBatchBytes + 256 > result.maxResponseBytes) {
		throw new RangeError('Inconsistent remote execution frame budgets.');
	}
	return result;
}

// Do not invoke toJSON/getters or recurse through an unbounded command argument before validation.
export function parseRemoteValue<T>(schema: z.ZodType<T>, input: unknown, maxBytes: number): T {
	let remaining = maxBytes;
	const ancestors = new Set<object>();
	const spend = (bytes: number) => {
		remaining -= bytes;
		if (remaining < 0) {
			throw bridgeError('PROTOCOL_INCOMPATIBLE');
		}
	};
	const clone = (value: unknown, depth: number): unknown => {
		if (depth > 24) {
			throw bridgeError('PROTOCOL_INCOMPATIBLE');
		}
		if (value === null || typeof value === 'boolean'
			|| (typeof value === 'number' && Number.isFinite(value))) {
			spend(JSON.stringify(value).length);
			return value;
		}
		if (typeof value === 'string') {
			if (value.length > remaining) {
				throw bridgeError('PROTOCOL_INCOMPATIBLE');
			}
			spend(Buffer.byteLength(JSON.stringify(value), 'utf8'));
			return value;
		}
		if (typeof value !== 'object' || value === null || ancestors.has(value)) {
			throw bridgeError('PROTOCOL_INCOMPATIBLE');
		}
		ancestors.add(value);
		try {
			if (Array.isArray(value)) {
				spend(2 + value.length);
				const copy: unknown[] = [];
				for (let index = 0; index < value.length; index += 1) {
					const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
					if (descriptor === undefined || !('value' in descriptor)) {
						throw bridgeError('PROTOCOL_INCOMPATIBLE');
					}
					copy.push(clone(descriptor.value, depth + 1));
				}
				return copy;
			}
			if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
				throw bridgeError('PROTOCOL_INCOMPATIBLE');
			}
			const keys = Object.keys(value);
			spend(2 + keys.length * 2);
			const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
			for (const key of keys) {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (descriptor === undefined || !('value' in descriptor)) {
					throw bridgeError('PROTOCOL_INCOMPATIBLE');
				}
				// Optional undefined object properties have the same meaning as command JSON serialization.
				if (descriptor.value !== undefined) {
					if (key.length > remaining) {
						throw bridgeError('PROTOCOL_INCOMPATIBLE');
					}
					spend(Buffer.byteLength(JSON.stringify(key), 'utf8'));
					copy[key] = clone(descriptor.value, depth + 1);
				}
			}
			return copy;
		} finally {
			ancestors.delete(value);
		}
	};
	const parsed = schema.safeParse(clone(input, 0));
	if (!parsed.success) {
		throw bridgeError('PROTOCOL_INCOMPATIBLE');
	}
	return parsed.data;
}

export function remoteValueBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function remoteFingerprint(value: unknown): string {
	const canonical = (entry: unknown): unknown => {
		if (Array.isArray(entry)) {
			return entry.map(canonical);
		}
		if (entry !== null && typeof entry === 'object') {
			return Object.fromEntries(Object.entries(entry)
				.filter(([, item]) => item !== undefined)
				.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
				.map(([key, item]) => [key, canonical(item)]));
		}
		return entry;
	};
	return createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

export function remoteDeadline<T>(
	operation: Promise<T>,
	timeoutMs: number,
	timing: RemoteExecutionTiming,
	signal?: AbortSignal,
	timeoutError: Error = bridgeError('TASK_RECOVERY_UNAVAILABLE'),
): Promise<T> {
	return new Promise((resolve, reject) => {
		let done = false;
		let timer: RemoteExecutionTimer | undefined;
		const finish = (action: () => void) => {
			if (!done) {
				done = true;
				timer?.dispose();
				signal?.removeEventListener('abort', abort);
				action();
			}
		};
		const abort = () => {
			const reason: unknown = signal?.reason;
			const error = reason instanceof MeshDomainError || reason instanceof AgentRuntimeError
				? remoteExecutionException(remoteExecutionFailure(reason).error)
				: bridgeError('TASK_RECOVERY_UNAVAILABLE');
			finish(() => reject(error));
		};
		operation.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
		if (signal?.aborted) {
			abort();
		} else {
			signal?.addEventListener('abort', abort, { once: true });
			timer = timing.schedule(() => finish(() => reject(timeoutError)), timeoutMs);
		}
	});
}

export function remoteDelay(delayMs: number, timing: RemoteExecutionTiming, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		let timer: RemoteExecutionTimer | undefined;
		const finish = () => {
			timer?.dispose();
			signal.removeEventListener('abort', finish);
			resolve();
		};
		if (signal.aborted) {
			resolve();
		} else {
			signal.addEventListener('abort', finish, { once: true });
			timer = timing.schedule(finish, delayMs);
		}
	});
}
