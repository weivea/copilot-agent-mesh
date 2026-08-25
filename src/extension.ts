import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import { MESH_PROTOCOL_VERSION } from '../shared/protocol';
import {
	AhpAgentRuntime,
	SdkAhpConnectionFactory,
	type SessionConfigurationResolver,
} from './agentHost/AhpAgentRuntime';
import { AgentHostLauncher } from './agentHost/AgentHostLauncher';
import {
	formatSessionConfigDefault,
	parseSessionConfigInput,
	validateSessionConfigValue,
} from './agentHost/SessionConfigValue';
import {
	AgentRuntimeError,
	AgentRuntimeLifecycle,
	type AgentInputValue,
	type AgentInputRequest,
	type AgentRuntime,
	type AgentTaskAnswer,
	type FirstTaskConfirmation,
	type ResolvedAgentTaskRequest,
	type WorkspaceResolver,
} from './agentHost/AgentRuntime';
import { VscodeAuthBroker, type AuthenticationMapping } from './agentHost/AuthBroker';
import { registerMeshSpikeEchoTool } from './tools/spikeEchoTool';
import { AgentMeshViewProvider } from './ui/AgentMeshViewProvider';

const configurationSection = 'copilotAgentMesh';
const runAgentHostTaskCommand = 'copilotAgentMesh.runAgentHostTask';
const agentRuntimeLifecycle = new AgentRuntimeLifecycle();

export interface AgentMeshExtensionApi {
	readonly agentRuntime: AgentRuntime;
}

export function activate(context: vscode.ExtensionContext): AgentMeshExtensionApi {
	const output = vscode.window.createOutputChannel('Copilot Agent Mesh');
	const dashboard = new AgentMeshViewProvider();
	const agentRuntime = createAgentRuntime(context);
	agentRuntimeLifecycle.track(agentRuntime);

	const configureDevice = vscode.commands.registerCommand('copilotAgentMesh.configureDevice', async () => {
		const configuration = vscode.workspace.getConfiguration(configurationSection);
		const currentName = configuration.get<string>('deviceName', '');
		const deviceName = await vscode.window.showInputBox({
			title: 'Configure Copilot Agent Mesh Device',
			prompt: 'Choose a recognizable name for this device.',
			placeHolder: 'mac-ios',
			value: currentName,
			ignoreFocusOut: true,
			validateInput: (value) => value.trim().length > 0 ? undefined : 'A device name is required.',
		});

		if (deviceName === undefined) {
			return;
		}

		await configuration.update('deviceName', deviceName.trim(), vscode.ConfigurationTarget.Global);
		dashboard.refresh();
		output.appendLine(`Device name changed to "${deviceName.trim()}".`);
	});

	const refreshDashboard = vscode.commands.registerCommand(
		'copilotAgentMesh.refreshDashboard',
		() => dashboard.refresh(),
	);
	const runAgentHostTask = vscode.commands.registerCommand(runAgentHostTaskCommand, async () => {
		try {
			const workspace = vscode.workspace.workspaceFolders?.find(({ uri }) => uri.scheme === 'file');
			if (workspace === undefined) {
				throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'Open a local file workspace before starting an Agent Host task.');
			}
			const prompt = await vscode.window.showInputBox({
				title: 'Run Copilot Agent Mesh Task',
				prompt: 'Describe the task to run in this workspace.',
				ignoreFocusOut: true,
			});
			if (prompt === undefined || prompt.trim().length === 0) {
				return;
			}
			const handle = await agentRuntime.start({
				taskId: randomUUID(),
				title: prompt.trim().slice(0, 80),
				prompt: prompt.trim(),
				workspaceId: workspace.uri.toString(),
				allowInteractiveAuthentication: true,
			});
			void consumeTask(handle, output).catch((error: unknown) => {
				const message = error instanceof AgentRuntimeError
					? `${error.code}: ${error.message}`
					: 'The Agent Host task stopped unexpectedly.';
				output.appendLine(`\n${message}`);
				void vscode.window.showErrorMessage(message);
			});
		} catch (error) {
			const message = error instanceof AgentRuntimeError
				? `${error.code}: ${error.message}`
				: 'The Agent Host task could not be started.';
			void vscode.window.showErrorMessage(message);
		}
	});

	const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(`${configurationSection}.deviceName`)) {
			dashboard.refresh();
		}
	});

	context.subscriptions.push(
		output,
		registerMeshSpikeEchoTool(),
		vscode.window.registerWebviewViewProvider(AgentMeshViewProvider.viewType, dashboard),
		configureDevice,
		refreshDashboard,
		runAgentHostTask,
		configurationListener,
		vscode.workspace.onDidChangeWorkspaceFolders(() => dashboard.refresh()),
		{
			dispose: () => void agentRuntimeLifecycle.dispose().catch((error: unknown) => {
				const message = error instanceof AgentRuntimeError
					? `${error.code}: ${error.message}`
					: 'Agent Host runtime cleanup failed.';
				output.appendLine(message);
			}),
		},
	);

	output.appendLine(`Copilot Agent Mesh activated with protocol v${MESH_PROTOCOL_VERSION}.`);
	return { agentRuntime };
}

