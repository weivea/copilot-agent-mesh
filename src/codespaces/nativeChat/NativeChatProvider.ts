import type * as vscode from 'vscode';

import { uuidSchema } from '../../../shared/protocol';
import {
	NATIVE_CHAT_CANCEL_COMMAND,
	NATIVE_CHAT_PARTICIPANT, NATIVE_CHAT_TYPE,
	type NativeChatContent, type NativeChatItem,
} from './NativeChatApi';
import type { NativeChatEntry, NativeChatSession, NativeChatStore, NativeChatTurn } from './NativeChatStore';

export interface NativeChatControls {
	isLive(generation: string, taskId: string): boolean;
	cancel(generation: string, taskId: string): Promise<void>;
	readonly onDidChange: (listener: () => void) => vscode.Disposable;
}

export interface NativeChatProviderOptions {
	readonly controls: NativeChatControls;
	readonly workspaceUris: () => ReadonlySet<string>;
	readonly autoOpen: () => boolean;
	confirmCancellation(title: string): Promise<boolean>;
	reportError(error: unknown): void;
	reportActionError(error: unknown): void;
}

export class NativeChatProvider implements vscode.Disposable {
	private readonly items = new Map<string, NativeChatItem>();
	private readonly itemChanges: vscode.EventEmitter<void>;
	private readonly itemCommits: vscode.EventEmitter<{ original: NativeChatItem; modified: NativeChatItem }>;
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly visibleTurns = new Map<string, number>();
	private readonly itemStates = new Map<string, string>();
	private readonly viewers = new Set<() => void>();
	private disposed = false;
	private requests = 0;

	public constructor(
		private readonly api: typeof vscode,
		private readonly store: NativeChatStore,
		private readonly options: NativeChatProviderOptions,
	) {
		this.itemChanges = new api.EventEmitter<void>();
		this.itemCommits = new api.EventEmitter<{ original: NativeChatItem; modified: NativeChatItem }>();
		this.subscriptions.push(this.itemChanges, this.itemCommits);
		try {
			this.subscriptions.push(api.chat.registerChatSessionItemProvider(NATIVE_CHAT_TYPE, {
				onDidChangeChatSessionItems: this.itemChanges.event,
				onDidCommitChatSessionItem: this.itemCommits.event,
				provideChatSessionItems: () => [...this.items.values()],
			}));
			const participant = api.chat.createChatParticipant(NATIVE_CHAT_PARTICIPANT, async (_request, _context, stream) => {
				stream.markdown(api.l10n.t('Mesh sessions show delegated tasks. Start or continue a task with the Mesh tools in the source window.'));
			});
			participant.iconPath = new api.ThemeIcon('remote');
			this.subscriptions.push(participant);
			this.subscriptions.push(api.chat.registerChatSessionContentProvider(
				NATIVE_CHAT_TYPE, this, participant, { supportsInterruptions: false },
			));
			this.subscriptions.push(
				store.onDidChange((id) => this.update(() => this.changed(id))),
				options.controls.onDidChange(() => this.update(() => this.refresh())),
				api.commands.registerCommand(NATIVE_CHAT_CANCEL_COMMAND, (resource: unknown, taskId: unknown) =>
					this.performControl(() => this.cancel(resource, taskId))),
			);
			this.refresh();
		} catch (error: unknown) {
			this.dispose();
			throw error;
		}
	}

	public get diagnostics(): { sessions: number; contentRequests: number; activeViews: number } {
		return { sessions: this.items.size, contentRequests: this.requests, activeViews: this.viewers.size };
	}

	public resource(session: Pick<NativeChatSession, 'id'>): vscode.Uri {
		const turn = this.store.get(session.id)?.turns.at(-1);
		return this.api.Uri.from({
			scheme: NATIVE_CHAT_TYPE, path: `/${session.id}`,
			query: turn === undefined || turn.taskId === session.id ? '' : `turn=${turn.taskId}`,
		});
	}

	public async open(sessionId: string): Promise<void> {
		const session = this.requireSession(this.api.Uri.from({ scheme: NATIVE_CHAT_TYPE, path: `/${uuidSchema.parse(sessionId)}` }));
		// This pinned workbench action opens the real Chat editor without submitting a prompt.
		await this.api.commands.executeCommand('workbench.action.chat.openSessionInEditorGroup', {
			resource: this.resource(session),
		});
	}

