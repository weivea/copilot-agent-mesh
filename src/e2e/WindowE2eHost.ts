import { basename, isAbsolute, join } from 'node:path';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';

import * as vscode from 'vscode';

import type { AgentMeshExtensionApi } from '../composition/createApplication';
import type { TwoDeviceE2eApi } from '../composition/TwoDeviceE2eApi';
import {
	multiWindowControlDirectory,
	multiWindowWorkspaceKey,
	parseMultiWindowRequest,
	type MultiWindowRequestEnvelope,
} from './MultiWindowE2eSupport';

const requestFilePattern = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;

export interface WindowE2eHostOptions {
	readonly environmentPrefix: string;
	readonly controller: (api: AgentMeshExtensionApi) => TwoDeviceE2eApi | undefined;
	readonly label: string;
}

export async function runWindowE2eHost(options: WindowE2eHostOptions): Promise<void> {
	const extension = vscode.extensions.getExtension<AgentMeshExtensionApi>(
		'weivea.copilot-agent-mesh',
	);
	if (extension === undefined) {
		throw new Error('The Copilot Agent Mesh development extension is unavailable.');
	}
	const api = await extension.activate();
	return runWindowE2eHostWithApi(api, options);
}

export async function runWindowE2eHostWithApi(
	api: AgentMeshExtensionApi,
	options: WindowE2eHostOptions,
): Promise<void> {
	const environmentPrefix = options.environmentPrefix;
	if (process.env[environmentPrefix] !== '1') {
		throw new Error(`${environmentPrefix}=1 is required for the ${options.label} Extension Host.`);
	}
	const controlRoot = process.env[`${environmentPrefix}_CONTROL_DIR`];
	const nonce = process.env[`${environmentPrefix}_NONCE`];
	if (controlRoot === undefined || !isAbsolute(controlRoot)) {
		throw new Error(`${environmentPrefix}_CONTROL_DIR must be an absolute path.`);
	}
	if (nonce === undefined) {
		throw new Error(`${environmentPrefix}_NONCE is required.`);
	}
	const controller = options.controller(api);
	if (controller === undefined) {
		throw new Error(`The gated ${options.label} API was not activated.`);
	}
	const folders = vscode.workspace.workspaceFolders;
	if (
		folders?.length !== 1
		|| folders[0].uri.scheme !== 'file'
	) {
		throw new Error(`The ${options.label} Extension Host requires exactly one local file workspace.`);
	}
	const workspaceBasename = basename(folders[0].uri.fsPath);
	const workspaceKey = multiWindowWorkspaceKey(workspaceBasename);
	const windowId = api.nodeInstanceId;
	const controlDirectory = multiWindowControlDirectory(
		controlRoot,
		workspaceBasename,
		windowId,
	);
	const requests = join(controlDirectory, 'requests');
	const responses = join(controlDirectory, 'responses');
	const readyPath = join(controlDirectory, 'ready.json');
	const statePath = join(controlDirectory, 'state.json');
	await Promise.all([
		mkdir(requests, { recursive: true }),
		mkdir(responses, { recursive: true }),
	]);

	const identity = {
		schemaVersion: 1,
		workspaceBasename,
		workspaceKey,
		windowId,
		nodeId: api.nodeId,
		nodeInstanceId: api.nodeInstanceId,
		extensionHostPid: process.pid,
		parentPid: process.ppid,
		activatedAt: new Date().toISOString(),
	};
	await atomicJson(readyPath, {
		...identity,
		ready: true,
		node: api.nodeState(),
		broker: api.brokerState(),
	});

	let closing = false;
	let nextStatePublication = 0;
	while (!closing) {
		if (Date.now() >= nextStatePublication) {
			await atomicJson(statePath, {
				...identity,
				publishedAt: new Date().toISOString(),
				node: api.nodeState(),
				broker: api.brokerState(),
			});
			nextStatePublication = Date.now() + 100;
		}
		const names = (await readdir(requests))
			.filter((name) => requestFilePattern.test(name))
			.sort();
		for (const name of names) {
			const path = join(requests, name);
			let request: MultiWindowRequestEnvelope | undefined;
			try {
				request = parseMultiWindowRequest(
					JSON.parse(await readFile(path, 'utf8')),
					{ nonce, workspaceKey, windowId },
				);
				if (request.action === 'controller.state') {
					controller.authorize(request);
					await respond(responses, request.id, windowId, {
						...identity,
						node: api.nodeState(),
						broker: api.brokerState(),
					});
				} else if (request.action === 'host.close') {
					controller.authorize(request);
					await respond(responses, request.id, windowId, { closing: true });
					await Promise.all([
						rm(readyPath, { force: true }),
						rm(statePath, { force: true }),
					]);
					closing = true;
				} else if (request.action === 'window.open') {
					controller.authorize(request);
					const workspacePath = request.params?.workspacePath;
					if (typeof workspacePath !== 'string' || !isAbsolute(workspacePath)) {
						throw new TypeError('The window E2E workspace path must be absolute.');
					}
					await vscode.commands.executeCommand(
						'vscode.openFolder',
						vscode.Uri.file(workspacePath),
						{ forceNewWindow: true },
					);
					await respond(responses, request.id, windowId, { opened: true });
				} else {
					const result = await controller.execute(
						request,
						request.action,
						request.params,
					);
					await respond(responses, request.id, windowId, result);
				}
			} catch (error) {
				const id = request?.id ?? requestFilePattern.exec(name)?.[1];
				if (id !== undefined) {
					await atomicJson(join(responses, `${id}.json`), {
						schemaVersion: 1,
						id,
						windowId,
						ok: false,
						error: serializeError(error),
					});
				}
			} finally {
				await rm(path, { force: true });
			}
			if (closing) {
				break;
			}
		}
		if (!closing) {
			await delay(25);
		}
	}

	await atomicJson(join(controlDirectory, 'closed.json'), {
		...identity,
		closedAt: new Date().toISOString(),
	});
	setTimeout(() => {
		void vscode.commands.executeCommand('workbench.action.closeWindow');
	}, 25);
	await new Promise<void>(() => undefined);
}

async function respond(
	responses: string,
	id: string,
	windowId: string,
	result: unknown,
): Promise<void> {
	await atomicJson(join(responses, `${id}.json`), {
		schemaVersion: 1,
		id,
		windowId,
		ok: true,
		result,
	});
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	});
	await rename(temporary, path);
}

function serializeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		const data = 'data' in error
			&& typeof error.data === 'object'
			&& error.data !== null
			&& !Array.isArray(error.data)
			? error.data as Record<string, unknown>
			: undefined;
		const reason = typeof data?.reason === 'string' ? data.reason : undefined;
		const diagnostic = typeof data?.diagnostic === 'string' ? data.diagnostic : undefined;
		return {
			name: error.name,
			message: error.message,
			...(reason === undefined && diagnostic === undefined
				? 'code' in error && typeof error.code === 'string'
					? { code: error.code }
					: {}
				: { code: reason ?? diagnostic }),
		};
	}
	return { name: 'Error', message: String(error) };
}

function delay(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}
