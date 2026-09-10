import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { createDashboardBrowserHarness } from './dashboardBrowserHarness';

const handle = (letter: string) => letter.repeat(32);
const component = () => ({ state: 'stopped', label: 'Stopped' });
function model() {
	return {
		device: { name: 'Online', platform: 'macOS', architecture: 'arm64', workerSupported: true, vscodeVersion: '1.103', extensionVersion: '0.5.0' },
		listener: { state: 'stopped', gateway: component(), tunnel: component(), agentHost: component(), canStart: true, canStop: false, canCopyConnectionUrl: false },
		broker: { state: 'running', role: 'owner', takeover: 'stable', holder: 'thisWindow' },
		thisWindow: { name: 'Editor', workspaceName: 'Project', claimStatus: 'claimed', previewEnabled: true, canRename: true, acceptsIncoming: false,
			canSetAcceptIncoming: false, agentHost: { source: 'unavailable', label: 'Unavailable', degraded: false } },
		connectivity: {
			discoveryEnabled: true, delegationEnabled: true, strictPolicyActivated: true, publishEnabled: true,
			hostingBackend: 'sdk', migrationPending: false, accountProvider: 'github', claimedWorkspaceCount: 2, receivingWorkspaceCount: 0,
			state: 'ready', truncated: false, candidates: [], incomingPeers: [], enabled: true, connectionState: 'online', connectedDeviceCount: 1,
		},
		management: {
			available: true, truncated: false, accountActionHandle: handle('A'),
			devices: [
				{ key: 'manage-device-1', name: 'Remote device', state: 'online', cleanupPending: false, activeTaskCount: 0,
					deleteActionHandle: handle('D') as string | undefined, revokeActionHandle: handle('R'), probeActionHandle: handle('P') },
				{ key: 'manage-device-2', name: 'Cached device', state: 'unknown', cleanupPending: false,
					deleteBlockedReason: 'Task status is unknown. Refresh device diagnostics before deleting.', revokeActionHandle: handle('U') },
			],
			workspaces: [
				{ key: 'manage-workspace-1', name: 'Same name', enabled: true, acceptsIncoming: false, enableActionHandle: handle('E'),
					receiveActionHandle: handle('I'), removeActionHandle: handle('M'),
					incomingPeers: [{ key: 'manage-peer-1', name: 'Remote device', allowed: false, autoAccept: false, allowActionHandle: handle('G'), autoAcceptActionHandle: handle('J') }] },
				{ key: 'manage-workspace-2', name: 'Same name', enabled: false, acceptsIncoming: false,
					enableActionHandle: handle('F'), incomingPeers: [] },
			],
			targets: [{
				key: 'manage-target-1', deviceName: 'Remote device', windowName: 'Editor', workspaceName: 'Remote root', locality: 'remote', online: true,
				sources: [{ sourceKey: 'manage-workspace-1', allowed: false, actionHandle: handle('S') }, { sourceKey: 'manage-workspace-2', allowed: true, actionHandle: handle('T') }],
				allSourcesAllowed: 'some', allSourcesActionHandle: handle('B'),
			}],
		},
		deviceTree: [
			{ key: 'tree-1', name: 'Online', locality: 'local', state: 'online', nodes: [{
				key: 'tree-2', label: 'Editor', thisWindow: true, status: 'online', workspaces: [
					workspace('tree-3', 'Same name', 'manage-workspace-1', true),
					workspace('tree-4', 'Same name', 'manage-workspace-2', true),
				],
			}] },
			{ key: 'tree-5', name: 'Remote device', locality: 'remote', state: 'online', managementKey: 'manage-device-1', nodes: [{
				key: 'tree-6', label: 'Editor', thisWindow: false, status: 'online',
				workspaces: [workspace('tree-7', 'Remote root', 'manage-target-1')],
			}] },
			{ key: 'tree-8', name: 'Cached tree device', locality: 'remote', state: 'unknown', nodes: [{
				key: 'tree-9', label: 'Stale window', thisWindow: false, status: 'online', workspaces: [workspace('tree-10', 'Stale root', 'manage-target-1')],
			}] },
		],
		localNodes: [],
		savedAuthorizations: [{ actionHandle: handle('L'), windowLabel: 'Offline local window', workspaceName: 'Offline root' }],
		outgoingTasks: [task('recovering', '00000001'), task('completed', '00000002'), task('timedOut', '00000003')],
		incomingTasks: [task('needsInput', '00000004'), task('cancelling', '00000005'), task('failed', '00000006'), task('cancelled', '00000007')],
		errors: [],
	};
}
function workspace(key: string, name: string, permissionKey: string, self = false) {
	return { key, name, permissionKey, claimStatus: 'claimed', enabled: true, busy: false, acceptsIncoming: true,
		allowlisted: true, gateState: self ? 'self' : 'allowed', canDelegate: !self,
		...(!self ? { delegateActionHandle: handle('C') } : {}), incomingPeers: [] };
}
function task(state: string, shortId: string) {
	const canCancel = !['completed', 'failed', 'cancelled', 'timedOut'].includes(state);
	return { counterpartLabel: 'Remote device', workspaceName: 'Task root', title: `Task ${shortId}`, state,
		startedAt: `2026-09-0${Number(shortId) + 1}T00:00:00.000Z`, shortId, canCancel, ...(canCancel ? { actionHandle: handle('K') } : {}) };
}

