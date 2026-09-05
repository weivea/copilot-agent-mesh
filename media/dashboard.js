(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const uiInstanceId = document.body.dataset.uiInstanceId;
	const version = 8;

	const controls = new Set();
	const controlActions = new WeakMap();
	const baseDisabled = new WeakMap();
	const textEncoder = new TextEncoder();

	const connectivityActions = new Set([
		'configureConnectivity',
		'refreshDiscovery',
		'pairDiscoveredPeer',
		'configureRemotePolicy',
		'revokeIncomingPeer',
		'retryConnectivityCleanup',
		'refreshRemoteTargets',
	]);
	const remotePolicyActions = new Set([
		'setRemoteAutoAccept',
		'setRemoteReceive',
		'setRemoteAllowed',
	]);
	const promptActions = new Set([...connectivityActions, ...remotePolicyActions]);
	const dashboardActions = new Set([
		...promptActions,
		'configureDevice',
		'renameWindow',
		'startListener',
		'stopListener',
		'copyConnectionUrl',
		'setAcceptIncoming',
		'setPeerAllowed',
		'openTargetChat',
		'cancelOutgoingTask',
		'cancelIncomingTask',
		'refresh',
	]);

	const state = {
		pendingActions: new Set(),
		actionFailure: undefined,
		model: undefined,
		selectedKey: undefined,
		focusedKey: undefined,
		expandedKeys: new Set(),
		treeButtons: new Map(),
		visibleTreeItems: [],
		treeLookup: new Map(),
		drawerOpen: false,
		treeInitialized: false,
	};

	const refreshButton = document.getElementById('refreshButton');
	const settingsButton = document.getElementById('settingsButton');
	const closeSettingsButton = document.getElementById('closeSettingsButton');

	refreshButton.addEventListener('click', () => {
		postAction('refresh');
	});
	settingsButton.addEventListener('click', () => {
		setDrawerOpen(!state.drawerOpen);
	});
	closeSettingsButton.addEventListener('click', () => {
		setDrawerOpen(false);
		settingsButton.focus();
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!isOutboundMessage(message) || message.uiInstanceId !== uiInstanceId) {
			return;
		}
		state.pendingActions = new Set(message.pendingActions || []);
		if (message.type === 'dashboard.error') {
			state.actionFailure = message.message;
			setStatus(message.message);
			updateControls();
			return;
		}
		state.model = message.model;
		render(message.model);
	});

	vscode.postMessage({ version, uiInstanceId, type: 'ready' });

	function render(model, focusTree = false) {
		const previousFocus = document.activeElement;
		const restoreTree = focusTree || previousFocus?.dataset?.treeKey !== undefined;
		const focusKey = previousFocus?.dataset?.focusKey;
		controls.clear();
		registerStaticControls();
		renderDevice(model.device, model.broker);
		renderThisWindow(model.thisWindow);
		renderAcceptIncomingSummary(model.thisWindow);
		renderListener(model.listener);
		renderConnectivity(
			model.connectivity,
			!model.errors.some((error) =>
				error.code === 'CONNECTIVITY_UNAVAILABLE' || error.code === 'DASHBOARD_SERVICES_UNAVAILABLE'),
		);
		renderCollection('localNodes', model.localNodes, renderLocalNode, peerEmptyMessage(model.thisWindow));
		renderCollection(
			'savedAuthorizations',
			model.savedAuthorizations,
			renderSavedAuthorization,
			'No saved offline authorizations.',
		);
		renderCollection('errors', model.errors, renderError, 'No diagnostic errors.');
		renderTaskDock(model);
		renderTree(model);
		renderSelection(model);
		for (const control of controls) {
			baseDisabled.set(control, control.disabled);
		}
		updateControls();
		setStatus(statusText());
		if (restoreTree) {
			restoreTreeFocus();
		} else if (focusKey) {
			[...controls].find((control) => control.dataset.focusKey === focusKey)?.focus();
		}
	}

	function registerStaticControls() {
		const refresh = registerControl(refreshButton, 'refresh');
		refresh.disabled = false;
		setDrawerOpen(state.drawerOpen);
	}

	function renderTaskDock(model) {
		renderCollection(
			'outgoingTasks',
			model.outgoingTasks,
			(task) => renderTask(task, 'cancelOutgoingTask', 'Target'),
			'No outgoing delegated tasks.',
		);
		renderCollection(
			'incomingTasks',
			model.incomingTasks,
			(task) => renderTask(task, 'cancelIncomingTask', 'Source'),
			'No incoming delegated tasks.',
		);
	}

	function renderTree(model) {
		const root = reset(document.getElementById('deviceTree'));
		root.setAttribute('role', 'tree');
		root.setAttribute('aria-label', 'Workspace targets');
		state.treeButtons.clear();

		const derived = buildTree(model);
		state.treeLookup = derived.lookup;
		state.visibleTreeItems = [];
		state.expandedKeys = new Set(
			[...state.expandedKeys].filter((key) => derived.expandableKeys.has(key)),
		);
		if (!state.treeInitialized) {
			for (const key of derived.defaultExpandedKeys) {
				state.expandedKeys.add(key);
			}
			state.treeInitialized = true;
		}
		if (state.selectedKey === undefined) {
			state.selectedKey = derived.defaultSelectionKey;
		}

		root.append(
			treeSection('This device'),
			renderTreeBranchList(derived.localDevices, model.connectivity.candidates.length > 0
				? undefined
				: 'No additional local Windows are currently available.'),
			treeSection('Other devices'),
			renderTreeBranchList(
				derived.remoteDevices,
				model.connectivity.candidates.length > 0
					? 'No paired devices with visible Workspaces. Unpaired candidates stay in Settings.'
					: 'No paired devices with visible Workspaces.',
			),
		);
		if (!state.treeButtons.has(state.focusedKey)) {
			state.focusedKey = state.treeButtons.has(state.selectedKey) ? state.selectedKey : state.visibleTreeItems[0];
		}
		updateTreeTabStops();
	}

	function buildTree(model) {
		const lookup = new Map();
		const expandableKeys = new Set();
		const defaultExpandedKeys = [];
		let defaultSelectionKey;

		const localDevices = [];
		const remoteDevices = [];

		const registerEntry = (entry) => {
			lookup.set(entry.key, entry);
			if (entry.expandable) {
				expandableKeys.add(entry.key);
			}
			if (defaultSelectionKey === undefined && entry.defaultSelection) {
				defaultSelectionKey = entry.key;
			}
			return entry;
		};

		const devices = model.deviceTree.length > 0
			? model.deviceTree
			: [fallbackTreeDevice(model)];

		for (const device of devices) {
			const deviceEntry = registerEntry({
				kind: 'device',
				key: device.key,
				label: device.name,
				meta: device.locality === 'local' ? 'This device' : deviceStateLabel(device.state),
				parentKey: undefined,
				depth: 0,
				expandable: device.nodes.length > 0,
				defaultSelection: false,
				value: device,
				children: [],
			});
			if (device.locality === 'local') {
				defaultExpandedKeys.push(device.key);
			}
			for (const node of device.nodes) {
				const nodeDefaultSelection = node.thisWindow
					&& node.workspaces.some(() => isCurrentWorkspace(device, node));
				const nodeEntry = registerEntry({
					kind: 'node',
					key: node.key,
					label: node.label,
					meta: node.thisWindow ? 'Current window' : nodeStatusLabel(node.status),
					parentKey: device.key,
					depth: 1,
					expandable: node.workspaces.length > 0,
					defaultSelection: node.thisWindow && node.workspaces.length === 0,
					value: { device, node },
					children: [],
				});
				deviceEntry.children.push(nodeEntry);
				if (node.thisWindow || nodeDefaultSelection) {
					defaultExpandedKeys.push(node.key);
				}
				for (const workspace of node.workspaces) {
					const current = isCurrentWorkspace(device, node);
					const workspaceEntry = registerEntry({
						kind: 'workspace',
						key: workspace.key,
						label: workspace.name,
						meta: current ? 'Current Workspace' : workspaceTreeMeta(workspace),
						parentKey: node.key,
						depth: 2,
						expandable: false,
						defaultSelection: current,
						value: { device, node, workspace, current },
						children: [],
					});
					nodeEntry.children.push(workspaceEntry);
				}
			}
			if (device.locality === 'local') {
				localDevices.push(deviceEntry);
			} else {
				remoteDevices.push(deviceEntry);
			}
		}

		if (defaultSelectionKey === undefined) {
			defaultSelectionKey = lookup.values().next().value?.key;
		}

		return {
			lookup,
			expandableKeys,
			defaultExpandedKeys,
			defaultSelectionKey,
			localDevices,
			remoteDevices,
		};
	}

	function fallbackTreeDevice(model) {
		return {
			key: 'tree-900000001',
			name: model.device.name,
			locality: 'local',
			state: ['running', 'contending'].includes(model.broker.state) ? 'online' : 'offline',
			nodes: [{
				key: 'tree-900000002',
				label: model.thisWindow.name,
				thisWindow: true,
				status: model.thisWindow.agentHost.degraded ? 'busy' : 'online',
				workspaces: [{
					key: 'tree-900000003',
					name: model.thisWindow.workspaceName,
					claimStatus: model.thisWindow.claimStatus === 'claimed'
						? 'claimed'
						: model.thisWindow.claimStatus === 'readOnly'
						? 'readOnly'
						: 'conflict',
					enabled: false,
					busy: false,
					acceptsIncoming: model.thisWindow.acceptsIncoming,
					allowlisted: false,
					gateState: 'self',
					canDelegate: false,
					incomingPeers: [],
					...(model.thisWindow.acceptActionHandle === undefined || !model.thisWindow.canSetAcceptIncoming
						? {}
						: {
							receiveActionHandle: model.thisWindow.acceptActionHandle,
							receiveAction: 'setAcceptIncoming',
						}),
				}],
			}],
		};
	}

	function renderTreeBranchList(entries, emptyMessage) {
		const container = document.createElement('div');
		if (entries.length === 0) {
			container.append(textElement('p', emptyMessage, 'empty'));
			return container;
		}
		for (const entry of entries) {
			renderTreeEntry(entry, container);
		}
		return container;
	}

	function renderTreeEntry(entry, container) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `treeItem depth-${entry.depth}${state.selectedKey === entry.key ? ' selected' : ''}`;
		button.setAttribute('role', 'treeitem');
		button.setAttribute('data-tree-key', entry.key);
		button.setAttribute('aria-selected', state.selectedKey === entry.key ? 'true' : 'false');
		button.setAttribute('aria-level', String(entry.depth + 1));
		if (entry.expandable) {
			button.setAttribute('aria-expanded', isExpanded(entry.key) ? 'true' : 'false');
		}
		button.tabIndex = state.focusedKey === entry.key || (state.focusedKey === undefined && state.selectedKey === entry.key) ? 0 : -1;
		button.append(
			textElement('span', entry.expandable ? (isExpanded(entry.key) ? '▾' : '▸') : '•', 'treeChevron'),
			textElement('span', kindMarker(entry.kind), 'treeMarker'),
			textElement('span', entry.label, 'treeLabel'),
			textElement('span', entry.meta, 'treeMeta'),
		);
		button.addEventListener('focus', () => {
			state.focusedKey = entry.key;
			updateTreeTabStops();
		});
		button.addEventListener('click', () => {
			if (entry.expandable && state.selectedKey === entry.key) {
				toggleExpanded(entry.key);
				return;
			}
			selectTreeKey(entry.key, true);
		});
		button.addEventListener('keydown', (event) => {
			handleTreeKeydown(event, entry.key);
		});
		state.treeButtons.set(entry.key, button);
		state.visibleTreeItems.push(entry.key);
		container.append(button);
		if (entry.expandable && isExpanded(entry.key)) {
			const group = document.createElement('div');
			group.setAttribute('role', 'group');
			for (const child of entry.children) {
				renderTreeEntry(child, group);
			}
			container.append(group);
		}
	}

	function renderSelection(model) {
		const summary = reset(document.getElementById('selectionSummary'));
		const details = reset(document.getElementById('selectionDetails'));
		const entry = state.selectedKey === undefined ? undefined : state.treeLookup.get(state.selectedKey);

		if (entry === undefined) {
			summary.append(textElement('span', 'Selection unavailable'));
			details.append(
				textElement('strong', 'The previous selection is no longer available.'),
				textElement('p', 'Refresh or select another current device, window, or Workspace. The Dashboard will not silently retarget a stale selection.', 'detail'),
			);
			return;
		}

		summary.append(textElement('span', selectionPath(entry)));
		switch (entry.kind) {
			case 'device':
				renderDeviceSelection(details, entry.value, model);
				break;
			case 'node':
				renderNodeSelection(details, entry.value.device, entry.value.node);
				break;
			case 'workspace':
				renderWorkspaceSelection(details, entry.value.device, entry.value.node, entry.value.workspace, entry.value.current, model);
				break;
		}
	}

	function renderDeviceSelection(root, device, model) {
		root.append(
			headingBlock(device.name, device.locality === 'local' ? 'This device' : 'Paired remote device'),
			propertyRow('State', deviceStateLabel(device.state)),
			propertyRow('Visible windows', device.nodes.length),
			propertyRow('Connectivity', connectivityStateLabel(model.connectivity.state)),
			propertyRow('Incoming tasks', model.incomingTasks.length),
			propertyRow('Outgoing tasks', model.outgoingTasks.length),
		);
		if (device.locality === 'local') {
			const actions = actionsRow();
			actions.append(
				actionButton('Configure device name', 'configureDevice'),
				staticButton('Open settings', () => setDrawerOpen(true), 'secondary'),
			);
			root.append(
				textElement('p', 'Discovery stays local-status only until you explicitly configure cross-device settings.', 'detail'),
				actions,
			);
			return;
		}
		root.append(
			textElement(
				'p',
				device.nodes.length === 0
					? 'This paired device has no visible authorized Workspaces in the current snapshot.'
					: 'Select a window or Workspace below this device to review exact routing and authorization.',
				'detail',
			),
			actionsRow(
				actionButton('Refresh connected devices', 'refreshRemoteTargets'),
				staticButton('Open settings', () => setDrawerOpen(true), 'secondary'),
			),
		);
	}

	function renderNodeSelection(root, device, node) {
		root.append(
			headingBlock(node.label, node.thisWindow ? 'Current window' : 'Window'),
			propertyRow('Device', device.name),
			propertyRow('State', nodeStatusLabel(node.status)),
			propertyRow('Visible Workspaces', node.workspaces.length),
			propertyRow('Location', device.locality === 'local' ? 'Local device' : 'Remote device'),
			textElement(
				'p',
				node.workspaces.length === 0
					? 'No Workspaces are currently visible for this window.'
					: 'Select a Workspace in this window to review receive gates, directional allowlists, and Chat delegation.',
				'detail',
			),
		);
		if (node.thisWindow) {
			root.append(actionsRow(actionButton('Rename this window', 'renameWindow', undefined, false)));
		}
	}

	function renderWorkspaceSelection(root, device, node, workspace, current, model) {
		root.append(
			headingBlock(workspace.name, current ? 'Current Workspace' : 'Workspace target'),
			propertyRow('Device', device.name),
			propertyRow('Window', node.label),
			propertyRow('Claim', claimLabel(workspace.claimStatus)),
			propertyRow('Workspace state', workspace.enabled ? (workspace.busy ? 'Busy' : 'Enabled') : 'Unavailable'),
		);
		if (current) {
			root.append(
				propertyRow('Agent Host', model.thisWindow.agentHost.label),
				renderReceiveControl(workspace),
			);
			if (workspace.incomingPeers.length > 0) {
				root.append(sectionHeading('Incoming device approvals'));
				for (const peer of workspace.incomingPeers) {
					root.append(renderIncomingAutoAccept(peer));
				}
			} else {
				root.append(textElement(
					'p',
					'No paired device has an incoming grant for this Workspace. Grant a device in Settings before enabling automatic acceptance.',
					'detail',
				));
			}
			root.append(textElement(
				'p',
				'Automatic acceptance skips the task-start confirmation only for the selected paired source device and this current Workspace.',
				'detail',
			));
			const actions = actionsRow(
				actionButton('Rename this window', 'renameWindow', undefined, !model.thisWindow.canRename),
				staticButton('Open settings', () => setDrawerOpen(true), 'secondary'),
			);
			root.append(actions);
			return;
		}

		root.append(
			propertyRow('Target gate', gateLabel(workspace.gateState)),
			propertyRow('Accepts incoming', workspace.acceptsIncoming ? 'Yes' : 'No'),
		);
		const explanation = workspaceExplanation(workspace);
		if (explanation) {
			root.append(textElement('p', explanation, workspace.canDelegate ? 'detail' : 'action-hint'));
		}
		if (workspace.allowActionHandle !== undefined) {
			root.append(renderAllowlistControl(device, workspace));
		}
		const actions = actionsRow();
		if (workspace.canDelegate && workspace.delegateActionHandle) {
			actions.append(actionButton('Delegate from Chat…', 'openTargetChat', {
				actionHandle: workspace.delegateActionHandle,
			}, false, false, 'primary'));
		}
		actions.append(device.locality === 'remote'
			? actionButton('Refresh connected devices', 'refreshRemoteTargets')
			: actionButton('Refresh local status', 'refresh'));
		actions.append(staticButton('Open settings', () => setDrawerOpen(true), 'secondary'));
		root.append(actions);
	}

	function renderReceiveControl(workspace) {
		const action = workspace.receiveAction;
		const actionHandle = workspace.receiveActionHandle;
		const available = typeof action === 'string' && typeof actionHandle === 'string';
		const container = document.createElement('div');
		container.className = 'selectionSection';
		container.append(sectionHeading('Incoming task gate'));
		const label = document.createElement('label');
		label.className = 'toggleCard';
		const checkbox = available
			? registerControl(document.createElement('input'), action)
			: document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = workspace.acceptsIncoming;
		checkbox.disabled = !available;
		checkbox.setAttribute('aria-label', 'Accept incoming tasks for this Workspace');
		checkbox.dataset.focusKey = `receive:${workspace.key}`;
		if (available) {
			checkbox.addEventListener('change', () => {
				postAction(action, { actionHandle, enabled: checkbox.checked });
			});
		}
		label.append(
			checkbox,
			textBlock(
				workspace.acceptsIncoming ? 'Accept incoming tasks' : 'Do not accept incoming tasks',
				action === 'setRemoteReceive'
					? 'This shared receive gate is managed by strict remote policy for this Workspace.'
					: 'This applies only to the current Workspace in this window.',
			),
		);
		container.append(label);
		if (action === 'setRemoteReceive') {
			container.append(textElement(
				'p',
				'Use Cross-device settings if you need to change the broader remote policy without enabling local delegation.',
				'detail',
			));
		}
		return container;
	}

	function renderIncomingAutoAccept(peer) {
		const card = document.createElement('label');
		card.className = 'toggleCard';
		const checkbox = registerControl(document.createElement('input'), 'setRemoteAutoAccept');
		checkbox.type = 'checkbox';
		checkbox.checked = peer.autoAccept;
		checkbox.setAttribute('aria-label', `Automatically accept tasks from ${peer.label}`);
		checkbox.dataset.focusKey = `autoAccept:${peer.key}`;
		checkbox.addEventListener('change', () => {
			postAction('setRemoteAutoAccept', {
				actionHandle: peer.actionHandle,
				enabled: checkbox.checked,
			});
		});
		card.append(
			checkbox,
			textBlock(
				`Automatically accept tasks from ${peer.label}`,
				'This Workspace only. Skips task-start confirmation, not sensitive tool approvals.',
			),
		);
		return card;
	}

	function renderAllowlistControl(device, workspace) {
		const action = device.locality === 'local' ? 'setPeerAllowed' : 'setRemoteAllowed';
		const label = document.createElement('label');
		label.className = 'toggleCard';
		const checkbox = registerControl(document.createElement('input'), action);
		checkbox.type = 'checkbox';
		checkbox.checked = workspace.allowlisted;
		checkbox.setAttribute('aria-label', `Allow delegation to ${workspace.name}`);
		checkbox.dataset.focusKey = `allow:${workspace.key}`;
		checkbox.addEventListener('change', () => {
			postAction(action, {
				actionHandle: workspace.allowActionHandle,
				enabled: checkbox.checked,
			});
		});
		label.append(
			checkbox,
			textBlock(
				device.locality === 'local'
					? 'Allow this local Workspace as a delegation target'
					: 'Authorize this window’s claimed source Workspaces for this remote Workspace',
				device.locality === 'local'
					? 'A checked box authorizes only the current Workspace to delegate to this exact local target.'
					: 'Applies to all claimed source roots in this window. Pairing alone is not enough.',
			),
		);
		return label;
	}

	function renderDevice(device, broker) {
		const root = reset(document.getElementById('device'));
		root.append(
			propertyRow('Name', device.name),
			propertyRow('Platform', `${device.platform} ${device.architecture}`),
			propertyRow('VS Code', device.vscodeVersion),
			propertyRow('Extension', device.extensionVersion),
			propertyRow('Broker role', broker.role === 'owner' ? 'Owner' : 'Contender'),
			propertyRow('Broker state', brokerStateLabel(broker.state)),
			actionsRow(actionButton('Configure device name', 'configureDevice')),
		);
		if (broker.error) {
			root.append(renderError(broker.error));
		}
	}

	function renderThisWindow(thisWindow) {
		const root = reset(document.getElementById('thisWindow'));
		root.append(
			propertyRow('Window name', thisWindow.name),
			propertyRow('Workspace', thisWindow.workspaceName),
			propertyRow('Claim', claimLabel(thisWindow.claimStatus)),
			propertyRow('Agent Host', thisWindow.agentHost.label),
		);
		if (thisWindow.agentHost.detail) {
			root.append(textElement('p', thisWindow.agentHost.detail, 'detail'));
		}
		if (thisWindow.detail) {
			root.append(textElement('p', thisWindow.detail, 'detail'));
		}
		root.append(actionsRow(actionButton('Rename this window', 'renameWindow', undefined, !thisWindow.canRename)));
	}

	function renderAcceptIncomingSummary(thisWindow) {
		const root = reset(document.getElementById('acceptIncoming'));
		root.append(
			propertyRow('Current state', thisWindow.acceptsIncoming ? 'Accepting incoming tasks' : 'Not accepting incoming tasks'),
			textElement(
				'p',
				thisWindow.previewEnabled
					? 'Change the live receive gate from the current Workspace details pane.'
					: 'This summary may still reflect strict remote policy even while local Peer Delegation Preview is off.',
				'detail',
			),
		);
	}

	function renderListener(listener) {
		const root = reset(document.getElementById('listener'));
		root.append(
			propertyRow('Listener', listenerStateLabel(listener.state)),
			renderComponentSummary('Gateway', listener.gateway),
			renderComponentSummary('Tunnel', listener.tunnel),
			renderComponentSummary('Agent Host', listener.agentHost),
		);
		const actions = actionsRow();
		if (listener.canStart) {
			actions.append(actionButton('Start listener', 'startListener'));
		}
		if (listener.canStop) {
			actions.append(actionButton('Stop listener', 'stopListener', undefined, false, true));
		}
		if (listener.canCopyConnectionUrl) {
			actions.append(actionButton('Copy connection URL', 'copyConnectionUrl'));
		}
		root.append(actions);
	}

	function renderConnectivity(connectivity, statusAvailable) {
		const root = reset(document.getElementById('connectivity'));
		const setting = (value) => statusAvailable ? String(value) : 'Unknown';
		root.append(
			propertyRow('Discovery state', connectivityStateLabel(connectivity.state)),
			propertyRow('Account discovery', setting(connectivity.discoveryEnabled ? 'Enabled' : 'Disabled (default)')),
			propertyRow('New remote tasks', setting(connectivity.delegationEnabled ? 'Enabled, subject to policy' : 'Disabled')),
			propertyRow('Strict remote policy', setting(connectivity.strictPolicyActivated ? 'Activated — latched on' : 'Not activated')),
			propertyRow('Discovery publishing', setting(connectivity.publishEnabled ? 'Enabled' : 'Disabled')),
			propertyRow('Hosting selection', setting(connectivity.hostingBackend === 'sdk' ? 'SDK private hosting' : 'Legacy CLI hosting')),
			propertyRow('Account provider', setting({ none: 'None selected', github: 'GitHub', microsoft: 'Microsoft' }[connectivity.accountProvider])),
			propertyRow('Claimed Workspaces', setting(connectivity.claimedWorkspaceCount)),
			propertyRow('Receiving Workspaces', setting(connectivity.receivingWorkspaceCount)),
			textElement(
				'p',
				statusAvailable
					? 'Rendering and Refresh read local status only. They do not sign in, discover devices, or start hosting.'
					: 'Connectivity settings are unavailable. Local task status and cancellation remain available.',
				'detail',
			),
			textElement(
				'p',
				statusAvailable
					? admissionLabel(connectivity.hostingBackend === 'sdk' ? 'private-port-token' : 'legacy-mesh-auth')
					: 'Current hosting admission is unavailable in this snapshot.',
				'detail',
			),
			textElement(
				'p',
				'Discovery candidates are hints only. Pair explicitly, authorize the exact Workspace, and enable the target receive gate before delegating work.',
				'detail',
			),
			textElement(
				'p',
				'Disabling remote delegation blocks new remote tasks; it does not cancel tasks already accepted.',
				'detail',
			),
			textElement(
				'p',
				'SDK private hosting never silently falls back to the legacy CLI.',
				'detail',
			),
			textElement(
				'p',
				'Remote policy uses only Workspaces owned by this calling window. Prompts open in the Broker owner window, including requests from non-owner windows.',
				'detail',
			),
		);
		if (connectivity.migrationPending) {
			root.append(textElement(
				'p',
				'Hosting migration pending. Finish cleanup before switching exposure backends.',
				'action-hint',
			));
		}
		if (connectivity.error) {
			root.append(renderError({
				code: connectivity.error,
				message: connectivityErrorMessage(connectivity.error),
			}));
		}
		if (connectivity.truncated) {
			root.append(textElement(
				'p',
				'Cross-device results reached the safe display limit. Use native configuration for items outside this bounded view.',
				'action-hint',
			));
		}
		const actions = actionsRow(
			actionButton('Configure discovery and hosting…', 'configureConnectivity'),
			actionButton(
				'Refresh account discovery',
				'refreshDiscovery',
				undefined,
				!connectivity.discoveryEnabled || connectivity.state === 'discovering',
			),
			actionButton('Refresh connected devices', 'refreshRemoteTargets'),
			actionButton('Configure strict remote policy…', 'configureRemotePolicy'),
			actionButton(
				'Retry connectivity cleanup',
				'retryConnectivityCleanup',
				undefined,
				!connectivity.migrationPending
					&& connectivity.error !== 'CLEANUP_FAILED'
					&& !connectivity.incomingPeers.some((peer) => peer.cleanupPending),
			),
		);
		root.append(actions);
		renderCollection(
			'discoveryCandidates',
			connectivity.candidates,
			(candidate) => renderDiscoveryCandidate(candidate, connectivity.discoveryEnabled),
			!statusAvailable
				? 'Discovery status is unavailable.'
				: connectivity.discoveryEnabled
				? 'No discovery candidates. Refresh account discovery explicitly when needed.'
				: 'Account discovery is disabled.',
		);
		renderCollection(
			'incomingPeers',
			connectivity.incomingPeers,
			renderIncomingPeer,
			statusAvailable ? 'No incoming peers are listed.' : 'Incoming peer status is unavailable.',
		);
	}

	function renderDiscoveryCandidate(candidate, discoveryEnabled) {
		const card = itemCard(candidate.label, candidate.stale ? 'Stale candidate' : 'Candidate');
		card.append(
			propertyRow('Host hint', { online: 'Online', offline: 'Offline', unknown: 'Unknown' }[candidate.hostHint]),
			textElement('p', admissionLabel(candidate.admission), 'detail'),
			textElement(
				'p',
				candidate.stale
					? 'Refresh discovery before pairing this candidate.'
					: 'This is not an executable worker or a task grant.',
				candidate.stale ? 'action-hint' : 'detail',
			),
			actionButton(
				'Pair this candidate…',
				'pairDiscoveredPeer',
				{ actionHandle: candidate.actionHandle },
				candidate.stale || !discoveryEnabled,
			),
		);
		return card;
	}

	function renderIncomingPeer(peer) {
		const card = itemCard(peer.label, { active: 'Active', pending: 'Pending', revoked: 'Revoked' }[peer.state]);
		card.append(
			propertyRow('Admission cleanup', peer.cleanupPending ? 'Pending — retry required' : 'No pending cleanup'),
			actionButton(
				'Revoke incoming peer…',
				'revokeIncomingPeer',
				{ actionHandle: peer.actionHandle },
				peer.state === 'revoked',
				true,
			),
		);
		if (peer.cleanupPending) {
			card.append(textElement(
				'p',
				'Peer cleanup is still pending. Retry connectivity cleanup to finish withdrawing access.',
				'action-hint',
			));
		}
		return card;
	}

	function renderLocalNode(node) {
		const card = itemCard(node.windowLabel, node.online ? 'Online' : 'Offline');
		card.append(
			propertyRow('Workspace', node.workspaceName),
			propertyRow('Accepts incoming', node.acceptsIncoming ? 'Yes' : 'No'),
			propertyRow('Busy', node.busy ? 'Yes' : 'No'),
			propertyRow('Claim gate', claimLabel(node.claimState)),
			propertyRow('Delegation gate', gateLabel(node.gateState)),
		);
		const fix = gateFix(node);
		if (fix) {
			card.append(textElement('p', fix, 'action-hint'));
		}
		if (node.self) {
			card.append(textElement('p', 'This is the current Window Node.', 'detail'));
		} else {
			const label = document.createElement('label');
			label.className = 'toggleCard';
			const checkbox = registerControl(document.createElement('input'), 'setPeerAllowed');
			checkbox.type = 'checkbox';
			checkbox.checked = node.allowlisted;
			checkbox.disabled = !node.canToggle;
			checkbox.setAttribute('aria-label', `Allow ${node.windowLabel} as a delegation target`);
			checkbox.addEventListener('change', () => {
				postAction('setPeerAllowed', {
					actionHandle: node.actionHandle,
					enabled: checkbox.checked,
				});
			});
			label.append(checkbox, textBlock('Allow this Workspace as a target', 'Legacy local-route view for diagnostics.'));
			card.append(label);
		}
		return card;
	}

	function renderSavedAuthorization(authorization) {
		const card = itemCard(authorization.windowLabel, 'Saved');
		card.append(
			propertyRow('Workspace', authorization.workspaceName),
			textElement(
				'p',
				'This Workspace is offline. This saved policy does not represent a live Window Node.',
				'detail',
			),
			actionButton(
				'Remove saved authorization',
				'setPeerAllowed',
				{ actionHandle: authorization.actionHandle, enabled: false },
				false,
				true,
			),
		);
		return card;
	}

	function renderTask(task, cancelAction, counterpartLabel) {
		const card = itemCard(task.title, taskStateLabel(task.state));
		card.append(
			propertyRow(counterpartLabel, task.counterpartLabel),
			propertyRow('Workspace', task.workspaceName),
			propertyRow('Started', formatTimestamp(task.startedAt)),
			propertyRow('Task ID', task.shortId),
		);
		if (task.canCancel) {
			card.append(actionButton(
				'Cancel task',
				cancelAction,
				{ actionHandle: task.actionHandle },
				false,
				true,
			));
		}
		return card;
	}

	function renderError(error) {
		const card = document.createElement('article');
		card.className = 'error';
		card.append(textElement('strong', error.code), textElement('p', error.message));
		if (error.action) {
			card.append(textElement('p', error.action, 'action-hint'));
		}
		return card;
	}

	function renderCollection(id, items, renderer, emptyMessage) {
		const root = reset(document.getElementById(id));
		if (items.length === 0 && emptyMessage) {
			root.append(textElement('p', emptyMessage, 'empty'));
			return;
		}
		for (const item of items) {
			root.append(renderer(item));
		}
	}

	function itemCard(title, status) {
		const card = document.createElement('article');
		card.className = 'card item';
		card.append(textElement('strong', title), textElement('span', status, 'statusPill'));
		return card;
	}

	function treeSection(title) {
		return textElement('div', title, 'treeSection');
	}

	function headingBlock(title, subtitle) {
		const block = document.createElement('div');
		block.className = 'headingBlock';
		block.append(textElement('strong', title, 'detailTitle'), textElement('p', subtitle, 'detail'));
		return block;
	}

	function sectionHeading(title) {
		return textElement('h3', title, 'sectionHeading');
	}

	function propertyRow(label, value) {
		const row = document.createElement('div');
		row.className = 'propertyRow';
		row.append(textElement('span', label, 'label'), textElement('span', value));
		return row;
	}

	function textBlock(title, detail) {
		const block = document.createElement('span');
		block.className = 'textBlock';
		block.append(textElement('span', title), textElement('span', detail, 'detail'));
		return block;
	}

	function renderComponentSummary(label, component) {
		const row = document.createElement('div');
		row.className = 'componentSummary';
		row.append(
			propertyRow(label, component.label),
		);
		if (component.detail) {
			row.append(textElement('p', component.detail, 'detail'));
		}
		return row;
	}

	function actionsRow() {
		const row = document.createElement('div');
		row.className = 'actions';
		for (const child of arguments) {
			if (child) {
				row.append(child);
			}
		}
		return row;
	}

	function actionButton(label, action, fields, disabled, dangerous, emphasis) {
		const button = registerControl(document.createElement('button'), action);
		button.type = 'button';
		button.disabled = disabled === true;
		button.className = emphasis === 'primary'
			? 'primary'
			: emphasis === 'secondary'
			? 'secondary'
			: dangerous
			? 'danger'
			: 'secondary';
		button.addEventListener('click', () => postAction(action, fields));
		setText(button, label);
		return button;
	}

	function staticButton(label, onClick, emphasis) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = emphasis === 'secondary' ? 'secondary' : 'linkButton';
		button.addEventListener('click', onClick);
		setText(button, label);
		return button;
	}

	function registerControl(control, action) {
		controls.add(control);
		controlActions.set(control, action);
		return control;
	}

	function updateControls() {
		for (const control of controls) {
			control.disabled = baseDisabled.get(control) === true || isActionPending(controlActions.get(control));
		}
	}

	function updateTreeTabStops() {
		for (const [key, button] of state.treeButtons) {
			button.tabIndex = state.focusedKey === key || (state.focusedKey === undefined && state.selectedKey === key) ? 0 : -1;
		}
	}

	function selectTreeKey(key, focus) {
		if (state.selectedKey === key && (!focus || state.focusedKey === key)) {
			return;
		}
		state.selectedKey = key;
		if (focus) {
			state.focusedKey = key;
		}
		render(state.model, focus);
	}

	function toggleExpanded(key) {
		if (isExpanded(key)) {
			state.expandedKeys.delete(key);
		} else {
			state.expandedKeys.add(key);
		}
		render(state.model, true);
	}

	function handleTreeKeydown(event, key) {
		const index = state.visibleTreeItems.indexOf(key);
		if (index < 0) {
			return;
		}
		const entry = state.treeLookup.get(key);
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				if (index < state.visibleTreeItems.length - 1) {
					selectTreeKey(state.visibleTreeItems[index + 1], true);
				}
				return;
			case 'ArrowUp':
				event.preventDefault();
				if (index > 0) {
					selectTreeKey(state.visibleTreeItems[index - 1], true);
				}
				return;
			case 'ArrowRight':
				event.preventDefault();
				if (entry?.expandable && !isExpanded(key)) {
					toggleExpanded(key);
					return;
				}
				if (entry?.children?.length > 0) {
					selectTreeKey(entry.children[0].key, true);
				}
				return;
			case 'ArrowLeft':
				event.preventDefault();
				if (entry?.expandable && isExpanded(key)) {
					toggleExpanded(key);
					return;
				}
				if (entry?.parentKey) {
					selectTreeKey(entry.parentKey, true);
				}
				return;
			case 'Home':
				event.preventDefault();
				if (state.visibleTreeItems.length > 0) {
					selectTreeKey(state.visibleTreeItems[0], true);
				}
				return;
			case 'End':
				event.preventDefault();
				if (state.visibleTreeItems.length > 0) {
					selectTreeKey(state.visibleTreeItems[state.visibleTreeItems.length - 1], true);
				}
				return;
			case 'Enter':
			case ' ':
				event.preventDefault();
				selectTreeKey(key, true);
				return;
		}
	}

	function restoreTreeFocus() {
		if (state.focusedKey === undefined) {
			return;
		}
		const control = state.treeButtons.get(state.focusedKey);
		if (control) {
			control.focus();
		}
	}

	function setDrawerOpen(open) {
		state.drawerOpen = open;
		const drawer = document.getElementById('settingsDrawer');
		drawer.hidden = !open;
		settingsButton.setAttribute('aria-expanded', open ? 'true' : 'false');
		settingsButton.className = open ? 'secondary' : '';
	}

	function postAction(action, fields) {
		if (isActionPending(action)) {
			return;
		}
		state.pendingActions.add(action);
		state.actionFailure = undefined;
		updateControls();
		setStatus(actionStatusMessage(action));
		vscode.postMessage({ version, uiInstanceId, type: 'action', action, ...(fields || {}) });
	}

	function actionStatusMessage(action) {
		if (action === 'openTargetChat') {
			return 'Opening a Chat draft for the selected exact target.';
		}
		if (promptActions.has(action)) {
			return 'Applying cross-device action. Complete any native prompts in the Broker owner window; task cancellation remains available.';
		}
		return 'Applying Dashboard action.';
	}

	function statusText() {
		if (state.actionFailure) {
			return state.actionFailure;
		}
		if ([...state.pendingActions].some((action) => promptActions.has(action))) {
			return 'Applying cross-device action. Complete any native prompts in the Broker owner window; task cancellation remains available.';
		}
		if (state.pendingActions.size > 0) {
			return 'Applying Dashboard action.';
		}
		return '';
	}

	function setStatus(message) {
		setText(document.getElementById('operationStatus'), message);
		setText(document.getElementById('announcement'), message || 'Dashboard refreshed.');
	}

	function textElement(tag, value, className) {
		const element = document.createElement(tag);
		if (className) {
			element.className = className;
		}
		setText(element, value);
		return element;
	}

	function reset(element) {
		element.replaceChildren();
		element.classList.remove('loading');
		return element;
	}

	function setText(element, value) {
		element.textContent = String(value ?? '');
	}

	function isExpanded(key) {
		return state.expandedKeys.has(key);
	}

	function selectionPath(entry) {
		const parts = [];
		let current = entry;
		while (current) {
			parts.unshift(current.label);
			current = current.parentKey === undefined ? undefined : state.treeLookup.get(current.parentKey);
		}
		return parts.join(' › ');
	}

	function isCurrentWorkspace(device, node) {
		return device.locality === 'local' && node.thisWindow;
	}

	function workspaceTreeMeta(workspace) {
		if (!workspace.enabled) {
			return 'Unavailable';
		}
		if (workspace.busy) {
			return 'Busy';
		}
		if (workspace.gateState === 'allowed') {
			return 'Allowed';
		}
		if (workspace.gateState === 'notAccepting') {
			return 'Receive off';
		}
		return claimLabel(workspace.claimStatus);
	}

	function workspaceExplanation(workspace) {
		switch (workspace.gateState) {
			case 'allowed':
				return 'This exact Workspace is authorized for Chat delegation. Live claims and runtime availability are checked before execution.';
			case 'notAllowed':
				return 'Enable the directional allowlist here before delegating from Chat.';
			case 'notAccepting':
				return 'The target Workspace is not accepting incoming tasks.';
			case 'offline':
				return 'The target window is offline. Keep the authorization if you want it to remain saved.';
			case 'multiWorkspace':
				return 'Keep exactly one claimed Workspace in the target window.';
			case 'notClaimed':
				return 'Open and claim one Workspace in the target window.';
			case 'unavailable':
				return 'This target is not available in the current snapshot.';
			case 'self':
				return 'The current Workspace is shown for context only and is not an executable peer target.';
			default:
				return '';
		}
	}

	function kindMarker(kind) {
		return { device: '◆', node: '▣', workspace: '▤' }[kind] || '•';
	}

	function claimLabel(value) {
		return {
			claimed: 'Claimed',
			readOnly: 'Read only',
			conflict: 'Conflict',
			unclaimed: 'Unclaimed',
			ambiguous: 'Multiple Workspaces',
			multiWorkspace: 'Multiple Workspaces',
		}[value] || value;
	}

	function gateLabel(value) {
		return {
			allowed: 'Allowed',
			notAllowed: 'Not allowed by this Workspace',
			notAccepting: 'Target is not accepting',
			offline: 'Target is offline',
			multiWorkspace: 'Target has multiple Workspaces',
			notClaimed: 'Target has no claimed Workspace',
			unavailable: 'Unavailable',
			self: 'Current Workspace',
		}[value] || value;
	}

	function gateFix(node) {
		if (node.gateState === 'notAllowed') {
			return 'Check the box below to allow this directional route.';
		}
		if (node.gateState === 'notAccepting') {
			return 'Open the target window and enable Accept incoming tasks.';
		}
		if (node.gateState === 'offline') {
			return node.allowlisted
				? 'The saved authorization is retained. Uncheck it to remove the offline entry.'
				: 'Reopen the target window before authorizing it.';
		}
		if (node.gateState === 'multiWorkspace') {
			return 'Keep exactly one claimed Workspace in the target window.';
		}
		if (node.gateState === 'notClaimed') {
			return 'Open and claim one Workspace in the target window.';
		}
		return '';
	}

	function peerEmptyMessage(thisWindow) {
		return thisWindow.previewEnabled
			? 'No local Window Node candidates are available.'
			: 'Peer candidates are unavailable while Peer Delegation Preview is disabled.';
	}

	function admissionLabel(admission) {
		return admission === 'private-port-token'
			? 'SDK private admission: private-port access is required in addition to Mesh authentication.'
			: 'Legacy CLI admission: the outer port is anonymous; Mesh authentication is still required.';
	}

	function deviceStateLabel(state) {
		return {
			connecting: 'Connecting',
			online: 'Online',
			busy: 'Busy',
			offline: 'Offline',
			authFailed: 'Authentication failed',
			incompatible: 'Incompatible',
			unknown: 'Unknown/Cached',
		}[state] || state;
	}

	function nodeStatusLabel(status) {
		return {
			online: 'Online',
			busy: 'Busy',
			offline: 'Offline',
			conflict: 'Conflict',
			draining: 'Draining',
		}[status] || status;
	}

	function listenerStateLabel(state) {
		return {
			stopped: 'Stopped',
			starting: 'Starting',
			running: 'Running',
			stopping: 'Stopping',
			error: 'Error',
			unavailable: 'Unavailable',
		}[state] || state;
	}

	function brokerStateLabel(state) {
		return {
			starting: 'Starting',
			running: 'Running',
			contending: 'Contending',
			takingOver: 'Taking over',
			stopping: 'Stopping',
			error: 'Error',
			disposed: 'Disposed',
		}[state] || state;
	}

	function taskStateLabel(state) {
		return {
			accepted: 'Accepted',
			startingAgent: 'Starting agent',
			running: 'Running',
			needsInput: 'Needs input',
			recovering: 'Recovering',
			cancelling: 'Cancelling',
			completed: 'Completed',
			failed: 'Failed',
			cancelled: 'Cancelled',
			timedOut: 'Timed out',
		}[state] || state;
	}

	function connectivityStateLabel(state) {
		return {
			disabled: 'Disabled',
			authRequired: 'Sign-in required',
			discovering: 'Discovering',
			ready: 'Ready (discovery only, not worker readiness)',
			error: 'Unavailable or error',
		}[state];
	}

	function connectivityErrorMessage(code) {
		return {
			DISABLED: 'Account discovery is disabled. Enable it explicitly in configuration.',
			AUTH_REQUIRED: 'Choose and sign in to an account in native configuration.',
			ACCOUNT_CHANGED: 'The account changed. Reconfigure and explicitly refresh discovery.',
			SCOPES_CHANGED: 'Account permissions changed. Reconfigure before refreshing discovery.',
			OFFLINE: 'Discovery could not reach the service. Check connectivity and explicitly retry.',
			DISCOVERY_UNAVAILABLE: 'Cross-device status or discovery is unavailable. Settings shown may not be current; local-window controls remain separate.',
			RATE_LIMITED: 'Discovery was rate limited. Wait before explicitly refreshing.',
			TIMEOUT: 'The connectivity operation timed out. Check local status before retrying.',
			CANCELLED: 'The connectivity operation was cancelled.',
			INVALID_ENDPOINT: 'A discovered endpoint failed validation. It was not admitted for use.',
			BINDING_CHANGED: 'The candidate or account binding changed. Refresh discovery before pairing.',
			POLICY_DENIED: 'Remote policy denied this operation. Check source grants and target receive permission.',
			PRIVATE_ACCESS_REQUIRED: 'SDK private admission requires private-port access. No anonymous fallback was used.',
			CLEANUP_FAILED: 'Connectivity cleanup is incomplete. Retry cleanup before changing exposure.',
			MIGRATION_REQUIRED: 'An explicit hosting migration is required. Open discovery and hosting configuration.',
			PROTOCOL_INCOMPATIBLE: 'The peer uses an incompatible Mesh protocol. Update both devices before pairing.',
		}[code];
	}

	function formatTimestamp(value) {
		const date = new Date(value);
		return Number.isNaN(date.valueOf()) ? 'Unknown' : date.toLocaleString();
	}

	function isActionPending(action) {
		return state.pendingActions.has(action)
			|| (promptActions.has(action) && [...state.pendingActions].some((pending) => promptActions.has(pending)));
	}

	function isOutboundMessage(value) {
		if (!isRecord(value) || value.version !== version || typeof value.uiInstanceId !== 'string') {
			return false;
		}
		if (value.pendingActions !== undefined && (!Array.isArray(value.pendingActions)
			|| value.pendingActions.length > dashboardActions.size
			|| new Set(value.pendingActions).size !== value.pendingActions.length
			|| value.pendingActions.some((action) => !dashboardActions.has(action)))) {
			return false;
		}
		if (value.type === 'dashboard.error') {
			return isExactRecord(value, ['version', 'uiInstanceId', 'type', 'code', 'message'], ['pendingActions'])
				&& typeof value.message === 'string'
				&& [
					'INVALID_MESSAGE', 'ACTION_FAILED', 'UNSAFE_VIEW_MODEL', 'WINDOW_NAME_CONFLICT',
					'WINDOW_NAME_INVALID', 'PEER_DELEGATION_DISABLED', 'WORKSPACE_SELECTION_AMBIGUOUS',
					'POLICY_FORBIDDEN', 'STALE_ACTION', 'TASK_NOT_FOUND',
				].includes(value.code);
		}
		return value.type === 'dashboard.snapshot'
			&& isExactRecord(value, ['version', 'uiInstanceId', 'type', 'model'], ['pendingActions'])
			&& isExactRecord(value.model, [
				'device', 'listener', 'broker', 'thisWindow', 'connectivity', 'deviceTree',
				'localNodes', 'savedAuthorizations', 'outgoingTasks', 'incomingTasks', 'errors',
			])
			&& isConnectivityViewModel(value.model.connectivity)
			&& isDeviceTree(value.model.deviceTree);
	}

	function isDeviceTree(value) {
		if (!Array.isArray(value) || value.length > 33 || textEncoder.encode(JSON.stringify(value)).byteLength > 512 * 1024) {
			return false;
		}
		const keys = new Set();
		const remember = (key) => {
			if (keys.has(key)) {
				return false;
			}
			keys.add(key);
			return true;
		};
		for (const device of value) {
			if (
				!isExactRecord(device, ['key', 'name', 'locality', 'state', 'nodes'])
				|| !isTreeKey(device.key)
				|| !isTreeLabel(device.name)
				|| !['local', 'remote'].includes(device.locality)
				|| !['connecting', 'online', 'busy', 'offline', 'authFailed', 'incompatible', 'unknown'].includes(device.state)
				|| !Array.isArray(device.nodes)
				|| device.nodes.length > 128
				|| !remember(device.key)
			) {
				return false;
			}
			for (const node of device.nodes) {
				if (
					!isExactRecord(node, ['key', 'label', 'thisWindow', 'status', 'workspaces'])
					|| !isTreeKey(node.key)
					|| !isTreeLabel(node.label)
					|| typeof node.thisWindow !== 'boolean'
					|| !['online', 'busy', 'offline', 'conflict', 'draining'].includes(node.status)
					|| !Array.isArray(node.workspaces)
					|| node.workspaces.length > 32
					|| !remember(node.key)
					|| (node.thisWindow && device.locality !== 'local')
				) {
					return false;
				}
				for (const workspace of node.workspaces) {
					if (
						!isExactRecord(
							workspace,
							[
								'key', 'name', 'claimStatus', 'enabled', 'busy', 'acceptsIncoming',
								'allowlisted', 'gateState', 'canDelegate', 'incomingPeers',
							],
							['delegateActionHandle', 'allowActionHandle', 'receiveActionHandle', 'receiveAction'],
						)
						|| !isTreeKey(workspace.key)
						|| !isTreeLabel(workspace.name)
						|| !['claimed', 'readOnly', 'conflict'].includes(workspace.claimStatus)
						|| !['allowed', 'notAllowed', 'notAccepting', 'offline', 'multiWorkspace', 'notClaimed', 'unavailable', 'self'].includes(workspace.gateState)
						|| !['enabled', 'busy', 'acceptsIncoming', 'allowlisted', 'canDelegate'].every((key) => typeof workspace[key] === 'boolean')
						|| !Array.isArray(workspace.incomingPeers)
						|| workspace.incomingPeers.length > 32
						|| !remember(workspace.key)
					) {
						return false;
					}
					if ((workspace.canDelegate) !== isActionHandle(workspace.delegateActionHandle)) {
						return false;
					}
					if (workspace.canDelegate && (node.thisWindow || !workspace.enabled || workspace.busy
						|| workspace.claimStatus !== 'claimed' || workspace.gateState !== 'allowed')) {
						return false;
					}
					if ((workspace.receiveAction === undefined) !== (workspace.receiveActionHandle === undefined)) {
						return false;
					}
					if (workspace.receiveAction !== undefined && !['setAcceptIncoming', 'setRemoteReceive'].includes(workspace.receiveAction)) {
						return false;
					}
					if (workspace.allowActionHandle !== undefined && !isActionHandle(workspace.allowActionHandle)) {
						return false;
					}
					if (workspace.receiveActionHandle !== undefined && !isActionHandle(workspace.receiveActionHandle)) {
						return false;
					}
					if (((workspace.receiveActionHandle !== undefined || workspace.incomingPeers.length > 0)
						&& (!node.thisWindow || device.locality !== 'local'))
						|| (node.thisWindow && workspace.allowActionHandle !== undefined)) {
						return false;
					}
					for (const peer of workspace.incomingPeers) {
						if (
							!isExactRecord(peer, ['key', 'label', 'autoAccept', 'actionHandle'])
							|| !isTreeKey(peer.key)
							|| !isTreeLabel(peer.label)
							|| typeof peer.autoAccept !== 'boolean'
							|| !isActionHandle(peer.actionHandle)
							|| !remember(peer.key)
						) {
							return false;
						}
					}
				}
			}
		}
		return true;
	}

	function isConnectivityViewModel(value) {
		if (
			!isExactRecord(value, [
				'discoveryEnabled', 'delegationEnabled', 'strictPolicyActivated', 'publishEnabled',
				'hostingBackend', 'migrationPending', 'accountProvider', 'claimedWorkspaceCount',
				'receivingWorkspaceCount', 'state', 'truncated', 'candidates', 'incomingPeers',
			], ['error'])
			|| ![
				'discoveryEnabled', 'delegationEnabled', 'strictPolicyActivated',
				'publishEnabled', 'migrationPending', 'truncated',
			].every((key) => typeof value[key] === 'boolean')
			|| !['cli', 'sdk'].includes(value.hostingBackend)
			|| !['none', 'github', 'microsoft'].includes(value.accountProvider)
			|| !['disabled', 'authRequired', 'discovering', 'ready', 'error'].includes(value.state)
			|| !['claimedWorkspaceCount', 'receivingWorkspaceCount'].every((key) =>
				Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 32)
			|| (value.error !== undefined && ![
				'DISABLED', 'AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'SCOPES_CHANGED', 'OFFLINE',
				'DISCOVERY_UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT', 'CANCELLED', 'INVALID_ENDPOINT',
				'BINDING_CHANGED', 'POLICY_DENIED', 'PRIVATE_ACCESS_REQUIRED', 'CLEANUP_FAILED',
				'MIGRATION_REQUIRED', 'PROTOCOL_INCOMPATIBLE',
			].includes(value.error))
			|| !Array.isArray(value.candidates) || value.candidates.length > 10
			|| !Array.isArray(value.incomingPeers) || value.incomingPeers.length > 256
		) {
			return false;
		}
		for (const candidate of value.candidates) {
			if (
				!isExactRecord(candidate, ['actionHandle', 'label', 'hostHint', 'stale', 'admission'])
				|| !isActionHandle(candidate.actionHandle)
				|| typeof candidate.label !== 'string' || !/^Candidate [0-9a-f]{8}$/u.test(candidate.label)
				|| !['online', 'offline', 'unknown'].includes(candidate.hostHint)
				|| typeof candidate.stale !== 'boolean'
				|| !['legacy-mesh-auth', 'private-port-token'].includes(candidate.admission)
			) {
				return false;
			}
		}
		for (const peer of value.incomingPeers) {
			if (
				!isExactRecord(peer, ['actionHandle', 'label', 'state', 'cleanupPending'])
				|| !isActionHandle(peer.actionHandle)
				|| typeof peer.label !== 'string' || !/^Peer [0-9a-f]{8}$/u.test(peer.label)
				|| !['active', 'pending', 'revoked'].includes(peer.state)
				|| typeof peer.cleanupPending !== 'boolean'
			) {
				return false;
			}
		}
		return true;
	}

	function isRecord(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value);
	}

	function isExactRecord(value, required, optional) {
		const extras = optional || [];
		return isRecord(value)
			&& required.every((key) => Object.hasOwn(value, key))
			&& Object.keys(value).every((key) => required.includes(key) || extras.includes(key));
	}

	function isActionHandle(value) {
		return typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/u.test(value);
	}

	function isTreeKey(value) {
		return typeof value === 'string' && /^tree-[1-9][0-9]{0,8}$/u.test(value);
	}

	function isTreeLabel(value) {
		return typeof value === 'string' && value.length > 0 && textEncoder.encode(value).byteLength <= 256;
	}
}());
