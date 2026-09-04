import { z } from 'zod';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const taskUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const timestamp = z.string().datetime({ offset: true });
const nonNegativeInteger = z.number().int().nonnegative();
const status = z.enum(['pass', 'fail', 'unverified']);
const fingerprint = z.string().regex(/^[a-f0-9]{16}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const stableCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
const evidenceReference = z.string().regex(/^#(?:\/(?:[A-Za-z0-9_-]|~[01])+)+$/u);
const terminalStateValues = [
	'completed',
	'failed',
	'cancelled',
	'timedOut',
	'not-observed',
] as const;
const terminalState = z.enum(terminalStateValues);
const protocolVersion = z.enum(['1.0.0', '0.9.0']);
const protocolOffer = z.union([
	z.tuple([z.literal('1.0.0')]),
	z.tuple([z.literal('1.0.0'), z.literal('0.9.0')]),
]);

const statusCount = z.strictObject({
	status,
	count: nonNegativeInteger,
});

const resourceCounts = z.strictObject({
	baselineOwned: nonNegativeInteger,
	ownedPeak: nonNegativeInteger,
	finalOwned: nonNegativeInteger,
});

const attemptDelta = z.strictObject({
	baseline: nonNegativeInteger,
	final: nonNegativeInteger,
	delta: z.number().int(),
});

const scenarioOutput = z.strictObject({
	count: nonNegativeInteger,
	bytes: nonNegativeInteger,
	hash: fingerprint.optional(),
});

const ac5Item = z.strictObject({
	item: z.number().int().min(1).max(12),
	status,
	evidenceRefs: z.array(evidenceReference).max(16),
});

const experimentStatus = z.enum(['pass', 'fail', 'unverified', 'unsupported']);

export const peerDelegationEvidenceSchema = z.strictObject({
	schemaVersion: z.literal(1),
	release: z.literal('0.4.0-preview'),
	runId: uuid,
	outcome: status,
	gitCommit: z.string().regex(/^[a-f0-9]{40}$/u),
	versions: z.strictObject({
		extension: z.literal('0.4.0'),
		vscode: z.string().min(1).max(64),
		ahpCommit: z.literal('f19dd8b3942d029744a3bdd31d830f9428e8ea47'),
		ahpClient: z.literal('0.9.0'),
		protocolOffer,
		selectedProtocolVersion: protocolVersion.optional(),
	}),
	startedAt: timestamp,
	finishedAt: timestamp,
	durationMs: nonNegativeInteger,
	platform: z.strictObject({
		os: z.literal('darwin'),
		architecture: z.literal('arm64'),
	}),
	topology: z.strictObject({
		ordinaryWindows: z.strictObject({
			status,
			count: nonNegativeInteger,
			ordinary: z.boolean(),
			sharedUserData: z.boolean(),
		}),
		broker: statusCount,
		workspaceClaims: z.strictObject({
			status,
			count: nonNegativeInteger,
			hashes: z.array(fingerprint).max(2),
			distinct: z.boolean(),
		}),
	}),
	doubleGate: z.strictObject({
		status,
		beforeTargetVisible: z.boolean(),
		notAllowedCode: stableCode.optional(),
		allowOnlyTargetVisible: z.boolean(),
		notAcceptingCode: stableCode.optional(),
		afterTargetVisible: z.boolean(),
		reverseTargetVisible: z.boolean(),
		dashboardSourceCandidateCount: nonNegativeInteger,
		dashboardTargetCandidateCount: nonNegativeInteger,
		dashboardAlwaysListedBoth: z.boolean(),
	}),
	confirmation: z.strictObject({
		status,
		preparedCount: nonNegativeInteger,
		acceptedCount: nonNegativeInteger,
		source: z.enum(['copilot-ui', 'programmatic', 'unobserved']),
		operatorAttested: z.boolean(),
	}),
	completion: z.strictObject({
		status,
		taskId: taskUuid.optional(),
		parentResultTaskId: taskUuid.optional(),
		parentSameInvocation: z.boolean(),
		parentResultFields: z.array(z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/u)).max(16),
		parentResultBytes: nonNegativeInteger,
		parentResultHash: fingerprint.optional(),
		invocationSource: z.enum(['copilot-ui', 'programmatic-core', 'none']),
		compactStatus: z.number().int().min(0).max(3).optional(),
		eventTypes: z.array(z.string().min(1).max(64)).max(256),
		eventSequences: z.array(z.number().int().positive()).max(256),
		eventJournalTruncated: z.boolean(),
		authoritativeOrder: z.boolean(),
		ahpTurnCompleteObserved: z.boolean(),
		output: scenarioOutput,
		incomingRecord: z.boolean(),
		source: z.enum(['editor', 'standalone', 'unavailable']),
		degraded: z.boolean(),
		sourceFailure: z.strictObject({
			code: stableCode,
			stage: z.enum(['discovery', 'connection', 'initialize', 'session', 'task']),
			detail: z.enum([
				'CANCELLED',
				'CONNECT_FAILED',
				'EARLY_CLOSE',
				'INVALID_RESPONSE',
				'TOKEN_INVALID',
				'UPGRADE_AUTH_REJECTED',
				'UPGRADE_BUSY',
				'UPGRADE_FAILED',
				'UPGRADE_TIMEOUT',
			]).optional(),
			statusCode: z.number().int().min(100).max(599).optional(),
			socketCode: z.enum(['EACCES', 'ECONNREFUSED', 'ENOENT']).optional(),
			endpointFingerprint: fingerprint.optional(),
			proxyStage: z.enum(['target', 'local']).optional(),
		}).optional(),
		leaseReleased: z.boolean(),
		durationMs: nonNegativeInteger,
	}),
	needsInput: z.strictObject({
		status,
		taskId: taskUuid.optional(),
		compactStatus: z.number().int().min(0).max(3).optional(),
		inputId: taskUuid.optional(),
		questionPresent: z.boolean(),
		eventTypes: z.array(z.string().min(1).max(64)).max(256),
		eventJournalTruncated: z.boolean(),
		answerTaskIdMatched: z.boolean(),
		answerInputIdMatched: z.boolean(),
		resumed: z.boolean(),
		terminalState,
		leaseReleased: z.boolean(),
	}),
	cancellation: z.strictObject({
		status,
		taskId: taskUuid.optional(),
		compactStatus: z.number().int().min(0).max(3).optional(),
		reason: z.enum(['token', 'budget', 'peer', 'not-observed']),
		eventTypes: z.array(z.string().min(1).max(64)).max(256),
		eventJournalTruncated: z.boolean(),
		terminalState,
		leaseReleased: z.boolean(),
	}),
	timeout: z.strictObject({
		status,
		taskId: taskUuid.optional(),
		compactStatus: z.number().int().min(0).max(3).optional(),
		reason: z.enum(['budget', 'not-observed']),
		budgetMs: nonNegativeInteger,
		productionDefaultMinutes: z.literal(60),
		productionMaximumMinutes: z.literal(60),
		eventTypes: z.array(z.string().min(1).max(64)).max(256),
		eventJournalTruncated: z.boolean(),
		terminalState,
		leaseReleased: z.boolean(),
	}),
	sessionVisibility: z.strictObject({
		status,
		source: z.enum(['editor', 'standalone', 'unavailable']),
		catalogBefore: nonNegativeInteger,
		catalogAfter: nonNegativeInteger,
		hostSessionHash: fingerprint.optional(),
		editorEndpointFingerprint: fingerprint.optional(),
		hostSessionEchoObserved: z.boolean(),
		clientDetachedObserved: z.boolean(),
		catalogAfterTerminalCleanup: z.boolean(),
		catalogSessionHashMatched: z.boolean(),
		uiObserved: z.boolean(),
	}),
	transport: z.strictObject({
		status,
		listenerStartAttempts: attemptDelta,
		tunnelLoadAttempts: attemptDelta,
		tunnelProbeAttempts: attemptDelta,
		tunnelEnsureHostedAttempts: attemptDelta,
		localRouteOnly: z.boolean(),
	}),
	resources: z.strictObject({
		vscode: resourceCounts,
		agentHost: resourceCounts,
		tunnel: resourceCounts,
		socket: resourceCounts,
		timer: resourceCounts,
	}),
	cleanup: z.strictObject({
		status,
		profileLockReleased: z.boolean(),
		workspaceLeaseReleased: z.boolean(),
		localIpcRemoved: z.boolean(),
		editorEndpointReleased: z.boolean(),
		runtimeRemoved: z.boolean(),
		ownedProcessesReleased: z.boolean(),
		ownedSocketsReleased: z.boolean(),
		ownedTimersReleased: z.boolean(),
		complete: z.boolean(),
	}),
	experiments: z.tuple([
		z.strictObject({
			id: z.literal('O1'),
			status: experimentStatus,
			conclusion: z.enum(['editor-session-visible', 'dashboard-only', 'unverified']),
		}),
		z.strictObject({
			id: z.literal('O2'),
			status: experimentStatus,
			conclusion: z.enum(['sixty-minutes-observed', 'shorter-duration-only', 'unverified']),
			observedDurationMs: nonNegativeInteger,
		}),
		z.strictObject({
			id: z.literal('O3'),
			status: z.literal('unverified'),
			conclusion: z.literal('tool-choice-not-guaranteed'),
		}),
		z.strictObject({
			id: z.literal('O4'),
			status: z.literal('unsupported'),
			conclusion: z.literal('concurrent-user-edits-undetectable'),
		}),
		z.strictObject({
			id: z.literal('O5'),
			status: z.literal('unsupported'),
			conclusion: z.literal('non-macos-endpoint-unverified'),
		}),
	]),
	ac5: z.array(ac5Item).length(12),
	limitations: z.array(z.enum([
		'COPILOT_TOOL_CHOICE_NOT_GUARANTEED',
		'CONCURRENT_USER_COPILOT_EDITS_UNDETECTABLE',
		'CROSS_DEVICE_DELEGATION_UNVERIFIED',
		'NON_MACOS_WORKER_UNSUPPORTED',
		'SIXTY_MINUTE_UI_CALL_UNVERIFIED',
		'TARGET_CHAT_SESSIONS_UI_UNVERIFIED',
		'REAL_NEEDS_INPUT_UNVERIFIED',
	])).max(7),
	blocker: z.strictObject({
		code: stableCode,
		message: z.string().min(1).max(512),
	}).optional(),
	cleanupFailures: z.array(z.strictObject({
		phase: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
		code: stableCode,
		message: z.string().min(1).max(512),
	})).max(16).optional(),
	failure: z.strictObject({
		code: stableCode,
		message: z.string().min(1).max(512),
	}).optional(),
}).superRefine((evidence, context) => {
	if (
		evidence.versions.selectedProtocolVersion !== undefined
		&& !evidence.versions.protocolOffer.some(
			(version) => version === evidence.versions.selectedProtocolVersion,
		)
	) {
		context.addIssue({
			code: 'custom',
			path: ['versions', 'selectedProtocolVersion'],
			message: 'The selected protocol version must be present in the exact protocol offer.',
		});
	}
	if (
		evidence.versions.selectedProtocolVersion === '0.9.0'
		&& evidence.versions.protocolOffer.length !== 2
	) {
		context.addIssue({
			code: 'custom',
			path: ['versions', 'protocolOffer'],
			message: 'Protocol 0.9.0 may only be selected from the editor registry 0.9 dual offer.',
		});
	}
	if (
		evidence.versions.protocolOffer.length === 2
		&& evidence.versions.selectedProtocolVersion === undefined
	) {
		context.addIssue({
			code: 'custom',
			path: ['versions', 'selectedProtocolVersion'],
			message: 'The dual protocol offer requires an explicitly recorded selected version.',
		});
	}
	if (
		evidence.outcome === 'pass'
		&& evidence.versions.selectedProtocolVersion === undefined
	) {
		context.addIssue({
			code: 'custom',
			path: ['versions', 'selectedProtocolVersion'],
			message: 'Passing evidence requires an explicitly observed selected protocol version.',
		});
	}
	const itemNumbers = evidence.ac5.map(({ item }) => item);
	if (new Set(itemNumbers).size !== 12 || itemNumbers.some((item, index) => item !== index + 1)) {
		context.addIssue({
			code: 'custom',
			path: ['ac5'],
			message: 'AC-5 items must appear exactly once in order 1 through 12.',
		});
	}
	for (const [index, item] of evidence.ac5.entries()) {
		if (item.status === 'pass' && item.evidenceRefs.length === 0) {
			context.addIssue({
				code: 'custom',
				path: ['ac5', index, 'evidenceRefs'],
				message: 'A passing AC-5 item requires at least one evidence reference.',
			});
		}
		for (const reference of item.evidenceRefs) {
			if (resolveJsonPointer(evidence, reference) === undefined) {
				context.addIssue({
					code: 'custom',
					path: ['ac5', index, 'evidenceRefs'],
					message: `Evidence reference does not resolve: ${reference}`,
				});
			}
		}
	}
	const expectedOutcome = deriveOutcome(evidence);
	if (evidence.outcome !== expectedOutcome) {
		context.addIssue({
			code: 'custom',
			path: ['outcome'],
			message: `Outcome must be ${expectedOutcome} for the recorded statuses.`,
		});
	}
	if (
		(evidence.cleanupFailures?.length ?? 0) > 0
		&& evidence.cleanup.status !== 'fail'
	) {
		addInvariantIssue(
			context,
			['cleanup'],
			'Recorded cleanup failures require failed cleanup status.',
		);
	}
	validateAc5Correspondence(evidence, context);
	if (
		evidence.confirmation.status === 'pass'
		&& (
			evidence.confirmation.source !== 'copilot-ui'
			|| evidence.confirmation.preparedCount !== 1
			|| evidence.confirmation.acceptedCount !== 1
			|| !evidence.confirmation.operatorAttested
		)
	) {
		context.addIssue({
			code: 'custom',
			path: ['confirmation'],
			message: 'Passing confirmation evidence requires one observed Copilot UI preparation and acceptance.',
		});
	}
	if (
		evidence.completion.status === 'pass'
		&& (
			evidence.completion.taskId === undefined
			|| evidence.completion.parentResultTaskId !== evidence.completion.taskId
			|| !evidence.completion.parentSameInvocation
			|| evidence.completion.parentResultFields.join(',') !== 'd,r,s,t'
			|| evidence.completion.parentResultBytes < 1
			|| evidence.completion.parentResultHash === undefined
			|| evidence.completion.compactStatus !== 0
			|| !evidence.completion.authoritativeOrder
			|| !orderedSubsequence(
				evidence.completion.eventTypes,
				['agentStarted', 'output', 'completed'],
			)
			|| !(
				evidence.completion.eventJournalTruncated
					? strictlyIncreasing(evidence.completion.eventSequences)
					: strictlyContiguous(evidence.completion.eventSequences)
			)
			|| (
				!evidence.completion.eventJournalTruncated
				&& evidence.completion.eventSequences[0] !== 1
			)
			|| evidence.completion.eventSequences.length !== evidence.completion.eventTypes.length
			|| !evidence.completion.ahpTurnCompleteObserved
			|| evidence.completion.output.count < 1
			|| evidence.completion.output.bytes < 1
			|| evidence.completion.output.hash === undefined
			|| !evidence.completion.incomingRecord
			|| evidence.completion.source !== 'editor'
			|| evidence.completion.degraded
			|| !evidence.completion.leaseReleased
		)
	) {
		context.addIssue({
			code: 'custom',
			path: ['completion'],
			message: 'Passing completion evidence requires the complete real editor Tool-to-Agent route.',
		});
	}
	if (
		evidence.doubleGate.status === 'pass'
		&& (
			evidence.doubleGate.beforeTargetVisible
			|| evidence.doubleGate.notAllowedCode !== 'PEER_NOT_ALLOWED'
			|| evidence.doubleGate.allowOnlyTargetVisible
			|| evidence.doubleGate.notAcceptingCode !== 'PEER_NOT_ACCEPTING'
			|| !evidence.doubleGate.afterTargetVisible
			|| evidence.doubleGate.reverseTargetVisible
			|| !evidence.doubleGate.dashboardAlwaysListedBoth
		)
	) {
		context.addIssue({
			code: 'custom',
			path: ['doubleGate'],
			message: 'Passing double-gate evidence does not match the required directional observations.',
		});
	}
	if (
		evidence.transport.status === 'pass'
		&& (
			!evidence.transport.localRouteOnly
			|| [
				evidence.transport.listenerStartAttempts,
				evidence.transport.tunnelLoadAttempts,
				evidence.transport.tunnelProbeAttempts,
				evidence.transport.tunnelEnsureHostedAttempts,
			].some(({ delta }) => delta !== 0)
		)
	) {
		context.addIssue({
			code: 'custom',
			path: ['transport'],
			message: 'Passing local-route evidence requires zero Listener and Tunnel attempt deltas.',
		});
	}
	for (const [key, observation] of Object.entries({
		listenerStartAttempts: evidence.transport.listenerStartAttempts,
		tunnelLoadAttempts: evidence.transport.tunnelLoadAttempts,
		tunnelProbeAttempts: evidence.transport.tunnelProbeAttempts,
		tunnelEnsureHostedAttempts: evidence.transport.tunnelEnsureHostedAttempts,
	})) {
		if (observation.delta !== observation.final - observation.baseline) {
			addInvariantIssue(
				context,
				['transport', key, 'delta'],
				'Transport attempt delta must equal final minus baseline.',
			);
		}
	}
	if (
		evidence.cleanup.status === 'pass'
		&& (
			!evidence.cleanup.complete
			|| !evidence.cleanup.profileLockReleased
			|| !evidence.cleanup.workspaceLeaseReleased
			|| !evidence.cleanup.localIpcRemoved
			|| !evidence.cleanup.editorEndpointReleased
			|| !evidence.cleanup.runtimeRemoved
			|| !evidence.cleanup.ownedProcessesReleased
			|| !evidence.cleanup.ownedSocketsReleased
			|| !evidence.cleanup.ownedTimersReleased
			|| Object.values(evidence.resources).some(({ finalOwned }) => finalOwned !== 0)
		)
	) {
		context.addIssue({
			code: 'custom',
			path: ['cleanup'],
			message: 'Passing cleanup evidence requires every harness-owned resource to be released.',
		});
	}
});

export type PeerDelegationEvidence = z.infer<typeof peerDelegationEvidenceSchema>;
export type PeerDelegationEvidenceTerminalState = typeof terminalStateValues[number];

export const peerDelegationDiagnosticEvidenceSchema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal('diagnostic'),
	release: z.literal('0.4.0-preview'),
	runId: uuid,
	outcome: z.literal('fail'),
	gitCommit: z.string().regex(/^[a-f0-9]{40}$/u),
	startedAt: timestamp,
	finishedAt: timestamp,
	durationMs: nonNegativeInteger,
	failure: z.strictObject({
		code: stableCode,
		message: z.string().min(1).max(512),
	}),
	validation: z.strictObject({
		code: z.literal('EVIDENCE_VALIDATION_FAILED'),
	}),
});
export type PeerDelegationDiagnosticEvidence = z.infer<
	typeof peerDelegationDiagnosticEvidenceSchema
