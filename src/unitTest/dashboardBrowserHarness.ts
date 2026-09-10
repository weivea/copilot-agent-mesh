import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

type BrowserEvent = {
	data?: unknown;
	key?: string;
	preventDefault(): void;
};

export class DashboardBrowserElement {
	public readonly children: DashboardBrowserElement[] = [];
	public readonly dataset: Record<string, string> = {};
	public readonly attributes: Record<string, string> = {};
	public parentElement?: DashboardBrowserElement;
	public id = '';
	public className = '';
	public type = '';
	public value = '';
	public title = '';
	public tabIndex = 0;
	public checked = false;
	public disabled = false;
	public hidden = false;
	public open = false;
	public scrollTop = 0;
	private ownText = '';
	private readonly listeners = new Map<string, Array<(event: BrowserEvent) => void>>();

	public constructor(public readonly tagName: string, private readonly onFocus: (element: DashboardBrowserElement) => void) {}

	public get textContent(): string { return [this.ownText, ...this.children.map((child) => child.textContent)].filter(Boolean).join(' '); }
	public set textContent(value: string) { this.children.length = 0; this.ownText = value; }
	public get text(): string { return this.textContent; }
	public get tag(): string { return this.tagName; }
	public get visible(): boolean {
		if (this.hidden) { return false; }
		if (!this.parentElement) { return true; }
		if (this.parentElement.tagName === 'details' && !this.parentElement.open && this.tagName !== 'summary') { return false; }
		return this.parentElement.visible;
	}

	public append(...children: DashboardBrowserElement[]): void {
		for (const child of children) {
			child.parentElement = this;
			this.children.push(child);
		}
	}
	public replaceChildren(...children: DashboardBrowserElement[]): void {
		for (const child of this.children) { child.parentElement = undefined; }
		this.children.length = 0;
		this.ownText = '';
		this.append(...children);
	}
	public setAttribute(key: string, value: string): void { this.attributes[key] = value; }
	public getAttribute(key: string): string | null { return this.attributes[key] ?? null; }
	public removeAttribute(key: string): void { delete this.attributes[key]; }
	public addEventListener(type: string, listener: (event: BrowserEvent) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
	public emit(type: string, values: Partial<BrowserEvent> = {}): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ preventDefault() {}, ...values });
		}
	}
	public dispatch(type: string, values: Partial<BrowserEvent> = {}): void { this.emit(type, values); }
	public click(): void {
		if (this.disabled) { return; }
		this.focus();
		if (this.type === 'checkbox') { this.checked = !this.checked; this.emit('change'); }
		else {
			if (this.tagName === 'summary' && this.parentElement) {
				this.parentElement.open = !this.parentElement.open;
				this.parentElement.emit('toggle');
			}
			this.emit('click');
		}
	}
	public focus(): void { this.onFocus(this); }
	public descendants(): DashboardBrowserElement[] { return [this, ...this.children.flatMap((child) => child.descendants())]; }
}

export function createDashboardBrowserHarness(language = 'en') {
	const messages: Array<Record<string, unknown>> = [];
	let activeElement: DashboardBrowserElement | undefined;
	const onFocus = (element: DashboardBrowserElement) => { activeElement = element; };
	const body = new DashboardBrowserElement('body', onFocus);
	body.dataset.uiInstanceId = 'media-view';
	body.dataset.language = language;
	const elementWithId = (tag: string, id: string) => {
		const element = new DashboardBrowserElement(tag, onFocus);
		element.id = id;
		return element;
	};
	const nav = elementWithId('nav', 'primaryNav');
	for (const [route, label] of [['overview', 'Overview'], ['history', 'Task history'], ['access', 'Devices & permissions']]) {
		const button = new DashboardBrowserElement('button', onFocus);
		button.type = 'button';
		button.dataset.route = route;
		button.textContent = label;
		nav.append(button);
	}
	const pageScroll = elementWithId('main', 'pageScroll');
	pageScroll.append(elementWithId('div', 'pageContent'));
	const helpPopover = elementWithId('aside', 'helpPopover');
	helpPopover.hidden = true;
	body.append(elementWithId('button', 'refreshButton'), nav, elementWithId('div', 'operationStatus'), pageScroll, helpPopover);
	const find = (predicate: (element: DashboardBrowserElement) => boolean) => body.descendants().filter(predicate);
	const element = (id: string) => {
		const found = find((candidate) => candidate.id === id)[0];
		if (!found) { throw new Error(`Dashboard element not found: ${id}`); }
		return found;
	};
	const documentListeners = new Map<string, (event: BrowserEvent) => void>();
	let receive: ((event: BrowserEvent) => void) | undefined;
	const browserWindow: Record<string, unknown> = {
		addEventListener: (name: string, listener: (event: BrowserEvent) => void) => {
			if (name !== 'message') { throw new Error(`Unexpected window event: ${name}`); }
			receive = listener;
		},
	};
	const context = {
		TextEncoder,
		document: {
			body,
			get activeElement() { return activeElement; },
			getElementById: element,
			createElement: (tag: string) => new DashboardBrowserElement(tag, onFocus),
			addEventListener: (name: string, listener: (event: BrowserEvent) => void) => { documentListeners.set(name, listener); },
		},
		window: browserWindow,
		acquireVsCodeApi: () => ({
			postMessage: (message: Record<string, unknown>) => { messages.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>); },
		}),
	};
	const root = resolve(__dirname, '../../..');
	for (const file of ['dashboard.l10n.js', 'dashboard.js']) {
		runInNewContext(readFileSync(resolve(root, 'media', file), 'utf8'), context, { filename: file });
	}
	const send = (message: unknown) => {
		if (!receive) { throw new Error('Dashboard message listener was not installed.'); }
		receive({ data: message, preventDefault() {} });
	};
	return {
		messages, element, find, body,
		get activeElement() { return activeElement; },
		render(model: unknown, pendingActions: string[] = []) {
			send({ version: 10, uiInstanceId: 'media-view', type: 'dashboard.snapshot', model, pendingActions });
		},
		send,
		keydown(key: string) { documentListeners.get('keydown')?.({ key, preventDefault() {} }); },
		button(label: string) {
			const match = find((candidate) => candidate.tagName === 'button' && candidate.textContent === label)[0];
			if (!match) { throw new Error(`Dashboard button not found: ${label}`); }
			return match;
		},
		control(key: string) {
			const match = find((candidate) => candidate.dataset.focusKey === key)[0];
			if (!match) { throw new Error(`Dashboard control not found: ${key}`); }
			return match;
		},
	};
}
