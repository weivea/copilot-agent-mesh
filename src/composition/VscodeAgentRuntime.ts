import type * as vscode from 'vscode';

import {
	AhpAgentRuntime,
	SdkAhpConnectionFactory,
	type SessionConfigurationResolver,
} from '../agentHost/AhpAgentRuntime';
import { AgentHostLauncher } from '../agentHost/AgentHostLauncher';
import {
	formatSessionConfigDefault,
	parseSessionConfigInput,
	validateSessionConfigValue,
} from '../agentHost/SessionConfigValue';
import { AgentRuntimeError } from '../agentHost/AgentRuntime';
import type {
	AgentRuntime,
	AgentRuntimeProbe,
	AgentTaskHandle,
	AgentTaskRequest,
	FirstTaskConfirmation,
	ResolvedAgentTaskRequest,
	WorkspaceResolver,
} from '../agentHost/AgentRuntime';
import { VscodeAuthBroker, type AuthenticationMapping } from '../agentHost/AuthBroker';
import type { StateStore } from '../domain/ports';
import type { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import type { LocalTaskConfirmation } from '../application/RemoteTaskRunner';
import type { TaskStartParams } from '../gateway/GatewayRouter';
import type { LocalWorkspace, WorkspaceRegistry } from '../workspaces/WorkspaceRegistry';

const configurationSection = 'copilotAgentMesh';
const taskApprovalStateKey = 'copilotAgentMesh.taskApprovals';

interface TaskApprovalState {
	readonly schemaVersion: 1;
	readonly always: readonly string[];
}

export class VscodeLocalTaskApproval implements LocalTaskConfirmation, FirstTaskConfirmation {
	private readonly preapprovedTasks = new Set<string>();

	public constructor(
		private readonly vscodeApi: typeof vscode,
		private readonly state: StateStore,
	) {}

	public async confirmRuntime(
		request: ResolvedAgentTaskRequest,
	): Promise<'once' | 'deny'> {
		if (this.preapprovedTasks.delete(request.taskId)) {
			return 'once';
		}
		const choice = await this.vscodeApi.window.showWarningMessage(
			`Allow Copilot Agent Mesh to run "${request.title}" in ${request.workspace.displayName}?`,
			{ modal: true, detail: 'The agent may modify files and run commands in this workspace.' },
			'Run Once',
		);
		return choice === 'Run Once' ? 'once' : 'deny';
	}

	public confirm(
		peerId: string,
		request: TaskStartParams,
		workspace: LocalWorkspace,
	): Promise<boolean>;
	public confirm(request: ResolvedAgentTaskRequest): Promise<'once' | 'deny'>;
	public confirm(
		first: string | ResolvedAgentTaskRequest,
		request?: TaskStartParams,
		workspace?: LocalWorkspace,
	): Promise<boolean | 'once' | 'deny'> {
		if (typeof first !== 'string') {
			return this.confirmRuntime(first);
		}
		return this.confirmRemote(first, request!, workspace!);
	}

	private confirmRemote(
		peerId: string,
		request: TaskStartParams,
		workspace: LocalWorkspace,
	): Promise<boolean> {
		return this.confirmRemoteCore(peerId, request, workspace);
	}

	private async confirmRemoteCore(
		peerId: string,
		request: TaskStartParams,
		workspace: LocalWorkspace,
	): Promise<boolean> {
		const approvalKey = `${peerId}:${workspace.workspaceId}`;
		const persisted = this.read();
		if (persisted.always.includes(approvalKey)) {
			this.preapprovedTasks.add(request.taskId);
			return true;
		}
		const choice = await this.vscodeApi.window.showWarningMessage(
			`Allow Copilot Agent Mesh to run "${request.title}" in ${workspace.name}?`,
			{
				modal: true,
				detail: 'The remote agent may modify files and run commands in this registered workspace.',
			},
			'Run Once',
			'Always Allow for This Device and Workspace',
		);
		if (choice === undefined) {
			return false;
		}
		if (choice === 'Always Allow for This Device and Workspace') {
			await this.state.update(taskApprovalStateKey, {
				schemaVersion: 1,
				always: [...new Set([...persisted.always, approvalKey])],
			});
		}
		this.preapprovedTasks.add(request.taskId);
		return true;
	}

	private read(): TaskApprovalState {
		const value = this.state.get<TaskApprovalState>(taskApprovalStateKey);
		return value?.schemaVersion === 1 && Array.isArray(value.always)
			? value
			: { schemaVersion: 1, always: [] };
	}
}

export function createVscodeAgentRuntime(
	vscodeApi: typeof vscode,
	context: vscode.ExtensionContext,
	workspaces: WorkspaceRegistry,
	guard: LocalDesktopWorkspaceGuard,
	approval: FirstTaskConfirmation,
): AgentRuntime {
	const configuration = vscodeApi.workspace.getConfiguration(configurationSection);
	const launcher = new AgentHostLauncher({
		storageRoot: vscodeApi.Uri.joinPath(context.globalStorageUri, 'agent-host').fsPath,
		configuredCodeCli: configuration.get<string>('codePath') || undefined,
	});
	const runtime = new AhpAgentRuntime({
		enabled: () => vscodeApi.workspace
			.getConfiguration(configurationSection)
			.get<boolean>('experimental.agentHost', false),
		launcher,
		connections: new SdkAhpConnectionFactory(),
		authBroker: new VscodeAuthBroker(vscodeApi.authentication, (resource) =>
			resolveAuthenticationProvider(vscodeApi, resource)),
		confirmation: approval,
		workspaceResolver: new RegistryWorkspaceResolver(workspaces),
		configResolver: new VscodeSessionConfigurationResolver(vscodeApi),
	});
	return new GuardedAgentRuntime(runtime, guard);
}

class RegistryWorkspaceResolver implements WorkspaceResolver {
	public constructor(private readonly workspaces: WorkspaceRegistry) {}

	public async resolve(workspaceId: string) {
		try {
			const workspace = await this.workspaces.resolveEnabled(workspaceId);
			return {
				workspaceId: workspace.workspaceId,
				displayName: workspace.name,
				uri: workspace.localUri,
			};
		} catch {
			return undefined;
		}
	}
}

class GuardedAgentRuntime implements AgentRuntime {
	public constructor(
		private readonly delegate: AgentRuntime,
		private readonly guard: LocalDesktopWorkspaceGuard,
	) {}

	public probe(): Promise<AgentRuntimeProbe> {
		this.guard.assertAllowed({ requireWorkspace: false });
		return this.delegate.probe();
	}

	public start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		this.guard.assertAllowed();
		return this.delegate.start(request);
	}

	public dispose(): Promise<void> {
		return this.delegate.dispose();
	}
}

