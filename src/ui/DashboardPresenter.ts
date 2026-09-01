import { DashboardSnapshot } from './DashboardFacade';
import { redactRemoteText } from './DashboardRedaction';
import { timestampSchema } from '../../shared/protocol';

const dashboardStringBytes = 2 * 1_024;

export interface DashboardViewModel {
	readonly device: Omit<DashboardSnapshot['device'], 'deviceId'>;
	readonly listener: DashboardSnapshot['listener'];
	readonly broker: NonNullable<DashboardSnapshot['broker']>;
	readonly thisWindow: DashboardSnapshot['thisWindow'];
	readonly localNodes: readonly DashboardLocalNodeViewModel[];
	readonly outgoingTasks: readonly NonNullable<DashboardSnapshot['outgoingTasks']>[number][];
	readonly incomingTasks: readonly NonNullable<DashboardSnapshot['incomingTasks']>[number][];
	readonly errors: DashboardSnapshot['errors'];
}

type DashboardLocalNodeViewModel =
	NonNullable<DashboardSnapshot['policyCandidates']>[number]
	& { readonly online: true };

export class DashboardPresenter {
	public present(snapshot: DashboardSnapshot): DashboardViewModel {
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
			localNodes: (snapshot.policyCandidates ?? [])
				.filter(isOnlinePolicyCandidate)
				.map((candidate) => ({
					...candidate,
					windowLabel: redactRemoteText(candidate.windowLabel),
					workspaceName: redactRemoteText(candidate.workspaceName),
				})),
			outgoingTasks: (snapshot.outgoingTasks ?? []).map(redactDashboardTask),
			incomingTasks: (snapshot.incomingTasks ?? []).map(redactDashboardTask),
			errors: snapshot.errors.map(redactError),
		};
	}
}

function isOnlinePolicyCandidate(
	candidate: NonNullable<DashboardSnapshot['policyCandidates']>[number],
): candidate is DashboardLocalNodeViewModel {
	return candidate.online;
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
