import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';

import {
	assertPassingPeerDelegationEvidence,
	normalizePeerDelegationEvidenceTerminalState,
	parsePeerDelegationEvidence,
	type PeerDelegationEvidence,
} from '../e2e/PeerDelegationEvidence';
import {
	PeerDelegationE2eRecorder,
	PeerDelegationE2eToolClock,
	projectPeerTaskEvents,
} from '../e2e/PeerDelegationE2eRecorder';
import {
	EditorCatalogProbeError,
	classifyEditorCatalogError,
} from '../composition/PeerDelegationE2eApi';
import {
	canRequestManualPostDetachObservation,
	manualPostDetachObservationTimeoutMs,
	parseManualPostDetachAttestation,
	waitForManualPostDetachAttestation,
} from '../e2e/PeerDelegationManualEvidence';
import {
	resolveManualTerminalBarrier,
} from '../e2e/PeerDelegationManualBarrier';
import {
	allManualStartsHaveTaskEvidence,
	assertFinalPeerResourceMetrics,
	assessExactTargetLiveness,
	classifyFrozenManualDecision,
	classifyTargetControllerRejection,
	isSuccessfulManualInvocation,
	latestManualObservationSequence,
	manualSettlementTaskIds,
	summarizeManualInvocation,
	summarizePostPromptDelegations,
} from '../e2e/PeerDelegationManualMonitor';

const runId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const inputId = '00000000-0000-4000-8000-000000000003';
const delegationRequestId = '00000000-0000-4000-8000-000000000004';
const postDetachChallenge = '00000000-0000-4000-8000-000000000005';
const invocationId = '00000000-0000-4000-8000-000000000006';
const secondInvocationId = '00000000-0000-4000-8000-000000000007';

function resourceMetrics(
	toolTimers: { readonly activeTimers: number; readonly armedBudgetTimers: number },
) {
	return {
		listener: { startAttempts: 0 },
		tunnel: {
			loadAttempts: 0,
			probeAttempts: 0,
			ensureHostedAttempts: 0,
		},
		toolTimers: {
			timersCreated: toolTimers.activeTimers,
			timersDisposed: 0,
			activeTimers: toolTimers.activeTimers,
			budgetTimersCreated: 0,
			armedBudgetTimers: toolTimers.armedBudgetTimers,
		},
	};
}

test('manual UI evidence accepts only the challenge issued after objective detach and catalog probe', () => {
	const attestation = {
		schemaVersion: 3,
		runId,
		postDetachChallenge,
		confirmationAcceptedOnce: true,
		targetSessionState: 'retained-done',
	};
	assert.equal(canRequestManualPostDetachObservation(true, false, true, true), false);
	assert.equal(canRequestManualPostDetachObservation(true, true, false, true), false);
	assert.equal(canRequestManualPostDetachObservation(true, true, true, false), false);
	assert.equal(canRequestManualPostDetachObservation(false, true, true, true), false);
	assert.equal(
		parseManualPostDetachAttestation(
			attestation,
			runId,
			'00000000-0000-4000-8000-000000000006',
		),
		undefined,
		'An attestation made before the post-detach challenge cannot pass.',
	);
	assert.equal(canRequestManualPostDetachObservation(true, true, true, true), true);
	assert.deepEqual(
		parseManualPostDetachAttestation(attestation, runId, postDetachChallenge),
		{ confirmationAcceptedOnce: true, targetSessionState: 'retained-done' },
	);
	assert.equal(manualPostDetachObservationTimeoutMs, 5 * 60_000);
});

test('manual UI evidence remains unverified without objective detach', () => {
	assert.equal(canRequestManualPostDetachObservation(true, true, false, true), false);
	assert.equal(
		parseManualPostDetachAttestation({
			schemaVersion: 3,
			runId,
			postDetachChallenge,
			confirmationAcceptedOnce: true,
			targetSessionState: 'unobserved',
		}, runId, postDetachChallenge),
		undefined,
	);
});

test('manual post-detach observation polling is bounded and accepts a later exact challenge', async () => {
	let now = 1_000;
	let reads = 0;
	const timedOut = await waitForManualPostDetachAttestation({
		runId,
		challenge: postDetachChallenge,
		read: async () => {
			reads += 1;
			return undefined;
		},
		delay: async (milliseconds) => {
			now += milliseconds;
		},
		now: () => now,
		timeoutMs: 500,
	});
	assert.equal(timedOut, undefined);
	assert.equal(reads, 2);

	reads = 0;
	now = 2_000;
	const observed = await waitForManualPostDetachAttestation({
		runId,
		challenge: postDetachChallenge,
		read: async () => {
			reads += 1;
			return reads === 2
				? {
					schemaVersion: 3,
					runId,
					postDetachChallenge,
					confirmationAcceptedOnce: true,
					targetSessionState: 'retained-working',
				}
				: undefined;
		},
		delay: async (milliseconds) => {
			now += milliseconds;
		},
		now: () => now,
		timeoutMs: 1_000,
	});
	assert.deepEqual(observed, {
		confirmationAcceptedOnce: true,
		targetSessionState: 'retained-working',
	});
	assert.equal(reads, 2);
});

test('editor catalog diagnostics classify tagged protocol and timeout failures', () => {
	assert.equal(
		classifyEditorCatalogError(new EditorCatalogProbeError('protocol', 'synthetic protocol failure')),
		'protocol',
	);
	assert.equal(
		classifyEditorCatalogError(new EditorCatalogProbeError('timeout', 'synthetic timeout failure')),
		'timeout',
	);
});

test('peer-delegation evidence rejects unsafe persistent content', () => {
	const base = unverifiedEvidence();
	assert.doesNotThrow(() => parsePeerDelegationEvidence(base));
	assert.doesNotThrow(() => parsePeerDelegationEvidence({
		...base,
		outcome: 'fail',
		failure: {
			code: 'TARGET_WINDOW_CLOSED',
			message: 'The exact target window controller closed before Tool invocation.',
			manualInvocation: {
				phase: 'target-liveness',
				preparedCount: 0,
				prepareStartedCount: 0,
				prepareFailedCount: 0,
				invokeStartedCount: 0,
				invokeCompletedCount: 0,
				unexpectedInvocationCount: 0,
				unexpectedActivityCount: 0,
				unresolvedPreparationCount: 0,
				taskIdPresent: false,
			},
		},
	}));
	assert.throws(
		() => parsePeerDelegationEvidence({
			...base,
			failure: { code: 'E2E_FAILED', message: '/Users/example/private-project' },
		}),
		/unsafe content/u,
	);
	assert.throws(
		() => parsePeerDelegationEvidence({
			...base,
			failure: {
				code: 'E2E_FAILED',
				message: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			},
		}),
		/unsafe content/u,
	);
	assert.throws(
		() => parsePeerDelegationEvidence({
			...base,
			connectionToken: 'not-allowed',
		}),
		/forbidden field/u,
	);
});

test('peer-delegation evidence requires resolvable AC-5 references and honest outcome', () => {
	const base = unverifiedEvidence();
	assert.throws(
		() => parsePeerDelegationEvidence({
			...base,
			ac5: base.ac5.map((item) => item.item === 1
				? { ...item, status: 'pass', evidenceRefs: ['#/missing/value'] }
				: item),
		}),
		/Evidence reference does not resolve/u,
	);
	assert.throws(
		() => parsePeerDelegationEvidence({ ...base, outcome: 'pass' }),
		/Outcome must be unverified/u,
	);
});

test('peer evidence maps every active task state to not-observed', () => {
	for (const status of [
		'accepted',
		'startingAgent',
		'running',
		'needsInput',
		'recovering',
		'cancelling',
	]) {
		assert.equal(
			normalizePeerDelegationEvidenceTerminalState(status),
			'not-observed',
			status,
		);
		const evidence = unverifiedEvidence();
		evidence.needsInput.terminalState =
			normalizePeerDelegationEvidenceTerminalState(status);
		evidence.timeout.terminalState =
			normalizePeerDelegationEvidenceTerminalState(status);
		assert.doesNotThrow(() => parsePeerDelegationEvidence(evidence), status);
	}
	for (const status of ['completed', 'failed', 'cancelled', 'timedOut']) {
		assert.equal(
			normalizePeerDelegationEvidenceTerminalState(status),
			status,
		);
	}
	assert.equal(normalizePeerDelegationEvidenceTerminalState('not-found'), 'not-observed');
	assert.equal(normalizePeerDelegationEvidenceTerminalState(undefined), 'not-observed');
});

