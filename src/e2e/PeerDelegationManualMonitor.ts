export interface ExactManualTarget {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly workspaceId: string;
}

export interface ManualInvocationObservation {
	readonly phase:
		| 'prepareStarted'
		| 'prepareFailed'
		| 'prepared'
		| 'invokeStarted'
		| 'invokeCompleted';
	readonly compactStatus?: number;
	readonly errorCode?: string;
	readonly taskIdPresent: boolean;
}

export interface ManualInvocationSummary {
	readonly preparedCount: number;
	readonly prepareStartedCount: number;
	readonly prepareFailedCount: number;
	readonly invokeStartedCount: number;
	readonly invokeCompletedCount: number;
	readonly unexpectedInvocationCount: number;
	readonly unexpectedActivityCount: number;
	readonly unresolvedPreparationCount: number;
	readonly compactStatus?: number;
	readonly errorCode?: string;
	readonly taskIdPresent: boolean;
}

export interface SequencedManualToolObservation extends ManualInvocationObservation {
	readonly sequence: number;
	readonly toolName: string;
	readonly delegationRequestId?: string;
	readonly taskId?: string;
	readonly preparationSequence?: number;
	readonly invocationSequence?: number;
}

export interface PostPromptManualInvocations {
	readonly expected: ManualInvocationSummary;
	readonly delegateObservations: readonly SequencedManualToolObservation[];
	readonly unexpectedInvokeStartedCount: number;
	readonly allInvokeStartedCount: number;
	readonly allInvokeCompletedCount: number;
	readonly unsettledInvokeStartedCount: number;
	readonly unresolvedPreparationCount: number;
	readonly unexpectedActivityCount: number;
}

export interface FinalPeerResourceMetrics {
	readonly listener: {
		readonly startAttempts: number;
	};
	readonly tunnel: {
		readonly loadAttempts: number;
		readonly probeAttempts: number;
		readonly ensureHostedAttempts: number;
	};
	readonly toolTimers: {
		readonly timersCreated: number;
		readonly timersDisposed: number;
		readonly activeTimers: number;
		readonly budgetTimersCreated: number;
		readonly armedBudgetTimers: number;
	};
}

export type TargetControllerRejection =
	| 'await-authoritative-outcome'
	| 'target-window-closed'
	| 'transient-unavailable'
	| 'observation-history-incomplete';

export type FrozenManualDecision =
	| 'authoritative-outcome'
	| 'pre-invocation-failure'
	| 'observation-history-incomplete';

export type ExactTargetLiveness =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: 'PEER_OFFLINE' };

export function summarizeManualInvocation(
	observations: readonly ManualInvocationObservation[],
	unexpectedInvocationCount = 0,
	unexpectedActivityCount = unexpectedInvocationCount,
	unresolvedPreparationCount = 0,
): ManualInvocationSummary {
	const latestTerminal = [...observations].reverse().find(
		({ phase }) => phase === 'prepareFailed' || phase === 'invokeCompleted',
	);
	return {
		preparedCount: countPhase(observations, 'prepared'),
		prepareStartedCount: countPhase(observations, 'prepareStarted'),
		prepareFailedCount: countPhase(observations, 'prepareFailed'),
		invokeStartedCount: countPhase(observations, 'invokeStarted'),
		invokeCompletedCount: countPhase(observations, 'invokeCompleted'),
		unexpectedInvocationCount,
		unexpectedActivityCount,
		unresolvedPreparationCount,
		...(latestTerminal?.compactStatus === undefined
			? {}
			: { compactStatus: latestTerminal.compactStatus }),
		...(latestTerminal?.errorCode === undefined
			? {}
			: { errorCode: latestTerminal.errorCode }),
		taskIdPresent: observations.some(({ taskIdPresent }) => taskIdPresent),
	};
}

export function latestManualObservationSequence(
	observations: readonly { readonly sequence: number }[],
): number {
	return observations.reduce((latest, observation) => {
		if (!Number.isSafeInteger(observation.sequence) || observation.sequence <= latest) {
			throw new TypeError('Manual Tool observations must have a strictly increasing sequence.');
		}
		return observation.sequence;
	}, 0);
}

