# Compatibility Matrix

> Status: 0.4.0 Preview implemented; Peer Window Delegation objective gate 8/12, full gate Unverified<br>
> Evidence date: 2026-09-05 (cross-device implementation); earlier live Agent evidence retains its original scope<br>
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
| Package | `0.4.0` Preview VSIX | Package/version documentation and implementation-time package checks | Preview; not published |
| Mesh protocol | v2 | Local Broker/Node and remote routing schemas | v2 only; v1 peers incompatible |
| VS Code minimum | `1.103.0` in `package.json` | Offline API/build coverage | Preview range; real minimum not yet proven |
| VS Code tested | `1.135.0` and `1.136.1`, macOS arm64 | 1.135.0: real ordinary same-user-data windows and authenticated production AHP turn with offer/selection `["1.0.0"]`/`1.0.0`. 1.136.1: dedicated-profile editor discovery, Unix-socket WebSocket upgrade, dual offer `["1.0.0","0.9.0"]`, selected `0.9.0`, and authoritative short no-tool `chat/turnComplete` | 1.135.0 Pass for scoped Preview; 1.136.1 editor/AHP compatibility Pass |
| Window Nodes | Ordinary VS Code windows with random process-lifetime `nodeId`/`nodeInstanceId` | Two nodes observed in 133 ms in the final authenticated run | Pass on tested build |
| Device Broker | One owner, generation-fenced takeover, authenticated local IPC | Exactly one Broker; takeover changed generation in 1878 ms | Pass on tested build |
| Workspace claims | Canonical identity hash, one claim per physical workspace | Duplicate repo conflict; node loss and same-`workspaceId` reclaim | Pass on tested build |
| Local routing | Window A → Broker → Window B → real AHP → Broker store → Window A; no Tunnel | Authenticated start/output/cancel passed without touching Tunnel | Pass on tested build |
| AHP package | TypeScript package `0.9.0` from pinned upstream commit `f19dd8b3942d029744a3bdd31d830f9428e8ea47`; standalone and registry-1.0 editors offer exact `["1.0.0"]`, registry-0.9 editors offer `["1.0.0","0.9.0"]` | VS Code 1.135.0 selected `1.0.0`; VS Code 1.136.1 selected `0.9.0` and completed a real turn with the same generated client | Pass; upstream revision is not yet tagged or npm-published |
| AHP authentication | `https://api.github.com` → provider `github`, scopes `read:user`, `user:email` | Dedicated profile exposed a silent session accepted by Agent Host | Pass on tested profile |
| Editor Agent Host source (0.4.0 P6) | schema-v2 editor endpoint, known registry metadata `1.0.0` or `0.9.0`, Unix socket WebSocket, registry-derived exact protocol policy, selected-version membership validation, and per-action version guards; standalone fallback | Offline strict parser/socket/selector/lifecycle coverage plus live authenticated editor completions on VS Code 1.135.0 (`1.0.0`) and 1.136.1 (`0.9.0`) | Live execution Pass on both versions; Chat Sessions UI visibility remains Unverified |
| Editor Session identity/workspace policy | Provider-scoped new Session URI, schema-supported folder isolation, and authoritative snapshot re-reads | VS Code 1.136.1 source compatibility plus offline Runtime/SDK coverage; earlier live execution evidence predates this policy | Real target Chat visibility remains Unverified; no history migration |
| Peer Window Delegation (0.4.0) | Six registered LM Tools with scoped target/task listing, wait/submit, directional allowlist plus target receive gate, and editor-first AHP | The earlier five-tool VS Code 1.135.0/macOS arm64 objective run passed AC-5 1-4, 6, 8-12, needs-input resume, token cancellation, short-budget cancellation, and cleanup | 10/12 original objective items Pass; newer tool modes and Copilot confirmation/same-Chat UI remain separate real acceptance gates |
| Dev Tunnel CLI | Exact macOS arm64 build `1.0.2030+fc9273aa0f` | Existing exact-build lifecycle evidence; multi-window local route kept Listener/Tunnel stopped | Pass on macOS arm64 only |
| Remote v2 route | One device Gateway/Tunnel → Broker → explicit Window Node | Historical two logical instances on one host passed public-relay pairing/routing and durable acceptance; their disposable Worker profile stopped at `AGENT_AUTH_REQUIRED` | Transport/routing evidence only; not physical-device or authenticated cross-device execution evidence |
| D1 discovery/binding/policy | Public Dev Tunnels management/contracts `1.3.56`, production v2 mutual proof, owner-only IPC, source allowlists, target grants and durable revocation | Offline production-startup/IPC, real loopback sockets, strict schema, endpoint/profile/owner races and revocation recovery; explicitly authorized GitHub native session and real read-only directory on one Mac returned `ready`, zero candidates | GitHub account/query Pass only on VS Code 1.136.1 `a44adf7...` macOS arm64; Entra/MSA, CLI account alignment, cross-profile and two-physical-device gates remain Blocked/Unverified |
| D2 private hosting | Connections `1.3.56`, SSH `3.12.42`, provider-neutral selection, actual SDK host, scoped capabilities, no anonymous ACE | Authorized single-Mac production SDK host/Gateway reached ready; real no-anonymous ACLs, missing/invalid/wrong-port capability refusal, Mesh mutual authentication/device proof and 100 pings; exact cleanup confirmed | Pass for this bounded private admission/Mesh-ping run on VS Code 1.136.1 `a44adf7...`, macOS arm64. Original enrollment failure retained; live expiry/renewal, active CLI migration, physical-device/Agent/UI gates Unverified |
| Cross-device Dashboard | v8 Device/Window/Workspace tree, per-view one-use aliases, native owner actions over authenticated IPC; cached-only render; explicit scoped B task-start auto-accept | Tree routing, strict local IPC, default-off policy migration, grant/claim/revision races and task-start trust-boundary coverage | Earlier live gates predate this UI/auto-accept update; does not establish Copilot same-Chat or target Chat Sessions visibility |
| Artifact Store | Immutable bounded JSON with producer/consumer ownership, length, SHA-256, and revision | Size/count/media/hash/ownership/corruption/path/secret tests plus exact 153-byte contract handoff passed | Same-device Broker scope only; not arbitrary file transfer |

