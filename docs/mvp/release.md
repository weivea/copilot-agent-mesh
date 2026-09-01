# Preview release engineering

> Version: `0.4.0` Preview
> Gate status: historical G0 Go; Peer Window Delegation requires its own real evidence gate

This document describes a reproducible evaluation package. It does not authorize
Marketplace publication, GitHub release creation, or promotion to general
availability.

## Supported Preview surface

| Platform | Window Node / Broker client | Worker host |
| --- | --- | --- |
| macOS arm64 | Preview | Experimental candidate; disabled by default |
| macOS x64 and other macOS architectures | Preview | Unsupported |
| Windows | Preview | Unsupported |
| Linux | Preview | Unsupported |

Every ordinary window under the same User Data is an active Window Node and may
use the Device Broker; non-owner windows are not read-only. Unsupported platforms
fail closed instead of launching Worker processes.

The package speaks Mesh protocol v2. Protocol-v1 peers are incompatible. Upgrade
migration preserves the 0.1 device ID and v1 workspace/task data in schema v2;
unknown or corrupt persisted versions fail.

The real Agent Host/AHP runtime requires:

1. `copilotAgentMesh.experimental.agentHost: true`.
2. An explicit first-task confirmation.
3. Explicit protected-resource or authorization-server mappings in
   `copilotAgentMesh.experimental.authenticationProviders`.
4. Available credentials from the mapped VS Code authentication provider.

No provider, account, resource, or scope is inferred. A successful real turn may
consume Copilot quota.

Worker tunnel hosting additionally requires a user-supplied
`copilotAgentMesh.devTunnelPath` to the exact validated macOS arm64 build
`1.0.2030+fc9273aa0f`. The extension does not discover it on `PATH` and never
downloads, installs, or upgrades the CLI.

## Build and verify

Use Node.js 22 or newer:

```sh
git submodule update --init --recursive
npm ci
npm audit --audit-level=high
npm run verify
```

`verify` runs unit, component, Extension Host, and VSIX package verification.
The package command creates:

```text
artifacts/copilot-agent-mesh-0.4.0-preview.vsix
```

The production bundle is separate from VSIX creation:

```sh
npm run bundle
npm run package:vsix
```

`package:vsix` invokes `vsce package --pre-release --no-dependencies`, prints
`vsce ls`, and verifies the ZIP central directory against an exact allowlist.
Only the production bundle, media, extension manifest, release documents,
project notices, and the AHP license are permitted. AHP runtime code is already
in the esbuild output, so the AHP source submodule and every nested archive are
excluded alongside source, tests, shared TypeScript, build output, test
downloads, source maps, credentials, and external CLIs.

Inspect and hash the result independently:

```sh
npx vsce ls --no-dependencies
unzip -Z1 artifacts/copilot-agent-mesh-0.4.0-preview.vsix
shasum -a 256 artifacts/copilot-agent-mesh-0.4.0-preview.vsix
```

## Real multi-window verification

Run the 0.4.0 Peer Window Delegation release gate separately:

```sh
MESH_PEER_DELEGATION_E2E=1 npm run test:peer-delegation-real
npm run validate:peer-delegation-evidence
```

The exact opt-in is required because this starts two ordinary VS Code windows and
may consume Copilot quota. A fully passing artifact requires the optional visible
Copilot Agent-mode phase documented in [the E2E guide](e2e.md); programmatic Tool
invocation cannot stand in for the one parent confirmation. A short E2E-only
budget is armed for one test task and does not change the manifest/runtime
default or maximum of 60 minutes.

The generated evidence remains local at
`artifacts/peer-delegation-e2e/evidence.json`. Do not package it into the VSIX or
publish it as a release asset without a separate review. Its validator rejects
sensitive content and any claimed Pass with residual harness-owned resources.

The recorded P8 objective run is valid but **Unverified**: AC-5 1-4, 6, and
8-12 passed against the existing full-Catalog authenticated profile, including
real editor completion, matched Host-echoed/recovery Session fingerprints,
needs-input resume, cancellation, and complete cleanup. Do not publish or
relabel this as a full Peer Delegation Pass: AC-5 5 and 7 plus O1/O2 still
require the visible Agent-mode/UI observations.

