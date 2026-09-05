# Cross-device implementation and validation

Date: 2026-09-05. Mesh 0.4.0 Preview, protocol v2.

D1 and D2 are implemented in the production composition. All three feature
settings default off. D2 is an optional **runtime backend**, not an omitted
deliverable. Physical-device, account SSO, private-service admission, real
Agent execution and Chat UI acceptance are separate gates. The authorized
single-Mac GitHub native sign-in/read-only directory gate and the separately
authorized single-Mac D2 private admission plus Mesh/ping gate have passed;
this does not promote the other gates.

Initial implementation used isolated local stores/IPC/sockets and disposable
Extension Host profiles. A subsequent, explicitly authorized GitHub read-only
run used real native authentication and the production SDK query. Later D2
runs separately authorized short-lived private resources and opaque Mesh
advertisements. No anonymous ACE or model turn was used, and the gate runs
performed no Git commit, push or pull request. The real D2 evidence below, not an offline SDK fixture,
establishes the scoped service-admission results.

## Fixed contracts

| Component | Exact implementation contract |
| --- | --- |
| Dev Tunnels contracts / management / connections | `1.3.56`, all pinned in `package.json` and `package-lock.json` |
| Dev Tunnels SSH / SSH TCP | `3.12.42`; public `NodeStream` adapter for the owned relay WebSocket |
| Management API | `2023-09-27-preview` |
| CLI backend | Existing macOS arm64 `1.0.2030+fc9273aa0f` binary and SHA-256 validation, unchanged |
| AHP | Existing submodule `f19dd8b3942d029744a3bdd31d830f9428e8ea47`, unchanged |
| Mesh | v2; actual `RpcPeer` / `PairingService` enrollment/reconnect/commit |
| Dashboard | v8 device tree, strict local DTOs and one-use per-view action aliases |

The published packages were retrieved from the configured Microsoft
`1es-public/npm-public` feed. Direct public npm registry access returned
`ENOTCONN`; this record does not substitute source `main` for a package release.
The installed package declarations and JavaScript were inspected. The lockfile
records each exact tarball and integrity. `node-rsa 1.1.1` supplies the released
SSH package's optional legacy RSA generation import so the production bundle
is self-contained; current VS Code Node runtimes use native crypto. Additional
runtime license texts are generated into `dist/THIRD_PARTY_NOTICES.txt`.

The shared handshake declarations now match production: hello uses
`coordinatorDeviceId`, `clientNonce`, and exactly one of `invitationId`/`peerId`;
authentication uses `sessionId` and `proof`; enrollment commit uses the existing
peer/enrollment proof. Ping sends and returns numeric `sentAt`/`receivedAt`.
Unknown fields remain rejected. No second handshake or protocol-v3 envelope
was introduced. `requireEditor` is an internal Broker-to-Node option, never
accepted in a network task request. The device-tree update adds a server-derived
`remoteTaskApproval` on that same trusted local boundary only. Network v2 remains
unchanged and rejects injected approval metadata.

## Production entry points

