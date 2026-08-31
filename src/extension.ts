import type * as vscode from 'vscode';

import {
	createApplication,
	type AgentMeshExtensionApi,
	type Application,
} from './composition/createApplication';

let application: Application | undefined;

export async function activate(
	context: vscode.ExtensionContext,
): Promise<AgentMeshExtensionApi> {
	application = await createApplication(context);
	const multiWindowMode = process.env.MESH_MULTI_WINDOW_E2E === '1';
	const peerDelegationMode = process.env.MESH_PEER_DELEGATION_E2E === '1';
	if (multiWindowMode) {
		void import('./e2e/multiWindowHost.js')
			.then(({ runWithApi }) => runWithApi(application!.api))
			.catch((error: unknown) => {
				process.emitWarning(
					error instanceof Error ? error.message : 'Multi-window E2E controller failed to load.',
					{ code: 'MESH_MULTI_WINDOW_E2E_CONTROLLER_FAILED' },
				);
			});
	}
	if (peerDelegationMode) {
		void import('./e2e/peerDelegationHost.js')
			.then(({ runWithApi }) => runWithApi(application!.api))
			.catch((error: unknown) => {
				process.emitWarning(
					error instanceof Error ? error.message : 'Peer-delegation E2E controller failed to load.',
					{ code: 'MESH_PEER_DELEGATION_E2E_CONTROLLER_FAILED' },
				);
			});
	}
	return application.api;
}

export async function deactivate(): Promise<void> {
	const current = application;
	application = undefined;
	await current?.dispose();
}