test('peer-delegation passing evidence requires all real AC-5 conditions', () => {
	const evidence = passingEvidence();
	assert.equal(assertPassingPeerDelegationEvidence(evidence).outcome, 'pass');
	assert.equal(assertPassingPeerDelegationEvidence({
		...evidence,
		cancellation: {
			...evidence.cancellation,
			eventTypes: ['agentStarted', 'cancelRequested', 'cancelConfirmed'],
		},
	}).outcome, 'pass');
	assert.equal(assertPassingPeerDelegationEvidence({
		...evidence,
		completion: {
			...evidence.completion,
			eventSequences: [1, 100, 300],
			eventJournalTruncated: true,
		},
	}).outcome, 'pass');
	assert.throws(
		() => parsePeerDelegationEvidence({
			...evidence,
			completion: {
				...evidence.completion,
				eventSequences: [2, 3, 4],
			},
		}),
		/complete real editor Tool-to-Agent route/u,
	);
	assert.throws(
		() => parsePeerDelegationEvidence({
			...evidence,
			confirmation: {
				...evidence.confirmation,
				source: 'programmatic',
			},
		}),
		/requires one observed Copilot UI/u,
	);
	assert.throws(
		() => parsePeerDelegationEvidence({
			...evidence,
			completion: {
				...evidence.completion,
				source: 'standalone',
				degraded: true,
			},
		}),
		/complete real editor Tool-to-Agent route/u,
	);
	assert.throws(
		() => parsePeerDelegationEvidence({
			...evidence,
			sessionVisibility: {
				...evidence.sessionVisibility,
				hostSessionEchoObserved: false,
			},
		}),
		/editor Tool-to-Agent route|AC-5 item 9 must match/u,
	);
	assert.throws(
		() => parsePeerDelegationEvidence({
			...evidence,
			sessionVisibility: {
				...evidence.sessionVisibility,
				recoverySessionHash: '1111111111111111',
			},
		}),
		/recoverySessionHash|unrecognized/iu,
	);
	const {
		hostSessionHash: _hostSessionHash,
		editorEndpointFingerprint: _editorEndpointFingerprint,
		...sessionWithoutHostEcho
	} = evidence.sessionVisibility;
	assert.doesNotThrow(() => parsePeerDelegationEvidence({
		...evidence,
		outcome: 'unverified',
		sessionVisibility: {
			...sessionWithoutHostEcho,
			hostSessionEchoObserved: false,
			catalogSessionHashMatched: false,
		},
		ac5: evidence.ac5.map((item) => item.item === 9
			? { ...item, status: 'unverified' as const, evidenceRefs: [] }
			: item),
	}));
	assert.throws(
		() => parsePeerDelegationEvidence({
			...evidence,
			sessionVisibility: {
				...evidence.sessionVisibility,
				status: 'pass',
				sessionArchivedObserved: true,
				clientDetachedObserved: true,
				catalogAfterTerminalCleanup: false,
				uiObserved: true,
				uiObservation: 'retained-done',
			},
			experiments: evidence.experiments.map((experiment) => experiment.id === 'O1'
				? { ...experiment, status: 'pass' as const, conclusion: 'editor-session-retained-done' as const }
				: experiment),
		}),
		/Passing O1 evidence requires editor catalog and objective UI observation/u,
	);
	assert.throws(
		() => parsePeerDelegationEvidence({
			...evidence,
			cleanup: {
				...evidence.cleanup,
				status: 'unverified',
			},
		}),
		/AC-5 item 11 must match/u,
	);
	assert.throws(
		() => parsePeerDelegationEvidence({
			...evidence,
			resources: {
				...evidence.resources,
				timer: {
					...evidence.resources.timer,
					finalOwned: 1,
				},
			},
		}),
		/Outcome must be fail|every harness-owned resource/u,
	);
	assert.throws(
		() => parsePeerDelegationEvidence({
			...evidence,
			cleanupFailures: [{
				phase: 'process-table',
				code: 'PEER_E2E_FAILED',
				message: 'Process observation failed.',
			}],
		}),
		/Outcome must be fail|require failed cleanup status/u,
	);
});

test('peer-delegation recorder stores identities and hashes without prompt or output text', () => {
	const recorder = new PeerDelegationE2eRecorder();
	recorder.observe({
		toolName: 'mesh_delegate_task',
		phase: 'invokeCompleted',
		invocationSequence: 7,
		invocationId,
		input: {
			delegationRequestId,
			prompt: 'do not persist this prompt',
		},
		result: {
			s: 0,
			t: taskId,
			d: delegationRequestId,
			r: 'do not persist this output',
		},
	});

	recorder.observeLifecycle({
		taskId,
		eventType: 'session/hostObserved',
		sessionUri: 'session:do-not-persist-this-identifier',
		source: 'editor',
		endpointFingerprint: '0123456789abcdef',
	});
	recorder.observeLifecycle({ taskId, eventType: 'chat/turnComplete' });
	recorder.observeLifecycle({ taskId, eventType: 'session/clientDetached' });
	const snapshot = recorder.snapshot();
	assert.equal(snapshot.tools.length, 1);
	assert.equal(snapshot.tools[0]?.taskId, taskId);
	assert.equal(snapshot.tools[0]?.delegationRequestId, delegationRequestId);
	assert.equal(snapshot.tools[0]?.compactStatus, 0);
	assert.equal(snapshot.tools[0]?.invocationSequence, 7);
	assert.deepEqual(snapshot.tools[0]?.resultFields, ['d', 'r', 's', 't']);
	assert.match(snapshot.tools[0]?.resultHash ?? '', /^[a-f0-9]{64}$/u);
	assert.equal(JSON.stringify(snapshot).includes('do not persist'), false);
	assert.deepEqual(snapshot.ahp, [
		{
			sequence: 2,
			at: snapshot.ahp[0]?.at,
			taskId,
			eventType: 'session/hostObserved',
			source: 'editor',
			sessionHash: snapshot.ahp[0]?.sessionHash,
			endpointFingerprint: '0123456789abcdef',
		},
		{
			sequence: 3,
			at: snapshot.ahp[1]?.at,
			taskId,
			eventType: 'chat/turnComplete',
		},
		{
			sequence: 4,
			at: snapshot.ahp[2]?.at,
			taskId,
			eventType: 'session/clientDetached',
		},
	]);
	assert.match(snapshot.ahp[0]?.sessionHash ?? '', /^[a-f0-9]{16}$/u);
	assert.equal(JSON.stringify(snapshot).includes('do-not-persist-this-identifier'), false);
});

test('peer-delegation recorder freezes new delegate ingress for final evidence', () => {
	const recorder = new PeerDelegationE2eRecorder();
	assert.doesNotThrow(() => recorder.assertDelegateInvocationAllowed());
	recorder.freezeDelegateInvocations();
	assert.throws(
		() => recorder.assertDelegateInvocationAllowed(),
		/invocation ingress is closed/u,
	);
});

test('manual monitor preserves a safe preparation failure without task identifiers', () => {
	const recorder = new PeerDelegationE2eRecorder();
	recorder.observe({
		toolName: 'mesh_delegate_task',
		phase: 'prepareFailed',
		input: {
			delegationRequestId,
			nodeId: 'do-not-persist-node-id',
			prompt: 'do not persist this prompt',
		},
		errorCode: 'PEER_OFFLINE',
	});

	const observation = recorder.snapshot().tools[0];
	assert.equal(observation?.phase, 'prepareFailed');
	assert.equal(observation?.errorCode, 'PEER_OFFLINE');
	assert.equal(observation?.taskId, undefined);
	assert.equal(JSON.stringify(observation).includes('do-not-persist'), false);
	assert.deepEqual(summarizeManualInvocation([{
		phase: observation!.phase,
		errorCode: observation!.errorCode,
		taskIdPresent: observation!.taskId !== undefined,
	}]), {
		preparedCount: 0,
		prepareStartedCount: 0,
		prepareFailedCount: 1,
		invokeStartedCount: 0,
		invokeCompletedCount: 0,
		unexpectedInvocationCount: 0,
		unexpectedActivityCount: 0,
		unresolvedPreparationCount: 0,
		errorCode: 'PEER_OFFLINE',
		taskIdPresent: false,
	});
});

