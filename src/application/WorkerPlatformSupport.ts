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
	const supported = (platform === 'darwin' && architecture === 'arm64')
		|| (platform === 'win32' && (architecture === 'x64' || architecture === 'arm64'));
	return {
		supported,
		listenerCode: 'CLI_UNSUPPORTED',
		listenerMessage: supported
			? 'The Worker listener is available on this platform.'
			: 'Cross-device connections require Windows x64/ARM64 or macOS arm64. Local coordination remains available.',
		agentCode: 'AGENT_UNAVAILABLE',
		agentMessage: supported
			? 'The Worker Agent Host is available on demand for authorized tasks.'
			: 'Worker task execution requires Windows x64/ARM64 or macOS arm64. This device can still act as a Coordinator.',
	};
}
