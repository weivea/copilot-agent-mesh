import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	DASHBOARD_MANAGEMENT_ACTIONS,
	MANAGEMENT_BOOLEAN_ACTIONS,
	type DashboardManagement,
} from '../../shared/protocol';
import type { DashboardSnapshot } from '../ui/DashboardFacade';
import { createDashboardActionHandle } from '../ui/DashboardActionHandle';
import {
	assertSafeDashboardOutboundMessage,
	DASHBOARD_MESSAGE_VERSION,
	parseDashboardInboundMessage,
} from '../ui/DashboardMessages';
import { DashboardPresenter } from '../ui/DashboardPresenter';

const brokerHandle = '11111111-1111-4111-8111-111111111111';
const uiHandle = 'A'.repeat(32);

test('generated aliases retry credential-like text and collisions without weakening the outbound guard', () => {
	const candidates = [`ghp_${'A'.repeat(28)}`, uiHandle, 'B'.repeat(32)];
	const used = new Set([uiHandle]);
	let calls = 0;
	const handle = createDashboardActionHandle(
		(candidate) => used.has(candidate),
		() => {
			const candidate = candidates[calls++];
			assert.ok(candidate);
			return candidate;
		},
	);
	assert.equal(handle, 'B'.repeat(32));
	assert.equal(calls, 3);
});

function snapshot(management?: DashboardManagement): DashboardSnapshot {
	const component = { state: 'stopped' as const, label: 'Stopped' };
	return {
		device: {
			name: 'Local laptop', platform: 'macOS', architecture: 'arm64',
			workerSupported: true, vscodeVersion: '1.103', extensionVersion: '0.5.0',
		},
		listener: {
			state: 'stopped', gateway: component, tunnel: component, agentHost: component,
			canStart: true, canStop: false, canCopyConnectionUrl: false,
		},
		thisWindow: {
			name: 'Editor', workspaceName: 'Project', claimStatus: 'claimed',
			previewEnabled: true, canRename: true, acceptsIncoming: false, canSetAcceptIncoming: false,
			agentHost: { source: 'unavailable', label: 'On demand', degraded: false },
		},
		workspaces: [], peers: [], tasks: [], errors: [],
		...(management === undefined ? {} : { management }),
	};
}

function management(): DashboardManagement {
	return {
		available: true, truncated: false, accountActionHandle: brokerHandle,
		devices: [{
			key: 'manage-device-1', name: 'Other laptop', state: 'offline', cleanupPending: false,
			activeTaskCount: 0, deleteActionHandle: brokerHandle, revokeActionHandle: brokerHandle,
		}],
		workspaces: [{
			key: 'manage-workspace-1', name: 'Project', enabled: true, acceptsIncoming: false,
			receiveActionHandle: brokerHandle,
			incomingPeers: [{
				key: 'manage-peer-1', name: 'Other laptop', allowed: false, autoAccept: false,
				allowActionHandle: brokerHandle,
			}],
		}],
		targets: [{
			key: 'manage-target-1', deviceName: 'Other laptop', windowName: 'Editor',
			workspaceName: 'Target', locality: 'remote', online: false, allSourcesAllowed: 'none',
			sources: [{ sourceKey: 'manage-workspace-1', allowed: false }],
		}],
	};
}

test('unavailable management is explicit and contains no fabricated setting actions', () => {
	const model = new DashboardPresenter().present(snapshot());
	assert.deepEqual(model.management, {
		available: false, truncated: false, devices: [], workspaces: [], targets: [],
	});
	assertSafeDashboardOutboundMessage({
		version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'view', type: 'dashboard.snapshot', model,
	});
});