>;

export const peerDelegationTestDiagnosticEvidenceSchema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal('test-diagnostic'),
	testMode: z.literal(true),
	release: z.literal('0.4.0-preview'),
	runId: uuid,
	outcome: z.literal('fail'),
	gitCommit: z.string().regex(/^[a-f0-9]{40}$/u),
	startedAt: timestamp,
	finishedAt: timestamp,
	durationMs: nonNegativeInteger,
	platform: z.strictObject({
		os: z.string().min(1).max(32),
		architecture: z.string().min(1).max(32),
	}),
	simulation: z.strictObject({
		os: z.string().min(1).max(32).optional(),
		architecture: z.string().min(1).max(32).optional(),
		dirtyTree: z.boolean(),
	}),
	failure: z.strictObject({
		code: stableCode,
		message: z.string().min(1).max(512),
	}),
	validation: z.strictObject({
		code: z.enum([
			'EVIDENCE_VALIDATION_FAILED',
			'TEST_MODE_NOT_RELEASE_EVIDENCE',
		]),
	}),
});
export type PeerDelegationTestDiagnosticEvidence = z.infer<
	typeof peerDelegationTestDiagnosticEvidenceSchema
>;
export type PeerDelegationEvidenceArtifact =
	| PeerDelegationEvidence
	| PeerDelegationDiagnosticEvidence;

