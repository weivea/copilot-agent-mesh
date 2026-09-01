import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
	TERMINAL_TASK_STATUSES,
	PROTOCOL_LIMITS,
	brokerRemoteListResultSchema,
	deviceInfoSchema,
	MESH_ERROR_CODES,
	nodeDirectoryResultSchema,
	routedTaskStartParamsSchema,
	serializedLocalResultBytes,
	taskAnswerParamsSchema,
	taskSnapshotAfterEventSeqSchema,
	taskSnapshotSchema,
	taskStatusSchema,
	taskTargetSchema,
	timestampSchema,
	uuidSchema,
	type MeshErrorReason,
	type RoutedTaskStartParams,
	type TaskSnapshot,
	type TaskSnapshotAfterEventSeq,
} from '../../shared/protocol';
import type {
	MeshDeviceToolSummary,
	MeshRemoteDirectorySnapshot,
} from '../../shared/toolProtocol';
import { MeshDomainError } from '../domain/errors';
import type { StateStore } from '../domain/ports';
import type { PeerConnectionManager } from '../peer/PeerConnectionManager';
import {
	isUsablePeerProfile,
	type PeerProfile,
	type PeerProfileStore,
} from '../peer/PeerProfile';
import {
	PeerRpcError,
	PeerTransportError,
} from '../peer/WebSocketPeerTransport';
import type {
	RemoteTaskRouteAdapter,
	RemoteTaskStartOutcome,
} from '../tools/LocalBrokerTaskFacade';

export const REMOTE_TASK_ROUTE_STATE_KEY = 'copilotAgentMesh.remoteTaskRoutes.v2';
export const REMOTE_TASK_ROUTE_LIMIT = 1_000;

const remoteTaskRouteSchema = z.strictObject({
	taskId: uuidSchema,
	delegationRequestId: uuidSchema,
	requestHash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
	peerId: uuidSchema,
	target: taskTargetSchema,
	createdAt: timestampSchema,
	state: z.union([taskStatusSchema, z.literal('ambiguous')]).default('ambiguous'),
	terminalAt: timestampSchema.optional(),
}).superRefine((route, context) => {
	if (isTerminal(route.state) !== (route.terminalAt !== undefined)) {
		context.addIssue({
			code: 'custom',
			path: ['terminalAt'],
			message: 'Only terminal remote routes require terminalAt',
		});
	}
});

const remoteTaskRouteCatalogSchema = z.strictObject({
	schemaVersion: z.literal(2),
	routes: z.array(remoteTaskRouteSchema).max(REMOTE_TASK_ROUTE_LIMIT),
}).superRefine((catalog, context) => {
	const taskIds = new Set<string>();
	for (const [index, route] of catalog.routes.entries()) {
		if (taskIds.has(route.taskId)) {
			context.addIssue({
				code: 'custom',
				path: ['routes', index, 'taskId'],
				message: 'Remote task route IDs must be unique',
			});
		}
		taskIds.add(route.taskId);
	}
});

type RemoteTaskRoute = z.infer<typeof remoteTaskRouteSchema>;
type RemoteTaskRouteCatalog = z.infer<typeof remoteTaskRouteCatalogSchema>;

interface RemoteRouteReservation {
	readonly route: RemoteTaskRoute;
	readonly attemptId: number;
}

interface RemoteRouteAttemptGroup {
	readonly route: RemoteTaskRoute;
	readonly attempts: Set<number>;
	readonly releasable: boolean;
	protected: boolean;
}

class VolatileStateStore implements StateStore {
	private readonly values = new Map<string, unknown>();

	public get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, structuredClone(value));
	}
}

/**
 * Owner-only outbound v2 coordinator. Per-window callers reach this instance
 * through the authenticated local Device Broker.
 */
export class ProductionRemoteTaskAdapter implements RemoteTaskRouteAdapter {
	private readonly taskRoutes = new Map<string, RemoteTaskRoute>();
	private readonly snapshots = new Map<string, TaskSnapshot | TaskSnapshotAfterEventSeq>();
	private readonly state: StateStore;
	private readonly now: () => Date;
	private readonly routeAttemptGroups = new Map<string, RemoteRouteAttemptGroup>();
	private routeMutation = Promise.resolve();
	private nextRouteAttemptId = 1;