| Location | Responsibility |
| --- | --- |
| `src/composition/ProductionConnectivity.ts` | Owner-only composition, persisted intent, native account/pairing/policy/migration actions, safe local snapshots |
| `src/composition/ProductionBrokerRuntime.ts` | Local Broker starts independently; isolated remote initialization, restore and disposal |
| `src/connectivity/AccountSessionProvider.ts` | Explicit exact-account selection, fixed scopes, silent refresh and invalidation |
| `src/connectivity/DevTunnelManagement.ts` | Public SDK calls, cancellation, bounded requests, rate-limit cooldown, restricted cluster redirects and safe errors |
| `src/connectivity/DevTunnelDiscoveryProvider.ts`, `DiscoveryService.ts` | Caller-owned Mesh resources, bounded candidate cache, unknown/stale presence and exact CLI publication |
| `src/connectivity/EndpointBindingStore.ts`, `DevTunnelEndpointResolver.ts`, `BoundPeerTransport.ts` | Explicit binding intents, locator resolution, Mesh identity proof and generation-fenced verified address commits |
| `src/broker/RemotePeerPolicyStore.ts`, `RemotePeerPolicyService.ts` | A's real local source allowlists; B's paired-device grants, receive gate and default-off per-device/Workspace task-start auto-accept |
| `src/gateway/PeerRevocationService.ts`, `PairingService.ts`, `RpcPeer.ts` | Durable denial, live and pending handshake closure, target cancellation and retryable key cleanup |
| `src/tunnel/RemoteExposureProvider.ts`, `CliDevTunnelExposureAdapter.ts` | Thin provider-neutral exposure and adaptation of the unchanged CLI metadata contract |
| `src/tunnel/SdkDevTunnelExposureProvider.ts`, `SdkRelayStreamFactory.ts`, `SelectedExposureProvider.ts` | Actual SDK host, owned cancellable relay socket, private capabilities, renewal, exact cleanup and exclusive selection |
| `shared/protocol/connectivity.ts`, `shared/protocol/remotePolicy.ts`, `DeviceBroker.ts`, `WindowNodeClient.ts` | Strict authenticated local IPC for connectivity and scoped policy actions, including non-owner windows |
| `src/ui/`, `media/dashboard.js`, `ProductionDashboardBindings.ts` | Device/Window/Workspace tree, selected-object controls, task dock, Settings, scoped aliases and cached-only rendering |
| `LocalBrokerTaskFacade.ts`, `ProductionRemoteTaskAdapter.ts`, `WindowNodeTaskExecutor.ts` | Real Tools integration, explicit routing, task reconciliation and editor-only strict remote execution |

The five Mesh Tools remain unchanged. Candidates are not executable workers.
Task ownership, request hashes, cancellation, needs-input, leases and event
sequence reconciliation continue through the existing Broker/task services.
An endpoint refresh never creates a replacement task ID.

## Setup and use

### Device-tree and scoped-acceptance follow-up

The subsequent device-tree update changes Dashboard messages to v8, not the
network protocol. It adds default-off automatic task-start acceptance for one
granted paired device in one target Workspace. B issues the internal approval
at dispatch; the Node requires matching peer, task, Workspace and strict editor
routing. Sensitive runtime inputs retain their existing approval boundaries.
Removing a grant or revoking the peer removes this opt-in. Disabling it affects
future approvals and does not impersonate cancellation of an accepted task.

This update's offline run contains 819 tests: 818 pass, zero fail, one
platform-conditional skip, across 15 suites. The isolated VS Code 1.136.1
extension run has 63 passing tests. Coverage includes default-off policy
migration, atomic all-source-root allowlist edits, claim/owner/revision races,
actual paired-loopback local IPC, one-use UI handles, exact-target unsubmitted
Chat drafts, sensitive-input escalation, bounded tree rendering, duplicate
names, stale selections, and focus/receive-action isolation. Packaging uses
the production bundle and existing VSIX whitelist. The resulting VSIX
(`fa58ff7b6123f84c973d5c8b6550468502a20ab6b45f4d9fdae3e180a3b31992`)
also activated from an isolated installed-extension directory on VS Code
1.136.1; the disposable profile was removed without changing the user's
installed extension or accounts.

The A/B layout preview uses the actual production HTML, CSS and renderer with
explicitly marked example data. It is not real remote-task or Chat visibility
evidence. Earlier private-service/Agent evidence predates this update. No
additional cloud resource, account login or real model turn is authorized or
claimed by these tests; physical-device automatic acceptance and ordinary
Copilot Chat UI remain Unverified.

Existing policy documents load with an empty auto-accept list. Uncheck the
per-device option to restore B's per-task startup prompt. Older builds reject
the newly stored field instead of silently ignoring its authorization meaning;
do not delete policy/revocation records to force a downgrade.

### Automatic offline-window cleanup

Offline Window Nodes no longer appear in the Dashboard's local directory or
device tree; cached offline windows under paired remote devices are also
excluded without forgetting those devices. Reopening a repository registers a
new window instance and reuses its canonical Workspace configuration, not the
old window record.

Internal offline records retain one heartbeat-TTL interval for reconnect
validation (30 seconds by default), then expire on the existing sweep
(5-second default interval). Records with task bindings are never collected by
this timer. Once the existing lifecycle releases the last binding and Lease,
an already-expired offline record is reclaimed. Workspace policies, task
records and task-route history are untouched. No manual-delete RPC or button,
wire-version change, cloud request, or account permission is added.

