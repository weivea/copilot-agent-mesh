import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
	TERMINAL_TASK_STATUSES,
	routedTaskStartParamsSchema,
	taskStatusSchema,
	taskTargetSchema,
	timestampSchema,
	uuidSchema,
	type RoutedTaskStartParams,
	type TaskSnapshot,
	type TaskSnapshotAfterEventSeq,
	type TaskStatus,
} from '../../shared/protocol';
import { MeshDomainError } from '../domain/errors';
import type { StateStore } from '../domain/ports';

export const TASK_ROUTE_CATALOG_STATE_KEY = 'copilotAgentMesh.taskRouteCatalog.v1';
export const TASK_ROUTE_CATALOG_LIMIT = 1_000;

const routeStateSchema = z.union([taskStatusSchema, z.literal('ambiguous')]);
const taskRouteRecordSchema = z.strictObject({
	taskId: uuidSchema,
	delegationRequestId: uuidSchema,
	requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
	target: taskTargetSchema,
	routeKind: z.enum(['local', 'remote']),
	peerId: uuidSchema.optional(),
	sourceNodeId: uuidSchema.optional(),
	sourcePeerId: uuidSchema.optional(),
	sourceWorkspaceIdentity: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/u).optional(),
	createdAt: timestampSchema,
	state: routeStateSchema,
	terminalAt: timestampSchema.optional(),
}).superRefine((route, context) => {
	if (
		route.routeKind === 'remote'
		&& (
			route.peerId === undefined
			|| route.sourceNodeId === undefined
			|| route.sourcePeerId !== undefined
		)
	) {
		context.addIssue({
			code: 'custom',
			message: 'Outbound remote routes require peerId and sourceNodeId only',
		});
	}
	if (
		route.routeKind === 'local'
		&& (
			route.peerId !== undefined
			|| (route.sourceNodeId === undefined) === (route.sourcePeerId === undefined)
		)
	) {
		context.addIssue({
			code: 'custom',
			message: 'Local routes require exactly one authenticated source',
		});
	}
	const terminal = isTerminal(route.state);
	if (terminal !== (route.terminalAt !== undefined)) {
		context.addIssue({
			code: 'custom',
			path: ['terminalAt'],
			message: 'Only terminal routes require terminalAt',
		});
	}
});

const taskRouteCatalogSchema = z.strictObject({
	schemaVersion: z.literal(1),
	routes: z.array(taskRouteRecordSchema).max(TASK_ROUTE_CATALOG_LIMIT),
}).superRefine((catalog, context) => {
	const taskIds = new Set<string>();
	const delegationIds = new Set<string>();
	for (const [index, route] of catalog.routes.entries()) {
		if (taskIds.has(route.taskId)) {
			context.addIssue({
				code: 'custom',
				path: ['routes', index, 'taskId'],
				message: 'Task route IDs must be unique',
			});
		}
		const delegationKey = `${route.sourceWorkspaceIdentity ?? 'legacy'}:${route.delegationRequestId}`;
		if (delegationIds.has(delegationKey)) {
			context.addIssue({
				code: 'custom',
				path: ['routes', index, 'delegationRequestId'],
				message: 'Delegation route IDs must be unique',
			});
		}
		taskIds.add(route.taskId);
		delegationIds.add(delegationKey);
	}
});

export type TaskRouteRecord = z.infer<typeof taskRouteRecordSchema>;
type TaskRouteCatalogState = z.infer<typeof taskRouteCatalogSchema>;

export interface TaskRouteReservation {
	readonly route: TaskRouteRecord;
	readonly attemptId: number;
}

export interface TaskRouteNoDispatchProof {
	readonly taskPersisted: false;
	readonly dispatchAttempted: false;
}

interface RouteAttemptGroup {
	readonly route: TaskRouteRecord;
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

export class TaskRouteCatalog {
	private readonly state: StateStore;
	private readonly now: () => Date;
	private readonly routes = new Map<string, TaskRouteRecord>();
	private readonly attemptGroups = new Map<string, RouteAttemptGroup>();
	private mutation = Promise.resolve();
	private nextAttemptId = 1;

	public constructor(
		state: StateStore = new VolatileStateStore(),
		now: () => Date = () => new Date(),
	) {
		this.state = state;
		this.now = now;
		for (const route of this.readCatalog().routes) {
			this.routes.set(route.taskId, route);
		}
	}

