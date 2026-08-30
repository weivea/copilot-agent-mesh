(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const uiInstanceId = document.body.dataset.uiInstanceId;
	const version = 3;

	document.addEventListener('click', (event) => {
		const button = event.target.closest('button[data-action]');
		if (!button) {
			return;
		}
		postAction(button.dataset);
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

	function postAction(data) {
		const action = data.action;
		const message = { version, uiInstanceId, type: 'action', action };
		if (data.targetId) {
			message.targetId = data.targetId;
		}
		for (const key of ['deviceId', 'nodeId', 'nodeInstanceId', 'peerId', 'workspaceId']) {
			if (data[key]) {
				message[key] = data[key];
			}
		}
		vscode.postMessage(message);
	}

	function render(model) {
		currentModel = { deviceId: model.device.deviceId || '' };
		renderDevice(model.device, model.broker);
		renderListener(model.listener);
		renderCollection('localNodes', model.localNodes, renderLocalNode, 'No local Window Nodes connected.');
		renderCollection('remoteDevices', model.remoteDevices, renderRemoteDevice, 'No remote devices configured.');
		renderCollection('tasks', model.tasks, renderTask, 'No delegated tasks.');
		renderCollection('collaborationRuns', model.collaborationRuns, renderCollaborationRun, model.collaborationPreview.enabled
			? 'No collaboration runs.'
			: 'Enable the same-device collaboration Preview setting to start a run.');
		const startCollaboration = document.getElementById('startCollaboration');
		startCollaboration.disabled = !model.collaborationPreview.canStart;
		startCollaboration.title = model.collaborationPreview.enabled
			? (model.collaborationPreview.canStart ? '' : 'Open and claim two different available local workspaces.')
			: 'Enable copilotAgentMesh.experimental.sameDeviceCollaboration.';
		renderCollection('errors', model.errors, renderError, '');
		setText(document.getElementById('announcement'), 'Dashboard refreshed.');
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
			definition('Takeover', broker.takeover),
			actionButton('Configure Name', 'configureDevice'),
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

	function renderWorkspace(workspace, target) {
		const card = itemCard(workspace.name, workspace.enabled ? (workspace.busy ? 'Busy' : 'Enabled') : 'Disabled');
		card.classList.add('nested');
		card.append(textElement('p', `Claim: ${workspace.claimStatus}`, 'detail'));
		if (workspace.capabilityTags.length > 0) {
			card.append(textElement('p', workspace.capabilityTags.join(', '), 'tags'));
		}
		if (workspace.activeTaskId) {
			card.append(textElement('p', 'An active task is using this workspace.', 'detail'));
		}
		if (workspace.claimStatus === 'claimed' && workspace.enabled && !workspace.busy) {
			card.append(actionButton('Run Task', 'runTask', undefined, false, {
				...target,
				workspaceId: workspace.workspaceId,
			}));
		}
		return card;
	}

	function renderLocalNode(node) {
		return renderNode(node, { deviceId: currentModel.deviceId }, node.thisWindow ? 'This Window' : undefined);
	}

	let currentModel = { deviceId: '' };

	function renderRemoteDevice(device) {
		const card = itemCard(device.name, device.state);
		for (const node of device.nodes) {
			card.append(renderNode(node, {
				deviceId: device.deviceId,
				peerId: device.peerId,
			}));
		}
		card.append(actionButton('Remove', 'removePeer', device.peerId, true));
		return card;
	}

	function renderNode(node, route, suffix) {
		const title = suffix ? `${node.label} · ${suffix}` : node.label;
		const card = itemCard(title, node.status);
		card.classList.add('node');
		if (node.workspaces.length === 0) {
			card.append(textElement('p', 'No claimed workspaces.', 'empty'));
		}
		for (const workspace of node.workspaces) {
			card.append(renderWorkspace(workspace, {
				...route,
				nodeId: node.nodeId,
				nodeInstanceId: node.nodeInstanceId,
			}));
		}
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

	function renderCollaborationRun(run) {
		const card = itemCard(run.title, run.status);
		for (const participant of run.participants) {
			card.append(textElement(
				'p',
				`${participant.role}: ${participant.nodeLabel} · ${participant.workspaceName}`,
				'detail',
			));
		}
		for (const task of run.tasks) {
			const dependency = task.dependsOn.length === 0
				? 'ready'
				: `depends on ${task.dependsOn.join(', ')}`;
			const line = `${task.role} ${task.kind}: ${task.status} · ${task.workspaceName} · ${dependency}`;
			card.append(textElement('p', line, 'phase'));
			if (task.validationStatus) {
				card.append(textElement('p', `Validation: ${task.validationStatus}`, 'detail'));
			}
			if (task.pendingInputId) {
				card.append(textElement(
					'p',
					`Waiting for input ${task.pendingInputId.slice(0, 8)}`,
					'action-hint',
				));
			}
			if (task.blockCode) {
				card.append(textElement('p', `Blocked: ${task.blockCode}`, 'action-hint'));
			}
			if (task.failureCode) {
				card.append(textElement('p', `Failed: ${task.failureCode}`, 'action-hint'));
			}
		}
		for (const artifact of run.artifacts) {
			card.append(textElement(
				'p',
				`Artifact: ${artifact.label} · ${artifact.mediaType} · ${artifact.contentLength} bytes · SHA-256 ${artifact.sha256.slice(0, 12)}…`,
				'detail',
			));
		}
		const actions = document.createElement('div');
		actions.className = 'actions';
		actions.append(actionButton('Refresh Run', 'getCollaboration', run.runId));
		if (run.canAnswer) {
			actions.append(actionButton('Answer Input', 'answerCollaboration', run.runId));
		}
		if (run.canCancel) {
			actions.append(actionButton('Cancel', 'cancelCollaboration', run.runId, true));
		}
		card.append(actions);
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

	function actionButton(label, action, targetId, dangerous, route) {
		const button = document.createElement('button');
		button.type = 'button';
		button.dataset.action = action;
		if (targetId) {
			button.dataset.targetId = targetId;
		}
		if (route) {
			for (const key of ['deviceId', 'nodeId', 'nodeInstanceId', 'peerId', 'workspaceId']) {
				if (route[key]) {
					button.dataset[key] = route[key];
				}
			}
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
