# MVP integration contracts

This document records the contract shared by the merged Foundation, Tools, and
Dashboard modules. Gateway and Dev Tunnel lifecycle behavior is unchanged.

## Task snapshots

- Task states are the Foundation states: `accepted`, `startingAgent`, `running`,
  `needsInput`, `recovering`, `cancelling`, `completed`, `failed`, `cancelled`,
  and `timedOut`.
- `pendingInput` is valid only for `needsInput` and `recovering`. Only
  `needsInput` exposes the answer action; recovery retains data without making
  it answerable.
- `failure` is required for `failed` and `timedOut` and forbidden otherwise.
  Its code is stable, its message is at most 2 KiB UTF-8, and `retryable`
  survives output shrinking even when the message does not.
- Foundation permits a 16 KiB UTF-8 terminal summary. Dashboard presentation
  truncates only that field at a valid UTF-8 boundary to its 2 KiB UI limit and
  sets `summaryTruncated`; it does not reject the complete snapshot.

## Tool event windows

- Event sequences are positive integers and strictly contiguous.
- For an untruncated response, `eventCursor` is the last returned sequence, or
  the requested `afterEventSequence` when no events are returned.
- A source journal gap or output byte/token truncation that removes leading
  events is represented by `eventGap.expectedFrom` and
  `eventGap.availableFrom`. The response also sets `truncated`; a bare
  truncation flag never substitutes for the gap.

## Dashboard safety

- Query keys and values are inspected with form-urlencoded `+` normalization
  before recursive decoding. Bracketed and compound credential keys, including
  `credentials[password]` and `api+key`, are rejected.
- The ViewModel is shape-checked against every Foundation task state and every
  displayed string is independently bounded by UTF-8 bytes.

## Workspace availability

- A missing or inaccessible canonical path marks only that local workspace
  record `stale` and disabled. `workspace.list` continues with the remaining
  records.
- Stale workspaces cannot acquire leases. An unleased stale record can be
  removed.
- Availability does not automatically clear stale state. The user must
  explicitly revalidate or register the workspace, then enable it.
