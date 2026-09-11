export function readCentralDirectory(buffer) {
	const minimumEndSize = 22;
	const earliestEnd = Math.max(0, buffer.length - 0xffff - minimumEndSize);
	let endOffset = -1;
	for (let offset = buffer.length - minimumEndSize; offset >= earliestEnd; offset -= 1) {
		if (buffer.readUInt32LE(offset) === 0x06054b50) {
			endOffset = offset;
			break;
		}
	}
	if (endOffset < 0) {
		throw new Error('VSIX end-of-central-directory record was not found.');
	}
	const entryCount = buffer.readUInt16LE(endOffset + 10);
	let offset = buffer.readUInt32LE(endOffset + 16);
	const names = [];
	for (let index = 0; index < entryCount; index += 1) {
		if (offset > buffer.length - 46 || buffer.readUInt32LE(offset) !== 0x02014b50) {
			throw new Error(`Invalid central-directory entry at offset ${offset}.`);
		}
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const nameStart = offset + 46;
		if (nameStart + nameLength + extraLength + commentLength > endOffset) {
			throw new Error('VSIX central-directory entry exceeds its archive boundary.');
		}
		names.push(buffer.toString('utf8', nameStart, nameStart + nameLength));
		offset = nameStart + nameLength + extraLength + commentLength;
	}
	return names;
}
