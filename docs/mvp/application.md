# MVP application composition

`src/composition/createApplication.ts` is the production composition root. The extension
entry point creates one `Application`; asynchronous deactivation awaits
`Application.dispose()`. Activation does not install a simulated worker or spike tool.

## Production graph

The application creates:

- `VscodeGlobalStateStore` for non-sensitive device, workspace, tunnel, peer, listener,
  task-approval, and delegation metadata. Mesh never calls `setKeysForSync`.
- `VscodeSecretStore` for invitations, enrollment proofs, peer roots, and temporary
  coordinator pairing credentials.
- `AtomicFileStore` rooted below `ExtensionContext.globalStorageUri`,
  `FileTaskStore`, and `ArtifactStore` for authoritative task records, immutable
  structured artifacts, and event journals.
- `DeviceService`, `WorkspaceService`, `WorkerTaskService`, `TaskCoordinator`, and
  `ListenerService`.
- Broker-owned `PeerPolicyStore` / `PeerPolicyService`, the directional double
  gate, and one active Window Node client per ordinary window.
- `PairingService`, `GatewayServer`, `PeerConnectionManager`,
  `DevTunnelCliProvider`, and the feature-gated `AhpAgentRuntime`.
- `ProductionDashboardBindings`, `ServiceDashboardFacade`, the P7 peer/task
  Dashboard, and exactly five production Language Model Tools.

## Preview platform scope

Worker Preview platform eligibility is deliberately limited to **macOS arm64**. That is the
only platform with both the exact-gated Dev Tunnel build and reliable owned Agent
Host process control validated together. Authenticated end-to-end AHP
start/output/cancel has passed compatibility Gate G0 on that scope. Windows,
Linux, macOS x64, and other architectures are Coordinator-only when peer-client
networking is available.

On a Coordinator-only platform, Listener start fails before spawning with stable
`CLI_UNSUPPORTED`, and Agent Host probe/start returns stable
`AGENT_UNAVAILABLE`. Dashboard details explain that macOS arm64 is required and
that Coordinator features remain available. The application never substitutes a
different CLI, an unowned process, or a fake Worker runtime.

Every command and public service crosses `LocalDesktopWorkspaceGuard`. Listener, peer,
coordinator, and metadata-only operations do not require an open folder, but still reject a
remote Extension Host or untrusted workspace. Workspace registration and worker execution
also require an all-local `file:` workspace.

The mutable Mesh application is exclusive across VS Code windows that share the extension's
`globalStorageUri`. Activation acquires an atomic owner lock containing a process ID, instance
ID, generation, token, and heartbeat. A stale takeover first acquires a separate `O_EXCL`
mutex, then re-reads the exact observed generation/token before replacing it. Concurrent
contenders remain passive, and an orphaned takeover mutex fails closed. Owner records are fully
written and synced through a private candidate inode before a no-replace hard link publishes
them, so readers never observe a partially initialized record. Every non-crash mutex exit removes
only its own on-disk token. Takeover also requires both an expired heartbeat and a dead owner
process.

Later Extension Hosts are active Window Nodes and authenticated Broker clients. They do not own
or restore the singleton Gateway/Tunnel/Peer Manager, but their tools and Dashboard may mutate
their own peer policy or route tasks through Broker IPC. Shared persistence remains exclusive to
the generation-fenced owner. Shutdown removes the owner lock only when its on-disk token still
belongs to that instance. Dynamic Agent Host configuration search debounces queries,
keeps at most two bounded AHP completion requests in flight, and displays only the latest
revision even when an older request has not resolved.

## Task lifecycle

The coordinator persists a semantic-hash `DelegationIntent`, UUID task ID, explicit invocation
ID, and deadline before sending `task.start`. The Tool generates a fresh invocation ID when the
caller omits one. Lost acknowledgements and in-flight retries reuse the returned invocation ID
with the exact payload to recover the same task; reusing an ID with different semantics fails
with `IDEMPOTENCY_CONFLICT`. Terminal intents remain append-only audit history, but never globally
deduplicate a later fresh invocation with the same semantics.
Worker start verifies ownership, resolves only an opaque registered workspace ID, checks the
Agent Host feature/probe, acquires the workspace lease, and atomically persists `accepted`
before launching `AgentRuntime.start`.

Same-device delegation uses one parent Tool confirmation. Its in-memory grant is bound to the
exact task/target and can auto-approve only structured, non-control-plane file URIs proven inside
the target Workspace; terminal, authentication, uncertain, cross-Workspace, secret, and publish
operations return `needsInput`. There is no persistent “Always allow” task grant. Runtime events
use a byte-and-count-bounded queue:
progress coalesces, nonterminal output truncates or drops with one explicit truncation event
per pressure episode, and tool/control/terminal events apply backpressure instead of being
discarded. The serial consumer persists every retained input, cancellation, and terminal
reducer event before change notifications. `task.get` reports
retained event gaps, and cancel has a worker deadline that fails with
`TASK_CANCELLATION_UNCONFIRMED` if no terminal confirmation arrives.

The production notification sink preserves that classification on the wire:
progress and bounded tool lifecycle summaries emit `task.progress`; output,
truncation, and Terminal summaries emit `task.output`; only real state/control
transitions emit `task.stateChanged`. Completed, failed, and cancelled states
therefore remain critical while high-volume progress/tool/output/Terminal
summaries use the RpcPeer ordinary coalescing and backpressure budget.

On startup, peers reconnect, the prior listener is restored, coordinator task snapshots are
reconciled, and worker task leases are rebuilt. Because the current `AgentRuntime` contract
does not expose process-independent resume, active worker records fail honestly with
`TASK_RECOVERY_UNAVAILABLE` instead of starting a duplicate agent.

## Listener and compatibility

`ListenerService` creates a fresh loopback-only `GatewayServer` for every start/restart and
then asks `DevTunnelCliProvider` to host that exact port. The provider enforces the exact
validated build, binary hash, login, JSON decoder, HTTPS health, and WSS readiness gates.
Connection URL creation is allowed only while hosted and creates a new one-time invitation;
the URL is written to the clipboard inside the Extension Host and never posted to the
webview.

Real tasks require `copilotAgentMesh.experimental.agentHost`. Disabled or unavailable AHP
returns the stable `AGENT_UNAVAILABLE` boundary. The extension never substitutes a fake
production runtime.

## Shutdown

Disposal first unregisters commands, tools, and the view, then closes the listener, drains
worker handles, disconnects coordinator peers, disposes the Agent runtime and owned child
processes, and finally closes the structured redacted log. Cleanup is idempotent and
aggregate failures are returned to asynchronous deactivation.

## P8 real harness composition

`MESH_PEER_DELEGATION_E2E=1` enables a third mutually exclusive, non-production
capability. It exposes only nonce-bound high-level policy, registered Tool, safe
catalog, and resource-observation actions. The short test budget is armed for one
delegation timer only; production Tool limits remain 60 minutes. Without the exact
environment value no E2E API is created and no VS Code window is launched.