	public reserveLocal(
		input: RoutedTaskStartParams,
		source: { readonly nodeId?: string; readonly peerId?: string },
	): Promise<TaskRouteRecord> {
		return this.reserve(input, localRoute(source));
	}

	public reserveLocalAttempt(
		input: RoutedTaskStartParams,
		source: { readonly nodeId?: string; readonly peerId?: string },
	): Promise<TaskRouteReservation> {
		return this.reserveAttempt(input, localRoute(source));
	}

	public reserveRemote(
		input: RoutedTaskStartParams,
		peerId: string,
		sourceNodeId: string,
	): Promise<TaskRouteRecord> {
		return this.reserve(input, remoteRoute(peerId, sourceNodeId));
	}

	public reserveRemoteAttempt(
		input: RoutedTaskStartParams,
		peerId: string,
		sourceNodeId: string,
	): Promise<TaskRouteReservation> {
		return this.reserveAttempt(input, remoteRoute(peerId, sourceNodeId));
	}

	public assertLocalCompatible(
		input: RoutedTaskStartParams,
		source: { readonly nodeId?: string; readonly peerId?: string },
	): void {
		this.assertCompatible(input, localRoute(source));
	}

	public assertRemoteCompatible(
		input: RoutedTaskStartParams,
		peerId: string,
		sourceNodeId: string,
	): void {
		this.assertCompatible(input, remoteRoute(peerId, sourceNodeId));
	}

	public retainAmbiguous(reservation: TaskRouteReservation): Promise<void> {
		const operation = async (): Promise<void> => {
			const group = this.requireAttemptGroup(reservation);
			group.protected = true;
			group.attempts.delete(reservation.attemptId);
			if (group.attempts.size === 0) {
				this.attemptGroups.delete(group.route.taskId);
			}
		};
		return this.serialize(operation);
	}

	public releaseAmbiguous(
		reservation: TaskRouteReservation,
		proof: TaskRouteNoDispatchProof,
	): Promise<boolean> {
		if (proof.taskPersisted !== false || proof.dispatchAttempted !== false) {
			throw new TypeError('An ambiguous route can only be released with no-dispatch proof.');
		}
		const operation = async (): Promise<boolean> => {
			const group = this.requireAttemptGroup(reservation);
			group.attempts.delete(reservation.attemptId);
			if (group.attempts.size > 0) {
				return false;
			}
			this.attemptGroups.delete(group.route.taskId);
			if (group.protected || !group.releasable) {
				return false;
			}
			const catalog = this.readCatalog();
			const current = catalog.routes.find(({ taskId }) => taskId === group.route.taskId);
			if (
				current === undefined
				|| current.state !== 'ambiguous'
				|| !sameRouteRecord(current, group.route)
			) {
				return false;
			}
			await this.writeCatalog(catalog.routes.filter(
				({ taskId }) => taskId !== current.taskId,
			));
			this.routes.delete(current.taskId);
			return true;
		};
		return this.serialize(operation);
	}

	public get(taskId: string): TaskRouteRecord | undefined {
		const route = this.routes.get(uuidSchema.parse(taskId));
		return route === undefined ? undefined : structuredClone(route);
	}

	public list(): readonly TaskRouteRecord[] {
		return [...this.routes.values()].map((route) => structuredClone(route));
	}

