import * as vscode from 'vscode';

import type { TaskStatus } from '../../shared/protocol';

export type ListenerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'unavailable';
export type PeerState = 'connecting' | 'online' | 'busy' | 'offline' | 'authFailed' | 'incompatible';
export type TaskState = TaskStatus;

export interface ComponentSnapshot {
	readonly state: 'ready' | 'stopped' | 'error' | 'unavailable';
	readonly label: string;
	readonly detail?: string;
	readonly action?: string;
}

export interface DashboardSnapshot {
	readonly device: {
		readonly name: string;
		readonly platform: string;
		readonly architecture: string;
		readonly vscodeVersion: string;
		readonly extensionVersion: string;
	};
	readonly listener: {
		readonly state: ListenerState;
		readonly gateway: ComponentSnapshot;
		readonly tunnel: ComponentSnapshot;
		readonly agentHost: ComponentSnapshot;
		readonly canStart: boolean;
		readonly canStop: boolean;
		readonly canCopyConnectionUrl: boolean;
	};
	readonly workspaces: readonly {
		readonly workspaceId: string;
		readonly name: string;
		readonly capabilityTags: readonly string[];
		readonly enabled: boolean;
		readonly busy: boolean;
		readonly activeTaskId?: string;
	}[];
	readonly peers: readonly {
		readonly peerId: string;
		readonly name: string;
		readonly state: PeerState;
		readonly latencyMs?: number;
		readonly lastSeenLabel?: string;
		readonly workspaceCount: number;
	}[];
	readonly tasks: readonly {
		readonly taskId: string;
		readonly title: string;
		readonly peerName: string;
		readonly workspaceName: string;
		readonly state: TaskState;
		readonly phase?: string;
		readonly summary?: string;
		readonly summaryTruncated?: boolean;
		readonly canCancel: boolean;
		readonly needsInput: boolean;
		readonly error?: {
			readonly code: string;
			readonly message: string;
			readonly action?: string;
		};
	}[];
	readonly errors: readonly {
		readonly code: string;
		readonly message: string;
		readonly action?: string;
	}[];
}

/**
 * Application-service boundary for the dashboard.
 *
 * Implementations collect connection URLs, task prompts, and task answers through
 * Extension Host UI. They also perform local confirmation before destructive
 * operations; those sensitive values never cross the webview message bus.
 */
export interface DashboardFacade {
	getSnapshot(): Promise<DashboardSnapshot>;
	onDidChange(listener: () => void): vscode.Disposable;
	configureDeviceName(): Promise<void>;
	registerCurrentWorkspace(): Promise<void>;
	removeWorkspace(workspaceId: string): Promise<void>;
	startListener(): Promise<void>;
	stopListener(): Promise<void>;
	copyConnectionUrl(): Promise<void>;
	addPeer(): Promise<void>;
	removePeer(peerId: string): Promise<void>;
	runTask(peerId?: string, workspaceId?: string): Promise<void>;
	cancelTask(taskId: string): Promise<void>;
	answerTaskInput(taskId: string): Promise<void>;
}

export interface DashboardServiceBindings {
	getSnapshot(): Promise<DashboardSnapshot>;
	onDidChange(listener: () => void): vscode.Disposable;
	configureDeviceName(name: string): Promise<void>;
	registerCurrentWorkspace(): Promise<void>;
	removeWorkspace(workspaceId: string): Promise<void>;
	startListener(): Promise<void>;
	stopListener(): Promise<void>;
	createConnectionUrl(): Promise<string>;
	addPeer(connectionUrl: string): Promise<void>;
	removePeer(peerId: string): Promise<void>;
	runTask(request: {
		readonly peerId?: string;
		readonly workspaceId?: string;
		readonly instruction: string;
	}): Promise<void>;
	cancelTask(taskId: string): Promise<void>;
	answerTaskInput(taskId: string, answer: string): Promise<void>;
}

export interface DashboardConfirmationHost {
	confirm(message: string, action: string): Promise<boolean>;
}

/**
 * Secure Extension Host adapter for real application services.
 *
 * Sensitive input, clipboard writes, and destructive confirmations terminate
 * here instead of crossing into the webview.
 */
