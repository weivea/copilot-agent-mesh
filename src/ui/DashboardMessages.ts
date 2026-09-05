import { DashboardViewModel } from './DashboardPresenter';
import { containsUnsafeDashboardText } from './DashboardRedaction';
import { dashboardDeviceTreeSchema } from './DashboardTree';
import {
	CONNECTIVITY_ACTIONS,
	REMOTE_POLICY_ACTIONS,
	TASK_STATUSES,
	utf8ByteLength,
} from '../../shared/protocol';

export const DASHBOARD_MESSAGE_VERSION = 8 as const;

export const DASHBOARD_ACTIONS = [
	'configureDevice',
	'renameWindow',
	'startListener',
	'stopListener',
	'copyConnectionUrl',
	'setAcceptIncoming',
	'setPeerAllowed',
	'openTargetChat',
	...REMOTE_POLICY_ACTIONS,
	'cancelOutgoingTask',
	'cancelIncomingTask',
	...CONNECTIVITY_ACTIONS,
	'refresh',
] as const;

export type DashboardAction = typeof DASHBOARD_ACTIONS[number];

export type DashboardOutboundErrorCode =
	| 'INVALID_MESSAGE'
	| 'ACTION_FAILED'
	| 'UNSAFE_VIEW_MODEL'
	| 'WINDOW_NAME_CONFLICT'
	| 'WINDOW_NAME_INVALID'
	| 'PEER_DELEGATION_DISABLED'
	| 'WORKSPACE_SELECTION_AMBIGUOUS'
	| 'POLICY_FORBIDDEN'
	| 'STALE_ACTION'
	| 'TASK_NOT_FOUND';

export type DashboardInboundMessage =
	| {
		readonly version: typeof DASHBOARD_MESSAGE_VERSION;
		readonly uiInstanceId: string;
		readonly type: 'ready';
	}
	| {
		readonly version: typeof DASHBOARD_MESSAGE_VERSION;
		readonly uiInstanceId: string;
		readonly type: 'action';
		readonly action: DashboardAction;
		readonly actionHandle?: string;
		readonly enabled?: boolean;
	};

export type DashboardOutboundMessage =
	| {
		readonly version: typeof DASHBOARD_MESSAGE_VERSION;
		readonly uiInstanceId: string;
		readonly type: 'dashboard.snapshot';
		readonly model: DashboardViewModel;
		readonly pendingActions?: readonly DashboardAction[];
	}
	| {
		readonly version: typeof DASHBOARD_MESSAGE_VERSION;
		readonly uiInstanceId: string;
		readonly type: 'dashboard.error';
		readonly code: DashboardOutboundErrorCode;
		readonly message: string;
		readonly pendingActions?: readonly DashboardAction[];
	};

const actions = new Set<string>(DASHBOARD_ACTIONS);
const booleanActions = new Set<DashboardAction>([
	'setAcceptIncoming',
	'setPeerAllowed',
	'setRemoteAutoAccept',
	'setRemoteReceive',
	'setRemoteAllowed',
]);
const handleActions = new Set<DashboardAction>([
	'setAcceptIncoming',
	'setPeerAllowed',
	'openTargetChat',
	'setRemoteAutoAccept',
	'setRemoteReceive',
	'setRemoteAllowed',
	'cancelOutgoingTask',
	'cancelIncomingTask',
	'pairDiscoveredPeer',
	'revokeIncomingPeer',
]);