test('manual monitor rechecks source sequence and awaits a started invocation after controller timeout', () => {
	const expectedRequestId = 'expected-request';
	const observations = [{
		sequence: 8,
		toolName: 'mesh_delegate_task',
		phase: 'invokeStarted' as const,
		delegationRequestId: expectedRequestId,
		taskIdPresent: false,
	}];
	assert.equal(latestManualObservationSequence(observations), 8);
	const invocations = summarizePostPromptDelegations(observations, 7, expectedRequestId);
	assert.equal(
		classifyTargetControllerRejection(invocations, true, false),
		'await-authoritative-outcome',
		'A controller failure cannot rewrite an already-started invocation as a window-close failure.',
	);
});

test('manual monitor linearizes a target-close decision at the frozen invocation snapshot', () => {
	const expectedRequestId = 'expected-request';
	const beforeFreeze = summarizePostPromptDelegations([], 7, expectedRequestId);
	assert.equal(
		classifyTargetControllerRejection(beforeFreeze, true, false),
		'target-window-closed',
		'The final liveness recheck can legitimately precede an accepted invocation.',
	);

	const crossingObservations = [
		{
			sequence: 8,
			toolName: 'mesh_delegate_task',
			phase: 'prepareStarted' as const,
			delegationRequestId: expectedRequestId,
			preparationSequence: 1,
			taskIdPresent: false,
		},
		{
			sequence: 9,
			toolName: 'mesh_delegate_task',
			phase: 'prepared' as const,
			delegationRequestId: expectedRequestId,
			preparationSequence: 1,
			taskIdPresent: false,
		},
		{
			sequence: 10,
			toolName: 'mesh_delegate_task',
			phase: 'invokeStarted' as const,
			delegationRequestId: expectedRequestId,
			invocationSequence: 1,
			invocationId,
			taskIdPresent: false,
		},
	];
	const afterFreeze = summarizePostPromptDelegations(
		crossingObservations,
		7,
		expectedRequestId,
	);
	assert.equal(
		classifyFrozenManualDecision(afterFreeze, true),
		'authoritative-outcome',
		'An invocation accepted before freeze processing must supersede the stale close decision.',
	);
	assert.equal(
		classifyFrozenManualDecision(afterFreeze, false),
		'authoritative-outcome',
		'Even incomplete history must not bypass settlement of an observed start.',
	);
	const afterAuthoritativeOutcome = summarizePostPromptDelegations([
		...crossingObservations,
		{
			sequence: 11,
			toolName: 'mesh_delegate_task',
			phase: 'invokeCompleted',
			delegationRequestId: expectedRequestId,
			invocationSequence: 1,
			invocationId,
			compactStatus: 0,
			taskIdPresent: true,
		},
	], 7, expectedRequestId);
	assert.equal(
		isSuccessfulManualInvocation(afterAuthoritativeOutcome, true),
		true,
		'The barrier-crossing invocation remains eligible only after its authoritative outcome.',
	);
});

test('manual monitor reports a true pre-invocation close only from a complete frozen snapshot', () => {
	const frozen = summarizePostPromptDelegations([], 7, 'expected-request');
	assert.equal(
		classifyFrozenManualDecision(frozen, true),
		'pre-invocation-failure',
	);
	assert.equal(
		classifyFrozenManualDecision(frozen, false),
		'observation-history-incomplete',
	);
});

test('manual barrier reports a true no-start closure without outcome or settlement work', async () => {
	const observations: never[] = [];
	const snapshot = {
		complete: true,
		observations,
		postPrompt: summarizePostPromptDelegations(observations, 7, 'expected-request'),
	};
	let outcomeWaited = false;
	let settlementAttempted = false;
	const resolution = await resolveManualTerminalBarrier(
		async () => snapshot,
		async () => {
			outcomeWaited = true;
			return snapshot;
		},
		async () => {
			settlementAttempted = true;
			return true;
		},
	);

	assert.equal(resolution.kind, 'pre-invocation-failure');
	assert.equal(outcomeWaited, false);
	assert.equal(settlementAttempted, false);
});

test('manual barrier resolves an invocation accepted while freeze processing is delayed', async () => {
	const task = '00000000-0000-4000-8000-000000000099';
	const recorder = new PeerDelegationE2eRecorder();
	const monitorSnapshot = () => {
		const observations = recorder.snapshot().delegateInvocations.map((observation) => ({
			...observation,
			taskIdPresent: observation.taskId !== undefined,
		}));
		return {
			complete: true,
			observations,
			postPrompt: summarizePostPromptDelegations(observations, 0, delegationRequestId),
		};
	};
	const preFreeze = summarizePostPromptDelegations([], 0, delegationRequestId);
	assert.equal(
		classifyTargetControllerRejection(preFreeze, true, false),
		'target-window-closed',
	);
	let releaseFreeze!: () => void;
	const freezeBarrier = new Promise<void>((resolveFreeze) => {
		releaseFreeze = resolveFreeze;
	});
	const taskEvidence = { state: 'waitingInput', leaseReleased: false };
	const resolutionPromise = resolveManualTerminalBarrier(
		async () => {
			await freezeBarrier;
			recorder.freezeDelegateInvocations();
			return monitorSnapshot();
		},
		async (frozen) => {
			assert.equal(frozen.postPrompt.allInvokeStartedCount, 1);
			recorder.observe({
				toolName: 'mesh_delegate_task',
				phase: 'taskAvailable',
				input: { delegationRequestId },
				result: { d: delegationRequestId, t: task },
				invocationSequence: 1,
				invocationId,
			});
			recorder.observe({
				toolName: 'mesh_delegate_task',
				phase: 'invokeCompleted',
				input: { delegationRequestId },
				result: { d: delegationRequestId, t: task, s: 1 },
				invocationSequence: 1,
				invocationId,
			});
			return monitorSnapshot();
		},
		async (snapshot) => {
			assert.deepEqual(manualSettlementTaskIds(snapshot.postPrompt), [task]);
			taskEvidence.state = 'cancelled';
			taskEvidence.leaseReleased = true;
			return taskEvidence.state === 'cancelled' && taskEvidence.leaseReleased;
		},
	);

	recorder.observe({
		toolName: 'mesh_delegate_task',
		phase: 'invokeStarted',
		input: { delegationRequestId },
		invocationSequence: 1,
		invocationId,
	});
	releaseFreeze();
	const resolution = await resolutionPromise;
	assert.throws(
		() => recorder.assertDelegateInvocationAllowed(),
		/invocation ingress is closed/u,
	);
	assert.equal(resolution.kind, 'failed-invocation');
	assert.equal(resolution.taskLeaseReleased, true);
	assert.deepEqual(taskEvidence, { state: 'cancelled', leaseReleased: true });
	assert.equal(resolution.snapshot.postPrompt.expected.compactStatus, 1);
});

test('manual barrier settles the frozen task when authoritative outcome observation fails', async () => {
	const observations = [
		{
			sequence: 1,
			toolName: 'mesh_delegate_task',
			phase: 'invokeStarted' as const,
			delegationRequestId,
			invocationId,
			taskIdPresent: false,
		},
		{
			sequence: 2,
			toolName: 'mesh_delegate_task',
			phase: 'taskAvailable' as const,
			delegationRequestId,
			invocationId,
			taskId,
			taskIdPresent: true,
		},
	];
	const snapshot = {
		complete: true,
		observations,
		postPrompt: summarizePostPromptDelegations(observations, 0, delegationRequestId),
	};
	let settlementAttempted = false;
	const resolution = await resolveManualTerminalBarrier(
		async () => snapshot,
		async () => {
			throw new Error('controller unavailable');
		},
		async (frozen) => {
			settlementAttempted = true;
			assert.deepEqual(manualSettlementTaskIds(frozen.postPrompt), [taskId]);
			return true;
		},
	);

	assert.equal(resolution.kind, 'outcome-observation-failed');
	assert.equal(resolution.taskLeaseReleased, true);
	assert.equal(settlementAttempted, true);
});

