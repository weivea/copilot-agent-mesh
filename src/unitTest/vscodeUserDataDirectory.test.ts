import assert from 'node:assert/strict';
import { test } from 'node:test';

import { userDataDirectoryFromGlobalStorage } from '../composition/VscodeUserDataDirectory';

test('Windows editor discovery derives custom, portable and named-profile User Data from its own storage', () => {
	for (const root of [
		'C:\\Users\\mesh\\AppData\\Roaming\\Code',
		'C:\\Users\\mesh\\AppData\\Roaming\\Code - Insiders',
		'D:\\Portable Code\\data\\user-data',
		'E:\\isolated profile',
		'\\\\server\\share\\Code Data',
	]) {
		for (const profile of ['User', 'User\\profiles\\profile-id']) {
			assert.equal(
				userDataDirectoryFromGlobalStorage(`${root}\\${profile}\\globalStorage\\weivea.copilot-agent-mesh`, 'win32'),
				root,
			);
		}
	}
});

test('macOS and Linux editor discovery retain the exact current instance root', () => {
	for (const platform of ['darwin', 'linux'] as const) {
		assert.equal(
			userDataDirectoryFromGlobalStorage('/custom Code/User/globalStorage/weivea.copilot-agent-mesh', platform),
			'/custom Code',
		);
		assert.equal(
			userDataDirectoryFromGlobalStorage('/custom Code/User/profiles/profile-id/globalStorage/weivea.copilot-agent-mesh', platform),
			'/custom Code',
		);
	}
});

test('unrecognized storage layouts do not invent a different profile root', () => {
	for (const path of ['relative\\globalStorage\\extension', 'C:\\unrelated\\globalStorage\\extension', 'C:\\User\\workspaceStorage\\extension']) {
		assert.equal(userDataDirectoryFromGlobalStorage(path, 'win32'), undefined);
	}
});
