import type {
	ActionEnvelope,
	StateAction,
} from '@microsoft/agent-host-protocol' with { 'resolution-mode': 'import' };

import {
	AgentRuntimeError,
	type AgentInputRequest,
	type AgentInputValue,
	type AgentRuntimeEvent,
	type AgentTaskAnswer,
} from './AgentRuntime';
import type { ProtectedResource } from './AuthBroker';

type PendingInput =
	| {
		readonly kind: 'chatInput';
		readonly chatUri: string;
		readonly requestId: string;
		readonly questions: readonly Question[];
	}
	| {
		readonly kind: 'toolConfirmation';
		readonly chatUri: string;
		readonly turnId: string;
		readonly toolCallId: string;
		readonly resultConfirmation: boolean;
	}
	| {
		readonly kind: 'toolAuthentication';
		readonly chatUri: string;
		readonly turnId: string;
		readonly toolCallId: string;
		readonly resource: ProtectedResource;
	};

interface Question {
	readonly id: string;
	readonly prompt: string;
	readonly required: boolean;
	readonly kind: string;
	readonly options?: readonly { readonly id: string; readonly label: string }[];
	readonly allowFreeformInput?: boolean;
	readonly min?: number;
	readonly max?: number;
	readonly defaultValue?: string | number | boolean;
}

export type AnswerDispatch =
	| { readonly channel: string; readonly action: unknown }
	| { readonly authentication: ProtectedResource; readonly requestId: string };

export class AhpEventMapper {
	private readonly pending = new Map<string, PendingInput>();

	constructor(private readonly maxTextLength = 16_384) {}

	map(envelope: ActionEnvelope): readonly AgentRuntimeEvent[] {
		if (envelope.rejectionReason !== undefined) {
			return [{
				type: 'failed',
				error: new AgentRuntimeError(
					'TASK_EXECUTION_FAILED',
					`The Agent Host rejected an action: ${bounded(envelope.rejectionReason, 512)}.`,
				),
			}];
		}

		const action = envelope.action;
		switch (action.type) {
			case 'chat/delta':
				return [{ type: 'output', text: bounded(action.content, this.maxTextLength) }];
			case 'chat/reasoning':
				return [{ type: 'progress', message: bounded(action.content, this.maxTextLength) }];
			case 'chat/responsePart':
				return mapResponsePart(action.part, this.maxTextLength);
			case 'chat/activityChanged':
				return action.activity === undefined
					? []
					: [{ type: 'progress', message: bounded(action.activity, 1_024) }];
			case 'chat/toolCallStart':
				return [{
					type: 'tool',
					name: bounded(action.displayName, 256),
					status: 'started',
					summary: optionalText(action.intention, 1_024),
				}];
			case 'chat/toolCallDelta':
				return [{
					type: 'tool',
					name: action.toolCallId,
					status: 'running',
					summary: optionalText(action.invocationMessage ?? action.content, 1_024),
				}];
			case 'chat/toolCallReady':
				return this.mapToolReady(envelope.channel, action);
			case 'chat/toolCallComplete':
				if (action.requiresResultConfirmation === true) {
					const requestId = `tool-result:${action.turnId}:${action.toolCallId}`;
					this.pending.set(requestId, {
						kind: 'toolConfirmation',
						chatUri: envelope.channel,
						turnId: action.turnId,
						toolCallId: action.toolCallId,
						resultConfirmation: true,
					});
					return [{
						type: 'inputRequired',
						request: {
							requestId,
							kind: 'toolConfirmation',
							prompt: 'Approve the tool result?',
						},
					}];
				}
				return [{
					type: 'tool',
					name: action.toolCallId,
					status: action.result.success ? 'completed' : 'failed',
				}];
			case 'chat/toolCallAuthRequired':
				return this.mapToolAuthentication(envelope.channel, action);
			case 'chat/inputRequested':
				return this.mapChatInput(envelope.channel, action.request);
			case 'chat/turnComplete':
				return [{ type: 'completed' }];
			case 'chat/turnCancelled':
				return [{ type: 'cancelled' }];
			case 'chat/error':
				return [{
					type: 'failed',
					error: new AgentRuntimeError(
						'TASK_EXECUTION_FAILED',
						bounded(action.error.message, 2_048),
					),
				}];
			case 'terminal/data':
				return [{
					type: 'terminal',
					summary: bounded(stripTerminalControl(action.data), 2_048),
				}];
			case 'terminal/commandExecuted':
				return [{
					type: 'terminal',
					summary: `Command started: ${bounded(action.commandLine, 512)}`,
				}];
			case 'terminal/commandFinished':
				return [{
					type: 'terminal',
					summary: `Command finished${action.exitCode === undefined ? '' : ` with exit code ${action.exitCode}`}.`,
				}];
			default:
				return [];
		}
	}

