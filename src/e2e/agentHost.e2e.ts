import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	AhpAgentRuntime,
	SdkAhpConnectionFactory,
	type SessionConfigurationResolver,
} from '../agentHost/AhpAgentRuntime';
import { AgentHostLauncher } from '../agentHost/AgentHostLauncher';
import { AgentRuntimeError } from '../agentHost/AgentRuntime';
import {
	UnavailableAuthBroker,
	type AuthenticationRequest,
	type AuthBroker,
} from '../agentHost/AuthBroker';

const authOptInVariable = 'MESH_AGENT_HOST_AUTH_E2E';
const successOptInVariable = 'MESH_AGENT_HOST_SUCCESS_E2E';
const tokenVariable = 'MESH_AGENT_HOST_E2E_TOKEN';
const expectedMarker = 'MESH_AGENT_HOST_E2E_OK';

async function main(): Promise<void> {
	const mode = process.argv[2];
	const authBoundary = mode === 'auth-boundary';
	const successTurn = mode === 'success-turn';
	if (!authBoundary && !successTurn) {
		throw new Error('Choose the auth-boundary or success-turn Agent Host E2E command.');
	}
	const optInVariable = successTurn ? successOptInVariable : authOptInVariable;
	if (process.env[optInVariable] !== '1') {
		console.log(`Agent Host ${mode} E2E skipped. Set ${optInVariable}=1 to run it.`);
		return;
	}
	const token = successTurn ? process.env[tokenVariable] : undefined;
	if (successTurn && (token === undefined || token.length === 0)) {
		throw new Error(`The success-turn E2E requires ${tokenVariable}.`);
	}

	console.warn(`Opt-in Agent Host ${mode} E2E enabled. A successful turn may consume Copilot quota.`);
	const root = await mkdtemp(join(tmpdir(), 'copilot-agent-mesh-runtime-e2e-'));
	const workspace = join(root, 'workspace');
	const launcher = new AgentHostLauncher({
		storageRoot: join(root, 'host'),
		configuredCodeCli: process.env.MESH_CODE_CLI,
	});
	const runtime = new AhpAgentRuntime({
		enabled: () => true,
		launcher,
		connections: new SdkAhpConnectionFactory(),
		authBroker: successTurn ? new E2eTokenAuthBroker(token!) : new UnavailableAuthBroker(),
		confirmation: { confirm: async () => 'once' },
		workspaceResolver: {
			resolve: async (workspaceId) => workspaceId === 'temporary-e2e-workspace'
				? {
					workspaceId,
					displayName: 'Temporary E2E Workspace',
					uri: new URL(`file://${workspace}`).toString(),
				}
				: undefined,
		},
		configResolver: new E2eConfigurationResolver(),
	});

	let outcome: Record<string, string> | undefined;
	try {
		await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
		const handle = await runtime.start({
			taskId: 'agent-host-e2e',
			title: 'Non-destructive Agent Host probe',
			prompt: `Reply with exactly ${expectedMarker}. Do not modify files or run commands.`,
			workspaceId: 'temporary-e2e-workspace',
			allowInteractiveAuthentication: false,
		});
		let completed = false;
		let output = '';
		for await (const event of handle.events) {
			if (event.type === 'failed') {
				throw event.error;
			}
			if (event.type === 'output') {
				output += event.text;
			}
			if (event.type === 'completed') {
				completed = true;
			}
		}
		await handle.dispose();
		if (!completed) {
			throw new Error('The real Agent Host turn ended without turnComplete.');
		}
		if (output.trim() !== expectedMarker) {
			throw new Error('The real Agent Host response did not exactly match the expected non-destructive marker.');
		}
		outcome = { outcome: 'turnComplete', workspace: 'temporary-non-sensitive' };
	} catch (error) {
		if (error instanceof AgentRuntimeError
			&& error.code === 'AGENT_AUTH_REQUIRED'
			&& !error.cleanupFailed
			&& authBoundary) {
			outcome = {
				outcome: 'blocked',
				code: error.code,
				reason: error.message,
			};
		} else {
			throw error;
		}

	} finally {
		await runtime.dispose();
		await rm(root, { recursive: true, force: true });
	}
	if (outcome === undefined) {
		throw new Error('The real Agent Host E2E completed without an outcome.');
	}
	console.log(JSON.stringify(outcome));
}

class E2eTokenAuthBroker implements AuthBroker {
	constructor(private readonly token: string) {}

	async authenticate(
		request: AuthenticationRequest,
		pushToken: (resource: string, token: string, scopes: readonly string[]) => Promise<void>,
	): Promise<void> {
		for (const resource of request.resources.filter(({ required }) => required !== false)) {
			if (request.signal?.aborted === true) {
				throw new DOMException('Authentication aborted.', 'AbortError');
			}
			try {
				await pushToken(resource.resource, this.token, resource.scopes_supported ?? []);
			} catch {
				throw new AgentRuntimeError('AGENT_AUTH_FAILED', 'The Agent Host rejected the E2E authentication token.');
			}
		}
	}
}

class E2eConfigurationResolver implements SessionConfigurationResolver {
	async resolve(request: Parameters<SessionConfigurationResolver['resolve']>[0]): Promise<Readonly<Record<string, unknown>>> {
		const values: Record<string, unknown> = { ...request.values };
		for (const [id, property] of Object.entries(request.schema.properties)) {
			if (values[id] !== undefined) {
				continue;
			}
			if (property.default !== undefined) {
				values[id] = property.default;
			} else if (property.enum?.[0] !== undefined) {
				values[id] = property.enum[0];
			} else if (property.enumDynamic === true) {
				values[id] = (await request.completions(id, values, ''))[0]?.value;
			}
		}
		const missing = request.schema.required?.filter((id) => values[id] === undefined) ?? [];
		if (missing.length > 0) {
			throw new AgentRuntimeError(
				'AGENT_CONFIG_REQUIRED',
				`The E2E cannot choose required configuration: ${missing.join(', ')}.`,
			);
		}
		return values;
	}
}

void main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Agent Host E2E failed: ${message.replace(/([?&]tkn=)[^&\s]+/gu, '$1<redacted>')}`);
	process.exitCode = 1;
});
