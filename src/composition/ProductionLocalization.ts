export type MessageArgument = string | number | boolean;
export type MessageTranslator = (message: string, ...args: MessageArgument[]) => string;

export function formatMessage(message: string, ...args: MessageArgument[]): string {
	return message.replace(/\{(\d+)\}/gu, (placeholder, index: string) => {
		const value = args[Number(index)];
		return value === undefined ? placeholder : String(value);
	});
}

export function localize(
	api: { readonly l10n?: { readonly t: MessageTranslator } },
	message: string,
	...args: MessageArgument[]
): string {
	return api.l10n?.t(message, ...args) ?? formatMessage(message, ...args);
}
