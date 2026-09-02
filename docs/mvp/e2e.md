# MVP real VS Code E2E

> Evidence date: 2026-08-31
> Development baseline: `d5555172b5b6d37200f24f351678adc9ab201593`
> Final platform: macOS arm64, VS Code `1.135.0`

## Opt-in boundary

### 0.4.0 Peer Window Delegation

The release gate is exact and default-off:

```sh
MESH_PEER_DELEGATION_E2E=1 npm run test:peer-delegation-real
```

Without the exact value `1`, the wrapper exits before compiling or launching VS
Code. An enabled run requires macOS arm64, creates two ordinary windows with one
dedicated User Data directory and two different temporary non-sensitive projects,
and removes only resources identified by its own root PIDs, descendants, and
unique runtime markers. A persistent authenticated profile is optional and must
be an explicit dedicated path outside real VS Code profiles:

```sh
MESH_PEER_DELEGATION_E2E=1 \
MESH_PEER_DELEGATION_E2E_PROFILE_DIR=$HOME/.mw-profile \
MESH_PEER_DELEGATION_E2E_AUTH_RESOURCE='https://api.github.com' \
MESH_PEER_DELEGATION_E2E_AUTH_PROVIDER='github' \
MESH_PEER_DELEGATION_E2E_AUTH_SCOPES_JSON='["read:user","user:email"]' \
npm run test:peer-delegation-real
```

The `AUTH_*` mapping above is retained for an owned standalone fallback only.
When the editor endpoint is selected, it reuses that editor Host's existing
identity and receives no proactive OAuth token injection. A later editor
authentication challenge fails explicitly and must be resolved in the editor
profile.

The persistent User Data remains the source of VS Code/Copilot authentication, but
it is not the Mesh state root for a peer-delegation run. After the development-only
E2E capability validates the environment/profile nonce and role, every Mesh
`globalState` key is projected through a fixed physical-key envelope containing
that run nonce. Both windows in one run share those envelopes; a later run treats
older envelopes as absent and overwrites the same bounded physical keys. Production
device, workspace catalog, route, delegation, pairing, peer, listener, and Tunnel
metadata remain untouched.

The Broker owner lock, local IPC identity root, tasks, artifacts, and peer policy
files live below the unique `<controlRoot>/broker` directory. Standalone Agent Host
state remains below `<controlRoot>/agent-host`. Cleanup removes the encompassing
owned run root. The harness never deletes the persistent extension global-storage
directory, edits its SQLite state directly, raises the 32-workspace limit, or evicts
production catalog entries.

The default visible phase uses the real Dashboard handle paths for policy and the
registered LM Tools for the passing Tool+Agent route. Diagnostics-only mode uses
the same production `TaskToolsCore`/Broker/Window Node/AHP path to collect
objective runtime evidence without pretending it had a parent Chat or
confirmation. The short budget override is armed only for the next minute-scale
delegation timer; ordinary Tool deadlines and the production default/maximum of
60 minutes are unchanged. No mock AHP, Fake Agent, synthetic terminal state, or
blocked/cancelled-as-completed result can pass.

Programmatic `vscode.lm.invokeTool` has no parent Chat identity and cannot prove
the required Copilot sidebar route. The exact enabled command therefore waits for
the visible Agent-mode phase by default. Setting
`MESH_PEER_DELEGATION_E2E_MANUAL_UI=0` is diagnostics-only and can never produce
passing confirmation evidence.

The harness prints one exact `#meshListWorkers` / `#meshDelegateTask` prompt. In
the named source window, submit it in Copilot Agent mode and click **Continue**
exactly once. After checking the target Chat Sessions list, record only the two
boolean observations with the printed command:

```sh
node scripts/e2e/peer-delegation/attest.mjs <run-id> confirmation-once session-visible
```

Use `session-not-visible` when that is the observed result. Without this phase,
AC-5 item 5 and UI visibility remain `unverified`, and the command exits nonzero.

Sanitized JSON and a short summary are written to:

- `artifacts/peer-delegation-e2e/evidence.json`
- `artifacts/peer-delegation-e2e/summary.md`

