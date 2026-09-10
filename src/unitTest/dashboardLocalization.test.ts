import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

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
