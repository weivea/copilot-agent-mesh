import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runId = process.argv[2];
const confirmation = process.argv[3];
const observation = process.argv[4];
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
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const evidenceRoot = join(repositoryRoot, 'artifacts', 'peer-delegation-e2e');
await mkdir(evidenceRoot, { recursive: true });
await writeFile(
	join(evidenceRoot, `attestation-${runId}.json`),
	`${JSON.stringify({
		schemaVersion: 1,
		runId,
		confirmationAcceptedOnce: true,
		targetSessionVisible: observation === 'session-visible',
	})}\n`,
	{ encoding: 'utf8', mode: 0o600 },
);
console.log(JSON.stringify({ recorded: true, runId, observation }));
