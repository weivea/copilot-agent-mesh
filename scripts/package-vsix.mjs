import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVSIX } from '@vscode/vsce';
import { prepareReleaseInstallers, writeReleaseInstallers } from './release-installers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const companion = JSON.parse(await readFile(join(root, 'companion', 'package.json'), 'utf8'));
assert.equal(companion.version, manifest.version, 'Main and companion versions must match.');
const installers = await prepareReleaseInstallers(root, manifest.version);
const packagePath = join(root, 'artifacts', `${manifest.name}-${manifest.version}-preview.vsix`);
await mkdir(join(root, 'artifacts'), { recursive: true });

await createVSIX({
	cwd: root,
	packagePath,
	dependencies: false,
	preRelease: true,
});
execFileSync(process.execPath, [join(root, 'scripts', 'verify-vsix.mjs'), packagePath], {
	cwd: root,
	stdio: 'inherit',
});
await writeReleaseInstallers(root, manifest, installers);
console.log(`Prepared v${manifest.version} release installers and SHA-256 sidecars in artifacts.`);
