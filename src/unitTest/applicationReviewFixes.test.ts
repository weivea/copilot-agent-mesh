import * as assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { test } from 'node:test';
import type * as vscode from 'vscode';

import { ListenerService, type ListenerGateway, type ListenerPairing } from '../application/ListenerService';
import { LocalDesktopWorkspaceGuard } from '../application/LocalDesktopWorkspaceGuard';
import {
	TaskCoordinator,
	type CoordinatorPeerConnection,
	type CoordinatorPeerManager,
} from '../application/TaskCoordinator';
import { getWorkerPlatformSupport } from '../application/WorkerPlatformSupport';
import {
	ProductionDashboardBindings,
	type ProductionDashboardBindingsOptions,
	selectDashboardTaskTarget,
} from '../composition/ProductionDashboardBindings';
import {
	VscodeLocalTaskApproval,
	VscodeWindowNodeTaskConfirmation,
} from '../composition/VscodeAgentRuntime';
import { canonicalTaskRequestHash } from '../domain/task';
import { GatewayRouter } from '../gateway/GatewayRouter';
import { GatewayServer } from '../gateway/GatewayServer';
import { InMemoryPairingRecordStore, PairingService } from '../gateway/PairingService';
import { InMemorySecretStore } from '../gateway/SecretStore';
import { InMemoryPeerProfileStore } from '../peer/PeerProfile';
import type {
	DevTunnelProvider,
	DevTunnelRuntimeStatus,
	HostedTunnel,
	TunnelCapability,
	TunnelMetadata,
	TunnelRequest,
} from '../tunnel/DevTunnelProvider';

const peerId = '00000000-0000-4000-8000-000000000001';
const deviceId = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000003';

test('Worker Preview platform gate supports only macOS arm64', () => {
	assert.equal(getWorkerPlatformSupport('darwin', 'arm64').supported, true);
	for (const [platform, architecture] of [
		['darwin', 'x64'],
		['linux', 'x64'],
		['win32', 'x64'],
	] as const) {
		const support = getWorkerPlatformSupport(platform, architecture);
		assert.equal(support.supported, false);
		assert.equal(support.listenerCode, 'CLI_UNSUPPORTED');
		assert.equal(support.agentCode, 'AGENT_UNAVAILABLE');
		assert.match(support.listenerMessage, /Coordinator/u);
		assert.match(support.agentMessage, /Coordinator/u);
	}
});

test('TaskCoordinator excludes an online connection when the peer is disabled', async () => {
	let requests = 0;
	const connection: CoordinatorPeerConnection = {
		profileId: peerId,
		snapshot: () => ({ state: 'online' }),
		request: async () => {
			requests += 1;
			throw new Error('Disabled peer must not be queried.');
		},
	};
	const peers: CoordinatorPeerManager = {
		listConnections: () => [connection],
		isEnabled: () => false,
		get: () => connection,
	};
	const coordinator = new TaskCoordinator(
		peers,
		new InMemoryPeerProfileStore(),
		new MemoryState(),
		allowedGuard(),
	);
	const directory = await coordinator.listWorkers(new AbortController().signal);
	assert.deepStrictEqual(directory.devices, []);
	assert.deepStrictEqual(directory.workers, []);
	assert.equal(requests, 0);
});

