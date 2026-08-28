import { createHash, randomBytes } from 'node:crypto';

import type * as vscode from 'vscode';

import type { StateStore } from '../domain/ports';
import type { SecretStore } from '../gateway/SecretStore';
import type { LocalIpcIdentity } from '../ipc';
import type { DeviceEnvironment, DeviceProfile } from '../storage/DeviceProfileStore';
import { DeviceProfileStore } from '../storage/DeviceProfileStore';
import type { BrokerOwnership } from '../storage/BrokerOwnerLock';

export const LOCAL_BROKER_KEY_SECRET = 'copilotAgentMesh.localBrokerKey.v2';

const brokerKeyPattern = /^[A-Za-z0-9_-]{43}$/u;
const defaultWaitTimeoutMs = 30_000;
const defaultWaitIntervalMs = 50;

export interface SharedBrokerWaitOptions {
	readonly timeoutMs?: number;
	readonly intervalMs?: number;
	readonly signal?: AbortSignal;
}

export async function ensureOwnedBrokerKey(
	secrets: SecretStore,
	ownership: BrokerOwnership,
	generation: string,
): Promise<string> {
	const existing = await readBrokerKey(secrets);
	if (existing !== undefined) {
		return existing;
	}
	await assertGeneration(ownership, generation);
	const candidate = randomBytes(32).toString('base64url');
	await secrets.store(LOCAL_BROKER_KEY_SECRET, candidate);
	try {
		await assertGeneration(ownership, generation);
	} catch (error: unknown) {
		throw new AggregateError(
			[error],
			'Broker ownership changed while creating the local authentication key.',
		);
	}
	return candidate;
}

export function waitForBrokerKey(
	secrets: SecretStore,
	options: SharedBrokerWaitOptions = {},
): Promise<string> {
	return waitForSharedValue(
		() => readBrokerKey(secrets),
		'Timed out waiting for the Broker owner to create local authentication state.',
		options,
	);
}

export function waitForDeviceProfile(
	state: StateStore,
	environment: DeviceEnvironment,
	options: SharedBrokerWaitOptions = {},
): Promise<DeviceProfile> {
	const store = new DeviceProfileStore(
		state,
		{ next: () => {
			throw new Error('A non-owner cannot create a device identity.');
		} },
		{ now: () => new Date() },
	);
	return waitForSharedValue(
		() => {
			const profile = store.get();
			if (
				profile !== undefined
				&& profile.platform !== environment.platform
			) {
				throw new Error('The shared device profile is incompatible with this Extension Host.');
			}
			return Promise.resolve(profile);
		},
		'Timed out waiting for the Broker owner to create the shared device profile.',
		options,
	);
}

export function createLocalBrokerIdentity(
	globalStorageUri: vscode.Uri,
	deviceId: string,
): LocalIpcIdentity {
	const storageIdentity = createHash('sha256')
		.update('copilot-agent-mesh/global-storage-identity/v2\0', 'utf8')
		.update(globalStorageUri.toString(), 'utf8')
		.digest();
	return {
		userIdentity: storageIdentity,
		deviceId,
	};
}

async function readBrokerKey(secrets: SecretStore): Promise<string | undefined> {
	const value = await secrets.get(LOCAL_BROKER_KEY_SECRET);
	if (value === undefined) {
		return undefined;
	}
	if (
		!brokerKeyPattern.test(value)
		|| Buffer.from(value, 'base64url').byteLength !== 32
		|| Buffer.from(value, 'base64url').toString('base64url') !== value
	) {
		throw new TypeError('The persisted local Broker authentication key is invalid.');
	}
	return value;
}

async function assertGeneration(
	ownership: BrokerOwnership,
	generation: string,
): Promise<void> {
	if (
		!ownership.isOwner()
		|| ownership.currentGeneration() !== generation
	) {
		throw new Error('The current Extension Host no longer owns this Broker generation.');
	}
	await ownership.assertOwner();
	if (ownership.currentGeneration() !== generation) {
		throw new Error('The current Extension Host no longer owns this Broker generation.');
	}
}

async function waitForSharedValue<T>(
	read: () => Promise<T | undefined>,
	timeoutMessage: string,
	options: SharedBrokerWaitOptions,
): Promise<T> {
	const timeoutMs = boundedWait(
		options.timeoutMs ?? defaultWaitTimeoutMs,
		'wait timeout',
	);
	const intervalMs = boundedWait(
		options.intervalMs ?? defaultWaitIntervalMs,
		'wait interval',
	);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (options.signal?.aborted === true) {
			throw new DOMException('Shared Broker identity wait was cancelled.', 'AbortError');
		}
		const value = await read();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() >= deadline) {
			throw new Error(timeoutMessage);
		}
		await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())), options.signal);
	}
}

function delay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', abort);
			resolve();
		}, delayMs);
		const abort = (): void => {
			clearTimeout(timer);
			reject(new DOMException('Shared Broker identity wait was cancelled.', 'AbortError'));
		};
		signal?.addEventListener('abort', abort, { once: true });
	});
}

function boundedWait(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > 10 * 60_000) {
		throw new RangeError(`The shared Broker ${label} is invalid.`);
	}
	return value;
}
