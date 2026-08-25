const maximumCanonicalLength = 4096;
const maximumDecodeRounds = 4;
const maximumUrlInspectionDepth = 4;
const normalizedCredentialKeys = new Set([
	'accesstoken',
	'apikey',
	'authorization',
	'clientsecret',
	'credential',
	'password',
	'privatekey',
	'refreshtoken',
	'secret',
	'tkn',
	'token',
]);

export function redactRemoteText(value: string): string {
	return containsUnsafeDashboardText(value) ? '[redacted sensitive details]' : value;
}

export function containsUnsafeDashboardText(value: string): boolean {
	return containsUnsafeDashboardTextAtDepth(value, 0);
}

function containsUnsafeDashboardTextAtDepth(value: string, depth: number): boolean {
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
	const urls = extractUrlCandidates(canonical);
	if (urls.length > 0) {
		if (depth >= maximumUrlInspectionDepth) {
			return true;
		}
		for (const candidate of urls) {
			if (containsUnsafeUrl(candidate, depth + 1)) {
				return true;
			}
		}
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
	for (let separator = 0; separator < value.length; separator += 1) {
		if (value[separator] !== '=' && value[separator] !== ':') {
			continue;
		}
		let cursor = separator - 1;
		while (cursor >= 0 && isCredentialPadding(value[cursor])) {
			cursor -= 1;
		}
		const keyEnd = cursor + 1;
		while (cursor >= 0 && isIdentifierCharacter(value[cursor])) {
			cursor -= 1;
		}
		if (keyEnd === cursor + 1) {
			continue;
		}
		const normalized = normalizeCredentialKey(value.slice(cursor + 1, keyEnd));
		if (normalizedCredentialKeys.has(normalized)) {
			return true;
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

function normalizeCredentialKey(value: string): string {
	let normalized = '';
	for (const character of value) {
		if (character !== '_' && character !== '-') {
			normalized += character.toLowerCase();
		}
	}
	return normalized;
}

function extractUrlCandidates(value: string): string[] {
	const lower = value.toLowerCase();
	const candidates: string[] = [];
	let searchFrom = 0;
	while (searchFrom < value.length) {
		const httpsIndex = lower.indexOf('https://', searchFrom);
		const httpIndex = lower.indexOf('http://', searchFrom);
		const start = firstAvailableIndex(httpsIndex, httpIndex);
		if (start < 0) {
			break;
		}
		let end = start;
		while (end < value.length && !isUrlTerminator(value[end])) {
			end += 1;
		}
		let candidate = value.slice(start, end);
		while (candidate.length > 0 && '.,;!?'.includes(candidate[candidate.length - 1])) {
			candidate = candidate.slice(0, -1);
		}
		if (candidate.length > 0) {
			candidates.push(candidate);
		}
		searchFrom = Math.max(end, start + 1);
	}
	return candidates;
}

function containsUnsafeUrl(candidate: string, depth: number): boolean {
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return true;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		return true;
	}
	if (parsed.username.length > 0 || parsed.password.length > 0) {
		return true;
	}
	if (parsed.pathname !== '/' && containsUnsafeDashboardTextAtDepth(parsed.pathname, depth)) {
		return true;
	}
	for (const [key, value] of parsed.searchParams) {
		if (
			containsUnsafeDashboardTextAtDepth(key, depth)
			|| containsUnsafeDashboardTextAtDepth(value, depth)
		) {
			return true;
		}
	}
	const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
	return fragment.length > 0 && containsUnsafeDashboardTextAtDepth(fragment, depth);
}

function firstAvailableIndex(first: number, second: number): number {
	if (first < 0) {
		return second;
	}
	if (second < 0) {
		return first;
	}
	return Math.min(first, second);
}

function isUrlTerminator(character: string): boolean {
	return character.trim().length === 0 || '"\'`()[]{}<>'.includes(character);
}
