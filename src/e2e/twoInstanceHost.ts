import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import * as vscode from 'vscode';

import type { AgentMeshExtensionApi } from '../composition/createApplication';
import type { E2eRole } from '../composition/E2eCapability';

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface RequestEnvelope {
	readonly id: string;
	readonly action: string;
	readonly nonce: string;
	readonly role: E2eRole;
	readonly params?: Record<string, unknown>;
}

export async function run(): Promise<void> {
	if (process.env.MESH_TWO_DEVICE_E2E !== '1') {
		throw new Error('MESH_TWO_DEVICE_E2E=1 is required for the two-instance Extension Host.');
	}
	const controlRoot = process.env.MESH_TWO_DEVICE_E2E_CONTROL_DIR;
	if (controlRoot === undefined || !isAbsolute(controlRoot)) {
		throw new Error('MESH_TWO_DEVICE_E2E_CONTROL_DIR must be an absolute path.');
	}
	const nonce = process.env.MESH_TWO_DEVICE_E2E_NONCE;
	const role = process.env.MESH_TWO_DEVICE_E2E_ROLE;
	if (
		nonce === undefined
		|| (role !== 'worker' && role !== 'coordinator')
	) {
		throw new Error('The two-device E2E nonce and role are required.');
	}
	const requests = join(controlRoot, 'requests');
	const responses = join(controlRoot, 'responses');
	await Promise.all([mkdir(requests, { recursive: true }), mkdir(responses, { recursive: true })]);

	const extension = vscode.extensions.getExtension<AgentMeshExtensionApi>('weivea.copilot-agent-mesh');
	if (extension === undefined) {
		throw new Error('The Copilot Agent Mesh development extension is unavailable.');
	}
	const api = await extension.activate();
	if (api.twoDeviceE2e === undefined) {
		throw new Error('The gated two-device E2E API was not activated.');
	}
	await atomicJson(join(controlRoot, 'ready.json'), {
		ready: true,
		role,
	});

	let stopping = false;
	while (!stopping) {
		for (const name of (await readdir(requests)).filter((value) => value.endsWith('.json')).sort()) {
			const path = join(requests, name);
			let request: RequestEnvelope | undefined;
			try {
				request = parseRequest(JSON.parse(await readFile(path, 'utf8')));
				if (request.action === 'host.shutdown') {
					api.twoDeviceE2e.authorize(request);
					stopping = true;
					await atomicJson(join(responses, `${request.id}.json`), {
						id: request.id,
						ok: true,
						result: { stopping: true },
					});
				} else {
					const result = await api.twoDeviceE2e.execute(
						request,
						request.action,
						request.params,
					);
					await atomicJson(join(responses, `${request.id}.json`), {
						id: request.id,
						ok: true,
						result,
					});
				}
			} catch (error) {
				const id = request?.id ?? name.replace(/\.json$/u, '');
				await atomicJson(join(responses, `${id}.json`), {
					id,
					ok: false,
					error: serializeError(error),
				});
			} finally {
				await rm(path, { force: true });
			}
			if (stopping) {
				break;
			}
		}
		if (!stopping) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}

function parseRequest(value: unknown): RequestEnvelope {
	if (
		typeof value !== 'object'
		|| value === null
		|| !('id' in value)
		|| typeof value.id !== 'string'
		|| !requestIdPattern.test(value.id)
		|| !('action' in value)
		|| typeof value.action !== 'string'
		|| !('nonce' in value)
		|| typeof value.nonce !== 'string'
		|| !('role' in value)
		|| (value.role !== 'worker' && value.role !== 'coordinator')
	) {
		throw new TypeError('Invalid two-device E2E request envelope.');
	}
	const params = 'params' in value ? value.params : undefined;
	if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
		throw new TypeError('Two-device E2E request params must be an object.');
	}
	return {
		id: value.id,
		action: value.action,
		nonce: value.nonce,
		role: value.role,
		params: params as Record<string, unknown> | undefined,
	};
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, path);
}

function serializeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
		};
	}
	return { name: 'Error', message: String(error) };
}