These generated artifacts are ignored rather than committed, matching the prior
real-E2E convention. `npm run validate:peer-delegation-evidence` rejects paths,
tokens, socket/User Data locations, full Workspace identities, raw prompts or
output, invalid evidence references, inconsistent Pass states, and any nonzero
harness-owned final resource count. Baseline, peak, and final counts all use the
harness ownership scope; unrelated global processes are neither counted nor a
global-zero assertion.

Cleanup runs as independent best-effort phases: process observation/termination,
log/sentinel diagnostics, profile-lock release, and exact run-root removal cannot
short-circuit one another. SIGINT/SIGTERM uses the same idempotent cleanup and
never performs a name-based or global process kill.

For a persistent profile, its User Data and extension global-storage paths are
observation-only and never appear in process ownership markers. A lock loser or
idle-check failure before child launch makes zero termination attempts and cannot
kill the winner/foreign profile user. Subprocess tests exercise both conflicts
with a live foreign sentinel.

The E2E-only standalone Agent Host stores its owned instance below the unique
per-run control directory, which puts a run marker in the detached process
arguments. Cleanup therefore continues to recognize an immediately reparented
Host without retaining historical PIDs or matching the shared profile.

Before controller readiness, the Extension Host may write only an allowlisted,
path-free startup code under the owned window control directory. The harness
validates its schema and freshness and includes the fixed safe diagnosis in a
controller timeout. Raw errors, profile paths, workspace names, and secrets are
never written to this diagnostic.

Before validating the complete evidence schema, the harness atomically writes a
separately validated minimal diagnostic envelope. If full schema or safety
validation fails, the diagnostic remains at the stable evidence path with the
original stable error code and `outcome: fail`. Active Broker task states are
normalized to `not-observed` rather than copied into terminal-only fields.
Verbose task journals are projected to at most 256 actual event observations;
`eventJournalTruncated` is explicit, milestone types retain their original
monotonic sequence numbers, and no synthetic events or renumbering is allowed.
The release command writes only to the stable artifact directory or an explicit
absolute directory outside the repository. A nested repository override is
rejected before compile or deletion, and log streams must open before a window
is spawned; later log failures are retained as cleanup failures.

`MESH_PEER_DELEGATION_E2E_TEST_MODE` is internal to subprocess tests. It cannot be
used through `npm run test:peer-delegation-real`, requires an isolated evidence
directory, records the actual process OS/architecture with `testMode: true`, and
emits only a `test-diagnostic` artifact. Both release validator modes reject that
artifact, and test mode cannot replace the stable release evidence file.

O1 is Pass only when, after Task terminal cleanup, a new editor connection sees the
task Session hash in `listSessions` with Idle/Error activity, no InProgress bit, and
no Archived bit, and the target UI is visibly observed. UI visibility remains a
separate user attestation and is never inferred from the catalog. The evidence records
`session/clientDetached` only after the original task handle has successfully closed
its subscriptions and AHP connection. Only then may a fresh independent connection
populate `catalogAfterTerminalCleanup`; Workspace lease release is not treated as
proof of Agent Host cleanup. O2 is Pass only
after a genuine 60-minute Copilot Tool call; shorter runs are recorded as
shorter-duration-only.
O3 remains non-guaranteed Tool choice, O4 remains undetectable concurrent user
Copilot edits, and O5 remains unsupported/unverified outside macOS arm64.
AC-5 item 9 is narrower than O1 but still cannot rely on source status alone:
it requires a Session resource echoed by the editor Host's subscription snapshot
or Session-channel action, plus its bounded hash and the editor endpoint
fingerprint. Equality between locally related `createSession` and recovery
values is not an independent check and cannot satisfy the item without that
Host-originated echo. If no Host echo is available, item 9 remains Unverified.
UI and post-task catalog observation are not required for item 9.

### Recorded P8 objective result

The 2026-09-01 diagnostics-only run on VS Code 1.135.0/macOS arm64 using the
existing dedicated profile with a full 32-entry production Workspace Catalog
produced a valid **Unverified** artifact rather than a false Pass:

- AC-5 1-4 passed: two ordinary windows, exactly one Broker, two distinct claim
  hashes, target absent before authorization, exact `PEER_NOT_ALLOWED` and
  `PEER_NOT_ACCEPTING`, target visible after both gates, and reverse direction
  absent; both Dashboard configuration lists contained both windows.
