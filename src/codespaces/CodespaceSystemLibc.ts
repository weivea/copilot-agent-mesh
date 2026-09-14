import {
	OwnedCommandError,
	runOwnedCommand,
	terminateOwnedProcessGroup,
} from '../spikes/ownedProcess';

export class CodespaceLibcDetectionError extends Error {
	public constructor(options?: ErrorOptions) {
		super('Could not determine the system glibc version using getconf GNU_LIBC_VERSION.', options);
		this.name = 'CodespaceLibcDetectionError';
	}
}

export class CodespaceSystemLibc {
	private version: string | undefined;

	public constructor(
		private readonly runCommand: typeof runOwnedCommand = runOwnedCommand,
		private readonly terminate: typeof terminateOwnedProcessGroup = terminateOwnedProcessGroup,
	) {}

	public async glibcVersionRuntime(signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		if (this.version !== undefined) {
			return this.version;
		}
		let output: string;
		try {
			// The extension host's Node report describes Node's build, not necessarily the container's libc.
			output = await this.runCommand('/usr/bin/getconf', ['GNU_LIBC_VERSION'], {
				timeoutMs: 3_000,
				maxOutputBytes: 1_024,
				signal,
			});
		} catch (error: unknown) {
			if (error instanceof OwnedCommandError && error.cleanupRequired) {
				try {
					if (error.ownedCleanup !== undefined) {
						await error.ownedCleanup.dispose();
					} else if (error.processGroupId !== undefined) {
						await this.terminate(error.processGroupId, 250);
					} else {
						throw error;
					}
				} catch (cleanup: unknown) {
					throw new AggregateError([new CodespaceLibcDetectionError({ cause: error }), cleanup],
						'System libc detection did not clean up its owned command.');
				}
			}
			signal?.throwIfAborted();
			throw new CodespaceLibcDetectionError({ cause: error });
		}
		signal?.throwIfAborted();
		const match = /^glibc (\d{1,3}\.\d{1,3}(?:\.\d{1,3})?)$/u.exec(output.trim());
		if (match === null) {
			throw new CodespaceLibcDetectionError();
		}
		this.version = match[1];
		return this.version;
	}
}
