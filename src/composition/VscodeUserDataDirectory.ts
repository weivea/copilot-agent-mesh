import { posix, win32 } from 'node:path';

export function userDataDirectoryFromGlobalStorage(
	globalStoragePath: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const paths = platform === 'win32' ? win32 : posix;
	if (!paths.isAbsolute(globalStoragePath)) {
		return undefined;
	}
	const storage = paths.dirname(globalStoragePath);
	if (paths.basename(storage).toLowerCase() !== 'globalstorage') {
		return undefined;
	}
	const profile = paths.dirname(storage);
	if (paths.basename(profile).toLowerCase() === 'user') {
		return paths.dirname(profile);
	}
	const profiles = paths.dirname(profile);
	const user = paths.dirname(profiles);
	if (paths.basename(profiles).toLowerCase() === 'profiles'
		&& paths.basename(user).toLowerCase() === 'user') {
		return paths.dirname(user);
	}
	return undefined;
}
