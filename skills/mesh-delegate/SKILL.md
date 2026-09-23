---
name: mesh-delegate
description: Delegate and coordinate bounded tasks across authorized VS Code windows, devices, and desktop-attached Codespaces using Copilot Agent Mesh.
disable-model-invocation: true
---

# Mesh delegation

Use this workflow as the source agent coordinating work through the six Mesh
tools. This skill does not create an agent, authorize a workspace, or replace
the tools. Use Agent mode with Mesh tools enabled. If the tools or required
target are unavailable, explain the blocker; do not simulate a delegation.

## Select an authorized target

1. Call `mesh_list_workers`. Use `scope: "local"` for same-device work,
   `"remote"` for paired devices, or `"all"` when both are needed.
2. Select the exact intended workspace from the returned directory. Prefer its
   `targetHandle`. Never invent IDs, infer authorization from a display name, or
   combine a handle with the legacy explicit routing IDs.
3. Refresh an expired handle or a partial directory rather than substituting a
   similarly named window. Listed targets are not proof of runtime availability.
   Ask the user to configure missing workspace permissions in the Dashboard;
   these tools cannot change account, connection, or authorization settings.

## Define a self-contained task

Give `mesh_delegate_task` a short title, a precise prompt, and explicit
`acceptanceCriteria`. Include:

- The objective and relevant context; the target does not inherit this chat.
- The intended files or subsystem, constraints, and non-goals.
- Reproduction details or source material the target needs and may access.
- Observable acceptance criteria and appropriate validation commands.
- The expected deliverable and the information to report back.

Do not transmit credentials or unrelated private material. Do not use Mesh for
Git, branch, worktree, commit, push, or pull request management. Do not request
recursive Mesh delegation.

The extension automatically includes its bundled `mesh-execute` guidance in
the authorized task prompt. Do not copy that skill or prefix the prompt with
`/mesh-execute`: raw AHP text is not a Chat slash command. The prompt including
that guidance must fit the 128 KiB UTF-8 limit; shorten oversized task context
instead of dropping the execution guidance.

## Submit and track

- For one task, use `mode: "wait"` (the default). It waits for completion,
  required input, failure, or cancellation.
- For independent work on several targets, submit one bounded task per target
  with `mode: "submit"`, preserve each returned task ID, then call
  `mesh_get_task` with `waitFor: "outcome"`. There is no broadcast operation.
  Respect each workspace's execution lease; do not overlap dependent changes.
- `accepted` is not `completed`. Inspect `outcome`, `taskState`, and
  `nextAction`; a successful status query is not proof of successful execution.
  In compact results preserve `t` (task ID) and `d` (delegation request ID):
  `s=0` completed, `s=1` input needed, `s=2` failed call, `s=3` cancelled call,
  and `s=4` accepted. A failed/cancelled call does not by itself establish the
  task's terminal state.
- Prefer event-driven `mesh_get_task(waitFor: "outcome")` or `"change"` over
  snapshot polling. If a bounded wait expires, inspect its last-read status
  and resume waiting on the same task when appropriate; do not resubmit it.
- Execution defaults to and is capped at 60 minutes. Get/wait has its own
  `waitSeconds` budget and does not extend the execution deadline.

## Handle input, recovery, and cancellation

- For `needsInput`, use the exact `taskId` and `inputId` from the latest result
  (`t`/`i` in compact output). Present the question or approval request to the
  user when their decision is required. Never infer approval from task scope.
- Answer with `mesh_answer_task`, preserving a stable `answerId` for an exact
  retry. Then wait on the same task; an answer receipt is not completion.
- Recover lost IDs with `mesh_list_tasks`. Its states are last-known cached
  values; confirm current state with `mesh_get_task`. Task ownership belongs
  to this authenticated window, not merely to a repository with the same name.
- Omit `delegationRequestId` for fresh work. Reuse it only for an exact retry
  with unchanged target, continuation, title, prompt, criteria, and timeout.
  An `IDEMPOTENCY_CONFLICT` is not permission to start replacement work.
- Use `mesh_cancel_task` when cancellation is intended, then observe the
  authoritative outcome. `cancelling` is not confirmed `cancelled`. Stopping
  Chat after submit returns, or stopping a read-only get/wait, leaves the task
  running. Stopping a delegate wait requests cancellation instead.

## Continue and report

To continue an owned completed task in its retained live session, supply
`continueFromTaskId` and the same exact target with a fresh delegation request
ID (or omit that ID). This creates a new task and turn, not a retry or a fork.
If that session is unavailable, busy, or incompatible, report the failure;
do not silently replace it with a new session. For pending input, answer the
existing task instead.

Assess the returned work against the acceptance criteria. Report what was
actually completed, supporting evidence and validation, unresolved questions,
and any remaining running tasks. Distinguish the host's completed turn from
successful fulfillment of every acceptance criterion.
