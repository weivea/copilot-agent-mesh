import { isAbsolute, join, resolve } from 'node:path';
import { pathKey, pathsOverlap } from './platform.mjs';

export function resolveHarnessProfile(prefix, runRoot, environment = process.env) {
	const configuredBase = environment[`${prefix}_PROFILE_DIR`];
	const persistent = configuredBase !== undefined;
	const base = persistent ? resolve(configuredBase) : join(runRoot, 'profile');
	const configuredUserData = environment[`${prefix}_USER_DATA_DIR`];
	const configuredExtensions = environment[`${prefix}_EXTENSIONS_DIR`];
	for (const [name, configured] of [
		['USER_DATA_DIR', configuredUserData],
		['EXTENSIONS_DIR', configuredExtensions],
	]) {
		if (configured !== undefined && (!persistent || !isAbsolute(configured))) {
			throw new Error(`${prefix}_${name} requires an absolute path and an explicit dedicated PROFILE_DIR.`);
		}
	}
	const userData = configuredUserData === undefined ? join(base, 'user-data') : resolve(configuredUserData);
	const extensions = configuredExtensions === undefined ? join(runRoot, 'extensions') : resolve(configuredExtensions);
	for (const configured of [configuredUserData, configuredExtensions].filter((value) => value !== undefined)) {
		if (!pathsOverlap(base, configured) || !pathKey(configured).startsWith(pathKey(base))) {
			throw new Error('Reused User Data and extensions must remain beneath the explicit dedicated profile root.');
		}
	}
	if (pathsOverlap(userData, extensions)) {
		throw new Error('User Data and extensions directories must not overlap.');
	}
	return { base, persistent, userData, extensions, reusedExtensions: configuredExtensions !== undefined };
}