Use two separately approved **physical macOS arm64 devices** for a physical
gate. Two profiles/processes on one computer only test logical isolation.

1. Open B's existing ordinary VS Code window and intended local Workspace.
   In **Dashboard -> Settings -> Cross-device -> Configure discovery and hosting**, enable
   account discovery, choose GitHub or Microsoft, then choose the exact account
   in native authentication UI. Account identity is provider plus account ID,
   not an email or display name.
2. Separately allow publishing B's Mesh endpoint. D1 requires the independently
   logged-in, exact user-supplied CLI. The management adapter must find that
   exact resource in the selected account's caller-owned list; a shared GET is
   insufficient. No VS Code OAuth token is injected into the CLI.
3. Start the Listener for D1, or explicitly select **Switch to SDK private
   hosting and start** for D2. The latter requires discovery/account/publication
   approval and a drained target. A setting alone never hot-swaps the host.
4. On A, enable discovery and authorize the matching service account. Refresh
   account discovery. Compare B's short candidate marker. Online/unknown
   presence is only a hosting hint, not proof of a live Workspace or Agent.
5. On B, explicitly copy the one-time connection URL. On A, use **Pair this
   candidate** and import it through the native password input. Invitation
   material is not placed in the Webview, directory, logs or reports.
6. Activate strict cross-device delegation on both sides. In **Configure
   strict remote policy**, B grants the newly paired device the selected
   target Workspace and enables receive. A allowlists that authenticated
   remote Workspace from every claimed source root.
7. Enable the existing experimental Agent Host feature only when real model
   execution is separately approved. In A's Agent-mode Chat, use
   `#meshListWorkers` and `#meshDelegateTask` with the exact returned
   Device/Node/NodeInstance/Workspace target. The selected tree Workspace's
   **Delegate from Chat…** opens a partial, unsubmitted draft, without an additional
   source Mesh confirmation. B confirms each remote task by default; it can
   explicitly auto-accept one granted paired device in this target Workspace.
   Sensitive tool approvals are unchanged. Missing/unusable editor hosting fails explicitly; it does not create
   a standalone or Remote Extension Host as a substitute.

GitHub scopes are exactly `read:org` and `user:email`; no `repo` scope is
requested. Microsoft requests only the Dev Tunnels audience
`46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2/.default`. Broader/different returned
scopes, missing sessions, account changes and missing owner-profile sessions
fail closed. Entra consent and consumer MSA must be tested independently.
The audience is not a copied first-party OAuth client ID.

B authorizes **a paired device to a Workspace**, not an independently
authenticated A window. A's Broker derives its source from authenticated
local IPC and current claims. Network callers still cannot supply a local
`sourceNodeId`. Display labels and capability markers never grant permission.

## Storage, lifecycle and recovery

All new documents are bounded strict-schema atomic files under the existing
`mesh-state` storage root, fenced to the current owner generation.

| File | Persistent contents |
| --- | --- |
| `connectivity/settings.json` | Local account reference/ID/scopes, publish intent, advertisement, strict latch and explicit backend/migration state |
| `connectivity/endpoints.json` | Verified peer/profile-generation bindings; separate approved non-secret pending binding intents |
| `connectivity/sdk-hosting.json` | Exact owned SDK resource/port/account reference, phase and endpoint cleanup handle |
| `peers/remote-policy.json` | Per-source bound targets, per-target incoming peer IDs and their default-empty auto-accept subset |
| `peers/revocations.json` | Durable denial and exact remaining credential/cancellation cleanup work |
| Existing `peers/policy.json` | Shared receive field; local allowlist semantics remain unchanged |

OAuth and service capabilities stay in adapter memory and intended
authentication headers. They do not enter the documents, IPC, Webview,
command arguments or reports. Mesh roots stay in SecretStorage.

Discovery is bounded to ten resources, requests to ten seconds, concurrent
management operations to two, refreshes to at least ten seconds and periodic
refresh to about sixty seconds. Candidates become stale after two minutes.
Retry-After is bounded and respected. WSS handshakes are bounded to eight
seconds; the existing RPC/heartbeat budgets remain.

