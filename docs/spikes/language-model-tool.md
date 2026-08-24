# P0.1 Language Model Tool Spike

## Scope

This spike validates the stable VS Code Language Model Tool request/response surface without starting a model, contacting a worker, reading workspace files, or inspecting Git. The contributed tool is `mesh_spike_echo`; the same exported constant is used for `vscode.lm.registerTool`.

The tool starts one in-memory simulated task per `delegationRequestId`. The simulated worker acknowledgement races the invocation's application-level budget and VS Code `CancellationToken`. Cancellation or timeout ends only the current wait. A retry with the same request ID and task semantics reuses the original task and `taskId`.

Successful output is one compact `LanguageModelTextPart` containing JSON:

```json
{"status":"pending","delegationRequestId":"request-id","taskId":"task-id","pollTool":"mesh_get_task","cancelTool":"mesh_cancel_task","echo":"message","delaySeconds":5}
```

`prepareInvocation` only validates and formats input. Its confirmation identifies the local simulated target, states that no workspace files are accessed, summarizes the message, and shows the configured acknowledgement delay.

## Environment

Validated on 2026-08-24:

| Component | Version |
| --- | --- |
| VS Code CLI | `1.134.0`, commit `110a328ea54b42367b803ec53ee0bf52ef26b419`, `arm64` |
| Extension Host test download | VS Code `1.134.0`, `darwin-arm64` |
| Node.js | `v24.12.0` |
| npm | `11.6.2` |
| `@types/vscode` resolved version | `1.125.0` |
| Manifest engine range | `^1.103.0` |

The resolved `@types/vscode` version remains newer than the manifest minimum because the existing dependency uses a caret range. P0 compatibility work must select and pin the final minimum API version; this spike does not claim that every build in the current engine range was tested.

## Automated evidence

Run from the repository root:

```sh
npm ci
npm run test:unit
npm run check-types
npm run lint
npm run compile-tests
npm run compile
npx vscode-test --code-version 1.134.0 --timeout 20000
```

Observed results:

- Node unit suite: 7/7 passing. It covers pending success at simulated 5, 15, and 30 second delays, application-budget timeout, cancellation, pure preparation, and retry reconciliation without a second task start.
- Type check and ESLint: passing.
- VS Code 1.134.0 arm64 Extension Host suite: 5/5 passing. It verifies the manifest/runtime name, cold implicit activation from tool invocation, runtime registration, confirmation data, and compact structured `LanguageModelTextPart`.
- The Extension Host test invokes with cancellation immediately after dispatch. This proves cold `onLanguageModelTool:mesh_spike_echo` activation without accepting the confirmation or calling a model.

The test profile uses a short temporary user-data path because the repository worktree path exceeds the macOS Unix-domain socket length limit.

## Manual Copilot UI verification still required

The isolated Extension Host had no GitHub/Copilot authentication token. The following are **not verified** and must not be treated as passing:

1. Built-in Copilot Agent automatically selects `mesh_spike_echo`.
2. Explicit `#meshSpikeEcho` attachment is visible and invokes the tool.
3. The confirmation title/body and Continue/Cancel controls render correctly in the real Copilot UI.
4. Real wall-clock invocations at 5, 15, and 30 second delays have acceptable UX.
5. After receiving `pending`, built-in Copilot Agent autonomously calls `mesh_get_task`.

Item 5 is the main P0.1 product uncertainty. This spike returns `pollTool` and `cancelTool` as protocol hints only; it does not register those production tools and does not implement or claim a real Agent auto-poll loop. The stable Tool API still provides one result per invocation and no supported mechanism for pushing a later result into an old turn.

## Gate status

Automated API, cancellation, timeout, idempotency, structured-result, manifest/runtime parity, and cold-activation checks pass on VS Code 1.134.0 arm64. P0.1 remains partially open until the five Copilot UI checks above are performed with an authenticated built-in Copilot Agent.