export class ServiceDashboardFacade implements DashboardFacade {
	public readonly onDidChange: (listener: () => void) => vscode.Disposable;

	public constructor(
		private readonly services: DashboardServiceBindings,
		private readonly confirmations: DashboardConfirmationHost = new VscodeDashboardConfirmationHost(),
	) {
		this.onDidChange = services.onDidChange.bind(services);
	}

	public getSnapshot(): Promise<DashboardSnapshot> {
		return this.services.getSnapshot();
	}

	public async configureDeviceName(): Promise<void> {
		const snapshot = await this.services.getSnapshot();
		const name = await vscode.window.showInputBox({
			title: 'Configure Copilot Agent Mesh Device',
			prompt: 'Choose a recognizable name for this device.',
			value: snapshot.device.name === 'Not configured' ? '' : snapshot.device.name,
			ignoreFocusOut: true,
			validateInput: (candidate) => candidate.trim().length > 0 ? undefined : 'A device name is required.',
		});
		if (name !== undefined) {
			await this.services.configureDeviceName(name.trim());
		}
	}

	public registerCurrentWorkspace(): Promise<void> {
		return this.services.registerCurrentWorkspace();
	}

	public async removeWorkspace(workspaceId: string): Promise<void> {
		if (await this.confirmations.confirm('Remove this shared workspace?', 'Remove Workspace')) {
			await this.services.removeWorkspace(workspaceId);
		}
	}

	public startListener(): Promise<void> {
		return this.services.startListener();
	}

	public async stopListener(): Promise<void> {
		if (await this.confirmations.confirm('Stop the listener and disconnect remote devices?', 'Stop Listener')) {
			await this.services.stopListener();
		}
	}

	public async copyConnectionUrl(): Promise<void> {
		const connectionUrl = await this.services.createConnectionUrl();
		await vscode.env.clipboard.writeText(connectionUrl);
		await vscode.window.showInformationMessage('Connection URL copied. Treat it as a one-time secret.');
	}

	public async addPeer(): Promise<void> {
		const connectionUrl = await vscode.window.showInputBox({
			title: 'Add Copilot Agent Mesh Connection',
			prompt: 'Paste the connection URL from the remote device.',
			password: true,
			ignoreFocusOut: true,
			validateInput: validateConnectionUrl,
		});
		if (connectionUrl !== undefined) {
			await this.services.addPeer(connectionUrl.trim());
		}
	}

	public async removePeer(peerId: string): Promise<void> {
		if (await this.confirmations.confirm('Remove and revoke this remote device?', 'Remove Device')) {
			await this.services.removePeer(peerId);
		}
	}

	public async runTask(peerId?: string, workspaceId?: string): Promise<void> {
		const instruction = await vscode.window.showInputBox({
			title: 'Run Remote Task',
			prompt: 'Describe the coding task. The instruction stays in the Extension Host.',
			ignoreFocusOut: true,
			validateInput: (candidate) => candidate.trim().length > 0 ? undefined : 'A task instruction is required.',
		});
		if (instruction !== undefined) {
			await this.services.runTask({ peerId, workspaceId, instruction: instruction.trim() });
		}
	}

	public async cancelTask(taskId: string): Promise<void> {
		if (await this.confirmations.confirm('Cancel this running task?', 'Cancel Task')) {
			await this.services.cancelTask(taskId);
		}
	}

	public async answerTaskInput(taskId: string): Promise<void> {
		const answer = await vscode.window.showInputBox({
			title: 'Answer Remote Task',
			prompt: 'The answer stays in the Extension Host.',
			ignoreFocusOut: true,
			validateInput: (candidate) => candidate.trim().length > 0 ? undefined : 'An answer is required.',
		});
		if (answer !== undefined) {
			await this.services.answerTaskInput(taskId, answer);
		}
	}
}

export class UnavailableDashboardFacade implements DashboardFacade {
	private readonly changed = new vscode.EventEmitter<void>();

	public readonly onDidChange = this.changed.event;