- AC-5 6 and 8-12 passed: the editor task emitted real
  `agentStarted`/output/`turnComplete`/`completed`, the Host echoed the created
  Session channel, the target had an Incoming record,
  Listener/Tunnel attempt deltas stayed zero, the Workspace lease and Profile
  Lock were released, and final harness-owned VS Code/Agent
  Host/Tunnel/socket/timer counts were zero.
- The run-scoped Mesh state reached both windows without reading or evicting that
  production Catalog. The authenticated run used the live editor source and
  passed real needs-input answer/resume, authoritative token cancellation, and
  the 10-second harness-budget cancellation. The post-task editor catalog
  remained empty and no user UI attestation was supplied, so AC-5 5 and 7 plus
  O1 for that pre-fix run remain Unverified. It exposed a lifecycle race: a
  terminal Chat could precede provisional Session materialization, so skipping
  `disposeSession` alone did not prove retention. O2 also remains Unverified because the observed editor
  invocation was about 87 seconds, not a 60-minute Copilot UI call.
- No user attestation was created. The full UI rerun still requires the exact
  enabled command, a signed-in dedicated profile, one visible Agent-mode Tool
  confirmation, and an honest `session-visible`/`session-not-visible` attestation.

The default `npm test` remains offline. The real test is explicit because it creates a
public Dev Tunnel and may consume Copilot quota:

```sh
MESH_TWO_DEVICE_E2E=1 npm run test:two-instance-real
```

The same-user-data multi-window test is a separate explicit command. Its default mode
launches real ordinary VS Code windows and covers local transport/lifecycle without
starting Agent Host or consuming quota:

```sh
npm run test:multi-window-real
```

On macOS, VS Code limits its main Unix-domain socket path to 103 UTF-8 bytes. If
the checkout path is too long, set `MESH_MULTI_WINDOW_E2E_RUNTIME_DIR` to a short
absolute directory outside `/tmp` and `/var/tmp`; the harness creates and removes
only its unique `mw-<run>` child there.

```sh
MESH_MULTI_WINDOW_E2E_RUNTIME_DIR=$HOME/.mw npm run test:multi-window-real
```

To add the production AHP task/cancellation path:

```sh
MESH_MULTI_WINDOW_E2E_TASKS=1 npm run test:multi-window-real
```

Optional authentication mapping uses
`MESH_MULTI_WINDOW_E2E_AUTH_RESOURCE`,
`MESH_MULTI_WINDOW_E2E_AUTH_PROVIDER`, and
`MESH_MULTI_WINDOW_E2E_AUTH_SCOPES_JSON`. An exact `AGENT_AUTH_REQUIRED` result is recorded as blocked when the mapping or
silent session is unavailable; the harness then records no authoritative
start/get/cancel/output evidence.

`MESH_MULTI_WINDOW_E2E_PROFILE_DIR` is an explicit opt-in persistent profile
base. It must be an absolute, dedicated path outside the per-run runtime and must
not overlap known real VS Code user-data or extension directories. The harness
retains its `user-data` child across runs, resets only Copilot Agent Mesh global
storage for deterministic Device/Node assertions, acquires an exclusive profile
lock, refuses to terminate a pre-existing profile user, and never defaults to
the developer's profile. The final authenticated command was:

```sh
MESH_MULTI_WINDOW_E2E=1 \
MESH_MULTI_WINDOW_E2E_TASKS=1 \
MESH_MULTI_WINDOW_E2E_PROFILE_DIR=$HOME/.mw-profile \
MESH_MULTI_WINDOW_E2E_AUTH_RESOURCE='https://api.github.com' \
MESH_MULTI_WINDOW_E2E_AUTH_PROVIDER='github' \
MESH_MULTI_WINDOW_E2E_AUTH_SCOPES_JSON='["read:user","user:email"]' \
MESH_MULTI_WINDOW_E2E_RUNTIME_DIR=$HOME/.mw \
npm run test:multi-window-real
```

## Same-profile multi-window flow

