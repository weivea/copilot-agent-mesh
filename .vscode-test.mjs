import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { defineConfig } from '@vscode/test-cli';

const testRoot = mkdtempSync(join(tmpdir(), 'cam-vscode-test-'));
process.once('exit', () => rmSync(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

export default defineConfig({
	files: 'out/src/test/*.test.js',
	...(process.env.VSCODE_EXECUTABLE_PATH ? {
		useInstallation: { fromPath: resolve(process.env.VSCODE_EXECUTABLE_PATH) },
	} : {}),
	launchArgs: [
		`--user-data-dir=${join(testRoot, 'user-data')}`,
		`--extensions-dir=${join(testRoot, 'extensions')}`,
	],
});
