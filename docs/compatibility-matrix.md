# Compatibility Matrix

> Status: Phase 0 in progress  
> Evidence date: 2026-08-24  
> Baseline commit: `108849d73acf8e4d9c484950846ce0d6b9a39131`

This document is the release gate for external platform compatibility. A version is
supported only after the corresponding opt-in spike has produced reproducible evidence.
Installed or declared versions are not treated as validated support.

## Gate G0

**Current decision: No-Go**

P0.1 Language Model Tool behavior, P0.2 Agent Host/AHP authentication and session
execution, and P0.3 Dev Tunnel hosting have not all passed. Until they do, the project
must not claim an end-to-end Copilot Agent Mesh MVP.

| Capability | Declared or detected | Validated | Status |
| --- | --- | --- | --- |
| VS Code minimum | `1.103.0` in `package.json` | Pending Phase 0 result | Not supported yet |
| VS Code tested | `1.134.0`, commit `110a328ea54b42367b803ec53ee0bf52ef26b419`, macOS arm64 | Bootstrap compile and Extension Host tests | Partial |
| Language Model Tool | Stable `vscode.lm` API | Pending P0.1 | No-Go |
| AHP package | Not selected | Pending P0.2 exact version and protocol negotiation | No-Go |
| AHP negotiated protocols | Unknown | Pending P0.2 | No-Go |
| Dev Tunnel CLI | `1.0.2006+dd9fe5139f`, macOS arm64 | CLI reports this build as outdated; hosting and decoder are pending P0.3 | No-Go |
| Dev Tunnel service | `1.0.1995.17384` (`43e8069d44`) | Version output only | Informational |
| Dev Tunnel decoder | Not selected | Pending fixture, revision, and hash from P0.3 | No-Go |

## Platform support

No OS/architecture combination is declared supported before Gate G0 passes.

The initial desktop target matrix is:

| OS | Architecture | Phase 0 evidence | Support |
| --- | --- | --- | --- |
| macOS | arm64 | Bootstrap only | Not declared |
| macOS | x64 | None | Not declared |
| Windows | x64 | None | Not declared |
| Linux | x64 | None | Not declared |

## Known unsupported environments

Version 1 does not support SSH, WSL, Dev Containers, Codespaces, `vscode.dev`, virtual
workspaces, untrusted workspaces, or mixed local/remote workspace folders.

## Evidence requirements

Promoting any row to supported requires:

1. The exact executable/package version and OS/architecture.
2. A reproducible command or automated opt-in test.
3. A sanitized fixture or protocol negotiation record where applicable.
4. Explicit cleanup and ownership evidence for child processes and tunnel resources.
5. A linked spike report describing failures and unsupported behavior.