The multi-window harness uses exactly one `--user-data-dir` and one temporary
`--extensions-dir` for every ordinary VS Code window. User Data is temporary by
default and persistent only through the explicit opt-in above. Each Extension Host creates
a Window Node with process-lifetime random `nodeId`/`nodeInstanceId`, heartbeats,
workspace claims, and its own real AHP runtime/handles. A nonce-authenticated test
controller selects a mailbox by workspace basename plus node instance ID.

The transport/lifecycle run proves:

1. repo-a and repo-b publish two live Window Nodes and exactly one generation-fenced
   Broker owner;
2. the listener remains stopped, a configured Dev Tunnel sentinel is never invoked,
   and the owned local IPC socket is the only local transport;
3. closing/reopening repo-b marks the old node offline and reclaims the same
   workspace ID;
4. closing the Broker owner produces a new generation and the survivor reconnects;
5. a symlinked second view of repo-a has one `claimed` and one `conflict` workspace,
   and routing to the conflicting node fails before Agent Host access; and
6. cleanup tracks exact PIDs/markers only and leaves no owned VS Code, Agent Host,
   Dev Tunnel, or local IPC socket.

The production local route is Window A → local Broker → Window B → real AHP →
Broker store → Window A. It does not touch Dev Tunnel. With
`MESH_MULTI_WINDOW_E2E_TASKS=1`, the harness attempts an explicit
Device → Node → Workspace task through that route. A run may claim
start/get/cancel/output only after authoritative AHP events are observed; an
authentication block is not counted as task-path success.

The 0.4.0 P2 authorization layer adds offline unit/component coverage for all
four allowlist/accept-switch combinations, directional policy, exact caller
ownership, offline identity rebinding, multi-workspace target rejection,
immediate revocation, and the route-acquisition TOCTOU recheck. The historical
real task mode above does not yet configure the new default-off peer policies;
P8 must update that harness before it can be used as 0.4.0 peer-delegation
evidence. Transport/lifecycle mode remains valid because it does not start a
peer task.

P6 adds offline real-Unix-socket coverage for the editor transport and a safe local
experiment boundary. On 2026-08-31, the macOS arm64 Stable endpoint command succeeded
but returned zero editor endpoints, while Insiders user-data was absent. No write
experiment could safely start, so editor AHP initialize and O1 target-window Chat
Sessions visibility are **unverified**, not Pass or Fail. P8 must rerun with a live
ordinary VS Code editor endpoint; only objective UI/session evidence may promote O1.

## Recorded 0.2.0 multi-window evidence

The ordinary transport/lifecycle run passed on VS Code `1.134.0`, macOS arm64:

- `.vscode-test/multi-window-evidence/6c119d7b-8596-4757-a129-7e31b412db5d.json`
- two nodes observed in 129 ms and exactly one Broker;
- Listener/Tunnel stopped and the configured sentinel untouched;
- repo-b offline in 268 ms, then the same `workspaceId` reclaimed;
- takeover changed the Broker generation;
- a duplicate repo produced a workspace conflict; and
- complete socket/process cleanup.

The second opted-in real AHP run also passed its infrastructure/lifecycle
assertions:

- `.vscode-test/multi-window-evidence/7886dc25-37ef-4909-ac2b-6af2a506078c.json`
- two nodes observed in 278 ms;
- repo-b offline in 214 ms;
- takeover in 1683 ms with the same `workspaceId`; and
- zero Tunnel/socket/process residue.

That historical run correctly stopped at `AGENT_AUTH_REQUIRED` because the fresh
shared profile had no authentication mapping/session. It did not count as task
success.

The final authenticated run passed on VS Code `1.135.0`, macOS arm64:

- `.vscode-test/multi-window-evidence/2ab62a03-51ba-45ef-a01a-0e3829f7ae7c.json`
- one authenticated session was available and the task emitted
  `agentStartRequested → agentStarted → output` (five output events);
- source-side start/get/cancel and terminal observations were authoritative;
- `AgentTaskHandle.cancel()` was invoked, followed by `cancelRequested` and
  `cancelConfirmed`, and the task reached `cancelled`;
- two nodes were visible in 133 ms, repo-b was offline in 210 ms, the same
  `workspaceId` was reclaimed, and Broker takeover completed in 1878 ms;
- the duplicate workspace conflict and no-Tunnel sentinel assertions passed; and
- cleanup recorded zero Agent Host, VS Code, and Dev Tunnel processes, removed
  the local IPC socket and per-run runtime, released the profile lock, and left
  no owned residue.