Private hosting creates one HTTP port with empty ACL entries, requests only a
Host capability for hosting and an exact-port Connect capability for admission,
and rejects unexpected anonymous ACEs. HTTP/WSS use system CA validation.
Management redirects are limited to the official service clusters with the
same path/query; WSS redirects are disabled. SDK forwarding stays on
`127.0.0.1`; the actual service/Extension Host IPv4 gate remains unverified.
Token renewal failure stops private admission and surfaces an error.
SDK endpoint-registration HTTP requests are linked to the owner/provider
lifetime, including the SDK's pre-connect registration step. Cancellation
aborts that actual request; only bounded, exact-endpoint DELETE cleanup remains
permitted afterward. A retained old endpoint is cleaned before a replacement
host is started, and unknown/nonzero existing host presence blocks competition.

Pending enrollment recovery, reconnect and endpoint changes keep the original
peer/root and task identities. Profile/account/advertisement/resource changes
require explicit binding. Deleting a profile cleans its matching side-table
references; startup removes only proven orphan generations. Remote-state
corruption blocks remote initialization without stopping local Broker/Node
capabilities.

Document authorization is checked immediately before the atomic rename, which
is the commit point. A validation failure before that point leaves the previous
document intact; a later claim change does not retroactively report an already
committed grant as rejected. When strict remote listing is disabled, unready or
draining, the local Broker returns no remote targets **before** making peer RPCs,
so local worker discovery remains usable.

### Revocation is not just disconnect

Removing a source allowlist entry or disabling receive/grant blocks new tasks;
accepted tasks retain ownership and can still be read/cancelled/answered.
Revoking an entire incoming peer first persists denial, then closes its
authenticated and in-progress handshakes, requests cancellation through B's
existing authoritative task service, and deletes exact credentials. Cleanup
failure leaves denial in force across restart. **Retry connectivity cleanup**
resumes the recorded work. A disconnected source must not report B's task as
cancelled merely because its socket closed.
The bounded incoming view prioritizes active/pending peers before revoked
history. Native configuration also provides an exact-peer selector covering
records outside the view; truncation never makes a peer impossible to revoke.

### Migration and rollback

The native migration action latches migration-pending, requires active target
tasks to drain, stops the old host successfully, and only then selects/starts
the new provider. Retaining versus deleting the exact old owned resource is an
explicit choice. A failed private start never restarts anonymous CLI hosting.
Retry the selected backend or explicitly choose the warned CLI fallback.
If old cleanup cannot be confirmed, a competing host is not started.

After changing a resource/port/advertisement/backend, use the candidate action
to **rebind the already paired device**; the existing root must prove its
identity again. New pairing identities do not inherit incoming grants.
SDK resource deletion is explicit and checks the recorded ID and ownership
marker; no name/label/prefix sweeps are used.

Turning off delegation keeps the strict latch. Turning off discovery does not
revoke Mesh identity or silently change admission. Before downgrading to an
older binary that cannot read the new policy/tombstones, stop hosting,
drain/cancel tasks, revoke incoming peers and finish credential cleanup, then
remove outbound test profiles as appropriate. Do not assume an old binary
enforces a new revocation document.

**Stopping advertisement updates is not unpublishing.** Consistent with the
discovery-off boundary, disabling queries/updates or clearing the account does
not silently issue another cloud mutation or erase an existing advertisement.
Native prompts and the Dashboard explicitly say this. To withdraw the
candidate, use the explicit exact-owned-resource deletion action (CLI and SDK
both have one). Delete it before clearing its account, or reauthorize that exact
account for SDK cleanup. Stopping a host alone may leave an offline candidate.

## Gate evidence and reproducible commands

After the native-account compatibility fix, the serialized complete offline
suite has **799 passing tests, zero failures and one platform-conditional skip**
(800 tests, 15 suites). The skipped
unsupported-actual-platform case does not apply to this macOS arm64 runner.
The full Extension Host run has **51 passing tests** on VS Code `1.136.1`
(downloaded build `07b4ff1883f94da91f6d698744fc7c3638b59720`). These tests cover
activation and programmatic Dashboard/IPC behavior, not authenticated Agent
execution or ordinary Chat visibility. The final runs include the core
review fixes and the published SDK default-host initialization fixture.

