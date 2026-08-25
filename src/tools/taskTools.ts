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

	protected internalError(
		options?: vscode.LanguageModelToolInvocationOptions<unknown>,
	): Promise<vscode.LanguageModelToolResult> {
		return this.result({
			status: 'error',
			error: {
				code: 'INTERNAL_ERROR',
				message: 'The mesh operation failed without a safe diagnostic.',
				retryable: false,
			},
		}, options);
	}
}

export class MeshListWorkersTool extends TaskToolBase implements vscode.LanguageModelTool<EmptyInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<EmptyInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			return this.result(await this.core().listWorkers(options.input, token), options);
		} catch {
			return this.internalError(options);
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
			return this.result(await this.core().delegateTask(options.input, token), options);
		} catch {
			return this.internalError(options);
		}
	}
}

export class MeshGetTaskTool extends TaskToolBase implements vscode.LanguageModelTool<GetTaskInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetTaskInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			return this.result(await this.core().getTask(options.input, token), options);
		} catch {
			return this.internalError(options);
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
			return this.result(await this.core().cancelTask(options.input, token), options);
		} catch {
			return this.internalError(options);
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
			return this.result(await this.core().answerTask(options.input, token), options);
		} catch {
			return this.internalError(options);
		}
	}
}

export function registerMeshTaskTools(
	facade: TaskToolFacade,
	options: TaskToolsCoreOptions = {},
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
	);
}