export function summarizePostPromptDelegations(
	observations: readonly SequencedManualToolObservation[],
	checkpoint: number,
	expectedDelegationRequestId: string,
): PostPromptManualInvocations {
	if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) {
		throw new TypeError('The manual Tool observation checkpoint is invalid.');
	}
	const postPrompt = observations.filter(({ sequence }) => sequence > checkpoint);
	latestManualObservationSequence(postPrompt);
	const delegateObservations = postPrompt.filter(
		({ toolName }) => toolName === 'mesh_delegate_task',
	);
	const expectedObservations = delegateObservations.filter(
		({ delegationRequestId }) => delegationRequestId === expectedDelegationRequestId,
	);
	const expectedInvokeStartedCount = countPhase(expectedObservations, 'invokeStarted');
	const allInvokeStartedCount = countPhase(delegateObservations, 'invokeStarted');
	const unexpectedInvokeStartedCount =
		allInvokeStartedCount - Math.min(expectedInvokeStartedCount, 1);
	const expectedPhaseLimits = new Map<ManualInvocationObservation['phase'], number>([
		['prepareStarted', 1],
		['prepareFailed', 1],
		['prepared', 1],
		['invokeStarted', 1],
		['invokeCompleted', 1],
	]);
	const unexpectedActivityCount = delegateObservations.filter(
		({ delegationRequestId }) => delegationRequestId !== expectedDelegationRequestId,
	).length + [...expectedPhaseLimits].reduce(
		(total, [phase, limit]) =>
			total + Math.max(0, countPhase(expectedObservations, phase) - limit),
		0,
	) + Number(
		countPhase(expectedObservations, 'prepared') > 0
		&& countPhase(expectedObservations, 'prepareFailed') > 0,
	);
	const startedSequences = new Set(delegateObservations
		.filter(({ phase }) => phase === 'invokeStarted')
		.map(({ invocationSequence }) => invocationSequence)
		.filter(isPositiveInteger));
	const completedSequences = new Set(delegateObservations
		.filter(({ phase }) => phase === 'invokeCompleted')
		.map(({ invocationSequence }) => invocationSequence)
		.filter(isPositiveInteger));
	const unsettledInvokeStartedCount = delegateObservations.filter(
		({ phase, invocationSequence }) =>
			phase === 'invokeStarted'
			&& (
				!isPositiveInteger(invocationSequence)
				|| !completedSequences.has(invocationSequence)
			),
	).length;
	const preparationCounts = new Map<string, { prepared: number; started: number }>();
	for (const observation of delegateObservations) {
		const key = observation.delegationRequestId ?? '<missing>';
		const counts = preparationCounts.get(key) ?? { prepared: 0, started: 0 };
		if (observation.phase === 'prepared') {
			counts.prepared += 1;
		} else if (observation.phase === 'invokeStarted') {
			counts.started += 1;
		}
		preparationCounts.set(key, counts);
	}
	const unresolvedPreparationCount = [...preparationCounts.values()].reduce(
		(total, { prepared, started }) => total + Math.max(0, prepared - started),
		0,
	) + countOpenPreparations(delegateObservations);
	return {
		expected: summarizeManualInvocation(
			expectedObservations,
			unexpectedInvokeStartedCount,
			unexpectedActivityCount,
			unresolvedPreparationCount,
		),
		delegateObservations,
		unexpectedInvokeStartedCount,
		unexpectedActivityCount,
		allInvokeStartedCount,
		allInvokeCompletedCount: [...completedSequences].filter(
			(sequence) => startedSequences.has(sequence),
		).length,
		unsettledInvokeStartedCount,
		unresolvedPreparationCount,
	};
}

export function classifyTargetControllerRejection(
	invocations: PostPromptManualInvocations,
	observationHistoryComplete: boolean,
	controllerProcessAlive: boolean,
): TargetControllerRejection {
	if (invocations.allInvokeStartedCount > 0) {
		return 'await-authoritative-outcome';
	}
	if (!observationHistoryComplete) {
		return 'observation-history-incomplete';
	}
	return controllerProcessAlive ? 'transient-unavailable' : 'target-window-closed';
}

export function classifyFrozenManualDecision(
	invocations: PostPromptManualInvocations,
	observationHistoryComplete: boolean,
): FrozenManualDecision {
	if (invocations.allInvokeStartedCount > 0) {
		return 'authoritative-outcome';
	}
	if (!observationHistoryComplete) {
		return 'observation-history-incomplete';
	}
	return 'pre-invocation-failure';
}

export function isSuccessfulManualInvocation(
	invocations: PostPromptManualInvocations,
	observationHistoryComplete: boolean,
): boolean {
	const summary = invocations.expected;
	return observationHistoryComplete
		&& invocations.unexpectedInvokeStartedCount === 0
		&& invocations.unexpectedActivityCount === 0
		&& invocations.unsettledInvokeStartedCount === 0
		&& summary.prepareStartedCount === 1
		&& summary.preparedCount === 1
		&& summary.prepareFailedCount === 0
		&& summary.invokeStartedCount === 1
		&& summary.invokeCompletedCount === 1
		&& summary.compactStatus === 0
		&& summary.taskIdPresent;
}

export function assertFinalPeerResourceMetrics(value: unknown): asserts value is FinalPeerResourceMetrics {
	if (
		!isRecord(value)
		|| !isRecord(value.listener)
		|| !isNonNegativeInteger(value.listener.startAttempts)
		|| !isRecord(value.tunnel)
		|| !isNonNegativeInteger(value.tunnel.loadAttempts)
		|| !isNonNegativeInteger(value.tunnel.probeAttempts)
		|| !isNonNegativeInteger(value.tunnel.ensureHostedAttempts)
		|| !isRecord(value.toolTimers)
		|| !isNonNegativeInteger(value.toolTimers.timersCreated)
		|| !isNonNegativeInteger(value.toolTimers.timersDisposed)
		|| !isNonNegativeInteger(value.toolTimers.activeTimers)
		|| !isNonNegativeInteger(value.toolTimers.budgetTimersCreated)
		|| !isNonNegativeInteger(value.toolTimers.armedBudgetTimers)
	) {
		throw new TypeError('The final peer resource metrics were malformed.');
	}
	if (value.toolTimers.activeTimers !== 0 || value.toolTimers.armedBudgetTimers !== 0) {
		throw new Error('The final peer resource metrics contain live Tool timers.');
	}
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

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function countOpenPreparations(
	observations: readonly SequencedManualToolObservation[],
): number {
	const finished = new Set(observations
		.filter(({ phase }) => phase === 'prepared' || phase === 'prepareFailed')
		.map(({ preparationSequence }) => preparationSequence)
		.filter(isPositiveInteger));
	return observations.filter(
		({ phase, preparationSequence }) =>
			phase === 'prepareStarted'
			&& (
				!isPositiveInteger(preparationSequence)
				|| !finished.has(preparationSequence)
			),
	).length;
}
