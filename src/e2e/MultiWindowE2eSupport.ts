import { createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const actionPattern = /^[a-z][a-z0-9.]{0,63}$/u;
const workspaceKeyPattern = /^[a-z0-9][a-z0-9-]{0,63}-[a-f0-9]{12}$/u;

export interface MultiWindowRequestEnvelope {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly action: string;
	readonly nonce: string;
	readonly role: 'coordinator';
	readonly workspaceKey: string;
	readonly windowId: string;
	readonly params: Record<string, unknown>;
}

export interface MultiWindowRequestIdentity {
	readonly nonce: string;
	readonly workspaceKey: string;
	readonly windowId: string;
}

export interface ProcessTableEntry {
	readonly pid: number;
	readonly parentPid: number;
	readonly processGroupId: number;
	readonly command: string;
}

export interface OwnedProcessSelection {
	readonly rootPids: ReadonlySet<number>;
	readonly markers: readonly string[];
	readonly selfPid: number;
}

export function multiWindowWorkspaceKey(workspaceBasename: string): string {
	if (
		workspaceBasename.length === 0
		|| workspaceBasename === '.'
		|| workspaceBasename === '..'
		|| workspaceBasename.includes('\0')
		|| Buffer.byteLength(workspaceBasename, 'utf8') > 256
	) {
		throw new TypeError('The multi-window E2E workspace basename is invalid.');
	}
	const label = workspaceBasename
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 48) || 'workspace';
	const digest = createHash('sha256')
		.update('copilot-agent-mesh/multi-window-control/v1\0', 'utf8')
		.update(workspaceBasename, 'utf8')
		.digest('hex')
		.slice(0, 12);
	return `${label}-${digest}`;
}

export function multiWindowControlDirectory(
	controlRoot: string,
	workspaceBasename: string,
	windowId: string,
): string {
	if (!isAbsolute(controlRoot)) {
		throw new TypeError('The multi-window E2E control root must be absolute.');
	}
	if (!uuidV4Pattern.test(windowId)) {
		throw new TypeError('The multi-window E2E window ID must be a UUID v4.');
	}
	return join(
		controlRoot,
		'windows',
		multiWindowWorkspaceKey(workspaceBasename),
		windowId,
	);
}

export function parseMultiWindowRequest(
	value: unknown,
	expected: MultiWindowRequestIdentity,
): MultiWindowRequestEnvelope {
	if (!isPlainRecord(value)) {
		throw new TypeError('Invalid multi-window E2E request envelope.');
	}
	const keys = Object.keys(value).sort();
	const expectedKeys = [
		'action',
		'id',
		'nonce',
		'params',
		'role',
		'schemaVersion',
		'windowId',
		'workspaceKey',
	];
	if (
		keys.length !== expectedKeys.length
		|| keys.some((key, index) => key !== expectedKeys[index])
		|| value.schemaVersion !== 1
		|| typeof value.id !== 'string'
		|| !uuidV4Pattern.test(value.id)
		|| typeof value.action !== 'string'
		|| !actionPattern.test(value.action)
		|| typeof value.nonce !== 'string'
		|| value.role !== 'coordinator'
		|| typeof value.workspaceKey !== 'string'
		|| !workspaceKeyPattern.test(value.workspaceKey)
		|| typeof value.windowId !== 'string'
		|| !uuidV4Pattern.test(value.windowId)
		|| !isPlainRecord(value.params)
		|| Buffer.byteLength(JSON.stringify(value.params), 'utf8') > 256 * 1_024
		|| !secureEqual(value.nonce, expected.nonce)
		|| value.workspaceKey !== expected.workspaceKey
		|| value.windowId !== expected.windowId
	) {
		throw new TypeError('Invalid multi-window E2E request envelope.');
	}
	return {
		schemaVersion: 1,
		id: value.id,
		action: value.action,
		nonce: value.nonce,
		role: value.role,
		workspaceKey: value.workspaceKey,
		windowId: value.windowId,
		params: value.params,
	};
}

export function parseProcessTable(value: string): readonly ProcessTableEntry[] {
	const entries: ProcessTableEntry[] = [];
	for (const line of value.split(/\r?\n/u)) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
		if (match === null) {
			continue;
		}
		const [pid, parentPid, processGroupId] = match.slice(1, 4).map(Number);
		if (
			![pid, parentPid, processGroupId].every(
				(candidate) => Number.isSafeInteger(candidate) && candidate >= 0,
			)
			|| pid === 0
		) {
			continue;
		}
		entries.push({
			pid,
			parentPid,
			processGroupId,
			command: match[4],
		});
	}
	return entries;
}

export function selectOwnedProcesses(
	entries: readonly ProcessTableEntry[],
	selection: OwnedProcessSelection,
): readonly ProcessTableEntry[] {
	if (
		selection.markers.length === 0
		|| selection.markers.some((marker) => marker.length === 0)
	) {
		throw new TypeError('Owned process markers must be non-empty.');
	}
	const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
	const owned = new Set<number>();
	for (const entry of entries) {
		if (
			entry.pid !== selection.selfPid
			&& (
				selection.rootPids.has(entry.pid)
				|| selection.markers.some((marker) => entry.command.includes(marker))
			)
		) {
			owned.add(entry.pid);
		}
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of entries) {
			if (
				entry.pid !== selection.selfPid
				&& !owned.has(entry.pid)
				&& owned.has(entry.parentPid)
			) {
				owned.add(entry.pid);
				changed = true;
			}
		}
	}
	const depth = (entry: ProcessTableEntry): number => {
		let value = 0;
		let current = entry;
		const seen = new Set<number>();
		while (owned.has(current.parentPid) && !seen.has(current.parentPid)) {
			seen.add(current.parentPid);
			value += 1;
			const parent = byPid.get(current.parentPid);
			if (parent === undefined) {
				break;
			}
			current = parent;
		}
		return value;
	};
	return entries
		.filter((entry) => owned.has(entry.pid))
		.sort((left, right) => depth(right) - depth(left) || right.pid - left.pid);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function secureEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, 'utf8');
	const rightBytes = Buffer.from(right, 'utf8');
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
