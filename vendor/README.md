# Vendored dependencies

`microsoft-agent-host-protocol-0.8.0.tgz` is the exact
`@microsoft/agent-host-protocol@0.8.0` release used by the Phase 0 Agent Host spike.

- Upstream: <https://github.com/microsoft/agent-host-protocol>
- Tag: `typescript/v0.8.0`
- Commit: `7153143f1c6993fa886d7d59870811cdad479d83`
- SHA-256: `faec121a9a3f1d455015a8bd9d7c529290b2b24d5c3f097245f43ac6c084096c`
- SHA-512 (base64): `Tg1EsWXENx55RB3igfaSTclxvck2RcBS+LPRSGxi86yLhoeJgldtjSH5aDZZTll0tSw7fzbkSOte3/B9ExRFVg==`
- License: MIT; see `microsoft-agent-host-protocol-LICENSE.txt`

The local tarball is used because the configured npm proxy did not expose `0.8.0`
during the spike. Replace it only after re-running protocol negotiation, provenance,
integrity, clean-install, and license checks.
