import { createHash } from 'node:crypto';

/**
 * Reuse only unchanged, unconsumed JSON-data bindings. Mint and publish a
 * snapshot synchronously after its asynchronous reads so consumed handles
 * cannot be restored by an older in-flight snapshot.
 */
export function snapshotActionIssuer<T extends object>(
	previous: ReadonlyMap<string, T> | undefined,
	next: Map<string, T>,
	create: (binding: T) => string,
): (binding: T) => string {
	const candidates = new Map<string, Array<{ handle: string; binding: T }>>();
	for (const [handle, binding] of previous ?? []) {
		const key = fingerprint(binding);
		const values = candidates.get(key) ?? [];
		values.push({ handle, binding });
		candidates.set(key, values);
	}
	return (binding) => {
		const values = candidates.get(fingerprint(binding));
		while (values?.length) {
			const existing = values.shift()!;
			if (previous?.get(existing.handle) === existing.binding && !next.has(existing.handle)) {
				next.set(existing.handle, binding);
				return existing.handle;
			}
		}
		return create(binding);
	};
}

export function replaceSnapshotActions<T>(target: Map<string, T>, next: ReadonlyMap<string, T>): void {
	target.clear();
	for (const [handle, binding] of next) { target.set(handle, binding); }
}

function fingerprint(value: object): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
