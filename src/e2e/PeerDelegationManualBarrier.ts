import {
	classifyFrozenManualDecision,
	isSuccessfulManualInvocation,
	type PostPromptManualInvocations,
} from './PeerDelegationManualMonitor';

export interface ManualBarrierSnapshot<Observation> {
	readonly complete: boolean;
	readonly observations: readonly Observation[];
	readonly postPrompt: PostPromptManualInvocations;
}

export type ManualBarrierResolution<Observation> =
	| {
		readonly kind: 'pre-invocation-failure';
		readonly snapshot: ManualBarrierSnapshot<Observation>;
	}
	| {
		readonly kind: 'observation-history-incomplete';
		readonly snapshot: ManualBarrierSnapshot<Observation>;
		readonly taskLeaseReleased: boolean;
	}
	| {
		readonly kind: 'unexpected-invocation';
		readonly snapshot: ManualBarrierSnapshot<Observation>;
		readonly taskLeaseReleased: boolean;
	}
	| {
		readonly kind: 'successful-invocation';
		readonly snapshot: ManualBarrierSnapshot<Observation>;
	}
	| {
		readonly kind: 'failed-invocation';
		readonly snapshot: ManualBarrierSnapshot<Observation>;
		readonly taskLeaseReleased: boolean;
	}
	| {
		readonly kind: 'outcome-observation-failed';
		readonly snapshot: ManualBarrierSnapshot<Observation>;
		readonly taskLeaseReleased: boolean;
	};

export async function resolveManualTerminalBarrier<Observation>(
	freeze: () => Promise<ManualBarrierSnapshot<Observation>>,
	waitForOutcome: (
		frozen: ManualBarrierSnapshot<Observation>,
	) => Promise<ManualBarrierSnapshot<Observation>>,
	settle: (snapshot: ManualBarrierSnapshot<Observation>) => Promise<boolean>,
): Promise<ManualBarrierResolution<Observation>> {
	const frozen = await freeze();
	const decision = classifyFrozenManualDecision(frozen.postPrompt, frozen.complete);
	if (decision === 'pre-invocation-failure') {
		return { kind: decision, snapshot: frozen };
	}
	if (decision === 'observation-history-incomplete') {
		return {
			kind: decision,
			snapshot: frozen,
			taskLeaseReleased: await settle(frozen),
		};
	}

	let resolved: ManualBarrierSnapshot<Observation>;
	try {
		resolved = await waitForOutcome(frozen);
	} catch {
		return {
			kind: 'outcome-observation-failed',
			snapshot: frozen,
			taskLeaseReleased: await settle(frozen),
		};
	}
	if (!resolved.complete) {
		return {
			kind: 'observation-history-incomplete',
			snapshot: resolved,
			taskLeaseReleased: await settle(resolved),
		};
	}
	if (resolved.postPrompt.unexpectedActivityCount > 0) {
		return {
			kind: 'unexpected-invocation',
			snapshot: resolved,
			taskLeaseReleased: await settle(resolved),
		};
	}
	if (isSuccessfulManualInvocation(resolved.postPrompt, true)) {
		return { kind: 'successful-invocation', snapshot: resolved };
	}
	return {
		kind: 'failed-invocation',
		snapshot: resolved,
		taskLeaseReleased: await settle(resolved),
	};
}