test('overview uses positive liveness and preserves every nonterminal task', () => {
	const browser = createDashboardBrowserHarness();
	browser.render(model());
	assert.deepEqual(browser.messages[0], { version: 10, uiInstanceId: 'media-view', type: 'ready' });
	assert.equal(browser.messages.length, 1);
	assert.match(browser.element('deviceTree').text, /Remote root/u);
	assert.doesNotMatch(browser.element('deviceTree').text, /Stale root|Stale window|Cached tree device/u);
	assert.match(browser.element('activeTasks').text, /Recovering[\s\S]*Needs input|Needs input[\s\S]*Recovering/u);
	assert.match(browser.element('activeTasks').text, /Cancelling/u);
	assert.doesNotMatch(browser.element('activeTasks').text, /Task 00000002|Task 00000003/u);
	browser.control('delegate-tree-7').click();
	assert.equal(browser.messages.at(-1)?.action, 'openTargetChat');
	assert.equal(browser.messages.at(-1)?.actionHandle, handle('C'));
});

test('overview keeps workspace shortcuts inline and moves normal device controls into management', () => {
	const browser = createDashboardBrowserHarness();
	browser.render(model());
	const shortcut = browser.control('permission-tree-3');
	assert.equal(shortcut.parentElement?.children[0].text, 'Same name');
	assert.equal(shortcut.parentElement?.className, 'itemHeading workspaceHeading');
	assert.doesNotMatch(browser.element('deviceTree').text, /Claimed|Device diagnostics|Revoke trust|Revoking trust/u);
	assert.doesNotMatch(browser.element('connectivity').text, /Account|Refresh remote devices|Disable cross-device/u);
	assert.match(browser.element('connectivity').text, /Cross-device connections/u);
	assert.match(browser.element('connectivity').text, /Online 1 connected Manage/u);
	browser.control('connect-manage').click();
	assert.equal(browser.control('revoke-manage-device-1').disabled, false);
	assert.equal(browser.control('probe-manage-device-1').disabled, false);
	assert.equal(browser.control('connect-disable').disabled, false);
	assert.equal(browser.control('remote-refresh').disabled, false);
	assert.match(browser.element('connectivity').text, /Account/u);
});

test('overview retains exceptional claim, busy and cleanup hints and full claim details remain scoped', () => {
	const browser = createDashboardBrowserHarness();
	const data = model();
	data.deviceTree[0].nodes[0].workspaces[1].claimStatus = 'conflict';
	data.deviceTree[0].nodes[0].workspaces[1].busy = true;
	data.management.devices[0].cleanupPending = true;
	browser.render(data);
	assert.match(browser.element('deviceTree').text, /Busy/u);
	assert.match(browser.element('deviceTree').text, /Conflict/u);
	assert.match(browser.element('deviceTree').text, /Access cleanup is pending/u);
	browser.control('permission-tree-4').click();
	assert.match(browser.element('pageContent').text, /Claim status Conflict/u);
});