	public provideChatSessionContent(resource: vscode.Uri): NativeChatContent {
		const session = this.requireSession(resource);
		this.requests += 1;
		const end = resource.query === '' ? 0
			: session.turns.findIndex((turn) => turn.taskId === resource.query.slice('turn='.length));
		const turns = session.turns.slice(0, end + 1);
		const last = turns.at(-1)!;
		const active = this.isActive(session, last);
		const history: (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] = [];
		for (const turn of turns) {
			const prompt = turn.acceptanceCriteria.length === 0 ? turn.prompt
				: `${turn.prompt}\n\n${this.api.l10n.t('Acceptance criteria')}:\n${turn.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`;
			history.push(new this.api.ChatRequestTurn2(
				prompt, undefined, [], NATIVE_CHAT_PARTICIPANT, [], undefined, turn.taskId, undefined, undefined,
			));
			if (turn === last && active) { continue; }
			const parts = turn.entries.map((entry) => new this.api.ChatResponseMarkdownPart(this.entryMarkdown(entry)));
			parts.push(new this.api.ChatResponseMarkdownPart(this.note(this.statusText(session, turn))));
			history.push(new this.api.ChatResponseTurn2(parts, {}, NATIVE_CHAT_PARTICIPANT));
		}
		return {
			title: session.title,
			history,
			requestHandler: undefined,
			...(active ? {
				activeResponseCallback: (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) =>
					this.stream(session.id, last.taskId, stream, token),
			} : {}),
		};
	}