The evidence stores event kinds and booleans only; it contains no token, account,
path, raw prompt, or raw output. Gate G0 is therefore **Go for the validated
macOS arm64 Preview scope**.

The real two-device v2 run also passed one-Tunnel pairing, explicit remote
Device → Node → Workspace discovery, and durable task acceptance. The Worker
then reported `agentStartRequested` followed by `failed(AGENT_AUTH_REQUIRED)`;
the harness removed the owned Tunnel and profiles and confirmed that all owned
processes stopped. This proves remote multiplexing and cleanup, not an
authenticated Agent turn.

The fallback cleanup path is independently exercisable:

```sh
MESH_TWO_DEVICE_E2E=1 \
MESH_TWO_DEVICE_E2E_FORCE_FALLBACK_CLEANUP=1 \
npm run test:two-instance-real
```

The harness downloads the official `devtunnel 1.0.2030+fc9273aa0f` macOS arm64 binary
to its temporary runtime directory and requires SHA-256
`004f3cc8ebcce61223bacac80d31937eb2e92eaee9a05600a1cb62fb5f775afe`.
`MESH_DEVTUNNEL_PATH` may instead select an already downloaded exact binary. The
harness neither installs nor changes a global CLI.

The Worker and Coordinator use different temporary `user-data`, `extensions`, control,
and therefore `globalStorage` directories. Both load the current `dist/extension.js`.
The file IPC and automatic local task approval require a Development/Test
Extension Host, `MESH_TWO_DEVICE_E2E=1`, and matching per-profile random nonce
and role values. Production extension mode disables the capability regardless
of environment values. Every IPC request revalidates its nonce and role; the
capability invokes production services and never replaces `AgentRuntime`.

## Automated flow

1. Start isolated Worker and Coordinator VS Code Development Hosts.
2. Configure the Worker, register a temporary non-sensitive workspace, and start the
   production Gateway plus exact-build Dev Tunnel.
3. Create a one-time invitation in Worker memory, pair Coordinator through its URL,
   and wait until the production directory reports the Worker online and the opaque
   workspace.
4. Delegate through `TaskCoordinator -> Gateway -> WorkerTaskService`.
5. Start a cancellation probe. Cancellation is counted only after the task emits
   `agentStarted`, the Worker records the production `AgentTaskHandle.cancel()` call,
   and the task reaches `cancelled`. If authentication fails before `agentStarted`,
   cancellation is reported blocked and is not claimed as covered.
6. With an authenticated runtime, start a separate non-destructive AHP completion
   task. A fresh profile without an explicit authentication mapping terminates as
   failed with stable `AGENT_AUTH_REQUIRED`; this is a verified boundary, not a
   successful Agent turn.
7. Stop the listener, re-verify exact CLI/build/hash and persisted ownership metadata,
   delete only the exact owned Tunnel ID, and require the versioned exact not-found
   response. The harness retains exact ID, ownership label, executable path, control
   path, and global-storage path until confirmation. If in-host cleanup fails, the
   harness uses the hash-verified CLI with strict decoder ownership checks and exact-ID
   not-found confirmation. If that also fails, profiles/control/metadata are retained
   and the command exits nonzero.
8. Close both hosts and confirm that their VS Code, Gateway, AHP, and Tunnel processes
   no longer reference an owned runtime path. Remove both profiles, extension
   directories, controls, workspace, and downloaded binary.

Retained evidence is stored under `.vscode-test/multi-window-evidence/<run-id>.json`
with path/secret-sanitized host logs. It contains no invitation URL, token,
account identity, raw prompt/output, filesystem path, or binary.

## Earlier two-instance result

The real run reached all transport and production task boundaries:

- exact Dev Tunnel lifecycle test: HTTPS `204`, WSS, ACE renewal, host restart, and
  exact-ID cleanup passed;
- two Development Hosts paired through the real public Tunnel;
- Coordinator observed one online Worker and its registered workspace;
- production Agent Host probe reported available and enabled;
- the isolated unauthenticated profile failed before `agentStarted`, so runtime-handle
  cancellation is explicitly blocked rather than claimed;