	public constructor(
		private readonly peers: PeerConnectionManager,
		private readonly profiles: PeerProfileStore,
		state: StateStore = new VolatileStateStore(),
		now: () => Date = () => new Date(),
	) {
		this.state = state;
		this.now = now;
		for (const route of this.readCatalog().routes) {
			this.taskRoutes.set(route.taskId, route);
		}
	}

	public async listDevices(signal: AbortSignal): Promise<MeshRemoteDirectorySnapshot> {
		throwIfAborted(signal);
		const profiles = (await this.profiles.list()).filter(isUsablePeerProfile);
		const connections = new Map(
			this.peers.listConnections().map((connection) => [connection.profileId, connection]),
		);
		const devices = await Promise.all(profiles.map(
			async (profile): Promise<MeshDeviceToolSummary | undefined> => {
				const incompatible = incompatibleDevice(profile);
				const connection = connections.get(profile.id);
				const state = connection?.snapshot().state;
				if (
					connection === undefined
					|| !this.peers.isEnabled(profile.id)
					|| state !== 'online'
				) {
					return incompatible;
				}
				try {
					const [deviceValue, nodesValue] = await Promise.all([
						raceAbort(connection.request('device.getInfo', {}), signal),
						raceAbort(connection.request('node.list', {}), signal),
					]);
					const device = deviceInfoSchema.parse(deviceValue);
					const directory = nodeDirectoryResultSchema.parse(nodesValue);
					if (directory.deviceId !== device.deviceId) {
						return incompatible;
					}
					return {
						deviceId: device.deviceId,
						deviceName: device.name,
						locality: 'remote' as const,
						status: 'online' as const,
						peerId: uuidSchema.parse(profile.id),
						nodesTruncated: directory.truncated,
						totalNodes: directory.totalNodes,
						nodes: directory.nodes.map((node) => ({
							nodeId: node.nodeId,
							nodeInstanceId: node.nodeInstanceId,
							label: node.label,
							status: node.status,
							capabilities: [...node.capabilities],
							workspaces: node.workspaces.map((workspace) => ({
								workspaceId: workspace.workspaceId,
								name: workspace.name,
								tags: [...workspace.capabilityTags],
								busy: workspace.busy,
								claimStatus: workspace.claimStatus,
							})),
						})),
					};
				} catch (error: unknown) {
					if (signal.aborted) {
						throw error;
					}
					return incompatible;
				}
			},
		));
		return budgetRemoteDirectory(devices.filter((device) => device !== undefined));
	}

	public async startTask(
		input: RoutedTaskStartParams,
		route: { readonly peerId?: string },
		outcome?: RemoteTaskStartOutcome,
	): Promise<TaskSnapshot> {
		const params = routedTaskStartParamsSchema.parse(input);
		const peerId = uuidSchema.safeParse(route.peerId);
		if (!peerId.success) {
			throw new MeshDomainError(
				'TUNNEL_UNAVAILABLE',
				'An explicit remote peer route is required.',
			);
		}
		const connection = await this.validateStart(params, peerId.data);
		const reservation = await this.reserveRoute(params, peerId.data);
		const gatewayParams: RoutedTaskStartParams = {
			delegationRequestId: params.delegationRequestId,
			taskId: params.taskId,
			target: params.target,
			title: params.title,
			prompt: params.prompt,
			acceptanceCriteria: params.acceptanceCriteria,
			...(params.timeoutMinutes === undefined
				? {}
				: { timeoutMinutes: params.timeoutMinutes }),
			workerDeadline: params.workerDeadline,
			...(params.sourceWorkspaceIdentity === undefined
				? {}
				: { sourceWorkspaceIdentity: params.sourceWorkspaceIdentity }),
		};
		const dispatch = outcome ?? { taskStartRequestAttempted: false };
		try {
			if (this.requireOnline(peerId.data) !== connection) {
				throw new MeshDomainError(
					'TUNNEL_UNAVAILABLE',
					'The explicit remote peer route changed during validation.',
					true,
				);
			}
			dispatch.taskStartRequestAttempted = true;
			const snapshot = this.parsePeerResult(
				taskSnapshotSchema,
				await this.requestPeer(connection.request('task.start', gatewayParams)),
			);
			this.assertSnapshotRoute(snapshot, reservation.route);
			await this.recordSnapshot(snapshot);
			await this.retainRouteAttempt(reservation);
			return snapshot;
		} catch (error: unknown) {
			if (dispatch.taskStartRequestAttempted) {
				await this.retainRouteAttempt(reservation);
			} else {
				await this.releaseRouteAttempt(reservation);
			}
			throw error;
		}
	}

