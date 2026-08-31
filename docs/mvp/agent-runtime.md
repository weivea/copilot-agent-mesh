# AgentHost / AHP runtime

The MVP runtime is a production adapter over the TypeScript 0.9.0 client built
from pinned `microsoft-agent-host-protocol` commit
`f19dd8b3942d029744a3bdd31d830f9428e8ea47`; it offers exactly `["1.0.0"]`
and negotiates AHP 1.0.0 with
VS Code 1.135.0 and does not use the Fake Agent. Fake AHP connections are limited
to deterministic tests.

## Enable and invoke

The runtime is disabled by default:

```json
{
  "copilotAgentMesh.experimental.agentHost": true
}
```

Run **Copilot Agent Mesh: Run Agent Host Task** for an explicit local invocation. Extension consumers can also use the `agentRuntime` returned by `activate()`. Requests carry only a workspace ID. The injected `WorkspaceResolver` must resolve that ID from the trusted local registry; the adapter rejects unknown or non-`file:` results and passes only the resolved URI as the Session `workingDirectories` entry.

The first-task safety decision is an injected `FirstTaskConfirmation`. The VS Code command supplies a modal implementation; the AHP adapter never assumes approval and cannot bypass the injected decision.

## Lifecycle

When the default-off Peer Delegation Preview is enabled, the target Window Node
first derives the current product's user-data directory and strictly discovers one
live schema-v2 `editor` Unix-socket endpoint at AHP `1.0.0`. Each delegated task
uses its own `net.connect` + authenticated WebSocket Upgrade + AHP client. Discovery,
connection, initialize, or protocol failure falls back to the existing standalone
launcher exactly once and exposes `standalone` plus a bounded degradation reason.
One connection-only failure may re-locate and reconnect the editor once under the
same approval capability before that fallback; no Session or Turn exists at that
boundary.
The selector also serializes the final pre-start endpoint probe with launch and
does not rediscover the endpoint while an editor start is in flight or selected.
This prevents Dashboard refreshes from rotating the registry token between
locate and WebSocket upgrade.
Fallback is forbidden when cleanup of the failed editor attempt is unconfirmed;
starting standalone in that state could overlap resources or execution. Selector
disposal retains failed cleanup for an explicit retry.
With Peer Delegation disabled, the historical standalone behavior is unchanged.
After an editor connection has initialized, authentication, configuration, title,
or task-start failures do not fall back. Source status records the editor as the
selected source plus a bounded failure code/message, rather than retaining an
older standalone probe result or reporting the editor as healthy.

Source fallback sits below one runtime approval boundary. An exact local
`DelegationGrant` validated by the target Window Node produces an in-memory,
WeakMap-backed capability bound to the complete request; same-device peer tasks
therefore show no target Node/runtime modal because the parent's native
Continue/Cancel was the sole consent. Legacy, direct, and cross-device tasks without
that local-source proof retain exactly one target confirmation, whose capability
covers both source attempts. The capability is not a wire/model boolean and carries
no serializable grant, path, or identity data.

The Dashboard does not infer a healthy source before selection. With Peer
Delegation off it reports the source as unavailable for delegation. With the
Preview on, a successful editor probe displays `Editor`; discovery, connection,
initialize, or protocol fallback displays `Standalone (degraded)` with only the
bounded reason category/message. Endpoint tokens, instance IDs, executable,
socket, and user-data paths never enter the ViewModel.

1. Probe a configured or known VS Code CLI candidate with `code --version`.
2. Create an owned instance directory, owner-only token file, dedicated user/server data directories, and an isolated process group.
3. Diff strict `code agent endpoints` JSON and require exactly one new standalone endpoint matching both an owned PID and the generated token. Stdout/stderr are drained but never interpreted as readiness.
4. Connect to the loopback endpoint, initialize AHP, apply the root snapshot, and dynamically select an advertised provider.
5. For standalone, authenticate advertised required resources through the explicit
   VS Code mapping. For editor, reuse the host's existing identity without an
   initial `authenticate` request. Then resolve Session configuration, create the
   Session with the registered workspace URI, and apply its snapshot.
