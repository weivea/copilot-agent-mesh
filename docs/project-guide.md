# Project guide

[Feature overview and architecture](../README.md) |
[Development](./development.md) |
[Release engineering](./mvp/release.md)

This guide contains the detailed Preview scope, operating workflows, limitations,
and historical evidence. For a short introduction, start with the feature overview.

## Preview overview

Copilot Agent Mesh 0.5.13 Preview provides **Peer Window Delegation** for ordinary
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
[the workflow and historical evidence](./cross-device-connectivity-validation.md).

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

**Desktop Codespaces:** a trusted Linux x64/ARM64 Codespace attached to desktop
VS Code can use the same six Mesh tools through the matching workspace companion.
The desktop retains its Broker, policies and task history; execution uses a
Mesh-owned AHP Host inside the Codespace, not the native Chat Host. Browser
Codespaces are not included. See [setup and design](./desktop-codespaces.md).

In the attached desktop window, choose **Prepare Codespaces Runtime** from the
Mesh Dashboard toolbar. This explicitly installs the bundled companion and
offers native CLI download/license confirmation. Reload when prompted, then
authorize target Workspaces and incoming tasks as usual. No public Codespace
port, additional Dev Tunnel, PAT setting, or shell login is required.
Unknown Agent protected resources still require an explicit provider mapping.
Mesh-owned sessions support continuation within the same live execution
generation. The **native Chat POC** adds target-side streaming in the
native Chat editor and retained entries in Sessions, without another model call.
It requires VS Code 1.137+. On first companion activation, Mesh automatically
saves the required desktop permission. **Fully quit all VS Code windows and
reopen once**, then reconnect. No launch flags or manual configuration edits
are needed, even on a new device. Existing runtime preferences and other
extension permissions are preserved. **Enable Native Codespaces Chat** retries
setup if a dirty or invalid user configuration prevented the automatic save.

Native provider registration no longer depends on discovering an internal
workbench menu command. While a required full restart is pending, incoming
tasks still retain their history and show an explicit presentation warning.

Short shared Extension Host stalls no longer use the ordinary 15-second
Codespaces command budget for Broker event acknowledgements. Execution can wait
within a separate bounded grace period while companion heartbeats continue.
This improves first-task resilience without replaying work or removing task
deadlines; it does not isolate the Broker from other extensions' CPU usage.

The Dashboard keeps its last validated actions usable during ordinary
background refreshes. Unchanged, unused action bindings remain stable across
reads; every action still revalidates the current caller, target and permissions.
No temporary "updating" or disabled phase is emitted for a healthy read.
Confirmed unavailable/invalid data or a read stalled for ten seconds instead
enters a read-only reconnecting state. Saved connection preferences are not
shown as switched off; local navigation and Refresh remain available.
The title-bar **Enable/Disable cross-device connections** action follows the
last confirmed saved preference, not the refresh or live transport state, so
periodic refreshes do not alternate its icon or tooltip.

Native conversation input is read-only in this POC; continue through the source
Mesh tools, including `#meshAnswerTask` for questions. The target-side Mesh cancel button uses the existing task channel,
and closing Chat does not cancel execution. History survives a window restart,
not necessarily deletion/rebuilding of the Codespace, and is not permission to
replay after Host replacement. This proposed-API companion is for private VSIX
evaluation, not normal Marketplace publishing. Actual cloud/UI qualification
remains distinct from the isolated native UI harness.

The Codespace connection account, Mesh Dev Tunnel account, and Copilot execution
account may differ. Installing the runtime does not require a shared account.
If setup reports a libc error, run `getconf GNU_LIBC_VERSION` in the Codespace
terminal and inspect **Output: Copilot Agent Mesh - Codespaces**. Setup now
distinguishes an undetected libc version from a confirmed unsupported platform.

## Preview prerequisites and limitations

- Local desktop windows require VS Code 1.103 or newer; the Codespaces companion and native Chat POC require 1.137 or newer.
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
  `copilotAgentMesh.experimental.authenticationProviders` applies to
  owned Agent Host paths, where every protected-resource or
  authorization-server URL must map to an installed VS Code authentication
  provider and exact scopes. Missing standalone mappings fail with
  `AGENT_AUTH_REQUIRED`. The Codespaces companion additionally supplies the
  documented exact GitHub resource mapping; it never infers mappings for unknown
  resources or changes the borrowed editor's identity.
