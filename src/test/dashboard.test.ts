import * as assert from 'assert';
import { readFile } from 'fs/promises';
import { runInNewContext } from 'node:vm';

import * as vscode from 'vscode';

import {
	CONNECTIVITY_ACTIONS,
	connectivitySnapshotSchema,
	DISABLED_CONNECTIVITY_SNAPSHOT,
	timestampSchema,
	type ConnectivityAction,
	type ConnectivitySnapshot,
	type RemotePolicyAction,
} from '../../shared/protocol';
import type { ListenerSnapshot } from '../application/ListenerService';
import {
	ProductionDashboardBindings,
	ProductionDashboardBindingsOptions,
} from '../composition/ProductionDashboardBindings';
import { AgentMeshViewProvider } from '../ui/AgentMeshViewProvider';
import {
	DashboardActionError,
	DashboardFacade,
	DashboardServiceBindings,
	DashboardSnapshot,
	DashboardTaskTarget,
	ServiceDashboardFacade,
	UnavailableDashboardFacade,
} from '../ui/DashboardFacade';
import {
	assertSafeDashboardOutboundMessage,
	DASHBOARD_MESSAGE_VERSION,
	parseDashboardInboundMessage,
} from '../ui/DashboardMessages';
import { DashboardPresenter } from '../ui/DashboardPresenter';