export function normalizePeerDelegationEvidenceTerminalState(
	status: unknown,
): PeerDelegationEvidenceTerminalState {
	return terminalStateValues.includes(status as PeerDelegationEvidenceTerminalState)
		? status as PeerDelegationEvidenceTerminalState
		: 'not-observed';
}

export function parsePeerDelegationEvidence(value: unknown): PeerDelegationEvidence {
	assertEvidenceContentSafe(value);
	return peerDelegationEvidenceSchema.parse(value);
}

export function parsePeerDelegationEvidenceArtifact(
	value: unknown,
): PeerDelegationEvidenceArtifact {
	assertEvidenceContentSafe(value);
	const evidence = peerDelegationEvidenceSchema.safeParse(value);
	return evidence.success
		? evidence.data
		: peerDelegationDiagnosticEvidenceSchema.parse(value);
}

export function createPeerDelegationDiagnosticEvidence(input: {
	readonly runId: string;
	readonly gitCommit: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly failureCode: string;
}): PeerDelegationDiagnosticEvidence {
	return peerDelegationDiagnosticEvidenceSchema.parse({
		schemaVersion: 1,
		kind: 'diagnostic',
		release: '0.4.0-preview',
		runId: input.runId,
		outcome: 'fail',
		gitCommit: input.gitCommit,
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
		durationMs: input.durationMs,
		failure: {
			code: input.failureCode,
			message: 'Strict peer-delegation evidence validation failed; unsafe details were discarded.',
		},
		validation: {
			code: 'EVIDENCE_VALIDATION_FAILED',
		},
	});
}

