import type { OwnedTaskStart } from '../../domain/task';

export const IDS = {
	device: '00000000-0000-4000-8000-000000000001',
	peer: '00000000-0000-4000-8000-000000000002',
	otherPeer: '00000000-0000-4000-8000-000000000003',
	workspace: '00000000-0000-4000-8000-000000000004',
	otherWorkspace: '00000000-0000-4000-8000-000000000005',
	delegation: '00000000-0000-4000-8000-000000000006',
	task: '00000000-0000-4000-8000-000000000007',
	otherTask: '00000000-0000-4000-8000-000000000008',
	input: '00000000-0000-4000-8000-000000000009',
	answer: '00000000-0000-4000-8000-00000000000a',
} as const;

export const AT = '2026-08-25T01:00:00.000Z';
export const LATER = '2026-08-25T01:01:00.000Z';
export const DEADLINE = '2026-08-25T02:00:00.000Z';

export function taskRequest(overrides: Partial<OwnedTaskStart> = {}): OwnedTaskStart {
	return {
		peerId: IDS.peer,
		delegationRequestId: IDS.delegation,
		taskId: IDS.task,
		workspaceId: IDS.workspace,
		title: 'Implement foundation',
		prompt: 'Keep this prompt exactly as written.\n',
		acceptanceCriteria: ['Tests pass'],
		workerDeadline: DEADLINE,
		...overrides,
	};
}
