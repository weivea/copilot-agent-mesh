import {
	AgentHostLauncher,
	type AgentHostLauncherLike,
	type AgentHostProbe,
	type LaunchedAgentHost,
} from '../agentHost/AgentHostLauncher';
import { AgentRuntimeError } from '../agentHost/AgentRuntime';
import { isAbsolute, join } from 'node:path';

export class ConfiguredCodespaceLauncher implements AgentHostLauncherLike {
	private current: { readonly path: string; readonly launcher: AgentHostLauncherLike } | undefined;
	private disposed = false;

	public constructor(
		private readonly resolveCli: () => Promise<string | undefined>,
		private readonly storageRoot: string,
		private readonly createLauncher: (path: string, storageRoot: string) => AgentHostLauncherLike =
			(path, storageRoot) => new AgentHostLauncher({
				storageRoot,
				configuredCodeCli: path,
				cliDataDirectory: join(storageRoot, 'cli-cache'),
				startupTimeoutMs: 120_000,
			}),
	) {}

	public async probe(): Promise<AgentHostProbe> {
		if (this.disposed) {
			return { available: false };
		}
		const launcher = await this.resolve();
		return launcher === undefined ? { available: false } : launcher.probe();
	}

	public async launch(signal?: AbortSignal): Promise<LaunchedAgentHost> {
		if (this.disposed) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Codespaces runtime is disposed.');
		}
		const launcher = await this.resolve();
		if (launcher === undefined) {
			throw new AgentRuntimeError(
				'AGENT_CONFIG_REQUIRED',
				'Use Prepare Codespaces Runtime before delegating to this Codespace.',
			);
		}
		return launcher.launch(signal);
	}

	public async dispose(): Promise<void> {
		this.disposed = true;
		await this.current?.launcher.dispose();
	}

	private async resolve(): Promise<AgentHostLauncherLike | undefined> {
		const path = await this.resolveCli();
		if (this.disposed) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Codespaces runtime is disposed.');
		}
		if (this.current !== undefined && this.current.path !== path) {
			throw new AgentRuntimeError(
				'TASK_RECOVERY_UNAVAILABLE',
				'The Codespaces runtime executable changed. Reload the window before starting another task.',
			);
		}
		if (path === undefined) {
			return undefined;
		}
		if (!isAbsolute(path)) {
			throw new AgentRuntimeError('AGENT_CONFIG_REQUIRED', 'The Codespaces CLI path must be absolute.');
		}
		this.current ??= { path, launcher: this.createLauncher(path, this.storageRoot) };
		return this.current.launcher;
	}
}
