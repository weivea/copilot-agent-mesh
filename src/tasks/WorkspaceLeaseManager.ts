import { ACTIVE_TASK_STATUSES, uuidSchema } from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import type { TaskRecord } from '../domain/task';

const activeStatuses = new Set<string>(ACTIVE_TASK_STATUSES);

export interface WorkspaceLeaseOwner {
	readonly peerId: string;
	readonly taskId: string;
}

export class WorkspaceLeaseManager {
	private readonly leases = new Map<string, WorkspaceLeaseOwner>();

	public acquire(workspaceId: string, peerId: string, taskId: string): void {
		const identity = normalizeLeaseIdentity(workspaceId, peerId, taskId);
		const owner = this.leases.get(workspaceId);
		const requestedOwner = { peerId: identity.peerId, taskId: identity.taskId };
		if (owner !== undefined && !sameOwner(owner, requestedOwner)) {
			throw new MeshDomainError('WORKSPACE_BUSY', 'An active task is using this workspace.');
		}
		this.leases.set(workspaceId, requestedOwner);
	}

	public release(workspaceId: string, peerId: string, taskId: string): void {
		const identity = normalizeLeaseIdentity(workspaceId, peerId, taskId);
		const owner = this.leases.get(workspaceId);
		if (owner !== undefined && sameOwner(owner, identity)) {
			this.leases.delete(workspaceId);
		}
	}

	public releaseForPersistedTerminal(record: TaskRecord): void {
		if (activeStatuses.has(record.state)) {
			throw new Error('Cannot release a workspace lease for a non-terminal task record.');
		}
		this.release(record.workspaceLeaseKey, record.peerId, record.taskId);
	}

	public isLeased(workspaceId: string): boolean {
		return this.leases.has(workspaceId);
	}

	public activeLeaseCount(): number {
		return this.leases.size;
	}

	public owner(workspaceId: string): WorkspaceLeaseOwner | undefined {
		const owner = this.leases.get(workspaceId);
		return owner === undefined ? undefined : { ...owner };
	}

	public restoreFromTaskRecords(records: readonly TaskRecord[]): void {
		const restored = new Map<string, WorkspaceLeaseOwner>();
		for (const record of records) {
			if (!activeStatuses.has(record.state)) {
				continue;
			}
			const identity = normalizeLeaseIdentity(
				record.workspaceLeaseKey,
				record.peerId,
				record.taskId,
			);
			const owner = restored.get(record.workspaceLeaseKey);
			const recordOwner = { peerId: identity.peerId, taskId: identity.taskId };
			if (owner !== undefined && !sameOwner(owner, recordOwner)) {
				throw new Error(`Multiple active task records claim workspace "${record.workspaceId}".`);
			}
			restored.set(record.workspaceLeaseKey, recordOwner);
		}
		this.leases.clear();
		for (const [workspaceId, owner] of restored) {
			this.leases.set(workspaceId, owner);
		}
	}
}

function sameOwner(left: WorkspaceLeaseOwner, right: WorkspaceLeaseOwner): boolean {
	return left.peerId === right.peerId && left.taskId === right.taskId;
}

function normalizeLeaseIdentity(
	workspaceId: string,
	peerId: string,
	taskId: string,
): { readonly peerId: string; readonly taskId: string } {
	const parsedPeerId = uuidSchema.safeParse(peerId);
	const parsedTaskId = uuidSchema.safeParse(taskId);
	if (
		workspaceId.length === 0
		|| Buffer.byteLength(workspaceId, 'utf8') > 1_024
		|| !parsedPeerId.success
		|| !parsedTaskId.success
	) {
		throw new TypeError('Workspace lease key must be non-empty and its owner must contain valid UUIDs.');
	}
	return { peerId: parsedPeerId.data, taskId: parsedTaskId.data };
}
