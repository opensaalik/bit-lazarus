# Bit Lazarus

Bit Lazarus is a torrent recovery bounty app. A requester creates a bounty from a real `.torrent` file, the torrent infohash derives an ENS wildcard name, a hunter proves delivery by seeding the recovered file, and the archive can later resolve through ENS to Walrus.

The production direction is:

1. A requester signs in with an Ethereum wallet.
2. A bounty is created from a `.torrent` file and a USDC reward amount.
3. The torrent infohash derives `btih-<infohash>.bitlazarus.eth`.
4. ENS wildcard CCIP Read resolves status, infohash, and archived Walrus records.
5. Arc becomes the USDC escrow and settlement layer.
6. After verified delivery, the recovered file is archived to Walrus and served through the ENS resource record.

## Build Provenance

This repository started before the hackathon as a peer-to-peer wallet and torrent recovery prototype:

- `5ff6c88` initialized the p2p wallet project.
- `c9c1599` added the original Bitcoin Lightning-backed escrow scaffolding.
- `733f9dc` through `48eb912` added wallet auth and wallet-linked profiles.
- `aad33ac`, `db21c25`, and `7ba6159` added the first bounty backend and escrow state syncing.
- `da8e198` and `e2ee1d0` scaffolded the first Vite/React frontend.
- `b7acfe5` through `e0125aa` added early delivery/proof protocol experiments.

During the hackathon, the project was rebuilt around ENS, Arc, Walrus, and browser-to-browser recovery:

- ENS resource location: `70ede0b`, `8bdd0a6`, `df252a5`, `d58a124`, `7bd41dd`, and `07f3a2c` moved the app to ENS wildcard/CCIP Read resolution instead of explicit subdomain writes.
- Arc escrow: `3d0fcf1` removed the Bitcoin Lightning path, then `161122f`, `f31382e`, `4b56c03`, `5120da9`, `ed4e2b7`, and `b6da9ab` added the Arc USDC escrow contract, read service, transaction endpoints, and wallet-signed lifecycle.
- Walrus archival: `4cb4791` added verified file upload to Walrus, and `1b948c5` added ENS/Walrus archive downloads for already-recovered torrents.
- WebTorrent recovery: `049669d`, `feb73f0`, `e5cd53d`, `a40524f`, `5be22be`, `e03a02c`, and `be83a06` added the in-app tracker, native seeding/download flow, tracker diagnostics, and peer connectivity hardening.
- Brave wallet and demo hardening: `089741e`, `fd91e64`, and `67774db` reduced wallet prompt friction and normalized Arc transaction gas fields.
- ENS wallet identities and demo data: `88d0914` assigned reusable wildcard ENS names to wallet sessions, while `885f659` and `b53b325` added the seeded demo bounties and old-escrow cleanup.
- Final UX polish: `d0407cd`, `8da7685`, `c163f49`, `e38b596`, and `a39494e` shaped the pixel-themed app, root-domain routing, ENS search, and separate info page.

## Requirements

- Node `>=20`
- An Ethereum wallet for app login and Arc interactions
- Sepolia RPC and `bitlazarus.eth` owner key only when deploying the ENS wildcard resolver

## Install

```bash
npm install
```

## Run The App Backend

```bash
ENS_PARENT_NAME=bitlazarus.eth \
ENS_NETWORK=sepolia \
ARC_RPC_URL=https://rpc.testnet.arc.network \
ARC_ESCROW_CONTRACT_ADDRESS=<arc-escrow-contract-address> \
WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space \
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space \
DATA_DIR=./data/local \
npm start
```

The backend runs on:

- `http://127.0.0.1:3000`

The WebTorrent tracker is mounted on the same HTTP server at `/tracker`.
On Render, the app uses `RENDER_EXTERNAL_HOSTNAME` to advertise:

```bash
wss://<render-hostname>/tracker
```

If your host does not set `RENDER_EXTERNAL_HOSTNAME`, configure:

```bash
WEBTORRENT_TRACKER_PUBLIC_HOST=bit-lazarus.onrender.com
WEBTORRENT_TRACKER_SCHEME=wss
WEBTORRENT_TRACKER_PATH=/tracker
```

## Run The ENS CCIP Gateway

Use this lighter process when hosting only the ENS offchain gateway:

