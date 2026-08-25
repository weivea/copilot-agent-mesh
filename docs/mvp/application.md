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

Worker and Listener services are exclusive across VS Code windows that share the extension's
`globalStorageUri`. Activation acquires an atomic owner lock containing a process ID, instance
ID, token, and heartbeat. A live lock keeps later Extension Hosts Coordinator-only: they do not
restore Worker tasks or touch Listener, tunnel, or pairing resources, and Dashboard reports the
owner conflict explicitly. Takeover requires both an expired heartbeat and a dead owner process,
preventing delayed live Extension Hosts from being fenced out. Shutdown removes the lock only
when its on-disk token still belongs to that instance.

## Task lifecycle

The coordinator persists a semantic-hash `DelegationIntent`, UUID task ID, UUID delegation
ID, and deadline before sending `task.start`. Lost acknowledgements retry the same IDs.
Worker start verifies ownership, resolves only an opaque registered workspace ID, checks the
Agent Host feature/probe, acquires the workspace lease, and atomically persists `accepted`
before launching `AgentRuntime.start`.

The first task for a peer/workspace pair requires local confirmation. “Always allow” stores
only the non-sensitive pair grant; each accepted task is still explicitly pre-authorized for
the runtime confirmation boundary. Runtime progress, bounded output, input, cancellation,
and terminal reducer events are persisted before change notifications. `task.get` reports
retained event gaps, and cancel has a worker deadline that fails with
`TASK_CANCELLATION_UNCONFIRMED` if no terminal confirmation arrives.

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
