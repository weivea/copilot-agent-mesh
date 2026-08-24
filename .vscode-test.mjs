import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@vscode/test-cli';

const testRoot = mkdtempSync(join(tmpdir(), 'cam-vscode-test-'));
process.once('exit', () => rmSync(testRoot, { recursive: true, force: true }));

export default defineConfig({
	files: 'out/src/test/**/*.test.js',
	launchArgs: [
		`--user-data-dir=${join(testRoot, 'user-data')}`,
		`--extensions-dir=${join(testRoot, 'extensions')}`,
	],
});
