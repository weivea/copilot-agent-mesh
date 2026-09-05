(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const uiInstanceId = document.body.dataset.uiInstanceId;
	const version = 7;
	const controls = new Set();
	const controlActions = new WeakMap();
	const baseDisabled = new WeakMap();
	const connectivityActions = new Set([
		'configureConnectivity', 'refreshDiscovery', 'pairDiscoveredPeer',
		'configureRemotePolicy', 'revokeIncomingPeer', 'retryConnectivityCleanup',
	]);
	const dashboardActions = new Set([
		...connectivityActions, 'configureDevice', 'renameWindow', 'startListener', 'stopListener',
		'copyConnectionUrl', 'setAcceptIncoming', 'setPeerAllowed', 'cancelOutgoingTask', 'cancelIncomingTask', 'refresh',
	]);
	let pendingActions = new Set();
	let actionFailure;

	document.querySelector('button[data-action="refresh"]').addEventListener('click', () => {
		postAction('refresh');
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!isOutboundMessage(message) || message.uiInstanceId !== uiInstanceId) {
			return;
		}
		pendingActions = new Set(message.pendingActions || []);
		if (message.type === 'dashboard.error') {
			actionFailure = message.message;
			setText(document.getElementById('operationStatus'), message.message);
			setText(document.getElementById('announcement'), message.message);
			updateControls();
			return;
		}
		render(message.model);
	});

	vscode.postMessage({ version, uiInstanceId, type: 'ready' });

	function postAction(action, fields) {
		if (isActionPending(action)) {
			return;
		}
		pendingActions.add(action);
		actionFailure = undefined;
		updateControls();
		const progress = connectivityActions.has(action)
			? 'Applying cross-device action. Complete any native prompts in the Broker owner window; this may take up to three minutes.'
			: 'Applying Dashboard action.';
		setText(document.getElementById('operationStatus'), progress);
		setText(document.getElementById('announcement'), progress);
		vscode.postMessage({ version, uiInstanceId, type: 'action', action, ...(fields || {}) });
	}

	function render(model) {
		controls.clear();
		const refresh = registerControl(document.querySelector('button[data-action="refresh"]'), 'refresh');
		refresh.disabled = false;
		renderDevice(model.device, model.broker);
		renderThisWindow(model.thisWindow);
		renderAcceptIncoming(model.thisWindow);
		renderListener(model.listener);
		renderConnectivity(model.connectivity, !model.errors.some((error) =>
			error.code === 'CONNECTIVITY_UNAVAILABLE' || error.code === 'DASHBOARD_SERVICES_UNAVAILABLE'));
		renderCollection('localNodes', model.localNodes, renderLocalNode, peerEmptyMessage(model.thisWindow));
		renderCollection(
			'savedAuthorizations',
			model.savedAuthorizations,
			renderSavedAuthorization,
			'No saved offline authorizations.',
		);
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
		renderCollection('errors', model.errors, renderError, '');
		for (const control of controls) {
			baseDisabled.set(control, control.disabled);
		}
		updateControls();
		const progress = pendingActions.size === 0 ? '' : [...pendingActions].some((action) => connectivityActions.has(action))
			? 'Applying cross-device action. Complete any native prompts in the Broker owner window; task cancellation remains available.'
			: 'Applying Dashboard action.';
		setText(document.getElementById('operationStatus'), actionFailure || progress);
		setText(document.getElementById('announcement'), actionFailure || progress || 'Dashboard refreshed.');
	}

	function renderThisWindow(thisWindow) {
		const root = reset(document.getElementById('thisWindow'));
		root.append(
			definition('Window name', thisWindow.name),
			definition('Workspace', thisWindow.workspaceName),
			definition('Claim', claimLabel(thisWindow.claimStatus)),
			definition('Agent Host', thisWindow.agentHost.label),
			definition('Peer Preview', thisWindow.previewEnabled ? 'Enabled' : 'Disabled'),
		);
		if (thisWindow.agentHost.detail) {
			root.append(textElement('p', thisWindow.agentHost.detail, 'detail'));
		}
		if (thisWindow.detail) {
			root.append(textElement('p', thisWindow.detail, 'action-hint'));
		}
		root.append(actionButton('Rename this window', 'renameWindow', undefined, !thisWindow.canRename));
	}

	function renderAcceptIncoming(thisWindow) {
		const root = reset(document.getElementById('acceptIncoming'));
		const label = document.createElement('label');
		label.className = 'toggle';
		const checkbox = registerControl(document.createElement('input'), 'setAcceptIncoming');
		checkbox.type = 'checkbox';
		checkbox.checked = thisWindow.acceptsIncoming;
		checkbox.disabled = !thisWindow.canSetAcceptIncoming;
		checkbox.addEventListener('change', () => {
			postAction('setAcceptIncoming', {
				actionHandle: thisWindow.acceptActionHandle,
				enabled: checkbox.checked,
			});
		});
		label.append(checkbox, textElement(
			'span',
			thisWindow.acceptsIncoming ? 'Accepting incoming tasks' : 'Not accepting incoming tasks',
		));
		root.append(label);
		if (!thisWindow.previewEnabled) {
			root.append(textElement(
				'p',
				'This local checkbox is disabled while Peer Delegation Preview is off. Use Cross-device → Configure strict remote policy to change the shared receive gate without enabling local delegation.',
				'action-hint',
			));
		} else if (!thisWindow.canSetAcceptIncoming) {
			root.append(textElement(
				'p',
				'Select exactly one claimed Workspace before changing this policy.',
				'action-hint',
			));
		}
	}

	function renderDevice(device, broker) {
		const root = reset(document.getElementById('device'));
		root.append(
			definition('Name', device.name),
			definition('Platform', `${device.platform} ${device.architecture}`),
			definition('VS Code', device.vscodeVersion),
			definition('Extension', device.extensionVersion),
			definition('Broker role', broker.role === 'owner' ? 'Owner' : 'Contender'),
			definition('Broker state', broker.state),
			actionButton('Configure device name', 'configureDevice'),
		);
		if (broker.error) {
			root.append(renderError(broker.error));
		}
	}

	function renderListener(listener) {
		const root = reset(document.getElementById('listener'));
		root.append(statusLine('Listener', listener.state));
		for (const [name, component] of [
			['Gateway', listener.gateway],
			['Tunnel', listener.tunnel],
		]) {
			const row = document.createElement('div');
			row.className = 'component';
			row.append(statusLine(name, component.label));
			if (component.detail) {
				row.append(textElement('p', component.detail, 'detail'));
			}
			root.append(row);
		}
		const actions = document.createElement('div');
		actions.className = 'actions';
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
		const setting = (value) => statusAvailable ? value : 'Unknown';
		root.append(
			definition('Discovery state', connectivityStateLabel(connectivity.state)),
			definition('Account discovery', setting(connectivity.discoveryEnabled ? 'Enabled' : 'Disabled (default)')),
			definition('New remote tasks', setting(connectivity.delegationEnabled ? 'Enabled, subject to policy' : 'Disabled')),
			definition('Strict remote policy', setting(connectivity.strictPolicyActivated ? 'Activated — latched on' : 'Not activated')),
			definition('Discovery publishing', setting(connectivity.publishEnabled ? 'Enabled' : 'Disabled')),
			definition('Hosting selection', setting(connectivity.hostingBackend === 'sdk' ? 'SDK private hosting' : 'Legacy CLI hosting')),
			definition('Account provider', setting({ none: 'None selected', github: 'GitHub', microsoft: 'Microsoft' }[connectivity.accountProvider])),
			definition('Claimed Workspaces', setting(connectivity.claimedWorkspaceCount)),
			definition('Receiving Workspaces', setting(connectivity.receivingWorkspaceCount)),
			textElement(
				'p',
				'Receiving Workspaces counts shared receive gates, including when local Peer Delegation Preview is off. Configure strict remote policy to change them without enabling local delegation.',
				'detail',
			),
			textElement('p', statusAvailable ? admissionLabel(
				connectivity.hostingBackend === 'sdk' ? 'private-port-token' : 'legacy-mesh-auth',
			) : 'Connectivity settings are unavailable. Current hosting and admission cannot be determined from this snapshot.', 'notice'),
			textElement(
				'p',
				'Disabling remote delegation blocks new remote tasks; it does not cancel tasks already accepted or remove saved pairings. Local-window delegation is separate.',
				'detail',
			),
			textElement(
				'p',
				!statusAvailable
					? 'Once activated, strict remote policy remains enforced when remote delegation is disabled.'
					: connectivity.strictPolicyActivated
					? 'The strict-policy latch stays enforced even when remote delegation is disabled. Disabling the feature does not restore legacy grants.'
					: 'Strict remote policy has not been activated. Pairing alone is not a Workspace grant.',
				'detail',
			),
			textElement(
				'p',
				'Configure account, discovery, delegation, publishing, or hosting in native VS Code prompts. SDK private hosting never silently falls back to the legacy CLI; migration or fallback must be explicitly selected.',
				'detail',
			),
		);
		if (connectivity.migrationPending) {
			root.append(textElement(
				'p',
				'Hosting migration pending. Finish the previous exposure cleanup before switching backends. Open configuration or retry connectivity cleanup.',
				'action-hint notice',
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
				'Cross-device results reached the safe display limit. Use native configuration to select an incoming peer outside this bounded view.',
				'action-hint',
			));
		}
		if (!connectivity.publishEnabled) {
			root.append(textElement(
				'p',
				'Stopping advertisement updates does not unpublish existing service records. Use native configuration to stop and delete the exact owned resource to withdraw a candidate.',
				'detail',
			));
		}
		const actions = document.createElement('div');
		actions.className = 'actions';
		actions.append(
			actionButton('Configure discovery and hosting…', 'configureConnectivity'),
			actionButton(
				'Refresh account discovery',
				'refreshDiscovery',
				undefined,
				!connectivity.discoveryEnabled || connectivity.state === 'discovering',
			),
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
		root.append(
			actions,
			textElement(
				'p',
				'Remote policy uses only Workspaces owned by this calling window, selected in the Broker owner’s native picker. Target receive permission is a separate gate. Prompts open in the Broker owner window, including requests from non-owner windows.',
				'detail',
			),
		);
		renderCollection(
			'discoveryCandidates',
			connectivity.candidates,
			(candidate) => renderDiscoveryCandidate(candidate, connectivity.discoveryEnabled),
			!statusAvailable
				? 'Discovery status is unavailable. Refresh local status after Broker reconnection.'
				: connectivity.discoveryEnabled
				? 'No discovery candidates. Refresh account discovery explicitly; a Dashboard refresh does not discover devices.'
				: 'Account discovery is disabled. Configure it explicitly to look for candidates.',
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
			definition('Host hint', { online: 'Online', offline: 'Offline', unknown: 'Unknown' }[candidate.hostHint]),
			textElement('p', admissionLabel(candidate.admission), 'detail'),
			textElement(
				'p',
				candidate.stale
					? 'This candidate is stale. Refresh account discovery before pairing.'
					: 'A host hint is not an executable worker or a task grant. Pairing requires an invitation in a native VS Code prompt.',
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
			definition('Admission cleanup', peer.cleanupPending ? 'Pending — retry required' : 'No pending cleanup'),
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

	function admissionLabel(admission) {
		return admission === 'private-port-token'
			? 'SDK private admission: private-port access is required in addition to Mesh authentication.'
			: 'Legacy CLI admission: the outer port is anonymous; Mesh authentication is still required.';
	}

	function connectivityStateLabel(state) {
		return {
			disabled: 'Disabled',
			authRequired: 'Sign-in required (configure explicitly)',
			discovering: 'Discovering',
			ready: 'Ready (discovery only, not worker readiness)',
			error: 'Unavailable or error — see details',
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

	function renderLocalNode(node) {
		const card = itemCard(node.windowLabel, node.online ? 'Online' : 'Offline');
		card.append(
			definition('Workspace', node.workspaceName),
			definition('Accepts incoming', node.acceptsIncoming ? 'Yes' : 'No'),
			definition('Busy', node.busy ? 'Yes' : 'No'),
			definition('Claim gate', claimLabel(node.claimState)),
			definition('Delegation gate', gateLabel(node.gateState)),
		);
		const fix = gateFix(node);
		if (fix) {
			card.append(textElement('p', fix, 'action-hint'));
		}
		if (node.self) {
			card.append(textElement('p', 'This is the current Window Node.', 'detail'));
		} else {
			const label = document.createElement('label');
			label.className = 'toggle';
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
			label.append(checkbox, textElement('span', 'Allow this Workspace as a target'));
			card.append(label);
		}
		return card;
	}

	function renderSavedAuthorization(authorization) {
		const card = itemCard(authorization.windowLabel, 'Saved');
		card.append(
			definition('Workspace', authorization.workspaceName),
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
		const card = itemCard(task.title, task.state);
		card.append(
			definition(counterpartLabel, task.counterpartLabel),
			definition('Workspace', task.workspaceName),
			definition('Started', formatTimestamp(task.startedAt)),
			definition('Task ID', task.shortId),
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
		card.append(textElement('strong', title), statusLine('', status));
		return card;
	}

	function statusLine(label, value) {
		const row = document.createElement('span');
		row.className = `status status-${String(value).toLowerCase()}`;
		setText(row, label ? `${label}: ${value}` : value);
		return row;
	}

	function definition(label, value) {
		const row = document.createElement('div');
		row.className = 'definition';
		row.append(textElement('span', label, 'label'), textElement('span', value));
		return row;
	}

	function actionButton(label, action, fields, disabled, dangerous) {
		const button = registerControl(document.createElement('button'), action);
		button.type = 'button';
		button.disabled = disabled === true;
		if (dangerous) {
			button.className = 'danger';
		}
		button.addEventListener('click', () => postAction(action, fields));
		setText(button, label);
		return button;
	}

	function registerControl(control, action) {
		controls.add(control);
		controlActions.set(control, action);
		return control;
	}

	function isActionPending(action) {
		return pendingActions.has(action)
			|| (connectivityActions.has(action) && [...pendingActions].some((pending) => connectivityActions.has(pending)));
	}

	function updateControls() {
		for (const control of controls) {
			control.disabled = baseDisabled.get(control) === true || isActionPending(controlActions.get(control));
		}
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
		element.textContent = String(value);
	}

	function peerEmptyMessage(thisWindow) {
		return thisWindow.previewEnabled
			? 'No local Window Node candidates are available.'
			: 'Peer candidates are unavailable while Peer Delegation Preview is disabled.';
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
			allowed: 'Ready',
			notAllowed: 'Not allowed by this Workspace',
			notAccepting: 'Target is not accepting',
			offline: 'Target is offline',
			multiWorkspace: 'Target has multiple Workspaces',
			notClaimed: 'Target has no claimed Workspace',
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

	function formatTimestamp(value) {
		const date = new Date(value);
		return Number.isNaN(date.valueOf()) ? 'Unknown' : date.toLocaleString();
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
				'device', 'listener', 'broker', 'thisWindow', 'connectivity',
				'localNodes', 'savedAuthorizations', 'outgoingTasks', 'incomingTasks', 'errors',
			])
			&& isConnectivityViewModel(value.model.connectivity);
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

	function isExactRecord(value, required, optional = []) {
		return isRecord(value) && required.every((key) => Object.hasOwn(value, key))
			&& Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
	}

	function isActionHandle(value) {
		return typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/u.test(value);
	}
}());
