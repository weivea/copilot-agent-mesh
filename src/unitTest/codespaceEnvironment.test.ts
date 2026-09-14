import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	assertCodespaceExecutionEnvironment,
	codespaceFileUri,
	describeCodespaceWorkspaces,
	desktopCodespaceBinding,
} from '../codespaces/CodespaceEnvironment';
import { createOpaqueWorkspaceIdentity } from '../workspaces/OpaqueWorkspaceIdentity';

test('desktop Codespaces mapping preserves remote paths without consulting the desktop filesystem', () => {
	const uri = 'vscode-remote://codespaces+example/workspaces/a%20b';
	assert.deepEqual(desktopCodespaceBinding({
		remoteName: 'codespaces', uiKind: 'desktop', extensionKind: 'ui', isTrusted: true,
		workspaceFolders: [{ uriScheme: 'vscode-remote', uriAuthority: 'codespaces+example' }],
	}, [{ uri, name: 'a b' }]), {
		authority: 'codespaces+example',
		expectedFolders: ['file:///workspaces/a%20b'],
	});
	assert.equal(desktopCodespaceBinding({
		remoteName: undefined, isTrusted: true, workspaceFolders: [{ uriScheme: 'file' }],
	}, [{ uri: 'file:///local', name: 'local' }]), undefined);
});

test('URI mapping rejects different authorities, credentials, fragments and non-remote schemes', () => {
	for (const uri of [
		'vscode-remote://codespaces+other/workspaces/repo',
		'vscode-remote://user@codespaces+example/workspaces/repo',
		'vscode-remote://codespaces+example/workspaces/repo?query=1',
		'vscode-remote://codespaces+example/workspaces/repo#fragment',
		'vscode-remote://codespaces%252Bexample/workspaces/repo',
		'vscode-remote://codespaces%2Bexample%2Fother/workspaces/repo',
		'file:///workspaces/repo',
		'not a uri',
	]) {
		assert.throws(() => codespaceFileUri(uri, 'codespaces+example'));
	}
});

test('VS Code serialized authorities decode once and remain bound to the actual window authority', () => {
	const environment = {
		remoteName: 'codespaces', uiKind: 'desktop' as const, extensionKind: 'ui' as const, isTrusted: true,
		workspaceFolders: [{ uriScheme: 'vscode-remote', uriAuthority: 'codespaces+example' }],
	};
	const uri = 'vscode-remote://codespaces%2Bexample/workspaces/a%20b%25file';
	assert.equal(codespaceFileUri(uri, 'codespaces+example'), 'file:///workspaces/a%20b%25file');
	assert.deepEqual(desktopCodespaceBinding(environment, [{ uri, name: 'a b%file' }]), {
		authority: 'codespaces+example', expectedFolders: ['file:///workspaces/a%20b%25file'],
	});
	assert.throws(() => desktopCodespaceBinding(environment, [
		{ uri: 'vscode-remote://codespaces%2Bother/workspaces/repo', name: 'Other' },
	]));
});

test('companion admission does not widen generic Linux, browser or untrusted workspace support', () => {
	const valid = {
		remoteName: 'codespaces', uiKind: 'desktop' as const, extensionKind: 'workspace' as const,
		isTrusted: true, platform: 'linux' as const, architecture: 'x64',
	};
	assert.doesNotThrow(() => assertCodespaceExecutionEnvironment(valid));
	for (const override of [
		{ remoteName: 'ssh-remote' }, { remoteName: undefined }, { uiKind: 'web' as const },
		{ extensionKind: 'ui' as const }, { isTrusted: false }, { platform: 'win32' as const },
		{ architecture: 'ia32' },
	]) {
		assert.throws(() => assertCodespaceExecutionEnvironment({ ...valid, ...override }));
	}
});

test('remote workspace identities distinguish identical inodes in different Codespaces', async () => {
	const calls: string[] = [];
	const resolver = { resolve: async (uri: string) => {
		calls.push(uri);
		return { canonicalUri: 'file:///workspaces/repo', identity: 'file:1:42' };
	} };
	const folders = [{ uri: 'file:///workspaces/repo', name: 'Repo', capabilityTags: ['linux'] }];
	const [a] = await describeCodespaceWorkspaces('codespaces+a', folders, resolver);
	const [b] = await describeCodespaceWorkspaces('codespaces+b', folders, resolver);
	assert.notEqual(createOpaqueWorkspaceIdentity(a.fileIdentity), createOpaqueWorkspaceIdentity(b.fileIdentity));
	assert.deepEqual(calls, ['file:///workspaces/repo', 'file:///workspaces/repo']);
	assert.equal(a.canonicalUri, 'file:///workspaces/repo');
	assert.deepEqual(a.capabilityTags, ['linux']);
	await assert.rejects(describeCodespaceWorkspaces('codespaces+a', [], resolver));
	await assert.rejects(describeCodespaceWorkspaces('codespaces+a', [
		{ uri: 'vscode-remote://codespaces+b/workspaces/repo', name: 'Wrong' },
	], resolver));
});

test('remote display metadata applies the same UTF-8 and empty-tag rules as desktop workspaces', async () => {
	const [workspace] = await describeCodespaceWorkspaces('codespaces+test', [{
		uri: 'file:///workspace',
		name: '\u754c'.repeat(200),
		capabilityTags: ['   ', '  typescript ', '\u754c'.repeat(64)],
	}], { resolve: async (uri) => ({ canonicalUri: uri, identity: 'file:1:2' }) });
	assert.ok(Buffer.byteLength(workspace.name, 'utf8') <= 256);
	assert.equal(workspace.capabilityTags[0], 'typescript');
	assert.equal(workspace.capabilityTags.length, 2);
	assert.ok(Buffer.byteLength(workspace.capabilityTags[1], 'utf8') <= 64);
	assert.ok(!workspace.name.includes('\ufffd'));
});
