# Copilot Agent Mesh

Copilot Agent Mesh 0.4.0 Preview adds default-off **Peer Window Delegation** for
ordinary VS Code windows on one macOS arm64 device. In Agent mode, Copilot can use
five Mesh tools to discover an explicitly authorized peer window, delegate one
task, wait for its authoritative result, answer input, or cancel it. Mesh protocol
v2 remains in use; v1 peers are explicitly incompatible. This is an evaluation
build, not a cross-device, cross-platform Worker, or general-availability claim.

One stable **Device Broker** owns pairing, peer roots, the Gateway, one Dev Tunnel,
the peer manager, global task/delegation persistence, reducer/event log, remote
routing, and the node registry. Every ordinary VS Code window under the same User
Data is an active **Window Node** with process-lifetime random
`nodeId`/`nodeInstanceId`, heartbeats, workspace claims, and its own real AHP
runtime and handles. Non-owner windows are active Broker clients, not read-only
coordinators.

Worker hosting and real task execution remain limited to **macOS arm64** in this
Preview. Other platforms fail closed with `CLI_UNSUPPORTED` or
`AGENT_UNAVAILABLE`; they do not start an unowned process or unvalidated tunnel.

## Preview prerequisites and limitations

- VS Code 1.103 or newer is required.
- Real Worker execution is experimental, disabled by default, and may consume Copilot quota.
- Enable `copilotAgentMesh.experimental.agentHost` only after reviewing the first-task confirmation and process ownership behavior.
- Enable `copilotAgentMesh.experimental.peerDelegation` in every participating
  window. The directional source allowlist and the target's **Accept Incoming
  Tasks** switch are both default-off.
- Use Copilot Chat in Agent mode with tools enabled. Copilot tool choice is not
  guaranteed; use `#meshListWorkers` and `#meshDelegateTask` when explicit
  selection is needed.
- AHP authentication is not inferred. Every advertised protected-resource or authorization-server URL must be mapped explicitly in `copilotAgentMesh.experimental.authenticationProviders` to an installed VS Code authentication provider and its exact scopes. Missing mappings fail with `AGENT_AUTH_REQUIRED`.
- Tunnel hosting requires a user-supplied `copilotAgentMesh.devTunnelPath` pointing to the exact validated macOS arm64 CLI build `1.0.2030+fc9273aa0f`. The extension does not search `PATH`, download, install, or upgrade Dev Tunnel.
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
- Run one generation-fenced Device Broker, authenticated local IPC, loopback
  Gateway, and exact-build Microsoft Dev Tunnel per User Data.
- Pair devices with one-time invitations and application-layer mutual authentication.
- Discover explicit Device → Node → Workspace targets, then delegate and wait,
  cancel, and answer tasks.
- Run the production Agent Host/AHP adapter with explicit VS Code authentication.
- Use the five Copilot task tools to discover workers, delegate, recover, cancel,
  or answer tasks.
- Configure a safe per-Workspace window name, receive switch, and directional
  peer allowlist from the Dashboard. Display names never authorize or route.
- Prefer the running VS Code instance's AHP `editor` endpoint for delegated
  sessions, with a visibly degraded standalone fallback.
- Operate the Broker, owner/takeover state, local nodes, workspace conflicts,
  remote nodes, listener, peers, and tasks from the Activity Bar Dashboard.
- Persist shared task/delegation state and bounded reducer events behind
  generation-fenced Broker writes.

Local tasks take the full direct route Window A → local Broker → Window B → real
AHP → Broker store → Window A and never touch Dev Tunnel. Remote v2 traffic uses
the device's single Gateway/Tunnel, is routed by the Broker to the selected node,
and is multiplexed back to all local windows over IPC.

The final ordinary-window run passed on VS Code 1.135.0, macOS arm64, using a
dedicated authenticated profile. It observed two Window Nodes in 133 ms, five
real output events, authoritative start/get/cancel, `cancelled`, Broker takeover
in 1878 ms, workspace reclaim/conflict, and exact zero-residue cleanup. The
earlier two-device v2 run remains transport/routing evidence only because its
disposable Worker profile stopped at `AGENT_AUTH_REQUIRED`. See
[the E2E evidence](./docs/mvp/e2e.md).

The 0.4.0 Peer Delegation objective run on the same VS Code/platform verified
two ordinary windows, exactly one Broker, two distinct claims, both double-gate
errors and directionality, the target Incoming record, zero Listener/Tunnel
attempt delta, released lease/profile lock, and zero harness-owned residue.
The disposable profile then stopped honestly at `AGENT_AUTH_REQUIRED` after an
explicit standalone degradation; no `agentStarted`/output/completed, Copilot
sidebar confirmation, target Chat Sessions UI, needs-input, cancellation, or
60-minute stability is claimed.

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
- Node.js and npm

Install dependencies and build the extension:

```bash
git submodule update --init --recursive
npm install
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

Cross-device delegation remains unverified. Windows, Linux, and macOS x64 remain
unable to host Worker/AHP execution in this Preview. Stable APIs also cannot
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
