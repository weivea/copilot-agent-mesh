# Compatibility Matrix

> Status: Phase 0 in progress  
> Evidence date: 2026-08-25
> Baseline commit: `66b2954`

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
| Dev Tunnel CLI | Installed `1.0.2006+dd9fe5139f`; validated downloaded `1.0.2030+fc9273aa0f`, macOS arm64, executable SHA-256 `004f3cc8ebcce61223bacac80d31937eb2e92eaee9a05600a1cb62fb5f775afe` | Exact-build login, strict create/port/access/show JSON, persistent port, port-scoped expiring anonymous ACE, owned host, HTTPS 204, real WSS, ACE renewal, stable-URI restart, and exact-ID cleanup passed. No global CLI upgrade occurred. | Pass on macOS arm64 / other platforms No-Go |
| Dev Tunnel service | `1.0.1995.17384` (`43e8069d44`) | Version output only | Informational |
| Dev Tunnel decoder | Supported revision `show-json-1.0.2030-r1`; sanitized real hosted fixture SHA-256 `d561eed56125ea53d2e97f1dcc5107575f7fb1df2eb2032a955338c9fb7a5ace` | Exact 2030 `portUri` contract and cross-version `portForwardingUris` rejection are tested | Pass for exact macOS arm64 build |

## Preview platform support

The Marketplace Preview scope does not claim cross-platform Worker support.
Coordinator support still depends on the peer client being available in that
environment.

| OS | Architecture | Phase 0 evidence | Preview support |
| --- | --- | --- | --- |
| macOS | arm64 | Bootstrap, Tool API, real AHP initialize, and real exact-build Dev Tunnel lifecycle; authenticated AHP Session/Turn E2E remains pending | Only Worker Preview candidate plus Coordinator; end-to-end Gate G0 remains No-Go |
| macOS | x64 | No owned Worker lifecycle evidence | Coordinator only; Worker returns `CLI_UNSUPPORTED` / `AGENT_UNAVAILABLE` |
| Windows | x64 | No Job Object-based Agent Host ownership and no validated tunnel build | Coordinator only; Worker returns `CLI_UNSUPPORTED` / `AGENT_UNAVAILABLE` |
| Linux | x64 | Agent process groups exist, but no validated tunnel build or complete Worker gate | Coordinator only; Worker returns `CLI_UNSUPPORTED` / `AGENT_UNAVAILABLE` |

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