export async function deactivate(): Promise<void> {
	await agentRuntimeLifecycle.dispose();
}

function createAgentRuntime(context: vscode.ExtensionContext): AgentRuntime {
	const configuration = vscode.workspace.getConfiguration(configurationSection);
	const launcher = new AgentHostLauncher({
		storageRoot: vscode.Uri.joinPath(context.globalStorageUri, 'agent-host').fsPath,
		configuredCodeCli: configuration.get<string>('codePath') || undefined,
	});
	return new AhpAgentRuntime({
		enabled: () => vscode.workspace
			.getConfiguration(configurationSection)
			.get<boolean>('experimental.agentHost', false),
		launcher,
		connections: new SdkAhpConnectionFactory(),
		authBroker: new VscodeAuthBroker(vscode.authentication, resolveAuthenticationProvider),
		confirmation: new VscodeFirstTaskConfirmation(),
		workspaceResolver: new VscodeWorkspaceResolver(),
		configResolver: new VscodeSessionConfigurationResolver(),
	});
}

class VscodeFirstTaskConfirmation implements FirstTaskConfirmation {
	async confirm(request: ResolvedAgentTaskRequest): Promise<'once' | 'deny'> {
		const choice = await vscode.window.showWarningMessage(
			`Allow Copilot Agent Mesh to run "${request.title}" in ${request.workspace.displayName}?`,
			{ modal: true, detail: 'The agent may modify files and run commands in this workspace.' },
			'Run Once',
		);
		return choice === 'Run Once' ? 'once' : 'deny';
	}
}

class VscodeWorkspaceResolver implements WorkspaceResolver {
	async resolve(workspaceId: string) {
		const workspace = vscode.workspace.workspaceFolders?.find(({ uri }) =>
			uri.scheme === 'file' && uri.toString() === workspaceId,
		);
		return workspace === undefined
			? undefined
			: {
				workspaceId,
				displayName: workspace.name,
				uri: workspace.uri.toString(),
			};
	}
}

