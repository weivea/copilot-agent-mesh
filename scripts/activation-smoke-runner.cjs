const assert = require('node:assert/strict');
const { access, readFile } = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
	const extension = vscode.extensions.getExtension('weivea.copilot-agent-mesh');
	assert.ok(extension, 'The installed Preview extension was not found.');
	const relative = path.relative(process.env.MESH_SMOKE_EXTENSIONS_DIR, extension.extensionPath);
	assert.ok(
		relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
		`The smoke loaded an extension outside the isolated directory: ${extension.extensionPath}`,
	);
	assert.equal(extension.packageJSON.version, process.env.MESH_SMOKE_EXTENSION_VERSION);
	assert.equal(extension.packageJSON.preview, true);
	assert.equal(extension.packageJSON.contributes.configuration.properties[
		'copilotAgentMesh.experimental.agentHost'
	], undefined);
	assert.equal(extension.packageJSON.contributes.configuration.properties[
		'copilotAgentMesh.experimental.peerDelegation'
	].default, true);
	await Promise.all(['x64', 'arm64'].map((architecture) => access(
		path.join(extension.extensionPath, 'dist', 'windows', `mesh-process-host-${architecture}.exe`),
	)));

	await extension.activate();
	assert.equal(extension.isActive, true);
	console.log(`Activated installed Preview extension from ${extension.extensionPath}`);
	if (process.env.MESH_SMOKE_COMPANION_VERSION) {
		const companion = vscode.extensions.getExtension('weivea.copilot-agent-mesh-codespaces');
		assert.ok(companion, 'The installed Codespaces companion was not found.');
		const companionRelative = path.relative(process.env.MESH_SMOKE_EXTENSIONS_DIR, companion.extensionPath);
		assert.ok(companionRelative !== '' && !path.isAbsolute(companionRelative)
			&& companionRelative !== '..' && !companionRelative.startsWith(`..${path.sep}`));
		assert.equal(companion.packageJSON.version, process.env.MESH_SMOKE_COMPANION_VERSION);
		assert.deepEqual(companion.packageJSON.extensionKind, ['workspace']);
		const companionManifest = JSON.parse(await readFile(path.join(companion.extensionPath, 'package.json'), 'utf8'));
		assert.deepEqual(companionManifest.enabledApiProposals, ['chatSessionsProvider', 'chatParticipantPrivate']);
		assert.equal(companion.packageJSON.contributes.languageModelTools, undefined);
		await companion.activate();
		assert.equal(companion.isActive, true);
		assert.deepEqual(await vscode.commands.executeCommand('copilotAgentMesh.codespaces.nativeChatStatus'),
			{ state: 'unsupportedEnvironment' });
		console.log(`Activated installed companion without starting a Codespace runtime: ${companion.extensionPath}`);
	}
}

module.exports = { run };
