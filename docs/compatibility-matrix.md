# Compatibility Matrix

> Status: 0.3.0 Preview implemented; Gate G0 Go for validated macOS arm64 scope<br>
> Evidence date: 2026-08-30<br>
> Mesh protocol: v2; v1 peers incompatible

This document is the release gate for external platform compatibility. Installed
or declared versions are not treated as validated support.

## Gate G0

**Current decision: Go for the validated macOS arm64 Preview scope**

The final VS Code 1.135.0 same-user-data run used an explicit dedicated profile
with a GitHub authentication session and exact resource/provider/scopes mapping.
The production path emitted `agentStarted` and five real output events, invoked
`AgentTaskHandle.cancel()`, reached authoritative `cancelled`, and cleaned every
owned Agent Host, VS Code, Tunnel, and local IPC resource. This decision does not
extend Worker support beyond macOS arm64 or authorize publication.

| Capability | Declared or detected | Validated | Status |
| --- | --- | --- | --- |
| Package | `0.3.0` Preview VSIX | Package/version documentation and implementation-time package checks | Preview; not published |
| Mesh protocol | v2 | Local Broker/Node and remote routing schemas | v2 only; v1 peers incompatible |
| VS Code minimum | `1.103.0` in `package.json` | Offline API/build coverage | Preview range; real minimum not yet proven |
| VS Code tested | `1.135.0`, macOS arm64 | Real ordinary same-user-data windows and authenticated production AHP turn | Pass for scoped Preview |
| Window Nodes | Ordinary VS Code windows with random process-lifetime `nodeId`/`nodeInstanceId` | Two nodes observed in 133 ms in the final authenticated run | Pass on tested build |
| Device Broker | One owner, generation-fenced takeover, authenticated local IPC | Exactly one Broker; takeover changed generation in 1878 ms | Pass on tested build |
| Workspace claims | Canonical identity hash, one claim per physical workspace | Duplicate repo conflict; node loss and same-`workspaceId` reclaim | Pass on tested build |
| Local routing | Window A → Broker → Window B → real AHP → Broker store → Window A; no Tunnel | Authenticated start/output/cancel passed without touching Tunnel | Pass on tested build |
| AHP package | TypeScript package `0.9.0` from pinned upstream commit `f19dd8b3942d029744a3bdd31d830f9428e8ea47`; negotiates AHP `1.0.0` | Current VS Code 1.135.0 Agent Host handshake and real turn passed | Pass; upstream revision is not yet tagged or npm-published |
| AHP authentication | `https://api.github.com` → provider `github`, scopes `read:user`, `user:email` | Dedicated profile exposed a silent session accepted by Agent Host | Pass on tested profile |
| Dev Tunnel CLI | Exact macOS arm64 build `1.0.2030+fc9273aa0f` | Existing exact-build lifecycle evidence; multi-window local route kept Listener/Tunnel stopped | Pass on macOS arm64 only |
| Remote v2 route | One device Gateway/Tunnel → Broker → explicit Window Node | Historical two-device pairing/discovery and durable acceptance passed; its disposable Worker profile then stopped at `AGENT_AUTH_REQUIRED` | Transport/routing pass; authenticated two-device execution not yet run |
| Same-device multi-project collaboration | Durable frontend/backend run DAG over authenticated local IPC | Real two-window run completed backend → Artifact → frontend → two validations with Listener/Tunnel stopped | Pass on tested macOS arm64 build; Preview opt-in; no cross-device claim |
| Artifact Store | Immutable bounded JSON with producer/consumer ownership, length, SHA-256, and revision | Size/count/media/hash/ownership/corruption/path/secret tests plus exact 153-byte contract handoff passed | Same-device Broker scope only; not arbitrary file transfer |

## Real multi-window evidence

| Evidence | Assertions |
| --- | --- |
| `.vscode-test/multi-window-evidence/6c119d7b-8596-4757-a129-7e31b412db5d.json` | Two nodes in 129 ms; exactly one Broker; Listener/Tunnel stopped and sentinel untouched; repo-b offline in 268 ms, then same `workspaceId` reclaimed; takeover changed generation; duplicate repo conflict; complete socket/process cleanup. |
| `.vscode-test/multi-window-evidence/7886dc25-37ef-4909-ac2b-6af2a506078c.json` | Opted-in real AHP run: two nodes in 278 ms; repo-b offline in 214 ms; takeover in 1683 ms; same `workspaceId`; zero tunnel/socket/process residue. Infrastructure/lifecycle passed, but AHP stopped at `AGENT_AUTH_REQUIRED`; no authoritative start/get/cancel/output evidence. |
| `.vscode-test/multi-window-evidence/2ab62a03-51ba-45ef-a01a-0e3829f7ae7c.json` | Final authenticated run on VS Code 1.135.0: two nodes in 133 ms; `agentStarted`; five output events; authoritative start/get/cancel; `AgentTaskHandle.cancel()` invoked; `cancelled`; repo-b offline in 210 ms; takeover in 1878 ms; workspace reclaim/conflict; profile lock released; zero Tunnel/socket/Agent Host/VS Code residue. |
| `.vscode-test/multi-project-evidence/99d16bac-1b46-470d-9c7d-b9ebb74d4352.json` | 0.3.0 authenticated run: two nodes in 182 ms; exactly one Broker; distinct frontend/backend claims; both implementation tasks emitted `agentStarted`, output, and completed/turnComplete; exact 153-byte schema Artifact consumed by frontend; two validations and independent exit codes passed; aggregate completed; takeover in 993 ms; Listener/Tunnel stopped; profile lock released; zero owned process/socket/timer residue. |

## Preview platform support

The 0.3.0 package does not claim Marketplace publication or cross-platform Worker
hosting. All ordinary windows are active Window Nodes, but the ability to host
the listener and execute real AHP tasks remains platform-gated.

| OS | Architecture | 0.3 evidence | Preview support |
| --- | --- | --- | --- |
| macOS | arm64 | Authenticated same-user-data production AHP start/output/cancel on VS Code 1.135.0; existing exact-build Tunnel evidence | Worker candidate and active Window Node; G0 Go for scoped Preview |
| macOS | x64 | No owned Worker lifecycle evidence | Active client Window Node; Worker host unsupported |
| Windows | x64 | Named-pipe and offline coverage; no Job Object-based real Agent Host/Tunnel gate | Active client Window Node; Worker host unsupported |
| Linux | x64 | Unix IPC and offline coverage; no validated real Tunnel/Worker gate | Active client Window Node; Worker host unsupported |

## Migration and unsupported environments

- Migration from 0.1 preserves the stable device ID and v1 workspace/task data
  into schema v2. Unknown or corrupt persisted versions fail closed.
- Protocol-v1 network peers do not interoperate with protocol v2.
- SSH, WSL, Dev Containers, Codespaces, `vscode.dev`, virtual workspaces,
  untrusted workspaces, and mixed local/remote workspace folders remain
  unsupported.

## Evidence requirements

Promoting any row to supported requires:

1. The exact executable/package version and OS/architecture.
2. A reproducible command or automated explicit opt-in test.
3. Sanitized protocol evidence without secrets, paths, or raw prompt/output.
4. Explicit cleanup and ownership evidence for processes, IPC, and Tunnel resources.
5. An authenticated authoritative AHP task result where the row claims execution.
