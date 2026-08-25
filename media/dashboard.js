(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const uiInstanceId = document.body.dataset.uiInstanceId;
	const version = 1;

	document.addEventListener('click', (event) => {
		const button = event.target.closest('button[data-action]');
		if (!button) {
			return;
		}
		postAction(button.dataset.action, button.dataset.targetId, button.dataset.peerId, button.dataset.workspaceId);
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!isOutboundMessage(message) || message.uiInstanceId !== uiInstanceId) {
			return;
		}
		if (message.type === 'dashboard.error') {
			setText(document.getElementById('announcement'), message.message);
			return;
		}
		render(message.model);
	});

	vscode.postMessage({ version, uiInstanceId, type: 'ready' });

	function postAction(action, targetId, peerId, workspaceId) {
		const message = { version, uiInstanceId, type: 'action', action };
		if (targetId) {
			message.targetId = targetId;
		}
		if (peerId) {
			message.peerId = peerId;
		}
		if (workspaceId) {
			message.workspaceId = workspaceId;
		}
		vscode.postMessage(message);
	}

	function render(model) {
		renderDevice(model.device);
		renderListener(model.listener);
		renderCollection('workspaces', model.workspaces, renderWorkspace, 'No workspaces registered.');
		renderCollection('peers', model.peers, renderPeer, 'No remote devices configured.');
		renderCollection('tasks', model.tasks, renderTask, 'No delegated tasks.');
		renderCollection('errors', model.errors, renderError, '');
		setText(document.getElementById('announcement'), 'Dashboard refreshed.');
	}

	function renderDevice(device) {
		const root = reset(document.getElementById('device'));
		root.append(
			definition('Name', device.name),
			definition('Platform', `${device.platform} ${device.architecture}`),
			definition('VS Code', device.vscodeVersion),
			definition('Extension', device.extensionVersion),
			actionButton('Configure Name', 'configureDevice'),
		);
	}

	function renderListener(listener) {
		const root = reset(document.getElementById('listener'));
		root.append(statusLine('Listener', listener.state));
		for (const [name, component] of [
			['Gateway', listener.gateway],
			['Tunnel', listener.tunnel],
			['Agent Host', listener.agentHost],
		]) {
			const row = document.createElement('div');
			row.className = 'component';
			row.append(statusLine(name, component.label));
			if (component.detail) {
				row.append(textElement('p', component.detail, 'detail'));
			}
			if (component.action) {
				row.append(textElement('p', component.action, 'action-hint'));
			}
			root.append(row);
		}
		const actions = document.createElement('div');
		actions.className = 'actions';
		if (listener.canStart) {
			actions.append(actionButton('Start', 'startListener'));
		}
		if (listener.canStop) {
			actions.append(actionButton('Stop', 'stopListener', undefined, true));
		}
		if (listener.canCopyConnectionUrl) {
			actions.append(actionButton('Copy Connection URL', 'copyConnectionUrl'));
		}
		root.append(actions);
	}

	function renderWorkspace(workspace) {
		const card = itemCard(workspace.name, workspace.enabled ? (workspace.busy ? 'Busy' : 'Enabled') : 'Disabled');
		if (workspace.capabilityTags.length > 0) {
			card.append(textElement('p', workspace.capabilityTags.join(', '), 'tags'));
		}
		if (workspace.activeTaskId) {
			card.append(textElement('p', 'An active task is using this workspace.', 'detail'));
		}
		card.append(actionButton('Remove', 'removeWorkspace', workspace.workspaceId, true));
		return card;
	}

	function renderPeer(peer) {
		const card = itemCard(peer.name, peer.state);
		const details = [];
		if (peer.latencyMs !== undefined) {
			details.push(`${peer.latencyMs} ms`);
		}
		if (peer.lastSeenLabel) {
			details.push(peer.lastSeenLabel);
		}
		details.push(`${peer.workspaceCount} workspaces`);
		card.append(textElement('p', details.join(' · '), 'detail'));
		card.append(
			actionButton('Run Task', 'runTask', undefined, false, peer.peerId),
			actionButton('Remove', 'removePeer', peer.peerId, true),
		);
		return card;
	}

	function renderTask(task) {
		const card = itemCard(task.title, task.state);
		card.append(textElement('p', `${task.peerName} · ${task.workspaceName}`, 'detail'));
		if (task.phase) {
			card.append(textElement('p', task.phase, 'phase'));
		}
		if (task.summary) {
			card.append(textElement('p', task.summary, 'summary'));
		}
		if (task.summaryTruncated) {
			card.append(textElement('p', 'Summary truncated for display.', 'action-hint'));
		}
		if (task.error) {
			card.append(renderError(task.error));
		}
		if (task.needsInput) {
			card.append(actionButton('Answer Input', 'answerTaskInput', task.taskId));
		}
		if (task.canCancel) {
			card.append(actionButton('Cancel', 'cancelTask', task.taskId, true));
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

	function actionButton(label, action, targetId, dangerous, peerId, workspaceId) {
		const button = document.createElement('button');
		button.type = 'button';
		button.dataset.action = action;
		if (targetId) {
			button.dataset.targetId = targetId;
		}
		if (peerId) {
			button.dataset.peerId = peerId;
		}
		if (workspaceId) {
			button.dataset.workspaceId = workspaceId;
		}
		if (dangerous) {
			button.className = 'danger';
		}
		setText(button, label);
		return button;
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

	function isOutboundMessage(value) {
		return value && typeof value === 'object' && value.version === version
			&& typeof value.uiInstanceId === 'string'
			&& (value.type === 'dashboard.snapshot' || value.type === 'dashboard.error');
	}
}());
