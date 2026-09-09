# Copilot Agent Mesh

Copilot Agent Mesh 0.5.0 Preview provides **Peer Window Delegation** for ordinary
VS Code windows on Windows x64/ARM64 and macOS arm64. Local discovery, task tools,
window naming, and policy controls are enabled by default. In Agent mode, Copilot can use
six Mesh tools to discover an explicitly authorized peer window, delegate tasks,
wait for authoritative results, recover task IDs, answer input, or cancel work. Mesh protocol
v2 remains in use; v1 peers are explicitly incompatible. This is an evaluation
build, not a general-availability claim. Existing dated macOS evidence is not
evidence of a Windows or physical cross-device task run.

Cross-device connections are also default-off, with **one Enable/Disable switch**
and **SDK-only private Tunnels**. Native VS Code account selection/sign-in enables
automatic discovery and device trust for your same-account devices; Workspace
grants, receive permission and task approval stay separate and default-deny.
Earlier, explicitly authorized single-Mac GitHub sign-in/read-only discovery and
D2 private-ingress/Mesh-authentication/100-ping runs passed with exact cleanup.
Those historical results do not validate this new automatic workflow across
physical devices. Entra/MSA, cross-profile, live renewal and real cross-device
Agent/Chat gates remain unverified. See
[the workflow and historical evidence](./docs/cross-device-connectivity-validation.md).

One stable **Device Broker** owns pairing, peer roots, the Gateway, one Dev Tunnel,
the peer manager, global task/delegation persistence, reducer/event log, remote
routing, and the node registry. Every ordinary VS Code window under the same User
Data is an active **Window Node** with process-lifetime random
`nodeId`/`nodeInstanceId`, heartbeats, workspace claims, and its own real AHP
runtime and handles. Non-owner windows are active Broker clients, not read-only
coordinators.

Worker hosting, cross-device hosting and task execution support **Windows
x64/ARM64 and macOS arm64**. Linux, macOS x64, and Windows x86 remain
Coordinator-only. The VSIX includes the Windows process controller; no Go
installation or additional Windows feature setting is needed by users.

## Preview prerequisites and limitations

- VS Code 1.103 or newer is required.
- Real Worker execution is experimental, requires Workspace/task authorization, and may consume Copilot quota.
- The Agent Host connects on demand for an authorized task. There is no separate runtime feature switch; merely enabling connections or opening the Dashboard does not start an Agent task.
- Same-device discovery and policy controls work without an extra settings step.
  The existing `copilotAgentMesh.experimental.peerDelegation` setting defaults
  to `true`; an explicit `false` remains an opt-out. The directional source
  allowlist and the target's **Accept Incoming Tasks** switch stay default-off.
- Use Copilot Chat in Agent mode with tools enabled. Copilot tool choice is not
  guaranteed; use `#meshListWorkers` and `#meshDelegateTask` when explicit
  selection is needed.
- A borrowed editor Agent Host reuses that editor profile's established identity;
  Mesh never pushes a separate OAuth token into it. If the editor later reports an
  authentication challenge, authenticate in that editor profile and retry.
  `copilotAgentMesh.experimental.authenticationProviders` applies only to the
  owned standalone Agent Host path, where every protected-resource or
  authorization-server URL must map to an installed VS Code authentication
  provider and exact scopes. Missing standalone mappings fail with
  `AGENT_AUTH_REQUIRED`.
- Cross-device connections use the Dev Tunnels SDK and native GitHub or Microsoft
  authentication in VS Code. No Dev Tunnel CLI installation, CLI login, or
  hosting-backend setting is required.
- A fresh shared profile has no authentication session by default. Real AHP E2E
  uses an explicitly configured, dedicated persistent test profile; it never
  defaults to the developer's normal VS Code profile.
- Gate G0 is **Go for the validated macOS arm64 Preview scope**: a real
  authenticated AHP turn produced output, invoked `AgentTaskHandle.cancel()`,
  reached `cancelled`, and left no owned process, socket, or Tunnel residue.

See [Preview release and installation](./docs/mvp/release.md) for packaging, installation, and verification instructions.

