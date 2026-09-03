export interface ExactManualTarget {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly workspaceId: string;
}

export interface ManualInvocationObservation {
	readonly phase: 'prepareFailed' | 'prepared' | 'invokeStarted' | 'invokeCompleted';
	readonly compactStatus?: number;
	readonly errorCode?: string;
	readonly taskIdPresent: boolean;
}

export interface ManualInvocationSummary {
	readonly preparedCount: number;
	readonly prepareFailedCount: number;
	readonly invokeStartedCount: number;
	readonly invokeCompletedCount: number;
	readonly compactStatus?: number;
	readonly errorCode?: string;
	readonly taskIdPresent: boolean;
}

export type ExactTargetLiveness =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: 'PEER_OFFLINE' };

export function summarizeManualInvocation(
	observations: readonly ManualInvocationObservation[],
): ManualInvocationSummary {
	const latestTerminal = [...observations].reverse().find(
		({ phase }) => phase === 'prepareFailed' || phase === 'invokeCompleted',
	);
	return {
		preparedCount: countPhase(observations, 'prepared'),
		prepareFailedCount: countPhase(observations, 'prepareFailed'),
		invokeStartedCount: countPhase(observations, 'invokeStarted'),
		invokeCompletedCount: countPhase(observations, 'invokeCompleted'),
		...(latestTerminal?.compactStatus === undefined
			? {}
			: { compactStatus: latestTerminal.compactStatus }),
		...(latestTerminal?.errorCode === undefined
			? {}
			: { errorCode: latestTerminal.errorCode }),
		taskIdPresent: observations.some(({ taskIdPresent }) => taskIdPresent),
	};
}

export function assessExactTargetLiveness(
	target: ExactManualTarget,
	controllerState: unknown,
	dashboardSnapshot: unknown,
): ExactTargetLiveness {
	if (!isRecord(controllerState) || !isRecord(controllerState.node)) {
		return { ok: false, code: 'PEER_OFFLINE' };
	}
	const node = controllerState.node;
	if (
		node.nodeId !== target.nodeId
		|| node.nodeInstanceId !== target.nodeInstanceId
		|| node.state !== 'online'
		|| node.registered !== true
		|| !Number.isSafeInteger(node.workspaceCount)
		|| (node.workspaceCount as number) < 1
	) {
		return { ok: false, code: 'PEER_OFFLINE' };
	}
	if (!isRecord(dashboardSnapshot) || !Array.isArray(dashboardSnapshot.localNodes)) {
		return { ok: false, code: 'PEER_OFFLINE' };
	}
	const exactNodes = dashboardSnapshot.localNodes.filter((entry) =>
		isRecord(entry)
		&& entry.nodeId === target.nodeId
		&& entry.nodeInstanceId === target.nodeInstanceId
	);
	if (exactNodes.length !== 1) {
		return { ok: false, code: 'PEER_OFFLINE' };
	}
	const exactNode = exactNodes[0];
	if (
		!isRecord(exactNode)
		|| !['online', 'busy'].includes(String(exactNode.status))
		|| !Array.isArray(exactNode.workspaces)
	) {
		return { ok: false, code: 'PEER_OFFLINE' };
	}
	const exactWorkspaces = exactNode.workspaces.filter((entry) =>
		isRecord(entry)
		&& entry.workspaceId === target.workspaceId
		&& entry.claimStatus === 'claimed'
		&& entry.enabled === true
	);
	return exactWorkspaces.length === 1
		? { ok: true }
		: { ok: false, code: 'PEER_OFFLINE' };
}

function countPhase(
	observations: readonly ManualInvocationObservation[],
	phase: ManualInvocationObservation['phase'],
): number {
	return observations.filter((observation) => observation.phase === phase).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
