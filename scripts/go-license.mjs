import { statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function resolveGoLicensePath(goroot) {
	const candidates = [join(goroot, 'LICENSE')];
	// Homebrew installs GOROOT in libexec but keeps the license in the package root.
	if (basename(goroot) === 'libexec') {
		candidates.push(join(dirname(goroot), 'LICENSE'));
	}
	for (const candidate of candidates) {
		let info;
		try {
			info = statSync(candidate);
		} catch (error) {
			if (error?.code === 'ENOENT') {
				continue;
			}
			throw error;
		}
		if (!info.isFile()) {
			throw new Error(`The Go license at ${candidate} is not a regular file.`);
		}
		return candidate;
	}
	throw new Error(`The Go toolchain license was not found. Expected ${candidates.join(' or ')}.`);
}