```bash
ENS_PARENT_NAME=bitlazarus.eth \
ENS_NETWORK=sepolia \
ARC_RPC_URL=https://rpc.testnet.arc.network \
ARC_ESCROW_CONTRACT_ADDRESS=<arc-escrow-contract-address> \
DATA_DIR=./data/gateway \
npm run ccip:gateway
```

The deployed gateway URL should be configured in the resolver deploy env as:

```bash
ENS_CCIP_GATEWAY_URL=https://bit-lazarus.onrender.com/ens/ccip/{sender}/{data}
```

## Deploy The Wildcard Resolver

```bash
ENS_PARENT_NAME=bitlazarus.eth \
ENS_NETWORK=sepolia \
ENS_CCIP_GATEWAY_URL=https://bit-lazarus.onrender.com/ens/ccip/{sender}/{data} \
ENS_RPC_URL=<sepolia-rpc-url> \
ENS_PRIVATE_KEY=<bitlazarus.eth-owner-private-key> \
npm run ens:deploy-resolver
```

## Deploy The Arc Escrow

Arc Testnet network details:

- RPC: `https://rpc.testnet.arc.network`
- Chain ID: `5042002`
- Explorer: `https://testnet.arcscan.app`
- Native gas token: `USDC`
- USDC ERC-20 interface: `0x3600000000000000000000000000000000000000`

Deploy the USDC escrow contract:

```bash
ARC_PRIVATE_KEY=<arc-funded-deployer-private-key> \
ARC_RPC_URL=https://rpc.testnet.arc.network \
ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
npm run arc:deploy-escrow
```

After deployment, set:

```bash
ARC_ESCROW_CONTRACT_ADDRESS=<deployed-contract-address>
```

For demo deployments, seed the persistent data directory with ten realistic torrent bounties:

```bash
DATA_DIR=/var/data \
ENS_PARENT_NAME=bitlazarus.eth \
ARC_ESCROW_CONTRACT_ADDRESS=<deployed-contract-address> \
npm run demo:seed-bounties
```

The seed is idempotent and writes five open bounties plus five completed Walrus-style archive entries.
If the server is already running, restart it after running the command; the running process keeps bounty state in memory.
For Render, you can instead set `DEMO_SEED_BOUNTIES=true` so the same seed runs in-process on startup.

## Walrus Archive

The app uploads verified recovered files to Walrus before confirming delivery on Arc, then stores the returned blob ID in the Arc escrow contract. ENS wildcard resolution reads the blob ID back from Arc.

Default Testnet endpoints are built in:

```bash
WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space
WALRUS_EPOCHS=5
```

Backend routes:

- `GET /walrus/config`
- `PUT /walrus/blobs`
- `GET /resources/:torrentInfoHash/download`

When a requester uploads a `.torrent` whose infohash already resolves to `walrus.blob`, the app skips new Arc bounty creation and downloads the archived file through the backend proxy.

## Arc API Routes

The backend never holds an Arc signing key. It returns transaction payloads for the browser wallet to sign:

- `GET /arc/config`
- `GET /arc/bounties/by-infohash/:torrentInfoHash`
- `POST /arc/transactions/create-bounty`
- `POST /arc/transactions/claim-bounty`
- `POST /arc/transactions/submit-delivery`
- `POST /arc/transactions/confirm-delivery`
- `POST /arc/transactions/refund-expired`

## Run The Frontend

In a second terminal:

```bash
npm run frontend:dev
```

Open the Vite URL it prints, usually:

- `http://127.0.0.1:5173`

## Demo Files

Use the bundled fixture files:

- [fixture-a.torrent](manual-test/torrents/fixture-a.torrent)
- [fixture-a.bin](manual-test/content/fixture-a.bin)

## Current Flow

1. Connect with Brave Wallet and approve the login signature prompt.
2. Create a bounty with `fixture-a.torrent` and a USDC reward amount.
3. Fund/open the bounty through the Arc escrow integration once deployed.
4. As hunter, open the bounty and click `Hunt bounty`.
5. As requester, create the delivery contract.
6. As hunter, load `fixture-a.bin`, commit the SHA-256, and start seeding.
7. As requester, start the download and verify the SHA-256.
8. Archive the recovered file to Walrus and expose it through ENS.

## Verification

```bash
npm test
npm run frontend:build
```
