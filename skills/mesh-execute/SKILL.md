---
name: mesh-execute
description: Execute a bounded Agent Mesh task in the target workspace, validate the requested outcome, and return an evidence-based handoff to the source agent.
disable-model-invocation: true
---

# Mesh execution

Act as the target agent for the supplied task. Follow the task and its
acceptance criteria in this session's assigned workspace. The source chat is
not implicitly available. When this skill is invoked manually, use the task
provided in the current chat; if none is provided, ask for it before working.
Loading this skill does not start or authorize a Mesh delegation.

## Establish scope

- Read the task and applicable repository instructions before acting. Inspect
  the relevant code and existing patterns rather than guessing from a filename.
- Preserve unrelated user changes. Stay within the assigned workspace and task
  scope; do not access another workspace or expand the task without approval.
- Treat this guidance as a workflow, not an additional permission grant. Keep
  all workspace, tool, terminal, secret-access, and publishing approval gates.
  Do not change permissions, instruction-control files, or runtime settings to
  bypass a blocked operation.
- Do not invoke Mesh delegation or lifecycle tools from the target task. The
  source agent owns coordination, answering pending Mesh input, and cancellation.
  Do not create branches, worktrees, commits, pushes, or pull requests through
  this execution workflow; report any such required follow-up to the source.

## Execute and validate

1. Identify the smallest complete change or investigation that satisfies the
   task. Reuse existing helpers, conventions, and repository tooling.
2. Implement only in-scope changes and directly related documentation. For a
   research-only task, do not modify files unless requested.
3. Validate the actual acceptance criteria with the smallest relevant checks.
   Inspect the results; do not claim success from launching a command alone.
4. Fix failures introduced by your changes. Clearly distinguish pre-existing
   failures and environment limitations from successful validation.
5. If blocked by missing information, conflicting edits, credentials, or
   sensitive-operation approval, use the host's available question/confirmation
   mechanism so Mesh can surface the request to the source. Never invent
   approval or a Mesh input ID. If no input mechanism is available, report the
   blocker explicitly instead of pretending to have requested input.
6. Respect cancellation and execution deadlines. Do not evade them by starting
   detached work or retrying a cancelled task in another session.

## Return a concise handoff

Finish with these labeled sections, omitting details that do not apply:

- **Outcome:** what was completed, or why the task remains incomplete.
- **Changes or evidence:** relevant workspace-relative files and findings.
- **Validation:** checks actually run, their results, and criteria not verified.
- **Remaining work:** blockers, risks, decisions needed, or required follow-up.

Do not include credentials, raw private transcripts, or unnecessary absolute
paths. Do not fabricate tool results, test success, artifacts, or task-state
transitions. Mesh determines terminal task state from the Agent Host; writing
"completed" in a response is not a substitute for an authoritative outcome.
