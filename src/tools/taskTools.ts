import * as vscode from 'vscode';

import {
	AnswerTaskInput,
	CancelTaskInput,
	DelegateTaskInput,
	GetTaskInput,
	ListWorkersInput,
	ListTasksInput,
	serializeToolResultToTokenBudget,
	fitToolResultToByteBudget,
	parseGetTaskInput,
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
import type { TaskToolInvocationObserver } from './TaskToolInvocationObserver';
import { presentToolResult } from './ToolResultPresentation';
import { TASK_TOOL_LIMITS } from '../../shared/toolProtocol';

abstract class TaskToolBase {
	constructor(
		protected readonly facade: TaskToolFacade,
		private readonly coreOptions: TaskToolsCoreOptions = {},
		private readonly observer?: TaskToolInvocationObserver,
	) {}

	protected core(): TaskToolsCore {
		return new TaskToolsCore(this.facade, this.coreOptions);
	}

	protected observe(
		toolName: string,
		phase: 'prepared' | 'invokeStarted' | 'invokeCompleted',
		input: unknown,
		result?: ToolJsonResult,
	): void {
		try {
			this.observer?.observe({ toolName, phase, input, result });
		} catch {
			// Diagnostics must never affect Tool execution.
		}
	}

	protected async result(
		value: ToolJsonResult,
		options?: vscode.LanguageModelToolInvocationOptions<unknown>,
	): Promise<vscode.LanguageModelToolResult> {
		const tokenization = options?.tokenizationOptions;
		const presented = fitToolResultToByteBudget(
			presentToolResult(value), this.coreOptions.outputByteLimit ?? TASK_TOOL_LIMITS.defaultOutputBytes,
		);
		const serialized = tokenization === undefined
			? JSON.stringify(presented)
			: await serializeToolResultToTokenBudget(presented, tokenization.tokenBudget, tokenization.countTokens);
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

	protected unbudgetedResult(value: ToolJsonResult): vscode.LanguageModelToolResult {
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(JSON.stringify(value)),
		]);
	}
}

export class MeshListWorkersTool extends TaskToolBase implements vscode.LanguageModelTool<ListWorkersInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ListWorkersInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		this.observe(MESH_TOOL_NAMES.listWorkers, 'invokeStarted', options.input);
		let value: ToolJsonResult;
		try {
			value = await this.core().listWorkers(options.input, token);
		} catch {
			value = internalErrorValue();
		}
		this.observe(MESH_TOOL_NAMES.listWorkers, 'invokeCompleted', options.input, value);
		try {
			return await this.result(value, options);
		} catch {
			return this.internalError();
		}
	}
}

export class MeshListTasksTool extends TaskToolBase implements vscode.LanguageModelTool<ListTasksInput> {
	prepareInvocation(): vscode.PreparedToolInvocation {
		return { invocationMessage: 'Listing tasks owned by this window' };
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ListTasksInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		this.observe(MESH_TOOL_NAMES.listTasks, 'invokeStarted', options.input);
		let value: ToolJsonResult;
		try {
			value = await this.core().listTasks(options.input, token);
		} catch {
			value = internalErrorValue();
		}
		this.observe(MESH_TOOL_NAMES.listTasks, 'invokeCompleted', options.input, value);
		try {
			return await this.result(value, options);
		} catch {
			return this.internalError();
		}
	}
}

export class MeshDelegateTaskTool extends TaskToolBase implements vscode.LanguageModelTool<DelegateTaskInput> {
	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<DelegateTaskInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const preparation = await this.core().prepareDelegateInvocation(options.input, token);
		this.observe(MESH_TOOL_NAMES.delegateTask, 'prepared', options.input);
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
		this.observe(MESH_TOOL_NAMES.delegateTask, 'invokeStarted', options.input);
		let value: ToolJsonResult;
		try {
			value = await this.core().delegateTask(options.input, token);
		} catch {
			value = internalErrorValue();
		}
		this.observe(MESH_TOOL_NAMES.delegateTask, 'invokeCompleted', options.input, value);
		try {
			return await this.result(value, options);
		} catch {
			return typeof value.s === 'number'
				? this.unbudgetedResult(value)
				: this.internalError();
		}
	}
}