	public requireForNode(taskId: string, sourceNodeId: string): TaskRouteRecord {
		const route = this.get(taskId);
		const source = uuidSchema.parse(sourceNodeId);
		if (route === undefined || route.sourceNodeId !== source) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'Task not found.');
		}
		return route;
	}

	public requireInbound(taskId: string, sourcePeerId: string): TaskRouteRecord {
		const route = this.get(taskId);
		const source = uuidSchema.parse(sourcePeerId);
		if (
			route === undefined
			|| route.routeKind !== 'local'
			|| route.sourcePeerId !== source
		) {
			throw new MeshDomainError('TASK_NOT_FOUND', 'Task not found.');
		}
		return route;
	}

	public markSnapshot(
		snapshot: TaskSnapshot | TaskSnapshotAfterEventSeq,
	): Promise<TaskRouteRecord> {
		const operation = async (): Promise<TaskRouteRecord> => {
			const route = this.routes.get(snapshot.taskId);
			if (
				route === undefined
				|| route.delegationRequestId !== snapshot.delegationRequestId
				|| route.target.deviceId !== snapshot.deviceId
				|| route.target.workspaceId !== snapshot.workspaceId
			) {
				throw new MeshDomainError(
					'PROTOCOL_INCOMPATIBLE',
					'The task response does not match its authoritative route.',
				);
			}
			const terminalAt = isTerminal(snapshot.state) ? snapshot.updatedAt : undefined;
			if (route.state === snapshot.state && route.terminalAt === terminalAt) {
				return structuredClone(route);
			}
			const { terminalAt: _previousTerminalAt, ...routeWithoutTerminalAt } = route;
			const updated = taskRouteRecordSchema.parse({
				...routeWithoutTerminalAt,
				state: snapshot.state,
				...(terminalAt === undefined ? {} : { terminalAt }),
			});
			const catalog = this.readCatalog();
			const routes = catalog.routes.map((candidate) =>
				candidate.taskId === updated.taskId ? updated : candidate,
			);
			await this.writeCatalog(routes);
			this.routes.set(updated.taskId, updated);
			return structuredClone(updated);
		};
		return this.serialize(operation);
	}

	public markState(taskId: string, state: TaskStatus, updatedAt: string): Promise<void> {
		const id = uuidSchema.parse(taskId);
		const parsedState = taskStatusSchema.parse(state);
		const at = timestampSchema.parse(updatedAt);
		const operation = async (): Promise<void> => {
			const route = this.routes.get(id);
			if (route === undefined) {
				throw new MeshDomainError('TASK_NOT_FOUND', 'Task route not found.');
			}
			const terminalAt = isTerminal(parsedState) ? at : undefined;
			if (route.state === parsedState && route.terminalAt === terminalAt) {
				return;
			}
			const { terminalAt: _previousTerminalAt, ...routeWithoutTerminalAt } = route;
			const updated = taskRouteRecordSchema.parse({
				...routeWithoutTerminalAt,
				state: parsedState,
				...(terminalAt === undefined ? {} : { terminalAt }),
			});
			const catalog = this.readCatalog();
			await this.writeCatalog(catalog.routes.map((candidate) =>
				candidate.taskId === updated.taskId ? updated : candidate,
			));
			this.routes.set(updated.taskId, updated);
		};
		const result = this.serialize(operation);
		return result.then(() => undefined);
	}

	private reserve(
		input: RoutedTaskStartParams,
		route: Pick<
			TaskRouteRecord,
			'routeKind' | 'peerId' | 'sourceNodeId' | 'sourcePeerId' | 'sourceWorkspaceIdentity'
		>,
	): Promise<TaskRouteRecord> {
		return this.reserveCore(input, route, false) as Promise<TaskRouteRecord>;
	}

	private reserveAttempt(
		input: RoutedTaskStartParams,
		route: Pick<
			TaskRouteRecord,
			'routeKind' | 'peerId' | 'sourceNodeId' | 'sourcePeerId' | 'sourceWorkspaceIdentity'
		>,
	): Promise<TaskRouteReservation> {
		return this.reserveCore(input, route, true) as Promise<TaskRouteReservation>;
	}

	private reserveCore(
		input: RoutedTaskStartParams,
		route: Pick<
			TaskRouteRecord,
			'routeKind' | 'peerId' | 'sourceNodeId' | 'sourcePeerId' | 'sourceWorkspaceIdentity'
		>,
		asAttempt: boolean,
	): Promise<TaskRouteRecord | TaskRouteReservation> {
		const params = routedTaskStartParamsSchema.parse(input);
		const operation = async (): Promise<TaskRouteRecord | TaskRouteReservation> => {
			const catalog = this.readCatalog();
			const requestHash = canonicalRouteRequestHash(params, route);
			const existing = catalog.routes.find((candidate) =>
				candidate.taskId === params.taskId
				|| (
					candidate.delegationRequestId === params.delegationRequestId
					&& candidate.sourceWorkspaceIdentity === params.sourceWorkspaceIdentity
				),
			);
			if (existing !== undefined) {
				if (
					existing.taskId !== params.taskId
					|| existing.delegationRequestId !== params.delegationRequestId
					|| existing.requestHash !== requestHash
					|| existing.routeKind !== route.routeKind
					|| existing.peerId !== route.peerId
					|| existing.sourceNodeId !== route.sourceNodeId
					|| existing.sourcePeerId !== route.sourcePeerId
					|| existing.sourceWorkspaceIdentity !== params.sourceWorkspaceIdentity
					|| !sameTarget(existing.target, params.target)
				) {
					throw new MeshDomainError(
						'IDEMPOTENCY_CONFLICT',
						'Task identifiers are already bound to another authoritative route.',
					);
				}
				this.routes.set(existing.taskId, existing);
				return this.reservationResult(existing, false, asAttempt);
			}

			const retained = makeCapacity(catalog.routes);
			const candidate = taskRouteRecordSchema.parse({
				taskId: params.taskId,
				delegationRequestId: params.delegationRequestId,
				requestHash,
				target: params.target,
				...route,
				...(params.sourceWorkspaceIdentity === undefined
					? {}
					: { sourceWorkspaceIdentity: params.sourceWorkspaceIdentity }),
				createdAt: this.now().toISOString(),
				state: 'ambiguous',
			});
			await this.writeCatalog([...retained, candidate]);
			for (const taskId of new Set(catalog.routes.map(({ taskId }) => taskId))) {
				if (!retained.some((retainedRoute) => retainedRoute.taskId === taskId)) {
					this.routes.delete(taskId);
				}
			}
			this.routes.set(candidate.taskId, candidate);
			return this.reservationResult(candidate, true, asAttempt);
		};
		return this.serialize(operation);
	}

	private reservationResult(
		route: TaskRouteRecord,
		created: boolean,
		asAttempt: boolean,
	): TaskRouteRecord | TaskRouteReservation {
		if (!asAttempt) {
			return structuredClone(route);
		}
		const attemptId = this.nextAttemptId;
		this.nextAttemptId += 1;
		let group = this.attemptGroups.get(route.taskId);
		if (group === undefined || !sameRouteRecord(group.route, route)) {
			group = {
				route: structuredClone(route),
				attempts: new Set<number>(),
				releasable: created,
				protected: !created,
			};
			this.attemptGroups.set(route.taskId, group);
		}
		group.attempts.add(attemptId);
		return {
			route: structuredClone(route),
			attemptId,
		};
	}

	private requireAttemptGroup(reservation: TaskRouteReservation): RouteAttemptGroup {
		const group = this.attemptGroups.get(reservation.route.taskId);
		if (
			group === undefined
			|| !group.attempts.has(reservation.attemptId)
			|| !sameRouteRecord(group.route, reservation.route)
		) {
			throw new TypeError('The task route reservation attempt is no longer active.');
		}
		return group;
	}

	private assertCompatible(
		input: RoutedTaskStartParams,
		route: Pick<
			TaskRouteRecord,
			'routeKind' | 'peerId' | 'sourceNodeId' | 'sourcePeerId' | 'sourceWorkspaceIdentity'
		>,
	): void {
		const params = routedTaskStartParamsSchema.parse(input);
		const existing = [...this.routes.values()].find((candidate) =>
			candidate.taskId === params.taskId
			|| (
				candidate.delegationRequestId === params.delegationRequestId
				&& candidate.sourceWorkspaceIdentity === params.sourceWorkspaceIdentity
			),
		);
		if (
			existing !== undefined
			&& (
				existing.taskId !== params.taskId
				|| existing.delegationRequestId !== params.delegationRequestId
				|| existing.requestHash !== canonicalRouteRequestHash(params, route)
				|| existing.routeKind !== route.routeKind
				|| existing.peerId !== route.peerId
				|| existing.sourceNodeId !== route.sourceNodeId
				|| existing.sourcePeerId !== route.sourcePeerId
				|| existing.sourceWorkspaceIdentity !== params.sourceWorkspaceIdentity
				|| !sameTarget(existing.target, params.target)
			)
		) {
			throw new MeshDomainError(
				'IDEMPOTENCY_CONFLICT',
				'Task identifiers are already bound to another authoritative route.',
			);
		}
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutation.then(operation, operation);
		this.mutation = result.then(() => undefined, () => undefined);
		return result;
	}

	private readCatalog(): TaskRouteCatalogState {
		const value = this.state.get<unknown>(TASK_ROUTE_CATALOG_STATE_KEY);
		if (value === undefined) {
			return { schemaVersion: 1, routes: [] };
		}
		const parsed = taskRouteCatalogSchema.safeParse(value);
		if (!parsed.success) {
			throw new TypeError('Invalid persisted authoritative task route catalog.');
		}
		return structuredClone(parsed.data);
	}

	private async writeCatalog(routes: readonly TaskRouteRecord[]): Promise<void> {
		const catalog = taskRouteCatalogSchema.parse({
			schemaVersion: 1,
			routes,
		});
		await this.state.update(TASK_ROUTE_CATALOG_STATE_KEY, catalog);
	}
}

