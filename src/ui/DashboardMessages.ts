import { DashboardViewModel } from './DashboardPresenter';
import { containsUnsafeDashboardText } from './DashboardRedaction';
import { TASK_STATUSES, utf8ByteLength } from '../../shared/protocol';

export const DASHBOARD_MESSAGE_VERSION = 3 as const;

export const DASHBOARD_ACTIONS = [
	'configureDevice',
	'registerWorkspace',
	'removeWorkspace',
	'startListener',
	'stopListener',
	'copyConnectionUrl',
	'addPeer',
	'removePeer',
	'runTask',
	'cancelTask',
	'refresh',
] as const;

export type DashboardAction = typeof DASHBOARD_ACTIONS[number];

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
		readonly targetId?: string;
		readonly deviceId?: string;
		readonly nodeId?: string;
		readonly nodeInstanceId?: string;
		readonly peerId?: string;
		readonly workspaceId?: string;
	};

export type DashboardOutboundMessage =
	| {
		readonly version: typeof DASHBOARD_MESSAGE_VERSION;
		readonly uiInstanceId: string;
		readonly type: 'dashboard.snapshot';
		readonly model: DashboardViewModel;
	}
	| {
		readonly version: typeof DASHBOARD_MESSAGE_VERSION;
		readonly uiInstanceId: string;
		readonly type: 'dashboard.error';
		readonly code: 'INVALID_MESSAGE' | 'ACTION_FAILED' | 'UNSAFE_VIEW_MODEL';
		readonly message: string;
	};

