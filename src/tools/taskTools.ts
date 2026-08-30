import * as vscode from 'vscode';

import {
	AnswerTaskInput,
	CancelTaskInput,
	DelegateTaskInput,
	GetTaskInput,
	serializeToolResultToTokenBudget,
	TaskToolsCore,
	TaskToolsCoreOptions,
	ToolJsonResult,
} from './taskToolsCore';
import { TaskToolFacade } from './taskToolFacade';
import {
	CollaborationToolsCore,
	type CollaborationToolsCoreOptions,
} from './collaborationToolsCore';
import type { CollaborationToolFacade } from './collaborationToolFacade';
import type { StartCollaborationToolInput } from '../../shared/toolProtocol';
import {
	assertMeshToolNameParity,
	MESH_RUNTIME_TOOL_NAMES,
	MESH_TOOL_MANIFEST_DESCRIPTORS,
	MESH_TOOL_NAMES,
} from './toolManifest';

type EmptyInput = Record<string, never>;

abstract class TaskToolBase {
	constructor(
		protected readonly facade: TaskToolFacade,
		private readonly coreOptions: TaskToolsCoreOptions = {},
	) {}

	protected core(): TaskToolsCore {
		return new TaskToolsCore(this.facade, this.coreOptions);
	}

	protected async result(
		value: ToolJsonResult,
		options?: vscode.LanguageModelToolInvocationOptions<unknown>,
	): Promise<vscode.LanguageModelToolResult> {
		const tokenization = options?.tokenizationOptions;
		const serialized = tokenization === undefined
			? JSON.stringify(value)
			: await serializeToolResultToTokenBudget(value, tokenization.tokenBudget, tokenization.countTokens);
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(serialized),
		]);
	}

	protected internalError(): vscode.LanguageModelToolResult {
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(JSON.stringify({
				status: 'error',
				error: {
					code: 'INTERNAL_ERROR',
					message: 'The mesh operation failed without a safe diagnostic.',
					retryable: false,
				},
			})),
		]);
	}
}

export class MeshListWorkersTool extends TaskToolBase implements vscode.LanguageModelTool<EmptyInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<EmptyInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			return await this.result(await this.core().listWorkers(options.input, token), options);
		} catch {
			return this.internalError();
		}
	}
}

export class MeshDelegateTaskTool extends TaskToolBase implements vscode.LanguageModelTool<DelegateTaskInput> {
	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<DelegateTaskInput>,
		_token: vscode.CancellationToken,
	): vscode.PreparedToolInvocation {
		const preparation = this.core().prepareDelegateInvocation(options.input);
		return {
			invocationMessage: preparation.invocationMessage,
			confirmationMessages: {
				title: preparation.confirmationTitle,
				message: preparation.confirmationMessage,
			},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<DelegateTaskInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			return await this.result(await this.core().delegateTask(options.input, token), options);
		} catch {
			return this.internalError();
		}
	}
}

export class MeshGetTaskTool extends TaskToolBase implements vscode.LanguageModelTool<GetTaskInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetTaskInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			return await this.result(await this.core().getTask(options.input, token), options);
		} catch {
			return this.internalError();
		}
	}
}

export class MeshCancelTaskTool extends TaskToolBase implements vscode.LanguageModelTool<CancelTaskInput> {
	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CancelTaskInput>,
		_token: vscode.CancellationToken,
	): vscode.PreparedToolInvocation {
		const preparation = this.core().prepareCancelInvocation(options.input);
		return {
			invocationMessage: preparation.invocationMessage,
			confirmationMessages: {
				title: preparation.confirmationTitle,
				message: preparation.confirmationMessage,
			},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CancelTaskInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			return await this.result(await this.core().cancelTask(options.input, token), options);
		} catch {
			return this.internalError();
		}
	}
}

export class MeshAnswerTaskTool extends TaskToolBase implements vscode.LanguageModelTool<AnswerTaskInput> {
	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AnswerTaskInput>,
		_token: vscode.CancellationToken,
	): vscode.PreparedToolInvocation {
		const preparation = this.core().prepareAnswerInvocation(options.input);
		return {
			invocationMessage: preparation.invocationMessage,
			confirmationMessages: {
				title: preparation.confirmationTitle,
				message: preparation.confirmationMessage,
			},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AnswerTaskInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			return await this.result(await this.core().answerTask(options.input, token), options);
		} catch {
			return this.internalError();
		}
	}
}

