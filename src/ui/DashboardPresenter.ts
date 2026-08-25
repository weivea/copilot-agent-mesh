import { DashboardSnapshot } from './DashboardFacade';

export interface DashboardViewModel {
	readonly device: DashboardSnapshot['device'];
	readonly listener: DashboardSnapshot['listener'];
	readonly workspaces: DashboardSnapshot['workspaces'];
	readonly peers: DashboardSnapshot['peers'];
	readonly tasks: DashboardSnapshot['tasks'];
	readonly errors: DashboardSnapshot['errors'];
}

export class DashboardPresenter {
	public present(snapshot: DashboardSnapshot): DashboardViewModel {
		return {
			device: { ...snapshot.device },
			listener: {
				...snapshot.listener,
				gateway: { ...snapshot.listener.gateway },
				tunnel: { ...snapshot.listener.tunnel },
				agentHost: { ...snapshot.listener.agentHost },
			},
			workspaces: snapshot.workspaces.map((workspace) => ({
				...workspace,
				capabilityTags: [...workspace.capabilityTags],
			})),
			peers: snapshot.peers.map((peer) => ({ ...peer })),
			tasks: snapshot.tasks.map((task) => ({
				...task,
				error: task.error === undefined ? undefined : { ...task.error },
			})),
			errors: snapshot.errors.map((error) => ({ ...error })),
		};
	}
}
