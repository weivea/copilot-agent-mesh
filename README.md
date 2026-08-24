# Copilot Agent Mesh

Copilot Agent Mesh is a desktop VS Code extension for delegating GitHub Copilot coding tasks across trusted devices and local workspaces.

The project is currently in its bootstrap phase. The extension contributes an Activity Bar dashboard, device-name configuration, and the initial shared protocol types described in the [product requirements](./copilot-agent-mesh-prd.md).

Project documents:

- [Product requirements](./copilot-agent-mesh-prd.md)
- [Technical implementation](./docs/technical-implementation.md)
- [Implementation plan](./docs/implementation-plan.md)

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
shared/              Gateway protocol types shared by coordinator and worker code
src/extension.ts     Extension activation and command registration
src/ui/              Activity Bar and Webview UI
src/test/            VS Code extension integration tests
```

The architecture will expand into the `gateway`, `peer`, `agentHost`, `tasks`, `tools`, `tunnel`, and `workspaces` modules defined by the PRD as each capability is implemented.

## Security model

This extension is intentionally disabled in untrusted and virtual workspaces. Future remote execution will require an explicitly registered workspace and paired peer connection.
