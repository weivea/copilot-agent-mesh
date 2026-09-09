import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { readProcessTable, resolveCodeCommand } from './platform.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);

export async function disposeHarnessProcesses(processes, operationError) {
	try {
		await processes.disposeWindows({ stopLaunching: true });
	} catch (cleanupError) {
		const error = new AggregateError(
			operationError === undefined ? [cleanupError] : [operationError, cleanupError],
			'Harness command cleanup was not confirmed; retain ownedCleanup and retry dispose.',
		);
		Object.defineProperties(error, {
			cleanupRequired: { value: true, enumerable: true },
			ownedCleanup: {
				value: { dispose: () => processes.disposeWindows({ stopLaunching: true }) },
				enumerable: false,
			},
		});
		throw error;
	}
}

export async function runWindowsHarnessCommand(executable, args, options = {}) {
	if (process.platform !== 'win32') {
		throw new Error('Windows command runner requires Windows Job Object ownership.');
	}
	const processes = new HarnessProcesses();
	let timer;
	let operationError;
	try {
		const child = await processes.launch(executable, args, options);
		const stdout = [];
		const stderr = [];
		child.stdout.on('data', (chunk) => stdout.push(chunk));
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		const completed = Promise.all([
			child.completion,
			finished(child.stdout, { cleanup: true }),
			finished(child.stderr, { cleanup: true }),
		]).then(([status]) => status);
		const status = await Promise.race([
			completed,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('Owned harness command timed out.')), options.timeoutMs ?? 10_000);
			}),
		]);
		return {
			status,
			stdout: Buffer.concat(stdout).toString('utf8'),
			stderr: Buffer.concat(stderr).toString('utf8'),
		};
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		clearTimeout(timer);
		await disposeHarnessProcesses(processes, operationError);
	}
}

export class HarnessProcesses {
	#windows = new Set();
	#stopping = false;

	async launch(executable, args, options = {}) {
		if (this.#stopping) {
			throw new Error('Harness process launch was cancelled.');
		}

		if (process.platform !== 'win32') {
			return spawn(executable, args, { ...options, shell: false });
		}
		const command = await resolveCodeCommand(executable, args, options.env);
		if (this.#stopping) {
			throw new Error('Harness process launch was cancelled.');
		}
		require('tsx/cjs');
		const { WindowsOwnedProcess } = require(join(repositoryRoot, 'src', 'spikes', 'windowsProcessHost.ts'));
		const child = new WindowsOwnedProcess(command.executable, command.args, {
			environment: command.env,
			cwd: options.cwd,
			helperPath: join(repositoryRoot, 'dist', 'windows', `mesh-process-host-${process.arch}.exe`),
			maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 * 1024,
		});
		this.#windows.add(child);
		try {
			await child.started;
			return child;
		} catch (error) {
			try {
				await child.dispose();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], 'Windows harness launch cleanup was not confirmed.');
			}
			throw error;
		}
	}

	async ownedWindowsProcesses(parsePosix) {
		const memberships = await Promise.all([...this.#windows].map(async (child) => {
			if (child.cleanupConfirmed) {
				return new Set();
			}
			try {
				return await child.ownedPids();
			} catch (error) {
				if (child.cleanupConfirmed) {
					return new Set();
				}
				throw error;
			}
		}));
		const pids = new Set(memberships.flatMap((membership) => [...membership]));
		if (pids.size === 0) {
			return [];
		}
		const table = new Map(readProcessTable(parsePosix).map((entry) => [entry.pid, entry]));
		// Membership comes exclusively from the kernel Job Object. Missing metadata
		// must not make an owned process disappear from cleanup evidence.
		return [...pids].map((pid) => table.get(pid) ?? {
			pid, parentPid: 0, processGroupId: 0, command: '<owned-process>',
		});
	}

	async disposeWindows({ stopLaunching = false } = {}) {
		this.#stopping ||= stopLaunching;
		const results = await Promise.allSettled([...this.#windows].map((child) => child.dispose()));
		const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
		if (failures.length > 0) {
			throw new AggregateError(failures, 'Windows harness Job Object cleanup was not confirmed.');
		}
	}
}