export function createPeerDelegationTestDiagnosticEvidence(input: {
	readonly runId: string;
	readonly gitCommit: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly platform: {
		readonly os: string;
		readonly architecture: string;
	};
	readonly simulation: {
		readonly os?: string;
		readonly architecture?: string;
		readonly dirtyTree: boolean;
	};
	readonly failureCode: string;
	readonly validationFailed: boolean;
}): PeerDelegationTestDiagnosticEvidence {
	return peerDelegationTestDiagnosticEvidenceSchema.parse({
		schemaVersion: 1,
		kind: 'test-diagnostic',
		testMode: true,
		release: '0.4.0-preview',
		runId: input.runId,
		outcome: 'fail',
		gitCommit: input.gitCommit,
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
		durationMs: input.durationMs,
		platform: input.platform,
		simulation: input.simulation,
		failure: {
			code: input.failureCode,
			message: 'Internal peer-delegation fixture diagnostic; not release evidence.',
		},
		validation: {
			code: input.validationFailed
				? 'EVIDENCE_VALIDATION_FAILED'
				: 'TEST_MODE_NOT_RELEASE_EVIDENCE',
		},
	});
}

export function parsePeerDelegationTestDiagnosticEvidence(
	value: unknown,
): PeerDelegationTestDiagnosticEvidence {
	assertEvidenceContentSafe(value);
	return peerDelegationTestDiagnosticEvidenceSchema.parse(value);
}

