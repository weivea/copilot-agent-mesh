import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodespaceCliInstallerError } from '../codespaces/CodespaceCliInstaller';
import {
	codespacePreparedSchema,
	codespacePreparationFailure,
	CODESPACE_PREPARATION_MESSAGES,
} from '../codespaces/CodespaceSetupProtocol';
import { MeshDomainError } from '../domain/errors';

test('runtime preparation transfers only a known error code, never native exception data', () => {
	const result = codespacePreparationFailure(new CodespaceCliInstallerError(
		'ENVIRONMENT_CHECK_FAILED', 'native-private-path-and-token-marker',
	));
	assert.deepEqual(codespacePreparedSchema.parse(result), { ready: false, error: { code: 'ENVIRONMENT_CHECK_FAILED' } });
	assert.doesNotMatch(JSON.stringify(result), /native-private/u);
	assert.deepEqual(codespacePreparationFailure(new MeshDomainError('PROTOCOL_INCOMPATIBLE', 'Private version message.')),
		{ ready: false, error: { code: 'PROTOCOL_INCOMPATIBLE' } });
	assert.deepEqual(codespacePreparationFailure(new Error('Unknown private exception.')),
		{ ready: false, error: { code: 'PREPARATION_FAILED' } });
	for (const code of Object.keys(CODESPACE_PREPARATION_MESSAGES)) {
		assert.equal(codespacePreparedSchema.safeParse({ ready: false, error: { code } }).success, true);
	}
	assert.equal(codespacePreparedSchema.safeParse({ ready: true, error: { code: 'NETWORK_ERROR' } }).success, false);
});

test('preparation cancellation is distinct from a cleanup failure after cancellation', () => {
	const cancelled = new CodespaceCliInstallerError('CANCELLED', 'Cancelled.');
	assert.deepEqual(codespacePreparationFailure(cancelled), { ready: false });
	assert.deepEqual(codespacePreparationFailure(new AggregateError([cancelled, new Error('Cleanup failed.')])),
		{ ready: false, error: { code: 'CLEANUP_FAILED' } });
});

test('all runtime setup diagnostics have native Chinese translations', () => {
	const dictionary = JSON.parse(readFileSync(resolve(__dirname, '../../../l10n/bundle.l10n.zh-cn.json'), 'utf8'));
	for (const message of Object.values(CODESPACE_PREPARATION_MESSAGES)) {
		assert.equal(typeof dictionary[message], 'string', message);
	}
});
