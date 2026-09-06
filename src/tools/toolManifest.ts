export const MESH_TOOL_NAMES = {
	listWorkers: 'mesh_list_workers',
	delegateTask: 'mesh_delegate_task',
	getTask: 'mesh_get_task',
	cancelTask: 'mesh_cancel_task',
	answerTask: 'mesh_answer_task',
	listTasks: 'mesh_list_tasks',
} as const;

export type MeshToolName = typeof MESH_TOOL_NAMES[keyof typeof MESH_TOOL_NAMES];

export interface ToolManifestDescriptor {
	readonly name: MeshToolName;
	readonly displayName: string;
	readonly toolReferenceName: string;
	readonly canBeReferencedInPrompt: true;
	readonly modelDescription: string;
	readonly userDescription: string;
	readonly tags: readonly string[];
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

const idSchema = {
	type: 'string',
	minLength: 36,
	maxLength: 36,
	pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
} as const;

export const MESH_TOOL_MANIFEST_DESCRIPTORS: readonly ToolManifestDescriptor[] = [
	{
		name: MESH_TOOL_NAMES.listWorkers,
		displayName: 'List Mesh Targets',
		toolReferenceName: 'meshListWorkers',
		canBeReferencedInPrompt: true,
		modelDescription: 'Find authorized Device -> Window -> Workspace targets for delegation. Use scope=local for same-device work without remote requests, remote for paired devices, or all (default). Prefer the returned targetHandle with mesh_delegate_task; legacy exact IDs remain supported. Handles are temporary, window-scoped selection references, not execution grants; re-list stale targets instead of matching names. Results contain safe metadata, not paths or secrets. status=partial and issues explicitly identify a failed scope while preserving available targets. A listed or allowed target is not proof that its Agent runtime is available.',
		userDescription: 'Find authorized windows and Workspaces on this device or paired devices.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				scope: { type: 'string', enum: ['local', 'remote', 'all'], default: 'all', description: 'Choose the discovery scope. local never requests remote directories.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.delegateTask,
		displayName: 'Delegate Mesh Task',
		toolReferenceName: 'meshDelegateTask',
		canBeReferencedInPrompt: true,
		modelDescription: 'Delegate one task to targetHandle from mesh_list_workers, or the legacy explicit target IDs, never both. mode=wait (default) waits for completion, input, failure or cancellation. mode=submit returns after durable acceptance so other targets can be scheduled; accepted is NOT completed. Use mesh_get_task with waitFor=outcome to resume waiting. After submit returns, stopping Chat does not cancel the task: use mesh_cancel_task. Omit delegationRequestId for fresh work; reuse it only for identical target/title/prompt/criteria/execution-timeout semantics. mode does not change execution identity. Readable results include outcome, taskId, delegationRequestId, taskState and nextAction. outcome describes this call; taskState describes proven task state, or unknown. Budget fallback uses s=0 completed, 1 needsInput, 2 failed call, 3 cancelled call, 4 accepted, with t/d IDs and optional taskState. Preserve IDs for recovery; do not infer task completion from acceptance or cancellation intent. Execution timeout defaults to and is capped at 60 minutes. Sensitive operations still require parent input. Do not use this tool for Git, branch, worktree, commit, push or pull request management.',
		userDescription: 'Delegate to a target Workspace; wait for the result or submit and continue coordinating.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				targetHandle: {
					type: 'string', minLength: 32, maxLength: 32, pattern: '^[A-Za-z0-9_-]{32}$',
					description: 'Preferred temporary selection reference from mesh_list_workers. Do not combine it with explicit target IDs.',
				},
				mode: { type: 'string', enum: ['wait', 'submit'], default: 'wait', description: 'wait preserves completion-wait behavior. submit returns after durable acceptance; use get/wait or explicit cancel afterward.' },
				delegationRequestId: { ...idSchema, description: 'Optional invocation identity. Omit for fresh work; reuse only for an exact execution retry. Changed semantics return IDEMPOTENCY_CONFLICT.' },
				deviceId: { ...idSchema, description: 'Explicit opaque target device ID returned by mesh_list_workers.' },
				nodeId: { ...idSchema, description: 'Explicit opaque target node ID returned by mesh_list_workers.' },
				nodeInstanceId: { ...idSchema, description: 'Explicit target node instance ID returned by mesh_list_workers.' },
				workspaceId: { ...idSchema, description: 'Opaque workspace ID returned by mesh_list_workers.' },
				peerId: { ...idSchema, description: 'Optional internal routing metadata for a remote device; it does not replace explicit target IDs.' },
				title: { type: 'string', minLength: 1, maxLength: 256, description: 'Short task title (maximum 256 UTF-8 bytes).' },
				prompt: { type: 'string', minLength: 1, maxLength: 131072, description: 'Exact task prompt (maximum 128 KiB UTF-8).' },
				acceptanceCriteria: {
					type: 'array',
					maxItems: 32,
					items: { type: 'string', minLength: 1, maxLength: 4096 },
					description: 'Optional acceptance criteria; each item is limited to 4 KiB UTF-8.',
				},
				timeoutMinutes: { type: 'integer', minimum: 1, maximum: 60, default: 60 },
			},
			required: ['title', 'prompt'],
			oneOf: [
				{ required: ['targetHandle'], not: { anyOf: ['deviceId', 'nodeId', 'nodeInstanceId', 'workspaceId', 'peerId'].map((key) => ({ required: [key] })) } },
				{ required: ['deviceId', 'nodeId', 'nodeInstanceId', 'workspaceId'], not: { required: ['targetHandle'] } },
			],
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.getTask,
		displayName: 'Get Mesh Task',
		toolReferenceName: 'meshGetTask',
		canBeReferencedInPrompt: true,
		modelDescription: 'Read a bounded owned-task snapshot, or reattach after submission, an answer or interrupted delegation. waitFor=snapshot (default) reads once; change waits for an update; outcome waits for needsInput or terminal state. Event-driven waits avoid polling. waitSeconds defaults to 60 and is capped at 3600; initial/final reads also have bounded request deadlines. Cancelling or timing out this read-only wait never cancels the task. waitOutcome and snapshotIsLastRead explicitly distinguish a finished wait from an older snapshot; inspect snapshot.status, not the success of this query, for task state. Event gaps/truncation are explicit. Use mesh_cancel_task for cancellation.',
		userDescription: 'Inspect a task or wait for its next input or result without restarting it.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				taskId: { ...idSchema, description: 'Task ID returned by mesh_delegate_task.' },
				afterEventSequence: { type: 'integer', minimum: 0 },
				maxEvents: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
				waitFor: { type: 'string', enum: ['snapshot', 'change', 'outcome'], default: 'snapshot' },
				waitSeconds: { type: 'integer', minimum: 1, maximum: 3600, description: 'Event-wait budget, default 60 seconds for change/outcome only. Expiry stops waiting, not task execution.' },
			},
			required: ['taskId'],
			oneOf: [
				{ properties: { waitFor: { enum: ['snapshot'] } }, not: { required: ['waitSeconds'] } },
				{ required: ['waitFor'], properties: { waitFor: { enum: ['change', 'outcome'] } } },
			],
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.cancelTask,
		displayName: 'Cancel Mesh Task',
		toolReferenceName: 'meshCancelTask',
		canBeReferencedInPrompt: true,
		modelDescription: 'Explicitly request cancellation of a task owned by this window. A receipt may still say cancelling: it is not proof of cancelled state; use mesh_get_task to observe the authoritative result. Delegate wait-mode token cancellation and execution-budget expiry also request task cancellation. Stopping a read-only get/wait, or stopping Chat after submit returned, does not.',
		userDescription: 'Request cancellation of a delegated task.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				taskId: { ...idSchema, description: 'Owned task ID to cancel.' },
			},
			required: ['taskId'],
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.answerTask,
		displayName: 'Answer Mesh Task',
		toolReferenceName: 'meshAnswerTask',
		canBeReferencedInPrompt: true,
		modelDescription: 'Answer the exact pending question or approval request of an owned task, using taskId and inputId from the latest result (compact fallback t/i), plus a stable caller-generated answerId for exact retries. The native confirmation shows the current question and a safe answer preview. An answer receipt is not task completion: continue with mesh_get_task(waitFor=outcome) using the same taskId. Do not invent an input ID or approve future requests.',
		userDescription: 'Send an answer to a delegated task that is waiting for input.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				taskId: { ...idSchema, description: 'Owned task ID waiting for input.' },
				inputId: { ...idSchema, description: 'Exact pending input ID returned by delegate or get/wait.' },
				answerId: { ...idSchema, description: 'Stable answer ID used for idempotent retries.' },
				answer: { type: 'string', minLength: 1, maxLength: 32768, description: 'Answer text (maximum 32 KiB UTF-8).' },
			},
			required: ['taskId', 'inputId', 'answerId', 'answer'],
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.listTasks,
		displayName: 'List My Mesh Tasks',
		toolReferenceName: 'meshListTasks',
		canBeReferencedInPrompt: true,
		modelDescription: 'Recover task IDs owned by this current authenticated window, including several submitted tasks. Reads the local task index/cache only; no remote refresh, authentication or execution. It never lists tasks merely sharing a repo, incoming peer-owned tasks or another window owner. lastKnownState may be stale or ambiguous: use mesh_get_task for authoritative state. Defaults to active tasks, limit=20; includeTerminal adds history, and nextBeforeTaskId pages older owned entries. Reopening a repo under a new window identity does not transfer task ownership.',
		userDescription: 'Find this window’s delegated tasks and recover their IDs.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
				includeTerminal: { type: 'boolean', default: false },
				beforeTaskId: { ...idSchema, description: 'Pagination cursor returned as nextBeforeTaskId by a previous list.' },
			},
			additionalProperties: false,
		},
	},
] as const;

