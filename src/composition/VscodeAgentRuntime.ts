import { createHash } from 'node:crypto';

import type * as vscode from 'vscode';

import {
	AhpAgentRuntime,
	SdkAhpConnectionFactory,
	type SessionConfigurationResolver,
} from '../agentHost/AhpAgentRuntime';
import { AgentHostLauncher } from '../agentHost/AgentHostLauncher';
import {
	AgentHostSourceSelector,
	EditorAgentHostLauncher,
} from '../agentHost/AgentHostSourceSelector';
import { EditorAgentHostLocator } from '../agentHost/EditorAgentHostLocator';
import { UnixSocketWebSocketConnector } from '../agentHost/UnixSocketWebSocketConnector';
import {
	formatSessionConfigDefault,
	parseSessionConfigInput,
	validateSessionConfigValue,
} from '../agentHost/SessionConfigValue';
import {
	AgentRuntimeApprovalCapabilityIssuer,
	AgentRuntimeError,
} from '../agentHost/AgentRuntime';
import type {
	AgentHostSourceStatus,
	AgentHostSourceStatusProvider,
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
import type { WorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import type { DelegatedToolInvocationRegistry } from '../tools/DelegatedToolInvocationRegistry';
import type { TaskStartParams } from '../gateway/GatewayRouter';
import type { LocalWorkspace } from '../workspaces/WorkspaceRegistry';
import { canonicalTaskRequestHash } from '../domain/task';
import type {
	WindowNodeTaskConfirmationHost,
	WindowNodeTaskConfirmationRequest,
	WindowNodeTaskConfirmationResult,
} from '../node/WindowNodeTaskExecutor';
import {
	disabledE2eCapability,
	isE2eCapabilityEnabled,
	type E2eCapability,
} from './E2eCapability';

const configurationSection = 'copilotAgentMesh';

export class VscodeLocalTaskApproval implements LocalTaskConfirmation, FirstTaskConfirmation {
	private readonly preapprovedTasks = new Map<string, Map<string, PreapprovedTask>>();

	public constructor(
		private readonly vscodeApi: typeof vscode,
		_state: StateStore,
		private readonly e2eCapability: E2eCapability = disabledE2eCapability,
	) {}

	public async confirmRuntime(
		request: ResolvedAgentTaskRequest,
	): Promise<'once' | 'deny'> {
		if (isE2eCapabilityEnabled(this.e2eCapability)) {
			return 'once';
		}
		const runtimeHash = runtimeApprovalHash(request);
		const approvals = this.preapprovedTasks.get(request.taskId);
		const context = request.approvalContext;
		const cacheKey = context === undefined
			? undefined
			: `${context.peerId}:${context.workspaceId}:${context.requestHash}`;
		const matching = cacheKey === undefined ? undefined : approvals?.get(cacheKey);
		if (matching !== undefined) {
			if (
				matching.peerId === context?.peerId
				&& matching.workspaceId === request.workspaceId
				&& matching.requestHash === context.requestHash
				&& matching.runtimeHash === runtimeHash
			) {
				approvals?.delete(matching.cacheKey);
				if (approvals?.size === 0) {
					this.preapprovedTasks.delete(request.taskId);
				}
				return 'once';
			}
		}
		const choice = await this.vscodeApi.window.showWarningMessage(
			`Allow Copilot Agent Mesh to run "${request.title}" in ${request.workspace.displayName}?`,
			{
				modal: true,
				detail: runtimeApprovalDetail(request),
			},
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
		if (isE2eCapabilityEnabled(this.e2eCapability)) {
			const requestHash = canonicalTaskRequestHash({
				...request,
				acceptanceCriteria: [...request.acceptanceCriteria],
				peerId,
				workspaceLeaseKey: workspace.fileIdentity,
			});
			this.cachePreapproval(request.taskId, {
				cacheKey: `${peerId}:${workspace.workspaceId}:${requestHash}`,
				peerId,
				workspaceId: workspace.workspaceId,
				requestHash,
				runtimeHash: remoteRuntimeApprovalHash(request),
			});
			return true;
		}
		const requestHash = canonicalTaskRequestHash({
			...request,
			acceptanceCriteria: [...request.acceptanceCriteria],
			peerId,
			workspaceLeaseKey: workspace.fileIdentity,
		});
		const cacheKey = `${peerId}:${workspace.workspaceId}:${requestHash}`;
		const choice = await this.vscodeApi.window.showWarningMessage(
			'Allow this remote Copilot Agent Mesh task?',
			{
				modal: true,
				detail: remoteApprovalDetail(peerId, request, workspace),
			},
			'Run Once',
		);
		if (choice !== 'Run Once') {
			return false;
		}
		this.cachePreapproval(request.taskId, {
			cacheKey,
			peerId,
			workspaceId: workspace.workspaceId,
			requestHash,
			runtimeHash: remoteRuntimeApprovalHash(request),
		});
		return true;
	}

	private cachePreapproval(taskId: string, approval: PreapprovedTask): void {
		const approvals = this.preapprovedTasks.get(taskId) ?? new Map<string, PreapprovedTask>();
		approvals.set(approval.cacheKey, approval);
		this.preapprovedTasks.set(taskId, approvals);
	}

}

export function createVscodeAgentRuntime(
	vscodeApi: typeof vscode,
	context: vscode.ExtensionContext,
	workspaceResolver: WorkspaceResolver,
	guard: LocalDesktopWorkspaceGuard,
	approval: FirstTaskConfirmation,
	workerPlatform: WorkerPlatformSupport,
	delegatedToolInvocations?: DelegatedToolInvocationRegistry,
	approvalCapabilities = new AgentRuntimeApprovalCapabilityIssuer(),
): AgentRuntime & AgentHostSourceStatusProvider {
	const configuration = vscodeApi.workspace.getConfiguration(configurationSection);
	const launcher = new AgentHostLauncher({
		storageRoot: vscodeApi.Uri.joinPath(context.globalStorageUri, 'agent-host').fsPath,
		configuredCodeCli: configuration.get<string>('codePath') || undefined,
	});
	const common = {
		enabled: () => vscodeApi.workspace
			.getConfiguration(configurationSection)
			.get<boolean>('experimental.agentHost', false),
		authBroker: new VscodeAuthBroker(vscodeApi.authentication, (resource) =>
			resolveAuthenticationProvider(vscodeApi, resource)),
		confirmation: approval,
		approvalCapabilities,
		workspaceResolver,
		configResolver: new VscodeSessionConfigurationResolver(vscodeApi),
		delegatedToolInvocations,
	};
	const standalone = new AhpAgentRuntime({
		...common,
		launcher,
		connections: new SdkAhpConnectionFactory(),
	});
	const editor = new AhpAgentRuntime({
		...common,
		launcher: new EditorAgentHostLauncher(
			new EditorAgentHostLocator({
				configuredCodeCli: configuration.get<string>('codePath') || undefined,
				configuredUserDataDir: configuration.get<unknown>('agentHost.userDataDir'),
				platform: { productName: vscodeApi.env.appName },
			}),
			new UnixSocketWebSocketConnector(),
		),
		connections: new SdkAhpConnectionFactory(),
	});
	const runtime = new AgentHostSourceSelector({
		preferEditor: () => vscodeApi.workspace
			.getConfiguration(configurationSection)
			.get<boolean>('experimental.peerDelegation', false),
		editor,
		standalone,
		confirmation: approval,
		workspaceResolver,
		approvalCapabilities,
	});
	return new GuardedAgentRuntime(runtime, guard, workerPlatform);
}

class GuardedAgentRuntime implements AgentRuntime, AgentHostSourceStatusProvider {
	public constructor(
		private readonly delegate: AgentRuntime & AgentHostSourceStatusProvider,
		private readonly guard: LocalDesktopWorkspaceGuard,
		private readonly workerPlatform: WorkerPlatformSupport,
	) {}

	public async probe(): Promise<AgentRuntimeProbe> {
		this.guard.assertAllowed({ requireWorkspace: false });
		if (!this.workerPlatform.supported) {
			return {
				available: false,
				featureEnabled: false,
				reason: this.workerPlatform.agentCode,
			};
		}
		return this.delegate.probe();
	}
	public async start(request: AgentTaskRequest): Promise<AgentTaskHandle> {
		this.guard.assertAllowed({ requireWorkspace: false });
		this.guard.assertAllowed({ requireWorkspace: false });
		if (!this.workerPlatform.supported) {
			throw new AgentRuntimeError(
				this.workerPlatform.agentCode,
				this.workerPlatform.agentMessage,
			);
		}
		this.guard.assertAllowed();
		return this.delegate.start(request);
	}

	public dispose(): Promise<void> {
		return this.delegate.dispose();
	}

	public sourceStatus(): AgentHostSourceStatus {
		return this.delegate.sourceStatus();
	}

	public onDidSourceStatusChange(listener: (status: AgentHostSourceStatus) => void): {
		dispose(): void;
	} {
		return this.delegate.onDidSourceStatusChange(listener);
	}
}

/**
 * Confirmation boundary for a task routed from one VS Code window to another.
 * The complete prompt remains in the Extension Host and is never sent to the
 * dashboard webview.
 */
export class VscodeWindowNodeTaskConfirmation implements WindowNodeTaskConfirmationHost {
	public constructor(
		private readonly vscodeApi: typeof vscode,
		private readonly e2eCapability: E2eCapability = disabledE2eCapability,
	) {}

	public async confirm(
		request: WindowNodeTaskConfirmationRequest,
	): Promise<WindowNodeTaskConfirmationResult> {
		assertPromptDisplayable(request.prompt);
		if (isE2eCapabilityEnabled(this.e2eCapability)) {
			return 'once';
		}
		const selected = await this.vscodeApi.window.showWarningMessage(
			'Allow this Copilot Agent Mesh window task?',
			{
				modal: true,
				detail: [
					`Source window: ${request.sourceWindowLabel}`,
					`Target window: ${request.targetWindowLabel}`,
					`Workspace: ${request.workspaceDisplayName}`,
					`Title: ${request.taskTitle}`,
					'',
					'Full prompt:',
					request.prompt,
					'',
					'The agent may modify files and run commands in this workspace.',
				].join('\n'),
			},
			'Run Once',
		);
		return selected === 'Run Once' ? 'once' : 'deny';
	}
}

interface DynamicCompletionItem extends vscode.QuickPickItem {
	readonly completionValue: string;
}

export class VscodeSessionConfigurationResolver implements SessionConfigurationResolver {
	public constructor(
		private readonly vscodeApi: typeof vscode,
		private readonly completionDebounceMs = 150,
	) {}

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
				const value = await this.selectDynamicCompletion(
					id,
					property.title,
					values,
					request.completions,
				);
				validateSessionConfigValue(id, property, value);
				values[id] = value;
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

	private selectDynamicCompletion(
		propertyId: string,
		title: string | undefined,
		values: Readonly<Record<string, unknown>>,
		completions: Parameters<SessionConfigurationResolver['resolve']>[0]['completions'],
	): Promise<string> {
		const picker = this.vscodeApi.window.createQuickPick<DynamicCompletionItem>();
		picker.title = title;
		picker.placeholder = 'Type to search all available values';
		picker.ignoreFocusOut = true;
		picker.matchOnDescription = true;
		picker.matchOnDetail = true;
		picker.keepScrollPosition = true;
		let debounce: NodeJS.Timeout | undefined;
		const activeRequests = new Map<number, CompletionRequest>();
		let pendingRequest: CompletionRequest | undefined;
		let revision = 0;
		let settled = false;
		const subscriptions: vscode.Disposable[] = [];
		const maxInflight = 2;

		return new Promise<string>((resolve, reject) => {
			const updateBusy = (): void => {
				picker.busy = activeRequests.size > 0 || pendingRequest !== undefined;
			};
			const cleanup = (): void => {
				if (debounce !== undefined) {
					clearTimeout(debounce);
					debounce = undefined;
				}
				for (const request of activeRequests.values()) {
					request.controller.abort();
				}
				pendingRequest?.controller.abort();
				pendingRequest = undefined;
				for (const subscription of subscriptions.splice(0)) {
					subscription.dispose();
				}
				picker.dispose();
			};
			const finish = (operation: () => void): void => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				operation();
			};
			const launchLatest = (): void => {
				if (
					settled
					|| pendingRequest === undefined
					|| activeRequests.size >= maxInflight
				) {
					updateBusy();
					return;
				}
				const request = pendingRequest;
				pendingRequest = undefined;
				activeRequests.set(request.revision, request);
				updateBusy();
				void completions(
					propertyId,
					values,
					request.query,
					request.controller.signal,
				).then(
					(items) => {
						if (
							settled
							|| request.controller.signal.aborted
							|| request.revision !== revision
						) {
							return;
						}
						picker.items = items.map((item) => ({
							label: item.label,
							description: item.value === item.label ? undefined : item.value,
							completionValue: item.value,
						}));
					},
					(error: unknown) => {
						if (!request.controller.signal.aborted && request.revision === revision) {
							finish(() => reject(error));
						}
					},
				).finally(() => {
					activeRequests.delete(request.revision);
					launchLatest();
				});
			};
			const schedule = (query: string, immediate = false): void => {
				revision += 1;
				if (debounce !== undefined) {
					clearTimeout(debounce);
					debounce = undefined;
				}
				for (const request of activeRequests.values()) {
					request.controller.abort();
				}
				pendingRequest?.controller.abort();
				const request: CompletionRequest = {
					query,
					revision,
					controller: new AbortController(),
				};
				pendingRequest = request;
				updateBusy();
				debounce = setTimeout(() => {
					debounce = undefined;
					if (pendingRequest === request && !request.controller.signal.aborted) {
						launchLatest();
					}
				}, immediate ? 0 : this.completionDebounceMs);
			};

			subscriptions.push(
				picker.onDidChangeValue((query) => schedule(query)),
				picker.onDidAccept(() => {
					const selected = picker.selectedItems[0] ?? picker.activeItems[0];
					if (selected !== undefined) {
						finish(() => resolve(selected.completionValue));
					}
				}),
				picker.onDidHide(() => {
					finish(() => reject(configRequired('Agent session configuration was cancelled.')));
				}),
			);
			picker.show();
			schedule('', true);
		});
	}
}

interface CompletionRequest {
	readonly query: string;
	readonly revision: number;
	readonly controller: AbortController;
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

interface PreapprovedTask {
	readonly cacheKey: string;
	readonly peerId: string;
	readonly workspaceId: string;
	readonly requestHash: string;
	readonly runtimeHash: string;
}

function remoteApprovalDetail(
	peerId: string,
	request: TaskStartParams,
	workspace: LocalWorkspace,
): string {
	assertPromptDisplayable(request.prompt);
	return [
		`Peer: ${peerId}`,
		`Workspace: ${workspace.name} (${workspace.workspaceId})`,
		`Title: ${request.title}`,
		'',
		'Full prompt:',
		request.prompt,
		'',
		'The remote agent may modify files and run commands in this registered workspace.',
	].join('\n');
}

function runtimeApprovalDetail(request: ResolvedAgentTaskRequest): string {
	assertPromptDisplayable(request.prompt);
	return [
		`Workspace: ${request.workspace.displayName} (${request.workspaceId})`,
		`Title: ${request.title}`,
		'',
		'Full prompt:',
		request.prompt,
		'',
		'The agent may modify files and run commands in this workspace.',
	].join('\n');
}

function assertPromptDisplayable(prompt: string): void {
	if (Buffer.byteLength(prompt, 'utf8') > 128 * 1_024) {
		throw new AgentRuntimeError(
			'TASK_EXECUTION_FAILED',
			'The task prompt exceeds the safe local approval display limit.',
		);
	}
}

function remoteRuntimeApprovalHash(request: TaskStartParams): string {
	return approvalHash({
		taskId: request.taskId,
		workspaceId: request.workspaceId,
		title: request.title,
		prompt: request.prompt,
		acceptanceCriteria: request.acceptanceCriteria,
	});
}

function runtimeApprovalHash(request: ResolvedAgentTaskRequest): string {
	return approvalHash({
		taskId: request.taskId,
		workspaceId: request.workspaceId,
		title: request.title,
		prompt: request.prompt,
		acceptanceCriteria: request.acceptanceCriteria ?? [],
	});
}

function approvalHash(request: {
	readonly taskId: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly prompt: string;
	readonly acceptanceCriteria: readonly string[];
}): string {
	return createHash('sha256').update([
		request.taskId,
		request.workspaceId,
		request.title,
		request.prompt,
		String(request.acceptanceCriteria.length),
		...request.acceptanceCriteria,
	].map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join(''), 'utf8').digest('hex');
}
