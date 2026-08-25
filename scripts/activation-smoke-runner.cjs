const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
	const extension = vscode.extensions.getExtension('weivea.copilot-agent-mesh');
	assert.ok(extension, 'The installed Preview extension was not found.');
	assert.ok(
		path.resolve(extension.extensionPath).startsWith(path.resolve(process.env.MESH_SMOKE_EXTENSIONS_DIR)),
		`The smoke loaded an extension outside the isolated directory: ${extension.extensionPath}`,
	);
	assert.equal(extension.packageJSON.version, '0.1.0');
	assert.equal(extension.packageJSON.preview, true);
	assert.equal(
		extension.packageJSON.contributes.configuration.properties[
			'copilotAgentMesh.experimental.agentHost'
		].default,
		false,
	);

	await extension.activate();
	assert.equal(extension.isActive, true);
	console.log(`Activated installed Preview extension from ${extension.extensionPath}`);
}

module.exports = { run };
