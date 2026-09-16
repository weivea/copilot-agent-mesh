# Development

[Feature overview](../README.md) |
[Project guide](./project-guide.md) |
[Release engineering](./mvp/release.md)

Run the commands below from the repository root. End users do not need the
build toolchain; use the [release installers](../README.md#install) instead.

## Requirements

- VS Code 1.103 or newer; Codespaces companion/native Chat development requires 1.137 or newer.
- Node.js 22 or newer and npm.
- Go at the version declared in `native/windows-process-host/go.mod` or newer
  (build-time only; not required to install or use the VSIX).

## Build and debug

Install dependencies and build the extension:

```bash
git submodule update --init --recursive
npm ci
npm run compile
```

Open the repository in VS Code:

```bash
code .
```

Select **Run and Debug** in the Activity Bar, choose **Run Extension**, and click
the green start button. On macOS, the equivalent keyboard shortcut is usually
`fn`+`F5`; a bare `F5` may trigger a system function instead. The debug configuration
builds the extension before opening an Extension Development Host.

## Useful commands

```bash
npm run watch
npm run check-types
npm run lint
npm test
npm run verify
npm run test:installers
npm run package:vsix
```

`npm run package:vsix` creates the main and companion VSIXs, synchronizes the
installer versions, and emits release assets. It does not create a GitHub release.
See [GitHub release installers](./mvp/release.md#github-release-installers)
for version, tag, checksum, and publishing conventions.

## Real execution tests

Real AHP tests may consume Copilot quota and require explicit opt-in. Use a
dedicated authenticated test profile, never the developer's normal profile.
Follow [real multi-window verification](./mvp/release.md#real-multi-window-verification)
for the complete environment and profile setup before running:

```bash
npm run test:multi-window-real
npm run test:peer-delegation-real
```

On macOS, a short `MESH_MULTI_WINDOW_E2E_RUNTIME_DIR` such as `$HOME/.mw`
avoids the Unix-domain socket path limit. The real task path additionally requires
the explicit opt-ins documented in the release guide.

The Peer Window Delegation gate requires `MESH_PEER_DELEGATION_E2E=1`.
Without that exact value it exits safely before compiling or launching VS Code.
The harness uses two ordinary windows, two temporary non-sensitive projects, one
shared dedicated profile, real registered LM tools, and the pinned AHP client.
Real Copilot sidebar confirmation and Chat Sessions visibility use an
operator-visible phase; programmatic `vscode.lm.invokeTool` evidence is never
misreported as UI confirmation. Sanitized evidence is written to
`artifacts/peer-delegation-e2e/evidence.json`.

Historical cross-device evidence does not establish the current workflow across
physical devices. Linux, macOS x64, and Windows x86 remain unable to host local
Worker/AHP execution. Stable APIs also cannot detect concurrent edits made by the
target window's separate user Copilot session; the Incoming Task record and
target-side cancel action are the mitigation. See the
[Preview evidence and limitations](./project-guide.md#preview-prerequisites-and-limitations).

## Project layout

```text
shared/                       Protocol v2 and bounded wire schemas
src/broker/                   Device Broker ownership, IPC, routing, and node catalog
src/node/                     Window Node lifecycle, routing adapters, and runtime handles
src/ipc/                      Authenticated local IPC transport
src/storage/                  Broker ownership fencing and durable storage adapters
src/composition/              Production application composition
src/ui/                       Activity Bar Dashboard and safe view models
src/test/                     VS Code extension integration tests
src/codespaces/               Desktop bridge and workspace companion execution
companion/                    Codespaces companion manifest and documentation
scripts/                      Build, packaging, installers, and test harnesses
native/windows-process-host/  Packaged Windows Job Object process controller
docs/                         Project, development, design, and release documentation
```

Production modules also live under `gateway`, `peer`, `agentHost`, `tasks`,
`tools`, `tunnel`, and `workspaces`.
