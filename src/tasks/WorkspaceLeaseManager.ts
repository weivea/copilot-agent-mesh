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
		assertLeaseIdentity(workspaceId, peerId, taskId);
		const owner = this.leases.get(workspaceId);
		const requestedOwner = { peerId, taskId };
		if (owner !== undefined && !sameOwner(owner, requestedOwner)) {
			throw new MeshDomainError('WORKSPACE_BUSY', 'An active task is using this workspace.');
		}
		this.leases.set(workspaceId, requestedOwner);
	}

	public release(workspaceId: string, peerId: string, taskId: string): void {
		assertLeaseIdentity(workspaceId, peerId, taskId);
		const owner = this.leases.get(workspaceId);
		if (owner !== undefined && sameOwner(owner, { peerId, taskId })) {
			this.leases.delete(workspaceId);
		}
	}

	public releaseForPersistedTerminal(record: TaskRecord): void {
		if (activeStatuses.has(record.state)) {
			throw new Error('Cannot release a workspace lease for a non-terminal task record.');
		}
		this.release(record.workspaceId, record.peerId, record.taskId);
	}

	public isLeased(workspaceId: string): boolean {
		return this.leases.has(workspaceId);
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
			assertLeaseIdentity(record.workspaceId, record.peerId, record.taskId);
			const owner = restored.get(record.workspaceId);
			const recordOwner = { peerId: record.peerId, taskId: record.taskId };
			if (owner !== undefined && !sameOwner(owner, recordOwner)) {
				throw new Error(`Multiple active task records claim workspace "${record.workspaceId}".`);
			}
			restored.set(record.workspaceId, recordOwner);
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

function assertLeaseIdentity(workspaceId: string, peerId: string, taskId: string): void {
	if (
		!uuidSchema.safeParse(workspaceId).success
		|| !uuidSchema.safeParse(peerId).success
		|| !uuidSchema.safeParse(taskId).success
	) {
		throw new TypeError('Workspace lease identity must contain valid UUIDs.');
	}
}