export const MESH_RUNTIME_TOOL_NAMES: readonly MeshToolName[] = Object.values(MESH_TOOL_NAMES);
export const LEGACY_MESH_SPIKE_TOOL_NAME = 'mesh_spike_echo';

export interface MeshManifestIntegrationVerification {
	readonly integrated: boolean;
	readonly missingNames: readonly MeshToolName[];
	readonly mismatchedNames: readonly MeshToolName[];
	readonly legacySpikePresent: boolean;
}

export interface MeshColdActivationContract {
	readonly toolNames: readonly MeshToolName[];
	readonly implicitActivationEvents: readonly string[];
}

export function getMeshColdActivationContract(): MeshColdActivationContract {
	return {
		toolNames: MESH_TOOL_MANIFEST_DESCRIPTORS.map(({ name }) => name),
		implicitActivationEvents: MESH_TOOL_MANIFEST_DESCRIPTORS.map(({ name }) => `onLanguageModelTool:${name}`),
	};
}

export function assertMeshToolNameParity(
	manifestNames: readonly string[],
	runtimeNames: readonly string[] = MESH_RUNTIME_TOOL_NAMES,
): void {
	const manifest = [...manifestNames].sort();
	const runtime = [...runtimeNames].sort();
	if (JSON.stringify(manifest) !== JSON.stringify(runtime)) {
		throw new Error('Mesh language model tool manifest/runtime name mismatch.');
	}
}

