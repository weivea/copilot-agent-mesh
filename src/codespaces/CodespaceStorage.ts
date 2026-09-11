import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Resolve VS Code's trusted storage base, including container-mounted aliases, without creating it. */
export async function canonicalCodespaceStorageBase(path: string): Promise<string> {
	if (!isAbsolute(path) || path.includes('\0')) {
		throw new TypeError('VS Code storage must be an absolute filesystem path.');
	}
	let candidate = resolve(path);
	const missing: string[] = [];
	for (let depth = 0; depth < 128; depth += 1) {
		try {
			return join(await realpath(candidate), ...missing);
		} catch (error: unknown) {
			if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
				throw error;
			}
			const parent = dirname(candidate);
			if (parent === candidate) {
				throw error;
			}
			missing.unshift(basename(candidate));
			candidate = parent;
		}
	}
	throw new Error('The VS Code storage path exceeds the supported depth.');
}
