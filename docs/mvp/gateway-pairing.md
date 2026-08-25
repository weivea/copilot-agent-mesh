# Gateway, Pairing, and Peer Connection MVP

## Architecture

The MVP is split into transport adapters and narrow application boundaries:

- `GatewayServer` owns the loopback HTTP listener and `ws` upgrade boundary.
- `RpcPeer` owns one socket, JSON-RPC framing, authentication state, heartbeat, limits, and disposal.
- `PairingService` owns invitation, enrollment, reconnect authentication, and credential lifecycle.
- `GatewayRouter` depends only on `DeviceService`, `WorkspaceService`, and `TaskService`.
- `WebSocketPeerTransport` implements enrollment, reconnect, RPC correlation, and heartbeat.
- `PeerConnection` exposes connection state; `PeerConnectionManager` owns profiles, automatic reconnect, and lifecycle.

No module in this feature invokes Git, parses Dev Tunnel output, or implements an agent runtime.

## Integration interfaces

`SecretStore` is the only credential storage boundary:

```ts
interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

The extension composition root should adapt VS Code `SecretStorage` to this interface. Invitation,
pending-enrollment, and peer metadata use `PairingRecordStore`; coordinator profiles use
`PeerProfileStore`. `PairingRecordStore.commitPeer` must atomically activate the peer while
removing its pending record and invitation. Durable adapters must preserve each method's ordering
and failure semantics.

Composition wiring is intentionally outside this module. The extension host should:

1. Adapt VS Code `SecretStorage` to `SecretStore`.
2. Adapt non-sensitive durable state to `PairingRecordStore` and `PeerProfileStore`.
3. Construct `PairingService`, then inject it and a `GatewayRouter` into `GatewayServer`.
4. Inject real `DeviceService`, `WorkspaceService`, and `TaskService` implementations into
   `GatewayRouter`.
5. Construct `WebSocketPeerTransport` and `PeerConnectionManager` for coordinator connections.
6. Register `GatewayServer.dispose()` and `PeerConnectionManager.dispose()` with extension
   deactivation.

The composition root owns persisted preferred-port lookup/update. It must not put invitation or peer
key material in `globalState`, logs, webview state, or service DTOs.

`GatewayRouter` accepts implementations of:

- `DeviceService.getInfo(authenticatedPeerId)`
- `WorkspaceService.list(authenticatedPeerId)`
- `TaskService.start/get/cancel/answer(authenticatedPeerId, ...)`

The authenticated peer is supplied by the gateway, never by request parameters. Task service
implementations remain responsible for durable idempotency, workspace leases, and ownership.

## Listener and JSON-RPC protocol

The Node server binds only `127.0.0.1`, using a supplied persisted port or port `0`. Only
`GET /healthz` returns `204` with an empty body. Only `/agent-mesh/rpc` can upgrade.
`WebSocketServer` uses `noServer`, a 1 MiB payload ceiling, and disabled compression.

Only single UTF-8 JSON text requests are accepted. Envelopes and method parameters are strict;
batches, binary frames, extra authorization-sensitive fields, and non-allowlisted methods fail.
Authenticated application methods are `device.getInfo`, `workspace.list`, `task.start`,
`task.get`, `task.cancel`, and `task.answer`.

## Pairing protocol

Each copied URL creates a fresh invitation ID and random 32-byte secret. The secret is carried
only in `#secret=...`, stored through `SecretStore`, expires after ten minutes, is one-time use,
and is limited to five live invitations.

Enrollment uses 32-byte nonces and HMAC-SHA-256 over four-byte big-endian length-prefixed UTF-8
fields. It never serializes a cryptographic transcript as JSON. The negotiated transcript is
hashed and used as HKDF-SHA-256 salt to derive a 32-byte peer root key. Proof labels are
direction-specific. Reconnect uses the persisted root key and separate reconnect labels.
Comparisons validate length before `timingSafeEqual`.

Enrollment is two-phase:

1. Worker persists a pending record and root key before returning `enrollmentId`.
2. Coordinator persists its root key/profile before sending the commit proof.
3. Worker activates the peer, then consumes the invitation.

If the final response is lost, the coordinator retains the candidate root key and profile, then
uses bounded full-jitter reconnect attempts to confirm the worker's committed peer idempotently.
An initial `AUTH_FAILED` can mean the worker commit is still completing, so it does not delete the
candidate key or fall back to invitation enrollment. Pairing material is removed only after
reconnect confirms the committed peer.

## Security and resource limits

- Pre-authentication: 64 KiB frames, 8 messages per 10 seconds, 30-second deadline.
- Listener: 16 global unauthenticated sockets and best-effort 4 per source.
- WebSocket payload: 1 MiB; text JSON only.
- Outbox: serialized UTF-8 accounting, 256 KiB or 128 events, including `bufferedAmount`.
- Post-authentication: WS ping every 10 seconds; terminate after 30 seconds without pong.
- Reconnect: full jitter, exponential ceiling from 1 to 30 seconds; reset only after 30 stable seconds.
- URL parser: `https`/`wss`, exact connect path, protocol `v=1`, single device/invite/secret fields,
  no userinfo, and a 32-byte base64url fragment secret.

Profiles contain only endpoint/device/invitation identifiers and opaque `SecretStore` references.
After enrollment they contain peer ID and credential reference only. Secrets are excluded from
profile/state/error text and are never added to the WebSocket URL.

## Testing

`npm run test:component` uses real loopback WebSockets and injected boundary services. It covers
health, pairing, wrong secrets, replay, lost commit response recovery, protocol mismatch, binary,
batch and size rejection, pong timeout, restart reconnect, and deterministic resource disposal.
It is part of the default `npm test` sequence.
