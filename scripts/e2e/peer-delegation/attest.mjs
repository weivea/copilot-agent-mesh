import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	resolvePeerDelegationEvidenceDestination,
} from './evidence-path.mjs';

const runId = process.argv[2];
const confirmation = process.argv[3];
const observation = process.argv[4];
const postDetachChallenge = process.argv[5];
if (
	typeof runId !== 'string'
	|| !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)
) {
	throw new Error('Provide the exact peer-delegation E2E run UUID.');
}
if (confirmation !== 'confirmation-once') {
	throw new Error('Confirmation observation must be confirmation-once.');
}
if (observation !== 'session-visible' && observation !== 'session-not-visible') {
	throw new Error('Observation must be session-visible or session-not-visible.');
}
if (
	typeof postDetachChallenge !== 'string'
	|| !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(postDetachChallenge)
) {
	throw new Error('Provide the post-detach observation challenge printed by the harness.');
}
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const fileName = `attestation-${runId}.json`;
const destination = await resolvePeerDelegationEvidenceDestination({
	repositoryRoot,
	configuredRoot: process.env.MESH_PEER_DELEGATION_E2E_EVIDENCE_DIR,
	additionalFileNames: [fileName],
});
const evidenceRoot = destination.root;
await mkdir(evidenceRoot, { recursive: true });
await resolvePeerDelegationEvidenceDestination({
	repositoryRoot,
	configuredRoot: evidenceRoot,
	additionalFileNames: [fileName],
});
const attestationPath = join(evidenceRoot, fileName);
const temporaryPath = `${attestationPath}.${process.pid}.tmp`;
try {
	await resolvePeerDelegationEvidenceDestination({
		repositoryRoot,
		configuredRoot: evidenceRoot,
		additionalFileNames: [fileName, `${fileName}.${process.pid}.tmp`],
	});
	await writeFile(
		temporaryPath,
		`${JSON.stringify({
			schemaVersion: 2,
			runId,
			postDetachChallenge,
			confirmationAcceptedOnce: true,
			targetSessionVisible: observation === 'session-visible',
		})}\n`,
		{ encoding: 'utf8', mode: 0o600, flag: 'wx' },
	);
	await resolvePeerDelegationEvidenceDestination({
		repositoryRoot,
		configuredRoot: evidenceRoot,
		additionalFileNames: [fileName, `${fileName}.${process.pid}.tmp`],
	});
	await rename(temporaryPath, attestationPath);
} finally {
	await rm(temporaryPath, { force: true });
}
console.log(JSON.stringify({ recorded: true, runId, observation }));
