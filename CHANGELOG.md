# Change Log

All notable changes to the "copilot-agent-mesh" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.4.0 Preview] - 2026-08-31

- Documented the 0.4.0 Peer Window Delegation redesign. Same-device multi-project
  collaboration moves from the Dashboard-driven fixed frontend/backend DAG to
  Copilot Chat driven peer window delegation: each window is its own primary node,
  authorizes peers through a directional workspace allowlist plus a receive-side
  "accept incoming tasks" gate, can be renamed for human reference, and delegates
  through the existing five Mesh Tools. See
  `docs/0.4.0-peer-delegation-requirements.md`.
- Documented the 0.4.0 technical design covering the Broker-owned peer policy
  store, double authorization gate and distinguishable error codes, long-running
  `mesh_delegate_task` with authoritative terminal outcomes, per-task delegation
  grants, recursion prevention, Dashboard rework, and the test matrix. See
  `docs/0.4.0-peer-delegation-design.md`.
- Added the Editor Agent Host Endpoint spike. A running VS Code instance exposes a
  `type: "editor"` AHP endpoint over a Unix socket that negotiates protocol
  `1.0.0`, reuses the signed-in Copilot identity, and lists the user's real chat
  sessions. This replaces the isolated standalone host as the preferred runtime
  source and makes child-task visibility in the target window plausible; the
  standalone launcher stays as an explicitly degraded fallback. See
  `docs/spikes/editor-agent-host.md`.
- Recorded that the stable VS Code tool confirmation surface offers only
  Continue/Cancel, so delegation authorization is a binary confirmation whose scope
  is stated in the confirmation body rather than a third button.
- Removed the 0.3.0 Collaboration service, fixed DAG, three collaboration tools,
  and Dashboard collaboration entry points while retaining the bounded Artifact
  Store and all Device Broker, Window Node, task, lease, IPC, and recovery
  foundations.
- Implemented the Broker-owned directional peer policy, default-off receive gate,
  safe window naming, double-gated Tool directory, distinguishable peer errors,
  long-running delegation result, one-task grant, recursion defense, editor AHP
  source preference, and P7 Dashboard configuration/task views.
- Added `MESH_PEER_DELEGATION_E2E=1 npm run test:peer-delegation-real`.
  The command launches two ordinary same-profile windows only after the exact
  opt-in, invokes the five registered LM Tools rather than replacing them with
  Broker calls, records real AHP and cleanup observations, and fails rather than
  treating missing Copilot UI/authentication evidence as Pass.
- Added a strict 0.4.0 evidence schema and release validator. Evidence rejects
  paths, tokens, raw prompts/output, full Workspace identities, malformed
  references, success-shaped incomplete results, and global-process-zero claims;
  it records only harness-owned baseline/delta/final resources.
- Recorded an honest real P8 objective run on VS Code 1.135.0/macOS arm64:
  AC-5 items 1-4, 8, and 10-12 were observed, including both peer rejection
  codes, directionality, Incoming, no Listener/Tunnel access, and complete
  cleanup. The disposable profile degraded to standalone and stopped at
  `AGENT_AUTH_REQUIRED`; UI/editor completion and the remaining items stay
  Unverified rather than being converted to Pass.
- Hardened final-stack lifecycle edges: an editor attempt with failed cleanup no
  longer starts a concurrent standalone fallback, selector disposal can retry,
  and a fast historical terminal notification cannot mask a retry's
  `IDEMPOTENCY_CONFLICT`.
- Hardened P8 evidence failure handling and persistent-profile ownership:
  nonterminal Broker states normalize to `not-observed`, strict schema/safety
  failures retain a separately validated diagnostic artifact, and shared
  persistent User Data/global-storage paths never confer process kill ownership.
  Lock/idle conflicts leave foreign profile users alive and perform zero
  termination attempts.
- Made internal E2E fixture mode permanently ineligible for release evidence:
  it requires an isolated artifact directory, records actual process platform
  plus `testMode: true` in a separately typed test diagnostic, and is rejected
  by both normal and `--require-pass` release validation. Unsupported release
  platforms fail before touching existing evidence.
- Bumped the Preview extension and VSIX artifact to `0.4.0` while retaining AHP
  commit `f19dd8b3942d029744a3bdd31d830f9428e8ea47`, TypeScript client `0.9.0`,
  and protocol offer `1.0.0`.

## [0.3.0 Preview] - 2026-08-30

- Added a generation-fenced, durable `CollaborationRun` aggregate with explicit
  frontend/backend participants, task dependencies, idempotent request identity,
  blocked/input/terminal propagation, takeover reconciliation, and exact
  cancellation of active versus not-yet-started tasks.
- Added a Broker-owned immutable Artifact Store limited to bounded structured JSON
  media types. Artifacts carry producer run/task identity, explicit consumer task
  authorization, content length, SHA-256, revision, and atomic recovery; forbidden
  secrets, paths, raw logs, prompts, output, and transcripts fail closed.
- Added the same-device orchestration sequence: backend contract/implementation →
  frontend implementation consuming the exact contract artifact → backend and
  frontend validation → aggregate completion.
- Added `mesh_start_collaboration`, `mesh_get_collaboration`, and
  `mesh_cancel_collaboration`, including manifest/runtime parity, safe error codes,
  deadlines, confirmations, token contraction, and reuse of `mesh_answer_task`.
- Added a Preview-gated Dashboard Collaboration Runs surface with explicit role and
  workspace selection, task dependency/blocked/input/validation state, artifact
  metadata, and start/get/cancel/answer actions. Raw goals and artifact content
  never enter the webview.