export class MeshGetTaskTool extends TaskToolBase implements vscode.LanguageModelTool<GetTaskInput> {
	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GetTaskInput>): vscode.PreparedToolInvocation {
		const input = parseGetTaskInput(options.input);
		return {
			invocationMessage: input.waitFor === 'snapshot' ? 'Reading Mesh task status'
				: 'Waiting for a Mesh task. Stopping this wait leaves the task running.',
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetTaskInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		this.observe(MESH_TOOL_NAMES.getTask, 'invokeStarted', options.input);
		let value: ToolJsonResult;
		try {
			value = await this.core().getTask(options.input, token);
		} catch {
			value = internalErrorValue();
		}
		this.observe(MESH_TOOL_NAMES.getTask, 'invokeCompleted', options.input, value);
		try {
			return await this.result(value, options);
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
		this.observe(MESH_TOOL_NAMES.cancelTask, 'invokeStarted', options.input);
		let value: ToolJsonResult;
		try {
			value = await this.core().cancelTask(options.input, token);
		} catch {
			value = internalErrorValue();
		}
		this.observe(MESH_TOOL_NAMES.cancelTask, 'invokeCompleted', options.input, value);
		try {
			return await this.result(value, options);
		} catch {
			return this.internalError();
		}
	}
}

export class MeshAnswerTaskTool extends TaskToolBase implements vscode.LanguageModelTool<AnswerTaskInput> {
	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AnswerTaskInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const preparation = await this.core().prepareAnswerInvocation(options.input, token);
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
		this.observe(MESH_TOOL_NAMES.answerTask, 'invokeStarted', options.input);
		let value: ToolJsonResult;
		try {
			value = await this.core().answerTask(options.input, token);
		} catch {
			value = internalErrorValue();
		}
		this.observe(MESH_TOOL_NAMES.answerTask, 'invokeCompleted', options.input, value);
		try {
			return await this.result(value, options);
		} catch {
			return this.internalError();
		}
	}
}

export interface RegisterMeshTaskToolsOptions extends TaskToolsCoreOptions {
	readonly observer?: TaskToolInvocationObserver;
}

export function registerMeshTaskTools(
	facade: TaskToolFacade,
	options: RegisterMeshTaskToolsOptions = {},
): vscode.Disposable {
	assertMeshToolNameParity(
		MESH_TOOL_MANIFEST_DESCRIPTORS.map(({ name }) => name),
		MESH_RUNTIME_TOOL_NAMES,
	);
	return vscode.Disposable.from(
		vscode.lm.registerTool(MESH_TOOL_NAMES.listWorkers, new MeshListWorkersTool(facade, options, options.observer)),
		vscode.lm.registerTool(MESH_TOOL_NAMES.listTasks, new MeshListTasksTool(facade, options, options.observer)),
		vscode.lm.registerTool(MESH_TOOL_NAMES.delegateTask, new MeshDelegateTaskTool(facade, options, options.observer)),
		vscode.lm.registerTool(MESH_TOOL_NAMES.getTask, new MeshGetTaskTool(facade, options, options.observer)),
		vscode.lm.registerTool(MESH_TOOL_NAMES.cancelTask, new MeshCancelTaskTool(facade, options, options.observer)),
		vscode.lm.registerTool(MESH_TOOL_NAMES.answerTask, new MeshAnswerTaskTool(facade, options, options.observer)),
	);
}

function internalErrorValue(): ToolJsonResult {
	return {
		status: 'error',
		error: {
			code: 'INTERNAL_ERROR',
			message: 'The mesh operation failed without a safe diagnostic.',
			retryable: false,
		},
	};
}
