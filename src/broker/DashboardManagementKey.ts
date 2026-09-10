import { createHash } from 'node:crypto';

export function managementKey(kind: 'workspace' | 'target' | 'device' | 'peer', ...identity: string[]): string {
	const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
	return `manage-${kind}-${BigInt(`0x${digest}`) + 1n}`;
}