6. Wait for `defaultChat`, subscribe to the Chat, then dispatch only the supplied
   prompt plus acceptance criteria. AHP 1.0 providers may keep a provisional
   Session in `creating` until that first turn materializes it, so startup must
   not wait for `session/ready` before dispatch.
7. Map bounded Chat output/reasoning, tool lifecycle and confirmation, elicited input, MCP authentication, Terminal summaries, and authoritative completion/cancellation/error actions to Mesh-neutral events.

Delegated Sessions use the exact target Workspace URI, publish no child Mesh tools,
and receive the acknowledged title
`Mesh · <safe source window name> → <safe bounded task summary>`. A rejected title
removes the provisional Session. After an authoritative editor-host turn terminal,
cleanup closes subscriptions, client connection, socket, and timers but does not call
`disposeSession`, because that command removes the user-visible history. Standalone
cleanup continues to dispose the Session and owned Host.

Mapped events enter a queue bounded by both serialized UTF-8 bytes and event
count. Progress coalesces to its latest queued value. Nonterminal output is
truncated or dropped under pressure and produces at most one
`outputTruncated` event until the queue falls below its low-water mark. Tool,
input, terminal, completed, failed, and cancelled events are nondroppable and
backpressure their producer. Subscription pumps await admission, while the
consumer remains serial so each retained event finishes task-store persistence
and fsync before the next event is consumed.

Connection recovery retains only `clientId`, Session/Chat URIs, subscriptions, and `lastSeenServerSeq`. It attempts AHP replay/snapshot recovery, re-lists Sessions, and rechecks authentication. Outbound Turn, input, and cancellation actions use persistent `clientSeq` values; actions without an accepted matching `origin` acknowledgement are resent with the same sequence after candidate takeover. Snapshot recovery reconciles accumulated response parts by stable IDs and stream ordinals, emits only undelivered content before authoritative completion, and preserves repeated id-less parts. Writes remain blocked during takeover, and Terminal subscriptions and authentication work are isolated by explicit connection generations. Recovery invalidates and aborts the old generation before shutdown; task disposal aborts and awaits recovery plus Terminal subscription work, then records successful subscription, Session, connection, and Host cleanup phases so a retry repeats only failed work. Missing Hosts or Sessions map to `TASK_RECOVERY_UNAVAILABLE`; authentication failures retain `AGENT_AUTH_REQUIRED` or `AGENT_AUTH_FAILED`. Endpoint tokens are never included in recovery descriptors, events, errors, or logs.
Editor connection tokens, socket/user-data/executable paths, and endpoint instance IDs
are registered in a reference-counted in-memory redaction set for raw and
percent-encoded forms and are removed after the final borrowing task disposes.

The P8 real harness may install a non-throwing, E2E-capability-only lifecycle
observer. It records only the task UUID and one of
`chat/turnComplete`/`chat/turnCancelled`/`chat/error`, allowing evidence to
distinguish the authoritative AHP action from the persisted Mesh terminal state.
It never records an envelope, prompt, output, URI, endpoint, or token, and no
observer exists in production extension mode.

Required Session configuration is rendered from the provider schema. Boolean values use explicit choices, strings remain strings, and numbers, arrays, and objects are parsed and recursively validated as JSON. Invalid, read-only, or unsupported properties fail with `AGENT_CONFIG_REQUIRED` instead of sending a coerced value to the provider.

## Authentication

The editor and standalone paths use different authentication policies. A borrowed
editor endpoint already owns the signed-in Copilot identity: its initial protected
resource list is informational, so `EditorExistingIdentityAuthBroker` performs no
VS Code session lookup and sends no root `authenticate` action. If
`resolveSessionConfig`, `createSession`, a tool, recovery, or a token-invalid
notification produces a real authentication challenge, the editor path fails
`AGENT_AUTH_REQUIRED` with a safe instruction to authenticate in that editor
profile. It never overrides or restarts editor credentials.

The standalone-only `VscodeAuthBroker` is silent-first. A modal `createIfNone`
request is allowed only when the invocation explicitly permits interactive
authentication. It does not infer an authentication provider, GitHub scopes, or
a Copilot resource.

Map each AHP protected-resource URL or advertised authorization-server URL to an existing VS Code authentication provider:

