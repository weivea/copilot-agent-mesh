import type * as vscode from 'vscode';

import type { ListenerService } from '../application/ListenerService';
import type { TaskCoordinator } from '../application/TaskCoordinator';
import type { AgentRuntime } from '../agentHost/AgentRuntime';
import type { DevTunnelCliProvider } from '../tunnel/DevTunnelCliProvider';
import type { ProductionDashboardBindings } from './ProductionDashboardBindings';

export interface TwoDeviceE2eApi {
	execute(action: string, params?: Record<string, unknown>): Promise<unknown>;
}

export function createTwoDeviceE2eApi(
	vscodeApi: typeof vscode,
	bindings: ProductionDashboardBindings,
	coordinator: TaskCoordinator,
	listener: ListenerService,
	runtime: AgentRuntime,
	tunnel: DevTunnelCliProvider,
): TwoDeviceE2eApi | undefined {
	if (process.env.MESH_TWO_DEVICE_E2E !== '1') {
		return undefined;
	}
	return {
		execute: async (action, params = {}) => {
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
					return { cleanup: await tunnel.deleteOwnedForE2e() };
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
