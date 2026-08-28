# Copilot Agent Mesh

Copilot Agent Mesh 0.2.0 Preview coordinates GitHub Copilot coding tasks across
trusted devices, VS Code windows, and local workspaces. It uses Mesh protocol v2;
v1 peers are explicitly incompatible. This package is an evaluation build, not a
declaration that the end-to-end G0 release gate has passed.

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
- AHP authentication is not inferred. Every advertised protected-resource or authorization-server URL must be mapped explicitly in `copilotAgentMesh.experimental.authenticationProviders` to an installed VS Code authentication provider and its exact scopes. Missing mappings fail with `AGENT_AUTH_REQUIRED`.
- Tunnel hosting requires a user-supplied `copilotAgentMesh.devTunnelPath` pointing to the exact validated macOS arm64 CLI build `1.0.2030+fc9273aa0f`. The extension does not search `PATH`, download, install, or upgrade Dev Tunnel.
- A fresh shared profile has no authentication mapping/session by default. The
  opted-in real AHP run therefore stops correctly at `AGENT_AUTH_REQUIRED`.
- Gate G0 remains **No-Go**: authenticated AHP Session/Turn E2E has not passed, so this Preview does not claim a full end-to-end MVP.

See [Preview release and installation](./docs/mvp/release.md) for packaging, installation, and verification instructions.

## Implemented Preview capabilities

- Register trusted local Workspaces by opaque ID and enforce one claimed Window
  Node per physical workspace.
- Run one generation-fenced Device Broker, authenticated local IPC, loopback
  Gateway, and exact-build Microsoft Dev Tunnel per User Data.
- Pair devices with one-time invitations and application-layer mutual authentication.
- Discover explicit Device → Node → Workspace targets, then delegate, poll,
  cancel, and answer tasks.
- Run the production Agent Host/AHP adapter with explicit VS Code authentication.
- Use five Copilot tools: list workers, delegate, get, cancel, and answer.
- Operate the Broker, owner/takeover state, local nodes, workspace conflicts,
  remote nodes, listener, peers, and tasks from the Activity Bar Dashboard.
- Persist shared task/delegation state and bounded reducer events behind
  generation-fenced Broker writes.

Local tasks take the full direct route Window A → local Broker → Window B → real
AHP → Broker store → Window A and never touch Dev Tunnel. Remote v2 traffic uses
the device's single Gateway/Tunnel, is routed by the Broker to the selected node,
and is multiplexed back to all local windows over IPC.

The ordinary-window lifecycle E2E passed on VS Code 1.134.0, macOS arm64. A second
opted-in AHP run passed the same infrastructure assertions but correctly stopped
at `AGENT_AUTH_REQUIRED`; it did **not** prove authoritative AHP
start/get/cancel/output. The real two-device v2 run also passed single-Tunnel
pairing, explicit Device → Node → Workspace discovery, and durable acceptance,
then recorded `agentStartRequested → failed(AGENT_AUTH_REQUIRED)` with exact
Tunnel/profile/process cleanup. See [the E2E evidence](./docs/mvp/e2e.md).

## Install the local Preview

```bash
npm ci
npm run package:vsix
code --install-extension artifacts/copilot-agent-mesh-0.2.0-preview.vsix
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
```

To opt into the real AHP path (which may consume quota):

```bash
MESH_MULTI_WINDOW_E2E_RUNTIME_DIR=$HOME/.mw \
MESH_MULTI_WINDOW_E2E_TASKS=1 npm run test:multi-window-real
```

The short runtime path avoids the macOS Unix-domain socket path limit.

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
