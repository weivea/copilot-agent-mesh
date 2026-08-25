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
and failure semantics. The active peer record retains `enrollmentId` and `transcriptHash` so an
already-applied commit can be proof-verified and acknowledged idempotently. It also retains
`cleanupPending` and the opaque invitation-secret reference until `completePeerCleanup` durably
records successful secret deletion. `listPeers` lets startup/normal pruning retry this cleanup.

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
2. Coordinator persists its root key, transcript metadata, and commit proof before sending commit.
3. Worker activates the peer, then consumes the invitation.

`mesh.enrollmentCommit` accepts the original session-bound request and a sessionless recovery
request. Both verify the persisted proof; duplicate requests for the same pending or active
enrollment are idempotent. Commit and expiry pruning are serialized so pruning cannot delete a root
while that root is becoming active. A commit is not acknowledged until invitation-secret deletion
and the active record's cleanup transition both complete; duplicate commit and prune paths retry
either interrupted step.

If commit delivery or its response is unknown, the coordinator retains the candidate root and
profile and uses bounded full-jitter reconnect attempts. A retry first attempts normal peer
authentication. If the worker has not activated the peer, it re-sends the persisted commit proof
without relying on the expired socket session. Explicit authentication or protocol rejection is
terminal for a new addition and rolls back its profile, socket, invitation secret, root, and commit
proof. Delivery/availability failures remain retryable.

Pending profiles persist only `enrollmentId`, transcript hash, worker-authored expiry, and opaque
references to the candidate root and commit proof. The coordinator does not compare the worker's
absolute timestamp with its own clock. The worker authoritatively rejects an expired recovery
commit, after which the connection enters `rePairRequired`. Potentially-active candidate key
material is retained rather than risking deletion of a root whose commit acknowledgement was lost;
the user must create a new invitation and pair again.

Candidate profile writes use read-after-error reconciliation because a durable store may apply a
write before reporting failure. Exact candidate state is treated as persisted and remains
repairable; candidate keys are deleted only when the previous profile is read back unchanged.
Unknown or conflicting readback preserves keys and fails closed.

## Security and resource limits

- Pre-authentication: 64 KiB frames, 8 messages per 10 seconds, 30-second deadline.
- Listener: 16 global unauthenticated sockets and best-effort 4 per source.
- WebSocket payload: 1 MiB; text JSON only.
- Outbox: serialized UTF-8 accounting with `bufferedAmount`; ordinary progress/output uses
  256 KiB or 128 events, while one schema-valid critical/snapshot frame up to 1 MiB has
  reserved capacity. Total pending transport data is bounded at 1 MiB + 256 KiB and 144
  events. Progress coalesces by task and output pressure emits one truncated marker per
  episode; a single frame over 1 MiB closes with `1009`.
- Post-authentication: WS ping every 10 seconds; terminate after 30 seconds without pong.
- Reconnect: full jitter, exponential ceiling from 1 to 30 seconds; reset only after 30 stable seconds.
- Handshake lifecycle: every async hello boundary checks its connection generation; socket disposal
  prevents late session publication, and per-session timers actively remove state at the 30-second TTL.
- Manager lifecycle: add, connect, background retries, and restore are tracked; dispose waits for
  in-flight profile listing and rejects late peer publication.
- URL parser: `https`/`wss`, exact connect path, protocol `v=1`, single device/invite/secret fields,
  no userinfo, and a 32-byte base64url fragment secret.

Profiles contain only endpoint/device/invitation identifiers and opaque `SecretStore` references.
After enrollment they contain peer ID and credential reference only. Pending enrollment profiles
also contain the non-secret recovery metadata described above. Secrets are excluded from
profile/state/error text and are never added to the WebSocket URL.

## Testing

`npm run test:component` uses real loopback WebSockets and injected boundary services. It covers
health, pairing, wrong secrets, replay, duplicate and undelivered commits, commit/prune races,
terminal rollback, pending expiry, protocol mismatch, binary, batch and size rejection, pong
timeout, restart reconnect, and deterministic resource disposal. It is part of the default
`npm test` sequence.