export function assertPassingPeerDelegationEvidence(value: unknown): PeerDelegationEvidence {
	const evidence = parsePeerDelegationEvidence(value);
	if (evidence.outcome !== 'pass' || evidence.ac5.some((item) => item.status !== 'pass')) {
		throw new Error('Peer-delegation evidence is valid but does not pass all AC-5 items.');
	}
	return evidence;
}

function validateAc5Correspondence(
	evidence: PeerDelegationEvidence,
	context: z.RefinementCtx,
): void {
	const expected: ReadonlyArray<{
		readonly status: 'pass' | 'fail' | 'unverified';
		readonly referencePrefixes: readonly string[];
	}> = [
		{
			status: evidence.topology.ordinaryWindows.status,
			referencePrefixes: ['#/topology/ordinaryWindows'],
		},
		{
			status: evidence.topology.broker.status,
			referencePrefixes: ['#/topology/broker'],
		},
		{
			status: evidence.topology.workspaceClaims.status,
			referencePrefixes: ['#/topology/workspaceClaims'],
		},
		{
			status: evidence.doubleGate.status,
			referencePrefixes: ['#/doubleGate'],
		},
		{
			status: evidence.confirmation.status,
			referencePrefixes: ['#/confirmation'],
		},
		{
			status: evidence.completion.status,
			referencePrefixes: ['#/completion/eventTypes', '#/completion/output', '#/completion/ahpTurnCompleteObserved'],
		},
		{
			status: evidence.completion.taskId !== undefined
				&& evidence.completion.parentResultTaskId === evidence.completion.taskId
				&& evidence.completion.parentSameInvocation
				&& evidence.completion.invocationSource === 'copilot-ui'
				&& evidence.completion.parentResultFields.join(',') === 'd,r,s,t'
				&& evidence.completion.parentResultBytes > 0
				&& evidence.completion.parentResultHash !== undefined
				? 'pass'
				: evidence.completion.status === 'fail' ? 'fail' : 'unverified',
			referencePrefixes: ['#/completion/parentResultTaskId', '#/completion/parentSameInvocation'],
		},
		{
			status: evidence.completion.incomingRecord
				? 'pass'
				: evidence.completion.status === 'fail' ? 'fail' : 'unverified',
			referencePrefixes: ['#/completion/incomingRecord'],
		},
		{
			status: evidence.completion.source === 'editor'
				&& !evidence.completion.degraded
				&& evidence.sessionVisibility.source === 'editor'
				&& evidence.sessionVisibility.hostSessionEchoObserved
				&& evidence.sessionVisibility.hostSessionHash !== undefined
				&& evidence.sessionVisibility.editorEndpointFingerprint !== undefined
				? 'pass'
				: evidence.completion.status === 'fail' ? 'fail' : 'unverified',
			referencePrefixes: [
				'#/completion/source',
				'#/sessionVisibility/source',
				'#/sessionVisibility/hostSessionEchoObserved',
			],
		},
		{
			status: evidence.transport.status,
			referencePrefixes: ['#/transport'],
		},
		{
			status: evidence.cleanup.status,
			referencePrefixes: ['#/cleanup'],
		},
		{
			status: evidence.cleanup.status,
			referencePrefixes: ['#/resources', '#/cleanup'],
		},
	];
	for (const [index, item] of evidence.ac5.entries()) {
		const requirement = expected[index]!;
		if (item.status !== requirement.status) {
			context.addIssue({
				code: 'custom',
				path: ['ac5', index, 'status'],
				message: `AC-5 item ${index + 1} must match its authoritative evidence status.`,
			});
		}
		if (
			item.status === 'pass'
			&& !item.evidenceRefs.some((reference) =>
				requirement.referencePrefixes.some((prefix) =>
					reference === prefix || reference.startsWith(`${prefix}/`)
				)
			)
		) {
			context.addIssue({
				code: 'custom',
				path: ['ac5', index, 'evidenceRefs'],
				message: `AC-5 item ${index + 1} must reference its authoritative evidence section.`,
			});
		}
	}
	if (
		evidence.topology.ordinaryWindows.status === 'pass'
		&& (
			evidence.topology.ordinaryWindows.count !== 2
			|| !evidence.topology.ordinaryWindows.ordinary
			|| !evidence.topology.ordinaryWindows.sharedUserData
		)
	) {
		addInvariantIssue(context, ['topology', 'ordinaryWindows'], 'Passing topology requires two ordinary shared-profile windows.');
	}
	if (
		evidence.topology.broker.status === 'pass'
		&& evidence.topology.broker.count !== 1
	) {
		addInvariantIssue(context, ['topology', 'broker'], 'Passing topology requires exactly one Broker.');
	}
	if (
		evidence.topology.workspaceClaims.status === 'pass'
		&& (
			evidence.topology.workspaceClaims.count !== 2
			|| evidence.topology.workspaceClaims.hashes.length !== 2
			|| new Set(evidence.topology.workspaceClaims.hashes).size !== 2
			|| !evidence.topology.workspaceClaims.distinct
		)
	) {
		addInvariantIssue(context, ['topology', 'workspaceClaims'], 'Passing topology requires two distinct Workspace claim hashes.');
	}
	if (
		evidence.needsInput.status === 'pass'
		&& (
			evidence.needsInput.taskId === undefined
			|| evidence.needsInput.compactStatus !== 1
			|| evidence.needsInput.inputId === undefined
			|| !evidence.needsInput.questionPresent
			|| !orderedSubsequence(
				evidence.needsInput.eventTypes,
				['inputRequired', 'inputAnswered', 'completed'],
			)
			|| !evidence.needsInput.answerTaskIdMatched
			|| !evidence.needsInput.answerInputIdMatched
			|| !evidence.needsInput.resumed
			|| evidence.needsInput.terminalState !== 'completed'
			|| !evidence.needsInput.leaseReleased
		)
	) {
		addInvariantIssue(context, ['needsInput'], 'Passing needs-input evidence requires exact answer routing, completion, and lease release.');
	}
	if (
		evidence.cancellation.status === 'pass'
		&& (
			evidence.cancellation.taskId === undefined
			|| evidence.cancellation.compactStatus !== 3
			|| evidence.cancellation.reason !== 'token'
			|| evidence.cancellation.terminalState !== 'cancelled'
			|| !orderedSubsequence(
				evidence.cancellation.eventTypes,
				['agentStarted', 'cancelRequested', 'cancelConfirmed'],
			)
			|| !evidence.cancellation.leaseReleased
		)
	) {
		addInvariantIssue(context, ['cancellation'], 'Passing cancellation evidence requires authoritative token cancellation and lease release.');
	}
	if (
		evidence.timeout.status === 'pass'
		&& (
			evidence.timeout.taskId === undefined
			|| evidence.timeout.compactStatus !== 3
			|| evidence.timeout.reason !== 'budget'
			|| !['cancelled', 'failed'].includes(evidence.timeout.terminalState)
			|| !evidence.timeout.eventTypes.includes('cancelRequested')
			|| (
				evidence.timeout.terminalState === 'cancelled'
				&& !evidence.timeout.eventTypes.includes('cancelConfirmed')
			)
			|| !evidence.timeout.leaseReleased
		)
	) {
		addInvariantIssue(context, ['timeout'], 'Passing timeout evidence requires budget cancellation, authoritative terminal state, and lease release.');
	}
	if (
		evidence.sessionVisibility.hostSessionEchoObserved
		&& (
			evidence.sessionVisibility.source !== 'editor'
			|| evidence.sessionVisibility.hostSessionHash === undefined
			|| evidence.sessionVisibility.editorEndpointFingerprint === undefined
		)
	) {
		addInvariantIssue(context, ['sessionVisibility'], 'A Host Session echo requires an editor source, channel hash, and endpoint fingerprint.');
	}
	if (
		evidence.sessionVisibility.status === 'pass'
		&& (
			evidence.sessionVisibility.source !== 'editor'
			|| !evidence.sessionVisibility.hostSessionEchoObserved
			|| !evidence.sessionVisibility.clientDetachedObserved
			|| !evidence.sessionVisibility.catalogAfterTerminalCleanup
			|| !evidence.sessionVisibility.catalogSessionHashMatched
			|| !evidence.sessionVisibility.uiObserved
			|| evidence.sessionVisibility.catalogAfter < 1
		)
	) {
		addInvariantIssue(context, ['sessionVisibility'], 'Passing O1 evidence requires editor catalog and objective UI observation.');
	}
	if (
		evidence.experiments[0].status !== evidence.sessionVisibility.status
		|| (
			evidence.experiments[0].status === 'pass'
			&& evidence.experiments[0].conclusion !== 'editor-session-visible'
		)
	) {
		addInvariantIssue(context, ['experiments', 0], 'O1 must match the recorded editor Session visibility evidence.');
	}
	if (
		evidence.experiments[1].status === 'pass'
		&& (
			evidence.experiments[1].conclusion !== 'sixty-minutes-observed'
			|| evidence.experiments[1].observedDurationMs < 60 * 60_000
		)
	) {
		addInvariantIssue(context, ['experiments', 1], 'O2 may pass only after a full 60-minute observed Tool call.');
	}
	if (
		evidence.cleanup.status === 'pass'
		&& Object.values(evidence.resources).some(({ baselineOwned }) => baselineOwned !== 0)
	) {
		addInvariantIssue(context, ['resources'], 'Harness-owned resource baselines must be zero before a passing run.');
	}
}

