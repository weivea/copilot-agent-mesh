import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
	delegationGrantSchema,
	type DelegationGrantProtocol,
	type NodeTaskStartParams,
} from '../../shared/protocol';
import type {
	AgentInputRequest,
	RegisteredLocalWorkspace,
} from '../agentHost/AgentRuntime';
import { canonicalRoutedTaskRequestHash } from '../domain/task';

const fileWriteToolNames = new Set(['write_file']);
const encodedUnsafePath = /%(?:2e|2f|5c|25|00)/iu;
const rawDotSegment = /(?:^|\/)\.{1,2}(?:\/|$)/u;
const windowsDrivePath = /^\/?[a-z]:[\\/]/iu;
const vcsControlRoots = new Set(['.git', '.hg', '.svn', '.husky', '.githooks']);
const vcsControlFiles = new Set(['.gitconfig', '.gitmodules', '.hgrc', '.hgsub']);
const ciControlRoots = new Set(['.buildkite', '.circleci', '.teamcity']);
const ciControlFiles = new Set([
	'.drone.yml',
	'.gitlab-ci.yml',
	'.travis.yml',
	'appveyor.yml',
	'azure-pipelines.yml',
	'bitbucket-pipelines.yml',
	'cloudbuild.yaml',
	'cloudbuild.yml',
	'jenkinsfile',
]);
const agentInstructionFiles = new Set([
	'agents.md',
	'claude.md',
	'gemini.md',
	'.cursorrules',
	'.windsurfrules',
]);
const vcsHookConfigurationFiles = new Set([
	'.pre-commit-config.yml',
	'.pre-commit-config.yaml',
	'lefthook.yml',
	'lefthook.yaml',
	'.lefthook.yml',
	'.lefthook.yaml',
	'lefthook-local.yml',
	'lefthook-local.yaml',
]);
const packageExecutionControlFiles = new Set([
	'.npmrc',
	'.yarnrc',
	'.yarnrc.yml',
	'build.gradle',
	'build.gradle.kts',
	'bun.lock',
	'bun.lockb',
	'bunfig.toml',
	'cargo.lock',
	'cargo.toml',
	'composer.json',
	'composer.lock',
	'deno.json',
	'deno.jsonc',
	'gemfile',
	'gemfile.lock',
	'npm-shrinkwrap.json',
	'package-lock.json',
	'package.json',
	'pipfile',
	'pipfile.lock',
	'poetry.lock',
	'pom.xml',
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'pnpm-workspace.yml',
	'pyproject.toml',
	'setup.cfg',
	'setup.py',
	'settings.gradle',
	'settings.gradle.kts',
	'uv.lock',
	'yarn.lock',
]);
const vscodeControlFiles = new Set(['tasks.json', 'settings.json', 'launch.json', 'mcp.json']);
const githubControlRoots = new Set([
	'actions',
	'agents',
	'chatmodes',
	'instructions',
	'prompts',
	'skills',
	'workflows',
]);
const toolConfirmationEvidenceSchema = z.strictObject({
	phase: z.enum(['operation', 'result']),
	toolName: z.string().min(1).max(256),
	fileEdits: z.array(z.strictObject({
		beforeUri: z.string().min(1).max(16_384).optional(),
		afterUri: z.string().min(1).max(16_384).optional(),
	}).refine(
		(edit) => edit.beforeUri !== undefined || edit.afterUri !== undefined,
		'At least one file URI is required.',
	)).min(1).max(128).optional(),
});

export type DelegationGrant = Readonly<DelegationGrantProtocol>;

export function createDelegationGrant(input: {
	readonly taskId: string;
	readonly targetNodeId: string;
	readonly targetNodeInstanceId: string;
	readonly workspaceIdentity: string;
	readonly requestHash: string;
}): DelegationGrant {
	const grant = delegationGrantSchema.parse({
		...input,
		autoApprove: ['localTerminal', 'localFileWrite'],
		neverAutoApprove: [
			'networkAuth',
			'crossWorkspaceWrite',
			'secretAccess',
			'externalPublish',
		],
	});
	Object.freeze(grant.autoApprove);
	Object.freeze(grant.neverAutoApprove);
	return Object.freeze(grant);
}

export function assertDelegationGrantBinding(
	params: NodeTaskStartParams,
	workspace: RegisteredLocalWorkspace,
): DelegationGrant {
	const grant = createDelegationGrant(delegationGrantSchema.parse(params.delegationGrant));
	const requestHash = canonicalRoutedTaskRequestHash({
		delegationRequestId: params.delegationRequestId,
		taskId: params.taskId,
		target: params.target,
		...(params.sourceNodeId === undefined ? {} : { sourceNodeId: params.sourceNodeId }),
		...(params.sourceWorkspaceIdentity === undefined
			? {}
			: { sourceWorkspaceIdentity: params.sourceWorkspaceIdentity }),
		title: params.title,
		prompt: params.prompt,
		acceptanceCriteria: [...params.acceptanceCriteria],
		...(params.timeoutMinutes === undefined ? {} : { timeoutMinutes: params.timeoutMinutes }),
		workerDeadline: params.workerDeadline,
		peerId: params.authenticatedOwnerId,
		workspaceLeaseKey: grant.workspaceIdentity,
	});
	if (
		grant.taskId !== params.taskId
		|| grant.targetNodeId !== params.target.nodeId
		|| grant.targetNodeInstanceId !== params.target.nodeInstanceId
		|| grant.workspaceIdentity !== workspace.workspaceIdentity
		|| grant.requestHash !== requestHash
	) {
		throw new Error('The delegation grant is not bound to this task route.');
	}
	return grant;
}

