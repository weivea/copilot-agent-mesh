# Production Language Model Tools

The MVP tool surface is implemented in `src/tools` and remains decoupled through
`TaskToolFacade`. Production composition supplies a local Broker facade backed
by persisted task state; the tool classes never
create tasks, simulate workers, inspect workspace files, or manage repository
state.

## Tool surface

| Tool | Behavior | Application deadline |
| --- | --- | ---: |
| `mesh_list_workers` | Returns bounded peer capability and opaque workspace metadata. | 5 s |
| `mesh_delegate_task` | Persists an intent, waits for durable broker acceptance, then returns `pending` before Agent startup completes. | 15 s |
| `mesh_get_task` | Returns a bounded snapshot, event cursor, event-gap indicator, and truncation indicator. | 10 s |
| `mesh_cancel_task` | Requests cancellation through the owner-scoped Facade method. | 10 s |
| `mesh_answer_task` | Sends an idempotent answer through the owner-scoped Facade method. | 10 s |

`prepareInvocation` is pure. Delegate confirmation displays only peer ID,
opaque workspace ID, and title summary. It never persists an intent or contacts
a worker.

All inputs are checked again at runtime with exact object properties and UTF-8
byte limits. Facade output is parsed through a strict allowlist before it can
reach a model. Unknown exceptions become a fixed safe text error and never
expose paths, credentials, process details, or stacks. Results are compact JSON
inside one `LanguageModelTextPart`; list and get results truncate bounded data
rather than returning raw transcripts. When VS Code supplies
`tokenizationOptions`, the adapter uses its model-specific `countTokens`
function and shrinks events, worker lists, and optional snapshot fields to the
actual token budget. If even the smallest JSON result does not fit, the adapter
returns an empty `LanguageModelTextPart` rather than exceeding the budget.

Task event sequences are positive and strictly contiguous. The cursor always
equals the last returned event sequence, or the requested `after` cursor when no
events are returned, including truncated windows. Dropping leading events for
byte or token budgets creates or advances `eventGap.expectedFrom` and
`eventGap.availableFrom`; only this explicit gap/truncation contract explains a
missing prefix. A bare `truncated` flag never substitutes for gap metadata.

Snapshots accept Foundation's recoverable pending-input state, but
`mesh_answer_task` remains exposed only while the task is `needsInput`.
Terminal and all other states reject pending input. `failed` and `timedOut`
snapshots require bounded failure details (`code`, message up to 2 KiB, and
`retryable`); every other state forbids them. Output shrinking may omit the
message but preserves the stable code and retryability.

Every peer, workspace, delegation, task, input, answer, and artifact identifier
is a canonical lowercase UUID (`8-4-4-4-12` hexadecimal form). Runtime parsing
rejects uppercase, escaped control characters, suffixes, and arbitrary opaque
strings, so identifier JSON size is fixed and matches the domain foundation.
Facade task responses are also bound to the requested task ID; a mismatched
snapshot or action receipt becomes `OUTPUT_INVALID`.

Under severe token pressure, delegation results use a state-preserving compact
wire form before any generic error or empty-text fallback:

| `s` | Meaning | Compact fields |
| ---: | --- | --- |
| `0` | Broker accepted; Agent startup is pending | `t` task ID, `d` delegation request ID |
| `1` | Caller wait ended; durable delegation needs reconciliation | `t`, `d`, `r:1` |
| `2` | Durable delegation error | `t`, `d`, `e` stable error code, `r` retry flag |
| `3` | Intent persistence is still pending and IDs are not available | `r:1` |

The keys are `s` state, `t` task ID, `d` delegation request ID, `e` error code,
and `r` retry/reconciliation flag. State is derived from the full result, never
inferred merely from the presence of both IDs. The pending and reconciliation
forms fit a 100-character budget with canonical UUIDs; a conflict error with
`r:0` fits 200 characters. If the matching compact form does not fit, the
result is empty text rather than a semantically different generic error.

Cancelling a `CancellationToken` aborts only the current Tool wait. In
particular, delegate cancellation or acknowledgement timeout does not call the
remote cancellation method. Once `persistDelegationIntent` resolves, the result
retains `delegationRequestId` and `taskId` so the durable task can be polled or
explicitly cancelled.

`mesh_delegate_task` accepts an optional `delegationRequestId`. Omit it for a
new user invocation; the Tool generates and returns a fresh ID. Reuse that ID
only for an automatic retry of the exact same payload. An explicit exact retry
recovers the same task whether acknowledgement was lost or the task is still
in flight, while a fresh invocation creates a new task even when a terminal
historical intent has identical semantics.

The delegate's 15-second budget covers both durable intent persistence and the
broker acceptance wait. Agent startup continues asynchronously and is observed
through `mesh_get_task`. Persistence itself is deliberately not given an abort
signal: if the caller budget or cancellation wins first, the durable promise
continues in the background and the Tool returns `pending`,
`reconciliationPending: true`, and `retrySameIntent: true`. Retrying the exact
intent with the returned `delegationRequestId` lets the Facade recover the IDs
after persistence completes instead of creating another task.

## Facade integration

`TaskToolFacade` is the production seam for the future `TaskCoordinator` and
`PeerManager` adapters:

```ts
interface TaskToolFacade {
  listWorkers(signal: AbortSignal): Promise<MeshWorkerDirectorySnapshot>;
  persistDelegationIntent(intent: DelegationIntentInput): Promise<PersistedDelegationIntent>;
  waitForDelegationAcceptance(ids: {
    delegationRequestId: string;
    taskId: string;
  }, signal: AbortSignal): Promise<DelegationAcceptance>;
  getTask(request: {
    taskId: string;
    afterEventSequence?: number;
    maxEvents: number;
  }, signal: AbortSignal): Promise<TaskToolReadResult>;
  cancelOwnedTask(request: { taskId: string }, signal: AbortSignal): Promise<TaskActionReceipt>;
  answerOwnedTask(request: {
    taskId: string;
    inputId: string;
    answerId: string;
    answer: string;
  }, signal: AbortSignal): Promise<TaskActionReceipt>;
}
```

The persistence method must durably allocate both IDs before resolving and must
recover the same IDs for an exact retry carrying the same `delegationRequestId`.
Historical semantic hashes are retained for audit and conflict detection, not
used as a global deduplication key. Aborting the acceptance signal stops
only that acknowledgement wait. Ownership is taken from the Facade's
authenticated coordinator context, never from tool input.

## Parent-session wiring

Copy the five objects exported as `MESH_TOOL_MANIFEST_DESCRIPTORS` into
`package.json.contributes.languageModelTools`. Register the same names by
calling `registerMeshTaskTools(taskFacade)` during activation. The exported
`assertMeshToolNameParity` and `getMeshColdActivationContract` helpers support
manifest/runtime parity and cold implicit activation tests.

`applyMeshToolManifestDescriptors(packageJson)` returns a mechanically updated
manifest that preserves unrelated tools, replaces stale production entries,
and removes the Phase 0 `mesh_spike_echo` descriptor.
`verifyMeshToolManifestDescriptors(packageJson)` reports missing/mismatched
production descriptors and whether the legacy spike is still present.

### Phase 0 spike migration

The `66b2954` baseline still imports and registers `registerMeshSpikeEchoTool`
from `src/extension.ts` and contributes `mesh_spike_echo` from `package.json`.
The parent integration must remove both legacy registration points when it
installs the eight production descriptors and calls
`registerMeshTaskTools(realFacade)`. Do not register the spike alongside the
production tools: it owns an in-memory simulated task lifecycle and is retained
only as isolated Phase 0 evidence under the spike-specific source and docs.
