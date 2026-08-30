# MVP Foundation

This foundation defines the runtime protocol boundary, task state machine, local
workspace policy, and recovery storage used by later Gateway, peer, Agent Host,
tool, and dashboard layers. It intentionally does not provide a fake agent
runtime and does not inspect or control Git.

## Runtime boundaries

- The extension runs in the local UI extension host (`extensionKind: ui`).
- `LocalDesktopWorkspaceGuard.assertAllowed()` rejects remote extension hosts,
  untrusted workspaces, missing workspace folders, virtual folders, and mixed
  file/non-file workspaces with stable Mesh error codes.
- Network, persistence, and Webview inputs use strict Zod 4 schemas and
  `safeParse`. JSON-RPC batches, unknown methods, unknown authorization fields,
  prototype-pollution shapes, and values over their UTF-8 byte limits are
  rejected. Generic JSON values use an iterative validator capped at 128 levels
  and 65,536 nodes, so adversarial nesting cannot overflow the call stack.
- `shared/protocol.ts` remains a compatibility export while runtime schemas live
  under `shared/protocol/`.
- Local workspace URIs and canonical filesystem identities exist only in
  `WorkspaceRegistry` persisted state. `WorkspaceSummary`, task snapshots, and
  Webview schemas expose opaque `workspaceId` values and have no local path,
  URI, or lease-key field.

## Task invariants

Worker tasks start in `accepted`. Active states are `accepted`,
`startingAgent`, `running`, `needsInput`, `recovering`, and `cancelling`.
Terminal states are `completed`, `failed`, `cancelled`, and `timedOut`.

- `taskReducer` is the only state transition function and does no I/O.
- Every active state can become `failed` or `timedOut`.
- Terminal records are immutable.
- Cancel and answer retries are idempotent. A completion arriving after
  cancellation begins cannot overwrite `cancelling`.
- Pending input survives agent recovery, but is cleared whenever the task
  leaves `needsInput` for a non-answerable state.
- Persisted records and snapshots require cancellation deadlines only for
  `cancelling`/`cancelled`, failure details only for `failed`/`timedOut`, and a
  summary for `completed`. `task.completed` notifications carry a terminal
  snapshot whose task ID, sequence, timestamp, and failure exactly match the
  outer notification.
- Task access is scoped to the authenticated owner. A different peer receives
  the same `TASK_NOT_FOUND` result as a missing task.
- Workspace leases are owned by the compound `(peerId, taskId)` identity, so
  equal task IDs from different peers cannot acquire or release each other's
  lease.
- Source Broker start idempotency is scoped by stable source Workspace identity
  and `delegationRequestId`; exact semantic retries reuse the same `taskId`.
  Reuse with a different canonical hash returns `IDEMPOTENCY_CONFLICT`.
  Authenticated Worker ownership remains peer-scoped, and a true task-ID
  ownership collision returns `TASK_ID_CONFLICT`.
- The canonical hash uses UTF-8 byte-length-prefixed semantic fields. Prompt,
  title, and acceptance criteria are not trimmed, line-ending-normalized, or
  otherwise rewritten.
- UUID inputs are canonicalized to lowercase before hashing, ownership checks,
  idempotency matching, and task filename construction.

## Storage and recovery

`DeviceProfileStore` and `WorkspaceRegistry` use only the injected state
adapter's `get` and `update` operations. They never call `setKeysForSync`.
Device IDs remain stable across reloads and renames. Workspace IDs are generated
opaque identifiers. Workspace registration lexically normalizes file URIs, then
uses an injected `FileIdentityResolver` to resolve aliases and symbolic links.
The resolver's canonical filesystem identity is the deduplication and lease key.
Every live list, resolution, registration, enable/disable, removal, and lease
acquisition revalidates that identity. Identity changes replace an unleased
record or disable a leased/colliding record. If `realpath` or `stat` reports that
a workspace is missing or inaccessible, its local record becomes sticky
`stale`/disabled state. Other workspaces remain listable, stale workspaces cannot
be leased, and an unleased stale record can be removed. A path becoming
accessible again does not silently reactivate it: `revalidate` or `register`
must explicitly clear stale state before it can be enabled. Revalidation and
lease acquisition are atomic under the same mutation queue, so an old and new
identity cannot both be leased through the registry.
Registering a different reachable URI that resolves to the same stale identity
refreshes the existing record's registered and canonical URIs and clears its
stale marker, while preserving disabled state until an explicit enable.

`AtomicFileStore` uses a temporary file, file sync, atomic rename, and directory
sync where the platform supports it. New directories are created one level at a
time below the owned storage root, and each new directory entry is persisted by
syncing only its owned parent; ancestors outside the storage root are untouched.
If that parent sync fails, the newly created empty directory is removed so a
retry must recreate and sync it; if rollback also fails, the store remembers
the unsynced entry and forces its parent sync on retry. Writes are serialized
in process.
`FileTaskStore` validates every task record, serializes read-modify-write
transitions, and stores one peer-namespaced task file per task. These task files
are the recovery authority; in-memory workspace leases are rebuilt from active
records. A corrupt record fails recovery explicitly rather than producing an
empty or successful-looking result.

Task event journals retain a contiguous suffix for at most 24 hours and 640 KiB
of serialized UTF-8 JSON, reserving headroom for the task snapshot and JSON-RPC
envelope within the 1 MiB frame. Truncation updates
`earliestAvailableEventSeq` and `eventsTruncated`; an individually oversized
event is dropped together with all older events so gap reporting remains
unambiguous. Every task read API applies retention with the injected clock and
atomically rewrites a changed journal, including terminal tasks that receive no
later transitions.

`workspace.list` is limited to 32 entries and validates its complete serialized
JSON-RPC response against the 1 MiB frame limit.

Persisted task records contain identifiers, owner, workspace, canonical request
hash, state, bounded summaries/events, and recovery metadata. They do not
contain the full prompt or raw output by default.

## Foundation interfaces

| Interface | Purpose |
| --- | --- |
| `Clock` | Injectable current time |
| `IdGenerator` | Injectable UUID/opaque ID generation |
| `StateStore` | Non-secret local state without Settings Sync |
| `AtomicFileSystem` | Injectable filesystem operations for atomic replacement |
| `FileIdentityResolver` / `NodeFileIdentityResolver` | Injectable canonical URI and filesystem identity resolution |
| `LocalDesktopWorkspaceGuard` | Reusable runtime entry-point policy |
| `DeviceProfileStore` | Stable local device identity |
| `WorkspaceRegistry` | Local URI registry and opaque wire summaries |
| `WorkspaceRegistry.acquireLease` | Atomic identity revalidation and lease acquisition |
| `FileTaskStore` | Validated authoritative task persistence |
| `WorkspaceLeaseManager` | One active task per workspace and restart rebuild |
| `taskReducer` | Pure task transition function |