```sh
npm run compile-tests
node --test --test-timeout=120000 \
  out/src/unitTest/*.test.js out/src/test/unit/*.test.js \
  out/src/componentTest/*.test.js
npm run check-types
npm run lint
npm run test:extension
npm run package:vsix
```

Run generation/compilation before tests, not concurrently with them: the
existing `ahp:build` generator rewrites its generated directory and client
output. This does not change the AHP pin.
Extension tests use a fresh disposable profile and must not be mistaken for
authenticated Agent or Chat acceptance.

| Gate | Status | Evidence / missing condition |
| --- | --- | --- |
| M0 published SDK and production wire | Pass, offline | Lockfile; installed versioned sources; strict production pairing/reconnect/commit/numeric-ping fixtures |
| M1 owner-only discovery/account boundary | Pass, offline | `connectivityDiscovery.test.ts`, production startup/IPC tests: disabled/non-owner zero auth/HTTP; scope/account changes, timeout, cooldown, URI and safe candidate handling |
| M2 binding and reconnect | Pass, loopback | `crossDeviceConnectivity.test.ts`: real production Mesh sockets, same-root rebinding, wrong identity, pairing failure, closed socket and profile/owner races |
| M3 policy, revocation and editor requirement | Pass, offline/loopback | `remotePeerPolicy.test.ts`, production startup, revocation socket/handshake/restart/cleanup tests and editor-selector regressions |
| M4 private SDK lifecycle | Pass, offline fixtures | `sdkPrivateHosting.test.ts`: published SDK request serialization, actual default-host initialization before a deliberately missing relay URI, no anonymous request ACL, Host-only client, port-specific Connect request, actual HTTP abort, renewal/cleanup and exclusive fallback |
| Existing task semantics | Pass, offline regression | Broker/task-route/idempotency/waiter/runtime suites: lost acknowledgements, semantic conflicts, needs-input, authoritative cancellation, lease release and event reconciliation |
| Extension Host / Dashboard code | Pass | 51 tests on isolated VS Code 1.136.1/macOS arm64; no auth, hosting or model task |
| Build / package / installed activation | Pass | Typecheck, lint, production bundle, 14-file VSIX whitelist and isolated installed-VSIX activation; local artifact only |
| GitHub native authorization and read-only directory, one Mac | Pass, scoped real run | VS Code 1.136.1 `a44adf7f53e00964ab890f9f8758a334f1fc15bc`, macOS arm64, exact `read:org`/`user:email`, production local IPC action then silent session reuse/SDK list: `ready`, zero candidates, no publication/hosting/model. Cross-profile/two-device reuse remains unverified |
| Entra / consumer MSA SSO | Blocked separately | No approved accounts, tenant consent or consumer-MSA experiment |
| D1 actual CLI + selected-account ownership | Blocked | Exact user-provided CLI, separately authorized CLI login and isolated public-resource permission required |
| D2 real private ingress, one Mac | Pass, scoped admission only | Authorized production SDK host reached ready; actual tunnel/port ACLs had no anonymous ACE; missing capability returned 302 without WSS upgrade, invalid capability 401, legitimate wrong-port capability 403; a correct service capability still required Mesh auth |
| D2 Mesh-over-private, single-Mac synthetic client | Pass on separately authorized retry; original failure retained | Production SDK host/Gateway, real private WSS, production PeerConnectionManager, successful hello/authenticate/enrollmentCommit/device.getInfo and 100 numeric pings; 26,445 application bytes, exact cloud cleanup confirmed within about 48 seconds. Not two physical devices, ordinary source-window delegation, Agent execution, live expiry/renewal or running-CLI migration evidence |
| Two physical devices / NAT / enterprise proxy / profile switch | Blocked | No approved second physical device or network/account experiment; loopback does not prove this |
| Real cross-device Agent, original Workspace and editor | Blocked | No model-budget authorization; no real cross-device task launched |
| Source same-Chat and target ordinary Chat Sessions visibility | Unverified | Requires independent real UI observation; Host catalog/session existence is insufficient |
| Long-duration stability and real renewal/migration | Unverified | Requires separately approved duration, network conditions and exact-resource cleanup |

### Authorized single-Mac GitHub gate (executed)

The user explicitly approved GitHub account selection in a dedicated Profile
and read-only Dev Tunnels discovery, excluding publication, tunnel creation,
hosting and model execution. The native-dialog-enabled run completed from
2026-09-05 19:45:31 to 19:46:56 Asia/Shanghai.

