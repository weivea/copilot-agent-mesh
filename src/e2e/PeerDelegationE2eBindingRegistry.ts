import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rmdir,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { deterministicTaskId } from '../tools/LocalBrokerTaskFacade';
import { TaskToolFacadeError } from '../tools/taskToolFacade';

const maximumBindings = 512;
const lockRetryMs = 10;
const lockTimeoutMs = 15_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const bindingFilePattern = /^binding-[a-f0-9]{64}\.json$/u;
const releasedLockPattern = /^\.lock\.released-[0-9a-f-]{36}$/u;
const processIncarnation = randomUUID();

interface ReservationOwner {
	readonly token: string;
	readonly pid: number;
	readonly processIncarnation: string;
}

interface Binding {
	readonly delegationRequestId: string;
	readonly sourceWorkspaceIdentity?: string;
	readonly taskId: string;
}

interface StoredBinding extends Binding {
	readonly schemaVersion: 1;
	readonly scenario: 'peerDelegation';
	readonly runNonce: string;
	readonly finalized: boolean;
	readonly retirementPending: boolean;
	readonly reservationTokens: readonly ReservationOwner[];
}

export interface BindingReservation {
	readonly token?: string;
}

export class PeerDelegationE2eBindingRegistry {
	private readonly directory: string;
	private readonly lockDirectory: string;

	public constructor(
		rootDirectory: string,
		private readonly runNonce: string,
	) {
		if (rootDirectory.length === 0 || !noncePattern.test(runNonce)) {
			throw new TypeError('The peer-delegation binding registry configuration is invalid.');
		}
		const runDigest = digest('run', runNonce);
		this.directory = join(rootDirectory, 'manual-delegation-bindings-v1', runDigest);
		this.lockDirectory = join(this.directory, '.lock');
	}

	public reserve(binding: Binding): Promise<BindingReservation> {
		return this.withLock(async () => {
			const normalized = parseBinding(binding);
			if (
				deterministicTaskId(
					normalized.delegationRequestId,
					normalized.sourceWorkspaceIdentity,
				) !== normalized.taskId
			) {
				throw new TaskToolFacadeError('OUTPUT_INVALID');
			}
			const existing = await this.readBinding(normalized.delegationRequestId);
			if (existing !== undefined) {
				if (!sameBinding(existing, normalized)) {
					throw new TaskToolFacadeError('IDEMPOTENCY_CONFLICT');
				}
				const token = randomUUID();
				const reservations = liveReservations(existing.reservationTokens);
				await this.writeBinding({
					...existing,
					reservationTokens: [...reservations, reservationOwner(token)],
				});
				return { token };
			}
			const files = await this.bindingFiles();
			if (files.length >= maximumBindings) {
				throw new TaskToolFacadeError('RATE_LIMITED', true);
			}
			const token = randomUUID();
			await this.writeBinding({
				...normalized,
				finalized: false,
				retirementPending: false,
				reservationTokens: [reservationOwner(token)],
			});
			return { token };
		});
	}

	public finalizeReservation(
		binding: Binding,
		reservation: BindingReservation,
	): Promise<void> {
		if (reservation.token === undefined) {
			return Promise.resolve();
		}
		return this.updateReservation(binding, reservation.token, true);
	}

	public retireReservation(
		binding: Binding,
		reservation: BindingReservation,
	): Promise<void> {
		if (reservation.token === undefined) {
			return Promise.resolve();
		}
		return this.updateReservation(binding, reservation.token, false);
	}

	public async resolve(
		delegationRequestId: string,
		sourceWorkspaceIdentity: string,
	): Promise<string> {
		const requestId = parseUuid(delegationRequestId);
		const sourceScope = parseSourceWorkspaceIdentity(sourceWorkspaceIdentity);
		const binding = await this.readBinding(requestId);
		if (
			binding === undefined
			|| binding.sourceWorkspaceIdentity !== sourceScope
		) {
			throw new TaskToolFacadeError('DELEGATION_NOT_FOUND');
		}
		if (deterministicTaskId(requestId, sourceScope) !== binding.taskId) {
			throw new TaskToolFacadeError('OUTPUT_INVALID');
		}
		return binding.taskId;
	}

