export const MESH_TOOL_NAMES = {
	listWorkers: 'mesh_list_workers',
	delegateTask: 'mesh_delegate_task',
	getTask: 'mesh_get_task',
	cancelTask: 'mesh_cancel_task',
	answerTask: 'mesh_answer_task',
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
		displayName: 'List Mesh Workers',
		toolReferenceName: 'meshListWorkers',
		canBeReferencedInPrompt: true,
		modelDescription: 'In Agent mode, call this when a user asks to work in another project or VS Code window. It lists the bounded opaque Device -> Node -> Workspace targets currently authorized by the directional peer allowlist and target receive gate; use its exact IDs with mesh_delegate_task. Results contain routing/status/capability metadata only, never paths, prompts, secrets, or raw task output. Tool choice is not guaranteed, so users may explicitly reference #meshListWorkers.',
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
		modelDescription: 'In Agent mode, delegates one coding task to an explicit Device -> Node -> Workspace target from mesh_list_workers and waits in this invocation for authoritative completed, needsInput, failed, or cancelled state; normal-path mesh_get_task polling is unnecessary. Omit delegationRequestId for a fresh invocation and reuse the returned ID only for the exact same target/title/prompt/criteria/timeout semantics; conflicts return IDEMPOTENCY_CONFLICT. Compact JSON is s=0 completed with t,d,r; s=1 needsInput with t,d,i,q; s=2 failed with t,d,e; or s=3 cancelled with t,d,e,x where x is token, budget, or peer. Preserve t for recovery if the Tool host interrupts the call; use mesh_get_task only for abnormal interruption or other-task tracking. Continue grants one task only: provably confined non-control-plane structured file changes may auto-approve, while terminal, authentication, secret, publish, cross-Workspace, execution/instruction-control, and uncertain operations require parent input. The default and maximum timeout are 60 minutes. Users can explicitly select this Tool with #meshDelegateTask, but Tool selection is not guaranteed. Do not use it for Git, branch, worktree, commit, push, or pull request management.',
		userDescription: 'Delegate one coding task and wait up to 60 minutes for completion, input, failure, or cancellation.',
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
				timeoutMinutes: { type: 'integer', minimum: 1, maximum: 60, default: 60 },
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
		modelDescription: 'Returns a bounded snapshot and event summary for abnormal mesh_delegate_task interruption recovery or tracking another task. Do not poll this Tool on the normal delegation path because mesh_delegate_task waits for an authoritative outcome. Event gaps and truncation are explicit; no raw transcript is returned.',
		userDescription: 'Recover or inspect a delegated task outside the normal waiting path.',
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
		modelDescription: 'Answers a pending question or approval request for a task owned by this coordinator. Use the exact t task ID and i input ID returned by mesh_delegate_task when s=1 (or the exact IDs from mesh_get_task during recovery), plus a stable caller-generated answer ID for idempotent retries.',
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