test('manual barrier settles a retained needs-input completion after its start was evicted', async () => {
	const task = '00000000-0000-4000-8000-000000000098';
	const retained = [{
		sequence: 513,
		toolName: 'mesh_delegate_task',
		phase: 'invokeCompleted' as const,
		delegationRequestId: 'expected-request',
		invocationSequence: 1,
		invocationId,
		taskId: task,
		taskIdPresent: true,
		compactStatus: 1,
	}];
	const postPrompt = summarizePostPromptDelegations(retained, 7, 'expected-request');
	assert.equal(postPrompt.allInvokeStartedCount, 0);
	assert.deepEqual(manualSettlementTaskIds(postPrompt), [task]);
	assert.equal(allManualStartsHaveTaskEvidence(postPrompt), true);
	const taskEvidence = { state: 'waitingInput', leaseReleased: false };
	let settledTaskIds: readonly string[] = [];
	const resolution = await resolveManualTerminalBarrier(
		async () => ({ complete: false, observations: retained, postPrompt }),
		async () => assert.fail('Incomplete frozen history must fail closed before outcome waiting.'),
		async (snapshot) => {
			settledTaskIds = manualSettlementTaskIds(snapshot.postPrompt);
			taskEvidence.state = 'cancelled';
			taskEvidence.leaseReleased = true;
			return taskEvidence.state === 'cancelled' && taskEvidence.leaseReleased;
		},
	);
	assert.equal(resolution.kind, 'observation-history-incomplete');
	assert.equal(resolution.taskLeaseReleased, true);
	assert.deepEqual(settledTaskIds, [task]);
	assert.deepEqual(taskEvidence, { state: 'cancelled', leaseReleased: true });
});

for (const compactStatus of [1, 2, 3] as const) {
	test(`manual barrier settles an expected compact status ${compactStatus} task before failure`, async () => {
		const task = `00000000-0000-4000-8000-00000000009${compactStatus}`;
		const observations = [
			{
				sequence: 8,
				toolName: 'mesh_delegate_task',
				phase: 'invokeStarted' as const,
				delegationRequestId: 'expected-request',
				invocationSequence: 1,
				invocationId,
				taskIdPresent: false,
			},
			{
				sequence: 9,
				toolName: 'mesh_delegate_task',
				phase: 'taskAvailable' as const,
				delegationRequestId: 'expected-request',
				invocationSequence: 1,
				invocationId,
				taskId: task,
				taskIdPresent: true,
			},
			{
				sequence: 10,
				toolName: 'mesh_delegate_task',
				phase: 'invokeCompleted' as const,
				delegationRequestId: 'expected-request',
				invocationSequence: 1,
				invocationId,
				taskId: task,
				taskIdPresent: true,
				compactStatus,
			},
		];
		const snapshot = {
			complete: true,
			observations,
			postPrompt: summarizePostPromptDelegations(observations, 7, 'expected-request'),
		};
		let leaseVerified = false;
		const resolution = await resolveManualTerminalBarrier(
			async () => snapshot,
			async () => snapshot,
			async (settled) => {
				assert.deepEqual(manualSettlementTaskIds(settled.postPrompt), [task]);
				leaseVerified = true;
				return true;
			},
		);
		assert.equal(resolution.kind, 'failed-invocation');
		assert.equal(resolution.taskLeaseReleased, true);
		assert.equal(leaseVerified, true);
		assert.equal(resolution.snapshot.postPrompt.expected.compactStatus, compactStatus);
	});
}

test('recorder retains only safe task identity at the task-available milestone', () => {
	const recorder = new PeerDelegationE2eRecorder();
	recorder.observe({
		toolName: 'mesh_delegate_task',
		phase: 'taskAvailable',
		input: {
			delegationRequestId,
			prompt: 'do not persist this prompt',
		},
		result: {
			d: delegationRequestId,
			t: taskId,
		},
		invocationSequence: 1,
		invocationId,
	});
	assert.deepEqual(recorder.snapshot().tools.map((observation) => ({
		phase: observation.phase,
		delegationRequestId: observation.delegationRequestId,
		taskId: observation.taskId,
		invocationSequence: observation.invocationSequence,
		invocationId: observation.invocationId,
	})), [{
		phase: 'taskAvailable',
		delegationRequestId,
		taskId,
		invocationSequence: 1,
		invocationId,
	}]);
	assert.equal(JSON.stringify(recorder.snapshot()).includes('do not persist'), false);
});

test('recorder retains task-available evidence when bounded history evicts its start', () => {
	const recorder = new PeerDelegationE2eRecorder();
	recorder.observe({
		toolName: 'mesh_delegate_task',
		phase: 'invokeStarted',
		input: { delegationRequestId },
		invocationSequence: 1,
		invocationId,
	});
	recorder.observe({
		toolName: 'mesh_delegate_task',
		phase: 'taskAvailable',
		input: { delegationRequestId },
		result: { d: delegationRequestId, t: taskId },
		invocationSequence: 1,
		invocationId,
	});
	for (let index = 0; index < 512; index += 1) {
		recorder.observe({
			toolName: 'mesh_list_workers',
			phase: 'invokeCompleted',
			input: {},
			result: {},
		});
	}
	const snapshot = recorder.snapshot();
	assert.equal(snapshot.truncated, true);
	assert.equal(snapshot.tools.some(({ phase }) => phase === 'invokeStarted'), false);
	assert.deepEqual(snapshot.delegateInvocations.filter(({ phase }) => phase === 'taskAvailable'), [{
		sequence: 2,
		at: snapshot.delegateInvocations.find(({ phase }) => phase === 'taskAvailable')!.at,
		toolName: 'mesh_delegate_task',
		phase: 'taskAvailable',
		delegationRequestId,
		taskId,
		invocationSequence: 1,
		invocationId,
		resultFields: ['d', 't'],
		resultBytes: JSON.stringify({ d: delegationRequestId, t: taskId }).length,
		resultHash: snapshot.delegateInvocations.find(({ phase }) => phase === 'taskAvailable')!.resultHash,
	}]);
});

test('general history truncation remains explicit when a pending preparation is evicted', () => {
	const recorder = new PeerDelegationE2eRecorder();
	recorder.observe({
		toolName: 'mesh_delegate_task',
		phase: 'prepareStarted',
		input: { delegationRequestId },
		preparationSequence: 1,
	});
	for (let index = 0; index < 512; index += 1) {
		recorder.observe({
			toolName: 'mesh_list_workers',
			phase: 'invokeCompleted',
			input: {},
			result: {},
		});
	}

	const snapshot = recorder.snapshot();
	assert.equal(snapshot.truncated, true);
	assert.equal(snapshot.delegateInvocationsTruncated, false);
	assert.equal(snapshot.tools.some(({ phase }) => phase === 'prepareStarted'), false);
});

test('recorder fails closed when bounded task-identity retention overflows', () => {
	const recorder = new PeerDelegationE2eRecorder();
	for (let index = 1; index <= 513; index += 1) {
		const suffix = index.toString(16).padStart(12, '0');
		recorder.observe({
			toolName: 'mesh_delegate_task',
			phase: 'taskAvailable',
			input: { delegationRequestId },
			result: {
				d: delegationRequestId,
				t: `00000000-0000-4000-8000-${suffix}`,
			},
			invocationSequence: index,
			invocationId: `10000000-0000-4000-8000-${suffix}`,
		});
	}
	const snapshot = recorder.snapshot();
	assert.equal(snapshot.tools.length, 512);
	assert.equal(snapshot.truncated, true);
	assert.equal(snapshot.delegateInvocationsTruncated, true);
});

