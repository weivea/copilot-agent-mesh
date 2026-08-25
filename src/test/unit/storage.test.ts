import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import type {
	FileIdentityResolver,
	ResolvedFileIdentity,
} from '../../workspaces/WorkspaceRegistry';
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

class BlockingState extends MemoryState {
	private nextUpdateBlock:
		| {
			readonly entered: () => void;
			readonly wait: Promise<void>;
		}
		| undefined;

	public blockNextUpdate(): { readonly entered: Promise<void>; readonly release: () => void } {
		let signalEntered!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			signalEntered = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.nextUpdateBlock = { entered: signalEntered, wait };
		return { entered, release };
	}

	public override async update(key: string, value: unknown): Promise<void> {
		const block = this.nextUpdateBlock;
		this.nextUpdateBlock = undefined;
		if (block !== undefined) {
			block.entered();
			await block.wait;
		}
		await super.update(key, value);
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

class MutableClock implements Clock {
	public constructor(private value: Date) {}

	public now(): Date {
		return new Date(this.value);
	}

	public set(value: Date): void {
		this.value = value;
	}
}

class FailingRenameFileSystem extends NodeAtomicFileSystem {
	public failRename = false;

	public override async rename(from: string, to: string): Promise<void> {
		if (this.failRename) {
			throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
		}
		await super.rename(from, to);
	}
}

class RecordingFileSystem extends NodeAtomicFileSystem {
	public readonly operations: string[] = [];

	public override async mkdir(path: string): Promise<boolean> {
		const created = await super.mkdir(path);
		this.operations.push(`mkdir:${path}:${created}`);
		return created;
	}

	public override async writeFile(path: string, contents: string): Promise<void> {
		this.operations.push(`write:${path}`);
		await super.writeFile(path, contents);
	}

	public override async syncFile(path: string): Promise<void> {
		this.operations.push(`sync-file:${path}`);
		await super.syncFile(path);
	}

	public override async rename(from: string, to: string): Promise<void> {
		this.operations.push(`rename:${from}:${to}`);
		await super.rename(from, to);
	}

	public override async syncDirectory(path: string): Promise<void> {
		this.operations.push(`sync-directory:${path}`);
		await super.syncDirectory(path);
	}
}

class FailingDirectorySyncFileSystem extends RecordingFileSystem {
	public failNextDirectorySync = true;

	public override async syncDirectory(path: string): Promise<void> {
		this.operations.push(`sync-directory:${path}`);
		if (this.failNextDirectorySync) {
			this.failNextDirectorySync = false;
			throw Object.assign(new Error('simulated directory sync failure'), { code: 'EIO' });
		}
		await NodeAtomicFileSystem.prototype.syncDirectory.call(this, path);
	}

	public override async removeDirectory(path: string): Promise<void> {
		this.operations.push(`remove-directory:${path}`);
		await super.removeDirectory(path);
	}
}

class FailingDirectorySyncAndRollbackFileSystem extends FailingDirectorySyncFileSystem {
	public failNextRollback = true;

	public override async removeDirectory(path: string): Promise<void> {
		this.operations.push(`remove-directory:${path}`);
		if (this.failNextRollback) {
			this.failNextRollback = false;
			throw Object.assign(new Error('simulated directory rollback failure'), { code: 'EIO' });
		}
		await NodeAtomicFileSystem.prototype.removeDirectory.call(this, path);
	}
}

class FakeFileIdentityResolver implements FileIdentityResolver {
	public readonly inputs: string[] = [];

	public constructor(
		private readonly resolveIdentity: (localUri: string) => ResolvedFileIdentity,
	) {}

	public async resolve(localUri: string): Promise<ResolvedFileIdentity> {
		this.inputs.push(localUri);
		return this.resolveIdentity(localUri);
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
		const clock = new MutableClock(new Date(AT));
		const store = new DeviceProfileStore(
			state,
			new SequenceIds([IDS.device]),
			clock,
		);
		const environment = {
			defaultName: 'worker',
			platform: 'darwin' as const,
			architecture: 'arm64',
			vscodeVersion: '1.103.0',
			extensionVersion: '0.0.1',
		};
		const first = await store.getOrCreate(environment);
		clock.set(new Date(LATER));
		const reloaded = await store.getOrCreate({
			...environment,
			defaultName: 'ignored',
			platform: 'linux',
			architecture: 'x64',
			vscodeVersion: '1.134.0',
			extensionVersion: '0.0.2',
		});
		const renamed = await store.rename('renamed');
		assert.strictEqual(reloaded.deviceId, first.deviceId);
		assert.strictEqual(reloaded.name, first.name);
		assert.strictEqual(reloaded.createdAt, first.createdAt);
		assert.strictEqual(reloaded.platform, 'linux');
		assert.strictEqual(reloaded.architecture, 'x64');
		assert.strictEqual(reloaded.vscodeVersion, '1.134.0');
		assert.strictEqual(reloaded.extensionVersion, '0.0.2');
		assert.strictEqual(reloaded.updatedAt, LATER);
		assert.strictEqual(renamed.deviceId, first.deviceId);
		assert.strictEqual(renamed.name, 'renamed');
		assert.deepStrictEqual([...state.values.keys()], ['copilotAgentMesh.deviceProfile']);
	});

	test('atomically migrates the 0.1 device profile without changing device identity', async () => {
		const state = new MemoryState();
		state.values.set('copilotAgentMesh.deviceProfile', {
			schemaVersion: 1,
			deviceId: IDS.device,
			name: 'existing-device',
			platform: 'darwin',
			architecture: 'arm64',
			vscodeVersion: '1.103.0',
			extensionVersion: '0.1.0',
			protocolVersion: 1,
			createdAt: AT,
			updatedAt: AT,
		});
		const store = new DeviceProfileStore(
			state,
			new SequenceIds([]),
			fixedClock,
		);

		assert.equal(store.get(), undefined);
		const migrated = await store.getOrCreate({
			defaultName: 'ignored',
			platform: 'darwin',
			architecture: 'arm64',
			vscodeVersion: '1.103.0',
			extensionVersion: '0.2.0',
		});

		assert.equal(migrated.schemaVersion, 2);
		assert.equal(migrated.protocolVersion, 2);
		assert.equal(migrated.deviceId, IDS.device);
		assert.equal(migrated.name, 'existing-device');
		assert.equal(migrated.createdAt, AT);
	});

	test('registers file workspaces but exposes only opaque wire data', async () => {
		const state = new MemoryState();
		const leases = new WorkspaceLeaseManager();
		const resolver = new FakeFileIdentityResolver((localUri) => ({
			canonicalUri: localUri,
			identity: 'device:1:inode:2',
		}));
		const registry = new WorkspaceRegistry(
			state,
			new SequenceIds([IDS.workspace]),
			fixedClock,
			resolver,
			leases,
		);
		const workspace = await registry.register({
			localUri: 'file:///Users/example/secret-project',
			name: 'Project',
			capabilityTags: ['backend'],
		});
		const wire = await registry.listForWire();
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
		assert.strictEqual(
			await registry.acquireLease(IDS.workspace, IDS.peer, IDS.task),
			'device:1:inode:2',
		);
		assert.strictEqual((await registry.listForWire())[0].busy, true);
		await assert.rejects(
			registry.setEnabled(IDS.workspace, false),
			(error) => error instanceof Error && error.message.includes('active task'),
		);
	});

	test('normalizes file URIs and deduplicates resolved symbolic-link identities', async () => {
		const state = new MemoryState();
		const resolver = new FakeFileIdentityResolver(() => ({
			canonicalUri: 'file:///canonical/project',
			identity: 'device:10:inode:20',
		}));
		const registry = new WorkspaceRegistry(
			state,
			new SequenceIds([IDS.workspace]),
			fixedClock,
			resolver,
			new WorkspaceLeaseManager(),
		);
		const first = await registry.register({
			localUri: 'file:///workspace/../alias',
			name: 'Alias',
		});
		const second = await registry.register({
			localUri: 'file:///other/symlink',
			name: 'Symlink',
		});
		assert.strictEqual(first.workspaceId, second.workspaceId);
		assert.strictEqual(first.localUri, 'file:///canonical/project');
		assert.strictEqual(first.fileIdentity, 'device:10:inode:20');
		assert.strictEqual(resolver.inputs[0], 'file:///alias');
		assert.strictEqual(resolver.inputs.includes('file:///other/symlink'), true);
		assert.strictEqual(JSON.stringify(await registry.listForWire()).includes('inode'), false);
	});

	test('persists the latest authoritative identity when registration revalidation changes twice', async () => {
		const resolutions = [
			{ canonicalUri: 'file:///canonical/one', identity: 'identity:one' },
			{ canonicalUri: 'file:///canonical/two', identity: 'identity:two' },
			{ canonicalUri: 'file:///canonical/three', identity: 'identity:three' },
		];
		let resolutionIndex = 0;
		const registry = new WorkspaceRegistry(
			new MemoryState(),
			new SequenceIds([IDS.workspace]),
			fixedClock,
			new FakeFileIdentityResolver(() =>
				resolutions[Math.min(resolutionIndex++, resolutions.length - 1)],
			),
			new WorkspaceLeaseManager(),
		);
		const input = { localUri: 'file:///registered/link', name: 'Moving target' };
		await registry.register(input);
		const updated = await registry.register(input);
		assert.strictEqual(updated.fileIdentity, 'identity:three');
		assert.strictEqual(updated.localUri, 'file:///canonical/three');
		assert.strictEqual((await registry.listLocal())[0].fileIdentity, 'identity:three');
	});

	test('disables a retargeted leased URI and atomically adopts its new identity after release', async () => {
		const state = new MemoryState();
		const leases = new WorkspaceLeaseManager();
		let resolved = {
			canonicalUri: 'file:///canonical/original',
			identity: 'device:1:inode:old',
		};
		const registry = new WorkspaceRegistry(
			state,
			new SequenceIds([IDS.workspace]),
			fixedClock,
			new FakeFileIdentityResolver(() => resolved),
			leases,
		);
		const input = { localUri: 'file:///registered/link', name: 'Retargetable' };
		const original = await registry.register(input);
		await registry.acquireLease(original.workspaceId, IDS.peer, IDS.task);
		resolved = {
			canonicalUri: 'file:///canonical/replacement',
			identity: 'device:1:inode:new',
		};
		await assert.rejects(
			registry.register(input),
			(error) => error instanceof Error && error.message.includes('identity changed'),
		);
		await assert.rejects(
			registry.acquireLease(original.workspaceId, IDS.peer, IDS.otherTask),
			(error) => error instanceof Error && error.message === 'Workspace is disabled.',
		);
		const [disabled] = await registry.listLocal();
		assert.strictEqual(disabled.enabled, false);
		assert.strictEqual(disabled.fileIdentity, original.fileIdentity);
		leases.release(original.fileIdentity, IDS.peer, IDS.task);
		const replaced = await registry.register(input);
		assert.strictEqual(replaced.workspaceId, original.workspaceId);
		assert.strictEqual(replaced.fileIdentity, resolved.identity);
		assert.strictEqual(replaced.localUri, resolved.canonicalUri);
		assert.strictEqual(replaced.enabled, false);
		await registry.setEnabled(replaced.workspaceId, true);
		assert.strictEqual(
			await registry.acquireLease(replaced.workspaceId, IDS.peer, IDS.otherTask),
			resolved.identity,
		);
	});

	test('rejects invalid canonical resolver output on every workspace use', async () => {
		let resolved = {
			canonicalUri: 'file:///canonical/project',
			identity: 'device:1:inode:2',
		};
		const registry = new WorkspaceRegistry(
			new MemoryState(),
			new SequenceIds([IDS.workspace]),
			fixedClock,
			new FakeFileIdentityResolver(() => resolved),
			new WorkspaceLeaseManager(),
		);
		const workspace = await registry.register({
			localUri: 'file:///registered/project',
			name: 'Project',
		});
		resolved = { canonicalUri: 'https://example.com/not-local', identity: '' };
		await assert.rejects(registry.resolveEnabled(workspace.workspaceId), TypeError);
		await assert.rejects(registry.listForWire(), TypeError);
	});

	test('isolates inaccessible workspaces and keeps them stale until explicit revalidation', async () => {
		const state = new MemoryState();
		const leases = new WorkspaceLeaseManager();
		const unavailable = new Set<string>();
		const resolver = new FakeFileIdentityResolver((localUri) => {
			if (unavailable.has(localUri)) {
				throw Object.assign(new Error('workspace unavailable'), { code: 'ENOENT' });
			}
			return {
				canonicalUri: localUri,
				identity: `identity:${localUri}`,
			};
		});
		const registry = new WorkspaceRegistry(
			state,
			new SequenceIds([IDS.workspace, IDS.otherWorkspace]),
			fixedClock,
			resolver,
			leases,
		);
		const missing = await registry.register({ localUri: 'file:///missing', name: 'Missing' });
		const available = await registry.register({ localUri: 'file:///available', name: 'Available' });
		unavailable.add(missing.registeredUri);

		const wire = await registry.listForWire();
		assert.deepStrictEqual(wire.map(({ workspaceId, enabled }) => ({ workspaceId, enabled })), [
			{ workspaceId: missing.workspaceId, enabled: false },
			{ workspaceId: available.workspaceId, enabled: true },
		]);
		const stale = (await registry.listLocal()).find(
			(workspace) => workspace.workspaceId === missing.workspaceId,
		);
		assert.strictEqual(stale?.stale, true);
		assert.strictEqual(stale?.enabled, false);
		await assert.rejects(
			registry.acquireLease(missing.workspaceId, IDS.peer, IDS.task),
			(error) => error instanceof Error && error.message === 'Workspace is disabled.',
		);

		unavailable.delete(missing.registeredUri);
		const missingCallsBeforeStickyList = resolver.inputs.filter(
			(input) => input === missing.registeredUri,
		).length;
		assert.strictEqual((await registry.listLocal())[0].stale, true);
		assert.strictEqual(
			resolver.inputs.filter((input) => input === missing.registeredUri).length,
			missingCallsBeforeStickyList,
		);
		const revalidated = await registry.revalidate(missing.workspaceId);
		assert.strictEqual(revalidated.stale, false);
		assert.strictEqual(revalidated.enabled, false);
		await registry.setEnabled(missing.workspaceId, true);
		assert.strictEqual(
			await registry.acquireLease(missing.workspaceId, IDS.peer, IDS.task),
			missing.fileIdentity,
		);
	});

	test('allows an unleased stale workspace to be removed', async () => {
		let unavailable = false;
		const registry = new WorkspaceRegistry(
			new MemoryState(),
			new SequenceIds([IDS.workspace]),
			fixedClock,
			new FakeFileIdentityResolver((localUri) => {
				if (unavailable) {
					throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
				}
				return { canonicalUri: localUri, identity: `identity:${localUri}` };
			}),
			new WorkspaceLeaseManager(),
		);
		const workspace = await registry.register({ localUri: 'file:///restricted', name: 'Restricted' });
		unavailable = true;
		await registry.listForWire();
		await registry.remove(workspace.workspaceId);
		assert.deepStrictEqual(await registry.listLocal(), []);
	});

	test('refreshes a stale registration through a reachable URI without enabling it', async () => {
		let deadLink = false;
		const registry = new WorkspaceRegistry(
			new MemoryState(),
			new SequenceIds([IDS.workspace]),
			fixedClock,
			new FakeFileIdentityResolver((localUri) => {
				if (localUri === 'file:///dead-link' && deadLink) {
					throw Object.assign(new Error('link target missing'), { code: 'ENOENT' });
				}
				return {
					canonicalUri: 'file:///real-workspace',
					identity: 'identity:real-workspace',
				};
			}),
			new WorkspaceLeaseManager(),
		);
		const original = await registry.register({ localUri: 'file:///dead-link', name: 'Linked' });
		deadLink = true;
		await registry.listForWire();
		assert.strictEqual((await registry.listLocal())[0].stale, true);

		const refreshed = await registry.register({ localUri: 'file:///real-workspace', name: 'Real' });
		assert.strictEqual(refreshed.workspaceId, original.workspaceId);
		assert.strictEqual(refreshed.registeredUri, 'file:///real-workspace');
		assert.strictEqual(refreshed.localUri, 'file:///real-workspace');
		assert.strictEqual(refreshed.fileIdentity, original.fileIdentity);
		assert.strictEqual(refreshed.stale, false);
		assert.strictEqual(refreshed.enabled, false);
		await assert.rejects(
			registry.acquireLease(refreshed.workspaceId, IDS.peer, IDS.task),
			(error) => error instanceof Error && error.message === 'Workspace is disabled.',
		);
		const enabled = await registry.setEnabled(refreshed.workspaceId, true);
		assert.strictEqual(enabled.enabled, true);
	});

	test('serializes concurrent registry mutations without losing updates', async () => {
		const state = new BlockingState();
		const resolver = new FakeFileIdentityResolver((localUri) => ({
			canonicalUri: localUri,
			identity: `identity:${localUri}`,
		}));
		const registry = new WorkspaceRegistry(
			state,
			new SequenceIds([IDS.workspace, IDS.otherWorkspace]),
			fixedClock,
			resolver,
			new WorkspaceLeaseManager(),
		);
		const [first, second] = await Promise.all([
			registry.register({ localUri: 'file:///one', name: 'One' }),
			registry.register({ localUri: 'file:///two', name: 'Two' }),
		]);
		assert.strictEqual((await registry.listLocal()).length, 2);
		const blockedUpdate = state.blockNextUpdate();
		const disabling = registry.setEnabled(first.workspaceId, false);
		await blockedUpdate.entered;
		const removing = registry.remove(second.workspaceId);
		blockedUpdate.release();
		await Promise.all([disabling, removing]);
		const remaining = await registry.listLocal();
		assert.deepStrictEqual(remaining.map((workspace) => ({
			workspaceId: workspace.workspaceId,
			enabled: workspace.enabled,
		})), [{
			workspaceId: first.workspaceId,
			enabled: false,
		}]);
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

	test('syncs each newly created owned directory entry in order', async () => {
		const root = await makeDirectory();
		const fileSystem = new RecordingFileSystem();
		const files = new AtomicFileStore(
			root,
			fileSystem,
			new SequenceIds(['temp-1']),
		);
		await files.writeJson('tasks/nested/value.json', { version: 1 });
		const tasksDirectory = join(root, 'tasks');
		const nestedDirectory = join(tasksDirectory, 'nested');
		const temporary = join(nestedDirectory, 'value.json.temp-1.tmp');
		const target = join(nestedDirectory, 'value.json');
		assert.deepStrictEqual(fileSystem.operations, [
			`mkdir:${tasksDirectory}:true`,
			`sync-directory:${root}`,
			`mkdir:${nestedDirectory}:true`,
			`sync-directory:${tasksDirectory}`,
			`write:${temporary}`,
			`sync-file:${temporary}`,
			`rename:${temporary}:${target}`,
			`sync-directory:${nestedDirectory}`,
		]);
		assert.strictEqual(
			fileSystem.operations.includes(`sync-directory:${dirname(root)}`),
			false,
		);
	});

	test('rolls back an unsynced directory so retry repeats mkdir and parent sync', async () => {
		const root = await makeDirectory();
		const fileSystem = new FailingDirectorySyncFileSystem();
		const files = new AtomicFileStore(
			root,
			fileSystem,
			new SequenceIds(['temp-1', 'temp-2']),
		);
		await assert.rejects(files.writeJson('tasks/value.json', { version: 1 }));
		const tasksDirectory = join(root, 'tasks');
		assert.deepStrictEqual(fileSystem.operations.slice(0, 3), [
			`mkdir:${tasksDirectory}:true`,
			`sync-directory:${root}`,
			`remove-directory:${tasksDirectory}`,
		]);
		await files.writeJson('tasks/value.json', { version: 2 });
		assert.deepStrictEqual(fileSystem.operations.slice(3, 5), [
			`mkdir:${tasksDirectory}:true`,
			`sync-directory:${root}`,
		]);
		assert.deepStrictEqual(await files.readJson('tasks/value.json'), { version: 2 });
	});

	test('remembers an unsynced directory when rollback fails and syncs it on retry', async () => {
		const root = await makeDirectory();
		const fileSystem = new FailingDirectorySyncAndRollbackFileSystem();
		const files = new AtomicFileStore(
			root,
			fileSystem,
			new SequenceIds(['temp-1', 'temp-2']),
		);
		await assert.rejects(
			files.writeJson('tasks/value.json', { version: 1 }),
			AggregateError,
		);
		const tasksDirectory = join(root, 'tasks');
		await files.writeJson('tasks/value.json', { version: 2 });
		assert.deepStrictEqual(fileSystem.operations.slice(3, 5), [
			`mkdir:${tasksDirectory}:false`,
			`sync-directory:${root}`,
		]);
		assert.deepStrictEqual(await files.readJson('tasks/value.json'), { version: 2 });
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
		assert.deepStrictEqual(leases.owner(IDS.workspaceLeaseKey), {
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
		assert.deepStrictEqual(leases.owner(IDS.workspaceLeaseKey), {
			peerId: IDS.peer,
			taskId: IDS.task,
		});
		const restartedLeases = new WorkspaceLeaseManager();
		restartedLeases.restoreFromTaskRecords(await tasks.listForRecovery());
		assert.strictEqual(restartedLeases.isLeased(IDS.workspaceLeaseKey), false);
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

	test('uses lowercase canonical UUIDs for task filenames and lookups', async () => {
		const root = await makeDirectory();
		const tasks = new FileTaskStore(new AtomicFileStore(
			root,
			new NodeAtomicFileSystem(),
			new SequenceIds(['temp-1']),
		), fixedClock);
		const upperPeer = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
		const upperTask = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
		const record = {
			...createAcceptedTask(taskRequest(), AT),
			peerId: upperPeer,
			taskId: upperTask,
		};
		await tasks.create(record);
		assert.deepStrictEqual(await new NodeAtomicFileSystem().readdir(join(root, 'tasks')), [
			`${upperPeer.toLowerCase()}--${upperTask.toLowerCase()}.json`,
		]);
		assert.strictEqual(
			(await tasks.getOwned(upperPeer, upperTask))?.taskId,
			upperTask.toLowerCase(),
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

	test('atomically persists 24-hour retention from every task read API', async () => {
		const methods = ['getOwned', 'list', 'listForRecovery'] as const;
		for (const [index, method] of methods.entries()) {
			const root = await makeDirectory();
			const clock = new MutableClock(new Date(AT));
			const tasks = new FileTaskStore(new AtomicFileStore(
				root,
				new NodeAtomicFileSystem(),
				new SequenceIds([`temp-${index}-create`, `temp-${index}-trim`]),
			), clock);
			await tasks.create({
				...createAcceptedTask(taskRequest(), AT),
				state: 'completed',
				summary: 'Completed',
				eventSeq: 1,
				events: [{
					eventSeq: 1,
					at: AT,
					type: 'seed',
				}],
			});
			clock.set(new Date(Date.parse(AT) + 24 * 60 * 60 * 1_000 + 1));
			if (method === 'getOwned') {
				await tasks.getOwned(IDS.peer, IDS.task);
			} else if (method === 'list') {
				await tasks.list();
			} else {
				await tasks.listForRecovery();
			}
			const persisted = JSON.parse(await readFile(
				join(root, 'tasks', `${IDS.peer}--${IDS.task}.json`),
				'utf8',
			)) as {
				events: unknown[];
				eventsTruncated: boolean;
				earliestAvailableEventSeq: number;
			};
			assert.deepStrictEqual(persisted.events, []);
			assert.strictEqual(persisted.eventsTruncated, true);
			assert.strictEqual(persisted.earliestAvailableEventSeq, 2);
		}
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

	test('rejects task files whose names do not match their complete identity', async () => {
		const cases = [
			`${IDS.otherPeer}--${IDS.task}.json`,
			`${IDS.peer}--${IDS.otherTask}.json`,
			`${encodeURIComponent(IDS.peer)}%2Fescape--${IDS.task}.json`,
			'extra.json',
		];
		for (const [index, name] of cases.entries()) {
			const root = await makeDirectory();
			const files = new AtomicFileStore(
				root,
				new NodeAtomicFileSystem(),
				new SequenceIds([`temp-${index}`]),
			);
			await new NodeAtomicFileSystem().mkdir(join(root, 'tasks'));
			await writeFile(
				join(root, 'tasks', name),
				JSON.stringify(createAcceptedTask(taskRequest(), AT)),
				'utf8',
			);
			const tasks = new FileTaskStore(files, fixedClock);
			await assert.rejects(
				index === 0 ? tasks.list() : tasks.listForRecovery(),
				StorageCorruptionError,
			);
		}
	});
});