- the non-destructive AHP boundary ended in failed state with `AGENT_AUTH_REQUIRED`;
- owned Tunnel deletion, process shutdown, and profile removal were confirmed.

The E2E exposed and fixed a production defect: the listener generated a 55-character
Tunnel ownership label, while the official service accepts at most 50. The listener now
uses the same namespace with a 31-character compact device suffix, and the provider
rejects over-limit labels before provisioning.

## Manual authenticated continuation

Use a disposable profile and supply an explicit mapping; the extension does not infer
a provider or scopes:

```sh
MESH_TWO_DEVICE_E2E=1 \
MESH_TWO_DEVICE_E2E_AUTH_RESOURCE='https://api.github.com' \
MESH_TWO_DEVICE_E2E_AUTH_PROVIDER='<installed VS Code authentication provider ID>' \
MESH_TWO_DEVICE_E2E_AUTH_SCOPES_JSON='["<exact required scope>"]' \
npm run test:two-instance-real
```

Complete the non-destructive VS Code authentication prompt in the Worker window. The
harness first checks `vscode.authentication` silently and never records the session or
token. With usable credentials it requires a real authoritative AHP `turnComplete`;
without them it reports `AGENT_AUTH_REQUIRED`, not success. The task prompt requests
only `MESH_TWO_INSTANCE_E2E_OK` and forbids file changes and commands.

## Thirteen MVP acceptance items

| # | MVP item | Status | Evidence or exact blocker |
|---|---|---|---|
| 1 | One VSIX on Windows, macOS, Linux | Partial | Packaging and offline platform gates pass; this real run covered only macOS arm64 Development Hosts, not installed VSIXes on all three OSes. |
| 2 | Configure device name | Pass | Both isolated profiles reported their configured Worker/Coordinator identities. |
| 3 | Register current workspace | Pass | Worker registered the temporary workspace and published only its opaque ID/name. |
| 4 | Worker Gateway/Tunnel start-stop; stable unsupported state elsewhere | Pass | Real macOS arm64 start/stop/cleanup passed; offline platform tests cover fail-closed `CLI_UNSUPPORTED`. |
| 5 | Display/copy connection URL | Pass | Production invitation creation returned a valid HTTPS URL to in-memory IPC; the secret was not persisted as evidence. |
| 6 | Add, save, and delete a connection | Partial | Real add/pair/save passed. Peer deletion is covered offline but was not exercised in this real run. |
| 7 | Connection state, heartbeat, and workspace list UI | Pass | Production dashboard/directory observed the peer online and its workspace over the real Tunnel. |
| 8 | Five mesh language-model task tools | Partial | Offline extension/tool suites cover all five tools; authenticated real service routing uses the same production facade, but Copilot itself invoking the LM tools is not claimed without separate evidence. |
| 9 | macOS arm64 Worker invokes built-in Copilot over AHP | Pass | VS Code 1.135.0 authenticated through the explicit GitHub mapping. The real production AHP task emitted `agentStarted` and five output events, invoked `AgentTaskHandle.cancel()`, and reached authoritative `cancelled`. |
| 10 | Coordinator UI shows task state/output summary | Partial | Production source-side snapshots exposed authenticated output and cancellation state, but the harness did not make a visual Dashboard assertion. |
| 11 | `mesh_delegate_task` waits for an authoritative result | Partial | Offline two-window Broker coverage proves event-driven completed, needs-input, failed, cancelled, and idempotent reconciliation without polling. A real Copilot LM-tool invocation and completed AHP task remain unverified; `mesh_get_task` is now abnormal-interruption recovery. |
| 12 | Multiple workspaces, one writer per workspace | Partial | Offline lease concurrency/recovery coverage remains green; the removed 0.3.0 collaboration orchestrator is not current evidence. |
| 13 | No Git/worktree management or injected Git prompt | Pass | Production request forwards the supplied prompt/criteria only; the real prompts contained no Git operation and the harness performed no repository mutation in the Worker workspace. |

This earlier two-instance matrix remains historical evidence. G0 is closed by the
authenticated same-user-data multi-window turn above. Cross-platform Worker
hosting, visual UI coverage, multi-workspace real coverage, authenticated
two-device execution, and Copilot-driven LM-tool invocation remain outside the
validated scope.