- Cross-device connections use the Dev Tunnels SDK and native GitHub or Microsoft
  authentication in VS Code. No Dev Tunnel CLI installation, CLI login, or
  hosting-backend setting is required.
- A fresh shared profile has no authentication session by default. Real AHP E2E
  uses an explicitly configured, dedicated persistent test profile; it never
  defaults to the developer's normal VS Code profile.
- Gate G0 is **Go for the validated macOS arm64 Preview scope**: a real
  authenticated AHP turn produced output, invoked `AgentTaskHandle.cancel()`,
  reached `cancelled`, and left no owned process, socket, or Tunnel residue.

See [Preview release and installation](./mvp/release.md) for packaging, installation, and verification instructions.

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
[the E2E evidence](./mvp/e2e.md). Two logical instances on one host are not
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

If the Dashboard is Online but shows no other devices, inspect **Output -> Copilot
Agent Mesh** in the Broker owner window. Discovery diagnostics distinguish HTTP
region results, SDK Tunnel counts, eligible endpoints, cancellation and refresh
scheduling. Slow or failed operations also report authorization/HTTP time, their
phase and budget, and delayed deadline/refresh timers. These diagnostics omit
account credentials, Tunnel capabilities, task content and raw responses.
Global listings can omit cross-region port details. Mesh reads the exact listed
resource's details when port metadata is incomplete: the list has a 10-second
deadline, each sequential detail read has a separate 5-second deadline, and the
whole round has a 20-second deadline. The existing 10-resource/10-endpoint and
management-concurrency limits remain. Incomplete offline candidates are deferred
unless an established connection needs their details; their advertised identities
are still checked against pinned identities.
A successful detail read alone never proves account ownership or grants task access.

Transient detail failures produce an explicit **partial** result instead of
discarding healthy, validated candidates. Previous candidates may be displayed
as **stale**, but are not used for enrollment or selected as live endpoints.
Authentication, account, identity and endpoint-validation failures do not fall
back to a partial success. Failed details back off independently from 30 seconds
up to five minutes; a changed advertisement or a fresh complete summary is
re-evaluated without reusing an old endpoint or capability.

With an authenticated remote connection or recent explicit remote-directory
demand, discovery normally refreshes after 15-18 seconds; otherwise it refreshes
after 60-63 seconds. Failed rounds back off from one to five minutes. **Refresh
remote devices** requests fresh discovery, subject to the minimum request interval
and service rate limits. Remote tool listings signal discovery demand without
waiting for the cloud round or bypassing failure backoff; local-only listings
and **Refresh local** do not.
These intervals do not change peer heartbeats, host renewal or task deadlines.

The connection badge describes this device's hosting lifecycle, not the outcome
of every directory request. Discovery warnings, individual remote-device
connection problems and failed user actions are shown separately. Recovering
discovery clears its own warning; a verified reconnect clears that peer's
transient error. An unrelated refresh cannot erase a hosting or action failure.
In particular, a discovery timeout does not report that a same-device or
desktop-attached Codespaces task failed.

**Device trust is not Workspace or task authorization.** In **Devices & permissions**,
or through a Workspace's **Permissions** shortcut on Overview, B separately grants
the trusted device its target Workspace and enables receive. A separately allows
the authenticated remote target from the selected source Workspace. Applying an
authorization to every Workspace in the window is a separate, explicit action
that identifies the affected Workspaces before confirmation. These gates
default to deny; B still confirms each task unless its scoped automatic-acceptance
policy is explicitly enabled. Use the Mesh task tools with target handles or
explicit Device/Node/Workspace IDs. Strict remote tasks use B's target-selected
backend: the existing editor Host for ordinary windows, or the explicitly bound
Mesh-owned Host for desktop Codespaces. There is no silent standalone fallback.

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

