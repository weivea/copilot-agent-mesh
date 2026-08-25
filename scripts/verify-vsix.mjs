import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const archivePath = resolve(process.argv[2] ?? 'artifacts/copilot-agent-mesh-0.1.0-preview.vsix');
const archive = readFileSync(archivePath);
const entries = readCentralDirectory(archive).sort();

const expected = [
	'[Content_Types].xml',
	'extension.vsixmanifest',
	'extension/LICENSE.txt',
	'extension/NOTICE',
	'extension/changelog.md',
	'extension/dist/extension.js',
	'extension/docs/mvp/release.md',
	'extension/media/agent-mesh.svg',
	'extension/media/dashboard.css',
	'extension/media/dashboard.js',
	'extension/package.json',
	'extension/readme.md',
	'extension/vendor/microsoft-agent-host-protocol-0.8.0.tgz',
	'extension/vendor/microsoft-agent-host-protocol-LICENSE.txt',
].sort();

const prohibited = [
	/(^|\/)(?:src|shared|test|tests|out|node_modules|\.vscode-test)(?:\/|$)/iu,
	/\.map$/iu,
	/(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))/iu,
	/(^|\/)(?:devtunnel|code|gh)(?:\.exe)?$/iu,
];

const unexpected = entries.filter((entry) => !expected.includes(entry));
const missing = expected.filter((entry) => !entries.includes(entry));
const prohibitedEntries = entries.filter((entry) => prohibited.some((pattern) => pattern.test(entry)));

if (unexpected.length || missing.length || prohibitedEntries.length) {
	throw new Error([
		'VSIX content verification failed.',
		unexpected.length ? `Unexpected: ${unexpected.join(', ')}` : '',
		missing.length ? `Missing: ${missing.join(', ')}` : '',
		prohibitedEntries.length ? `Prohibited: ${prohibitedEntries.join(', ')}` : '',
	].filter(Boolean).join('\n'));
}

const sha256 = createHash('sha256').update(archive).digest('hex');
console.log(entries.join('\n'));
console.log(`sha256  ${sha256}  ${archivePath}`);

function readCentralDirectory(buffer) {
	const endSignature = 0x06054b50;
	const centralSignature = 0x02014b50;
	const minimumEndSize = 22;
	const earliestEnd = Math.max(0, buffer.length - 0xffff - minimumEndSize);
	let endOffset = -1;

	for (let offset = buffer.length - minimumEndSize; offset >= earliestEnd; offset -= 1) {
		if (buffer.readUInt32LE(offset) === endSignature) {
			endOffset = offset;
			break;
		}
	}
	if (endOffset < 0) {
		throw new Error('VSIX end-of-central-directory record was not found.');
	}

	const entryCount = buffer.readUInt16LE(endOffset + 10);
	let offset = buffer.readUInt32LE(endOffset + 16);
	const names = [];

	for (let index = 0; index < entryCount; index += 1) {
		if (buffer.readUInt32LE(offset) !== centralSignature) {
			throw new Error(`Invalid central-directory entry at offset ${offset}.`);
		}
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const nameStart = offset + 46;
		names.push(buffer.toString('utf8', nameStart, nameStart + nameLength));
		offset = nameStart + nameLength + extraLength + commentLength;
	}

	return names;
}