suite('Dashboard', () => {
	test('configures a script-enabled webview with media-only resources and a strict CSP', () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();

		provider.resolveWebviewView(view);

		assert.strictEqual(view.webview.options.enableScripts, true);
		assert.deepStrictEqual(
			view.webview.options.localResourceRoots?.map((uri) => uri.fsPath),
			[vscode.Uri.joinPath(extension.extensionUri, 'media').fsPath],
		);
		assert.match(view.webview.html, /default-src 'none'/);
		assert.match(view.webview.html, /script-src 'nonce-[^']+'/);
		assert.ok(view.webview.html.includes(view.webview.cspSource));
		assert.ok(view.webview.html.includes('dashboard.js'));
		assert.ok(view.webview.html.includes('dashboard.css'));
		assert.ok(view.webview.html.includes('Workspace targets'));
		assert.ok(view.webview.html.includes('This device and Other devices'));
		assert.ok(view.webview.html.includes('id="tasks-heading">Tasks</h2>'));
		assert.ok(view.webview.html.includes('Settings and diagnostics'));
		assert.ok(view.webview.html.includes('Discovery candidates — not workers'));
		provider.dispose();
	});

	test('refresh preserves policy-control focus instead of moving it back into the tree or out of Settings', async () => {
		const media = await createDashboardMediaHarness();
		media.render(DISABLED_CONNECTIVITY_SNAPSHOT);
		media.treeItem('tree-3').focus();
		media.checkbox('Accept incoming tasks for this Workspace').focus();
		media.render(DISABLED_CONNECTIVITY_SNAPSHOT);
		assert.strictEqual(media.focusedElement(), media.checkbox('Accept incoming tasks for this Workspace'));
		media.button('Settings').click();
		media.render(DISABLED_CONNECTIVITY_SNAPSHOT);
		assert.strictEqual(media.focusedElement(), media.button('Settings'));
		assert.equal(media.element('settingsDrawer').hidden, false);
	});

	test('a same-named unbound Workspace cannot borrow the current Workspace receive action', async () => {
		const media = await createDashboardMediaHarness();
		const source = snapshot();
		const tree = structuredClone(source.deviceTree);
		assert.ok(tree);
		const current = tree[0].nodes[0].workspaces[0];
		tree[0].nodes[0].workspaces.push({
			...current, key: 'tree-15', receiveAction: undefined, receiveActionHandle: undefined, incomingPeers: [],
		});
		media.receive({
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'media-view',
			type: 'dashboard.snapshot', model: new DashboardPresenter().present({ ...source, deviceTree: tree }),
		});
		media.treeItem('tree-15').click();
		assert.equal(media.checkbox('Accept incoming tasks for this Workspace').disabled, true);
		assert.equal(media.messages.some((message) => message.type === 'action'), false);
	});

	test('media accepts the full supported node count rather than silently rejecting more than 32 windows', async () => {
		const media = await createDashboardMediaHarness();
		const source = snapshot();
		const tree = structuredClone(source.deviceTree);
		assert.ok(tree);
		const template = tree[0].nodes[0];
		tree[0].nodes.push(...Array.from({ length: 32 }, (_, index) => ({
			...template, key: `tree-${100 + index}`, label: `Window ${index + 1}`, thisWindow: false, workspaces: [],
		})));
		media.receive({
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'media-view',
			type: 'dashboard.snapshot', model: new DashboardPresenter().present({ ...source, deviceTree: tree }),
		});
		assert.match(media.element('deviceTree').text, /Window 32/u);
	});

	test('uses textContent rather than innerHTML for remote strings', async () => {
		const extension = getExtension();
		const bundle = await readFile(vscode.Uri.joinPath(extension.extensionUri, 'media', 'dashboard.js').fsPath, 'utf8');

		assert.ok(bundle.includes('textContent'));
		assert.ok(!bundle.includes('innerHTML'));
		assert.ok(bundle.includes('Remove saved authorization'));
		assert.ok(bundle.includes(`const version = ${DASHBOARD_MESSAGE_VERSION};`));
	});

	test('renders default-off connectivity without initiating discovery, authentication, or hosting', async () => {
		const media = await createDashboardMediaHarness();
		assert.deepStrictEqual(media.messages, [{
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'media-view', type: 'ready',
		}]);
		media.render(DISABLED_CONNECTIVITY_SNAPSHOT);
		assert.strictEqual(media.messages.length, 1);
		assert.match(media.element('connectivity').text, /Disabled \(default\)/u);
		assert.match(media.element('connectivity').text, /outer port is anonymous; Mesh authentication is still required/u);
		assert.match(media.element('discoveryCandidates').text, /discovery is disabled/u);
		assert.strictEqual(media.button('Refresh account discovery').disabled, true);
		assert.strictEqual(media.button('Retry connectivity cleanup').disabled, true);
		assert.strictEqual(media.button('Refresh connected devices').disabled, false);
		assert.strictEqual(media.button('Configure discovery and hosting…').disabled, false);
		assert.strictEqual(media.button('Configure strict remote policy…').disabled, false);
		media.button('Configure discovery and hosting…').click();
		assert.match(media.element('operationStatus').text, /native prompts in the Broker owner window/u);
		assert.deepStrictEqual(media.messages.at(-1), {
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'media-view',
			type: 'action', action: 'configureConnectivity',
		});
	});

	test('renders candidates as hints, strict grants, private hosting, revocation, and explicit cleanup actions', async () => {
		const media = await createDashboardMediaHarness();
		const source = { ...connectivitySnapshot(), migrationPending: true };
		media.render(source);
		const candidateText = media.element('discoveryCandidates').text;
		assert.match(candidateText, /Unknown/u);
		assert.doesNotMatch(candidateText, /Offline|Ready/u);
		assert.match(candidateText, /not an executable worker or a task grant/u);
		assert.strictEqual(media.button('Pair this candidate…').disabled, false);
		assert.match(media.element('connectivity').text, /Activated — latched on/u);
		assert.match(media.element('connectivity').text, /blocks new remote tasks; it does not cancel/u);
		assert.match(media.element('connectivity').text, /SDK private hosting never silently falls back/u);
		assert.match(media.element('connectivity').text, /migration pending/u);
		assert.match(media.element('connectivity').text, /only Workspaces owned by this calling window/u);
		assert.match(media.element('connectivity').text, /non-owner windows/u);
		assert.match(media.element('incomingPeers').text, /Active/u);
		for (const [label, action] of [
			['Configure discovery and hosting…', 'configureConnectivity'],
			['Refresh account discovery', 'refreshDiscovery'],
			['Refresh connected devices', 'refreshRemoteTargets'],
			['Pair this candidate…', 'pairDiscoveredPeer'],
			['Configure strict remote policy…', 'configureRemotePolicy'],
			['Revoke incoming peer…', 'revokeIncomingPeer'],
			['Retry connectivity cleanup', 'retryConnectivityCleanup'],
		] as const) {
			media.render(source);
			media.button(label).click();
			const message = media.messages.at(-1);
			assert.ok(message);
			assert.strictEqual(message.action, action);
			assert.ok(parseDashboardInboundMessage(message));
			assert.ok(!JSON.stringify(message).includes(source.candidates[0].actionHandle));
			assert.ok(!JSON.stringify(message).includes(source.incomingPeers[0].actionHandle));
		}

		media.render({
			...source,
			migrationPending: false,
			truncated: true,
			candidates: [{ ...source.candidates[0], stale: true, hostHint: 'offline', admission: 'legacy-mesh-auth' }],
			incomingPeers: [{ ...source.incomingPeers[0], state: 'revoked', cleanupPending: true }],
		});
		assert.match(media.element('discoveryCandidates').text, /Offline/u);
		assert.match(media.element('discoveryCandidates').text, /stale/iu);
		assert.match(media.element('discoveryCandidates').text, /Legacy CLI admission/u);
		assert.match(media.element('incomingPeers').text, /Revoked/u);
		assert.match(media.element('incomingPeers').text, /cleanup is still pending/u);
		assert.match(media.element('connectivity').text, /safe display limit/u);
		assert.strictEqual(media.button('Pair this candidate…').disabled, true);
		assert.strictEqual(media.button('Revoke incoming peer…').disabled, true);
		assert.strictEqual(media.button('Retry connectivity cleanup').disabled, false);

		for (const error of connectivitySnapshotSchema.shape.error.unwrap().options) {
			media.render({ ...source, state: 'error', error });
			assert.ok(media.element('connectivity').text.includes(error));
			assert.ok(!media.element('connectivity').text.includes('undefined'));
		}
	});

	test('media rejects mismatched versions, cross-view messages, raw Broker handles, and connectivity injection', async () => {
		const media = await createDashboardMediaHarness();
		media.render(DISABLED_CONNECTIVITY_SNAPSHOT);
		const original = media.element('connectivity').text;
		const model = withScopedConnectivity(connectivitySnapshot());
		const valid = {
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'media-view',
			type: 'dashboard.snapshot', model,
		};
		for (const invalid of [
			{ ...valid, version: DASHBOARD_MESSAGE_VERSION - 1 },
			{ ...valid, uiInstanceId: 'other-view' },
			{ ...valid, account: 'private-account' },
			{ ...valid, model: { ...model, connectivity: connectivitySnapshot() } },
			{ ...valid, model: { ...model, connectivity: { ...model.connectivity, endpoint: 'https://example.test' } } },
			{ ...valid, model: { ...model, connectivity: {
				...model.connectivity, candidates: [{ ...model.connectivity.candidates[0], label: 'https://example.test' }],
			} } },
			{ ...valid, model: { ...model, connectivity: {
				...model.connectivity, incomingPeers: [{ ...model.connectivity.incomingPeers[0], label: `sha256:${'a'.repeat(43)}` }],
			} } },
			{ ...valid, model: { ...model, deviceTree: [{ ...model.deviceTree[0], path: '/private/project' }] } },
		]) {
			media.receive(invalid);
			assert.strictEqual(media.element('connectivity').text, original);
		}
	});

	test('renders the device tree layout with persistent expansion, selection, and keyboard navigation', async () => {
		const media = await createDashboardMediaHarness();
		media.render(DISABLED_CONNECTIVITY_SNAPSHOT);

		assert.match(media.element('deviceTree').text, /This device/u);
		assert.match(media.element('deviceTree').text, /Other devices/u);
		assert.match(media.selectedTreeLabel() ?? '', /service-workspace/u);
		assert.match(media.element('selectionSummary').text, /test-device.*This Window.*service-workspace/u);
		assert.doesNotMatch(media.element('deviceTree').text, /Candidate abcdef01/u);

		media.treeItem('tree-7').click();
		assert.match(media.element('selectionSummary').text, /Lab Mac/u);
		media.treeItem('tree-7').click();
		assert.doesNotMatch(media.element('deviceTree').text, /billing-api/u);
		media.treeItem('tree-7').keydown('ArrowRight');
		assert.match(media.selectedTreeLabel() ?? '', /Backend window/u);
		media.treeItem('tree-8').keydown('ArrowRight');
		assert.match(media.element('deviceTree').text, /billing-api/u);
		media.treeItem('tree-8').keydown('ArrowDown');
		assert.match(media.selectedTreeLabel() ?? '', /orders-api/u);
		media.treeItem('tree-10').click();
		assert.match(media.element('selectionSummary').text, /Lab Mac.*Backend window.*billing-api/u);

		media.render(DISABLED_CONNECTIVITY_SNAPSHOT);
		assert.match(media.selectedTreeLabel() ?? '', /billing-api/u);
		assert.match(media.element('deviceTree').text, /billing-api/u);
	});

	test('uses stable presentation keys for duplicate labels and does not silently retarget stale selections', async () => {
		const media = await createDashboardMediaHarness();
		const source = snapshot();
		const duplicateNames = {
			...source,
			deviceTree: source.deviceTree?.map((device) => device.key !== 'tree-7'
				? device
				: {
					...device,
					nodes: device.nodes.map((node) => ({
						...node,
						workspaces: node.workspaces.map((workspace) => ({
							...workspace,
							name: 'shared-target',
						})),
					})),
				}),
		};
		media.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'media-view',
			type: 'dashboard.snapshot',
			model: new DashboardPresenter().present(duplicateNames),
		});
		media.treeItem('tree-7').click();
		media.treeItem('tree-7').keydown('ArrowRight');
		media.treeItem('tree-8').click();
		media.treeItem('tree-8').keydown('ArrowRight');
		media.treeItem('tree-10').click();
		assert.strictEqual(media.treeItem('tree-10').attributes['aria-selected'], 'true');
		assert.strictEqual(media.treeItem('tree-9').attributes['aria-selected'], 'false');

		const reordered = {
			...duplicateNames,
			deviceTree: duplicateNames.deviceTree?.map((device) => device.key !== 'tree-7'
				? device
				: {
					...device,
					nodes: device.nodes.map((node) => ({
						...node,
						workspaces: [...node.workspaces].reverse(),
					})),
				}),
		};
		media.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'media-view',
			type: 'dashboard.snapshot',
			model: new DashboardPresenter().present(reordered),
		});
		assert.strictEqual(media.treeItem('tree-10').attributes['aria-selected'], 'true');
		assert.strictEqual(media.treeItem('tree-9').attributes['aria-selected'], 'false');

		const removed = {
			...reordered,
			deviceTree: reordered.deviceTree?.map((device) => device.key !== 'tree-7'
				? device
				: {
					...device,
					nodes: device.nodes.map((node) => ({
						...node,
						workspaces: node.workspaces.filter((workspace) => workspace.key !== 'tree-10'),
					})),
				}),
		};
		media.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'media-view',
			type: 'dashboard.snapshot',
			model: new DashboardPresenter().present(removed),
		});
		assert.strictEqual(media.selectedTreeLabel(), undefined);
		assert.match(media.element('selectionDetails').text, /will not silently retarget/u);
	});

	test('renders exact remote policy checkboxes and opens Chat drafts without extra modal actions', async () => {
		const media = await createDashboardMediaHarness();
		media.render(DISABLED_CONNECTIVITY_SNAPSHOT);

		const autoAccept = media.checkbox(/Automatically accept tasks from Lab Mac/u);
		assert.strictEqual(autoAccept.checked, false);
		assert.match(media.element('selectionDetails').text, /Skips task-start confirmation, not sensitive tool approvals/u);
		autoAccept.toggle();
		assert.deepStrictEqual(media.messages.at(-1), {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'media-view',
			type: 'action',
			action: 'setRemoteAutoAccept',
			actionHandle: 'f'.repeat(32),
			enabled: true,
		});

		media.treeItem('tree-7').click();
		media.treeItem('tree-7').keydown('ArrowRight');
		media.treeItem('tree-8').click();
		media.treeItem('tree-8').keydown('ArrowRight');
		media.treeItem('tree-10').click();
		assert.match(
			media.element('selectionDetails').text,
			/Authorize this window’s claimed source Workspaces for this remote Workspace/u,
		);
		assert.match(
			media.element('selectionDetails').text,
			/Applies to all claimed source roots in this window/u,
		);
		media.button('Delegate from Chat…').click();
		assert.deepStrictEqual(media.messages.at(-1), {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'media-view',
			type: 'action',
			action: 'openTargetChat',
			actionHandle: 'j'.repeat(32),
		});
	});

	test('renders unknown remote device state as cached metadata without guessed availability', async () => {
		const media = await createDashboardMediaHarness();
		const value = snapshot();
		media.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'media-view',
			type: 'dashboard.snapshot',
			model: new DashboardPresenter().present({
				...value,
				deviceTree: value.deviceTree?.map((device) => device.key !== 'tree-7'
					? device
					: {
						...device,
						state: 'unknown',
						nodes: device.nodes.map((node) => ({
							...node,
							workspaces: node.workspaces.map((workspace) => ({
								...workspace,
								canDelegate: false,
								delegateActionHandle: undefined,
							})),
						})),
					}),
			}),
		});
		media.treeItem('tree-7').click();
		assert.match(media.element('selectionDetails').text, /Unknown\/Cached/u);
		assert.match(media.element('selectionDetails').text, /Refresh connected devices/u);
		assert.throws(() => media.button('Delegate from Chat…'));
		assert.doesNotMatch(media.element('selectionDetails').text, /Online|Offline/u);
	});

	test('validates inbound messages and rejects extra or malformed data', () => {
		const valid = {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'cancelOutgoingTask',
			actionHandle: 'a'.repeat(32),
		};
		assert.deepStrictEqual(parseDashboardInboundMessage(valid), valid);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, actionHandle: '/private/task' }), undefined);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, secret: 'leak' }), undefined);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, actionHandle: undefined }), undefined);
		assert.strictEqual(parseDashboardInboundMessage({ ...valid, action: 'unknown' }), undefined);
		assert.strictEqual(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: 'b'.repeat(32),
		}), undefined);
		assert.ok(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: 'b'.repeat(32),
			enabled: true,
		}));
		assert.ok(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'renameWindow',
		}));
		assert.ok(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'openTargetChat',
			actionHandle: 'd'.repeat(32),
		}));
		assert.ok(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'setRemoteAutoAccept',
			actionHandle: 'e'.repeat(32),
			enabled: false,
		}));
		assert.strictEqual(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'openTargetChat',
			actionHandle: 'd'.repeat(32),
			enabled: true,
		}), undefined);
		assert.strictEqual(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'setAcceptIncoming',
			actionHandle: 'e'.repeat(32),
		}), undefined);
		assert.strictEqual(parseDashboardInboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'action',
			action: 'renameWindow',
			workspaceIdentity: 'sha256:foreign',
		}), undefined);
	});

	test('accepts only exact connectivity actions with kind-specific aliases and no payload', () => {
		for (const action of CONNECTIVITY_ACTIONS) {
			const requiresHandle = action === 'pairDiscoveredPeer' || action === 'revokeIncomingPeer';
			const message = {
				version: DASHBOARD_MESSAGE_VERSION,
				uiInstanceId: 'connectivity-view',
				type: 'action',
				action,
				...(requiresHandle ? { actionHandle: 'h'.repeat(32) } : {}),
			};
			assert.deepStrictEqual(parseDashboardInboundMessage(message), message);
			for (const extra of [
				{ enabled: true },
				{ workspaceIdentity: `sha256:${'a'.repeat(43)}` },
				{ nodeId: 'caller-chosen' },
				{ peerId: 'caller-chosen' },
				{ accountProvider: 'microsoft' },
				{ endpoint: 'https://example.test' },
				{ invitation: 'private-input' },
				{ payload: {} },
				{ secret: undefined },
			]) {
				assert.strictEqual(parseDashboardInboundMessage({ ...message, ...extra }), undefined);
			}
			if (requiresHandle) {
				assert.strictEqual(parseDashboardInboundMessage({ ...message, actionHandle: undefined }), undefined);
				assert.strictEqual(parseDashboardInboundMessage({
					...message,
					actionHandle: connectivitySnapshot().candidates[0].actionHandle,
				}), undefined);
			} else {
				assert.strictEqual(parseDashboardInboundMessage({
					...message, actionHandle: 'h'.repeat(32),
				}), undefined);
				assert.strictEqual(parseDashboardInboundMessage({
					...message, actionHandle: undefined,
				}), undefined);
			}
			assert.strictEqual(parseDashboardInboundMessage({
				...message, version: DASHBOARD_MESSAGE_VERSION - 1,
			}), undefined);
		}
	});

	test('defaults connectivity off without promoting discovery hints to local workers', () => {
		const presenter = new DashboardPresenter();
		const disabled = presenter.present(snapshot());
		assert.deepStrictEqual(disabled.connectivity, DISABLED_CONNECTIVITY_SNAPSHOT);
		const discovered = presenter.present({ ...snapshot(), connectivity: connectivitySnapshot() });
		assert.strictEqual(discovered.connectivity.candidates[0].hostHint, 'unknown');
		assert.deepStrictEqual(discovered.localNodes, disabled.localNodes);
		assert.deepStrictEqual(discovered.outgoingTasks, disabled.outgoingTasks);
		assert.strictEqual(discovered.connectivity.strictPolicyActivated, true);
		assert.strictEqual(discovered.connectivity.delegationEnabled, false);
	});

	test('strictly whitelists connectivity fields, enum values, bounds, and Webview aliases', () => {
		const source = connectivitySnapshot();
		const presented = new DashboardPresenter().present({ ...snapshot(), connectivity: source });
		const model = {
			...presented,
			connectivity: {
				...presented.connectivity,
				candidates: presented.connectivity.candidates.map((candidate) => ({
					...candidate, actionHandle: 'd'.repeat(32),
				})),
				incomingPeers: presented.connectivity.incomingPeers.map((peer) => ({
					...peer, actionHandle: 'e'.repeat(32),
				})),
			},
		};
		const message = {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'connectivity-view',
			type: 'dashboard.snapshot' as const,
			model,
		};
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage(message));
		assert.throws(() => connectivitySnapshotSchema.parse(model.connectivity));
		assert.throws(() => assertSafeDashboardOutboundMessage({ ...message, model: presented }));

		const candidate = model.connectivity.candidates[0];
		const peer = model.connectivity.incomingPeers[0];
		for (const changes of [
			{ endpoint: 'https://example.test' },
			{ accountId: 'hidden-account' },
			{ workspaceIdentity: `sha256:${'a'.repeat(43)}` },
			{ accessToken: 'hidden' },
			{ hostingBackend: 'automatic' },
			{ accountProvider: 'https://example.test' },
			{ discoveryEnabled: 'false' },
			{ strictPolicyActivated: 1 },
			{ publishEnabled: undefined },
			{ migrationPending: 'false' },
			{ state: 'online' },
			{ error: 'private diagnostic output' },
			{ error: 'https://example.test' },
			{ claimedWorkspaceCount: -1 },
			{ claimedWorkspaceCount: 33 },
			{ claimedWorkspaceCount: undefined },
			{ claimedWorkspaceCount: 1.5 },
			{ receivingWorkspaceCount: -1 },
			{ receivingWorkspaceCount: 33 },
			{ receivingWorkspaceCount: 1.5 },
			{ receivingWorkspaceCount: Number.NaN },
			{ receivingWorkspaceCount: undefined },
			{ receivingWorkspaceCount: '1' },
			{ truncated: 'false' },
			{ candidates: Array.from({ length: 11 }, () => candidate) },
			{ incomingPeers: Array.from({ length: 257 }, () => peer) },
			{ candidates: [{ ...candidate, actionHandle: source.candidates[0].actionHandle }] },
			{ candidates: [{ ...candidate, label: 'Candidate nothex00' }] },
			{ candidates: [{ ...candidate, hostHint: 'ready' }] },
			{ candidates: [{ ...candidate, stale: 'false' }] },
			{ candidates: [{ ...candidate, admission: 'anonymous' }] },
			{ candidates: [{ ...candidate, tunnelId: 'hidden-resource' }] },
			{ incomingPeers: [{ ...peer, state: 'allowed' }] },
			{ incomingPeers: [{ ...peer, cleanupPending: 'false' }] },
			{ incomingPeers: [{ ...peer, peerId: 'hidden-peer' }] },
		]) {
			assert.throws(() => assertSafeDashboardOutboundMessage({
				...message,
				model: { ...model, connectivity: { ...model.connectivity, ...changes } },
			} as never));
		}
		for (const unsafe of [
			'Bearer private-value',
			'api_key=private-value',
			'https://example.test',
			'vscode://file/private-project',
			'file:///private/project',
			'C:\\private\\project',
			`sha256:${'a'.repeat(43)}`,
		]) {
			for (const changes of [
				{ candidates: [{ ...candidate, label: unsafe }] },
				{ candidates: [{ ...candidate, actionHandle: unsafe }] },
				{ incomingPeers: [{ ...peer, label: unsafe }] },
				{ incomingPeers: [{ ...peer, actionHandle: unsafe }] },
			]) {
				assert.throws(() => assertSafeDashboardOutboundMessage({
					...message,
					model: { ...model, connectivity: { ...model.connectivity, ...changes } },
				} as never));
			}
			assert.throws(() => new DashboardPresenter().present({
				...snapshot(),
				connectivity: {
					...source,
					candidates: [{ ...source.candidates[0], label: unsafe }],
				},
			}));
		}
		for (const error of connectivitySnapshotSchema.shape.error.unwrap().options) {
			assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
				...message,
				model: { ...model, connectivity: { ...model.connectivity, error } },
			}));
		}
		for (const count of [0, 1, 32]) {
			assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
				...message,
				model: { ...model, connectivity: {
					...model.connectivity,
					claimedWorkspaceCount: count,
					receivingWorkspaceCount: count,
				} },
			}));
		}
		assert.throws(() => new DashboardPresenter().present({
			...snapshot(),
			connectivity: { ...source, endpoint: 'https://example.test' },
		} as never));
	});

	test('rejects secrets and path forms in otherwise valid outbound models', () => {
		const base = {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot' as const,
		};
		const safeModel = new DashboardPresenter().present(snapshot());
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({ ...base, model: safeModel }));
		for (const unsafeText of [
			'/tmp',
			'Failed at /tmp',
			'path=/Users/person/private-project',
			'C:\\Users\\person\\private-project\\file.ts',
			'path=C:\\Users\\person\\private-project',
			'path=\\\\server\\share\\private',
			'file:///Users/person/private-project/file.ts',
			'src/auth.ts',
			'media/dashboard.css',
			'https://example.test/connect#secret=hidden',
			'#secret%3Dhidden',
			'#secret%253Dhidden',
			'#secret%25253Dhidden',
			'{"password":"hunter2"}',
			'{ "PaSsWoRd" : "hunter2" }',
			'{"access_token":"private-value"}',
			'client_secret = private-value',
			'apiKey: private-value',
			'api_key = private-value',
			'private-key: private-value',
			'refresh_token%253Dprivate-value',
			'auth_token = private-value',
			'id_token: private-value',
			'oauthAccessToken = private-value',
			'credential = private-value',
			'Authorization : private-value',
			'tkn\t=\tprivate-value',
			'token: ghp_example',
			'token = gho_example',
			'token = ghu_example',
			'token = ghs_example',
			'token = ghr_example',
			'{"api key":"private-value"}',
			'{"private key" : "private-value"}',
			'{"client-secret":"private-value"}',
			'https://example.test/?credentials[password]=private-value',
			'https://example.test/?credentials%5Bpassword%5D=private-value',
			'https://example.test/?user[api_key][value]=private-value',
			'https://example.test/?x[password][y]=private-value',
			'https://example.test/?user%5Bapi%2Bkey%5D%5Bvalue%5D=private-value',
			'https://example.test/?x%5Bpassword%5D%5By%5D=private-value',
			'https://example.test/?api+key=private-value',
			'https://example.test/?nested=api%2Bkey%3Dprivate-value',
			'malformed=%E0%A4%A',
			'https://x/#/Users/person/private-project',
			'https://x/?location=C%3A%5CUsers%5Cperson%5Cprivate',
			'https://x/?location=file%253A%252F%252F%252Ftmp%252Fprivate',
			'https://user:pass@example.test',
			'https://user%3Apass@example.test',
			'https://user%253Apass@example.test',
			'vscode-remote://ssh-remote+host/home/alice',
			'vscode://file/Users/alice',
			'vscode-remote%3A%2F%2Fssh-remote%2Bhost%2Fhome%2Falice',
			'VSCODE://file/Users/alice',
			'custom-scheme://host/home/alice',
			'1vscode-remote://ssh-remote+host/home/alice',
			'1https://user:pass@example.test',
			'1://host/home/alice',
			'file:tmp',
			'1file:tmp',
			'https:user:pass@example.test',
			'1https:user:pass@example.test',
			'https:///etc',
			'https:////secret',
			'https://',
			'https://?query=value',
			'HTTPS%3A%2F%2F%2Fetc',
			'1HTTPS%3A%2F%2F%2Fetc',
			'https://%75ser:pass@example.test/',
			'https://x/%23opaque-secret',
			"https://'user:pass'@example.test/",
			'https://example.test/\u0000hidden',
			'https://example.test/%00hidden',
		]) {
			assert.throws(() => assertSafeDashboardOutboundMessage({
				...base,
				model: withTaskTitle(safeModel, unsafeText),
			}), `Expected rejection for ${JSON.stringify(unsafeText)}`);
		}
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			...base,
			model: withTaskTitle(safeModel, 'https://example.test'),
		}));
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			...base,
			model: withTaskTitle(safeModel, 'HTTPS://EXAMPLE.TEST'),
		}));
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			...base,
			model: withTaskTitle(safeModel, 'tokenCount = 12'),
		}));
	});

	test('strictly validates device-tree actions, bounds, and safe labels', () => {
		const message = {
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot' as const,
			model: new DashboardPresenter().present(snapshot()),
		};
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage(message));
		assert.throws(() => assertSafeDashboardOutboundMessage({
			...message,
			model: {
				...message.model,
				deviceTree: message.model.deviceTree.map((device, index) => index === 0
					? { ...device, key: 'tree-7' }
					: device),
			},
		} as never));
		assert.throws(() => assertSafeDashboardOutboundMessage({
			...message,
			model: {
				...message.model,
				deviceTree: message.model.deviceTree.map((device) => device.key !== 'tree-7'
					? device
					: {
						...device,
						nodes: device.nodes.map((node) => ({
							...node,
							workspaces: node.workspaces.map((workspace) => workspace.key !== 'tree-10'
								? workspace
								: {
									...workspace,
									canDelegate: true,
									delegateActionHandle: undefined,
								}),
						})),
					}),
			},
		} as never));
		assert.throws(() => assertSafeDashboardOutboundMessage({
			...message,
			model: {
				...message.model,
				deviceTree: message.model.deviceTree.map((device) => ({
					...device,
					nodes: device.nodes.map((node) => ({
						...node,
						workspaces: node.workspaces.map((workspace) => workspace.key !== 'tree-3'
							? workspace
							: {
								...workspace,
								incomingPeers: [{
									...workspace.incomingPeers[0],
									label: 'file:///private/project',
								}],
							}),
					})),
				})),
			},
		} as never));
	});

	test('redacts path-bearing remote summaries, details, and errors before validation', () => {
		const source = snapshot();
		const presenter = new DashboardPresenter();
		const model = presenter.present({
			...source,
			listener: {
				...source.listener,
				gateway: { ...source.listener.gateway, detail: 'Gateway failed at C:\\mesh\\gateway.json' },
			},
			outgoingTasks: source.outgoingTasks?.map((task) => ({
				...task,
				title: 'Changed src/auth.ts',
			})),
			errors: [{ code: 'TASK_FAILED', message: '{"credential" : "private-value"}' }],
		});

		assert.strictEqual(model.listener.gateway.detail, '[redacted sensitive details]');
		assert.strictEqual(model.outgoingTasks[0].title, '[redacted sensitive details]');
		assert.strictEqual(model.errors[0].message, '[redacted sensitive details]');
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model,
		}));
	});

	test('moves offline policy into Saved Authorizations and restores one row after reopen', () => {
		const source = snapshot();
		const target = source.policyCandidates?.[0];
		assert.ok(target);
		const closed = new DashboardPresenter().present({
			...source,
			policyCandidates: [
				{
					...target,
					actionHandle: undefined,
					windowLabel: 'This Window',
					workspaceName: 'source-workspace',
					self: true,
					canToggle: false,
				},
				{
					...target,
					windowLabel: 'Closed Window',
					workspaceName: 'closed-workspace',
					online: false,
					acceptsIncoming: false,
					allowlisted: false,
					canToggle: false,
					gateState: 'offline',
				},
				{
					...target,
					actionHandle: 'd'.repeat(32),
					windowLabel: 'C:\\private\\closed-window',
					workspaceName: 'file:///private/workspace',
					online: false,
					allowlisted: true,
					canToggle: true,
					gateState: 'offline',
				},
			],
		});

		assert.deepStrictEqual(
			closed.localNodes.map(({ windowLabel }) => windowLabel),
			['This Window'],
		);
		assert.deepStrictEqual(closed.savedAuthorizations, [{
			actionHandle: 'd'.repeat(32),
			windowLabel: '[redacted sensitive details]',
			workspaceName: '[redacted sensitive details]',
		}]);
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model: closed,
		}));

		const reopened = new DashboardPresenter().present({
			...source,
			policyCandidates: [
				{
					...target,
					actionHandle: undefined,
					windowLabel: 'This Window',
					workspaceName: 'source-workspace',
					self: true,
					canToggle: false,
				},
				{
					...target,
					actionHandle: 'e'.repeat(32),
					windowLabel: 'Reopened Window',
					workspaceName: 'reopened-workspace',
				},
			],
		});
		assert.deepStrictEqual(
			reopened.localNodes.map(({ windowLabel }) => windowLabel),
			['This Window', 'Reopened Window'],
		);
		assert.equal(reopened.localNodes.every(({ online }) => online), true);
		assert.equal(
			reopened.localNodes.filter(({ workspaceName }) => workspaceName === 'reopened-workspace').length,
			1,
		);
		assert.deepStrictEqual(reopened.savedAuthorizations, []);
	});

	test('presents every Foundation task state and safely truncates valid UTF-8 summaries', () => {
		const source = snapshot();
		const presenter = new DashboardPresenter();
		const summary = '🙂'.repeat(4_096);
		const baseTask = source.outgoingTasks?.[0];
		assert.ok(baseTask);
		const states: DashboardSnapshot['tasks'][number]['state'][] = [
			'accepted',
			'startingAgent',
			'running',
			'needsInput',
			'recovering',
			'cancelling',
			'completed',
			'failed',
			'cancelled',
			'timedOut',
		];
		const model = presenter.present({
			...source,
			outgoingTasks: states.map((state, index) => ({
				...baseTask,
				actionHandle: [
					'completed',
					'failed',
					'cancelled',
					'timedOut',
				].includes(state) ? undefined : `${index}`.padStart(32, 'a'),
				state,
				title: summary,
				shortId: `${index}`.padStart(8, 'a'),
				canCancel: !['completed', 'failed', 'cancelled', 'timedOut'].includes(state),
			})),
		});

		assert.strictEqual(model.outgoingTasks.length, states.length);
		for (const task of model.outgoingTasks) {
			assert.strictEqual(Buffer.byteLength(task.title, 'utf8'), 2 * 1_024);
		}
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model,
		}));
	});

	test('strictly validates outbound model types and enums', () => {
		const model = new DashboardPresenter().present(snapshot());
		assert.throws(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model: {
				...model,
				listener: { ...model.listener, canStop: 'false' },
			},
		} as never));
		assert.throws(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model: { ...model, device: null },
		} as never));
	});

	test('keeps This Window disabled when Preview is off and rejects identity leakage', () => {
		const model = new DashboardPresenter().present({
			...snapshot(),
			thisWindow: {
				name: 'This Window',
				workspaceName: 'service-workspace',
				claimStatus: 'claimed',
				previewEnabled: false,
				canRename: false,
				acceptsIncoming: false,
				canSetAcceptIncoming: false,
				agentHost: {
					source: 'standalone',
					label: 'Standalone (degraded)',
					degraded: true,
					reason: 'EDITOR_DISCOVERY_FAILED',
				},
				detail: 'Enable Peer Delegation Preview to rename this window.',
			},
		});
		assert.strictEqual(model.thisWindow.canRename, false);
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model,
		}));
		assert.throws(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model: {
				...model,
				thisWindow: {
					...model.thisWindow,
					workspaceIdentity: 'sha256:abcdefghijklmnopqrstuvwxyz0123456789_______',
				},
			},
		} as never));
	});

	test('renders truthful Editor and degraded Standalone source states', () => {
		const source = snapshot();
		const presenter = new DashboardPresenter();
		const editor = presenter.present(source);
		assert.equal(editor.thisWindow.agentHost.label, 'Editor');
		assert.equal(editor.thisWindow.agentHost.degraded, false);
		const degraded = presenter.present({
			...source,
			thisWindow: {
				...source.thisWindow,
				agentHost: {
					source: 'standalone',
					label: 'Standalone (degraded)',
					degraded: true,
					reason: 'EDITOR_DISCOVERY_FAILED',
					detail: 'Editor discovery was unavailable.',
				},
			},
		});
		assert.equal(degraded.thisWindow.agentHost.label, 'Standalone (degraded)');
		assert.equal(degraded.thisWindow.agentHost.reason, 'EDITOR_DISCOVERY_FAILED');
	});

	test('canonicalizes every protocol-valid timestamp shape and safely marks malformed values', () => {
		const variants = [
			'2026-08-31T00:00:00+00:00',
			'2026-08-31T08:00:00+08:00',
			'2026-08-31T00:00:00.1Z',
			'2026-08-31T00:00:00.123Z',
			'2026-08-31T00:00:00.123456Z',
			'2026-08-31T00:00:00.123456789Z',
		];
		for (const value of variants) {
			assert.equal(timestampSchema.safeParse(value).success, true);
		}
		const extendedYearAfterNormalization = '9999-12-31T23:59:59-23:59';
		assert.equal(timestampSchema.safeParse(extendedYearAfterNormalization).success, true);
		const source = snapshot();
		const task = source.outgoingTasks?.[0];
		assert.ok(task);
		const model = new DashboardPresenter().present({
			...source,
			outgoingTasks: variants.slice(0, 3).map((startedAt) => ({ ...task, startedAt })),
			incomingTasks: [
				...variants.slice(3).map((startedAt) => ({ ...task, startedAt })),
				{ ...task, startedAt: extendedYearAfterNormalization },
				{ ...task, startedAt: 'malformed timestamp' },
			],
		});
		for (const projected of [...model.outgoingTasks, ...model.incomingTasks.slice(0, 3)]) {
			assert.match(projected.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
		}
		assert.equal(model.incomingTasks[3]?.startedAt, 'Unknown');
		assert.equal(model.incomingTasks[4]?.startedAt, 'Unknown');
		assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'instance-1',
			type: 'dashboard.snapshot',
			model,
		}));
	});

	test('isolates repeated resolves of the same view and makes repeated disposal safe', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const first = new TestWebviewView();
		const second = new TestWebviewView();

		provider.resolveWebviewView(first);
		const replacedId = getUiInstanceId(first.webview.html);
		provider.resolveWebviewView(first);
		const firstId = getUiInstanceId(first.webview.html);
		provider.resolveWebviewView(second);
		const secondId = getUiInstanceId(second.webview.html);
		assert.notStrictEqual(replacedId, firstId);
		assert.notStrictEqual(firstId, secondId);

		await first.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: replacedId, type: 'ready' });
		await first.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: firstId, type: 'ready' });
		await second.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: secondId, type: 'ready' });
		assert.strictEqual(first.webview.sent.length, 2);
		assert.strictEqual(first.webview.sent[0]?.type, 'dashboard.error');
		assert.strictEqual(second.webview.sent.length, 1);

		first.dispose();
		first.dispose();
		facade.fireChanged();
		await settle();
		assert.strictEqual(first.webview.sent.length, 2);
		assert.strictEqual(second.webview.sent.length, 2);

		provider.dispose();
		provider.dispose();
	});

	test('rejects stale instance messages', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);

		await view.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: 'stale-instance',
			type: 'action',
			action: 'startListener',
		});

		assert.deepStrictEqual(facade.calls, []);
		assert.strictEqual(view.webview.sent[0]?.type, 'dashboard.error');
		provider.dispose();
	});

	test('scopes one-time action handles to one UI instance and exact action', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const first = new TestWebviewView();
		const second = new TestWebviewView();
		provider.resolveWebviewView(first);
		provider.resolveWebviewView(second);
		const firstId = getUiInstanceId(first.webview.html);
		const secondId = getUiInstanceId(second.webview.html);
		await first.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: firstId, type: 'ready' });
		await second.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: secondId, type: 'ready' });
		const acceptHandle = getThisWindowActionHandle(first.webview.sent[0]);
		assert.ok(acceptHandle);
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setAcceptIncoming',
			actionHandle: acceptHandle,
			enabled: true,
		});
		assert.ok(facade.calls.includes(`setAcceptIncoming:${'c'.repeat(32)}:true`));
		const firstHandle = getCollectionActionHandle(
			first.webview.sent[first.webview.sent.length - 1],
			'localNodes',
		);
		assert.ok(firstHandle);

		await second.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: secondId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: firstHandle,
			enabled: true,
		});
		assert.equal(second.webview.sent.some(({ code }) => code === 'STALE_ACTION'), true);

		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: firstHandle,
			enabled: true,
		});
		assert.ok(facade.calls.includes(`setPeerAllowed:${'a'.repeat(32)}:true`));
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: firstHandle,
			enabled: false,
		});
		assert.equal(first.webview.sent.some(({ code }) => code === 'STALE_ACTION'), true);
		provider.dispose();
	});

	test('scopes Saved Authorization removal handles and fails closed across transitions', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const first = new TestWebviewView();
		const second = new TestWebviewView();
		provider.resolveWebviewView(first);
		provider.resolveWebviewView(second);
		const firstId = getUiInstanceId(first.webview.html);
		const secondId = getUiInstanceId(second.webview.html);
		await first.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: firstId, type: 'ready' });
		await second.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: secondId, type: 'ready' });
		const oldLocalHandle = getCollectionActionHandle(first.webview.sent[0], 'localNodes');
		assert.ok(oldLocalHandle);
		const current = facade.snapshotValue;
		facade.snapshotValue = {
			...current,
			policyCandidates: current.policyCandidates?.map((candidate) => ({
				...candidate,
				online: false,
				allowlisted: true,
				canToggle: true,
				gateState: 'offline',
			})),
		};

		facade.fireChanged();
		await waitFor(() => first.webview.sent.length >= 2 && second.webview.sent.length >= 2);
		let latest = first.webview.sent[first.webview.sent.length - 1];
		assert.equal(getCollectionLength(latest, 'localNodes'), 0);
		assert.equal(getCollectionLength(latest, 'savedAuthorizations'), 1);
		assert.equal(getCollectionActionHandle(latest, 'localNodes'), undefined);
		assert.ok(getCollectionActionHandle(latest, 'savedAuthorizations'));

		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: oldLocalHandle,
			enabled: false,
		});
		assert.equal(first.webview.sent.some(({ code }) => code === 'STALE_ACTION'), true);
		latest = first.webview.sent[first.webview.sent.length - 1];
		const firstSavedHandle = getCollectionActionHandle(latest, 'savedAuthorizations');
		assert.ok(firstSavedHandle);
		await second.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: secondId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: firstSavedHandle,
			enabled: false,
		});
		assert.equal(second.webview.sent.some(({ code }) => code === 'STALE_ACTION'), true);

		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: firstSavedHandle,
			enabled: true,
		});
		assert.equal(first.webview.sent.some(({ code }) => code === 'POLICY_FORBIDDEN'), true);
		assert.equal(facade.calls.some((call) => call.startsWith('setPeerAllowed:')), false);
		latest = first.webview.sent[first.webview.sent.length - 1];
		const removeHandle = getCollectionActionHandle(latest, 'savedAuthorizations');
		assert.ok(removeHandle);
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: removeHandle,
			enabled: false,
		});
		assert.ok(facade.calls.includes(`setPeerAllowed:${'a'.repeat(32)}:false`));
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setPeerAllowed',
			actionHandle: removeHandle,
			enabled: false,
		});
		assert.equal(first.webview.sent.filter(({ code }) => code === 'STALE_ACTION').length >= 2, true);

		facade.snapshotValue = {
			...current,
			policyCandidates: current.policyCandidates?.map((candidate) => ({
				...candidate,
				actionHandle: 'e'.repeat(32),
				windowLabel: 'Reopened Window',
			})),
		};
		facade.fireChanged();
		await waitFor(() => {
			const message = first.webview.sent[first.webview.sent.length - 1];
			return getCollectionLength(message, 'savedAuthorizations') === 0
				&& getCollectionLength(message, 'localNodes') === 1;
		});
		provider.dispose();
	});

	test('scopes device-tree remote policy and Chat draft handles to one view and exact action', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const tree = structuredClone(facade.snapshotValue.deviceTree);
		assert.ok(tree);
		tree[0].nodes[0].workspaces[0].receiveAction = 'setRemoteReceive';
		facade.snapshotValue = { ...facade.snapshotValue, deviceTree: tree };
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const first = new TestWebviewView();
		const second = new TestWebviewView();
		provider.resolveWebviewView(first);
		provider.resolveWebviewView(second);
		const firstId = getUiInstanceId(first.webview.html);
		const secondId = getUiInstanceId(second.webview.html);
		await first.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: firstId, type: 'ready' });
		await second.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: secondId, type: 'ready' });

		const firstSnapshot = first.webview.sent[0];
		const delegateHandle = getTreeWorkspaceHandle(firstSnapshot, 'tree-10', 'delegateActionHandle');
		const allowHandle = getTreeWorkspaceHandle(firstSnapshot, 'tree-10', 'allowActionHandle');
		const receiveHandle = getTreeWorkspaceHandle(firstSnapshot, 'tree-3', 'receiveActionHandle');
		const autoAcceptHandle = getTreeIncomingPeerHandle(firstSnapshot, 'tree-3', 'tree-4');
		assert.match(delegateHandle ?? '', /^[A-Za-z0-9_-]{32}$/u);
		assert.match(allowHandle ?? '', /^[A-Za-z0-9_-]{32}$/u);
		assert.match(receiveHandle ?? '', /^[A-Za-z0-9_-]{32}$/u);
		assert.match(autoAcceptHandle ?? '', /^[A-Za-z0-9_-]{32}$/u);
		assert.notStrictEqual(delegateHandle, 'j'.repeat(32));
		assert.notStrictEqual(receiveHandle, 'c'.repeat(32));
		assert.notStrictEqual(autoAcceptHandle, 'f'.repeat(32));

		await second.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: secondId,
			type: 'action',
			action: 'openTargetChat',
			actionHandle: delegateHandle,
		});
		assert.ok(second.webview.sent.some(({ code }) => code === 'STALE_ACTION'));
		assert.deepStrictEqual(facade.calls, []);

		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setRemoteAllowed',
			actionHandle: delegateHandle,
			enabled: true,
		});
		assert.ok(first.webview.sent.some(({ code }) => code === 'STALE_ACTION'));
		assert.deepStrictEqual(facade.calls, []);

		const afterInvalid = first.webview.sent.filter(({ type }) => type === 'dashboard.snapshot').at(-1);
		assert.ok(afterInvalid);
		const freshDelegateHandle = getTreeWorkspaceHandle(afterInvalid, 'tree-10', 'delegateActionHandle');
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'openTargetChat',
			actionHandle: freshDelegateHandle,
		});
		const afterChat = first.webview.sent.filter(({ type }) => type === 'dashboard.snapshot').at(-1);
		const nextAllowHandle = afterChat ? getTreeWorkspaceHandle(afterChat, 'tree-10', 'allowActionHandle') : undefined;
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setRemoteAllowed',
			actionHandle: nextAllowHandle,
			enabled: false,
		});
		const afterAllow = first.webview.sent.filter(({ type }) => type === 'dashboard.snapshot').at(-1);
		const nextReceiveHandle = afterAllow ? getTreeWorkspaceHandle(afterAllow, 'tree-3', 'receiveActionHandle') : undefined;
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setRemoteReceive',
			actionHandle: nextReceiveHandle,
			enabled: true,
		});
		const afterReceive = first.webview.sent.filter(({ type }) => type === 'dashboard.snapshot').at(-1);
		const nextAutoAcceptHandle = afterReceive ? getTreeIncomingPeerHandle(afterReceive, 'tree-3', 'tree-4') : undefined;
		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setRemoteAutoAccept',
			actionHandle: nextAutoAcceptHandle,
			enabled: true,
		});
		assert.deepStrictEqual(facade.calls, [
			`openTargetChat:${'j'.repeat(32)}`,
			`remotePolicy:setRemoteAllowed:${'k'.repeat(32)}:false`,
			`remotePolicy:setRemoteReceive:${'c'.repeat(32)}:true`,
			`remotePolicy:setRemoteAutoAccept:${'f'.repeat(32)}:true`,
		]);

		await first.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: firstId,
			type: 'action',
			action: 'setRemoteAutoAccept',
			actionHandle: nextAutoAcceptHandle,
			enabled: false,
		});
		assert.ok(first.webview.sent.some(({ code }) => code === 'STALE_ACTION'));
		provider.dispose();
	});

	test('keeps active task UI handles stable across refresh and removes them at terminal state', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);
		await view.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'ready' });
		const handle = getCollectionActionHandle(view.webview.sent[0], 'outgoingTasks');
		assert.ok(handle);

		facade.fireChanged();
		await settle();
		const refreshedHandle = getCollectionActionHandle(
			view.webview.sent[view.webview.sent.length - 1],
			'outgoingTasks',
		);
		assert.equal(refreshedHandle, handle);

		const current = facade.snapshotValue;
		facade.snapshotValue = {
			...current,
			outgoingTasks: current.outgoingTasks?.map((task) => ({
				...task,
				state: 'completed',
				canCancel: false,
				actionHandle: undefined,
			})),
		};
		facade.fireChanged();
		await settle();
		assert.equal(getCollectionActionHandle(
			view.webview.sent[view.webview.sent.length - 1],
			'outgoingTasks',
		), undefined);
		await view.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId,
			type: 'action',
			action: 'cancelOutgoingTask',
			actionHandle: handle,
		});
		assert.equal(view.webview.sent.some(({ code }) => code === 'STALE_ACTION'), true);
		provider.dispose();
	});

	test('scopes connectivity aliases to one view, one action, and one snapshot without replay', async () => {
		const facade = new RecordingDashboardFacade();
		const connectivity = connectivitySnapshot();
		facade.snapshotValue = { ...snapshot(), connectivity };
		const provider = new AgentMeshViewProvider(facade, getExtension().extensionUri);
		const first = new TestWebviewView();
		const second = new TestWebviewView();
		provider.resolveWebviewView(first);
		provider.resolveWebviewView(second);
		const firstId = getUiInstanceId(first.webview.html);
		const secondId = getUiInstanceId(second.webview.html);
		await first.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: firstId, type: 'ready' });
		await second.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: secondId, type: 'ready' });
		const initial = getConnectivityActionHandle(first, 'candidates');
		assert.match(initial, /^[A-Za-z0-9_-]{32}$/u);
		assert.notStrictEqual(initial, getConnectivityActionHandle(second, 'candidates'));
		assert.notStrictEqual(initial, connectivity.candidates[0].actionHandle);
		for (const raw of [connectivity.candidates[0].actionHandle, connectivity.incomingPeers[0].actionHandle]) {
			assert.ok(!JSON.stringify(first.webview.sent).includes(raw));
		}
		const send = async (
			view: TestWebviewView, action: ConnectivityAction, actionHandle: string,
		) => view.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId: getUiInstanceId(view.webview.html),
			type: 'action', action, actionHandle,
		});

		await send(second, 'pairDiscoveredPeer', initial);
		assert.ok(second.webview.sent.some(({ code }) => code === 'STALE_ACTION'));
		assert.deepStrictEqual(facade.calls, []);
		await send(first, 'revokeIncomingPeer', initial);
		assert.ok(first.webview.sent.some(({ code }) => code === 'STALE_ACTION'));
		assert.deepStrictEqual(facade.calls, []);

		const pairHandle = getConnectivityActionHandle(first, 'candidates');
		await send(first, 'pairDiscoveredPeer', pairHandle);
		await send(first, 'pairDiscoveredPeer', pairHandle);
		assert.deepStrictEqual(facade.calls, [
			`connectivity:pairDiscoveredPeer:${connectivity.candidates[0].actionHandle}`,
		]);
		const revokeHandle = getConnectivityActionHandle(first, 'incomingPeers');
		await send(first, 'revokeIncomingPeer', revokeHandle);
		await send(first, 'revokeIncomingPeer', revokeHandle);
		assert.deepStrictEqual(facade.calls, [
			`connectivity:pairDiscoveredPeer:${connectivity.candidates[0].actionHandle}`,
			`connectivity:revokeIncomingPeer:${connectivity.incomingPeers[0].actionHandle}`,
		]);

		const stale = getConnectivityActionHandle(first, 'candidates');
		facade.fireChanged();
		await settle();
		assert.notStrictEqual(stale, getConnectivityActionHandle(first, 'candidates'));
		await send(first, 'pairDiscoveredPeer', stale);
		assert.strictEqual(facade.calls.length, 2);
		const disposed = getConnectivityActionHandle(first, 'incomingPeers');
		first.dispose();
		await send(first, 'revokeIncomingPeer', disposed);
		assert.strictEqual(facade.calls.length, 2);
		provider.dispose();
	});

	test('rejects unsafe connectivity before aliasing and invalidates previously displayed handles', async () => {
		const facade = new RecordingDashboardFacade();
		const source = connectivitySnapshot();
		facade.snapshotValue = { ...snapshot(), connectivity: source };
		const provider = new AgentMeshViewProvider(facade, getExtension().extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);
		await view.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'ready' });
		const handle = getConnectivityActionHandle(view, 'candidates');
		facade.snapshotValue = {
			...snapshot(),
			connectivity: {
				...source,
				candidates: [{ ...source.candidates[0], actionHandle: 'https://example.test/#secret=hidden' }],
			},
		};
		facade.fireChanged();
		await settle();
		assert.strictEqual(view.webview.sent.at(-1)?.code, 'UNSAFE_VIEW_MODEL');
		assert.ok(!JSON.stringify(view.webview.sent).includes('hidden'));
		await view.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'action',
			action: 'pairDiscoveredPeer', actionHandle: handle,
		});
		assert.deepStrictEqual(facade.calls, []);
		assert.ok(view.webview.sent.some(({ code }) => code === 'STALE_ACTION'));
		provider.dispose();
	});

	test('keeps connectivity actions single-flight without blocking live snapshots or task cancellation', async () => {
		const facade = new RecordingDashboardFacade();
		facade.snapshotValue = { ...snapshot(), connectivity: connectivitySnapshot() };
		let finish!: () => void;
		facade.connectivityAction = async (action) => {
			facade.calls.push(action);
			await new Promise<void>((resolve) => { finish = resolve; });
		};
		const provider = new AgentMeshViewProvider(facade, getExtension().extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);
		await view.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'ready' });
		const oldHandle = getConnectivityActionHandle(view, 'candidates');
		await view.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'action', action: 'configureConnectivity',
		});
		facade.fireChanged();
		await view.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'action', action: 'configureRemotePolicy',
		});
		await settle();
		assert.deepStrictEqual(facade.calls, ['configureConnectivity']);
		assert.ok(view.webview.sent.length > 1, 'Local task status must keep updating during native prompts.');
		assert.deepStrictEqual(view.webview.sent.at(-1)?.pendingActions, ['configureConnectivity']);
		const tasks = (view.webview.sent.filter((message) => message.type === 'dashboard.snapshot').at(-1)?.model as {
			outgoingTasks: { actionHandle: string }[];
		}).outgoingTasks;
		await view.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'action',
			action: 'cancelOutgoingTask', actionHandle: tasks[0].actionHandle,
		});
		await settle();
		assert.ok(facade.calls.some((call) => call.includes('cancelDashboardTask')));
		finish();
		await waitFor(() => (view.webview.sent.at(-1)?.pendingActions as unknown[])?.length === 0);
		assert.notStrictEqual(oldHandle, getConnectivityActionHandle(view, 'candidates'));
		provider.dispose();
	});

	test('media preserves native pending state across snapshots but keeps cancel controls usable', async () => {
		const media = await createDashboardMediaHarness();
		media.render(connectivitySnapshot());
		media.button('Configure discovery and hosting…').click();
		assert.strictEqual(media.button('Configure strict remote policy…').disabled, true);
		assert.strictEqual(media.button('Cancel task').disabled, false);
		media.button('Cancel task').click();
		assert.strictEqual(media.messages.at(-1)?.action, 'cancelOutgoingTask');
	});

	test('shows safe connectivity action failures without forwarding native diagnostics', async () => {
		const facade = new RecordingDashboardFacade();
		facade.connectivityAction = async () => {
			throw new Error('https://example.test/#secret=private-value file:///private/project');
		};
		const provider = new AgentMeshViewProvider(facade, getExtension().extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);
		await view.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'ready' });
		await view.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'action',
			action: 'configureConnectivity',
		});
		assert.ok(view.webview.sent.some(({ code }) => code === 'ACTION_FAILED'));
		assert.doesNotMatch(JSON.stringify(view.webview.sent), /private-value|example\.test|private\/project/u);
		const media = await createDashboardMediaHarness();
		for (const message of view.webview.sent) {
			media.receive({ ...message, uiInstanceId: 'media-view' });
		}
		assert.match(media.element('operationStatus').text, /dashboard action failed/u);
		media.button('Configure discovery and hosting…').click();
		assert.match(media.element('operationStatus').text, /native prompts/u);
		provider.dispose();
	});

	test('coalesces async publications so an old snapshot cannot overwrite a new one', async () => {
		const extension = getExtension();
		const facade = new DeferredDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);

		await view.webview.receive({ version: DASHBOARD_MESSAGE_VERSION, uiInstanceId, type: 'ready' });
		await waitFor(() => facade.pendingCount === 1);
		facade.fireChanged();
		facade.resolveNext(withDeviceName(snapshot(), 'old-device'));
		await waitFor(() => facade.pendingCount === 1);
		facade.resolveNext(withDeviceName(snapshot(), 'new-device'));
		await waitFor(() => view.webview.sent.length === 1);

		const message = view.webview.sent[0];
		assert.strictEqual(message.type, 'dashboard.snapshot');
		assert.strictEqual(getSnapshotDeviceName(message), 'new-device');
		provider.dispose();
	});

	test('requires local confirmation before stopping the listener', async () => {
		const services = new RecordingServiceBindings();
		const denied = new ServiceDashboardFacade(services, {
			confirm: async () => false,
		});
		await denied.stopListener();
		assert.strictEqual(services.stopCalls, 0);

		const approved = new ServiceDashboardFacade(services, {
			confirm: async () => true,
		});
		await approved.stopListener();
		assert.strictEqual(services.stopCalls, 1);
	});

	test('delegates all connectivity prompts to bindings and explicitly errors when unavailable', async () => {
		const services = new RecordingServiceBindings();
		const facade = new ServiceDashboardFacade(
			services,
			{ confirm: async () => assert.fail('Connectivity confirmations belong to the Broker owner.') },
			{ showInputBox: async () => assert.fail('Connectivity inputs must not be collected by the caller UI.') },
		);
		for (const action of CONNECTIVITY_ACTIONS) {
			const handle = action === 'pairDiscoveredPeer' || action === 'revokeIncomingPeer'
				? connectivitySnapshot().candidates[0].actionHandle
				: undefined;
			await facade.connectivityAction(action, handle);
		}
		assert.deepStrictEqual(services.connectivityCalls.map(({ action }) => action), [...CONNECTIVITY_ACTIONS]);
		assert.ok(services.connectivityCalls.every((call) =>
			Object.keys(call).every((key) => key === 'action' || key === 'actionHandle'),
		));
		await assert.rejects(
			new UnavailableDashboardFacade().connectivityAction('configureConnectivity'),
			/unavailable/u,
		);
	});

	test('forwards remote policy and exact Chat draft actions without local confirmation', async () => {
		const services = new RecordingServiceBindings();
		const facade = new ServiceDashboardFacade(
			services,
			{ confirm: async () => assert.fail('Remote policy prompts belong to the Broker owner.') },
			{ showInputBox: async () => assert.fail('Target Chat drafts must not request extra Dashboard input.') },
		);
		await facade.remotePolicyAction('setRemoteAutoAccept', 'a'.repeat(32), true);
		await facade.remotePolicyAction('setRemoteReceive', 'b'.repeat(32), false);
		await facade.openTargetChat('c'.repeat(32));
		assert.deepStrictEqual(services.remotePolicyCalls, [
			{ action: 'setRemoteAutoAccept', actionHandle: 'a'.repeat(32), enabled: true },
			{ action: 'setRemoteReceive', actionHandle: 'b'.repeat(32), enabled: false },
		]);
		assert.deepStrictEqual(services.targetChatCalls, ['c'.repeat(32)]);
		await assert.rejects(
			new UnavailableDashboardFacade().openTargetChat('d'.repeat(32)),
			/unavailable/u,
		);
	});

	test('reserves exact task cancellation before confirmation and releases a denial', async () => {
		const services = new RecordingServiceBindings();
		const order: string[] = [];
		services.cancellationOrder = order;
		const facade = new ServiceDashboardFacade(services, {
			confirm: async () => {
				order.push('confirm');
				return false;
			},
		});
		await facade.cancelDashboardTask('a'.repeat(32), 'incoming');
		assert.deepStrictEqual(order, ['prepare', 'confirm', 'release']);
	});

	test('collects a separate safe task title without placing instructions in the view model', async () => {
		const services = new RecordingServiceBindings();
		const values = ['Safe dashboard title', 'Sensitive prompt body'];
		const facade = new ServiceDashboardFacade(
			services,
			{ confirm: async () => true },
			{
				showInputBox: async (options) => {
					const value = values.shift();
					assert.equal(options.validateInput?.(value ?? ''), undefined);
					return value;
				},
			},
		);
		await facade.runTask({
			deviceId: 'device-1',
			nodeId: 'node-1',
			nodeInstanceId: 'instance-1',
			workspaceId: 'workspace-1',
		});

		assert.deepStrictEqual(services.lastTaskRequest, {
			target: {
				deviceId: 'device-1',
				nodeId: 'node-1',
				nodeInstanceId: 'instance-1',
				workspaceId: 'workspace-1',
			},
			title: 'Safe dashboard title',
			instruction: 'Sensitive prompt body',
		});
		const viewModel = await services.getSnapshot();
		assert.doesNotMatch(JSON.stringify(viewModel), /Sensitive prompt body/u);
	});

	test('collects the window name in the Extension Host without accepting an identity from Webview', async () => {
		const services = new RecordingServiceBindings();
		const facade = new ServiceDashboardFacade(
			services,
			{ confirm: async () => true },
			{
				showInputBox: async (options) => {
					assert.strictEqual(options.value, 'This Window');
					assert.strictEqual(options.validateInput?.('Renamed Window'), undefined);
					const whitespaceError = await options.validateInput?.(' Renamed Window ');
					const pathError = await options.validateInput?.('ｆｉｌｅ：／／／private');
					if (typeof whitespaceError !== 'string' || typeof pathError !== 'string') {
						throw new Error('Expected string window-name validation errors.');
					}
					assert.match(whitespaceError, /surrounding whitespace/u);
					assert.match(pathError, /path and URI/u);
					return 'Renamed Window';
				},
			},
		);

		await facade.renameCurrentWindow();

		assert.strictEqual(services.lastWindowName, 'Renamed Window');
	});

	test('surfaces safe explicit rename errors through the Dashboard message contract', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		facade.renameError = new DashboardActionError(
			'WINDOW_NAME_CONFLICT',
			'Another Workspace already uses an equivalent window name.',
		);
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);

		await view.webview.receive({
			version: DASHBOARD_MESSAGE_VERSION,
			uiInstanceId,
			type: 'action',
			action: 'renameWindow',
		});

		assert.strictEqual(view.webview.sent[0]?.type, 'dashboard.error');
		assert.strictEqual(view.webview.sent[0]?.code, 'WINDOW_NAME_CONFLICT');
		assert.strictEqual(
			view.webview.sent[0]?.message,
			'Another Workspace already uses an equivalent window name.',
		);
		provider.dispose();
	});

	test('Production bindings derive the owned policy identity server-side and reject ambiguous selection', async () => {
		const mutations: unknown[] = [];
		const selected = createWindowRenameBindings({
			enabled: true,
			selection: {
				kind: 'selected',
				workspaceIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				workspaceId: 'workspace-1',
				workspaceName: 'service-workspace',
				claimStatus: 'claimed',
			},
			mutations,
		});
		const rename = await selected.prepareWindowRename();
		await rename.rename('Backend');
		assert.deepStrictEqual(mutations, [{
			workspaceIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			windowName: 'Backend',
		}]);
		selected.dispose();
		selected.dispose();

		const ambiguous = createWindowRenameBindings({
			enabled: true,
			selection: {
				kind: 'unavailable',
				workspaceName: 'Multiple Workspaces',
				claimStatus: 'ambiguous',
			},
			mutations,
		});
		await assert.rejects(
			ambiguous.prepareWindowRename(),
			(error: unknown) =>
				error instanceof DashboardActionError
				&& error.code === 'WORKSPACE_SELECTION_AMBIGUOUS',
		);
		assert.strictEqual(mutations.length, 1);
		ambiguous.dispose();
	});

	test('rejects rename when the active Workspace changes while the input is open', async () => {
		const mutations: unknown[] = [];
		let selection: WindowRenameSelection = {
			kind: 'selected',
			workspaceIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			workspaceId: 'workspace-a',
			workspaceName: 'Workspace A',
			claimStatus: 'claimed',
		};
		const bindings = createWindowRenameBindings({
			enabled: true,
			selection: () => selection,
			mutations,
		});
		const facade = new ServiceDashboardFacade(
			bindings,
			{ confirm: async () => true },
			{
				showInputBox: async () => {
					selection = {
						kind: 'selected',
						workspaceIdentity: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
						workspaceId: 'workspace-b',
						workspaceName: 'Workspace B',
						claimStatus: 'claimed',
					};
					return 'Renamed Window';
				},
			},
		);

		await assert.rejects(
			facade.renameCurrentWindow(),
			(error: unknown) =>
				error instanceof DashboardActionError
				&& error.code === 'WORKSPACE_SELECTION_AMBIGUOUS',
		);
		assert.deepStrictEqual(mutations, []);
		bindings.dispose();
	});

	test('Production connectivity uses authenticated local IPC from non-owner windows and never refreshes cloud state on render', async () => {
		const fixture = createConnectivityBindings();
		try {
			const first = await fixture.bindings.getSnapshot();
			const second = await fixture.bindings.getSnapshot();
			assert.deepStrictEqual(first.connectivity, DISABLED_CONNECTIVITY_SNAPSHOT);
			assert.deepStrictEqual(second.connectivity, DISABLED_CONNECTIVITY_SNAPSHOT);
			assert.strictEqual(first.broker?.role, 'contender');
			assert.strictEqual(first.localNodes?.length, 1);
			assert.strictEqual(first.outgoingTasks?.length, 1);
			assert.strictEqual(first.remoteDevices?.[0]?.name, 'Cached remote device');
			assert.strictEqual(fixture.calls.filter((call) => call === 'connectivitySnapshot').length, 2);
			assert.strictEqual(fixture.calls.filter((call) => call === 'cachedRemoteDevices').length, 2);
			assert.deepStrictEqual(fixture.mutations, []);
			fixture.state.connectivity = connectivitySnapshot();
			const enabled = await fixture.bindings.getSnapshot();
			assert.deepStrictEqual(enabled.connectivity, connectivitySnapshot());
			assert.deepStrictEqual(fixture.mutations, [], 'Enabled rendering must not initiate discovery either.');
			const ownerReads = fixture.calls.filter((call) => call === 'ownerRuntime').length;
			for (const action of CONNECTIVITY_ACTIONS) {
				const handle = action === 'pairDiscoveredPeer' || action === 'revokeIncomingPeer'
					? connectivitySnapshot().candidates[0].actionHandle
					: undefined;
				await fixture.bindings.connectivityAction(action, handle);
				assert.deepStrictEqual(fixture.mutations.at(-1), {
					action, ...(handle === undefined ? {} : { actionHandle: handle }),
				});
			}
			assert.strictEqual(fixture.calls.filter((call) => call === 'ownerRuntime').length, ownerReads);
			assert.strictEqual(fixture.calls.includes('cloud'), false);
			assert.strictEqual(fixture.calls.includes('runtime'), false);
			assert.strictEqual(fixture.calls.includes('native'), false);
		} finally {
			fixture.bindings.dispose();
		}
	});

	test('Production bindings open an exact Chat draft target without confirmation or task start, and reject replayed stale handles', async () => {
		const fixture = createConnectivityBindings();
		try {
			fixture.state.connectivity = {
				...connectivitySnapshot(),
				delegationEnabled: true,
				strictPolicyActivated: true,
			};
			const first = await fixture.bindings.getSnapshot();
			const target = findSnapshotWorkspace(
				first,
				(workspace) => workspace.deviceLocality === 'remote' && workspace.name === 'billing-api',
			);
			assert.ok(target);
			const handle = getSnapshotTreeWorkspaceHandle(first, target.key, 'delegateActionHandle');
			assert.match(handle ?? '', /^[A-Za-z0-9_-]{32}$/u);

			await fixture.bindings.openTargetChat(handle!);
			assert.deepStrictEqual(fixture.describedTargets, [{
				deviceId: '00000000-0000-4000-8000-000000000201',
				peerId: '00000000-0000-4000-8000-000000000202',
				nodeId: '00000000-0000-4000-8000-000000000211',
				nodeInstanceId: '00000000-0000-4000-8000-000000000212',
				workspaceId: '00000000-0000-4000-8000-000000000213',
				title: 'Prepare a delegation',
				prompt: 'Describe the task to delegate.',
				acceptanceCriteria: [],
			}]);
			assert.deepStrictEqual(fixture.commandCalls, [{
				command: 'workbench.action.chat.open',
				args: [{
					query: 'Use #meshDelegateTask for this exact Mesh target: '
						+ `${JSON.stringify({
							deviceId: '00000000-0000-4000-8000-000000000201',
							peerId: '00000000-0000-4000-8000-000000000202',
							nodeId: '00000000-0000-4000-8000-000000000211',
							nodeInstanceId: '00000000-0000-4000-8000-000000000212',
							workspaceId: '00000000-0000-4000-8000-000000000213',
						})}.\nTask: `,
					isPartialQuery: true,
					mode: 'agent',
				}],
			}]);
			assert.strictEqual(fixture.calls.includes('native'), false);
			assert.strictEqual(fixture.calls.includes('cloud'), false);

			await assert.rejects(
				fixture.bindings.openTargetChat(handle!),
				(error: unknown) => error instanceof DashboardActionError && error.code === 'STALE_ACTION',
			);

			const second = await fixture.bindings.getSnapshot();
			const secondTarget = findSnapshotWorkspace(
				second,
				(workspace) => workspace.deviceLocality === 'remote' && workspace.name === 'billing-api',
			);
			assert.ok(secondTarget);
			const staleHandle = getSnapshotTreeWorkspaceHandle(second, secondTarget.key, 'delegateActionHandle');
			assert.match(staleHandle ?? '', /^[A-Za-z0-9_-]{32}$/u);
			await fixture.bindings.getSnapshot();
			await assert.rejects(
				fixture.bindings.openTargetChat(staleHandle!),
				(error: unknown) => error instanceof DashboardActionError && error.code === 'STALE_ACTION',
			);
			assert.strictEqual(fixture.commandCalls.length, 1);
		} finally {
			fixture.bindings.dispose();
		}
	});

	test('Production bindings keep cached remote metadata as unknown without enabling delegation', async () => {
		const fixture = createConnectivityBindings();
		try {
			fixture.state.connectivity = {
				...connectivitySnapshot(),
				delegationEnabled: true,
				strictPolicyActivated: true,
			};
			fixture.state.remotePolicy = {
				...fixture.state.remotePolicy,
				peerStates: [],
			};
			const value = await fixture.bindings.getSnapshot();
			const target = findSnapshotWorkspace(
				value,
				(workspace) => workspace.deviceLocality === 'remote' && workspace.name === 'billing-api',
			);
			assert.ok(target);
			assert.strictEqual(target.deviceState, 'unknown');
			assert.strictEqual(getSnapshotTreeWorkspaceHandle(value, target.key, 'delegateActionHandle'), undefined);
		} finally {
			fixture.bindings.dispose();
		}
	});

	test('Production Dashboard accepts neutral CLI and SDK exposure status without projecting hosting metadata', async () => {
		const fixture = createConnectivityBindings();
		const media = await createDashboardMediaHarness();
		try {
			for (const provider of ['cli', 'sdk'] as const) {
				fixture.state.connectivity = { ...DISABLED_CONNECTIVITY_SNAPSHOT, hostingBackend: provider };
				fixture.state.ownerListener = {
					state: 'running',
					port: 31234,
					forwardingOrigin: 'https://neutral-forwarding.example.test',
					tunnel: {
						state: 'ready',
						tunnel: {
							provider,
							admission: provider === 'sdk' ? 'private-port-token' : 'legacy-mesh-auth',
							forwardingOrigin: 'https://neutral-forwarding.example.test',
							localPort: 31234,
							resource: { clusterId: 'use', tunnelId: 'neutral-resource' },
							ownershipLabel: '/private/neutral-owner',
							locator: {
								provider: 'dev-tunnels',
								clusterId: 'use',
								tunnelId: 'neutral-resource',
								portNumber: 31234,
								advertisementId: '00000000-0000-4000-8000-000000000301',
							},
						},
					},
				};
				const value = await fixture.bindings.getSnapshot();
				assert.strictEqual(value.listener.state, 'running');
				assert.strictEqual(value.listener.tunnel.state, 'ready');
				assert.strictEqual(value.listener.canCopyConnectionUrl, true);
				assert.strictEqual(value.listener.canStart, false);
				const model = new DashboardPresenter().present(value);
				const message = {
					version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'media-view',
					type: 'dashboard.snapshot' as const, model,
				};
				assert.doesNotThrow(() => assertSafeDashboardOutboundMessage(message));
				assert.doesNotMatch(JSON.stringify(model), /neutral-forwarding|neutral-resource|neutral-owner|00000000-0000-4000-8000-000000000301/u);
				media.receive(message);
				assert.ok(media.element('connectivity').text.includes(
					provider === 'sdk' ? 'SDK private hosting' : 'Legacy CLI hosting',
				));
			}
			assert.deepStrictEqual(fixture.mutations, []);
			assert.strictEqual(fixture.calls.includes('cloud'), false);
			assert.strictEqual(fixture.calls.includes('runtime'), false);
			assert.strictEqual(fixture.calls.includes('native'), false);
		} finally {
			fixture.bindings.dispose();
		}
	});

	test('shows the shared receive gate with local Preview off and changes it only through native remote policy', async () => {
		const fixture = createConnectivityBindings();
		const media = await createDashboardMediaHarness();
		try {
			fixture.state.connectivity = {
				...DISABLED_CONNECTIVITY_SNAPSHOT,
				delegationEnabled: true,
				strictPolicyActivated: true,
				claimedWorkspaceCount: 1,
				receivingWorkspaceCount: 1,
			};
			for (const receivingWorkspaceCount of [1, 0]) {
				fixture.state.connectivity = { ...fixture.state.connectivity, receivingWorkspaceCount };
				const value = await fixture.bindings.getSnapshot();
				assert.strictEqual(value.thisWindow.previewEnabled, false);
				assert.strictEqual(value.thisWindow.acceptsIncoming, receivingWorkspaceCount === 1);
				assert.strictEqual(value.thisWindow.canSetAcceptIncoming, false);
				assert.strictEqual(value.thisWindow.acceptActionHandle, undefined);
				const message = {
					version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'media-view',
					type: 'dashboard.snapshot' as const, model: new DashboardPresenter().present(value),
				};
				assert.doesNotThrow(() => assertSafeDashboardOutboundMessage(message));
				media.receive(message);
				assert.match(media.element('connectivity').text, new RegExp(`Receiving Workspaces\\s+${receivingWorkspaceCount}`, 'u'));
				assert.match(
					media.element('acceptIncoming').text,
					receivingWorkspaceCount === 1 ? /Accepting incoming tasks/u : /Not accepting incoming tasks/u,
				);
				assert.match(media.element('acceptIncoming').text, /strict remote policy/i);
				media.button('Configure strict remote policy…').click();
				assert.deepStrictEqual(media.messages.at(-1), {
					version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'media-view',
					type: 'action', action: 'configureRemotePolicy',
				});
				await fixture.bindings.connectivityAction('configureRemotePolicy');
			}
			assert.deepStrictEqual(fixture.mutations, [
				{ action: 'configureRemotePolicy' },
				{ action: 'configureRemotePolicy' },
			]);
			assert.strictEqual(fixture.calls.includes('localPolicy'), false);
			assert.strictEqual(fixture.calls.includes('passiveEditorProbe'), true);
			assert.strictEqual(fixture.calls.includes('native'), false);
			assert.strictEqual(fixture.calls.includes('cloud'), false);

			for (const claimedWorkspaceCount of [0, 2, 32]) {
				fixture.state.connectivity = {
					...fixture.state.connectivity, claimedWorkspaceCount, receivingWorkspaceCount: 1,
				};
				const value = await fixture.bindings.getSnapshot();
				assert.strictEqual(value.thisWindow.acceptsIncoming, false, 'Aggregate receive counts must not be attributed to a selected Workspace.');
				assert.strictEqual(value.thisWindow.canSetAcceptIncoming, false);
				assert.strictEqual(value.thisWindow.acceptActionHandle, undefined);
			}
		} finally {
			fixture.bindings.dispose();
		}
	});

	test('preserves the selected local receive policy when local Preview is enabled', async () => {
		const fixture = createConnectivityBindings();
		try {
			fixture.state.previewEnabled = true;
			for (const localAcceptsIncoming of [true, false]) {
				fixture.state.localAcceptsIncoming = localAcceptsIncoming;
				fixture.state.connectivity = {
					...DISABLED_CONNECTIVITY_SNAPSHOT,
					claimedWorkspaceCount: 1,
					receivingWorkspaceCount: localAcceptsIncoming ? 0 : 1,
				};
				const value = await fixture.bindings.getSnapshot();
				assert.strictEqual(value.thisWindow.acceptsIncoming, localAcceptsIncoming);
				assert.strictEqual(value.thisWindow.canSetAcceptIncoming, true);
				assert.match(value.thisWindow.acceptActionHandle ?? '', /^[A-Za-z0-9_-]{32}$/u);
			}
			assert.strictEqual(fixture.calls.filter((call) => call === 'localPolicy').length, 2);
		} finally {
			fixture.bindings.dispose();
		}
	});

	test('Production connectivity failures and malformed remote snapshots do not hide local Dashboard state or leak diagnostics', async () => {
		const fixture = createConnectivityBindings();
		try {
			fixture.state.connectivityError = new Error('file:///private/project access_token=private-value');
			fixture.state.directoryError = new Error(`https://example.test sha256:${'a'.repeat(43)}`);
			const failed = await fixture.bindings.getSnapshot();
			assert.strictEqual(failed.localNodes?.length, 1);
			assert.strictEqual(failed.outgoingTasks?.length, 1);
			assert.strictEqual(failed.connectivity?.state, 'error');
			assert.strictEqual(failed.connectivity?.error, 'DISCOVERY_UNAVAILABLE');
			assert.ok(failed.errors.some(({ code }) => code === 'CONNECTIVITY_UNAVAILABLE'));
			assert.ok(failed.errors.some(({ code }) => code === 'REMOTE_DIRECTORY_UNAVAILABLE'));
			assert.doesNotThrow(() => assertSafeDashboardOutboundMessage({
				version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'bindings-view',
				type: 'dashboard.snapshot', model: new DashboardPresenter().present(failed),
			}));
			assert.doesNotMatch(JSON.stringify(failed), /private-value|private\/project|example\.test/u);
			const media = await createDashboardMediaHarness();
			media.receive({
				version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'media-view',
				type: 'dashboard.snapshot', model: new DashboardPresenter().present(failed),
			});
			assert.match(media.element('connectivity').text, /Unknown/u);
			assert.doesNotMatch(media.element('connectivity').text, /outer port is anonymous|Not activated/u);
			assert.match(media.element('incomingPeers').text, /status is unavailable/u);
			assert.match(media.element('thisWindow').text, /Source Workspace/u);
			fixture.state.connectivityError = undefined;
			fixture.state.directoryError = undefined;
			fixture.state.connectivity = {
				...connectivitySnapshot(),
				candidates: [{ ...connectivitySnapshot().candidates[0], label: 'https://example.test' }],
			};
			const malformed = await fixture.bindings.getSnapshot();
			assert.strictEqual(malformed.connectivity?.state, 'error');
			assert.strictEqual(malformed.localNodes?.length, 1);
			assert.ok(!JSON.stringify(malformed).includes('example.test'));
			fixture.state.connectivity = connectivitySnapshot();
			const recovered = await fixture.bindings.getSnapshot();
			assert.deepStrictEqual(recovered.connectivity, connectivitySnapshot());
			assert.ok(!recovered.errors.some(({ code }) => code === 'CONNECTIVITY_UNAVAILABLE'));
			fixture.state.guardError = new Error('Local guard rejected this operation.');
			await assert.rejects(fixture.bindings.getSnapshot(), /Local guard rejected/u);
		} finally {
			fixture.bindings.dispose();
		}
	});

	test('dispatches all dashboard actions without sensitive values in messages', async () => {
		const extension = getExtension();
		const facade = new RecordingDashboardFacade();
		const provider = new AgentMeshViewProvider(facade, extension.extensionUri);
		const view = new TestWebviewView();
		provider.resolveWebviewView(view);
		const uiInstanceId = getUiInstanceId(view.webview.html);

		const actions = [
			{ action: 'configureDevice' },
			{ action: 'renameWindow' },
			{ action: 'startListener' },
			{ action: 'stopListener' },
			{ action: 'copyConnectionUrl' },
			{ action: 'configureConnectivity' },
			{ action: 'refreshDiscovery' },
			{ action: 'refreshRemoteTargets' },
			{ action: 'configureRemotePolicy' },
			{ action: 'retryConnectivityCleanup' },
			{ action: 'refresh' },
		] as const;

		for (const action of actions) {
			await view.webview.receive({
				version: DASHBOARD_MESSAGE_VERSION,
				uiInstanceId,
				type: 'action',
				...action,
			});
		}

		assert.deepStrictEqual(facade.calls, [
			'configureDevice',
			'renameWindow',
			'startListener',
			'stopListener',
			'copyConnectionUrl',
			'connectivity:configureConnectivity:',
			'connectivity:refreshDiscovery:',
			'connectivity:refreshRemoteTargets:',
			'connectivity:configureRemotePolicy:',
			'connectivity:retryConnectivityCleanup:',
		]);
		provider.dispose();
	});
});

