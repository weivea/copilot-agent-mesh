import { DashboardSnapshot } from './DashboardFacade';
import { redactRemoteText } from './DashboardRedaction';
import {
	connectivitySnapshotSchema,
	DISABLED_CONNECTIVITY_SNAPSHOT,
	timestampSchema,
	type ConnectivitySnapshot,
} from '../../shared/protocol';
import { dashboardDeviceTreeSchema, type DashboardDeviceTree } from './DashboardTree';

const dashboardStringBytes = 2 * 1_024;

export interface DashboardViewModel {
	readonly device: Omit<DashboardSnapshot['device'], 'deviceId'>;
	readonly listener: DashboardSnapshot['listener'];
	readonly broker: NonNullable<DashboardSnapshot['broker']>;
	readonly thisWindow: DashboardSnapshot['thisWindow'];
	readonly connectivity: DashboardConnectivityViewModel;
	readonly deviceTree: DashboardDeviceTree;
	readonly localNodes: readonly DashboardLocalNodeViewModel[];
	readonly savedAuthorizations: readonly DashboardSavedAuthorizationViewModel[];
	readonly outgoingTasks: readonly NonNullable<DashboardSnapshot['outgoingTasks']>[number][];
	readonly incomingTasks: readonly NonNullable<DashboardSnapshot['incomingTasks']>[number][];
	readonly errors: DashboardSnapshot['errors'];
}

export interface DashboardConnectivityViewModel extends Omit<ConnectivitySnapshot, 'candidates' | 'incomingPeers'> {
	readonly candidates: readonly Readonly<ConnectivitySnapshot['candidates'][number]>[];
	readonly incomingPeers: readonly Readonly<ConnectivitySnapshot['incomingPeers'][number]>[];
}

type DashboardLocalNodeViewModel =
	Omit<NonNullable<DashboardSnapshot['policyCandidates']>[number], 'nodeId' | 'nodeInstanceId'>
	& { readonly online: true };

interface DashboardSavedAuthorizationViewModel {
	readonly actionHandle: string;
	readonly windowLabel: string;
	readonly workspaceName: string;
}

export class DashboardPresenter {
	public present(snapshot: DashboardSnapshot): DashboardViewModel {
		const policyCandidates = snapshot.policyCandidates ?? [];
		return {
			device: {
				name: redactRemoteText(snapshot.device.name),
				platform: redactRemoteText(snapshot.device.platform),
				architecture: redactRemoteText(snapshot.device.architecture),
				vscodeVersion: redactRemoteText(snapshot.device.vscodeVersion),
				extensionVersion: redactRemoteText(snapshot.device.extensionVersion),
			},
			listener: {
				...snapshot.listener,
				gateway: redactComponent(snapshot.listener.gateway),
				tunnel: redactComponent(snapshot.listener.tunnel),
				agentHost: redactComponent(snapshot.listener.agentHost),
			},
			broker: redactBroker(snapshot.broker ?? {
				state: 'error',
				role: 'contender',
				takeover: 'error',
				holder: 'none',
				error: {
					code: 'BROKER_UNAVAILABLE',
					message: 'The local Device Broker lifecycle is unavailable.',
				},
			}),
			thisWindow: {
				...snapshot.thisWindow,
				name: redactRemoteText(snapshot.thisWindow.name),
				workspaceName: redactRemoteText(snapshot.thisWindow.workspaceName),
				detail: optionalRedacted(snapshot.thisWindow.detail),
				agentHost: {
					...snapshot.thisWindow.agentHost,
					label: redactRemoteText(snapshot.thisWindow.agentHost.label),
					detail: optionalRedacted(snapshot.thisWindow.agentHost.detail),
				},
			},
			connectivity: presentConnectivity(snapshot.connectivity ?? DISABLED_CONNECTIVITY_SNAPSHOT),
			deviceTree: presentDeviceTree(snapshot.deviceTree ?? []),
			localNodes: policyCandidates
				.filter(isOnlinePolicyCandidate)
				.map(({ nodeId: _nodeId, nodeInstanceId: _nodeInstanceId, ...candidate }) => ({
					...candidate,
					windowLabel: redactRemoteText(candidate.windowLabel),
					workspaceName: redactRemoteText(candidate.workspaceName),
				})),
			savedAuthorizations: policyCandidates
				.filter(({ online, allowlisted }) => !online && allowlisted)
				.map(toSavedAuthorization),
			outgoingTasks: (snapshot.outgoingTasks ?? []).map(redactDashboardTask),
			incomingTasks: (snapshot.incomingTasks ?? []).map(redactDashboardTask),
			errors: snapshot.errors.map(redactError),
		};
	}
}

