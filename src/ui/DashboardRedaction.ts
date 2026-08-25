const maximumCanonicalLength = 16 * 1024;
const maximumDecodeRounds = 4;
const maximumUriInspectionDepth = 4;
const sensitiveCredentialKeySuffixes = [
	'apikey',
	'authorization',
	'credential',
	'password',
	'privatekey',
	'secret',
	'tkn',
	'token',
] as const;
const githubTokenPrefixes = [
	'gho_',
	'ghp_',
	'ghr_',
	'ghs_',
	'ghu_',
	'github_pat_',
] as const;

export function redactRemoteText(value: string): string {
	return containsUnsafeDashboardText(value) ? '[redacted sensitive details]' : value;
}

export function containsUnsafeDashboardText(value: string): boolean {
	return containsUnsafeDashboardTextAtDepth(value, 0);
}

function containsUnsafeDashboardTextAtDepth(value: string, depth: number): boolean {
	const canonicalForms = canonicalizePercentEncoding(value);
	if (canonicalForms === undefined) {
		return true;
	}
	for (const form of canonicalForms) {
		if (containsC0(form) || containsUnsafeUriCandidate(form, depth)) {
			return true;
		}
	}
	const canonical = canonicalForms[canonicalForms.length - 1];
	const lower = canonical.toLowerCase();
	if (
		lower.includes('file://')
		|| lower.includes('api_key=')
		|| lower.includes('api-key=')
		|| lower.includes('bearer ')
		|| githubTokenPrefixes.some((prefix) => lower.includes(prefix))
		|| containsCredentialAssignment(lower)
	) {
		return true;
	}
	return lexicalTokens(lower).some(isPathToken);
}

function containsUnsafeUriCandidate(value: string, depth: number): boolean {
	const uris = extractUriCandidates(value);
	if (uris.length === 0) {
		return false;
	}
	if (depth >= maximumUriInspectionDepth) {
		return true;
	}
	return uris.some((candidate) => containsUnsafeUri(candidate, depth + 1));
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

function canonicalizePercentEncoding(value: string): string[] | undefined {
	if (value.length > maximumCanonicalLength) {
		return undefined;
	}
	let canonical = value;
	const forms = [value];
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
			return forms;
		}
		canonical = decoded;
		forms.push(canonical);
	}
	return canonical.includes('%') ? undefined : forms;
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
		while (
			cursor >= 0
			&& isCredentialKeyCharacter(value[cursor])
		) {
			cursor -= 1;
		}
		if (keyEnd === cursor + 1) {
			continue;
		}
		const normalized = normalizeCredentialKey(value.slice(cursor + 1, keyEnd));
		if (isSensitiveCredentialKey(normalized)) {
			return true;
		}
	}
	return false;
}

function isCredentialPadding(character: string): boolean {
	return character === '"' || character === '\'' || character.trim().length === 0;
}

function isCredentialKeyCharacter(character: string): boolean {
	return isIdentifierCharacter(character)
		|| character.trim().length === 0
		|| character === '['
		|| character === ']'
		|| character === '+';
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
		const code = character.charCodeAt(0);
		if (isAsciiLetter(character) || (code >= 48 && code <= 57)) {
			normalized += character.toLowerCase();
		}
	}
	return normalized;
}

function containsUnsafeFormKey(value: string, depth: number): boolean {
	const normalized = normalizeFormComponent(value);
	return isSensitiveCredentialKey(normalizeCredentialKey(normalized))
		|| containsUnsafeDashboardTextAtDepth(normalized, depth);
}

function normalizeFormComponent(value: string): string {
	return value.replaceAll('+', ' ');
}

function isSensitiveCredentialKey(value: string): boolean {
	return sensitiveCredentialKeySuffixes.some((suffix) => value.endsWith(suffix));
}

function extractUriCandidates(value: string): string[] {
	const candidates = new Set<string>();
	for (let start = 0; start < value.length; start += 1) {
		if (!isAsciiLetter(value[start])) {
			continue;
		}
		let schemeEnd = start + 1;
		while (schemeEnd < value.length && isUriSchemeCharacter(value[schemeEnd])) {
			schemeEnd += 1;
		}
		if (value[schemeEnd] !== ':') {
			continue;
		}
		let end = schemeEnd + 1;
		while (end < value.length && !isUrlTerminator(value[end])) {
			end += 1;
		}
		let candidate = value.slice(start, end);
		while (candidate.length > 0 && '.,;!?'.includes(candidate[candidate.length - 1])) {
			candidate = candidate.slice(0, -1);
		}
		if (candidate.length > 0) {
			candidates.add(candidate);
		}
		start = Math.max(start, end - 1);
	}
	addSchemeDelimiterTokens(value, candidates);
	return [...candidates];
}

function containsUnsafeUri(candidate: string, depth: number): boolean {
	const separator = candidate.indexOf(':');
	if (separator <= 0) {
		return true;
	}
	const rawProtocol = candidate.slice(0, separator).toLowerCase();
	if (rawProtocol !== 'https' && rawProtocol !== 'http') {
		return true;
	}
	if (!hasStrictHttpAuthority(candidate, separator)) {
		return true;
	}
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
			containsUnsafeFormKey(key, depth)
			|| containsUnsafeDashboardTextAtDepth(normalizeFormComponent(value), depth)
		) {
			return true;
		}
	}
	const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
	return fragment.length > 0 && containsUnsafeDashboardTextAtDepth(fragment, depth);
}

function hasStrictHttpAuthority(candidate: string, separator: number): boolean {
	const authorityStart = separator + 3;
	if (
		candidate[separator + 1] !== '/'
		|| candidate[separator + 2] !== '/'
		|| candidate[authorityStart] === undefined
		|| candidate[authorityStart] === '/'
	) {
		return false;
	}
	let authorityEnd = authorityStart;
	while (
		authorityEnd < candidate.length
		&& candidate[authorityEnd] !== '/'
		&& candidate[authorityEnd] !== '?'
		&& candidate[authorityEnd] !== '#'
	) {
		authorityEnd += 1;
	}
	return authorityEnd > authorityStart;
}

function isUriSchemeCharacter(character: string): boolean {
	if (isAsciiLetter(character)) {
		return true;
	}
	const code = character.charCodeAt(0);
	return (code >= 48 && code <= 57)
		|| character === '+'
		|| character === '-'
		|| character === '.';
}

function addSchemeDelimiterTokens(value: string, candidates: Set<string>): void {
	let searchFrom = 0;
	while (searchFrom < value.length) {
		const delimiter = value.indexOf('://', searchFrom);
		if (delimiter < 0) {
			return;
		}
		let start = delimiter - 1;
		while (start >= 0 && !isUrlTerminator(value[start])) {
			start -= 1;
		}
		let end = delimiter + 3;
		while (end < value.length && !isUrlTerminator(value[end])) {
			end += 1;
		}
		const candidate = value.slice(start + 1, end);
		if (candidate.length > 0) {
			candidates.add(candidate);
		}
		searchFrom = delimiter + 3;
	}
}

function isUrlTerminator(character: string): boolean {
	return character.trim().length === 0 || '"`()[]{}<>'.includes(character);
}

function containsC0(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 31 || code === 127) {
			return true;
		}
	}
	return false;
}