	public async prevalidateStartTask(
		input: RoutedTaskStartParams,
		route: { readonly peerId?: string },
	): Promise<void> {
		const params = routedTaskStartParamsSchema.parse(input);
		const peerId = uuidSchema.safeParse(route.peerId);
		if (!peerId.success) {
			throw new MeshDomainError(
				'TUNNEL_UNAVAILABLE',
				'An explicit remote peer route is required.',
			);
		}
		await this.validateStart(params, peerId.data);
	}

	public async getTask(
		taskId: string,
		afterEventSequence: number | undefined,
		signal: AbortSignal,
	): Promise<TaskSnapshot | TaskSnapshotAfterEventSeq | undefined> {
		const parsedTaskId = uuidSchema.parse(taskId);
		const route = this.taskRoutes.get(parsedTaskId);
		if (route === undefined) {
			return undefined;
		}
		let value: unknown;
		try {
			value = await raceAbort(this.requestPeer(
				this.requireOnline(route.peerId).request('task.get', {
					taskId: parsedTaskId,
					...(afterEventSequence === undefined ? {} : { afterEventSeq: afterEventSequence }),
				}),
			), signal);
		} catch (error: unknown) {
			if (error instanceof MeshDomainError && error.reason === 'TASK_NOT_FOUND') {
				return undefined;
			}
			throw error;
		}
		const snapshot = afterEventSequence === undefined
			? this.parsePeerResult(taskSnapshotSchema, value)
			: this.parsePeerResult(taskSnapshotAfterEventSeqSchema, value);
		this.assertSnapshotRoute(snapshot, route);
		await this.recordSnapshot(snapshot);
		return snapshot;
	}

	public async cancelTask(
		taskId: string,
		signal: AbortSignal,
	): Promise<TaskSnapshot | undefined> {
		const parsedTaskId = uuidSchema.parse(taskId);
		const route = this.taskRoutes.get(parsedTaskId);
		if (route === undefined) {
			return undefined;
		}
		const snapshot = this.parsePeerResult(taskSnapshotSchema, await raceAbort(
			this.requestPeer(
				this.requireOnline(route.peerId).request('task.cancel', { taskId: parsedTaskId }),
			),
			signal,
		));
		this.assertSnapshotRoute(snapshot, route);
		await this.recordSnapshot(snapshot);
		return snapshot;
	}

	public async answerTask(
		taskId: string,
		inputId: string,
		answerId: string,
		answer: string,
		signal: AbortSignal,
	): Promise<TaskSnapshot | undefined> {
		const params = taskAnswerParamsSchema.parse({ taskId, inputId, answerId, answer });
		const route = this.taskRoutes.get(params.taskId);
		if (route === undefined) {
			return undefined;
		}
		const snapshot = this.parsePeerResult(taskSnapshotSchema, await raceAbort(
			this.requestPeer(
				this.requireOnline(route.peerId).request('task.answer', params),
			),
			signal,
		));
		this.assertSnapshotRoute(snapshot, route);
		await this.recordSnapshot(snapshot);
		return snapshot;
	}

	public listKnownTasks(): readonly (TaskSnapshot | TaskSnapshotAfterEventSeq)[] {
		return [...this.snapshots.values()].map((snapshot) => structuredClone(snapshot));
	}

