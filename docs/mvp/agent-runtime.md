# AgentHost / AHP runtime

The MVP runtime is a production adapter over the TypeScript 0.9.0 client built
from pinned `microsoft-agent-host-protocol` commit
`f19dd8b3942d029744a3bdd31d830f9428e8ea47`; it negotiates AHP 1.0.0 with
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

1. Probe a configured or known VS Code CLI candidate with `code --version`.
2. Create an owned instance directory, owner-only token file, dedicated user/server data directories, and an isolated process group.
3. Diff strict `code agent endpoints` JSON and require exactly one new standalone endpoint matching both an owned PID and the generated token. Stdout/stderr are drained but never interpreted as readiness.
4. Connect to the loopback endpoint, initialize AHP, apply the root snapshot, and dynamically select an advertised provider.
5. Authenticate advertised required resources, resolve Session configuration (including dynamic completions), create the Session with the registered workspace URI, and apply the Session snapshot before processing actions.
6. Wait for `defaultChat`, subscribe to the Chat, then dispatch only the supplied
   prompt plus acceptance criteria. AHP 1.0 providers may keep a provisional
   Session in `creating` until that first turn materializes it, so startup must
   not wait for `session/ready` before dispatch.
7. Map bounded Chat output/reasoning, tool lifecycle and confirmation, elicited input, MCP authentication, Terminal summaries, and authoritative completion/cancellation/error actions to Mesh-neutral events.

Mapped events enter a queue bounded by both serialized UTF-8 bytes and event
count. Progress coalesces to its latest queued value. Nonterminal output is
truncated or dropped under pressure and produces at most one
`outputTruncated` event until the queue falls below its low-water mark. Tool,
input, terminal, completed, failed, and cancelled events are nondroppable and
backpressure their producer. Subscription pumps await admission, while the
consumer remains serial so each retained event finishes task-store persistence
and fsync before the next event is consumed.

Connection recovery retains only `clientId`, Session/Chat URIs, subscriptions, and `lastSeenServerSeq`. It attempts AHP replay/snapshot recovery, re-lists Sessions, and rechecks authentication. Outbound Turn, input, and cancellation actions use persistent `clientSeq` values; actions without an accepted matching `origin` acknowledgement are resent with the same sequence after candidate takeover. Snapshot recovery reconciles accumulated response parts by stable IDs and stream ordinals, emits only undelivered content before authoritative completion, and preserves repeated id-less parts. Writes remain blocked during takeover, and Terminal subscriptions and authentication work are isolated by explicit connection generations. Recovery invalidates and aborts the old generation before shutdown; task disposal aborts and awaits recovery plus Terminal subscription work, then records successful subscription, Session, connection, and Host cleanup phases so a retry repeats only failed work. Missing Hosts or Sessions map to `TASK_RECOVERY_UNAVAILABLE`; authentication failures retain `AGENT_AUTH_REQUIRED` or `AGENT_AUTH_FAILED`. Endpoint tokens are never included in recovery descriptors, events, errors, or logs.

Required Session configuration is rendered from the provider schema. Boolean values use explicit choices, strings remain strings, and numbers, arrays, and objects are parsed and recursively validated as JSON. Invalid, read-only, or unsupported properties fail with `AGENT_CONFIG_REQUIRED` instead of sending a coerced value to the provider.

## Authentication

`VscodeAuthBroker` is silent-first. A modal `createIfNone` request is allowed only when the invocation explicitly permits interactive authentication. The adapter does not infer an authentication provider, GitHub scopes, or a Copilot resource.

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

An authentication attempt is successful only after the Agent Host accepts `authenticate`. Missing mappings, unavailable silent credentials, or interaction-disabled contexts return `AGENT_AUTH_REQUIRED`; rejected tokens return `AGENT_AUTH_FAILED`. Since tokens are not cached, account/session changes are observed on the next initial, challenge, or invalid-token authentication attempt.

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
