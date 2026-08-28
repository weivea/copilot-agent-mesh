# Preview release engineering

> Version: `0.2.0` Preview
> Gate status: G0 **No-Go**

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
npm ci
npm audit --audit-level=high
npm run verify
```

`verify` runs unit, component, Extension Host, and VSIX package verification.
The package command creates:

```text
artifacts/copilot-agent-mesh-0.2.0-preview.vsix
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
in the esbuild output, so its source tarball and every other nested archive are
rejected alongside source, tests, shared TypeScript, build output, test
downloads, source maps, credentials, and external CLIs.

Inspect and hash the result independently:

```sh
npx vsce ls --no-dependencies
unzip -Z1 artifacts/copilot-agent-mesh-0.2.0-preview.vsix
shasum -a 256 artifacts/copilot-agent-mesh-0.2.0-preview.vsix
```

## Real multi-window verification

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

The real AHP task path is a separate opt-in and may consume quota:

```sh
MESH_MULTI_WINDOW_E2E_RUNTIME_DIR=$HOME/.mw \
MESH_MULTI_WINDOW_E2E_TASKS=1 npm run test:multi-window-real
```

The recorded opted-in run passed infrastructure/lifecycle assertions but stopped
correctly at `AGENT_AUTH_REQUIRED` because the fresh shared profile had no
authentication mapping/session. It did not prove authoritative AHP
start/get/cancel/output, so G0 remains No-Go.

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
3. Run `npm run smoke:vsix` without enabling Worker settings.
4. Run `npm run test:multi-window-real`; on macOS use
   `MESH_MULTI_WINDOW_E2E_RUNTIME_DIR=$HOME/.mw` if needed.
5. Record the commit SHA, VSIX SHA-256, verified archive listing, and sanitized
   multi-window evidence.
6. Transfer the VSIX only as an explicitly labeled Preview evaluation artifact.
7. Do not publish, push, create a release, or claim G0 completion from this procedure.