	createAnswer(answer: AgentTaskAnswer): AnswerDispatch {
		const pending = this.pending.get(answer.requestId);
		if (pending === undefined) {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The requested Agent Host input is no longer pending.');
		}

		if (pending.kind === 'toolAuthentication') {
			if (answer.outcome !== 'accept') {
				this.pending.delete(answer.requestId);
				return {
					channel: pending.chatUri,
					action: {
						type: 'chat/toolCallComplete',
						turnId: pending.turnId,
						toolCallId: pending.toolCallId,
						result: { success: false, content: [] },
					},
				};
			}
			return { authentication: pending.resource, requestId: answer.requestId };
		}

		if (pending.kind === 'toolConfirmation') {
			this.pending.delete(answer.requestId);
			if (pending.resultConfirmation) {
				return {
					channel: pending.chatUri,
					action: {
						type: 'chat/toolCallResultConfirmed',
						turnId: pending.turnId,
						toolCallId: pending.toolCallId,
						approved: answer.outcome === 'accept',
					},
				};
			}
			return {
				channel: pending.chatUri,
				action: answer.outcome === 'accept'
					? {
						type: 'chat/toolCallConfirmed',
						turnId: pending.turnId,
						toolCallId: pending.toolCallId,
						approved: true,
						confirmed: 'user-action',
						selectedOptionId: answer.selectedOptionId,
					}
					: {
						type: 'chat/toolCallConfirmed',
						turnId: pending.turnId,
						toolCallId: pending.toolCallId,
						approved: false,
						reason: answer.outcome === 'decline' ? 'denied' : 'skipped',
						reasonMessage: answer.reason,
						selectedOptionId: answer.selectedOptionId,
					},
			};
		}

		const answers = answer.outcome === 'accept'
			? validateAnswers(pending.questions, answer.values ?? {})
			: undefined;
		this.pending.delete(answer.requestId);
		return {
			channel: pending.chatUri,
			action: {
				type: 'chat/inputCompleted',
				requestId: pending.requestId,
				response: answer.outcome,
				answers,
			},
		};
	}

	completeAuthentication(requestId: string): void {
		const pending = this.pending.get(requestId);
		if (pending?.kind === 'toolAuthentication') {
			this.pending.delete(requestId);
		}
	}

	private mapToolReady(
		chatUri: string,
		action: Extract<StateAction, { type: 'chat/toolCallReady' }>,
	): readonly AgentRuntimeEvent[] {
		if (action.confirmed !== undefined) {
			return [{
				type: 'tool',
				name: action.toolCallId,
				status: 'running',
				summary: optionalText(action.invocationMessage, 1_024),
			}];
		}
		const requestId = `tool:${action.turnId}:${action.toolCallId}`;
		this.pending.set(requestId, {
			kind: 'toolConfirmation',
			chatUri,
			turnId: action.turnId,
			toolCallId: action.toolCallId,
			resultConfirmation: false,
		});
		return [{
			type: 'inputRequired',
			request: {
				requestId,
				kind: 'toolConfirmation',
				prompt: optionalText(action.confirmationTitle ?? action.invocationMessage, 1_024) ?? 'Approve tool call?',
				options: action.options?.map((option) => ({
					id: option.id,
					label: bounded(option.label, 256),
					approve: option.kind === 'approve',
				})),
			},
		}];
	}