export function parseDashboardInboundMessage(value: unknown): DashboardInboundMessage | undefined {
	if (!isRecord(value) || value.version !== DASHBOARD_MESSAGE_VERSION || !isIdentifier(value.uiInstanceId)) {
		return undefined;
	}
	if (value.type === 'ready') {
		return hasOnlyKeys(value, ['version', 'uiInstanceId', 'type']) ? value as DashboardInboundMessage : undefined;
	}
	if (
		value.type !== 'action'
		|| typeof value.action !== 'string'
		|| !actions.has(value.action)
		|| !optionalActionHandle(value.actionHandle)
		|| (value.enabled !== undefined && typeof value.enabled !== 'boolean')
		|| !hasOnlyKeys(value, [
			'version',
			'uiInstanceId',
			'type',
			'action',
			'actionHandle',
			'enabled',
		])
	) {
		return undefined;
	}
	const action = value.action as DashboardAction;
	if (handleActions.has(action) !== isActionHandle(value.actionHandle)) {
		return undefined;
	}
	if (booleanActions.has(action) !== (typeof value.enabled === 'boolean')) {
		return undefined;
	}
	const allowedActionKeys = [
		'version',
		'uiInstanceId',
		'type',
		'action',
		...(handleActions.has(action) ? ['actionHandle'] : []),
		...(booleanActions.has(action) ? ['enabled'] : []),
	];
	if (!hasOnlyKeys(value, allowedActionKeys)) {
		return undefined;
	}
	return value as DashboardInboundMessage;
}

export function assertSafeDashboardOutboundMessage(value: DashboardOutboundMessage): void {
	if (
		value.version !== DASHBOARD_MESSAGE_VERSION
		|| !isIdentifier(value.uiInstanceId)
		|| (value.type !== 'dashboard.snapshot' && value.type !== 'dashboard.error')
	) {
		throw new Error('Invalid dashboard outbound message.');
	}
	if (value.type === 'dashboard.snapshot') {
		assertExactRecord(value, ['version', 'uiInstanceId', 'type', 'model'], ['pendingActions']);
		assertDashboardViewModel(value.model);
	} else {
		assertExactRecord(value, ['version', 'uiInstanceId', 'type', 'code', 'message'], ['pendingActions']);
		if (![
			'INVALID_MESSAGE',
			'ACTION_FAILED',
			'UNSAFE_VIEW_MODEL',
			'WINDOW_NAME_CONFLICT',
			'WINDOW_NAME_INVALID',
			'PEER_DELEGATION_DISABLED',
			'WORKSPACE_SELECTION_AMBIGUOUS',
			'POLICY_FORBIDDEN',
			'STALE_ACTION',
			'TASK_NOT_FOUND',
		].includes(value.code)) {
			throw new Error('Invalid dashboard error code.');
		}
	}
	if (value.pendingActions !== undefined) {
		assertArray(value.pendingActions, DASHBOARD_ACTIONS.length);
		if (new Set(value.pendingActions).size !== value.pendingActions.length
			|| value.pendingActions.some((action) => !actions.has(action))) {
			throw new Error('Invalid pending Dashboard actions.');
		}
	}
	assertSafeValue(value, '$');
}

