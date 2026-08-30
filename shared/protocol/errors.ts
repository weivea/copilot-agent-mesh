import { z } from 'zod';

import { PROTOCOL_LIMITS, utf8String } from './limits';

export const MESH_ERROR_CODES = {
	AUTH_REQUIRED: 1000,
	AUTH_FAILED: 1001,
	PROTOCOL_INCOMPATIBLE: 1002,
	RATE_LIMITED: 1003,
	WORKSPACE_NOT_FOUND: 1004,
	WORKSPACE_DISABLED: 1005,
	WORKSPACE_BUSY: 1006,
	TASK_NOT_FOUND: 1007,
	TASK_ID_CONFLICT: 1008,
	TASK_NOT_CANCELLABLE: 1009,
	INPUT_NOT_PENDING: 1010,
	AGENT_UNAVAILABLE: 1011,
	AGENT_AUTH_REQUIRED: 1012,
	TASK_EXECUTION_FAILED: 1013,
	TASK_RECOVERY_UNAVAILABLE: 1014,
	WORKER_DRAINING: 1015,
	REMOTE_WORKSPACE_UNSUPPORTED: 1016,
	CLI_UNSUPPORTED: 1017,
	TUNNEL_UNAVAILABLE: 1018,
	WORKSPACE_UNTRUSTED: 1019,
	LOCAL_FILE_WORKSPACE_REQUIRED: 1020,
	PORT_CONFLICT: 1021,
	TUNNEL_ACCESS_EXPIRED: 1022,
	TASK_CANCELLATION_UNCONFIRMED: 1023,
	DELEGATION_NOT_FOUND: 1024,
	ARTIFACT_NOT_FOUND: 1029,
	ARTIFACT_FORBIDDEN: 1030,
	ARTIFACT_INVALID: 1031,
	ARTIFACT_CORRUPT: 1032,
	ARTIFACT_LIMIT_EXCEEDED: 1033,
} as const;

export const JSON_RPC_ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
} as const;

export type MeshErrorReason = keyof typeof MESH_ERROR_CODES;
export type MeshErrorCode = typeof MESH_ERROR_CODES[MeshErrorReason];

const meshErrorCodes = new Set<number>(Object.values(MESH_ERROR_CODES));
const jsonRpcErrorCodes = new Set<number>(Object.values(JSON_RPC_ERROR_CODES));

export const rpcErrorSchema = z.strictObject({
	code: z.number().int().refine(
		(code) => jsonRpcErrorCodes.has(code) || meshErrorCodes.has(code),
		'Unknown JSON-RPC or Mesh error code',
	),
	message: utf8String(PROTOCOL_LIMITS.errorMessageBytes, 'error message', 1),
	data: z.strictObject({
		reason: z.enum(Object.keys(MESH_ERROR_CODES) as [MeshErrorReason, ...MeshErrorReason[]]),
		retryable: z.boolean().optional(),
	}).optional(),
}).superRefine((error, context) => {
	if (meshErrorCodes.has(error.code)) {
		if (
			error.data === undefined
			|| MESH_ERROR_CODES[error.data.reason] !== error.code
		) {
			context.addIssue({
				code: 'custom',
				path: ['data', 'reason'],
				message: 'Mesh error code and reason must match',
			});
		}
	}
});

export type RpcError = z.infer<typeof rpcErrorSchema>;
