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
			failedCandidateCount: 0, deferredCandidateCount: 0, peerErrors: [],
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
	assert.deepEqual(browser.messages[0], { version: 11, uiInstanceId: 'media-view', type: 'ready' });
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

test('discovery timeouts are scoped warnings, preserve delegation, and disappear on discovery recovery', () => {
	for (const language of ['en', 'zh']) {
		const browser = createDashboardBrowserHarness(language);
		const source = model();
		browser.render(source);
		const tasks = browser.element('activeTasks').text;
		browser.render({ ...source, connectivity: {
			...source.connectivity, state: 'partial', discoveryError: 'TIMEOUT', failedCandidateCount: 1,
		} });
		const panel = browser.element('connectivity');
		assert.match(panel.text, /TIMEOUT/u);
		assert.match(panel.text, language === 'en' ? /Device discovery.*does not report a failure of local or Codespaces tasks/u : /设备发现.*不表示本机或 Codespaces 任务执行失败/u);
		assert.ok(panel.children.some((child) => child.className === 'warning' && child.getAttribute('role') === 'status'));
		assert.ok(!panel.children.some((child) => child.className === 'error'));
		assert.equal(browser.control('delegate-tree-7').disabled, false);
		assert.equal(browser.element('activeTasks').text, tasks);
		assert.equal(browser.find((item) => item.dataset.focusKey === 'connect-disable').length, 0);
		browser.control('remote-refresh').click();
		assert.equal(browser.messages.at(-1)?.action, 'refreshRemoteTargets');
		browser.render(source);
		assert.doesNotMatch(browser.element('connectivity').text, /TIMEOUT/u);
		assert.equal(browser.element('activeTasks').text, tasks);
	}
});

test('intentional offline deferrals are explicit in management without showing a failure banner', () => {
	const browser = createDashboardBrowserHarness();
	const source = model();
	browser.render({ ...source, connectivity: { ...source.connectivity, state: 'partial', deferredCandidateCount: 1 } });
	assert.ok(!browser.element('connectivity').children.some((child) => ['warning', 'error'].includes(child.className)));
	browser.button('Devices & permissions').click();
	assert.match(browser.element('connectivity').text, /Discovery is partial: 0 failed, 1 deferred/u);
	assert.match(browser.element('diagnostics').text, /Partially updated/u);
});

test('peer and action failures keep their own labels and authentication failures remain errors', () => {
	const browser = createDashboardBrowserHarness();
	const source = model();
	browser.render({ ...source, connectivity: {
		...source.connectivity, discoveryError: 'AUTH_REQUIRED',
		actionError: { action: 'configureConnectivity', code: 'TIMEOUT' },
		peerErrors: [{ label: 'Device 12345678', code: 'OFFLINE' }],
	} });
	assert.ok(browser.element('connectivity').children.some((child) =>
		child.className === 'error' && child.getAttribute('role') === 'alert' && child.text.includes('Device discovery')));
	assert.match(browser.element('connectivity').text, /Connection action failed/u);
	assert.match(browser.element('connectivity').text, /Remote device connection issues: 1/u);
	assert.equal(browser.control('delegate-tree-7').disabled, false);
	browser.button('Devices & permissions').click();
	assert.match(browser.element('connectivity').text, /Remote device connection.*Device 12345678/u);
});

test('renderer rejects malformed scoped discovery and peer diagnostics', () => {
	const browser = createDashboardBrowserHarness();
	const source = model();
	browser.render(source);
	const original = browser.element('connectivity').text;
	for (const patch of [
		{ discoveryError: 'UNKNOWN' }, { failedCandidateCount: 11 }, { deferredCandidateCount: -1 },
		{ actionError: { action: 'runTask', code: 'TIMEOUT' } },
		{ actionError: { action: 'refreshDiscovery', code: 'TIMEOUT', token: 'private' } },
		{ peerErrors: [{ label: 'untrusted identity', code: 'OFFLINE' }] },
		{ peerErrors: Array.from({ length: 257 }, () => ({ label: 'Device 12345678', code: 'OFFLINE' })) },
	]) {
		browser.render({ ...source, connectivity: { ...source.connectivity, ...patch } });
		assert.equal(browser.element('connectivity').text, original);
	}
});

