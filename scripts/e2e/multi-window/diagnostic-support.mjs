const terminalStates = new Set(['completed', 'failed', 'cancelled', 'timedOut']);

export function runtimeCanStart(probe) {
	return probe?.featureEnabled === true && (probe.available === true || probe.canStart === true);
}

export async function confirmTaskCancellation(request, source, taskId, options = {}) {
	const now = options.now ?? Date.now;
	const delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const deadline = now() + (options.timeoutMs ?? 15_000);
	const failures = [];
	let lastReadFailure;
	let terminalState;
	try {
		await request(source, 'task.cancel', { taskId }, Math.min(5_000, Math.max(1, deadline - now())));
	} catch (error) {
		failures.push(error);
	}
	while (now() < deadline) {
		try {
			const value = await request(source, 'task.get', { taskId }, Math.min(2_000, deadline - now()));
			if (value?.snapshot?.taskId === taskId && terminalStates.has(value.snapshot.status)) {
				terminalState = value.snapshot.status;
				break;
			}
		} catch (error) {
			lastReadFailure = error;
		}
		await delay(Math.min(100, Math.max(0, deadline - now())));
	}
	if (terminalState === undefined) {
		if (lastReadFailure !== undefined) {
			failures.push(lastReadFailure);
		}
		failures.push(new Error('Diagnostic task cancellation did not produce a confirmed terminal state before the deadline.'));
	}
	if (failures.length > 0) {
		throw Object.assign(new AggregateError(failures, 'Diagnostic task cancellation cleanup failed.'), {
			terminalState,
		});
	}
	return terminalState;
}

export function combineOperationAndCleanupError(primaryError, cleanupError) {
	return primaryError === undefined ? cleanupError : new AggregateError(
		[primaryError, cleanupError],
		'The diagnostic failed and its task cleanup was not fully confirmed.',
	);
}

export async function grantTemporaryWorkspaceTask(request, source, target) {
	if (source.workspaceBasename !== 'repo-a' || target.workspaceBasename !== 'repo-b') {
		throw new Error('Explicit diagnostic grants are restricted to the two harness-created Workspaces.');
	}
	const snapshot = await request(source, 'snapshot', {}, 5_000);
	const matches = snapshot.policyCandidates?.filter((candidate) =>
		candidate.nodeId === target.nodeId && candidate.nodeInstanceId === target.nodeInstanceId
		&& candidate.workspaceName === 'repo-b' && candidate.self === false,
	) ?? [];
	if (matches.length !== 1 || typeof matches[0].windowLabel !== 'string'
		|| typeof matches[0].allowlisted !== 'boolean' || typeof matches[0].acceptsIncoming !== 'boolean') {
		throw new Error('The exact temporary target Workspace policy candidate is unavailable.');
	}
	const candidate = matches[0];
	const allow = (allowed) => request(source, 'peer.policy.allow', {
		windowLabel: candidate.windowLabel,
		nodeId: target.nodeId,
		nodeInstanceId: target.nodeInstanceId,
		allowed,
	}, 5_000);
	const receive = (enabled) => request(target, 'peer.policy.accept', { enabled }, 5_000);
	const restore = async () => {
		const failures = [];
		// Both mutations advance the shared policy revision; do not invalidate an in-flight action.
		for (const restorePolicy of [
			() => allow(candidate.allowlisted),
			() => receive(candidate.acceptsIncoming),
		]) {
			try { await restorePolicy(); }
			catch (error) { failures.push(error); }
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, 'Temporary Workspace grants could not be restored.');
		}
	};
	try {
		await receive(true);
		await allow(true);
		return restore;
	} catch (error) {
		try {
			await restore();
		} catch (cleanupError) {
			throw combineOperationAndCleanupError(error, cleanupError);
		}
		throw error;
	}
}
