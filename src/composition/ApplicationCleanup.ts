export interface ApplicationCleanupStep {
	dispose: () => Promise<void> | void;
	readonly safetyCritical: boolean;
	complete: boolean;
}

export interface ApplicationCleanupState<Resource extends object> {
	readonly disposedContributions: WeakSet<Resource>;
	stoppedLogged: boolean;
	loggerDisposed: boolean;
	complete: boolean;
}

export interface ApplicationCleanupLogger {
	log(level: 'info', category: string, message: string): void;
	error(category: string, message: string, error?: unknown): void;
	dispose(): void;
}

export function createApplicationCleanupState<
	Resource extends object,
>(): ApplicationCleanupState<Resource> {
	return {
		disposedContributions: new WeakSet(),
		stoppedLogged: false,
		loggerDisposed: false,
		complete: false,
	};
}

export function addApplicationCleanup(
	cleanup: ApplicationCleanupStep[],
	dispose: () => Promise<void> | void,
	safetyCritical = false,
): ApplicationCleanupStep {
	const step = { dispose, safetyCritical, complete: false };
	cleanup.push(step);
	return step;
}

export async function disposeApplicationResources<
	Resource extends object & { dispose(): void },
>(
	contributions: readonly Resource[],
	cleanup: readonly ApplicationCleanupStep[],
	logger: ApplicationCleanupLogger,
	state: ApplicationCleanupState<Resource>,
): Promise<void> {
	if (state.complete) {
		return;
	}
	const failures: unknown[] = [];
	for (const contribution of [...contributions].reverse()) {
		if (state.disposedContributions.has(contribution)) {
			continue;
		}
		try {
			contribution.dispose();
			state.disposedContributions.add(contribution);
		} catch (error: unknown) {
			failures.push(error);
			logCleanupFailure(logger, error);
		}
	}
	for (const step of [...cleanup].reverse()) {
		if (step.complete) {
			continue;
		}
		try {
			await step.dispose();
			step.complete = true;
		} catch (error: unknown) {
			failures.push(error);
			logCleanupFailure(logger, error);
			if (step.safetyCritical) {
				throw cleanupAggregate(failures);
			}
		}
	}
	if (failures.length > 0) {
		throw cleanupAggregate(failures);
	}
	if (!state.stoppedLogged) {
		logger.log('info', 'application', 'Copilot Agent Mesh application stopped.');
		state.stoppedLogged = true;
	}
	if (!state.loggerDisposed) {
		logger.dispose();
		state.loggerDisposed = true;
	}
	state.complete = true;
}

export function activationRollbackFailure(
	activationError: unknown,
	cleanupError: unknown,
): AggregateError {
	return new AggregateError(
		[activationError, cleanupError],
		'Copilot Agent Mesh activation failed and rollback was incomplete.',
	);
}

function logCleanupFailure(logger: ApplicationCleanupLogger, error: unknown): void {
	try {
		logger.error('shutdown', 'Application resource cleanup failed.', error);
	} catch {
		// Cleanup errors remain available to the caller even if logging is unavailable.
	}
}

function cleanupAggregate(failures: readonly unknown[]): AggregateError {
	return new AggregateError(
		failures,
		'Copilot Agent Mesh did not cleanly release every resource.',
	);
}
