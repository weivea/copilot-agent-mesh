import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const actionPattern = /^[a-z][a-z0-9.]{0,63}$/u;
const workspaceKeyPattern = /^[a-z0-9][a-z0-9-]{0,63}-[a-f0-9]{12}$/u;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const startupMessages = {
	BROKER_RUNTIME_START_FAILED: 'The Device Broker runtime failed to start.',
	WINDOW_NODE_CONNECT_FAILED: 'The Window Node could not connect to the local Device Broker.',
	WORKSPACE_BUSY: 'The Window Node workspace claim was rejected as busy.',
	WORKSPACE_NOT_FOUND: 'The Window Node workspace could not be resolved.',
} as const;

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

export type MultiWindowStartupDiagnosticCode = keyof typeof startupMessages;

export interface MultiWindowStartupDiagnostic {
	readonly schemaVersion: 1;
	readonly code: MultiWindowStartupDiagnosticCode;
	readonly message: string;
	readonly recordedAt: string;
	readonly workspaceKey: string;
	readonly windowId: string;
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

export function multiWindowStartupDiagnosticPath(
	controlRoot: string,
	workspaceBasename: string,
	windowId: string,
): string {
	return join(
		multiWindowControlDirectory(controlRoot, workspaceBasename, windowId),
		'startup-failure.json',
	);
}

export async function writeMultiWindowStartupDiagnostic(input: {
	readonly controlRoot: string;
	readonly workspaceBasename: string;
	readonly windowId: string;
	readonly code: MultiWindowStartupDiagnosticCode;
}): Promise<void> {
	const path = multiWindowStartupDiagnosticPath(
		input.controlRoot,
		input.workspaceBasename,
		input.windowId,
	);
	const controlDirectory = multiWindowControlDirectory(
		input.controlRoot,
		input.workspaceBasename,
		input.windowId,
	);
	const value = {
		schemaVersion: 1,
		code: input.code,
		recordedAt: new Date().toISOString(),
	};
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await mkdir(controlDirectory, { recursive: true });
	try {
		await writeFile(temporary, `${JSON.stringify(value)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
			flag: 'wx',
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function clearMultiWindowStartupDiagnostic(
	controlRoot: string,
	workspaceBasename: string,
	windowId: string,
): Promise<void> {
	await rm(
		multiWindowStartupDiagnosticPath(controlRoot, workspaceBasename, windowId),
		{ force: true },
	);
}

export async function readMultiWindowStartupDiagnostic(
	path: string,
	expected: {
		readonly workspaceKey: string;
		readonly windowId: string;
		readonly launchedAt: number;
	},
): Promise<MultiWindowStartupDiagnostic> {
	const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
	return parseMultiWindowStartupDiagnostic(value, expected);
}

export function parseMultiWindowStartupDiagnostic(
	value: unknown,
	expected: {
		readonly workspaceKey: string;
		readonly windowId: string;
		readonly launchedAt: number;
	},
): MultiWindowStartupDiagnostic {
	if (
		!isPlainRecord(value)
		|| Object.keys(value).sort().join(',') !== 'code,recordedAt,schemaVersion'
		|| value.schemaVersion !== 1
		|| typeof value.code !== 'string'
		|| !Object.hasOwn(startupMessages, value.code)
		|| typeof value.recordedAt !== 'string'
		|| !isoTimestampPattern.test(value.recordedAt)
		|| !isCanonicalTimestamp(value.recordedAt)
		|| Date.parse(value.recordedAt) < expected.launchedAt - 1_000
	) {
		throw new TypeError('Invalid multi-window E2E startup diagnostic.');
	}
	const code = value.code as MultiWindowStartupDiagnosticCode;
	return {
		schemaVersion: 1,
		code,
		message: startupMessages[code],
		recordedAt: value.recordedAt,
		workspaceKey: expected.workspaceKey,
		windowId: expected.windowId,
	};
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

function isCanonicalTimestamp(value: string): boolean {
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds)
		&& new Date(milliseconds).toISOString() === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function secureEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, 'utf8');
	const rightBytes = Buffer.from(right, 'utf8');
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