test('manual monitor accounts for missing and wrong post-prompt correlation IDs', () => {
	const invocations = summarizePostPromptDelegations([
		{
			sequence: 3,
			toolName: 'mesh_delegate_task',
			phase: 'invokeStarted',
			taskIdPresent: false,
		},
		{
			sequence: 4,
			toolName: 'mesh_delegate_task',
			phase: 'invokeStarted',
			delegationRequestId: 'wrong-request',
			taskIdPresent: false,
		},
		{
			sequence: 5,
			toolName: 'mesh_delegate_task',
			phase: 'invokeCompleted',
			delegationRequestId: 'wrong-request',
			taskId: taskId,
			taskIdPresent: true,
		},
	], 2, delegationRequestId);
	assert.equal(invocations.allInvokeStartedCount, 2);
	assert.equal(invocations.unexpectedInvokeStartedCount, 2);
	assert.equal(invocations.unexpectedActivityCount, 3);
	assert.equal(invocations.expected.unexpectedInvocationCount, 2);
	assert.equal(invocations.unsettledInvokeStartedCount, 2);
	assert.equal(isSuccessfulManualInvocation(invocations, true), false);
});

test('post-prompt completion accounting cannot use a pre-checkpoint invocation', () => {
	const invocations = summarizePostPromptDelegations([
		{
			sequence: 3,
			toolName: 'mesh_delegate_task',
			phase: 'invokeStarted',
			delegationRequestId,
			invocationSequence: 2,
			invocationId: secondInvocationId,
			taskIdPresent: false,
		},
		{
			sequence: 4,
			toolName: 'mesh_delegate_task',
			phase: 'invokeCompleted',
			delegationRequestId: 'older-request',
			invocationSequence: 1,
			invocationId,
			taskId,
			taskIdPresent: true,
		},
	], 2, delegationRequestId);
	assert.equal(invocations.allInvokeStartedCount, 1);
	assert.equal(invocations.allInvokeCompletedCount, 0);
	assert.equal(invocations.unsettledInvokeStartedCount, 1);
});

test('invocation identity prevents sequence reuse from settling a newer tool registration', () => {
	const invocations = summarizePostPromptDelegations([
		{
			sequence: 3,
			toolName: 'mesh_delegate_task',
			phase: 'invokeStarted',
			delegationRequestId,
			invocationSequence: 1,
			invocationId: secondInvocationId,
			taskIdPresent: false,
		},
		{
			sequence: 4,
			toolName: 'mesh_delegate_task',
			phase: 'invokeCompleted',
			delegationRequestId,
			invocationSequence: 1,
			invocationId,
			taskId,
			taskIdPresent: true,
		},
	], 2, delegationRequestId);
	assert.equal(invocations.allInvokeStartedCount, 1);
	assert.equal(invocations.allInvokeCompletedCount, 0);
	assert.equal(invocations.unsettledInvokeStartedCount, 1);
	assert.equal(allManualStartsHaveTaskEvidence(invocations), false);
});

test('unexpected pending preparation cannot certify no-task cleanup', () => {
	const invocations = summarizePostPromptDelegations([{
		sequence: 2,
		toolName: 'mesh_delegate_task',
		phase: 'prepareStarted',
		delegationRequestId: 'wrong-request',
		preparationSequence: 1,
		taskIdPresent: false,
	}], 1, delegationRequestId);
	assert.equal(invocations.unexpectedActivityCount, 1);
	assert.equal(invocations.allInvokeStartedCount, 0);
	assert.equal(invocations.unresolvedPreparationCount, 1);
	assert.equal(isSuccessfulManualInvocation(invocations, true), false);
});

test('settled invocation does not hide another pending unexpected preparation', () => {
	const invocations = summarizePostPromptDelegations([
		{
			sequence: 2,
			toolName: 'mesh_delegate_task',
			phase: 'prepareStarted',
			delegationRequestId,
			preparationSequence: 1,
			taskIdPresent: false,
		},
		{
			sequence: 3,
			toolName: 'mesh_delegate_task',
			phase: 'prepared',
			delegationRequestId,
			preparationSequence: 1,
			taskIdPresent: false,
		},
		{
			sequence: 4,
			toolName: 'mesh_delegate_task',
			phase: 'invokeStarted',
			delegationRequestId,
			invocationSequence: 1,
			invocationId,
			taskIdPresent: false,
		},
		{
			sequence: 5,
			toolName: 'mesh_delegate_task',
			phase: 'invokeCompleted',
			delegationRequestId,
			invocationSequence: 1,
			invocationId,
			taskId,
			taskIdPresent: true,
			compactStatus: 0,
		},
		{
			sequence: 6,
			toolName: 'mesh_delegate_task',
			phase: 'prepareStarted',
			delegationRequestId: 'wrong-request',
			preparationSequence: 2,
			taskIdPresent: false,
		},
	], 1, delegationRequestId);
	assert.equal(invocations.unsettledInvokeStartedCount, 0);
	assert.equal(invocations.unresolvedPreparationCount, 1);
	assert.equal(invocations.unexpectedActivityCount, 1);
});

test('manual monitor cannot prove exactly-once success from truncated or duplicate phases', () => {
	const exact = summarizePostPromptDelegations([
		{
			sequence: 2,
			toolName: 'mesh_delegate_task',
			phase: 'prepareStarted',
			delegationRequestId,
			preparationSequence: 1,
			taskIdPresent: false,
		},
		{
			sequence: 3,
			toolName: 'mesh_delegate_task',
			phase: 'prepared',
			delegationRequestId,
			preparationSequence: 1,
			taskIdPresent: false,
		},
		{
			sequence: 4,
			toolName: 'mesh_delegate_task',
			phase: 'invokeStarted',
			delegationRequestId,
			invocationSequence: 1,
			invocationId,
			taskIdPresent: false,
		},
		{
			sequence: 5,
			toolName: 'mesh_delegate_task',
			phase: 'invokeCompleted',
			delegationRequestId,
			taskId,
			invocationSequence: 1,
			invocationId,
			taskIdPresent: true,
			compactStatus: 0,
		},
	], 1, delegationRequestId);
	assert.equal(isSuccessfulManualInvocation(exact, true), true);
	assert.equal(isSuccessfulManualInvocation(exact, false), false);
	const duplicate = summarizePostPromptDelegations([
		...exact.delegateObservations,
		{
			sequence: 6,
			toolName: 'mesh_delegate_task',
			phase: 'invokeStarted',
			delegationRequestId,
			invocationSequence: 2,
			invocationId: secondInvocationId,
			taskIdPresent: false,
		},
	], 1, delegationRequestId);
	assert.equal(duplicate.unexpectedInvokeStartedCount, 1);
	assert.equal(duplicate.unexpectedActivityCount, 1);
	assert.equal(duplicate.expected.unexpectedInvocationCount, 1);
	assert.equal(isSuccessfulManualInvocation(duplicate, true), false);
});

test('final resource validation rejects drift from a clean baseline', () => {
	const baseline = resourceMetrics({ activeTimers: 0, armedBudgetTimers: 0 });
	assert.doesNotThrow(() => assertFinalPeerResourceMetrics(baseline));
	const final = resourceMetrics({ activeTimers: 1, armedBudgetTimers: 0 });
	assert.throws(
		() => assertFinalPeerResourceMetrics(final),
		/live Tool timers/u,
		'Cleanup must validate the refreshed final metrics rather than the clean baseline.',
	);
	assert.throws(() => assertFinalPeerResourceMetrics({ toolTimers: {} }), /malformed/u);
});

