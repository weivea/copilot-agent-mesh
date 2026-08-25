import type * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const sensitiveKey = /(authorization|cookie|secret|token|proof|credential|password|hmac|tkn)/iu;
const urlPattern = /\b(?:https?|wss?):\/\/[^\s"'<>]+/giu;
const posixPath = /(?:^|[\s"'(])\/(?:Users|home|var|private|Volumes)\/[^\s"')]+/gu;
const windowsPath = /\b[A-Za-z]:\\[^\s"']+/gu;

export class StructuredLogger implements vscode.Disposable {
	public constructor(private readonly output: vscode.OutputChannel) {}

	public log(
		level: LogLevel,
		category: string,
		message: string,
		fields: Readonly<Record<string, unknown>> = {},
	): void {
		const record = {
			at: new Date().toISOString(),
			level,
			category: bounded(category, 64),
			message: redactText(bounded(message, 2_048)),
			fields: redactValue(fields, 0),
		};
		this.output.appendLine(JSON.stringify(record));
	}

	public error(category: string, message: string, error?: unknown): void {
		this.log('error', category, message, {
			error: error instanceof Error
				? { name: error.name, message: error.message }
				: 'Unknown error',
		});
	}

	public dispose(): void {
		this.output.dispose();
	}
}

export function redactText(value: string): string {
	return value
		.replace(urlPattern, (candidate) => redactUrl(candidate))
		.replace(posixPath, (candidate) => `${candidate[0]?.trim().length === 0 ? candidate[0] : ''}[local-path]`)
		.replace(windowsPath, '[local-path]')
		.replace(
			/\b(authorization|cookie|secret|token|proof|credential|password|hmac|tkn)\b\s*[:=]\s*[^\s,;]+/giu,
			'$1=[redacted]',
		);
}

function redactUrl(value: string): string {
	try {
		const url = new URL(value);
		url.username = '';
		url.password = '';
		for (const key of [...url.searchParams.keys()]) {
			if (sensitiveKey.test(key)) {
				url.searchParams.set(key, '[redacted]');
			}
		}
		url.hash = url.hash.length > 0 ? '#[redacted]' : '';
		return url.toString();
	} catch {
		return '[redacted-url]';
	}
}

function redactValue(value: unknown, depth: number): unknown {
	if (depth > 5) {
		return '[bounded]';
	}
	if (typeof value === 'string') {
		return redactText(bounded(value, 2_048));
	}
	if (Array.isArray(value)) {
		return value.slice(0, 50).map((entry) => redactValue(entry, depth + 1));
	}
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value).slice(0, 50).map(([key, entry]) => [
				key,
				sensitiveKey.test(key) ? '[redacted]' : redactValue(entry, depth + 1),
			]),
		);
	}
	return typeof value === 'number' || typeof value === 'boolean' || value === null
		? value
		: String(value);
}

function bounded(value: string, max: number): string {
	return value.length <= max ? value : value.slice(0, max);
}
