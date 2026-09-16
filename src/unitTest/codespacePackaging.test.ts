import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
	CODESPACES_COMPANION_ID,
	CODESPACES_PREPARE_RUNTIME_COMMAND,
	CODESPACES_SETUP_COMMAND,
} from '../codespaces/CodespaceEnvironment';
import { MESH_RUNTIME_TOOL_NAMES } from '../tools/toolManifest';

const root = resolve(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('desktop and companion manifests preserve one public tool surface with separate execution hosts', () => {
	const main = JSON.parse(read('package.json'));
	const companion = JSON.parse(read('companion/package.json'));
	const lock = JSON.parse(read('package-lock.json'));
	assert.deepEqual(main.extensionKind, ['ui']);
	assert.deepEqual(companion.extensionKind, ['workspace']);
	assert.equal(`${companion.publisher}.${companion.name}`, CODESPACES_COMPANION_ID);
	assert.equal(companion.version, main.version);
	assert.equal(lock.version, main.version);
	assert.equal(lock.packages[''].version, main.version);
	assert.equal(companion.api, 'none');
	assert.equal(companion.contributes.languageModelTools, undefined);
	assert.deepEqual(main.contributes.languageModelTools.map((tool: { name: string }) => tool.name), MESH_RUNTIME_TOOL_NAMES);
	assert.equal(companion.capabilities.untrustedWorkspaces.supported, false);
	assert.equal(companion.capabilities.virtualWorkspaces.supported, false);
	assert.ok(companion.activationEvents.includes('onCommand:copilotAgentMesh.codespaces.connect'));
	assert.ok(companion.contributes.commands.some((entry: { command: string }) => entry.command === CODESPACES_PREPARE_RUNTIME_COMMAND));
	assert.ok(main.contributes.commands.some((entry: { command: string }) => entry.command === CODESPACES_SETUP_COMMAND));
});

test('release packages the exact companion without including native CLI downloads or loose helper output', () => {
	const main = JSON.parse(read('package.json'));
	assert.equal(main.scripts['package:vsix'], 'node scripts/package-vsix.mjs && npm run vsix:list');
	assert.equal(main.scripts['verify:vsix'], 'npm run vsix:list && node scripts/verify-vsix.mjs');
	assert.equal(main.scripts['smoke:vsix'], 'node scripts/smoke-vsix.mjs');
	for (const script of ['package-vsix.mjs', 'verify-vsix.mjs', 'smoke-vsix.mjs']) {
		assert.ok(read(`scripts/${script}`).includes('${manifest.version}-preview.vsix'),
			`${script} must derive its default artifact from the current package version`);
	}
	assert.ok(main.files.includes('dist/codespaces-companion.vsix'));
	assert.ok(!main.files.includes('dist/**'));
	assert.ok(!main.files.includes('dist/codespaces-companion.js'));
	assert.match(read('esbuild.js'), /'codespaces-companion': 'src\/codespaces\/extension\.ts'/u);
	assert.match(read('scripts/package-codespaces-companion.mjs'), /createVSIX/u);
	assert.match(read('scripts/package-codespaces-companion.mjs'), /readCentralDirectory/u);
	assert.equal(main.dependencies['@github/copilot-sdk'], undefined);
});
