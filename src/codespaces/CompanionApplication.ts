import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type * as vscode from 'vscode';
import { z } from 'zod';

import { AgentRuntimeError } from '../agentHost/AgentRuntime';
import { VscodeWindowNodeTaskConfirmation } from '../composition/VscodeAgentRuntime';
import { abortable } from '../connectivity/ConnectivityOperations';
import { StructuredLogger } from '../logging/StructuredLogger';
import { WindowNodeTaskExecutor } from '../node/WindowNodeTaskExecutor';
import { NodeFileIdentityResolver } from '../workspaces/NodeFileIdentityResolver';
import {
	assertCodespaceExecutionEnvironment,
	CODESPACES_PREPARE_RUNTIME_COMMAND,
	describeCodespaceWorkspaces,
} from './CodespaceEnvironment';
import { CodespaceCliInstaller } from './CodespaceCliInstaller';
import { createCodespaceRuntime } from './CodespaceRuntimeComposition';
import { RemoteExecutionServer } from './RemoteExecutionServer';
import { canonicalCodespaceStorageBase } from './CodespaceStorage';
import { codespacePreparationFailure, CODESPACE_PREPARATION_MESSAGES, type CodespacePreparedResult } from './CodespaceSetupProtocol';
import { MeshDomainError } from '../domain/errors';
import { createNativeChatService } from './nativeChat/NativeChatService';

export interface CompanionApplication {
	dispose(): Promise<void>;
}