function makeCapacity(routes: readonly TaskRouteRecord[]): readonly TaskRouteRecord[] {
	if (routes.length < TASK_ROUTE_CATALOG_LIMIT) {
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
			'The authoritative task route catalog is full of active or ambiguous routes.',
		);
	}
	return routes.filter((route) => route.taskId !== oldestTerminal.taskId);
}

function canonicalRouteRequestHash(
	input: RoutedTaskStartParams,
	route: Pick<
		TaskRouteRecord,
		'routeKind' | 'peerId' | 'sourceNodeId' | 'sourcePeerId' | 'sourceWorkspaceIdentity'
	>,
): string {
	const fields = [
		'copilot-agent-mesh/task-route/v1',
		route.routeKind,
		route.peerId ?? '',
		route.sourceNodeId ?? '',
		route.sourcePeerId ?? '',
		input.sourceWorkspaceIdentity ?? '',
		input.delegationRequestId,
		input.taskId,
		input.target.deviceId,
		input.target.nodeId,
		input.target.nodeInstanceId,
		input.target.workspaceId,
		input.sourceNodeId ?? '',
		String(input.timeoutMinutes ?? ''),
		input.title,
		input.prompt,
		String(input.acceptanceCriteria.length),
		...input.acceptanceCriteria,
		input.workerDeadline,
	];
	return createHash('sha256')
		.update(fields.map(lengthPrefix).join(''), 'utf8')
		.digest('hex');
}

