import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { createAcceptedTask } from '../../domain/task';
import { taskEventJournalBytes } from '../../domain/taskEvents';
import type { Clock, IdGenerator, StateStore } from '../../domain/ports';
import {
	AtomicFileStore,
	NodeAtomicFileSystem,
	StorageCorruptionError,
} from '../../storage/AtomicFileStore';
import { DeviceProfileStore } from '../../storage/DeviceProfileStore';
import { FileTaskStore } from '../../tasks/FileTaskStore';
import { WorkspaceLeaseManager } from '../../tasks/WorkspaceLeaseManager';
import { WorkspaceRegistry } from '../../workspaces/WorkspaceRegistry';
import { AT, IDS, LATER, taskRequest } from './fixtures';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) =>
		rm(path, { recursive: true, force: true }),
	));
});

class MemoryState implements StateStore {
	public readonly values = new Map<string, unknown>();

	public get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	public async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

class SequenceIds implements IdGenerator {
	private index = 0;

	public constructor(private readonly values: readonly string[]) {}

	public next(): string {
		const value = this.values[this.index];
		this.index += 1;
		if (value === undefined) {
			throw new Error('No test ID available.');
		}
		return value;
	}
}

const fixedClock: Clock = {
	now: () => new Date(AT),
};

class FailingRenameFileSystem extends NodeAtomicFileSystem {
	public failRename = false;

	public override async rename(from: string, to: string): Promise<void> {
		if (this.failRename) {
			throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
		}
		await super.rename(from, to);
	}
}

async function makeDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'copilot-agent-mesh-'));
	temporaryDirectories.push(path);
	return path;
}

