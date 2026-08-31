export interface PeerDelegationCleanupPhase {
	readonly name: string;
	run(): Promise<void>;
}

export interface PeerDelegationCleanupFailure {
	readonly phase: string;
	readonly error: unknown;
}

export async function runPeerDelegationCleanupPhases(
	phases: readonly PeerDelegationCleanupPhase[],
): Promise<readonly PeerDelegationCleanupFailure[]> {
	const failures: PeerDelegationCleanupFailure[] = [];
	for (const phase of phases) {
		try {
			await phase.run();
		} catch (error: unknown) {
			failures.push({ phase: phase.name, error });
		}
	}
	return failures;
}
