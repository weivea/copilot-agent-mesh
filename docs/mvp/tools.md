# Production Language Model Tools

The MVP tool surface is implemented in `src/tools` and remains decoupled through
`TaskToolFacade`. Production composition supplies a local Broker facade backed
by persisted task state; the tool classes never
create tasks, simulate workers, inspect workspace files, or manage repository
state.

## Tool surface

| Tool | Behavior | Application deadline |
| --- | --- | ---: |
| `mesh_list_workers` | Returns bounded peer capability and opaque workspace metadata; same-device Window Nodes are visible only after the directional double authorization gate. | 5 s |
| `mesh_delegate_task` | Starts or reconciles one durable task, then remains pending until an authoritative completed, needs-input, failed, or cancelled state. | 60 min maximum |
| `mesh_get_task` | Returns a bounded snapshot, event cursor, event-gap indicator, and truncation indicator for abnormal interruption recovery or another task. | 10 s |
| `mesh_cancel_task` | Requests cancellation through the owner-scoped Facade method. | 10 s |
| `mesh_answer_task` | Sends an idempotent answer through the owner-scoped Facade method. | 10 s |

`prepareInvocation` is side-effect free. Delegate confirmation resolves safe
Window and Workspace display names and includes a bounded title summary,
one-task scope, the structured in-Workspace file changes eligible for automatic
approval, the terminal and sensitive categories that still require input, and
the 60-minute maximum. It
never displays IDs, paths, the raw prompt, or secrets, and it never persists an
intent or contacts a worker. P5 never treats a working directory or arbitrary
tool prose as proof that a terminal command is confined to the Workspace.

Same-device peer delegation is default-off behind
`copilotAgentMesh.experimental.peerDelegation`. When enabled, a local target is
listed only when its sole workspace is online and claimed, its
`acceptsIncoming` policy is on, and every claimed source workspace allowlists
the target's stable `workspaceIdentity`. Labels and workspace display names do
not participate in authorization or routing. `node.task.start` repeats the same
checks immediately before route lease acquisition. Direct starts distinguish
`PEER_NOT_ALLOWED`, `PEER_NOT_ACCEPTING`, `PEER_OFFLINE`, and
`PEER_MULTI_WORKSPACE`; the filtered list never reveals which failed gate hid a
candidate.

Policy configuration uses a separate authenticated RPC surface. A multi-root
window may pass one of its own claimed `workspaceIdentity` values to
`node.policy.get` to read and update each policy independently; the Broker
rejects foreign identities. This selector never changes Tool source
authorization, which remains derived from the registered Window Node.

Window rename uses the same authenticated policy surface. Names are validated
in length/character/path, secret-shape, then folded-uniqueness order. The Store
performs uniqueness validation and partial-policy persistence in one
generation-fenced serialized mutation; normalized or case-insensitive conflicts
return `WINDOW_NAME_CONFLICT`, while invalid values return
`WINDOW_NAME_INVALID`. Authorized directories, Dashboard directories, and
task-source display labels reuse `windowNodeDescriptor.label` with stored name,
safe Workspace display name, then short node ID fallback. Claimed Workspace
fallbacks participate in uniqueness: explicit names win, duplicate fallbacks
deterministically use a short ID, and user renames that collide with any
effective name fail without suffixing. Structurally valid P2 schema-v1 policy
files are generation-fenced into the current safe fold while preserving gates;
malformed or unknown data still fails. Labels never affect authorization, route
identity, Lease ownership, or Task ownership.

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
| `0` | Authoritative completion | `t` task ID, `d` delegation request ID, `r` bounded structured result |
| `1` | Authoritative input request | `t`, `d`, `i` input ID, `q` bounded question |
| `2` | Authoritative failure or start/reconciliation failure after identity allocation | `t`, `d`, `e` stable error code |
| `3` | Authoritative cancellation | `t`, `d`, `e` stable error code, `x` = `token`, `budget`, or `peer` |

