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
	minLength: 1,
	maxLength: 128,
} as const;

export const MESH_TOOL_MANIFEST_DESCRIPTORS: readonly ToolManifestDescriptor[] = [
	{
		name: MESH_TOOL_NAMES.listWorkers,
		displayName: 'List Mesh Workers',
		toolReferenceName: 'meshListWorkers',
		canBeReferencedInPrompt: true,
		modelDescription: 'Lists currently available Copilot Agent Mesh peers and their opaque workspaces. Call this before delegating when the target peer or workspace is not already known.',
		userDescription: 'List available remote worker devices and workspaces without exposing filesystem paths.',
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
		modelDescription: 'Delegates a coding task to a selected Copilot Agent Mesh peer and opaque workspace. Returns after worker acceptance with a pending task ID; use mesh_get_task to poll. Do not use this tool for Git, branch, worktree, commit, push, or pull request management.',
		userDescription: 'Start an asynchronous coding task on a selected trusted worker and workspace.',
		tags: ['copilot-agent-mesh'],
		inputSchema: {
			type: 'object',
			properties: {
				peerId: { ...idSchema, description: 'Opaque peer ID returned by mesh_list_workers.' },
				workspaceId: { ...idSchema, description: 'Opaque workspace ID returned by mesh_list_workers.' },
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
			required: ['peerId', 'workspaceId', 'title', 'prompt'],
			additionalProperties: false,
		},
	},
	{
		name: MESH_TOOL_NAMES.getTask,
		displayName: 'Get Mesh Task',
		toolReferenceName: 'meshGetTask',
		canBeReferencedInPrompt: true,
		modelDescription: 'Returns a bounded snapshot and event summary for an asynchronous Copilot Agent Mesh task, including event-gap and truncation indicators. Never returns a raw transcript.',
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