## Implemented Preview capabilities

- Register trusted local Workspaces by opaque ID and enforce one claimed Window
  Node per physical workspace.
- Run one generation-fenced Device Broker and authenticated local IPC per User
  Data, with one loopback Gateway/private SDK Tunnel when cross-device connections
  are enabled.
- Automatically discover and authenticate same-account devices with durable device
  keys and application-layer mutual authentication, without exchanging invitations.
- Discover explicit Device → Node → Workspace targets, then delegate and wait,
  cancel, and answer tasks.
- Run the production Agent Host/AHP adapter with explicit VS Code authentication.
- Use the six Copilot task tools to discover targets, submit or wait for tasks,
  recover owned task IDs, cancel, or answer input.
- Configure a safe per-Workspace window name, receive switch, and directional
  peer allowlist from the Dashboard. Display names never authorize or route.
- Prefer the running VS Code instance's AHP `editor` endpoint for delegated
  sessions, with a visibly degraded standalone fallback.
- Create new Editor sessions with provider-scoped identities and require
  Host-supported `folder` isolation, so tasks use the target window's existing
  directory rather than an automatically provisioned worktree. Existing
  worktrees and branches are kept; unsupported folder configuration fails
  explicitly. Standalone behavior is unchanged.
- Operate the Broker, owner/takeover state, local nodes, workspace conflicts,
  remote nodes, listener, peers, and tasks from the Activity Bar Dashboard.
- Persist shared task/delegation state and bounded reducer events behind
  generation-fenced Broker writes.
- Discover only caller-owned Mesh Dev Tunnels using pinned public SDK packages;
  discovery hints and device trust alone never authorize executable workers.
- Bind locators to authenticated peer/profile generations, recover pending
  enrollment, and re-resolve endpoints without changing task identities.
- Enforce A's real local-source allowlists and B's independent paired-device
  grants/receive switch; revoke incoming peers durably and close their sockets.
- Use SDK-only private hosting with Host and port-specific Connect capabilities,
  never anonymous ACEs or a CLI fallback.

Local tasks take the full direct route Window A → local Broker → Window B → real
AHP → Broker store → Window A and never touch Dev Tunnel. Remote v2 traffic uses
the device's single Gateway/Tunnel, is routed by the Broker to the selected node,
and is multiplexed back to all local windows over IPC.

The final ordinary-window run passed on VS Code 1.135.0, macOS arm64, using a
dedicated authenticated profile. It observed two Window Nodes in 133 ms, five
real output events, authoritative start/get/cancel, `cancelled`, Broker takeover
in 1878 ms, workspace reclaim/conflict, and exact zero-residue cleanup. The
earlier two-instance public-relay v2 run remains transport/routing evidence only because its
disposable Worker profile stopped at `AGENT_AUTH_REQUIRED`. See
[the E2E evidence](./docs/mvp/e2e.md). Two logical instances on one host are not
two physical devices.

The 0.4.0 Peer Delegation objective run on the same VS Code/platform verified
two ordinary windows, exactly one Broker, two distinct claims, both double-gate
errors and directionality, the target Incoming record, zero Listener/Tunnel
attempt delta, a real editor-backed `agentStarted`/output/`turnComplete`/
`completed` sequence, exact needs-input resume, token cancellation, short-budget
cancellation, released leases/profile lock, and zero harness-owned residue.
The editor Host objectively echoed the created Session channel on the selected
editor endpoint. Copilot-sidebar confirmation, target Chat Sessions UI
visibility, and 60-minute UI stability remain explicitly Unverified.

An Editor Session's presence in the Host catalog alone does not establish Chat
visibility: its provider and actual working directory must also match the target
window. Normal terminal cleanup retains Editor history without keeping the Mesh
connection alive. Old `ahp-session:` resources are not renamed or migrated by the
new-session policy.

## Mesh tool workflow

Existing tool references and explicit-ID calls remain supported. Configuration,
sign-in, pairing, hosting and Workspace grants stay in the Dashboard, not in
model-callable management tools.

