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
	const skillNames = ['mesh-delegate', 'mesh-execute'];
	assert.deepEqual(extension.packageJSON.contributes.chatSkills,
		skillNames.map((name) => ({ path: `./skills/${name}/SKILL.md` })));
	for (const name of skillNames) {
		const markdown = (await readFile(path.join(extension.extensionPath, 'skills', name, 'SKILL.md'), 'utf8'))
			.replace(/\r\n/gu, '\n');
		assert.match(markdown, new RegExp(`^name: ${name}$`, 'mu'));
		assert.match(markdown, /^disable-model-invocation: true$/mu);
	}

	const api = await bounded(extension.activate(), 'Installed extension activation');
	assert.equal(extension.isActive, true);
	await bounded(vscode.commands.executeCommand('copilotAgentMesh.dashboard.focus'), 'Dashboard view resolution');
	const takeoverState = process.env.MESH_SMOKE_TAKEOVER_STATE;
	if (takeoverState === 'live' || takeoverState === 'malformed') {
		await bounded((async () => {
			while (true) {
				let state;
				try { state = api.brokerState(); } catch { /* Backend not constructed yet. */ }
				if (state?.error?.code === 'BROKER_TAKEOVER_BLOCKED') { return; }
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		})(), 'Blocked Broker status');
		assert.equal(api.brokerState().owner, false);
		assert.equal(api.brokerState().error?.code, 'BROKER_TAKEOVER_BLOCKED');
		assert.equal(await readFile(path.join(process.env.MESH_SMOKE_STORAGE_ROOT, 'worker-owner.takeover'), 'utf8'),
			process.env.MESH_SMOKE_TAKEOVER_CONTENT);
		console.log(`Dashboard resolved with ${takeoverState} mutex preserved and explicit BROKER_TAKEOVER_BLOCKED.`);
		await bounded(vscode.commands.executeCommand('copilotAgentMesh.refreshDashboard'), 'Startup Dashboard refresh');
		if (takeoverState === 'malformed') {
			await assert.rejects(bounded(api.ready, 'Failed backend startup', 40_000), /Timed out waiting for the Broker owner/u);
			await bounded(vscode.commands.executeCommand('copilotAgentMesh.dashboard.focus'), 'Failed startup Dashboard');
			console.log('Dashboard remains available after backend identity startup fails explicitly.');
		}
	} else {
		await bounded(api.ready, 'Backend startup');
		await bounded(api.node.start(), 'First Broker connection');
		assert.equal(api.brokerState().state, 'running');
		assert.equal(api.nodeState().registered, true);
		if (takeoverState === 'orphan') {
			await assert.rejects(access(path.join(process.env.MESH_SMOKE_STORAGE_ROOT, 'worker-owner.takeover')),
				{ code: 'ENOENT' });
			console.log('Orphan takeover recovered; Dashboard resolved and the Window Node connected.');
		}
	}
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

async function bounded(operation, name, timeoutMs = 20_000) {
	let timer;
	try {
		return await Promise.race([
			operation,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${name} exceeded ${timeoutMs / 1_000} seconds.`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

module.exports = { run };
