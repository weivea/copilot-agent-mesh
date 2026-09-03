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
	assessExactTargetLiveness,
	summarizeManualInvocation,
} from '../e2e/PeerDelegationManualMonitor';

const runId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const inputId = '00000000-0000-4000-8000-000000000003';
const delegationRequestId = '00000000-0000-4000-8000-000000000004';
const postDetachChallenge = '00000000-0000-4000-8000-000000000005';

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
				prepareFailedCount: 0,
				invokeStartedCount: 0,
				invokeCompletedCount: 0,
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
			prepareFailedCount: 1,
			invokeStartedCount: 0,
			invokeCompletedCount: 0,
			errorCode: 'PEER_OFFLINE',
			taskIdPresent: false,
		});
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
	const application = readFileSync(
		resolve(root, 'src/composition/createApplication.ts'),
		'utf8',
	);
	const brokerRuntime = readFileSync(
		resolve(root, 'src/composition/ProductionBrokerRuntime.ts'),
		'utf8',
	);
	assert.equal(manifest.version, '0.4.0');
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
		/prepareFailedCount[\s\S]*TARGET_WINDOW_CLOSED[\s\S]*assessExactTargetLiveness/u,
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
