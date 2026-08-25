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
- `AtomicFileStore` rooted below `ExtensionContext.globalStorageUri` and `FileTaskStore`
  for authoritative task records and event journals.
- `DeviceService`, `WorkspaceService`, `WorkerTaskService`, `TaskCoordinator`, and
  `ListenerService`.
- `PairingService`, `GatewayServer`, `PeerConnectionManager`,
  `DevTunnelCliProvider`, and the feature-gated `AhpAgentRuntime`.
- `ProductionDashboardBindings`, `ServiceDashboardFacade`, the Dashboard view, and the
  five production Language Model Tools.

## Preview platform scope

Worker Preview platform eligibility is deliberately limited to **macOS arm64**. That is the
only platform with both the exact-gated Dev Tunnel build and reliable owned Agent
Host process control validated together. Authenticated end-to-end AHP execution
remains behind compatibility Gate G0 and is not claimed complete. Windows, Linux, macOS x64, and other
architectures are Coordinator-only when peer-client networking is available.

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

Later Extension Hosts are read-only Coordinator dashboards. They do not restore or mutate peer
connections, delegation intents, workspace registrations or leases, Worker tasks, Listener,
tunnel, or pairing resources. Mutating commands and task tools return stable `WORKER_DRAINING`
guidance pointing to the owner window. Shutdown removes the owner lock only when its on-disk
token still belongs to that instance. Dynamic Agent Host configuration search debounces queries,
keeps at most two bounded AHP completion requests in flight, and displays only the latest
revision even when an older request has not resolved.

## Task lifecycle

The coordinator persists a semantic-hash `DelegationIntent`, UUID task ID, explicit invocation
ID, and deadline before sending `task.start`. The Tool generates a fresh invocation ID when the
caller omits one. Lost acknowledgements and in-flight retries reuse the returned invocation ID
with the exact payload to recover the same task; reusing an ID with different semantics fails
with `TASK_ID_CONFLICT`. Terminal intents remain append-only audit history, but never globally
deduplicate a later fresh invocation with the same semantics.
Worker start verifies ownership, resolves only an opaque registered workspace ID, checks the
Agent Host feature/probe, acquires the workspace lease, and atomically persists `accepted`
before launching `AgentRuntime.start`.

The first task for a peer/workspace pair requires local confirmation. “Always allow” stores
only the non-sensitive pair grant; each accepted task is still explicitly pre-authorized for
the runtime confirmation boundary. Runtime events use a byte-and-count-bounded queue:
progress coalesces, nonterminal output truncates or drops with one explicit truncation event
per pressure episode, and tool/control/terminal events apply backpressure instead of being
discarded. The serial consumer persists every retained input, cancellation, and terminal
reducer event before change notifications. `task.get` reports
retained event gaps, and cancel has a worker deadline that fails with
`TASK_CANCELLATION_UNCONFIRMED` if no terminal confirmation arrives.

The production notification sink preserves that classification on the wire:
`progress` emits `task.progress`, output and truncation emit `task.output`, and
state/control transitions emit `task.stateChanged`. Terminal states therefore
remain critical while high-volume progress/output uses the RpcPeer ordinary
coalescing and backpressure budget.

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
