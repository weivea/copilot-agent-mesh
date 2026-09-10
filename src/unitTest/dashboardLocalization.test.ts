import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { z } from 'zod';

const root = resolve(__dirname, '../../..');
const readJson = (name: string): unknown => JSON.parse(readFileSync(resolve(root, name), 'utf8'));

function strings(value: unknown): string[] {
	if (typeof value === 'string') { return [value]; }
	if (Array.isArray(value)) { return value.flatMap(strings); }
	if (value !== null && typeof value === 'object') { return Object.values(value).flatMap(strings); }
	return [];
}

function dictionary(value: unknown): Record<string, string> {
	assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
	const result: Record<string, string> = {};
	for (const [key, text] of Object.entries(value)) {
		assert.equal(typeof text, 'string', key);
		assert.ok(typeof text === 'string' && text.length > 0, key);
		result[key] = text;
	}
	return result;
}

test('all localized command and configuration references have English and Chinese text', () => {
	const source = strings(readJson('package.json'));
	const english = dictionary(readJson('package.nls.json'));
	const chinese = dictionary(readJson('package.nls.zh-cn.json'));
	const references = source.flatMap((value) => /^%([^%]+)%$/u.exec(value)?.[1] ?? []);
	assert.ok(references.length >= 17);
	for (const key of references) {
		assert.ok(Object.hasOwn(english, key), `English reference missing: ${key}`);
		assert.ok(Object.hasOwn(chinese, key), `Chinese reference missing: ${key}`);
	}
	assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
});

test('native toolbar shows the connection switch first and reserves color for the online command', () => {
	const manifest = z.object({
		contributes: z.object({
			commands: z.array(z.object({ command: z.string(), icon: z.unknown().optional() })),
			menus: z.object({
				'view/title': z.array(z.object({ command: z.string(), when: z.string(), group: z.string() })),
			}),
		}),
	}).parse(readJson('package.json'));
	const actions = manifest.contributes.menus['view/title'];
	assert.equal(actions.some((action) => action.command === 'copilotAgentMesh.configureDevice'), false);
	assert.deepEqual(actions.map((action) => action.group), ['navigation@1', 'navigation@1', 'navigation@2', 'navigation@9']);
	assert.equal(actions[0].command, 'copilotAgentMesh.startListener');
	assert.equal(actions[1].command, 'copilotAgentMesh.stopListener');
	assert.match(actions[0].when, /!copilotAgentMesh\.connectionsOnline/u);
	assert.match(actions[1].when, /&& copilotAgentMesh\.connectionsOnline$/u);
	const start = manifest.contributes.commands.find((command) => command.command === actions[0].command);
	const stop = manifest.contributes.commands.find((command) => command.command === actions[1].command);
	assert.equal(start?.icon, '$(radio-tower)');
	const paths = z.object({ dark: z.string(), light: z.string() }).parse(stop?.icon);
	for (const [theme, path] of Object.entries(paths)) {
		assert.equal(path, `media/connections-enabled-${theme}.svg`);
		const svg = readFileSync(resolve(root, path), 'utf8');
		assert.match(svg, /viewBox="0 0 16 16"/u);
		assert.match(svg, theme === 'dark' ? /stroke="#73c991"/u : /stroke="#16825d"/u);
	}
	assert.ok(manifest.contributes.commands.some((command) => command.command === 'copilotAgentMesh.configureDevice'),
		'The palette command remains available even though the redundant toolbar button is removed.');
});

test('native Chinese messages preserve format arguments', () => {
	for (const [source, translated] of Object.entries(dictionary(readJson('l10n/bundle.l10n.zh-cn.json')))) {
		const parameters = (value: string) => [...value.matchAll(/\{\d+\}/gu)].map(([parameter]) => parameter).sort();
		assert.deepEqual(parameters(translated), parameters(source), source);
	}
});

test('native management confirmations and action errors have Chinese translations', () => {
	const chinese = dictionary(readJson('l10n/bundle.l10n.zh-cn.json'));
	for (const name of ['ProductionDashboardManagement', 'ProductionConnectivity', 'ProductionDashboardBindings']) {
		const path = resolve(root, 'src/composition', `${name}.ts`);
		const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const callee = node.expression.getText(source);
				const argument = callee === 'localize' ? node.arguments[1]
					: callee === 'this.t' || callee === 'forbidden' ? node.arguments[0] : undefined;
				if (argument !== undefined && ts.isStringLiteralLike(argument)) {
					assert.ok(Object.hasOwn(chinese, argument.text), `${name}: ${argument.text}`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
});