class RecordingDashboardFacade implements DashboardFacade {
	private readonly changed = new vscode.EventEmitter<void>();
	public readonly calls: string[] = [];
	public readonly onDidChange = this.changed.event;
	public snapshotValue = snapshot();
	public renameError?: DashboardActionError;

	public getSnapshot(): Promise<DashboardSnapshot> {
		return Promise.resolve(this.snapshotValue);
	}

	public fireChanged(): void {
		this.changed.fire();
	}

	public async configureDeviceName(): Promise<void> {
		this.calls.push('configureDevice');
	}

	public async renameCurrentWindow(): Promise<void> {
		if (this.renameError !== undefined) {
			throw this.renameError;
		}
		this.calls.push('renameWindow');
	}

	public async setAcceptIncoming(actionHandle: string, enabled: boolean): Promise<void> {
		this.calls.push(`setAcceptIncoming:${actionHandle}:${enabled}`);
	}

	public async setPeerAllowed(actionHandle: string, allowed: boolean): Promise<void> {
		this.calls.push(`setPeerAllowed:${actionHandle}:${allowed}`);
	}

	public async connectivityAction(action: ConnectivityAction, actionHandle?: string): Promise<void> {
		this.calls.push(`connectivity:${action}:${actionHandle ?? ''}`);
	}

