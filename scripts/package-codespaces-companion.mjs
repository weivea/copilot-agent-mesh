import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVSIX } from '@vscode/vsce';
import { readCentralDirectory } from './vsix-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const main = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const companion = JSON.parse(await readFile(join(root, 'companion', 'package.json'), 'utf8'));
assert.equal(companion.publisher, main.publisher);
assert.equal(companion.version, main.version, 'Main and companion versions must match.');
await mkdir(join(root, 'out'), { recursive: true });
await mkdir(join(root, 'artifacts'), { recursive: true });
const stage = await mkdtemp(join(root, 'out', 'codespaces-package-'));
const artifact = join(root, 'artifacts', `${companion.name}-${main.version}-preview.vsix`);
try {
	await mkdir(join(stage, 'dist'));
	await mkdir(join(stage, 'l10n'));
	await writeFile(join(stage, 'package.json'), JSON.stringify(companion, null, 2));
	for (const name of ['LICENSE', 'NOTICE']) {
		await copyFile(join(root, name), join(stage, name));
	}
	await copyFile(join(root, 'companion', 'README.md'), join(stage, 'README.md'));
	await copyFile(join(root, 'l10n', 'bundle.l10n.zh-cn.json'), join(stage, 'l10n', 'bundle.l10n.zh-cn.json'));
	await copyFile(join(root, 'dist', 'codespaces-companion.js'), join(stage, 'dist', 'extension.js'));
	await copyFile(join(root, 'dist', 'THIRD_PARTY_NOTICES.txt'), join(stage, 'dist', 'THIRD_PARTY_NOTICES.txt'));
	await createVSIX({
		cwd: stage,
		readmePath: 'README.md',
		packagePath: artifact,
		dependencies: false,
		preRelease: true,
	});
	assert.deepEqual(readCentralDirectory(await readFile(artifact)).sort(), [
		'[Content_Types].xml', 'extension.vsixmanifest', 'extension/LICENSE.txt',
		'extension/NOTICE', 'extension/dist/extension.js', 'extension/dist/THIRD_PARTY_NOTICES.txt',
		'extension/package.json', 'extension/readme.md',
		'extension/l10n/bundle.l10n.zh-cn.json',
	].sort(), 'The companion VSIX must contain only its bundled runtime and notices.');
	await copyFile(artifact, join(root, 'dist', 'codespaces-companion.vsix'));
	console.log(`Packaged matching Codespaces companion: ${artifact}`);
} finally {
	await rm(stage, { recursive: true, force: true });
}