test('TaskCoordinator preserves capabilities and excludes disabled workspaces', async () => {
	const connection: CoordinatorPeerConnection = {
		profileId: peerId,
		snapshot: () => ({ state: 'online' }),
		request: async (method) => method === 'device.getInfo'
			? {
				deviceId,
				name: 'Enabled Worker',
				platform: 'darwin',
				architecture: 'arm64',
				vscodeVersion: '1.134.0',
				extensionVersion: '0.0.1',
				protocolVersion: 2,
			}
			: {
				workspaces: [
					{
						workspaceId,
						name: 'Enabled workspace',
						capabilityTags: ['typescript', 'tests'],
						enabled: true,
						busy: false,
					},
					{
						workspaceId: '00000000-0000-4000-8000-000000000004',
						name: 'Disabled workspace',
						capabilityTags: ['secret-disabled-capability'],
						enabled: false,
						busy: false,
					},
				],
			},
	};
	const coordinator = new TaskCoordinator(
		{
			listConnections: () => [connection],
			isEnabled: () => true,
			get: () => connection,
		},
		new InMemoryPeerProfileStore(),
		new MemoryState(),
		allowedGuard(),
	);
	const directory = await coordinator.listWorkers(new AbortController().signal);
	assert.deepStrictEqual(directory.workers[0]?.capabilities, ['typescript', 'tests']);
	assert.deepStrictEqual(
		directory.workers[0]?.workspaces.map(({ workspaceId: id }) => id),
		[workspaceId],
	);
});

test('Dashboard requires explicit picks and skips disabled workers', async () => {
	const disabled = {
		peerId,
		deviceName: 'Disabled',
		capabilities: [],
		workspaces: [{ workspaceId, name: 'Disabled workspace', tags: [], busy: false }],
	};
	const enabled = {
		...disabled,
		peerId: deviceId,
		deviceName: 'Enabled',
	};
	const directory = { workers: [disabled, enabled] };
	let peerPicks = 0;
	let workspacePicks = 0;
	const selected = await selectDashboardTaskTarget(
		directory,
		undefined,
		undefined,
		(id) => id === deviceId,
		async (workers) => {
			peerPicks += 1;
			assert.deepStrictEqual(workers.map(({ peerId: id }) => id), [deviceId]);
			return workers[0];
		},
		async (workspaces) => {
			workspacePicks += 1;
			return workspaces[0];
		},
	);
	assert.equal(selected?.worker.peerId, deviceId);
	assert.equal(selected?.workspace.workspaceId, workspaceId);
	assert.equal(peerPicks, 1);
	assert.equal(workspacePicks, 1);
	assert.equal(
		await selectDashboardTaskTarget(
			directory,
			peerId,
			undefined,
			(id) => id === deviceId,
			async () => {
				throw new Error('Explicit disabled peer must not trigger a fallback pick.');
			},
			async () => {
				throw new Error('Disabled peer must not trigger a workspace pick.');
			},
		),
		undefined,
	);
});

test('production dashboard persists the separate title without deriving it from instructions', async () => {
	let persisted: {
		readonly title: string;
		readonly prompt: string;
	} | undefined;
	const disposable = { dispose: () => undefined };
	const bindings = new ProductionDashboardBindings({
		changed: {
			event: () => disposable,
			fire: () => undefined,
		},
		node: {
			onDidChange: () => disposable,
		},
		localTasks: {
			persistDelegationIntent: async (intent: {
				readonly title: string;
				readonly prompt: string;
			}) => {
				persisted = intent;
				return {
					delegationRequestId: '00000000-0000-4000-8000-000000000010',
					taskId: '00000000-0000-4000-8000-000000000011',
					recovered: false,
				};
			},
		},
		lifecycle: {
			onDidChange: () => disposable,
		},
	} as unknown as ProductionDashboardBindingsOptions);
	await bindings.runTask({
		target: {
			deviceId,
			nodeId: '00000000-0000-4000-8000-000000000020',
			nodeInstanceId: '00000000-0000-4000-8000-000000000021',
			workspaceId,
		},
		title: 'Non-sensitive task title',
		instruction: 'Sensitive prompt shown only during confirmation.',
	});

	assert.equal(persisted?.title, 'Non-sensitive task title');
	assert.equal(persisted?.prompt, 'Sensitive prompt shown only during confirmation.');
	assert.notEqual(persisted?.title, persisted?.prompt);
	bindings.dispose();
});