class VscodeSessionConfigurationResolver implements SessionConfigurationResolver {
	async resolve(request: Parameters<SessionConfigurationResolver['resolve']>[0]): Promise<Readonly<Record<string, unknown>>> {
		const values: Record<string, unknown> = { ...request.values };
		for (const id of request.schema.required ?? []) {
			if (values[id] !== undefined) {
				continue;
			}
			const property = request.schema.properties[id];
			if (property === undefined) {
				throw new AgentRuntimeError('AGENT_CONFIG_REQUIRED', `Agent configuration property "${id}" is unavailable.`);
			}
			if (property.readOnly === true) {
				throw new AgentRuntimeError(
					'AGENT_CONFIG_REQUIRED',
					`Agent configuration property "${id}" is read-only and has no resolved value.`,
				);
			}
			const choices = property.enumDynamic === true
				? await request.completions(id, values)
				: property.enum?.map((value, index) => ({
					value,
					label: property.enumLabels?.[index] ?? String(value),
				}));
			if (choices !== undefined && choices.length > 0) {
				const selected = await vscode.window.showQuickPick(
					choices.map((choice) => ({ label: choice.label, value: choice.value })),
					{ title: property.title, ignoreFocusOut: true },
				);
				if (selected === undefined) {
					throw new AgentRuntimeError('AGENT_CONFIG_REQUIRED', 'Agent session configuration was cancelled.');
				}
				validateSessionConfigValue(id, property, selected.value);
				values[id] = selected.value;
				continue;
			}
			if (property.type === 'boolean') {
				const selected = await vscode.window.showQuickPick(
					[{ label: 'Yes', value: true }, { label: 'No', value: false }],
					{ title: property.title, ignoreFocusOut: true },
				);
				if (selected === undefined) {
					throw new AgentRuntimeError('AGENT_CONFIG_REQUIRED', 'Agent session configuration was cancelled.');
				}
				validateSessionConfigValue(id, property, selected.value);
				values[id] = selected.value;
				continue;
			}
			const entered = await vscode.window.showInputBox({
				title: property.title,
				prompt: property.description,
				value: formatSessionConfigDefault(id, property),
				ignoreFocusOut: true,
			});
			if (entered === undefined) {
				throw new AgentRuntimeError('AGENT_CONFIG_REQUIRED', 'Agent session configuration was cancelled.');
			}
			values[id] = parseSessionConfigInput(id, property, entered);
		}
		return values;
	}
}

async function resolveAuthenticationProvider(resource: {
	readonly resource: string;
	readonly authorization_servers?: readonly string[];
}): Promise<AuthenticationMapping | undefined> {
	const mappings = vscode.workspace.getConfiguration(configurationSection).get<Record<string, AuthenticationMapping>>(
		'experimental.authenticationProviders',
		{},
	);
	for (const key of [resource.resource, ...(resource.authorization_servers ?? [])]) {
		const mapping = mappings[key];
		if (mapping !== undefined
			&& typeof mapping.providerId === 'string'
			&& Array.isArray(mapping.scopes)
			&& mapping.scopes.every((scope) => typeof scope === 'string')) {
			return mapping;
		}
	}
	return undefined;
}

async function consumeTask(
	handle: Awaited<ReturnType<AgentRuntime['start']>>,
	output: vscode.OutputChannel,
): Promise<void> {
	output.show(true);
	try {
		for await (const event of handle.events) {
			switch (event.type) {
				case 'output':
					output.append(event.text);
					break;
				case 'inputRequired':
					await answerTaskInput(handle, event.request);
					break;
				case 'failed':
					output.appendLine(`\n${event.error.code}: ${event.error.message}`);
					break;
				default:
					output.appendLine(`[${event.type}] ${'message' in event ? event.message : ''}`);
			}

			async function answerTaskInput(
				handle: Awaited<ReturnType<AgentRuntime['start']>>,
				request: AgentInputRequest,
			): Promise<void> {
				while (true) {
					const answer = await requestTaskAnswer(request);
					try {
						await handle.answer(answer);
						return;
					} catch (error) {
						const message = error instanceof AgentRuntimeError
							? `${error.code}: ${error.message}`
							: 'The Agent Host rejected the answer.';
						await vscode.window.showErrorMessage(message);
						if (answer.outcome !== 'accept') {
							throw error;
						}
					}
				}
			}
		}
	} finally {
		await handle.dispose();
	}
}