test('workspace permissions use exact keys and back restores scroll and triggering focus', () => {
	const browser = createDashboardBrowserHarness();
	browser.render(model());
	browser.element('pageScroll').scrollTop = 321;
	browser.control('permission-tree-4').click();
	assert.equal(browser.control('enabled-manage-workspace-2').checked, false);
	assert.equal(browser.find((item) => item.dataset.focusKey === 'enabled-manage-workspace-1').length, 0);
	browser.control('enabled-manage-workspace-2').click();
	assert.deepEqual(browser.messages.at(-1), {
		version: 10, uiInstanceId: 'media-view', type: 'action', action: 'setWorkspaceEnabled', actionHandle: handle('F'), enabled: true,
	});
	browser.button('Back').click();
	assert.equal(browser.element('pageScroll').scrollTop, 321);
	assert.equal(browser.activeElement?.dataset.focusKey, 'permission-tree-4');
});

test('selected-source access is separate from explicit all-workspace access', () => {
	const browser = createDashboardBrowserHarness();
	browser.render(model());
	browser.control('permission-tree-7').click();
	assert.equal(browser.control('source-workspace').value, '');
	assert.match(browser.element('pageContent').text, /only after every source workspace allows this target/u);
	const source = browser.control('source-workspace');
	source.value = 'manage-workspace-2';
	source.emit('change');
	browser.control('target-manage-target-1-manage-workspace-2').click();
	assert.equal(browser.messages.at(-1)?.actionHandle, handle('T'));
	assert.equal(browser.messages.at(-1)?.enabled, false);
	assert.equal(browser.messages.at(-1)?.action, 'setTargetAllowed');
	browser.render(model());
	browser.control('allow-all-manage-target-1').click();
	assert.equal(browser.messages.at(-1)?.action, 'setWindowTargetAllowed');
	assert.equal(browser.messages.at(-1)?.actionHandle, handle('B'));
	assert.match(browser.element('pageContent').text, /Same name Same name/u);
	const authorized = model();
	authorized.management.targets[0].allSourcesAllowed = 'all';
	for (const source of authorized.management.targets[0].sources) { source.allowed = true; }
	browser.render(authorized);
	assert.doesNotMatch(browser.element('pageContent').text, /only after every source workspace allows this target/u);
});

test('incoming grant and automatic start post independent booleans', () => {
	const browser = createDashboardBrowserHarness();
	browser.render(model());
	browser.control('permission-tree-3').click();
	browser.control('incoming-manage-workspace-1-manage-peer-1').click();
	assert.equal(browser.messages.at(-1)?.action, 'setIncomingDeviceGrant');
	assert.equal(browser.messages.at(-1)?.actionHandle, handle('G'));
	browser.render(model());
	browser.control('autoaccept-manage-workspace-1-manage-peer-1').click();
	assert.equal(browser.messages.at(-1)?.action, 'setDeviceAutoAccept');
	assert.equal(browser.messages.at(-1)?.actionHandle, handle('J'));
});

test('a removed selected source never silently retargets a similarly named source', () => {
	const browser = createDashboardBrowserHarness();
	const data = model();
	browser.render(data);
	browser.control('permission-tree-7').click();
	browser.control('source-workspace').value = 'manage-workspace-1';
	browser.control('source-workspace').emit('change');
	data.management.workspaces = [data.management.workspaces[1]];
	data.management.targets[0].sources = [data.management.targets[0].sources[1]];
	browser.render(data);
	assert.equal(browser.control('source-workspace').value, '');
	assert.equal(browser.control('target-manage-target-1-none').disabled, true);
	assert.match(browser.element('pageContent').text, /no replacement was chosen/u);
	assert.equal(browser.messages.length, 1);
});

