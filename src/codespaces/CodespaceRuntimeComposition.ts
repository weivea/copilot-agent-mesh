import type * as vscode from 'vscode';
import { join } from 'node:path';

import {
	AgentRuntimeApprovalCapabilityIssuer,
	type AgentRuntimeLifecycleObserver,
	type WorkspaceResolver,
} from '../agentHost/AgentRuntime';
import { CodespaceOwnedAgentRuntime } from '../agentHost/CodespaceOwnedAgentRuntime';
import { VscodeAuthBroker, type AuthenticationMapping, type ProtectedResource } from '../agentHost/AuthBroker';
import { SdkAhpConnectionFactory } from '../agentHost/AhpAgentRuntime';
import {
	resolveAuthenticationProvider,
	VscodeLocalTaskApproval,
	VscodeSessionConfigurationResolver,
} from '../composition/VscodeAgentRuntime';
import { VscodeGlobalStateStore } from '../storage/VscodeStorageAdapters';
import { ConfiguredCodespaceLauncher } from './ConfiguredCodespaceLauncher';
import { canonicalCodespaceStorageBase } from './CodespaceStorage';

export async function resolveCodespaceAuthenticationProvider(
	api: typeof vscode,
	resource: ProtectedResource,
): Promise<AuthenticationMapping | undefined> {
	const configured = await resolveAuthenticationProvider(api, resource);
	if (configured !== undefined) {
		return configured;
	}
	return resource.resource === 'https://api.github.com'
		? { providerId: 'github', scopes: ['read:user', 'user:email'] }
		: undefined;
}

export async function createCodespaceRuntime(
	api: typeof vscode,
	context: vscode.ExtensionContext,
	workspaceResolver: WorkspaceResolver,
	resolveCli: () => Promise<string | undefined>,
	lifecycleObserver?: AgentRuntimeLifecycleObserver,
): Promise<{
	readonly runtime: CodespaceOwnedAgentRuntime;
	readonly approvalCapabilities: AgentRuntimeApprovalCapabilityIssuer;
}> {
	const storageBase = await canonicalCodespaceStorageBase(context.globalStorageUri.fsPath);
	const approvalCapabilities = new AgentRuntimeApprovalCapabilityIssuer();
	const runtime = new CodespaceOwnedAgentRuntime({
		enabled: () => api.workspace.isTrusted,
		workspaceResolver,
		approvalCapabilities,
		confirmation: new VscodeLocalTaskApproval(api, new VscodeGlobalStateStore(context.globalState)),
		configResolver: new VscodeSessionConfigurationResolver(api),
		authBroker: new VscodeAuthBroker(api.authentication, (resource) =>
			resolveCodespaceAuthenticationProvider(api, resource)),
		launcher: new ConfiguredCodespaceLauncher(
			resolveCli,
			join(storageBase, 'agent-host'),
		),
		connections: new SdkAhpConnectionFactory(),
		lifecycleObserver,
	});
	return { runtime, approvalCapabilities };
}