	private reserveRoute(
		input: RoutedTaskStartParams,
		peerId: string,
	): Promise<RemoteRouteReservation> {
		const operation = async (): Promise<RemoteRouteReservation> => {
			const catalog = this.readCatalog();
			const existing = catalog.routes.find((route) => route.taskId === input.taskId);
			if (existing !== undefined) {
				if (!sameRoute(existing, input, peerId)) {
					throw new MeshDomainError(
						'IDEMPOTENCY_CONFLICT',
						'The task ID is already bound to another explicit remote route.',
					);
				}
				this.taskRoutes.set(existing.taskId, existing);
				return this.routeReservation(existing, false);
			}
			const retained = makeRemoteCapacity(catalog.routes);
			const candidate = remoteTaskRouteSchema.parse({
				taskId: input.taskId,
				delegationRequestId: input.delegationRequestId,
				requestHash: remoteRequestHash(input, peerId),
				peerId,
				target: input.target,
				createdAt: this.now().toISOString(),
				state: 'ambiguous',
			});
			await this.state.update(REMOTE_TASK_ROUTE_STATE_KEY, {
				schemaVersion: 2,
				routes: [...retained, candidate],
			} satisfies RemoteTaskRouteCatalog);
			for (const route of catalog.routes) {
				if (!retained.some(({ taskId }) => taskId === route.taskId)) {
					this.taskRoutes.delete(route.taskId);
					this.snapshots.delete(route.taskId);
				}
			}
			this.taskRoutes.set(candidate.taskId, candidate);
			return this.routeReservation(candidate, true);
		};
		return this.serializeRoute(operation);
	}

	private routeReservation(
		route: RemoteTaskRoute,
		created: boolean,
	): RemoteRouteReservation {
		const attemptId = this.nextRouteAttemptId;
		this.nextRouteAttemptId += 1;
		let group = this.routeAttemptGroups.get(route.taskId);
		if (group === undefined || !sameRemoteRouteRecord(group.route, route)) {
			group = {
				route: structuredClone(route),
				attempts: new Set<number>(),
				releasable: created,
				protected: !created,
			};
			this.routeAttemptGroups.set(route.taskId, group);
		}
		group.attempts.add(attemptId);
		return {
			route: structuredClone(route),
			attemptId,
		};
	}

	private retainRouteAttempt(reservation: RemoteRouteReservation): Promise<void> {
		return this.serializeRoute(async () => {
			const group = this.requireRouteAttemptGroup(reservation);
			group.protected = true;
			group.attempts.delete(reservation.attemptId);
			if (group.attempts.size === 0) {
				this.routeAttemptGroups.delete(group.route.taskId);
			}
		});
	}

	private releaseRouteAttempt(reservation: RemoteRouteReservation): Promise<boolean> {
		return this.serializeRoute(async () => {
			const group = this.requireRouteAttemptGroup(reservation);
			group.attempts.delete(reservation.attemptId);
			if (group.attempts.size > 0) {
				return false;
			}
			this.routeAttemptGroups.delete(group.route.taskId);
			if (group.protected || !group.releasable) {
				return false;
			}
			const catalog = this.readCatalog();
			const current = catalog.routes.find(({ taskId }) => taskId === group.route.taskId);
			if (
				current === undefined
				|| current.state !== 'ambiguous'
				|| !sameRemoteRouteRecord(current, group.route)
			) {
				return false;
			}
			await this.state.update(REMOTE_TASK_ROUTE_STATE_KEY, {
				schemaVersion: 2,
				routes: catalog.routes.filter(({ taskId }) => taskId !== current.taskId),
			} satisfies RemoteTaskRouteCatalog);
			this.taskRoutes.delete(current.taskId);
			this.snapshots.delete(current.taskId);
			return true;
		});
	}

