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
	if (process.env.MESH_MULTI_WINDOW_E2E === '1') {
		void import('./e2e/multiWindowHost.js')
			.then(({ runWithApi }) => runWithApi(application!.api))
			.catch((error: unknown) => {
				process.emitWarning(
					error instanceof Error ? error.message : 'Multi-window E2E controller failed to load.',
					{ code: 'MESH_MULTI_WINDOW_E2E_CONTROLLER_FAILED' },
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