function assertDashboardViewModel(model: unknown): asserts model is DashboardViewModel {
	assertExactRecord(
		model,
		[
			'device',
			'listener',
			'broker',
			'thisWindow',
			'connectivity',
			'deviceTree',
			'localNodes',
			'savedAuthorizations',
			'outgoingTasks',
			'incomingTasks',
			'errors',
		],
		[],
	);
	assertExactRecord(
		model.device,
		['name', 'platform', 'architecture', 'vscodeVersion', 'extensionVersion'],
		[],
	);
	assertStrings(model.device, ['name', 'platform', 'architecture', 'vscodeVersion', 'extensionVersion']);

	assertExactRecord(
		model.listener,
		['state', 'gateway', 'tunnel', 'agentHost', 'canStart', 'canStop', 'canCopyConnectionUrl'],
		[],
	);
	assertEnum(model.listener.state, ['stopped', 'starting', 'running', 'stopping', 'error', 'unavailable']);
	assertBoolean(model.listener.canStart);
	assertBoolean(model.listener.canStop);
	assertBoolean(model.listener.canCopyConnectionUrl);
	assertComponent(model.listener.gateway);
	assertComponent(model.listener.tunnel);
	assertComponent(model.listener.agentHost);

	assertExactRecord(
		model.broker,
		['state', 'role', 'takeover', 'holder'],
		['error'],
	);
	assertEnum(model.broker.state, [
		'starting',
		'running',
		'contending',
		'takingOver',
		'stopping',
		'error',
		'disposed',
	]);
	assertEnum(model.broker.role, ['owner', 'contender']);
	assertEnum(model.broker.takeover, ['stable', 'waiting', 'takingOver', 'stopping', 'error']);
	assertEnum(model.broker.holder, ['thisWindow', 'anotherWindow', 'none']);
	if (model.broker.error !== undefined) {
		assertDashboardError(model.broker.error);
	}

	assertExactRecord(
		model.thisWindow,
		[
			'name',
			'workspaceName',
			'claimStatus',
			'previewEnabled',
			'canRename',
			'acceptsIncoming',
			'canSetAcceptIncoming',
			'agentHost',
		],
		['acceptActionHandle', 'detail'],
	);
	assertStrings(model.thisWindow, ['name', 'workspaceName']);
	assertEnum(model.thisWindow.claimStatus, [
		'claimed',
		'readOnly',
		'conflict',
		'unclaimed',
		'ambiguous',
	]);
	assertBoolean(model.thisWindow.previewEnabled);
	assertBoolean(model.thisWindow.canRename);
	assertBoolean(model.thisWindow.acceptsIncoming);
	assertBoolean(model.thisWindow.canSetAcceptIncoming);
	if (model.thisWindow.canSetAcceptIncoming) {
		assertActionHandle(model.thisWindow.acceptActionHandle);
	} else if (model.thisWindow.acceptActionHandle !== undefined) {
		throw new Error('An unavailable receive policy cannot expose an action handle.');
	}
	assertOptionalString(model.thisWindow.detail);
	assertExactRecord(model.thisWindow.agentHost, ['source', 'label', 'degraded'], ['reason', 'detail']);
	assertEnum(model.thisWindow.agentHost.source, ['editor', 'standalone', 'unavailable']);
	assertString(model.thisWindow.agentHost.label);
	assertBoolean(model.thisWindow.agentHost.degraded);
	if (model.thisWindow.agentHost.reason !== undefined) {
		assertEnum(model.thisWindow.agentHost.reason, [
			'EDITOR_DISCOVERY_FAILED',
			'EDITOR_START_FAILED',
			'STANDALONE_START_FAILED',
		]);
	}
	assertOptionalString(model.thisWindow.agentHost.detail);

	assertConnectivity(model.connectivity);
	dashboardDeviceTreeSchema.parse(model.deviceTree);

	assertArray(model.localNodes, 128);
	for (const candidate of model.localNodes) {
		assertExactRecord(
			candidate,
			[
				'windowLabel',
				'workspaceName',
				'online',
				'acceptsIncoming',
				'busy',
				'allowlisted',
				'self',
				'canToggle',
				'claimState',
				'gateState',
			],
			['actionHandle'],
		);
		assertStrings(candidate, ['windowLabel', 'workspaceName']);
		for (const key of ['online', 'acceptsIncoming', 'busy', 'allowlisted', 'self', 'canToggle']) {
			assertBoolean(candidate[key]);
		}
		assertEnum(candidate.claimState, ['claimed', 'multiWorkspace', 'unclaimed']);
		assertEnum(candidate.gateState, [
			'allowed',
			'notAllowed',
			'notAccepting',
			'offline',
			'multiWorkspace',
			'notClaimed',
		]);
		if (candidate.canToggle) {
			assertActionHandle(candidate.actionHandle);
		} else if (candidate.actionHandle !== undefined) {
			throw new Error('A non-actionable candidate cannot expose an action handle.');
		}
	}

	assertArray(model.savedAuthorizations, 32);
	for (const authorization of model.savedAuthorizations) {
		assertExactRecord(
			authorization,
			['actionHandle', 'windowLabel', 'workspaceName'],
			[],
		);
		assertActionHandle(authorization.actionHandle);
		assertStrings(authorization, ['windowLabel', 'workspaceName']);
	}

	assertDashboardTasks(model.outgoingTasks);
	assertDashboardTasks(model.incomingTasks);

	assertArray(model.errors, 100);
	model.errors.forEach(assertDashboardError);
}

