import type { ToolJsonResult } from './taskToolsCore';

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nextAction(taskId: string, state: unknown, inputId?: unknown): ToolJsonResult {
	if (state === 'needsInput' && typeof inputId === 'string') {
		return { tool: 'meshAnswerTask', taskId, inputId, requiresUserInput: true };
	}
	if (['completed', 'failed', 'cancelled', 'timedOut'].includes(String(state))) {
		return { tool: 'none' };
	}
	return { tool: 'meshGetTask', taskId, waitFor: state === 'unknown' ? 'snapshot' : 'outcome' };
}

export function presentToolResult(value: ToolJsonResult): ToolJsonResult {
	if (typeof value.s === 'number' && typeof value.t === 'string' && typeof value.d === 'string') {
		const outcome = ['completed', 'needsInput', 'failed', 'cancelled', 'accepted'][value.s];
		if (outcome === undefined) { return value; }
		const taskState = value.taskState ?? ['completed', 'needsInput', 'unknown', 'cancelled', 'unknown'][value.s];
		return {
			outcome,
			taskId: value.t,
			delegationRequestId: value.d,
			taskState,
			...(value.s === 0 ? { result: value.r } : {}),
			...(value.s === 1 ? { pendingInput: { inputId: value.i, question: value.q } } : {}),
			...(value.e === undefined ? {} : { error: { code: value.e } }),
			...(value.x === undefined ? {} : { cancellationReason: value.x }),
			nextAction: value.e === 'OUTPUT_TOO_LARGE'
				? { tool: 'meshGetTask', taskId: value.t, waitFor: 'snapshot' }
				: nextAction(value.t, taskState, value.i),
		};
	}
	if (record(value.snapshot) && typeof value.snapshot.taskId === 'string') {
		const input = record(value.snapshot.pendingInput) ? value.snapshot.pendingInput.inputId : undefined;
		return { ...value, nextAction: value.snapshotIsLastRead === true
			? { tool: 'meshGetTask', taskId: value.snapshot.taskId, waitFor: 'snapshot' }
			: nextAction(value.snapshot.taskId, value.snapshot.status, input) };
	}
	if (typeof value.taskId === 'string' && typeof value.taskStatus === 'string') {
		return { ...value, nextAction: nextAction(value.taskId, value.taskStatus) };
	}
	if (record(value.error) && ['STALE_TARGET', 'WORKSPACE_NOT_FOUND', 'PEER_OFFLINE'].includes(String(value.error.code))) {
		return { ...value, nextAction: { tool: 'meshListWorkers' } };
	}
	return value;
}

/** Lossless first contraction before existing field-by-field budget trimming. */
export function compactPresentedDelegation(value: ToolJsonResult): ToolJsonResult | undefined {
	if (typeof value.taskId !== 'string' || typeof value.delegationRequestId !== 'string') { return undefined; }
	const status = ['completed', 'needsInput', 'failed', 'cancelled', 'accepted'].indexOf(String(value.outcome));
	if (status < 0) { return undefined; }
	return {
		s: status, t: value.taskId, d: value.delegationRequestId,
		...(status === 0 ? { r: value.result } : {}),
		...(status === 1 && record(value.pendingInput)
			? { i: value.pendingInput.inputId, q: value.pendingInput.question } : {}),
		...(record(value.error) ? { e: value.error.code } : {}),
		...(value.cancellationReason === undefined ? {} : { x: value.cancellationReason }),
		...((status === 2 && value.taskState !== 'unknown') || status === 4
			|| (status === 3 && value.taskState !== 'cancelled') ? { taskState: value.taskState } : {}),
	};
}
