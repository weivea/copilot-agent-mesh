import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';

import {
	GATEWAY_METHODS,
	MESH_ERROR_CODES,
	PROTOCOL_LIMITS,
	persistedTaskRecordSchema,
	rpcErrorResponseSchema,
	rpcNotificationSchema,
	rpcRequestSchema,
	safeParseJsonText,
	safeParseRpcMessageText,
	taskStartParamsSchema,
	utf8ByteLength,
	webviewOutboundMessageSchema,
} from '../../../shared/protocol';
import { createAcceptedTask } from '../../domain/task';
import { AT, IDS, taskRequest } from './fixtures';

function helloRequest(): object {
	return {
		jsonrpc: '2.0',
		id: 'request-1',
		method: GATEWAY_METHODS.hello,
		params: {
			protocolMin: 1,
			protocolMax: 1,
			deviceId: IDS.device,
			nonce: 'abcdefghijklmnopqrstuvwxyzABCDEF',
		},
	};
}

describe('protocol schemas', () => {
	test('accepts known strict JSON-RPC requests', () => {
		assert.strictEqual(rpcRequestSchema.safeParse(helloRequest()).success, true);
	});

	test('rejects missing fields, wrong types, and unknown methods', () => {
		const missing = { ...helloRequest(), params: {} };
		const wrongType = {
			...helloRequest(),
			params: { ...(helloRequest() as { params: object }).params, protocolMin: '1' },
		};
		const unknown = { ...helloRequest(), method: 'task.unknown' };
		assert.strictEqual(rpcRequestSchema.safeParse(missing).success, false);
		assert.strictEqual(rpcRequestSchema.safeParse(wrongType).success, false);
		assert.strictEqual(rpcRequestSchema.safeParse(unknown).success, false);
	});

	test('rejects JSON-RPC batch input', () => {
		const result = safeParseRpcMessageText(JSON.stringify([helloRequest()]));
		assert.deepStrictEqual(result.success, false);
		if (!result.success) {
			assert.strictEqual(result.reason, 'INVALID_MESSAGE');
		}
	});

	test('rejects prototype-pollution shapes without mutating prototypes', () => {
		const text = JSON.stringify(helloRequest()).replace(
			'"params":{',
			'"__proto__":{"polluted":true},"params":{',
		);
		const result = safeParseRpcMessageText(text);
		assert.strictEqual(result.success, false);
		assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
		const response = safeParseRpcMessageText(
			'{"jsonrpc":"2.0","id":"request-1","result":{"nested":{"__proto__":{"polluted":true}}}}',
		);
		assert.strictEqual(response.success, false);
	});

	test('rejects deeply nested JSON without recursion or thrown validation errors', () => {
		const depth = 12_000;
		const text = `{"jsonrpc":"2.0","id":"request-1","result":${'['.repeat(depth)}null${']'.repeat(depth)}}`;
		assert.ok(utf8ByteLength(text) < PROTOCOL_LIMITS.unauthenticatedFrameBytes);
		let result: ReturnType<typeof safeParseRpcMessageText> | undefined;
		assert.doesNotThrow(() => {
			result = safeParseRpcMessageText(text, PROTOCOL_LIMITS.unauthenticatedFrameBytes);
		});
		assert.strictEqual(result?.success, false);

		const throwingSchema = z.unknown().refine(() => {
			throw new Error('validator failed');
		});
		assert.deepStrictEqual(
			safeParseJsonText('null', throwingSchema),
			{ success: false, reason: 'INVALID_MESSAGE' },
		);
	});

	test('enforces serialized frame bytes before parsing', () => {
		const text = `${'x'.repeat(PROTOCOL_LIMITS.unauthenticatedFrameBytes)}🙂`;
		assert.ok(utf8ByteLength(text) > PROTOCOL_LIMITS.unauthenticatedFrameBytes);
		const result = safeParseRpcMessageText(text, PROTOCOL_LIMITS.unauthenticatedFrameBytes);
		assert.deepStrictEqual(result, { success: false, reason: 'FRAME_TOO_LARGE' });
	});

	test('enforces UTF-8 field limits rather than JavaScript character counts', () => {
		const request = taskRequest({
			prompt: '🙂'.repeat(PROTOCOL_LIMITS.taskPromptBytes / 4 + 1),
		});
		const { peerId: _, ...params } = request;
		assert.strictEqual(taskStartParamsSchema.safeParse(params).success, false);
	});

	test('validates errors and task notifications', () => {
		assert.strictEqual(rpcErrorResponseSchema.safeParse({
			jsonrpc: '2.0',
			id: 'request-1',
			error: {
				code: MESH_ERROR_CODES.WORKSPACE_BUSY,
				message: 'Workspace is busy.',
				data: { reason: 'WORKSPACE_BUSY', retryable: true },
			},
		}).success, true);
		assert.strictEqual(rpcErrorResponseSchema.safeParse({
			jsonrpc: '2.0',
			id: 'request-1',
			error: {
				code: MESH_ERROR_CODES.WORKSPACE_BUSY,
				message: 'Workspace is busy.',
				data: { reason: 'TASK_NOT_FOUND' },
			},
		}).success, false);
		assert.strictEqual(rpcNotificationSchema.safeParse({
			jsonrpc: '2.0',
			method: 'task.stateChanged',
			params: {
				taskId: IDS.task,
				eventSeq: 1,
				at: AT,
				state: 'running',
			},
		}).success, true);
	});

	test('persisted records reject full prompt and raw output fields', () => {
		const record = createAcceptedTask(taskRequest(), AT);
		assert.strictEqual(persistedTaskRecordSchema.safeParse(record).success, true);
		assert.strictEqual(persistedTaskRecordSchema.safeParse({
			...record,
			prompt: 'must not persist',
		}).success, false);
		assert.strictEqual(persistedTaskRecordSchema.safeParse({
			...record,
			output: 'must not persist',
		}).success, false);
		assert.strictEqual(persistedTaskRecordSchema.safeParse({
			...record,
			recoveryDescriptor: {
				adapter: 'ahp',
				sessionId: 'session-1',
				prompt: 'must not persist',
			},
		}).success, false);
	});

	test('webview outbound schemas reject local URI fields', () => {
		const result = webviewOutboundMessageSchema.safeParse({
			type: 'dashboard.state',
			device: {
				deviceId: IDS.device,
				name: 'worker',
				platform: 'darwin',
				architecture: 'arm64',
				vscodeVersion: '1.103.0',
				extensionVersion: '0.0.1',
				protocolVersion: 1,
			},
			workspaces: [{
				workspaceId: IDS.workspace,
				name: 'Workspace',
				capabilityTags: [],
				enabled: true,
				busy: false,
				localUri: 'file:///secret/path',
			}],
			tasks: [],
		});
		assert.strictEqual(result.success, false);
	});
});
