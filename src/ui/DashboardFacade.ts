import * as vscode from 'vscode';

import {
	DISABLED_CONNECTIVITY_SNAPSHOT,
	PROTOCOL_LIMITS,
	utf8ByteLength,
	type ConnectivityAction,
	type ConnectivitySnapshot,
	type DashboardTaskDirection,
	type TaskStatus,
} from '../../shared/protocol';
import { validateWindowName } from '../broker/WindowName';
export {
	DashboardActionError,
	type DashboardActionErrorCode,
} from './DashboardActionError';

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
		readonly deviceId?: string;
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
	readonly broker?: {
		readonly state: 'starting' | 'running' | 'contending' | 'takingOver'
			| 'stopping' | 'error' | 'disposed';
		readonly role: 'owner' | 'contender';
		readonly takeover: 'stable' | 'waiting' | 'takingOver' | 'stopping' | 'error';
		readonly holder: 'thisWindow' | 'anotherWindow' | 'none';
		readonly error?: {
			readonly code: string;
			readonly message: string;
			readonly action?: string;
		};
	};
	readonly thisWindow: {
		readonly name: string;
		readonly workspaceName: string;
		readonly claimStatus: 'claimed' | 'readOnly' | 'conflict' | 'unclaimed' | 'ambiguous';
		readonly previewEnabled: boolean;
		readonly canRename: boolean;
		readonly acceptsIncoming: boolean;
		readonly canSetAcceptIncoming: boolean;
		readonly acceptActionHandle?: string;
		readonly agentHost: {
			readonly source: 'editor' | 'standalone' | 'unavailable';
			readonly label: string;
			readonly degraded: boolean;
			readonly reason?: 'EDITOR_DISCOVERY_FAILED' | 'EDITOR_START_FAILED' | 'STANDALONE_START_FAILED';
			readonly detail?: string;
		};
		readonly detail?: string;
	};
	readonly connectivity?: ConnectivitySnapshot;
	readonly policyCandidates?: readonly DashboardPolicyCandidateSnapshot[];
	readonly outgoingTasks?: readonly DashboardTaskSummarySnapshot[];
	readonly incomingTasks?: readonly DashboardTaskSummarySnapshot[];
	readonly localNodes?: readonly DashboardNodeSnapshot[];
	readonly remoteDevices?: readonly {
		readonly deviceId: string;
		readonly peerId: string;
		readonly name: string;
		readonly state: PeerState;
		readonly nodes: readonly DashboardNodeSnapshot[];
	}[];
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

export interface DashboardPolicyCandidateSnapshot {
	readonly actionHandle?: string;
	readonly windowLabel: string;
	readonly workspaceName: string;
	readonly online: boolean;
	readonly acceptsIncoming: boolean;
	readonly busy: boolean;
	readonly allowlisted: boolean;
	readonly self: boolean;
	readonly canToggle: boolean;
	readonly claimState: 'claimed' | 'multiWorkspace' | 'unclaimed';
	readonly gateState: 'allowed' | 'notAllowed' | 'notAccepting' | 'offline' | 'multiWorkspace' | 'notClaimed';
}

export interface DashboardTaskSummarySnapshot {
	readonly actionHandle?: string;
	readonly counterpartLabel: string;
	readonly workspaceName: string;
	readonly title: string;
	readonly state: TaskState;
	readonly startedAt: string;
	readonly shortId: string;
	readonly canCancel: boolean;
}

export interface DashboardNodeSnapshot {
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly label: string;
	readonly status: 'online' | 'busy' | 'offline' | 'conflict' | 'draining';
	readonly thisWindow: boolean;
	readonly workspaces: readonly {
		readonly workspaceId: string;
		readonly name: string;
		readonly capabilityTags: readonly string[];
		readonly enabled: boolean;
		readonly busy: boolean;
		readonly claimStatus: 'claimed' | 'readOnly' | 'conflict';
		readonly activeTaskId?: string;
	}[];
}

export interface DashboardTaskTarget {
	readonly deviceId: string;
	readonly nodeId: string;
	readonly nodeInstanceId: string;
	readonly workspaceId: string;
	readonly peerId?: string;
}

export interface DashboardWindowRenameSession {
	readonly currentName: string;
	rename(name: string): Promise<void>;
}

