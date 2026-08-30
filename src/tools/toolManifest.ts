export const MESH_TOOL_NAMES = {
	listWorkers: 'mesh_list_workers',
	delegateTask: 'mesh_delegate_task',
	getTask: 'mesh_get_task',
	cancelTask: 'mesh_cancel_task',
	answerTask: 'mesh_answer_task',
	startCollaboration: 'mesh_start_collaboration',
	getCollaboration: 'mesh_get_collaboration',
	cancelCollaboration: 'mesh_cancel_collaboration',
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

const taskTargetSchema = {
	type: 'object',
	properties: {
		deviceId: { ...idSchema, description: 'The local Device ID returned by mesh_list_workers.' },
		nodeId: { ...idSchema, description: 'An explicit local Window Node ID returned by mesh_list_workers.' },
		nodeInstanceId: { ...idSchema, description: 'The exact local Window Node instance ID.' },
		workspaceId: { ...idSchema, description: 'An explicit claimed local Workspace ID.' },
	},
	required: ['deviceId', 'nodeId', 'nodeInstanceId', 'workspaceId'],
	additionalProperties: false,
} as const;

export const MESH_TOOL_MANIFEST_DESCRIPTORS: readonly ToolManifestDescriptor[] = [
	{
		name: MESH_TOOL_NAMES.listWorkers,
		displayName: 'List Mesh Workers',
		toolReferenceName: 'meshListWorkers',
		canBeReferencedInPrompt: true,
		modelDescription: 'Lists a bounded opaque Device -> Node -> Workspace hierarchy. Call this before delegating to obtain every explicit target ID. Results contain routing/status/capability metadata only, never paths, prompts, secrets, or raw task output.',
		userDescription: 'List available mesh devices, window nodes, and workspaces without exposing filesystem paths.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.delegateTask,
		displayName: 'Delegate Mesh Task',
		toolReferenceName: 'meshDelegateTask',
		canBeReferencedInPrompt: true,
		modelDescription: 'Delegates a coding task to one explicit Device -> Node -> Workspace target from mesh_list_workers. deviceId, nodeId, nodeInstanceId, and workspaceId are always required; optional peerId is internal remote routing metadata and never replaces those IDs. Omit delegationRequestId for a fresh user invocation; the tool generates and returns one. Reuse that ID only to retry the exact same payload, which recovers the same task; the same ID with a different payload conflicts. Returns after durable broker acceptance and before Agent startup completes with a pending task ID; use mesh_get_task to poll startup and terminal outcomes. Under a small token budget, compact JSON uses s state (0 accepted pending, 1 reconcile the same intent, 2 error, 3 persistence pending), t taskId, d delegationRequestId, e stable error code, and r retry/reconciliation flag; s=1 or s=3 with r=1 means retry the exact same intent and ID. Do not use this tool for Git, branch, worktree, commit, push, or pull request management.',
		userDescription: 'Start an asynchronous coding task on an explicitly selected device, node, and workspace.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				delegationRequestId: { ...idSchema, description: 'Optional invocation identity. Omit for a fresh task; reuse the returned ID only for an exact retry.' },
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
				timeoutMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
			},
			required: ['deviceId', 'nodeId', 'nodeInstanceId', 'workspaceId', 'title', 'prompt'],
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.getTask,
		displayName: 'Get Mesh Task',
		toolReferenceName: 'meshGetTask',
		canBeReferencedInPrompt: true,
		modelDescription: 'Returns a bounded snapshot and event summary for an asynchronous Copilot Agent Mesh task, including event-gap and truncation indicators. Event sequences are positive and consecutive; eventGap identifies every omitted leading event, while eventCursor always equals the last returned sequence or the requested afterEventSequence for an empty window. Recovering snapshots may retain pending input, but only needsInput snapshots expose mesh_answer_task. Failed and timedOut snapshots include safe failure code, message, and retryable fields. Never returns a raw transcript.',
		userDescription: 'Check a delegated task status and bounded results.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				taskId: { ...idSchema, description: 'Task ID returned by mesh_delegate_task.' },
				afterEventSequence: { type: 'integer', minimum: 0 },
				maxEvents: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
			},
			required: ['taskId'],
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.cancelTask,
		displayName: 'Cancel Mesh Task',
		toolReferenceName: 'meshCancelTask',
		canBeReferencedInPrompt: true,
		modelDescription: 'Requests cancellation of a task owned by this coordinator. This is the only mesh tool that turns a caller cancellation intent into a remote task cancellation request.',
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
		modelDescription: 'Answers a pending question or approval request for a task owned by this coordinator. Use the exact task and input IDs from mesh_get_task plus a stable caller-generated answer ID for idempotent retries.',
		userDescription: 'Send an answer to a delegated task that is waiting for input.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				taskId: { ...idSchema, description: 'Owned task ID waiting for input.' },
				inputId: { ...idSchema, description: 'Pending input ID returned by mesh_get_task.' },
				answerId: { ...idSchema, description: 'Stable answer ID used for idempotent retries.' },
				answer: { type: 'string', minLength: 1, maxLength: 32768, description: 'Answer text (maximum 32 KiB UTF-8).' },
			},
			required: ['taskId', 'inputId', 'answerId', 'answer'],
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.startCollaboration,
		displayName: 'Start Local Multi-project Collaboration',
		toolReferenceName: 'meshStartCollaboration',
		canBeReferencedInPrompt: true,
		modelDescription: 'Starts one durable Preview collaboration run across exactly two different claimed workspaces on the same local device. Call mesh_list_workers first and pass explicit frontend and backend Device -> Node -> Workspace targets. Omit collaborationRequestId for a fresh run; reuse the returned ID only for an exact retry. The Broker schedules backend implementation and structured contract production, frontend implementation using that exact authorized artifact, then one validation task per workspace. This path never starts a Listener or Dev Tunnel. Use mesh_get_collaboration to poll, mesh_cancel_collaboration to cancel the active task and pending dependencies, and mesh_answer_task with the active task/input IDs when input is required. Do not use this tool for Git, branch, worktree, commit, push, or pull request management.',
		userDescription: 'Start a durable same-device frontend/backend collaboration across two explicitly selected workspaces.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				collaborationRequestId: { ...idSchema, description: 'Optional exact-retry identity. Omit for a fresh collaboration.' },
				title: { type: 'string', minLength: 1, maxLength: 256, description: 'Non-sensitive collaboration title.' },
				goal: { type: 'string', minLength: 1, maxLength: 65536, description: 'Complete implementation goal, limited to 64 KiB UTF-8.' },
				frontend: { ...taskTargetSchema, description: 'Explicit frontend participant target.' },
				backend: { ...taskTargetSchema, description: 'Explicit backend participant target.' },
				timeoutMinutes: { type: 'integer', minimum: 1, maximum: 1440, default: 60 },
			},
			required: ['title', 'goal', 'frontend', 'backend'],
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.getCollaboration,
		displayName: 'Get Local Collaboration',
		toolReferenceName: 'meshGetCollaboration',
		canBeReferencedInPrompt: true,
		modelDescription: 'Returns a bounded same-device collaboration snapshot containing participant routes, dependency states, validation summaries, and immutable artifact metadata only. It never returns artifact content, raw prompts, raw output, local paths, or secrets. When a task needs input, use its taskId and inputId with mesh_answer_task.',
		userDescription: 'Inspect a durable local multi-project collaboration run.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				runId: { ...idSchema, description: 'Collaboration run ID returned by mesh_start_collaboration.' },
			},
			required: ['runId'],
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.cancelCollaboration,
		displayName: 'Cancel Local Collaboration',
		toolReferenceName: 'meshCancelCollaboration',
		canBeReferencedInPrompt: true,
		modelDescription: 'Cancels the exact active task in an owned same-device collaboration run and marks every not-yet-started dependent task cancelled. Races with authoritative task completion are reconciled without starting a duplicate task.',
		userDescription: 'Cancel a local multi-project collaboration run.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				runId: { ...idSchema, description: 'Owned collaboration run ID to cancel.' },
			},
			required: ['runId'],
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
