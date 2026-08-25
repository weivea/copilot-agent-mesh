# Copilot Agent Mesh

Copilot Agent Mesh is a Preview desktop VS Code extension for coordinating GitHub Copilot coding tasks across trusted devices and local workspaces. This package is an evaluation build, not a declaration that the end-to-end G0 release gate has passed.

The only Worker Preview candidate platform is **macOS arm64**. Windows, Linux,
macOS x64, and every other architecture are **Coordinator-only**: they may connect
to an already configured peer, but cannot host a listener or execute Worker tasks.
Unsupported Worker surfaces return `CLI_UNSUPPORTED` and
`AGENT_UNAVAILABLE` with an actionable macOS arm64 requirement; they never fall
back to an unowned process or unvalidated tunnel build.

## Preview prerequisites and limitations

- VS Code 1.103 or newer is required.
- Real Worker execution is experimental, disabled by default, and may consume Copilot quota.
- Enable `copilotAgentMesh.experimental.agentHost` only after reviewing the first-task confirmation and process ownership behavior.
- AHP authentication is not inferred. Every advertised protected-resource or authorization-server URL must be mapped explicitly in `copilotAgentMesh.experimental.authenticationProviders` to an installed VS Code authentication provider and its exact scopes. Missing mappings fail with `AGENT_AUTH_REQUIRED`.
- Tunnel hosting requires a user-supplied `copilotAgentMesh.devTunnelPath` pointing to the exact validated macOS arm64 CLI build `1.0.2030+fc9273aa0f`. The extension does not search `PATH`, download, install, or upgrade Dev Tunnel.
- Gate G0 remains **No-Go**: authenticated AHP Session/Turn E2E has not passed, so this Preview does not claim a full end-to-end MVP.

See [Preview release and installation](./docs/mvp/release.md) for packaging, installation, and verification instructions.

Project documents:

- [Product requirements](./copilot-agent-mesh-prd.md)
- [Technical implementation](./docs/technical-implementation.md)
- [Implementation plan](./docs/implementation-plan.md)
- [Compatibility matrix](./docs/compatibility-matrix.md)

## Development

Requirements:

- VS Code 1.103 or newer
- Node.js and npm

Install dependencies and build the extension:

```bash
npm install
npm run compile
```

Open the repository in VS Code:

```bash
code .
```

Select **Run and Debug** in the Activity Bar, choose **Run Extension**, and click the green start button. On macOS, the equivalent keyboard shortcut is usually `fn`+`F5`; a bare `F5` may trigger a system function instead. The debug configuration builds the extension before opening an Extension Development Host.

Useful commands:

```bash
npm run watch
npm run check-types
npm run lint
npm test
npm run verify
npm run package:vsix
```

## Project layout

```text
shared/              Gateway protocol types shared by coordinator and Worker code
src/extension.ts     Minimal extension lifecycle entry point
src/composition/     Production application composition
src/ui/              Activity Bar and Webview UI
src/test/            VS Code extension integration tests
```

Production modules live under `gateway`, `peer`, `agentHost`, `tasks`, `tools`,
`tunnel`, and `workspaces`.

## Security model

This extension is intentionally disabled in untrusted and virtual workspaces.
Remote execution requires an explicitly registered workspace and paired peer
connection.