Editor endpoints reuse the editor Host's established identity and never receive
tokens from `copilotAgentMesh.experimental.authenticationProviders`; those
mappings apply only to an owned standalone fallback. AC-5 item 9 additionally
requires a Host-echoed editor Session fingerprint to match the task recovery
fingerprint, plus an editor endpoint fingerprint; two locally derived values or
a reported source cannot satisfy it.

Run the ordinary-window transport/lifecycle test explicitly:

```sh
npm run test:multi-window-real
```

On macOS, keep the runtime path short enough for Unix-domain sockets:

```sh
MESH_MULTI_WINDOW_E2E_RUNTIME_DIR=$HOME/.mw npm run test:multi-window-real
```

The test launches ordinary VS Code windows sharing one User Data directory. It
must observe multiple Window Nodes, exactly one generation-fenced Broker,
workspace claim/reclaim and conflicts, takeover, and complete process/socket
cleanup while the local task route leaves Dev Tunnel untouched.

The real AHP task path is a separate opt-in and may consume quota. Its persistent
profile must be a dedicated absolute directory and must first be signed into
GitHub interactively; the harness rejects overlap with real VS Code profiles and
aborts non-destructively if the dedicated profile is already locked or in use:

```sh
MESH_MULTI_WINDOW_E2E=1 \
MESH_MULTI_WINDOW_E2E_TASKS=1 \
MESH_MULTI_WINDOW_E2E_PROFILE_DIR=$HOME/.mw-profile \
MESH_MULTI_WINDOW_E2E_AUTH_RESOURCE='https://api.github.com' \
MESH_MULTI_WINDOW_E2E_AUTH_PROVIDER='github' \
MESH_MULTI_WINDOW_E2E_AUTH_SCOPES_JSON='["read:user","user:email"]' \
MESH_MULTI_WINDOW_E2E_RUNTIME_DIR=$HOME/.mw \
npm run test:multi-window-real
```

Evidence `2ab62a03-51ba-45ef-a01a-0e3829f7ae7c` passed with an accepted
authentication session, `agentStarted`, five output events,
`AgentTaskHandle.cancel()`, authoritative `cancelled`, and zero owned process,
socket, or Tunnel residue. G0 is Go only for this validated macOS arm64 Preview
scope.

## Isolated activation smoke

The smoke command installs the VSIX into temporary user-data and extension
directories (an isolated VS Code profile), then starts an independent Extension
Host that activates the installed extension:

```sh
npm run smoke:vsix
```

Set `VSCODE_EXECUTABLE_PATH` to reuse a specific VS Code executable; otherwise
`@vscode/test-electron` downloads or reuses its stable test build. The fresh
profile keeps listener auto-start and experimental Agent Host disabled, so the
smoke does not create a public tunnel or run a model task.

## CI boundary

The `preview-package.yml` matrix runs on Linux, macOS, and Windows. It performs
clean install, audit, type checking, lint, offline unit/component tests,
Extension Host tests, package verification, installed-VSIX activation smoke,
and artifact upload. Linux runs both Extension Host phases under `xvfb`. A smoke
failure blocks artifact upload on every matrix platform.

Ordinary CI must not run `test:dev-tunnel-real`,
`test:agent-host-auth-e2e`, or `test:agent-host-success-e2e`. Those tests require
explicit local opt-in, platform credentials, exact external executables, and
cleanup review; the success path may consume Copilot quota.

`test:multi-window-real` is also an explicit real-window release check rather than
an ordinary unit/component gate. Its AHP branch must never run unless
`MESH_MULTI_WINDOW_E2E_TASKS=1` is set.

## Manual release checklist

1. Confirm the worktree is clean and record the current commit SHA.
2. Run `npm ci`, `npm audit --audit-level=high`, and `npm run verify`.
3. Run the explicit Peer Window Delegation E2E and require valid, passing AC-5
   evidence; do not convert an authentication/UI block into Pass.
4. Run `npm run smoke:vsix` without enabling Worker settings.
5. Run `npm run test:multi-window-real`; on macOS use
   `MESH_MULTI_WINDOW_E2E_RUNTIME_DIR=$HOME/.mw` if needed.
6. Record the commit SHA, VSIX SHA-256, verified archive listing, and sanitized
   multi-window evidence.
7. Transfer the VSIX only as an explicitly labeled Preview evaluation artifact.
8. Do not publish or create a GitHub Release without explicit authorization.