function addInvariantIssue(
	context: z.RefinementCtx,
	path: PropertyKey[],
	message: string,
): void {
	context.addIssue({ code: 'custom', path, message });
}

function orderedSubsequence(values: readonly string[], required: readonly string[]): boolean {
	let index = -1;
	for (const value of required) {
		index = values.indexOf(value, index + 1);
		if (index < 0) {
			return false;
		}
	}
	return true;
}

function strictlyContiguous(values: readonly number[]): boolean {
	return values.every((value, index) =>
		index === 0 || value === values[index - 1]! + 1);
}

function strictlyIncreasing(values: readonly number[]): boolean {
	return values.every((value, index) =>
		index === 0 || value > values[index - 1]!);
}

function deriveOutcome(evidence: {
	readonly ac5: readonly { readonly status: 'pass' | 'fail' | 'unverified' }[];
	readonly topology: {
		readonly ordinaryWindows: { readonly status: 'pass' | 'fail' | 'unverified' };
		readonly broker: { readonly status: 'pass' | 'fail' | 'unverified' };
		readonly workspaceClaims: { readonly status: 'pass' | 'fail' | 'unverified' };
	};
	readonly doubleGate: { readonly status: 'pass' | 'fail' | 'unverified' };
	readonly confirmation: { readonly status: 'pass' | 'fail' | 'unverified' };
	readonly completion: { readonly status: 'pass' | 'fail' | 'unverified' };
	readonly needsInput: { readonly status: 'pass' | 'fail' | 'unverified' };
	readonly cancellation: { readonly status: 'pass' | 'fail' | 'unverified' };
	readonly timeout: { readonly status: 'pass' | 'fail' | 'unverified' };
	readonly transport: { readonly status: 'pass' | 'fail' | 'unverified' };
	readonly cleanup: { readonly status: 'pass' | 'fail' | 'unverified' };
	readonly resources: Readonly<Record<string, { readonly finalOwned: number }>>;
	readonly cleanupFailures?: readonly unknown[];
	readonly failure?: unknown;
}): 'pass' | 'fail' | 'unverified' {
	if (evidence.failure !== undefined || (evidence.cleanupFailures?.length ?? 0) > 0) {
		return 'fail';
	}
	const required = [
		...evidence.ac5.map(({ status: itemStatus }) => itemStatus),
		evidence.topology.ordinaryWindows.status,
		evidence.topology.broker.status,
		evidence.topology.workspaceClaims.status,
		evidence.doubleGate.status,
		evidence.confirmation.status,
		evidence.completion.status,
		evidence.needsInput.status,
		evidence.cancellation.status,
		evidence.timeout.status,
		evidence.transport.status,
		evidence.cleanup.status,
	];
	if (Object.values(evidence.resources).some(({ finalOwned }) => finalOwned !== 0)) {
		return 'fail';
	}
	if (required.includes('fail')) {
		return 'fail';
	}
	return required.every((itemStatus) => itemStatus === 'pass') ? 'pass' : 'unverified';
}