| Tool | Purpose and important options |
| --- | --- |
| `#meshListWorkers` | Find authorized targets. `scope` is `local`, `remote`, or `all` (default). Local scope never requests remote directories; all-scope failures are explicit `partial` results when another scope is available. |
| `#meshDelegateTask` | Prefer a returned `targetHandle`, or supply the legacy exact IDs, never both. `mode: "wait"` is the default; `"submit"` returns after durable acceptance so other targets can be scheduled. Optional `continueFromTaskId` reuses an owned completed task's session; omit it for a new session. |
| `#meshGetTask` | Read an owned task by ID. `waitFor: "snapshot"` reads once; `"change"` or `"outcome"` subscribes to events. Outcome means input is needed or the task reached a terminal state. |
| `#meshAnswerTask` | Answer the exact current input with a stable `answerId`. Native confirmation shows the current question and a safe answer preview. Then get/wait on the same task ID; do not create a new delegation. |
| `#meshCancelTask` | Explicitly request cancellation. A `cancelling` receipt is not a confirmed `cancelled` task. |
| `#meshListTasks` | Recover IDs from this authenticated window's owned task index. Active tasks are the default; `includeTerminal`, `limit` (default 20, maximum 100), and `beforeTaskId` support bounded history/pagination. States are explicitly last-known, not a remote refresh. |

For one-to-many work, list targets, submit a separate task to each intended
Workspace, then inspect or wait on their returned IDs. Each target still needs
its independent authorization and free Workspace Lease. There is no broadcast
operation or automatic recursive delegation.

The source window explicitly chooses session reuse by passing
`continueFromTaskId` with the previous completed task's ID and the same exact
target. This creates a **new task ID and new turn** in the retained editor
Session/Chat, preserving conversation context. Without that field, delegation
still creates a new session. Use a fresh `delegationRequestId` (or omit it) for
each follow-up; reusing that request ID only retries the identical task.

Continuation requires the same authenticated owner/source scope, target window
instance and Workspace, a completed task record, and an available idle editor
session. It does not reopen a completed task, answer pending input, or fork an
old transcript: later turns already in that session remain part of its history.
Deleted, archived, busy, incompatible, or standalone sessions cannot be silently
replaced with a new session. Authorization, Workspace leases, execution deadlines,
and sensitive-operation approvals still apply independently to every follow-up.

`timeoutMinutes` remains the execution budget (default and maximum 60 minutes).
Get/wait has a separate `waitSeconds` event-wait budget (default 60, maximum
3,600 seconds), plus bounded initial/final reads. Stopping or timing out get/wait
does **not** cancel the task. After submit returns, stopping the source Chat
does not cancel submitted work either; use the explicit cancel tool. Default
Delegate wait-mode cancellation retains its existing task-cancellation behavior.

Target handles are temporary, per-window references to exact routing IDs, not
authentication or execution grants. They expire after five minutes and are
invalidated by Broker reconnect; source scope and live authorization are still
checked. Refresh a stale selection instead of substituting a same-named window.
Reopening a repository under a new Window Node identity does not transfer
another window's task ownership.

Default delegation output now uses `outcome`, `taskId`, `delegationRequestId`,
`taskState`, and `nextAction`. The call outcome and actual task state are separate;
`unknown` is not proof of failure. Tight output budgets retain the compact
fallback with `s` (0 completed, 1 input needed, 2 failed call, 3 cancelled call,
4 accepted), `t`/`d` identities, and authoritative `taskState` when needed.
An accepted task is never reported as completed. Get/wait timeouts explicitly
mark their snapshot as the last read rather than pretending it is current.

## Cross-device opt-in

On **every participating Windows x64/ARM64 or macOS arm64 device**, open the Mesh Dashboard and choose
**Enable cross-device connections**. Select the same GitHub or Microsoft account
through native VS Code account selection/sign-in. The Broker starts a private SDK
Tunnel, discovers other enabled same-account devices and authenticates their
durable device identities automatically. There is no invitation, manual connection
URL, separate Listener button, or discovery/delegation/hosting toggle to manage.
Merely opening a default-off Dashboard does not query the cloud or start hosting.