function presentDeviceTree(value: DashboardDeviceTree): DashboardDeviceTree {
	return dashboardDeviceTreeSchema.parse(value).map((device) => ({
		...device, name: redactRemoteText(device.name),
		nodes: device.nodes.map((node) => ({
			...node, label: redactRemoteText(node.label),
			workspaces: node.workspaces.map((workspace) => ({
				...workspace, name: redactRemoteText(workspace.name),
				incomingPeers: workspace.incomingPeers.map((peer) => ({ ...peer, label: redactRemoteText(peer.label) })),
			})),
		})),
	}));
}

function presentConnectivity(snapshot: ConnectivitySnapshot): DashboardConnectivityViewModel {
	// Validate Broker UUID handles before the provider replaces them with Webview aliases.
	const value = connectivitySnapshotSchema.parse(snapshot);
	return {
		discoveryEnabled: value.discoveryEnabled,
		delegationEnabled: value.delegationEnabled,
		strictPolicyActivated: value.strictPolicyActivated,
		publishEnabled: value.publishEnabled,
		hostingBackend: value.hostingBackend,
		migrationPending: value.migrationPending,
		accountProvider: value.accountProvider,
		claimedWorkspaceCount: value.claimedWorkspaceCount,
		receivingWorkspaceCount: value.receivingWorkspaceCount,
		state: value.state,
		...(value.error === undefined ? {} : { error: value.error }),
		truncated: value.truncated,
		candidates: value.candidates.map((candidate) => ({
			actionHandle: candidate.actionHandle,
			label: redactRemoteText(candidate.label),
			hostHint: candidate.hostHint,
			stale: candidate.stale,
			admission: candidate.admission,
		})),
		incomingPeers: value.incomingPeers.map((peer) => ({
			actionHandle: peer.actionHandle,
			label: redactRemoteText(peer.label),
			state: peer.state,
			cleanupPending: peer.cleanupPending,
		})),
	};
}

function isOnlinePolicyCandidate(
	candidate: NonNullable<DashboardSnapshot['policyCandidates']>[number],
): candidate is NonNullable<DashboardSnapshot['policyCandidates']>[number] & { readonly online: true } {
	return candidate.online;
}

function toSavedAuthorization(
	candidate: NonNullable<DashboardSnapshot['policyCandidates']>[number],
): DashboardSavedAuthorizationViewModel {
	if (!candidate.canToggle || candidate.actionHandle === undefined) {
		throw new Error('A saved authorization requires a remove action.');
	}
	return {
		actionHandle: candidate.actionHandle,
		windowLabel: redactRemoteText(candidate.windowLabel),
		workspaceName: redactRemoteText(candidate.workspaceName),
	};
}

function redactBroker(
	broker: NonNullable<DashboardSnapshot['broker']>,
): NonNullable<DashboardSnapshot['broker']> {
	return {
		...broker,
		error: broker.error === undefined ? undefined : redactError(broker.error),
	};
}

function redactDashboardTask(
	task: NonNullable<DashboardSnapshot['outgoingTasks']>[number],
): NonNullable<DashboardSnapshot['outgoingTasks']>[number] {
	return {
		...task,
		counterpartLabel: redactRemoteText(task.counterpartLabel),
		workspaceName: redactRemoteText(task.workspaceName),
		title: redactAndTruncate(task.title).value ?? 'Delegated task',
		startedAt: normalizeDashboardTimestamp(task.startedAt),
	};
}

function normalizeDashboardTimestamp(value: string): string {
	if (!timestampSchema.safeParse(value).success) {
		return 'Unknown';
	}
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		return 'Unknown';
	}
	const canonical = new Date(timestamp).toISOString();
	return /^\d{4}-\d{2}-\d{2}T/u.test(canonical) ? canonical : 'Unknown';
}

function redactComponent(component: DashboardSnapshot['listener']['gateway']): DashboardSnapshot['listener']['gateway'] {
	return {
		...component,
		label: redactRemoteText(component.label),
		detail: optionalRedacted(component.detail),
		action: optionalRedacted(component.action),
	};
}

function redactError(error: DashboardSnapshot['errors'][number]): DashboardSnapshot['errors'][number] {
	return {
		...error,
		code: redactRemoteText(error.code),
		message: redactRemoteText(error.message),
		action: optionalRedacted(error.action),
	};
}

function optionalRedacted(value: string | undefined): string | undefined {
	return value === undefined ? undefined : redactRemoteText(value);
}

function redactAndTruncate(value: string | undefined): {
	readonly value?: string;
	readonly truncated: boolean;
} {
	if (value === undefined) {
		return { truncated: false };
	}
	const redacted = redactRemoteText(value);
	if (Buffer.byteLength(redacted, 'utf8') <= dashboardStringBytes) {
		return { value: redacted, truncated: false };
	}
	let result = '';
	let bytes = 0;
	for (const character of redacted) {
		const characterBytes = Buffer.byteLength(character, 'utf8');
		if (bytes + characterBytes > dashboardStringBytes) {
			break;
		}
		result += character;
		bytes += characterBytes;
	}
	return { value: result, truncated: true };
}