The branch-specific fields are exact: `r` appears only for completion; `i` and
`q` only for needs-input; and `x` only for cancellation. Every compact branch
preserves `t` and `d`. Questions, result summaries, and error text normalize benign multiline
whitespace, redact unsafe path/control spans, and remain bounded before token
contraction. A field containing a recognized credential assignment or bearer
credential is redacted in full before whitespace normalization, so continuation
text cannot escape the credential boundary; otherwise safe surrounding content
is retained. Valid percent-encoded credential-free prose remains available for
inspection. Malformed, undecodable, or excessively nested percent encoding fails
closed by redacting the full field, because it can otherwise split a credential
key from its value. Every decoded form also removes C0, C1, and Unicode format
controls for credential-key inspection, preventing encoded controls from splitting
a key. Credential assignment parsing examines a bounded candidate before `=` or
`:`, treats clear ASCII punctuation as structural boundaries, and normalizes
wrapper quotes, apostrophes, key whitespace, separators, and inserted Unicode
marks, symbols, controls, private-use/surrogate code points, separators, and
default-ignorables away from ASCII alphanumerics. This catches variation selectors,
combining marks, fillers, visible emoji, quoted-key, and spaced-key obfuscation.
Ordinary Unicode letters, numbers, and punctuation remain structural prose
boundaries, so international labels are not collapsed into credential keys.
Ordinary valid percent-encoded prose remains available. Canonical inspection is
bounded to a fixed number of linear decode
passes. Assignment parsing makes one forward pass with rolling normalized key
state capped at 256 code units, so long runs of ignored filler cannot exhaust a
backward-search budget or introduce quadratic rescans. Byte-budget
contraction always preserves `t` and `d`; if a completed or needs-input payload
cannot fit, it becomes exact compact failure
`{s:2,t,d,e:"OUTPUT_TOO_LARGE"}` rather than an identity-free generic result.

Cancelling a VS Code `CancellationToken` sends exactly one task cancellation
request and continues waiting for an authoritative cancelled or failed state.
The single 60-minute budget timer uses the same rule. If authoritative
completion wins before cancellation acceptance it remains completion; after
cancellation acceptance it cannot be reported as successful. Independent peer
cancellation is reported separately.

`mesh_delegate_task` accepts an optional `delegationRequestId`. Omit it for a
new user invocation; the Tool generates and returns a fresh ID. Reuse that ID
only for an automatic retry of the exact same payload. An explicit exact retry
recovers the same task whether acknowledgement was lost or the task is still
in flight, while a fresh invocation creates a new task even when a terminal
historical intent has identical semantics.

The idempotency key is stable source Workspace scope identity plus
`delegationRequestId`; a single claimed source uses its Workspace identity and
multiple claimed sources use their sorted canonical set hash. Active editor,
display names, and Window Node instance IDs do not define the scope. P2
authorization still checks every claimed source Workspace separately. Exact
retries reuse the task ID and never restart an accepted task.
Changing target, title, prompt, criteria, or timeout returns
`IDEMPOTENCY_CONFLICT`. Broker generation takeover restores the persisted route
mapping before accepting another start.

The delegate subscribes before starting or reconciling the task, so an immediate
terminal event cannot be lost. It uses Broker-published authoritative snapshots,
not snapshot polling loops. `mesh_get_task` remains available for abnormal Tool
host interruption and explicit tracking of another task, but normal delegation
does not poll it.

## Facade integration

`TaskToolFacade` is the production seam for the future `TaskCoordinator` and
`PeerManager` adapters:

```ts
interface TaskToolFacade {
  listWorkers(signal: AbortSignal): Promise<MeshWorkerDirectorySnapshot>;
  identifyDelegation(intent: DelegationIntentInput): DelegationIdentity;
  describeDelegationTarget(intent: DelegationIntentInput, signal: AbortSignal): Promise<DelegationTargetDisplay>;
  subscribeToTask(taskId: string, listener: (snapshot: TaskToolSnapshot) => void, onError: (error: unknown) => void): TaskSnapshotSubscription;
  persistDelegationIntent(intent: DelegationIntentInput): Promise<PersistedDelegationIntent>;
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
used as a global deduplication key. Ownership and source Workspace provenance
come from the Facade's authenticated coordinator context, never from display
labels or caller-supplied Tool input.

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
