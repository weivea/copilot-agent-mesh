export const manualPostDetachObservationTimeoutMs = 5 * 60_000;
const manualPostDetachObservationPollMs = 250;

export interface ManualPostDetachAttestation {
	readonly confirmationAcceptedOnce: boolean;
	readonly targetSessionState: 'retained-done' | 'retained-working' | 'absent';
}

export function canRequestManualPostDetachObservation(
	manualUi: boolean,
	sessionArchivedObserved: boolean,
	clientDetachedObserved: boolean,
	catalogProbeCompleted: boolean,
): boolean {
	return manualUi
		&& sessionArchivedObserved
		&& clientDetachedObserved
		&& catalogProbeCompleted;
}

export function parseManualPostDetachAttestation(
	value: unknown,
	expectedRunId: string,
	expectedChallenge: string,
): ManualPostDetachAttestation | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (
		value.schemaVersion !== 3
		|| value.runId !== expectedRunId
		|| value.postDetachChallenge !== expectedChallenge
		|| typeof value.confirmationAcceptedOnce !== 'boolean'
		|| (
			value.targetSessionState !== 'retained-done'
			&& value.targetSessionState !== 'retained-working'
			&& value.targetSessionState !== 'absent'
		)
	) {
		return undefined;
	}
	return {
		confirmationAcceptedOnce: value.confirmationAcceptedOnce,
		targetSessionState: value.targetSessionState,
	};
}

export async function waitForManualPostDetachAttestation(options: {
	readonly runId: string;
	readonly challenge: string;
	readonly read: () => Promise<unknown | undefined>;
	readonly delay: (milliseconds: number) => Promise<void>;
	readonly now?: () => number;
	readonly timeoutMs?: number;
}): Promise<ManualPostDetachAttestation | undefined> {
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? manualPostDetachObservationTimeoutMs;
	const deadline = now() + timeoutMs;
	while (now() < deadline) {
		const value = await options.read();
		const attestation = parseManualPostDetachAttestation(
			value,
			options.runId,
			options.challenge,
		);
		if (attestation !== undefined) {
			return attestation;
		}
		await options.delay(manualPostDetachObservationPollMs);
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