test('opening Chat drafts never flashes global progress or compact disconnect controls', () => {
	for (const language of ['en', 'zh']) {
		const browser = createDashboardBrowserHarness(language);
		const data = model();
		browser.render(data);
		const connection = browser.element('connectivity').text;
		const assertQuietOverview = () => {
			assert.equal(browser.element('operationStatus').text, '');
			assert.equal(browser.element('connectivity').text, connection);
			assert.equal(browser.find((item) => item.dataset.focusKey === 'connect-disable').length, 0);
		};
		for (let index = 0; index < 3; index++) {
			assertQuietOverview();
			const delegate = browser.control('delegate-tree-7');
			const messageCount = browser.messages.length;
			delegate.click();
			assert.equal(browser.control('delegate-tree-7').disabled, true);
			assertQuietOverview();
			assert.deepEqual(browser.messages.at(-1), {
				version: 11, uiInstanceId: 'media-view', type: 'action', action: 'openTargetChat', actionHandle: handle('C'),
			});
			delegate.emit('click');
			browser.control('delegate-tree-7').click();
			assert.equal(browser.messages.length, messageCount + 1, 'Pending drafts must still reject duplicate clicks.');
			for (const pending of [['openTargetChat'], ['openTargetChat'], []]) {
				browser.render(data, pending);
				assert.equal(browser.control('delegate-tree-7').disabled, pending.length > 0);
				assertQuietOverview();
			}
		}
	}
});

test('pending Chat drafts preserve management disconnect and concurrent operation feedback', () => {
	const browser = createDashboardBrowserHarness();
	const data = model();
	browser.render(data, ['openTargetChat']);
	browser.button('Devices & permissions').click();
	assert.equal(browser.element('operationStatus').text, '');
	assert.equal(browser.control('connect-disable').disabled, false);
	browser.control('switch-account').click();
	browser.render(data, ['openTargetChat', 'switchAccount']);
	browser.button('Overview').click();
	assert.match(browser.element('operationStatus').text, /Action in progress/u);
	assert.equal(browser.control('delegate-tree-7').disabled, true);
	assert.equal(browser.control('connect-disable').disabled, false);
	assert.equal(browser.control('cancel-incoming-00000004').disabled, false);
	browser.control('cancel-incoming-00000004').click();
	assert.equal(browser.messages.at(-1)?.action, 'cancelIncomingTask');
	browser.control('connect-disable').click();
	assert.equal(browser.messages.at(-1)?.action, 'disableConnectivity');
	assert.equal(browser.control('connect-disable').disabled, true);
	browser.render(data, ['openTargetChat']);
	assert.equal(browser.control('delegate-tree-7').disabled, true);
	assert.equal(browser.element('operationStatus').text, '');
	assert.equal(browser.find((item) => item.dataset.focusKey === 'connect-disable').length, 0);
});

test('Chat draft failures remain visible and retries only lock the draft action', () => {
	const browser = createDashboardBrowserHarness();
	const data = model();
	browser.render(data);
	const connection = browser.element('connectivity').text;
	browser.control('delegate-tree-7').click();
	browser.send({
		version: 11, uiInstanceId: 'media-view', type: 'dashboard.error',
		code: 'ACTION_FAILED', message: 'The Chat draft could not be opened.', pendingActions: ['openTargetChat'],
	});
	assert.match(browser.element('pageContent').text, /The Chat draft could not be opened/u);
	assert.equal(browser.control('delegate-tree-7').disabled, true);
	assert.equal(browser.element('operationStatus').text, '');
	assert.equal(browser.element('connectivity').text, connection);
	browser.render(data);
	assert.match(browser.element('pageContent').text, /The Chat draft could not be opened/u);
	assert.equal(browser.control('delegate-tree-7').disabled, false);
	browser.control('delegate-tree-7').click();
	assert.doesNotMatch(browser.element('pageContent').text, /The Chat draft could not be opened/u);
	assert.equal(browser.control('delegate-tree-7').disabled, true);
	assert.equal(browser.element('operationStatus').text, '');
	assert.equal(browser.element('connectivity').text, connection);
	assert.equal(browser.messages.filter(({ action }) => action === 'openTargetChat').length, 2);
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
		version: 11, uiInstanceId: 'media-view', type: 'action', action: 'setWorkspaceEnabled', actionHandle: handle('F'), enabled: true,
	});
	browser.button('Back').click();
	assert.equal(browser.element('pageScroll').scrollTop, 321);
	assert.equal(browser.activeElement?.dataset.focusKey, 'permission-tree-4');
});

