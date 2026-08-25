# Copilot Agent Mesh

Copilot Agent Mesh is a Preview desktop VS Code extension for delegating GitHub Copilot coding tasks across trusted devices and local workspaces.

The only Worker Preview candidate platform is **macOS arm64**; full authenticated
end-to-end support remains gated by the opt-in compatibility evidence. Windows, Linux,
macOS x64, and other architectures may use Coordinator features when the peer
client is otherwise available, but they cannot host a listener or execute Worker
tasks. Unsupported Worker surfaces return `CLI_UNSUPPORTED` and
`AGENT_UNAVAILABLE` with an actionable macOS arm64 requirement; they never fall
back to an unowned process or unvalidated tunnel build.

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