test('manual monitor rejects a closed or replaced exact target and accepts the normal path', () => {
	const target = {
		nodeId: 'node-one',
		nodeInstanceId: 'instance-one',
		workspaceId: 'workspace-one',
	};
	const controllerState = {
		node: {
			nodeId: target.nodeId,
			nodeInstanceId: target.nodeInstanceId,
			state: 'online',
			registered: true,
			workspaceCount: 1,
		},
	};
	const exactNode = {
		nodeId: target.nodeId,
		nodeInstanceId: target.nodeInstanceId,
		status: 'online',
		workspaces: [{
			workspaceId: target.workspaceId,
			claimStatus: 'claimed',
			enabled: true,
		}],
	};

	assert.deepEqual(
		assessExactTargetLiveness(target, controllerState, { localNodes: [exactNode] }),
		{ ok: true },
	);
	assert.deepEqual(
		assessExactTargetLiveness(target, undefined, { localNodes: [exactNode] }),
		{ ok: false, code: 'PEER_OFFLINE' },
	);
	assert.deepEqual(
		assessExactTargetLiveness(target, controllerState, {
			localNodes: [{ ...exactNode, nodeInstanceId: 'replacement-instance' }],
		}),
		{ ok: false, code: 'PEER_OFFLINE' },
		'A replacement instance must not satisfy the exact target claim.',
	);
	assert.deepEqual(
		assessExactTargetLiveness(target, controllerState, {
			localNodes: [{
				...exactNode,
				workspaces: [{ ...exactNode.workspaces[0], workspaceId: 'replacement-workspace' }],
			}],
		}),
		{ ok: false, code: 'PEER_OFFLINE' },
	);
});

test('peer task evidence projection bounds verbose journals without inventing milestones', () => {
	const events = Array.from({ length: 300 }, (_, index) => ({
		eventSeq: index + 1,
		type: index % 2 === 0 ? 'progress' : 'output',
	}));
	events[0] = { eventSeq: 1, type: 'agentStartRequested' };
	events[1] = { eventSeq: 2, type: 'agentStarted' };
	events[150] = { eventSeq: 151, type: 'cancelRequested' };
	events[299] = { eventSeq: 300, type: 'cancelConfirmed' };

	const projected = projectPeerTaskEvents(events, 16);

	assert.equal(projected.truncated, true);
	assert.equal(projected.events.length, 16);
	const types = projected.events.map(({ type }) => type);
	assert.ok(types.indexOf('agentStarted') < types.indexOf('output'));
	assert.ok(types.indexOf('output') < types.indexOf('cancelRequested'));
	assert.ok(types.indexOf('cancelRequested') < types.indexOf('cancelConfirmed'));
	assert.equal(projected.events.every((event) => events.includes(event)), true);
	assert.equal(projected.events.every((event, index) =>
		index === 0 || event.eventSeq > projected.events[index - 1]!.eventSeq), true);
	assert.throws(() => projectPeerTaskEvents(events, 15), RangeError);
});

test('peer-delegation Tool clock shortens only minute-scale budget timers', () => {
	const clock = new PeerDelegationE2eToolClock(500);
	const operation = clock.createTimer(5_000);
	clock.armNextBudgetTimer();
	const budget = clock.createTimer(60_000);
	assert.deepEqual(clock.snapshot(), {
		budgetOverrideMs: 500,
		timersCreated: 2,
		timersDisposed: 0,
		activeTimers: 2,
		budgetTimersCreated: 1,
		armedBudgetTimers: 0,
	});
	operation.dispose();
	budget.dispose();
	assert.equal(clock.snapshot().activeTimers, 0);
	assert.equal(clock.snapshot().timersDisposed, 2);
});

