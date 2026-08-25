import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { suite, test } from 'node:test';

import WebSocket from 'ws';

import { RpcPeer, type RpcPeerOptions } from '../gateway/RpcPeer';
import type { GatewayRouter } from '../gateway/GatewayRouter';
import type { PairingService } from '../gateway/PairingService';
import {
	GATEWAY_NOTIFICATIONS,
	PROTOCOL_LIMITS,
	rpcNotificationSchema,
} from '../../shared/protocol';

suite('RpcPeer outbound queue', () => {
	test('coalesces queued progress by task and resolves after the latest frame is sent', async () => {
		const { peer, socket } = createPeer();
		try {
			const blocker = send(peer, response('blocker'));
			const first = send(peer, progress('first'));
			const second = send(peer, progress('second'));

			assert.equal(socket.sent.length, 1);
			socket.completeNext();
			assert.equal(socket.sent.length, 2);
			assert.equal(
				(JSON.parse(socket.sent[1].toString('utf8')) as {
					params: { summary: string };
				}).params.summary,
				'second',
			);
			socket.completeNext();
			await Promise.all([blocker, first, second]);
			assert.equal(socket.sent.length, 2);
		} finally {
			peer.dispose();
		}
	});

	test('uses one schema-valid truncated output marker per pressure episode', async () => {
		const { peer, socket } = createPeer({ outboxMaxBytes: 1 });
		try {
			const blocker = send(peer, response('blocker'));
			let settled = false;
			const first = send(peer, output('first'));
			const second = send(peer, output('second'));
			void Promise.all([first, second]).then(() => {
				settled = true;
			});
			await Promise.resolve();
			assert.equal(settled, false);
			assert.equal(socket.sent.length, 1);

			socket.completeNext();
			assert.equal(socket.sent.length, 2);
			const marker = JSON.parse(socket.sent[1].toString('utf8')) as {
				params: { output: string; truncated: boolean };
			};
			assert.equal(rpcNotificationSchema.safeParse(marker).success, true);
			assert.equal(marker.params.truncated, true);
			assert.match(marker.params.output, /backpressure/u);
			socket.completeNext();
			await Promise.all([blocker, first, second]);
			assert.equal(settled, true);
			assert.equal(socket.sent.length, 2);

			const nextEpisode = send(peer, output('third'));
			assert.equal(socket.sent.length, 3);
			socket.completeNext();
			await nextEpisode;
		} finally {
			peer.dispose();
		}
	});

	test('releases completed pressure episodes for later tasks', async () => {
		const { peer, socket } = createPeer({ outboxMaxBytes: 1 });
		try {
			for (let index = 0; index < 20; index += 1) {
				const pressured = send(peer, output('dropped', taskIdFor(index)));
				assert.equal(socket.sent.length, index + 1);
				socket.completeNext();
				await pressured;
			}
		} finally {
			peer.dispose();
		}
	});

	test('includes retained socket buffering in hard admission after send callbacks', async () => {
		const { peer, socket } = createPeer();
		try {
			const first = send(peer, response('buffered'));
			socket.completeNext(true);
			await first;
			socket.bufferedAmount = PROTOCOL_LIMITS.frameBytes + 256 * 1024 - 1;

			await assert.rejects(send(peer, response('too much')), /queue capacity/u);
			assert.equal(socket.closeCode, 1013);
		} finally {
			peer.dispose();
		}
	});

	test('admits one critical frame exactly at the protocol limit', async () => {
		const { peer, socket } = createPeer();
		try {
			const empty = response('');
			const fixedBytes = Buffer.byteLength(JSON.stringify(empty));
			const value = response('x'.repeat(PROTOCOL_LIMITS.frameBytes - fixedBytes));
			assert.equal(Buffer.byteLength(JSON.stringify(value)), PROTOCOL_LIMITS.frameBytes);

			const sent = send(peer, value);
			assert.equal(socket.sent[0].byteLength, PROTOCOL_LIMITS.frameBytes);
			socket.completeNext();
			await sent;
		} finally {
			peer.dispose();
		}
	});
});

const taskId = '11111111-1111-4111-8111-111111111111';
const at = '2026-08-25T09:00:00.000Z';

function progress(summary: string): unknown {
	return {
		jsonrpc: '2.0',
		method: GATEWAY_NOTIFICATIONS.taskProgress,
		params: { taskId, eventSeq: 1, at, summary },
	};
}

function output(value: string, outputTaskId = taskId): unknown {
	return {
		jsonrpc: '2.0',
		method: GATEWAY_NOTIFICATIONS.taskOutput,
		params: { taskId: outputTaskId, eventSeq: 1, at, output: value, truncated: false },
	};
}

function taskIdFor(index: number): string {
	return `11111111-1111-4111-8111-${index.toString().padStart(12, '0')}`;
}

function response(payload: string): unknown {
	return { jsonrpc: '2.0', id: 'request', result: { payload } };
}

function send(peer: RpcPeer, value: unknown): Promise<void> {
	return (peer as unknown as {
		send(outbound: unknown): Promise<void>;
	}).send(value);
}

function createPeer(options: RpcPeerOptions = {}): {
	readonly peer: RpcPeer;
	readonly socket: ControlledSocket;
} {
	const socket = new ControlledSocket();
	const pairing = {
		registerConnection: () => undefined,
		disposeConnection: () => undefined,
	} as unknown as PairingService;
	const peer = new RpcPeer(
		socket as unknown as WebSocket,
		pairing,
		{} as GatewayRouter,
		() => undefined,
		() => undefined,
		{ handshakeTimeoutMs: 60_000, ...options },
	);
	return { peer, socket };
}

class ControlledSocket extends EventEmitter {
	public readyState: number = WebSocket.OPEN;
	public bufferedAmount = 0;
	public closeCode: number | undefined;
	public readonly sent: Buffer[] = [];
	private readonly completions: Array<{
		readonly bytes: number;
		readonly callback: (error?: Error) => void;
	}> = [];

	public send(
		data: Buffer,
		_options: unknown,
		callback: (error?: Error) => void,
	): void {
		const copy = Buffer.from(data);
		this.sent.push(copy);
		this.bufferedAmount += copy.byteLength;
		this.completions.push({ bytes: copy.byteLength, callback });
	}

	public completeNext(retainBufferedAmount = false): void {
		const completion = this.completions.shift();
		assert.ok(completion);
		if (!retainBufferedAmount) {
			this.bufferedAmount -= completion.bytes;
		}
		completion.callback();
	}

	public close(code: number): void {
		this.closeCode = code;
		this.readyState = WebSocket.CLOSING;
	}

	public terminate(): void {
		this.readyState = WebSocket.CLOSED;
	}

	public ping(): void {}
}