test('offline target handles only offer removal, never new source or bulk access', () => {
	const browser = createDashboardBrowserHarness();
	const data = model();
	data.management.targets[0].online = false;
	browser.render(data);
	browser.control('permission-tree-7').click();
	browser.control('source-workspace').value = 'manage-workspace-1';
	browser.control('source-workspace').emit('change');
	assert.equal(browser.control('target-manage-target-1-manage-workspace-1').disabled, true);
	assert.equal(browser.control('allow-all-manage-target-1').disabled, true);
	assert.equal(browser.control('deny-all-manage-target-1').disabled, false);
	assert.match(browser.element('pageContent').text, /Offline targets only support removing existing access/u);
	browser.control('source-workspace').value = 'manage-workspace-2';
	browser.control('source-workspace').emit('change');
	assert.equal(browser.control('target-manage-target-1-manage-workspace-2').disabled, false);
	browser.control('target-manage-target-1-manage-workspace-2').click();
	assert.equal(browser.messages.at(-1)?.actionHandle, handle('T'));
	assert.equal(browser.messages.at(-1)?.enabled, false);
});

test('history partitions all terminal states with direction and status filters recent-first', () => {
	const browser = createDashboardBrowserHarness();
	browser.render(model());
	browser.button('Task history').click();
	const tasks = browser.element('historyTasks').text;
	assert.match(tasks, /Completed|Failed|Cancelled|Timed out/u);
	assert.doesNotMatch(tasks, /Task 00000001|Task 00000004|Task 00000005/u);
	assert.ok(tasks.indexOf('Task 00000007') < tasks.indexOf('Task 00000002'));
	browser.control('history-status').value = 'timedOut';
	browser.control('history-status').emit('change');
	assert.match(browser.element('historyTasks').text, /Task 00000003/u);
	assert.doesNotMatch(browser.element('historyTasks').text, /Task 00000002/u);
	browser.control('history-direction').value = 'incoming';
	browser.control('history-direction').emit('change');
	assert.match(browser.element('historyTasks').text, /No task history matches/u);
});

test('saved devices stay visible while off; unknown and active tasks block deletion but not revoke', () => {
	const browser = createDashboardBrowserHarness();
	const data = model();
	data.connectivity.enabled = false;
	data.connectivity.connectionState = 'disabled';
	data.management.devices[0].activeTaskCount = 1;
	data.management.devices[0].deleteActionHandle = undefined;
	browser.render(data);
	assert.doesNotMatch(browser.element('deviceTree').text, /Remote root/u);
	browser.button('Saved devices').click();
	assert.match(browser.element('savedDevices').text, /Cached device/u);
	assert.match(browser.element('savedAuthorizations').text, /Offline local window/u);
	assert.equal(browser.control('delete-manage-device-1').disabled, true);
	assert.equal(browser.control('delete-manage-device-2').disabled, true);
	assert.equal(browser.control('revoke-manage-device-1').disabled, false);
	browser.control('revoke-manage-device-1').click();
	assert.equal(browser.messages.at(-1)?.action, 'revokeDevice');
});

test('confirmed online devices stay in management rather than the saved-device list', () => {
	const browser = createDashboardBrowserHarness();
	browser.render(model());
	browser.button('Saved devices').click();
	assert.doesNotMatch(browser.element('savedDevices').text, /Remote device/u);
	assert.match(browser.element('savedDevices').text, /Cached device/u);
	browser.button('Devices & permissions').click();
	assert.equal(browser.control('revoke-manage-device-1').disabled, false);
});

test('connection startup is cancellable immediately and navigation/task cancellation remain usable', () => {
	const browser = createDashboardBrowserHarness();
	const data = model();
	data.connectivity.enabled = false;
	data.connectivity.connectionState = 'disabled';
	browser.render(data);
	browser.button('Enable cross-device connections').click();
	assert.equal(browser.button('Cancel connection startup').disabled, false);
	browser.control('cancel-incoming-00000004').click();
	assert.equal(browser.messages.at(-1)?.action, 'cancelIncomingTask');
	browser.button('Cancel connection startup').click();
	assert.equal(browser.messages.at(-1)?.action, 'disableConnectivity');
	browser.button('Task history').click();
	assert.ok(browser.element('historyTasks'));
});