function assertConnectivity(value: unknown): void {
	assertExactRecord(
		value,
		[
			'discoveryEnabled',
			'delegationEnabled',
			'strictPolicyActivated',
			'publishEnabled',
			'hostingBackend',
			'migrationPending',
			'accountProvider',
			'claimedWorkspaceCount',
			'receivingWorkspaceCount',
			'state',
			'truncated',
			'candidates',
			'incomingPeers',
		],
		['error'],
	);
	for (const key of [
		'discoveryEnabled', 'delegationEnabled', 'strictPolicyActivated',
		'publishEnabled', 'migrationPending', 'truncated',
	]) {
		assertBoolean(value[key]);
	}
	assertEnum(value.hostingBackend, ['cli', 'sdk']);
	assertEnum(value.accountProvider, ['none', 'github', 'microsoft']);
	assertEnum(value.state, ['disabled', 'authRequired', 'discovering', 'ready', 'error']);
	for (const key of ['claimedWorkspaceCount', 'receivingWorkspaceCount']) {
		const count = value[key];
		if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 32) {
			throw new Error('Dashboard Workspace count is outside its safe bound.');
		}
	}
	if (value.error !== undefined) {
		assertEnum(value.error, [
			'DISABLED', 'AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED', 'OFFLINE',
			'DISCOVERY_UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT', 'CANCELLED', 'INVALID_ENDPOINT',
			'BINDING_CHANGED', 'POLICY_DENIED', 'PRIVATE_ACCESS_REQUIRED', 'CLEANUP_FAILED',
			'MIGRATION_REQUIRED', 'PROTOCOL_INCOMPATIBLE',
		]);
	}
	assertArray(value.candidates, 10);
	for (const candidate of value.candidates) {
		assertExactRecord(candidate, ['actionHandle', 'label', 'hostHint', 'stale', 'admission'], []);
		assertActionHandle(candidate.actionHandle);
		assertString(candidate.label);
		if (!/^Candidate [0-9a-f]{8}$/u.test(candidate.label)) {
			throw new Error('Dashboard candidate label is invalid.');
		}
		assertEnum(candidate.hostHint, ['online', 'offline', 'unknown']);
		assertBoolean(candidate.stale);
		assertEnum(candidate.admission, ['legacy-mesh-auth', 'private-port-token']);
	}
	assertArray(value.incomingPeers, 256);
	for (const peer of value.incomingPeers) {
		assertExactRecord(peer, ['actionHandle', 'label', 'state', 'cleanupPending'], []);
		assertActionHandle(peer.actionHandle);
		assertString(peer.label);
		if (!/^Peer [0-9a-f]{8}$/u.test(peer.label)) {
			throw new Error('Dashboard incoming peer label is invalid.');
		}
		assertEnum(peer.state, ['active', 'pending', 'revoked']);
		assertBoolean(peer.cleanupPending);
	}
}

