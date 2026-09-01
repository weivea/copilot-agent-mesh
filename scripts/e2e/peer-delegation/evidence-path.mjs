import { lstat, readdir } from 'node:fs/promises';
import {
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
	sep,
} from 'node:path';

const releaseFileNames = ['evidence.json', 'summary.md'];

export async function resolvePeerDelegationEvidenceDestination(options) {
	const repositoryRoot = resolve(options.repositoryRoot);
	const defaultRoot = join(repositoryRoot, 'artifacts', 'peer-delegation-e2e');
	const configuredRoot = options.configuredRoot;
	if (configuredRoot !== undefined && !isAbsolute(configuredRoot)) {
		throw new Error('The peer-delegation evidence directory override must be absolute.');
	}
	const root = configuredRoot === undefined ? defaultRoot : resolve(configuredRoot);
	if (root === dirname(root)) {
		throw new Error('The peer-delegation evidence directory must not be a filesystem root.');
	}
	if (configuredRoot === undefined && !isWithin(repositoryRoot, root)) {
		throw new Error('The default peer-delegation evidence directory escaped the repository.');
	}
	if (
		configuredRoot !== undefined
		&& root !== defaultRoot
		&& (
			filesystemPathKey(root) === filesystemPathKey(defaultRoot)
			|| await pathsShareEntry(root, defaultRoot)
		)
	) {
		throw new Error('The peer-delegation evidence directory aliases the stable release directory.');
	}
	if (
		configuredRoot !== undefined
		&& root !== defaultRoot
		&& options.allowRepositoryNestedOverride !== true
		&& (
			root === repositoryRoot
			|| isWithin(repositoryRoot, root)
			|| isWithin(root, repositoryRoot)
		)
	) {
		throw new Error(
			'The peer-delegation evidence directory override must be the stable artifact directory or outside the repository.',
		);
	}
	await assertPathComponentsHaveNoSymlink(root);
	await assertSafeExistingFiles(
		root,
		[...releaseFileNames, ...(options.additionalFileNames ?? [])],
	);
	return {
		root,
		evidencePath: join(root, 'evidence.json'),
		summaryPath: join(root, 'summary.md'),
	};
}

export function assertCleanCommittedReleaseSnapshot(options) {
	if (options.statusBefore.length !== 0 || options.statusAfter.length !== 0) {
		throw Object.assign(
			new Error('Full release evidence requires a clean committed tree.'),
			{ code: 'WORKTREE_DIRTY' },
		);
	}
	if (
		options.headBefore !== options.expectedCommit
		|| options.headAfter !== options.expectedCommit
	) {
		throw Object.assign(
			new Error('Full release evidence must match the current committed HEAD.'),
			{ code: 'EVIDENCE_COMMIT_MISMATCH' },
		);
	}
}

async function assertPathComponentsHaveNoSymlink(path) {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	const segments = relative(root, absolute).split(sep).filter(Boolean);
	let current = root;
	for (const segment of segments) {
		if (process.platform === 'darwin' || process.platform === 'win32') {
			const entries = await readdir(current).catch((error) => {
				if (error?.code === 'ENOENT') {
					return undefined;
				}
				throw error;
			});
			const alias = entries?.find(
				(entry) =>
					entry.toLocaleLowerCase('en-US')
						=== segment.toLocaleLowerCase('en-US')
					&& entry !== segment,
			);
			if (alias !== undefined) {
				throw new Error('The peer-delegation evidence path contains a case alias.');
			}
		}
		current = join(current, segment);
		let entry;
		try {
			entry = await lstat(current);
		} catch (error) {
			if (error?.code === 'ENOENT') {
				return;
			}
			throw error;
		}
		if (entry.isSymbolicLink()) {
			throw new Error('The peer-delegation evidence path must not contain symbolic links.');
		}
	}
}

async function assertSafeExistingFiles(root, names) {
	const directoryEntries = await readdir(root).catch((error) => {
		if (error?.code === 'ENOENT') {
			return [];
		}
		throw error;
	});
	for (const name of new Set(names)) {
		if (
			typeof name !== 'string'
			|| name.length === 0
			|| name !== name.split(/[\\/]/u).at(-1)
		) {
			throw new Error('The peer-delegation evidence file name is invalid.');
		}
		if (
			(process.platform === 'darwin' || process.platform === 'win32')
			&& directoryEntries.some(
				(entry) =>
					entry.toLocaleLowerCase('en-US')
						=== name.toLocaleLowerCase('en-US')
					&& entry !== name,
			)
		) {
			throw new Error('The peer-delegation evidence file name is a case alias.');
		}
		let entry;
		try {
			entry = await lstat(join(root, name));
		} catch (error) {
			if (error?.code === 'ENOENT') {
				continue;
			}
			throw error;
		}
		if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
			throw new Error('The peer-delegation evidence file is aliased or unsafe.');
		}
	}
}

async function pathsShareEntry(left, right) {
	try {
		const [leftEntry, rightEntry] = await Promise.all([lstat(left), lstat(right)]);
		return leftEntry.dev === rightEntry.dev && leftEntry.ino === rightEntry.ino;
	} catch (error) {
		if (error?.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

function filesystemPathKey(path) {
	const absolute = resolve(path);
	return process.platform === 'darwin' || process.platform === 'win32'
		? absolute.toLocaleLowerCase('en-US')
		: absolute;
}

function isWithin(parent, candidate) {
	const path = relative(parent, candidate);
	return path.length > 0
		&& path !== '..'
		&& !path.startsWith(`..${sep}`)
		&& !isAbsolute(path);
}
