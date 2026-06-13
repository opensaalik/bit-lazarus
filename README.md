# Bit Lazarus

Bit Lazarus is a torrent recovery bounty app. A requester creates a bounty from a real `.torrent` file, the torrent infohash derives an ENS wildcard name, a hunter proves delivery by seeding the recovered file, and the archive can later resolve through ENS to Walrus.

The production direction is:

1. A requester signs in with an Ethereum wallet.
2. A bounty is created from a `.torrent` file and a USDC reward amount.
3. The torrent infohash derives `btih-<infohash>.bitlazarus.eth`.
4. ENS wildcard CCIP Read resolves status, infohash, and archived Walrus records.
5. Arc becomes the USDC escrow and settlement layer.
6. After verified delivery, the recovered file is archived to Walrus and served through the ENS resource record.

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
ARC_ESCROW_CONTRACT_ADDRESS=0x831ad29969e853e668ac3e9db4856a1f48acfd0d \
WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space \
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space \
DATA_DIR=./data/local \
npm start
```

The backend runs on:

- `http://127.0.0.1:3000`

## Run The ENS CCIP Gateway

Use this lighter process when hosting only the ENS offchain gateway:

```bash
ENS_PARENT_NAME=bitlazarus.eth \
ENS_NETWORK=sepolia \
ARC_RPC_URL=https://rpc.testnet.arc.network \
ARC_ESCROW_CONTRACT_ADDRESS=0x831ad29969e853e668ac3e9db4856a1f48acfd0d \
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
