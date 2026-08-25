import type * as vscode from 'vscode';

import type { ListenerService } from '../application/ListenerService';
import type { WorkerTaskService } from '../application/RemoteTaskRunner';
import type { TaskCoordinator } from '../application/TaskCoordinator';
import type { AgentRuntime } from '../agentHost/AgentRuntime';
import type { DevTunnelCliProvider } from '../tunnel/DevTunnelCliProvider';
import type { ProductionDashboardBindings } from './ProductionDashboardBindings';
import {
	isE2eCapabilityEnabled,
	type E2eCapability,
	type E2eRole,
} from './E2eCapability';

export interface TwoDeviceE2eApi {
	authorize(request: { readonly nonce: string; readonly role: E2eRole }): void;
	execute(
		request: { readonly nonce: string; readonly role: E2eRole },
		action: string,
		params?: Record<string, unknown>,
	): Promise<unknown>;
}

export function createTwoDeviceE2eApi(
	vscodeApi: typeof vscode,
	bindings: ProductionDashboardBindings,
	coordinator: TaskCoordinator,
	listener: ListenerService,
	runtime: AgentRuntime,
	tunnel: DevTunnelCliProvider,
	workerTasks: WorkerTaskService,
	capability: E2eCapability,
): TwoDeviceE2eApi | undefined {
	if (!isE2eCapabilityEnabled(capability)) {
		return undefined;
	}
	const authorize = (request: { readonly nonce: string; readonly role: E2eRole }): void => {
		capability.assertRequest(request.nonce, request.role);
	};
	return {
		authorize,
		execute: async (request, action, params = {}) => {
			authorize(request);
			switch (action) {
				case 'snapshot':
					return bindings.getSnapshot();
				case 'workspace.register':
					await bindings.registerCurrentWorkspace();
					return bindings.getSnapshot();
				case 'listener.start':
					await bindings.startListener();
					return listener.snapshot();
				case 'listener.invite':
					return { connectionUrl: await bindings.createConnectionUrl() };
				case 'peer.add':
					await bindings.addPeer(requiredString(params, 'connectionUrl'));
					return bindings.getSnapshot();
				case 'directory.list': {
					const controller = deadline(10_000);
					try {
						return await coordinator.listWorkers(controller.signal);
					} finally {
						controller.abort();
					}
				}
				case 'task.start': {
					const controller = deadline(20_000);
					try {
						return await coordinator.startTask({
							peerId: requiredString(params, 'peerId'),
							workspaceId: requiredString(params, 'workspaceId'),
							title: requiredString(params, 'title'),
							prompt: requiredString(params, 'prompt'),
							acceptanceCriteria: optionalStrings(params, 'acceptanceCriteria'),
							timeoutMinutes: 5,
						}, controller.signal);
					} finally {
						controller.abort();
					}
				}
				case 'task.get': {
					const controller = deadline(10_000);
					try {
						return await coordinator.getTask({
							taskId: requiredString(params, 'taskId'),
							maxEvents: 100,
						}, controller.signal);
					} finally {
						controller.abort();
					}
				}
				case 'task.cancel': {
					const controller = deadline(10_000);
					try {
						return await coordinator.cancelOwnedTask(
							{ taskId: requiredString(params, 'taskId') },
							controller.signal,
						);
					} finally {
						controller.abort();
					}
				}
				case 'task.runtimeCancelObserved':
					return {
						observed: workerTasks.runtimeHandleCancellationObservedForE2e(
							requiredString(params, 'taskId'),
						),
					};
				case 'runtime.probe':
					return runtime.probe();
				case 'auth.check': {
					const session = await vscodeApi.authentication.getSession(
						requiredString(params, 'providerId'),
						optionalStrings(params, 'scopes'),
						{ silent: true },
					);
					return { available: session !== undefined };
				}
				case 'listener.stop':
					await bindings.stopListener();
					return listener.snapshot();
				case 'tunnel.cleanup':
					return { cleanup: await tunnel.deleteOwnedForE2e(capability) };
				case 'tunnel.metadata':
					return tunnel.ownedMetadataForE2e(capability);
				default:
					throw new Error(`Unsupported two-device E2E action: ${action}`);
			}
		},
	};
}

function requiredString(
	params: Record<string, unknown>,
	key: string,
): string {
	const value = params[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value;
}

function optionalStrings(
	params: Record<string, unknown>,
	key: string,
): readonly string[] {
	const value = params[key];
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
		throw new TypeError(`${key} must be an array of strings.`);
	}
	return value;
}

function deadline(timeoutMs: number): AbortController {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref();
	return controller;
}