	public async remotePolicyAction(action: RemotePolicyAction, actionHandle: string, enabled: boolean): Promise<void> {
		this.calls.push(`remotePolicy:${action}:${actionHandle}:${enabled}`);
	}

	public async openTargetChat(actionHandle: string): Promise<void> {
		this.calls.push(`openTargetChat:${actionHandle}`);
	}

	public async cancelDashboardTask(actionHandle: string, direction: 'incoming' | 'outgoing'): Promise<void> {
		this.calls.push(`cancelDashboardTask:${direction}:${actionHandle}`);
	}

	public async registerCurrentWorkspace(): Promise<void> {
		this.calls.push('registerWorkspace');
	}

	public async removeWorkspace(workspaceId: string): Promise<void> {
		this.calls.push(`removeWorkspace:${workspaceId}`);
	}

	public async startListener(): Promise<void> {
		this.calls.push('startListener');
	}

	public async stopListener(): Promise<void> {
		this.calls.push('stopListener');
	}

	public async copyConnectionUrl(): Promise<void> {
		this.calls.push('copyConnectionUrl');
	}

	public async addPeer(): Promise<void> {
		this.calls.push('addPeer');
	}

	public async removePeer(peerId: string): Promise<void> {
		this.calls.push(`removePeer:${peerId}`);
	}