/**
 * Returns a package manifest with the production descriptors installed.
 * Existing non-mesh tools are preserved; the Phase 0 spike descriptor and any
 * stale production descriptors are replaced mechanically.
 */
export function applyMeshToolManifestDescriptors(
	packageManifest: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const contributes = isRecord(packageManifest.contributes) ? packageManifest.contributes : {};
	const existing = Array.isArray(contributes.languageModelTools)
		? contributes.languageModelTools.filter((descriptor) => {
			if (!isRecord(descriptor) || typeof descriptor.name !== 'string') {
				return true;
			}
			return descriptor.name !== LEGACY_MESH_SPIKE_TOOL_NAME
				&& !MESH_RUNTIME_TOOL_NAMES.some((name) => name === descriptor.name);
		})
		: [];
	return {
		...packageManifest,
		contributes: {
			...contributes,
			languageModelTools: [...existing, ...MESH_TOOL_MANIFEST_DESCRIPTORS],
		},
	};
}

export function verifyMeshToolManifestDescriptors(
	packageManifest: unknown,
): MeshManifestIntegrationVerification {
	const manifest = isRecord(packageManifest) ? packageManifest : {};
	const contributes = isRecord(manifest.contributes) ? manifest.contributes : {};
	const descriptors = Array.isArray(contributes.languageModelTools)
		? contributes.languageModelTools.filter(isRecord)
		: [];
	const descriptorsByName = new Map(
		descriptors
			.filter((descriptor): descriptor is Record<string, unknown> & { name: string } => (
				typeof descriptor.name === 'string'
			))
			.map((descriptor) => [descriptor.name, descriptor]),
	);
	const missingNames = MESH_RUNTIME_TOOL_NAMES.filter((name) => !descriptorsByName.has(name));
	const mismatchedNames = MESH_TOOL_MANIFEST_DESCRIPTORS
		.filter((expected) => {
			const actual = descriptorsByName.get(expected.name);
			return actual !== undefined && canonicalJson(actual) !== canonicalJson(expected);
		})
		.map(({ name }) => name);
	const legacySpikePresent = descriptorsByName.has(LEGACY_MESH_SPIKE_TOOL_NAME);
	return {
		integrated: missingNames.length === 0 && mismatchedNames.length === 0 && !legacySpikePresent,
		missingNames,
		mismatchedNames,
		legacySpikePresent,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}