	public retire(taskId: string): Promise<void> {
		const parsedTaskId = parseUuid(taskId);
		return this.withLock(async () => {
			for (const file of await this.bindingFiles()) {
				const binding = await this.readStoredBinding(join(this.directory, file));
				if (binding.taskId === parsedTaskId) {
					const reservations = liveReservations(binding.reservationTokens);
					if (reservations.length === 0) {
						await unlink(join(this.directory, file));
						await syncDirectory(this.directory);
					} else {
						await this.writeBinding({
							...binding,
							retirementPending: true,
							reservationTokens: reservations,
						});
					}
					return;
				}
			}
		});
	}

	public size(): Promise<number> {
		return this.withLock(async () => (await this.bindingFiles()).length);
	}

	private async updateReservation(
		binding: Binding,
		token: string,
		finalize: boolean,
	): Promise<void> {
		const normalized = parseBinding(binding);
		await this.withLock(async () => {
			const existing = await this.readBinding(normalized.delegationRequestId);
			if (
				existing === undefined
				|| !sameBinding(existing, normalized)
				|| !existing.reservationTokens.some(
					(reservation) => reservation.token === token,
				)
			) {
				throw new TaskToolFacadeError('OUTPUT_INVALID');
			}
			const reservationTokens = liveReservations(existing.reservationTokens).filter(
				(candidate) => candidate.token !== token,
			);
			if (existing.retirementPending && reservationTokens.length === 0) {
				await unlink(this.bindingPath(normalized.delegationRequestId));
				await syncDirectory(this.directory);
				return;
			}
			if (!finalize && !existing.finalized && reservationTokens.length === 0) {
				await unlink(this.bindingPath(normalized.delegationRequestId));
				await syncDirectory(this.directory);
				return;
			}
			await this.writeBinding({
				...existing,
				finalized: existing.finalized || finalize,
				retirementPending: existing.retirementPending,
				reservationTokens,
			});
		});
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.directory, { recursive: true });
		const lockToken = await this.acquireLock();
		let operationError: unknown;
		try {
			await this.cleanupReleasedLocks();
			return await operation();
		} catch (error: unknown) {
			operationError = error;
			throw error;
		} finally {
			try {
				await this.releaseLock(lockToken);
			} catch (releaseError: unknown) {
				if (operationError === undefined) {
					throw releaseError;
				}
				throw new AggregateError(
					[operationError, releaseError],
					'Peer-delegation binding operation and lock release both failed.',
				);
			}
		}
	}

	private async cleanupReleasedLocks(): Promise<void> {
		for (const entry of await readdir(this.directory)) {
			if (!releasedLockPattern.test(entry)) {
				continue;
			}
			const released = join(this.directory, entry);
			try {
				await unlink(join(released, 'owner.json'));
			} catch (error: unknown) {
				if (!isFileNotFound(error)) {
					throw error;
				}
			}
			try {
				await rmdir(released);
			} catch (error: unknown) {
				if (!isFileNotFound(error)) {
					throw error;
				}
			}
		}
	}

	private async acquireLock(): Promise<string> {
			const deadline = Date.now() + lockTimeoutMs;
			for (;;) {
				const token = randomUUID();
				const candidateDirectory = `${this.lockDirectory}.candidate-${token}`;
				try {
					await mkdir(candidateDirectory);
					try {
						await writeFile(
							join(candidateDirectory, 'owner.json'),
							`${JSON.stringify({ pid: process.pid, token })}\n`,
							{ encoding: 'utf8', flag: 'wx', mode: 0o600 },
						);
						await rename(candidateDirectory, this.lockDirectory);
					} catch (error: unknown) {
						try {
							await unlink(join(candidateDirectory, 'owner.json'));
							await rmdir(candidateDirectory);
						} catch (cleanupError: unknown) {
							if (!isFileNotFound(cleanupError)) {
								throw new AggregateError(
									[error, cleanupError],
									'Binding lock initialization and rollback both failed.',
								);
							}
						}
						throw error;
					}
					const published: unknown = JSON.parse(
						await readFile(join(this.lockDirectory, 'owner.json'), 'utf8'),
					);
					if (
						typeof published !== 'object'
						|| published === null
						|| (published as Record<string, unknown>).token !== token
					) {
						throw new Error('Peer-delegation binding lock publication was fenced.');
					}
					return token;
				} catch (error: unknown) {
					if (!isDestinationOccupied(error)) {
						throw error;
					}
					await this.recoverAbandonedLock();
					if (Date.now() >= deadline) {
						throw new TaskToolFacadeError('TIMEOUT', true);
					}
					await delay(lockRetryMs);
				}
			}
		}

	private async recoverAbandonedLock(): Promise<void> {
		const owner = await this.readLockOwner();
		if (owner === undefined || processIsAlive(owner.pid)) {
			return;
		}
		const currentOwner = await this.readLockOwner();
		if (currentOwner?.token !== owner.token) {
			return;
		}
		if (processIsAlive(currentOwner.pid)) {
			return;
		}
		const staleDirectory = `${this.lockDirectory}.stale-${currentOwner.token}`;
		try {
			await rename(this.lockDirectory, staleDirectory);
		} catch (error: unknown) {
			if (isFileNotFound(error) || isDestinationOccupied(error)) {
				return;
			}
			throw error;
		}
	}

	private async readLockOwner(): Promise<
		{ readonly pid: number; readonly token: string } | undefined
	> {
		try {
			const value: unknown = JSON.parse(
				await readFile(join(this.lockDirectory, 'owner.json'), 'utf8'),
			);
			if (
				typeof value !== 'object'
				|| value === null
				|| Array.isArray(value)
				|| Object.keys(value).sort().join(',') !== 'pid,token'
			) {
				return undefined;
			}
			const candidate = value as Record<string, unknown>;
			if (
				!Number.isSafeInteger(candidate.pid)
				|| (candidate.pid as number) <= 0
				|| typeof candidate.token !== 'string'
				|| !uuidPattern.test(candidate.token)
			) {
				return undefined;
			}
			return { pid: candidate.pid as number, token: candidate.token };
		} catch (error: unknown) {
			if (isFileNotFound(error) || error instanceof SyntaxError) {
				return undefined;
			}
			throw error;
		}
	}

	private async releaseLock(token: string): Promise<void> {
			let value: unknown;
			try {
				value = JSON.parse(await readFile(join(this.lockDirectory, 'owner.json'), 'utf8'));
			} catch {
				throw new Error('Peer-delegation binding lock ownership is unavailable.');
			}
			if (
				typeof value !== 'object'
				|| value === null
				|| Array.isArray(value)
				|| (value as Record<string, unknown>).token !== token
			) {
				throw new Error('Peer-delegation binding lock ownership changed.');
			}
			await rename(
				this.lockDirectory,
				`${this.lockDirectory}.released-${token}`,
			);
	}

	private async bindingFiles(): Promise<readonly string[]> {
		return (await readdir(this.directory))
			.filter((file) => bindingFilePattern.test(file))
			.sort();
	}

	private async readBinding(delegationRequestId: string): Promise<StoredBinding | undefined> {
		const path = this.bindingPath(delegationRequestId);
		let contents: string;
		try {
			contents = await readFile(path, 'utf8');
		} catch (error: unknown) {
			if (isFileNotFound(error)) {
				return undefined;
			}
			throw error;
		}
		return this.parseStoredBinding(contents);
	}

	private async readStoredBinding(path: string): Promise<StoredBinding> {
		return this.parseStoredBinding(await readFile(path, 'utf8'));
	}

	private parseStoredBinding(contents: string): StoredBinding {
		let value: unknown;
		try {
			value = JSON.parse(contents);
		} catch {
			throw new TaskToolFacadeError('OUTPUT_INVALID');
		}
		if (
			typeof value !== 'object'
			|| value === null
			|| Array.isArray(value)
			|| Object.keys(value).sort().join(',')
				!== 'delegationRequestId,finalized,reservationTokens,retirementPending,runNonce,scenario,schemaVersion,sourceWorkspaceIdentity,taskId'
				&& Object.keys(value).sort().join(',')
					!== 'delegationRequestId,finalized,reservationTokens,retirementPending,runNonce,scenario,schemaVersion,taskId'
		) {
			throw new TaskToolFacadeError('OUTPUT_INVALID');
		}
		const candidate = value as Record<string, unknown>;
		if (
			candidate.schemaVersion !== 1
			|| candidate.scenario !== 'peerDelegation'
			|| typeof candidate.finalized !== 'boolean'
			|| typeof candidate.retirementPending !== 'boolean'
			|| !Array.isArray(candidate.reservationTokens)
			|| candidate.reservationTokens.some(
				(reservation) => !isReservationOwner(reservation),
			)
			|| typeof candidate.runNonce !== 'string'
			|| !secureEqual(candidate.runNonce, this.runNonce)
		) {
			throw new TaskToolFacadeError('OUTPUT_INVALID');
		}
		return {
			...parseBinding(candidate),
			schemaVersion: 1,
			scenario: 'peerDelegation',
			runNonce: candidate.runNonce,
			finalized: candidate.finalized,
			retirementPending: candidate.retirementPending,
			reservationTokens: candidate.reservationTokens as ReservationOwner[],
		};
	}

	private async writeBinding(
		binding: Binding & Pick<
			StoredBinding,
			'finalized' | 'retirementPending' | 'reservationTokens'
		>,
	): Promise<void> {
		const target = this.bindingPath(binding.delegationRequestId);
		const temporary = `${target}.${randomUUID()}.tmp`;
		const stored: StoredBinding = {
			schemaVersion: 1,
			scenario: 'peerDelegation',
			runNonce: this.runNonce,
			...binding,
		};
		const handle = await open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(stored)}\n`, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temporary, target);
			await syncDirectory(this.directory);
		} catch (error: unknown) {
			try {
				await unlink(temporary);
			} catch (cleanupError: unknown) {
				if (!isFileNotFound(cleanupError)) {
					throw new AggregateError(
						[error, cleanupError],
						'Binding write and temporary-file cleanup both failed.',
					);
				}
			}
			throw error;
		}
	}

	private bindingPath(delegationRequestId: string): string {
		return join(this.directory, `binding-${digest('request', delegationRequestId)}.json`);
	}
}

function parseBinding(value: {
	readonly delegationRequestId?: unknown;
	readonly sourceWorkspaceIdentity?: unknown;
	readonly taskId?: unknown;
}): Binding {
	const delegationRequestId = parseUuid(value.delegationRequestId);
	const taskId = parseUuid(value.taskId);
	const sourceWorkspaceIdentity = value.sourceWorkspaceIdentity === undefined
		? undefined
		: parseSourceWorkspaceIdentity(value.sourceWorkspaceIdentity);
	return {
		delegationRequestId,
		...(sourceWorkspaceIdentity === undefined ? {} : { sourceWorkspaceIdentity }),
		taskId,
	};
}

function parseUuid(value: unknown): string {
	if (typeof value !== 'string' || !uuidPattern.test(value)) {
		throw new TaskToolFacadeError('OUTPUT_INVALID');
	}
	return value;
}

function parseSourceWorkspaceIdentity(value: unknown): string {
	if (
		typeof value !== 'string'
		|| value.length === 0
		|| Buffer.byteLength(value, 'utf8') > 512
	) {
		throw new TaskToolFacadeError('OUTPUT_INVALID');
	}
	return value;
}

function sameBinding(left: Binding, right: Binding): boolean {
	return left.delegationRequestId === right.delegationRequestId
		&& left.sourceWorkspaceIdentity === right.sourceWorkspaceIdentity
		&& left.taskId === right.taskId;
}

function digest(kind: 'request' | 'run', value: string): string {
	return createHash('sha256')
		.update(`copilot-agent-mesh/peer-delegation-binding/${kind}/v1\0`, 'utf8')
		.update(value, 'utf8')
		.digest('hex');
}

function secureEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, 'utf8');
	const rightBytes = Buffer.from(right, 'utf8');
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function syncDirectory(path: string): Promise<void> {
	if (process.platform === 'win32') {
		return;
	}
	const handle = await open(path, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& error.code === 'EEXIST';
}

function isDestinationOccupied(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& ['EEXIST', 'ENOTEMPTY'].includes(String(error.code));
}

function isFileNotFound(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& error.code === 'ENOENT';
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return !(
			typeof error === 'object'
			&& error !== null
			&& 'code' in error
			&& error.code === 'ESRCH'
		);
	}
}

function reservationOwner(token: string): ReservationOwner {
	return {
		token,
		pid: process.pid,
		processIncarnation,
	};
}

function liveReservations(
	reservations: readonly ReservationOwner[],
): readonly ReservationOwner[] {
	return reservations.filter((reservation) =>
		processIsAlive(reservation.pid)
		&& (
			reservation.pid !== process.pid
			|| reservation.processIncarnation === processIncarnation
		));
}

function isReservationOwner(value: unknown): value is ReservationOwner {
	if (
		typeof value !== 'object'
		|| value === null
		|| Array.isArray(value)
		|| Object.keys(value).sort().join(',') !== 'pid,processIncarnation,token'
	) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return Number.isSafeInteger(candidate.pid)
		&& (candidate.pid as number) > 0
		&& typeof candidate.token === 'string'
		&& uuidPattern.test(candidate.token)
		&& typeof candidate.processIncarnation === 'string'
		&& uuidPattern.test(candidate.processIncarnation);
}
