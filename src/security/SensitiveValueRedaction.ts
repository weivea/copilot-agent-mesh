const redaction = '[redacted sensitive details]';
const minimumSensitiveValueLength = 8;
const registrations = new Map<string, number>();

export interface SensitiveValueRegistration {
	dispose(): void;
}

export function registerSensitiveValues(values: readonly string[]): SensitiveValueRegistration {
	const registered = new Set(values
		.flatMap((value) => sensitiveVariants(value))
		.filter((value) => value.length >= minimumSensitiveValueLength));
	for (const value of registered) {
		registrations.set(value, (registrations.get(value) ?? 0) + 1);
	}
	let disposed = false;
	return {
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			for (const value of registered) {
				const count = registrations.get(value);
				if (count === undefined || count <= 1) {
					registrations.delete(value);
				} else {
					registrations.set(value, count - 1);
				}
			}
		},
	};
}

export function redactRegisteredSensitiveValues(value: string): string {
	let redacted = value;
	for (const sensitive of registrations.keys()) {
		redacted = redacted.split(sensitive).join(redaction);
	}
	return redacted;
}

function sensitiveVariants(value: string): readonly string[] {
	if (value.length < minimumSensitiveValueLength) {
		return [];
	}
	const encoded = encodeURIComponent(value);
	return encoded === value
		? [value]
		: [value, encoded, encoded.toLowerCase(), encoded.toUpperCase()];
}
