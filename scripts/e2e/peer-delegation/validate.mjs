import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const defaultEvidencePath = resolve(
	repositoryRoot,
	'artifacts',
	'peer-delegation-e2e',
	'evidence.json',
);
const argumentsWithoutFlags = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const evidencePath = resolve(argumentsWithoutFlags[0] ?? defaultEvidencePath);
const requirePass = process.argv.includes('--require-pass');
const require = createRequire(import.meta.url);
const {
	assertPassingPeerDelegationEvidence,
	parsePeerDelegationEvidenceArtifact,
} = require(resolve(repositoryRoot, 'out/src/e2e/PeerDelegationEvidence.js'));

const serialized = await readFile(evidencePath, 'utf8');
if (Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) {
	throw new Error('Peer-delegation evidence exceeds the 1 MiB validation limit.');
}
const value = JSON.parse(serialized);
const evidence = requirePass
	? assertPassingPeerDelegationEvidence(value)
	: parsePeerDelegationEvidenceArtifact(value);
const head = git(['rev-parse', 'HEAD']);
const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
if (status.length !== 0) {
	throw new Error('Peer-delegation evidence validation requires a clean current worktree.');
}
if (evidence.gitCommit !== head) {
	throw new Error('Peer-delegation evidence was produced for a different git commit.');
}
console.log(JSON.stringify({
	valid: true,
	passing: evidence.outcome === 'pass',
	kind: evidence.kind ?? 'evidence',
	runId: evidence.runId,
	outcome: evidence.outcome,
	ac5PassCount: 'ac5' in evidence
		? evidence.ac5.filter(({ status }) => status === 'pass').length
		: 0,
}));

function git(args) {
	const result = spawnSync('git', args, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		shell: false,
	});
	if (result.status !== 0) {
		throw new Error('Unable to bind peer-delegation evidence to the current git tree.');
	}
	return result.stdout.trim();
}
