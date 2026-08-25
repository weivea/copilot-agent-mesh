export interface WorkerPlatformSupport {
	readonly supported: boolean;
	readonly listenerCode: 'CLI_UNSUPPORTED';
	readonly listenerMessage: string;
	readonly agentCode: 'AGENT_UNAVAILABLE';
	readonly agentMessage: string;
}

export function getWorkerPlatformSupport(
	platform: NodeJS.Platform = process.platform,
	architecture: string = process.arch,
): WorkerPlatformSupport {
	const supported = platform === 'darwin' && architecture === 'arm64';
	return {
		supported,
		listenerCode: 'CLI_UNSUPPORTED',
		listenerMessage: supported
			? 'The macOS arm64 Worker Preview listener is available.'
			: 'Worker Preview listener hosting requires macOS arm64 and the exact supported Dev Tunnel CLI build. This device can still act as a Coordinator.',
		agentCode: 'AGENT_UNAVAILABLE',
		agentMessage: supported
			? 'The macOS arm64 Worker Preview Agent Host is available when enabled and configured.'
			: 'Worker Preview task execution requires macOS arm64. This device can still act as a Coordinator.',
	};
}