test('all connection states expose their precise recovery or stop actions', () => {
	for (const [connectionState, label, action] of [
		['disabled', 'Off', 'Enable cross-device connections'],
		['authenticating', 'Waiting for account authorization', 'Cancel connection startup'],
		['starting', 'Connecting', 'Cancel connection startup'],
		['online', 'Online', 'Disable cross-device connections'],
		['stopping', 'Disconnecting', 'Disable cross-device connections'],
		['authRequired', 'Sign-in required', 'Sign in and connect'],
		['error', 'Connection needs attention', 'Enable cross-device connections'],
		['cleanupPending', 'Offline · Tunnel cleanup pending', 'Retry Tunnel cleanup'],
	]) {
		const browser = createDashboardBrowserHarness();
		const data = model();
		data.connectivity.connectionState = connectionState;
		data.connectivity.enabled = !['disabled', 'authRequired', 'cleanupPending'].includes(connectionState);
		browser.render(data);
		assert.match(browser.element('connectivity').text, new RegExp(label));
		if (connectionState === 'online') {
			assert.equal(browser.find((element) => element.dataset.focusKey === 'connect-disable').length, 0);
			browser.control('connect-manage').click();
		}
		assert.equal(browser.button(action).disabled, connectionState === 'stopping');
	}
});

test('operational errors and truncation stay inline and preserve detailed reasons', () => {
	const browser = createDashboardBrowserHarness('zh');
	const data = {
		...model(),
		errors: [{ code: 'STALE_ACTION', message: 'Exact source registration changed.', action: 'Refresh the selected source.' }],
		management: { ...model().management, truncated: true },
		connectivity: { ...model().connectivity, error: 'ACCOUNT_CHANGED', truncated: true },
	};
	browser.render(data);
	assert.match(browser.element('pageContent').text, /Exact source registration changed/u);
	assert.match(browser.element('pageContent').text, /所选账号不拥有此隧道/u);
	assert.match(browser.element('pageContent').text, /安全显示上限/u);
	assert.equal(browser.find((item) => item.text === 'Exact source registration changed.')[0]?.visible, true);
	browser.send({ version: 10, uiInstanceId: 'media-view', type: 'dashboard.error', code: 'ACTION_FAILED', message: 'Device probe was rejected.' });
	assert.match(browser.element('pageContent').text, /Device probe was rejected/u);
	browser.render(model());
	assert.match(browser.element('pageContent').text, /Device probe was rejected/u, 'Snapshot updates must not expire action errors');
});

test('missing management handles disable changes and explain missing authority', () => {
	const browser = createDashboardBrowserHarness();
	const data = model();
	data.management.workspaces[0].receiveActionHandle = undefined;
	browser.render(data);
	browser.control('permission-tree-3').click();
	assert.equal(browser.control('receiving-manage-workspace-1').disabled, true);
	assert.match(browser.element('pageContent').text, /Permission changes are unavailable without a current authorized action/u);
	const count = browser.messages.length;
	browser.control('receiving-manage-workspace-1').click();
	assert.equal(browser.messages.length, count);
});

test('snapshot refresh preserves disclosure state and active control focus', () => {
	const browser = createDashboardBrowserHarness();
	browser.render(model());
	browser.control('disclosure-device-tree-5').click();
	assert.equal(browser.control('disclosure-device-tree-5').parentElement?.open, false);
	browser.render(model());
	assert.equal(browser.control('disclosure-device-tree-5').parentElement?.open, false);
	assert.equal(browser.activeElement?.dataset.focusKey, 'disclosure-device-tree-5');
});

