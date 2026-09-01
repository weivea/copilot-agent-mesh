import { createHash, timingSafeEqual } from 'node:crypto';

import type { StateStore } from '../domain/ports';

const stateKeyPrefix = 'copilotAgentMesh.peerDelegationE2eState.v1';
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface PeerDelegationE2eStateEnvelope {
	readonly schemaVersion: 1;
	readonly scenario: 'peerDelegation';
	readonly runNonce: string;
	readonly logicalKey: string;
	readonly value: unknown;
}

export class PeerDelegationE2eStateStore implements StateStore {
	public constructor(
		private readonly state: StateStore,
		private readonly runNonce: string,
	) {
		if (!noncePattern.test(runNonce)) {
			throw new TypeError('The peer-delegation E2E state nonce must be a UUID v4.');
		}
	}

	public get<T>(key: string): T | undefined {
		const envelope = this.state.get<unknown>(physicalStateKey(key));
		if (!isEnvelope(envelope, key, this.runNonce)) {
			return undefined;
		}
		return structuredClone(envelope.value) as T;
	}

	public update(key: string, value: unknown): Promise<void> {
		const envelope: PeerDelegationE2eStateEnvelope = {
			schemaVersion: 1,
			scenario: 'peerDelegation',
			runNonce: this.runNonce,
			logicalKey: key,
			value: structuredClone(value),
		};
		return this.state.update(physicalStateKey(key), envelope);
	}
}

function physicalStateKey(logicalKey: string): string {
	if (
		logicalKey.length === 0
		|| Buffer.byteLength(logicalKey, 'utf8') > 512
	) {
		throw new TypeError('The peer-delegation E2E logical state key is invalid.');
	}
	const digest = createHash('sha256')
		.update('copilot-agent-mesh/peer-delegation-e2e-state/v1\0', 'utf8')
		.update(logicalKey, 'utf8')
		.digest('hex');
	return `${stateKeyPrefix}.${digest}`;
}

function isEnvelope(
	value: unknown,
	logicalKey: string,
	runNonce: string,
): value is PeerDelegationE2eStateEnvelope {
	if (
		typeof value !== 'object'
		|| value === null
		|| Array.isArray(value)
		|| Object.keys(value).sort().join(',') !== 'logicalKey,runNonce,scenario,schemaVersion,value'
	) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return candidate.schemaVersion === 1
		&& candidate.scenario === 'peerDelegation'
		&& candidate.logicalKey === logicalKey
		&& typeof candidate.runNonce === 'string'
		&& secureEqual(candidate.runNonce, runNonce);
}

function secureEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, 'utf8');
	const rightBytes = Buffer.from(right, 'utf8');
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
