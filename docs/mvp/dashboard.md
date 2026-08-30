# MVP Dashboard integration

The dashboard is a secure presentation and command surface. It does not own device,
listener, tunnel, workspace, peer, or task state.

P7 provides `This Window`, `Accept Incoming Tasks`, `Local Window Nodes`,
`Outgoing Tasks`, and `Incoming Tasks`. `This Window` keeps the P3 effective
window label, current Workspace display name, claim status, Preview status, and
rename control. It also shows the P6 Agent Host source as `Editor`,
`Standalone (degraded)`, or an explicit unavailable/not-yet-selected state. The
controls are disabled while the default-off Peer Delegation Preview is disabled. The strict
`renameWindow` Webview action carries no name, path, Workspace ID, or
`workspaceIdentity`; the Extension Host collects the name and derives the
caller-owned claimed Workspace through `ProductionDashboardBindings` and
`WindowNodeClient`.

Before opening the InputBox, the bindings create an Extension Host-only rename
session that closes over the selected identity and safe prefill. Submission
revalidates that Preview remains enabled and the live claimed/active Workspace
still matches that identity. A changed or ambiguous selection fails with
`WORKSPACE_SELECTION_AMBIGUOUS`; it never retargets the rename.

The base safety Dashboard reads `node.dashboard.list`, not Tool-facing
`node.list`. This safe unfiltered projection preserves this-window identity,
Workspace claim/conflict and busy state, active task naming, and
directory-truncation warnings even while peer delegation is disabled or no
target passes the authorization gate. Full workspace identities are removed at
the Broker boundary.

For multi-root windows, a single claimed Workspace is selected directly.
Otherwise the active editor's Workspace must uniquely match an own claim; an
ambiguous selection fails explicitly rather than mutating an arbitrary policy.
Selection matches both the original VS Code Workspace URI and its canonical
execution URI so symlinked roots retain stable active-Workspace provenance.
Successful writes broadcast `node.policy.changed`, and task/topology/source
changes use event notifications, so all open dashboards re-render without
polling or reload.

The peer configuration list is intentionally broader than `mesh_list_workers`.
It shows every same-device candidate and its online, accept, busy, claim, and
double-gate state, including self where useful and persisted offline allowlist
entries. A checked box changes only the current source Workspace's `A -> B`
allowlist. It never grants `B -> A`.

Candidate and task mutations use two layers of one-time opaque handles. The
Broker handle is scoped to the authenticated IPC Session and binds the exact
source policy plus stable target identity/current Node instance, or exact task
ID plus incoming/outgoing authorization path. The View provider wraps it in a
fresh `uiInstanceId`-scoped handle on every publication. Refresh, topology or
policy changes, successful/failed consumption, replay, cross-view use, wrong
direction, and disposal fail closed. No label or short ID authorizes a mutation.
Offline saved targets can only be unchecked.

Task cancellation redeems the visible action handle into a separate bounded
in-flight reservation before the Extension Host opens its confirmation modal.
That reservation survives ordinary snapshot refreshes, is consumed by cancel,
and is explicitly released when the user declines, so status notifications
cannot retarget or invalidate an already displayed confirmation.

Outgoing tasks are selected by exact source Node ownership; incoming tasks are
selected by exact target Node instance. Their Webview records contain only a
safe counterpart label, Workspace display name, bounded sanitized title,
authoritative status, start time, and eight-character display ID. Raw prompts,
output, artifacts, paths, complete identities, and task UUIDs are absent.
Incoming cancel uses target authorization; outgoing cancel uses owner
authorization. Remote outgoing snapshots are refreshed by the same authoritative
task notifications and retained in a bounded per-window cache; merged task
collections are sorted and truncated to the strict 500-item UI limit with an
explicit warning. Dashboard has no answer-input path.

P6 exposes an Agent Host source status provider with typed `editor | standalone`
source, a bounded degradation enum/message, and change notifications wired into the
existing Dashboard refresh event. The existing Agent Host component projects
`Editor`, `Standalone`, or `Standalone (degraded)` without exposing an endpoint
document or sensitive fields; P7 owns the broader Dashboard rework.

## Facade contract

`src/ui/DashboardFacade.ts` exports `DashboardFacade`, `DashboardSnapshot`,
`DashboardServiceBindings`, and `ServiceDashboardFacade`. The application
composition root should adapt the real stores and application services to
`DashboardServiceBindings`, then construct `ServiceDashboardFacade`:

