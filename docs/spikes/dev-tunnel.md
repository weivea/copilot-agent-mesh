# P0.3 Dev Tunnel Spike

## Gate result

**No-Go on the observed CLI build.**

The installed Dev Tunnel CLI can authenticate and create owned resources, but build
`1.0.2006+dd9fe5139f` does not satisfy the versioned JSON and hosted-readiness contract.
The extension must stop with `CLI_UNSUPPORTED`; it must not retry, parse human-readable
output, or silently upgrade the global CLI.

## Environment

Validated on 2026-08-24:

| Component | Exact value |
| --- | --- |
| macOS | `26.6.2` |
| Architecture | `arm64` |
| Dev Tunnel executable | `/opt/homebrew/bin/devtunnel` |
| Dev Tunnel CLI | `1.0.2006+dd9fe5139f` |
| Dev Tunnel service | `1.0.1995.17384` (`43e8069d44`) |
| Node.js | `v24.12.0` |
| npm | `11.6.2` |
| Decoder revision | `show-json-1.0.2006-r1` |
| Sanitized fixture SHA-256 | `244e17f9195cc8b8c38da88b996eab1ace0655bf3642d951c4827fd65a166f73` |

The CLI reports this build as outdated. The candidate build named in the technical plan,
`1.0.2030+fc9273aa0f`, was not installed or tested and is not declared supported.

## Implementation

- `ChildProcessRunner` uses `spawn(executable, args, { shell: false, windowsHide: true })`.
- The default executable allowlist contains only `devtunnel` and `devtunnel.exe`.
- On POSIX, every child starts in an owned process group. Timeout, abort, and output
  overflow send `SIGTERM`, then unconditionally send `SIGKILL` to that group after a
  bounded grace period, and poll within a second bounded deadline until the group is
  confirmed absent before settling. Successful and nonzero launcher exits use the same
  cleanup. Windows fails closed with
  `PROCESS_TREE_UNSUPPORTED` until a Job Object or equivalent owned-tree controller is
  implemented.
- Abort, timeout, nonzero exit, process-start failure, and combined output overflow have
  stable errors. Captured output is bounded, and child output is not included in errors.
- `redactProcessText` removes URL fragments, token query parameters, authorization
  values, token arguments, and JSON secret fields.
- `DevTunnelJsonDecoder` accepts one exact JSON document, one matching HTTP port, and one
  HTTPS forwarding URI on `.devtunnels.ms`. Userinfo, query strings, fragments, unknown
  fields, multiple URIs, wrong protocols, and unknown shapes fail closed.
- `MESH_DEVTUNNEL_E2E=1 npm run spike:dev-tunnel` is opt-in. On the observed build it
  checks the exact version and login, emits a safe `CLI_UNSUPPORTED` result, and exits
  before creating a public resource.

## Real CLI evidence

The account login probe succeeded without printing identity data. Two short-lived
resource probes then used unique `camspike*` IDs, label `copilot-agent-mesh-p0`, a
one-hour expiration, a fixed HTTP port, and a one-hour port-scoped anonymous access
entry.

Observed behavior:

1. On a fresh create, `create --json` emitted 393 bytes of ordinary welcome text before
   the JSON object. The production decoder intentionally rejects this input.
2. The returned tunnel ID did not equal the requested positional ID. The one-off probe
   extracted the actual ID only to address and delete its owned resource; production
   code does not use this fallback.
3. `port create --protocol http`, port-scoped `access create --anonymous --expiration
   1h`, and `show --json` completed.
4. `show --json` had no non-JSON prefix and reported the expected HTTP port, but without
   an active host it contained no forwarding URI. The sanitized real fixture is
   `fixtures/devtunnel-show-1.0.2006-no-host.sanitized.json`.
5. A positive hosted object in the unit test is a contract fixture, not claimed as real
   CLI evidence.
6. Every probe used a cleanup trap. A targeted post-run audit for the unique
   `camspike*` plus `copilot-agent-mesh-p0` ownership markers found zero resources
   before cleanup recovery and zero afterward. No unrelated tunnel was read, changed,
   or deleted.

Because the build already failed its machine-readable create contract, the spike did not
start a public host or claim HTTPS `/healthz`, WSS, stable URI, restart, port migration,
ACE renewal, or three-platform behavior. Those remain required on a selected CLI build.

## Automated evidence

Run:

```sh
npm run test:unit
npm run check-types
npm run lint
MESH_DEVTUNNEL_E2E=1 \
  MESH_DEVTUNNEL_PATH=/opt/homebrew/bin/devtunnel \
  npm run spike:dev-tunnel
```

The P0.3 unit suite covers:

- executable allowlisting, shell-free execution, unavailable process-tree control,
  timeout, inherited pipes, a descendant that ignores `SIGTERM`, abort, pre-abort,
  successful/nonzero launcher cleanup, transient Darwin `EPERM`, confirmation deadline,
  output bounds, nonzero exit secrecy, and redaction;
- valid URI selection, the real no-host fixture, non-JSON prefixes, unknown fields,
  unrelated-port version drift, missing ports, wrong protocols, multiple URIs, HTTP,
  userinfo, wrong host suffix, and tokenized query strings.

The opt-in command is expected to return `CLI_UNSUPPORTED` with exit code `2` on this
exact build. A success-shaped result would be a test failure.

## Remaining P0.3 requirements

- Select and install an exact current CLI build on macOS, Windows, and Linux.
- Implement and test an owned Windows process-tree controller before enabling CLI
  execution there.
- Capture a sanitized real hosted fixture and lock its decoder revision/hash.
- Verify exact `204` health with system CA validation, no redirects, and the official
  anti-phishing bypass header.
- Complete an authenticated WSS handshake.
- Verify host kill/restart, stable URI, port collision migration, access revocation and
  expiry, renewal failure, deleted resources, stop-during-backoff, and the permanent
  failure circuit breaker.
- Repeat resource cleanup verification using only owned IDs recorded at creation time;
  product code must not depend on `devtunnel list --json`.
