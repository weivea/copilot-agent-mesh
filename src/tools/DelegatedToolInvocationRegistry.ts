import { createHash } from 'node:crypto';

import {
	delegatedExecutionContextSchema,
	type DelegatedExecutionContext,
} from '../../shared/protocol';
import { parseDelegateTaskInput } from './taskToolsCore';
import { MESH_TOOL_NAMES } from './toolManifest';

const defaultEntryLimit = 128;
const defaultScopeEntryLimit = 16;
const defaultTtlMs = 300_000;
const maximumCorrelationIdLength = 2_048;

interface CorrelationEntry {
	readonly observationKey: string;
	readonly scopeKey: string;
	readonly fingerprint: string;
	readonly context: DelegatedExecutionContext;
	readonly expiresAt: number;
	readonly claimed: boolean;
}

export interface DelegatedToolInvocationRegistryOptions {
	readonly entryLimit?: number;
	readonly scopeEntryLimit?: number;
	readonly ttlMs?: number;
	readonly now?: () => number;
}

export class DelegatedToolInvocationRegistry {
	private readonly entries = new Map<string, CorrelationEntry>();
	private readonly entryLimit: number;
	private readonly scopeEntryLimit: number;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private disposed = false;

	public constructor(options: DelegatedToolInvocationRegistryOptions = {}) {
		this.entryLimit = positiveInteger(options.entryLimit ?? defaultEntryLimit, 'entryLimit');
		this.scopeEntryLimit = positiveInteger(
			options.scopeEntryLimit ?? defaultScopeEntryLimit,
			'scopeEntryLimit',
		);
		if (this.scopeEntryLimit > this.entryLimit) {
			throw new TypeError('scopeEntryLimit cannot exceed entryLimit.');
		}
		this.ttlMs = positiveInteger(options.ttlMs ?? defaultTtlMs, 'ttlMs');
		this.now = options.now ?? Date.now;
	}

	public observe(input: {
		readonly scopeId: string;
		readonly invocationId: string;
		readonly toolName: string;
		readonly toolInput: unknown;
		readonly context: DelegatedExecutionContext;
	}): void {
		if (
			this.disposed
			|| input.toolName !== MESH_TOOL_NAMES.delegateTask
			|| typeof input.toolInput !== 'string'
			|| !validCorrelationId(input.scopeId)
			|| !validCorrelationId(input.invocationId)
		) {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(input.toolInput);
		} catch {
			return;
		}
		const fingerprint = delegationFingerprint(parsed);
		if (fingerprint === undefined) {
			return;
		}
		const now = this.now();
		this.prune(now);
		const scopeKey = digest(input.scopeId);
		const observationKey = digest(`${input.scopeId}\0${input.invocationId}`);
		if (this.entries.has(observationKey)) {
			return;
		}
		while (this.countScope(scopeKey) >= this.scopeEntryLimit) {
			const oldest = this.oldestUnclaimed((entry) => entry.scopeKey === scopeKey);
			if (oldest === undefined) {
				return;
			}
			this.entries.delete(oldest);
		}
		while (this.entries.size >= this.entryLimit) {
			const oldest = this.oldestUnclaimed();
			if (oldest === undefined) {
				return;
			}
			this.entries.delete(oldest);
		}
		this.entries.set(observationKey, {
			observationKey,
			scopeKey,
			fingerprint,
			context: delegatedExecutionContextSchema.parse(input.context),
			expiresAt: now + this.ttlMs,
			claimed: false,
		});
	}

	public consume(rawInput: unknown): DelegatedExecutionContext | undefined {
		if (this.disposed) {
			return undefined;
		}
		const fingerprint = delegationFingerprint(rawInput);
		if (fingerprint === undefined) {
			return undefined;
		}
		this.prune(this.now());
		const matches = [...this.entries.values()].filter((entry) =>
			entry.fingerprint === fingerprint,
		);
		const match = matches.find((entry) => !entry.claimed) ?? matches[0];
		if (match === undefined) {
			return undefined;
		}
		if (!match.claimed) {
			this.entries.set(match.observationKey, {
				...match,
				claimed: true,
			});
		}
		return { ...match.context };
	}

	public forget(scopeId: string, invocationId: string): void {
		if (!validCorrelationId(scopeId) || !validCorrelationId(invocationId)) {
			return;
		}
		this.entries.delete(digest(`${scopeId}\0${invocationId}`));
	}

	public clearScope(scopeId: string): void {
		if (!validCorrelationId(scopeId)) {
			return;
		}
		const scopeKey = digest(scopeId);
		for (const [key, entry] of this.entries) {
			if (entry.scopeKey === scopeKey) {
				this.entries.delete(key);
			}
		}
	}

	public dispose(): void {
		this.disposed = true;
		this.entries.clear();
	}

	public clear(): void {
		this.entries.clear();
	}

	public get size(): number {
		this.prune(this.now());
		return this.entries.size;
	}

	private prune(now: number): void {
		for (const [key, entry] of this.entries) {
			if (!entry.claimed && entry.expiresAt <= now) {
				this.entries.delete(key);
			}
		}
	}

	private countScope(scopeKey: string): number {
		let count = 0;
		for (const entry of this.entries.values()) {
			if (entry.scopeKey === scopeKey) {
				count += 1;
			}
		}
		return count;
	}

	private oldestUnclaimed(
		predicate: (entry: CorrelationEntry) => boolean = () => true,
	): string | undefined {
		return [...this.entries.entries()].find(([, entry]) =>
			!entry.claimed && predicate(entry),
		)?.[0];
	}
}

function delegationFingerprint(rawInput: unknown): string | undefined {
	try {
		const input = parseDelegateTaskInput(rawInput);
		const target = 'targetHandle' in input ? [input.targetHandle] : [
			input.deviceId, input.nodeId, input.nodeInstanceId, input.workspaceId, input.peerId ?? null,
		];
		return digest(JSON.stringify([
			input.delegationRequestId ?? null,
			target,
			input.title,
			input.prompt,
			input.acceptanceCriteria,
			input.timeoutMinutes ?? null,
			input.mode ?? 'wait',
		]));
	} catch {
		return undefined;
	}
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function validCorrelationId(value: string): boolean {
	return value.length > 0 && value.length <= maximumCorrelationIdLength;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive integer.`);
	}
	return value;
}
