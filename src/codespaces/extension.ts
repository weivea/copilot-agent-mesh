import * as vscode from 'vscode';
import { createCompanionApplication, type CompanionApplication } from './CompanionApplication';

let application: CompanionApplication | undefined;

export function activate(context: vscode.ExtensionContext): void {
	application = createCompanionApplication(vscode, context);
}

export async function deactivate(): Promise<void> {
	const current = application;
	await current?.dispose();
	if (application === current) {
		application = undefined;
	}
}
