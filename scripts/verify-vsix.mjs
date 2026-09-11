import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCentralDirectory } from './vsix-archive.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const archivePath = resolve(process.argv[2] ?? `artifacts/copilot-agent-mesh-${manifest.version}-preview.vsix`);
const archive = readFileSync(archivePath);
const entries = readCentralDirectory(archive).sort();

const expected = [
	'[Content_Types].xml',
	'extension.vsixmanifest',
	'extension/LICENSE.txt',
	'extension/NOTICE',
	'extension/changelog.md',
	'extension/dist/extension.js',
	'extension/dist/THIRD_PARTY_NOTICES.txt',
	'extension/dist/codespaces-companion.vsix',
	'extension/dist/windows/LICENSE-go.txt',
	'extension/dist/windows/mesh-process-host-arm64.exe',
	'extension/dist/windows/mesh-process-host-x64.exe',
	'extension/docs/mvp/release.md',
	'extension/docs/desktop-codespaces.md',
	'extension/l10n/bundle.l10n.zh-cn.json',
	'extension/media/agent-mesh.svg',
	'extension/media/connections-enabled-dark.svg',
	'extension/media/connections-enabled-light.svg',
	'extension/media/dashboard.css',
	'extension/media/dashboard.js',
	'extension/media/dashboard.l10n.js',
	'extension/package.json',
	'extension/package.nls.json',
	'extension/package.nls.zh-cn.json',
	'extension/readme.md',
	'extension/third_party/agent-host-protocol/LICENSE',
].sort();

const prohibited = [
	/(^|\/)(?:src|shared|test|tests|out|node_modules|\.vscode-test)(?:\/|$)/iu,
	/\.map$/iu,
	/(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))/iu,
	/(^|\/)(?:devtunnel|code|gh)(?:\.exe)?$/iu,
	/\.(?:7z|bz2|cab|gz|jar|rar|tar|tgz|vsix|whl|xz|zip)$/iu,
];

const unexpected = entries.filter((entry) => !expected.includes(entry));
const missing = expected.filter((entry) => !entries.includes(entry));
const prohibitedEntries = entries.filter((entry) => entry !== 'extension/dist/codespaces-companion.vsix'
	&& prohibited.some((pattern) => pattern.test(entry)));

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