test('device naming is an accessible inline edit next to the value, not a standalone action', () => {
	for (const language of ['en', 'zh']) {
		const browser = createDashboardBrowserHarness(language);
		const data = model();
		data.device.name = 'My device';
		browser.render(data);
		browser.button(language === 'en' ? 'Devices & permissions' : '设备与权限').click();
		const edit = browser.control('rename-device');
		assert.equal(edit.parentElement?.className, 'editableValue');
		assert.equal(edit.parentElement?.children[0].text, 'My device');
		assert.equal(edit.parentElement?.parentElement?.className, 'propertyRow');
		assert.equal(edit.attributes['aria-label'], language === 'en' ? 'Edit device name' : '编辑设备名称');
		assert.equal(edit.title, edit.attributes['aria-label']);
		assert.throws(() => browser.button(language === 'en' ? 'Rename device' : '重命名设备'));
		edit.click();
		assert.deepEqual(browser.messages.at(-1), {
			version: 11, uiInstanceId: 'media-view', type: 'action', action: 'configureDevice',
		});
		browser.render(data);
		assert.equal(browser.activeElement?.dataset.focusKey, 'rename-device');
	}
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

test('refresh and reconnect notices retain last-known rows and preferences but reject even detached action callbacks', () => {
	const browser = createDashboardBrowserHarness();
	const data = model();
	browser.render(data);
	const previousDelegate = browser.control('delegate-tree-7');
	browser.control('permission-tree-7').click();
	browser.control('source-workspace').value = 'manage-workspace-1';
	browser.control('source-workspace').emit('change');
	const previousSourceToggle = browser.control('target-manage-target-1-manage-workspace-1');
	const refreshing = {
		...data, errors: [{ code: 'DASHBOARD_REFRESHING', message: 'DASHBOARD_REFRESHING' }],
	};
	browser.render(refreshing);
	assert.equal(browser.control('target-manage-target-1-manage-workspace-1').disabled, true);
	assert.equal(browser.control('allow-all-manage-target-1').disabled, true);
	previousDelegate.emit('click');
	previousSourceToggle.emit('change');
	assert.equal(browser.messages.length, 1, 'Stale callbacks must not post actions even if the DOM disable is bypassed.');
	assert.equal(browser.find((item) => item.className === 'error').length, 0);
	assert.equal(browser.find((item) => item.id === 'dashboardFreshness').length, 0);
	assert.doesNotMatch(browser.element('pageContent').text, /Updating live status/u);
	assert.doesNotMatch(browser.element('pageContent').text, /Reconnecting/u);
	browser.button('Overview').click();
	assert.match(browser.element('deviceTree').text, /Remote root/u);
	assert.match(browser.element('activeTasks').text, /Task 00000001/u);
	assert.match(browser.element('connectivity').text, /Online 1 connected/u);
	assert.equal(browser.control('delegate-tree-7').disabled, true);
	assert.equal(browser.control('cancel-incoming-00000004').disabled, true);

	const reconnecting = {
		...data, errors: [{ code: 'DASHBOARD_RECONNECTING', message: 'DASHBOARD_RECONNECTING' }],
	};
	browser.render(reconnecting);
	browser.send({ version: 11, uiInstanceId: 'media-view', type: 'dashboard.error', code: 'STALE_ACTION', message: 'This action is stale.' });
	assert.equal(browser.find((item) => item.id === 'dashboardFreshness').length, 1);
	assert.equal(browser.find((item) => item.className === 'error').length, 0);
	assert.match(browser.element('dashboardFreshness').text, /not current status.*preferences are unchanged/u);
	assert.equal(browser.element('dashboardFreshness').attributes.role, 'status');
	browser.button('Devices & permissions').click();
	for (const key of ['rename-device', 'rename-window', 'switch-account', 'connect-disable', 'remote-refresh', 'register-workspace', 'revoke-manage-device-1']) {
		assert.equal(browser.control(key).disabled, true, key);
	}
	assert.equal(browser.control('advanced-settings').disabled, false);
	assert.equal(browser.control('refresh').disabled, false);
	browser.button('Task history').click();
	assert.match(browser.element('historyTasks').text, /Task 00000002/u);
	browser.button('Overview').click();
	const recovered = model();
	recovered.deviceTree[1].nodes[0].workspaces[0].name = 'Recovered root';
	browser.render(recovered, ['switchAccount']);
	assert.equal(browser.find((item) => item.id === 'dashboardFreshness').length, 0);
	assert.equal(browser.find((item) => item.className === 'error').length, 0);
	assert.match(browser.element('deviceTree').text, /Recovered root/u);
	assert.equal(browser.control('delegate-tree-7').disabled, false);
	assert.equal(browser.control('cancel-incoming-00000004').disabled, false, 'A fresh model permits cancellation during native prompts.');
	browser.control('delegate-tree-7').click();
	assert.deepEqual(browser.messages.at(-1), {
		version: 11, uiInstanceId: 'media-view', type: 'action', action: 'openTargetChat', actionHandle: handle('C'),
	});
});

test('repeated brief refreshes never insert a banner or replace the visible last-known rows', () => {
	for (const language of ['en', 'zh'] as const) {
		const browser = createDashboardBrowserHarness(language);
		const data = model();
		browser.render(data);
		for (let index = 0; index < 20; index++) {
			const tree = browser.element('deviceTree');
			const refreshing = {
				...data, errors: [{ code: 'DASHBOARD_REFRESHING', message: 'DASHBOARD_REFRESHING' }],
			};
			browser.render(refreshing);
			assert.equal(browser.element('deviceTree'), tree, 'A control-plane refresh marker must not rebuild visible rows.');
			assert.equal(browser.find((item) => item.id === 'dashboardFreshness').length, 0);
			assert.doesNotMatch(browser.element('pageContent').text, /Updating live status|正在刷新实时状态/u);
			assert.equal(browser.control('delegate-tree-7').disabled, true, 'Silent display is not stale-action authorization.');
			browser.render(data);
			assert.equal(browser.find((item) => item.id === 'dashboardFreshness').length, 0);
			assert.equal(browser.control('delegate-tree-7').disabled, false);
		}
	}
});

test('a quiet refresh marker does not hide a new genuine error', () => {
	const browser = createDashboardBrowserHarness();
	const data = model();
	browser.render(data);
	browser.render({
		...data, errors: [
			{ code: 'AUTH_REQUIRED', message: 'Authentication is required.' },
			{ code: 'DASHBOARD_REFRESHING', message: 'DASHBOARD_REFRESHING' },
		],
	});
	assert.equal(browser.find((item) => item.id === 'dashboardFreshness').length, 0);
	assert.match(browser.element('pageContent').text, /AUTH_REQUIRED/u);
	assert.equal(browser.control('delegate-tree-7').disabled, true);
});

test('localized reconnecting notices preserve an explicitly disabled preference too', () => {
	const browser = createDashboardBrowserHarness('zh-CN');
	const data = model();
	data.connectivity.enabled = false;
	data.connectivity.connectionState = 'disabled';
	browser.render({ ...data, errors: [{ code: 'DASHBOARD_RECONNECTING', message: 'DASHBOARD_RECONNECTING' }] });
	assert.match(browser.element('dashboardFreshness').text, /重新连接本机 Broker.*并非实时状态.*连接设置未更改/u);
	assert.doesNotMatch(browser.element('dashboardFreshness').text, /DASHBOARD_RECONNECTING/u);
	assert.match(browser.element('connectivity').text, /已关闭/u);
	assert.equal(browser.control('connect-enable').disabled, true);
	assert.equal(browser.find((item) => item.className === 'error').length, 0);
	browser.render(data);
	assert.equal(browser.control('connect-enable').disabled, false);
});

test('a connecting view never renders unread fallback preferences or rows', () => {
	for (const language of ['en', 'zh-CN']) {
		const browser = createDashboardBrowserHarness(language);
		browser.render({
			...model(), errors: [{ code: 'DASHBOARD_CONNECTING', message: 'DASHBOARD_CONNECTING' }],
		});
		const text = browser.element('pageContent').text;
		assert.match(text, language === 'en' ? /have not been read/u : /尚未读取到/u);
		assert.doesNotMatch(text, /Remote root|Same name|Task 00000001|Online 1 connected|连接已关闭/u);
		assert.equal(browser.find((item) => item.className === 'error').length, 0);
		assert.equal(browser.find((item) => item.id === 'deviceTree' || item.id === 'connectivity').length, 0);
		assert.equal(browser.control('refresh').disabled, false);
		browser.control('refresh').click();
		assert.equal(browser.messages.at(-1)?.action, 'refresh');
	}
});

test('reconnecting retains real faults and rejected service data stays a failure until fresh recovery', () => {
	const browser = createDashboardBrowserHarness();
	browser.render({
		...model(), errors: [
			{ code: 'DASHBOARD_RECONNECTING', message: 'DASHBOARD_RECONNECTING' },
			{ code: 'CONFIGURATION_INVALID', message: 'The configured listener port is invalid.' },
		],
		connectivity: { ...model().connectivity, error: 'ACCOUNT_CHANGED' },
	});
	assert.match(browser.element('pageContent').text, /CONFIGURATION_INVALID/u);
	assert.match(browser.element('pageContent').text, /ACCOUNT_CHANGED/u);
	browser.send({
		version: 11, uiInstanceId: 'media-view', type: 'dashboard.error',
		code: 'UNSAFE_VIEW_MODEL', message: 'The dashboard rejected an invalid service snapshot.',
	});
	assert.equal(browser.find((item) => item.id === 'dashboardFreshness' || item.id === 'deviceTree').length, 0);
	assert.match(browser.element('pageContent').text, /UNSAFE_VIEW_MODEL/u);
	assert.equal(browser.control('refresh').disabled, false);
	browser.button('Dismiss error').click();
	assert.match(browser.element('pageContent').text, /Dashboard data is unavailable/u);
	browser.render(model());
	assert.equal(browser.find((item) => item.className === 'error').length, 0);
	assert.equal(browser.control('delegate-tree-7').disabled, false);
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
	browser.send({ version: 11, uiInstanceId: 'media-view', type: 'dashboard.error', code: 'ACTION_FAILED', message: 'Device probe was rejected.' });
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
