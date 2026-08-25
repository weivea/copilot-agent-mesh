# MVP real two-instance E2E

> Evidence date: 2026-08-25
> Baseline: local `mvp-e2e-base` at `06775c7e2e8a18f7771507e4a739fad0b865d9a0`
> Platform: macOS arm64, VS Code `1.134.0`

## Opt-in boundary

The default `npm test` remains offline. The real test is explicit because it creates a
public Dev Tunnel and may consume Copilot quota:

```sh
MESH_TWO_DEVICE_E2E=1 npm run test:two-instance-real
```

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

The retained temporary evidence contains only `two-instance-evidence.json` and
path/secret-sanitized host logs. It contains no invitation URL, token, account identity,
filesystem path, or binary.

## Result

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
| 8 | Four mesh language-model tools | Partial | Offline extension/tool suites cover all four tools; real delegation/cancel used the same `TaskCoordinator`, but an authenticated Copilot did not invoke the LM tools. |
| 9 | macOS arm64 Worker invokes built-in Copilot over AHP | Blocked | Real production AHP launched and probed, but the isolated profile had no explicit VS Code authentication mapping/session; task failed correctly with `AGENT_AUTH_REQUIRED` before `agentStarted`, runtime-handle cancellation, Session completion, or `turnComplete`. |
| 10 | Coordinator UI shows task state/output summary | Partial | The real auth failure was observable through production snapshots; cancellation was blocked before `agentStarted`, and no authenticated text output or visual UI assertion was available. |
| 11 | `mesh_get_task` returns completion result to Copilot | Partial | Real result polling traversed Coordinator/Gateway/Worker; authenticated Copilot tool invocation and a completed AHP result remain blocked by item 9. |
| 12 | Multiple workspaces, one writer per workspace | Partial | Lease/concurrency behavior passes offline; this real run registered one temporary workspace. |
| 13 | No Git/worktree management or injected Git prompt | Pass | Production request forwards the supplied prompt/criteria only; the real prompts contained no Git operation and the harness performed no repository mutation in the Worker workspace. |

Summary: 6 pass, 6 partial, 1 blocked. The sole hard runtime blocker is explicit
authentication for a disposable Worker profile; the partial items require additional
OS/UI/multi-workspace coverage or depend on that authenticated authoritative turn.