Devices are symmetric: there is no master or hub. Remote traffic uses outbound
private WSS through the target device's Tunnel cloud relay. Windows on the same
device use the local Broker's authenticated IPC, not the Tunnel.

**Device trust is not Workspace or task authorization.** In **Manage devices and
permissions…** or the selected Workspace's controls, B separately grants the
trusted device its target Workspace and enables receive. A separately allowlists
that authenticated remote Workspace from every claimed source root. These gates
default to deny; B still confirms each task unless its scoped automatic-acceptance
policy is explicitly enabled. Use the Mesh task tools with target handles or
explicit Device/Node/Workspace IDs. Strict remote tasks require B's existing editor
Host, without standalone fallback.

**Disable cross-device connections** is the one-click off path: it stops discovery,
outbound peers and the Listener, and deletes **only this Broker's exact owned
Tunnel**. **Cancel connection startup** is available while native sign-in/startup
is pending. VS Code authentication, durable device keys, peer credentials,
Workspace policies and task records are retained. A failed cloud cleanup stays
persisted and visible as pending; **Retry Tunnel cleanup** resumes it rather than
claiming the resource was deleted. Disconnecting is not proof that a task was
cancelled.

Device identity is durable; the Tunnel is an ephemeral connection resource.
Re-enabling recreates the Tunnel and automatically rediscovers/rebinds trusted
same-account devices without a new invitation or automatic permission changes.
Switching back to a previously selected account reuses that account's saved device
identity; choosing a different account does not transfer Workspace grants.
The old CLI hosting settings and UI are removed. A recorded legacy CLI-owned
Tunnel can be retired only through exact SDK ownership proof with its native
account, not a CLI login or a name/prefix-based deletion sweep.

The Dashboard groups **This device / Other devices -> Window -> Workspace**.
Select a Workspace for its controls; tasks stay in the task dock, the connection
switch stays visible, and transport diagnostics remain collapsed in Settings.
**Delegate from Chat…** opens an
unsubmitted Agent Chat draft for that exact target. A has no additional Mesh
task-start dialog; Copilot's existing tool-confirmation behavior is unchanged.
Refreshing the tree only reads cached/local state. **Refresh connected devices**
explicitly refreshes trusted peers; account discovery runs automatically while
connections are enabled.

Offline windows disappear from the tree automatically. Reopening the same
repository creates a new Window Node, while its saved Workspace configuration
and authorizations remain. Paired remote devices stay listed when offline.
The Broker keeps a short in-memory reconnect grace period (30 seconds by
default); expired window records are reclaimed automatically, but task cleanup
bindings and their leases are retained until the existing task lifecycle releases
them. This does not delete projects or task history.

On B, select **this window's Workspace** and enable automatic task acceptance
for a specific already-granted paired device. One explicit, scoped opt-in lets
that device's future tasks skip B's task-start prompt for this Workspace only.
It defaults off and does not bypass receive, grants, A's source allowlist,
editor availability, or sensitive terminal/authentication/publishing approvals.
B authorizes the paired device, not an independently authenticated window on A.
Turning it off restores startup confirmation for future approvals, without
cancelling tasks already approved. Removing the incoming grant or revoking the
peer clears its saved automatic acceptance; granting it again does not restore it.

The unified connection switch defaults off. Disabling connections never restores
legacy authorization or clears Workspace policy. Receive/grant removal does not
cancel accepted tasks; **Revoke incoming peer** additionally closes connections
and requests authoritative target-side cancellation. Cleanup failure remains
visible and never restores permission.

Existing saved remote policies migrate with no automatically accepted peers.
Disable the per-device checkbox to return to per-task confirmation. Older
builds that do not understand the new policy field fail closed for remote
initialization; do not delete policy or revocation files to force a downgrade.

## Install the local Preview

```bash
git submodule update --init --recursive
npm ci
npm run package:vsix
code --install-extension artifacts/copilot-agent-mesh-0.4.0-preview.vsix
```

Project documents:

