import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
	SessionConfigSchema,
	StateAction,
} from '@microsoft/agent-host-protocol' with { 'resolution-mode': 'import' };

import { AgentRuntimeError, type AgentHostSource } from './AgentRuntime';
import { validateSessionConfigValue } from './SessionConfigValue';

export interface AgentSessionIdentity {
	readonly provider: string;
	readonly uri: string;
}

export function createAgentSessionIdentity(
	source: AgentHostSource | undefined,
	provider: string,
	id: string,
): AgentSessionIdentity {
	if (source === 'editor' && !/^[a-z][a-z0-9+.-]*$/iu.test(provider)) {
		throw new AgentRuntimeError(
			'AGENT_CONFIG_REQUIRED',
			'The editor Agent provider cannot be represented by a native Session URI.',
		);
	}
	return Object.freeze({
		provider,
		uri: `${source === 'editor' ? provider : 'ahp-session'}:/${id}`,
	});
}

export function matchesEditorSessionWorkspace(
	workingDirectories: unknown,
	workspaceUri: string,
): workingDirectories is readonly string[] {
	const expected = normalizedDirectoryUri(workspaceUri);
	return expected !== undefined
		&& Array.isArray(workingDirectories)
		&& workingDirectories.length === 1
		&& normalizedDirectoryUri(workingDirectories[0]) === expected;
}

export class EditorSessionPolicy {
	private workingDirectories: readonly string[] | undefined;
	private values: Readonly<Record<string, unknown>> | undefined;

	public constructor(
		private readonly identity: AgentSessionIdentity,
		private readonly workspaceUri: string,
	) {}

	public constrainConfiguration(values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
		return { ...values, isolation: 'folder' };
	}

	public assertResolvedConfiguration(
		schema: SessionConfigSchema,
		values: Readonly<Record<string, unknown>>,
	): void {
		const isolation = schema.properties.isolation;
		if (isolation === undefined) {
			throw configurationFailure();
		}
		validateSessionConfigValue('isolation', isolation, 'folder');
		if (values.isolation !== 'folder') {
			throw configurationFailure();
		}
	}

	public acceptSnapshot(snapshot: unknown): void {
		if (
			!isRecord(snapshot)
			|| snapshot.resource !== this.identity.uri
			|| !isRecord(snapshot.state)
		) {
			throw sessionFailure();
		}
		const value = snapshot.state;
		if (
			(value.resource !== undefined && value.resource !== this.identity.uri)
			|| value.provider !== this.identity.provider
			|| !isRecord(value.config)
			|| !isRecord(value.config.values)
			|| value.config.values.isolation !== 'folder'
			|| !matchesEditorSessionWorkspace(value.workingDirectories, this.workspaceUri)
		) {
			throw sessionFailure();
		}
		this.values = { ...value.config.values };
		this.workingDirectories = [...value.workingDirectories];
	}

	public acceptAction(action: StateAction): void {
		switch (action.type) {
			case 'session/configChanged': {
				this.assertCurrentState();
				if (!isRecord(action.config)) {
					throw sessionFailure();
				}
				const values = action.replace ? { ...action.config } : { ...this.values, ...action.config };
				if (values.isolation !== 'folder') {
					throw sessionFailure();
				}
				this.values = values;
				break;
			}
			case 'session/workingDirectorySet':
				this.assertCurrentState();
				this.acceptDirectories([...new Set([...this.workingDirectories!, action.directory])]);
				break;
			case 'session/workingDirectoryRemoved':
				this.assertCurrentState();
				this.acceptDirectories(this.workingDirectories!.filter((directory) => directory !== action.directory));
				break;
			case 'session/workingDirectoryReplaced':
				this.assertCurrentState();
				this.acceptDirectories([...new Set(this.workingDirectories!.map((directory) =>
					directory === action.directory ? action.replacement : directory,
				))]);
				break;
		}
	}

	public assertCurrentState(): void {
		if (
			this.values?.isolation !== 'folder'
			|| !matchesEditorSessionWorkspace(this.workingDirectories, this.workspaceUri)
		) {
			throw sessionFailure();
		}
	}

	private acceptDirectories(directories: readonly string[]): void {
		if (!matchesEditorSessionWorkspace(directories, this.workspaceUri)) {
			throw sessionFailure();
		}
		this.workingDirectories = directories;
	}
}

function normalizedDirectoryUri(value: unknown): string | undefined {
	if (typeof value !== 'string' || !URL.canParse(value)) {
		return undefined;
	}
	const uri = new URL(value);
	if (
		uri.protocol !== 'file:'
		|| uri.username !== ''
		|| uri.password !== ''
		|| uri.search !== ''
		|| uri.hash !== ''
		|| (uri.hostname !== '' && uri.hostname !== 'localhost')
	) {
		return undefined;
	}
	try {
		return pathToFileURL(resolve(fileURLToPath(uri))).href;
	} catch (error: unknown) {
		if (error instanceof TypeError) {
			return undefined;
		}
		throw error;
	}
}

function configurationFailure(): AgentRuntimeError {
	return new AgentRuntimeError(
		'AGENT_CONFIG_REQUIRED',
		'The editor Agent Host must support folder isolation in the target workspace.',
	);
}

export class EditorSessionPolicyError extends AgentRuntimeError {
	public constructor() {
		super(
			'TASK_EXECUTION_FAILED',
			'The editor Agent Session does not match its provider, folder isolation, or target workspace.',
		);
	}
}

function sessionFailure(): EditorSessionPolicyError {
	return new EditorSessionPolicyError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
