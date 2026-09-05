const esbuild = require("esbuild");
const { rmSync, existsSync, readFileSync, readdirSync, lstatSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve, sep } = require("node:path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			if (production && result.errors.length === 0) {
				writeThirdPartyNotices(result.metafile);
			}
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	if (production) {
		rmSync('dist', { recursive: true, force: true });
	}
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		metafile: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

function writeThirdPartyNotices(metafile) {
	const root = resolve('node_modules');
	const packages = new Set();
	for (const input of Object.keys(metafile.inputs)) {
		let directory = dirname(resolve(input));
		while (directory.startsWith(`${root}${sep}`)) {
			if (existsSync(join(directory, 'package.json'))) {
				packages.add(directory);
				break;
			}
			directory = dirname(directory);
		}
	}
	const mit = readFileSync('LICENSE', 'utf8');
	const notices = [];
	for (const directory of [...packages].sort()) {
		const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
		const files = readdirSync(directory).filter((name) =>
			/^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/iu.test(name)
			&& lstatSync(join(directory, name)).isFile());
		const license = files.length > 0
			? files.map((name) => readFileSync(join(directory, name), 'utf8')).join('\n\n')
			: metadata.license === 'MIT'
				? `${metadata.name.startsWith('@microsoft/') ? 'Copyright (c) Microsoft Corporation\n' : ''}${mit.slice(mit.indexOf('Permission is hereby granted'))}`
				: `License: ${metadata.license}. See ${metadata.repository?.url ?? metadata.repository ?? metadata.homepage ?? metadata.name}.`;
		notices.push(`${metadata.name} ${metadata.version}\n${'='.repeat(72)}\n${license}`);
	}
	writeFileSync('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n'), 'utf8');
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
