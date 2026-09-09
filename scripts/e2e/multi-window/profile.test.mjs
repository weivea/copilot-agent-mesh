import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveHarnessProfile } from './profile.mjs';

const prefix = 'MESH_MULTI_WINDOW_E2E';
const base = resolve('.vscode-test', 'dedicated-login');
const runtime = resolve('.mw', 'owned-run');

test('dedicated authentication profile and installed extensions are reused in place', () => {
	const profile = resolveHarnessProfile(prefix, runtime, {
		[`${prefix}_PROFILE_DIR`]: base,
		[`${prefix}_USER_DATA_DIR`]: join(base, 'profile'),
		[`${prefix}_EXTENSIONS_DIR`]: join(base, 'extensions'),
	});
	assert.equal(profile.userData, join(base, 'profile'));
	assert.equal(profile.extensions, join(base, 'extensions'));
	assert.equal(profile.reusedExtensions, true);
	assert.equal(profile.persistent, true);
});

test('existing dedicated-profile layout remains compatible', () => {
	const profile = resolveHarnessProfile(prefix, runtime, { [`${prefix}_PROFILE_DIR`]: base });
	assert.equal(profile.userData, join(base, 'user-data'));
	assert.equal(profile.extensions, join(runtime, 'extensions'));
	assert.equal(profile.reusedExtensions, false);
});

test('profile reuse requires explicit consent and cannot escape or overlap', () => {
	for (const environment of [
		{ [`${prefix}_USER_DATA_DIR`]: join(base, 'profile') },
		{ [`${prefix}_PROFILE_DIR`]: base, [`${prefix}_USER_DATA_DIR`]: 'relative' },
		{ [`${prefix}_PROFILE_DIR`]: base, [`${prefix}_USER_DATA_DIR`]: resolve('unrelated-profile') },
		{ [`${prefix}_PROFILE_DIR`]: base, [`${prefix}_EXTENSIONS_DIR`]: join(base, 'user-data', 'extensions') },
		{ [`${prefix}_PROFILE_DIR`]: base, [`${prefix}_EXTENSIONS_DIR`]: resolve('unrelated-extensions') },
	]) {
		assert.throws(() => resolveHarnessProfile(prefix, runtime, environment));
	}
});

test('short diagnostic submits one task, never auto-approves input and never starts a Tunnel', async () => {
	const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
	const diagnostic = source.slice(
		source.indexOf('async function runDiagnosticTask'),
		source.indexOf('async function runProductionTask'),
	);
	assert.equal((diagnostic.match(/'task\.start'/gu) ?? []).length, 1);
	assert.doesNotMatch(diagnostic, /'task\.answer'/u);
	assert.match(diagnostic, /'needsInput'/u);
	assert.match(diagnostic, /finally[\s\S]*confirmTaskCancellation/u);
	assert.match(diagnostic, /MESH_WINDOWS_DIAGNOSTIC_OK/u);
	assert.match(diagnostic, /probe\.editorOnly !== true/u);
	assert.match(diagnostic, /requireEditor: true/u);
	assert.match(diagnostic, /runtimeCanStart\(probe\)/u);
	assert.doesNotMatch(source, /'listener\.start'|'tunnel\.create'/u);
	assert.match(source, /diagnosticTask && !realTaskEnabled/u);
	assert.match(source, /'single-task-diagnostic'/u);
});
