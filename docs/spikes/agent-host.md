# Agent Host / AHP Spike

## Gate

**P0.2 overall: NO-GO.** The current macOS build passes owned process startup, JSON endpoint discovery, token/PID/URL validation, WebSocket transport, AHP version negotiation, `initialize`, Root snapshot, and dynamic provider discovery. Authentication, Session configuration/creation, Chat subscription, a harmless Turn, cancellation, reconnect, replay, crash recovery, approval/input, MCP auth, and Terminal channels remain unverified and must not be treated as passing.

## Verified environment

| Component | Exact value |
| --- | --- |
| VS Code CLI | `/usr/local/bin/code` |
| VS Code | `1.134.0` |
| Commit | `110a328ea54b42367b803ec53ee0bf52ef26b419` |
| Platform | macOS arm64 |
| Node used by harness | `v24.12.0` |
| AHP TypeScript package | `@microsoft/agent-host-protocol@0.8.0` (exact, vendored release tarball) |
| AHP release tag | `typescript/v0.8.0` |
| AHP release commit | `7153143f1c6993fa886d7d59870811cdad479d83` |
| SDK protocol offer | `0.8.0`, `0.7.0`, `0.6.0`, `0.5.2`, `0.5.1` |
| Negotiated AHP protocol | `0.8.0` |
| Endpoint registry schema/protocol | schema `2`, registry protocol `0.1.0` (not the negotiated AHP version) |

The configured Microsoft npm proxy exposed only package `0.7.0` during the spike. A real handshake with that exact package failed with JSON-RPC `-32005`: the Host reported version `0.8.0` and accepted `^0.8.0`. Package `0.8.0` was therefore not guessed: it was resolved from the official tag above, generated and packed from that commit, checked against the npm CDN package contents, and successfully negotiated with the Host.

Because a clean install through the configured proxy cannot fetch `0.8.0`, the audited 327 KiB release tarball is committed at `vendor/microsoft-agent-host-protocol-0.8.0.tgz`. `package.json` uses that immutable local source and `package-lock.json` pins SHA-512 `Tg1EsWXENx55RB3igfaSTclxvck2RcBS+LPRSGxi86yLhoeJgldtjSH5aDZZTll0tSw7fzbkSOte3/B9ExRFVg==`. The harness independently verifies the installed package metadata is exactly `0.8.0`.

## Harness

The harness is default-off:

```bash
npm run spike:agent-host
```

This exits without starting a process. The real probe requires explicit opt-in:

```bash
MESH_AGENT_HOST_E2E=1 \
MESH_CODE_CLI=/usr/local/bin/code \
npm run spike:agent-host
```

The command warns that later Session/Turn probes may consume Copilot quota. It creates an isolated temporary user-data directory, server-data directory, token file (`0600`), and empty workspace. It records a baseline from:

```text
code agent endpoints --user-data-dir <owned-user-data-dir>
```

It then starts exactly:

```text
code agent host
  --new-instance
  --foreground
  --host 127.0.0.1
  --port 0
  --user-data-dir <owned-user-data-dir>
  --server-data-dir <owned-server-data-dir>
  --connection-token-file <owned-secret-file>
  --log error
```

Readiness stdout is drained and never parsed or logged because the current CLI includes the token in that human-readable text. The harness polls only `code agent endpoints ...` JSON, requires one new `standalone` entry, and matches a PID in the spawned launcher's owned process tree plus the expected token. This distinction is required on macOS because `/usr/local/bin/code` is a shell launcher and the registry reports its child supervisor PID. Zero matches time out; multiple matches fail immediately. It validates a loopback TCP endpoint and constructs the WebSocket URL itself. Safe output omits the token and query string.

Only validated members of the spawned process tree are signalled. Shutdown closes the AHP client, sends `SIGTERM` to owned descendants and the launcher, escalates to `SIGKILL` only for those same PIDs after five seconds, and recursively removes only the unique temporary root it created.

CLI calls, endpoint polling, WebSocket establishment, and AHP requests all have explicit time limits. A WebSocket timeout closes the still-connecting socket before the harness enters owned-process cleanup.

## Real evidence

On 2026-08-24 the opt-in harness produced:

```json
{
  "codeVersion": "1.134.0",
  "codeCommit": "110a328ea54b42367b803ec53ee0bf52ef26b419",
  "codeArchitecture": "arm64",
  "ahpPackageVersion": "0.8.0",
  "negotiatedProtocolVersion": "0.8.0",
  "registryProtocolVersion": "0.1.0",
  "providers": [
    {
      "provider": "copilotcli",
      "displayName": "Copilot",
      "protectedResourceCount": 2
    },
    {
      "provider": "claude",
      "displayName": "Claude",
      "protectedResourceCount": 2
    }
  ],
  "globalWebSocket": true
}
```

Provider IDs are not hardcoded. This result came from the returned `ahp-root://` snapshot. No authentication token was requested or sent.

The SDK WebSocket implementation explicitly uses `globalThis.WebSocket`. It is a function in both the Node runtime above and the tested VS Code Extension Host. The harness fails before connecting with a specific error if that global is absent; a future runtime without it must supply an explicit public `AhpTransport` adapter rather than silently changing transport behavior.

## Ordinary CI coverage

`npm run test:unit` does not start VS Code, use the network, or call a model. It covers:

- strict JSON parsing and invalid fields;
- unique new standalone endpoint selection;
- owned PID and expected-token matching;
- loopback URL validation;
- zero-match polling and timeout;
- multiple-match rejection;
- token, URL query, JSON field, and Authorization redaction;
- the global WebSocket transport boundary.

## Unverified requirements

The following are explicitly **not passed**:

- A lower minimum VS Code version; only `1.134.0` was tested.
- Windows or Linux Host startup and AHP initialization.
- `vscode.authentication` and AHP `authenticate`.
- Session config resolution, Session creation, readiness, and default Chat discovery.
- Any prompt or `turnComplete`; no Copilot quota was consumed by this probe.
- Approval, input, MCP auth, Terminal, or Changeset event mapping.
- Cancellation acceptance/rejection/deadline behavior.
- Reconnect, replay, snapshot fallback, missing subscriptions, or Host crash recovery.

Until those checks pass, production code must return an unavailable/spike-gated outcome; it must not claim Auth, Session, Turn, or Recovery support.
