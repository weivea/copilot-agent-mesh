export function redactRemoteText(value: string): string {
	return containsUnsafeDashboardText(value) ? '[redacted sensitive details]' : value;
}

export function containsUnsafeDashboardText(value: string): boolean {
	const lower = decodePercentEncoding(value).toLowerCase();
	if (
		lower.includes('file://')
		|| lower.includes('secret=')
		|| lower.includes('secret:')
		|| lower.includes('token=')
		|| lower.includes('token:')
		|| lower.includes('credential=')
		|| lower.includes('credential:')
		|| lower.includes('password=')
		|| lower.includes('password:')
		|| lower.includes('api_key=')
		|| lower.includes('api-key=')
		|| lower.includes('bearer ')
		|| lower.includes('ghp_')
		|| lower.includes('github_pat_')
	) {
		return true;
	}
	return lexicalTokens(lower).some(isPathToken);
}

function lexicalTokens(value: string): string[] {
	const tokens: string[] = [];
	let current = '';
	for (const character of value) {
		if (isBoundary(character)) {
			pushToken(tokens, current);
			current = '';
		} else {
			current += character;
		}
	}
	pushToken(tokens, current);
	return tokens;
}

function pushToken(tokens: string[], candidate: string): void {
	let end = candidate.length;
	while (end > 0 && isTrailingPunctuation(candidate[end - 1])) {
		end -= 1;
	}
	if (end > 0) {
		tokens.push(candidate.slice(0, end));
	}
}

function isPathToken(token: string): boolean {
	if (token.startsWith('/') || token.startsWith('\\\\')) {
		return true;
	}
	if (
		token.length >= 3
		&& isAsciiLetter(token[0])
		&& token[1] === ':'
		&& isSeparator(token[2])
	) {
		return true;
	}
	if (!token.includes('/') && !token.includes('\\')) {
		return false;
	}
	if (token.includes('://')) {
		return false;
	}
	return splitPathSegments(token).length >= 2;
}

function splitPathSegments(token: string): string[] {
	const segments: string[] = [];
	let segment = '';
	for (const character of token) {
		if (isSeparator(character)) {
			if (segment.length > 0) {
				segments.push(segment);
				segment = '';
			}
		} else {
			segment += character;
		}
	}
	if (segment.length > 0) {
		segments.push(segment);
	}
	return segments;
}

function isBoundary(character: string): boolean {
	return /\s/.test(character) || '"\'`()[]{}<>,;='.includes(character);
}

function isTrailingPunctuation(character: string): boolean {
	return '.,:;!?)]}'.includes(character);
}

function isSeparator(character: string): boolean {
	return character === '/' || character === '\\';
}

function isAsciiLetter(character: string): boolean {
	const code = character.charCodeAt(0);
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function decodePercentEncoding(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