describe('foundation storage', () => {
	test('keeps device identity stable while allowing name changes', async () => {
		const state = new MemoryState();
		const store = new DeviceProfileStore(
			state,
			new SequenceIds([IDS.device]),
			fixedClock,
		);
		const environment = {
			defaultName: 'worker',
			platform: 'darwin' as const,
			architecture: 'arm64',
			vscodeVersion: '1.103.0',
			extensionVersion: '0.0.1',
		};
		const first = await store.getOrCreate(environment);
		const reloaded = await store.getOrCreate({ ...environment, defaultName: 'ignored' });
		const renamed = await store.rename('renamed');
		assert.strictEqual(reloaded.deviceId, first.deviceId);
		assert.strictEqual(renamed.deviceId, first.deviceId);
		assert.strictEqual(renamed.name, 'renamed');
		assert.deepStrictEqual([...state.values.keys()], ['copilotAgentMesh.deviceProfile']);
	});

	test('registers file workspaces but exposes only opaque wire data', async () => {
		const state = new MemoryState();
		const leases = new WorkspaceLeaseManager();
		const registry = new WorkspaceRegistry(
			state,
			new SequenceIds([IDS.workspace]),
			fixedClock,
			(workspaceId) => leases.isLeased(workspaceId),
		);
		const workspace = await registry.register({
			localUri: 'file:///Users/example/secret-project',
			name: 'Project',
			capabilityTags: ['backend'],
		});
		const wire = registry.listForWire();
		assert.strictEqual(workspace.workspaceId, IDS.workspace);
		assert.strictEqual(JSON.stringify(wire).includes('/Users/example'), false);
		assert.strictEqual('localUri' in wire[0], false);
		await assert.rejects(
			registry.register({
				localUri: 'vscode-remote://ssh-remote/project',
				name: 'Remote',
			}),
			TypeError,
		);
		leases.acquire(IDS.workspace, IDS.peer, IDS.task);
		assert.strictEqual(registry.listForWire()[0].busy, true);
		await assert.rejects(
			registry.setEnabled(IDS.workspace, false),
			(error) => error instanceof Error && error.message.includes('active task'),
		);
	});

	test('preserves the previous file when an atomic replace is interrupted', async () => {
		const root = await makeDirectory();
		const fileSystem = new FailingRenameFileSystem();
		const files = new AtomicFileStore(
			root,
			fileSystem,
			new SequenceIds(['temp-1', 'temp-2']),
		);
		await files.writeJson('state/value.json', { version: 1 });
		fileSystem.failRename = true;
		await assert.rejects(files.writeJson('state/value.json', { version: 2 }));
		assert.deepStrictEqual(await files.readJson('state/value.json'), { version: 1 });
	});

	test('surfaces corrupted JSON instead of returning success-shaped defaults', async () => {
		const root = await makeDirectory();
		const files = new AtomicFileStore(
			root,
			new NodeAtomicFileSystem(),
			new SequenceIds(['temp-1']),
		);
		await new NodeAtomicFileSystem().mkdir(join(root, 'tasks'));
		await writeFile(join(root, 'tasks', `${IDS.task}.json`), '{"broken":', 'utf8');
		await assert.rejects(
			files.readJson(`tasks/${IDS.task}.json`),
			StorageCorruptionError,
		);
	});

	test('uses task files as recovery authority without persisting prompt or output', async () => {
		const root = await makeDirectory();
		const files = new AtomicFileStore(
			root,
			new NodeAtomicFileSystem(),
			new SequenceIds(['temp-1', 'temp-2', 'temp-3']),
		);
		const tasks = new FileTaskStore(files, fixedClock);
		const active = createAcceptedTask(taskRequest(), AT);
		await tasks.create(active);
		await tasks.transitionOwned(IDS.peer, IDS.task, {
			type: 'agentStartRequested',
			at: LATER,
		});
		const recovered = await tasks.listForRecovery();
		const leases = new WorkspaceLeaseManager();
		leases.restoreFromTaskRecords(recovered);
		assert.strictEqual(recovered[0].state, 'startingAgent');
		assert.deepStrictEqual(leases.owner(IDS.workspace), {
			peerId: IDS.peer,
			taskId: IDS.task,
		});

		const raw = await readFile(
			join(root, 'tasks', `${IDS.peer}--${IDS.task}.json`),
			'utf8',
		);
		assert.strictEqual(raw.includes(taskRequest().prompt), false);
		assert.strictEqual(raw.includes('"prompt"'), false);
		assert.strictEqual(raw.includes('"output"'), false);
		await assert.rejects(
			tasks.transitionOwned(IDS.otherPeer, IDS.task, {
				type: 'failed',
				at: LATER,
				code: 'SHOULD_NOT_APPLY',
				message: 'Wrong owner',
				retryable: false,
			}),
			(error) => error instanceof Error && error.message === 'Task not found.',
		);

		await tasks.transitionOwned(IDS.peer, IDS.task, {
			type: 'failed',
			at: LATER,
			code: 'TASK_RECOVERY_UNAVAILABLE',
			message: 'Session cannot be recovered.',
			retryable: true,
		});
		assert.deepStrictEqual(leases.owner(IDS.workspace), {
			peerId: IDS.peer,
			taskId: IDS.task,
		});
		const restartedLeases = new WorkspaceLeaseManager();
		restartedLeases.restoreFromTaskRecords(await tasks.listForRecovery());
		assert.strictEqual(restartedLeases.isLeased(IDS.workspace), false);
	});

	test('namespaces identical task IDs by peer without leaking ownership', async () => {
		const root = await makeDirectory();
		const tasks = new FileTaskStore(new AtomicFileStore(
			root,
			new NodeAtomicFileSystem(),
			new SequenceIds(['temp-1', 'temp-2']),
		), fixedClock);
		const first = createAcceptedTask(taskRequest(), AT);
		const second = createAcceptedTask(taskRequest({
			peerId: IDS.otherPeer,
			delegationRequestId: IDS.otherTask,
		}), AT);
		await tasks.create(first);
		await tasks.create(second);
		assert.strictEqual((await tasks.list()).length, 2);
		assert.strictEqual((await tasks.getOwned(IDS.peer, IDS.task))?.peerId, IDS.peer);
		assert.strictEqual(
			(await tasks.getOwned(IDS.otherPeer, IDS.task))?.peerId,
			IDS.otherPeer,
		);
	});

	test('compacts event journals before writing task files', async () => {
		const root = await makeDirectory();
		const tasks = new FileTaskStore(new AtomicFileStore(
			root,
			new NodeAtomicFileSystem(),
			new SequenceIds(['temp-1']),
		), fixedClock);
		const summary = 'x'.repeat(16 * 1_024);
		const events = Array.from({ length: 80 }, (_, index) => ({
			eventSeq: index + 1,
			at: AT,
			type: 'task.output',
			summary,
		}));
		await tasks.create({
			...createAcceptedTask(taskRequest(), AT),
			eventSeq: events.length,
			events,
		});
		const stored = await tasks.getOwned(IDS.peer, IDS.task);
		assert.ok(stored);
		assert.ok(taskEventJournalBytes(stored) <= 1_048_576);
		assert.strictEqual(stored.eventsTruncated, true);
		assert.strictEqual(
			stored.earliestAvailableEventSeq,
			stored.events[0].eventSeq,
		);
	});

	test('rejects schema-invalid task files during recovery', async () => {
		const root = await makeDirectory();
		const files = new AtomicFileStore(
			root,
			new NodeAtomicFileSystem(),
			new SequenceIds(['temp-1']),
		);
		await new NodeAtomicFileSystem().mkdir(join(root, 'tasks'));
		await writeFile(
			join(root, 'tasks', `${IDS.peer}--${IDS.task}.json`),
			JSON.stringify({ schemaVersion: 1, taskId: IDS.task }),
			'utf8',
		);
		await assert.rejects(
			new FileTaskStore(files, fixedClock).listForRecovery(),
			StorageCorruptionError,
		);
	});
});