export async function canAutoApproveToolConfirmation(
	grant: DelegationGrant,
	taskId: string,
	workspace: RegisteredLocalWorkspace,
	request: AgentInputRequest,
): Promise<boolean> {
	const evidence = toolConfirmationEvidenceSchema.safeParse(request.confirmationEvidence);
	if (
		taskId !== grant.taskId
		|| workspace.workspaceIdentity !== grant.workspaceIdentity
		|| request.kind !== 'toolConfirmation'
		|| !evidence.success
		|| evidence.data.phase !== 'operation'
		|| !fileWriteToolNames.has(evidence.data.toolName)
		|| evidence.data.fileEdits === undefined
	) {
		return false;
	}
	try {
		const workspaceInputPath = parseFileUri(workspace.uri);
		const workspacePath = await canonicalExistingPath(workspaceInputPath);
		for (const edit of evidence.data.fileEdits) {
			const uriPaths = [
				...(edit.beforeUri === undefined
					? []
					: [{
						input: parseFileUri(edit.beforeUri),
						canonicalize: canonicalExistingPath,
					}]),
				...(edit.afterUri === undefined
					? []
					: [{
						input: parseFileUri(edit.afterUri),
						canonicalize: canonicalPotentialPath,
					}]),
			];
			for (const uriPath of uriPaths) {
				if (
					!isContained(workspaceInputPath, uriPath.input)
					|| isSensitiveWorkspacePath(workspaceInputPath, uriPath.input)
				) {
					return false;
				}
				const targetPath = await uriPath.canonicalize(uriPath.input);
				if (
					!isContained(workspacePath, targetPath)
					|| isSensitiveWorkspacePath(workspacePath, targetPath)
				) {
					return false;
				}
			}
		}
		return true;
	} catch {
		return false;
	}
}

function parseFileUri(value: string): string {
	if (
		typeof value !== 'string'
		|| encodedUnsafePath.test(value)
		|| rawDotSegment.test(value)
	) {
		throw new Error('Unsafe file URI.');
	}
	const uri = new URL(value);
	if (
		uri.protocol !== 'file:'
		|| (uri.hostname !== '' && uri.hostname !== 'localhost')
	) {
		throw new Error('Unsupported file URI.');
	}
	const filePath = fileURLToPath(uri);
	if (
		!isAbsolute(filePath)
		|| (process.platform !== 'win32' && windowsDrivePath.test(filePath))
	) {
		throw new Error('Ambiguous file path.');
	}
	return filePath;
}

async function canonicalExistingPath(filePath: string): Promise<string> {
	return realpath(filePath);
}

async function canonicalPotentialPath(filePath: string): Promise<string> {
	try {
		return await realpath(filePath);
	} catch (error: unknown) {
		if (!isMissingPath(error)) {
			throw error;
		}
		await assertDirectoryEntryAbsent(filePath);
		const inputParent = dirname(filePath);
		const parent = await realpath(inputParent);
		await assertDirectoryEntryAbsent(filePath);
		const verifiedParent = await realpath(inputParent);
		if (verifiedParent !== parent) {
			throw new Error('The target parent changed during canonicalization.');
		}
		return resolve(parent, basename(filePath));
	}
}

async function assertDirectoryEntryAbsent(filePath: string): Promise<void> {
	try {
		await lstat(filePath);
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			return;
		}
		throw error;
	}
	throw new Error('The target directory entry exists but cannot be canonicalized.');
}

function isContained(workspacePath: string, targetPath: string): boolean {
	const child = relative(workspacePath, targetPath);
	return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function isSensitiveWorkspacePath(workspacePath: string, targetPath: string): boolean {
	const relativeComponents = relative(workspacePath, targetPath).split(sep);
	const absoluteComponents = resolve(targetPath).split(sep).filter((component) => component !== '');
	return hasSensitivePathComponents(relativeComponents)
		|| hasSensitivePathComponents(absoluteComponents);
}

function hasSensitivePathComponents(rawComponents: readonly string[]): boolean {
	const components = rawComponents.map((component) => component.toLowerCase());
	return isProtectedControlPlanePath(components)
		|| rawComponents.some((component) =>
			component.normalize('NFKC') !== component
				|| component.replace(/[ .]+$/u, '') !== component
				|| /\p{Cf}/u.test(component),
		)
		|| components.some((component) =>
		component === '.ssh'
			|| component === '.aws'
			|| component === '.azure'
			|| component === '.env'
			|| component.startsWith('.env.')
			|| component === '.git-credentials'
			|| component === 'credentials'
			|| component === 'secrets',
	);
}

function isProtectedControlPlanePath(components: readonly string[]): boolean {
	for (let index = 0; index < components.length; index += 1) {
		const root = components[index];
		const second = components[index + 1];
		if (
			vcsControlRoots.has(root)
			|| vcsControlFiles.has(root)
			|| ciControlRoots.has(root)
			|| ciControlFiles.has(root)
			|| agentInstructionFiles.has(root)
			|| vcsHookConfigurationFiles.has(root)
			|| packageExecutionControlFiles.has(root)
			|| root.endsWith('.code-workspace')
			|| root === '.devcontainer'
			|| root === '.devcontainer.json'
			|| (
				root === '.github'
				&& (
					second === 'copilot-instructions.md'
					|| (second !== undefined && githubControlRoots.has(second))
				)
			)
			|| (
				root === '.vscode'
				&& second !== undefined
				&& vscodeControlFiles.has(second)
			)
		) {
			return true;
		}
	}
	return false;
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error
		&& 'code' in error
		&& (error as NodeJS.ErrnoException).code === 'ENOENT';
}