async function requestTaskAnswer(request: AgentInputRequest): Promise<AgentTaskAnswer> {
	if (request.kind === 'toolAuthentication') {
		const choice = await vscode.window.showWarningMessage(request.prompt, { modal: true }, 'Authenticate');
		return { requestId: request.requestId, outcome: choice === 'Authenticate' ? 'accept' : 'decline' };
	}
	if (request.kind === 'toolConfirmation') {
		if (request.options !== undefined && request.options.length > 0) {
			const selected = await vscode.window.showQuickPick(
				request.options.map((option) => ({
					label: option.label,
					option,
				})),
				{ title: request.prompt, ignoreFocusOut: true },
			);
			return selected === undefined
				? { requestId: request.requestId, outcome: 'cancel' }
				: {
					requestId: request.requestId,
					outcome: selected.option.approve === true ? 'accept' : 'decline',
					selectedOptionId: selected.option.id,
				};
		}
		const choice = await vscode.window.showWarningMessage(request.prompt, { modal: true }, 'Approve', 'Deny');
		return { requestId: request.requestId, outcome: choice === 'Approve' ? 'accept' : 'decline' };
	}
	const values: Record<string, AgentInputValue> = {};
	for (const field of request.fields ?? []) {
		if (!field.required) {
			const choice = await vscode.window.showQuickPick(
				['Answer', 'Skip'],
				{ title: field.prompt, ignoreFocusOut: true },
			);
			if (choice === undefined) {
				return { requestId: request.requestId, outcome: 'cancel' };
			}
			if (choice === 'Skip') {
				continue;
			}
		}
		if (field.type === 'boolean') {
			const selected = await vscode.window.showQuickPick(
				[{ label: 'Yes', value: true }, { label: 'No', value: false }],
				{ title: field.prompt, ignoreFocusOut: true },
			);
			if (selected === undefined) {
				return { requestId: request.requestId, outcome: 'cancel' };
			}
			values[field.id] = selected.value;
			continue;
		}
		if (field.type === 'singleSelect' || field.type === 'multiSelect') {
			const freeformId = '__mesh_freeform__';
			const options = [
				...(field.options?.map((option) => ({ label: option.label, id: option.id })) ?? []),
				...(field.allowFreeformInput ? [{ label: 'Enter another value…', id: freeformId }] : []),
			];
			const selected = await vscode.window.showQuickPick(
				options,
				{ title: field.prompt, ignoreFocusOut: true, canPickMany: field.type === 'multiSelect' },
			);
			if (selected === undefined) {
				return { requestId: request.requestId, outcome: 'cancel' };
			}
			const selections = Array.isArray(selected) ? selected : [selected];
			const wantsFreeform = selections.some(({ id }) => id === freeformId);
			const selectedIds = selections.filter(({ id }) => id !== freeformId).map(({ id }) => id);
			if (wantsFreeform) {
				const freeform = await vscode.window.showInputBox({
					title: `${field.prompt}: other value`,
					ignoreFocusOut: true,
					validateInput: (value) => value.trim().length > 0 ? undefined : 'Enter a value.',
				});
				if (freeform === undefined) {
					return { requestId: request.requestId, outcome: 'cancel' };
				}
				values[field.id] = {
					selected: field.type === 'multiSelect' ? selectedIds : selectedIds[0],
					freeformValues: [freeform.trim()],
				};
			} else {
				values[field.id] = field.type === 'multiSelect' ? selectedIds : selectedIds[0] ?? '';
			}
			continue;
		}
		const entered = await vscode.window.showInputBox({
			title: field.prompt,
			ignoreFocusOut: true,
			value: field.defaultValue === undefined ? undefined : String(field.defaultValue),
			validateInput: field.type === 'number' || field.type === 'integer'
				? (value) => validateNumericField(value, field)
				: undefined,
		});
		if (entered === undefined) {
			return { requestId: request.requestId, outcome: 'cancel' };
		}
		values[field.id] = field.type === 'number' || field.type === 'integer' ? Number(entered) : entered;
	}

	function validateNumericField(
		value: string,
		field: NonNullable<AgentInputRequest['fields']>[number],
	): string | undefined {
		const number = Number(value);
		if (value.trim().length === 0) {
			return 'Enter a number.';
		}
		if (!Number.isFinite(number)) {
			return 'Enter a valid number.';
		}
		if (field.type === 'integer' && !Number.isInteger(number)) {
			return 'Enter a whole number.';
		}
		if (field.min !== undefined && number < field.min) {
			return `Enter a value of at least ${field.min}.`;
		}
		if (field.max !== undefined && number > field.max) {
			return `Enter a value no greater than ${field.max}.`;
		}
		return undefined;
	}
	return { requestId: request.requestId, outcome: 'accept', values };
}
