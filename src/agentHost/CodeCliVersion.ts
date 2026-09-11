export interface CodeCliVersion {
	readonly version: string;
	readonly commit: string;
	readonly architecture?: string;
}

const releasePattern = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/u;
const nativeVersionPattern = new RegExp(
	`^(?:code|code-insiders|code-oss|code-exploration) (${releasePattern.source}) \\(commit ([0-9a-f]{40})\\)$`,
	'u',
);
const desktopReleasePattern = new RegExp(`^${releasePattern.source}$`, 'u');

export function parseCodeCliVersion(output: string): CodeCliVersion | undefined {
	const lines = output.trim().split(/\r?\n/u);
	if (lines.length === 1) {
		const native = nativeVersionPattern.exec(lines[0]);
		return native === null ? undefined : { version: native[1], commit: native[2] };
	}
	if (
		lines.length === 3
		&& desktopReleasePattern.test(lines[0])
		&& /^[0-9A-Za-z_-]{1,128}$/u.test(lines[1])
		&& /^[0-9A-Za-z_-]{1,32}$/u.test(lines[2])
	) {
		return { version: lines[0], commit: lines[1], architecture: lines[2] };
	}
	return undefined;
}
