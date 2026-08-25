import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	activationRollbackFailure,
	addApplicationCleanup,
	createApplicationCleanupState,
	disposeApplicationResources,
	type ApplicationCleanupLogger,
	type ApplicationCleanupStep,
} from '../composition/ApplicationCleanup';

class TestLogger implements ApplicationCleanupLogger {
	public disposeCalls = 0;
	public readonly errors: unknown[] = [];

	public log(): void {}

	public error(_category: string, _message: string, error?: unknown): void {
		this.errors.push(error);
	}

	public dispose(): void {
		this.disposeCalls += 1;
	}
}

test('application cleanup retries critical steps without releasing ownership early', async () => {
	const cleanup: ApplicationCleanupStep[] = [];
	const calls: string[] = [];
	let nodeFailures = 1;
	let lifecycleFailures = 1;
	addApplicationCleanup(cleanup, async () => {
		calls.push('lifecycle');
		if (lifecycleFailures > 0) {
			lifecycleFailures -= 1;
			throw new Error('lifecycle cleanup failed');
		}
	}, true);
	addApplicationCleanup(cleanup, async () => {
		calls.push('node');
		if (nodeFailures > 0) {
			nodeFailures -= 1;
			throw new Error('node cleanup failed');
		}
	}, true);
	addApplicationCleanup(cleanup, () => {
		calls.push('ui');
	});
	const contribution = {
		dispose: () => {
			calls.push('contribution');
		},
	};
	const state = createApplicationCleanupState<typeof contribution>();
	const logger = new TestLogger();

	await assert.rejects(
		disposeApplicationResources([contribution], cleanup, logger, state),
		(error: unknown) => hasFailure(error, 'node cleanup failed'),
	);
	assert.deepEqual(calls, ['contribution', 'ui', 'node']);

	await assert.rejects(
		disposeApplicationResources([contribution], cleanup, logger, state),
		(error: unknown) => hasFailure(error, 'lifecycle cleanup failed'),
	);
	assert.deepEqual(calls, ['contribution', 'ui', 'node', 'node', 'lifecycle']);

	await disposeApplicationResources([contribution], cleanup, logger, state);
	await disposeApplicationResources([contribution], cleanup, logger, state);
	assert.deepEqual(calls, [
		'contribution',
		'ui',
		'node',
		'node',
		'lifecycle',
		'lifecycle',
	]);
	assert.equal(logger.disposeCalls, 1);
});

test('activation rollback preserves both activation and cleanup failures', () => {
	const activation = new Error('activation failed');
	const cleanup = new Error('cleanup failed');
	const combined = activationRollbackFailure(activation, cleanup);
	assert.deepEqual(combined.errors, [activation, cleanup]);
	assert.match(combined.message, /activation failed and rollback was incomplete/u);
});

function hasFailure(error: unknown, message: string): boolean {
	return error instanceof AggregateError
		&& error.errors.some((nested) =>
			nested instanceof Error && nested.message === message,
		);
}