- Added the explicitly gated `MESH_MULTI_PROJECT_E2E=1 npm run
  test:multi-project-real` harness for two ordinary VS Code windows, real AHP
  completion, exact artifact handoff, per-workspace validation, local-route
  isolation, and zero-residue cleanup evidence.
- Passed that gate on VS Code 1.135.0/macOS arm64. Evidence
  `99d16bac-1b46-470d-9c7d-b9ebb74d4352` records both authoritative completed
  turns, exact Artifact ID/media type/153-byte size/SHA-256 consumption, two
  passed validations, aggregate completion, no Listener/Tunnel use, released
  profile lock, and zero owned process/socket residue.
- Fixed Dashboard input handling so the pending Agent question is shown in the
  native Extension Host input box without crossing the webview message bus,
  answers are bound to the exact pending input ID, and common Chinese approval
  terms such as `继续`、`同意` and `批准` are accepted. Repeated identical
  confirmations now expose a short input-ID prefix and already queued requests
  continue in the same interaction, making successful answers visible. Answers
  now route through the Broker-owned Collaboration aggregate, so either current
  participant window can answer, and the run immediately clears stale
  `needsInput` after the underlying task resumes.
- Upgraded the production AHP client from the published 0.8.0 tarball to the
  TypeScript 0.9.0 client built from pinned upstream commit
  `f19dd8b3942d029744a3bdd31d830f9428e8ea47`, which negotiates AHP 1.0.0 with
  VS Code 1.135.0. The upstream source is an explicit Git submodule because this
  client revision is not yet tagged or published to npm. This is the newest
  upstream commit before `60706330` changed the offer to AHP 0.9.0, which is
  incompatible with the tested VS Code Host's `^1.0.0` requirement.
- Added an opt-in persistent real-E2E profile, guarded against overlap with real
  VS Code user-data directories, so an interactive GitHub session can be reused
  without changing the default disposable-profile behavior.
- Fixed AHP 1.0 provisional Session startup: the first turn is dispatched once
  the default Chat is available rather than deadlocking while waiting for
  `session/ready`. Extended only the bounded Broker-to-Node task-start request
  timeout so real Agent startup does not close the local IPC transport.
- Passed Gate G0 for the macOS arm64 Preview scope on VS Code 1.135.0. Evidence
  `2ab62a03-51ba-45ef-a01a-0e3829f7ae7c` records an authenticated real turn with
  `agentStarted`, five output events, `AgentTaskHandle.cancel()`, authoritative
  `cancelled`, and zero owned Tunnel/socket/Agent Host/VS Code process residue.

## [0.2.0 Preview] - 2026-08-25

- Added protocol v2; v1 peers are explicitly incompatible.
- Added one generation-fenced Device Broker owner for pairing, peer roots,
  Gateway/one Dev Tunnel, peer management, global task/delegation persistence,
  reducer events, remote routing, and the node registry. Non-owner windows remain
  active clients and shared writes are fenced.
- Added authenticated bounded local IPC over Unix sockets or Windows named pipes,
  including short hashed endpoints, owner-only Unix permissions, a shared
  SecretStorage key, nonce plus mutual HMAC, and takeover fencing.
- Added ordinary-window Window Nodes with process-lifetime random identities,
  heartbeats, canonical hashed workspace claims, and per-window real AHP runtime
  handles. Duplicate physical workspaces are conflict/read-only.
- Added the direct local route Window A → Broker → Window B → real AHP → Broker
  store → Window A without Dev Tunnel, plus Broker-routed remote v2 multiplexing.
- Added Device → Node → Workspace targeting to all five tools and the Dashboard;
  its view model excludes secrets, paths, and raw prompt/output.
- Added schema-v2 migration preserving the 0.1 device ID and v1 workspace/task
  data; unknown or corrupt versions fail closed.
- Verified same-user-data ordinary-window transport/lifecycle on VS Code 1.134.0
  macOS arm64. The opted-in AHP run passed infrastructure/lifecycle assertions but
  stopped at `AGENT_AUTH_REQUIRED`; authoritative AHP start/get/cancel/output
  remains unproven and G0 remains No-Go.
- Verified the real two-device v2 route over one Tunnel through durable acceptance
  and explicit `AGENT_AUTH_REQUIRED`, followed by exact Tunnel/profile/process cleanup.

## [0.1.0 Preview] - 2026-08-25

- Added a reproducible pre-release VSIX pipeline with a positive content allowlist, archive inspection, and isolated-profile activation smoke test.
- Added Linux, macOS, and Windows offline test/package CI; real Worker E2E remains explicitly opt-in and outside ordinary CI.
- Documented macOS arm64-only Worker hosting, Coordinator-only platforms, explicit AHP authentication mappings, and the exact user-supplied Dev Tunnel CLI `1.0.2030+fc9273aa0f`.
- Included runtime dependency notices and the AHP `0.8.0` MIT license without nesting its already bundled source tarball in the VSIX.
- Retained the Gate G0 **No-Go** status; this package does not claim full authenticated end-to-end support.
- Added production Gateway, pairing, Peer reconnect, Workspace registry, task state,
  persistence, recovery, and bounded backpressure.
- Added exact-build Dev Tunnel hosting with renewal, health/WSS readiness, restart, and
  exact-owned cleanup.
- Added the production Agent Host/AHP adapter with explicit authentication, Session,
  Chat, Terminal, Input, cancellation, and recovery boundaries.
- Replaced the Phase 0 echo tool with five production Mesh tools and an interactive
  Dashboard.
- Added a real two-instance E2E covering Tunnel, pairing, Workspace discovery,
  delegation, polling, authentication failure handling, and resource cleanup.