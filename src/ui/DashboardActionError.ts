export type DashboardActionErrorCode =
	| 'WINDOW_NAME_CONFLICT'
	| 'WINDOW_NAME_INVALID'
	| 'PEER_DELEGATION_DISABLED'
	| 'WORKSPACE_SELECTION_AMBIGUOUS'
	| 'POLICY_FORBIDDEN';

export class DashboardActionError extends Error {
	public constructor(
		public readonly code: DashboardActionErrorCode,
		message: string,
	) {
		super(message);
	}
}
