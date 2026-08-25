import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LocalDesktopWorkspaceGuard, type LocalDesktopEnvironment } from '../../application/LocalDesktopWorkspaceGuard';
import { MeshDomainError } from '../../domain/errors';

function guard(environment: Partial<LocalDesktopEnvironment> = {}): LocalDesktopWorkspaceGuard {
	return new LocalDesktopWorkspaceGuard(() => ({
		remoteName: undefined,
		isTrusted: true,
		workspaceFolders: [{ uriScheme: 'file' }],
		...environment,
	}));
}

function rejectsWith(reason: MeshDomainError['reason'], callback: () => void): void {
	assert.throws(
		callback,
		(error) => error instanceof MeshDomainError && error.reason === reason,
	);
}

describe('LocalDesktopWorkspaceGuard', () => {
	test('allows trusted local file workspaces', () => {
		assert.doesNotThrow(() => guard().assertAllowed());
	});

	test('rejects remote extension hosts with a stable code', () => {
		rejectsWith('REMOTE_WORKSPACE_UNSUPPORTED', () =>
			guard({ remoteName: 'ssh-remote' }).assertAllowed(),
		);
	});

	test('rejects untrusted workspaces with a stable code', () => {
		rejectsWith('WORKSPACE_UNTRUSTED', () =>
			guard({ isTrusted: false }).assertAllowed(),
		);
	});

	test('rejects missing, virtual, and mixed workspace folders', () => {
		for (const workspaceFolders of [
			undefined,
			[],
			[{ uriScheme: 'memfs' }],
			[{ uriScheme: 'file' }, { uriScheme: 'vscode-remote' }],
		]) {
			rejectsWith('LOCAL_FILE_WORKSPACE_REQUIRED', () =>
				guard({ workspaceFolders }).assertAllowed(),
			);
		}
	});

	test('supports non-workspace entry points without weakening remote or trust checks', () => {
		assert.doesNotThrow(() =>
			guard({ workspaceFolders: undefined }).assertAllowed({ requireWorkspace: false }),
		);
		rejectsWith('WORKSPACE_UNTRUSTED', () =>
			guard({ isTrusted: false }).assertAllowed({ requireWorkspace: false }),
		);
	});
});
