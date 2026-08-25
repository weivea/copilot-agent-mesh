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
Extension Host security boundary. The production fallback is
`UnavailableDashboardFacade`; it reads only the configured device metadata and
reports services as unavailable. It never creates fake online state or fake tasks.

## Message and data boundary

The webview sends only action names and bounded opaque IDs. Connection URLs,
pairing secrets, task prompts, complete output, answers, credentials, and local
paths never cross the message bus. Both directions are runtime validated, and
outbound messages are rejected when they contain forbidden fields, local path
shapes, secret URL fragments, or oversized strings.

Each resolved view receives a new `uiInstanceId`. Messages from stale instances
are rejected, and resolve/dispose cleanup is idempotent.

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