test('production dashboard uses the safe unfiltered directory for self, conflicts, truncation, and task names', async () => {
	const disposable = { dispose: () => undefined };
	const thisNodeId = '00000000-0000-4000-8000-000000000020';
	const thisInstanceId = '00000000-0000-4000-8000-000000000021';
	const conflictNodeId = '00000000-0000-4000-8000-000000000022';
	const taskId = '00000000-0000-4000-8000-000000000023';
	const bindings = new ProductionDashboardBindings({
		vscodeApi: {
			window: { activeTextEditor: undefined },
			workspace: {
				getConfiguration: () => ({ get: () => false }),
				getWorkspaceFolder: () => undefined,
			},
		},
		changed: {
			event: () => disposable,
			fire: () => undefined,
		},
		profile: () => ({
			deviceId,
			name: 'This Device',
			platform: 'darwin',
			architecture: 'arm64',
			vscodeVersion: '1.135.0',
			extensionVersion: '0.4.0',
		}),
		node: {
			nodeId: thisNodeId,
			onDidChange: () => disposable,
			selectPeerPolicyWorkspace: () => ({
				kind: 'selected',
				workspaceIdentity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				workspaceId,
				workspaceName: 'Source Workspace',
				claimStatus: 'claimed',
			}),
			listDashboardNodes: async () => ({
				deviceId,
				nodes: [
					{
						nodeId: thisNodeId,
						nodeInstanceId: thisInstanceId,
						label: 'This Window',
						status: 'online',
						workspaces: [{
							workspaceId,
							name: 'Source Workspace',
							capabilityTags: ['typescript'],
							enabled: true,
							busy: true,
							claimStatus: 'claimed',
							activeTaskId: taskId,
						}],
					},
					{
						nodeId: conflictNodeId,
						nodeInstanceId: '00000000-0000-4000-8000-000000000024',
						label: 'Duplicate Window',
						status: 'conflict',
						workspaces: [{
							workspaceId: '00000000-0000-4000-8000-000000000025',
							name: 'Conflicting Workspace',
							capabilityTags: [],
							enabled: true,
							busy: false,
							claimStatus: 'conflict',
						}],
					},
				],
				truncated: true,
				totalNodes: 3,
			}),
		},
		localTasks: {},
		remoteTasks: {
			listDevices: async () => ({ devices: [], truncated: false, totalDevices: 0 }),
			listKnownTasks: () => [],
		},
		runtime: {
			probe: async () => ({ available: false, featureEnabled: false }),
		},
		guard: {
			assertAllowed: () => undefined,
		},
		workerPlatform: {
			supported: true,
			listenerCode: 'CLI_UNSUPPORTED',
			listenerMessage: 'Unsupported',
			agentCode: 'AGENT_UNAVAILABLE',
			agentMessage: 'Unavailable',
		},
		lifecycle: {
			onDidChange: () => disposable,
			snapshot: () => ({ state: 'running', owner: true }),
		},
		ownerRuntime: () => ({
			listener: {
				snapshot: () => ({
					state: 'stopped',
					tunnel: { state: 'stopped' },
				}),
			},
			tasks: {
				list: async () => [{
					schemaVersion: 2,
					taskId,
					title: 'Named task',
					peerId: deviceId,
					sourceNodeId: thisNodeId,
					workspaceId,
					target: {
						deviceId,
						nodeId: thisNodeId,
						nodeInstanceId: thisInstanceId,
						workspaceId,
					},
					state: 'running',
				}],
			},
		}),
	} as unknown as ProductionDashboardBindingsOptions);

	const snapshot = await bindings.getSnapshot();
	assert.equal(snapshot.localNodes?.length, 2);
	assert.equal(snapshot.localNodes?.find(({ thisWindow }) => thisWindow)?.workspaces[0]?.name, 'Source Workspace');
	assert.ok(snapshot.errors.some(({ code }) => code === 'NODE_DIRECTORY_TRUNCATED'));
	assert.ok(snapshot.errors.some(({ code }) => code === 'WORKSPACE_CLAIM_CONFLICT'));
	assert.equal(snapshot.tasks[0]?.workspaceName, 'Source Workspace');
	assert.equal(snapshot.tasks[0]?.phase, 'Window Node: This Window');
	bindings.dispose();
});

