# Projector Runtime Adapter Contract

> `src/runtime/node.js` is the single seam between HyperFrame SDK and Projector app code.

---

## Purpose

The adapter exists to:
- Own the `HyperFrame` instance
- Expose a ctx-compatible app facade
- Translate SDK events into app-level events
- Keep Projector from coupling directly to SDK internals

**It is the only place in Projector that should know the full shape of the HyperFrame runtime object.**

---

## What the Adapter Owns

### 1. The HyperFrame Instance
```
adapter.node = new HyperFrame({ storagePath })
```
Single runtime instance for the app process. Exposed explicitly.

### 2. App-Specific Mutable State
| Field | Purpose |
|---|---|
| `syncReady` | Workspace sync readiness |
| `transitioning` | Session switch in progress |
| `lastMirrorStatus` | `'ok'` / `'error'` / `'pending'` |
| `lastError` | Last recoverable error message |
| `ownerReachable` | Owner peer is reachable over swarm |
| `sourceFolderPath` | Selected owner source folder path |
| `watcherActive` | Owner folder watcher is active |
| `mirrorActive` | Mirror pass is currently running |
| `activeTransferCount` | Queued + active download count |

These drive `sessionHealth` computation. Not in SDK.

### 3. Event Forwarding Callbacks
Injected by `main.js` via `bindEmitters()`:
- `emitHealth`, `emitFileList`, `emitActivity`, `emitPeerList`, `emitSessionLibrary`, `emitRequests`

---

## Exposed Properties (ctx-compatible)

| Property | Source |
|---|---|
| `identity` | `node.identity` |
| `session` | `node.session` (read/write) |
| `sessions` | `node.sessions` |
| `storagePath` | constructor arg |
| `controlPlane` | `node.controlPlane` |
| `dataPlane` | `node.dataPlane` |
| `messagePlane` | `node.messagePlane` |
| `swarm` | `node.swarm` |
| `peerRegistry` | `node.peerRegistry` |
| `storage` | `node.storage` |
| `node` | raw HyperFrame instance |

---

## Public API

| Method | Behavior |
|---|---|
| `init()` | Init HyperFrame + bind events |
| `restoreSession()` | Restore last session; fail into recoverable state |
| `createSession(opts)` | Owner creates session |
| `joinSession(code, opts)` | Join existing session |
| `switchSession(sessionId)` | Strict teardown/rebind sequence |
| `forgetSession(sessionId)` | Delete non-current saved session |
| `renameSession(sessionId, name)` | Rename saved session |
| `destroy()` | Clean shutdown |
| `setMemberPolicy(deviceId, patch)` | Update member contract |
| `setMemberRole(deviceId, role)` | Promote/demote member |
| `setVisibilityRule(path, vis)` | Set path visibility |
| `setPrivateShare(deviceId, opts)` | Create private share |
| `clearPrivateShare(deviceId)` | Remove private share |
| `requestAccess(body)` | Submit access request and return fresh filtered visible messages |
| `respondToRequest(id, action, comment)` | Atomic: validate → policy → notice → return filtered visible messages |
| `getVisibleMessages()` | Filtered messages only |
| `getPeers()` | Current peer list plus raw pending connections |
| `getMemberList()` | Enriched app-friendly rows with nested `policy` |
| `getConfig()` | Serialized identity + version |
| `saveConfig(patch)` | Update identity fields |
| `saveIdentity()` | Persist identity to disk |
| `getHealth()` | Compute sessionHealth |

---

## Behavioral Contracts

### `restoreSession()`
- Reads current session from library
- Owned sessions: re-create; Joined sessions: re-join
- Refuses restore if `profileSetupComplete` is false
- On failure: clears session, sets `lastError`, emits health

### `switchSession(sessionId)`
Strict sequence:
1. Disconnect swarm / leave topic
2. Close all planes
3. Clear peer registry + messages
4. Clear app-specific transient state
5. Activate target session
6. Re-open planes for new session
7. Rejoin swarm
8. Emit health, session library, peers, file list

### `forgetSession(sessionId)`
- Rejects unknown session ids
- Rejects forgetting the current active session in place
- Allows forgetting non-current sessions only
- Main process is responsible for cleaning session-local artifacts after the record is removed

### `respondToRequest(requestId, action, comment)`
- Resolve request by ID
- Verify `kind === 'request'`, `status === 'open'`, caller is Owner
- Map: `approve` → `approved`, `hold` → `pending`, `deny` → `blocked`
- Call `setMemberPolicy()` for contract update
- Create notice via `sendNotice()`
- Return fresh filtered visible messages

### `getMemberList()`
- Returns UI-facing rows
- `policy` is nested and stable:
  - `status`
  - `workspaceAccess`
  - `activityAccess`
  - `uploadAccess`
  - `companyLabel`
  - `allowedPaths`

### `getHealth()`
- Returns the only summary truth consumed by the renderer
- Includes transport and workspace state:
  - `peerCount`
  - `ownerReachable`
  - `sourceFolderPath`
  - `sourceFolderSelected`
  - `watcherActive`
  - `mirrorActive`
  - `activeTransferCount`

---

## Event Translation (SDK → Projector)

| SDK Event | App Effect |
|---|---|
| `session-state` | `emitHealth()` + `emitSessionLibrary()` + `emitFileList()` |
| `peer-presence` | `emitHealth()` + `emitPeerList()` |
| `peer-connected` | `emitHealth()` + `emitPeerList()` |
| `peer-disconnected` | `emitHealth()` + `emitPeerList()` |
| `metadata-update` | `emitHealth()` + `emitFileList()` |
| `message-update` | `emitRequests()` (filtered through `getVisibleMessages()`) |

> **Critical rule:** Renderer only receives filtered visible messages. Never raw message plane contents.

---

## State Ownership Boundaries

| Layer | Owns |
|---|---|
| **HyperFrame SDK** | identity, sessions, metadata, permissions, swarm, control messages, trust, message plane |
| **Adapter** | app facade, event translation, health shaping, recoverable restore, switch discipline |
| **Projector services** | workspace sync, transfers, local cache, paths, audit log |
| **Projector UI** | rendering, user interactions |

---

## Invariants

1. `main.js` does not implement runtime logic
2. Renderer does not talk to SDK directly
3. Services do not need raw HyperFrame internals beyond adapter-exposed shape
4. `sessionHealth` remains the only summary truth
5. Message visibility is filtered before UI delivery
6. Backend policy mutation remains fail-closed
7. Session switching leaves no stale listeners, peers, or file state