	public async runTask(target?: DashboardTaskTarget): Promise<void> {
		this.calls.push(target === undefined
			? 'runTask'
			: `runTask:${target.deviceId}:${target.nodeId}:${target.nodeInstanceId}:${target.workspaceId}:${target.peerId ?? ''}`);
	}

	public async cancelTask(taskId: string): Promise<void> {
		this.calls.push(`cancelTask:${taskId}`);
	}

}

class DeferredDashboardFacade extends RecordingDashboardFacade {
	private readonly pending: Array<(value: DashboardSnapshot) => void> = [];

	public override getSnapshot(): Promise<DashboardSnapshot> {
		return new Promise((resolve) => this.pending.push(resolve));
	}

	public get pendingCount(): number {
		return this.pending.length;
	}

	public resolveNext(value: DashboardSnapshot): void {
		const resolve = this.pending.shift();
		assert.ok(resolve);
		resolve(value);
	}
}

class RecordingServiceBindings implements DashboardServiceBindings {
	private readonly changed = new vscode.EventEmitter<void>();
	public readonly onDidChange = this.changed.event;
	public stopCalls = 0;
	public cancellationOrder?: string[];
	public lastWindowName?: string;
	public readonly connectivityCalls: Array<{ action: ConnectivityAction; actionHandle?: string }> = [];
	public readonly remotePolicyCalls: Array<{ action: RemotePolicyAction; actionHandle: string; enabled: boolean }> = [];
	public readonly targetChatCalls: string[] = [];
	public lastTaskRequest?: {
		readonly target?: DashboardTaskTarget;
		readonly title: string;
		readonly instruction: string;
	};
	public getSnapshot(): Promise<DashboardSnapshot> {
		return Promise.resolve(snapshot());
	}