The packaged extension ran its real
`node.connectivityAction('configureConnectivity')` path. The user selected
GitHub and completed native consent; the production adapter then reused the
session silently for its SDK caller-owned Mesh query. Generated session
evidence `github-readonly-gate/evidence-attempt-2.json` records:

| Observation | Result |
| --- | --- |
| Provider / requested scopes | `github`; exactly `read:org`, `user:email` |
| Production directory result | `ready`, query succeeded, candidate count `0`, not truncated |
| Listener | `stopped`, start-attempt count `0` |
| Publication / Agent / cloud resource changes | None |
| Cleanup | Discovery disabled, extension resources disposed, owned test process exited, isolated Profile removed |
| Physical topology | One Mac only; no physical-device pairing or data plane tested |

An empty result is a successful authenticated directory query, not proof that
any remote device has been discovered. No token, account ID, invitation or
raw user log is stored in the report. Removing this temporary Profile does
not revoke the user's GitHub-side OAuth application authorization.

The first attempt was an invalid interactive harness, not a failed GitHub
service gate: VS Code's `--extensionTestsPath` mode explicitly refuses native
authentication dialogs. The successful retry omitted that mode and let the
user interact normally. Source inspection also found and fixed a production
compatibility error: silent reuse previously supplied `accountId` as the
account label. It now finds the exact ID through stable `getAccounts()`, passes
the provider's actual account object, and still verifies the returned ID.
Native authentication errors are reported as authentication/cancellation
failures rather than unrelated discovery errors.

### Authorized single-Mac D2 private admission (executed)

The user separately approved one temporary private Dev Tunnel, at most two
test ports, at most five minutes from resource creation and 1 MiB of application
test traffic, without model execution. The production SDK backend created one
Gateway port. A short-lived second loopback-only test port on the same exact
resource was used to obtain a legitimate wrong-port Connect capability and
was removed before the Mesh handshake. This does not change the production
backend's one-Gateway-port contract.

The successful run used the installed package with SHA-256 recorded below,
macOS arm64 and VS Code 1.136.1 commit
`a44adf7f53e00964ab890f9f8758a334f1fc15bc`. Native account, publication and SDK
selection actions ran through the real production local IPC path. The source
was an explicitly synthetic client in the same Extension Host using production
`PeerConnectionManager`/`WebSocketPeerTransport`, not a second physical device
or an ordinary source-window Agent task.

| Observation | Generated result |
| --- | --- |
| Actual production SDK host | Ready; Listener start-attempt count `1` |
| Actual tunnel and both test-port ACLs | No anonymous ACE |
| Missing service capability | HTTP `302`, no WSS upgrade followed |
| Invalid service capability | HTTP `401` |
| Legitimate capability for the wrong test port | HTTP `403` |
| Correct capability without Mesh proof | Mesh `AUTH_REQUIRED`; service credentials do not authenticate the peer |
| Mesh proof | `mesh.hello`, `mesh.authenticate`, `mesh.enrollmentCommit` and authenticated `device.getInfo` succeeded |
| Application traffic | `100` numeric ping replies; `26,445` application-frame bytes (not total TLS/SSH overhead) |
| Cloud operation window | 20:36:29.126 to 20:37:16.800 Asia/Shanghai, including confirmed exact-resource deletion |
| Cleanup | Exact tunnel deletion verified; local services stopped, process exited and isolated Profile removed |

Generated safe session evidence is
`d2-private-gate/evidence-attempt-3.json`. It records method names, response
field names, stable error codes, counts and timestamps, not tokens, proofs,
account IDs, resource IDs, prompts or raw user logs. Exact resource IDs existed
only in the protected cleanup ledger, which was removed after deletion was
confirmed.

History is not rewritten: the first setup attempt never enabled publication
and created no resource. The first cloud-resource run passed private admission
but failed during the following Mesh enrollment; its exact resource was
deleted. Its original harness omitted the detailed transport reason, so the
root cause cannot be established from that record. No-cloud checks with real
native storage, full production composition and the installed bundle passed.
The separately approved retry added safe phase/RPC traces and used the
production peer manager; that run completed on its first enrollment attempt
without needing recovery. This is evidence of a successful bounded run,
**not proof that the earlier intermittent failure has been root-caused or that
long-duration reliability has passed**.

