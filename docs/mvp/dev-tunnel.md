# Dev Tunnel MVP

> Evidence date: 2026-08-25
> Scope: macOS arm64, opt-in real integration

## Compatibility gate

The strict JSON provider targets exactly `devtunnel 1.0.2030+fc9273aa0f` on the validated
macOS arm64 path. The official Homebrew cask currently resolves that build to:

- URL: `https://tunnelsassetsprod.blob.core.windows.net/cli/1.0.2030+fc9273aa0f/osx-arm64-devtunnel`
- Executable SHA-256: `004f3cc8ebcce61223bacac80d31937eb2e92eaee9a05600a1cb62fb5f775afe`
- Decoder: `show-json-1.0.2030-r1`
- Sanitized hosted fixture SHA-256:
  `d561eed56125ea53d2e97f1dcc5107575f7fb1df2eb2032a955338c9fb7a5ace`

The installed global CLI is only probed. The provider never runs an installer or changes
the user's global CLI. A downloaded exact binary may be selected explicitly with
`MESH_DEVTUNNEL_PATH` for the opt-in test. After hashing the resolved executable, the
provider creates a runner allowlist for its exact basename, including the official
`osx-arm64-devtunnel` download name.

Build `1.0.2006+dd9fe5139f` remains unsupported because `create --json` emits ordinary
text before the JSON document. Build 2030 fixes that issue. Its hosted `show --json`
contract uses the single `portUri` field; the decoder intentionally rejects
`portForwardingUris` rather than accepting a permissive cross-version union.

The complete lifecycle gate passes through an exact-build controlled fallback. The command
`host <qualified-id> --port-number <fixed-port>` exits on the official 2030 build with
`Invalid arguments. Batch update of ports is not supported. Add, update, or delete ports
individually instead.` This occurs with both an already configured port and an empty
persistent tunnel. Only for the hash-gated exact 2030 build, the provider therefore permits
`host <qualified-id>` after a fresh strict `show --json` proves that the tunnel has exactly
one port, that the port is `metadata.localPort` with protocol `http`, and a port-scoped
`access list --json` proves exactly the persisted index-zero anonymous/connect ACE and
expiration. Tunnel-wide and inline port `accessControl` arrays must be empty. Initial host
and every restart repeat all checks and re-hash the executable before process creation.
Any extra port, protocol, ownership, ACE, index, scope, expiration, or executable drift
fails closed and opens the circuit before another host starts. Renewal and host transitions
are serialized against freshly loaded ownership metadata. No global CLI upgrade is attempted.

## Lifecycle

`DevTunnelCliProvider` performs:

1. Exact `--version` allowlisting and versioned `user show` login probing.
2. A strict loopback `/healthz` check on the persisted port.
3. Persistent tunnel creation with a unique `copilot-agent-mesh-*` ownership label.
4. One fixed HTTP port and one port-scoped anonymous `connect` ACE with an explicit
   expiration.
5. One owned `devtunnel host` process for the `{tunnelId, port}` pair.
6. Strict `show --json` decoding to one HTTPS `portUri`.
7. Public `/healthz` validation with system CA trust, no redirect following, exact `204`,
   `Accept: application/json`, and the official
   `X-Tunnel-Skip-AntiPhishing-Page: true` header.
8. A real WSS request/response probe with the same anti-phishing header.

The store records the exact build, decoder revision, qualified tunnel ID, fixed port,
ownership label, tunnel expiration, ACE index, and ACE expiration. Before renewal deletes
anything, `access list --port-number <fixed-port> --json` must contain exactly the persisted
index-zero anonymous/connect ACE with the persisted expiration. Renewal then uses
`access delete --index 0` followed by a new port-scoped anonymous ACE. Ownership mismatch
or a failure after deletion starts opens `TUNNEL_ACCESS_EXPIRED`; a timeout or network
failure while inspecting the ACE remains transient and performs no deletion.

Before the exact-2030 host fallback starts, `show --json` must contain no additional ports
and the ACE list must match persisted ownership metadata. An unexpected host exit starts
full-jitter bounded backoff and repeats invariant validation, JSON discovery, HTTPS health,
and WSS probes. Permanent build, schema, login, missing-resource, and expired-access failures
open the circuit breaker. `stop()` cancels pending restart timers plus in-flight CLI, JSON
discovery, HTTPS, WSS, and backoff work, and terminates only the owned process group. A
stopped generation cannot publish later state. It does not delete the persistent tunnel.

If the persisted port differs from the requested port, or no longer serves the expected
loopback health endpoint, startup fails with `PORT_MIGRATION_REQUIRED` or `PORT_CONFLICT`.
The provider never silently selects another port. Port deletion, credential revocation,
endpoint invalidation, and peer re-pairing remain an explicit migration workflow.

## Tests

Offline tests are the default:

```sh
npm run test:unit
```

The real test is opt-in and requires a logged-in exact CLI:

```sh
MESH_DEVTUNNEL_E2E=1 \
MESH_DEVTUNNEL_PATH=/path/to/osx-arm64-devtunnel \
npm run test:dev-tunnel-real
```

It starts a loopback fake agent endpoint, verifies real HTTPS `204` and WSS transport,
renews the ACE, kills and restarts the owned host while preserving the public URI, and
deletes only the unique tunnel ID recorded by its in-memory ownership store. Cleanup is
confirmed only by build 2030's exact exit-2, empty-stdout, cluster-qualified not-found
response from exact-ID `show --json`; timeout, network failure, and any other transient
error fail the test. The test never uses `list --json` or wildcard cleanup.

The fixture at
`docs/mvp/fixtures/devtunnel-show-1.0.2030-hosted.sanitized.json` was captured from that
real hosted lifecycle. No tunnel ID, account identity, access token, or unknown binary is
committed.

Windows remains fail-closed until the owned process runner uses a Job Object. Linux,
macOS x64, and Windows builds require their own exact executable hashes, fixtures, and
real integration evidence before they can be added to the allowlist.
