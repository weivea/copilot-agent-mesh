import { DashboardSnapshot } from './DashboardFacade';
import { redactRemoteText } from './DashboardRedaction';

const dashboardStringBytes = 2 * 1_024;

type DashboardTask = DashboardSnapshot['tasks'][number];
type DashboardTaskViewModel = Omit<DashboardTask, 'summary' | 'summaryTruncated'> & {
	readonly summary?: string;
	readonly summaryTruncated: boolean;
};

export interface DashboardViewModel {
	readonly device: DashboardSnapshot['device'];
	readonly listener: DashboardSnapshot['listener'];
	readonly broker: NonNullable<DashboardSnapshot['broker']>;
	readonly localNodes: readonly NonNullable<DashboardSnapshot['localNodes']>[number][];
	readonly remoteDevices: readonly NonNullable<DashboardSnapshot['remoteDevices']>[number][];
	readonly workspaces: DashboardSnapshot['workspaces'];
	readonly peers: DashboardSnapshot['peers'];
	readonly tasks: readonly DashboardTaskViewModel[];
	readonly errors: DashboardSnapshot['errors'];
}

export class DashboardPresenter {
	public present(snapshot: DashboardSnapshot): DashboardViewModel {
		return {
			device: {
				...snapshot.device,
				name: redactRemoteText(snapshot.device.name),
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
			localNodes: (snapshot.localNodes ?? []).map(redactNode),
			remoteDevices: (snapshot.remoteDevices ?? []).map((device) => ({
				...device,
				name: redactRemoteText(device.name),
				nodes: device.nodes.map(redactNode),
			})),
			workspaces: snapshot.workspaces.map((workspace) => ({
				...workspace,
				name: redactRemoteText(workspace.name),
				capabilityTags: workspace.capabilityTags.map(redactRemoteText),
			})),
			peers: snapshot.peers.map((peer) => ({
				...peer,
				name: redactRemoteText(peer.name),
				lastSeenLabel: optionalRedacted(peer.lastSeenLabel),
			})),
			tasks: snapshot.tasks.map((task) => {
				const summary = redactAndTruncate(task.summary);
				return {
					...task,
					title: redactRemoteText(task.title),
					peerName: redactRemoteText(task.peerName),
					workspaceName: redactRemoteText(task.workspaceName),
					phase: optionalRedacted(task.phase),
					summary: summary.value,
					summaryTruncated: task.summaryTruncated === true || summary.truncated,
					error: task.error === undefined ? undefined : redactError(task.error),
				};
			}),
			errors: snapshot.errors.map(redactError),
		};
	}
}

function redactBroker(
	broker: NonNullable<DashboardSnapshot['broker']>,
): NonNullable<DashboardSnapshot['broker']> {
	return {
		...broker,
		error: broker.error === undefined ? undefined : redactError(broker.error),
	};
}

function redactNode(
	node: NonNullable<DashboardSnapshot['localNodes']>[number],
): NonNullable<DashboardSnapshot['localNodes']>[number] {
	return {
		...node,
		label: redactRemoteText(node.label),
		workspaces: node.workspaces.map((workspace) => ({
			...workspace,
			name: redactRemoteText(workspace.name),
			capabilityTags: workspace.capabilityTags.map(redactRemoteText),
		})),
	};
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