	public async configureDeviceName(_name: string): Promise<void> {}
	public async prepareWindowRename() {
		return {
			currentName: 'This Window',
			rename: async (name: string) => {
				this.lastWindowName = name;
			},
		};
	}
	public async setAcceptIncoming(_actionHandle: string, _enabled: boolean): Promise<void> {}
	public async setPeerAllowed(_actionHandle: string, _allowed: boolean): Promise<void> {}
	public async connectivityAction(action: ConnectivityAction, actionHandle?: string): Promise<void> {
		this.connectivityCalls.push({ action, ...(actionHandle === undefined ? {} : { actionHandle }) });
	}
	public async remotePolicyAction(action: RemotePolicyAction, actionHandle: string, enabled: boolean): Promise<void> {
		this.remotePolicyCalls.push({ action, actionHandle, enabled });
	}
	public async openTargetChat(actionHandle: string): Promise<void> {
		this.targetChatCalls.push(actionHandle);
	}
	public async prepareDashboardTaskCancellation(
		_actionHandle: string,
		_direction: 'incoming' | 'outgoing',
	) {
		this.cancellationOrder?.push('prepare');
		return {
			cancel: async () => {
				this.cancellationOrder?.push('cancel');
			},
			release: async () => {
				this.cancellationOrder?.push('release');
			},
		};
	}
	public async registerCurrentWorkspace(): Promise<void> {}
	public async removeWorkspace(_workspaceId: string): Promise<void> {}
	public async startListener(): Promise<void> {}

	public async stopListener(): Promise<void> {
		this.stopCalls += 1;
	}

	public createConnectionUrl(): Promise<string> {
		return Promise.resolve('https://example.test/connect#secret=secret');
	}

	public async addPeer(_connectionUrl: string): Promise<void> {}
	public async removePeer(_peerId: string): Promise<void> {}

	public async runTask(request: {
		readonly target?: DashboardTaskTarget;
		readonly title: string;
		readonly instruction: string;
	}): Promise<void> {
		this.lastTaskRequest = request;
	}

	public async cancelTask(_taskId: string): Promise<void> {}
}

class TestWebview implements vscode.Webview {
	public options: vscode.WebviewOptions = {};
	public html = '';
	public readonly cspSource = 'vscode-webview-resource:';
	public readonly sent: Array<Record<string, unknown>> = [];
	private readonly messages = new vscode.EventEmitter<unknown>();

	public readonly onDidReceiveMessage = this.messages.event;

	public asWebviewUri(localResource: vscode.Uri): vscode.Uri {
		return vscode.Uri.parse(`vscode-webview-resource:${localResource.path}`);
	}

	public async postMessage(message: Record<string, unknown>): Promise<boolean> {
		this.sent.push(message);
		return true;
	}

	public async receive(message: unknown): Promise<void> {
		this.messages.fire(message);
		await settle();
	}
}

class TestWebviewView implements vscode.WebviewView {
	public readonly viewType = AgentMeshViewProvider.viewType;
	public readonly webview = new TestWebview();
	public visible = true;
	public title?: string;
	public description?: string;
	public badge?: vscode.ViewBadge;
	private readonly visibility = new vscode.EventEmitter<void>();
	private readonly disposal = new vscode.EventEmitter<void>();

	public readonly onDidChangeVisibility = this.visibility.event;
	public readonly onDidDispose = this.disposal.event;

	public show(_preserveFocus?: boolean): void {}

	public dispose(): void {
		this.disposal.fire();
	}
}

