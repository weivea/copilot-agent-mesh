export function boundUtf8(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maximumBytes) {
		return value;
	}
	let result = '';
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, 'utf8');
		if (bytes + size > maximumBytes) {
			break;
		}
		result += character;
		bytes += size;
	}
	return result;
}