test('0.4.0 release metadata keeps the real peer gate default-off and five-tool parity', () => {
	const root = resolve(__dirname, '../../..');
	const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const lockfile = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
	const wrapper = readFileSync(
		resolve(root, 'scripts/e2e/peer-delegation/run.mjs'),
		'utf8',
	);
	const validator = readFileSync(
		resolve(root, 'scripts/e2e/peer-delegation/validate.mjs'),
		'utf8',
	);
	const harness = readFileSync(
		resolve(root, 'scripts/e2e/peer-delegation/enabled.mjs'),
		'utf8',
	);
	const barrier = readFileSync(
		resolve(root, 'src/e2e/PeerDelegationManualBarrier.ts'),
		'utf8',
	);
	const application = readFileSync(
		resolve(root, 'src/composition/createApplication.ts'),
		'utf8',
	);
	const brokerRuntime = readFileSync(
		resolve(root, 'src/composition/ProductionBrokerRuntime.ts'),
		'utf8',
	);
	assert.equal(manifest.version, '0.4.0');
	assert.equal(lockfile.packages['node_modules/fast-uri'].version, '3.1.6');
	assert.equal(
		manifest.scripts['test:peer-delegation-real'],
		'node scripts/e2e/peer-delegation/run.mjs',
	);
	assert.equal(manifest.contributes.languageModelTools.length, 5);
	assert.equal(
		manifest.contributes.configuration.properties[
			'copilotAgentMesh.experimental.peerDelegation'
		].default,
		false,
	);
	assert.match(manifest.scripts['package:vsix'], /copilot-agent-mesh-0\.4\.0-preview\.vsix/u);
	assert.doesNotMatch(JSON.stringify(manifest.scripts), /0\.3\.0-preview\.vsix/u);
	assert.ok(
		wrapper.indexOf(`process.env[environmentVariable] !== '1'`)
			< wrapper.indexOf('const result = spawnSync'),
		'The exact environment gate must run before any compile or launch command.',
	);
	const cleanSnapshotCall = wrapper.indexOf('assertCleanCommittedReleaseSnapshot({');
	const evidenceRemoval = wrapper.indexOf('rmSync(evidence.evidencePath');
	const summaryRemoval = wrapper.indexOf('rmSync(evidence.summaryPath');
	assert.ok(
		cleanSnapshotCall >= 0
			&& cleanSnapshotCall < evidenceRemoval
			&& evidenceRemoval < summaryRemoval,
		'The clean-snapshot call must execute before the actual stable artifact removals.',
	);
	assert.match(
		harness,
		/async function installEvidenceTemporary[\s\S]*revalidateEvidenceDestination[\s\S]*await rename/u,
	);
	const manualCompletion = harness.indexOf('async function waitForManualCompletion');
	const manualCompletionEnd = harness.indexOf('async function runNeedsInputScenario', manualCompletion);
	const detachWait = harness.indexOf('const completionObservations = await waitForTaskClientDetach');
	const catalogProbe = harness.indexOf("await request(target, 'peer.session.catalog'");
	const postDetachPrompt = harness.indexOf('manualPostDetachObservationRequired: true');
	const attestationRead = harness.indexOf('uiAttestation = await readUiAttestation(postDetachChallenge)');
	assert.ok(manualCompletion >= 0 && manualCompletionEnd > manualCompletion);
	assert.equal(
		harness.slice(manualCompletion, manualCompletionEnd).includes('readUiAttestation'),
		false,
		'Manual completion must not read Session visibility before task-handle detach.',
	);
	assert.match(
		harness.slice(manualCompletion, manualCompletionEnd),
		/Promise\.allSettled\([\s\S]*controller\.state[\s\S]*peer\.dashboard\.snapshot/u,
	);
	assert.match(
		harness.slice(manualCompletion, manualCompletionEnd),
		/prepareFailedCount[\s\S]*classifyTargetControllerRejection[\s\S]*TARGET_WINDOW_CLOSED[\s\S]*assessExactTargetLiveness/u,
	);
	assert.match(
		harness.slice(manualCompletion, manualCompletionEnd),
		/observationCheckpoint[\s\S]*unexpectedActivityCount[\s\S]*settleUnexpectedManualInvocations/u,
	);
	assert.match(
		harness.slice(manualCompletion, manualCompletionEnd),
		/initialInvocations\.unresolvedPreparationCount[\s\S]*MANUAL_SOURCE_BUSY/u,
	);
	assert.match(
		harness.slice(manualCompletion, manualCompletionEnd),
		/waitForManualInvocationQuiescence[\s\S]*isSuccessfulManualInvocation/u,
	);
	assert.ok(
		harness.indexOf('await freezeManualDelegateIngress(source,')
			< harness.indexOf('await waitForManualInvocationQuiescence'),
		'Delegate ingress must freeze before the final quiescence audit.',
	);
	assert.match(
		harness.slice(manualCompletion, manualCompletionEnd),
		/const frozen = await freezeManualDelegateIngress[\s\S]*if \(!frozen\.complete\)[\s\S]*settleUnexpectedManualInvocations[\s\S]*waitForManualInvocationQuiescence/u,
	);
	const frozenDecision = harness.indexOf('async function resolveFrozenManualTerminalDecision');
	const frozenDecisionEnd = harness.indexOf('async function waitForFrozenManualOutcome', frozenDecision);
	const frozenDecisionBody = harness.slice(frozenDecision, frozenDecisionEnd);
	assert.ok(frozenDecision >= 0 && frozenDecisionEnd > frozenDecision);
	assert.match(
		frozenDecisionBody,
		/resolveManualTerminalBarrier[\s\S]*freezeManualDelegateIngress[\s\S]*waitForFrozenManualOutcome[\s\S]*settleUnexpectedManualInvocations/u,
	);
	assert.match(
		barrier,
		/const frozen = await freeze\(\)[\s\S]*classifyFrozenManualDecision\(frozen\.postPrompt, frozen\.complete\)/u,
	);
	assert.match(
		frozenDecisionBody,
		/authoritativeOutcomeDeadline[\s\S]*manualCompletionTimeoutMs/u,
	);
	assert.match(
		harness,
		/peer\.manual\.task\.resolve[\s\S]*cancelManualTaskAndWait/u,
	);
	const settleStart = harness.indexOf('async function settleUnexpectedManualInvocations');
	const settleEnd = harness.indexOf('async function waitForTaskLeaseReleased', settleStart);
	const settleBody = harness.slice(settleStart, settleEnd);
	assert.ok(settleStart >= 0 && settleEnd > settleStart);
	assert.ok(
		settleBody.indexOf('await settleKnownTasks()')
			< settleBody.indexOf('finalPostPrompt.unresolvedPreparationCount'),
		'Observed task handles must be settled before pending preparations fail cleanup evidence.',
	);
	assert.match(
		settleBody,
		/manualIngressFreezeProof\?\.complete === true[\s\S]*!finalObservations\.truncated/u,
	);
	assert.match(
		settleBody,
		/catch \{[\s\S]*taskIdentitiesComplete = false;[\s\S]*resolveMissingTaskIdentities\(\)[\s\S]*settleKnownTasks\(\)[\s\S]*continue;/u,
	);
	assert.match(
		frozenDecisionBody,
		/MANUAL_TOOL_INVOCATION_FAILED[\s\S]*resolved\.postPrompt\.expected[\s\S]*false/u,
	);
	assert.ok(
		harness.indexOf('const controllerProcessAlive = isControllerProcessAlive(target)')
			< harness.indexOf('rechecked = await recheckManualInvocationAfterControllerFailure'),
		'Verified process exit must be sampled before the final sequenced Source observation recheck.',
	);
	assert.match(
		harness,
		/name: 'observe-tool-resources'[\s\S]*const observedResourceMetrics = await request\([\s\S]*assertFinalPeerResourceMetrics\(observedResourceMetrics\)[\s\S]*finalResourceMetrics = observedResourceMetrics/u,
	);
	assert.match(
		harness,
		/evidence\.resources\.timer\.ownedPeak =\s*\(finalResourceMetrics\?\.toolTimers\.timersCreated \?\? 0\)/u,
	);
	assert.match(harness, /manualInvocation[\s\S]*taskIdPresent/u);
	assert.ok(
		detachWait >= 0
			&& detachWait < catalogProbe
			&& catalogProbe < postDetachPrompt
			&& postDetachPrompt < attestationRead,
		'Post-detach attestation must follow objective detach and the fresh catalog probe.',
	);
	assert.match(
		harness,
		/canRequestManualPostDetachObservation\(\s*manualUi,\s*sessionArchivedObserved,\s*clientDetachedObserved,\s*catalogProbeCompleted/u,
	);
	assert.match(harness, /targetSessionState:\s*'unobserved'/u);
	assert.doesNotMatch(harness, /rm\(meshGlobalStorageDirectory/u);
	assert.match(
		application,
		/BrokerOwnerLock\.acquire\(brokerStorageUri\.fsPath[\s\S]*storageRootUri: brokerStorageUri/u,
	);
	assert.match(
		application,
		/createLocalBrokerIdentity\(brokerStorageUri, deviceId\)[\s\S]*createLocalBrokerIdentity\(\s*brokerStorageUri/u,
	);
	assert.match(brokerRuntime, /options\.storageRootUri,\s*'mesh-state'/u);
	assert.match(harness, /readMultiWindowStartupDiagnostic/u);
	const logStreamCreation = harness.indexOf('const output = createWriteStream');
	const logStreamOpen = harness.indexOf("output.once('open'", logStreamCreation);
	const windowSpawn = harness.indexOf('child = spawn', logStreamCreation);
	assert.ok(
		logStreamCreation >= 0
			&& logStreamCreation < logStreamOpen
			&& logStreamOpen < windowSpawn,
		'The owned log stream must open before the VS Code process is spawned.',
	);
	assert.match(harness, /output\.on\('error'[\s\S]*record\.outputFailure/u);
	assert.match(harness, /async function closeLogStreams[\s\S]*await finished\(output[\s\S]*throw new AggregateError/u);
	assert.match(validator, /evidence\.gitCommit !== head/u);
	assert.match(validator, /status\.length !== 0/u);
});

function unverifiedEvidence(): PeerDelegationEvidence {
	return {
		schemaVersion: 1,
		release: '0.4.0-preview',
		runId,
		outcome: 'unverified',
		gitCommit: '0123456789abcdef0123456789abcdef01234567',
		versions: {
			extension: '0.4.0',
			vscode: '1.135.0',
			ahpCommit: 'f19dd8b3942d029744a3bdd31d830f9428e8ea47',
			ahpClient: '0.9.0',
			protocolOffer: ['1.0.0'],
		},
		startedAt: '2026-08-31T00:00:00.000Z',
		finishedAt: '2026-08-31T00:00:01.000Z',
		durationMs: 1_000,
		platform: { os: 'darwin', architecture: 'arm64' },
		topology: {
			ordinaryWindows: {
				status: 'unverified',
				count: 0,
				ordinary: false,
				sharedUserData: false,
			},
			broker: { status: 'unverified', count: 0 },
			workspaceClaims: {
				status: 'unverified',
				count: 0,
				hashes: [],
				distinct: false,
			},
		},
		doubleGate: {
			status: 'unverified',
			beforeTargetVisible: false,
			allowOnlyTargetVisible: false,
			afterTargetVisible: false,
			reverseTargetVisible: false,
			dashboardSourceCandidateCount: 0,
			dashboardTargetCandidateCount: 0,
			dashboardAlwaysListedBoth: false,
		},
		confirmation: {
			status: 'unverified',
			preparedCount: 0,
			acceptedCount: 0,
			source: 'unobserved',
			operatorAttested: false,
		},
		completion: {
			status: 'unverified',
			parentSameInvocation: false,
			parentResultFields: [],
			parentResultBytes: 0,
			invocationSource: 'none',
			eventTypes: [],
			eventSequences: [],
			eventJournalTruncated: false,
			authoritativeOrder: false,
			ahpTurnCompleteObserved: false,
			output: { count: 0, bytes: 0 },
			incomingRecord: false,
			source: 'unavailable',
			degraded: false,
			leaseReleased: false,
			durationMs: 0,
		},
		needsInput: {
			status: 'unverified',
			questionPresent: false,
			eventTypes: [],
			eventJournalTruncated: false,
			answerTaskIdMatched: false,
			answerInputIdMatched: false,
			resumed: false,
			terminalState: 'not-observed',
			leaseReleased: false,
		},
		cancellation: {
			status: 'unverified',
			reason: 'not-observed',
			eventTypes: [],
			eventJournalTruncated: false,
			terminalState: 'not-observed',
			leaseReleased: false,
		},
		timeout: {
			status: 'unverified',
			reason: 'not-observed',
			budgetMs: 10_000,
			productionDefaultMinutes: 60,
			productionMaximumMinutes: 60,
			eventTypes: [],
			eventJournalTruncated: false,
			terminalState: 'not-observed',
			leaseReleased: false,
		},
		sessionVisibility: {
			status: 'unverified',
			source: 'unavailable',
			catalogBefore: 0,
			catalogAfter: 0,
			hostSessionEchoObserved: false,
			sessionArchivedObserved: false,
			clientDetachedObserved: false,
			catalogAfterTerminalCleanup: false,
			catalogSessionHashMatched: false,
			uiObserved: false,
			uiObservation: 'unobserved',
		},
		transport: {
			status: 'unverified',
			listenerStartAttempts: { baseline: 0, final: 0, delta: 0 },
			tunnelLoadAttempts: { baseline: 0, final: 0, delta: 0 },
			tunnelProbeAttempts: { baseline: 0, final: 0, delta: 0 },
			tunnelEnsureHostedAttempts: { baseline: 0, final: 0, delta: 0 },
			localRouteOnly: false,
		},
		resources: {
			vscode: { baselineOwned: 0, ownedPeak: 0, finalOwned: 0 },
			agentHost: { baselineOwned: 0, ownedPeak: 0, finalOwned: 0 },
			tunnel: { baselineOwned: 0, ownedPeak: 0, finalOwned: 0 },
			socket: { baselineOwned: 0, ownedPeak: 0, finalOwned: 0 },
			timer: { baselineOwned: 0, ownedPeak: 0, finalOwned: 0 },
		},
		cleanup: {
			status: 'unverified',
			profileLockReleased: false,
			workspaceLeaseReleased: false,
			localIpcRemoved: false,
			editorEndpointReleased: false,
			runtimeRemoved: false,
			ownedProcessesReleased: false,
			ownedSocketsReleased: false,
			ownedTimersReleased: false,
			complete: false,
		},
		experiments: [
			{ id: 'O1', status: 'unverified', conclusion: 'unverified' },
			{
				id: 'O2',
				status: 'unverified',
				conclusion: 'unverified',
				observedDurationMs: 0,
			},
			{
				id: 'O3',
				status: 'unverified',
				conclusion: 'tool-choice-not-guaranteed',
			},
			{
				id: 'O4',
				status: 'unsupported',
				conclusion: 'concurrent-user-edits-undetectable',
			},
			{
				id: 'O5',
				status: 'unsupported',
				conclusion: 'non-macos-endpoint-unverified',
			},
		],
		ac5: Array.from({ length: 12 }, (_, index) => ({
			item: index + 1,
			status: 'unverified' as const,
			evidenceRefs: [],
		})),
		limitations: [
			'COPILOT_TOOL_CHOICE_NOT_GUARANTEED',
			'CONCURRENT_USER_COPILOT_EDITS_UNDETECTABLE',
			'CROSS_DEVICE_DELEGATION_UNVERIFIED',
			'NON_MACOS_WORKER_UNSUPPORTED',
			'SIXTY_MINUTE_UI_CALL_UNVERIFIED',
			'TARGET_CHAT_SESSIONS_UI_UNVERIFIED',
			'REAL_NEEDS_INPUT_UNVERIFIED',
		],
	};
}

function passingEvidence(): PeerDelegationEvidence {
	const base = unverifiedEvidence();
	const references = [
		'#/topology/ordinaryWindows',
		'#/topology/broker',
		'#/topology/workspaceClaims',
		'#/doubleGate',
		'#/confirmation',
		'#/completion/eventTypes',
		'#/completion/parentSameInvocation',
		'#/completion/incomingRecord',
		'#/sessionVisibility/hostSessionEchoObserved',
		'#/transport',
		'#/cleanup/workspaceLeaseReleased',
		'#/resources',
	];
	return {
		...base,
		outcome: 'pass',
		topology: {
			ordinaryWindows: {
				status: 'pass',
				count: 2,
				ordinary: true,
				sharedUserData: true,
			},
			broker: { status: 'pass', count: 1 },
			workspaceClaims: {
				status: 'pass',
				count: 2,
				hashes: ['0123456789abcdef', 'fedcba9876543210'],
				distinct: true,
			},
		},
		doubleGate: {
			status: 'pass',
			beforeTargetVisible: false,
			notAllowedCode: 'PEER_NOT_ALLOWED',
			allowOnlyTargetVisible: false,
			notAcceptingCode: 'PEER_NOT_ACCEPTING',
			afterTargetVisible: true,
			reverseTargetVisible: false,
			dashboardSourceCandidateCount: 2,
			dashboardTargetCandidateCount: 2,
			dashboardAlwaysListedBoth: true,
		},
		confirmation: {
			status: 'pass',
			preparedCount: 1,
			acceptedCount: 1,
			source: 'copilot-ui',
			operatorAttested: true,
		},
		completion: {
			status: 'pass',
			taskId,
			parentResultTaskId: taskId,
			parentSameInvocation: true,
			parentResultFields: ['d', 'r', 's', 't'],
			parentResultBytes: 128,
			parentResultHash: '0123456789abcdef',
			invocationSource: 'copilot-ui',
			compactStatus: 0,
			eventTypes: ['agentStarted', 'output', 'completed'],
			eventSequences: [1, 2, 3],
			eventJournalTruncated: false,
			authoritativeOrder: true,
			ahpTurnCompleteObserved: true,
			output: {
				count: 1,
				bytes: 8,
				hash: '0123456789abcdef',
			},
			incomingRecord: true,
			source: 'editor',
			degraded: false,
			leaseReleased: true,
			durationMs: 1_000,
		},
		needsInput: {
			status: 'pass',
			taskId,
			compactStatus: 1,
			inputId,
			questionPresent: true,
			eventTypes: ['inputRequired', 'inputAnswered', 'completed'],
			eventJournalTruncated: false,
			answerTaskIdMatched: true,
			answerInputIdMatched: true,
			resumed: true,
			terminalState: 'completed',
			leaseReleased: true,
		},
		cancellation: {
			status: 'pass',
			taskId,
			compactStatus: 3,
			reason: 'token',
			eventTypes: ['agentStarted', 'output', 'cancelRequested', 'cancelConfirmed'],
			eventJournalTruncated: false,
			terminalState: 'cancelled',
			leaseReleased: true,
		},
		timeout: {
			status: 'pass',
			taskId,
			compactStatus: 3,
			reason: 'budget',
			budgetMs: 10_000,
			productionDefaultMinutes: 60,
			productionMaximumMinutes: 60,
			eventTypes: ['agentStarted', 'output', 'cancelRequested', 'cancelConfirmed'],
			eventJournalTruncated: false,
			terminalState: 'cancelled',
			leaseReleased: true,
		},
		sessionVisibility: {
			status: 'unverified',
			source: 'editor',
			catalogBefore: 0,
			catalogAfter: 1,
			hostSessionHash: '0123456789abcdef',
			editorEndpointFingerprint: 'fedcba9876543210',
			hostSessionEchoObserved: true,
			sessionArchivedObserved: true,
			clientDetachedObserved: true,
			catalogAfterTerminalCleanup: true,
			catalogSessionHashMatched: true,
			uiObserved: false,
			uiObservation: 'unobserved',
		},
		transport: {
			status: 'pass',
			listenerStartAttempts: { baseline: 0, final: 0, delta: 0 },
			tunnelLoadAttempts: { baseline: 0, final: 0, delta: 0 },
			tunnelProbeAttempts: { baseline: 0, final: 0, delta: 0 },
			tunnelEnsureHostedAttempts: { baseline: 0, final: 0, delta: 0 },
			localRouteOnly: true,
		},
		cleanup: {
			status: 'pass',
			profileLockReleased: true,
			workspaceLeaseReleased: true,
			localIpcRemoved: true,
			editorEndpointReleased: true,
			runtimeRemoved: true,
			ownedProcessesReleased: true,
			ownedSocketsReleased: true,
			ownedTimersReleased: true,
			complete: true,
		},
		ac5: references.map((reference, index) => ({
			item: index + 1,
			status: 'pass',
			evidenceRefs: [reference],
		})),
	};
}