The Dashboard separates **Overview**, **Task history**, and **Devices & permissions**.
Overview contains this device, confirmed connected devices and nonterminal tasks.
Each Workspace has a **Permissions** shortcut that opens its exact settings without
another target picker. Remote Workspace pages edit the selected local source's
sending authorization; receiving permission is managed in the target window.
Completed, failed, cancelled and timed-out tasks are kept in Task history, with
status and direction filters. A lost connection does not move an active task to
history. Task visibility and ownership are unchanged.

Account, Workspace and device management are page controls rather than nested
configuration menus. Advanced VS Code settings and existing Workspace commands
remain available. Transport and Agent Host diagnostics are collapsed by default;
errors and reasons an action is unavailable remain visible. The interface follows
VS Code's language, with Chinese and English text. Informational explanations use
closable, keyboard-accessible info popovers instead of taking up the main page.
**Delegate from Chat…** opens an
unsubmitted Agent Chat draft for that exact target. A has no additional Mesh
task-start dialog; Copilot's existing tool-confirmation behavior is unchanged.
Refreshing the tree only reads cached/local state. **Refresh connected devices**
explicitly refreshes trusted peers; account discovery runs automatically while
connections are enabled.

Offline windows disappear from Overview automatically. Reopening the same
repository creates a new Window Node, while its saved Workspace configuration
and authorizations remain. Offline and unconfirmed remote devices appear under
**Saved devices**, not as live targets. Deleting a saved device revokes its trust
and related permissions while retaining task history and durable revocation
records. Deletion is blocked while associated tasks are nonterminal or their
state cannot be established. **Revoke trust** remains a separate confirmed action,
including for connected devices with active tasks; it disconnects the device and
requests cancellation without pretending those requests are completed tasks.
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
cancel accepted tasks; **Revoke trust** additionally closes connections
and requests authoritative target-side cancellation. Cleanup failure remains
visible and never restores permission.

Existing saved remote policies migrate with no automatically accepted peers.
Disable the per-device checkbox to return to per-task confirmation. Older
builds that do not understand the new policy field fail closed for remote
initialization; do not delete policy or revocation files to force a downgrade.

## Install from GitHub Releases

Install desktop VS Code first, then run the installer for your platform. No Git,
Node.js, npm, or Go installation is needed. These commands become available after
the scripts are merged to `main` and the matching GitHub release assets are
published; packaging alone does not publish a release.

**Windows (PowerShell 5.1 or newer):**

```powershell
& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/weivea/copilot-agent-mesh/main/scripts/install.ps1' -ErrorAction Stop).Content))
```

**macOS (Terminal):**

```bash
installer="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' https://raw.githubusercontent.com/weivea/copilot-agent-mesh/main/scripts/install.sh)" && /bin/bash -c "$installer"
```

These commands execute this repository's installer; review
[the Windows script](../scripts/install.ps1) or [the macOS script](../scripts/install.sh)
before running. Each script downloads its pinned release VSIX and SHA-256 sidecar,
checks the checksum, and installs it with `code --install-extension ... --force`.
It verifies the installed version and removes only its own temporary downloads.
Download, checksum, and installation failures stop the installer. The checksum
detects damaged/mismatched assets; it is not an independent publisher signature.
No administrator access, execution-policy changes, or VS Code configuration edits
are required. Reload VS Code after installation.

The same script command installs updates after the version on `main` is advanced;
there is no automatic background updater. If you installed a newer build manually,
the pinned installer may replace it. Private repositories require authenticated
downloads and are not supported by these anonymous bootstrap commands.

The main VSIX includes the matching Codespaces companion. In a desktop-attached
Codespace, use **Prepare Codespaces Runtime** in the Dashboard; do not install the
workspace companion into your ordinary local window. The native Chat POC still
requires VS Code 1.137+ and a full restart after its separate permission setup.
GitHub distribution does not remove these experimental API requirements.

For local builds, release assets, and version/tag conventions, see
[release engineering](./mvp/release.md#github-release-installers).

## Project documents

- [Development and project layout](./development.md)
- [Product requirements (historical)](./product-requirements.md)
- [Technical implementation](./technical-implementation.md)
- [Implementation plan](./implementation-plan.md)
- [Compatibility matrix](./compatibility-matrix.md)

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
