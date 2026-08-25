import { GATEWAY_NOTIFICATIONS } from '../../shared/protocol';
import type { TaskNotificationSink } from '../application/RemoteTaskRunner';

export type TaskNotificationPublisher = (
	peerId: string,
	method: string,
	params: Record<string, unknown>,
) => Promise<void> | void;

export function createTaskNotificationSink(
	publish: TaskNotificationPublisher,
): TaskNotificationSink {
	return {
		publish: (record, event) => {
			const base = {
				taskId: record.taskId,
				eventSeq: record.eventSeq,
				at: event.at,
			};
			switch (event.type) {
				case 'progress':
				case 'tool':
					if (Buffer.byteLength(event.summary, 'utf8') === 0) {
						return;
					}
					return publish(record.peerId, GATEWAY_NOTIFICATIONS.taskProgress, {
						...base,
						summary: event.summary,
					});
				case 'output':
				case 'terminal':
					if (Buffer.byteLength(event.summary, 'utf8') === 0) {
						return;
					}
					return publish(record.peerId, GATEWAY_NOTIFICATIONS.taskOutput, {
						...base,
						output: event.summary,
						truncated: false,
					});
				case 'outputTruncated':
					return publish(record.peerId, GATEWAY_NOTIFICATIONS.taskOutput, {
						...base,
						output: Buffer.byteLength(event.summary, 'utf8') === 0
							? 'Agent output was truncated.'
							: event.summary,
						truncated: true,
					});
				default:
					return publish(record.peerId, GATEWAY_NOTIFICATIONS.taskStateChanged, {
						...base,
						state: record.state,
					});
			}
		},
	};
}