test('local approval shows the full prompt and preapproval cannot be reused by title', async () => {
	const calls: unknown[][] = [];
	const choices: Array<string | undefined> = ['Run Once', undefined];
	const vscodeApi = {
		window: {
			showWarningMessage: async (...args: unknown[]) => {
				calls.push(args);
				return choices.shift();
			},
		},
	} as unknown as typeof vscode;
	const approval = new VscodeLocalTaskApproval(vscodeApi, new MemoryState());
	const fullPrompt = `Inspect every change.\n${'safe detail '.repeat(2_000)}`;
	const taskRequest = {
		delegationRequestId: '00000000-0000-4000-8000-000000000004',
		taskId: '00000000-0000-4000-8000-000000000005',
		workspaceId,
		title: 'Same title',
		prompt: fullPrompt,
		acceptanceCriteria: ['All checks pass'],
		workerDeadline: '2099-01-01T00:00:00.000Z',
	};
	const workspace = {
		workspaceId,
		registeredUri: 'file:///workspace',
		localUri: 'file:///workspace',
		fileIdentity: 'file:1:1',
		name: 'Workspace',
		capabilityTags: [],
		enabled: true,
		stale: false,
		createdAt: '2026-08-25T00:00:00.000Z',
		updatedAt: '2026-08-25T00:00:00.000Z',
	};
	assert.equal(await approval.confirm(peerId, taskRequest, workspace), true);
	assert.match(String((calls[0]?.[1] as { detail?: string })?.detail), /Peer:/u);
	assert.match(String((calls[0]?.[1] as { detail?: string })?.detail), /Workspace/u);
	assert.match(String((calls[0]?.[1] as { detail?: string })?.detail), /Same title/u);
	assert.ok(String((calls[0]?.[1] as { detail?: string })?.detail).includes(fullPrompt));
	assert.deepEqual(calls[0]?.slice(2), ['Run Once']);

	const changedRuntimeRequest = {
		taskId: taskRequest.taskId,
		title: taskRequest.title,
		prompt: 'Different prompt with the same title.',
		acceptanceCriteria: taskRequest.acceptanceCriteria,
		workspaceId,
		workspace: {
			workspaceId,
			displayName: workspace.name,
			uri: workspace.localUri,
		},
		approvalContext: {
			peerId,
			workspaceId,
			requestHash: canonicalTaskRequestHash({
				...taskRequest,
				acceptanceCriteria: [...taskRequest.acceptanceCriteria],
				peerId,
				workspaceLeaseKey: workspace.fileIdentity,
			}),
		},
	};
	assert.equal(await approval.confirm(changedRuntimeRequest), 'deny');
	assert.equal(calls.length, 2);
	assert.equal(await approval.confirm({
		...changedRuntimeRequest,
		prompt: fullPrompt,
	}), 'once');
	assert.equal(calls.length, 2);
});

test('Window Node confirmation names both windows, workspace, title, and full prompt', async () => {
	const calls: unknown[][] = [];
	const vscodeApi = {
		window: {
			showWarningMessage: async (...args: unknown[]) => {
				calls.push(args);
				return 'Run Once';
			},
		},
	} as unknown as typeof vscode;
	const confirmation = new VscodeWindowNodeTaskConfirmation(vscodeApi);
	const result = await confirmation.confirm({
		sourceWindowLabel: 'Source Window',
		targetWindowLabel: 'Target Window',
		workspaceDisplayName: 'Workspace',
		taskTitle: 'Review changes',
		prompt: 'Full prompt text.',
	});
	assert.equal(result, 'once');
	const detail = String((calls[0]?.[1] as { detail?: string }).detail);
	for (const expected of [
		'Source Window',
		'Target Window',
		'Workspace',
		'Review changes',
		'Full prompt text.',
	]) {
		assert.ok(detail.includes(expected));
	}
});

