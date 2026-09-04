(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const uiInstanceId = document.body.dataset.uiInstanceId;
	const version = 6;
	const controls = new Set();
	let pending = false;

	document.querySelector('button[data-action="refresh"]').addEventListener('click', () => {
		postAction('refresh');
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!isOutboundMessage(message) || message.uiInstanceId !== uiInstanceId) {
			return;
		}
		pending = false;
		if (message.type === 'dashboard.error') {
			setText(document.getElementById('announcement'), message.message);
			return;
		}
		render(message.model);
	});

	vscode.postMessage({ version, uiInstanceId, type: 'ready' });

	function postAction(action, fields) {
		if (pending) {
			return;
		}
		pending = true;
		setControlsDisabled(true);
		setText(document.getElementById('announcement'), 'Applying Dashboard action.');
		vscode.postMessage({ version, uiInstanceId, type: 'action', action, ...(fields || {}) });
	}

	function render(model) {
		controls.clear();
		renderDevice(model.device, model.broker);
		renderThisWindow(model.thisWindow);
		renderAcceptIncoming(model.thisWindow);
		renderListener(model.listener);
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
		setText(document.getElementById('announcement'), 'Dashboard refreshed.');
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
		const checkbox = registerControl(document.createElement('input'));
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
				'Enable Peer Delegation Preview to make this control available.',
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
			const checkbox = registerControl(document.createElement('input'));
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
		const button = registerControl(document.createElement('button'));
		button.type = 'button';
		button.disabled = disabled === true;
		if (dangerous) {
			button.className = 'danger';
		}
		button.addEventListener('click', () => postAction(action, fields));
		setText(button, label);
		return button;
	}

	function registerControl(control) {
		controls.add(control);
		return control;
	}

	function setControlsDisabled(disabled) {
		for (const control of controls) {
			control.disabled = disabled;
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
		return value && typeof value === 'object' && value.version === version
			&& typeof value.uiInstanceId === 'string'
			&& (value.type === 'dashboard.snapshot' || value.type === 'dashboard.error');
	}
}());
