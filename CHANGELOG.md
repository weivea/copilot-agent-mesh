# Change Log

All notable changes to the "copilot-agent-mesh" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.1.0 Preview] - 2026-08-25

- Added a reproducible pre-release VSIX pipeline with a positive content allowlist, archive inspection, and isolated-profile activation smoke test.
- Added Linux, macOS, and Windows offline test/package CI; real Worker E2E remains explicitly opt-in and outside ordinary CI.
- Documented macOS arm64-only Worker hosting, Coordinator-only platforms, explicit AHP authentication mappings, and the exact user-supplied Dev Tunnel CLI `1.0.2030+fc9273aa0f`.
- Included runtime dependency notices and the AHP `0.8.0` MIT license without nesting its already bundled source tarball in the VSIX.
- Retained the Gate G0 **No-Go** status; this package does not claim full authenticated end-to-end support.
- Added production Gateway, pairing, Peer reconnect, Workspace registry, task state,
  persistence, recovery, and bounded backpressure.
- Added exact-build Dev Tunnel hosting with renewal, health/WSS readiness, restart, and
  exact-owned cleanup.
- Added the production Agent Host/AHP adapter with explicit authentication, Session,
  Chat, Terminal, Input, cancellation, and recovery boundaries.
- Replaced the Phase 0 echo tool with five production Mesh tools and an interactive
  Dashboard.
- Added a real two-instance E2E covering Tunnel, pairing, Workspace discovery,
  delegation, polling, authentication failure handling, and resource cleanup.