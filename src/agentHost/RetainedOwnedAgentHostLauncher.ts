import { randomBytes } from 'node:crypto';

import type {
	AgentHostLauncherLike,
	AgentHostProbe,
	LaunchedAgentHost,
} from './AgentHostLauncher';
import { AgentRuntimeError } from './AgentRuntime';

interface RetainedHost {
	readonly host: LaunchedAgentHost;
	readonly fingerprint: string;
	exitSubscription?: { dispose(): void };
}

interface SharedLaunch {
	readonly controller: AbortController;
	readonly promise: Promise<RetainedHost>;
}

/** Owns one Host generation; task leases own only their client-side attachments. */
export class RetainedOwnedAgentHostLauncher implements AgentHostLauncherLike {
	private readonly leases = new Set<OwnedAgentHostLease>();
	private readonly failureListeners = new Set<(error: AgentRuntimeError) => void>();
	private retained: RetainedHost | undefined;
	private launching: SharedLaunch | undefined;
	private generationFailure: AgentRuntimeError | undefined;
	private stopping = false;
	private wrappedDisposed = false;
	private disposal: Promise<void> | undefined;

	public constructor(private readonly launcher: AgentHostLauncherLike) {}

	public get hasLiveHost(): boolean {
		return !this.stopping && this.generationFailure === undefined && this.retained !== undefined;
	}

	public get failure(): AgentRuntimeError | undefined {
		return this.generationFailure;
	}

	public onDidFail(listener: (error: AgentRuntimeError) => void): { dispose(): void } {
		this.failureListeners.add(listener);
		return { dispose: () => this.failureListeners.delete(listener) };
	}

	public async probe(): Promise<AgentHostProbe> {
		if (this.stopping || this.generationFailure !== undefined) {
			return { available: false };
		}
		if (this.retained !== undefined) {
			return { available: true, version: this.retained.host.version };
		}
		const result = await this.launcher.probe();
		return this.stopping || this.generationFailure !== undefined ? { available: false } : result;
	}

	public launch(signal?: AbortSignal): Promise<LaunchedAgentHost> {
		try {
			this.assertAvailable();
			if (signal?.aborted === true) {
				throw cancelledLaunch();
			}
			if (this.retained !== undefined) {
				return Promise.resolve(this.createLease(this.retained));
			}
		} catch (error: unknown) {
			return Promise.reject(error);
		}

		const launch = this.launching ?? this.startHost();
		return new Promise<LaunchedAgentHost>((resolve, reject) => {
			let settled = false;
			const finish = (): boolean => {
				if (settled) { return false; }
				settled = true;
				signal?.removeEventListener('abort', cancelWaiter);
				launch.controller.signal.removeEventListener('abort', cancelSharedLaunch);
				return true;
			};
			const cancelWaiter = () => {
				if (!finish()) { return; }
				// A task cancels only its lease; generation shutdown owns Host startup.
				reject(cancelledLaunch());
			};
			const cancelSharedLaunch = () => {
				if (finish()) { reject(cancelledLaunch()); }
			};
			signal?.addEventListener('abort', cancelWaiter, { once: true });
			launch.controller.signal.addEventListener('abort', cancelSharedLaunch, { once: true });
			if (signal?.aborted === true) {
				cancelWaiter();
			} else if (launch.controller.signal.aborted) {
				cancelSharedLaunch();
			}
			void launch.promise.then(
				(host) => {
					if (!finish()) { return; }
					try {
						resolve(this.createLease(host));
					} catch (error: unknown) {
						reject(error);
					}
				},
				(error: unknown) => {
					if (finish()) { reject(error); }
				},
			);
		});
	}

