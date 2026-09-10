import { TaskCoordinator, type CoordinatorPeerManager } from '../application/TaskCoordinator';
import { TaskToolFacadeError } from '../tools/taskToolFacade';

type Arguments = ConstructorParameters<typeof TaskCoordinator>;

/** Preserve the native v1 API without permitting it to bypass saved-device admission fences. */
export class ProductionLegacyTaskCoordinator extends TaskCoordinator {
	private admissions: Promise<void> = Promise.resolve();

	public constructor(args: Arguments, private readonly assertProfileAllowed: (profileId: string) => void) {
		const peers = args[0];
		const wrap = (connection: ReturnType<CoordinatorPeerManager['get']>) => connection && ({
			profileId: connection.profileId,
			snapshot: () => connection.snapshot(),
			request: (method: string, params: Record<string, unknown>) => {
				if (method === 'task.start') {
					try { assertProfileAllowed(connection.profileId); }
					catch { throw new TaskToolFacadeError('TUNNEL_UNAVAILABLE'); }
				}
				return connection.request(method, params);
			},
		});
		super({
			get: (id) => wrap(peers.get(id)),
			isEnabled: (id) => peers.isEnabled(id),
			listConnections: () => peers.listConnections().map((connection) => wrap(connection)!),
		}, ...args.slice(1) as [
			Arguments[1], Arguments[2], Arguments[3], Arguments[4], Arguments[5], Arguments[6],
		]);
	}

	public override persistDelegationIntent(input: Parameters<TaskCoordinator['persistDelegationIntent']>[0]) {
		return this.withAdmissionBarrier(async () => {
			if ('peerId' in input && input.peerId !== undefined) { this.assertProfileAllowed(input.peerId); }
			return super.persistDelegationIntent(input);
		});
	}

	public withAdmissionBarrier<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.admissions.then(operation, operation);
		this.admissions = result.then(() => undefined, () => undefined);
		return result;
	}
}