function assertEvidenceContentSafe(value: unknown): void {
	const pending: Array<{ readonly value: unknown; readonly path: string }> = [{
		value,
		path: '#',
	}];
	let visited = 0;
	while (pending.length > 0) {
		const current = pending.pop()!;
		visited += 1;
		if (visited > 20_000) {
			throw new TypeError('Peer-delegation evidence exceeds the safe node limit.');
		}
		if (typeof current.value === 'string') {
			assertSafeString(current.value, current.path);
			continue;
		}
		if (Array.isArray(current.value)) {
			for (const [index, child] of current.value.entries()) {
				pending.push({ value: child, path: `${current.path}/${index}` });
			}
			continue;
		}
		if (typeof current.value !== 'object' || current.value === null) {
			continue;
		}
		for (const [key, child] of Object.entries(current.value)) {
			if (forbiddenEvidenceKeys.has(key)) {
				throw new TypeError(`Peer-delegation evidence contains forbidden field ${current.path}/${key}.`);
			}
			pending.push({ value: child, path: `${current.path}/${key}` });
		}
	}
}

const forbiddenEvidenceKeys = new Set([
	'connectionToken',
	'credential',
	'credentials',
	'projectPath',
	'prompt',
	'rawOutput',
	'rawPrompt',
	'secret',
	'socketPath',
	'token',
	'userDataDir',
	'userDataPath',
	'workspaceIdentity',
	'workspacePath',
]);