test('strict renderer rejects malformed nested model, unknown keys and raw handles without changing the UI', () => {
	const browser = createDashboardBrowserHarness();
	browser.render(model());
	const before = browser.element('pageContent').text;
	const invalid: unknown[] = [
		{ ...model(), hiddenSettings: {} },
		{ ...model(), management: { ...model().management, grants: [] } },
		{ ...model(), device: { ...model().device, workerSupported: 'true' } },
		{ ...model(), outgoingTasks: [{ ...task('recovering', '00000001'), prompt: 'unexpected' }] },
		{ ...model(), management: { ...model().management, accountActionHandle: '11111111-1111-4111-8111-111111111111' } },
		{ ...model(), incomingTasks: [{ ...task('completed', '00000001'), canCancel: true, actionHandle: handle('K') }] },
		{ ...model(), management: { ...model().management, devices: [{ ...model().management.devices[0], activeTaskCount: undefined }] } },
		{ ...model(), listener: { ...model().listener, gateway: { state: 'error', label: 1 } } },
		{ ...model(), management: { ...model().management, devices: Array(33).fill(model().management.devices[0]) } },
		{ ...model(), management: { ...model().management, targets: [{ ...model().management.targets[0],
			sources: [{ sourceKey: 'manage-workspace-999', allowed: true, actionHandle: handle('Z') }] }] } },
		{ ...model(), deviceTree: [{ ...model().deviceTree[0], managementKey: handle('X') }] },
	];
	for (const data of invalid) {
		browser.render(data);
		assert.equal(browser.element('pageContent').text, before);
	}
});

test('unavailable exact permissions never select a similarly named workspace', () => {
	const browser = createDashboardBrowserHarness();
	const data = model();
	data.deviceTree[0].nodes[0].workspaces[1].permissionKey = 'manage-workspace-999';
	browser.render(data);
	browser.control('permission-tree-4').click();
	assert.match(browser.element('pageContent').text, /no other workspace was selected/u);
	assert.equal(browser.find((item) => item.tagName === 'input').length, 0);
});

test('Chinese localizes operational labels, preserves user names, and help is explicitly closable', () => {
	const browser = createDashboardBrowserHarness('zh-CN');
	browser.render(model());
	assert.match(browser.element('deviceTree').text, /Online/u, 'User device name must not be translated');
	assert.match(browser.element('connectivity').text, /跨设备连接/u);
	assert.match(browser.element('activeTasks').text, /未结束任务/u);
	assert.match(browser.element('activeTasks').text, /我发出的/u);
	assert.match(browser.element('activeTasks').text, /发给我的/u);
	assert.match(browser.element('activeTasks').text, /恢复中|等待输入/u);
	browser.control('help-overviewHelp').click();
	assert.equal(browser.element('helpPopover').hidden, false);
	assert.match(browser.element('helpPopover').text, /已确认在线/u);
	browser.keydown('Escape');
	assert.equal(browser.element('helpPopover').hidden, true);
	assert.equal(browser.activeElement?.dataset.focusKey, 'help-overviewHelp');
	const fallback = createDashboardBrowserHarness('fr');
	fallback.render(model());
	assert.match(fallback.element('activeTasks').text, /Recovering/u);
});

test('diagnostic dictionary has Chinese text for every coded explanation', () => {
	const window: { dashboardDiagnostics?: Record<string, string>; dashboardL10n?: { zh: Record<string, string> } } = {};
	runInNewContext(readFileSync(resolve(__dirname, '../../../media/dashboard.l10n.js'), 'utf8'), { window });
	for (const [code, message] of Object.entries(window.dashboardDiagnostics ?? {})) {
		assert.ok(window.dashboardL10n?.zh[message], code);
	}
	const code = readFileSync(resolve(__dirname, '../../../media/dashboard.js'), 'utf8');
	assert.doesNotMatch(code, /innerHTML/u);
	assert.doesNotMatch(code, /postAction\(['"]configure(?:Connectivity|RemotePolicy)/u);
	assert.doesNotMatch(readFileSync(resolve(__dirname, '../../../media/dashboard.css'), 'utf8'), /#[0-9a-f]{3,8}\b/iu);
});
