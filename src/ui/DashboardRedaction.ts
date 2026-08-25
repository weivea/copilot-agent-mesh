const maximumCanonicalLength = 4096;
const maximumDecodeRounds = 4;
const credentialKeys = [
	'authorization',
	'credential',
	'password',
	'secret',
	'tkn',
	'token',
] as const;

export function redactRemoteText(value: string): string {
	return containsUnsafeDashboardText(value) ? '[redacted sensitive details]' : value;
}

export function containsUnsafeDashboardText(value: string): boolean {
	const canonical = canonicalizePercentEncoding(value);
	if (canonical === undefined) {
		return true;
	}
	const lower = canonical.toLowerCase();
	if (
		lower.includes('file://')
		|| lower.includes('api_key=')
		|| lower.includes('api-key=')
		|| lower.includes('bearer ')
		|| lower.includes('ghp_')
		|| lower.includes('github_pat_')
		|| containsCredentialAssignment(lower)
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

function canonicalizePercentEncoding(value: string): string | undefined {
	if (value.length > maximumCanonicalLength) {
		return undefined;
	}
	let canonical = value;
	for (let round = 0; round < maximumDecodeRounds && canonical.includes('%'); round += 1) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(canonical);
		} catch {
			return undefined;
		}
		if (decoded.length > maximumCanonicalLength) {
			return undefined;
		}
		if (decoded === canonical) {
			return canonical;
		}
		canonical = decoded;
	}
	return canonical.includes('%') ? undefined : canonical;
}

function containsCredentialAssignment(value: string): boolean {
	for (const key of credentialKeys) {
		let searchFrom = 0;
		while (searchFrom < value.length) {
			const index = value.indexOf(key, searchFrom);
			if (index < 0) {
				break;
			}
			searchFrom = index + key.length;
			const before = index === 0 ? undefined : value[index - 1];
			const after = value[searchFrom];
			if ((before !== undefined && isIdentifierCharacter(before)) || isIdentifierCharacter(after)) {
				continue;
			}
			let cursor = searchFrom;
			while (cursor < value.length && isCredentialPadding(value[cursor])) {
				cursor += 1;
			}
			if (value[cursor] === '=' || value[cursor] === ':') {
				return true;
			}
		}
	}
	return false;
}

function isCredentialPadding(character: string): boolean {
	return character === '"' || character === '\'' || character.trim().length === 0;
}

function isIdentifierCharacter(character: string | undefined): boolean {
	if (character === undefined) {
		return false;
	}
	const code = character.charCodeAt(0);
	return isAsciiLetter(character)
		|| (code >= 48 && code <= 57)
		|| character === '_'
		|| character === '-';
}