The D1/D2 code paths, setup, commands, gate evidence, migration and cleanup
conditions are recorded in [Cross-device implementation and validation](./cross-device-connectivity-validation.md).
The single-Mac GitHub and D2 rows are separate explicitly authorized results,
not extensions of G0. They establish only their stated account/query and
private-service/Mesh-ping scopes, not two-device or cross-profile SSO, real
cross-device Agent execution, live expiry/renewal, or ordinary Chat UI.

## Real multi-window evidence

| Evidence | Assertions |
| --- | --- |
| `.vscode-test/multi-window-evidence/6c119d7b-8596-4757-a129-7e31b412db5d.json` | Two nodes in 129 ms; exactly one Broker; Listener/Tunnel stopped and sentinel untouched; repo-b offline in 268 ms, then same `workspaceId` reclaimed; takeover changed generation; duplicate repo conflict; complete socket/process cleanup. |
| `.vscode-test/multi-window-evidence/7886dc25-37ef-4909-ac2b-6af2a506078c.json` | Opted-in real AHP run: two nodes in 278 ms; repo-b offline in 214 ms; takeover in 1683 ms; same `workspaceId`; zero tunnel/socket/process residue. Infrastructure/lifecycle passed, but AHP stopped at `AGENT_AUTH_REQUIRED`; no authoritative start/get/cancel/output evidence. |
| `.vscode-test/multi-window-evidence/2ab62a03-51ba-45ef-a01a-0e3829f7ae7c.json` | Final authenticated run on VS Code 1.135.0: two nodes in 133 ms; `agentStarted`; five output events; authoritative start/get/cancel; `AgentTaskHandle.cancel()` invoked; `cancelled`; repo-b offline in 210 ms; takeover in 1878 ms; workspace reclaim/conflict; profile lock released; zero Tunnel/socket/Agent Host/VS Code residue. |
| `artifacts/peer-delegation-e2e/evidence.json` | P8 objective run: two ordinary nodes, one Broker, two distinct claims, `PEER_NOT_ALLOWED`, `PEER_NOT_ACCEPTING`, one-way visibility, real editor completion with a Host-originated Session-channel echo, Incoming record, needs-input resume, token and short-budget cancellation, zero Listener/Tunnel attempts, lease/profile release, and zero harness-owned residue. Copilot UI-dependent items keep the artifact Unverified, not Pass. |

## Preview platform support

The 0.4.0 package does not claim Marketplace publication or cross-platform Worker
hosting. All ordinary windows are active Window Nodes, but the ability to host
the listener and execute real AHP tasks remains platform-gated.

| OS | Architecture | Evidence | Preview support |
| --- | --- | --- | --- |
| macOS | arm64 | Authenticated production AHP execution on VS Code 1.135.0 and dedicated-profile production-path Session/Turn completion on VS Code 1.136.1; existing exact-build Tunnel evidence | Worker candidate and active Window Node; G0 Go for scoped Preview |
| macOS | x64 | No owned Worker lifecycle evidence | Active client Window Node; Worker host unsupported |
| Windows | x64 | Named-pipe and offline coverage; no Job Object-based real Agent Host/Tunnel gate | Active client Window Node; Worker host unsupported |
| Linux | x64 | Unix IPC and offline coverage; no validated real Tunnel/Worker gate | Active client Window Node; Worker host unsupported |

The P6 user-data strategy has offline Stable/Insiders/Linux/Windows/override tests.
Those strategies do not change the support rows above: Windows, Linux, and macOS x64
Worker Host execution and editor endpoint discovery remain unsupported/unverified.

## Migration and unsupported environments

- Migration from 0.1 preserves the stable device ID and v1 workspace/task data
  into schema v2. Unknown or corrupt persisted versions fail closed.
- Protocol-v1 network peers do not interoperate with protocol v2.
- New Editor sessions require provider-scoped URI identities and Host-advertised
  `folder` isolation. Existing `ahp-session:` histories are not renamed. A Host
  that cannot honor this workspace policy fails explicitly; this does not add
  platform support or upgrade the Chat UI visibility gate from Unverified.
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
