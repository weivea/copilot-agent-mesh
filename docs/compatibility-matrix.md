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
| VS Code tested | `1.134.0`, commit `110a328ea54b42367b803ec53ee0bf52ef26b419`, macOS arm64 | Bootstrap, P0.1 suites, and P0.2 real Agent Host initialize/provider discovery | Partial |
| Language Model Tool | Stable `vscode.lm` API on VS Code `1.134.0` | Manifest/runtime parity, cold activation, structured result, cancellation, timeout, and idempotent retry pass; authenticated Copilot selection, confirmation UI, wall-clock UX, and autonomous polling remain unverified | Partial / No-Go |
| AHP package | `@microsoft/agent-host-protocol@0.8.0`, official tag `typescript/v0.8.0` / commit `7153143f1c6993fa886d7d59870811cdad479d83`, vendored tarball SHA-256 `faec121a9a3f1d455015a8bd9d7c529290b2b24d5c3f097245f43ac6c084096c` | Package `0.7.0` was rejected by Host requirement `^0.8.0`; audited `0.8.0` completed real initialize | Partial / No-Go |
| AHP negotiated protocols | SDK offered `0.8.0`, `0.7.0`, `0.6.0`, `0.5.2`, `0.5.1`; Host selected `0.8.0` | Root snapshot dynamically discovered Copilot and Claude providers; Auth, Session, Chat, Turn, cancellation, reconnect, replay, and recovery remain unverified | Partial / No-Go |
| Dev Tunnel CLI | `1.0.2006+dd9fe5139f`, macOS arm64 | Login and owned create/port/access/show probes ran, but `create --json` emitted a 393-byte text prefix; hosted URI, health, WSS, restart, migration, and renewal remain unverified | No-Go |
| Dev Tunnel service | `1.0.1995.17384` (`43e8069d44`) | Version output only | Informational |
| Dev Tunnel decoder | Observed revision `show-json-1.0.2006-r1`; sanitized no-host fixture SHA-256 `244e17f9195cc8b8c38da88b996eab1ace0655bf3642d951c4827fd65a166f73` | Strict failure paths and a synthetic hosted contract are tested; no real hosted forwarding URI fixture exists | No-Go |

## Platform support

No OS/architecture combination is declared supported before Gate G0 passes.

The initial desktop target matrix is:

| OS | Architecture | Phase 0 evidence | Support |
| --- | --- | --- | --- |
| macOS | arm64 | Bootstrap, P0.1 Tool API, P0.2 real AHP initialize, and P0.3 fail-closed CLI/decoder evidence | Not declared |
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