test('real GatewayServer retries HTTP close after a transient stop failure', async () => {
	const pairing = new PairingService(
		deviceId,
		new InMemorySecretStore(),
		new InMemoryPairingRecordStore(),
	);
	let closeCalls = 0;
	const gateway = new GatewayServer(
		pairing,
		new GatewayRouter(
			{ getInfo: async () => ({ deviceId }) },
			{ list: async () => ({ workspaces: [] }) },
			{
				start: async () => { throw new Error('not used'); },
				get: async () => { throw new Error('not used'); },
				cancel: async () => { throw new Error('not used'); },
				answer: async () => { throw new Error('not used'); },
			},
		),
		{
			closeHttpServer: async (server: Server) => {
				closeCalls += 1;
				if (closeCalls === 1) {
					throw new Error('transient close failure');
				}
				await closeServer(server);
			},
		},
	);
	const address = await gateway.start();
	await assert.rejects(gateway.dispose(), /transient close failure/u);
	assert.equal((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status, 204);
	await gateway.dispose();
	assert.equal(closeCalls, 2);
	await pairing.dispose();
});

test('unsupported ListenerService fails before probing with stable CLI_UNSUPPORTED state', async () => {
	const tunnel = new RecordingTunnel();
	const listener = createListener(tunnel, new RecordingGateway(), new RecordingPairing(), {
		supported: false,
		listenerCode: 'CLI_UNSUPPORTED',
		listenerMessage: 'Worker Preview requires macOS arm64. Coordinator remains available.',
		agentCode: 'AGENT_UNAVAILABLE',
		agentMessage: 'Worker Preview requires macOS arm64. Coordinator remains available.',
	});
	await assert.rejects(listener.start(), /macOS arm64/u);
	assert.equal(tunnel.probeCalls, 0);
	assert.equal(listener.snapshot().error?.code, 'CLI_UNSUPPORTED');
	await listener.dispose();
});

test('ListenerService creates an exact service-compatible ownership label', async () => {
	const tunnel = new RecordingTunnel();
	const listener = createListener(tunnel, new RecordingGateway(), new RecordingPairing());
	await listener.start();
	assert.equal(tunnel.lastRequest?.ownershipLabel, 'copilot-agent-mesh-0000000000004000800000000000000');
	assert.equal(tunnel.lastRequest?.ownershipLabel.length, 50);
	await listener.dispose();
});

test('ListenerService stops reporting running and copy-ready after tunnel access expires', async () => {
	const tunnel = new RecordingTunnel();
	const gateway = new RecordingGateway();
	const listener = createListener(tunnel, gateway, new RecordingPairing());
	let changes = 0;
	const subscription = listener.onDidChange(() => {
		changes += 1;
	});
	await listener.start();

	tunnel.expireAccess();

	const snapshot = listener.snapshot();
	assert.equal(snapshot.state, 'error');
	assert.equal(snapshot.error?.code, 'TUNNEL_ACCESS_EXPIRED');
	assert.equal(snapshot.forwardingOrigin, undefined);
	await assert.rejects(listener.createConnectionUrl(), /Start the listener/u);
	assert.ok(changes >= 3);
	await settleMicrotasks();
	assert.equal(gateway.disposeCalls, 1);

	await listener.start();
	assert.equal(listener.snapshot().state, 'running');
	assert.equal(tunnel.stopCalls, 1);
	subscription.dispose();
	await listener.dispose();
});

test('ListenerService publishes transient tunnel backoff without reporting a copy-ready endpoint', async () => {
	const tunnel = new RecordingTunnel();
	const listener = createListener(tunnel, new RecordingGateway(), new RecordingPairing());
	let changes = 0;
	listener.onDidChange(() => {
		changes += 1;
	});
	await listener.start();
	const beforeBackoff = changes;

	tunnel.enterBackoff();

	assert.equal(listener.snapshot().tunnel.state, 'backoff');
	assert.equal(changes, beforeBackoff + 1);
	await assert.rejects(listener.createConnectionUrl(), /Start the listener/u);
	await listener.dispose();
});

test('ListenerService dispose succeeds after a prior stop failure and releases all ownership', async () => {
	const tunnel = new RecordingTunnel();
	tunnel.stopFailures = 1;
	const gateway = new RecordingGateway();
	const pairing = new RecordingPairing();
	const listener = createListener(tunnel, gateway, pairing);
	await listener.start();
	await assert.rejects(listener.stop(), AggregateError);
	await listener.dispose();
	assert.equal(listener.snapshot().state, 'stopped');
	assert.ok(gateway.disposeCalls >= 2);
	assert.ok(tunnel.stopCalls >= 3);
	assert.equal(pairing.disposeCalls, 1);
});

test('ListenerService aggregates double cleanup failures and retains retryable ownership', async () => {
	const tunnel = new RecordingTunnel();
	tunnel.stopFailures = 2;
	const gateway = new RecordingGateway();
	gateway.disposeFailures = 2;
	const pairing = new RecordingPairing();
	const listener = createListener(tunnel, gateway, pairing);
	await listener.start();
	await assert.rejects(
		listener.dispose(),
		(error: unknown) => error instanceof AggregateError && error.errors.length >= 2,
	);
	assert.equal(listener.snapshot().state, 'error');
	assert.ok(gateway.disposeCalls >= 2);
	assert.ok(tunnel.stopCalls >= 2);
	assert.equal(pairing.disposeCalls, 1);
	await listener.dispose();
	assert.equal(listener.snapshot().state, 'stopped');
});

test('ListenerService retries failed subscription cleanup without re-disposing services', async () => {
	const tunnel = new RecordingTunnel();
	tunnel.subscriptionDisposeFailures = 1;
	const gateway = new RecordingGateway();
	const pairing = new RecordingPairing();
	const listener = createListener(tunnel, gateway, pairing);
	await listener.start();

	await assert.rejects(listener.dispose(), (error: unknown) =>
		error instanceof AggregateError
		&& error.errors.length === 1
		&& error.errors[0] instanceof Error
		&& error.errors[0].message === 'subscription cleanup failed',
	);
	const stopCalls = tunnel.stopCalls;
	const gatewayDisposeCalls = gateway.disposeCalls;
	assert.equal(pairing.disposeCalls, 1);
	assert.equal(tunnel.subscriptionDisposeCalls, 1);

	await listener.dispose();
	assert.equal(tunnel.stopCalls, stopCalls);
	assert.equal(gateway.disposeCalls, gatewayDisposeCalls);
	assert.equal(pairing.disposeCalls, 1);
	assert.equal(tunnel.subscriptionDisposeCalls, 2);
	await listener.dispose();
	assert.equal(tunnel.subscriptionDisposeCalls, 2);
});

test('ListenerService never replaces retained Gateway ownership after failed startup cleanup', async () => {
	const tunnel = new RecordingTunnel();
	tunnel.ensureFailures = 1;
	const first = new RecordingGateway();
	first.disposeFailures = 2;
	const second = new RecordingGateway();
	const gateways = [first, second];
	let created = 0;
	const listener = new ListenerService(
		deviceId,
		new RecordingPairing(),
		tunnel,
		() => gateways[created++]!,
		new MemoryState(),
		allowedGuard(),
		{ workerPlatform: getWorkerPlatformSupport('darwin', 'arm64') },
	);
	await assert.rejects(listener.start(), AggregateError);
	assert.equal(created, 1);
	await assert.rejects(listener.start(), AggregateError);
	assert.equal(created, 1);
	await listener.start();
	assert.equal(created, 2);
	await listener.dispose();
});

function createListener(
	tunnel: RecordingTunnel,
	gateway: RecordingGateway,
	pairing: RecordingPairing,
	workerPlatform = getWorkerPlatformSupport('darwin', 'arm64'),
): ListenerService {
	return new ListenerService(
		deviceId,
		pairing,
		tunnel,
		() => gateway,
		new MemoryState(),
		allowedGuard(),
		{ workerPlatform },
	);
}

function allowedGuard(): LocalDesktopWorkspaceGuard {
	return new LocalDesktopWorkspaceGuard(() => ({
		remoteName: undefined,
		isTrusted: true,
		workspaceFolders: [{ uriScheme: 'file' }],
	}));
}

class MemoryState {
	private readonly values = new Map<string, unknown>();

	public get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

class RecordingGateway implements ListenerGateway {
	public disposeCalls = 0;
	public disposeFailures = 0;

	public async start(): Promise<{ readonly port: number }> {
		return { port: 43123 };
	}

	public async dispose(): Promise<void> {
		this.disposeCalls += 1;
		if (this.disposeFailures > 0) {
			this.disposeFailures -= 1;
			throw new Error('gateway cleanup failed');
		}
	}

	public async notifyPeer(): Promise<void> {}
}

class RecordingPairing implements ListenerPairing {
	public disposeCalls = 0;

	public async createInvitation(): Promise<{ readonly url: string }> {
		return { url: 'https://worker.example/connect' };
	}

	public async dispose(): Promise<void> {
		this.disposeCalls += 1;
	}
}

class RecordingTunnel implements DevTunnelProvider {
	public probeCalls = 0;
	public stopCalls = 0;
	public stopFailures = 0;
	public ensureFailures = 0;
	public subscriptionDisposeCalls = 0;
	public subscriptionDisposeFailures = 0;
	public lastRequest: TunnelRequest | undefined;
	private readonly listeners = new Set<() => void>();
	private status: DevTunnelRuntimeStatus = { state: 'stopped' };

	public async probe(): Promise<TunnelCapability> {
		this.probeCalls += 1;
		return { loggedIn: true, supported: true, build: 'test' };
	}

	public async ensureHosted(request: TunnelRequest): Promise<HostedTunnel> {
		this.lastRequest = request;
		if (this.ensureFailures > 0) {
			this.ensureFailures -= 1;
			throw new Error('tunnel startup failed');
		}
		const hosted: HostedTunnel = {
			accessDuration: request.accessDuration,
			accessExpiresAt: '2099-01-01T00:00:00.000Z',
			accessIndex: 0,
			build: 'test',
			decoderRevision: 'test',
			forwardingOrigin: 'https://worker.example',
			localPort: request.localPort,
			ownershipLabel: request.ownershipLabel,
			provisioned: true,
			status: 'ready',
			tunnelAlias: request.tunnelAlias,
			tunnelExpiresAt: '2099-01-01T00:00:00.000Z',
			tunnelId: 'test',
		};
		this.status = { state: 'ready', tunnel: hosted };
		return hosted;
	}

	public async renewAccess(): Promise<TunnelMetadata> {
		throw new Error('not used');
	}

	public async stop(): Promise<void> {
		this.stopCalls += 1;
		if (this.stopFailures > 0) {
			this.stopFailures -= 1;
			throw new Error('tunnel cleanup failed');
		}
		this.status = { state: 'stopped' };
	}

	public dispose(): Promise<void> {
		return this.stop();
	}

	public getStatus(): DevTunnelRuntimeStatus {
		return this.status;
	}

	public onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return {
			dispose: () => {
				this.subscriptionDisposeCalls += 1;
				if (this.subscriptionDisposeFailures > 0) {
					this.subscriptionDisposeFailures -= 1;
					throw new Error('subscription cleanup failed');
				}
				this.listeners.delete(listener);
			},
		};
	}

	public expireAccess(): void {
		this.status = {
			state: 'circuit-open',
			code: 'TUNNEL_ACCESS_EXPIRED',
			message: 'The owned anonymous access entry has expired.',
		};
		for (const listener of this.listeners) {
			listener();
		}
	}

	public enterBackoff(): void {
		this.status = {
			state: 'backoff',
			attempt: 1,
			retryAt: '2026-08-25T10:00:00.000Z',
		};
		for (const listener of this.listeners) {
			listener();
		}
	}
}

async function settleMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function closeServer(server: Server): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.close((error) => error === undefined ? resolve() : reject(error));
	});
}