	private mapToolAuthentication(
		chatUri: string,
		action: Extract<StateAction, { type: 'chat/toolCallAuthRequired' }>,
	): readonly AgentRuntimeEvent[] {
		const requestId = `auth:${action.turnId}:${action.toolCallId}`;
		const resource: ProtectedResource = {
			resource: action.auth.resource.resource,
			resource_name: action.auth.resource.resource_name,
			authorization_servers: action.auth.resource.authorization_servers,
			scopes_supported: action.auth.requiredScopes ?? action.auth.resource.scopes_supported,
			required: true,
		};
		this.pending.set(requestId, {
			kind: 'toolAuthentication',
			chatUri,
			turnId: action.turnId,
			toolCallId: action.toolCallId,
			resource,
		});
		return [{
			type: 'inputRequired',
			request: {
				requestId,
				kind: 'toolAuthentication',
				prompt: `Authentication is required for ${resource.resource_name ?? new URL(resource.resource).origin}.`,
			},
		}];
	}

	private mapChatInput(chatUri: string, request: {
		readonly id: string;
		readonly message?: string;
		readonly questions?: readonly unknown[];
	}): readonly AgentRuntimeEvent[] {
		const questions = (request.questions ?? []).map(parseQuestion);
		this.pending.set(request.id, {
			kind: 'chatInput',
			chatUri,
			requestId: request.id,
			questions,
		});
		const mapped: AgentInputRequest = {
			requestId: request.id,
			kind: 'chatInput',
			prompt: bounded(request.message ?? 'The agent requires input.', 1_024),
			fields: questions.map((question) => ({
				id: question.id,
				prompt: question.prompt,
				required: question.required,
				type: mapQuestionKind(question.kind),
				options: question.options,
				allowFreeformInput: question.allowFreeformInput,
				min: question.min,
				max: question.max,
				defaultValue: question.defaultValue,
			})),
		};
		return [{ type: 'inputRequired', request: mapped }];
	}
}

function mapResponsePart(part: unknown, maxLength: number): readonly AgentRuntimeEvent[] {
	if (!isRecord(part)) {
		return [];
	}
	if ((part.kind === 'markdown' || part.kind === 'systemNotification') && typeof part.content !== 'undefined') {
		return [{ type: 'output', text: bounded(stringOrMarkdown(part.content), maxLength) }];
	}
	if (part.kind === 'reasoning' && typeof part.content === 'string') {
		return [{ type: 'progress', message: bounded(part.content, maxLength) }];
	}
	return [];
}

function parseQuestion(value: unknown): Question {
	if (!isRecord(value) || typeof value.id !== 'string') {
		throw new AgentRuntimeError('TASK_EXECUTION_FAILED', 'The Agent Host returned an invalid input question.');
	}
	const prompt = typeof value.message === 'string'
		? value.message
		: typeof value.title === 'string'
			? value.title
			: typeof value.prompt === 'string'
				? value.prompt
				: typeof value.label === 'string'
					? value.label
					: value.id;
	const options = Array.isArray(value.options)
		? value.options.flatMap((option) =>
			isRecord(option) && typeof option.id === 'string' && typeof option.label === 'string'
				? [{ id: option.id, label: bounded(option.label, 256) }]
				: [],
		)
		: undefined;
	return {
		id: value.id,
		prompt: bounded(prompt, 1_024),
		required: value.required === true,
		kind: typeof value.kind === 'string' ? value.kind : 'text',
		options,
		allowFreeformInput: value.allowFreeformInput === true,
		min: typeof value.min === 'number' ? value.min : undefined,
		max: typeof value.max === 'number' ? value.max : undefined,
		defaultValue: typeof value.defaultValue === 'string'
			|| typeof value.defaultValue === 'number'
			|| typeof value.defaultValue === 'boolean'
			? value.defaultValue
			: undefined,
	};
}