function lengthPrefix(value: string): string {
	return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

function sameTarget(
	left: TaskRouteRecord['target'],
	right: RoutedTaskStartParams['target'],
): boolean {
	return left.deviceId === right.deviceId
		&& left.nodeId === right.nodeId
		&& left.nodeInstanceId === right.nodeInstanceId
		&& left.workspaceId === right.workspaceId;
}

function sameRouteRecord(left: TaskRouteRecord, right: TaskRouteRecord): boolean {
	return left.taskId === right.taskId
		&& left.delegationRequestId === right.delegationRequestId
		&& left.requestHash === right.requestHash
		&& left.routeKind === right.routeKind
		&& left.peerId === right.peerId
		&& left.sourceNodeId === right.sourceNodeId
		&& left.sourcePeerId === right.sourcePeerId
		&& left.sourceWorkspaceIdentity === right.sourceWorkspaceIdentity
		&& left.createdAt === right.createdAt
		&& left.state === right.state
		&& left.terminalAt === right.terminalAt
		&& sameTarget(left.target, right.target);
}

function localRoute(
	source: { readonly nodeId?: string; readonly peerId?: string },
): Pick<TaskRouteRecord, 'routeKind' | 'peerId' | 'sourceNodeId' | 'sourcePeerId'> {
	const nodeId = source.nodeId === undefined ? undefined : uuidSchema.parse(source.nodeId);
	const sourcePeerId = source.peerId === undefined ? undefined : uuidSchema.parse(source.peerId);
	if ((nodeId === undefined) === (sourcePeerId === undefined)) {
		throw new TypeError('A local task route requires exactly one authenticated source.');
	}
	return {
		routeKind: 'local',
		...(nodeId === undefined ? {} : { sourceNodeId: nodeId }),
		...(sourcePeerId === undefined ? {} : { sourcePeerId }),
	};
}

function remoteRoute(
	peerId: string,
	sourceNodeId: string,
): Pick<TaskRouteRecord, 'routeKind' | 'peerId' | 'sourceNodeId' | 'sourcePeerId'> {
	return {
		routeKind: 'remote',
		peerId: uuidSchema.parse(peerId),
		sourceNodeId: uuidSchema.parse(sourceNodeId),
	};
}

function isTerminal(state: string): boolean {
	return (TERMINAL_TASK_STATUSES as readonly string[]).includes(state);
}