Token expiry/renewal, active CLI-to-SDK migration, cross-profile/owner races
over the real relay, two physical devices and real Agent/Chat visibility
remain separate gates. Neither synthetic ping nor the service-side port
catalog establishes those results.

### No-model physical-gate procedure (not executed)

After obtaining explicit permission, use dedicated profiles, non-sensitive
workspaces, two physical devices, one exact approved resource/port, a five-minute
watchdog and a 1 MiB application-traffic budget. Do not borrow a developer's
normal profile or read private credential databases. Record only versions,
role/topology attestations, bounded codes/counters and exact cleanup success;
keep resource IDs solely in the restricted local ledger needed for cleanup.

Follow setup steps 1-5. In A's native configuration menu choose **Probe a bound
connection**. This is a real production `mesh.ping` operation, bounded to 100
requests, 60 seconds and at most 1 MiB of its own application traffic. Timeout
closes the exact source connection. It creates no hosting resource and always
labels physical topology unverified; the operator must establish the physical
topology separately. It does not bound unrelated pre-existing task streams:
the experiment must use an idle isolated connection.

On B stop the test host, observe A disconnect, restore that exact permitted
host and reconnect/rebind as required. Exercise account removal, missing
scopes, stale claims, revoke, owner takeover and cleanup failure separately.
For D2 use an independently bounded test client to submit missing, wrong and
wrong-port service capabilities: an application mock of this rejection is
not sufficient. Check both tunnel and port ACLs through the approved management
channel. Stop hosting and use exact-resource cleanup; retry recorded failures
before calling the resource gate Pass. Remove only the exact test pairing
profiles afterward. The native probe is not a remote process/watchdog or
automatic cloud-resource cleanup harness.

Real Agent/UI acceptance is a different run: separately approve model quota,
use B's already-open original Workspace/editor, retain both task confirmations,
collect authoritative task/input/cancel events, and independently observe A's
same Chat and B's ordinary Chat UI. Close the editor endpoint and confirm
strict execution fails rather than falling back. Never fill in Pass manually
or use a directory catalog as a proxy for these observations.

## Limits and residual resources

Dev Tunnels remains Public Preview with no production SLA. WSS TLS terminates
at Microsoft ingress; private capabilities and Mesh HMAC do not make the
content relay-blind E2EE. No WebRTC, Tailscale, OpenSSH or mDNS backend, no new
Worker platform and no background OS service was added.

Entra/MSA, cross-profile and two-device SSO, two-physical-device private forwarding,
other proxy/CA environments, real expiry/renewal and real Agent/Chat compatibility remain
explicitly unverified. Old `ahp-session:` histories are
not renamed, provider-scoped URIs/folder isolation are unchanged, and separate
user Copilot activity is not independently detectable through stable APIs.

The subsequent explicitly authorized D2 experiments created two short-lived
private tunnel resources in separate runs, one per authorization; both exact
deletions were confirmed. No model task or long-lived cloud service was created.
Local dependencies, build artifacts and the test runner's VS Code download
cache are intentional development outputs, not evidence of a running host.
Disposable test profiles, sockets and owned test processes are checked and
cleaned by the test lifecycle. The isolated Extension Host test processes
exited, and installed-VSIX smoke activation exited successfully and removed
its temporary profile.

Artifact used for the authorized GitHub and D2 gates: `artifacts/copilot-agent-mesh-0.4.0-preview.vsix`
(14 verified entries, about 539 KiB). SHA-256:

```text
8d0a36970a13d967d242abc0d098d70a22bfb4afe85fc353d0a5143e54b881ac
```

The previous packaging checkpoint passed isolated activation smoke. The
account-adapter build above passed package verification, real native GitHub
authentication/read-only discovery and the separately authorized D2 private
admission/Mesh-ping retry in fresh isolated VS Code 1.136.1 profiles; the
successful gate supervisors exited with code 0.
No task-owned cloud resource, hosting process or test IPC listener remains.
The AHP submodule was not upgraded, and the gate runs did not change Git HEAD
or publish a package. Subsequent user-requested source commits and pushes are
separate from these experiments.