function assertSafeString(value: string, path: string): void {
	if (Buffer.byteLength(value, 'utf8') > 2_048) {
		throw new TypeError(`Peer-delegation evidence string is oversized at ${path}.`);
	}
	const unsafePatterns = [
		/(?:^|[\s"'(])\/[A-Za-z0-9._~-]+(?:\/[^\s"'()]*)?/u,
		/(?:^|[\s"'(])\/(?:Applications|Users|Volumes|etc|home|opt|private|tmp|usr|var)(?:\/|$)/u,
		/(?:^|[\s"'(])[A-Za-z]:[\\/]/u,
		/(?:^|[\s"'(])\\\\[^\\\s]+\\/u,
		/\bfile:/iu,
		/\bsha256:[A-Za-z0-9_-]{43}\b/u,
		/\b(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{8,}\b/u,
		/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
		/-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
		/[?&]tkn=/iu,
	];
	if (unsafePatterns.some((pattern) => pattern.test(value))) {
		throw new TypeError(`Peer-delegation evidence contains unsafe content at ${path}.`);
	}
}

function resolveJsonPointer(value: unknown, reference: string): unknown {
	let current = value;
	for (const raw of reference.slice(2).split('/')) {
		const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~');
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
				return undefined;
			}
			current = current[index];
		} else if (typeof current === 'object' && current !== null && segment in current) {
			current = (current as Record<string, unknown>)[segment];
		} else {
			return undefined;
		}
	}
	return current;
}
