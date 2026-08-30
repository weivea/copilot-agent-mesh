import * as assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	collaborationRunSnapshotSchema,
	type CollaborationRunSnapshot,
	type CollaborationStartParams,
} from '../../shared/protocol';
import type {
	CollaborationRunToolResult,
	StartCollaborationToolInput,
} from '../../shared/toolProtocol';
import { createCollaborationRun } from '../domain/collaboration';
import {
	CollaborationToolFacadeError,
	type CollaborationToolFacade,
} from '../tools/collaborationToolFacade';
import { CollaborationToolsCore } from '../tools/collaborationToolsCore';
import { serializeToolResultToTokenBudget } from '../tools/taskToolsCore';
import { uuid } from './collaborationTestSupport';

const DEVICE_ID = uuid(1);
const FRONTEND_NODE_ID = uuid(2);
const FRONTEND_INSTANCE_ID = uuid(3);
const FRONTEND_WORKSPACE_ID = uuid(4);
const BACKEND_NODE_ID = uuid(5);
const BACKEND_INSTANCE_ID = uuid(6);
const BACKEND_WORKSPACE_ID = uuid(7);
const REQUEST_ID = uuid(8);
const RUN_ID = uuid(9);
const AT = '2026-08-30T06:00:00.000Z';

suite('CollaborationToolsCore', () => {
	test('generates a request ID and returns a bounded collaboration contract', async () => {
		const facade = new RecordingFacade(snapshot());
		const core = new CollaborationToolsCore(facade, { id: () => REQUEST_ID });
		const result = await core.start(input());
		assert.equal(result.status, 'ok');
		assert.equal(facade.started?.collaborationRequestId, REQUEST_ID);
		assert.equal((result.run as CollaborationRunSnapshot).runId, snapshot().runId);
		assert.equal(result.getTool, 'mesh_get_collaboration');
		assert.equal(result.cancelTool, 'mesh_cancel_collaboration');
		assert.doesNotMatch(JSON.stringify(result), /complete frontend\/backend goal/u);
	});

	test('rejects same-workspace DAGs before calling the facade', async () => {
		const facade = new RecordingFacade(snapshot());
		const core = new CollaborationToolsCore(facade);
		const result = await core.start({
			...input(),
			backend: {
				...input().backend,
				workspaceId: FRONTEND_WORKSPACE_ID,
			},
		});
		assert.equal(result.status, 'error');
		assert.equal((result.error as { code: string }).code, 'COLLABORATION_DAG_INVALID');
		assert.equal(facade.started, undefined);
	});

	test('maps stable get and cancel errors without leaking diagnostics', async () => {
		const facade = new RecordingFacade(snapshot());
		const core = new CollaborationToolsCore(facade);
		facade.error = new CollaborationToolFacadeError('FEATURE_DISABLED');
		const disabled = await core.start(input());
		assert.equal((disabled.error as { code: string }).code, 'FEATURE_DISABLED');
		assert.doesNotMatch(JSON.stringify(disabled), /private diagnostic/u);

		facade.error = undefined;
		const get = await core.get({ runId: snapshot().runId });
		const cancel = await core.cancel({ runId: snapshot().runId });
		assert.equal(get.status, 'ok');
		assert.equal(cancel.status, 'ok');
		assert.deepStrictEqual(facade.gotten, [snapshot().runId]);
		assert.deepStrictEqual(facade.cancelled, [snapshot().runId]);
	});

	test('preparation confirms explicit role routes and the full goal', () => {
		const core = new CollaborationToolsCore(new RecordingFacade(snapshot()));
		const preparation = core.prepareStartInvocation(input());
		assert.match(preparation.confirmationMessage, new RegExp(FRONTEND_WORKSPACE_ID, 'u'));
		assert.match(preparation.confirmationMessage, new RegExp(BACKEND_WORKSPACE_ID, 'u'));
		assert.match(preparation.confirmationMessage, /complete frontend\/backend goal/u);
	});

	test('token contraction preserves run and active task identities', async () => {
		const core = new CollaborationToolsCore(new RecordingFacade(snapshot()));
		const result = await core.get({ runId: snapshot().runId });
		const serialized = await serializeToolResultToTokenBudget(
			result,
			420,
			async (text) => text.length,
		);
		const compact = JSON.parse(serialized);
		assert.equal(compact.run.runId, snapshot().runId);
		assert.equal(compact.run.status, 'pending');
		assert.equal(compact.run.tasks[0].taskId, snapshot().tasks[0].taskId);
	});
});

class RecordingFacade implements CollaborationToolFacade {
	public readonly sourceNodeId = FRONTEND_NODE_ID;
	public started?: StartCollaborationToolInput & { readonly collaborationRequestId: string };
	public readonly gotten: string[] = [];
	public readonly cancelled: string[] = [];
	public error?: Error;

	public constructor(private readonly value: CollaborationRunSnapshot) {}

	public async startCollaboration(
		input: StartCollaborationToolInput & { readonly collaborationRequestId: string },
		_signal: AbortSignal,
	): Promise<CollaborationRunToolResult> {
		this.started = structuredClone(input);
		if (this.error !== undefined) {
			throw this.error;
		}
		return { run: this.value };
	}

	public async getCollaboration(
		runId: string,
		_signal: AbortSignal,
	): Promise<CollaborationRunToolResult> {
		this.gotten.push(runId);
		if (this.error !== undefined) {
			throw this.error;
		}
		return { run: this.value };
	}

	public async cancelCollaboration(
		runId: string,
		_signal: AbortSignal,
	): Promise<CollaborationRunToolResult> {
		this.cancelled.push(runId);
		if (this.error !== undefined) {
			throw this.error;
		}
		return { run: this.value };
	}
}

function input(): StartCollaborationToolInput {
	return {
		title: 'Implement API',
		goal: 'A complete frontend/backend goal.',
		frontend: target(FRONTEND_NODE_ID, FRONTEND_INSTANCE_ID, FRONTEND_WORKSPACE_ID),
		backend: target(BACKEND_NODE_ID, BACKEND_INSTANCE_ID, BACKEND_WORKSPACE_ID),
	};
}

function snapshot(): CollaborationRunSnapshot {
	const params: CollaborationStartParams = {
		...input(),
		collaborationRequestId: REQUEST_ID,
		timeoutMinutes: 60,
	};
	const run = createCollaborationRun(FRONTEND_NODE_ID, params, AT);
	return collaborationRunSnapshotSchema.parse({
		schemaVersion: 1,
		runId: run.runId,
		collaborationRequestId: run.collaborationRequestId,
		coordinator: run.coordinator,
		participants: run.participants,
		title: run.title,
		tasks: run.tasks.map(({ workerDeadline: _workerDeadline, ...task }) => task),
		status: run.status,
		artifacts: [],
		validations: [],
		cancellationRequested: false,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
	});
}

function target(nodeId: string, nodeInstanceId: string, workspaceId: string) {
	return {
		deviceId: DEVICE_ID,
		nodeId,
		nodeInstanceId,
		workspaceId,
	};
}