export interface DashboardTaskCancellationSession {
	cancel(): Promise<void>;
	release(): Promise<void>;
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
	renameCurrentWindow(): Promise<void>;
	setAcceptIncoming(actionHandle: string, enabled: boolean): Promise<void>;
	setPeerAllowed(actionHandle: string, allowed: boolean): Promise<void>;
	connectivityAction(action: ConnectivityAction, actionHandle?: string): Promise<void>;
	cancelDashboardTask(actionHandle: string, direction: DashboardTaskDirection): Promise<void>;
	registerCurrentWorkspace(): Promise<void>;
	removeWorkspace(workspaceId: string): Promise<void>;
	startListener(): Promise<void>;
	stopListener(): Promise<void>;
	copyConnectionUrl(): Promise<void>;
	addPeer(): Promise<void>;
	removePeer(peerId: string): Promise<void>;
	runTask(target?: DashboardTaskTarget): Promise<void>;
	cancelTask(taskId: string): Promise<void>;
}

export interface DashboardServiceBindings {
	getSnapshot(): Promise<DashboardSnapshot>;
	onDidChange(listener: () => void): vscode.Disposable;
	configureDeviceName(name: string): Promise<void>;
	prepareWindowRename(): Promise<DashboardWindowRenameSession>;
	setAcceptIncoming(actionHandle: string, enabled: boolean): Promise<void>;
	setPeerAllowed(actionHandle: string, allowed: boolean): Promise<void>;
	connectivityAction(action: ConnectivityAction, actionHandle?: string): Promise<void>;
	prepareDashboardTaskCancellation(
		actionHandle: string,
		direction: DashboardTaskDirection,
	): Promise<DashboardTaskCancellationSession>;
	registerCurrentWorkspace(): Promise<void>;
	removeWorkspace(workspaceId: string): Promise<void>;
	startListener(): Promise<void>;
	stopListener(): Promise<void>;
	createConnectionUrl(): Promise<string>;
	addPeer(connectionUrl: string): Promise<void>;
	removePeer(peerId: string): Promise<void>;
	runTask(request: {
		readonly target?: DashboardTaskTarget;
		readonly title: string;
		readonly instruction: string;
	}): Promise<void>;
	cancelTask(taskId: string): Promise<void>;
}

export interface DashboardConfirmationHost {
	confirm(message: string, action: string): Promise<boolean>;
}