	private startHost(): SharedLaunch {
		const controller = new AbortController();
		let launch!: SharedLaunch;
		const promise = Promise.resolve().then(async () => {
			this.assertAvailable();
			const host = await this.launcher.launch(controller.signal);
			const retained: RetainedHost = { host, fingerprint: randomBytes(32).toString('hex') };
			this.retained = retained;
			retained.exitSubscription = host.onExit(() => {
				if (!this.stopping) {
					this.failGeneration(new AgentRuntimeError(
						'TASK_RECOVERY_UNAVAILABLE',
						'The Codespace-owned Agent Host exited. Its execution generation cannot be resumed.',
					));
				}
			});
			if (host.source === 'editor') {
				throw new AgentRuntimeError(
					'AGENT_UNAVAILABLE',
					'An editor Agent Host cannot be used as a Codespace-owned Host.',
				);
			}
			this.assertCurrent(retained);
			return retained;
		}).catch((error: unknown) => {
			const failure = error instanceof AgentRuntimeError ? error : new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'The Codespace-owned Agent Host could not be started.',
			);
			this.failGeneration(failure);
			throw failure;
		}).finally(() => {
			if (this.launching === launch) {
				this.launching = undefined;
			}
		});
		launch = { controller, promise };
		this.launching = launch;
		return launch;
	}

	private createLease(retained: RetainedHost): LaunchedAgentHost {
		this.assertCurrent(retained);
		const lease = new OwnedAgentHostLease(
			retained,
			() => this.assertCurrent(retained),
			() => this.leases.delete(lease),
		);
		this.leases.add(lease);
		return lease;
	}

	private assertAvailable(): void {
		if (this.stopping) {
			throw new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Codespace-owned Agent Host launcher has been disposed.');
		}
		if (this.generationFailure !== undefined) {
			throw new AgentRuntimeError(
				'TASK_RECOVERY_UNAVAILABLE',
				'The Codespace-owned Agent Host generation is unavailable. It will not be replaced automatically.',
			);
		}
	}

	private assertCurrent(retained: RetainedHost): void {
		this.assertAvailable();
		if (this.retained !== retained) {
			throw new AgentRuntimeError('TASK_RECOVERY_UNAVAILABLE', 'The Codespace-owned Agent Host lease is stale.');
		}
	}

	private failGeneration(error: AgentRuntimeError): void {
		if (this.generationFailure !== undefined || this.stopping) { return; }
		this.generationFailure = new AgentRuntimeError(
			error.code,
			'The Codespace-owned Agent Host generation is unavailable.',
			false,
			undefined,
			error.cleanupFailed,
		);
		for (const listener of this.failureListeners) {
			try {
				listener(this.generationFailure);
			} catch {
				process.emitWarning('A Codespaces Host failure observer failed.', { code: 'MESH_CODESPACES_OBSERVER_FAILED' });
			}
		}
	}

	public dispose(): Promise<void> {
		this.disposal ??= this.disposeOwned().catch((error: unknown) => {
			this.disposal = undefined;
			throw error;
		});
		return this.disposal;
	}

	private async disposeOwned(): Promise<void> {
		this.stopping = true;
		const launching = this.launching;
		launching?.controller.abort();
		// Launch failures remain visible to their callers. The wrapped launcher
		// retains partial-start resources and retries their cleanup below.
		await launching?.promise.catch(() => undefined);
		const results = await Promise.allSettled([...this.leases].map((lease) => lease.dispose()));
		let cleanupFailed = results.some(({ status }) => status === 'rejected');
		if (!this.wrappedDisposed) {
			try {
				await this.launcher.dispose();
				this.wrappedDisposed = true;
			} catch {
				cleanupFailed = true;
			}
		}
		if (this.wrappedDisposed && this.retained?.exitSubscription !== undefined) {
			try {
				this.retained.exitSubscription.dispose();
				this.retained.exitSubscription = undefined;
			} catch {
				cleanupFailed = true;
			}
		}
		if (cleanupFailed) {
			throw new AgentRuntimeError(
				'AGENT_UNAVAILABLE',
				'Codespace-owned Agent Host cleanup failed. Owned resources remain tracked for explicit disposal retry.',
				false,
				undefined,
				true,
			);
		}
		this.retained = undefined;
		this.failureListeners.clear();
	}
}

class OwnedAgentHostLease implements LaunchedAgentHost {
	public readonly source = 'codespace-owned';
	public readonly preserveTerminalSession = true;
	public readonly endpointFingerprint: string;
	public readonly openWebSocket?: LaunchedAgentHost['openWebSocket'];
	private readonly subscriptions = new Set<{ dispose(): void }>();
	private released = false;

	public constructor(
		private readonly retained: RetainedHost,
		private readonly assertCurrent: () => void,
		private readonly didRelease: () => void,
	) {
		this.endpointFingerprint = retained.fingerprint;
		if (retained.host.openWebSocket !== undefined) {
			this.openWebSocket = async (signal) => {
				this.assertActive();
				const socket = await retained.host.openWebSocket!(signal);
				try {
					this.assertActive();
				} catch (error: unknown) {
					socket.terminate();
					throw error;
				}
				return socket;
			};
		}
	}

	public get endpoint(): URL {
		this.assertActive();
		return new URL(this.retained.host.endpoint.href);
	}

	public get version(): string { return this.retained.host.version; }
	public get registryProtocolVersion(): string { return this.retained.host.registryProtocolVersion; }

	public onExit(listener: (error: AgentRuntimeError) => void): { dispose(): void } {
		if (this.released) { return { dispose: () => undefined }; }
		// Delegate registration, including late-exit replay, to the native Host.
		const subscription = this.retained.host.onExit(listener);
		this.subscriptions.add(subscription);
		return {
			dispose: () => {
				subscription.dispose();
				this.subscriptions.delete(subscription);
			},
		};
	}

	public async dispose(): Promise<void> {
		this.released = true;
		for (const subscription of this.subscriptions) {
			subscription.dispose();
			this.subscriptions.delete(subscription);
		}
		this.didRelease();
	}

	private assertActive(): void {
		if (this.released) {
			throw new AgentRuntimeError('TASK_RECOVERY_UNAVAILABLE', 'The Codespace-owned Agent Host lease was released.');
		}
		this.assertCurrent();
	}
}

function cancelledLaunch(): AgentRuntimeError {
	return new AgentRuntimeError('AGENT_UNAVAILABLE', 'The Codespace-owned Agent Host launch was cancelled.');
}
