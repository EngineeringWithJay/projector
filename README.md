> Built to solve file synchronization without cloud provider dependency, third-party storage fees, or data leaving your network.

# P2P Storage Projector — Projector

## The Problem

File sync between devices today means choosing between centralized cloud storage (Google Drive, Dropbox — $10–$20/TB/month with privacy tradeoffs) or complex self-hosted solutions (Nextcloud, Syncthing — requires server infrastructure and configuration). There's no simple, zero-infrastructure option for secure P2P file sync.

## The Solution

Projector creates peer-to-peer storage overlays using the Hypercore protocol. It projects local files into a distributed network where authorized peers discover and sync them directly — no central server, no cloud fees, no data leaving your encrypted P2P mesh.

## Live Demo

> 📹 **Demo:** [Insert 30-second screen recording showing: select folder → share link → peer syncs files]
>
> 🔗 *Electron desktop app*

## Key Metrics & Impact

- **Zero-infrastructure sync:** P2P discovery via hyperswarm — no server required for peer discovery
- **Encrypted transport:** All data transferred via hypercore's cryptographic integrity verification
- **Offline-first:** localdrive + corestore persist data locally; syncs when peers become available
- **Real-time mirroring:** mirror-drive watches filesystem changes and propagates delta updates
- **Content-addressed:** hyperdrive ensures every block is cryptographically verified — tamper detection built in
- **Concurrent peers:** hyperswarm connects through NAT/firewalls via distributed hash table — no port forwarding

## Technical Architecture

| Layer | Technology |
|-------|-----------|
| **Application** | Electron, Node.js |
| **Transport** | hyperswarm (P2P discovery and connection) |
| **Storage** | hypercore, hyperdrive (content-addressed) |
| **Sync Engine** | mirror-drive, localdrive |
| **Persistence** | corestore |
| **Integrity** | hypercore-crypto |

## How It Works

```
Local Filesystem
        │
        ▼
  localdrive ──→ Encapsulates local directory as a hyperdrive
        │
        ▼
  hyperdrive ──→ Content-addressed, versioned storage
        │
        ▼
  hyperswarm ──→ DHT-based peer discovery across NAT
        │
        ▼
  mirror-drive ──→ Watches changes, syncs deltas
        │
        ▼
  Remote Peers ──→ Receive verified, encrypted file copies
```

## Local Setup

```bash
# Clone and install
npm install

# Start the projector
npm start

# Run P2P sync tests
npm test
```

## License

MIT — see [LICENSE](LICENSE)
