# MVP Dashboard integration

The dashboard is a secure presentation and command surface. It does not own device,
listener, tunnel, workspace, peer, or task state.

## Facade contract

`src/ui/DashboardFacade.ts` exports `DashboardFacade`, `DashboardSnapshot`,
`DashboardServiceBindings`, and `ServiceDashboardFacade`. The application
composition root should adapt the real stores and application services to
`DashboardServiceBindings`, then construct `ServiceDashboardFacade`:

| Facade operation | Required application-service behavior |
| --- | --- |
| `getSnapshot` / `onDidChange` | Read and observe device, listener, tunnel, AHP, workspace, peer, task, and stable error state |
| `configureDeviceName` | Collect the name in Extension Host UI and persist it through the device service |
| `registerCurrentWorkspace` / `removeWorkspace` | Register the active local workspace or confirm and remove by `workspaceId` |
| `startListener` / `stopListener` | Drive the real gateway and tunnel lifecycle |
| `copyConnectionUrl` | Obtain the one-time URL and write it directly with `vscode.env.clipboard`; never return or post it to the webview |
| `addPeer` / `removePeer` | Collect the URL in Extension Host UI, enroll it, or confirm and revoke by `peerId` |
| `runTask` | Collect the full task prompt in Extension Host UI and call the coordinator with optional safe peer/workspace IDs |
| `cancelTask` | Confirm locally and cancel by `taskId` |
| `answerTaskInput` | Collect the answer in Extension Host UI and submit it by `taskId` |

Destructive confirmations are a Facade responsibility and therefore remain an
Extension Host security boundary. This includes listener stop, workspace/peer
removal, and task cancellation. The production fallback is
`UnavailableDashboardFacade`; it reads only the configured device metadata and
reports services as unavailable. It never creates fake online state or fake tasks.

## Message and data boundary

The webview sends only action names and bounded opaque IDs. Connection URLs,
pairing secrets, task prompts, complete output, answers, credentials, and local
paths never cross the message bus. Both directions are runtime validated, and
outbound messages are rejected when they contain forbidden fields, local path
shapes, secret URL fragments, or oversized strings.

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
