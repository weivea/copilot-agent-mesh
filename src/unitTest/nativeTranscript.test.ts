import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nativeTranscriptText, NativeTranscriptRedactor } from '../codespaces/nativeChat/NativeChatExecution';
import { registerSensitiveValues } from '../security/SensitiveValueRedaction';

test('native transcript preserves local markdown, newlines and workspace paths', () => {
	const text = '## Changes\n\nUpdated `/workspaces/demo/src/main.ts`.\n```ts\nconst value = 42;\n```\n';
	assert.equal(nativeTranscriptText(text), text);
	const redactor = new NativeTranscriptRedactor();
	let result = '';
	for (const chunk of [text.slice(0, 13), text.slice(13, 40), text.slice(40)]) {
		result += redactor.write(chunk);
	}
	result += redactor.flush();
	assert.equal(result, text);
});

test('native transcript does not persist a registered secret split between output events', () => {
	const secret = 'native-transcript-private-capability-3785026';
	const registration = registerSensitiveValues([secret]);
	try {
		const redactor = new NativeTranscriptRedactor();
		let result = '';
		for (const chunk of ['A result\n', secret.slice(0, 10), secret.slice(10), '\nSafe final line\n']) {
			result += redactor.write(chunk);
		}
		result += redactor.flush();
		assert.ok(!result.includes(secret));
		assert.ok(!result.includes(secret.slice(0, 10)));
		assert.match(result, /redacted|omitted/i);
		assert.match(result, /Safe final line/);
	} finally { registration.dispose(); }
});

test('native transcript omits credential assignments spanning lines', () => {
	const redactor = new NativeTranscriptRedactor();
	const secret = 'a-private-value-that-must-not-be-persisted';
	const result = redactor.write('A result\npassword:\n')
		+ redactor.write(secret + '\n')
		+ redactor.flush();
	assert.ok(!result.includes(secret));
	assert.match(result, /omitted|redacted/i);
});

test('a credential value after blank lines is not recorded as a fresh safe line', () => {
	const redactor = new NativeTranscriptRedactor();
	const result = redactor.write('password:\n') + redactor.write('\nprivate-value\nSafe text\n') + redactor.flush();
	assert.ok(!result.includes('private-value'));
	assert.match(result, /Safe text/);
});

test('native transcript marks oversized lines rather than storing unbounded or partial sensitive text', () => {
	const redactor = new NativeTranscriptRedactor();
	const result = redactor.write('a'.repeat(20_000))
		+ redactor.write('tail')
		+ redactor.write('\nNext line\n')
		+ redactor.flush();
	assert.ok(result.length < 200);
	assert.match(result, /omitted/);
	assert.match(result, /Next line/);
	assert.ok(!result.includes('tail'));
});
