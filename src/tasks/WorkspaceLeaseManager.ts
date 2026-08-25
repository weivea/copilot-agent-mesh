import { ACTIVE_TASK_STATUSES } from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import type { TaskRecord } from '../domain/task';

const activeStatuses = new Set<string>(ACTIVE_TASK_STATUSES);

export class WorkspaceLeaseManager {
	private readonly leases = new Map<string, string>();

	public acquire(workspaceId: string, taskId: string): void {
		const owner = this.leases.get(workspaceId);
		if (owner !== undefined && owner !== taskId) {
			throw new MeshDomainError('WORKSPACE_BUSY', 'An active task is using this workspace.');
		}
		this.leases.set(workspaceId, taskId);
	}

	public release(workspaceId: string, taskId: string): void {
		if (this.leases.get(workspaceId) === taskId) {
			this.leases.delete(workspaceId);
		}
	}

	public releaseForPersistedTerminal(record: TaskRecord): void {
		if (activeStatuses.has(record.state)) {
			throw new Error('Cannot release a workspace lease for a non-terminal task record.');
		}
		this.release(record.workspaceId, record.taskId);
	}

	public isLeased(workspaceId: string): boolean {
		return this.leases.has(workspaceId);
	}

	public owner(workspaceId: string): string | undefined {
		return this.leases.get(workspaceId);
	}

	public restoreFromTaskRecords(records: readonly TaskRecord[]): void {
		const restored = new Map<string, string>();
		for (const record of records) {
			if (!activeStatuses.has(record.state)) {
				continue;
			}
			const owner = restored.get(record.workspaceId);
			if (owner !== undefined && owner !== record.taskId) {
				throw new Error(`Multiple active task records claim workspace "${record.workspaceId}".`);
			}
			restored.set(record.workspaceId, record.taskId);
		}
		this.leases.clear();
		for (const [workspaceId, taskId] of restored) {
			this.leases.set(workspaceId, taskId);
		}
	}
}
