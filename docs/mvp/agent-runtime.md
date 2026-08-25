# AgentHost / AHP runtime

The MVP runtime is a production adapter over `@microsoft/agent-host-protocol@0.8.0`; it does not use the Fake Agent. Fake AHP connections are limited to deterministic component tests.

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
6. Wait for `session/ready` and `defaultChat`, subscribe to the Chat, then dispatch only the supplied prompt plus acceptance criteria.
7. Map bounded Chat output/reasoning, tool lifecycle and confirmation, elicited input, MCP authentication, Terminal summaries, and authoritative completion/cancellation/error actions to Mesh-neutral events.

Connection recovery retains only `clientId`, Session/Chat URIs, subscriptions, and `lastSeenServerSeq`. It attempts AHP replay/snapshot recovery, re-lists Sessions, and rechecks authentication. Missing Hosts or Sessions map to `TASK_RECOVERY_UNAVAILABLE`; authentication failures retain `AGENT_AUTH_REQUIRED` or `AGENT_AUTH_FAILED`. Endpoint tokens are never included in recovery descriptors, events, errors, or logs.

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

```bash
MESH_AGENT_HOST_E2E=1 \
MESH_CODE_CLI=/usr/local/bin/code \
npm run test:agent-host-e2e
```

It requests a no-file-change response and accepts success only when an authoritative `turnComplete` accompanies accumulated output equal to `MESH_AGENT_HOST_E2E_OK`. The stable `AGENT_AUTH_REQUIRED` boundary is accepted only after error-free runtime cleanup when the non-interactive harness cannot obtain a VS Code authentication session. It must not run in ordinary CI because a successful turn may consume Copilot quota.

## Verified result

On 2026-08-25, macOS arm64 with VS Code `1.134.0` reached the real AHP `0.8.0` Host, initialized the root snapshot, discovered the provider dynamically, and stopped at the expected production boundary:

```json
{
  "outcome": "blocked",
  "code": "AGENT_AUTH_REQUIRED",
  "reason": "Authentication requires an explicit user action in VS Code. Resource: GitHub Copilot."
}
```

This is not reported as Session or Turn success. A real turn remains dependent on running inside VS Code with an explicitly configured authentication-provider mapping and user-approved interactive authentication.