function snapshot(): DashboardSnapshot {
	return {
		device: {
			deviceId: 'device-1',
			name: 'test-device',
			platform: 'test-platform',
			architecture: 'test-architecture',
			vscodeVersion: '1.0.0',
			extensionVersion: '1.0.0',
		},
		listener: {
			state: 'running',
			gateway: { state: 'ready', label: 'Ready' },
			tunnel: { state: 'ready', label: 'Ready' },
			agentHost: { state: 'ready', label: 'Ready' },
			canStart: false,
			canStop: true,
			canCopyConnectionUrl: true,
		},
		broker: {
			state: 'running',
			role: 'owner',
			takeover: 'stable',
			holder: 'thisWindow',
		},
		thisWindow: {
			name: 'This Window',
			workspaceName: 'service-workspace',
			claimStatus: 'claimed',
			previewEnabled: true,
			canRename: true,
			acceptsIncoming: false,
			canSetAcceptIncoming: true,
			acceptActionHandle: 'c'.repeat(32),
			agentHost: {
				source: 'editor',
				label: 'Editor',
				degraded: false,
			},
		},
		deviceTree: [{
			key: 'tree-1',
			name: 'test-device',
			locality: 'local',
			state: 'online',
			nodes: [{
				key: 'tree-2',
				label: 'This Window',
				thisWindow: true,
				status: 'online',
				workspaces: [{
					key: 'tree-3',
					name: 'service-workspace',
					claimStatus: 'claimed',
					enabled: true,
					busy: false,
					acceptsIncoming: false,
					allowlisted: false,
					gateState: 'self',
					canDelegate: false,
					receiveActionHandle: 'c'.repeat(32),
					receiveAction: 'setAcceptIncoming',
					incomingPeers: [{
						key: 'tree-4',
						label: 'Lab Mac',
						autoAccept: false,
						actionHandle: 'f'.repeat(32),
					}],
				}],
			}, {
				key: 'tree-5',
				label: 'Local Window',
				thisWindow: false,
				status: 'online',
				workspaces: [{
					key: 'tree-6',
					name: 'local-target',
					claimStatus: 'claimed',
					enabled: true,
					busy: false,
					acceptsIncoming: true,
					allowlisted: true,
					gateState: 'allowed',
					canDelegate: true,
					delegateActionHandle: 'g'.repeat(32),
					allowActionHandle: 'h'.repeat(32),
					incomingPeers: [],
				}],
			}],
		}, {
			key: 'tree-7',
			name: 'Lab Mac',
			locality: 'remote',
			state: 'online',
			nodes: [{
				key: 'tree-8',
				label: 'Backend window',
				thisWindow: false,
				status: 'online',
				workspaces: [{
					key: 'tree-9',
					name: 'orders-api',
					claimStatus: 'claimed',
					enabled: true,
					busy: false,
					acceptsIncoming: true,
					allowlisted: false,
					gateState: 'notAllowed',
					canDelegate: false,
					allowActionHandle: 'i'.repeat(32),
					incomingPeers: [],
				}, {
					key: 'tree-10',
					name: 'billing-api',
					claimStatus: 'claimed',
					enabled: true,
					busy: false,
					acceptsIncoming: true,
					allowlisted: true,
					gateState: 'allowed',
					canDelegate: true,
					delegateActionHandle: 'j'.repeat(32),
					allowActionHandle: 'k'.repeat(32),
					incomingPeers: [],
				}],
			}],
		}],
		policyCandidates: [{
			actionHandle: 'a'.repeat(32),
			windowLabel: 'Remote Window',
			workspaceName: 'remote-workspace',
			online: true,
			acceptsIncoming: true,
			busy: false,
			allowlisted: true,
			self: false,
			canToggle: true,
			claimState: 'claimed',
			gateState: 'allowed',
		}],
		outgoingTasks: [{
			actionHandle: 'b'.repeat(32),
			counterpartLabel: 'Remote Window',
			workspaceName: 'remote-workspace',
			title: 'Implement authentication',
			state: 'running',
			startedAt: '2026-08-31T00:00:00.000Z',
			shortId: '1234abcd',
			canCancel: true,
		}],
		incomingTasks: [],
		localNodes: [{
			nodeId: 'node-1',
			nodeInstanceId: 'instance-1',
			label: 'This Window',
			status: 'online',
			thisWindow: true,
			workspaces: [{
				workspaceId: 'workspace-1',
				name: 'service-workspace',
				capabilityTags: ['typescript'],
				enabled: true,
				busy: false,
				claimStatus: 'claimed',
			}],
		}],
		remoteDevices: [{
			deviceId: 'device-2',
			peerId: 'peer-1',
			name: 'remote-device',
			state: 'online',
			nodes: [{
				nodeId: 'node-2',
				nodeInstanceId: 'instance-2',
				label: 'Remote Window',
				status: 'online',
				thisWindow: false,
				workspaces: [{
					workspaceId: 'workspace-2',
					name: 'remote-workspace',
					capabilityTags: [],
					enabled: true,
					busy: false,
					claimStatus: 'claimed',
				}],
			}],
		}],
		workspaces: [],
		peers: [],
		tasks: [{
			taskId: 'task-1',
			title: 'Implement authentication',
			peerName: 'remote-device',
			workspaceName: 'service-workspace',
			state: 'running',
			phase: 'Editing',
			summary: 'Task is running.',
			canCancel: true,
			needsInput: false,
		}],
		errors: [],
	};
}

function connectivitySnapshot(): ConnectivitySnapshot {
	return {
		...DISABLED_CONNECTIVITY_SNAPSHOT,
		discoveryEnabled: true,
		strictPolicyActivated: true,
		publishEnabled: true,
		hostingBackend: 'sdk',
		accountProvider: 'microsoft',
		claimedWorkspaceCount: 1,
		receivingWorkspaceCount: 1,
		state: 'ready',
		candidates: [{
			actionHandle: '00000000-0000-4000-8000-000000000101',
			label: 'Candidate abcdef01',
			hostHint: 'unknown',
			stale: false,
			admission: 'private-port-token',
		}],
		incomingPeers: [{
			actionHandle: '00000000-0000-4000-8000-000000000102',
			label: 'Peer abcdef02',
			state: 'active',
			cleanupPending: false,
		}],
	};
}

function getConnectivityActionHandle(
	view: TestWebviewView,
	collection: 'candidates' | 'incomingPeers',
): string {
	const message = view.webview.sent.filter(({ type }) => type === 'dashboard.snapshot').at(-1);
	assert.ok(message);
	const model = message.model as ReturnType<DashboardPresenter['present']>;
	const handle = model.connectivity[collection][0]?.actionHandle;
	assert.strictEqual(typeof handle, 'string');
	return handle;
}

function getTreeWorkspaceHandle(
	message: Record<string, unknown>,
	workspaceKey: string,
	field: 'delegateActionHandle' | 'allowActionHandle' | 'receiveActionHandle',
): string | undefined {
	const model = message.model;
	if (typeof model !== 'object' || model === null || Array.isArray(model)) {
		return undefined;
	}
	const deviceTree = (model as Record<string, unknown>).deviceTree;
	if (!Array.isArray(deviceTree)) {
		return undefined;
	}
	for (const device of deviceTree) {
		const nodes = (device as { nodes?: unknown }).nodes;
		if (!Array.isArray(nodes)) {
			continue;
		}
		for (const node of nodes) {
			const workspaces = (node as { workspaces?: unknown }).workspaces;
			if (!Array.isArray(workspaces)) {
				continue;
			}
			for (const workspace of workspaces) {
				const record = workspace as Record<string, unknown>;
				if (record.key === workspaceKey && typeof record[field] === 'string') {
					return record[field] as string;
				}
			}
		}
	}
	return undefined;
}

function getTreeIncomingPeerHandle(
	message: Record<string, unknown>,
	workspaceKey: string,
	peerKey: string,
): string | undefined {
	const model = message.model;
	if (typeof model !== 'object' || model === null || Array.isArray(model)) {
		return undefined;
	}
	const deviceTree = (model as Record<string, unknown>).deviceTree;
	if (!Array.isArray(deviceTree)) {
		return undefined;
	}
	for (const device of deviceTree) {
		const nodes = (device as { nodes?: unknown }).nodes;
		if (!Array.isArray(nodes)) {
			continue;
		}
		for (const node of nodes) {
			const workspaces = (node as { workspaces?: unknown }).workspaces;
			if (!Array.isArray(workspaces)) {
				continue;
			}
			for (const workspace of workspaces) {
				const record = workspace as Record<string, unknown>;
				if (record.key !== workspaceKey || !Array.isArray(record.incomingPeers)) {
					continue;
				}
				for (const peer of record.incomingPeers) {
					const peerRecord = peer as Record<string, unknown>;
					if (peerRecord.key === peerKey && typeof peerRecord.actionHandle === 'string') {
						return peerRecord.actionHandle as string;
					}
				}
			}
		}
	}
	return undefined;
}

function getSnapshotTreeWorkspaceHandle(
	value: DashboardSnapshot,
	workspaceKey: string,
	field: 'delegateActionHandle' | 'allowActionHandle' | 'receiveActionHandle',
): string | undefined {
	const deviceTree = value.deviceTree;
	if (!Array.isArray(deviceTree)) {
		return undefined;
	}
	for (const device of deviceTree) {
		for (const node of device.nodes) {
			for (const workspace of node.workspaces) {
				if (workspace.key === workspaceKey) {
					const candidate = workspace[field];
					return typeof candidate === 'string' ? candidate : undefined;
				}
			}
		}
	}
	return undefined;
}

function findSnapshotWorkspace(
	value: DashboardSnapshot,
	predicate: (workspace: {
		key: string;
		name: string;
		deviceLocality: 'local' | 'remote';
		deviceState: string;
		nodeLabel: string;
	}) => boolean,
): { key: string; name: string; deviceLocality: 'local' | 'remote'; deviceState: string; nodeLabel: string } | undefined {
	const deviceTree = value.deviceTree;
	if (!Array.isArray(deviceTree)) {
		return undefined;
	}
	for (const device of deviceTree) {
		for (const node of device.nodes) {
			for (const workspace of node.workspaces) {
				const candidate = {
					key: workspace.key,
					name: workspace.name,
					deviceLocality: device.locality,
					deviceState: device.state,
					nodeLabel: node.label,
				} as const;
				if (predicate(candidate)) {
					return candidate;
				}
			}
		}
	}
	return undefined;
}

function withScopedConnectivity(connectivity: ConnectivitySnapshot): ReturnType<DashboardPresenter['present']> {
	const model = new DashboardPresenter().present({ ...snapshot(), connectivity });
	return {
		...model,
		connectivity: {
			...model.connectivity,
			candidates: model.connectivity.candidates.map((candidate, index) => ({
				...candidate, actionHandle: index.toString(16).padStart(32, 'd'),
			})),
			incomingPeers: model.connectivity.incomingPeers.map((peer, index) => ({
				...peer, actionHandle: index.toString(16).padStart(32, 'e'),
			})),
		},
	};
}

class DashboardTestElement {
	public textContent = '';
	public className = '';
	public disabled = false;
	public checked = false;
	public hidden = false;
	public tabIndex = 0;
	public readonly dataset: Record<string, string> = {};
	public readonly attributes: Record<string, string> = {};
	public readonly classList = { remove: (_name: string) => undefined };
	public readonly children: DashboardTestElement[] = [];
	private readonly listeners = new Map<string, (...args: unknown[]) => void>();
	public onFocus?: (element: DashboardTestElement) => void;

	public constructor(public tagName: string) {}

	public get text(): string {
		return [this.textContent, ...this.children.map((child) => child.text)].join(' ');
	}

	public append(...children: DashboardTestElement[]): void {
		this.children.push(...children);
	}

	public replaceChildren(): void {
		this.textContent = '';
		this.children.length = 0;
	}

	public setAttribute(name: string, value: string): void {
		this.attributes[name] = value;
		if (name.startsWith('data-')) {
			this.dataset[name.slice(5).replace(/-([a-z])/gu, (_all, letter: string) => letter.toUpperCase())] = value;
		}
	}

	public addEventListener(event: string, listener: (...args: unknown[]) => void): void {
		this.listeners.set(event, listener);
	}

	public focus(): void {
		this.onFocus?.(this);
		this.listeners.get('focus')?.();
	}

	public click(): void {
		assert.strictEqual(this.disabled, false, 'A disabled control cannot be activated.');
		this.focus();
		this.listeners.get('click')?.();
	}

	public toggle(): void {
		assert.strictEqual(this.disabled, false, 'A disabled control cannot be activated.');
		this.focus();
		this.checked = !this.checked;
		this.listeners.get('change')?.();
	}

	public keydown(key: string): void {
		this.listeners.get('keydown')?.({
			key,
			preventDefault: () => undefined,
		} as unknown as never);
	}

	public descendants(): DashboardTestElement[] {
		return [this, ...this.children.flatMap((child) => child.descendants())];
	}
}

async function createDashboardMediaHarness(): Promise<{
	readonly messages: Array<Record<string, unknown>>;
	element(id: string): DashboardTestElement;
	button(text: string): DashboardTestElement;
	treeItem(key: string): DashboardTestElement;
	checkbox(label: string | RegExp): DashboardTestElement;
	focusedElement(): DashboardTestElement | undefined;
	selectedTreeLabel(): string | undefined;
	receive(message: unknown): void;
	render(connectivity: ConnectivitySnapshot): void;
}> {
	const messages: Array<Record<string, unknown>> = [];
	let activeElement: DashboardTestElement | undefined;
	const roots = new Map<string, DashboardTestElement>([
		['refreshButton', new DashboardTestElement('button')],
		['settingsButton', new DashboardTestElement('button')],
		['closeSettingsButton', new DashboardTestElement('button')],
		['deviceTree', new DashboardTestElement('div')],
		['selectionSummary', new DashboardTestElement('p')],
		['selectionDetails', new DashboardTestElement('div')],
		['settingsDrawer', new DashboardTestElement('aside')],
		...[
			'device', 'thisWindow', 'acceptIncoming', 'listener', 'connectivity',
			'discoveryCandidates', 'incomingPeers', 'localNodes', 'savedAuthorizations',
			'outgoingTasks', 'incomingTasks', 'errors', 'announcement', 'operationStatus',
		].map((id) => [id, new DashboardTestElement('div')] as const),
	]);
	const onFocus = (element: DashboardTestElement) => { activeElement = element; };
	for (const root of roots.values()) { root.onFocus = onFocus; }
	const refresh = roots.get('refreshButton');
	const settings = roots.get('settingsButton');
	const closeSettings = roots.get('closeSettingsButton');
	assert.ok(refresh && settings && closeSettings);
	refresh.textContent = 'Refresh';
	settings.textContent = 'Settings';
	closeSettings.textContent = 'Close';
	const element = (id: string): DashboardTestElement => {
		const result = roots.get(id);
		assert.ok(result, `Unknown Dashboard element: ${id}`);
		return result;
	};
	let listener: ((event: { data: unknown }) => void) | undefined;
	const bundle = await readFile(
		vscode.Uri.joinPath(getExtension().extensionUri, 'media', 'dashboard.js').fsPath,
		'utf8',
	);
	runInNewContext(bundle, {
		TextEncoder,
		document: {
			body: { dataset: { uiInstanceId: 'media-view' } },
			get activeElement() { return activeElement; },
			querySelector: () => undefined,
			getElementById: element,
			createElement: (tag: string) => {
				const element = new DashboardTestElement(tag);
				element.onFocus = onFocus;
				return element;
			},
		},
		window: {
			addEventListener: (event: string, callback: (event: { data: unknown }) => void) => {
				assert.strictEqual(event, 'message');
				listener = callback;
			},
		},
		acquireVsCodeApi: () => ({
			postMessage: (message: unknown) => {
				messages.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>);
			},
		}),
	});
	const receive = (message: unknown): void => {
		assert.ok(listener);
		listener({ data: message });
	};
	return {
		messages,
		element,
		focusedElement: () => activeElement,
		button: (text: string) => {
			const result = [...[...roots.values()].flatMap((root) => root.descendants())]
				.find((candidate) => candidate.tagName === 'button' && candidate.textContent === text);
			assert.ok(result, `Missing Dashboard button: ${text}`);
			return result;
		},
		treeItem: (key: string) => {
			const result = element('deviceTree').descendants().find((candidate) =>
				candidate.attributes['data-tree-key'] === key);
			assert.ok(result, `Missing tree item: ${key}`);
			return result;
		},
		checkbox: (label: string | RegExp) => {
			const matcher = typeof label === 'string'
				? (value: string | undefined) => value === label
				: (value: string | undefined) => value !== undefined && label.test(value);
			const result = [...roots.values()].flatMap((root) => root.descendants()).find((candidate) =>
				candidate.tagName === 'input' && matcher(candidate.attributes['aria-label']));
			assert.ok(result, `Missing Dashboard checkbox: ${String(label)}`);
			return result;
		},
		selectedTreeLabel: () => element('deviceTree').descendants()
			.find((candidate) => candidate.attributes['aria-selected'] === 'true')
			?.text,
		receive,
		render: (connectivity: ConnectivitySnapshot) => receive({
			version: DASHBOARD_MESSAGE_VERSION, uiInstanceId: 'media-view',
			type: 'dashboard.snapshot', model: withScopedConnectivity(connectivity),
		}),
	};
}

