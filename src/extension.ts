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
	return application.api;
}

export async function deactivate(): Promise<void> {
	const current = application;
	application = undefined;
	await current?.dispose();
}
