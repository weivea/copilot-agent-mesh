# Copilot Agent Mesh - Codespaces

This workspace-only companion executes Mesh tasks in a trusted Linux Codespace
attached to **desktop VS Code**. Install the matching Copilot Agent Mesh UI
extension on the desktop. This companion does not register additional model tools,
own a Device Broker, publish a public port, or join a separate Mesh device.

In the attached window, run **Copilot Agent Mesh: Prepare Codespaces Runtime**
from the Mesh Dashboard toolbar. The main extension installs its exact bundled
companion version and offers explicit native CLI download/license confirmation.
Preparing the runtime does not start an Agent task or grant workspace access.

Use the same six Mesh tools, Workspace permissions, and incoming-task controls as
for other windows. Tasks run in the Codespace filesystem. Completed task sessions
can be continued on the same live execution generation; they are Mesh-owned
sessions, not the window's built-in Copilot Host sessions.

**0.5.12 native Chat POC:** the companion requires desktop VS Code 1.137 or newer.
On first activation it asks the desktop Mesh extension to automatically save
its API permission. Fully quit all VS Code windows and reopen once, then
reconnect. **No launch parameters or manual configuration edits are needed.**
The `chatSessionsProvider` and `chatParticipantPrivate`
proposals put real incoming Mesh tasks in the native **Chat editor and Sessions**.
Existing desktop runtime preferences, comments and other extension permissions
are preserved. **Enable Native Codespaces Chat** retries a blocked automatic
save; an unsaved or invalid user configuration is never overwritten. A native
Chat opt-out disables automatic setup, and no VS Code installation file is changed.

Incoming tasks open automatically; disable
`copilotAgentMesh.codespaces.nativeChat.autoOpen` to keep Sessions without
taking focus. Native Chat is a read-only task transcript in this POC, with
an explicit **Cancel Mesh task** control. Answer questions with **#meshAnswerTask**
and continue completed sessions through the original source's Mesh tools. Closing Chat only
detaches observation; it does not cancel work.

Bounded, redacted history is saved separately from temporary Host data and
reopens after window reload/restart. Saved history does not make a stopped
runtime resumable. UI/history errors are visible and leave the existing Mesh
execution channel authoritative. Without proposed-API permissions the tool
workflow still works, but native Chat is unavailable. This is a private VSIX
POC, not a stable Marketplace integration.

0.5.8 removes an incorrect startup check that could dispose a registered native
provider when an optional workbench menu command was absent. Incoming tasks
remain recorded while native permission is awaiting a full restart, and a
warning explains why the UI is not yet available. Previously unrecorded tasks
are not replayed to fabricate history.

Token-sized output is coalesced losslessly into bounded batches before slow
consumers can fill the event-count limit. Normal task summaries use a separate
16 KiB limit rather than the 2 KiB error-message limit. Actual queue/storage and
tool-result budgets remain enforced; upgrading cannot reconstruct output
already dropped by an older version.

Broker event acknowledgement has a separate bounded stall budget; a brief
desktop Extension Host pause does not immediately retire an otherwise healthy
Codespace execution generation. Companion heartbeat/cancellation paths remain
separate, and real connection loss or task deadlines still stop execution.
No uncertain task is automatically retried.

The companion obtains Agent authentication through VS Code's native account
provider. It does not read shell credentials or another Agent Host's tokens.
Unknown protected resources require an explicit authentication-provider mapping.
The Codespace connection and Mesh Dev Tunnel accounts may differ from this
Copilot execution account. Runtime preparation does not sign into any of them.
The optional `copilotAgentMesh.codespaces.codePath` is a **remote** absolute path
to a compatible native CLI, not the `code` remote wrapper.

System libc detection uses the container's `getconf GNU_LIBC_VERSION`. Missing
diagnostic information is an explicit detection failure, not proof that glibc
is too old. Setup errors identify the failed stage and a safe error code; see
**Output: Copilot Agent Mesh - Codespaces** for the underlying error.

Browser clients, untrusted/virtual workspaces, generic SSH/WSL/Dev Containers,
automatic Codespace startup, and cross-generation task replay are not supported.
Closing the controlling window or losing the companion lease initiates cleanup
of only Mesh-owned tasks and processes.

See the [technical design](https://github.com/weivea/copilot-agent-mesh/blob/main/docs/desktop-codespaces.md)
for the bridge, authorization, session, and lifecycle contracts.
