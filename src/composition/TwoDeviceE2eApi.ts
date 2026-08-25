import { randomUUID } from 'node:crypto';

import type * as vscode from 'vscode';

import type { AgentRuntime } from '../agentHost/AgentRuntime';
import type { BrokerLifecycle } from '../broker/BrokerLifecycle';
import type { WindowNodeClient } from '../node/WindowNodeClient';
import type { LocalIpcRemoteTaskAdapter } from '../node/LocalIpcRemoteTaskAdapter';
import type { LocalIpcEndpoint } from '../ipc';
import type { LocalBrokerTaskFacade } from '../tools/LocalBrokerTaskFacade';
import type { ProductionDashboardBindings } from './ProductionDashboardBindings';
import type { ProductionBrokerRuntime } from './ProductionBrokerRuntime';
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

export interface TwoDeviceE2eApiOptions {
	readonly vscodeApi: typeof vscode;
	readonly bindings: ProductionDashboardBindings;
	readonly node: WindowNodeClient;
	readonly localTasks: LocalBrokerTaskFacade;
	readonly remoteTasks: LocalIpcRemoteTaskAdapter;
	readonly runtime: AgentRuntime;
	readonly lifecycle: BrokerLifecycle<ProductionBrokerRuntime>;
	readonly ownerRuntime: () => ProductionBrokerRuntime | undefined;
	readonly capability: E2eCapability;
	readonly localIpcEndpoint?: LocalIpcEndpoint;
}

