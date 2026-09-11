import type * as vscode from 'vscode';
import { z } from 'zod';

export const NATIVE_CHAT_TYPE = 'agent-mesh-codespaces';
export const NATIVE_CHAT_PARTICIPANT = 'weivea.copilot-agent-mesh-codespaces.session';
export const NATIVE_CHAT_OPEN_COMMAND = 'copilotAgentMesh.codespaces.openSession';
export const NATIVE_CHAT_CANCEL_COMMAND = 'copilotAgentMesh.codespaces.cancelSessionTask';
export const NATIVE_CHAT_STATUS_COMMAND = 'copilotAgentMesh.codespaces.nativeChatStatus';
export const NATIVE_CHAT_HELP_COMMAND = 'copilotAgentMesh.codespaces.nativeChatHelp';
export const NATIVE_CHAT_EXTENSION_ID = 'weivea.copilot-agent-mesh-codespaces';
export const NATIVE_CHAT_PROPOSALS = ['chatSessionsProvider', 'chatParticipantPrivate'] as const;

export const nativeChatStatusSchema = z.strictObject({
	state: z.enum(['enabled', 'disabled', 'apiUnavailable', 'permissionRequired', 'initializationFailed', 'unsupportedEnvironment']),
});
export type NativeChatStatus = z.infer<typeof nativeChatStatusSchema>;

export interface NativeChatItem {
	readonly resource: vscode.Uri;
	label: string;
	description?: string | vscode.MarkdownString;
	tooltip?: string | vscode.MarkdownString;
	iconPath?: vscode.ThemeIcon;
	status?: number;
	archived?: boolean;
	readonly legacyResource?: vscode.Uri;
	timing?: { created: number; lastRequestStarted?: number; lastRequestEnded?: number };
}

export interface NativeChatContent {
	readonly title: string;
	readonly history: readonly (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[];
	readonly requestHandler: vscode.ChatRequestHandler | undefined;
	readonly activeResponseCallback?: (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => Promise<void>;
}

// Deliberately small subset of the proposals pinned to VS Code 1.137.0,
// commit 645f29cc3176500b4b5762ba887cf2a7f0ffdf2c. No private database access.
declare module 'vscode' {
	export class ChatRequestTurn2 {
		readonly prompt: string;
		readonly participant: string;
		readonly command: string | undefined;
		readonly references: readonly ChatPromptReference[];
		readonly toolReferences: readonly ChatLanguageModelToolReference[];
		readonly id?: string;
		constructor(
			prompt: string, command: string | undefined, references: ChatPromptReference[],
			participant: string, toolReferences: ChatLanguageModelToolReference[],
			editedFileEvents: undefined, id: string | undefined,
			modelId: undefined, modeInstructions2: undefined,
		);
	}

	export class ChatResponseTurn2 {
		readonly response: readonly (ChatResponseMarkdownPart | ChatResponseCommandButtonPart)[];
		readonly result: ChatResult;
		readonly participant: string;
		constructor(
			response: readonly (ChatResponseMarkdownPart | ChatResponseCommandButtonPart)[],
			result: ChatResult, participant: string,
		);
	}

	export namespace chat {
		function registerChatSessionItemProvider(
			type: string,
			provider: {
				readonly onDidChangeChatSessionItems: Event<void>;
				readonly onDidCommitChatSessionItem: Event<{ original: NativeChatItem; modified: NativeChatItem }>;
				provideChatSessionItems(token: CancellationToken): NativeChatItem[] | Promise<NativeChatItem[]>;
			},
		): Disposable;
		function registerChatSessionContentProvider(
			scheme: string,
			provider: { provideChatSessionContent(resource: Uri, token: CancellationToken): NativeChatContent | Promise<NativeChatContent> },
			participant: ChatParticipant,
			capabilities?: { supportsInterruptions?: boolean },
		): Disposable;
	}
}

export function hasNativeChatApi(api: typeof vscode): boolean {
	return typeof api.chat?.registerChatSessionItemProvider === 'function'
		&& typeof api.chat.registerChatSessionContentProvider === 'function'
		&& typeof api.ChatRequestTurn2 === 'function'
		&& typeof api.ChatResponseTurn2 === 'function';
}