class VscodeSessionConfigurationResolver implements SessionConfigurationResolver {
	public constructor(private readonly vscodeApi: typeof vscode) {}

	public async resolve(
		request: Parameters<SessionConfigurationResolver['resolve']>[0],
	): Promise<Readonly<Record<string, unknown>>> {
		const values: Record<string, unknown> = { ...request.values };
		for (const id of request.schema.required ?? []) {
			if (values[id] !== undefined) {
				continue;
			}
			if (!request.interactive) {
				throw configRequired(`Agent session configuration requires interactive input for "${id}".`);
			}
			const property = request.schema.properties[id];
			if (property === undefined || property.readOnly === true) {
				throw configRequired(`Agent configuration property "${id}" cannot be configured.`);
			}
			if (property.enumDynamic === true) {
				const items = await request.completions(id, values, '');
				const selected = await this.vscodeApi.window.showQuickPick(
					items.slice(0, 100).map((item) => ({ label: item.label, value: item.value })),
					{ title: property.title, ignoreFocusOut: true },
				);
				if (selected === undefined) {
					throw configRequired('Agent session configuration was cancelled.');
				}
				validateSessionConfigValue(id, property, selected.value);
				values[id] = selected.value;
				continue;
			}
			const choices = property.enum?.map((value, index) => ({
				label: property.enumLabels?.[index] ?? String(value),
				value,
			}));
			if (choices !== undefined && choices.length > 0) {
				const selected = await this.vscodeApi.window.showQuickPick(
					choices,
					{ title: property.title, ignoreFocusOut: true },
				);
				if (selected === undefined) {
					throw configRequired('Agent session configuration was cancelled.');
				}
				validateSessionConfigValue(id, property, selected.value);
				values[id] = selected.value;
				continue;
			}
			if (property.type === 'boolean') {
				const selected = await this.vscodeApi.window.showQuickPick(
					[{ label: 'Yes', value: true }, { label: 'No', value: false }],
					{ title: property.title, ignoreFocusOut: true },
				);
				if (selected === undefined) {
					throw configRequired('Agent session configuration was cancelled.');
				}
				values[id] = selected.value;
				continue;
			}
			const entered = await this.vscodeApi.window.showInputBox({
				title: property.title,
				prompt: property.description,
				value: formatSessionConfigDefault(id, property),
				ignoreFocusOut: true,
			});
			if (entered === undefined) {
				throw configRequired('Agent session configuration was cancelled.');
			}
			values[id] = parseSessionConfigInput(id, property, entered);
		}
		return values;
	}
}

async function resolveAuthenticationProvider(
	vscodeApi: typeof vscode,
	resource: {
		readonly resource: string;
		readonly authorization_servers?: readonly string[];
	},
): Promise<AuthenticationMapping | undefined> {
	const mappings = vscodeApi.workspace.getConfiguration(configurationSection).get<Record<string, AuthenticationMapping>>(
		'experimental.authenticationProviders',
		{},
	);
	for (const key of [resource.resource, ...(resource.authorization_servers ?? [])]) {
		const mapping = mappings[key];
		if (
			mapping !== undefined
			&& typeof mapping.providerId === 'string'
			&& Array.isArray(mapping.scopes)
			&& mapping.scopes.every((scope) => typeof scope === 'string')
		) {
			return mapping;
		}

	}
	return undefined;
}

function configRequired(message: string): AgentRuntimeError {
	return new AgentRuntimeError('AGENT_CONFIG_REQUIRED', message);
}
