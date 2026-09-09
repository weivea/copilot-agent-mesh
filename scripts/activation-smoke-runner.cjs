const assert = require('node:assert/strict');
const { access } = require('node:fs/promises');
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
}

module.exports = { run };