function assertDashboardTasks(value: unknown): void {
	assertArray(value, 500);
	for (const task of value) {
		assertExactRecord(
			task,
			[
				'counterpartLabel',
				'workspaceName',
				'title',
				'state',
				'startedAt',
				'shortId',
				'canCancel',
			],
			['actionHandle'],
		);
		assertStrings(task, ['counterpartLabel', 'workspaceName', 'title', 'startedAt', 'shortId']);
		assertEnum(task.state, TASK_STATUSES);
		assertBoolean(task.canCancel);
		const shortId = task.shortId;
		const startedAt = task.startedAt;
		assertString(shortId);
		assertString(startedAt);
		if (!/^[0-9a-f]{8}$/u.test(shortId)) {
			throw new Error('Dashboard task short ID is invalid.');
		}
		if (
			startedAt !== 'Unknown'
			&& !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(startedAt)
		) {
			throw new Error('Dashboard task start time is invalid.');
		}
		if (task.canCancel) {
			assertActionHandle(task.actionHandle);
		} else if (task.actionHandle !== undefined) {
			throw new Error('A terminal task cannot expose a cancel handle.');
		}
	}
}

function assertSafeValue(value: unknown, location: string): void {
	if (typeof value === 'string') {
		if (utf8ByteLength(value) > 2 * 1_024) {
			throw new Error(`Dashboard value exceeds the safe bound at ${location}.`);
		}
		if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
			return;
		}
		if (containsUnsafeDashboardText(value)) {
			throw new Error(`Dashboard value contains a local path or secret at ${location}.`);
		}
		if (/sha256:[A-Za-z0-9_-]{43}/u.test(value)) {
			throw new Error(`Dashboard value contains a full workspace identity at ${location}.`);
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => assertSafeValue(entry, `${location}[${index}]`));
		return;
	}
	if (isRecord(value)) {
		for (const [key, entry] of Object.entries(value)) {
			if (/(secret|token|credential|path|uri|prompt|output|transcript|grant|workspaceIdentity)/i.test(key)) {
				throw new Error(`Dashboard field is forbidden at ${location}.${key}.`);
			}
			assertSafeValue(entry, `${location}.${key}`);
		}
	}
}

function assertComponent(value: unknown): void {
	assertExactRecord(value, ['state', 'label'], ['detail', 'action']);
	assertEnum(value.state, ['ready', 'stopped', 'error', 'unavailable']);
	assertString(value.label);
	assertOptionalString(value.detail);
	assertOptionalString(value.action);
}

function assertDashboardError(value: unknown): void {
	assertExactRecord(value, ['code', 'message'], ['action']);
	assertString(value.code);
	assertString(value.message);
	assertOptionalString(value.action);
}

function assertExactRecord(
	value: unknown,
	required: readonly string[],
	optional: readonly string[],
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error('Dashboard value must be an object.');
	}
	const keys = new Set([...required, ...optional]);
	if (!required.every((key) => Object.hasOwn(value, key)) || !Object.keys(value).every((key) => keys.has(key))) {
		throw new Error('Dashboard object has an invalid shape.');
	}
}

function assertStrings(value: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of keys) {
		assertString(value[key]);
	}
}

function assertString(value: unknown): asserts value is string {
	if (typeof value !== 'string') {
		throw new Error('Dashboard value must be a string.');
	}
}

function assertOptionalString(value: unknown): void {
	if (value !== undefined) {
		assertString(value);
	}
}

function assertBoolean(value: unknown): asserts value is boolean {
	if (typeof value !== 'boolean') {
		throw new Error('Dashboard value must be a boolean.');
	}
}

function assertActionHandle(value: unknown): asserts value is string {
	if (!isActionHandle(value)) {
		throw new Error('Dashboard value must be a scoped action handle.');
	}
}

function assertEnum(value: unknown, allowed: readonly string[]): asserts value is string {
	if (typeof value !== 'string' || !allowed.includes(value)) {
		throw new Error('Dashboard value is outside its allowed enum.');
	}
}

function assertArray(value: unknown, maximumLength: number): asserts value is unknown[] {
	if (!Array.isArray(value) || value.length > maximumLength) {
		throw new Error('Dashboard collection exceeds its allowed shape.');
	}
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isActionHandle(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/u.test(value);
}

function optionalActionHandle(value: unknown): boolean {
	return value === undefined || isActionHandle(value);
}
