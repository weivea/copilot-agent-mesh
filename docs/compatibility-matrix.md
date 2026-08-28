# Compatibility Matrix

> Status: 0.2.0 Preview implemented; Gate G0 No-Go<br>
> Evidence date: 2026-08-25<br>
> Mesh protocol: v2; v1 peers incompatible

This document is the release gate for external platform compatibility. Installed
or declared versions are not treated as validated support.

## Gate G0

**Current decision: No-Go**

The multi-window transport and lifecycle gate passed, but an authenticated
authoritative AHP Session/Turn has not. The opted-in run correctly reached
`AGENT_AUTH_REQUIRED` because its fresh shared profile had no explicit
authentication mapping/session. It did not prove AHP start/get/cancel/output.

| Capability | Declared or detected | Validated | Status |
| --- | --- | --- | --- |
| Package | `0.2.0` Preview VSIX | Package/version documentation and implementation-time package checks | Preview; not published |
| Mesh protocol | v2 | Local Broker/Node and remote routing schemas | v2 only; v1 peers incompatible |
| VS Code minimum | `1.103.0` in `package.json` | Offline API/build coverage | Preview range; real minimum not yet proven |
| VS Code tested | `1.134.0`, macOS arm64 | Real ordinary same-user-data windows plus implementation-time unit/component/Extension Host/full npm tests | Pass for tested infrastructure; final counts intentionally not recorded here |
| Window Nodes | Ordinary VS Code windows with random process-lifetime `nodeId`/`nodeInstanceId` | Two nodes observed in 129 ms and 278 ms in separate final real runs | Pass on tested build |
| Device Broker | One owner, generation-fenced takeover, authenticated local IPC | Exactly one Broker; takeover changed generation. Final AHP-boundary run takeover completed in 1683 ms. | Pass on tested build |
| Workspace claims | Canonical identity hash, one claim per physical workspace | Duplicate repo conflict; node loss and same-`workspaceId` reclaim | Pass on tested build |
| Local routing | Window A → Broker → Window B → real AHP → Broker store → Window A; no Tunnel | Transport/lifecycle route infrastructure passed | Partial: authoritative AHP task path remains blocked |
| AHP package | `@microsoft/agent-host-protocol@0.8.0` | Production lifecycle reaches explicit authentication boundary | Partial / No-Go |
| AHP authentication | Explicit resource/provider/scope mapping plus available VS Code session | Fresh shared profile had neither mapping nor session | Blocked with expected `AGENT_AUTH_REQUIRED` |
| Dev Tunnel CLI | Exact macOS arm64 build `1.0.2030+fc9273aa0f` | Existing exact-build lifecycle evidence; multi-window local route kept Listener/Tunnel stopped | Pass on macOS arm64 only |
| Remote v2 route | One device Gateway/Tunnel → Broker → explicit Window Node | Real two-device pairing/discovery and durable acceptance passed; Fresh Profile then emitted `agentStartRequested` and `failed(AGENT_AUTH_REQUIRED)`; Tunnel/profile/process cleanup passed | Transport/routing pass; authenticated execution No-Go |

## Real multi-window evidence

| Evidence | Assertions |
| --- | --- |
| `.vscode-test/multi-window-evidence/6c119d7b-8596-4757-a129-7e31b412db5d.json` | Two nodes in 129 ms; exactly one Broker; Listener/Tunnel stopped and sentinel untouched; repo-b offline in 268 ms, then same `workspaceId` reclaimed; takeover changed generation; duplicate repo conflict; complete socket/process cleanup. |
| `.vscode-test/multi-window-evidence/7886dc25-37ef-4909-ac2b-6af2a506078c.json` | Opted-in real AHP run: two nodes in 278 ms; repo-b offline in 214 ms; takeover in 1683 ms; same `workspaceId`; zero tunnel/socket/process residue. Infrastructure/lifecycle passed, but AHP stopped at `AGENT_AUTH_REQUIRED`; no authoritative start/get/cancel/output evidence. |

## Preview platform support

The 0.2.0 package does not claim Marketplace publication or cross-platform Worker
hosting. All ordinary windows are active Window Nodes, but the ability to host
the listener and execute real AHP tasks remains platform-gated.

| OS | Architecture | 0.2 evidence | Preview support |
| --- | --- | --- | --- |
| macOS | arm64 | Real same-user-data Broker/Node transport and lifecycle on VS Code 1.134.0; existing exact-build Tunnel evidence | Worker candidate and active Window Node; G0 No-Go until authenticated AHP turn |
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
