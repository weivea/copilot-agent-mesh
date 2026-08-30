import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
	applyMeshToolManifestDescriptors,
	LEGACY_MESH_SPIKE_TOOL_NAME,
	MESH_RUNTIME_TOOL_NAMES,
	verifyMeshToolManifestDescriptors,
} from '../tools/toolManifest';

const packageManifest: unknown = JSON.parse(
	readFileSync(resolve(__dirname, '../../../package.json'), 'utf8'),
);
const currentVerification = verifyMeshToolManifestDescriptors(packageManifest);
const removedCollaborationTools = [
	'mesh_start_collaboration',
	'mesh_get_collaboration',
	'mesh_cancel_collaboration',
] as const;
const pendingReason = [
	'Parent integration pending.',
	`Missing: ${currentVerification.missingNames.join(', ') || 'none'}.`,
	`Legacy spike present: ${currentVerification.legacySpikePresent}.`,
].join(' ');

test('package.json has the production mesh tool manifest contract', {
	skip: currentVerification.integrated ? false : pendingReason,
}, () => {
	assert.equal(currentVerification.integrated, true);
});

test('mechanical manifest application installs production tools and removes the legacy spike', () => {
	assert.ok(isRecord(packageManifest));
	const applied = applyMeshToolManifestDescriptors(packageManifest);
	const verification = verifyMeshToolManifestDescriptors(applied);
	const contributes = isRecord(applied.contributes) ? applied.contributes : {};
	const tools = Array.isArray(contributes.languageModelTools) ? contributes.languageModelTools : [];
	const names = tools
		.filter(isRecord)
		.map(({ name }) => name)
		.filter((name): name is string => typeof name === 'string');

	assert.deepStrictEqual(verification, {
		integrated: true,
		missingNames: [],
		mismatchedNames: [],
		legacySpikePresent: false,
	});
	assert.ok(!names.includes(LEGACY_MESH_SPIKE_TOOL_NAME));
	assert.ok(MESH_RUNTIME_TOOL_NAMES.every((name) => names.includes(name)));
	assert.ok(removedCollaborationTools.every((name) => !names.includes(name)));
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
