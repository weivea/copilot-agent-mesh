import {
	PROTOCOL_LIMITS,
	utf8ByteLength,
	type PersistedTaskRecord,
} from '../../shared/protocol';

export const TASK_EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const TASK_EVENT_JOURNAL_BYTES = PROTOCOL_LIMITS.frameBytes;

export function compactTaskEventJournal(
	record: PersistedTaskRecord,
	referenceAt: string,
): PersistedTaskRecord {
	if (record.events.length === 0) {
		return record.eventsTruncated
			? {
				...record,
				earliestAvailableEventSeq: record.eventSeq + 1,
			}
			: record;
	}

	const referenceTime = Date.parse(referenceAt);
	if (!Number.isFinite(referenceTime)) {
		throw new TypeError('Event journal reference time must be a valid timestamp.');
	}
	const cutoff = referenceTime - TASK_EVENT_RETENTION_MS;
	let retainedStart = 0;

	for (let index = 0; index < record.events.length; index += 1) {
		const event = record.events[index];
		const eventTime = Date.parse(event.at);
		if (!Number.isFinite(eventTime)) {
			throw new TypeError('Event journal timestamps must be valid.');
		}
		const eventBytes = utf8ByteLength(JSON.stringify(event));
		if (eventTime < cutoff || eventBytes + 2 > TASK_EVENT_JOURNAL_BYTES) {
			retainedStart = index + 1;
		}
	}

	let retainedBytes = 2;
	let byteLimitedStart = record.events.length;
	for (let index = record.events.length - 1; index >= retainedStart; index -= 1) {
		const eventBytes = utf8ByteLength(JSON.stringify(record.events[index]));
		const separatorBytes = byteLimitedStart === record.events.length ? 0 : 1;
		if (retainedBytes + separatorBytes + eventBytes > TASK_EVENT_JOURNAL_BYTES) {
			break;
		}
		retainedBytes += separatorBytes + eventBytes;
		byteLimitedStart = index;
	}
	retainedStart = Math.max(retainedStart, byteLimitedStart);

	const events = record.events.slice(retainedStart);
	const eventsTruncated = record.eventsTruncated || retainedStart > 0;
	if (!eventsTruncated) {
		return record;
	}
	return {
		...record,
		events,
		eventsTruncated: true,
		earliestAvailableEventSeq: events[0]?.eventSeq ?? record.eventSeq + 1,
	};
}

export function taskEventJournalBytes(record: Pick<PersistedTaskRecord, 'events'>): number {
	return utf8ByteLength(JSON.stringify(record.events));
}
