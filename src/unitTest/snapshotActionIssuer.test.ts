import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotActionIssuer, replaceSnapshotActions } from '../ui/SnapshotActionIssuer';

type Binding = { action: string; target: string; revision: number };
const value: Binding = { action: 'allow', target: 'exact-target', revision: 1 };

function stage(previous: Map<string, Binding>) {
	const next = new Map<string, Binding>();
	let sequence = 0;
	const issue = snapshotActionIssuer(previous, next, (binding) => {
		const handle = `new-${++sequence}`;
		next.set(handle, binding);
		return handle;
	});
	return { next, issue };
}

test('unchanged reads preserve exact handles without growing the registry', () => {
	const current = new Map([['existing', value]]);
	for (let index = 0; index < 20; index++) {
		const { issue, next } = stage(current);
		assert.equal(issue({ ...value }), 'existing');
		replaceSnapshotActions(current, next);
		assert.equal(current.size, 1);
	}
});

test('changed authority and consumed bindings never reuse the old handle', () => {
	for (const changed of [{ ...value, action: 'remove' }, { ...value, target: 'different' }, { ...value, revision: 2 }]) {
		const current = new Map([['existing', value]]);
		const { issue, next } = stage(current);
		assert.notEqual(issue(changed), 'existing');
		assert.ok(current.has('existing'), 'Collection must not clear currently displayed capabilities.');
		replaceSnapshotActions(current, next);
		assert.ok(!current.has('existing'));
	}
	const current = new Map([['existing', value]]);
	const { issue } = stage(current);
	current.delete('existing');
	assert.notEqual(issue({ ...value }), 'existing');
});

test('duplicate bindings retain independent one-use handles and obsolete entries are removed', () => {
	const current = new Map([
		['one', value], ['two', { ...value }], ['obsolete', { ...value, target: 'gone' }],
	]);
	const { issue, next } = stage(current);
	assert.deepEqual(new Set([issue({ ...value }), issue({ ...value })]), new Set(['one', 'two']));
	replaceSnapshotActions(current, next);
	assert.equal(current.size, 2);
	assert.ok(!current.has('obsolete'));
});
