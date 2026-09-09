import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentRuntimeError } from '../agentHost/AgentRuntime';
import { EditorAgentHostLauncher } from '../agentHost/AgentHostSourceSelector';
import { EditorAgentHostLocator, EditorAgentHostLocatorError } from '../agentHost/EditorAgentHostLocator';
import { UnixSocketWebSocketConnector } from '../agentHost/UnixSocketWebSocketConnector';

test('editor discovery cleanup failures prevent a success-shaped fallback and are retried during disposal', async () => {
	const locator = new EditorAgentHostLocator();
	locator.locate = async () => {
		throw new EditorAgentHostLocatorError('COMMAND_FAILED', 'private diagnostic', true);
	};
	let cleanupAttempts = 0;
	locator.dispose = async () => {
		cleanupAttempts += 1;
		if (cleanupAttempts === 1) {
			throw new Error('Native CLI cleanup still pending.');
		}
	};
	const launcher = new EditorAgentHostLauncher(locator, new UnixSocketWebSocketConnector());
	await assert.rejects(launcher.launch(), (error: unknown) =>
		error instanceof AgentRuntimeError && error.cleanupFailed
		&& error.cause === undefined && !error.message.includes('private diagnostic'));
	await assert.rejects(launcher.dispose(), /cleanup still pending/u);
	await launcher.dispose();
	assert.equal(cleanupAttempts, 2);
	await assert.rejects(launcher.launch(), /disposed/u);
});