	private requireRouteAttemptGroup(
		reservation: RemoteRouteReservation,
	): RemoteRouteAttemptGroup {
		const group = this.routeAttemptGroups.get(reservation.route.taskId);
		if (
			group === undefined
			|| !group.attempts.has(reservation.attemptId)
			|| !sameRemoteRouteRecord(group.route, reservation.route)
		) {
			throw new TypeError('The remote task route reservation attempt is no longer active.');
		}
		return group;
	}

	private serializeRoute<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.routeMutation.then(operation, operation);
		this.routeMutation = result.then(() => undefined, () => undefined);
		return result;
	}

	private readCatalog(): RemoteTaskRouteCatalog {
		const value = this.state.get<unknown>(REMOTE_TASK_ROUTE_STATE_KEY);
		if (value === undefined) {
			return { schemaVersion: 2, routes: [] };
		}
		const parsed = remoteTaskRouteCatalogSchema.safeParse(value);
		if (!parsed.success) {
			throw new TypeError('Invalid persisted remote task route catalog.');
		}
		return structuredClone(parsed.data);
	}

	private recordSnapshot(
		snapshot: TaskSnapshot | TaskSnapshotAfterEventSeq,
	): Promise<void> {
		const operation = async (): Promise<void> => {
			const catalog = this.readCatalog();
			const route = catalog.routes.find(({ taskId }) => taskId === snapshot.taskId);
			if (route === undefined) {
				throw new MeshDomainError(
					'PROTOCOL_INCOMPATIBLE',
					'The remote task response has no persisted route.',
				);
			}
			this.assertSnapshotRoute(snapshot, route);
			const terminalAt = isTerminal(snapshot.state) ? snapshot.updatedAt : undefined;
			if (route.state === snapshot.state && route.terminalAt === terminalAt) {
				this.snapshots.set(snapshot.taskId, structuredClone(snapshot));
				return;
			}
			const { terminalAt: _previousTerminalAt, ...routeWithoutTerminalAt } = route;
			const updated = remoteTaskRouteSchema.parse({
				...routeWithoutTerminalAt,
				state: snapshot.state,
				...(terminalAt === undefined ? {} : { terminalAt }),
			});
			await this.state.update(REMOTE_TASK_ROUTE_STATE_KEY, {
				schemaVersion: 2,
				routes: catalog.routes.map((candidate) =>
					candidate.taskId === updated.taskId ? updated : candidate,
				),
			} satisfies RemoteTaskRouteCatalog);
			this.taskRoutes.set(updated.taskId, updated);
			this.snapshots.set(snapshot.taskId, structuredClone(snapshot));
		};
		const result = this.routeMutation.then(operation, operation);
		this.routeMutation = result.then(() => undefined, () => undefined);
		return result;
	}

	private async validateStart(
		params: RoutedTaskStartParams,
		peerId: string,
	) {
		const existing = this.taskRoutes.get(params.taskId);
		if (existing !== undefined && !sameRoute(existing, params, peerId)) {
			throw new MeshDomainError(
				'IDEMPOTENCY_CONFLICT',
				'The task ID is already bound to another explicit remote route.',
			);
		}
		if (
			existing === undefined
			&& Date.parse(params.workerDeadline) <= this.now().valueOf()
		) {
			throw new MeshDomainError(
				'TASK_EXECUTION_FAILED',
				'The task worker deadline has already expired.',
			);
		}
		const connection = this.requireOnline(peerId);
		const device = this.parsePeerResult(
			deviceInfoSchema,
			await this.requestPeer(connection.request('device.getInfo', {})),
		);
		if (device.deviceId !== params.target.deviceId) {
			throw new MeshDomainError(
				'TASK_ID_CONFLICT',
				'The explicit remote device route is stale.',
			);
		}
		return connection;
	}

	private requireOnline(peerId: string) {
		const connection = this.peers.get(peerId);
		if (
			connection === undefined
			|| !this.peers.isEnabled(peerId)
			|| connection.snapshot().state !== 'online'
		) {
			throw new MeshDomainError(
				'TUNNEL_UNAVAILABLE',
				'The explicit remote peer route is unavailable.',
				true,
			);
		}
		return connection;
	}

	private async requestPeer(operation: Promise<unknown>): Promise<unknown> {
		try {
			return await operation;
		} catch (error: unknown) {
			if (error instanceof PeerRpcError) {
				if (isMeshErrorReason(error.reason)) {
					throw new MeshDomainError(
						error.reason,
						'The remote mesh request was rejected.',
						error.retryable,
					);
				}
				throw new MeshDomainError(
					'TASK_EXECUTION_FAILED',
					'The remote mesh request failed.',
					error.retryable,
				);
			}
			if (error instanceof PeerTransportError) {
				throw new MeshDomainError(
					'TUNNEL_UNAVAILABLE',
					'The remote peer connection is unavailable.',
					true,
				);
			}
			throw error;
		}
	}

	private parsePeerResult<T>(schema: z.ZodType<T>, value: unknown): T {
		const parsed = schema.safeParse(value);
		if (!parsed.success) {
			throw new MeshDomainError(
				'PROTOCOL_INCOMPATIBLE',
				'The remote peer returned an incompatible response.',
			);
		}
		return parsed.data;
	}

	private assertSnapshotRoute(
		snapshot: TaskSnapshot | TaskSnapshotAfterEventSeq,
		route: RemoteTaskRoute,
	): void {
		if (
			snapshot.taskId !== route.taskId
			|| snapshot.delegationRequestId !== route.delegationRequestId
			|| snapshot.deviceId !== route.target.deviceId
			|| snapshot.workspaceId !== route.target.workspaceId
		) {
			throw new MeshDomainError(
				'PROTOCOL_INCOMPATIBLE',
				'The remote task response does not match its persisted route.',
			);
		}
	}
}

