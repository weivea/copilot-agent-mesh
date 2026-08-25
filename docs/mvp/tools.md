# Production Language Model Tools

The MVP tool surface is implemented in `src/tools` and is intentionally
decoupled from the current coordinator, peer, gateway, and extension activation
work. Production wiring supplies one `TaskToolFacade`; the tool classes never
create tasks, simulate workers, inspect workspace files, or manage repository
state.

## Tool surface

| Tool | Behavior | Application deadline |
| --- | --- | ---: |
| `mesh_list_workers` | Returns bounded peer capability and opaque workspace metadata. | 5 s |
| `mesh_delegate_task` | Persists an intent, waits for worker acceptance, then returns `pending` with poll/cancel hints. | 15 s |
| `mesh_get_task` | Returns a bounded snapshot, event cursor, event-gap indicator, and truncation indicator. | 10 s |
| `mesh_cancel_task` | Requests cancellation through the owner-scoped Facade method. | 10 s |
| `mesh_answer_task` | Sends an idempotent answer through the owner-scoped Facade method. | 10 s |

`prepareInvocation` is pure. Delegate confirmation displays only peer ID,
opaque workspace ID, and title summary. It never persists an intent or contacts
a worker.

All inputs are checked again at runtime with exact object properties and UTF-8
byte limits. Facade output is parsed through a strict allowlist before it can
reach a model. Unknown exceptions become a fixed safe text error and never
expose paths, credentials, process details, or stacks. Results are compact JSON
inside one `LanguageModelTextPart`; list and get results truncate bounded data
rather than returning raw transcripts. When VS Code supplies
`tokenizationOptions`, the adapter uses its model-specific `countTokens`
function and shrinks events, worker lists, and optional snapshot fields to the
actual token budget.

Cancelling a `CancellationToken` aborts only the current Tool wait. In
particular, delegate cancellation or acknowledgement timeout does not call the
remote cancellation method. Once `persistDelegationIntent` resolves, the result
retains `delegationRequestId` and `taskId` so the durable task can be polled or
explicitly cancelled.

## Facade integration

`TaskToolFacade` is the production seam for the future `TaskCoordinator` and
`PeerManager` adapters:

```ts
interface TaskToolFacade {
  listWorkers(signal: AbortSignal): Promise<MeshWorkerDirectorySnapshot>;
  persistDelegationIntent(intent: DelegationIntentInput): Promise<PersistedDelegationIntent>;
  waitForDelegationAcceptance(ids: {
    delegationRequestId: string;
    taskId: string;
  }, signal: AbortSignal): Promise<DelegationAcceptance>;
  getTask(request: {
    taskId: string;
    afterEventSequence?: number;
    maxEvents: number;
  }, signal: AbortSignal): Promise<TaskToolReadResult>;
  cancelOwnedTask(request: { taskId: string }, signal: AbortSignal): Promise<TaskActionReceipt>;
  answerOwnedTask(request: {
    taskId: string;
    inputId: string;
    answerId: string;
    answer: string;
  }, signal: AbortSignal): Promise<TaskActionReceipt>;
}
```

The persistence method must durably allocate both IDs before resolving and must
recover the same IDs for an exact retry. Aborting the acceptance signal stops
only that acknowledgement wait. Ownership is taken from the Facade's
authenticated coordinator context, never from tool input.

## Parent-session wiring

Copy the five objects exported as `MESH_TOOL_MANIFEST_DESCRIPTORS` into
`package.json.contributes.languageModelTools`. Register the same names by
calling `registerMeshTaskTools(facade)` during activation. The exported
`assertMeshToolNameParity` and `getMeshColdActivationContract` helpers support
manifest/runtime parity and cold implicit activation tests.
