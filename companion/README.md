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

**0.5.5 native Chat POC:** the companion requires desktop VS Code 1.137 or newer.
Fully quit desktop VS Code, launch it with
`code --enable-proposed-api weivea.copilot-agent-mesh-codespaces`, and reconnect.
The explicitly enabled `chatSessionsProvider` and `chatParticipantPrivate`
proposals put real incoming Mesh tasks in the native **Chat editor and Sessions**.
**Native Codespaces Chat Setup (POC)** explains the opt-in without editing your
desktop runtime arguments.

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
