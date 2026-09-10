(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const uiInstanceId = document.body.dataset.uiInstanceId;
	const version = 10;
	const language = /^zh(?:-|$)/i.test(document.body.dataset.language || '') ? 'zh' : 'en';
	const dictionary = window.dashboardL10n?.[language] || {};
	const t = (key, ...values) => (dictionary[key] || key).replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
	const terminalStates = new Set(['completed', 'failed', 'cancelled', 'timedOut']);
	const taskStates = ['accepted', 'startingAgent', 'running', 'needsInput', 'recovering', 'cancelling', ...terminalStates];
	const managementActions = [
		'switchAccount', 'probeDevice', 'revokeDevice', 'deleteSavedDevice', 'setWorkspaceReceiving',
		'setIncomingDeviceGrant', 'setDeviceAutoAccept', 'setTargetAllowed', 'setWindowTargetAllowed',
		'setWorkspaceEnabled', 'removeManagedWorkspace',
	];
	const connectivityActions = [
		'enableConnectivity', 'disableConnectivity', 'configureConnectivity', 'refreshDiscovery',
		'pairDiscoveredPeer', 'configureRemotePolicy', 'revokeIncomingPeer',
		'retryConnectivityCleanup', 'refreshRemoteTargets',
	];
	const remotePolicyActions = ['setRemoteAutoAccept', 'setRemoteReceive', 'setRemoteAllowed'];
	const promptActions = new Set([...connectivityActions, ...remotePolicyActions, ...managementActions, 'registerWorkspace']
		.filter((action) => action !== 'disableConnectivity'));
	const dashboardActions = new Set([
		...connectivityActions, ...remotePolicyActions, ...managementActions, 'openAdvancedSettings', 'registerWorkspace',
		'configureDevice', 'renameWindow', 'startListener', 'stopListener', 'copyConnectionUrl',
		'setAcceptIncoming', 'setPeerAllowed', 'openTargetChat', 'cancelOutgoingTask', 'cancelIncomingTask', 'refresh',
	]);
	const booleanActions = new Set([
		'setWorkspaceReceiving', 'setIncomingDeviceGrant', 'setDeviceAutoAccept', 'setTargetAllowed',
		'setWindowTargetAllowed', 'setWorkspaceEnabled', 'setAcceptIncoming', 'setPeerAllowed', ...remotePolicyActions,
	]);
	const handleActions = new Set([
		...managementActions, ...remotePolicyActions, 'setAcceptIncoming', 'setPeerAllowed', 'openTargetChat',
		'cancelOutgoingTask', 'cancelIncomingTask', 'pairDiscoveredPeer', 'revokeIncomingPeer',
	]);
	const controls = new Map();
	const focusTargets = new Map();
	const encoder = new TextEncoder();
	const state = {
		model: undefined, pendingActions: new Set(), actionFailure: undefined, page: 'overview',
		permissionKey: undefined, treeKey: undefined, sourceKey: undefined, back: [], disclosures: new Map(),
		sourceInitialized: false,
		historyStatus: 'all', historyDirection: 'all', helpKey: undefined, helpFocus: undefined,
	};
	const refreshButton = document.getElementById('refreshButton');
	const navigation = document.getElementById('primaryNav');
	const scroll = document.getElementById('pageScroll');
	const content = document.getElementById('pageContent');
	const popover = document.getElementById('helpPopover');

	refreshButton.textContent = t('Refresh local');
	refreshButton.addEventListener('click', () => postAction('refresh'));
	for (const button of navigation.children) {
		button.textContent = t({ overview: 'Overview', history: 'Task history', access: 'Devices & permissions' }[button.dataset.route]);
		button.addEventListener('click', () => navigate(button.dataset.route));
	}
	window.addEventListener('message', (event) => {
		const message = event.data;
		try {
			if (!isOutboundMessage(message) || message.uiInstanceId !== uiInstanceId) { return; }
		} catch { return; }
		state.pendingActions = new Set(message.pendingActions || []);
		if (message.type === 'dashboard.error') {
			state.actionFailure = { code: message.code, message: message.message };
		} else {
			state.model = message.model;
		}
		render();
	});
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && !popover.hidden) {
			event.preventDefault();
			closeHelp(true);
		}
	});
	vscode.postMessage({ version, uiInstanceId, type: 'ready' });

	function render(options = {}) {
		const focused = options.focusKey || document.activeElement?.dataset?.focusKey;
		const position = options.scrollTop ?? scroll.scrollTop;
		controls.clear();
		focusTargets.clear();
		registerControl(refreshButton, 'refresh', false, 'refresh');
		for (const button of navigation.children) {
			const activePage = ['saved', 'permissions'].includes(state.page) ? 'access' : state.page;
			if (button.dataset.route === activePage) { button.setAttribute('aria-current', 'page'); }
			else { button.removeAttribute('aria-current'); }
		}
		content.replaceChildren();
		if (state.actionFailure) {
			const banner = renderError(state.actionFailure);
			banner.append(button('Dismiss error', () => { state.actionFailure = undefined; render(); }, 'dismiss-error'));
			content.append(banner);
		}
		const model = state.model;
		if (!model) {
			content.append(tr('p', 'Loading…', 'empty'));
			updateControls();
			return;
		}
		renderOperationalErrors(model);
		if (state.page === 'overview') { renderOverview(model); }
		else if (state.page === 'history') { renderHistory(model); }
		else if (state.page === 'access') { renderAccess(model); }
		else if (state.page === 'saved') { renderSaved(model); }
		else { renderPermissions(model); }
		updateControls();
		scroll.scrollTop = position;
		if (options.heading) {
			focusTargets.get('page-heading')?.focus({ preventScroll: true });
		} else if (focused) {
			focusTargets.get(focused)?.focus({ preventScroll: true });
		}
		if (state.helpKey) { renderHelp(); }
	}

	function navigate(page, selection) {
		closeHelp(false);
		if (selection || page === 'saved') {
			state.back.push({
				page: state.page, permissionKey: state.permissionKey, treeKey: state.treeKey, sourceKey: state.sourceKey,
				sourceInitialized: state.sourceInitialized,
				scrollTop: scroll.scrollTop, focusKey: document.activeElement?.dataset?.focusKey,
			});
		} else { state.back = []; }
		state.page = page;
		state.permissionKey = selection?.permissionKey;
		state.treeKey = selection?.treeKey;
		if (selection?.sourceKey) { state.sourceKey = selection.sourceKey; state.sourceInitialized = true; }
		render({ heading: true, scrollTop: 0 });
	}

	function goBack() {
		const previous = state.back.pop();
		if (!previous) { navigate('access'); return; }
		Object.assign(state, {
			page: previous.page, permissionKey: previous.permissionKey, treeKey: previous.treeKey, sourceKey: previous.sourceKey,
			sourceInitialized: previous.sourceInitialized,
		});
		closeHelp(false);
		render({ focusKey: previous.focusKey, scrollTop: previous.scrollTop });
	}

	function pageHeading(key, helpKey) {
		const row = el('div', undefined, 'pageHeading');
		const heading = tr('h2', key);
		heading.tabIndex = -1;
		focusable(heading, 'page-heading');
		row.append(heading);
		if (helpKey) { row.append(helpButton(key, helpKey)); }
		content.append(row);
	}

	function renderOperationalErrors(model) {
		for (const error of model.errors) { content.append(renderError(error)); }
		if (model.broker.error && !model.errors.some((error) => error.code === model.broker.error.code)) {
			content.append(renderError(model.broker.error));
		}
		for (const [name, component] of Object.entries({
			Gateway: model.listener.gateway, Tunnel: model.listener.tunnel, 'Agent Host': model.listener.agentHost,
		})) {
			if (component.state === 'error') {
				content.append(notice(t('{0}: {1}', t(name), diagnosticText(component.detail || component.label)), true));
				if (component.action) { content.append(notice(diagnosticText(component.action))); }
			}
		}
		if (model.thisWindow.agentHost.degraded) {
			content.append(notice(diagnosticText(model.thisWindow.agentHost.reason || model.thisWindow.agentHost.detail || 'Agent Host is unavailable.')));
			if (model.thisWindow.agentHost.reason && model.thisWindow.agentHost.detail) {
				content.append(notice(diagnosticText(model.thisWindow.agentHost.detail)));
			}
		}
		if (model.management.truncated) { content.append(notice(t('Management results reached the safe display limit. Refresh or open advanced settings; hidden entries are not granted access.'))); }
		if (model.connectivity.truncated) { content.append(notice(t('Discovery results reached the safe display limit. Refresh remote devices to retry.'))); }
	}

	function renderOverview(model) {
		pageHeading('Overview', 'overviewHelp');
		content.append(renderConnectivity(model, true));
		const targets = section('Devices and workspaces');
		targets.id = 'deviceTree';
		const devices = model.deviceTree.filter((device) => device.locality === 'local'
			|| (model.connectivity.connectionState === 'online' && ['online', 'busy'].includes(device.state)));
		for (const device of devices) {
			const local = device.locality === 'local';
			const branch = disclosure(device.name, `device-${device.key}`, true, 'device', false);
			const summary = branch.children[0];
			summary.replaceChildren();
			const line = el('span', undefined, 'summaryLine');
			line.append(el('strong', device.name), badge(local ? t('This device') : stateLabel(device.state)));
			summary.append(line);
			for (const node of device.nodes) {
				if (!local && !['online', 'busy'].includes(node.status)) { continue; }
				const windowRow = el('div', undefined, 'window');
				windowRow.append(el('h4', node.label), el('p', t('{0} · {1}', node.thisWindow ? t('This window') : t('Window'), stateLabel(node.status)), 'meta'));
				for (const workspace of node.workspaces) {
					const target = el('article', undefined, 'workspace');
					target.dataset.workspaceKey = workspace.key;
					const top = el('div', undefined, 'itemHeading workspaceHeading');
					top.append(el('strong', workspace.name, 'grow'));
					if (workspace.claimStatus !== 'claimed') { top.append(badge(stateLabel(workspace.claimStatus), true)); }
					if (workspace.busy) { top.append(badge(t('Busy'), true)); }
					top.append(button('Permissions', () => navigate('permissions', {
						permissionKey: workspace.permissionKey, treeKey: workspace.key,
					}), `permission-${workspace.key}`, 'workspacePermissions'));
					target.append(top);
					if (workspace.gateState !== 'allowed' && workspace.gateState !== 'self') {
						target.append(el('p', gateReason(workspace.gateState), 'warning'));
					}
					if (!workspace.enabled) { target.append(notice(t('This workspace is disabled. Enable it in its permissions page.'))); }
					if (!node.thisWindow) {
						target.append(actionRow(actionButton('Delegate in Chat', 'openTargetChat',
							{ actionHandle: workspace.delegateActionHandle }, !workspace.canDelegate,
							`delegate-${workspace.key}`, false, true)));
						if (!workspace.canDelegate && workspace.gateState === 'allowed') {
							target.append(notice(workspace.busy ? t('Target is busy. Wait for its task to finish.') : t('Delegation is unavailable for this workspace.')));
						}
					}
					windowRow.append(target);
				}
				if (node.workspaces.length === 0) { windowRow.append(tr('p', 'No registered workspaces in this window.', 'empty')); }
				branch.append(windowRow);
			}
			if (!local && model.management.devices.some((item) => item.key === device.managementKey && item.cleanupPending)) {
				branch.append(notice(t('Access cleanup is pending. Retry Tunnel cleanup to finish withdrawing access.')));
			}
			targets.append(branch);
		}
		if (!devices.some((device) => device.locality === 'local')) {
			const local = item(model.device.name, t('This device'));
			local.append(el('p', t('{0} · {1}', model.thisWindow.name, model.thisWindow.workspaceName), 'meta'));
			local.append(tr('p', 'Workspace details are unavailable. Refresh local status.', 'empty'));
			targets.append(local);
		}
		if (!devices.some((device) => device.locality === 'remote')) {
			targets.append(tr('p', 'No confirmed online remote devices. Offline and cached devices are in Saved devices.', 'empty'));
		}
		targets.append(button('Saved devices', () => navigate('saved'), 'overview-saved'));
		content.append(targets);
		const tasks = section('Active tasks', 'tasksHelp');
		tasks.id = 'activeTasks';
		const active = allTasks(model).filter((task) => !terminalStates.has(task.state));
		appendItems(tasks, active, renderTask, 'No active tasks.');
		content.append(tasks);
	}

	function renderConnectivity(model, compact = false) {
		const value = model.connectivity;
		const root = el('section', undefined, compact ? 'connection compactConnection' : 'connection');
		root.id = 'connectivity';
		root.setAttribute('aria-label', t('Cross-device connections'));
		if (compact) {
			const summary = el('div', undefined, 'connectionSummary');
			summary.append(tr('strong', 'Cross-device connections', 'connectionLabel'), badge(connectionLabel(value.connectionState)),
				el('span', t('{0} connected', value.connectedDeviceCount), 'detail grow'),
				button('Manage', () => navigate('access'), 'connect-manage', 'link'));
			root.append(summary);
		} else {
			const heading = el('div', undefined, 'itemHeading');
			heading.append(tr('strong', 'Cross-device connections'), badge(connectionLabel(value.connectionState)),
				helpButton('Cross-device connections', 'connectionsHelp'));
			root.append(heading);
			if (value.accountLabel) { root.append(property('Account', value.accountLabel)); }
			else { root.append(property('Account', { none: t('Choose when enabling'), github: 'GitHub', microsoft: 'Microsoft' }[value.accountProvider])); }
			root.append(property('Connected devices', String(value.connectedDeviceCount)));
		}
		if (value.error) { root.append(renderError({ code: value.error, message: diagnosticText(value.error) })); }
		if (!model.device.workerSupported) { root.append(notice(diagnosticText('PLATFORM_UNSUPPORTED'))); }
		const available = !model.errors.some((error) => ['CONNECTIVITY_UNAVAILABLE', 'DASHBOARD_SERVICES_UNAVAILABLE'].includes(error.code));
		const starting = ['authenticating', 'starting'].includes(value.connectionState) || state.pendingActions.has('enableConnectivity');
		const actions = actionRow();
		if (!starting && !['online', 'stopping'].includes(value.connectionState)) {
			actions.append(actionButton(value.connectionState === 'authRequired' ? 'Sign in and connect' : 'Enable cross-device connections',
				'enableConnectivity', undefined, !available || !model.device.workerSupported, 'connect-enable', false, true));
		}
		if ((value.enabled || starting || value.connectionState === 'online')
			&& (!compact || starting || value.connectionState !== 'online' || state.pendingActions.size > 0 || value.error)) {
			actions.append(actionButton(starting ? 'Cancel connection startup' : 'Disable cross-device connections',
				'disableConnectivity', undefined, !available || value.connectionState === 'stopping', 'connect-disable', true));
		}
		const cleanup = value.connectionState === 'cleanupPending' || value.migrationPending
			|| value.error === 'CLEANUP_FAILED' || value.incomingPeers.some((peer) => peer.cleanupPending);
		if (cleanup) {
			root.append(notice(t('Connections are stopped or being cleaned up. Use the account that owns the Tunnel to finish cleanup. Saved permissions are not broadened.')));
			actions.append(actionButton('Retry Tunnel cleanup', 'retryConnectivityCleanup', undefined, !available, 'cleanup-retry'));
		}
		if (!compact) {
			actions.append(actionButton('Refresh remote devices', 'refreshRemoteTargets', undefined,
				!available || !value.enabled || value.connectionState !== 'online', 'remote-refresh'));
		}
		if (actions.children.length > 0) { root.append(actions); }
		return root;
	}

	function allTasks(model) {
		return [...model.outgoingTasks.map((task) => ({ ...task, direction: 'outgoing' })),
			...model.incomingTasks.map((task) => ({ ...task, direction: 'incoming' }))]
			.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
	}

	function renderHistory(model) {
		pageHeading('Task history', 'historyHelp');
		const filters = el('div', undefined, 'filters');
		filters.append(selectField('Status', 'history-status', [['all', t('All statuses')], ...[...terminalStates].map((value) => [value, stateLabel(value)])],
			state.historyStatus, (value) => { state.historyStatus = value; render(); }));
		filters.append(selectField('Direction', 'history-direction', [['all', t('Both directions')], ['outgoing', t('Outgoing')], ['incoming', t('Incoming')]],
			state.historyDirection, (value) => { state.historyDirection = value; render(); }));
		content.append(filters);
		const tasks = allTasks(model).filter((task) => terminalStates.has(task.state)
			&& (state.historyStatus === 'all' || state.historyStatus === task.state)
			&& (state.historyDirection === 'all' || state.historyDirection === task.direction));
		const list = el('section');
		list.id = 'historyTasks';
		list.append(el('p', t('{0} records · Recent first', tasks.length), 'count'));
		appendItems(list, tasks, renderTask, 'No task history matches these filters.');
		content.append(list);
	}

	function renderTask(task) {
		const root = item(task.title, stateLabel(task.state), ['needsInput', 'recovering', 'cancelling'].includes(task.state));
		root.dataset.taskId = `${task.direction}-${task.shortId}`;
		root.append(el('p', t('{0} · {1}: {2} · {3}', t(task.direction === 'outgoing' ? 'Outgoing' : 'Incoming'),
			t(task.direction === 'outgoing' ? 'Target' : 'Source'), task.counterpartLabel, task.workspaceName), 'meta'));
		root.append(el('p', formatTimestamp(task.startedAt), 'meta'));
		if (task.state === 'needsInput') { root.append(notice(t('Input is required from the task owner. Continue in the originating Chat.'))); }
		if (task.state === 'recovering') { root.append(notice(t('Recovering task status. Losing a connection does not mean this task has finished.'))); }
		if (task.state === 'cancelling') { root.append(notice(t('Cancellation was requested. The task remains active until termination is confirmed.'))); }
		const details = disclosure('Task details', `task-${task.direction}-${task.shortId}`);
		details.append(property('Task ID', task.shortId), property('Workspace', task.workspaceName));
		if (task.canCancel && !terminalStates.has(task.state)) {
			details.append(actionButton('Cancel task', task.direction === 'outgoing' ? 'cancelOutgoingTask' : 'cancelIncomingTask',
				{ actionHandle: task.actionHandle }, false, `cancel-${task.direction}-${task.shortId}`, true));
		}
		root.append(details);
		return root;
	}

	function renderAccess(model) {
		pageHeading('Devices & permissions', 'permissionsHelp');
		content.append(renderConnectivity(model));
		const device = section('This device');
		const editName = actionButton('Edit device name', 'configureDevice', undefined, false, 'rename-device');
		editName.className = 'fieldEdit';
		editName.setAttribute('aria-label', t('Edit device name'));
		editName.title = t('Edit device name');
		editName.textContent = '✎';
		device.append(property('Device name', model.device.name, editName), property('This window', model.thisWindow.name),
			property('Current workspace', model.thisWindow.workspaceName));
		device.append(actionRow(
			actionButton('Rename this window', 'renameWindow', undefined, !model.thisWindow.canRename, 'rename-window'),
			actionButton('Switch account', 'switchAccount', { actionHandle: model.management.accountActionHandle },
				false, 'switch-account'),
		));
		if (!model.management.accountActionHandle) { device.append(tr('p', 'Account changes are unavailable. Enable connections or refresh status.', 'detail')); }
		if (model.thisWindow.detail) { device.append(notice(diagnosticText(model.thisWindow.detail))); }
		content.append(device);
		const workspaces = section('Registered workspaces');
		workspaces.id = 'managementWorkspaces';
		if (!model.management.available) { workspaces.append(notice(t('Device and workspace management is unavailable. Refresh to retry.'))); }
		appendItems(workspaces, model.management.workspaces, (workspace) => {
			const root = item(workspace.name, workspace.enabled ? t('Enabled') : t('Disabled'));
			root.append(button('Permissions', () => navigate('permissions', { permissionKey: workspace.key }), `manage-${workspace.key}`));
			return root;
		}, 'No registered workspaces.');
		workspaces.append(actionButton('Register current workspace', 'registerWorkspace', undefined, !model.management.available, 'register-workspace'));
		content.append(workspaces);
		const devices = section('Trusted devices');
		appendItems(devices, model.management.devices.filter((device) => ['online', 'busy', 'connecting'].includes(device.state)), (device) => {
			const root = item(device.name, stateLabel(device.state));
			root.append(renderDeviceActions(device, true));
			return root;
		}, 'No online trusted devices.');
		devices.append(button('Saved devices', () => navigate('saved'), 'access-saved'));
		content.append(devices, renderDiagnostics(model));
		content.append(actionRow(actionButton('Advanced VS Code settings', 'openAdvancedSettings', undefined, false, 'advanced-settings')));
	}

	function renderSaved(model) {
		content.append(button('Back', goBack, 'back', 'back'));
		pageHeading('Saved devices', 'savedHelp');
		if (!model.management.available) { content.append(notice(t('Device and workspace management is unavailable. Cached permissions below are not evidence of a live connection.'))); }
		const devices = el('section');
		devices.id = 'savedDevices';
		appendItems(devices, model.management.devices.filter((device) =>
			model.connectivity.connectionState !== 'online' || !['online', 'busy'].includes(device.state)), (device) => {
			const cachedOnlineState = model.connectivity.connectionState !== 'online' && ['online', 'busy'].includes(device.state);
			const root = item(device.name, cachedOnlineState ? t('Saved · Connections off') : stateLabel(device.state), device.cleanupPending);
			if (device.lastSeen) { root.append(property('Last seen', formatTimestamp(device.lastSeen))); }
			root.append(property('Active tasks', device.activeTaskCount === undefined ? t('Unknown') : String(device.activeTaskCount)));
			root.append(renderDeviceActions(device, false));
			const blocked = device.deleteBlockedReason || (device.activeTaskCount === undefined
				? 'Task status is unknown. Refresh device diagnostics before deleting.'
				: device.activeTaskCount > 0 ? 'Active tasks block deletion. Cancel them or wait for a terminal outcome.' : undefined);
			if (blocked) { root.append(notice(diagnosticText(blocked))); }
			root.append(tr('p', 'Deleting a saved device revokes trust and permissions. Task history is preserved.', 'warning'));
			root.append(actionButton('Delete saved device', 'deleteSavedDevice', { actionHandle: device.deleteActionHandle },
				Boolean(blocked) || device.activeTaskCount !== 0, `delete-${device.key}`, true));
			if (!blocked && !device.deleteActionHandle) { root.append(tr('p', 'Deletion is unavailable until task status and authority are verified.', 'detail')); }
			return root;
		}, 'No saved devices.');
		content.append(devices);
		const authorizations = section('Offline local authorizations');
		authorizations.id = 'savedAuthorizations';
		appendItems(authorizations, model.savedAuthorizations, (authorization, index) => {
			const root = item(authorization.windowLabel, t('Offline · Saved'));
			root.append(property('Workspace', authorization.workspaceName),
				tr('p', 'This saved local permission is not a live window.', 'detail'),
				actionButton('Remove saved authorization', 'setPeerAllowed',
					{ actionHandle: authorization.actionHandle, enabled: false }, false, `saved-local-${index}`, true));
			return root;
		}, 'No saved offline local authorizations.');
		content.append(authorizations);
		const targets = section('Saved target permissions');
		appendItems(targets, model.management.targets, (target) => {
			const root = item(target.workspaceName, target.online ? t('Online') : t('Offline · Saved'));
			root.append(el('p', t('{0} · {1} · {2}', target.locality === 'local' ? t('Local') : t('Remote'), target.deviceName, target.windowName), 'meta'));
			root.append(button('Permissions', () => navigate('permissions', { permissionKey: target.key }), `saved-target-${target.key}`));
			return root;
		}, 'No saved target permissions.');
		content.append(targets);
	}

	function renderDeviceActions(device, compact) {
		const root = el('div');
		const details = disclosure('Device diagnostics', `diagnostics-${device.key}`);
		details.append(property('Connection state', stateLabel(device.state)),
			property('Active tasks', device.activeTaskCount === undefined ? t('Unknown') : String(device.activeTaskCount)),
			actionButton('Check device', 'probeDevice', { actionHandle: device.probeActionHandle }, false, `probe-${device.key}`));
		if (!device.probeActionHandle) { details.append(tr('p', 'Device diagnostics are unavailable. Refresh remote devices to retry.', 'detail')); }
		root.append(details);
		if (device.cleanupPending) { root.append(notice(t('Access cleanup is pending. Retry Tunnel cleanup to finish withdrawing access.'))); }
		if (!['revoked', 'pending'].includes(device.state)) {
			root.append(actionButton('Revoke trust', 'revokeDevice', { actionHandle: device.revokeActionHandle }, false, `revoke-${device.key}`, true));
			root.append(tr('p', 'Revoking trust disconnects this device and requests cancellation of its active tasks. Confirmation is required.', compact ? 'detail' : 'warning'));
			if (!device.revokeActionHandle) { root.append(tr('p', 'Revocation is unavailable without a current authorized action.', 'detail')); }
		}
		return root;
	}

	function renderPermissions(model) {
		content.append(button('Back', goBack, 'back', 'back'));
		pageHeading('Workspace permissions', 'permissionsHelp');
		const workspace = model.management.workspaces.find((item) => item.key === state.permissionKey);
		const target = model.management.targets.find((item) => item.key === state.permissionKey);
		const treeWorkspace = model.deviceTree.flatMap((device) => device.nodes.flatMap((node) => node.workspaces))
			.find((item) => item.permissionKey === state.permissionKey);
		if (workspace) {
			content.append(el('h3', workspace.name));
			if (treeWorkspace) { content.append(property('Claim status', stateLabel(treeWorkspace.claimStatus))); }
			renderWorkspacePermissions(workspace, model);
		} else if (target) {
			content.append(el('h3', target.workspaceName),
				el('p', t('{0} · {1} · {2}', target.locality === 'local' ? t('Local') : t('Remote'), target.deviceName, target.windowName), 'meta'));
			if (treeWorkspace) { content.append(property('Claim status', stateLabel(treeWorkspace.claimStatus))); }
			renderTargetPermissions(target, model);
		} else {
			const exact = model.deviceTree.flatMap((device) => device.nodes.flatMap((node) => node.workspaces))
				.find((item) => item.key === state.treeKey);
			if (exact) { content.append(el('h3', exact.name)); }
			content.append(notice(t('Permissions for this exact workspace are unavailable or stale. Refresh; no other workspace was selected.')));
		}
	}

	function renderWorkspacePermissions(workspace, model) {
		const settings = section('Workspace registration');
		settings.append(toggle('Enable workspace', workspace.enabled, 'setWorkspaceEnabled', workspace.enableActionHandle,
			`enabled-${workspace.key}`));
		settings.append(tr('p', 'Disabling a workspace is separate from its incoming permission. Removal disables its registration without deleting files, permissions or task history.', 'detail'));
		settings.append(actionButton('Remove workspace', 'removeManagedWorkspace', { actionHandle: workspace.removeActionHandle },
			false, `remove-${workspace.key}`, true));
		if (!workspace.removeActionHandle) { settings.append(tr('p', 'Workspace removal is unavailable without a current authorized action.', 'detail')); }
		content.append(settings);
		const incoming = section('Incoming tasks', 'incomingHelp');
		incoming.append(toggle('Receive incoming tasks', workspace.acceptsIncoming, 'setWorkspaceReceiving', workspace.receiveActionHandle,
			`receiving-${workspace.key}`));
		appendItems(incoming, workspace.incomingPeers, (peer) => {
			const root = item(peer.name);
			root.append(toggle('Allow incoming tasks from this device', peer.allowed, 'setIncomingDeviceGrant',
				peer.allowActionHandle, `incoming-${workspace.key}-${peer.key}`));
			root.append(toggle('Start automatically without asking', peer.autoAccept, 'setDeviceAutoAccept',
				peer.autoAcceptActionHandle, `autoaccept-${workspace.key}-${peer.key}`));
			if (peer.autoAccept) { root.append(notice(t('Allowed tasks can start automatically. Sensitive operations still require confirmation.'))); }
			return root;
		}, 'No incoming devices. Enable connections on both devices using the same account.');
		incoming.append(tr('p', 'Incoming permission and automatic start are independent. Ask before starting is the default.', 'detail'));
		content.append(incoming);
		const outgoing = section('Outgoing targets', 'outgoingHelp');
		outgoing.append(el('p', t('Source workspace: {0}', workspace.name), 'meta'));
		appendItems(outgoing, model.management.targets, (target) => {
			const root = item(target.workspaceName, target.online ? t('Online') : t('Offline · Saved'));
			root.append(el('p', t('{0} · {1} · {2}', target.locality === 'local' ? t('Local') : t('Remote'), target.deviceName, target.windowName), 'meta'));
			root.append(targetToggle(target, workspace.key));
			root.append(button('Target permissions', () => navigate('permissions', { permissionKey: target.key, sourceKey: workspace.key }),
				`target-permissions-${target.key}`));
			return root;
		}, 'No known target workspaces.');
		content.append(outgoing);
	}

	function renderTargetPermissions(target, model) {
		if (!target.online) { content.append(notice(t('This target is offline or cached. Saved permission does not mean it can run tasks.'))); }
		const sources = model.management.workspaces;
		if (!state.sourceInitialized) {
			const currentKeys = model.deviceTree.flatMap((device) => device.nodes.filter((node) => node.thisWindow)
				.flatMap((node) => node.workspaces.map((workspace) => workspace.permissionKey)));
			const current = sources.filter((source) => currentKeys.includes(source.key));
			state.sourceKey = current.length === 1 ? current[0].key : sources.length === 1 ? sources[0].key : undefined;
			state.sourceInitialized = true;
		}
		const selectedSource = sources.some((workspace) => workspace.key === state.sourceKey) ? state.sourceKey : undefined;
		const scope = el('div', undefined, 'scope');
		scope.append(selectField('Source workspace', 'source-workspace',
			[['', t('Select a source workspace')], ...sources.map((workspace) => [workspace.key, workspace.name])],
			selectedSource || '', (value) => { state.sourceKey = value || undefined; state.sourceInitialized = true; render(); }));
		if (state.sourceKey && !selectedSource) {
			scope.append(notice(t('The selected source workspace is no longer available. Select a source explicitly; no replacement was chosen.')));
		}
		scope.append(targetToggle(target, selectedSource));
		scope.append(tr('p', 'Only the selected source workspace is changed. Target receiving permission is controlled on the target device.', 'detail'));
		if (target.locality === 'remote' && target.sources.length > 1 && target.allSourcesAllowed !== 'all') {
			scope.append(notice(t('This window can send remote tasks only after every source workspace allows this target. Authorize each source or use the explicit apply-to-all action.')));
		}
		content.append(scope);
		const bulk = disclosure('Apply to all workspaces in this window', `bulk-${target.key}`);
		bulk.append(tr('p', 'This changes outgoing permission for every listed source workspace. The extension will confirm the affected roots.', 'warning'));
		const list = el('ul');
		for (const source of sources) { list.append(el('li', source.name)); }
		bulk.append(list, property('Current access', stateLabel(target.allSourcesAllowed)));
		if (!target.online) {
			bulk.append(notice(t('Offline targets only support removing existing access. Reconnect before allowing new access.')));
		}
		bulk.append(actionRow(
			actionButton('Allow all listed workspaces', 'setWindowTargetAllowed',
				{ actionHandle: target.allSourcesActionHandle, enabled: true }, sources.length === 0 || !target.online, `allow-all-${target.key}`, true),
			actionButton('Remove access for all listed workspaces', 'setWindowTargetAllowed',
				{ actionHandle: target.allSourcesActionHandle, enabled: false }, sources.length === 0, `deny-all-${target.key}`, true),
		));
		if (!target.allSourcesActionHandle) { bulk.append(tr('p', 'Bulk changes are unavailable without verified authority for every affected workspace.', 'detail')); }
		content.append(bulk);
	}

	function targetToggle(target, sourceKey) {
		const source = target.sources.find((item) => item.sourceKey === sourceKey);
		const offlineWithoutAccess = !target.online && !source?.allowed;
		return toggle('Allow this target', source?.allowed || false, 'setTargetAllowed', source?.actionHandle,
			`target-${target.key}-${sourceKey || 'none'}`, !source
				? 'Select an authorized source workspace to change this permission.'
				: offlineWithoutAccess ? 'Offline targets only support removing existing access. Reconnect before allowing new access.' : undefined,
			offlineWithoutAccess);
	}

	function renderDiagnostics(model) {
		const root = disclosure('Diagnostics', 'diagnostics');
		root.id = 'diagnostics';
		const host = model.thisWindow.agentHost;
		root.append(property('Platform', `${model.device.platform} ${model.device.architecture}`),
			property('VS Code version', model.device.vscodeVersion), property('Extension version', model.device.extensionVersion),
			property('Agent Host source', stateLabel(host.source)), property('Agent Host', diagnosticText(host.label)));
		if (host.reason) { root.append(notice(diagnosticText(host.reason))); }
		if (host.detail) { root.append(el('p', diagnosticText(host.detail), 'detail')); }
		const listener = section('Transport diagnostics');
		listener.id = 'listener';
		listener.append(property('Listener', stateLabel(model.listener.state)), property('Broker', stateLabel(model.broker.state)),
			property('Broker role', stateLabel(model.broker.role)), property('Broker holder', stateLabel(model.broker.holder)),
			property('Broker takeover', stateLabel(model.broker.takeover)));
		for (const [name, component] of Object.entries({ Gateway: model.listener.gateway, Tunnel: model.listener.tunnel, 'Agent Host': model.listener.agentHost })) {
			listener.append(property(name, stateLabel(component.state)));
			if (component.detail) { listener.append(el('p', diagnosticText(component.detail), 'detail')); }
			if (component.action) { listener.append(el('p', diagnosticText(component.action), 'warning')); }
		}
		root.append(listener);
		const connectivity = model.connectivity;
		root.append(property('Hosting backend', connectivity.hostingBackend.toUpperCase()),
			property('Discovery', stateLabel(connectivity.state)),
			property('Publishing', connectivity.publishEnabled ? t('Enabled') : t('Disabled')),
			property('Delegation', connectivity.delegationEnabled ? t('Enabled') : t('Disabled')),
			property('Strict policy', connectivity.strictPolicyActivated ? t('Enabled') : t('Disabled')),
			property('Claimed workspaces', String(connectivity.claimedWorkspaceCount)),
			property('Receiving workspaces', String(connectivity.receivingWorkspaceCount)));
		const candidates = section('Discovery candidates — not workers');
		candidates.id = 'discoveryCandidates';
		appendItems(candidates, connectivity.candidates, (candidate) => {
			const row = item(t('Candidate {0}', candidate.label.replace(/^Candidate /, '')), candidate.stale ? t('Stale candidate') : t('Candidate'));
			row.append(property('Host hint', stateLabel(candidate.hostHint)), tr('p',
				candidate.admission === 'private-port-token'
					? 'Private-port access and Mesh authentication are both required.'
					: 'Legacy outer port is anonymous; Mesh authentication is still required.', candidate.admission === 'private-port-token' ? 'detail' : 'warning'));
			return row;
		}, connectivity.discoveryEnabled ? 'No discovery candidates.' : 'Device discovery is disabled.');
		root.append(candidates);
		const peers = section('Incoming peer admission');
		peers.id = 'incomingPeers';
		appendItems(peers, connectivity.incomingPeers, (peer, index) => {
			const row = item(t('Peer {0}', peer.label.replace(/^Peer /, '')), stateLabel(peer.state));
			row.append(property('Admission cleanup', peer.cleanupPending ? t('Pending — retry required') : t('No pending cleanup')));
			if (peer.cleanupPending) { row.append(notice(t('Access cleanup is pending. Retry Tunnel cleanup to finish withdrawing access.'))); }
			if (peer.state !== 'revoked') {
				row.append(actionButton('Revoke incoming peer', 'revokeIncomingPeer', { actionHandle: peer.actionHandle }, false, `revoke-peer-${index}`, true));
			}
			return row;
		}, 'No incoming peers are listed.');
		root.append(peers);
		const local = section('Local route diagnostics');
		appendItems(local, model.localNodes, (node) => {
			const row = item(node.windowLabel, node.online ? t('Online') : t('Offline'));
			row.append(property('Workspace', node.workspaceName), property('Delegation gate', gateReason(node.gateState)));
			return row;
		}, 'No local route candidates.');
		root.append(local);
		return root;
	}

	function toggle(label, checked, action, handle, key, reason, disabled = false) {
		const container = el('div');
		const row = el('label', undefined, 'toggle');
		const checkbox = el('input');
		checkbox.type = 'checkbox';
		checkbox.checked = checked;
		registerControl(checkbox, action, disabled || !isActionHandle(handle), key);
		checkbox.addEventListener('change', () => {
			postAction(action, { actionHandle: handle, enabled: checkbox.checked });
		});
		row.append(checkbox, tr('span', label, 'grow'));
		container.append(row);
		if (disabled || !isActionHandle(handle)) { container.append(tr('p', reason || 'Permission changes are unavailable without a current authorized action.', 'detail')); }
		return container;
	}

	function selectField(label, key, options, selected, onChange) {
		const root = el('label', undefined, 'field');
		root.append(tr('span', label));
		const select = el('select');
		select.setAttribute('aria-label', t(label));
		focusable(select, key);
		for (const [value, text] of options) {
			const option = el('option', text);
			option.value = value;
			select.append(option);
		}
		select.value = selected;
		select.addEventListener('change', () => onChange(select.value));
		root.append(select);
		return root;
	}

	function actionButton(label, action, fields, disabled, key, dangerous, primary) {
		const root = button(label, () => postAction(action, fields), key);
		root.className = primary ? 'primary' : dangerous ? 'danger' : '';
		registerControl(root, action, Boolean(disabled) || (handleActions.has(action) && !isActionHandle(fields?.actionHandle)), key);
		if (handleActions.has(action) && !isActionHandle(fields?.actionHandle)) {
			root.title = t('A current authorized action is required. Refresh to retry.');
		}
		return root;
	}

	function registerControl(control, action, disabled, key) {
		disabled = disabled || (managementActions.includes(action) && !state.model?.management.available);
		controls.set(control, { action, disabled });
		control.disabled = disabled;
		focusable(control, key);
		return control;
	}

	function focusable(element, key) {
		element.dataset.focusKey = key;
		focusTargets.set(key, element);
		return element;
	}

	function updateControls() {
		for (const [control, binding] of controls) {
			control.disabled = binding.disabled || isActionPending(binding.action);
		}
		const pending = state.pendingActions.size > 0;
		document.getElementById('operationStatus').textContent = pending
			? t('Action in progress. Navigation, task cancellation and disconnect remain available.') : '';
	}

	function isActionPending(action) {
		return state.pendingActions.has(action)
			|| (promptActions.has(action) && [...state.pendingActions].some((pending) => promptActions.has(pending)));
	}

	function postAction(action, fields) {
		if (!dashboardActions.has(action) || isActionPending(action)) { return; }
		if (managementActions.includes(action) && !state.model?.management.available) { return; }
		if (handleActions.has(action) !== isActionHandle(fields?.actionHandle)
			|| booleanActions.has(action) !== (typeof fields?.enabled === 'boolean')) { return; }
		state.pendingActions.add(action);
		state.actionFailure = undefined;
		render();
		vscode.postMessage({ version, uiInstanceId, type: 'action', action, ...fields });
	}

	function button(label, onClick, key, className) {
		const root = tr('button', label, className);
		root.type = 'button';
		root.addEventListener('click', onClick);
		focusable(root, key);
		return root;
	}

	function helpButton(title, key) {
		const root = button('Help', () => {
			if (state.helpKey === key) { closeHelp(true); return; }
			state.helpKey = key;
			state.helpFocus = `help-${key}`;
			renderHelp();
			popover.children[0]?.children[1]?.focus();
		}, `help-${key}`, 'helpButton');
		root.textContent = 'ⓘ';
		root.setAttribute('aria-label', t('Help: {0}', t(title)));
		root.setAttribute('aria-haspopup', 'dialog');
		root.setAttribute('aria-controls', 'helpPopover');
		root.setAttribute('aria-expanded', String(state.helpKey === key));
		return root;
	}

	function renderHelp() {
		popover.replaceChildren();
		popover.hidden = false;
		popover.setAttribute('aria-label', t('Help'));
		const heading = el('div', undefined, 'itemHeading');
		heading.append(tr('strong', 'Help'), button('Close help', () => closeHelp(true), 'close-help'));
		popover.append(heading, el('p', t(state.helpKey)));
		focusTargets.get(state.helpFocus)?.setAttribute('aria-expanded', 'true');
	}

	function closeHelp(restore) {
		popover.hidden = true;
		const trigger = focusTargets.get(state.helpFocus);
		trigger?.setAttribute('aria-expanded', 'false');
		state.helpKey = undefined;
		if (restore) { trigger?.focus({ preventScroll: true }); }
	}

	function section(title, helpKey) {
		const root = el('section', undefined, 'section');
		const heading = el('div', undefined, 'sectionHeading');
		heading.append(tr('h3', title));
		if (helpKey) { heading.append(helpButton(title, helpKey)); }
		root.append(heading);
		return root;
	}

	function disclosure(title, key, defaultOpen = false, className, translate = true) {
		const root = el('details', undefined, className);
		root.open = state.disclosures.get(key) ?? defaultOpen;
		const summary = el('summary', translate ? t(title) : title);
		focusable(summary, `disclosure-${key}`);
		root.append(summary);
		root.addEventListener('toggle', () => { state.disclosures.set(key, root.open); });
		return root;
	}

	function item(title, status, attention) {
		const root = el('article', undefined, 'item');
		const heading = el('div', undefined, 'itemHeading');
		heading.append(el('strong', title));
		if (status) { heading.append(badge(status, attention)); }
		root.append(heading);
		return root;
	}
	function badge(text, attention) { return el('span', text, attention ? 'badge attention' : 'badge'); }
	function notice(text, error) { return el('p', text, error ? 'error' : 'warning'); }
	function property(label, value, edit) {
		const row = el('div', undefined, 'propertyRow');
		const text = el('span', value);
		const valueElement = edit ? el('div', undefined, 'editableValue') : text;
		if (edit) { valueElement.append(text, edit); }
		row.append(tr('span', label), valueElement);
		return row;
	}
	function actionRow(...children) { const row = el('div', undefined, 'actions'); row.append(...children); return row; }
	function appendItems(root, items, renderer, empty) {
		if (items.length === 0) { root.append(tr('p', empty, 'empty')); }
		else { items.forEach((value, index) => root.append(renderer(value, index))); }
	}
	function el(tag, text, className) {
		const element = document.createElement(tag);
		if (text !== undefined) { element.textContent = text; }
		if (className) { element.className = className; }
		return element;
	}
	function tr(tag, key, className) { return el(tag, t(key), className); }
	function renderError(error) {
		const root = el('article', undefined, 'error');
		const message = diagnosticText(error.message, error.code);
		root.append(el('strong', error.code), el('p', message));
		if (window.dashboardDiagnostics?.[error.code] && error.message !== window.dashboardDiagnostics[error.code]
			&& diagnosticText(error.message) !== message && error.message !== error.code) {
			root.append(el('p', diagnosticText(error.message), 'detail'));
		}
		if (error.action) { root.append(el('p', diagnosticText(error.action), 'detail')); }
		return root;
	}
	function diagnosticText(value, code) {
		const messages = window.dashboardDiagnostics || {};
		const known = messages[code] || messages[value];
		return t(known || value);
	}
	function formatTimestamp(value) {
		const date = new Date(value);
		return Number.isNaN(date.valueOf()) ? t('Unknown') : date.toLocaleString(language === 'zh' ? 'zh-CN' : 'en');
	}
	function gateReason(value) {
		return t({
			allowed: 'Allowed', notAllowed: 'This source workspace has not allowed this target.',
			notAccepting: 'The target is not receiving tasks. Change receiving permission on the target device.',
			offline: 'The target is offline. Its saved permissions are retained.',
			multiWorkspace: 'The target window has multiple workspaces. Select one claimed workspace.',
			notClaimed: 'The target has no claimed workspace. Register it on the target device.',
			unavailable: 'Delegation authority or runtime status is unavailable. Refresh to retry.',
			self: 'Current workspace',
		}[value] || 'Unavailable');
	}
	function connectionLabel(value) {
		return t({
			disabled: 'Off', authenticating: 'Waiting for account authorization', starting: 'Connecting',
			online: 'Online', stopping: 'Disconnecting', authRequired: 'Sign-in required',
			error: 'Connection needs attention', cleanupPending: 'Offline · Tunnel cleanup pending',
		}[value]);
	}
	function stateLabel(value) {
		return t({
			accepted: 'Accepted', startingAgent: 'Starting agent', running: 'Running', needsInput: 'Needs input',
			recovering: 'Recovering', cancelling: 'Cancelling', completed: 'Completed', failed: 'Failed',
			cancelled: 'Cancelled', timedOut: 'Timed out', connecting: 'Connecting', online: 'Online', busy: 'Busy',
			offline: 'Offline', authFailed: 'Authentication failed', incompatible: 'Incompatible', unknown: 'Unknown / Cached',
			pending: 'Pending', revoked: 'Revoked', active: 'Active', claimed: 'Claimed', readOnly: 'Read-only',
			conflict: 'Conflict', draining: 'Draining', stopped: 'Stopped', starting: 'Starting', stopping: 'Stopping',
			error: 'Error', unavailable: 'Unavailable', ready: 'Ready', contending: 'Contending', takingOver: 'Taking over',
			disposed: 'Disposed', owner: 'Owner', contender: 'Contender', thisWindow: 'This window',
			anotherWindow: 'Another window', none: 'None', all: 'All', some: 'Some', stable: 'Stable', waiting: 'Waiting',
			editor: 'VS Code editor', standalone: 'Standalone', disabled: 'Disabled', authRequired: 'Sign-in required',
			discovering: 'Discovering',
		}[value] || 'Unknown');
	}

	// Validators below mirror the bounded, exact extension-to-webview projection.
	function isOutboundMessage(value) {
		if (!isExactRecord(value, ['version', 'uiInstanceId', 'type'], ['model', 'code', 'message', 'pendingActions'])
			|| value.version !== version || typeof value.uiInstanceId !== 'string'
			|| !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.uiInstanceId)) { return false; }
		if (value.pendingActions !== undefined && (!Array.isArray(value.pendingActions)
			|| value.pendingActions.length > dashboardActions.size
			|| new Set(value.pendingActions).size !== value.pendingActions.length
			|| value.pendingActions.some((action) => !dashboardActions.has(action)))) { return false; }
		if (value.type === 'dashboard.error') {
			return isExactRecord(value, ['version', 'uiInstanceId', 'type', 'code', 'message'], ['pendingActions'])
				&& isText(value.message) && [
					'INVALID_MESSAGE', 'ACTION_FAILED', 'UNSAFE_VIEW_MODEL', 'WINDOW_NAME_CONFLICT', 'WINDOW_NAME_INVALID',
					'PEER_DELEGATION_DISABLED', 'WORKSPACE_SELECTION_AMBIGUOUS', 'POLICY_FORBIDDEN', 'STALE_ACTION', 'TASK_NOT_FOUND',
				].includes(value.code);
		}
		return value.type === 'dashboard.snapshot'
			&& isExactRecord(value, ['version', 'uiInstanceId', 'type', 'model'], ['pendingActions'])
			&& isModel(value.model);
	}

	function isModel(model) {
		if (!isExactRecord(model, ['device', 'listener', 'broker', 'thisWindow', 'connectivity', 'management',
			'deviceTree', 'localNodes', 'savedAuthorizations', 'outgoingTasks', 'incomingTasks', 'errors'])) { return false; }
		const device = model.device;
		const listener = model.listener;
		const broker = model.broker;
		const current = model.thisWindow;
		if (!isExactRecord(device, ['name', 'platform', 'architecture', 'workerSupported', 'vscodeVersion', 'extensionVersion'])
			|| !strings(device, ['name', 'platform', 'architecture', 'vscodeVersion', 'extensionVersion']) || typeof device.workerSupported !== 'boolean'
			|| !isExactRecord(listener, ['state', 'gateway', 'tunnel', 'agentHost', 'canStart', 'canStop', 'canCopyConnectionUrl'])
			|| !['stopped', 'starting', 'running', 'stopping', 'error', 'unavailable'].includes(listener.state)
			|| !booleans(listener, ['canStart', 'canStop', 'canCopyConnectionUrl'])
			|| ![listener.gateway, listener.tunnel, listener.agentHost].every(isComponent)
			|| !isExactRecord(broker, ['state', 'role', 'takeover', 'holder'], ['error'])
			|| !['starting', 'running', 'contending', 'takingOver', 'stopping', 'error', 'disposed'].includes(broker.state)
			|| !['owner', 'contender'].includes(broker.role) || !['stable', 'waiting', 'takingOver', 'stopping', 'error'].includes(broker.takeover)
			|| !['thisWindow', 'anotherWindow', 'none'].includes(broker.holder)
			|| (broker.error !== undefined && !isError(broker.error))
			|| !isExactRecord(current, ['name', 'workspaceName', 'claimStatus', 'previewEnabled', 'canRename', 'acceptsIncoming',
				'canSetAcceptIncoming', 'agentHost'], ['acceptActionHandle', 'detail'])
			|| !strings(current, ['name', 'workspaceName']) || !optionalText(current.detail)
			|| !['claimed', 'readOnly', 'conflict', 'unclaimed', 'ambiguous'].includes(current.claimStatus)
			|| !booleans(current, ['previewEnabled', 'canRename', 'acceptsIncoming', 'canSetAcceptIncoming'])
			|| !actionableHandle(current.canSetAcceptIncoming, current.acceptActionHandle)
			|| !isExactRecord(current.agentHost, ['source', 'label', 'degraded'], ['reason', 'detail'])
			|| !['editor', 'standalone', 'unavailable'].includes(current.agentHost.source)
			|| !isText(current.agentHost.label) || typeof current.agentHost.degraded !== 'boolean'
			|| !optionalText(current.agentHost.detail)
			|| (current.agentHost.reason !== undefined && !['EDITOR_DISCOVERY_FAILED', 'EDITOR_START_FAILED', 'STANDALONE_START_FAILED'].includes(current.agentHost.reason))) { return false; }
		return isConnectivity(model.connectivity) && isManagement(model.management) && isDeviceTree(model.deviceTree)
			&& boundedArray(model.localNodes, 128, (node) =>
				isExactRecord(node, ['windowLabel', 'workspaceName', 'online', 'acceptsIncoming', 'busy', 'allowlisted', 'self',
					'canToggle', 'claimState', 'gateState'], ['actionHandle'])
				&& strings(node, ['windowLabel', 'workspaceName'])
				&& booleans(node, ['online', 'acceptsIncoming', 'busy', 'allowlisted', 'self', 'canToggle'])
				&& ['claimed', 'multiWorkspace', 'unclaimed'].includes(node.claimState)
				&& ['allowed', 'notAllowed', 'notAccepting', 'offline', 'multiWorkspace', 'notClaimed'].includes(node.gateState)
				&& actionableHandle(node.canToggle, node.actionHandle))
			&& boundedArray(model.savedAuthorizations, 32, (item) => isExactRecord(item, ['actionHandle', 'windowLabel', 'workspaceName'])
				&& isActionHandle(item.actionHandle) && strings(item, ['windowLabel', 'workspaceName']))
			&& isTasks(model.outgoingTasks) && isTasks(model.incomingTasks)
			&& boundedArray(model.errors, 100, isError);
	}

	function isManagement(value) {
		if (!isExactRecord(value, ['available', 'truncated', 'devices', 'workspaces', 'targets'], ['accountActionHandle'])
			|| !booleans(value, ['available', 'truncated']) || !optionalHandle(value.accountActionHandle)) { return false; }
		const keys = new Set();
		const remember = (key) => { if (keys.has(key)) { return false; } keys.add(key); return true; };
		return boundedArray(value.devices, 32, (device) =>
			isExactRecord(device, ['key', 'name', 'state', 'cleanupPending'],
				['activeTaskCount', 'deleteBlockedReason', 'lastSeen', 'deleteActionHandle', 'revokeActionHandle', 'probeActionHandle'])
			&& managementKey(device.key, 'device') && remember(device.key) && isTreeLabel(device.name)
			&& ['connecting', 'online', 'busy', 'offline', 'authFailed', 'incompatible', 'unknown', 'pending', 'revoked'].includes(device.state)
			&& typeof device.cleanupPending === 'boolean' && (device.activeTaskCount === undefined || boundedInteger(device.activeTaskCount, Number.MAX_SAFE_INTEGER))
			&& optionalText(device.deleteBlockedReason) && (device.lastSeen === undefined || isTimestamp(device.lastSeen))
			&& ['deleteActionHandle', 'revokeActionHandle', 'probeActionHandle'].every((key) => optionalHandle(device[key]))
			&& (device.deleteActionHandle === undefined || (device.activeTaskCount === 0 && device.deleteBlockedReason === undefined)))
			&& boundedArray(value.workspaces, 32, (workspace) =>
				isExactRecord(workspace, ['key', 'name', 'enabled', 'acceptsIncoming', 'incomingPeers'],
					['receiveActionHandle', 'enableActionHandle', 'removeActionHandle'])
				&& managementKey(workspace.key, 'workspace') && remember(workspace.key) && isTreeLabel(workspace.name)
				&& booleans(workspace, ['enabled', 'acceptsIncoming'])
				&& ['receiveActionHandle', 'enableActionHandle', 'removeActionHandle'].every((key) => optionalHandle(workspace[key]))
				&& boundedArray(workspace.incomingPeers, 32, (peer) =>
					isExactRecord(peer, ['key', 'name', 'allowed', 'autoAccept'], ['allowActionHandle', 'autoAcceptActionHandle'])
					&& managementKey(peer.key, 'peer') && isTreeLabel(peer.name) && booleans(peer, ['allowed', 'autoAccept'])
					&& optionalHandle(peer.allowActionHandle) && optionalHandle(peer.autoAcceptActionHandle))
				&& new Set(workspace.incomingPeers.map((peer) => peer.key)).size === workspace.incomingPeers.length)
			&& boundedArray(value.targets, 128, (target) =>
				isExactRecord(target, ['key', 'deviceName', 'windowName', 'workspaceName', 'locality', 'online', 'sources', 'allSourcesAllowed'],
					['allSourcesActionHandle'])
				&& managementKey(target.key, 'target') && remember(target.key)
				&& ['deviceName', 'windowName', 'workspaceName'].every((key) => isTreeLabel(target[key]))
				&& ['local', 'remote'].includes(target.locality) && typeof target.online === 'boolean'
				&& ['all', 'some', 'none'].includes(target.allSourcesAllowed) && optionalHandle(target.allSourcesActionHandle)
				&& boundedArray(target.sources, 32, (source) =>
					isExactRecord(source, ['sourceKey', 'allowed'], ['actionHandle']) && managementKey(source.sourceKey, 'workspace')
					&& typeof source.allowed === 'boolean' && optionalHandle(source.actionHandle)
					&& value.workspaces.some((workspace) => workspace.key === source.sourceKey))
				&& new Set(target.sources.map((source) => source.sourceKey)).size === target.sources.length);
	}

	function isDeviceTree(value) {
		if (!Array.isArray(value) || value.length > 33 || encoder.encode(JSON.stringify(value)).byteLength > 512 * 1024) { return false; }
		const keys = new Set();
		const remember = (key) => { if (keys.has(key)) { return false; } keys.add(key); return true; };
		return value.every((device) =>
			isExactRecord(device, ['key', 'name', 'locality', 'state', 'nodes'], ['managementKey'])
			&& isTreeKey(device.key) && remember(device.key) && isTreeLabel(device.name)
			&& (device.managementKey === undefined || managementKey(device.managementKey, 'device'))
			&& ['local', 'remote'].includes(device.locality)
			&& ['connecting', 'online', 'busy', 'offline', 'authFailed', 'incompatible', 'unknown'].includes(device.state)
			&& boundedArray(device.nodes, 128, (node) =>
				isExactRecord(node, ['key', 'label', 'thisWindow', 'status', 'workspaces'])
				&& isTreeKey(node.key) && remember(node.key) && isTreeLabel(node.label) && typeof node.thisWindow === 'boolean'
				&& (!node.thisWindow || device.locality === 'local')
				&& ['online', 'busy', 'offline', 'conflict', 'draining'].includes(node.status)
				&& boundedArray(node.workspaces, 32, (workspace) =>
					isExactRecord(workspace, ['key', 'name', 'claimStatus', 'enabled', 'busy', 'acceptsIncoming', 'allowlisted',
						'gateState', 'canDelegate', 'incomingPeers'],
					['delegateActionHandle', 'allowActionHandle', 'receiveActionHandle', 'receiveAction', 'permissionKey'])
					&& isTreeKey(workspace.key) && remember(workspace.key) && isTreeLabel(workspace.name)
					&& (workspace.permissionKey === undefined || managementKey(workspace.permissionKey, 'workspace') || managementKey(workspace.permissionKey, 'target'))
					&& ['claimed', 'readOnly', 'conflict'].includes(workspace.claimStatus)
					&& booleans(workspace, ['enabled', 'busy', 'acceptsIncoming', 'allowlisted', 'canDelegate'])
					&& ['allowed', 'notAllowed', 'notAccepting', 'offline', 'multiWorkspace', 'notClaimed', 'unavailable', 'self'].includes(workspace.gateState)
					&& actionableHandle(workspace.canDelegate, workspace.delegateActionHandle)
					&& (!workspace.canDelegate || (!node.thisWindow && workspace.enabled && !workspace.busy && workspace.claimStatus === 'claimed' && workspace.gateState === 'allowed'))
					&& optionalHandle(workspace.allowActionHandle) && optionalHandle(workspace.receiveActionHandle)
					&& ((workspace.receiveAction === undefined) === (workspace.receiveActionHandle === undefined))
					&& (workspace.receiveAction === undefined || ['setAcceptIncoming', 'setRemoteReceive'].includes(workspace.receiveAction))
					&& (!node.thisWindow || workspace.allowActionHandle === undefined)
					&& boundedArray(workspace.incomingPeers, 32, (peer) =>
						isExactRecord(peer, ['key', 'label', 'autoAccept', 'actionHandle'])
						&& isTreeKey(peer.key) && remember(peer.key) && isTreeLabel(peer.label)
						&& typeof peer.autoAccept === 'boolean' && isActionHandle(peer.actionHandle))
					&& (!(workspace.receiveActionHandle !== undefined || workspace.incomingPeers.length > 0)
						|| (node.thisWindow && device.locality === 'local')))));
	}

	function isConnectivity(value) {
		return isExactRecord(value, ['discoveryEnabled', 'delegationEnabled', 'strictPolicyActivated', 'publishEnabled',
			'hostingBackend', 'migrationPending', 'accountProvider', 'claimedWorkspaceCount', 'receivingWorkspaceCount',
			'state', 'truncated', 'candidates', 'incomingPeers', 'enabled', 'connectionState', 'connectedDeviceCount'], ['error', 'accountLabel'])
			&& booleans(value, ['discoveryEnabled', 'delegationEnabled', 'strictPolicyActivated', 'publishEnabled', 'migrationPending', 'truncated', 'enabled'])
			&& ['cli', 'sdk'].includes(value.hostingBackend) && ['none', 'github', 'microsoft'].includes(value.accountProvider)
			&& ['disabled', 'authRequired', 'discovering', 'ready', 'error'].includes(value.state)
			&& ['disabled', 'authenticating', 'starting', 'online', 'stopping', 'authRequired', 'error', 'cleanupPending'].includes(value.connectionState)
			&& boundedInteger(value.connectedDeviceCount, 256)
			&& (value.accountLabel === undefined || (isText(value.accountLabel) && value.accountLabel.length <= 256))
			&& ['claimedWorkspaceCount', 'receivingWorkspaceCount'].every((key) => boundedInteger(value[key], 32))
			&& (value.error === undefined || [
				'DISABLED', 'AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED', 'OFFLINE', 'DISCOVERY_UNAVAILABLE',
				'RATE_LIMITED', 'TIMEOUT', 'CANCELLED', 'INVALID_ENDPOINT', 'BINDING_CHANGED', 'POLICY_DENIED',
				'PRIVATE_ACCESS_REQUIRED', 'CLEANUP_FAILED', 'MIGRATION_REQUIRED', 'PROTOCOL_INCOMPATIBLE', 'PLATFORM_UNSUPPORTED',
			].includes(value.error))
			&& boundedArray(value.candidates, 10, (candidate) =>
				isExactRecord(candidate, ['actionHandle', 'label', 'hostHint', 'stale', 'admission'])
				&& isActionHandle(candidate.actionHandle) && typeof candidate.label === 'string' && /^Candidate [0-9a-f]{8}$/u.test(candidate.label)
				&& ['online', 'offline', 'unknown'].includes(candidate.hostHint) && typeof candidate.stale === 'boolean'
				&& ['legacy-mesh-auth', 'private-port-token'].includes(candidate.admission))
			&& boundedArray(value.incomingPeers, 256, (peer) =>
				isExactRecord(peer, ['actionHandle', 'label', 'state', 'cleanupPending']) && isActionHandle(peer.actionHandle)
				&& typeof peer.label === 'string' && /^Peer [0-9a-f]{8}$/u.test(peer.label)
				&& ['active', 'pending', 'revoked'].includes(peer.state) && typeof peer.cleanupPending === 'boolean');
	}

	function isTasks(value) {
		return boundedArray(value, 500, (task) =>
			isExactRecord(task, ['counterpartLabel', 'workspaceName', 'title', 'state', 'startedAt', 'shortId', 'canCancel'], ['actionHandle'])
			&& strings(task, ['counterpartLabel', 'workspaceName', 'title']) && taskStates.includes(task.state)
			&& isTimestamp(task.startedAt) && typeof task.shortId === 'string' && /^[0-9a-f]{8}$/u.test(task.shortId)
			&& typeof task.canCancel === 'boolean' && actionableHandle(task.canCancel, task.actionHandle)
			&& (!terminalStates.has(task.state) || !task.canCancel));
	}
	function isError(value) {
		return isExactRecord(value, ['code', 'message'], ['action']) && strings(value, ['code', 'message']) && optionalText(value.action);
	}
	function isComponent(value) {
		return isExactRecord(value, ['state', 'label'], ['detail', 'action'])
			&& ['ready', 'stopped', 'error', 'unavailable'].includes(value.state) && isText(value.label)
			&& optionalText(value.detail) && optionalText(value.action);
	}
	function isExactRecord(value, required, optional = []) {
		return value !== null && typeof value === 'object' && !Array.isArray(value)
			&& required.every((key) => Object.hasOwn(value, key))
			&& Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
	}
	function boundedArray(value, bound, validate) { return Array.isArray(value) && value.length <= bound && value.every(validate); }
	function boundedInteger(value, bound) { return Number.isInteger(value) && value >= 0 && value <= bound; }
	function strings(value, keys) { return keys.every((key) => isText(value[key])); }
	function booleans(value, keys) { return keys.every((key) => typeof value[key] === 'boolean'); }
	function isText(value) { return typeof value === 'string' && encoder.encode(value).byteLength <= 2048; }
	function optionalText(value) { return value === undefined || isText(value); }
	function isActionHandle(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/u.test(value); }
	function optionalHandle(value) { return value === undefined || isActionHandle(value); }
	function actionableHandle(available, handle) { return available ? isActionHandle(handle) : handle === undefined; }
	function isTreeKey(value) { return typeof value === 'string' && /^tree-[1-9][0-9]{0,8}$/u.test(value); }
	function managementKey(value, kind) { return typeof value === 'string' && value.length <= 64 && new RegExp(`^manage-${kind}-[1-9][0-9]*$`, 'u').test(value); }
	function isTreeLabel(value) { return typeof value === 'string' && value.length > 0 && encoder.encode(value).byteLength <= 256; }
	function isTimestamp(value) {
		return value === 'Unknown' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)));
	}
}());
