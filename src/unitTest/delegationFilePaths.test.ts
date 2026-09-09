import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDelegatedFileUri } from '../node/DelegationGrant';

test('Windows delegated file URIs preserve drive, spaces and UNC share paths', () => {
	assert.equal(
		parseDelegatedFileUri('file:///C:/mesh%20workspace/src/file.ts', 'win32'),
		'C:\\mesh workspace\\src\\file.ts',
	);
	assert.equal(
		parseDelegatedFileUri('file://server/share/mesh%20workspace/src/file.ts', 'win32'),
		'\\\\server\\share\\mesh workspace\\src\\file.ts',
	);
	assert.equal(
		parseDelegatedFileUri('file://localhost/C:/workspace/file.ts', 'win32'),
		'C:\\workspace\\file.ts',
	);
});

test('UNC support does not admit non-file schemes, traversal, encoded separators or ambiguous URI suffixes', () => {
	for (const value of [
		'https://server/share/file.ts',
		'file://server/share/../outside.ts',
		'file://server/share/%2e%2e/outside.ts',
		'file://server/share/src%2Ffile.ts',
		'file://server/share/src%5Cfile.ts',
		'file://server/share/src/file.ts?other',
		'file://server/share/src/file.ts#other',
		'src/file.ts',
	]) {
		assert.throws(() => parseDelegatedFileUri(value, 'win32'), value);
	}
	assert.throws(() => parseDelegatedFileUri('file://server/share/file.ts', 'linux'));
	assert.throws(() => parseDelegatedFileUri('file:///C:/workspace/file.ts', 'darwin'));
	assert.equal(parseDelegatedFileUri('file:///workspace/src/file.ts', 'linux'), '/workspace/src/file.ts');
});