	public async getSnapshot(): Promise<DashboardSnapshot> {
		const configuration = vscode.workspace.getConfiguration('copilotAgentMesh');
		const configuredName = configuration.get<string>('deviceName', '').trim();
		const extensionVersion = vscode.extensions
			.getExtension('weivea.copilot-agent-mesh')
			?.packageJSON.version as string | undefined;

		return {
			device: {
				name: configuredName.length > 0 ? configuredName : 'Not configured',
				platform: platformLabel(process.platform),
				architecture: process.arch,
				vscodeVersion: vscode.version,
				extensionVersion: extensionVersion ?? 'Unavailable',
			},
			listener: {
				state: 'unavailable',
				gateway: unavailableComponent('Gateway service is not connected.', 'Complete service wiring'),
				tunnel: unavailableComponent('Dev Tunnel service is not connected.', 'Install or sign in to devtunnel'),
				agentHost: unavailableComponent('Agent Host service is not connected.', 'Complete the AHP compatibility gate'),
				canStart: false,
				canStop: false,
				canCopyConnectionUrl: false,
			},
			workspaces: [],
			peers: [],
			tasks: [],
			errors: [{
				code: 'DASHBOARD_SERVICES_UNAVAILABLE',
				message: 'Dashboard services have not been connected to the UI facade.',
				action: 'Wire the device, listener, workspace, peer, and task services.',
			}],
		};
	}

	public async configureDeviceName(): Promise<void> {
		const configuration = vscode.workspace.getConfiguration('copilotAgentMesh');
		const currentName = configuration.get<string>('deviceName', '');
		const value = await vscode.window.showInputBox({
			title: 'Configure Copilot Agent Mesh Device',
			prompt: 'Choose a recognizable name for this device.',
			value: currentName,
			ignoreFocusOut: true,
			validateInput: (candidate) => candidate.trim().length > 0 ? undefined : 'A device name is required.',
		});
		if (value !== undefined) {
			await configuration.update('deviceName', value.trim(), vscode.ConfigurationTarget.Global);
			this.changed.fire();
		}
	}

	public registerCurrentWorkspace(): Promise<void> {
		return this.unavailable('Workspace service');
	}

	public removeWorkspace(_workspaceId: string): Promise<void> {
		return this.unavailable('Workspace service');
	}

	public startListener(): Promise<void> {
		return this.unavailable('Listener service');
	}

	public stopListener(): Promise<void> {
		return this.unavailable('Listener service');
	}

	public copyConnectionUrl(): Promise<void> {
		return this.unavailable('Connection URL service');
	}

	public addPeer(): Promise<void> {
		return this.unavailable('Peer service');
	}

	public removePeer(_peerId: string): Promise<void> {
		return this.unavailable('Peer service');
	}

	public runTask(_peerId?: string, _workspaceId?: string): Promise<void> {
		return this.unavailable('Task service');
	}

	public cancelTask(_taskId: string): Promise<void> {
		return this.unavailable('Task service');
	}

	public answerTaskInput(_taskId: string): Promise<void> {
		return this.unavailable('Task service');
	}

	private async unavailable(service: string): Promise<void> {
		await vscode.window.showErrorMessage(`${service} is unavailable. The dashboard did not perform this action.`);
	}
}

function unavailableComponent(detail: string, action: string): ComponentSnapshot {
	return { state: 'unavailable', label: 'Unavailable', detail, action };
}

function platformLabel(platform: NodeJS.Platform): string {
	const names: Partial<Record<NodeJS.Platform, string>> = {
		darwin: 'macOS',
		linux: 'Linux',
		win32: 'Windows',
	};
	return names[platform] ?? platform;
}

class VscodeDashboardConfirmationHost implements DashboardConfirmationHost {
	public async confirm(message: string, action: string): Promise<boolean> {
		const selected = await vscode.window.showWarningMessage(message, { modal: true }, action);
		return selected === action;
	}
}

function validateConnectionUrl(candidate: string): string | undefined {
	const value = candidate.trim();
	if (value.length === 0) {
		return 'A connection URL is required.';
	}
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' ? undefined : 'Connection URLs must use HTTPS.';
	} catch {
		return 'Enter a valid connection URL.';
	}
}