const actions = new Set<string>(DASHBOARD_ACTIONS);
const targetActions = new Set<DashboardAction>([
	'removeWorkspace',
	'removePeer',
	'cancelTask',
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
		|| !optionalIdentifier(value.targetId)
		|| !optionalIdentifier(value.deviceId)
		|| !optionalIdentifier(value.nodeId)
		|| !optionalIdentifier(value.nodeInstanceId)
		|| !optionalIdentifier(value.peerId)
		|| !optionalIdentifier(value.workspaceId)
		|| !hasOnlyKeys(value, [
			'version',
			'uiInstanceId',
			'type',
			'action',
			'targetId',
			'deviceId',
			'nodeId',
			'nodeInstanceId',
			'peerId',
			'workspaceId',
		])
	) {
		return undefined;
	}
	const action = value.action as DashboardAction;
	if (targetActions.has(action) && !isIdentifier(value.targetId)) {
		return undefined;
	}
	const routingKeys = [
		value.deviceId,
		value.nodeId,
		value.nodeInstanceId,
		value.workspaceId,
	];
	const hasRouting = routingKeys.some((entry) => entry !== undefined);
	if (
		action === 'runTask'
			? (hasRouting && !routingKeys.every(isIdentifier))
				|| (!hasRouting && value.peerId !== undefined)
			: hasRouting || value.peerId !== undefined
	) {
		return undefined;
	}
	const allowedActionKeys = action === 'runTask'
		? ['version', 'uiInstanceId', 'type', 'action', 'deviceId', 'nodeId', 'nodeInstanceId', 'peerId', 'workspaceId']
		: targetActions.has(action)
			? ['version', 'uiInstanceId', 'type', 'action', 'targetId']
			: ['version', 'uiInstanceId', 'type', 'action'];
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
		assertExactRecord(value, ['version', 'uiInstanceId', 'type', 'model'], []);
		assertDashboardViewModel(value.model);
	} else {
		assertExactRecord(value, ['version', 'uiInstanceId', 'type', 'code', 'message'], []);
		if (!['INVALID_MESSAGE', 'ACTION_FAILED', 'UNSAFE_VIEW_MODEL'].includes(value.code)) {
			throw new Error('Invalid dashboard error code.');
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
			'localNodes',
			'remoteDevices',
			'workspaces',
			'peers',
			'tasks',
			'errors',
		],
		[],
	);
	assertExactRecord(
		model.device,
		['name', 'platform', 'architecture', 'vscodeVersion', 'extensionVersion'],
		['deviceId'],
	);
	assertStrings(model.device, ['name', 'platform', 'architecture', 'vscodeVersion', 'extensionVersion']);
	assertOptionalIdentifier(model.device.deviceId);

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

	assertArray(model.localNodes, 128);
	model.localNodes.forEach(assertNode);

	assertArray(model.remoteDevices, 128);
	for (const device of model.remoteDevices) {
		assertExactRecord(device, ['deviceId', 'peerId', 'name', 'state', 'nodes'], []);
		assertIdentifier(device.deviceId);
		assertIdentifier(device.peerId);
		assertString(device.name);
		assertEnum(device.state, ['connecting', 'online', 'busy', 'offline', 'authFailed', 'incompatible']);
		assertArray(device.nodes, 128);
		device.nodes.forEach(assertNode);
	}

	assertArray(model.workspaces, 200);
	for (const workspace of model.workspaces) {
		assertExactRecord(
			workspace,
			['workspaceId', 'name', 'capabilityTags', 'enabled', 'busy'],
			['activeTaskId'],
		);
		assertIdentifier(workspace.workspaceId);
		assertString(workspace.name);
		assertBoolean(workspace.enabled);
		assertBoolean(workspace.busy);
		assertOptionalIdentifier(workspace.activeTaskId);
		assertArray(workspace.capabilityTags, 50);
		workspace.capabilityTags.forEach(assertString);
	}

	function assertNode(value: unknown): void {
		assertExactRecord(
			value,
			['nodeId', 'nodeInstanceId', 'label', 'status', 'thisWindow', 'workspaces'],
			[],
		);
		assertIdentifier(value.nodeId);
		assertIdentifier(value.nodeInstanceId);
		assertString(value.label);
		assertEnum(value.status, ['online', 'busy', 'offline', 'conflict', 'draining']);
		assertBoolean(value.thisWindow);
		assertArray(value.workspaces, 32);
		for (const workspace of value.workspaces) {
			assertExactRecord(
				workspace,
				['workspaceId', 'name', 'capabilityTags', 'enabled', 'busy', 'claimStatus'],
				['activeTaskId'],
			);
			assertIdentifier(workspace.workspaceId);
			assertString(workspace.name);
			assertArray(workspace.capabilityTags, 32);
			workspace.capabilityTags.forEach(assertString);
			assertBoolean(workspace.enabled);
			assertBoolean(workspace.busy);
			assertEnum(workspace.claimStatus, ['claimed', 'readOnly', 'conflict']);
			assertOptionalIdentifier(workspace.activeTaskId);
		}
	}

	assertArray(model.peers, 200);
	for (const peer of model.peers) {
		assertExactRecord(
			peer,
			['peerId', 'name', 'state', 'workspaceCount'],
			['latencyMs', 'lastSeenLabel'],
		);
		assertIdentifier(peer.peerId);
		assertString(peer.name);
		assertEnum(peer.state, ['connecting', 'online', 'busy', 'offline', 'authFailed', 'incompatible']);
		assertBoundedInteger(peer.workspaceCount, 0, 10000);
		if (peer.latencyMs !== undefined) {
			assertBoundedInteger(peer.latencyMs, 0, 600000);
		}
		assertOptionalString(peer.lastSeenLabel);
	}

	assertArray(model.tasks, 500);
	for (const task of model.tasks) {
		assertExactRecord(
			task,
			['taskId', 'title', 'peerName', 'workspaceName', 'state', 'canCancel', 'needsInput'],
			['phase', 'summary', 'summaryTruncated', 'error'],
		);
		assertIdentifier(task.taskId);
		assertStrings(task, ['title', 'peerName', 'workspaceName']);
		assertEnum(task.state, TASK_STATUSES);
		assertBoolean(task.canCancel);
		assertBoolean(task.needsInput);
		assertBoolean(task.summaryTruncated);
		assertOptionalString(task.phase);
		assertOptionalString(task.summary);
		if (task.error !== undefined) {
			assertDashboardError(task.error);
		}
	}

	assertArray(model.errors, 100);
	model.errors.forEach(assertDashboardError);
}

function assertSafeValue(value: unknown, location: string): void {
	if (typeof value === 'string') {
		if (utf8ByteLength(value) > 2 * 1_024) {
			throw new Error(`Dashboard value exceeds the safe bound at ${location}.`);
		}
		if (containsUnsafeDashboardText(value)) {
			throw new Error(`Dashboard value contains a local path or secret at ${location}.`);
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => assertSafeValue(entry, `${location}[${index}]`));
		return;
	}
	if (isRecord(value)) {
		for (const [key, entry] of Object.entries(value)) {
			if (/(secret|token|credential|localPath|prompt|fullOutput)/i.test(key)) {
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

function assertIdentifier(value: unknown): asserts value is string {
	if (!isIdentifier(value)) {
		throw new Error('Dashboard value must be an opaque identifier.');
	}
}

function assertOptionalIdentifier(value: unknown): void {
	if (value !== undefined) {
		assertIdentifier(value);
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

function assertBoundedInteger(value: unknown, minimum: number, maximum: number): void {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error('Dashboard number is outside its allowed range.');
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

function optionalIdentifier(value: unknown): boolean {
	return value === undefined || isIdentifier(value);
}