export interface DashboardInputHost {
	showInputBox(options: vscode.InputBoxOptions): Thenable<string | undefined>;
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
		private readonly inputs: DashboardInputHost = vscode.window,
	) {
		this.onDidChange = services.onDidChange.bind(services);
	}

	public getSnapshot(): Promise<DashboardSnapshot> {
		return this.services.getSnapshot();
	}

	public async configureDeviceName(): Promise<void> {
		const snapshot = await this.services.getSnapshot();
		const name = await this.inputs.showInputBox({
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

	public async renameCurrentWindow(): Promise<void> {
		const session = await this.services.prepareWindowRename();
		const name = await this.inputs.showInputBox({
			title: 'Rename This Window',
			prompt: 'Choose a device-wide unique display name for the current Workspace.',
			value: session.currentName,
			ignoreFocusOut: true,
			validateInput: validateWindowNameInput,
		});
		if (name !== undefined) {
			await session.rename(name);
		}
	}

	public setAcceptIncoming(actionHandle: string, enabled: boolean): Promise<void> {
		return this.services.setAcceptIncoming(actionHandle, enabled);
	}

	public setPeerAllowed(actionHandle: string, allowed: boolean): Promise<void> {
		return this.services.setPeerAllowed(actionHandle, allowed);
	}

	public connectivityAction(action: ConnectivityAction, actionHandle?: string): Promise<void> {
		return this.services.connectivityAction(action, actionHandle);
	}

	public async cancelDashboardTask(
		actionHandle: string,
		direction: DashboardTaskDirection,
	): Promise<void> {
		const reservation = await this.services.prepareDashboardTaskCancellation(
			actionHandle,
			direction,
		);
		let approved: boolean;
		try {
			approved = await this.confirmations.confirm(
				direction === 'incoming'
					? 'Cancel this task running in this window?'
					: 'Cancel this delegated task?',
				'Cancel Task',
			);
		} catch (error: unknown) {
			await reservation.release();
			throw error;
		}
		if (!approved) {
			await reservation.release();
			return;
		}
		await reservation.cancel();
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
		const connectionUrl = await this.inputs.showInputBox({
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

	public async runTask(target?: DashboardTaskTarget): Promise<void> {
		const title = await this.inputs.showInputBox({
			title: 'Name Remote Task',
			prompt: 'Enter a non-sensitive title for task lists and persisted history.',
			ignoreFocusOut: true,
			validateInput: validateTaskTitle,
		});
		if (title === undefined) {
			return;
		}
		const instruction = await this.inputs.showInputBox({
			title: 'Run Remote Task',
			prompt: 'Describe the coding task. The instruction stays in the Extension Host.',
			ignoreFocusOut: true,
			validateInput: validateTaskInstruction,
		});
		if (instruction !== undefined) {
			await this.services.runTask({
				target,
				title: title.trim(),
				instruction: instruction.trim(),
			});
		}
	}

	public async cancelTask(taskId: string): Promise<void> {
		if (await this.confirmations.confirm('Cancel this running task?', 'Cancel Task')) {
			await this.services.cancelTask(taskId);
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
			broker: {
				state: 'error',
				role: 'contender',
				takeover: 'error',
				holder: 'none',
				error: {
					code: 'BROKER_UNAVAILABLE',
					message: 'The local Device Broker lifecycle is unavailable.',
				},
			},
			thisWindow: {
				name: 'Unavailable',
				workspaceName: 'No Workspace',
				claimStatus: 'unclaimed',
				previewEnabled: false,
				canRename: false,
				acceptsIncoming: false,
				canSetAcceptIncoming: false,
				agentHost: {
					source: 'unavailable',
					label: 'Unavailable',
					degraded: false,
				},
				detail: 'Peer window delegation is unavailable.',
			},
			connectivity: {
				...DISABLED_CONNECTIVITY_SNAPSHOT,
				state: 'error',
				error: 'DISCOVERY_UNAVAILABLE',
			},
			policyCandidates: [],
			outgoingTasks: [],
			incomingTasks: [],
			localNodes: [],
			remoteDevices: [],
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

	public renameCurrentWindow(): Promise<void> {
		return this.unavailable('Window rename service');
	}

	public setAcceptIncoming(_actionHandle: string, _enabled: boolean): Promise<void> {
		return this.unavailable('Incoming task policy service');
	}

	public setPeerAllowed(_actionHandle: string, _allowed: boolean): Promise<void> {
		return this.unavailable('Peer allowlist service');
	}

	public async connectivityAction(_action: ConnectivityAction, _actionHandle?: string): Promise<void> {
		throw new Error('Cross-device connectivity is unavailable. No action was performed.');
	}

	public cancelDashboardTask(
		_actionHandle: string,
		_direction: DashboardTaskDirection,
	): Promise<void> {
		return this.unavailable('Dashboard task service');
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

	public runTask(_target?: DashboardTaskTarget): Promise<void> {
		return this.unavailable('Task service');
	}

	public cancelTask(_taskId: string): Promise<void> {
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

function validateTaskTitle(candidate: string): string | undefined {
	const value = candidate.trim();
	if (value.length === 0) {
		return 'A non-sensitive task title is required.';
	}
	return utf8ByteLength(value) <= PROTOCOL_LIMITS.taskTitleBytes
		? undefined
		: `The task title must be at most ${PROTOCOL_LIMITS.taskTitleBytes} UTF-8 bytes.`;
}

function validateTaskInstruction(candidate: string): string | undefined {
	const value = candidate.trim();
	if (value.length === 0) {
		return 'A task instruction is required.';
	}
	return utf8ByteLength(value) <= PROTOCOL_LIMITS.taskPromptBytes
		? undefined
		: `The task instruction must be at most ${PROTOCOL_LIMITS.taskPromptBytes} UTF-8 bytes.`;
}

function validateWindowNameInput(candidate: string): string | undefined {
	try {
		validateWindowName(candidate);
		return undefined;
	} catch (error: unknown) {
		return error instanceof Error ? error.message : 'The window name is invalid.';
	}
}