export function createCompanionApplication(
	api: typeof vscode,
	context: vscode.ExtensionContext,
): CompanionApplication {
	const output = api.window.createOutputChannel('Copilot Agent Mesh - Codespaces', { log: true });
	const logger = new StructuredLogger(output);
	const extensionVersion = String(context.extension.packageJSON.version);
	const quality = api.version.endsWith('-insider') ? 'insider' : 'stable';
	const lifetime = new AbortController();
	const assertAllowed = () => {
		if (lifetime.signal.aborted) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Codespaces companion is stopping.');
		}
		assertCodespaceExecutionEnvironment({
			remoteName: api.env.remoteName,
			uiKind: api.env.uiKind === api.UIKind.Desktop ? 'desktop' : 'web',
			extensionKind: context.extension.extensionKind === api.ExtensionKind.Workspace ? 'workspace' : 'ui',
			isTrusted: api.workspace.isTrusted,
			platform: process.platform,
			architecture: process.arch,
		});
	};
	let installer: Promise<CodespaceCliInstaller> | undefined;
	const getInstaller = () => installer ??= canonicalCodespaceStorageBase(context.globalStorageUri.fsPath)
		.then((base) => new CodespaceCliInstaller({
			storageRoot: join(base, 'native-cli'),
			platform: process.platform,
			architecture: process.arch,
			version: api.version,
			quality,
			signal: lifetime.signal,
		})).catch((error: unknown) => {
			installer = undefined;
			throw error;
		});
	const identityResolver = new NodeFileIdentityResolver();
	const nativeChat = createNativeChatService(api, context, (error) =>
		logger.error('codespaces', 'Native Chat presentation or history is unavailable.', error));
	const server = new RemoteExecutionServer({
		extensionVersion,
		assertAllowed,
		readWorkspaces: async (authority: string) => {
			assertAllowed();
			const tags = api.workspace.getConfiguration('copilotAgentMesh')
				.get<readonly string[]>('workspace.capabilityTags', []);
			return describeCodespaceWorkspaces(authority, (api.workspace.workspaceFolders ?? []).map((folder) => ({
				uri: folder.uri.toString(), name: folder.name, capabilityTags: tags,
			})), identityResolver);
		},
		createExecutor: async (execution) => {
			const { nodeId, nodeInstanceId, nodeLabel, workspaceResolver, eventSink } = execution;
			const observation = await nativeChat.observe(execution);
			const { runtime, approvalCapabilities } = await createCodespaceRuntime(
				api, context, workspaceResolver, resolveCli,
				{ observeLifecycle: (event) => {
					if (event.eventType === 'protocol/negotiated') {
						logger.log('info', 'codespaces', 'Codespaces AHP protocol negotiated.', {
							taskId: event.taskId, source: event.source,
							offeredVersions: event.protocolOffer, selectedVersion: event.selectedProtocolVersion,
						});
					}
				} },
			);
			let lastRuntimeState: string | undefined;
			runtime.onDidSourceStatusChange((status) => {
				const failure = 'failure' in status ? status.failure : undefined;
				const state = JSON.stringify({ source: status.source, code: failure?.code, stage: failure?.stage });
				if (state !== lastRuntimeState) {
					lastRuntimeState = state;
					logger.log(failure === undefined ? 'info' : 'error', 'codespaces',
						'Codespaces Agent runtime state changed.', {
							source: status.source,
							code: failure?.code,
							stage: failure?.stage,
							detail: failure?.message,
						});
				}
			});
			const executor = new WindowNodeTaskExecutor({
				nodeId, nodeInstanceId, nodeLabel,
				executionBackend: 'codespace-owned',
				runtime: observation?.runtime(runtime) ?? runtime,
				workspaceResolver,
				approvalCapabilities,
				eventSink: observation?.eventSink(eventSink) ?? eventSink,
				observeInputAnswer: observation?.observeInputAnswer,
				confirmationHost: new VscodeWindowNodeTaskConfirmation(api),
				ids: randomUUID,
				clock: () => new Date(),
			});
			return { executor: observation?.attach(executor) ?? executor, probe: () => runtime.probe() };
		},
		reportError: (error: Error) => logger.error('codespaces', 'Codespaces execution failed safely.', error),
	});
	let setup: Promise<CodespacePreparedResult> | undefined;
	let setupFailure: unknown;
	const subscriptions = [
		api.commands.registerCommand('copilotAgentMesh.codespaces.connect', (input: unknown) => server.connect(input)),
		api.commands.registerCommand('copilotAgentMesh.codespaces.call', (input: unknown) => server.call(input)),
		api.commands.registerCommand('copilotAgentMesh.codespaces.disconnect', (input: unknown) => server.disconnect(input)),
		api.commands.registerCommand(CODESPACES_PREPARE_RUNTIME_COMMAND, (input: unknown) => {
			if (setup !== undefined) {
				return setup;
			}
			setupFailure = undefined;
			setup = prepare(input).catch(async (error: unknown) => {
				const result = codespacePreparationFailure(error);
				if (!result.ready && result.error !== undefined) {
					logger.error('codespaces', 'Runtime preparation failed.', error);
					logger.log('error', 'codespaces', 'Runtime preparation stopped before task authentication.', { code: result.error.code });
					if (input === undefined) {
						await api.window.showErrorMessage(api.l10n.t(CODESPACE_PREPARATION_MESSAGES[result.error.code]));
					}
				}
				if (error instanceof AggregateError) {
					setupFailure = error;
				}
				return result;
			}).finally(() => { setup = undefined; });
			return setup;
		}),
	];
	let disposed = false;
	return {
		dispose: async () => {
			if (disposed) {
				return;
			}
			lifetime.abort();
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			const results = await Promise.allSettled([server.dispose(), setup ?? Promise.resolve()]);
			const failures = results.flatMap((result, index) =>
				result.status === 'rejected' && !(index === 1 && isExpectedCancellation(result.reason)) ? [result.reason] : []);
			const nativeCleanup = await Promise.allSettled([nativeChat.dispose()]);
			failures.push(...nativeCleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
			if (setupFailure !== undefined) {
				failures.push(setupFailure);
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, 'Codespaces companion cleanup did not complete.');
			}
			output.dispose();
			disposed = true;
		},
	};

	async function resolveCli(): Promise<string | undefined> {
		assertAllowed();
		const configured = api.workspace.getConfiguration('copilotAgentMesh').get<string>('codespaces.codePath', '').trim();
		if (configured !== '') {
			if (!isAbsolute(configured)) {
				throw new AgentRuntimeError('AGENT_CONFIG_REQUIRED', 'The configured Codespaces native CLI path must be absolute.');
			}
			return configured;
		}
		return (await (await getInstaller()).findInstalled())?.executablePath;
	}

	async function prepare(input: unknown): Promise<CodespacePreparedResult> {
		assertAllowed();
		if (input !== undefined && !z.strictObject({ extensionVersion: z.literal(extensionVersion) }).safeParse(input).success) {
			throw new MeshDomainError('PROTOCOL_INCOMPATIBLE', 'The desktop and companion extension versions do not match.');
		}
		const accept = api.l10n.t('Download and accept license');
		const choice = await abortable(api.window.showWarningMessage(
			api.l10n.t('Download the native VS Code CLI {0} ({1}) for Mesh execution in this Codespace?', api.version, quality),
			{
				modal: true,
				detail: api.l10n.t('The runtime is installed in Mesh private storage, not on PATH. Downloading accepts the VS Code Server License Terms (https://aka.ms/vscode-server-license) and Microsoft Privacy Statement (https://privacy.microsoft.com/). No Agent task is started.'),
			},
			accept,
		), lifetime.signal);
		if (choice !== accept) {
			return { ready: false };
		}
		assertAllowed();
		await api.window.withProgress({
			location: api.ProgressLocation.Notification,
			title: api.l10n.t('Preparing Mesh Codespaces runtime'),
			cancellable: true,
		}, async (_progress, cancellation) => {
			const controller = new AbortController();
			const abort = () => controller.abort();
			lifetime.signal.addEventListener('abort', abort, { once: true });
			const subscription = cancellation.onCancellationRequested(() => controller.abort());
			if (cancellation.isCancellationRequested || lifetime.signal.aborted) {
				controller.abort();
			}
			try {
				await (await getInstaller()).install({ signal: controller.signal });
			} catch (error: unknown) {
				logger.error('codespaces', 'Native CLI preparation did not complete.', error);
				throw error;
			} finally {
				subscription.dispose();
				lifetime.signal.removeEventListener('abort', abort);
			}
		});
		return { ready: true };
	}
}

function isExpectedCancellation(error: unknown): boolean {
	return error instanceof Error && !(error instanceof AggregateError)
		&& (error.name === 'AbortError' || ('code' in error && error.code === 'CANCELLED'));
}