function createConnectivityBindings(): {
	readonly bindings: ProductionDashboardBindings;
	readonly calls: string[];
	readonly mutations: Array<{ action: ConnectivityAction; actionHandle?: string }>;
	readonly commandCalls: Array<{ command: string; args: unknown[] }>;
	readonly describedTargets: unknown[];
	readonly state: {
		connectivity: ConnectivitySnapshot;
		remotePolicy: {
			workspaces: Array<{
				workspaceId: string;
				name: string;
				acceptsIncoming: boolean;
				receiveActionHandle: string;
				incomingPeers: Array<{
					peerId: string;
					label: string;
					autoAccept: boolean;
					actionHandle: string;
				}>;
			}>;
			remoteTargets: Array<{
				profileId: string;
				deviceId: string;
				nodeId: string;
				nodeInstanceId: string;
				workspaceId: string;
				allowlisted: boolean;
				acceptsIncoming: boolean;
				canDelegate: boolean;
				actionHandle?: string;
			}>;
			peerStates: Array<{
				profileId: string;
				deviceId: string;
				state: 'connecting' | 'online' | 'busy' | 'offline' | 'authFailed' | 'incompatible';
			}>;
			truncated: boolean;
		};
		connectivityError?: Error;
		directoryError?: Error;
		guardError?: Error;
		ownerListener?: ListenerSnapshot;
		previewEnabled?: boolean;
		localAcceptsIncoming?: boolean;
	};
} {
	const source = snapshot();
	const disposable = { dispose: () => undefined };
	const calls: string[] = [];
	const mutations: Array<{ action: ConnectivityAction; actionHandle?: string }> = [];
	const commandCalls: Array<{ command: string; args: unknown[] }> = [];
	const describedTargets: unknown[] = [];
	const state: {
		connectivity: ConnectivitySnapshot;
		remotePolicy: {
			workspaces: Array<{
				workspaceId: string;
				name: string;
				acceptsIncoming: boolean;
				receiveActionHandle: string;
				incomingPeers: Array<{
					peerId: string;
					label: string;
					autoAccept: boolean;
					actionHandle: string;
				}>;
			}>;
			remoteTargets: Array<{
				profileId: string;
				deviceId: string;
				nodeId: string;
				nodeInstanceId: string;
				workspaceId: string;
				allowlisted: boolean;
				acceptsIncoming: boolean;
				canDelegate: boolean;
				actionHandle?: string;
			}>;
			peerStates: Array<{
				profileId: string;
				deviceId: string;
				state: 'connecting' | 'online' | 'busy' | 'offline' | 'authFailed' | 'incompatible';
			}>;
			truncated: boolean;
		};
		connectivityError?: Error;
		directoryError?: Error;
		guardError?: Error;
		ownerListener?: ListenerSnapshot;
		previewEnabled?: boolean;
		localAcceptsIncoming?: boolean;
	} = {
		connectivity: DISABLED_CONNECTIVITY_SNAPSHOT,
		remotePolicy: {
			workspaces: [{
				workspaceId: '00000000-0000-4000-8000-000000000401',
				name: 'Source Workspace',
				acceptsIncoming: false,
				receiveActionHandle: '00000000-0000-4000-8000-000000000402',
				incomingPeers: [{
					peerId: '00000000-0000-4000-8000-000000000202',
					label: 'Cached remote device · Source Workspace',
					autoAccept: false,
					actionHandle: '00000000-0000-4000-8000-000000000403',
				}],
			}],
			remoteTargets: [{
				profileId: '00000000-0000-4000-8000-000000000202',
				deviceId: '00000000-0000-4000-8000-000000000201',
				nodeId: '00000000-0000-4000-8000-000000000211',
				nodeInstanceId: '00000000-0000-4000-8000-000000000212',
				workspaceId: '00000000-0000-4000-8000-000000000213',
				allowlisted: true,
				acceptsIncoming: true,
				canDelegate: true,
				actionHandle: '00000000-0000-4000-8000-000000000214',
			}],
			peerStates: [{
				profileId: '00000000-0000-4000-8000-000000000202',
				deviceId: '00000000-0000-4000-8000-000000000201',
				state: 'online',
			}],
			truncated: false,
		},
	};
	const native = () => {
		calls.push('native');
		assert.fail('Dashboard bindings must not call native account or provider APIs.');
	};
	const bindings = new ProductionDashboardBindings({
		vscodeApi: {
			window: {
				activeTextEditor: undefined,
				showInputBox: native,
				showQuickPick: native,
				showWarningMessage: native,
			},
			authentication: { getSession: native },
			workspace: {
				getConfiguration: () => ({ get: () => state.previewEnabled ?? false }),
				getWorkspaceFolder: () => undefined,
			},
			commands: {
				executeCommand: async (command: string, ...args: unknown[]) => {
					commandCalls.push({ command, args });
				},
			},
		},
		changed: {
			event: () => disposable,
			fire: () => { calls.push('changed'); },
		},
		profile: () => source.device,
		node: {
			nodeId: source.localNodes![0].nodeId,
			onDidChange: () => disposable,
			selectPeerPolicyWorkspace: () => ({
				kind: 'selected',
				workspaceIdentity: `sha256:${'a'.repeat(43)}`,
				workspaceId: 'source-workspace',
				workspaceName: 'Source Workspace',
				claimStatus: 'claimed',
			}),
			getPeerPolicy: async () => {
				calls.push('localPolicy');
				return { acceptsIncoming: state.localAcceptsIncoming ?? false };
			},
			listPeerPolicyCandidates: async () => ({ candidates: [], truncated: false }),
			listDashboardNodes: async () => ({
				deviceId: source.device.deviceId,
				nodes: source.localNodes,
				truncated: false,
				totalNodes: 1,
			}),
			listDashboardTasks: async () => ({
				tasks: source.outgoingTasks?.map((task) => ({ ...task, direction: 'outgoing' })),
				truncated: false,
				totalTasks: 1,
			}),
			connectivitySnapshot: async () => {
				calls.push('connectivitySnapshot');
				if (state.connectivityError !== undefined) {
					throw state.connectivityError;
				}
				return state.connectivity;
			},
			cachedRemoteDevices: async () => {
				calls.push('cachedRemoteDevices');
				if (state.directoryError !== undefined) {
					throw state.directoryError;
				}
				return {
					devices: [{
						deviceId: '00000000-0000-4000-8000-000000000201',
						deviceName: 'Cached remote device',
						peerId: '00000000-0000-4000-8000-000000000202',
						locality: 'remote',
						status: 'online',
						nodes: [{
							nodeId: '00000000-0000-4000-8000-000000000211',
							nodeInstanceId: '00000000-0000-4000-8000-000000000212',
							label: 'Backend window',
							status: 'online',
							workspaces: [{
								workspaceId: '00000000-0000-4000-8000-000000000213',
								name: 'billing-api',
								tags: [],
								busy: false,
								claimStatus: 'claimed',
							}],
						}],
						nodesTruncated: false,
						totalNodes: 1,
					}],
					truncated: false,
					totalDevices: 1,
				};
			},
			remotePolicyDashboard: async () => state.remotePolicy,
			connectivityAction: async (action: ConnectivityAction, actionHandle?: string) => {
				mutations.push({ action, ...(actionHandle === undefined ? {} : { actionHandle }) });
			},
		},
		localTasks: {
			describeDelegationTarget: async (intent: unknown) => {
				describedTargets.push(intent);
				return { windowName: 'Backend window', workspaceName: 'billing-api' };
			},
			startTask: async () => assert.fail('Opening a Chat draft must not start a task.'),
		},
		remoteTasks: {
			listDevices: async () => {
				calls.push('cloud');
				assert.fail('Rendering must use the authenticated local directory cache.');
			},
			listKnownTasks: () => [],
		},
		runtime: () => {
			calls.push('runtime');
			assert.ok(state.previewEnabled || state.connectivity.delegationEnabled, 'Default-off rendering must not probe or start hosting.');
			return {
				probe: async (options?: { requireEditor?: true }) => {
					if (!state.previewEnabled) {
						assert.deepStrictEqual(options, { requireEditor: true });
						calls.push('passiveEditorProbe');
					}
					return { available: false, featureEnabled: true, canStart: true, source: 'editor' };
				},
			};
		},
		guard: {
			assertAllowed: (options: unknown) => {
				assert.deepStrictEqual(options, { requireWorkspace: false });
				if (state.guardError !== undefined) {
					throw state.guardError;
				}
			},
		},
		workerPlatform: { supported: true },
		lifecycle: {
			onDidChange: () => disposable,
			snapshot: () => state.ownerListener === undefined
				? { state: 'contending', owner: false, holderWindowId: 'owner-window' }
				: { state: 'running', owner: true, holderWindowId: 'owner-window' },
		},
		ownerRuntime: () => {
			calls.push('ownerRuntime');
			return state.ownerListener === undefined ? undefined : {
				listener: { snapshot: () => state.ownerListener },
				get tunnel() { return assert.fail('Dashboard must not read legacy CLI runtime metrics.'); },
				get exposure() { return assert.fail('Dashboard must not access hosting providers.'); },
				get sdkExposure() { return assert.fail('Dashboard must not access SDK hosting directly.'); },
			};
		},
	} as unknown as ProductionDashboardBindingsOptions);
	return { bindings, calls, mutations, commandCalls, describedTargets, state };
}

function withTaskTitle(
	value: ReturnType<DashboardPresenter['present']>,
	title: string,
): ReturnType<DashboardPresenter['present']> {
	return {
		...value,
		outgoingTasks: value.outgoingTasks.map((task) => ({ ...task, title })),
	};
}

function withDeviceName(value: DashboardSnapshot, name: string): DashboardSnapshot {
	return {
		...value,
		device: { ...value.device, name },
	};
}

function getSnapshotDeviceName(message: Record<string, unknown>): unknown {
	const model = message.model;
	if (typeof model !== 'object' || model === null || Array.isArray(model)) {
		return undefined;
	}

	const device = (model as Record<string, unknown>).device;
	if (typeof device !== 'object' || device === null || Array.isArray(device)) {
		return undefined;
	}
	return (device as Record<string, unknown>).name;
}

function getCollectionActionHandle(
	message: Record<string, unknown>,
	collection: 'localNodes' | 'savedAuthorizations' | 'outgoingTasks' | 'incomingTasks',
): string | undefined {
	const model = message.model;
	if (typeof model !== 'object' || model === null || Array.isArray(model)) {
		return undefined;
	}

	const items = (model as Record<string, unknown>)[collection];
	if (!Array.isArray(items)) {
		return undefined;
	}
	const first = items[0];
	if (typeof first !== 'object' || first === null || Array.isArray(first)) {
		return undefined;
	}
	const handle = (first as Record<string, unknown>).actionHandle;
	return typeof handle === 'string' ? handle : undefined;
}

function getCollectionLength(
	message: Record<string, unknown>,
	collection: 'localNodes' | 'savedAuthorizations' | 'outgoingTasks' | 'incomingTasks',
): number | undefined {
	const model = message.model;
	if (typeof model !== 'object' || model === null || Array.isArray(model)) {
		return undefined;
	}
	const items = (model as Record<string, unknown>)[collection];
	return Array.isArray(items) ? items.length : undefined;
}

function getThisWindowActionHandle(message: Record<string, unknown>): string | undefined {
	const model = message.model;
	if (typeof model !== 'object' || model === null || Array.isArray(model)) {
		return undefined;
	}
	const thisWindow = (model as Record<string, unknown>).thisWindow;
	if (typeof thisWindow !== 'object' || thisWindow === null || Array.isArray(thisWindow)) {
		return undefined;
	}
	const handle = (thisWindow as Record<string, unknown>).acceptActionHandle;
	return typeof handle === 'string' ? handle : undefined;
}

function getExtension(): vscode.Extension<unknown> {
	const extension = vscode.extensions.getExtension('weivea.copilot-agent-mesh');
	assert.ok(extension);
	return extension;
}

function getUiInstanceId(html: string): string {
	const match = /data-ui-instance-id="([^"]+)"/.exec(html);
	assert.ok(match);
	return match[1];
}

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

type WindowRenameSelection =
	| {
		readonly kind: 'selected';
		readonly workspaceIdentity: string;
		readonly workspaceId: string;
		readonly workspaceName: string;
		readonly claimStatus: 'claimed';
	}
	| {
		readonly kind: 'unavailable';
		readonly workspaceName: string;
		readonly claimStatus: 'ambiguous';
	};

function createWindowRenameBindings(options: {
	readonly enabled: boolean;
	readonly selection: WindowRenameSelection | (() => WindowRenameSelection);
	readonly mutations: unknown[];
}): ProductionDashboardBindings {
	const disposable = { dispose: () => undefined };
	return new ProductionDashboardBindings({
		vscodeApi: {
			window: { activeTextEditor: undefined },
			workspace: {
				getConfiguration: () => ({
					get: () => options.enabled,
				}),
				getWorkspaceFolder: () => undefined,
			},
		},
		changed: {
			event: () => disposable,
			fire: () => undefined,
		},
		node: {
			nodeId: 'node-1',
			onDidChange: () => disposable,
			selectPeerPolicyWorkspace: () =>
				typeof options.selection === 'function' ? options.selection() : options.selection,
			getPeerPolicy: async (workspaceIdentity: string) => ({
				workspaceIdentity,
				windowName: 'This Window',
				acceptsIncoming: false,
				allowlist: [],
			}),
			setPeerPolicy: async (mutation: unknown) => {
				options.mutations.push(mutation);
				return mutation;
			},
		},
		guard: { assertAllowed: () => undefined },
		lifecycle: { onDidChange: () => disposable },
	} as unknown as ProductionDashboardBindingsOptions);
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) {
			return;
		}
		await settle();
	}
	assert.fail('Timed out waiting for dashboard test condition.');
}