function validateAnswers(
	questions: readonly Question[],
	values: Readonly<Record<string, AgentInputValue>>,
): Record<string, {
	readonly state: 'submitted';
	readonly value: {
		readonly kind: 'text' | 'number' | 'boolean' | 'selected' | 'selected-many';
		readonly value: string | number | boolean | readonly string[];
		readonly freeformValues?: readonly string[];
	};
}> {
	const result: Record<string, {
		state: 'submitted';
		value: {
			kind: 'text' | 'number' | 'boolean' | 'selected' | 'selected-many';
			value: string | number | boolean | readonly string[];
			freeformValues?: readonly string[];
		};
	}> = {};
	for (const question of questions) {
		const value = values[question.id];
		if (value === undefined) {
			if (question.required) {
				throw new AgentRuntimeError('TASK_EXECUTION_FAILED', `A required answer is missing for "${question.id}".`);
			}
			continue;
		}
		const kind = mapAnswerKind(question.kind);
		if (!answerMatches(question, kind, value)) {
			throw new AgentRuntimeError('TASK_EXECUTION_FAILED', `The answer for "${question.id}" has the wrong type.`);
		}
		const normalized = normalizeAnswerValue(kind, value);
		result[question.id] = { state: 'submitted', value: { kind, ...normalized } };
	}
	return result;
}

function mapQuestionKind(kind: string): 'string' | 'number' | 'integer' | 'boolean' | 'singleSelect' | 'multiSelect' {
	switch (kind) {
		case 'number':
			return 'number';
		case 'integer':
			return 'integer';
		case 'boolean':
			return 'boolean';
		case 'single-select':
			return 'singleSelect';
		case 'multi-select':
			return 'multiSelect';
		default:
			return 'string';
	}
}

function mapAnswerKind(kind: string): 'text' | 'number' | 'boolean' | 'selected' | 'selected-many' {
	switch (kind) {
		case 'number':
		case 'integer':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'single-select':
			return 'selected';
		case 'multi-select':
			return 'selected-many';
		default:
			return 'text';
	}
}

function answerMatches(question: Question, kind: string, value: AgentInputValue): boolean {
	const normalized = normalizeAnswerValue(kind, value);
	if (question.kind === 'integer' && (typeof normalized.value !== 'number' || !Number.isInteger(normalized.value))) {
		return false;
	}
	if (typeof normalized.value === 'number'
		&& ((question.min !== undefined && normalized.value < question.min)
			|| (question.max !== undefined && normalized.value > question.max))) {
		return false;
	}
	if (Array.isArray(normalized.value)
		&& ((question.min !== undefined && normalized.value.length < question.min)
			|| (question.max !== undefined && normalized.value.length > question.max))) {
		return false;
	}
	if (normalized.freeformValues !== undefined && !question.allowFreeformInput) {
		return false;
	}
	switch (kind) {
		case 'number':
			return typeof normalized.value === 'number';
		case 'boolean':
			return typeof normalized.value === 'boolean';
		case 'selected-many':
			return Array.isArray(normalized.value) && normalized.value.every((item) => typeof item === 'string');
		default:
			return typeof normalized.value === 'string';
	}
}

function normalizeAnswerValue(
	kind: string,
	value: AgentInputValue,
): { value: string | number | boolean | readonly string[]; freeformValues?: readonly string[] } {
	if (isFreeformAnswer(value)) {
		const selected = value.selected ?? (kind === 'selected-many' ? [] : '');
		return {
			value: selected,
			freeformValues: value.freeformValues.filter((item): item is string => typeof item === 'string'),
		};
	}
	return { value };
}

function isFreeformAnswer(value: AgentInputValue): value is Extract<AgentInputValue, { readonly freeformValues: readonly string[] }> {
	return isRecord(value)
		&& Array.isArray(value.freeformValues)
		&& value.freeformValues.every((item) => typeof item === 'string');
}

function optionalText(value: unknown, limit: number): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return bounded(stringOrMarkdown(value), limit);
}

function stringOrMarkdown(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	return isRecord(value) && typeof value.markdown === 'string' ? value.markdown : '';
}

function bounded(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function stripTerminalControl(value: string): string {
	return value
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
