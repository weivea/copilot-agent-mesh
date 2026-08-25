import { z } from 'zod';

export const PROTOCOL_LIMITS = {
	frameBytes: 1_048_576,
	taskEventJournalBytes: 768 * 1_024,
	unauthenticatedFrameBytes: 65_536,
	taskTitleBytes: 256,
	taskPromptBytes: 128 * 1_024,
	acceptanceCriteriaCount: 32,
	acceptanceCriterionBytes: 4 * 1_024,
	taskAnswerBytes: 32 * 1_024,
	outputEventBytes: 16 * 1_024,
	terminalSummaryBytes: 16 * 1_024,
	errorMessageBytes: 2 * 1_024,
	nameBytes: 256,
	identifierBytes: 128,
} as const;

const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function utf8String(maxBytes: number, fieldName: string, minimumBytes = 0) {
	return z.string().refine(
		(value) => {
			const length = utf8ByteLength(value);
			return length >= minimumBytes && length <= maxBytes;
		},
		`${fieldName} must be between ${minimumBytes} and ${maxBytes} UTF-8 bytes`,
	);
}