function incompatibleDevice(profile: PeerProfile): MeshDeviceToolSummary | undefined {
	const deviceId = uuidSchema.safeParse(profile.workerDeviceId);
	const peerId = uuidSchema.safeParse(profile.id);
	if (!deviceId.success || !peerId.success) {
		return undefined;
	}
	return {
		deviceId: deviceId.data,
		deviceName: deviceId.data,
		locality: 'remote',
		status: 'incompatible',
		peerId: peerId.data,
		nodesTruncated: false,
		totalNodes: 0,
		nodes: [],
	};
}

export function budgetRemoteDirectory(
	input: readonly MeshDeviceToolSummary[],
): MeshRemoteDirectorySnapshot {
	const sources = [...input].sort((left, right) =>
		left.deviceId.localeCompare(right.deviceId)
		|| (left.peerId ?? '').localeCompare(right.peerId ?? ''),
	);
	const devices: MeshDeviceToolSummary[] = [];
	let stoppedForBytes = false;
	for (
		let index = 0;
		index < sources.length && index < PROTOCOL_LIMITS.deviceListCount;
		index += 1
	) {
		const source = sources[index];
		const device: MeshDeviceToolSummary = {
			...source,
			nodes: [],
			nodesTruncated: source.totalNodes > 0,
		};
		const withDevice = {
			devices: [...devices, device],
			truncated: devices.length + 1 < sources.length,
			totalDevices: sources.length,
		};
		if (serializedLocalResultBytes(withDevice) > PROTOCOL_LIMITS.frameBytes) {
			stoppedForBytes = true;
			break;
		}
		devices.push(device);
		const nodes = device.nodes as MeshDeviceToolSummary['nodes'][number][];
		for (const node of source.nodes) {
			nodes.push(structuredClone(node));
			const returnedAll = nodes.length === source.totalNodes && !source.nodesTruncated;
			const candidateDevice = {
				...device,
				nodes,
				nodesTruncated: !returnedAll,
			};
			const candidate = {
				devices: [
					...devices.slice(0, -1),
					candidateDevice,
				],
				truncated: devices.length < sources.length,
				totalDevices: sources.length,
			};
			if (serializedLocalResultBytes(candidate) > PROTOCOL_LIMITS.frameBytes) {
				nodes.pop();
				stoppedForBytes = true;
				break;
			}
		}
		const returnedAll = nodes.length === source.totalNodes && !source.nodesTruncated;
		devices[devices.length - 1] = {
			...device,
			nodes,
			nodesTruncated: !returnedAll,
		};
		if (stoppedForBytes) {
			break;
		}
	}
	const result = {
		devices,
		truncated: devices.length < sources.length,
		totalDevices: sources.length,
	};
	return brokerRemoteListResultSchema.parse(result);
}

