import { realpath } from 'node:fs/promises';
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
		const workspacePath = await canonicalExistingPath(parseFileUri(workspace.uri));
		for (const edit of evidence.data.fileEdits) {
			const paths = [
				...(edit.beforeUri === undefined
					? []
					: [await canonicalExistingPath(parseFileUri(edit.beforeUri))]),
				...(edit.afterUri === undefined
					? []
					: [await canonicalPotentialPath(parseFileUri(edit.afterUri))]),
			];
			for (const targetPath of paths) {
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
		const parent = await realpath(dirname(filePath));
		return resolve(parent, basename(filePath));
	}
}

function isContained(workspacePath: string, targetPath: string): boolean {
	const child = relative(workspacePath, targetPath);
	return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function isSensitiveWorkspacePath(workspacePath: string, targetPath: string): boolean {
	const components = relative(workspacePath, targetPath)
		.split(sep)
		.map((component) => component.toLowerCase());
	return components.some((component) =>
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

function isMissingPath(error: unknown): boolean {
	return error instanceof Error
		&& 'code' in error
		&& (error as NodeJS.ErrnoException).code === 'ENOENT';
}
