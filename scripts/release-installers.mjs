import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function prepareReleaseInstallers(root, version) {
	assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
		'Release versions must use the numeric major.minor.patch format supported by VSIX.');
	const installers = [
		{ name: 'install.ps1', pattern: /^\$ExtensionVersion = '[^'\n]*'$/gmu, replacement: `$ExtensionVersion = '${version}'` },
		{ name: 'install.sh', pattern: /^EXTENSION_VERSION='[^'\n]*'$/gmu, replacement: `EXTENSION_VERSION='${version}'` },
	];
	return Promise.all(installers.map(async ({ name, pattern, replacement }) => {
		const source = (await readFile(join(root, 'scripts', name), 'utf8')).replaceAll('\r\n', '\n');
		assert.equal([...source.matchAll(pattern)].length, 1, `${name} must contain exactly one managed extension version.`);
		return { name, content: source.replace(pattern, () => replacement) };
	}));
}

export async function writeReleaseInstallers(root, manifest, installers) {
	const artifacts = join(root, 'artifacts');
	const checksums = await Promise.all([manifest.name, `${manifest.name}-codespaces`].map(async (name) => {
		const asset = `${name}-${manifest.version}-preview.vsix`;
		const digest = createHash('sha256').update(await readFile(join(artifacts, asset))).digest('hex');
		return { name: `${asset}.sha256`, content: `${digest}  ${asset}\n` };
	}));

	await mkdir(artifacts, { recursive: true });
	for (const installer of installers) {
		await writeFile(join(root, 'scripts', installer.name), installer.content, 'utf8');
		await writeFile(join(artifacts, installer.name), installer.content, 'utf8');
	}
	for (const checksum of checksums) {
		await writeFile(join(artifacts, checksum.name), checksum.content, 'utf8');
	}
}