- [Product requirements](./copilot-agent-mesh-prd.md)
- [Technical implementation](./docs/technical-implementation.md)
- [Implementation plan](./docs/implementation-plan.md)
- [Compatibility matrix](./docs/compatibility-matrix.md)

## Development

Requirements:

- VS Code 1.103 or newer
- Node.js 22 or newer and npm
- Go at the version declared in `native/windows-process-host/go.mod` or newer
  (build-time only; not required to install or use the VSIX)

Install dependencies and build the extension:

```bash
git submodule update --init --recursive
npm ci
npm run compile
```

Open the repository in VS Code:

```bash
code .
```

Select **Run and Debug** in the Activity Bar, choose **Run Extension**, and click the green start button. On macOS, the equivalent keyboard shortcut is usually `fn`+`F5`; a bare `F5` may trigger a system function instead. The debug configuration builds the extension before opening an Extension Development Host.

Useful commands:

```bash
npm run watch
npm run check-types
npm run lint
npm test
npm run verify
npm run package:vsix
npm run test:multi-window-real
npm run test:peer-delegation-real
```

To opt into the real AHP path (which may consume quota):

```bash
MESH_MULTI_WINDOW_E2E_RUNTIME_DIR=$HOME/.mw \
MESH_MULTI_WINDOW_E2E_TASKS=1 npm run test:multi-window-real
```

The short runtime path avoids the macOS Unix-domain socket path limit.

The real Peer Window Delegation gate is additionally protected by an exact
environment value. Without it the command exits safely before compiling or
launching VS Code:

```bash
MESH_PEER_DELEGATION_E2E=1 npm run test:peer-delegation-real
```

The harness uses two ordinary windows, two temporary non-sensitive projects, one
shared dedicated profile, real registered LM tools, and the pinned AHP client.
Real Copilot sidebar confirmation and Chat Sessions visibility use an
operator-visible phase in the exact enabled command; programmatic
`vscode.lm.invokeTool` evidence is never misreported as UI confirmation.
Sanitized evidence is written to
`artifacts/peer-delegation-e2e/evidence.json`.

Historical cross-device evidence does not establish the current workflow across
physical devices. Linux, macOS x64, and Windows x86 remain unable to host
Worker/AHP execution. Stable APIs also cannot
detect concurrent edits made by the target window's separate user Copilot session;
the Incoming Task record and target-side cancel action are the mitigation.

## Project layout

```text
shared/              Protocol v2 and bounded wire schemas
src/broker/           Device Broker ownership, IPC, routing, and node catalog
src/node/             Window Node lifecycle, routing adapters, and real runtime handles
src/ipc/              Authenticated local IPC transport
src/storage/          Broker ownership fencing and durable storage adapters
src/composition/      Production application composition
src/ui/               Activity Bar Dashboard and safe view models
src/test/             VS Code extension integration tests
native/windows-process-host/  Packaged Windows Job Object process controller
```

Production modules also live under `gateway`, `peer`, `agentHost`, `tasks`,
`tools`, `tunnel`, and `workspaces`.

## Security model

This extension is intentionally disabled in untrusted and virtual workspaces.
Remote execution requires an explicitly registered workspace and paired peer
connection.

Local IPC uses Unix sockets on macOS/Linux and named pipes on Windows, with a
hashed short endpoint. Unix directories/sockets use `0700`/`0600`; peers use a
shared SecretStorage Broker key, nonce plus mutual HMAC, and bounded replay,
deadline, rate, frame, queue, and backpressure handling. Canonical realpath/file
identity is hashed before entering the Broker catalog or IPC. A duplicate physical
workspace is conflict/read-only. Node loss releases its claim; an active task fails
explicitly with `TASK_RECOVERY_UNAVAILABLE` because the current AHP runtime has no
recovery API, and it is never executed twice.

Windows-owned CLI and standalone Agent Host processes start inside a Job Object
before their first instruction runs. The packaged controller owns that job and
its process handles, so cancellation, failed startup, or loss of the parent
connection cannot leave an untracked child process tree. Borrowed editor Hosts
remain owned by VS Code and are never terminated by Mesh.