export function createTwoDeviceE2eApi(
	options: TwoDeviceE2eApiOptions,
): TwoDeviceE2eApi | undefined {
	if (!isE2eCapabilityEnabled(options.capability)) {
		return undefined;
	}
	const authorize = (request: { readonly nonce: string; readonly role: E2eRole }): void => {
		options.capability.assertRequest(request.nonce, request.role);
	};
	return {
		authorize,
		execute: async (request, action, params = {}) => {
			authorize(request);
			switch (action) {
				case 'snapshot':
					return options.bindings.getSnapshot();
				case 'node.state':
					return options.node.snapshot();
				case 'broker.state':
					return options.lifecycle.snapshot();
				case 'listener.state': {
					const owner = options.ownerRuntime();
					return {
						broker: options.lifecycle.snapshot(),
						listener: owner?.listener.snapshot(),
						tunnel: owner?.tunnel.getStatus(),
					};
				}
				case 'ipc.endpoint':
					if (options.localIpcEndpoint === undefined) {
						throw new Error('The local IPC endpoint is unavailable.');
					}
					return options.localIpcEndpoint;
				case 'workspace.register':
					await options.bindings.registerCurrentWorkspace();
					return options.bindings.getSnapshot();
				case 'listener.start': {
					const owner = requireOwner(options);
					await options.bindings.startListener();
					return owner.listener.snapshot();
				}
				case 'listener.invite':
					return { connectionUrl: await options.bindings.createConnectionUrl() };
				case 'peer.add':
					await options.bindings.addPeer(requiredString(params, 'connectionUrl'));
					return options.bindings.getSnapshot();
				case 'directory.list': {
					const controller = deadline(10_000);
					try {
						return await options.localTasks.listWorkers(controller.signal);
					} finally {
						controller.abort();
					}
				}
				case 'directory.remote': {
					const controller = deadline(10_000);
					try {
						return await options.remoteTasks.listDevices(controller.signal);
					} finally {
						controller.abort();
					}
				}
				case 'task.start': {
					const target = explicitTarget(params);
					const instruction = requiredString(params, 'prompt');
					const title = requiredString(params, 'title');
					const delegationRequestId = optionalString(params, 'delegationRequestId') ?? randomUUID();
					const taskId = optionalString(params, 'taskId') ?? randomUUID();
					if (target.deviceId === options.node.deviceId) {
						return options.node.startTask({
							delegationRequestId,
							taskId,
							target,
							sourceNodeId: options.node.nodeId,
							title,
							prompt: instruction,
							acceptanceCriteria: [...optionalStrings(params, 'acceptanceCriteria')],
							workerDeadline: new Date(Date.now() + 5 * 60_000).toISOString(),
						});
					}
					const peerId = requiredString(params, 'peerId');
					return options.remoteTasks.startTask({
						delegationRequestId,
						taskId,
						target,
						title,
						prompt: instruction,
						acceptanceCriteria: [...optionalStrings(params, 'acceptanceCriteria')],
						workerDeadline: new Date(Date.now() + 5 * 60_000).toISOString(),
					}, { peerId });
				}
				case 'task.get': {
					const controller = deadline(30_000);
					try {
						const taskId = requiredString(params, 'taskId');
						const remote = await options.remoteTasks.getTask(
							taskId,
							undefined,
							controller.signal,
						);
						if (remote !== undefined) {
							return toE2eTaskReadResult(remote);
						}
						return options.localTasks.getTask(
							{ taskId, maxEvents: 100 },
							controller.signal,
						);
					} finally {
						controller.abort();
					}

					function toE2eTaskReadResult(
						remote: Awaited<ReturnType<LocalIpcRemoteTaskAdapter['getTask']>> & object,
					): Record<string, unknown> {
						const snapshot = remote as Exclude<
							Awaited<ReturnType<LocalIpcRemoteTaskAdapter['getTask']>>,
							undefined
						>;
						return {
							snapshot: {
								taskId: snapshot.taskId,
								status: snapshot.state,
								title: snapshot.title,
								updatedAt: snapshot.updatedAt,
								...(snapshot.summary === undefined ? {} : { summary: snapshot.summary }),
								...(snapshot.pendingInput === undefined ? {} : { pendingInput: snapshot.pendingInput }),
								...(snapshot.failure === undefined ? {} : { failure: snapshot.failure }),
							},
							eventCursor: snapshot.eventSeq,
							events: snapshot.events.map((event) => ({
								sequence: event.eventSeq,
								type: event.type,
								at: event.at,
								summary: event.summary ?? event.type,
							})),
							truncated: snapshot.eventsTruncated,
						};
					}
				}
				case 'task.cancel': {
					const controller = deadline(30_000);
					try {
						const taskId = requiredString(params, 'taskId');
						return options.localTasks.cancelOwnedTask(
							{ taskId },
							controller.signal,
						);
					} finally {
						controller.abort();
					}
				}
				case 'task.answer': {
					const controller = deadline(30_000);
					try {
						const taskId = requiredString(params, 'taskId');
						const inputId = requiredString(params, 'inputId');
						const answerId = optionalString(params, 'answerId') ?? randomUUID();
						const answer = requiredString(params, 'answer');
						return options.localTasks.answerOwnedTask({
							taskId,
							inputId,
							answerId,
							answer,
						}, controller.signal);
					} finally {
						controller.abort();
					}
				}
				case 'runtime.probe':
					return options.runtime.probe();
				case 'auth.check': {
					const session = await options.vscodeApi.authentication.getSession(
						requiredString(params, 'providerId'),
						optionalStrings(params, 'scopes'),
						{ silent: true },
					);
					return { available: session !== undefined };
				}
				case 'listener.stop': {
					const owner = requireOwner(options);
					await options.bindings.stopListener();
					return owner.listener.snapshot();
				}
				case 'tunnel.cleanup':
					return {
						cleanup: await requireOwner(options).tunnel.deleteOwnedForE2e(
							options.capability,
						),
					};
				case 'tunnel.metadata':
					return requireOwner(options).tunnel.ownedMetadataForE2e(options.capability);
				default:
					throw new Error(`Unsupported gated E2E action: ${action}`);
			}
		},
	};
}

function requireOwner(options: TwoDeviceE2eApiOptions): ProductionBrokerRuntime {
	const owner = options.ownerRuntime();
	if (owner === undefined || options.lifecycle.snapshot().state !== 'running') {
		throw new Error('The E2E action requires the current Broker owner.');
	}
	return owner;
}

function explicitTarget(params: Record<string, unknown>) {
	return {
		deviceId: requiredString(params, 'deviceId'),
		nodeId: requiredString(params, 'nodeId'),
		nodeInstanceId: requiredString(params, 'nodeInstanceId'),
		workspaceId: requiredString(params, 'workspaceId'),
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

function optionalString(
	params: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = params[key];
	if (value === undefined) {
		return undefined;
	}
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
	controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
	return controller;
}
