import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@vscode/test-cli';

const profileRoot = join(tmpdir(), `copilot-agent-mesh-test-${process.pid}`);

export default defineConfig({
	files: 'out/src/test/**/*.test.js',
	launchArgs: [
		`--user-data-dir=${join(profileRoot, 'user')}`,
		`--extensions-dir=${join(profileRoot, 'extensions')}`,
	],
});
