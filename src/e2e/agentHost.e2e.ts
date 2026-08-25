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
import { UnavailableAuthBroker } from '../agentHost/AuthBroker';

const optInVariable = 'MESH_AGENT_HOST_E2E';

async function main(): Promise<void> {
	if (process.env[optInVariable] !== '1') {
		console.log(`Agent Host E2E skipped. Set ${optInVariable}=1 to run it.`);
		return;
	}

	console.warn('Opt-in Agent Host E2E enabled. A successful turn may consume Copilot quota.');
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
		authBroker: new UnavailableAuthBroker(),
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
			prompt: 'Reply with exactly MESH_AGENT_HOST_E2E_OK. Do not modify files or run commands.',
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
		if (output.trim() !== 'MESH_AGENT_HOST_E2E_OK') {
			throw new Error('The real Agent Host response did not exactly match the expected non-destructive marker.');
		}
		outcome = { outcome: 'turnComplete', workspace: 'temporary-non-sensitive' };
	} catch (error) {
		if (error instanceof AgentRuntimeError
			&& error.code === 'AGENT_AUTH_REQUIRED'
			&& !error.cleanupFailed) {
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
				values[id] = (await request.completions(id, values))[0]?.value;
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