type CollaborationRunInput = { readonly runId: string };

abstract class CollaborationToolBase {
	constructor(
		protected readonly facade: CollaborationToolFacade,
		private readonly coreOptions: CollaborationToolsCoreOptions = {},
	) {}

	protected core(): CollaborationToolsCore {
		return new CollaborationToolsCore(this.facade, this.coreOptions);
	}

	protected async result(
		value: ToolJsonResult,
		options?: vscode.LanguageModelToolInvocationOptions<unknown>,
	): Promise<vscode.LanguageModelToolResult> {
		const tokenization = options?.tokenizationOptions;
		const serialized = tokenization === undefined
			? JSON.stringify(value)
			: await serializeToolResultToTokenBudget(
				value,
				tokenization.tokenBudget,
				tokenization.countTokens,
			);
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(serialized),
		]);
	}

	protected internalError(): vscode.LanguageModelToolResult {
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(JSON.stringify({
				status: 'error',
				error: {
					code: 'INTERNAL_ERROR',
					message: 'The mesh operation failed without a safe diagnostic.',
					retryable: false,
				},
			})),
		]);
	}
}

export class MeshStartCollaborationTool extends CollaborationToolBase
	implements vscode.LanguageModelTool<StartCollaborationToolInput> {
	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<StartCollaborationToolInput>,
		_token: vscode.CancellationToken,
	): vscode.PreparedToolInvocation {
		const preparation = this.core().prepareStartInvocation(options.input);
		return {
			invocationMessage: preparation.invocationMessage,
			confirmationMessages: {
				title: preparation.confirmationTitle,
				message: preparation.confirmationMessage,
			},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<StartCollaborationToolInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			return await this.result(await this.core().start(options.input, token), options);
		} catch {
			return this.internalError();
		}
	}
}

export class MeshGetCollaborationTool extends CollaborationToolBase
	implements vscode.LanguageModelTool<CollaborationRunInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CollaborationRunInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			return await this.result(await this.core().get(options.input, token), options);
		} catch {
			return this.internalError();
		}
	}
}

export class MeshCancelCollaborationTool extends CollaborationToolBase
	implements vscode.LanguageModelTool<CollaborationRunInput> {
	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CollaborationRunInput>,
		_token: vscode.CancellationToken,
	): vscode.PreparedToolInvocation {
		const preparation = this.core().prepareCancelInvocation(options.input);
		return {
			invocationMessage: preparation.invocationMessage,
			confirmationMessages: {
				title: preparation.confirmationTitle,
				message: preparation.confirmationMessage,
			},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CollaborationRunInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			return await this.result(await this.core().cancel(options.input, token), options);
		} catch {
			return this.internalError();
		}
	}
}

export function registerMeshTaskTools(
	facade: TaskToolFacade,
	collaborations: CollaborationToolFacade,
	options: TaskToolsCoreOptions = {},
	collaborationOptions: CollaborationToolsCoreOptions = {},
): vscode.Disposable {
	assertMeshToolNameParity(
		MESH_TOOL_MANIFEST_DESCRIPTORS.map(({ name }) => name),
		MESH_RUNTIME_TOOL_NAMES,
	);
	return vscode.Disposable.from(
		vscode.lm.registerTool(MESH_TOOL_NAMES.listWorkers, new MeshListWorkersTool(facade, options)),
		vscode.lm.registerTool(MESH_TOOL_NAMES.delegateTask, new MeshDelegateTaskTool(facade, options)),
		vscode.lm.registerTool(MESH_TOOL_NAMES.getTask, new MeshGetTaskTool(facade, options)),
		vscode.lm.registerTool(MESH_TOOL_NAMES.cancelTask, new MeshCancelTaskTool(facade, options)),
		vscode.lm.registerTool(MESH_TOOL_NAMES.answerTask, new MeshAnswerTaskTool(facade, options)),
		vscode.lm.registerTool(
			MESH_TOOL_NAMES.startCollaboration,
			new MeshStartCollaborationTool(collaborations, collaborationOptions),
		),
		vscode.lm.registerTool(
			MESH_TOOL_NAMES.getCollaboration,
			new MeshGetCollaborationTool(collaborations, collaborationOptions),
		),
		vscode.lm.registerTool(
			MESH_TOOL_NAMES.cancelCollaboration,
			new MeshCancelCollaborationTool(collaborations, collaborationOptions),
		),
	);
}
