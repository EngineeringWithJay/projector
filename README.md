# Projector

P2P storage projector built on hypercore, hyperdrive, and hyperswarm for decentralized file synchronization.

## What it does

Projector creates secure, peer-to-peer storage overlays using the Hypercore protocol. It projects local files into a distributed network where they can be discovered and synced by authorized peers without any central server.

Built for offline-first, multi-device workflows where cloud dependency isn't desirable.

## Technology

| Layer | Stack |
|-------|-------|
| Transport | hyperswarm (P2P discovery) |
| Storage | hypercore, hyperdrive |
| Sync | mirror-drive |
| Persistence | corestore, localdrive |
| Platform | Node.js + Electron |
| Caching | hypercore-crypto |

## Architecture

```
Local files → localdrive → hyperdrive (encrypted)
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
              hyperswarm              hypercore-crypto
           (peer discovery)         (content integrity)
                    │
                    ▼
            Authorized Peers
```

## Use cases

- Sync project files between machines without a cloud provider
- Share large files with collaborators using direct P2P connections
- Offline-first archival with cryptographic integrity verification

## Status

Working prototype. Core sync and discovery are functional.