```json
{
  "copilotAgentMesh.experimental.authenticationProviders": {
    "https://authorization.example.test": {
      "providerId": "installed.authentication-provider",
      "scopes": ["exact", "requested", "scopes"]
    }
  }
}
```

A standalone authentication attempt is successful only after the Agent Host
accepts `authenticate`. Missing mappings, unavailable silent credentials, or
interaction-disabled contexts return `AGENT_AUTH_REQUIRED`; rejected tokens
return `AGENT_AUTH_FAILED`. Since tokens are not cached, account/session changes
are observed on the next initial, challenge, or invalid-token authentication
attempt.

## Errors and ownership

The adapter exposes stable codes including `AGENT_UNAVAILABLE`, `AGENT_AUTH_REQUIRED`, `AGENT_AUTH_FAILED`, `AGENT_CONFIG_REQUIRED`, `TASK_EXECUTION_FAILED`, `TASK_CANCELLATION_UNCONFIRMED`, and `TASK_RECOVERY_UNAVAILABLE`. Messages are bounded and token-bearing URL/query or JSON fragments are redacted.

macOS and Linux use dedicated POSIX process groups and terminate only the owned group. Launcher shutdown aborts and awaits in-flight launches before releasing resources. A failed termination remains tracked and retryable; the instance directory is not removed until process-group termination succeeds. Windows fails closed until a Job Object controller is available. The token file remains until owned-host shutdown because the target build has not proved an earlier safe deletion point.

## Tests

Default tests never contact Agent Host or a model:

```bash
npm run test:component
npm test
```

The fake AHP component covers initialize, protected-resource authentication, dynamic configuration, Session/Chat startup, output, input, tool confirmation, cancellation, reconnect replay, Host crash, completion, Terminal summaries, and stable auth failures.

The real test is explicit and uses a temporary non-sensitive workspace:

The authentication-boundary smoke test may finish at the stable, cleanup-safe `AGENT_AUTH_REQUIRED` boundary:

```bash
MESH_AGENT_HOST_AUTH_E2E=1 \
MESH_CODE_CLI=/usr/local/bin/code \
npm run test:agent-host-auth-e2e
```

The separate success-turn test requires an explicit ephemeral token and never accepts an authentication boundary as success:

```bash
MESH_AGENT_HOST_SUCCESS_E2E=1 \
MESH_AGENT_HOST_E2E_TOKEN=... \
MESH_CODE_CLI=/usr/local/bin/code \
npm run test:agent-host-success-e2e
```

Both request a no-file-change response. The success-turn command exits successfully only when an authoritative `turnComplete` accompanies accumulated output equal to `MESH_AGENT_HOST_E2E_OK`; every blocked, partial, or mismatched result is nonzero. Neither command runs in ordinary CI because a successful turn may consume Copilot quota.

The 2026-08-31 P6 editor-source experiment ran on macOS arm64. The Stable registry
command succeeded but returned zero endpoints; Insiders user-data was absent. Editor
initialize and O1 Session visibility therefore remain unverified in that environment,
with no Session created and no sensitive evidence persisted.

P8 performs a bounded post-task editor `listSessions` observation and compares
the newest Session's domain-separated 16-hex fingerprint with the task recovery
Session. It does not open and close a separate pre-task AHP catalog client,
because that borrowed-client lifecycle can perturb editor identity readiness.
Only fingerprints and counts leave the Extension Host. A standalone fallback can
demonstrate degraded execution but can never satisfy the editor Session claim.

## Verified result

On 2026-08-30, macOS arm64 with VS Code `1.135.0` negotiated AHP `1.0.0`,
authenticated through the explicit GitHub mapping, and completed the production
start/output/cancel path:

```json
{
  "outcome": "passed",
  "task": {
    "state": "cancelled",
    "authSessionAvailable": true,
    "startAuthoritative": true,
    "getAuthoritative": true,
    "cancelAuthoritative": true,
    "agentTaskHandleCancelInvoked": true,
    "terminalAuthoritative": true,
    "outputObserved": true
  }
}
```

The sanitized evidence is
`.vscode-test/multi-window-evidence/2ab62a03-51ba-45ef-a01a-0e3829f7ae7c.json`;
it stores no raw prompt, output, token, account, or path.
