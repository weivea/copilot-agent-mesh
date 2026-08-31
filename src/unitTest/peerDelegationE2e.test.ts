import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';

import {
	assertPassingPeerDelegationEvidence,
	parsePeerDelegationEvidence,
	type PeerDelegationEvidence,
} from '../e2e/PeerDelegationEvidence';
import {
	PeerDelegationE2eRecorder,
	PeerDelegationE2eToolClock,
} from '../e2e/PeerDelegationE2eRecorder';

const runId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const inputId = '00000000-0000-4000-8000-000000000003';
const delegationRequestId = '00000000-0000-4000-8000-000000000004';

test('peer-delegation evidence rejects unsafe persistent content', () => {
	const base = unverifiedEvidence();
	assert.doesNotThrow(() => parsePeerDelegationEvidence(base));
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

test('peer-delegation passing evidence requires all real AC-5 conditions', () => {
	const evidence = passingEvidence();
	assert.equal(assertPassingPeerDelegationEvidence(evidence).outcome, 'pass');
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
	recorder.observeLifecycle({ taskId, eventType: 'chat/turnComplete' });
	const snapshot = recorder.snapshot();
	assert.equal(snapshot.tools.length, 1);
	assert.equal(snapshot.tools[0]?.taskId, taskId);
	assert.equal(snapshot.tools[0]?.delegationRequestId, delegationRequestId);
	assert.equal(snapshot.tools[0]?.compactStatus, 0);
	assert.deepEqual(snapshot.tools[0]?.resultFields, ['d', 'r', 's', 't']);
	assert.match(snapshot.tools[0]?.resultHash ?? '', /^[a-f0-9]{64}$/u);
	assert.equal(JSON.stringify(snapshot).includes('do not persist'), false);
	assert.deepEqual(snapshot.ahp, [{
		sequence: 2,
		at: snapshot.ahp[0]?.at,
		taskId,
		eventType: 'chat/turnComplete',
	}]);
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
	assert.match(wrapper, /rmSync[\s\S]*evidence\.json/u);
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
			terminalState: 'not-observed',
			leaseReleased: false,
		},
		sessionVisibility: {
			status: 'unverified',
			source: 'unavailable',
			catalogBefore: 0,
			catalogAfter: 0,
			sessionHashMatched: false,
			uiObserved: false,
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
		'#/completion/source',
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
			terminalState: 'cancelled',
			leaseReleased: true,
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