| Facade operation | Required application-service behavior |
| --- | --- |
| `getSnapshot` / `onDidChange` | Read and observe device, listener, tunnel, AHP, workspace, peer, task, and stable error state |
| `configureDeviceName` | Collect the name in Extension Host UI and persist it through the device service |
| `prepareWindowRename` / `renameCurrentWindow` | Capture one owned Workspace before collecting a bounded name, revalidate it on submit, then invoke the authenticated policy RPC |
| `registerCurrentWorkspace` / `removeWorkspace` | Register the active local workspace or confirm and remove by `workspaceId` |
| `startListener` / `stopListener` | Drive the real gateway and tunnel lifecycle |
| `copyConnectionUrl` | Obtain the one-time URL and write it directly with `vscode.env.clipboard`; never return or post it to the webview |
| `addPeer` / `removePeer` | Collect the URL in Extension Host UI, enroll it, or confirm and revoke by `peerId` |
| `setAcceptIncoming` | Resolve the current exact owned Workspace in Extension Host and update only its receive policy |
| `setPeerAllowed` | Redeem a one-time Broker candidate handle for one directional allow/revoke mutation |
| `cancelDashboardTask` | Confirm locally and redeem a direction-bound one-time task handle |

Destructive confirmations are a Facade responsibility and therefore remain an
Extension Host security boundary. This includes listener stop, workspace/peer
removal, and task cancellation. The production fallback is
`UnavailableDashboardFacade`; it reads only the configured device metadata and
reports services as unavailable. It never creates fake online state or fake tasks.

## Message and data boundary

The webview sends only action names and bounded opaque IDs. Window names,
Workspace identities, connection URLs, pairing secrets, task prompts, complete
output, answers, credentials, and local paths never cross the message bus.
Both directions are runtime validated, and
outbound messages are rejected when they contain forbidden fields, local path
shapes, secret URL fragments, or oversized strings. Foundation's complete task
state set is reused directly, including `recovering` and `cancelling`.

Each resolved view receives a new `uiInstanceId`. Messages from stale instances
are rejected, resolve/dispose cleanup is idempotent, and snapshot reads are
serialized and coalesced per instance so an older async read cannot overwrite a
newer state.

The presenter redacts path-bearing remote summaries, component details, and
errors. The outbound guard independently rejects POSIX, Windows, UNC, file URI,
and relative source-path forms in any string. This defense is applied after
strict ViewModel shape validation and before every `postMessage`. Secret checks
canonicalize percent encoding for a bounded number of rounds and fail closed on
malformed or oversized input before recognizing JSON, quoted, and whitespace
credential assignments, including normalized compound keys such as access token,
client secret, auth token, ID token, API key, private key, and refresh token.
Credential keys use explicit sensitive suffixes so ordinary fields such as
`tokenCount` remain valid; quoted keys may contain spaces or hyphens. GitHub
classic, OAuth, user, server, refresh, and fine-grained token prefixes are
centralized in one deny list. HTTP(S) values are parsed;
their decoded pathname, query keys/values, and fragment are recursively subjected
to the same path and secret checks; any URL userinfo is rejected. URI schemes are
canonicalized and parsed generically, with non-HTTP(S) schemes rejected fail
closed so prefixed VS Code, remote, file, malformed, and unknown URI tokens cannot
bypass path checks. Every `scheme:` form is inspected. Before URL parsing,
HTTP(S) must have the exact raw `scheme://host` authority shape with two slashes
and a non-empty host segment. URI candidates are checked in raw form before each
bounded percent-decoding round, C0 input is rejected, and decoded path, query,
and fragment components recursively pass through the same guard.
Query components use form-urlencoded `+` normalization before recursive
inspection. Every bracket-key segment is normalized independently, so keys such
as `credentials[password]`, `user[api_key][value]`, and `api+key` are treated as
credentials. A valid task summary may use the
Foundation 16 KiB limit; the presenter truncates that field at a UTF-8 code-point
boundary to the 2 KiB UI limit and carries `summaryTruncated` so the webview shows
that the displayed summary is incomplete.

The webview loads `media/dashboard.js` and `media/dashboard.css` through
`asWebviewUri`. Its resource roots contain only `media/`, scripts are enabled, and
the CSP is `default-src 'none'` with the nonce and `webview.cspSource`. Remote
strings are rendered with `textContent`; the bundle does not use `innerHTML`.

## Composition exports

- View ID: `AgentMeshViewProvider.viewType`
- Manifest command IDs: `DASHBOARD_COMMANDS.configureDevice`,
  `DASHBOARD_COMMANDS.refresh`
- Application boundary: `DashboardFacade`
- Real-service adapter: `DashboardServiceBindings` + `ServiceDashboardFacade`
- Read model: `DashboardSnapshot`
- Presenter: `DashboardPresenter`