function sameRoute(
	route: RemoteTaskRoute,
	input: RoutedTaskStartParams,
	peerId: string,
): boolean {
	return route.delegationRequestId === input.delegationRequestId
		&& (route.requestHash === undefined
			|| route.requestHash === remoteRequestHash(input, peerId))
		&& route.peerId === peerId
		&& route.target.deviceId === input.target.deviceId
		&& route.target.nodeId === input.target.nodeId
		&& route.target.nodeInstanceId === input.target.nodeInstanceId
		&& route.target.workspaceId === input.target.workspaceId;
}

function sameRemoteRouteRecord(left: RemoteTaskRoute, right: RemoteTaskRoute): boolean {
	return left.taskId === right.taskId
		&& left.delegationRequestId === right.delegationRequestId
		&& left.requestHash === right.requestHash
		&& left.peerId === right.peerId
		&& left.createdAt === right.createdAt
		&& left.state === right.state
		&& left.terminalAt === right.terminalAt
		&& left.target.deviceId === right.target.deviceId
		&& left.target.nodeId === right.target.nodeId
		&& left.target.nodeInstanceId === right.target.nodeInstanceId
		&& left.target.workspaceId === right.target.workspaceId;
}

function makeRemoteCapacity(routes: readonly RemoteTaskRoute[]): readonly RemoteTaskRoute[] {
	if (routes.length < REMOTE_TASK_ROUTE_LIMIT) {
		return routes;
	}
	const oldestTerminal = routes
		.filter((route) => route.terminalAt !== undefined && isTerminal(route.state))
		.sort((left, right) =>
			left.terminalAt!.localeCompare(right.terminalAt!)
			|| left.createdAt.localeCompare(right.createdAt)
			|| left.taskId.localeCompare(right.taskId),
		)[0];
	if (oldestTerminal === undefined) {
		throw new MeshDomainError(
			'RATE_LIMITED',
			'The remote task route catalog is full of active or ambiguous routes.',
		);
	}
	return routes.filter((route) => route.taskId !== oldestTerminal.taskId);
}

function remoteRequestHash(input: RoutedTaskStartParams, peerId: string): string {
	const fields = [
		'copilot-agent-mesh/remote-task-route/v2',
		peerId,
		input.delegationRequestId,
		input.taskId,
		input.target.deviceId,
		input.target.nodeId,
		input.target.nodeInstanceId,
		input.target.workspaceId,
		input.sourceNodeId ?? '',
		input.sourceWorkspaceIdentity ?? '',
		String(input.timeoutMinutes ?? ''),
		input.title,
		input.prompt,
		String(input.acceptanceCriteria.length),
		...input.acceptanceCriteria,
		input.workerDeadline,
	];
	return createHash('sha256')
		.update(fields.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join(''), 'utf8')
		.digest('hex');
}

function isTerminal(state: string): boolean {
	return (TERMINAL_TASK_STATUSES as readonly string[]).includes(state);
}

function isMeshErrorReason(reason: string): reason is MeshErrorReason {
	return Object.hasOwn(MESH_ERROR_CODES, reason);
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => {
			signal.removeEventListener('abort', abort);
			reject(new DOMException('Remote mesh operation cancelled.', 'AbortError'));
		};
		signal.addEventListener('abort', abort, { once: true });
		void operation.then(
			(value) => {
				signal.removeEventListener('abort', abort);
				if (!signal.aborted) {
					resolve(value);
				}
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort);
				if (!signal.aborted) {
					reject(error);
				}
			},
		);
	});
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new DOMException('Remote mesh operation cancelled.', 'AbortError');
	}
}