	public dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		for (const detach of [...this.viewers]) { detach(); }
		for (const subscription of this.subscriptions.reverse()) { subscription.dispose(); }
		this.subscriptions.length = 0;
	}

	public refresh(): void {
		if (this.disposed) { return; }
		const sessions = this.store.list().filter((session) => this.options.workspaceUris().has(session.workspaceUri));
		const visible = new Set(sessions.map((session) => session.id));
		let changed = false;
		const commits: { original: NativeChatItem; modified: NativeChatItem }[] = [];
		for (const id of this.itemStates.keys()) {
			if (!visible.has(id)) {
				this.items.delete(id);
				this.itemStates.delete(id);
				this.visibleTurns.delete(id);
				changed = true;
			}
		}
		for (const session of sessions) {
			const turn = session.turns.at(-1)!;
			const status = this.statusCode(session, turn);
			const state = JSON.stringify([
				session.title, session.archived, turn.taskId, status, turn.status, turn.endedAt, session.turns.length,
			]);
			this.visibleTurns.set(session.id, session.turns.length);
			if (this.itemStates.get(session.id) === state) { continue; }
			const previous = this.items.get(session.id);
			const resource = this.resource(session);
			const precedingTurn = session.turns.at(-2);
			const item: NativeChatItem = {
				resource, label: session.title,
				...(precedingTurn === undefined ? {} : {
					legacyResource: this.api.Uri.from({
						scheme: NATIVE_CHAT_TYPE, path: `/${session.id}`,
						query: precedingTurn.taskId === session.id ? '' : `turn=${precedingTurn.taskId}`,
					}),
				}),
			};
			item.description = `${session.workspaceName} - ${this.statusText(session, turn)}`;
			item.tooltip = this.api.l10n.t('Mesh-owned Codespace execution. Source: {0}. Follow-up tasks keep the source Mesh authorization.', session.sourceLabel);
			item.iconPath = new this.api.ThemeIcon('remote');
			item.archived = session.archived;
			item.status = status;
			item.timing = {
				created: Date.parse(session.createdAt),
				lastRequestStarted: Date.parse(turn.startedAt),
				...(turn.endedAt === undefined ? {} : { lastRequestEnded: Date.parse(turn.endedAt) }),
			};
			this.items.set(session.id, item);
			if (previous !== undefined && previous.resource.toString() !== item.resource.toString()) {
				commits.push({ original: previous, modified: item });
			}
			this.itemStates.set(session.id, state);
			changed = true;
		}
		// The native commit event swaps the exact old Chat editor in place. The
		// controller-only API cannot invalidate a completed Chat model's content.
		for (const commit of commits) { this.itemCommits.fire(commit); }
		if (changed) { this.itemChanges.fire(); }
	}

	private changed(id: string): void {
		const session = this.store.get(id);
		const count = this.visibleTurns.get(id);
		this.refresh();
		if (session !== undefined && this.options.autoOpen() && !session.archived
			&& (count === undefined || count < session.turns.length)
			&& this.isActive(session, session.turns.at(-1)!)) {
			void this.open(id).catch(this.options.reportError);
		}
	}

	private stream(sessionId: string, taskId: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const offsets = new Map<number, number>();
			let ended = false;
			let subscription: vscode.Disposable | undefined;
			let cancellation: vscode.Disposable | undefined;
			let controls: vscode.Disposable | undefined;
			const cleanup = () => {
				if (ended) { return; }
				ended = true;
				subscription?.dispose();
				cancellation?.dispose();
				controls?.dispose();
				this.viewers.delete(detach);
			};
			const detach = () => { cleanup(); resolve(); };
			const render = () => {
				if (ended) { return; }
				try {
					const session = this.store.get(sessionId);
					const turn = session?.turns.find((candidate) => candidate.taskId === taskId);
					if (session === undefined || turn === undefined) { throw new Error('The Mesh session transcript is no longer available.'); }
					if (!this.options.workspaceUris().has(session.workspaceUri)) { detach(); return; }
					for (const entry of turn.entries) {
						const offset = offsets.get(entry.sequence);
						if (entry.kind === 'output') {
							const delta = entry.text.slice(offset ?? 0);
							if (delta) { stream.markdown(this.markdown(delta)); }
						} else if (offset === undefined) {
							if (entry.kind === 'progress' || entry.kind === 'tool') {
								stream.progress(entry.text);
							} else {
								stream.markdown(this.entryMarkdown(entry));
							}
							if (entry.kind === 'input' && entry.inputId !== undefined) {
								stream.markdown(this.note(this.api.l10n.t(
									'Answer this question with #meshAnswerTask in the source window. Native Chat observes the source-owned task.',
								)));
							}
						}
						offsets.set(entry.sequence, entry.text.length);
					}
					if (!this.isActive(session, turn)) {
						stream.markdown(this.note(this.statusText(session, turn)));
						detach();
					}
				} catch (error: unknown) {
					this.options.reportError(error);
					cleanup();
					reject(error);
				}
			};
			if (this.disposed || token.isCancellationRequested) { resolve(); return; }
			this.viewers.add(detach);
			subscription = this.store.onDidChange((id) => { if (id === sessionId) { render(); } });
			controls = this.options.controls.onDidChange(render);
			// VS Code cancels this token both on Stop and when releasing the view.
			// It only detaches this observer; the explicit Mesh command owns cancellation.
			cancellation = token.onCancellationRequested(detach);
			stream.markdown(this.note(this.api.l10n.t(
				'This view observes a Mesh task. Use Cancel Mesh task to stop execution; closing this view does not cancel it.',
			)));
			stream.button({
				title: this.api.l10n.t('Cancel Mesh task'),
				command: NATIVE_CHAT_CANCEL_COMMAND,
				arguments: [this.resource({ id: sessionId }).toString(), taskId],
			});
			render();
			if (ended) { subscription?.dispose(); controls.dispose(); cancellation.dispose(); }
		});
	}

	private requireSession(resource: vscode.Uri): NativeChatSession {
		if (this.disposed || resource.scheme !== NATIVE_CHAT_TYPE || resource.authority !== ''
			|| resource.fragment !== '' || !resource.path.startsWith('/')) {
			throw new Error('Invalid Mesh Chat session resource.');
		}
		const session = this.store.get(uuidSchema.parse(resource.path.slice(1)));
		if (session === undefined || !this.options.workspaceUris().has(session.workspaceUri)) {
			throw new Error('This Mesh Chat session does not belong to the current workspace.');
		}
		if (resource.query !== '' && (!/^turn=[0-9a-f-]{36}$/u.test(resource.query)
			|| !session.turns.some((turn) => turn.taskId === resource.query.slice('turn='.length)))) {
			throw new Error('Invalid Mesh Chat view revision.');
		}
		return session;
	}

	private liveTask(resource: unknown, taskId: unknown): { session: NativeChatSession; turn: NativeChatTurn } {
		if (typeof resource !== 'string') { throw new TypeError('A Mesh session resource is required.'); }
		const session = this.requireSession(this.api.Uri.parse(resource, true));
		const turn = session.turns.at(-1)!;
		if (turn.taskId !== uuidSchema.parse(taskId) || !this.isActive(session, turn)) {
			throw new Error('This Mesh task is no longer active in this window.');
		}
		return { session, turn };
	}

	private async cancel(resource: unknown, taskId: unknown): Promise<void> {
		const { session } = this.liveTask(resource, taskId);
		if (!await this.options.confirmCancellation(session.title)) { return; }
		const current = this.liveTask(resource, taskId);
		await this.options.controls.cancel(current.session.generation, current.turn.taskId);
	}

	private async performControl(action: () => Promise<void>): Promise<void> {
		try { await action(); } catch (error: unknown) {
			this.options.reportActionError(error);
			void this.api.window.showErrorMessage(this.api.l10n.t('The Mesh session action did not complete. See Output: Copilot Agent Mesh - Codespaces.'));
			throw error;
		}
	}

	private update(action: () => void): void {
		try { action(); } catch (error: unknown) { this.options.reportError(error); }
	}

	public async openCommand(resource: unknown): Promise<void> {
		if (typeof resource === 'string') {
			await this.open(this.requireSession(this.api.Uri.parse(resource, true)).id);
			return;
		}
		if (resource !== undefined) { throw new TypeError('Invalid Mesh session selection.'); }
		const sessions = this.store.list().filter((session) => this.options.workspaceUris().has(session.workspaceUri));
		const choice = await this.api.window.showQuickPick(sessions.map((session) => ({
			label: session.title, description: session.workspaceName, session,
		})), { title: this.api.l10n.t('Open Mesh Codespaces Session') });
		if (choice !== undefined) { await this.open(choice.session.id); }
	}

	private isActive(session: NativeChatSession, turn: NativeChatTurn): boolean {
		return !isTerminalChatTurn(turn) && this.options.controls.isLive(session.generation, turn.taskId);
	}

	private statusCode(session: NativeChatSession, turn: NativeChatTurn): number | undefined {
		if (turn.status === 'completed') { return 1; }
		if (isTerminalChatTurn(turn)) { return 0; }
		if (!this.options.controls.isLive(session.generation, turn.taskId)) { return undefined; }
		return turn.status === 'needsInput' ? 3 : 2;
	}

	private statusText(session: NativeChatSession, turn: NativeChatTurn): string {
		if (!isTerminalChatTurn(turn) && !this.options.controls.isLive(session.generation, turn.taskId)) {
			return this.api.l10n.t('Saved history; no live task is attached to this window.');
		}
		switch (turn.status) {
			case 'starting': return this.api.l10n.t('Starting Mesh task');
			case 'running': return this.api.l10n.t('Mesh task running');
			case 'needsInput': return this.api.l10n.t('Mesh task needs input');
			case 'completed': return this.api.l10n.t('Mesh task completed');
			case 'cancelled': return this.api.l10n.t('Mesh task cancelled');
			case 'failed': return this.api.l10n.t('Mesh task failed');
			case 'interrupted': return this.api.l10n.t('Execution disconnected; saved history only');
		}
	}

	private entryMarkdown(entry: NativeChatEntry): vscode.MarkdownString {
		return entry.kind === 'output' ? this.markdown(entry.text) : this.note(entry.text);
	}

	private note(text: string): vscode.MarkdownString {
		return this.markdown(`\n\n> ${new this.api.MarkdownString().appendText(text).value.replaceAll('\n', '\n> ')}\n\n`);
	}

	private markdown(text: string): vscode.MarkdownString {
		const result = new this.api.MarkdownString(text);
		result.isTrusted = { enabledCommands: [] };
		result.supportHtml = false;
		return result;
	}
}

export function isTerminalChatTurn(turn: Pick<NativeChatTurn, 'status'>): boolean {
	return turn.status === 'completed' || turn.status === 'cancelled' || turn.status === 'failed' || turn.status === 'interrupted';
}