test('management actions accept only their handle and exact boolean shape', () => {
	const booleanActions = new Set<string>(MANAGEMENT_BOOLEAN_ACTIONS);
	for (const action of DASHBOARD_MANAGEMENT_ACTIONS) {
		const input = {
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'view', type: 'action', action,
			actionHandle: uiHandle, ...(booleanActions.has(action) ? { enabled: false } : {}),
		};
		assert.deepEqual(parseDashboardInboundMessage(input), input, action);
		assert.equal(parseDashboardInboundMessage({ ...input, actionHandle: brokerHandle }), undefined, action);
		assert.equal(parseDashboardInboundMessage({ ...input, sourceKey: 'manage-workspace-2' }), undefined, action);
		assert.equal(parseDashboardInboundMessage({ ...input, deviceId: brokerHandle }), undefined, action);
		assert.equal(parseDashboardInboundMessage({ ...input, actionHandle: undefined }), undefined, action);
		assert.equal(parseDashboardInboundMessage({
			...input, enabled: booleanActions.has(action) ? undefined : true,
		}), undefined, action);
	}
});

test('settings navigation and registration do not accept mutation handles or user identities', () => {
	for (const action of ['openAdvancedSettings', 'registerWorkspace']) {
		const input = { version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'view', type: 'action', action };
		assert.deepEqual(parseDashboardInboundMessage(input), input);
		assert.equal(parseDashboardInboundMessage({ ...input, actionHandle: uiHandle }), undefined);
		assert.equal(parseDashboardInboundMessage({ ...input, enabled: true }), undefined);
		assert.equal(parseDashboardInboundMessage({ ...input, workspaceIdentity: 'untrusted' }), undefined);
	}
});

test('management is schema validated before raw Broker handles can be aliased', () => {
	const source = management();
	const presenter = new DashboardPresenter();
	assert.equal(presenter.present(snapshot(source)).management.devices[0].deleteActionHandle, brokerHandle);
	assert.throws(() => presenter.present(snapshot({ ...source, accountActionHandle: uiHandle })));
	assert.throws(() => presenter.present(snapshot({
		...source, devices: [{ ...source.devices[0], key: 'a workspace name' }],
	})));
	const injected = { ...source, workspaceIdentity: 'private-identity' };
	assert.throws(() => presenter.present(snapshot(injected)));
});

test('management names and target metadata are redacted before presentation', () => {
	const source = management();
	const model = new DashboardPresenter().present(snapshot({
		...source,
		devices: [{ ...source.devices[0], name: '/Users/private/device' }],
		workspaces: [{
			...source.workspaces[0], name: '/Users/private/project',
			incomingPeers: [{ ...source.workspaces[0].incomingPeers[0], name: 'api_key=private-example' }],
		}],
		targets: [{ ...source.targets[0], windowName: '/Users/private/window', workspaceName: 'C:\\private\\project' }],
	}));
	const text = JSON.stringify(model.management);
	assert.doesNotMatch(text, /\/Users\/private|private-example|C:\\\\private/u);
});

test('saved-device deletion never appears available for active or unproven task state', () => {
	const source = management();
	const presenter = new DashboardPresenter();
	for (const activeTaskCount of [1, undefined]) {
		assert.throws(() => presenter.present(snapshot({
			...source, devices: [{ ...source.devices[0], activeTaskCount }],
		})));
	}
});

test('outbound management rejects raw handles, unknown fields, secret names and oversized collections', () => {
	const presenter = new DashboardPresenter();
	const model = presenter.present(snapshot());
	const outbound = {
		version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'view', type: 'dashboard.snapshot' as const, model,
	};
	assertSafeDashboardOutboundMessage(outbound);
	assert.throws(() => assertSafeDashboardOutboundMessage({
		...outbound, model: { ...model, management: { ...model.management, accountActionHandle: brokerHandle } },
	}));
	assert.throws(() => assertSafeDashboardOutboundMessage({
		...outbound, model: { ...model, management: { ...model.management, devices: [{
			key: 'manage-device-1', name: 'api_key=private-example', state: 'offline', cleanupPending: false,
		}] } },
	}));
	const injected = { ...model.management, credentials: { password: 'private-example' } };
	assert.throws(() => assertSafeDashboardOutboundMessage({
		...outbound, model: { ...model, management: injected },
	}));
	assert.throws(() => assertSafeDashboardOutboundMessage({
		...outbound, model: { ...model, management: {
			...model.management,
			devices: Array.from({ length: 257 }, (_, index) => ({
				key: `manage-device-${index + 1}`, name: 'Other laptop', state: 'offline' as const, cleanupPending: false,
			})),
		} },
	}));
});
